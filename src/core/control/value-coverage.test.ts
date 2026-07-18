// Value-pattern coverage: the round-trip tests confirm every param id is wired,
// but each param at only a point or two. This file sweeps the VALUE domain that
// matters — every enum OPTION and the continuous EXTREMES — through the real
// emit -> device -> readback path (device echoed by a faithful table), so each
// selectable value is verified end to end, not just its codec in isolation.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../../models";
import { emptyPlan, ensureFixedConnections, LEVEL_MAX_DB, LEVEL_OFF_DB, type Plan } from "../plan";
import { ref } from "../../models/types";

vi.mock("../platform", () => ({ vdGet: vi.fn(), vdGetStr: vi.fn() }));

import { vdGet, vdGetStr } from "../platform";
import { applyDeviceState } from "./readback";
import { planToCommands, planToNameWrites } from "./translate";
import type { VdCommand } from "./translate";
import {
  BUS_TYPE_OPTIONS,
  denormalizeInsertFx,
  DELAY_FRAME_RATE_OPTIONS,
  INSERT_FX_NONE,
  INSERT_FX_OPTIONS,
  OUTPUT_INSERT_FX_OPTIONS,
  PORT_REF_PARAM_IDS as PORT_REF_PARAMS,
  REC_POINT_OPTIONS,
} from "./params";
import {
  DELAY_TIME_MAX_MS,
  DELAY_TIME_MIN_MS,
  PHONES_LEVEL_MAX,
  PHONES_LEVEL_MIN,
  PORT_REF_NONE,
  VD_LEVEL_MAX,
  VD_LEVEL_OFF,
  VD_PAN_MAX,
} from "./vd";

const model = getModel("URX44V");

function base(): Plan {
  const plan = emptyPlan("URX44V");
  ensureFixedConnections(model, plan);
  return plan;
}

// Echo the emitted commands back as the device state, then read them into a
// fresh plan — the emit -> device -> readback round trip.
function roundTrip(plan: Plan): Promise<Plan> {
  const table = new Map<string, number>();
  for (const c of planToCommands(model, plan)) table.set(`${c.paramId}:${c.x}:${c.y}`, c.vdValue);
  vi.mocked(vdGet).mockImplementation((id, x, y) => {
    const k = `${id}:${x}:${y}`;
    return Promise.resolve(table.has(k) ? table.get(k)! : PORT_REF_PARAMS.has(id) ? PORT_REF_NONE : 0);
  });
  const strTable = new Map<string, string>();
  for (const w of planToNameWrites(model, plan)) strTable.set(`${w.param}:0:${w.y}`, w.value);
  vi.mocked(vdGetStr).mockImplementation((id, x, y) => Promise.resolve(strTable.get(`${id}:${x}:${y}`) ?? ""));
  const out = emptyPlan("URX44V");
  return applyDeviceState(model, out).then(() => out);
}

function cmd(plan: Plan, name: string, y: number): VdCommand | undefined {
  return planToCommands(model, plan).find((c) => c.name === name && c.y === y);
}

beforeEach(() => {
  vi.mocked(vdGet).mockReset();
  vi.mocked(vdGetStr).mockReset();
});

describe("insert-FX: every option encodes and round-trips", () => {
  for (const opt of INSERT_FX_OPTIONS) {
    it(`input "${opt.label}" (${opt.value})`, async () => {
      const plan = base();
      plan.nodeParams["ch1"] = { insertFx: opt.value };
      // Encoded value: none -> the uint32 sentinel, effects -> their enum value.
      expect(cmd(plan, "INSERT_FX", 0)!.vdValue).toBe(denormalizeInsertFx(opt.value));
      const back = await roundTrip(plan);
      expect(back.nodeParams["ch1"]?.insertFx).toBe(opt.value);
    });
  }

  for (const opt of OUTPUT_INSERT_FX_OPTIONS) {
    it(`output "${opt.label}" (${opt.value})`, async () => {
      const plan = base();
      plan.nodeParams["bus.stereo"] = { insertFx: opt.value };
      expect(cmd(plan, "INSERT_FX", 0)!.vdValue).toBe(denormalizeInsertFx(opt.value));
      const back = await roundTrip(plan);
      expect(back.nodeParams["bus.stereo"]?.insertFx).toBe(opt.value);
    });
  }
});

