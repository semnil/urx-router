// The GATE / COMP / DUCKER time stop tables, against the unit's own: how many stops each
// has, where it starts and ends, and the sum of its raw stops — which an entry changed inside
// the table moves even where the count and the ends stay put. Then the identities the field
// tables rest on: one attack table for all three processors, one table for GATE decay and
// COMP release, and every factory value a stop.

import { describe, expect, it } from "vitest";
import { DUCKER_DECAY_STOPS_MS, DYN_ATTACK_STOPS_MS, DYN_HOLD_STOPS_MS, DYN_RELEASE_STOPS_MS } from "./dyn-time-stops";
import { attackToVd, holdToVd, releaseToVd, vdToAttack, vdToHold, vdToRelease } from "./vd";
import { channelDynamics, DUCKER_FIELDS } from "./translate";
import type { DynField } from "./translate";
import { COMP_EQ_COMP_FIRST } from "./params";
import { getModel, MODEL_IDS } from "../../models";
import { defaultPlan } from "../../models/initial-state";

const TABLES = [
  {
    name: "attack",
    ms: DYN_ATTACK_STOPS_MS,
    toRaw: attackToVd,
    fromRaw: vdToAttack,
    count: 227,
    first: 92,
    last: 80000,
    sum: 2707666,
  },
  {
    name: "hold",
    ms: DYN_HOLD_STOPS_MS,
    toRaw: holdToVd,
    fromRaw: vdToHold,
    count: 214,
    first: 2,
    last: 196000,
    sum: 4532608,
  },
  {
    name: "decay / release",
    ms: DYN_RELEASE_STOPS_MS,
    toRaw: releaseToVd,
    fromRaw: vdToRelease,
    count: 277,
    first: 93,
    last: 9990,
    sum: 590007,
  },
  {
    name: "ducker decay",
    ms: DUCKER_DECAY_STOPS_MS,
    toRaw: releaseToVd,
    fromRaw: vdToRelease,
    count: 122,
    first: 13,
    last: 50000,
    sum: 742257,
  },
] as const;

/** Every time field the channel strip and the ducker carry, by processor and key. */
function timeFields(): Map<string, DynField> {
  const dyn = channelDynamics(getModel("URX44V"), "ch1", COMP_EQ_COMP_FIRST)!;
  const out = new Map<string, DynField>();
  for (const f of dyn.gate) if (f.unit === "ms") out.set(`gate.${f.key}`, f);
  for (const f of dyn.comp!) if (f.unit === "ms") out.set(`comp.${f.key}`, f);
  for (const f of DUCKER_FIELDS) if (f.unit === "ms") out.set(`ducker.${f.key}`, f);
  return out;
}

describe("the time stop tables", () => {
  it.each(TABLES)("$name: the unit's count, ends and sum, strictly rising", (t) => {
    const raw = t.ms.map((v) => t.toRaw(v));
    expect(raw).toHaveLength(t.count);
    expect(raw[0]).toBe(t.first);
    expect(raw[raw.length - 1]).toBe(t.last);
    expect(raw.reduce((a, b) => a + b, 0)).toBe(t.sum);
    expect(raw.every((v, i) => i === 0 || v > raw[i - 1])).toBe(true);
  });

  // A stop is one raw the unit writes, and the encoders carry it there and back unchanged —
  // so a stop the plan holds is written as that raw, and a read of that raw is that stop.
  it.each(TABLES)("$name: every stop is a raw that reads back as itself", (t) => {
    const moved = t.ms.filter((v) => t.fromRaw(t.toRaw(v)) !== v);
    expect(moved).toEqual([]);
  });

  it("is one attack table for GATE, COMP and DUCKER, and one for GATE decay and COMP release", () => {
    const f = timeFields();
    expect([...f.keys()].sort()).toEqual(
      ["comp.attack", "comp.release", "ducker.attack", "ducker.decay", "gate.attack", "gate.decay", "gate.hold"].sort(),
    );
    expect(f.get("gate.attack")!.steps).toBe(DYN_ATTACK_STOPS_MS);
    expect(f.get("comp.attack")!.steps).toBe(DYN_ATTACK_STOPS_MS);
    expect(f.get("ducker.attack")!.steps).toBe(DYN_ATTACK_STOPS_MS);
    expect(f.get("gate.hold")!.steps).toBe(DYN_HOLD_STOPS_MS);
    expect(f.get("gate.decay")!.steps).toBe(DYN_RELEASE_STOPS_MS);
    expect(f.get("comp.release")!.steps).toBe(DYN_RELEASE_STOPS_MS);
    expect(f.get("ducker.decay")!.steps).toBe(DUCKER_DECAY_STOPS_MS);
  });

  // The window a field declares is its table's: the load, the write and the encoders all
  // bound by it, and a window wider than the table would admit a value no stop is.
  it("gives each time field its table's ends as its window", () => {
    for (const [key, f] of timeFields()) {
      expect(f.min, key).toBe(f.steps![0]);
      expect(f.max, key).toBe(f.steps![f.steps!.length - 1]);
    }
  });

  it("holds every factory value on a stop: the field defaults and every model's new plan", () => {
    for (const [key, f] of timeFields()) expect(f.steps, `${key} default ${f.def}`).toContain(f.def);
    const off: string[] = [];
    let checked = 0;
    for (const id of MODEL_IDS) {
      const plan = defaultPlan(id);
      for (const [node, np] of Object.entries(plan.nodeParams)) {
        for (const [group, values] of [
          ["gate", np.gate],
          ["comp", np.comp],
          ["ducker", np.ducker],
        ] as const) {
          for (const [key, v] of Object.entries(values ?? {})) {
            const f = timeFields().get(`${group}.${key}`);
            if (!f || typeof v !== "number") continue;
            checked++;
            if (!f.steps!.includes(v)) off.push(`${id} ${node} ${group}.${key} ${v}`);
          }
        }
      }
    }
    // A plan carrying no time value at all would satisfy the assertion above.
    expect(checked).toBeGreaterThan(0);
    expect(off).toEqual([]);
  });
});
