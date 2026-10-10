#!/usr/bin/env node
// Refuses the ways of waiting for the dev app (`pnpm tauri dev`) that cannot see it come up,
// and answers a background launch with the check that can.
//
//   node scripts/check-startup-wait.mjs --hook         read a Claude Code PreToolUse or PostToolUse
//                                                      payload from stdin
//   node scripts/check-startup-wait.mjs --pid <tree>   print the PID of the dev app <tree> built,
//                                                      or exit 1 when it is not running and 2
//                                                      when that cannot be told
//   ... --pid <tree> --wait                            poll until it runs; exit 2 still stops it
//
// PreToolUse, Bash: a command that waits for the app by reading the dev server's log — a
// `while` / `until` loop that sleeps with a grep for the lines cargo prints inside it, or a grep
// for them downstream of a followed `tail` — is refused, and so is `pgrep -f` naming the binary.
// The command line is read as shell: a word inside quotes is an argument rather than a command,
// and a grep after the loop's `done` is outside the loop. The log carries an SGR reset between
// `Running` and the binary's path, so no fixed string matches that line; the binary is started
// from `src-tauri/` with the relative argv `target/debug/urx-router`, so an absolute path never
// matches it, and a match on the whole argv also finds the shells wrapping it. The process NAME
// identifies an app, and its working directory identifies the tree that built it: `--pid`.
//
// PostToolUse, Bash: a background launch of `tauri dev` is answered with that check, since a
// background command reports only when it exits, and the app exits when its window closes.
//
// Both events feed a hook's stderr back to Claude on exit 2; everything else exits 0.

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = "urx-router";
const GREPS = new Set(["grep", "egrep", "fgrep", "rg"]);
const LOG_MARKER = /Running|Finished|target\/debug|panicked/;
const FULL_ARGV = /^-[a-zA-Z]*f|^--full$/;
const FOLLOW = /^-[a-zA-Z]*[fF]|^--follow/;
const LEADING = new Set(["!", "{", "}", "do", "then", "else", "elif", "fi", "if", "time"]);
const TAURI_DEV = /\btauri\s+dev\b/;

const POLL_MS = 1000;

const CHECK = [
  "Check the process instead, once and in this turn: `node scripts/check-startup-wait.mjs --pid <tree>` prints",
  "the PID of the `urx-router` process (`pgrep -x urx-router`) whose working directory is `<tree>/src-tauri`",
  "(`lsof -a -p <pid> -d cwd -Fn`), exits 1 while that tree's app is not running — an app another tree built",
  "does not count — and exits 2 with the reason when it cannot tell. To wait, run the same command with `--wait`",
  "in the background, after that one check has shown the app is not already up: it polls while the answer is",
  "not running, prints the PID and exits 0 once the app is up, and exits 2 as soon as it cannot tell. Act on",
  "the PID it prints.",
].join(" ");

/** The simple commands of a shell command line: each one's words with quoting removed, and the
 *  operator that ends it. A redirection's target is not a word, and a command substitution inside
 *  double quotes is read as the commands it runs, listed after the command that holds it; one
 *  that never closes is text. A here-document's body is text too, apart from the substitutions an
 *  unquoted delimiter leaves it running. */
