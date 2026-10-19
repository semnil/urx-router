import { describe, expect, it } from "vitest";
import { getModel } from "../models";
import { simBindings } from "./sim-map";
import { setupGlassPaths } from "./sim-map-setup";
import {
  rateHoldReason,
  SETUP_WRITTEN_SCREENS,
  UNIT_ONLY_SCREENS,
  simLocks,
  UNIT_OPS,
  type SimLockSpec,
  type SimLockState,
} from "./sim-locks";

const REASONS = {
  unitOnly: "unitOnly",
  notAccepted: "notAccepted",
  unitOp: "unitOp",
  rateLinked: "rateLinked",
  rateScope: "rateScope",
  trackCountLive: "trackCountLive",
  integrationOff: "integrationOff",
  rateFollowUsb: "rateFollowUsb",
  setupOffline: "setupOffline",
};
const model = getModel("URX44V");
const paths = [...simBindings(model).keys()];
const OFFLINE: SimLockState = {
  linked: false,
  live: false,
  rateOpen: false,
  rateScope: false,
  followUsbOn: false,
};
const LINKED: SimLockState = { ...OFFLINE, linked: true };
const LIVE: SimLockState = { ...LINKED, live: true };

function locks(state = OFFLINE): SimLockSpec[] {
  return simLocks(paths, setupGlassPaths(model), state, REASONS);
}
/** The reason `target` is held for, or null where it is not. */
function reasonFor(all: SimLockSpec[], target: SimLockSpec["target"]): string | null {
  return all.find((l) => JSON.stringify(l.target) === JSON.stringify(target))?.reason ?? null;
}
const path = (p: string) => ({ kind: "path", path: p }) as const;

