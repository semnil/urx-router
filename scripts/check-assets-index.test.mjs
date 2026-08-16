// The asset checker's token classifier, shown the shapes whose ORDER is the whole rule — and
// the one it got wrong. `CONSOLE` in a code span passed as a verified environment variable
// for one commit, and the assertion count went UP by one, because "any shouted word" was
// tried before the fall-through that forces an author to classify a token. Nothing could see
// it: this file had no test at all, and the checker's own run reported a bigger number and a
// clean exit.
//
// That this file imports the checker at all is the other half. The module walks the tree,
// spawns git and calls process.exit, so before the CLI guard an import ran the whole check
// inside the test worker — which is why the classifier could only ever be measured by
// mutating the repository and reading a count.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ENV_CORPUS, ENV_NAME, SELF_FILES, classifyToken, mentions, walk } from "./check-assets-index.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("classifyToken", () => {
  it("routes each shape the section writes to its own oracle", () => {
    expect(classifyToken("pnpm test:e2e:race t9-probe")).toBe("pnpm");
    expect(classifyToken("UPDATE_SKILL=1 pnpm test skill-export")).toBe("pnpm");
    expect(classifyToken("node scripts/race-shard-weights.mjs")).toBe("node");
    expect(classifyToken("python3 .claude/skills/urx-routing-planner/scripts/plan_tool.py validate")).toBe("python");
    expect(classifyToken("window.__urxConsole")).toBe("handle");
    expect(classifyToken("--experimental")).toBe("flag");
    expect(classifyToken("VITE_TRACE=1")).toBe("envAssign");
    expect(classifyToken("e2e/race/fake-device.ts")).toBe("path");
    expect(classifyToken("PWTEST_SHARD_WEIGHTS")).toBe("env");
    expect(classifyToken("--")).toBe("prose"); // PROSE_TOKENS, by default
  });

  // The defect this file exists for. Both of these are the section's prose voice, and both
  // reach a real oracle the moment "shouted" is the whole test: the env branch is a search of
  // the repository for a string, and the repository contains the words CONSOLE and OFF.
  it("leaves a shouted word with no underscore unclassified", () => {
    expect(classifyToken("CONSOLE")).toBe("unclassified");
    expect(classifyToken("OFF")).toBe("unclassified");
    expect(classifyToken("GRAPH")).toBe("unclassified");
  });

  // The other half of the ordering. An all-caps name a row's own file exports is answerable
  // against that file, which is the stronger of the two readings, so the env shape has to be
  // tried after it and not before.
  it("prefers the row's own export to the env shape", () => {
    const isRowExport = (name) => name === "FILE_HEADER";
    expect(classifyToken("FILE_HEADER", { isRowExport })).toBe("rowExport");
    expect(classifyToken("FILE_HEADER")).toBe("env");
    expect(classifyToken("colorToken", { isRowExport: () => true })).toBe("rowExport");
    expect(classifyToken("colorToken")).toBe("unclassified");
  });
});

// A name held against the repository. Substring was the first spelling and it let a longer
// name answer for a shorter one — which is not hypothetical here: the only mention of
// PWTEST_SHARD_WEIGHTS_DISABLED in this repository is as the name of a mutation a pin
// performs, so deleting the real variable would have left the assertion green.
describe("mentions", () => {
  // `includes` answers true to both of these, which is what the oracle used to do.
  it("does not let a longer shouted name answer for a shorter one", () => {
    expect(mentions("PWTEST_SHARD_WEIGHTS_DISABLED", "PWTEST_SHARD_WEIGHTS")).toBe(false);
    expect(mentions("SOME_PWTEST_SHARD_WEIGHTS", "PWTEST_SHARD_WEIGHTS")).toBe(false);
  });

  // The other caller: an in-page handle, where the same collision is one `__urxTraceProbe`
  // away from being live.
  it("does the same for a published handle", () => {
    expect(mentions("window.__urxTraceProbe = probe;", "__urxTrace")).toBe(false);
    expect(mentions("window.__urxTrace = probe;", "__urxTrace")).toBe(true);
  });

  it("reads the spellings a name is actually written in", () => {
    expect(mentions("  PWTEST_SHARD_WEIGHTS: ${{ needs.detect.outputs.weights }}", "PWTEST_SHARD_WEIGHTS")).toBe(true);
    expect(mentions('if [ -z "$PWTEST_SHARD_WEIGHTS" ]; then', "PWTEST_SHARD_WEIGHTS")).toBe(true);
    expect(mentions("process.env.VITE_TRACE", "VITE_TRACE")).toBe(true);
  });
});

