import { describe, expect, it } from "vitest";
import { cmdAddr, planToCommands } from "../core/control/translate";
import { nodeParamContestPath } from "../core/plan-history";
import { markParamSource } from "./param-source";
import type { ParamSource, Plan } from "../core/plan";
import { getModel } from "../models";
import { defaultPlan } from "../models/initial-state";
import { filledPlan } from "./filled-plan.test-util";
import { insertFxParamKey } from "../core/control/insert-fx-effect";
import { unauthoredWriteNodes } from "./unauthored-writes";

const MODEL = getModel("URX44V");

const everyAddr = (plan: Plan): Set<number> => new Set(planToCommands(MODEL, plan, "all").map(cmdAddr));

/** Re-mark every key of one node, the way an edit or a device read would. */
function markNode(plan: Plan, nodeId: string, source: ParamSource): number {
  const prefix = nodeParamContestPath(nodeId, "");
  let n = 0;
  for (const key of plan.paramSource!.keys()) {
    if (key.startsWith(prefix)) {
      plan.paramSource!.set(key, source);
      n++;
    }
  }
  return n;
}

describe("unauthoredWriteNodes", () => {
  // A plan nobody has marked is a plan nothing vouches for, and the values in it are the
  // factory's — which is the subject. `defaultPlan` is that plan: File > New, a model switch
  // and the app's own startup all reach a write through it, and staying quiet there left the
  // warning to documents alone while the more common way to a first write said nothing.
  it("names every strip of a plan nothing vouches for", () => {
    const plan = defaultPlan("URX44V");
    expect(plan.paramSource, "the premise: no funnel has recorded anything").toBeUndefined();
    const nodes = unauthoredWriteNodes(MODEL, plan, "all", everyAddr(plan));
    expect(nodes.length).toBeGreaterThan(1);
    expect(nodes).toContain("ch1");
  });

  // …and one edit does not vouch for the rest of the board. The map exists from the first
  // closed gesture, so a guard that only asked whether it exists went quiet from then on.
  it("names the strips around the one key an edit claimed", () => {
    const plan = defaultPlan("URX44V");
    markParamSource(plan, [nodeParamContestPath("ch1", "gain")], "manual");
    expect(unauthoredWriteNodes(MODEL, plan, "all", everyAddr(plan))).toContain("ch2");
  });

  // The positive control for everything below: a document that described nothing is
  // factory-filled throughout, so every strip the write moves is one nobody chose.
  it("names every strip of a document that described nothing", () => {
    const plan = filledPlan();
    const nodes = unauthoredWriteNodes(MODEL, plan, "all", everyAddr(plan));
    expect(nodes.length).toBeGreaterThan(1);
    expect(nodes).toContain("ch1");
    expect(nodes).toContain("bus.fx1");
  });

  // The distinction the whole feature rests on: the operator's own keys, and the document's,
  // are values someone chose. Only the fill and the unit's own readings are not.
  it.each<[ParamSource, boolean]>([
    ["manual", false],
    ["load", false],
    ["default", true],
    ["device", true],
  ])("reports a strip whose keys came from %s: %s", (source, reported) => {
    const plan = filledPlan();
    expect(markNode(plan, "ch1", source)).toBeGreaterThan(0);
    expect(unauthoredWriteNodes(MODEL, plan, "all", everyAddr(plan)).includes("ch1")).toBe(reported);
  });

  // What it is warning ABOUT is the write, not the fill: a factory-filled key the unit already
  // agrees with moves nothing, so naming its strip would send the operator to look at a value
  // that is not going to change.
  it("says nothing when the addresses do not differ from the device", () => {
    const plan = filledPlan();
    expect(unauthoredWriteNodes(MODEL, plan, "all", new Set())).toEqual([]);
  });

  // …and the same plan reports only the strips whose addresses are in that set.
  it("names only the strips the write actually moves", () => {
    const plan = filledPlan();
    const ch2 = new Set(
      planToCommands(MODEL, plan, "all")
        .filter((c) => c.node === "ch2")
        .map(cmdAddr),
    );
    expect(ch2.size).toBeGreaterThan(0);
    expect(unauthoredWriteNodes(MODEL, plan, "all", ch2)).toEqual(["ch2"]);
  });

  // A scene-scoped write sends less, so it warns about less: the device-wide strips are not
  // in its emit at all and cannot be changed by it.
  it("leaves the scene-external strips out of a scene-scoped write", () => {
    const plan = filledPlan();
    const all = everyAddr(plan);
    expect(unauthoredWriteNodes(MODEL, plan, "all", all)).toContain("bus.mon1");
    expect(unauthoredWriteNodes(MODEL, plan, "scene", all)).not.toContain("bus.mon1");
  });
});

