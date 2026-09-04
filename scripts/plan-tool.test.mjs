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

/** The app's own load. THREE stages: deserialize, the load-time repair, and the fill that
 *  completes a document from the model's factory values. The last is optional here because
 *  the two questions below are different — `appChanges` asks what the document's own values
 *  survive, and the fill answers about the ones it did not write. */
const appLoad = async (plan, fill) => {
  const { deserializeDocument } = await import("../src/core/plan.ts");
  const { paramRangeProblems, applyParamRange } = await import("../src/core/plan-validate.ts");
  const { fillFactoryParams } = await import("../src/models/initial-state.ts");
  const loaded = deserializeDocument(JSON.stringify(plan)).plan;
  applyParamRange(loaded, paramRangeProblems(loaded));
  if (fill) fillFactoryParams(loaded.modelId, loaded);
  return loaded;
};

/** Whether the app's load leaves this node's fxEffect as the document wrote it. */
const appChanges = async (plan) => {
  const loaded = await appLoad(plan, false);
  return JSON.stringify(loaded.nodeParams[NODE]?.fxEffect) !== JSON.stringify(plan.nodeParams[NODE].fxEffect);
};

/** Every leaf of `value`, by dotted path — the granularity the comparison below needs. */
const leavesOf = (value, path = [], out = new Map()) => {
  if (Array.isArray(value)) value.forEach((v, i) => leavesOf(v, [...path, String(i)], out));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) leavesOf(v, [...path, k], out);
  else if (path.length) out.set(path.join("."), value);
  return out;
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

    // …and the other side of the same fact, which silence used to hide: a plan that omits the
    // section does not leave the channel alone, since the app fills in its factory effect and
    // the write sends that. The advisory is a different line — the section is not present to
    // reset — and it has to be there, or an author reads the absence of a warning as safety.
    const omitted = { ...doc({}), nodeParams: { "bus.fx1": { level: -10 } } };
    const quiet = toolWarnings(dir, omitted);
    expect(quiet).not.toContain("resets that effect's parameters");
    expect(quiet).toContain("name no fxEffect");
    expect(quiet, "the channel it names is the one the document left out").toContain("bus.fx1");
  });

  // The two advisories a plan with `fxEffect.params` used to draw at once said opposite
  // things: "selecting an FX type resets that effect's parameters" and "omit to keep its
  // current value". Following the second — omitting the params and keeping the section —
  // writes the selector and every slot, which resets the effect the author meant to keep.
  // The shared advice is TRUE of the other two raw maps, and that is what makes this a
  // pair rather than a wording fix: `ssmcs` and `insertFxParams` write only the keys a plan
  // carries, so it stays on them and comes off FX.
  it("does not tell an FX plan to omit the params, and still tells an SSMCS plan to", () => {
    const KEEP = "omit to keep its current value";
    const fx = toolWarnings(dir, doc({ type: 0, params: { revxLpf: 40 } }));
    expect(fx).not.toContain(KEEP);
    // Nor the version that survived it: omitting the SECTION keeps nothing either, since the
    // loader completes what a document leaves out. An advisory offering that as the way to
    // preserve the effect sends an author to the one thing that does not preserve it.
    expect(fx).not.toContain("omit the whole fxEffect section to keep");
    expect(fx).toContain("neither does omitting the whole section");

    // The control, on the same run: the shared advice is not simply gone.
    const both = {
      ...doc({ type: 0, params: { revxLpf: 40 } }),
      nodeParams: {
        "bus.fx1": { fxEffect: { type: 0, params: { revxLpf: 40 } } },
        ch1: { ssmcs: { outGain: 10 } },
      },
    };
    const out = toolWarnings(dir, both);
    expect(out).toContain("SSMCS channel strip (raw curve values) — verify on the device");
    // …and the FX node is not the one carrying it.
    for (const line of out.split("\n").filter((l) => l.includes("verify on the device,"))) {
      expect(line, "the raw-map advice reaches no FX node").not.toContain("bus.fx");
    }
  });

  // What this tool must NOT do is decide whether omitting a raw key keeps the unit's value.
  // It carries routing data and no model of the write path, and that answer depends on things
  // only the write path knows — the channel's comp/EQ mode (SSMCS values are sent in one mode
  // and in no other), which family the selector names (a slot keyed under another family is
  // never sent), what the loader turns a bare slot number into with no selector present, and
  // which slots the unit recomputes for itself.
  //
  // A conditional version WAS written, and three of its branches contradicted the app: it
  // warned that the unit would recompute a strip the plan never sends, fired on a foreign
  // family's switch key, and told an author that bare slots would be sent "once this plan
  // selects an effect" when the loader had already dropped them. So the pin is the shape of
  // the answer rather than any one branch: the sentence is the SAME whatever else the plan
  // writes, which is what a tool with no emit model can honestly say.
  it("says the same thing about a raw map whatever else the plan writes", () => {
    const ch = (np) => ({ ...doc({}), nodeParams: { ch1: np } });
    const line = (out, note) =>
      out
        .split("\n")
        .filter((l) => l.includes(note))
        .join("|");
    const SSMCS = "SSMCS channel strip (raw curve values)";
    const ENGINE = "insert-FX engine parameters (raw slot values)";
    const SHAPES = [
      // Each pair is a plan the reverted branches answered DIFFERENTLY.
      [SSMCS, { ssmcs: { outGain: 10 } }],
      [SSMCS, { ssmcs: { morphing: 60, outGain: 10 } }],
      [SSMCS, { compEqType: 1, ssmcs: { morphing: 60, outGain: 10 } }],
      [SSMCS, { ssmcs: { sweetSpotData: 3, outGain: 10 } }],
      [ENGINE, { insertFxParams: { "mbc:8": 4 } }],
      [ENGINE, { insertFxParams: { 8: 4 } }],
      [ENGINE, { insertFx: 1793, insertFxParams: { "compander:1": 5 } }],
      [ENGINE, { insertFx: 1793, insertFxParams: { "mbc:6": 1 } }],
      [ENGINE, { insertFx: 1792, insertFxParams: { "mbc:6": 1, "mbc:8": 4 } }],
      [ENGINE, { insertFx: 1792, insertFxParams: { 6: 1, 8: 4 } }],
      [ENGINE, { insertFx: 512, insertFxParams: { "pitch:34": 1 } }],
    ];
    const said = new Map();
    for (const [note, np] of SHAPES) {
      const got = line(toolWarnings(dir, ch(np)), note);
      expect(got, `${note}: ${JSON.stringify(np)}`).not.toBe("");
      said.set(note, (said.get(note) ?? new Set()).add(got));
    }
    for (const [note, variants] of said) {
      expect([...variants], `${note} is said one way`).toHaveLength(1);
      // …and the one way it is said makes no promise about omission.
      expect([...variants][0]).toContain("Omitting a key is NOT a way to keep the unit's value");
      expect([...variants][0]).not.toContain("recompute");
    }
    // The advice it does keep, which needs no emit model: the selector reset, unchanged.
    expect(toolWarnings(dir, ch({ insertFx: 1793 }))).toContain(
      "selecting an insert effect resets that effect's parameters on the device",
    );
  });

  // The gap, as a count. Two documents the app rewrites and the tool cannot see — both need
  // the effect catalogue, which the bundled data does not carry.
  it("has exactly two blind spots, both needing the effect catalogue", () => {
    expect(CASES.filter(([, , changes, warns]) => changes && !warns).map(([name]) => name)).toEqual([
      "a number outside its parameter's window",
      "a type no channel offers",
    ]);
  });

  // The third stage the answers above rest on. `appChanges` asks what the SANITISER does to a
  // document's own values, which is only the tool's claim while the fill leaves those alone —
  // it completes absences, and a fill that altered a written value would make every verdict in
  // the table above describe a load the app no longer performs.
  it("completes a document without altering what it wrote", async () => {
    for (const [name, fx] of CASES.map(([n, f]) => [n, f])) {
      const plan = doc(fx);
      const two = (await appLoad(plan, false)).nodeParams[NODE]?.fxEffect;
      const three = (await appLoad(plan, true)).nodeParams[NODE]?.fxEffect;
      const after = leavesOf(three);
      for (const [path, value] of leavesOf(two)) expect(after.get(path), `${name} · ${path}`).toEqual(value);
    }
    // The positive control: the fill does add. Without it the loop above passes on two
    // identical objects and states nothing about a stage that ran.
    const plan = doc({ type: 0 });
    expect(leavesOf((await appLoad(plan, true)).nodeParams[NODE]?.fxEffect).size).toBeGreaterThan(
      leavesOf((await appLoad(plan, false)).nodeParams[NODE]?.fxEffect).size,
    );
  });

  // What the fill costs, said to the author before they hand the plan over. Silence used to be
  // how a plan preserved a channel; a document that names none of these three now writes the
  // factory value over whatever the unit holds, and the insert-FX one CLEARS the effect.
  it("names each selector a document leaves out", () => {
    const bare = { format: "urx-router-plan", version: 2, modelId: "URX44V", connections: [] };
    const out = toolWarnings(dir, bare);
    expect(out).toContain("name no fxEffect");
    expect(out).toContain("name no insertFx");
    // The SSMCS strip is conditional: the factory comp/EQ order sends none of it, so only a
    // document that selects the order and omits the values is warned about.
    expect(out).not.toContain("name no ssmcs");
    const ssmcs = { ...bare, nodeParams: { ch1: { compEqType: 1 } } };
    expect(toolWarnings(dir, ssmcs)).toContain("select the SSMCS comp/EQ order and name no ssmcs");
    // …and a document that carries the strip is not told about it.
    const dialled = { ...bare, nodeParams: { ch1: { compEqType: 1, ssmcs: { outGain: 10 } } } };
    expect(toolWarnings(dir, dialled)).not.toContain("name no ssmcs");
  });
});
