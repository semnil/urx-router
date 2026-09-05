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
  it("names the strip through the selector and the array it decides", () => {
    const plan = withInsertFx();
    plan.paramSource!.set(nodeParamContestPath("ch1", "insertFx"), "default");
    const selector = planToCommands(MODEL, plan, "all").filter((c) => c.node === "ch1" && c.name === "INSERT_FX");
    expect(selector.length, "the premise: the selector reaches the wire").toBeGreaterThan(0);
    expect(unauthoredWriteNodes(MODEL, plan, "all", new Set(selector.map(cmdAddr)))).toEqual(["ch1"]);
    expect(unauthoredWriteNodes(MODEL, plan, "all", engineAddrs(plan))).toEqual(["ch1"]);
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
  const addr = new Set(gain.map(cmdAddr));
  // The premise that makes this the DOWNWARD case: a step up encodes to the value it already
  // has, so only a step down can tell that the address follows this leaf.
  const up = { ...plan, nodeParams: { ...plan.nodeParams, ch1: { ...plan.nodeParams.ch1, gain: 71 } } };
  const upAt = planToCommands(MODEL, up, "all").filter((c) => c.node === "ch1" && c.name === "HA_GAIN");
  expect(upAt[0].vdValue, "the premise: a step up is clamped back").toBe(gain[0].vdValue);
  expect(unauthoredWriteNodes(MODEL, plan, "all", addr)).toEqual(["ch1"]);
});

// Removing a value does not always change what the emit sends: an FX channel's effect slots go
// out with the descriptor's own default when the plan carries none, and the fill puts exactly
// that default in the plan — so dropping the key emits the same number. Only moving the value
// separates them, and these are 24 commands a write really does send.
it("names a strip whose only unauthored key is one its removal cannot separate", () => {
  const plan = filledPlan();
  for (const key of plan.paramSource!.keys()) plan.paramSource!.set(key, "manual");
  const type = nodeParamContestPath("bus.fx1", "fxEffect.type");
  expect(plan.paramSource!.has(type), "the premise: the fill supplied the effect type").toBe(true);
  plan.paramSource!.set(type, "default");

  const fx = planToCommands(MODEL, plan, "all").filter((c) => c.node === "bus.fx1" && c.name.startsWith("FX_EFFECT"));
  expect(fx.length, "the premise: the section reaches the wire").toBeGreaterThan(0);

  // The premise that makes this the STEP's case: an absent effect type resolves to the
  // channel's factory type, which is the one the fill put there — so dropping the key sends
  // exactly what keeping it sends, and its removal says nothing about who decided the values.
  const bare = {
    ...plan,
    nodeParams: {
      ...plan.nodeParams,
      "bus.fx1": {
        ...plan.nodeParams["bus.fx1"],
        fxEffect: { ...plan.nodeParams["bus.fx1"]!.fxEffect, type: undefined },
      },
    },
  } as typeof plan;
  const without = new Map(
    planToCommands(MODEL, bare, "all")
      .filter((c) => c.node === "bus.fx1" && c.name.startsWith("FX_EFFECT"))
      .map((c) => [cmdAddr(c), c.vdValue]),
  );
  expect(
    fx.every((c) => without.get(cmdAddr(c)) === c.vdValue),
    "the premise: dropping the type changes nothing the write sends",
  ).toBe(true);

  expect(unauthoredWriteNodes(MODEL, plan, "all", new Set(fx.map(cmdAddr)))).toEqual(["bus.fx1"]);
});
