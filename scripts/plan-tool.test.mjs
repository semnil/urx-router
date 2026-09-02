// Pins the skill's plan validator against the app it describes.
//
// `.claude/skills/urx-routing-planner/scripts/plan_tool.py` is what an agent runs before it
// hands a generated plan to anyone, and its whole value is one sentence: a document it reports
// clean is one the app loads unchanged. Nothing held that sentence — the skill's hand-written
// half has no other test — so the tool answered OK for documents the loader silently rewrote.
//
// It is asked DIFFERENTIALLY rather than against a table of expected strings: each document is
// run through the tool and through the app's own load (deserialize, then the load-time repair),
// and the two answers have to agree about whether this document survives as written. A table of
// strings would go on passing after the loader changed, which is the failure being pinned.
//
// The two disagreements are declared, not tolerated: the tool carries routing data and no effect
// catalogue, so a finite number outside its parameter's window and a `type` the channel's menu
// does not offer are invisible to it. They are asserted as misses, so the gap is a number here
// rather than a sentence in a docstring.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TOOL = join(ROOT, ".claude/skills/urx-routing-planner/scripts/plan_tool.py");
const NODE = "bus.fx1";

const python = (() => {
  const r = spawnSync("python3", ["--version"], { encoding: "utf8" });
  return r.status === 0 ? "python3" : null;
})();

const doc = (fx) => ({
  format: "urx-router-plan",
  version: 2,
  modelId: "URX44V",
  positions: {},
  connections: [],
  nodeParams: { [NODE]: { fxEffect: fx } },
});

/** Every warning line, whatever it is about. The differential above reads only the paths the
 *  app removes; the selector advisory is a statement about what the WRITE does to a document
 *  the app keeps as written, so it has no place in that comparison and its own case reads
 *  the whole output. */
const toolWarnings = (dir, plan) => {
  const file = join(dir, "plan.json");
  writeFileSync(file, JSON.stringify(plan));
  const r = spawnSync(python, [TOOL, "validate", file], { encoding: "utf8" });
  expect(r.status, r.stdout).toBe(0);
  return r.stderr;
};

/** The paths the tool says the app removes. Node-level advice (selector warnings, "verify on
 *  the device") is not an answer to this question and is left out. */
const toolPaths = (dir, plan) => {
  const file = join(dir, "plan.json");
  writeFileSync(file, JSON.stringify(plan));
  const r = spawnSync(python, [TOOL, "validate", file], { encoding: "utf8" });
  // Warnings go to stderr and the verdict to stdout; a document that fails outright is a
  // different answer than a clean one, so the exit code is asserted rather than assumed.
  expect(r.status, r.stdout).toBe(0);
  return r.stderr
    .split("\n")
    .filter((l) => l.startsWith("WARNING: node param "))
    .map((l) => l.slice("WARNING: node param ".length).split(":")[0]);
};

/** Whether the app's load leaves this node's fxEffect as the document wrote it. */
const appChanges = async (plan) => {
  const { deserializeDocument } = await import("../src/core/plan.ts");
  const { paramRangeProblems, applyParamRange } = await import("../src/core/plan-validate.ts");
  const loaded = deserializeDocument(JSON.stringify(plan)).plan;
  applyParamRange(loaded, paramRangeProblems(loaded));
  return JSON.stringify(loaded.nodeParams[NODE]?.fxEffect) !== JSON.stringify(plan.nodeParams[NODE].fxEffect);
};

// Rev-X Hall's own LPF starts well above 0, and no channel offers type 12345 — the two the
// tool cannot answer without the app's effect catalogue.
const CASES = [
  ["a document the app writes itself", { on: true, type: 0, level: 50, params: { revxLpf: 40 } }, false, false],
  ["an empty effect object, whose key the app removes", {}, true, true],
  ["a boolean where a number belongs", { type: 0, level: false }, true, true],
  ["a boolean type", { type: false }, true, true],
  ["a boolean parameter map", { type: 0, params: false }, true, true],
  ["an object where a parameter belongs", { type: 0, params: { revxLpf: { x: 1 } } }, true, true],
  ["a string, which the sanitiser drops", { type: 0, level: "x" }, true, true],
  ["a null parameter, which the sanitiser drops", { type: 0, params: { revxLpf: null } }, true, true],
  ["an effect object that is not an object", false, true, true],
  ["an effect object that is an array", [{}], true, true],
  ["a number outside its parameter's window", { type: 0, params: { revxLpf: 0 } }, true, false],
  ["a type no channel offers", { type: 12345 }, true, false],
];

// Skipped BY NAME where python3 is absent, rather than passing over a tool it never ran.
describe.skipIf(!python)("plan_tool.py (python3) agrees with the app's loader", () => {
  const dir = mkdtempSync(join(tmpdir(), "urx-plan-tool-"));

  for (const [name, fx, changes, warns] of CASES) {
    it(name, async () => {
      const plan = doc(fx);
      // The app's answer first: a case that stopped exercising the loader would otherwise
      // pass by agreeing with a tool that also says nothing.
      expect(await appChanges(plan), "the app rewrites this document").toBe(changes);
      expect(toolPaths(dir, plan).length > 0, "the tool warns about it").toBe(warns);
    });
  }

  // The advisory that stops a plan author destroying an effect. Writing the FX section makes
  // the unit refill that effect's array with the type's defaults, and it is not recoverable —
  // and the selector goes out whether or not the document names a type, since an absent one
  // resolves to the channel's factory type. Asked about the `type` KEY instead, a plan saying
  // only `{ "level": 80 }` was silently in that class.
  it("warns on the effect section's presence, not on a named type", () => {
    const named = toolWarnings(dir, doc({ type: 0, level: 80 }));
    const unnamed = toolWarnings(dir, doc({ level: 80 }));
    for (const [what, out] of [
      ["a named type", named],
      ["no type named", unnamed],
    ]) {
      expect(out, what).toContain("resets that effect's parameters on the device");
    }
    // …and the one without a type says so, since the author did not write the selector.
    expect(unnamed).toContain("names no type");
    expect(named).not.toContain("names no type");

    // The control: a plan that omits the section is the way to leave the effect alone, and
    // nothing about it is advised against.
    const omitted = { ...doc({}), nodeParams: { "bus.fx1": { level: -10 } } };
    expect(toolWarnings(dir, omitted)).not.toContain("resets that effect's parameters");
  });

  // The gap, as a count. Two documents the app rewrites and the tool cannot see — both need
  // the effect catalogue, which the bundled data does not carry.
  it("has exactly two blind spots, both needing the effect catalogue", () => {
    expect(CASES.filter(([, , changes, warns]) => changes && !warns).map(([name]) => name)).toEqual([
      "a number outside its parameter's window",
      "a type no channel offers",
    ]);
  });
});
