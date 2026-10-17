import { describe, expect, it } from "vitest";
import { getModel } from "../models";
import { defaultPlan } from "../models/initial-state";
import { simBindings } from "./sim-map";
import { UNIT_ONLY_SCREENS, simLocks, UNIT_OPS, type SimLockSpec, type SimLockState } from "./sim-locks";

const REASONS = {
  unitOnly: "unitOnly",
  notAccepted: "notAccepted",
  unitOp: "unitOp",
  rateLinked: "rateLinked",
  trackCountLive: "trackCountLive",
  fx2Rate: "fx2Rate",
  deviceDriven: "deviceDriven",
  integrationOff: "integrationOff",
  rateFollowUsb: "rateFollowUsb",
};
const model = getModel("URX44V");
const paths = [...simBindings(model).keys()];
const OFFLINE: SimLockState = {
  linked: false,
  live: false,
  dawIntegration: false,
  rateOpen: false,
  rateFollowUsb: false,
};

function locks(state = OFFLINE, rate = 48_000): SimLockSpec[] {
  const plan = defaultPlan("URX44V");
  plan.sampleRate = rate;
  return simLocks(model, plan, paths, state, REASONS);
}
/** The reason `target` is held for, or null where it is not. */
function reasonFor(all: SimLockSpec[], target: SimLockSpec["target"]): string | null {
  return all.find((l) => JSON.stringify(l.target) === JSON.stringify(target))?.reason ?? null;
}
const path = (p: string) => ({ kind: "path", path: p }) as const;

