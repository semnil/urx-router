// Device-follow apply paths: the owner-node stamping planToCommands adds to each
// VdCommand, the no-read-back applyDirect for node-local scalars, and the scoped
// applyNodeState that re-reads only the named nodes. Together these let follow
// reflect a device-side change without a full readback (see follow.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../../models";
import { emptyPlan, ensureFixedConnections, type Plan } from "../plan";
import { ref } from "../../models/types";

vi.mock("../platform", () => ({ vdGet: vi.fn(), vdGetStr: vi.fn() }));

import { vdGet, vdGetStr } from "../platform";
import { applyDeviceState, applyDirect, applyNodeState } from "./readback";
import { planToCommands } from "./translate";
import { PORT_REF_PARAM_IDS as PORT_REF_PARAMS } from "./params";
import { PORT_REF_NONE, vdToLevel } from "./vd";

const model = getModel("URX44V");

function base(): Plan {
  const plan = emptyPlan("URX44V");
  ensureFixedConnections(model, plan);
  return plan;
}

function mainSend(plan: Plan, node: string) {
  return plan.connections.find((c) => c.from === ref(node, "out") && c.to === ref("bus.stereo", "in"));
}

// Echo a plan's emitted commands back as the device state for vdGet, so a readback
// reads exactly what the source plan implies.
function deviceFrom(plan: Plan): void {
  const table = new Map<string, number>();
  for (const c of planToCommands(model, plan)) table.set(`${c.paramId}:${c.x}:${c.y}`, c.vdValue);
  vi.mocked(vdGet).mockImplementation((id, x, y) => {
    const k = `${id}:${x}:${y}`;
    return Promise.resolve(table.has(k) ? table.get(k)! : PORT_REF_PARAMS.has(id) ? PORT_REF_NONE : 0);
  });
  vi.mocked(vdGetStr).mockResolvedValue("");
}

beforeEach(() => {
  vi.mocked(vdGet).mockReset();
  vi.mocked(vdGetStr).mockReset();
});

describe("planToCommands owner-node stamping", () => {
  it("stamps each command with its owner node id", () => {
    const src = base();
    // Bus faders / master ON are emitted only when the plan carries the value.
    src.nodeParams["bus.stereo"] = { ...src.nodeParams["bus.stereo"], level: -3 };
    src.nodeParams["bus.mix1"] = { ...src.nodeParams["bus.mix1"], on: false };
    const cmds = planToCommands(model, src);
    const fader = cmds.find((c) => c.name === "CH_FADER" && c.y === 0);
    expect(fader?.node).toBe("ch1");
    const master = cmds.find((c) => c.name === "STEREO_MASTER_FADER");
    expect(master?.node).toBe("bus.stereo");
    const mixOn = cmds.find((c) => c.name === "OUT_MASTER_ON");
    expect(mixOn?.node).toBe("bus.mix1");
  });

  it("leaves a global address (sample rate) unstamped", () => {
    const sr = planToCommands(model, base()).find((c) => c.name === "SAMPLE_RATE");
    expect(sr?.node).toBeUndefined();
  });

  it("stamps stereo-channel fader (param 266) with its channel node", () => {
    const fader = planToCommands(model, base()).find((c) => c.name === "CH_FADER" && c.node === "ch_5_6");
    expect(fader).toBeDefined();
    expect(fader?.paramId).toBe(266);
  });
});

describe("applyDirect", () => {
  it("places a fader value the same as a full readback would, with no read", () => {
    const src = base();
    const conn = mainSend(src, "ch1")!;
    conn.params = { ...conn.params, level: -12 };
    const cmd = planToCommands(model, src).find((c) => c.name === "CH_FADER" && c.node === "ch1")!;

    const dst = base();
    const ok = applyDirect(dst, "ch1", "CH_FADER", cmd.vdValue);
    expect(ok).toBe(true);
    expect(mainSend(dst, "ch1")?.params?.level).toBe(vdToLevel(cmd.vdValue));
    expect(vdGet).not.toHaveBeenCalled();
  });

  it("writes a node-local on flag and returns true", () => {
    const dst = base();
    expect(applyDirect(dst, "ch1", "CH_ON", 0)).toBe(true);
    expect(dst.nodeParams["ch1"]?.on).toBe(false);
  });

  it("returns false for a non-direct param so the caller falls back to a read", () => {
    const dst = base();
    expect(applyDirect(dst, "bus.stereo", "EQ_BAND_GAIN", 0)).toBe(false);
  });
});

