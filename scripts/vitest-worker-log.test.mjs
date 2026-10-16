// The worker log is off unless URX_VITEST_WORKER_LOG is set, and a worker that dies mid-file is named by its file
// and its pid. The second is asked of vitest itself: a fixture run where one test file kills its own worker and
// another passes, with the setup file vitest.config.ts adds.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ENV = "URX_VITEST_WORKER_LOG";
const SETUP = "scripts/vitest-worker-log-setup.mjs";
const repo = fileURLToPath(new URL("..", import.meta.url));
const vitestBin = path.join(repo, "node_modules", "vitest", "vitest.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vitest-worker-log-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Each read is its own literal import, since a bundler resolves an import only from a literal path.
const reads = {
  on: () => import("../vitest.config.ts?on"),
  unset: () => import("../vitest.config.ts?unset"),
  empty: () => import("../vitest.config.ts?empty"),
};

/** vitest.config.ts as read with the variable set to `value`, or unset for `undefined`. */
async function configWith(value, tag) {
  const before = process.env[ENV];
  if (value === undefined) delete process.env[ENV];
  else process.env[ENV] = value;
  try {
    return (await reads[tag]()).default;
  } finally {
    if (before === undefined) delete process.env[ENV];
    else process.env[ENV] = before;
  }
}

describe("vitest.config.ts", () => {
  it("adds the setup file only when the variable names a file", async () => {
    expect((await configWith(path.join(tmp, "unused.log"), "on")).test.setupFiles).toEqual([SETUP]);
    expect((await configWith(undefined, "unset")).test.setupFiles).toEqual([]);
    expect((await configWith("", "empty")).test.setupFiles).toEqual([]);
    expect(fs.existsSync(path.join(repo, SETUP))).toBe(true);
  });
});

// The setup file run in a plain node process with `vitest` resolved to a stub, so each way a worker ends can be
// chosen: on its own, by SIGTERM, or by SIGKILL. Vitest itself ends a worker either of the first two ways and
// does not say which beforehand, so a fixture run cannot pick.
describe("the setup file, by how the worker ends", () => {
  const child = path.join(tmp, "worker.mjs");
  fs.writeFileSync(
    child,
    `import { registerHooks } from "node:module";\n` +
      `const stub = "data:text/javascript," + encodeURIComponent(` +
      `"export const expect = { getState: () => ({ testPath: '/x/some.test.ts' }) };");\n` +
      `registerHooks({ resolve: (s, c, next) => (s === "vitest" ? { url: stub, shortCircuit: true } : next(s, c)) });\n` +
      `await import(${JSON.stringify(path.join(repo, SETUP))});\n` +
      `const how = process.argv[2];\n` +
      `if (how === "SIGTERM" || how === "SIGKILL") {\n` +
      `  process.kill(process.pid, how);\n` +
      `  setTimeout(() => {}, 5000);\n` +
      `}\n`,
  );
  const end = (how) => {
    const log = path.join(tmp, `direct-${how}.log`);
    const r = spawnSync(process.execPath, [child, how], { env: { ...process.env, [ENV]: log }, timeout: 20_000 });
    const whats = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => l.match(/ pid=\d+ (start|end) /)[1]);
    return { status: r.status, signal: r.signal, whats };
  };

  it("writes one end line when the worker exits on its own", () => {
    expect(end("exit")).toEqual({ status: 0, signal: null, whats: ["start", "end"] });
  });

  it("writes one end line on SIGTERM, and the worker still dies of it", () => {
    expect(end("SIGTERM")).toEqual({ status: null, signal: "SIGTERM", whats: ["start", "end"] });
  });

  it("writes no end line when the worker is killed any other way", () => {
    expect(end("SIGKILL")).toEqual({ status: null, signal: "SIGKILL", whats: ["start"] });
  });
});

describe("a fixture run", () => {
  const dir = path.join(tmp, "fixture");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "vitest.config.mjs"),
    `export default { test: { globals: true, include: ["*.test.mjs"], ` +
      `setupFiles: process.env.${ENV} ? [${JSON.stringify(path.join(repo, SETUP))}] : [] } };\n`,
  );
  fs.writeFileSync(path.join(dir, "ok.test.mjs"), `test("passes", () => {});\n`);
  fs.writeFileSync(
    path.join(dir, "skipped.test.mjs"),
    `describe.skipIf(true)("skipped", () => {\n  test("never runs", () => {});\n});\n`,
  );
  const pidFile = path.join(tmp, "dying.pid");
  fs.writeFileSync(
    path.join(dir, "dies.test.mjs"),
    `import fs from "node:fs";\n` +
      `test("kills its own worker", async () => {\n` +
      `  fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
      `  process.kill(process.pid, "SIGKILL");\n` +
      `  await new Promise((r) => setTimeout(r, 5000));\n` +
      `});\n`,
  );
  const run = (env) =>
    spawnSync(process.execPath, [vitestBin, "run", "--root", dir, "--config", path.join(dir, "vitest.config.mjs")], {
      cwd: repo,
      env: { ...process.env, [ENV]: "", ...env },
      encoding: "utf8",
      timeout: 60_000,
    });
  const lines = (log) =>
    fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => {
        const [, pid, what, file] = l.match(/ pid=(\d+) (start|end) (.+)$/);
        return { pid: Number(pid), what, file: path.basename(file) };
      });

  it("names the file and the pid of a worker that died in it, and ends every file that finished", () => {
    const log = path.join(tmp, "on.log");
    const r = run({ [ENV]: log });
    expect(r.status).not.toBe(0);
    const got = lines(log);
    const dying = Number(fs.readFileSync(pidFile, "utf8"));
    expect(got.filter((l) => l.file === "dies.test.mjs")).toEqual([
      { pid: dying, what: "start", file: "dies.test.mjs" },
    ]);
    // A file that ran and one whose every test was skipped (no hooks run there) both end, once, in the worker
    // that started them.
    for (const name of ["ok.test.mjs", "skipped.test.mjs"]) {
      const own = got.filter((l) => l.file === name);
      expect(
        own.map((l) => l.what),
        name,
      ).toEqual(["start", "end"]);
      expect(own[0].pid, name).toBe(own[1].pid);
    }
  });

  it("writes nothing with the variable unset", () => {
    const before = fs.readdirSync(tmp);
    const r = run({});
    expect(r.status).not.toBe(0);
    expect(fs.readdirSync(tmp).filter((f) => !before.includes(f) && f !== "dying.pid")).toEqual([]);
  });
});
