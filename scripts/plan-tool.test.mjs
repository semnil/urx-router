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
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deserialize, PLAN_VERSION } from "../src/core/plan";
import { insertFxPairProblems, paramRangeProblems } from "../src/core/plan-validate";
import { getModel, MODEL_IDS } from "../src/models";
import { INSERT_FX_OPTIONS } from "../src/core/control/params";
import { insertFxWritableSlots } from "../src/core/control/insert-fx-effect";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TOOL = join(ROOT, ".claude/skills/urx-routing-planner/scripts/plan_tool.py");
const NODE = "bus.fx1";

const python = (() => {
  const r = spawnSync("python3", ["--version"], { encoding: "utf8" });
  return r.status === 0 ? "python3" : null;
})();

const doc = (fx) => ({
  format: "urx-router-plan",
  version: PLAN_VERSION,
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

// Rev-X Hall's own LPF starts well above 0, and no channel offers type 12345. These were the
// two the tool could not answer while models.json carried routing alone; it carries the FX
// channels' menus and admitted sets now, so both are answered and the rows say so. What they
// pin is that the tool's warning and the app's repair agree per document, which is the same
// question every other row asks.
const CASES = [
  ["a document the app writes itself", { on: true, type: 0, params: { revxLpf: 40 } }, false, false],
  ["an empty effect object, whose key the app removes", {}, true, true],
  ["a boolean where a number belongs", { type: 0, params: { revxLpf: false } }, true, true],
  // Array slot 2, which the app removes at the load whatever the value is. A finite number in
  // its old window is the shape that reads as valid, so it is the one asked here.
  ["the effect array's slot 2, which the app no longer carries", { type: 0, level: 80 }, true, true],
  ["a boolean type", { type: false }, true, true],
  ["a boolean parameter map", { type: 0, params: false }, true, true],
  ["an object where a parameter belongs", { type: 0, params: { revxLpf: { x: 1 } } }, true, true],
  ["a string, which the sanitiser drops", { type: 0, params: { revxLpf: "x" } }, true, true],
  ["a null parameter, which the sanitiser drops", { type: 0, params: { revxLpf: null } }, true, true],
  ["an effect object that is not an object", false, true, true],
  ["an effect object that is an array", [{}], true, true],
  ["a number outside its parameter's window", { type: 0, params: { revxLpf: 0 } }, true, true],
  ["a type no channel offers", { type: 12345 }, true, true],
];

// Skipped BY NAME where python3 is absent, rather than passing over a tool it never ran.
// The two carry the format version separately — one in TypeScript, one in Python — and the
// tool REFUSES a document tagged higher than its own. Left behind by a bump, it would report
// `planVersionUnsupported` for every document the app now writes, which is the opposite of a
// missed drop and just as wrong. Read out of the file rather than run, so it holds whether or
// not python3 is here.
describe("the version the two halves read", () => {
  it("is one number", () => {
    const src = readFileSync(TOOL, "utf8");
    const declared = /^PLAN_VERSION = (\d+)$/m.exec(src);
    expect(declared, "plan_tool.py declares no PLAN_VERSION").not.toBeNull();
    expect(Number(declared[1])).toBe(PLAN_VERSION);
  });
});

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
    expect(quiet).toContain("carry no usable fxEffect");
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

  // The gap, as a count. It was two — a number outside its parameter's window and a type no
  // channel offers, both needing the FX channel's catalogue — and models.json carries that
  // catalogue now, so it is NONE. Asserted as a number rather than deleted: a table of cases
  // where the app rewrites and the tool says nothing is exactly what the whole file exists to
  // keep at zero, and a row that stops warning tomorrow has to land here rather than passing
  // as one more green case.
  it("has no blind spots left", () => {
    expect(CASES.filter(([, , changes, warns]) => changes && !warns).map(([name]) => name)).toEqual([]);
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
    const bare = { format: "urx-router-plan", version: PLAN_VERSION, modelId: "URX44V", connections: [] };
    const out = toolWarnings(dir, bare);
    expect(out).toContain("carry no usable fxEffect");
    expect(out).toContain("carry no usable insertFx");
    // The SSMCS strip is conditional: the factory comp/EQ order sends none of it, so only a
    // document that selects the order and omits the values is warned about.
    expect(out).not.toContain("carry no usable ssmcs");
    const ssmcs = { ...bare, nodeParams: { ch1: { compEqType: 1 } } };
    expect(toolWarnings(dir, ssmcs)).toContain("select the SSMCS comp/EQ order and carry no usable ssmcs");
    // …and a document that carries the strip is not told about it.
    const dialled = { ...bare, nodeParams: { ch1: { compEqType: 1, ssmcs: { outGain: 10 } } } };
    expect(toolWarnings(dir, dialled)).not.toContain("carry no usable ssmcs");
  });

  // Each of the three asks whether the document carries a value the app can USE. A key holding
  // the wrong kind of thing is dropped on load and completed from the factory, which lands
  // exactly where an absent key lands — so a rule reading the key's PRESENCE tells the author
  // the opposite of what the write does, on the document most likely to have got it wrong.
  it.each([
    ["a number where the effect object goes", { "bus.fx1": { fxEffect: 5 } }, "carry no usable fxEffect", true],
    ["an effect object the app removes", { "bus.fx1": { fxEffect: {} } }, "carry no usable fxEffect", true],
    [
      "an effect the document wrote",
      { "bus.fx1": { fxEffect: { type: 0 } } },
      "bus.fx1, bus.fx2: carry no usable fxEffect",
      false,
    ],
    ["a boolean where the selector goes", { ch1: { insertFx: true } }, "ch1, ch2", true],
    ["a selector the document wrote", { ch1: { insertFx: 1793 } }, "ch1, ch2", false],
  ])("%s", (_name, nodeParams, needle, warned) => {
    const out = toolWarnings(dir, {
      format: "urx-router-plan",
      version: 2,
      modelId: "URX44V",
      connections: [],
      nodeParams,
    });
    expect(out.includes(needle)).toBe(warned);
  });

  // A STEREO-linked MONO IN pair holds ONE insert effect between its two channels, and
  // plan-schema.md tells an author to put the same value on both members for exactly that
  // reason — the app fills an omitted one with No Effect and the write would then clear the
  // pair. So the pair has to claim its slot once here, as `insertFxCensus` counts it, or the
  // tool scolds the document the skill just asked for and points at a fix that breaks it.
  // The unlinked pair is the control: without it, a census that stopped reporting collisions
  // at all would satisfy the first half.
  it("counts a STEREO-linked pair as one holder of the insert-FX slot", () => {
    const pair = (ch1) => ({
      format: "urx-router-plan",
      version: 2,
      modelId: "URX44V",
      connections: [],
      nodeParams: { ch1, ch2: { insertFx: 1793 } },
    });
    const slot = "select into the one device-wide compander slot";
    expect(toolWarnings(dir, pair({ stereoLink: true, insertFx: 1793 }))).not.toContain(slot);
    expect(toolWarnings(dir, pair({ insertFx: 1793 })), "the control: an unlinked pair").toContain(slot);
    // The flag is the pair's, held on the primary — set on the SECOND member it names no
    // pair state at all, so the two still collide.
    expect(
      toolWarnings(dir, {
        format: "urx-router-plan",
        version: 2,
        modelId: "URX44V",
        connections: [],
        nodeParams: { ch1: { insertFx: 1793 }, ch2: { stereoLink: true, insertFx: 1793 } },
      }),
      "stereoLink on the partner is not the pair's flag",
    ).toContain(slot);
    // …and an unrelated channel is still held against the pair.
    expect(
      toolWarnings(dir, {
        format: "urx-router-plan",
        version: 2,
        modelId: "URX44V",
        connections: [],
        nodeParams: { ch1: { stereoLink: true, insertFx: 1793 }, ch2: { insertFx: 1793 }, ch3: { insertFx: 1794 } },
      }),
      "the pair holds the slot against ch3",
    ).toContain(slot);
  });

  // The pair collapse above must not swallow a pair that disagrees with ITSELF. The unit
  // keeps one selector, one bypass and one engine for a linked pair, so two different values
  // describe no state it can be in — the app refuses such a document, and the tool whose whole
  // claim is "clean here means the app loads it unchanged" has to refuse it too, with a
  // non-zero exit rather than a warning.
  it("fails a STEREO-linked pair whose two members disagree", () => {
    const pair = (ch1, ch2) => ({
      format: "urx-router-plan",
      version: 2,
      modelId: "URX44V",
      connections: [],
      nodeParams: { ch1, ch2 },
    });
    const run = (plan) => {
      const file = join(dir, "plan.json");
      writeFileSync(file, JSON.stringify(plan));
      return spawnSync(python, [TOOL, "validate", file], { encoding: "utf8" });
    };

    for (const [name, ch1, ch2] of [
      ["the selector", { stereoLink: true, insertFx: 1793 }, { insertFx: 1794 }],
      ["the bypass", { stereoLink: true, insertFx: 1793, insertFxOn: true }, { insertFx: 1793, insertFxOn: false }],
      [
        // Slot 6 is the compander's Threshold. Slot 0 is the engine's type id, which the
        // write never sends, so a pair differing only there is one the unit can satisfy.
        "the engine values",
        { stereoLink: true, insertFx: 1793, insertFxParams: { 6: -1200 } },
        { insertFx: 1793, insertFxParams: { 6: -1300 } },
      ],
      ["one side omitted", { stereoLink: true, insertFx: 1793, insertFxOn: true }, {}],
    ]) {
      const r = run(pair(ch1, ch2));
      expect(r.status, `${name}: ${r.stdout}`).not.toBe(0);
      expect(r.stdout, name).toContain("[insertFxPair] ch1 / ch2");
    }

    // The controls, both directions: an agreeing pair passes, and an UNLINKED pair holding
    // two different effects is two channels rather than a contradiction.
    expect(run(pair({ stereoLink: true, insertFx: 1793 }, { insertFx: 1793 })).status).toBe(0);
    expect(run(pair({ insertFx: 1793 }, { insertFx: 1794 })).status).toBe(0);
    // …and a disagreeing pair gets its slot collision back, which the collapse had removed.
    expect(run(pair({ stereoLink: true, insertFx: 1793 }, { insertFx: 1794 })).stderr).toContain(
      "select into the one device-wide compander slot",
    );
  });

  // The pair verdict is a JUDGEMENT about the written state, and the two implementations
  // reach it independently — one over the sanitised plan through the emit path, one over raw
  // JSON. So they are asked the same corpus and have to agree case by case, which is the only
  // thing that catches a divergence at a JSON type boundary: `null` against an omitted key,
  // `true` against `1`, an off-menu selector against No Effect. Each of those is a pair the
  // unit CAN satisfy or cannot, and a checker that answers differently from the app either
  // refuses a document the app loads or clears one the app refuses.
  const PAIR_CORPUS = [
    // — the unit cannot satisfy these —
    ["two selectors", { stereoLink: true, insertFx: 1793 }, { insertFx: 1794 }, false],
    [
      "two bypasses",
      { stereoLink: true, insertFx: 1793, insertFxOn: true },
      { insertFx: 1793, insertFxOn: false },
      false,
    ],
    // Slot 6 is the compander's Threshold — a slot the family actually WRITES. Slot 0 is the
    // engine's type id and the write skips it, so a document differing only there is one the
    // unit can satisfy; picking it here would have asserted the opposite of the rule.
    [
      "two engine values",
      { stereoLink: true, insertFx: 1793, insertFxParams: { 6: -1200 } },
      { insertFx: 1793, insertFxParams: { 6: -1300 } },
      false,
    ],
    [
      "an engine value the write skips",
      { stereoLink: true, insertFx: 1793, insertFxParams: { 0: 12 } },
      { insertFx: 1793, insertFxParams: { 0: 13 } },
      true,
    ],
    ["one side omitted", { stereoLink: true, insertFx: 1793, insertFxOn: true }, {}, false],
    // — the unit CAN satisfy these, so neither may refuse —
    // An off-menu selector is No Effect on the wire, which is what the partner holds.
    ["an off-menu selector beside No Effect", { stereoLink: true, insertFx: 4242 }, { insertFx: -1 }, true],
    // The bypass is sent as `? 1 : 0`, so every truthy value is one bypass.
    ["true against 1", { stereoLink: true, insertFx: 1793, insertFxOn: true }, { insertFx: 1793, insertFxOn: 1 }, true],
    [
      "false against 0",
      { stereoLink: true, insertFx: 1793, insertFxOn: false },
      { insertFx: 1793, insertFxOn: 0 },
      true,
    ],
    // `null` is dropped by the load-time sanitiser, which leaves the factory value — the
    // same thing an omitted key leaves.
    ["null against omitted", { stereoLink: true, insertFxOn: null }, {}, true],
    ["null against the factory value", { stereoLink: true, insertFxOn: null }, { insertFxOn: false }, true],
    // The boundary that `null` does NOT reach: a leaf the sanitiser drops but that is TRUTHY
    // if it is read raw. The app drops it and the factory false stands; anything comparing
    // the JSON as written calls it a bypass that is on.
    [
      "a dropped truthy bypass against the factory value",
      { stereoLink: true, insertFx: 1793, insertFxOn: "on" },
      { insertFx: 1793, insertFxOn: false },
      true,
    ],
    // With No Effect selected the unit ignores the switch, so the bypass is never sent and
    // the two members cannot disagree about it.
    [
      "two bypasses under No Effect",
      { stereoLink: true, insertFx: -1, insertFxOn: true },
      { insertFx: -1, insertFxOn: false },
      true,
    ],
    // Engine values under a family the selector does not name are not sent either.
    [
      "engine values of another family",
      { stereoLink: true, insertFx: 1793, insertFxParams: { "amp:3": 12 } },
      { insertFx: 1793, insertFxParams: { "amp:3": 99 } },
      true,
    ],
    ["both agree", { stereoLink: true, insertFx: 1793, insertFxOn: true }, { insertFx: 1793, insertFxOn: true }, true],
    ["neither names one", { stereoLink: true }, {}, true],
    // The control for the whole table: unlinked, the two channels are independent.
    ["unlinked and different", { insertFx: 1793 }, { insertFx: 1794 }, true],
  ];

  // …and the same question asked of EVERY channel selector rather than of one. The hand-written
  // table above reached the engine values through the compander alone, whose namespace happens
  // to equal its resource-slot name — so a validator keying the namespace off that name agreed
  // with the app on every case in it and ignored all four guitar amps and Pitch Fix. The
  // selectors come from the app's own catalogue, so one added tomorrow is asked the same three
  // questions the day it ships.
  const INPUT_SELECTORS = INSERT_FX_OPTIONS.filter((o) => o.slot).map((o) => o.value);
  // Read from the file the TOOL reads, not from the app's own model: the question is whether
  // the generated data and the app agree, so taking it from the app would answer itself.
  const SPACE = JSON.parse(readFileSync(join(ROOT, ".claude/skills/urx-routing-planner/scripts/models.json"), "utf8"))
    .URX44V.insertFxParamSpace;

  it("asks every channel selector, in its own namespace", () => {
    expect(INPUT_SELECTORS.length, "the catalogue has to carry some").toBeGreaterThan(1);
    // The families must not all be the same word, or the case below cannot tell a namespace
    // from a resource-slot name — which is exactly the blind spot it exists for.
    expect(new Set(INPUT_SELECTORS.map((v) => SPACE[String(v)]?.family)).size).toBeGreaterThan(1);

    for (const selector of INPUT_SELECTORS) {
      const space = SPACE[String(selector)];
      expect(space, `selector ${selector} has a namespace`).toBeDefined();
      // Two values that survive the write: translate bounds every engine slot to the range
      // its own control declares, so a pair of numbers outside it arrives as one value and
      // the "differing" half below would assert nothing. The ends of the range are the two
      // that are always representable and always distinct.
      const spec = insertFxWritableSlots(space.family).find((x) => x.rawMin !== x.rawMax);
      expect(spec, `selector ${selector} has a slot with a range`).toBeDefined();
      const [lo, hi] = [spec.rawMin, spec.rawMax];
      const slot = spec.slot;
      const q = `${space.family}:${slot}`;
      const ask = (ch1, ch2) => {
        const plan = {
          format: "urx-router-plan",
          version: 2,
          modelId: "URX44V",
          connections: [],
          nodeParams: { ch1, ch2 },
        };
        const file = join(dir, "plan.json");
        writeFileSync(file, JSON.stringify(plan));
        const r = spawnSync(python, [TOOL, "validate", file], { encoding: "utf8" });
        const loaded = deserialize(JSON.stringify(plan));
        expect(loaded).not.toBeNull();
        return {
          tool: r.status === 0,
          app: insertFxPairProblems(getModel("URX44V"), loaded).length === 0,
          stdout: r.stdout,
        };
      };

      // Qualified keys that DIFFER: both have to refuse.
      const differ = ask(
        { stereoLink: true, insertFx: selector, insertFxParams: { [q]: lo } },
        { insertFx: selector, insertFxParams: { [q]: hi } },
      );
      expect(differ.app, `the app, ${q} differing`).toBe(false);
      expect(differ.tool, `the tool, ${q} differing\n${differ.stdout}`).toBe(false);

      // The same value under the same key: both have to pass. Without this the case above
      // is satisfied by a checker that refuses every document carrying engine values.
      const same = ask(
        { stereoLink: true, insertFx: selector, insertFxParams: { [q]: lo } },
        { insertFx: selector, insertFxParams: { [q]: lo } },
      );
      expect(same.app, `the app, ${q} agreeing`).toBe(true);
      expect(same.tool, `the tool, ${q} agreeing\n${same.stdout}`).toBe(true);

      // A BARE key against the qualified one it is re-keyed into: one value, so both pass.
      const bare = ask(
        { stereoLink: true, insertFx: selector, insertFxParams: { [String(slot)]: lo } },
        { insertFx: selector, insertFxParams: { [q]: lo } },
      );
      expect(bare.app, `the app, bare ${slot} against ${q}`).toBe(true);
      expect(bare.tool, `the tool, bare ${slot} against ${q}\n${bare.stdout}`).toBe(true);

      // …and the rest of the decision table, which is about what the write LEAVES OUT or
      // NORMALISES. Each row is a document whose two members store different things and
      // reach the unit as one state, so a checker reproducing only "which slots exist"
      // refuses a plan the app loads.
      const rows = [
        // Past the same end of the range: both arrive as that end.
        [`below ${q} min`, { [q]: lo - 1 }, { [q]: lo }, true],
        [`above ${q} max`, { [q]: hi }, { [q]: hi + 1 }, true],
        // A boolean is not a finite number, so the write sends neither.
        [`boolean ${q} against boolean`, { [q]: true }, { [q]: false }, true],
        [`boolean ${q} against omitted`, { [q]: true }, {}, true],
        // The control for the three above: inside the range, two numbers still differ.
        [`${q} inside the range`, { [q]: lo }, { [q]: hi }, false],
      ];
      for (const [name, p1, p2, ok] of rows) {
        const got = ask(
          { stereoLink: true, insertFx: selector, insertFxParams: p1 },
          { insertFx: selector, insertFxParams: p2 },
        );
        expect(got.app, `the app, ${name}`).toBe(ok);
        expect(got.tool, `the tool, ${name}\n${got.stdout}`).toBe(ok);
      }
    }
  });

  // The loader drops an engine leaf that is neither a boolean nor a finite number, and every
  // question below it — which key answers for a slot, whether the driver gate is on, whether
  // anything is sent at all — has to be asked AFTER that. Read off the raw JSON instead, a
  // dropped key hides the bare key the app falls through to and gates a suppression the app
  // never applies. Both directions are here: a pair the CLI must not refuse, and one it must
  // not clear.
  it.each([
    // "Nothing is sent" has one meaning, however the document spells it.
    ["an empty map against an omitted one", { insertFx: 1793, insertFxParams: {} }, { insertFx: 1793 }, true],
    [
      "a map of only dropped leaves against an omitted one",
      { insertFx: 1793, insertFxParams: { "compander:6": null, "compander:7": "x" } },
      { insertFx: 1793 },
      true,
    ],
    // A dropped qualified key must not hide the bare key the app uses instead.
    [
      "a null qualified key beside a valid bare one",
      { insertFx: 512, insertFxParams: { "pitch:16": null, 16: 5 } },
      { insertFx: 512, insertFxParams: { 16: 5 } },
      true,
    ],
    // …and the control: a qualified key that SURVIVES does win over the bare one, so two
    // documents that differ only there still differ.
    [
      "a valid qualified key beside a different bare one",
      { insertFx: 512, insertFxParams: { "pitch:16": 5, 16: 1 } },
      { insertFx: 512, insertFxParams: { "pitch:16": 6, 16: 1 } },
      false,
    ],
    // A dropped gate is not a gate: the unit drives nothing, so the Scale IS written and two
    // values for it are two states. This is the direction that matters most — the CLI
    // clearing a document the app refuses.
    [
      "a string gate with the Scale differing",
      { insertFx: 512, insertFxParams: { "pitch:34": "on", "pitch:16": 0 } },
      { insertFx: 512, insertFxParams: { "pitch:34": "on", "pitch:16": 1 } },
      false,
    ],
    [
      "a null gate with the Scale differing",
      { insertFx: 512, insertFxParams: { "pitch:34": null, "pitch:16": 0 } },
      { insertFx: 512, insertFxParams: { "pitch:34": null, "pitch:16": 1 } },
      false,
    ],
    // …and the control for those two: a gate that survives DOES suppress the Scale.
    [
      "a surviving gate with the Scale differing",
      { insertFx: 512, insertFxParams: { "pitch:34": 1, "pitch:16": 0 } },
      { insertFx: 512, insertFxParams: { "pitch:34": 1, "pitch:16": 1 } },
      true,
    ],
  ])("agrees with the app about %s", (_name, ch1, ch2, ok) => {
    const plan = {
      format: "urx-router-plan",
      version: 2,
      modelId: "URX44V",
      connections: [],
      nodeParams: { ch1: { stereoLink: true, ...ch1 }, ch2 },
    };
    const file = join(dir, "plan.json");
    writeFileSync(file, JSON.stringify(plan));
    const r = spawnSync(python, [TOOL, "validate", file], { encoding: "utf8" });
    const loaded = deserialize(JSON.stringify(plan));
    expect(loaded).not.toBeNull();

    expect(insertFxPairProblems(getModel("URX44V"), loaded).length === 0, `the app: ${_name}`).toBe(ok);
    expect(r.status === 0, `the tool: ${_name}\n${r.stdout}`).toBe(ok);
  });

  // A container where a SCALAR belongs. The document sanitiser is built for the nested groups
  // (`gate` is a record, `eqBands` an array, and an empty array survives it vacuously), so it
  // cannot tell one of those from a document that put a container in the bypass or in an
  // engine slot — and a container that reaches the plan is read as a JavaScript truth by
  // everything after it: `[]` is a bypass that is ON, and a container in Pitch Fix's MIDI
  // Control slot drops the Scale out of the write. The loader now takes them out of those two
  // fields, which is what lets one rule describe both sides.
  //
  // Driven over EVERY model, every one of its linked pairs and both document versions: the
  // pair rule is per pair and the re-keying is per version, so one model's CH1/2 at version 3
  // is one cell of that table rather than a sample of it.
  const CONTAINERS = [
    ["an empty array", []],
    ["an array of records", [{ a: 1 }]],
    ["a non-empty object", { a: 1 }],
  ];

  for (const modelId of MODEL_IDS) {
    const pairs = getModel(modelId).channelPairs;
    for (const [primary, partner] of pairs) {
      for (const version of [2, 3]) {
        it.each(CONTAINERS)(
          `agrees about ${modelId} ${primary}/${partner} v${version} carrying %s`,
          (_name, container) => {
            const ask = (ch1, ch2) => {
              const plan = {
                format: "urx-router-plan",
                version,
                modelId,
                connections: [],
                nodeParams: { [primary]: { stereoLink: true, ...ch1 }, [partner]: ch2 },
              };
              const file = join(dir, "plan.json");
              writeFileSync(file, JSON.stringify(plan));
              const r = spawnSync(python, [TOOL, "validate", file], { encoding: "utf8" });
              const loaded = deserialize(JSON.stringify(plan));
              expect(loaded).not.toBeNull();
              return {
                tool: r.status === 0,
                app: insertFxPairProblems(getModel(modelId), loaded).length === 0,
                stdout: r.stdout,
                warnings: r.stderr,
              };
            };

            // The bypass: a container is not a bypass that is on, so this is the factory
            // false the partner also has.
            const bypass = ask({ insertFx: 1793, insertFxOn: container }, { insertFx: 1793, insertFxOn: false });
            expect(bypass.app, `the app, bypass ${_name}`).toBe(true);
            expect(bypass.tool, `the tool, bypass ${_name}\n${bypass.stdout}`).toBe(true);

            // …and the control, so this does not pass on a checker that ignores the bypass:
            // a real bypass difference is still a contradiction.
            const real = ask({ insertFx: 1793, insertFxOn: true }, { insertFx: 1793, insertFxOn: false });
            expect(real.app, "the app, a real bypass difference").toBe(false);
            expect(real.tool, `the tool, a real bypass difference\n${real.stdout}`).toBe(false);

            // Pitch Fix's gate: a container there gates nothing, so the Scale IS written and
            // two values for it are two states.
            const gate = ask(
              { insertFx: 512, insertFxParams: { "pitch:34": container, "pitch:16": 0 } },
              { insertFx: 512, insertFxParams: { "pitch:34": container, "pitch:16": 1 } },
            );
            expect(gate.app, `the app, pitch gate ${_name}`).toBe(false);
            expect(gate.tool, `the tool, pitch gate ${_name}\n${gate.stdout}`).toBe(false);

            // …and its control: a gate that IS a scalar still suppresses the Scale.
            const scalarGate = ask(
              { insertFx: 512, insertFxParams: { "pitch:34": 1, "pitch:16": 0 } },
              { insertFx: 512, insertFxParams: { "pitch:34": 1, "pitch:16": 1 } },
            );
            expect(scalarGate.app, "the app, a scalar pitch gate").toBe(true);
            expect(scalarGate.tool, `the tool, a scalar pitch gate\n${scalarGate.stdout}`).toBe(true);

            // An engine slot that is a container carries no value, so it is the same as the
            // partner naming nothing there.
            const slot = ask({ insertFx: 1793, insertFxParams: { "compander:6": container } }, { insertFx: 1793 });
            expect(slot.app, `the app, engine slot ${_name}`).toBe(true);
            expect(slot.tool, `the tool, engine slot ${_name}\n${slot.stdout}`).toBe(true);

            // …and SAYING SO is the other half of the contract. A verdict of "clean" about a
            // document whose setting the app then removes is the shape this whole matrix was
            // blind to: the pair reads the same either way, so only the warning tells the
            // author their bypass or their engine value is not going to survive the load.
            // The path is compared, not just the fact of a warning, because the author's next
            // move is to go and look at it.
            expect(bypass.warnings, `the bypass warning names its path, ${_name}`).toContain(
              `node param ${primary}.insertFxOn:`,
            );
            expect(slot.warnings, `the engine-slot warning names its path, ${_name}`).toContain(
              `node param ${primary}.insertFxParams.compander:6:`,
            );
            // The control: a SCALAR in either place is kept, so neither is warned about —
            // without it a checker warning on every document would satisfy the two above.
            expect(real.warnings, "a real bypass is not a dropped value").not.toContain(
              `node param ${primary}.insertFxOn:`,
            );
            expect(scalarGate.warnings, "a scalar gate is not a dropped value").not.toContain(
              `node param ${primary}.insertFxParams.`,
            );
          },
        );
      }
    }
  }

  // `insertFxParams` that is not a map at all, partitioned over the JSON types it could be.
  // The loader drops the whole field, and the author has to be told at THAT path — reporting
  // its slots says nothing about a document whose map was a string, and an array reaches the
  // loader intact (`eqBands` is an array, so the sanitiser keeps one), which is a second way
  // in to the same answer. The valid object is the control: it is kept, so it must not be
  // warned about, or a checker warning on every document would satisfy the rows above.
  it.each([
    ["a string", "not-a-map", true],
    ["a number", 7, true],
    ["a boolean", true, true],
    // The FALSY half of the same partition. `if (params)` in the loader is false for these,
    // so a truthiness check leaves them in the plan while the tool says they were dropped —
    // which is exactly the gap a matrix of `true` and `7` cannot see.
    ["a false boolean", false, true],
    ["a zero", 0, true],
    ["an empty string", "", true],
    ["null", null, true],
    ["an empty array", [], true],
    ["an array of records", [{ a: 1 }], true],
    ["an object of slots", { "compander:6": -1200 }, false],
  ])("agrees that insertFxParams as %s is dropped whole", (_name, value, dropped) => {
    const plan = {
      format: "urx-router-plan",
      version: PLAN_VERSION,
      modelId: "URX44V",
      connections: [],
      nodeParams: { ch1: { insertFx: 1793, insertFxParams: value } },
    };
    const file = join(dir, "plan.json");
    writeFileSync(file, JSON.stringify(plan));
    const r = spawnSync(python, [TOOL, "validate", file], { encoding: "utf8" });
    const loaded = deserialize(JSON.stringify(plan));
    expect(loaded).not.toBeNull();

    // What the APP did with it, which is what the warning is a claim about.
    expect(loaded.nodeParams.ch1?.insertFxParams === undefined, `the app dropped it: ${_name}`).toBe(dropped);
    expect(r.stderr.includes("node param ch1.insertFxParams:"), `the tool says so: ${_name}`).toBe(dropped);
  });

  // The FX channel's own two repairs, which the tool could not see until models.json carried
  // the channel's menu and what each control admits. Both sides are asked the same documents
  // and have to name the same paths: the app REPORTS them (`paramRangeProblems`) and the tool
  // WARNS about them, and a plan the tool calls clean must not be one the app repairs.
  //
  // The admitted set is the CONTROL's, so the rows walk all three kinds — a slider's window,
  // a select's option list and a toggle's two states — because bounding everything against a
  // range is the mistake the app's own note records.
  it("agrees with the app about the FX repairs that need the channel's catalogue", () => {
    const FX = JSON.parse(readFileSync(join(ROOT, ".claude/skills/urx-routing-planner/scripts/models.json"), "utf8"))
      .URX44V.fxChannels["bus.fx1"];
    expect(FX, "the generated data carries the channel").toBeDefined();

    const slider = Object.entries(FX.params).find(([, p]) => p.control === "slider" && p.rawMax !== undefined);
    const select = Object.entries(FX.params).find(([, p]) => p.control === "select" && (p.options ?? []).length > 1);
    const toggle = Object.entries(FX.params).find(([, p]) => p.control === "toggle");
    expect(slider, "a slider key").toBeDefined();
    expect(select, "a select key").toBeDefined();
    expect(toggle, "a toggle key").toBeDefined();

    const ask = (fxEffect) => {
      const plan = {
        format: "urx-router-plan",
        version: PLAN_VERSION,
        modelId: "URX44V",
        connections: [],
        nodeParams: { "bus.fx1": { fxEffect } },
      };
      const file = join(dir, "plan.json");
      writeFileSync(file, JSON.stringify(plan));
      const r = spawnSync(python, [TOOL, "validate", file], { encoding: "utf8" });
      const loaded = deserialize(JSON.stringify(plan));
      expect(loaded).not.toBeNull();
      return { app: paramRangeProblems(loaded), tool: r.stderr };
    };

    // A type the menu does not offer: the app DROPS it.
    const badType = ask({ type: 4242 });
    expect(
      badType.app.some((p) => p.key === "type" && p.action === "drop"),
      "the app drops the type",
    ).toBe(true);
    expect(badType.tool, "the tool names the type").toContain("bus.fx1.fxEffect.type");
    // …and a type it DOES offer is not reported, or the row above passes on a checker that
    // objects to every type.
    expect(
      ask({ type: FX.types[0] }).app.some((p) => p.key === "type"),
      "a legal type",
    ).toBe(false);
    expect(ask({ type: FX.types[0] }).tool).not.toContain("bus.fx1.fxEffect.type");

    // Each control kind, past what it admits and then inside it.
    for (const [name, [key, spec], past, inside] of [
      ["slider", slider, slider[1].rawMax + 1, slider[1].rawMax],
      ["select", select, Math.max(...select[1].options) + 1, select[1].options[0]],
      ["toggle", toggle, 2, 1],
    ]) {
      const over = ask({ type: FX.types[0], params: { [key]: past } });
      expect(
        over.app.some((p) => p.key === key && p.action === "bound"),
        `the app bounds ${name} ${key}=${past}`,
      ).toBe(true);
      expect(over.tool, `the tool names ${name} ${key}`).toContain(`bus.fx1.fxEffect.params.${key}`);

      const ok = ask({ type: FX.types[0], params: { [key]: inside } });
      expect(
        ok.app.some((p) => p.key === key),
        `the app leaves ${name} ${key}=${inside}`,
      ).toBe(false);
      expect(ok.tool, `the tool leaves ${name} ${key}`).not.toContain(`bus.fx1.fxEffect.params.${key}`);
      void spec;
    }
  });

  // The one family whose write set MOVES with its own values: Pitch Fix stops sending the
  // Scale and the twelve-note mask while MIDI Control is on, because switching it on is what
  // clears them on the unit. So the same two documents are a contradiction with the control
  // off and one state with it on — which a checker holding a static slot list cannot tell
  // apart, and it refuses the second.
  it("follows Pitch Fix's MIDI Control, which moves what a write sends", () => {
    const SPACE_PITCH = SPACE["512"];
    expect(SPACE_PITCH?.driven, "the generated data carries the gate and what it drives").toBeDefined();
    const { gate, slots: drivenSlots } = SPACE_PITCH.driven;
    // The Scale and one note, which is what the unit takes over.
    const scale = drivenSlots[0];
    const note = drivenSlots[drivenSlots.length - 1];

    const ask = (ch1, ch2) => {
      const plan = {
        format: "urx-router-plan",
        version: 2,
        modelId: "URX44V",
        connections: [],
        nodeParams: { ch1, ch2 },
      };
      const file = join(dir, "plan.json");
      writeFileSync(file, JSON.stringify(plan));
      const r = spawnSync(python, [TOOL, "validate", file], { encoding: "utf8" });
      const loaded = deserialize(JSON.stringify(plan));
      expect(loaded).not.toBeNull();
      return {
        tool: r.status === 0,
        app: insertFxPairProblems(getModel("URX44V"), loaded).length === 0,
        stdout: r.stdout,
      };
    };
    const pitch = (on, extra) => ({ insertFx: 512, insertFxParams: { [`pitch:${gate}`]: on, ...extra } });

    for (const [what, slot] of [
      ["the Scale", scale],
      ["a note", note],
    ]) {
      // Control OFF: the write sends it, so two values are two states.
      const off = ask({ stereoLink: true, ...pitch(0, { [`pitch:${slot}`]: 0 }) }, pitch(0, { [`pitch:${slot}`]: 1 }));
      expect(off.app, `the app, ${what} with MIDI Control off`).toBe(false);
      expect(off.tool, `the tool, ${what} with MIDI Control off\n${off.stdout}`).toBe(false);

      // Control ON: the unit owns it, the write leaves it out, and the two are one state.
      const on = ask({ stereoLink: true, ...pitch(1, { [`pitch:${slot}`]: 0 }) }, pitch(1, { [`pitch:${slot}`]: 1 }));
      expect(on.app, `the app, ${what} with MIDI Control on`).toBe(true);
      expect(on.tool, `the tool, ${what} with MIDI Control on\n${on.stdout}`).toBe(true);
    }

    // The gate is read for TRUTH, not for the number 1: the app takes whatever the slot
    // holds and asks `on ?`, so a boolean gates exactly as a 1 does. Read as `== 1` the
    // Scale comes back into the write and the pair reads as a contradiction again.
    const truthy = ask(
      { stereoLink: true, ...pitch(true, { [`pitch:${scale}`]: 0 }) },
      pitch(true, { [`pitch:${scale}`]: 1 }),
    );
    expect(truthy.app, "the app, a boolean MIDI Control").toBe(true);
    expect(truthy.tool, `the tool, a boolean MIDI Control\n${truthy.stdout}`).toBe(true);

    // …and a truthy value that is not 1, which is what separates "read for truth" from
    // "read as 1" in a language where `True == 1`. The gate's own slot is bounded to 1 on
    // the way out, so both members still SEND the same gate — what moves is whether the
    // Scale is left out.
    const two = ask({ stereoLink: true, ...pitch(2, { [`pitch:${scale}`]: 0 }) }, pitch(2, { [`pitch:${scale}`]: 1 }));
    expect(two.app, "the app, a MIDI Control past its own range").toBe(true);
    expect(two.tool, `the tool, a MIDI Control past its own range\n${two.stdout}`).toBe(true);

    // The gate itself is still sent, so disagreeing about IT is a contradiction either way.
    const gates = ask({ stereoLink: true, ...pitch(1, {}) }, pitch(0, {}));
    expect(gates.app, "the app, the gate itself differing").toBe(false);
    expect(gates.tool, `the tool, the gate itself differing\n${gates.stdout}`).toBe(false);
  });

  it.each(PAIR_CORPUS)("agrees with the app about %s", (_name, ch1, ch2, ok) => {
    const plan = {
      format: "urx-router-plan",
      version: 2,
      modelId: "URX44V",
      connections: [],
      nodeParams: { ch1, ch2 },
    };
    const file = join(dir, "plan.json");
    writeFileSync(file, JSON.stringify(plan));
    const r = spawnSync(python, [TOOL, "validate", file], { encoding: "utf8" });
    const toolSaysOk = r.status === 0;
    // The app's own answer, over the document as the loader hands it on: deserialize applies
    // the same sanitiser the tool has to stand in for.
    const loaded = deserialize(JSON.stringify(plan));
    expect(loaded, "the document has to load at all for the comparison to mean anything").not.toBeNull();
    const appSaysOk = insertFxPairProblems(getModel("URX44V"), loaded).length === 0;

    expect(appSaysOk, `the app: ${_name}`).toBe(ok);
    expect(toolSaysOk, `the tool: ${_name}\n${r.stdout}`).toBe(ok);
  });

  // `True == 1` in Python, and the app's own comparison is `===` — so a boolean comp/EQ type
  // falls back to the COMP-first order and sends no SSMCS at all.
  it("does not read a boolean as the SSMCS comp/EQ order", () => {
    const doc = (v) => ({
      format: "urx-router-plan",
      version: 2,
      modelId: "URX44V",
      connections: [],
      nodeParams: { ch1: { compEqType: v } },
    });
    expect(toolWarnings(dir, doc(true))).not.toContain("carry no usable ssmcs");
    expect(toolWarnings(dir, doc(1)), "the control: the real value is warned about").toContain("carry no usable ssmcs");
  });
});
