// Runs in each vitest worker ahead of its test file, while URX_VITEST_WORKER_LOG names a file: it appends a
// `start` line with the worker's pid and the test file before the file loads, and one `end` line when the
// worker ends the way vitest ends it once the file is done — it exits on its own, or vitest sends it SIGTERM,
// whichever comes first, whether the file's tests ran or were all skipped. The SIGTERM is raised again once
// the line is written. A worker that dies any other way (a crash, a SIGKILL) writes no `end`, so a file with a
// `start` line and no `end` line is one whose worker died while running it, and the pid on that line is the
// one an OS crash report for that worker carries. macOS and Linux only: vitest.config.ts refuses the variable on
// Windows.
import fs from "node:fs";
import { expect } from "vitest";

const out = process.env.URX_VITEST_WORKER_LOG;
const file = expect.getState().testPath;
const line = (what) => fs.appendFileSync(out, `${new Date().toISOString()} pid=${process.pid} ${what} ${file}\n`);

const end = () => line("end");
line("start");
process.on("exit", end);
process.once("SIGTERM", () => {
  end();
  process.kill(process.pid, "SIGTERM");
});