export function simpleCommands(command) {
  const out = [];
  const inner = [];
  const heredocs = [];
  let words = [];
  let word = null;
  let redirect = false;
  const endWord = () => {
    if (word !== null && !redirect) words.push(word);
    if (word !== null) redirect = false;
    word = null;
  };
  const endCommand = (op) => {
    endWord();
    redirect = false;
    if (words.length > 0 || op === "|") out.push({ words, op });
    out.push(...inner.splice(0));
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end < 0 ? command.length : end;
      word = (word ?? "") + command.slice(i + 1, stop);
      i = stop;
    } else if (c === '"') {
      let text = "";
      for (i++; i < command.length && command[i] !== '"'; i++) {
        const open = command[i] === "`" ? "`" : command.startsWith("$(", i) ? "$(" : null;
        const end = open === null ? -1 : open === "`" ? command.indexOf("`", i + 1) : closingParen(command, i + 2);
        if (end >= 0) {
          inner.push(...simpleCommands(command.slice(i + open.length, end)));
          i = end;
          continue;
        }
        if (command[i] === "\\" && i + 1 < command.length) i++;
        text += command[i];
      }
      word = (word ?? "") + text;
    } else if (c === "\\") {
      if (next !== "\n") word = (word ?? "") + (next ?? "");
      i++;
    } else if (c === "#" && word === null) {
      const end = command.indexOf("\n", i);
      i = (end < 0 ? command.length : end) - 1;
    } else if (c === "<" && next === "<" && command[i + 2] !== "<") {
      endWord();
      i += 2;
      const strip = command[i] === "-";
      if (strip) i++;
      while (command[i] === " " || command[i] === "\t") i++;
      let delim = "";
      let quoted = false;
      for (; i < command.length && !/[\s;&|<>()]/.test(command[i]); i++) {
        const q = command[i];
        if (q === "'" || q === '"') {
          const end = command.indexOf(q, i + 1);
          const stop = end < 0 ? command.length : end;
          delim += command.slice(i + 1, stop);
          quoted = true;
          i = stop;
        } else if (q === "\\") {
          delim += command[++i] ?? "";
          quoted = true;
        } else {
          delim += q;
        }
      }
      i--;
      heredocs.push({ delim, strip, quoted });
    } else if (c === ">" || c === "<" || (c === "&" && next === ">")) {
      endWord();
      while (/[<>&|]/.test(command[i + 1] ?? "")) i++;
      redirect = true;
    } else if (c === "$" && next === "(") {
      endCommand("$(");
      i++;
    } else if (c === "|" || c === "&" || c === ";") {
      const op = next === c ? c + c : c;
      endCommand(op);
      i += op.length - 1;
    } else if (c === "\n" && heredocs.length > 0) {
      endCommand(c);
      for (const { delim, strip, quoted } of heredocs.splice(0)) {
        let start = i + 1;
        for (;;) {
          const end = command.indexOf("\n", start);
          const stop = end < 0 ? command.length : end;
          const line = command.slice(start, stop);
          const closes = (strip ? line.replace(/^\t+/, "") : line) === delim;
          if (!closes && !quoted) out.push(...substitutions(line));
          if (closes || end < 0) {
            i = stop - 1;
            break;
          }
          start = end + 1;
        }
        i++;
      }
      i--;
    } else if (c === "\n" || c === "(" || c === ")" || c === "`") {
      endCommand(c);
    } else if (c === " " || c === "\t") {
      endWord();
    } else {
      word = (word ?? "") + c;
    }
  }
  endCommand(null);
  return out;
}

/** The commands the substitutions in a line of text run; text with none runs nothing. */
function substitutions(text) {
  const found = [];
  for (let i = 0; i < text.length; i++) {
    const open = text[i] === "`" ? "`" : text.startsWith("$(", i) ? "$(" : null;
    const end = open === null ? -1 : open === "`" ? text.indexOf("`", i + 1) : closingParen(text, i + 2);
    if (end < 0) continue;
    found.push(...simpleCommands(text.slice(i + open.length, end)));
    i = end;
  }
  return found;
}

