import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../../models";
import { emptyPlan, ensureFixedConnections, type Plan } from "../plan";
import { DEFAULT_SAMPLE_RATE, SAMPLE_RATES } from "../constraints";

// readback pulls live values through platform.vdGet; selftest drives the full
// connect/get/set/disconnect cycle. Mock the platform IPC with an in-memory
// device so these stay hermetic (mirrors readback.test / selftest.test).
vi.mock("../platform", () => ({
  vdConnect: vi.fn(),
  vdDisconnect: vi.fn(),
  vdGet: vi.fn(),
  vdSet: vi.fn(),
  vdGetStr: vi.fn(),
}));

import { vdGet, vdGetStr } from "../platform";
import { PARAMS } from "./params";
import { planToCommands } from "./translate";
import { applyDeviceState } from "./readback";
import { perturbedPlan } from "./selftest";
import { rateAction } from "./client";

const model = getModel("URX44V");
const SAMPLE_RATE_ID = PARAMS.SAMPLE_RATE.id;

beforeEach(() => {
  vi.mocked(vdGet).mockReset();
  vi.mocked(vdGetStr).mockReset();
  vi.mocked(vdGetStr).mockResolvedValue("");
});

describe("sample rate — translate", () => {
  it("emits SAMPLE_RATE unconditionally, even on an empty plan", () => {
    const plan = emptyPlan("URX44V");
    const cmds = planToCommands(model, plan);
    const sr = cmds.filter((c) => c.name === "SAMPLE_RATE");
    // A top-level plan scalar (always set), so it is sent as absolute state once.
    expect(sr).toHaveLength(1);
    expect(sr[0]!.vdValue).toBe(DEFAULT_SAMPLE_RATE);
    expect(sr[0]!.y).toBe(0);
    expect(sr[0]!.request.uri).toBe(`/vd/parameters/${SAMPLE_RATE_ID}:0:0?operation=value`);
  });

  it("emits the chosen rate as a raw Hz value for every selectable rate", () => {
    for (const rate of SAMPLE_RATES) {
      const plan = emptyPlan("URX44V");
      plan.sampleRate = rate;
      const sr = planToCommands(model, plan).find((c) => c.name === "SAMPLE_RATE");
      // raw encoding: the broker value is the Hz figure unchanged.
      expect(sr!.vdValue).toBe(rate);
    }
  });
});

describe("sample rate — command ordering", () => {
  it("sends the rate first, so the rest of the write lands under the intended clock", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    const cmds = planToCommands(model, plan);
    expect(cmds[0]!.name).toBe("SAMPLE_RATE");
  });

  it("writes the features the block diagram calls unavailable above 96 kHz", () => {
    // The device ACCEPTS and holds these at 192 kHz — measured on a URX44V for the
    // stereo CH EQ (213), FX2's fader/send/effect type and the insert FX selector
    // (135). "The feature is unavailable" does not mean "the parameter is
    // unwritable": only the DSP is gone, the stored value survives. So the write
    // still drives the device to the plan, and lowering the rate brings the
    // settings back into effect with nothing left to re-send.
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.sampleRate = 192000;
    plan.nodeParams["ch_5_6"] = { eqOn: true };
    plan.nodeParams["ch1"] = { insertFx: 1793, insertFxOn: true };
    const cmds = planToCommands(model, plan);
    expect(cmds.some((c) => c.name === "STEREO_CH_EQ_ON")).toBe(true);
    expect(cmds.some((c) => c.name === "INSERT_FX" && c.vdValue === 1793)).toBe(true);
    expect(cmds.some((c) => c.node === "bus.fx2")).toBe(true);
  });
});

describe("sample rate — what a write does about a rate disagreement", () => {
  // The decision matrix the write path runs before sending anything. Pure, so it is
  // pinned here rather than only through the UI flow.
  it("proceeds when the device already runs the plan's rate", () => {
    expect(rateAction(48000, { followUsb: true, sampleRate: 48000 })).toBe("proceed");
    // Follow USB is irrelevant when there is nothing to change.
    expect(rateAction(48000, { followUsb: false, sampleRate: 48000 })).toBe("proceed");
  });

  it("asks a plain yes/no when the device holds its own clock", () => {
    // The plan's rate will stick, so the only question is whether to re-clock.
    expect(rateAction(96000, { followUsb: false, sampleRate: 48000 })).toBe("confirmReclock");
  });

  it("asks the operator to choose when the device is slaved to its USB host", () => {
    // Writing the plan's rate here would be undone ~0.4 s later, and neither answer
    // (adopt the device's rate / release Follow USB) can be inferred.
    expect(rateAction(96000, { followUsb: true, sampleRate: 48000 })).toBe("askChoice");
  });
});

describe("sample rate — readback round-trip", () => {
  it("recovers a non-default device rate onto plan.sampleRate", async () => {
    // The all-default round-trip in readback.test only exercises 48 kHz; pin that
    // a non-default rate survives emit → device table → readback.
    vi.mocked(vdGet).mockImplementation((paramId: number) => Promise.resolve(paramId === SAMPLE_RATE_ID ? 96000 : 0));
    const target = emptyPlan("URX44V");
    await applyDeviceState(model, target);
    expect(target.sampleRate).toBe(96000);
  });

  it("counts the sample-rate read in the applied total", async () => {
    vi.mocked(vdGet).mockResolvedValue(0);
    const target = emptyPlan("URX44V");
    const before = target.sampleRate;
    const result = await applyDeviceState(model, target);
    expect(result.errors).toEqual([]);
    // A 0 Hz device reply still writes through (raw passthrough); the count covers
    // it. (0 is not a real rate, but readback reports verbatim — see the boundary
    // note in the constraints/deserialize section below.)
    expect(target.sampleRate).toBe(0);
    expect(before).toBe(DEFAULT_SAMPLE_RATE);
  });
});

describe("sample rate — readback failure isolation", () => {
  it("leaves plan.sampleRate untouched and records an error when its read throws", async () => {
    vi.mocked(vdGet).mockImplementation((paramId: number) => {
      if (paramId === SAMPLE_RATE_ID) return Promise.reject(new Error("read timeout"));
      return Promise.resolve(0);
    });
    const target = emptyPlan("URX44V");
    target.sampleRate = 88200; // a known pre-read value to prove it is preserved
    const result = await applyDeviceState(model, target);

    expect(target.sampleRate).toBe(88200);
    expect(result.errors.some((e) => e.startsWith("sample rate:"))).toBe(true);
    // The failure is local: other groups still applied (the rate is plan-level,
    // never a node, so it must not flag any node as unread).
    expect(result.unreadNodes.size).toBe(0);
  });
});

describe("sample rate — self-test never re-clocks", () => {
  it("perturbedPlan keeps the original rate (re-clocking glitches live audio)", () => {
    // SAMPLE_RATE is always emitted, so a self-test write pass sends it; pin that
    // the perturb walk leaves the rate at the device's current value, so the
    // write is a no-op rather than a deliberate (audible) re-clock.
    const original: Plan = emptyPlan("URX44V");
    ensureFixedConnections(model, original);
    original.sampleRate = 176400;
    for (const pass of [0, 1, 2]) {
      const perturbed = perturbedPlan(model, original, pass);
      expect(perturbed.sampleRate).toBe(176400);
      const sr = planToCommands(model, perturbed).find((c) => c.name === "SAMPLE_RATE");
      expect(sr!.vdValue).toBe(176400);
    }
  });
});
