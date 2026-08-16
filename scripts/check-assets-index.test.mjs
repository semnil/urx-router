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

import { classifyToken, mentions } from "./check-assets-index.mjs";

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
  it("does not let a longer shouted name answer for a shorter one", () => {
    expect("PWTEST_SHARD_WEIGHTS_DISABLED".includes("PWTEST_SHARD_WEIGHTS")).toBe(true);
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