describe("the controls the SIM view holds shut", () => {
  it("holds the SETUP > GENERAL settings the app does not write and every operation of the unit's own, at any time", () => {
    const all = locks(LIVE);
    for (const id of UNIT_ONLY_SCREENS) expect(reasonFor(all, { kind: "screen", id })).toBe("unitOnly");
    for (const id of SETUP_WRITTEN_SCREENS)
      expect(reasonFor(all, { kind: "screen", id }), `${id} is written to the unit`).toBeNull();
    for (const op of UNIT_OPS) expect(reasonFor(all, { kind: "op", op })).toBe("unitOp");
    expect(reasonFor(all, path("sd.usbStorage"))).toBe("unitOp");
    expect(reasonFor(all, path("setup.followUsb")), "a press is the toolbar's FOLLOW USB").toBeNull();
    expect(reasonFor(all, { kind: "screen", id: "setup.patch" }), "Output Patch is the plan's").toBeNull();
  });

  // The app writes the unit's SETUP > GENERAL settings over the Live sync session alone, so with no
  // session the screens and the values on a screen already open are held, a link without a session
  // included.
  it("holds the SETUP > GENERAL settings the app writes while Live sync is down, and opens them while it is up", () => {
    const values = setupGlassPaths(model);
    for (const p of [
      "setup.brightness",
      "setup.language",
      "setup.power.autoPowerOff",
      "setup.udk.1.A",
      "setup.udk.4.D",
    ])
      expect(values, p).toContain(p);
    expect(values, "the unit's knob bank is read and never written").not.toContain("setup.udk.bank");
    for (const state of [OFFLINE, LINKED]) {
      const all = locks(state);
      for (const id of SETUP_WRITTEN_SCREENS) expect(reasonFor(all, { kind: "screen", id }), id).toBe("setupOffline");
      for (const p of values) expect(reasonFor(all, path(p)), p).toBe("setupOffline");
      expect(reasonFor(all, path("setup.udk.bank"))).toBeNull();
    }
    const live = locks(LIVE);
    for (const id of SETUP_WRITTEN_SCREENS) expect(reasonFor(live, { kind: "screen", id }), id).toBeNull();
    for (const p of values) expect(reasonFor(live, path(p)), p).toBeNull();
  });

  // Whether a compatible DAW holds the unit is read only while Live sync is up, so the screen is held
  // offline and on a link without a session. During Live sync it is the simulator's to draw.
  it("holds Software Integration and its sends while Live sync is down, and opens them while it is up", () => {
    const targets = [
      { kind: "screen", id: "setup.integration" } as const,
      path("setup.integration.fx1Send"),
      path("setup.integration.fx2Send"),
    ];
    for (const target of targets) {
      const name = JSON.stringify(target);
      expect(reasonFor(locks(), target), name).toBe("integrationOff");
      expect(reasonFor(locks(LINKED), target), `${name} no session`).toBe("integrationOff");
      expect(reasonFor(locks(LIVE), target), name).toBeNull();
    }
  });

  it("holds a channel's PRE into an FX bus while Live sync is up, which the unit does not take, and nothing else of the send", () => {
    expect(reasonFor(locks(), path("ch.ch1.send.fx1.pre")), "offline the tap is the plan's").toBeNull();
    expect(reasonFor(locks(LINKED), path("ch.ch1.send.fx1.pre"))).toBeNull();
    const all = locks(LIVE);
    expect(paths).toContain("ch.ch1.send.fx1.pre");
    expect(reasonFor(all, path("ch.ch1.send.fx1.pre"))).toBe("notAccepted");
    expect(reasonFor(all, path("ch.ch1.send.fx2.pre"))).toBe("notAccepted");
    expect(reasonFor(all, path("ch.ch1.send.fx1.level"))).toBeNull();
    expect(reasonFor(all, path("ch.ch1.send.mix1.pre")), "a MIX send's PRE is the plan's").toBeNull();
  });

  // While Follow USB is on the unit takes no rate from its own screen either, and the simulator
  // shows that from the Follow USB it is given, so nothing of the app's own is drawn there.
  it("opens the rate during Live sync while Follow USB is off, and leaves it to the unit while Follow USB is on", () => {
    const screen = { kind: "screen", id: "setup.rate" } as const;
    expect(reasonFor(locks({ ...LIVE, followUsbOn: true }), screen), "Follow USB on").toBeNull();
    expect(reasonFor(locks({ ...LINKED, followUsbOn: true }), screen), "Follow USB on, no session").toBeNull();
    expect(
      reasonFor(locks({ ...LIVE, rateScope: true, followUsbOn: true }), screen),
      "Follow USB on, Scene only",
    ).toBeNull();
    expect(reasonFor(locks(LIVE), screen), "Follow USB not yet read").toBe("rateFollowUsb");
    expect(reasonFor(locks({ ...LIVE, rateScope: true }), screen), "a Scene-only session carries no rate").toBe(
      "rateScope",
    );
    expect(reasonFor(locks({ ...LIVE, rateOpen: true }), screen)).toBeNull();
    expect(reasonFor(locks(LINKED), screen)).toBe("rateLinked");
  });

  // The toolbar's rate picker gives the same reason, and holds the rate while Follow USB is on as
  // well: it has no simulator of its own to hold it.
  it("names why a rate chosen in the app does not reach the unit, and nothing where it does", () => {
    expect(rateHoldReason(OFFLINE, REASONS), "no link").toBeNull();
    expect(rateHoldReason(LINKED, REASONS), "a device action").toBe("rateLinked");
    expect(rateHoldReason({ ...LINKED, rateScope: true }, REASONS), "a session starting").toBe("rateLinked");
    expect(rateHoldReason({ ...LIVE, rateScope: true }, REASONS), "Scene only").toBe("rateScope");
    expect(rateHoldReason(LIVE, REASONS), "Follow USB on or not yet read").toBe("rateFollowUsb");
    expect(rateHoldReason({ ...LIVE, rateOpen: true }, REASONS), "Follow USB off").toBeNull();
  });

  it("holds the rate while the device link is held, and the Track Count while Live sync is up", () => {
    expect(reasonFor(locks(), { kind: "screen", id: "setup.rate" })).toBeNull();
    expect(reasonFor(locks(), path("sd.trackCount"))).toBeNull();
    const linked = locks(LINKED);
    expect(reasonFor(linked, { kind: "screen", id: "setup.rate" })).toBe("rateLinked");
    expect(reasonFor(linked, path("sd.trackCount"))).toBeNull();
    const live = locks(LIVE);
    expect(reasonFor(live, path("sd.trackCount"))).toBe("trackCountLive");
  });

  // The unit holds a COMP's computed values and an insert's driven rows still, and hides FX 2's
  // sends at the rates that take FX 2 out, and the simulator draws them as the unit does: no lock of
  // the app's own reaches them.
  it("draws no lock on a COMP's or an insert's values or on a send's level and ON, in any state", () => {
    const held = [OFFLINE, LINKED, LIVE].flatMap((state) => locks(state));
    const reached = held.filter(
      (l) => l.target.kind === "path" && /\.comp\.|\.insFx\.|\.send\.\w+\.(on|level)$/.test(l.target.path),
    );
    for (const key of ["threshold", "ratio", "gain", "knee", "attack", "release"])
      expect(paths, key).toContain(`ch.ch1.comp.${key}`);
    expect(paths.some((p) => p.includes(".insFx."))).toBe(true);
    expect(paths).toContain("ch.ch1.send.fx2.level");
    expect(reached).toEqual([]);
  });
});