// The premise the whole subtraction rests on, and the one place the emit does not hold it:
// `insertFx` GATES its node's insert-FX block, so blanking the selector takes the engine
// array with it. Asked of the unauthored set at once, an authored engine parameter's address
// then goes missing for the SELECTOR's sake and the strip is named for a value the operator
// set themselves. Asked one leaf at a time, the authored parameter still claims its address.
describe("a leaf that gates its node's whole block", () => {
  const withInsertFx = (): Plan => {
    const plan = filledPlan();
    plan.nodeParams.ch1 = {
      ...plan.nodeParams.ch1,
      insertFx: 1793,
      insertFxParams: { [insertFxParamKey("compander", 6)]: -2000 },
    };
    // Everything is the unit's except the one parameter the operator dialled in.
    for (const key of plan.paramSource!.keys()) plan.paramSource!.set(key, "device");
    for (const leaf of ["insertFx", `insertFxParams.${insertFxParamKey("compander", 6)}`]) {
      plan.paramSource!.set(nodeParamContestPath("ch1", leaf), "manual");
    }
    return plan;
  };

  const engineAddrs = (plan: Plan): Set<number> => {
    const engine = planToCommands(MODEL, plan, "all").filter((c) => c.node === "ch1" && c.name === "INSERT_FX_EFFECT");
    expect(engine.length, "the premise: the engine array reaches the wire").toBeGreaterThan(0);
    return new Set(engine.map(cmdAddr));
  };

  it("says nothing when both the selector and the parameter are the operator's", () => {
    const plan = withInsertFx();
    plan.paramSource!.set(nodeParamContestPath("ch1", "insertFx"), "manual");
    expect(unauthoredWriteNodes(MODEL, plan, "all", engineAddrs(plan))).toEqual([]);
  });

  // An unauthored selector names the strip through BOTH of its addresses. Its own is the
  // obvious one; the engine array follows it, since a type write refills every slot from that
  // type's defaults — so what lands there is the fill's choice however the operator dialled the
  // slot in under the type they had.
  const selectorAddrs = (plan: Plan): Set<number> => {
    const sel = planToCommands(MODEL, plan, "all").filter((c) => c.node === "ch1" && c.name === "INSERT_FX");
    expect(sel.length, "the premise: the selector reaches the wire").toBeGreaterThan(0);
    return new Set(sel.map(cmdAddr));
  };

  // A selector the fill supplied names the strip through its OWN address, like any other value
  // nobody chose.
  it("names the strip for a selector nobody chose", () => {
    const plan = withInsertFx();
    plan.paramSource!.set(nodeParamContestPath("ch1", "insertFx"), "default");
    expect(unauthoredWriteNodes(MODEL, plan, "all", selectorAddrs(plan))).toEqual(["ch1"]);
  });

  // …and the array with it, WHEN that selector is one of the things the write is changing: a
  // type write refills the effect's slots from the type's own defaults, so what lands there is
  // not the value the operator dialled in under the type they had.
  it("names the array a selector the write is changing would refill", () => {
    const plan = withInsertFx();
    plan.paramSource!.set(nodeParamContestPath("ch1", "insertFx"), "default");
    const both = new Set([...selectorAddrs(plan), ...engineAddrs(plan)]);
    expect(unauthoredWriteNodes(MODEL, plan, "all", both)).toEqual(["ch1"]);
  });

  // The distinction that separates those two. With the selector fetched off the unit and only
  // an engine parameter of the operator's own moving, the write changes no selector and no
  // refill happens — saying otherwise names a strip whose changing value they set themselves.
  it("says nothing when only an authored engine value moves under a selector that does not", () => {
    const plan = withInsertFx();
    plan.paramSource!.set(nodeParamContestPath("ch1", "insertFx"), "device");
    expect(unauthoredWriteNodes(MODEL, plan, "all", engineAddrs(plan))).toEqual([]);
  });

  // A step does not move every value: an enum is bounded to an option list and a neighbouring
  // integer is not on it. `insertFx` at No Effect is the write that CLEARS the unit's insert
  // effect, and it is what a document omitting the key gets — the case the whole feature is
  // for, and one no step could see.
  it("names the strips whose insert effect the fill would clear", () => {
    const plan = filledPlan();
    const clearing = planToCommands(MODEL, plan, "all").filter((c) => c.name === "INSERT_FX");
    expect(clearing.length, "the premise: the fill sends a selector").toBeGreaterThan(0);
    const named = unauthoredWriteNodes(MODEL, plan, "all", new Set(clearing.map(cmdAddr)));
    expect(named).toContain("ch1");
    expect(named).toContain("bus.stereo");
    expect(named).toContain("bus.mix1");
  });

  it("names the strip when the PARAMETER is the fill's", () => {
    const plan = withInsertFx();
    plan.paramSource!.set(nodeParamContestPath("ch1", "insertFx"), "manual");
    plan.paramSource!.set(nodeParamContestPath("ch1", `insertFxParams.${insertFxParamKey("compander", 6)}`), "default");
    expect(unauthoredWriteNodes(MODEL, plan, "all", engineAddrs(plan))).toEqual(["ch1"]);
  });
});