describe("insert-FX ON/OFF (bypass) round-trips", () => {
  it("input bypass (both states) — written after the selector", async () => {
    const plan = base();
    plan.nodeParams["ch1"] = { insertFx: 1794, insertFxOn: false };
    expect(cmd(plan, "INSERT_FX_ON", 0)!.vdValue).toBe(0);
    expect((await roundTrip(plan)).nodeParams["ch1"]?.insertFxOn).toBe(false);
    plan.nodeParams["ch1"] = { insertFx: 1794, insertFxOn: true };
    expect(cmd(plan, "INSERT_FX_ON", 0)!.vdValue).toBe(1);
    expect((await roundTrip(plan)).nodeParams["ch1"]?.insertFxOn).toBe(true);
  });

  it("MIX bypass writes both L/R-linked instances", async () => {
    const plan = base();
    plan.nodeParams["bus.mix1"] = { insertFx: 1792, insertFxOn: true };
    expect(cmd(plan, "INSERT_FX_ON", 0)!.vdValue).toBe(1);
    expect(cmd(plan, "INSERT_FX_ON", 1)!.vdValue).toBe(1);
    expect((await roundTrip(plan)).nodeParams["bus.mix1"]?.insertFxOn).toBe(true);
  });

  it("not written under No Effect (the device ignores the switch then)", () => {
    const plan = base();
    plan.nodeParams["ch1"] = { insertFx: INSERT_FX_NONE, insertFxOn: false };
    expect(cmd(plan, "INSERT_FX_ON", 0)).toBeUndefined();
  });
});

describe("new CH SETTING / MIX params round-trip", () => {
  it("MIX → STEREO TO ST on/off", async () => {
    for (const on of [true, false]) {
      const plan = base();
      plan.connections.find((c) => c.from === "bus.mix1:out" && c.to === "bus.stereo:in")!.params = { on };
      const back = await roundTrip(plan);
      const conn = back.connections.find((c) => c.from === "bus.mix1:out" && c.to === "bus.stereo:in");
      expect(conn?.params?.on).toBe(on);
    }
  });

  it("MIX Pan Link on/off", async () => {
    for (const panLink of [true, false]) {
      const plan = base();
      plan.nodeParams["bus.mix1"] = { panLink };
      const back = await roundTrip(plan);
      expect(back.nodeParams["bus.mix1"]?.panLink).toBe(panLink);
    }
  });

  it("STEREO / MIX master balance round-trips", async () => {
    for (const [id, pan] of [
      ["bus.stereo", -20],
      ["bus.mix1", 30],
      ["bus.mix2", -63],
    ] as const) {
      const plan = base();
      plan.nodeParams[id] = { ...plan.nodeParams[id], pan };
      const back = await roundTrip(plan);
      expect(back.nodeParams[id]?.pan).toBe(pan);
    }
  });

  it("Signal Type stereo link and PAN/BAL mode", async () => {
    for (const [stereoLink, panBal] of [
      [true, 1],
      [false, 0],
    ] as const) {
      const plan = base();
      plan.nodeParams["ch1"] = { stereoLink, panBal };
      const back = await roundTrip(plan);
      expect(back.nodeParams["ch1"]?.stereoLink).toBe(stereoLink);
      expect(back.nodeParams["ch1"]?.panBal).toBe(panBal);
    }
  });

  it("SSMCS Sweet Spot Data preset index", async () => {
    for (const idx of [1, 2, 34]) {
      const plan = base();
      plan.nodeParams["ch1"] = { compEqType: 1, ssmcs: { sweetSpotData: idx } };
      const back = await roundTrip(plan);
      expect(back.nodeParams["ch1"]?.ssmcs?.sweetSpotData).toBe(idx);
    }
  });
});

