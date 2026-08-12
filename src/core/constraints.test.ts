import { describe, it, expect } from "vitest";
import {
  rateConstraints,
  formatRate,
  SAMPLE_RATES,
  DEFAULT_SAMPLE_RATE,
  duckerBypassWarnings,
  channelDuckerOn,
  channelEqUnavailable,
  insertFxAllRateLocked,
  insertFxFree,
  insertFxMenu,
  canPatchFromMonitor,
  isMonitorBus,
  outputMono,
} from "./constraints";
import type { InsertFxMenuEntry } from "./constraints";
import { directOutTarget } from "./routing";
import { emptyPlan } from "./plan";
import { getModel } from "../models";
import { ref } from "../models/types";
import {
  INSERT_FX_NONE,
  INSERT_FX_OPTIONS,
  OUTPUT_INSERT_FX_OPTIONS,
  PAN_BAL_BAL,
  PAN_BAL_PAN,
} from "./control/params";
import type { InsertFxOption, InsertFxSlot } from "./control/params";

describe("rateConstraints", () => {
  it("reports no warnings at or below 96 kHz", () => {
    for (const rate of [44100, 48000, 88200, 96000]) {
      const c = rateConstraints(getModel("URX44"), rate);
      expect(c.warnings).toEqual([]);
      expect(c.disabledNodes).toEqual([]);
    }
  });

  it("disables insert FX and the FX2 bus above 96 kHz", () => {
    const c = rateConstraints(getModel("URX44"), 192000);
    expect(c.warnings).toContain("insFx");
    expect(c.warnings).toContain("fx2");
    expect(c.disabledNodes).toContain("bus.fx2");
  });

  it("warns the stereo-channel EQ drops out at 176.4 / 192 kHz, not at 96 kHz", () => {
    for (const id of ["URX22", "URX44", "URX44V"] as const) {
      expect(rateConstraints(getModel(id), 96000).warnings).not.toContain("stereoEq");
      expect(rateConstraints(getModel(id), 176400).warnings).toContain("stereoEq");
      expect(rateConstraints(getModel(id), 192000).warnings).toContain("stereoEq");
    }
  });

  it("treats 176.4 kHz the same as 192 kHz", () => {
    const a = rateConstraints(getModel("URX22"), 176400);
    const b = rateConstraints(getModel("URX22"), 192000);
    expect(a).toEqual(b);
  });
});

describe("channelEqUnavailable", () => {
  it("is true only for a stereo channel at 176.4 / 192 kHz", () => {
    expect(channelEqUnavailable("ch_5_6", 176400)).toBe(true);
    expect(channelEqUnavailable("ch_5_6", 192000)).toBe(true);
    expect(channelEqUnavailable("ch_5_6", 96000)).toBe(false);
    expect(channelEqUnavailable("ch_5_6", 48000)).toBe(false);
  });

  it("never fires for a mono channel or a bus (their EQ survives high rates)", () => {
    expect(channelEqUnavailable("ch1", 192000)).toBe(false);
    expect(channelEqUnavailable("bus.stereo", 192000)).toBe(false);
    expect(channelEqUnavailable("bus.mix1", 192000)).toBe(false);
  });
});

// The slot facts come off the catalog rather than being listed here, so a family
// added to INSERT_FX_OPTIONS with a new slot joins these cases without an edit.
const bySlot = (options: InsertFxOption[]): Map<InsertFxSlot, InsertFxOption[]> => {
  const map = new Map<InsertFxSlot, InsertFxOption[]>();
  for (const o of options) if (o.slot) map.set(o.slot, [...(map.get(o.slot) ?? []), o]);
  return map;
};
const INPUT_SLOTS = bySlot(INSERT_FX_OPTIONS);

const planAt = (rate: number): ReturnType<typeof emptyPlan> => {
  const plan = emptyPlan("URX44V");
  plan.sampleRate = rate;
  return plan;
};