describe("ENV_CORPUS", () => {
  it("takes the places a variable is set or read, and nothing else", () => {
    expect(ENV_CORPUS.test(".github/workflows/race.yml")).toBe(true);
    expect(ENV_CORPUS.test("scripts/shard-weights.mjs")).toBe(true);
    expect(ENV_CORPUS.test("src/core/env.ts")).toBe(true);
    expect(ENV_CORPUS.test(".env.demo")).toBe(true);
    expect(ENV_CORPUS.test("vitest.config.ts")).toBe(true);
    // Not the whole tree: a corpus that reads the documents would be answered by the very
    // sentence making the claim, which is the shape this oracle exists to refuse.
    expect(ENV_CORPUS.test("docs/en/architecture.md")).toBe(false);
    expect(ENV_CORPUS.test("CLAUDE.md")).toBe(false);
    expect(ENV_CORPUS.test("package.json")).toBe(false);
    expect(ENV_CORPUS.test("src-tauri/src/lib.rs")).toBe(false);
    // The one a directory-shaped rule lets back in: a document that lives under .github/ and
    // repeats what the asset table claims.
    expect(ENV_CORPUS.test(".github/PULL_REQUEST_TEMPLATE.md")).toBe(false);
  });

  // The exclusion half asked of the tree rather than of nine literals: a document entering the
  // corpus is the failure the predicate exists to prevent, and only a corpus-level reading can
  // see one arrive. The literals above say what the rule means; this says what it admits.
  it("admits no document and neither of the two files that would answer for themselves", () => {
    const corpus = walk(repo)
      .map((f) => f.slice(repo.length + 1))
      .filter((f) => ENV_CORPUS.test(f));
    expect(corpus.filter((f) => f.endsWith(".md"))).toEqual([]);
    expect(corpus.filter((f) => f.startsWith("docs/"))).toEqual([]);
    // …and the predicate admits both halves of this checker, which is why the corpora subtract
    // SELF_FILES after applying it. Held here because that subtraction happens inside the CLI
    // guard, where nothing else can reach it.
    expect(corpus).toContain("scripts/check-assets-index.mjs");
    expect(corpus).toContain("scripts/check-assets-index.test.mjs");
    expect([...SELF_FILES].sort()).toEqual(["scripts/check-assets-index.mjs", "scripts/check-assets-index.test.mjs"]);
  });

  // Why the corpus was widened, computed from the tree rather than asserted: this derives the
  // names a workflow carries and src/, e2e/ and scripts/ do not, and asserts there is at least
  // one — while .github/ sat outside the corpus, such a name read as "appears nowhere in the
  // repo". Derived rather than spelled, so a rename in a workflow cannot fail this for a
  // reason it is not about.
  it("reaches names that live only in a workflow", () => {
    // The checker's own walk, so the paths carry forward slashes on every platform — built with
    // join() alone they are backslashes on Windows, where ENV_CORPUS keeps only the arms that
    // have no separator in them (`.env*`, `*.config.ts`). That does not empty the corpus, it
    // shrinks it to five files, and this case then passes MORE easily: `outside` collapses from
    // 5.47 MB to 0.01 MB, so 31 names look workflow-only where 22 are. Measured by simulating
    // the shape rather than asserting it.
    const tree = walk(repo).map((f) => f.slice(repo.length + 1));
    expect(tree.some((f) => f.startsWith("src/"))).toBe(true);
    const files = tree.filter((f) => f.startsWith(".github/"));
    const outside = tree
      .filter((f) => ENV_CORPUS.test(f) && !f.startsWith(".github/"))
      .map((f) => readFileSync(join(repo, f), "utf8"))
      .join("\n");
    // The classifier's own shape, so a change to what counts as a variable cannot leave this
    // enumerating the old one.
    const inWorkflows = new Set();
    for (const f of files) {
      for (const m of readFileSync(join(repo, f), "utf8").matchAll(new RegExp(`\\b${ENV_NAME}\\b`, "g"))) {
        inWorkflows.add(m[0]);
      }
    }
    const onlyThere = [...inWorkflows].filter((name) => !mentions(outside, name));
    expect(onlyThere.length).toBeGreaterThan(0);
  });
});
