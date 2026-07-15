// Device-follow DIRECT path integrity. A device-side edit to a node-local scalar
// (fader / pan / on / gain / level …) is reflected with NO read-back: follow.ts
// routes the notify to readback.applyDirect, which decodes the raw and writes the
// owner node's plan slot. Unlike the scoped path (which reuses applyDeviceState
// verbatim, so it can never drift from a full read), applyDirect is a SEPARATE
// switch — its decoder + target slot must independently agree with what a full
// readback would produce, or a device-side change would land differently through
// direct vs. scoped follow. These pin two contracts the existing suites do not:
//
//  1. Every param the catalog flags follow: "direct" is actually handled by
//     applyDirect (returns true). A new direct param added to params.ts but
//     forgotten here would silently fall back to a scoped read — correct, but the
//     no-read-back optimization is lost and a decoder bug would be masked.
//  2. emit ∘ applyDirect is a fixed point: applying an emitted command's raw back
//     through applyDirect and re-emitting reproduces the same broker value. This
//     is the direct-path twin of completeness.test.ts's emit ∘ readback fixed
//     point, and catches a wrong decoder (e.g. vdToPan where vdToLevel is meant)
//     or a write to the wrong plan slot.

import { describe, expect, it } from "vitest";
import { getModel } from "../../models";
import { emptyPlan, ensureFixedConnections, type Plan } from "../plan";
import { applyDirect } from "./readback";
import { planToCommands } from "./translate";
import type { ParamName, ParamSpec } from "./params";
import { PARAMS } from "./params";

const model = getModel("URX44V");

const DIRECT_NAMES: ParamName[] = (Object.entries(PARAMS as Record<string, ParamSpec>) as [ParamName, ParamSpec][])
  .filter(([, spec]) => spec.follow === "direct")
  .map(([name]) => name);

function base(): Plan {
  const plan = emptyPlan("URX44V");
  ensureFixedConnections(model, plan);
  return plan;
}

// A plan seeded so every follow: "direct" param is actually emitted (some are
// only emitted when the plan carries the value, e.g. bus master fader / OSC level).
function seeded(): Plan {
  const plan = base();
  plan.nodeParams["bus.stereo"] = { level: -3, pan: -10, on: false };
  plan.nodeParams["bus.mix1"] = { level: -5, on: false, pan: 5, panLink: true };
  plan.nodeParams["bus.mon1"] = { on: false, level: -6, phonesLevel: 5 };
  plan.nodeParams["bus.mon2"] = { on: true, level: -12, phonesLevel: 3 };
  plan.nodeParams["bus.osc"] = { osc: { on: true, level: -20, mode: 0 } };
  plan.nodeParams["bus.fx1"] = { level: -4, pan: 8, on: false };
  plan.nodeParams["ch1"] = { on: false, gain: 20 };
  return plan;
}

describe("device-follow direct path is complete over the catalog", () => {
  it('every follow: "direct" param is handled by applyDirect (no silent scoped fallback)', () => {
    // applyDirect returns true purely by ParamName, so any owner node exercises the
    // switch coverage; a param missing from the switch returns false and would be
    // caught here (it would silently degrade to a scoped read at runtime).
    for (const name of DIRECT_NAMES) {
      expect.soft(applyDirect(base(), "ch1", name, 0), name).toBe(true);
    }
  });

  it("the seeded plan actually emits a command for every direct param", () => {
    // Guards the fixed-point test below against a false pass: if a direct param
    // stopped being emitted, its round trip would vanish silently. Every direct
    // ParamName must appear at least once in the seeded command set.
    const emitted = new Set(planToCommands(model, seeded()).map((c) => c.name));
    const missing = DIRECT_NAMES.filter((n) => !emitted.has(n));
    expect(missing).toEqual([]);
  });
});

describe("emit ∘ applyDirect fixed point (direct follow reflects a device edit correctly)", () => {
  it("applying each emitted direct command's raw back through applyDirect re-emits the same broker value", () => {
    const src = seeded();
    const directCmds = planToCommands(model, src).filter((c) => DIRECT_NAMES.includes(c.name) && c.node !== undefined);
    expect(directCmds.length).toBeGreaterThan(0);

    for (const cmd of directCmds) {
      // Reflect the device-reported raw into a fresh plan through the direct path,
      // exactly as follow.ts does on a notify (no read-back).
      const dst = base();
      const ok = applyDirect(dst, cmd.node!, cmd.name, cmd.vdValue);
      expect.soft(ok, `${cmd.name}@${cmd.node}`).toBe(true);

      // Re-translate: the same address must carry the same broker value, i.e. the
      // decoder + target slot applyDirect chose invert the encoder translate used.
      const reEmit = planToCommands(model, dst).find(
        (c) => c.paramId === cmd.paramId && c.x === cmd.x && c.y === cmd.y,
      );
      expect.soft(reEmit?.vdValue, `${cmd.name}@${cmd.paramId}:${cmd.x}:${cmd.y}`).toBe(cmd.vdValue);
    }
  });

  it("a direct on/off toggle round-trips both states (polarity is not inverted)", () => {
    // Independent of the encoded default: force each boolean direct param through
    // both raw states and confirm the re-emit matches, so a flipped polarity in
    // applyDirect (e.g. treating 0 as ON) is caught.
    const boolNames = DIRECT_NAMES.filter((n) => (PARAMS as Record<string, ParamSpec>)[n].encoding === "bool");
    const src = seeded();
    for (const name of boolNames) {
      const sample = planToCommands(model, src).find((c) => c.name === name && c.node !== undefined);
      if (!sample) continue;
      for (const raw of [0, 1]) {
        const dst = base();
        applyDirect(dst, sample.node!, name, raw);
        const reEmit = planToCommands(model, dst).find(
          (c) => c.paramId === sample.paramId && c.x === sample.x && c.y === sample.y,
        );
        expect.soft(reEmit?.vdValue, `${name}=${raw}`).toBe(raw);
      }
    }
  });
});
