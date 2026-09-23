import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function check(guards, source) {
  const parent = join(repo, ".claude");
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, "skip-guards-"));
  const put = (path, text) => {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  try {
    put("package.json", '{"type":"module"}');
    put(
      "vitest.config.ts",
      'export default { cacheDir: ".cache", test: { include: ["src/*.test.ts"], maxWorkers: 1 } };',
    );
    put(
      "playwright.config.ts",
      'export default { testDir: "e2e/race", projects: [{ name: "race" }, { name: "race-webkit" }] };',
    );
    put(
      "e2e/race/guards.spec.ts",
      'import { test } from "@playwright/test";\n' +
        guards.map((_, i) => `test.skip("case ${i}", () => {});`).join("\n"),
    );
    put(
      "e2e/race/skip-ledger.json",
      JSON.stringify({
        collect: {
          minCases: { "e2e/race/guards.spec.ts": guards.length },
          minCasesWebkit: { "e2e/race/guards.spec.ts": guards.length },
          shardWeights: [guards.length],
        },
        skips: guards.map((title, i) => ({
          file: "e2e/race/guards.spec.ts",
          title: `case ${i}`,
          guardedBy: { file: "src/guards.test.ts", title },
        })),
      }),
    );
    put("src/guards.test.ts", source);
    put("executed.jsonl", "");
    put(".github/workflows/race.yml", readFileSync(join(repo, ".github/workflows/race.yml"), "utf8"));
    mkdirSync(join(dir, "scripts"));
    for (const file of ["check-race-skips.mjs", "shard-weights.mjs"])
      copyFileSync(join(repo, "scripts", file), join(dir, "scripts", file));
    const manifest = fileURLToPath(import.meta.resolve("vitest/package.json"));
    const runner = resolve(dirname(manifest), JSON.parse(readFileSync(manifest, "utf8")).bin.vitest);
    const warm = spawnSync(process.execPath, [runner, "run", "--reporter=json", "--outputFile=warm.json"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    expect(warm.error).toBeUndefined();
    const caches = readdirSync(join(dir, ".cache"), { recursive: true }).filter((file) =>
      file.endsWith("results.json"),
    );
    expect(caches).not.toHaveLength(0);
    const cached = caches.map((file) => readFileSync(join(dir, ".cache", file), "utf8"));
    put("executed.jsonl", "");
    const result = spawnSync(process.execPath, [join(dir, "scripts/check-race-skips.mjs")], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    expect(result.error).toBeUndefined();
    expect(
      caches.map((file) => readFileSync(join(dir, ".cache", file), "utf8")),
      "the partial guard run changed the full suite's result cache",
    ).toEqual(cached);
    return { ...result, executed: readFileSync(join(dir, "executed.jsonl"), "utf8").trim().split("\n") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the race skip guards", () => {
  it("runs the named guards without executing their siblings", () => {
    const result = check(
      ["suite > guard (a+b) [x]?", "literal > name > leaf"],
      `import { describe, expect, it } from "vitest";
       import { appendFileSync } from "node:fs";
       const ran = name => appendFileSync("executed.jsonl", name + "\\n");
       describe("suite", () => {
         it("guard (a+b) [x]?", () => { ran("guard"); expect(1).toBe(1); });
         it("guard (a+b) [x]? extra", () => ran("suffix"));
         it("another guard", () => { ran("sibling"); expect(1).toBe(2); });
       });
       describe("other suite", () => {
         it("guard (a+b) [x]?", () => ran("other suite"));
       });
       describe("literal > name", () => {
         it("leaf", () => { ran("literal"); expect(1).toBe(1); });
       });`,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.executed).toEqual(["guard", "literal"]);
  });

  it("rejects failed, skipped, missing and ambiguous guards after filtering", () => {
    const result = check(
      ["suite > failed", "suite > runtime skip", "suite > declared skip", "suite > missing", "a > b > c"],
      `import { describe, expect, it } from "vitest";
       describe("suite", () => {
         it("failed", () => expect(1).toBe(2));
         it("runtime skip", ({ skip }) => skip());
         it.skip("declared skip", () => {});
       });
       describe("a > b", () => it("c", () => expect(1).toBe(1)));
       describe("a", () => it("b > c", () => expect(1).toBe(1)));`,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"suite > failed", which vitest reports as "failed"');
    expect(result.stderr).toContain('"suite > runtime skip", which vitest reports as "skipped"');
    expect(result.stderr).toContain('"suite > declared skip", which vitest reports as "skipped"');
    expect(result.stderr).toContain('"suite > missing", which vitest does not run');
    expect(result.stderr).toContain('"a > b > c", which is the full name of 2');
  });
});
