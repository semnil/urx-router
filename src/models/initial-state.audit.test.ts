// QA audit (models/initial-state.ts + initial-*.ts): the factory-capture seed and
// the model's fixed-rule set are two independent sources that must line up. The
// capture (initial-urx44v.ts / initial-urx22.ts) hand-lists the factory wires,
// while build.ts marks certain rules `fixed` (non-removable). These pins record the
// current coupling so a change to either side surfaces instead of silently drifting.
// The block diagram remains the source of truth.

import { describe, expect, it } from "vitest";
import { ensureFixedConnections } from "../core/plan";
import { validatePlan } from "../core/routing";
import { MODELS, MODEL_IDS } from "./index";
import { defaultPlan } from "./initial-state";

describe("defaultPlan capture vs the model's fixed-rule set", () => {
  // AUDIT: the capture seeds every fixed `send` wire (CH/FX -> bus) but omits the two
  // fixed MIX 1/2 -> STEREO "TO ST" sendSwitch wires — they are OFF at the factory and
  // materialized lazily by ensureFixedConnections, which every real plan path runs
  // (startup + loadPlan in main.ts, and readback). So defaultPlan ALONE is not a
  // complete fixed-wire set; this pins exactly which fixed wires it leaves out.
  it.each(MODEL_IDS)("%s: the capture omits exactly the two fixed MIX -> STEREO TO ST switches", (id) => {
    const model = MODELS[id];
    const seeded = new Set(defaultPlan(id).connections.map((c) => `${c.from} ${c.to}`));
    const missing = model.rules.filter((r) => r.fixed && !seeded.has(`${r.from} ${r.to}`));
    expect(missing.map((r) => `${r.from} ${r.to}`).sort()).toEqual([
      "bus.mix1:out bus.stereo:in",
      "bus.mix2:out bus.stereo:in",
    ]);
    for (const r of missing) expect(r.kind).toBe("sendSwitch");
  });

  // ensureFixedConnections closes that gap: after it runs, the plan carries every
  // fixed wire, the two added TO ST switches come in OFF (params.on === false), and
  // the completed plan still validates.
  it.each(MODEL_IDS)("%s: ensureFixedConnections completes the seed to the full fixed set (TO ST off)", (id) => {
    const model = MODELS[id];
    const plan = defaultPlan(id);
    ensureFixedConnections(model, plan);
    const seeded = new Set(plan.connections.map((c) => `${c.from} ${c.to}`));
    for (const r of model.rules.filter((x) => x.fixed)) {
      expect(seeded.has(`${r.from} ${r.to}`), `${id}: ${r.from} ${r.to}`).toBe(true);
    }
    for (const mix of ["bus.mix1", "bus.mix2"]) {
      const toSt = plan.connections.find((c) => c.from === `${mix}:out` && c.to === "bus.stereo:in");
      expect(toSt?.params?.on, `${id}: ${mix} TO ST`).toBe(false);
    }
    expect(validatePlan(model, plan)).toEqual([]);
  });
});