/** The index of the `)` closing a parenthesis opened just before `from`, or -1. */
function closingParen(command, from) {
  let depth = 1;
  for (let i = from; i < command.length; i++) {
    if (command[i] === "(") depth++;
    else if (command[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

const LOG_WAIT = `startup-wait: this waits on the dev server's log, whose \`Running\` line carries an SGR reset before the binary's path, so no pattern written here matches it, and the app being up is not a log line. ${CHECK}`;

/** The reason `command` cannot see the dev app come up, or null when it is not such a wait. */
export function startupWaitFinding(command) {
  // One frame per open `for` / `while` / `until`; a grep and a sleep inside a nested frame count
  // for the loops around it too.
  const frames = [];
  const close = () => {
    const frame = frames.pop();
    if (frame.waits && frame.sleeps && frame.logGrep) return true;
    const outer = frames.at(-1);
    if (outer) {
      outer.sleeps ||= frame.sleeps;
      outer.logGrep ||= frame.logGrep;
    }
    return false;
  };
  let followed = false;
  for (const { words, op } of simpleCommands(command)) {
    let i = 0;
    let name;
    for (; i < words.length; i++) {
      const w = words[i];
      if (w === "while" || w === "until") frames.push({ waits: true, sleeps: false, logGrep: false });
      else if (w === "for" || w === "select") {
        frames.push({ waits: false, sleeps: false, logGrep: false });
        i = words.length;
      } else if (w === "done") {
        if (frames.length > 0 && close()) return LOG_WAIT;
      } else if (!LEADING.has(w) && !/^[A-Za-z_]\w*=/.test(w)) {
        name = w.split("/").pop();
        break;
      }
    }
    const args = words.slice(i + 1);
    if (name === "pgrep" && args.some((a) => FULL_ARGV.test(a)) && args.some((a) => a.includes(APP))) {
      return `startup-wait: \`pgrep -f\` matches the whole argv — the app's is the relative \`target/debug/urx-router\`, and the shells wrapping it match too. ${CHECK}`;
    }
    const logGrep = GREPS.has(name) && args.some((a) => LOG_MARKER.test(a));
    if (logGrep && followed) return LOG_WAIT;
    const frame = frames.at(-1);
    if (frame) {
      frame.sleeps ||= name === "sleep";
      frame.logGrep ||= logGrep;
    }
    followed = op === "|" && (followed || (name === "tail" && args.some((a) => FOLLOW.test(a))));
  }
  while (frames.length > 0) if (close()) return LOG_WAIT;
  return null;
}

const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C" } });

/** The PIDs of the processes named like the app. */
function appPids() {
  const res = run("pgrep", ["-x", APP]);
  if (res.error) throw res.error;
  if (res.status > 1) throw new Error(`pgrep exited ${res.status}: ${res.stderr.trim()}`);
  return res.stdout.split("\n").filter(Boolean);
}

/** A process's working directory, or null once it has exited. */
function processCwd(pid) {
  const res = run("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"]);
  if (res.error) throw res.error;
  const line = res.stdout.split("\n").find((l) => l.startsWith("n"));
  return line === undefined ? null : line.slice(1);
}

function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The PID of the dev app `tree` built — the process named like the app whose working directory
 *  is `<tree>/src-tauri` — or null. Throws when `tree` has no `src-tauri`. */
export function devAppPid(tree, { pids = appPids, cwdOf = processCwd } = {}) {
  const want = realpathSync(join(tree, "src-tauri"));
  for (const pid of pids()) {
    const cwd = cwdOf(pid);
    if (cwd !== null && canonical(cwd) === want) return pid;
  }
  return null;
}

/** The check to take now, for a command that launched the dev app in the background. */
export function launchReminder(command, background) {
  if (!background || !TAURI_DEV.test(command)) return null;
  return `startup-wait: a background command reports only when it exits, and the dev app exits when its window closes. ${CHECK}`;
}

/** The message a hook payload earns, or null. */
export function hookMessage(payload) {
  if (payload?.tool_name !== "Bash") return null;
  const command = String(payload.tool_input?.command ?? "");
  if (payload.hook_event_name === "PreToolUse") return startupWaitFinding(command);
  if (payload.hook_event_name === "PostToolUse")
    return launchReminder(command, payload.tool_input?.run_in_background === true);
  return null;
}

function main() {
  const at = process.argv.indexOf("--pid");
  if (at >= 0) {
    const tree = process.argv[at + 1];
    if (tree === undefined) {
      console.error("usage: node scripts/check-startup-wait.mjs --pid <tree>");
      process.exit(2);
    }
    const wait = process.argv.includes("--wait");
    const answer = () => {
      let pid;
      try {
        pid = devAppPid(tree);
      } catch (err) {
        console.error(`startup-wait: cannot tell whether ${tree}'s dev app is running (${err.message})`);
        process.exitCode = 2;
        return;
      }
      if (pid !== null) console.log(pid);
      else if (wait) setTimeout(answer, POLL_MS);
      else process.exitCode = 1;
    };
    answer();
    return;
  }
  if (!process.argv.includes("--hook")) {
    console.error("usage: node scripts/check-startup-wait.mjs --hook  (a hook payload on stdin)");
    console.error("       node scripts/check-startup-wait.mjs --pid <tree> [--wait]");
    process.exit(1);
  }
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch (err) {
    console.error(`startup-wait: unreadable hook payload, nothing checked (${err.message})`);
    process.exit(1);
  }
  const message = hookMessage(payload);
  if (message) {
    console.error(message);
    process.exit(2);
  }
}

/** Whether this file is the program. Node stamps `import.meta.url` with the resolved path
 *  and leaves `process.argv[1]` as it was typed, so both are resolved before comparing. */
function isMain() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMain()) main();
