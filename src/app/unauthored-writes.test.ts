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
      plan.paramSource!.set(nodeParamContestPath("ch1", leaf), leaf === "insertFx" ? "device" : "manual");
    }
    return plan;
  };

  it("does not name a strip for an address its own authored leaf asks for", () => {
    const plan = withInsertFx();
    const engine = planToCommands(MODEL, plan, "all").filter((c) => c.node === "ch1" && c.name === "INSERT_FX_EFFECT");
    expect(engine.length, "the premise: the authored parameter reaches the wire").toBeGreaterThan(0);
    expect(unauthoredWriteNodes(MODEL, plan, "all", new Set(engine.map(cmdAddr)))).toEqual([]);
  });

  // The control on the same fixture: with the parameter unauthored too, nothing claims the
  // address and the strip IS named — so the case above is the join working, not the note
  // having gone quiet.
  it("names it once no authored leaf asks for that address", () => {
    const plan = withInsertFx();
    plan.paramSource!.set(nodeParamContestPath("ch1", `insertFxParams.${insertFxParamKey("compander", 6)}`), "device");
    const engine = planToCommands(MODEL, plan, "all").filter((c) => c.node === "ch1" && c.name === "INSERT_FX_EFFECT");
    expect(unauthoredWriteNodes(MODEL, plan, "all", new Set(engine.map(cmdAddr)))).toEqual(["ch1"]);
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
