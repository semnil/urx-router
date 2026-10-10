// The startup-wait hook, shown each wait it refuses beside the good one it is a mutation of.
// The refused commands are the shapes that waited on a dev app already running: a sleeping
// loop around a grep of the dev server's log, in each spelling that has been written, and
// `pgrep -f` naming the binary. The allowed ones carry the same loop, the same grep or the
// same word, so a rule that fires on any of them alone fires on ordinary work — including the
// same words quoted as a search pattern, and a log grep written after a loop has ended.
//
// The check the hook points at is run against real processes: an app built by another tree
// must not answer for this one, which is the case a bare `pgrep -x` cannot tell apart, and its
// waiting form must go on waiting only while the answer is "not running".
//
// It also drives the wiring: the command `.claude/settings.json` registers is run as the
// harness runs it, since a checker nobody calls refuses nothing while every case here passes.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { devAppPid, hookMessage, launchReminder, startupWaitFinding } from "./check-startup-wait.mjs";

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
  'until [ -n "$(pgrep -f urx-router)" ]; do sleep 1; done',
  "while true; do if grep -q Running work/dev.log; then break; fi; sleep 5; done",
  "tail -F work/dev.log | sed -u 's/x/y/' | grep -m1 Running",
  "cat <<'EOF'\nok\nEOF\npgrep -f urx-router",
  "cat <<EOF\n$(pgrep -f urx-router)\nEOF",
  "cat <<EOF\n\\\\$(pgrep -f urx-router)\nEOF",
  'echo "\\\\$(pgrep -f urx-router)"',
];

const ALLOWED = [
  "until pgrep -x urx-router >/dev/null; do sleep 5; done",
  "pgrep -x urx-router",
  "grep -n Running docs/en/architecture.md",
  "for f in work/*.log; do grep -c Finished $f; done",
  'until grep -q "ready" work/server.log; do sleep 1; done',
  "while read line; do echo $line; done < work/list.txt",
  "pgrep -f vitest",
  "rg -n 'pgrep -f urx-router' scripts CLAUDE.md",
  'grep -n "until grep -q Running work/dev.log; do sleep 5; done" CLAUDE.md',
  "while kill -0 $pid; do sleep 5; done; rg -n panicked work/cargo-test.log",
  "until ! pgrep -x cargo >/dev/null; do sleep 5; done\ngrep -n Finished work/cargo-test.log",
  "tail -n 50 work/dev.log | grep Running",
  "tail -f work/dev.log > work/copy.log; grep Running work/dev.log",
  "node scripts/check-startup-wait.mjs --pid /x/tree --wait",
  "cat <<'EOF'\npgrep -f urx-router\nEOF",
  'cat <<-"EOF"\n\tpgrep -f urx-router\n\tEOF',
  "cat <<'EOF' > work/repro.sh\nuntil grep -q Running work/dev.log; do sleep 1; done\nEOF",
  "cat <<EOF\n\\$(pgrep -f urx-router)\nEOF",
  "cat <<EOF\n\\`pgrep -f urx-router\\`\nEOF",
  'echo "\\$(pgrep -f urx-router)"',
];

describe("what a command may wait on", () => {
  it.each(REFUSED)("refuses %s", (command) => {
    expect(startupWaitFinding(command)).toMatch(/--pid <tree>/);
  });
  it.each(ALLOWED)("allows %s", (command) => {
    expect(startupWaitFinding(command)).toBeNull();
  });
});