describe("insertFxMenu", () => {
  const u44v = getModel("URX44V");
  const lockOf = (menu: InsertFxMenuEntry[], label: string): string | null =>
    menu.find((e) => e.option.label === label)!.lock;

  it("offers the node's own option list, locking an effect above its own rate ceiling", () => {
    for (const rate of SAMPLE_RATES) {
      const menu = insertFxMenu(u44v, planAt(rate), "ch1");
      expect(menu.map((e) => e.option)).toEqual(INSERT_FX_OPTIONS);
      for (const e of menu) {
        const overCeiling = e.option.maxRate !== undefined && rate > e.option.maxRate;
        expect(e.lock).toBe(overCeiling ? "rate" : null);
      }
      // No Effect has no ceiling and no slot: it is always selectable.
      expect(lockOf(menu, "No Effect")).toBeNull();
    }
  });

  // The device facts behind the loop above (user guide p.180), named so a ceiling
  // mistyped in the catalog cannot pass by agreeing with itself.
  it("keeps Pitch Fix to 48 kHz, the amps to 96 kHz, and nothing above that", () => {
    expect(lockOf(insertFxMenu(u44v, planAt(48000), "ch1"), "Pitch Fix")).toBeNull();
    expect(lockOf(insertFxMenu(u44v, planAt(96000), "ch1"), "Pitch Fix")).toBe("rate");
    expect(lockOf(insertFxMenu(u44v, planAt(96000), "ch1"), "Clean")).toBeNull();
    expect(lockOf(insertFxMenu(u44v, planAt(192000), "ch1"), "Clean")).toBe("rate");
    expect(insertFxFree(insertFxMenu(u44v, planAt(192000), "ch1"))).toEqual([]);
  });

  it("locks every option of a slot another node holds, and only that slot", () => {
    expect(INPUT_SLOTS.size).toBeGreaterThan(1); // else "only that slot" is vacuous
    for (const [slot, options] of INPUT_SLOTS) {
      const plan = planAt(48000); // no effect is rate-locked here, so every lock is the slot's
      plan.nodeParams["ch1"] = { insertFx: options[0].value };
      for (const e of insertFxMenu(u44v, plan, "ch2")) {
        expect(e.lock).toBe(e.option.slot === slot ? "slot" : null);
      }
    }
  });

  it("does not hold a node's own selection against itself", () => {
    for (const [, options] of INPUT_SLOTS) {
      const plan = planAt(48000);
      plan.nodeParams["ch1"] = { insertFx: options[0].value };
      expect(insertFxMenu(u44v, plan, "ch1").every((e) => e.lock === null)).toBe(true);
    }
  });

  // A STEREO-linked pair holds one effect between them on the unit, and the app mirrors
  // the selection onto both members — so the census counts the pair once and the pair's
  // own menu must not lock against what the app itself wrote. The gate is Signal Type:
  // the unit was measured mirroring in PAN mode too.
  it("does not hold a linked partner's mirrored selection against either member", () => {
    for (const panBal of [PAN_BAL_BAL, PAN_BAL_PAN]) {
      for (const [, options] of INPUT_SLOTS) {
        const plan = planAt(48000);
        plan.nodeParams["ch1"] = { stereoLink: true, panBal, insertFx: options[0].value };
        plan.nodeParams["ch2"] = { insertFx: options[0].value };
        expect(insertFxMenu(u44v, plan, "ch1").every((e) => e.lock === null)).toBe(true);
        expect(insertFxMenu(u44v, plan, "ch2").every((e) => e.lock === null)).toBe(true);
        // The pair still holds the slot against an unrelated channel.
        expect(lockOf(insertFxMenu(u44v, plan, "ch3"), options[0].label)).toBe("slot");
      }
    }
  });

  it("shares the out-dyn slot across the output buses without touching the channel menus", () => {
    const plan = planAt(48000);
    plan.nodeParams["bus.stereo"] = { insertFx: OUTPUT_INSERT_FX_OPTIONS.find((o) => o.slot === "out-dyn")!.value };
    // Every output effect is on that one slot, so a MIX bus has nothing left to take.
    expect(insertFxFree(insertFxMenu(u44v, plan, "bus.mix1"))).toEqual([]);
    // The channels' compander is a different slot, so their menus stay open.
    expect(insertFxMenu(u44v, plan, "ch1").every((e) => e.lock === null)).toBe(true);
  });

  it("is empty for a node with no insert FX", () => {
    expect(insertFxMenu(u44v, planAt(48000), "ch_5_6")).toEqual([]);
    expect(insertFxAllRateLocked([])).toBe(false);
  });

  it("drops No Effect and both lock reasons from the free list", () => {
    const plan = planAt(96000); // Pitch Fix is out on rate
    plan.nodeParams["ch1"] = { insertFx: INPUT_SLOTS.get("compander")![0].value };
    const menu = insertFxMenu(u44v, plan, "ch2");
    const free = insertFxFree(menu);
    expect(free.map((o) => o.label)).toEqual(["Clean", "Crunch", "Lead", "Drive"]);
    expect(free.some((o) => o.value === INSERT_FX_NONE)).toBe(false);
    for (const e of menu) expect(free.includes(e.option)).toBe(e.lock === null && e.option.value !== INSERT_FX_NONE);
  });
});

