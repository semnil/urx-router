import { describe, expect, it } from "vitest";
import { defaultPlan } from "../models/initial-state";
import type { Plan } from "../core/plan";
import { silentKey } from "../core/control/params";
import { fxParams } from "../core/control/fx-effect";
import { takeFxReseeds } from "./fx-reseed";

const ROOM = 1;
const onRoom = (): Plan => {
  const plan = defaultPlan("URX44V");
  plan.nodeParams["bus.fx1"] = { ...plan.nodeParams["bus.fx1"], fxEffect: { type: ROOM } };
  return plan;
};
const aheadOfFx1 = { keepHeads: true, only: new Set([silentKey("fx", "bus.fx1")]) };
const notSent = (): boolean => false;

describe("takeFxReseeds", () => {
  it("hands the park in front of the type write the incoming type's keys, and spends the record", () => {
    const reseeds = new Map([["bus.fx1", ROOM]]);
    const keep = takeFxReseeds(reseeds, onRoom(), aheadOfFx1, notSent);
    expect([...(keep.get("bus.fx1") ?? [])]).toEqual(fxParams(ROOM).map((d) => d.key));
    expect(reseeds.size).toBe(0);
  });

  it("hands no other park anything, and leaves a pending record for its own", () => {
    const reseeds = new Map([["bus.fx1", ROOM]]);
    for (const scope of [
      {},
      { exclude: new Set([silentKey("fx", "ch1")]) },
      { keepHeads: true, only: new Set([silentKey("insertFx", "bus.fx1")]) },
      { only: new Set([silentKey("fx", "bus.fx1")]) },
    ]) {
      expect(takeFxReseeds(reseeds, onRoom(), scope, notSent).size, JSON.stringify(scope)).toBe(0);
      expect(reseeds.get("bus.fx1"), JSON.stringify(scope)).toBe(ROOM);
    }
  });

  it("drops a record no type write is pending for, at any park", () => {
    // The unit was last sent the type: selections that came back to it send nothing.
    const sent = new Map([["bus.fx1", ROOM]]);
    expect(takeFxReseeds(sent, onRoom(), {}, () => true).size).toBe(0);
    expect(sent.size).toBe(0);
    // …and in front of a head write as well, which then keeps nothing.
    const ahead = new Map([["bus.fx1", ROOM]]);
    expect(takeFxReseeds(ahead, onRoom(), aheadOfFx1, () => true).size).toBe(0);
    expect(ahead.size).toBe(0);
    // The channel has left the type.
    const left = new Map([["bus.fx1", 2]]);
    expect(takeFxReseeds(left, onRoom(), aheadOfFx1, notSent).size).toBe(0);
    expect(left.size).toBe(0);
  });
});