// An array index is part of a key's identity, so the walk that asks what a leaf sends has to
// reach inside one. Asked of a node whose one authored leaf is an EQ band's gain, a walk that
// stopped at the array attributes that band's address to nobody and names the strip for a
// value the operator set themselves.
describe("an authored leaf inside an array", () => {
  const oneBand = (): Plan => {
    const plan = filledPlan();
    for (const key of plan.paramSource!.keys()) plan.paramSource!.set(key, "device");
    const band = nodeParamContestPath("ch1", "eqBands.1.gain");
    expect(plan.paramSource!.has(band), "the premise: the factory carries that band").toBe(true);
    plan.paramSource!.set(band, "manual");
    return plan;
  };
  // One band per parameter id, in the descriptor's own order — the index is not an address
  // field, so the band is picked out of the emitted run rather than matched on one.
  const bandAddrs = (plan: Plan, index: number): Set<number> => {
    const gains = planToCommands(MODEL, plan, "all").filter((c) => c.node === "ch1" && c.name === "EQ_BAND_GAIN");
    const one = gains[index];
    return new Set(one ? [cmdAddr(one)] : []);
  };

  it("claims its own address, so the strip is not named for it", () => {
    const plan = oneBand();
    const addrs = bandAddrs(plan, 1);
    expect(addrs.size, "the premise: that band's gain reaches the wire").toBeGreaterThan(0);
    expect(unauthoredWriteNodes(MODEL, plan, "all", addrs)).toEqual([]);
  });

  // The control on the same fixture: a DIFFERENT band of the same array is nobody's, and its
  // address does name the strip — so the case above is the walk reaching the index rather
  // than the note having gone quiet about arrays altogether.
  it("does not claim a sibling index", () => {
    const plan = oneBand();
    const addrs = bandAddrs(plan, 2);
    expect(addrs.size, "the premise").toBeGreaterThan(0);
    expect(unauthoredWriteNodes(MODEL, plan, "all", addrs)).toEqual(["ch1"]);
  });
});

// A step in one direction is not enough: a value sitting at the top of its range does not move
// upward, and the emit clamps it back to what it already was. Asked only that way, the strip
// whose gain the fill left at the ceiling would go unnamed.
it("names a strip whose unauthored value sits at the end of its range", () => {
  const plan = filledPlan();
  for (const key of plan.paramSource!.keys()) plan.paramSource!.set(key, "manual");
  plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, gain: 70 };
  plan.paramSource!.set(nodeParamContestPath("ch1", "gain"), "default");
  const gain = planToCommands(MODEL, plan, "all").filter((c) => c.node === "ch1" && c.name === "HA_GAIN");
  expect(gain.length, "the premise: the gain reaches the wire").toBeGreaterThan(0);
  expect(unauthoredWriteNodes(MODEL, plan, "all", new Set(gain.map(cmdAddr)))).toEqual(["ch1"]);
});