describe("insertFxAllRateLocked", () => {
  const u44v = getModel("URX44V");

  it("is true only above every effect's ceiling", () => {
    for (const rate of SAMPLE_RATES) {
      const locked = insertFxAllRateLocked(insertFxMenu(u44v, planAt(rate), "ch1"));
      expect(locked).toBe(rate > 96000);
    }
  });

  it("ignores a slot lock — a menu can be empty of free effects without the rate", () => {
    const plan = planAt(48000);
    plan.nodeParams["bus.stereo"] = { insertFx: OUTPUT_INSERT_FX_OPTIONS.find((o) => o.slot === "out-dyn")!.value };
    const menu = insertFxMenu(u44v, plan, "bus.mix1");
    expect(insertFxFree(menu)).toEqual([]);
    expect(insertFxAllRateLocked(menu)).toBe(false);
  });
});

describe("formatRate", () => {
  it("renders kHz with a fractional part where needed", () => {
    expect(formatRate(48000)).toBe("48 kHz");
    expect(formatRate(44100)).toBe("44.1 kHz");
    expect(formatRate(176400)).toBe("176.4 kHz");
  });
});

describe("directOutTarget", () => {
  const u44v = getModel("URX44V");

  it("classifies a channel tap by destination — USB vs microSD Rec", () => {
    expect(directOutTarget(u44v, ref("ch_5_6", "out"), ref("out.usbmain_b", "in"))).toBe("usb");
    expect(directOutTarget(u44v, ref("ch_5_6", "out"), ref("out.sdrec.t1", "in"))).toBe("sdRec");
  });

  it("is null for a bus source into the same direct out (post-Ducker)", () => {
    expect(directOutTarget(u44v, ref("bus.stereo", "out"), ref("out.usbmain_b", "in"))).toBeNull();
    expect(directOutTarget(u44v, ref("bus.mix1", "out"), ref("out.usbmain_b", "in"))).toBeNull();
  });

  it("is null for a bus send (not a patch/record)", () => {
    expect(directOutTarget(u44v, ref("ch_5_6", "out"), ref("bus.stereo", "in"))).toBeNull();
  });
});

