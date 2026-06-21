// Value-pattern coverage: the round-trip tests confirm every param id is wired,
// but each param at only a point or two. This file sweeps the VALUE domain that
// matters — every enum OPTION and the continuous EXTREMES — through the real
// emit -> device -> readback path (device echoed by a faithful table), so each
// selectable value is verified end to end, not just its codec in isolation.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../../models";
import { emptyPlan, ensureFixedConnections, LEVEL_MAX_DB, LEVEL_OFF_DB, type Plan } from "../plan";
import { ref } from "../../models/types";

vi.mock("../platform", () => ({ vdGet: vi.fn() }));

import { vdGet } from "../platform";
import { applyDeviceState } from "./readback";
import { planToCommands } from "./translate";
import type { VdCommand } from "./translate";
import {
  BUS_TYPE_OPTIONS,
  denormalizeInsertFx,
  DELAY_FRAME_RATE_OPTIONS,
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
  const out = emptyPlan("URX44V");
  return applyDeviceState(model, out).then(() => out);
}

function cmd(plan: Plan, name: string, y: number): VdCommand | undefined {
  return planToCommands(model, plan).find((c) => c.name === name && c.y === y);
}

beforeEach(() => vi.mocked(vdGet).mockReset());

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
    for (const [id, type] of [["ch1", 0], ["ch1", 1], ["bus.stereo", 0], ["bus.stereo", 2]] as const) {
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
  for (const [id, level] of [["bus.mon1", PHONES_LEVEL_MIN], ["bus.mon2", PHONES_LEVEL_MAX]] as const) {
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
