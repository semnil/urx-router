import { describe, expect, it } from "vitest";
import { getModel } from "../models";
import { defaultPlan } from "../models/initial-state";
import { simBindings } from "./sim-map";
import { DEVICE_SETUP_SCREENS, simLocks, UNIT_OPS, type SimLockSpec, type SimLockState } from "./sim-locks";

const REASONS = {
  deviceSetup: "deviceSetup",
  notAccepted: "notAccepted",
  unitOp: "unitOp",
  rateLinked: "rateLinked",
  followUsb: "followUsb",
  trackCountLive: "trackCountLive",
  fx2Rate: "fx2Rate",
  deviceDriven: "deviceDriven",
};
const model = getModel("URX44V");
const paths = [...simBindings(model).keys()];
const OFFLINE: SimLockState = { linked: false, live: false };

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
  it("holds the SETUP > GENERAL settings and every operation of the unit's own, at any time", () => {
    const all = locks();
    for (const id of DEVICE_SETUP_SCREENS) expect(reasonFor(all, { kind: "screen", id })).toBe("deviceSetup");
    for (const op of UNIT_OPS) expect(reasonFor(all, { kind: "op", op })).toBe("unitOp");
    expect(reasonFor(all, path("sd.usbStorage"))).toBe("unitOp");
    expect(reasonFor(all, path("setup.followUsb")), "the toolbar's FOLLOW USB is where it changes").toBe("followUsb");
    expect(reasonFor(all, { kind: "screen", id: "setup.patch" }), "Output Patch is the plan's").toBeNull();
  });

  it("holds a channel's PRE into an FX bus, which the unit does not take, and nothing else of the send", () => {
    const all = locks();
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

  it("holds the rate while the device link is held, and the Track Count while Live sync is up", () => {
    expect(reasonFor(locks(), { kind: "screen", id: "setup.rate" })).toBeNull();
    expect(reasonFor(locks(), path("sd.trackCount"))).toBeNull();
    const linked = locks({ linked: true, live: false });
    expect(reasonFor(linked, { kind: "screen", id: "setup.rate" })).toBe("rateLinked");
    expect(reasonFor(linked, path("sd.trackCount"))).toBeNull();
    const live = locks({ linked: true, live: true });
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
});