describe("duckerBypassWarnings", () => {
  const u44v = getModel("URX44V");

  it("reports nothing when no ducker is on", () => {
    const plan = emptyPlan("URX44V");
    plan.connections.push({ from: ref("ch_5_6", "out"), to: ref("out.usbmain_b", "in"), kind: "patch" });
    expect(duckerBypassWarnings(u44v, plan)).toEqual([]);
  });

  it("reports nothing when the ducked channel has no direct out", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["out.ducker1"] = { duckerOn: true };
    plan.connections.push({ from: ref("ch_5_6", "out"), to: ref("bus.stereo", "in"), kind: "send" });
    expect(duckerBypassWarnings(u44v, plan)).toEqual([]);
  });

  it("flags a channel whose ducker is on and is tapped to a USB direct out", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["out.ducker1"] = { duckerOn: true };
    plan.connections.push({ from: ref("ch_5_6", "out"), to: ref("out.usbmain_b", "in"), kind: "patch" });
    expect(duckerBypassWarnings(u44v, plan)).toEqual(["ch_5_6"]);
  });

  it("does not flag a microSD Rec tap (dry recording is intentional)", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["out.ducker1"] = { duckerOn: true };
    plan.connections.push({ from: ref("ch_5_6", "out"), to: ref("out.sdrec.t1", "in"), kind: "record" });
    expect(duckerBypassWarnings(u44v, plan)).toEqual([]);
  });

  it("does not flag a bus-sourced USB out (the duck is already in the bus)", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["out.ducker1"] = { duckerOn: true };
    plan.connections.push({ from: ref("bus.stereo", "out"), to: ref("out.usbmain_b", "in"), kind: "patch" });
    expect(duckerBypassWarnings(u44v, plan)).toEqual([]);
  });

  // Two independent ducked channels, each tapped to a USB direct out, must each be
  // flagged (the warning is per host, not a single boolean). Discover the ducker→host
  // mapping from the model so the pairing stays correct if build.ts renumbers.
  it("flags every ducked-and-tapped channel, not just the first", () => {
    const duckers = u44v.nodes.filter((n) => n.kind === "ducker" && n.attachTo);
    expect(duckers.length).toBeGreaterThanOrEqual(2);
    const [d1, d2] = duckers;
    const plan = emptyPlan("URX44V");
    plan.nodeParams[d1.id] = { duckerOn: true };
    plan.nodeParams[d2.id] = { duckerOn: true };
    plan.connections.push(
      { from: ref(d1.attachTo!, "out"), to: ref("out.usbmain_b", "in"), kind: "patch" },
      { from: ref(d2.attachTo!, "out"), to: ref("out.usbsub", "in"), kind: "patch" },
    );
    expect(duckerBypassWarnings(u44v, plan).sort()).toEqual([d1.attachTo, d2.attachTo].sort());
  });

  // A host tapped to BOTH a USB out and a microSD Rec out is still flagged exactly once
  // for the USB tap; the SD tap neither adds a second entry nor suppresses the warning.
  it("flags a host once when it feeds both a USB out and a microSD Rec out", () => {
    const d = u44v.nodes.find((n) => n.kind === "ducker" && n.attachTo)!;
    const host = d.attachTo!;
    const plan = emptyPlan("URX44V");
    plan.nodeParams[d.id] = { duckerOn: true };
    plan.connections.push(
      { from: ref(host, "out"), to: ref("out.usbmain_b", "in"), kind: "patch" },
      { from: ref(host, "out"), to: ref("out.sdrec.t1", "in"), kind: "record" },
    );
    expect(duckerBypassWarnings(u44v, plan)).toEqual([host]);
  });
});

describe("channelDuckerOn", () => {
  const u44v = getModel("URX44V");

  it("is true only when the channel's hung ducker is on", () => {
    const plan = emptyPlan("URX44V");
    expect(channelDuckerOn(u44v, plan, "ch_5_6")).toBe(false); // factory ducker off
    plan.nodeParams["out.ducker1"] = { duckerOn: true }; // ducker1 hangs on ch_5_6
    expect(channelDuckerOn(u44v, plan, "ch_5_6")).toBe(true);
    expect(channelDuckerOn(u44v, plan, "ch_7_8")).toBe(false); // a different channel's ducker
  });
});

