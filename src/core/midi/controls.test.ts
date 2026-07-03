import { describe, it, expect, beforeEach } from "vitest";
import { getModel } from "../../models";
import { defaultPlan } from "../../models/initial-state";
import type { Plan } from "../plan";
import { ensureFixedConnections, LEVEL_OFF_DB } from "../plan";
import { ref } from "../../models/types";
import { bindControl, controlId, listControls, parseControlId } from "./controls";

const model = getModel("URX44V");
let plan: Plan;

beforeEach(() => {
  // Mirror the app: every plan on screen has its fixed wires ensured (main.ts).
  plan = defaultPlan("URX44V");
  ensureFixedConnections(model, plan);
});

const conn = (from: string, to: string) => plan.connections.find((c) => c.from === ref(from, "out") && c.to === ref(to, "in"))!;

describe("control ids", () => {
  it("round-trip through the id syntax, including send scopes", () => {
    expect(parseControlId(controlId("ch1", "level"))).toEqual({ node: "ch1", param: "level" });
    expect(parseControlId(controlId("bus.fx1", "level", "bus.mix1"))).toEqual({ node: "bus.fx1", param: "level", send: "bus.mix1" });
    expect(parseControlId("nonsense")).toBeNull();
    expect(parseControlId("a/b@c@d")).toBeNull();
  });
});

describe("control catalog", () => {
  it("lists the console controls under fixed ids", () => {
    const ids = new Set(listControls(model, plan).map((c) => c.id));
    // channel strip: main fader / MUTE / PAN, HA + processing toggles, sends
    for (const id of [
      "ch1/level",
      "ch1/mute",
      "ch1/pan",
      "ch1/gain",
      "ch1/phantom",
      "ch1/phase",
      "ch1/hpf",
      "ch1/gateOn",
      "ch1/compOn",
      "ch1/eqOn",
      "ch1/level@bus.mix1",
      "ch1/mute@bus.mix1",
      "ch1/pan@bus.mix1",
      "ch1/level@bus.fx1",
      "ch1/mute@bus.fx1",
    ])
      expect(ids, id).toContain(id);
    // FX-channel strip: main path + MIX sends only (no FX → FX)
    expect(ids).toContain("bus.fx1/level");
    expect(ids).toContain("bus.fx1/level@bus.mix1");
    expect(ids).not.toContain("bus.fx1/level@bus.fx2");
    // FX sends are mono on the device: no send pan
    expect(ids).not.toContain("ch1/pan@bus.fx1");
    // buses / monitors / OSC / master / ducker
    for (const id of [
      "bus.mix1/level",
      "bus.mix1/mute",
      "bus.mix1/pan",
      "bus.mix1/eqOn",
      "bus.stereo/level",
      "bus.stereo/mute",
      "bus.stereo/pan",
      "bus.mon1/level",
      "bus.mon1/mute",
      "bus.mon1/phonesLevel",
      "bus.mon1/cueInterrupt",
      "bus.mon1/mono",
      "bus.osc/level",
      "bus.osc/oscOn",
    ])
      expect(ids, id).toContain(id);
    expect([...ids].some((i) => i.endsWith("/duckerOn"))).toBe(true);
    // STREAMING is meter-only; Hi-Z exists on CH3/CH4 only
    expect([...ids].some((i) => i.startsWith("bus.stream/"))).toBe(false);
    expect(ids).not.toContain("ch1/hiZ");
    expect(ids).toContain("ch3/hiZ");
  });

  it("binds only ids that exist for the model", () => {
    expect(bindControl(model, plan, "ch1/level")).not.toBeNull();
    expect(bindControl(model, plan, "ch99/level")).toBeNull();
    expect(bindControl(model, plan, "ch1/bogus")).toBeNull();
    expect(bindControl(model, plan, "ch1/level@bus.mix9")).toBeNull();
  });
});