// An FX channel's level is emitted with the descriptor's own default when the plan carries
// none, and the fill puts exactly that default — 100, the top of its range — into the plan. So
// the value is unauthored while nothing about the emit distinguishes it from a plan that never
// named it, and a write moving the unit's 80 back to 100 has to be named for what it is.
it.each(["bus.fx1", "bus.fx2"])("names %s when the fill supplied its level", (node) => {
  const plan = filledPlan();
  for (const key of plan.paramSource!.keys()) plan.paramSource!.set(key, "manual");
  const level = nodeParamContestPath(node, "fxEffect.level");
  expect(plan.paramSource!.get(level), "the premise: the fill carries it").toBe("manual");
  expect(plan.nodeParams[node]?.fxEffect?.level, "the premise: at the top of its range").toBe(100);
  plan.paramSource!.set(level, "default");

  const at = planToCommands(MODEL, plan, "all");
  const moved = {
    ...plan,
    nodeParams: {
      ...plan.nodeParams,
      [node]: { ...plan.nodeParams[node], fxEffect: { ...plan.nodeParams[node]!.fxEffect, level: 80 } },
    },
  } as typeof plan;
  const held = new Map(planToCommands(MODEL, moved, "all").map((c) => [cmdAddr(c), c.vdValue]));
  const changing = at.filter((c) => held.get(cmdAddr(c)) !== c.vdValue);
  expect(changing, "the premise: the unit differs in that one value").toHaveLength(1);

  expect(unauthoredWriteNodes(MODEL, plan, "all", new Set(changing.map(cmdAddr)))).toEqual([node]);
  // The control: the same address, with the level the operator's own.
  plan.paramSource!.set(level, "manual");
  expect(unauthoredWriteNodes(MODEL, plan, "all", new Set(changing.map(cmdAddr)))).toEqual([]);
});

// A slot the plan does not carry is still emitted, with the descriptor's own default — so that
// command has no plan key behind it and cannot be a value the operator failed to choose. Read
// as though the absent key owned it, every such slot would name its strip.
it("says nothing about a slot the emit supplies itself", () => {
  const plan = filledPlan();
  for (const key of plan.paramSource!.keys()) plan.paramSource!.set(key, "manual");
  const params = { ...plan.nodeParams["bus.fx1"]!.fxEffect!.params };
  const dropped = Object.keys(params)[0];
  delete params[dropped];
  plan.nodeParams["bus.fx1"] = {
    ...plan.nodeParams["bus.fx1"],
    fxEffect: { ...plan.nodeParams["bus.fx1"]!.fxEffect, params },
  };
  expect(plan.paramSource!.has(nodeParamContestPath("bus.fx1", `fxEffect.params.${dropped}`)), "the premise").toBe(
    true,
  );
  plan.paramSource!.delete(nodeParamContestPath("bus.fx1", `fxEffect.params.${dropped}`));

  const fx = planToCommands(MODEL, plan, "all").filter((c) => c.node === "bus.fx1" && c.name.startsWith("FX_EFFECT"));
  expect(fx.length, "the premise: the section still reaches the wire").toBeGreaterThan(0);
  expect(unauthoredWriteNodes(MODEL, plan, "all", new Set(fx.map(cmdAddr)))).toEqual([]);
});

// The value a command carries is the LAST key read before it goes out. The guard above it is
// read first and decides only whether the block runs at all: an EQ band's ON follows the band,
// not the 1-knob switch that let the bands through.
it("names the strip for the band's own key, not the switch read before it", () => {
  const plan = filledPlan();
  for (const key of plan.paramSource!.keys()) plan.paramSource!.set(key, "manual");
  expect(plan.nodeParams.ch1?.eqOneKnob?.on, "the premise: the switch is off, so the bands go out").toBe(false);
  plan.paramSource!.set(nodeParamContestPath("ch1", "eqBands.0.on"), "default");

  const band = planToCommands(MODEL, plan, "all").filter((c) => c.node === "ch1" && c.name === "EQ_BAND_ON");
  expect(band.length, "the premise: the bands reach the wire").toBeGreaterThan(0);
  expect(unauthoredWriteNodes(MODEL, plan, "all", new Set([cmdAddr(band[0])]))).toEqual(["ch1"]);
});

// The floor under every case above: a plan the operator authored throughout names nothing,
// whatever the write is changing. The emit reads keys the plan does NOT carry on its way to a
// decision — 52 such reads on a factory-filled URX44V — and a command pushed after one of them
// carries no plan key at all, so taking that name would put a strip in the note for a value
// nobody supplied.
it("says nothing about a plan the operator authored throughout", () => {
  const plan = filledPlan();
  for (const key of plan.paramSource!.keys()) plan.paramSource!.set(key, "load");
  const every = new Set(planToCommands(MODEL, plan, "all").map(cmdAddr));
  expect(every.size, "the premise: the write has plenty to send").toBeGreaterThan(100);
  expect(unauthoredWriteNodes(MODEL, plan, "all", every)).toEqual([]);
});