describe("applyNodeState scoping", () => {
  it("re-reads only the named nodes, leaving the rest at the plan value", async () => {
    // Device truth: ch1 fader at -18 dB, ch2 fader at -24 dB. The plan starts at 0.
    const truth = base();
    mainSend(truth, "ch1")!.params = { ...mainSend(truth, "ch1")!.params, level: -18 };
    mainSend(truth, "ch2")!.params = { ...mainSend(truth, "ch2")!.params, level: -24 };
    deviceFrom(truth);

    const plan = base();
    await applyNodeState(model, plan, new Set(["ch1"]));

    // ch1 pulled to the device value; ch2 untouched (not in the scope).
    const c1 = planToCommands(model, truth).find((c) => c.name === "CH_FADER" && c.node === "ch1")!;
    expect(mainSend(plan, "ch1")?.params?.level).toBe(vdToLevel(c1.vdValue));
    expect(mainSend(plan, "ch2")?.params?.level ?? 0).toBe(0);
  });

  it("reads fewer addresses than a full readback", async () => {
    deviceFrom(base());
    await applyNodeState(model, base(), new Set(["ch1"]));
    const scopedReads = vi.mocked(vdGet).mock.calls.length;

    vi.mocked(vdGet).mockClear();
    deviceFrom(base());
    await applyDeviceState(model, base());
    const fullReads = vi.mocked(vdGet).mock.calls.length;

    expect(scopedReads).toBeGreaterThan(0);
    expect(scopedReads).toBeLessThan(fullReads);
  });
});

// The unit turns Pan Link off without a notify when BUS Type goes to FIXED on its own
// screen, and leaves every send pan into the MIX at its source's pan. Device follow sees
// the BUS Type notify and re-reads the MIX alone, which reads the switch off and no send.
describe("a read that finds Pan Link off where the plan held it on", () => {
  const send = (plan: Plan, from: string) =>
    plan.connections.find((c) => c.from === ref(from, "out") && c.to === ref("bus.mix1", "in"))!;
  const planWith = (panLink: boolean, sendPan: number): Plan => {
    const p = base();
    p.nodeParams["bus.mix1"] = { ...p.nodeParams["bus.mix1"], panLink };
    mainSend(p, "ch1")!.params = { ...mainSend(p, "ch1")!.params, pan: 30 };
    send(p, "ch1").params = { ...send(p, "ch1").params, pan: sendPan };
    return p;
  };

  it("gives the sends a scoped read of the MIX did not read their sources' pans", async () => {
    deviceFrom(planWith(false, 30));
    const plan = planWith(true, -43);
    await applyNodeState(model, plan, new Set(["bus.mix1"]));
    expect(plan.nodeParams["bus.mix1"]?.panLink).toBe(false);
    expect(send(plan, "ch1").params?.pan).toBe(30);
  });

  // The other edge: a read that finds the link on where the plan held it off. The unit set the
  // send pans to their sources' pans when it turned on, so the sends this pass did not read
  // take that value.
  it("gives the sends a scoped read of the MIX did not read their sources' pans when it finds the link on", async () => {
    deviceFrom(planWith(true, 30));
    const plan = planWith(false, -43);
    await applyNodeState(model, plan, new Set(["bus.mix1"]));
    expect(plan.nodeParams["bus.mix1"]?.panLink).toBe(true);
    expect(send(plan, "ch1").params?.pan).toBe(30);
  });

  // A full read takes every send from the unit, and a send pan the unit holds apart from its
  // source — a link that went off long before this plan was read — stays what was read.
  it("keeps the send pans a full read took from the unit", async () => {
    deviceFrom(planWith(false, 50));
    const plan = planWith(true, -43);
    await applyDeviceState(model, plan);
    expect(plan.nodeParams["bus.mix1"]?.panLink).toBe(false);
    expect(send(plan, "ch1").params?.pan).toBe(50);
  });
});