describe("enum options round-trip", () => {
  it("COMP/EQ type — both modes", async () => {
    for (const type of [0, 1]) {
      const plan = base();
      plan.nodeParams["ch1"] = { compEqType: type };
      const back = await roundTrip(plan);
      expect(back.nodeParams["ch1"]?.compEqType).toBe(type);
    }
  });

  it("oscillator mode — Sine / Pink / Burst", async () => {
    for (const mode of [0, 1, 2]) {
      const plan = base();
      plan.nodeParams["bus.osc"] = { osc: { mode } };
      const back = await roundTrip(plan);
      expect(back.nodeParams["bus.osc"]?.osc?.mode).toBe(mode);
    }
  });

  it("EQ 1-knob type — mono (Intensity/Vocal) and output (Intensity/Loudness) round-trip", async () => {
    for (const [id, type] of [
      ["ch1", 0],
      ["ch1", 1],
      ["bus.stereo", 0],
      ["bus.stereo", 2],
    ] as const) {
      const plan = base();
      plan.nodeParams[id] = { eqOneKnob: { on: true, type, level: 80 } };
      const back = await roundTrip(plan);
      expect(back.nodeParams[id]?.eqOneKnob?.type).toBe(type);
      expect(back.nodeParams[id]?.eqOneKnob?.level).toBe(80);
      expect(back.nodeParams[id]?.eqOneKnob?.on).toBe(true);
    }
  });

  it("STREAMING DELAY frame rate — every option round-trips", async () => {
    for (const opt of DELAY_FRAME_RATE_OPTIONS) {
      const plan = base();
      plan.nodeParams["bus.stream"] = { delay: { frameRate: opt.value } };
      const back = await roundTrip(plan);
      expect(back.nodeParams["bus.stream"]?.delay?.frameRate).toBe(opt.value);
    }
  });
});

describe("STREAMING DELAY time round-trips at its extremes", () => {
  for (const ms of [DELAY_TIME_MIN_MS, 100, DELAY_TIME_MAX_MS]) {
    it(`${ms} ms`, async () => {
      const plan = base();
      plan.nodeParams["bus.stream"] = { delay: { on: true, time: ms } };
      const back = await roundTrip(plan);
      expect(back.nodeParams["bus.stream"]?.delay?.time).toBe(ms);
      expect(back.nodeParams["bus.stream"]?.delay?.on).toBe(true);
    });
  }
});

describe("PHONES level round-trips at its extremes (PHONES 1 / 2)", () => {
  for (const [id, level] of [
    ["bus.mon1", PHONES_LEVEL_MIN],
    ["bus.mon2", PHONES_LEVEL_MAX],
  ] as const) {
    it(`${id} = ${level}`, async () => {
      const plan = base();
      plan.nodeParams[id] = { phonesLevel: level };
      const back = await roundTrip(plan);
      expect(back.nodeParams[id]?.phonesLevel).toBe(level);
    });
  }
});

describe("continuous extremes round-trip through the device path", () => {
  it("channel fader floor (-inf) and ceiling", async () => {
    for (const [db, vd] of [
      [LEVEL_OFF_DB, VD_LEVEL_OFF],
      [LEVEL_MAX_DB, VD_LEVEL_MAX],
    ] as const) {
      const plan = base();
      const conn = plan.connections.find((c) => c.from === ref("ch1", "out") && c.to === ref("bus.stereo", "in"));
      conn!.params = { level: db };
      expect(cmd(plan, "CH_FADER", 0)!.vdValue).toBe(vd);
      const back = await roundTrip(plan);
      const rt = back.connections.find((c) => c.from === ref("ch1", "out") && c.to === ref("bus.stereo", "in"));
      expect(rt!.params?.level).toBe(db);
    }
  });

  it("channel pan hard left and hard right", async () => {
    for (const [pan, vd] of [
      [-VD_PAN_MAX, -VD_PAN_MAX], // L63
      [VD_PAN_MAX, VD_PAN_MAX], // R63
    ] as const) {
      const plan = base();
      const conn = plan.connections.find((c) => c.from === ref("ch1", "out") && c.to === ref("bus.stereo", "in"));
      conn!.params = { pan };
      expect(cmd(plan, "CH_PAN", 0)!.vdValue).toBe(vd);
      const back = await roundTrip(plan);
      const rt = back.connections.find((c) => c.from === ref("ch1", "out") && c.to === ref("bus.stereo", "in"));
      expect(rt!.params?.pan).toBe(pan);
    }
  });
});