// A helper that builds several commands and pushes them together — the EQ 1-knob's ON, TYPE and
// LEVEL go out as one chain — must still give each its own key. Read off the pushes instead,
// the whole chain's reads land on the first of them and the other two answer for nobody.
it.each(["ch1", "bus.stereo", "bus.mix1"])("names %s for a filled 1-knob level in a pushed chain", (node) => {
  const plan = filledPlan();
  plan.nodeParams[node] = { ...plan.nodeParams[node], eqOneKnob: { on: true, type: 0, level: 100 } };
  for (const key of plan.paramSource!.keys()) plan.paramSource!.set(key, "manual");
  const level = nodeParamContestPath(node, "eqOneKnob.level");
  plan.paramSource!.set(level, "default");

  const cmds = planToCommands(MODEL, plan, "all").filter((c) => c.node === node && c.name === "EQ_ONE_KNOB_LEVEL");
  expect(cmds.length, "the premise: the level reaches the wire").toBeGreaterThan(0);
  expect(unauthoredWriteNodes(MODEL, plan, "all", new Set(cmds.map(cmdAddr)))).toEqual([node]);
  // The control: the same address with the level the operator's own.
  plan.paramSource!.set(level, "manual");
  expect(unauthoredWriteNodes(MODEL, plan, "all", new Set(cmds.map(cmdAddr)))).toEqual([]);
});

// Two channels selecting the same shared engine slot collapse to one command, and the survivor
// is a COPY. Carried on the command rather than in a table keyed by the object, the record
// survives that copy; looked up by identity it does not, and the strip goes unnamed.
it("keeps a value's key across the shared-address collapse", () => {
  const plan = filledPlan();
  const key = insertFxParamKey("compander", 6);
  plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, insertFx: 1793, insertFxParams: { [key]: -2000 } };
  plan.nodeParams.ch2 = { ...plan.nodeParams.ch2, insertFx: 1794, insertFxParams: { [key]: -3000 } };
  for (const k of plan.paramSource!.keys()) plan.paramSource!.set(k, "manual");
  plan.paramSource!.set(nodeParamContestPath("ch2", `insertFxParams.${key}`), "device");

  const survivor = planToCommands(MODEL, plan, "all").filter((c) => c.node === "ch2" && c.name === "INSERT_FX_EFFECT");
  expect(survivor, "the premise: one command survives the collapse").toHaveLength(1);
  expect(survivor[0].shadowed, "the premise: it is the copy the collapse made").toEqual(["ch1"]);
  expect(unauthoredWriteNodes(MODEL, plan, "all", new Set(survivor.map(cmdAddr)))).toEqual(["ch2"]);
});

// The emit does not always send what the plan holds: the SSMCS bank's COMP and EQ switches go
// out INVERTED, ON as 0. Made a condition of the record, that transform read as a value nobody
// supplied and a document's own switch was named — so the key has to survive it, and the same
// value from the fill has to be named all the same.
describe.each(["compOn", "eqOn"] as const)("an SSMCS %s the document wrote", (leaf) => {
  const withSsmcs = (): Plan => {
    const plan = filledPlan();
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, compEqType: 1, [leaf]: true };
    for (const key of plan.paramSource!.keys()) plan.paramSource!.set(key, "manual");
    plan.paramSource!.set(nodeParamContestPath("ch1", leaf), "manual");
    return plan;
  };
  const addrs = (plan: Plan): Set<number> => {
    const cmds = planToCommands(MODEL, plan, "all").filter(
      (c) => c.node === "ch1" && c.name === (leaf === "compOn" ? "SSMCS_COMP_ON" : "SSMCS_EQ_ON"),
    );
    expect(cmds.length, "the premise: the switch reaches the wire").toBeGreaterThan(0);
    // The premise that makes this the inverting case: ON goes out as 0.
    expect(cmds[0].vdValue, "the premise: the switch is inverted on the wire").toBe(0);
    return new Set(cmds.map(cmdAddr));
  };

  it("is not named", () => {
    const plan = withSsmcs();
    expect(unauthoredWriteNodes(MODEL, plan, "all", addrs(plan))).toEqual([]);
  });

  it("is named once the same value came from the fill", () => {
    const plan = withSsmcs();
    plan.paramSource!.set(nodeParamContestPath("ch1", leaf), "default");
    expect(unauthoredWriteNodes(MODEL, plan, "all", addrs(plan))).toEqual(["ch1"]);
  });
});
