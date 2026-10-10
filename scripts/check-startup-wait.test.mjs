// The startup-wait hook, shown each wait it refuses beside the good one it is a mutation of.
// The refused commands are the shapes that waited on a dev app already running: a sleeping
// loop around a grep of the dev server's log, in each spelling that has been written, and
// `pgrep -f` naming the binary. The allowed ones carry the same loop, the same grep or the
// same word, so a rule that fires on any of them alone fires on ordinary work.
//
// It also drives the wiring: the command `.claude/settings.json` registers is run as the
// harness runs it, since a checker nobody calls refuses nothing while every case here passes.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hookMessage, launchReminder, startupWaitFinding } from "./check-startup-wait.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./check-startup-wait.mjs", import.meta.url));

const REFUSED = [
  'until grep -c "Running `target/debug/urx-router`" work/dev.log; do sleep 5; done',
  "until grep -qF 'Running' work/dev.log; do sleep 2; done",
  'until grep -qE "Finished .*dev|error|panicked" work/dev.log; do sleep 5; done',
  'until grep -qE "Running `|error" work/dev.log; do sleep 3; done',
  'while ! rg -q "target/debug/urx-router" work/dev.log; do sleep 1; done',
  "tail -f work/dev.log | grep -m1 Running",
  'pgrep -f "/Users/x/urx-router/src-tauri/target/debug/urx-router"',
  "pgrep -fl urx-router",
];

const ALLOWED = [
  "until pgrep -x urx-router >/dev/null; do sleep 5; done",
  "pgrep -x urx-router",
  "grep -n Running docs/en/architecture.md",
  "for f in work/*.log; do grep -c Finished $f; done",
  'until grep -q "ready" work/server.log; do sleep 1; done',
  "while read line; do echo $line; done < work/list.txt",
  "pgrep -f vitest",
];

describe("what a command may wait on", () => {
  it.each(REFUSED)("refuses %s", (command) => {
    expect(startupWaitFinding(command)).toMatch(/pgrep -x urx-router/);
  });
  it.each(ALLOWED)("allows %s", (command) => {
    expect(startupWaitFinding(command)).toBeNull();
  });
});

describe("what a launch is answered with", () => {
  it("answers a background tauri dev launch with the process check", () => {
    expect(launchReminder("pnpm tauri dev -- -- --experimental > work/dev.log 2>&1", true)).toMatch(
      /pgrep -x urx-router/,
    );
  });
  it("says nothing about a foreground launch or another background command", () => {
    expect(launchReminder("pnpm tauri dev", false)).toBeNull();
    expect(launchReminder("pnpm test > work/t.log 2>&1", true)).toBeNull();
  });
  it("routes each event to its own rule and ignores other tools", () => {
    const wait = REFUSED[0];
    expect(
      hookMessage({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: wait } }),
    ).not.toBeNull();
    expect(
      hookMessage({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: wait } }),
    ).toBeNull();
    expect(
      hookMessage({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { command: wait } }),
    ).toBeNull();
  });
});

const payload = (event, command, background = false) =>
  JSON.stringify({ hook_event_name: event, tool_name: "Bash", tool_input: { command, run_in_background: background } });

describe("the program", () => {
  const run = (input) => spawnSync(process.execPath, [SCRIPT, "--hook"], { input, encoding: "utf8" });

  it("exits 2 with the reason on stderr for a refused wait", () => {
    const res = run(payload("PreToolUse", REFUSED[2]));
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/pgrep -x urx-router/);
  });
  it("exits 0 in silence for an allowed command", () => {
    const res = run(payload("PreToolUse", ALLOWED[0]));
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
  });
  it("reports an unreadable payload rather than passing it", () => {
    const res = run("not json");
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/nothing checked/);
  });
});

describe("the wiring", () => {
  const settings = JSON.parse(readFileSync(new URL("../.claude/settings.json", import.meta.url), "utf8"));
  const commandsFor = (event) =>
    (settings.hooks?.[event] ?? [])
      .filter((entry) => new RegExp(`^(?:${entry.matcher})$`).test("Bash"))
      .flatMap((entry) => entry.hooks.map((hook) => hook.command));
  const runRegistered = (command, input) =>
    spawnSync("sh", ["-c", command], { input, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT } });

  it.each([
    ["PreToolUse", payload("PreToolUse", REFUSED[0])],
    ["PostToolUse", payload("PostToolUse", "pnpm tauri dev > work/dev.log 2>&1", true)],
  ])("a command %s registers for Bash refuses what the checker refuses", (event, input) => {
    const results = commandsFor(event).map((command) => runRegistered(command, input));
    expect(results.some((res) => res.status === 2 && /pgrep -x urx-router/.test(res.stderr))).toBe(true);
  });
});