describe("what a launch is answered with", () => {
  it("answers a background tauri dev launch with the process check", () => {
    expect(launchReminder("pnpm tauri dev -- -- --experimental > work/dev.log 2>&1", true)).toMatch(/--pid <tree>/);
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
    expect(res.stderr).toMatch(/--pid <tree>/);
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

describe("which app the check names", () => {
  const cwds = { 11: "/x/other/src-tauri", 12: "/x/tree/src-tauri", 13: null };
  const tree = mkdtempSync(join(tmpdir(), "startup-wait-"));
  mkdirSync(join(tree, "src-tauri"));
  const cwdOf = (pid) => (pid === "12" ? join(tree, "src-tauri") : cwds[pid]);

  it("names the process whose working directory is the tree's src-tauri, and no other", () => {
    expect(devAppPid(tree, { pids: () => ["11", "13"], cwdOf })).toBeNull();
    expect(devAppPid(tree, { pids: () => ["11", "13", "12"], cwdOf })).toBe("12");
  });
  it("refuses a tree with no src-tauri rather than reading it as an app not running", () => {
    expect(() => devAppPid(join(tree, "missing"), { pids: () => [], cwdOf })).toThrow();
  });
});

const which = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).stdout.trim();
const tools = ["pgrep", "lsof", "bash"].map(which);

describe.skipIf(tools.some((path) => path === ""))("which app the check names, among real processes", () => {
  const root = mkdtempSync(join(tmpdir(), "startup-wait-"));
  const children = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const launch = (name) => {
    const dir = join(root, name, "src-tauri");
    mkdirSync(dir, { recursive: true });
    // A link to bash: a process started through a link takes the link's name and bash keeps it,
    // and a builtin read on a pipe nothing writes holds it up with no child to leave behind.
    const binary = join(dir, "urx-router");
    symlinkSync(tools[2], binary);
    const child = spawn(binary, ["-c", "read -t 30 _"], { cwd: dir, stdio: ["pipe", "ignore", "pipe"] });
    children.push(child);
    const dummy = { tree: join(root, name), pid: String(child.pid), exit: null, stderr: "" };
    child.stderr.on("data", (chunk) => (dummy.stderr += chunk));
    child.on("exit", (code, signal) => (dummy.exit = `${code}/${signal}`));
    return dummy;
  };
  const nameOf = (pid) => spawnSync("ps", ["-o", "comm=", "-p", pid], { encoding: "utf8" }).stdout.trim();
  // Waits until the check names the dummy; a dummy that is not running is reported as such,
  // with what it printed and what the process table holds under the app's name, rather than
  // as a check that answered null.
  const named = (dummy) =>
    vi.waitFor(
      () => {
        const table = spawnSync("pgrep", ["-lx", "urx-router"], { encoding: "utf8" }).stdout.trim();
        expect(
          { answer: devAppPid(dummy.tree), exit: dummy.exit, stderr: dummy.stderr },
          `pgrep -lx urx-router: [${table}]; the dummy runs as [${nameOf(dummy.pid)}], through a link to ${realpathSync(tools[2])}`,
        ).toEqual({ answer: dummy.pid, exit: null, stderr: "" });
      },
      { timeout: 5000 },
    );
  const cli = (tree) => spawnSync(process.execPath, [SCRIPT, "--pid", tree], { encoding: "utf8" });

  it("waits through an app another tree built and answers once this tree's is up", async () => {
    mkdirSync(join(root, "tree", "src-tauri"), { recursive: true });
    const other = launch("other");
    await named(other);
    expect(devAppPid(join(root, "tree"))).toBeNull();
    const refused = cli(join(root, "tree"));
    expect([refused.status, refused.stdout]).toEqual([1, ""]);

    const own = launch("tree");
    await named(own);
    const answered = cli(join(root, "tree"));
    expect([answered.status, answered.stdout.trim()]).toEqual([0, own.pid]);
  });
  it("waits while the tree's app is not running and exits with its PID once it is", async () => {
    mkdirSync(join(root, "late", "src-tauri"), { recursive: true });
    const other = launch("elsewhere");
    await named(other);
    const waiter = spawn(process.execPath, [SCRIPT, "--pid", join(root, "late"), "--wait"], { stdio: "pipe" });
    children.push(waiter);
    let stdout = "";
    waiter.stdout.on("data", (chunk) => (stdout += chunk));
    const exited = new Promise((resolve) => waiter.on("exit", (code) => resolve(code)));
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(waiter.exitCode).toBeNull();

    const own = launch("late");
    expect(await exited).toBe(0);
    expect(stdout.trim()).toBe(own.pid);
  });
  it("reads a process that has exited as no app rather than as a failed read", () => {
    const gone = String(spawnSync("true").pid);
    expect(devAppPid(join(root, "tree"), { pids: () => [gone] })).toBeNull();
  });
  it.each([[[]], [["--wait"]]])(
    "exits 2 at once when lsof cannot read a running app's directory (%j)",
    async (extra) => {
      const bin = join(root, "failing-lsof");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "lsof"), "#!/bin/sh\necho 'lsof: injected failure' >&2\nexit 1\n", { mode: 0o755 });
      const running = launch(`unread-${extra.length}`);
      await named(running);
      const res = spawnSync(process.execPath, [SCRIPT, "--pid", running.tree, ...extra], {
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      expect([res.signal, res.status, res.stdout]).toEqual([null, 2, ""]);
      expect(res.stderr).toMatch(/injected failure/);
    },
  );
  it.each([[[]], [["--wait"]]])(
    "exits 2 at once for a tree with no src-tauri, which waiting must not read as not yet (%j)",
    (extra) => {
      const res = spawnSync(process.execPath, [SCRIPT, "--pid", join(root, "missing"), ...extra], {
        encoding: "utf8",
        timeout: 5000,
      });
      expect([res.signal, res.status]).toEqual([null, 2]);
      expect(res.stderr).toMatch(/cannot tell/);
    },
  );
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
    expect(results.some((res) => res.status === 2 && /--pid <tree>/.test(res.stderr))).toBe(true);
  });
});
