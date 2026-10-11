// Pins the plan_tool.py session's own failure handling against stand-in tools, since the real
// tool answers every document and never shows what a stopped interpreter does to the session.

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atLeast, newestPython } from "./python.test-util.mjs";
import { planToolSession } from "./plan-tool.test-util.mjs";

const found = newestPython();
const python = atLeast(found, 3, 7) ? found.exe : null;

/** A directory holding a plan_tool.py that runs `prelude` on import, and whose main() writes its
 *  pid to `pid.txt` and then runs `body`. */
const standIn = (body, prelude = "") => {
  const dir = mkdtempSync(join(tmpdir(), "urx-plan-tool-stand-in-"));
  writeFileSync(
    join(dir, "plan_tool.py"),
    [
      "import os, sys, threading, time",
      prelude,
      "def main(argv):",
      `    with open(os.path.join(${JSON.stringify(dir)}, "pid.txt"), "w") as fh:`,
      "        fh.write(str(os.getpid()))",
      `    ${body}`,
      "",
    ].join("\n"),
  );
  return dir;
};
const pidOf = (dir) => Number(readFileSync(join(dir, "pid.txt"), "utf8"));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Polls until `pid` has exited, failing after `ms`. */
const gone = async (pid, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() > deadline) throw new Error(`process ${pid} is still running`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe.skipIf(!python)("the plan_tool.py session", () => {
  const open = [];
  afterEach(async () => {
    for (const s of open.splice(0)) await s.close();
  });
  const session = (dir, opts) => {
    const s = planToolSession(python, dir, opts);
    open.push(s);
    return s;
  };

  // The positive control: a tool that answers is a session that answers, and closing it ends
  // the interpreter.
  it("answers and ends its interpreter on close", async () => {
    const dir = standIn("print('OK'); return 0");
    const s = session(dir);
    expect(s.run(["validate", "x"])).toEqual({ status: 0, stdout: "OK\n", stderr: "" });
    const pid = pidOf(dir);
    expect(alive(pid)).toBe(true);
    await s.close();
    await gone(pid);
  });

  it("throws within its bound on a tool that stops answering, refuses every later call, and ends the interpreter", async () => {
    const dir = standIn("time.sleep(3600)");
    const s = session(dir, { timeoutMs: 1_000 });
    const t0 = Date.now();
    expect(() => s.run(["validate", "x"])).toThrow(/gave no answer to validate x in 1000 ms/);
    expect(Date.now() - t0).toBeLessThan(10_000);
    const t1 = Date.now();
    expect(() => s.run(["validate", "y"])).toThrow(/stopped answering earlier/);
    expect(Date.now() - t1).toBeLessThan(1_000);
    const pid = pidOf(dir);
    await gone(pid);
    await s.close();
  });

  // A thread that is not a daemon keeps the interpreter alive after its input loop ends.
  const LINGERS = "threading.Thread(target=time.sleep, args=(3600,)).start()";

  it("kills an interpreter that is still running once its input has closed", async () => {
    const dir = standIn("return 0", LINGERS);
    const s = session(dir, { closeGraceMs: 500 });
    expect(s.run(["validate", "x"]).status).toBe(0);
    const pid = pidOf(dir);
    const t0 = Date.now();
    await s.close();
    expect(Date.now() - t0).toBeLessThan(5_000);
    await gone(pid);
  });

  it("kills the interpreter and rejects when closing overruns its bound", async () => {
    const dir = standIn("return 0", LINGERS);
    const s = session(dir, { closeGraceMs: 60_000 });
    expect(s.run(["validate", "x"]).status).toBe(0);
    const pid = pidOf(dir);
    await expect(s.close()).rejects.toThrow(/did not end within 5000 ms/);
    await gone(pid);
  });

  it("ends the interpreter of an exited session without waiting", async () => {
    const dir = standIn("os._exit(3)");
    const s = session(dir);
    expect(() => s.run(["validate", "x"])).toThrow(/process exited \(code 3/);
    expect(existsSync(join(dir, "pid.txt"))).toBe(true);
    await gone(pidOf(dir));
    await s.close();
  });
});