// Addresses confirmed by live snapshot-diff on URX44V (Rec Point 137, BUS Type
// 587, OSC Burst width 714 / interval 715).
describe("Rec Point / BUS Type / OSC Burst round-trip", () => {
  it("Rec Point — every MONO IN option encodes raw and round-trips (param 137)", async () => {
    for (const opt of REC_POINT_OPTIONS) {
      const plan = base();
      plan.nodeParams["ch1"] = { recPoint: opt.value };
      expect(cmd(plan, "REC_POINT", 0)!.vdValue).toBe(opt.value);
      const back = await roundTrip(plan);
      expect(back.nodeParams["ch1"]?.recPoint).toBe(opt.value);
    }
  });

  it("BUS Type — VARI / FIXED write both MIX L/R instances and round-trip (param 587)", async () => {
    for (const opt of BUS_TYPE_OPTIONS) {
      const plan = base();
      plan.nodeParams["bus.mix1"] = { busType: opt.value };
      const cmds = planToCommands(model, plan).filter((c) => c.name === "BUS_TYPE");
      expect(cmds.map((c) => c.y).sort()).toEqual([0, 1]);
      expect(cmds.every((c) => c.vdValue === opt.value)).toBe(true);
      const back = await roundTrip(plan);
      expect(back.nodeParams["bus.mix1"]?.busType).toBe(opt.value);
    }
  });

  it("OSC Burst width (seconds → raw ms ×1000) and interval (raw) round-trip", async () => {
    for (const [width, interval, wRaw] of [
      [0.1, 1, 100],
      [0.2, 2, 200],
      [10, 30, 10000],
    ] as const) {
      const plan = base();
      plan.nodeParams["bus.osc"] = { osc: { mode: 2, width, interval } };
      expect(cmd(plan, "OSC_BURST_WIDTH", 0)!.vdValue).toBe(wRaw);
      expect(cmd(plan, "OSC_BURST_INTERVAL", 0)!.vdValue).toBe(interval);
      const back = await roundTrip(plan);
      expect(back.nodeParams["bus.osc"]?.osc?.width).toBeCloseTo(width, 5);
      expect(back.nodeParams["bus.osc"]?.osc?.interval).toBe(interval);
    }
  });
});

// microSD Rec per-track source assign (param 736, confirmed on URX44V): each
// source writes its L/R port ref to the track pair's two tracks, and Track Count
// (839) is read-only — read back (raw × 2) but never emitted.
describe("microSD Rec source assign round-trips (param 736)", () => {
  // source node id → the L/R port refs written to track-pair slot t1 (tracks 0/1)
  const cases: [string, number, number][] = [
    ["ch1", 0, 1], // CH1/2 pair (mono primary + partner)
    ["ch3", 2, 3], // CH3/4 pair
    ["ch_5_6", 4, 5], // stereo channel (its two input slots)
    ["bus.stereo", 256, 257],
    ["bus.mix1", 288, 289],
    ["bus.mix2", 290, 291],
  ];
  for (const [src, l, r] of cases) {
    it(`${src} → slot t1 writes ${l}/${r} and round-trips`, async () => {
      const plan = base();
      plan.connections.push({ from: ref(src, "out"), to: ref("out.sdrec.t1", "in"), kind: "record" });
      const cmds = planToCommands(model, plan).filter((c) => c.name === "SD_REC_SOURCE" && c.y <= 1);
      expect(cmds.find((c) => c.y === 0)!.vdValue).toBe(l);
      expect(cmds.find((c) => c.y === 1)!.vdValue).toBe(r);
      const back = await roundTrip(plan);
      const conn = back.connections.find((c) => c.to === ref("out.sdrec.t1", "in") && c.kind === "record");
      expect(conn?.from).toBe(ref(src, "out"));
    });
  }

  it("an unassigned track pair writes NONE to both tracks and reads back unwired", async () => {
    const plan = base(); // no record wire on slot t2 (tracks 2/3)
    const cmds = planToCommands(model, plan).filter((c) => c.name === "SD_REC_SOURCE" && (c.y === 2 || c.y === 3));
    expect(cmds.length).toBe(2);
    expect(cmds.every((c) => c.vdValue === PORT_REF_NONE)).toBe(true);
    const back = await roundTrip(plan);
    expect(back.connections.some((c) => c.to === ref("out.sdrec.t2", "in"))).toBe(false);
  });

  it("Track Count is read-only: never emitted, read back as raw × 2", async () => {
    const plan = base();
    plan.nodeParams["out.sdrec"] = { sdRecTrackCount: 16 };
    expect(planToCommands(model, plan).some((c) => c.name === "SD_REC_TRACK_COUNT")).toBe(false);
    // The echo table returns 0 for unmocked params, so readback decodes 0 × 2 = 0.
    const back = await roundTrip(plan);
    expect(back.nodeParams["out.sdrec"]?.sdRecTrackCount).toBe(0);
  });
});