describe("the controls the SIM view holds shut", () => {
  it("holds the SETUP > GENERAL settings the app does not write and every operation of the unit's own, at any time", () => {
    const all = locks();
    for (const id of UNIT_ONLY_SCREENS) expect(reasonFor(all, { kind: "screen", id })).toBe("unitOnly");
    for (const id of [
      "setup.language",
      "setup.brightness",
      "setup.udk",
      "setup.peripheral",
      "setup.power",
      "setup.datetime",
    ])
      expect(reasonFor(all, { kind: "screen", id }), `${id} is written to the unit`).toBeNull();
    for (const op of UNIT_OPS) expect(reasonFor(all, { kind: "op", op })).toBe("unitOp");
    expect(reasonFor(all, path("sd.usbStorage"))).toBe("unitOp");
    expect(reasonFor(all, path("setup.followUsb")), "a press is the toolbar's FOLLOW USB").toBeNull();
    expect(reasonFor(all, { kind: "screen", id: "setup.patch" }), "Output Patch is the plan's").toBeNull();
  });

  it("opens Software Integration and its sends only while Live sync is up on a unit a compatible DAW holds", () => {
    const targets = [
      { kind: "screen", id: "setup.integration" } as const,
      path("setup.integration.fx1Send"),
      path("setup.integration.fx2Send"),
    ];
    for (const target of targets) {
      const name = JSON.stringify(target);
      expect(reasonFor(locks(), target), name).toBe("integrationOff");
      expect(
        reasonFor(
          locks({ linked: true, live: true, dawIntegration: false, rateOpen: false, rateFollowUsb: false }),
          target,
        ),
        name,
      ).toBe("integrationOff");
      expect(
        reasonFor(
          locks({ linked: true, live: false, dawIntegration: true, rateOpen: false, rateFollowUsb: false }),
          target,
        ),
        `${name} no session`,
      ).toBe("integrationOff");
      expect(
        reasonFor(
          locks({ linked: true, live: true, dawIntegration: true, rateOpen: false, rateFollowUsb: false }),
          target,
        ),
        name,
      ).toBeNull();
    }
  });

  it("holds a channel's PRE into an FX bus while Live sync is up, which the unit does not take, and nothing else of the send", () => {
    expect(reasonFor(locks(), path("ch.ch1.send.fx1.pre")), "offline the tap is the plan's").toBeNull();
    expect(
      reasonFor(
        locks({ linked: true, live: false, dawIntegration: false, rateOpen: false, rateFollowUsb: false }),
        path("ch.ch1.send.fx1.pre"),
      ),
    ).toBeNull();
    const all = locks({ linked: true, live: true, dawIntegration: false, rateOpen: false, rateFollowUsb: false });
    expect(paths).toContain("ch.ch1.send.fx1.pre");
    expect(reasonFor(all, path("ch.ch1.send.fx1.pre"))).toBe("notAccepted");
    expect(reasonFor(all, path("ch.ch1.send.fx2.pre"))).toBe("notAccepted");
    expect(reasonFor(all, path("ch.ch1.send.fx1.level"))).toBeNull();
    expect(reasonFor(all, path("ch.ch1.send.mix1.pre")), "a MIX send's PRE is the plan's").toBeNull();
  });

  it("holds the sends into FX 2 at a rate that takes FX 2 out, and only then", () => {
    expect(reasonFor(locks(), path("ch.ch1.send.fx2.level"))).toBeNull();
    const high = locks(OFFLINE, 192_000);
    for (const field of ["on", "level"]) expect(reasonFor(high, path(`ch.ch1.send.fx2.${field}`))).toBe("fx2Rate");
    expect(reasonFor(high, path("ch.ch1.send.fx1.level"))).toBeNull();
  });

  it("opens the rate during Live sync while Follow USB is off, and names Follow USB while it is on", () => {
    const held = { linked: true, live: true, dawIntegration: false, rateOpen: false, rateFollowUsb: true };
    expect(reasonFor(locks(held), { kind: "screen", id: "setup.rate" }), "Follow USB on").toBe("rateFollowUsb");
    expect(
      reasonFor(locks({ ...held, rateFollowUsb: false }), { kind: "screen", id: "setup.rate" }),
      "a Scene-only session carries no rate",
    ).toBe("rateLinked");
    const screen = { kind: "screen", id: "setup.rate" } as const;
    expect(
      reasonFor(
        locks({ linked: true, live: true, dawIntegration: false, rateOpen: true, rateFollowUsb: false }),
        screen,
      ),
    ).toBeNull();
    expect(
      reasonFor(
        locks({ linked: true, live: false, dawIntegration: false, rateOpen: false, rateFollowUsb: false }),
        screen,
      ),
    ).toBe("rateLinked");
  });

  it("holds the rate while the device link is held, and the Track Count while Live sync is up", () => {
    expect(reasonFor(locks(), { kind: "screen", id: "setup.rate" })).toBeNull();
    expect(reasonFor(locks(), path("sd.trackCount"))).toBeNull();
    const linked = locks({ linked: true, live: false, dawIntegration: false, rateOpen: false, rateFollowUsb: false });
    expect(reasonFor(linked, { kind: "screen", id: "setup.rate" })).toBe("rateLinked");
    expect(reasonFor(linked, path("sd.trackCount"))).toBeNull();
    const live = locks({ linked: true, live: true, dawIntegration: false, rateOpen: false, rateFollowUsb: false });
    expect(reasonFor(live, path("sd.trackCount"))).toBe("trackCountLive");
  });

  it("holds an insert's rows the unit drives, and only while it drives them", () => {
    const plan = defaultPlan("URX44V");
    plan.nodeParams["bus.mix1"] = { ...plan.nodeParams["bus.mix1"], insertFx: 1792, insertFxOn: true };
    const knobOff = simLocks(model, plan, paths, OFFLINE, REASONS);
    expect(reasonFor(knobOff, path("ch.bus.mix1.insFx.oneKnobLevel")), "the level waits for the knob").toBe(
      "deviceDriven",
    );
    expect(reasonFor(knobOff, path("ch.bus.mix1.insFx.lowThreshold"))).toBeNull();
    plan.nodeParams["bus.mix1"].insertFxParams = { "mbc:6": 1 };
    const knobOn = simLocks(model, plan, paths, OFFLINE, REASONS);
    expect(reasonFor(knobOn, path("ch.bus.mix1.insFx.lowThreshold")), "the knob sets the bands").toBe("deviceDriven");
    expect(reasonFor(knobOn, path("ch.bus.mix1.insFx.outGain"))).toBeNull();
  });

  // The unit holds these still while its 1-knob or Auto Makeup is on and shows nothing for it, so
  // the LCD, which simulates the unit, draws them as the unit does: no padlock and no dimming.
  it("draws no lock on a COMP value the unit holds still without showing it", () => {
    const plan = defaultPlan("URX44V");
    const computed = ["threshold", "ratio", "gain", "knee", "attack", "release"];
    for (const key of computed) expect(paths, key).toContain(`ch.ch1.comp.${key}`);
    plan.nodeParams.ch1 = {
      ...plan.nodeParams.ch1,
      comp: { ...plan.nodeParams.ch1?.comp, oneKnob: true, autoMakeup: true },
    };
    const held = simLocks(model, plan, paths, OFFLINE, REASONS);
    for (const key of computed) expect(reasonFor(held, path(`ch.ch1.comp.${key}`)), key).toBeNull();
  });
});
