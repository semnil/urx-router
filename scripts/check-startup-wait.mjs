#!/usr/bin/env node
// Refuses the ways of waiting for the dev app (`pnpm tauri dev`) that cannot see it come up,
// and answers a background launch with the check that can.
//
//   node scripts/check-startup-wait.mjs --hook   read a Claude Code PreToolUse or PostToolUse
//                                                payload from stdin
//
// PreToolUse, Bash: a command that waits for the app by reading the dev server's log — a loop
// that sleeps, or a `tail -f`, around a grep for the lines cargo prints — is refused, and so is
// `pgrep -f` naming the binary. The log carries an SGR reset between `Running` and the binary's
// path, so no fixed string matches that line; the binary is started from `src-tauri/` with the
// relative argv `target/debug/urx-router`, so an absolute path never matches it, and a match on
// the whole argv also finds the shells wrapping it. The process NAME identifies the app:
// `pgrep -x urx-router`.
//
// PostToolUse, Bash: a background launch of `tauri dev` is answered with that check, since a
// background command reports only when it exits, and the app exits when its window closes.
//
// Both events feed a hook's stderr back to Claude on exit 2; everything else exits 0.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WAIT = /\b(?:until|while)\b[\s\S]*\bsleep\b|\btail\s+(?:-\w*f|--follow)\b/;
const GREP = /\b(?:e?grep|rg)\b([^|;&\n]*)/g;
const LOG_MARKER = /Running|Finished|target\/debug|panicked/;
const PGREP_FULL = /\bpgrep\b(?=[^|;&\n]*\s-[a-zA-Z]*f)[^|;&\n]*urx-router/;
const TAURI_DEV = /\btauri\s+dev\b/;

const CHECK = [
  "Check the process instead: `pgrep -x urx-router` once, in this turn, and `lsof -a -p <pid> -d cwd -Fn`",
  "for which tree built it. To wait, run `until pgrep -x urx-router >/dev/null; do sleep 5; done` in the",
  "background, after that one check has shown whether the app is already up.",
].join(" ");

/** The reason `command` cannot see the dev app come up, or null when it is not such a wait. */
export function startupWaitFinding(command) {
  if (PGREP_FULL.test(command)) {
    return `startup-wait: \`pgrep -f\` matches the whole argv — the app's is the relative \`target/debug/urx-router\`, and the shells wrapping it match too. ${CHECK}`;
  }
  if (!WAIT.test(command)) return null;
  for (const [, args] of command.matchAll(GREP)) {
    if (LOG_MARKER.test(args)) {
      return `startup-wait: this waits on the dev server's log, whose \`Running\` line carries an SGR reset before the binary's path, so no pattern written here matches it, and the app being up is not a log line. ${CHECK}`;
    }
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
  if (!process.argv.includes("--hook")) {
    console.error("usage: node scripts/check-startup-wait.mjs --hook  (a hook payload on stdin)");
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