describe("outputMono", () => {
  const patch = (plan: ReturnType<typeof emptyPlan>, from: string, to: string): void => {
    plan.connections.push({ from: ref(from, "out"), to: ref(to, "in"), kind: "patch" });
  };

  it("reports no mono on an unpatched output", () => {
    expect(outputMono(emptyPlan("URX44V"), "out.main")).toEqual({ via: "none" });
  });

  // The factory arrangement. It is legal and common, which is why this state is
  // stated rather than warned about.
  it("reports no mono for a STEREO / MIX / STREAMING patch", () => {
    for (const src of ["bus.stereo", "bus.mix1", "bus.stream"]) {
      const plan = emptyPlan("URX44V");
      patch(plan, src, "out.main");
      expect(outputMono(plan, "out.main")).toEqual({ via: "none" });
    }
  });

  it("names the monitor bus a patch passes through, and its switch state", () => {
    const plan = emptyPlan("URX44V");
    patch(plan, "bus.mon1", "out.main");
    expect(outputMono(plan, "out.main")).toEqual({ via: "monitor", monitorId: "bus.mon1", on: false });
    plan.nodeParams["bus.mon1"] = { mono: true };
    expect(outputMono(plan, "out.main")).toEqual({ via: "monitor", monitorId: "bus.mon1", on: true });
  });

  // The value reaches the device as `np.mono ? 1 : 0` (translate.ts) and the load funnel
  // lets a finite numeric leaf through unchecked, so a plan authored elsewhere can carry
  // `mono: 1`. That unit IS summing to mono; a strict `=== true` here would report OFF
  // about it.
  it("reads the switch the way the device write reads it", () => {
    const plan = emptyPlan("URX44V");
    patch(plan, "bus.mon1", "out.main");
    plan.nodeParams["bus.mon1"] = { mono: 1 as unknown as boolean };
    expect(outputMono(plan, "out.main")).toEqual({ via: "monitor", monitorId: "bus.mon1", on: true });
    plan.nodeParams["bus.mon1"] = { mono: 0 as unknown as boolean };
    expect(outputMono(plan, "out.main")).toEqual({ via: "monitor", monitorId: "bus.mon1", on: false });
  });

  // The A/B rig: MAIN through a mono-switched monitor, LINE straight from STEREO.
  // Each output answers from its own patch, so the stereo half is not contaminated
  // by the mono one — the reason no plan-wide predicate can call either a mistake.
  it("answers per output", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.mon2"] = { mono: true };
    patch(plan, "bus.mon2", "out.main");
    patch(plan, "bus.stereo", "out.line");
    expect(outputMono(plan, "out.main")).toEqual({ via: "monitor", monitorId: "bus.mon2", on: true });
    expect(outputMono(plan, "out.line")).toEqual({ via: "none" });
  });
});

describe("canPatchFromMonitor / isMonitorBus", () => {
  // The scope rule: the row exists where a routing change can remove the lock. A
  // USB output cannot take a MONITOR source at all, so it is not an analog output
  // here however much it is an output.
  it("covers MAIN / LINE and excludes the USB and microSD outputs", () => {
    const m = getModel("URX44V");
    expect(canPatchFromMonitor(m, "out.main")).toBe(true);
    expect(canPatchFromMonitor(m, "out.line")).toBe(true);
    for (const id of ["out.usbmain_a", "out.usbmain_b", "out.usbsub", "out.sdrec.t1"])
      expect(canPatchFromMonitor(m, id)).toBe(false);
    // Read from the rules, so a model without LINE OUT answers from its own rules
    // rather than from a list that has to remember the URX22 is different.
    expect(canPatchFromMonitor(getModel("URX22"), "out.main")).toBe(true);
    expect(canPatchFromMonitor(getModel("URX22"), "out.line")).toBe(false);
  });

  it("covers both monitor buses and nothing else", () => {
    expect(isMonitorBus("bus.mon1")).toBe(true);
    expect(isMonitorBus("bus.mon2")).toBe(true);
    for (const id of ["bus.stereo", "bus.mix1", "bus.stream", "out.main"]) expect(isMonitorBus(id)).toBe(false);
  });

  // Every id the two sets name has to exist on the models that carry it, or the
  // row silently never renders. The URX22 has no LINE OUT, so it is checked on
  // the models that do.
  it("names nodes the models actually have", () => {
    for (const id of ["out.main", "bus.mon1", "bus.mon2"])
      for (const m of ["URX22", "URX44", "URX44V"] as const)
        expect(getModel(m).nodes.some((n) => n.id === id)).toBe(true);
    for (const m of ["URX44", "URX44V"] as const) expect(getModel(m).nodes.some((n) => n.id === "out.line")).toBe(true);
    expect(getModel("URX22").nodes.some((n) => n.id === "out.line")).toBe(false);
  });
});

describe("sample-rate table", () => {
  it("includes the default rate", () => {
    expect(SAMPLE_RATES).toContain(DEFAULT_SAMPLE_RATE);
  });
});