describe("normalized value access", () => {
  it("snaps a fader level to the level_gain grid and reads it back", () => {
    const c = bindControl(model, plan, "ch1/level")!;
    expect(c.set(1)).toBe(true);
    expect(conn("ch1", "bus.stereo").params?.level).toBe(10);
    expect(c.get()).toBe(1);
    c.set(0);
    expect(conn("ch1", "bus.stereo").params?.level).toBe(LEVEL_OFF_DB);
    expect(c.get()).toBe(0);
    c.set(0.5);
    const mid = conn("ch1", "bus.stereo").params?.level;
    expect(mid).toBeGreaterThan(LEVEL_OFF_DB);
    expect(mid).toBeLessThan(10);
  });

  it("drives the MUTE semantics of each strip kind", () => {
    // channel MUTE = the → STEREO assign ON (ships on)
    const chMute = bindControl(model, plan, "ch1/mute")!;
    expect(chMute.get()).toBe(0);
    chMute.set(1);
    expect(conn("ch1", "bus.stereo").params?.on).toBe(false);
    expect(chMute.get()).toBe(1);
    // MIX MUTE = the MIX → STEREO "TO ST" send (ships off = muted)
    const mixMute = bindControl(model, plan, "bus.mix1/mute")!;
    expect(mixMute.get()).toBe(1);
    mixMute.set(0);
    expect(conn("bus.mix1", "bus.stereo").params?.on).toBe(true);
    // master MUTE = the node's own ON flag
    const master = bindControl(model, plan, "bus.stereo/mute")!;
    master.set(1);
    expect(plan.nodeParams["bus.stereo"]?.on).toBe(false);
    master.set(0);
    expect(plan.nodeParams["bus.stereo"]?.on).toBe(true);
  });

  it("maps gain over the channel's own dB range in 1 dB steps", () => {
    const c = bindControl(model, plan, "ch1/gain")!; // A.GAIN -8 … +70
    c.set(0);
    expect(plan.nodeParams.ch1?.gain).toBe(-8);
    c.set(1);
    expect(plan.nodeParams.ch1?.gain).toBe(70);
    c.set(0.5);
    expect(plan.nodeParams.ch1?.gain).toBe(31);
    expect(c.step).toBeCloseTo(1 / 78);
  });

  it("maps pan L63 … R63 and phones 0.0 … 10.0 without float dust", () => {
    const pan = bindControl(model, plan, "ch1/pan")!;
    pan.set(0);
    expect(conn("ch1", "bus.stereo").params?.pan).toBe(-63);
    pan.set(1);
    expect(conn("ch1", "bus.stereo").params?.pan).toBe(63);
    pan.set(0.5);
    expect(conn("ch1", "bus.stereo").params?.pan).toBe(0);
    const ph = bindControl(model, plan, "bus.mon1/phonesLevel")!;
    ph.set(0.29);
    expect(plan.nodeParams["bus.mon1"]?.phonesLevel).toBe(2.9);
  });

  it("locks device-locked controls instead of writing", () => {
    // FIXED BUS Type: the send level is inert
    plan.nodeParams["bus.mix1"] = { ...plan.nodeParams["bus.mix1"], busType: 1 };
    const level = bindControl(model, plan, "ch1/level@bus.mix1")!;
    const before = conn("ch1", "bus.mix1").params?.level;
    expect(level.set(1)).toBe(false);
    expect(conn("ch1", "bus.mix1").params?.level).toBe(before);
    // Pan Link (VARI): the send pan is inert
    plan.nodeParams["bus.mix2"] = { ...plan.nodeParams["bus.mix2"], panLink: true };
    const pan = bindControl(model, plan, "ch1/pan@bus.mix2")!;
    expect(pan.set(1)).toBe(false);
    // Stereo-channel EQ is forced off at 192 kHz: reads 0 and refuses the write,
    // leaving whatever the plan already held (the factory seed) untouched.
    plan.sampleRate = 192000;
    const seeded = plan.nodeParams.ch_5_6?.eqOn;
    const eq = bindControl(model, plan, "ch_5_6/eqOn")!;
    expect(eq.get()).toBe(0);
    expect(eq.set(1)).toBe(false);
    expect(plan.nodeParams.ch_5_6?.eqOn).toBe(seeded);
  });

  it("drives the OSC level / ON through the osc params object", () => {
    const level = bindControl(model, plan, "bus.osc/level")!;
    level.set(1);
    expect(plan.nodeParams["bus.osc"]?.osc?.level).toBe(0);
    level.set(0);
    expect(plan.nodeParams["bus.osc"]?.osc?.level).toBe(-96);
    const on = bindControl(model, plan, "bus.osc/oscOn")!;
    expect(on.get()).toBe(0);
    on.set(1);
    expect(plan.nodeParams["bus.osc"]?.osc?.on).toBe(true);
    expect(on.get()).toBe(1);
  });
});
