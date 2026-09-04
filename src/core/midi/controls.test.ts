import { describe, it, expect, beforeEach } from "vitest";
import { getModel } from "../../models";
import { defaultPlan } from "../../models/initial-state";
import type { Plan } from "../plan";
import { deserialize, ensureFixedConnections, LEVEL_OFF_DB, serialize } from "../plan";
import { ref } from "../../models/types";
import { COMP_EQ_SSMCS, EQ_TYPE_PASS, INSERT_FX_OPTIONS, PAN_BAL_BAL, PAN_BAL_PAN } from "../control/params";
import { planToCommands } from "../control/translate";
import {
  bindControl,
  controlId,
  listControls,
  parseControlId,
  COMP_SCOPE,
  EQ_SCOPE,
  eqBandScope,
  FX_SCOPE,
  INSFX_SCOPE,
} from "./controls";
import { MidiEngine } from "./engine";
import { mirrorBalPair, mirrorLinkedInsertFx } from "../routing";
import { planProblems } from "../plan-validate";
import {
  COMPANDER_H,
  COMPANDER_S,
  GUITAR_MOD,
  MBC_BANDS,
  MBC_ONE_KNOB,
  PITCH_MIDI_ENABLE_SLOT,
  PITCH_SCALE_SLOT,
  pitchDeviceDriven,
  insertFxParamKey,
  insertFxParams,
  type InsertFxFamily,
} from "../control/insert-fx-effect";
import { wireRaw, wireSteps } from "./mapping";

const model = getModel("URX44V");
let plan: Plan;

beforeEach(() => {
  // Mirror the app: every plan on screen has its fixed wires ensured (main.ts).
  plan = defaultPlan("URX44V");
  ensureFixedConnections(model, plan);
});

const conn = (from: string, to: string) =>
  plan.connections.find((c) => c.from === ref(from, "out") && c.to === ref(to, "in"))!;

describe("control ids", () => {
  it("round-trip through the id syntax, including send and processor scopes", () => {
    expect(parseControlId(controlId("ch1", "level"))).toEqual({ node: "ch1", param: "level" });
    expect(parseControlId(controlId("bus.fx1", "level", "bus.mix1"))).toEqual({
      node: "bus.fx1",
      param: "level",
      scope: "bus.mix1",
    });
    // A band scope carries a dot, which the id grammar has to pass through — the
    // whole point of the third component is that it names a stage, not only a bus.
    expect(parseControlId(controlId("ch1", "gain", "eq.low"))).toEqual({
      node: "ch1",
      param: "gain",
      scope: "eq.low",
    });
    expect(parseControlId("nonsense")).toBeNull();
    expect(parseControlId("a/b@c@d")).toBeNull();
  });
});

describe("control catalog", () => {
  // `arm()` refuses an id the catalog cannot bind, so an id the catalog OFFERS and
  // then declines is a control that looks assignable and silently is not. Nothing
  // asserted the two halves agree — the feedback round trip below walks the same
  // list and skips what will not bind (`if (!c) continue`), which is right for what
  // it measures and blind to this. It is also half of what keeps
  // `e2e/race/t4b-midi.spec.ts`'s refusal case unreachable from the UI; the other
  // half is that the arming surfaces only ever pass ids from this list, which is a
  // property of console.ts / dyn-screen.ts and not pinned here.
  it.each(["URX22", "URX44", "URX44V"] as const)("binds every id it lists for %s", (id) => {
    const m = getModel(id);
    const p = defaultPlan(id);
    ensureFixedConnections(m, p);
    const listed = listControls(m, p).map((c) => c.id);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.filter((cid) => !bindControl(m, p, cid))).toEqual([]);
  });

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
      "bus.stereo/pan",
      "bus.mon1/level",
      "bus.mon1/phonesLevel",
      "bus.mon1/cueInterrupt",
      "bus.mon1/mono",
      "bus.osc/level",
      "bus.osc/oscOn",
      // the scribble power LED (node master ON) is a uniform "chOn" on every strip that
      // has one — including STEREO / MONITOR (which have no MUTE chip)
      "ch1/chOn",
      "bus.fx1/chOn",
      "bus.mix1/chOn",
      "bus.stereo/chOn",
      "bus.mon1/chOn",
    ])
      expect(ids, id).toContain(id);
    // STEREO / MONITOR have no → STEREO send, so no send-less "mute" (their master is chOn)
    expect(ids).not.toContain("bus.stereo/mute");
    expect(ids).not.toContain("bus.mon1/mute");
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

  it("drives the MUTE semantics of the send-bearing strips", () => {
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
  });

  it("drives the power LED (chOn) on np.on with ON polarity, uniform across strips", () => {
    // Every strip's power LED is chOn = np.on, lit = 1 = on (opposite polarity to the
    // mute controls, whose 1 = muted) — including STEREO / MONITOR, which have no MUTE.
    for (const id of ["ch1", "bus.fx1", "bus.mix1", "bus.stereo", "bus.mon1"]) {
      const chOn = bindControl(model, plan, `${id}/chOn`)!;
      expect(chOn.get(), id).toBe(1); // ships on
      chOn.set(0);
      expect(plan.nodeParams[id]?.on, id).toBe(false);
      expect(chOn.get(), id).toBe(0);
      chOn.set(1);
      expect(plan.nodeParams[id]?.on, id).toBe(true);
    }
  });

  it("maps gain over the channel's own dB range in 1 dB steps", () => {
    const c = bindControl(model, plan, "ch1/gain")!; // A.GAIN -8 … +70
    c.set(0);
    expect(plan.nodeParams.ch1?.gain).toBe(-8);
    c.set(1);
    expect(plan.nodeParams.ch1?.gain).toBe(70);
    c.set(0.5);
    expect(plan.nodeParams.ch1?.gain).toBe(31);
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

  it("locks only the FIXED-bus send level; its MUTE and PRE/POST tap stay writable", () => {
    // FIXED BUS Type freezes the send level (and Pan Link the pan), but the send's
    // ON (MUTE) and its PRE/POST tap remain editable — matching the console chip.
    plan.nodeParams["bus.mix1"] = { ...plan.nodeParams["bus.mix1"], busType: 1 };
    expect(bindControl(model, plan, "ch1/level@bus.mix1")!.set(1)).toBe(false); // level inert
    const mute = bindControl(model, plan, "ch1/mute@bus.mix1")!;
    expect(mute.set(1)).toBe(true);
    expect(conn("ch1", "bus.mix1").params?.on).toBe(false);
    const tap = bindControl(model, plan, "ch1/tap@bus.mix1")!;
    expect(tap.set(1)).toBe(true);
    expect(conn("ch1", "bus.mix1").params?.tap).toBe("pre");
  });

  it("has no writable control for the read-only CH → FX send tap", () => {
    // CH → FX taps are device-locked (broker max_value=0): the catalog omits the
    // control entirely, so a MIDI mapping can never write one.
    expect(bindControl(model, plan, "ch1/tap@bus.fx1")).toBeNull();
    expect(listControls(model, plan).some((c) => c.id === "ch1/tap@bus.fx1")).toBe(false);
  });

  it("rejects out-of-range normalized input by clamping, never writing past a grid end", () => {
    // Normalized values arrive 0..1; anything outside (or NaN) clamps rather than
    // driving the plan past the level_gain / pan grids.
    const level = bindControl(model, plan, "ch1/level")!;
    level.set(5); // above 1 → clamps to the top detent
    expect(conn("ch1", "bus.stereo").params?.level).toBe(10);
    level.set(-3); // below 0 → clamps to off
    expect(conn("ch1", "bus.stereo").params?.level).toBe(LEVEL_OFF_DB);
    level.set(NaN); // non-finite → treated as 0 → off
    expect(conn("ch1", "bus.stereo").params?.level).toBe(LEVEL_OFF_DB);
    const pan = bindControl(model, plan, "ch1/pan")!;
    pan.set(2); // above 1 → clamps to R63
    expect(conn("ch1", "bus.stereo").params?.pan).toBe(63);
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

describe("channel tuning screen parameters", () => {
  it("lists GATE / COMP / EQ under processor and band scopes", () => {
    const ids = new Set(listControls(model, plan).map((c) => c.id));
    for (const id of [
      "ch1/threshold@gate",
      "ch1/range@gate",
      "ch1/attack@gate",
      "ch1/hold@gate",
      "ch1/decay@gate",
      "ch1/threshold@comp",
      "ch1/ratio@comp",
      "ch1/gain@comp",
      "ch1/autoMakeup@comp",
      "ch1/oneKnob@comp",
      "ch1/oneKnobLevel@comp",
      "ch1/oneKnob@eq",
      "ch1/oneKnobLevel@eq",
      "ch1/bandOn@eq.low",
      "ch1/freq@eq.low",
      "ch1/q@eq.low",
      "ch1/gain@eq.high",
    ])
      expect(ids, id).toContain(id);
    // The EQ exists on the buses too; GATE / COMP are MONO IN-channel features.
    expect(ids).toContain("bus.stereo/gain@eq.low");
    expect(ids).toContain("bus.mix1/freq@eq.high");
    expect(ids).not.toContain("bus.stereo/threshold@gate");
    expect(ids).not.toContain("ch_5_6/threshold@comp");
    // The enum dropdowns (knee / filter type / 1-knob type) are deliberately absent.
    expect(ids).not.toContain("ch1/knee@comp");
    expect(ids).not.toContain("ch1/type@eq.low");
  });

  // The morphing bank's scopes, and the one row inside it that offers no control at all.
  // A shelf has no Q on the device — the screen shows that row locked and says why — so a
  // mapping onto it would drive nothing and report back the value it invented. The
  // catalog's `continue` is the only thing that keeps it out, and nothing read it.
  it("scopes the morphing strip's parameters, and offers no Q on a shelf", () => {
    const p = defaultPlan("URX44V");
    p.nodeParams.ch1 = { ...p.nodeParams.ch1, compEqType: COMP_EQ_SSMCS };
    const ids = new Set(listControls(model, p).map((c) => c.id));
    for (const id of [
      // The strip's own master carries no scope: it is the chip beside GATE / COMP / EQ
      // on the strip, not a parameter inside one of the faces.
      "ch1/ssmcsOn",
      "ch1/compDrive@ssmcs",
      "ch1/morphing@ssmcs",
      "ch1/outGain@ssmcs",
      "ch1/attack@ssmcs.comp",
      "ch1/ratio@ssmcs.comp",
      "ch1/sideChain@ssmcs.sc",
      "ch1/q@ssmcs.sc",
      "ch1/freq@ssmcs.sc",
      "ch1/bandOn@ssmcs.eq.low",
      "ch1/freq@ssmcs.eq.low",
      "ch1/gain@ssmcs.eq.high",
      "ch1/q@ssmcs.eq.mid",
    ])
      expect(ids, id).toContain(id);
    // The two shelves, and only the two: MID's Q above is the positive control, so a
    // catalog that dropped every band Q would fail rather than satisfy this.
    expect(ids).not.toContain("ch1/q@ssmcs.eq.low");
    expect(ids).not.toContain("ch1/q@ssmcs.eq.high");
    // The knee is an enum, absent for the same reason COMP's is.
    expect(ids).not.toContain("ch1/knee@ssmcs.comp");
    // And the bank is exclusive: the channel is in SSMCS, so the shipped screens' own
    // controls are not listed for it while the other bank's channels keep theirs.
    expect(ids).not.toContain("ch1/threshold@comp");
    expect(ids).toContain("ch2/threshold@comp");
  });

  it("snaps to the field table's own grid, so MIDI and the slider agree", () => {
    // GATE threshold: -72 … 0 dB in 1 dB steps.
    const thr = bindControl(model, plan, "ch1/threshold@gate")!;
    thr.set(0);
    expect(plan.nodeParams.ch1?.gate?.threshold).toBe(-72);
    thr.set(1);
    expect(plan.nodeParams.ch1?.gate?.threshold).toBe(0);
    thr.set(0.5);
    expect(plan.nodeParams.ch1?.gate?.threshold).toBe(-36);
    expect(thr.get()).toBeCloseTo(0.5, 6);
    // COMP makeup gain: 0 … +18 dB in 0.5 dB steps, no float dust.
    const gain = bindControl(model, plan, "ch1/gain@comp")!;
    gain.set(0.25);
    expect(plan.nodeParams.ch1?.comp?.gain).toBe(4.5);
    // An EQ band frequency is logarithmic: the midpoint is the geometric one, not
    // 10 kHz — a linear mapping would resolve nothing at the bottom of the range.
    const freq = bindControl(model, plan, "ch1/freq@eq.low")!;
    freq.set(0);
    expect(plan.nodeParams.ch1?.eqBands?.[0]?.freq).toBe(20);
    freq.set(1);
    expect(plan.nodeParams.ch1?.eqBands?.[0]?.freq).toBe(20000);
    freq.set(0.5);
    expect(plan.nodeParams.ch1?.eqBands?.[0]?.freq).toBe(632);
    expect(freq.get()).toBeCloseTo(0.5, 3);
  });

  it("writes one band without disturbing the other three", () => {
    // The bands are one array, and the seed fills all four: writing LOW must not
    // rebuild the entry beside it.
    const before = structuredClone(plan.nodeParams.ch1?.eqBands?.[1]);
    bindControl(model, plan, "ch1/gain@eq.high")!.set(1);
    bindControl(model, plan, "ch1/gain@eq.low")!.set(0);
    expect(plan.nodeParams.ch1?.eqBands?.[3]?.gain).toBe(18);
    expect(plan.nodeParams.ch1?.eqBands?.[0]?.gain).toBe(-18);
    expect(plan.nodeParams.ch1?.eqBands?.[1]).toEqual(before);
  });

  it("refuses the values the device owns while COMP 1-knob is on", () => {
    const thr = bindControl(model, plan, "ch1/threshold@comp")!;
    const auto = bindControl(model, plan, "ch1/autoMakeup@comp")!;
    const level = bindControl(model, plan, "ch1/oneKnobLevel@comp")!;
    // 1-knob off: the level does nothing, everything else is the operator's.
    expect(level.set(0.5)).toBe(false);
    expect(thr.set(0.5)).toBe(true);
    expect(auto.set(1)).toBe(true);
    bindControl(model, plan, "ch1/oneKnob@comp")!.set(1);
    // 1-knob on: the device computes threshold / ratio / gain and cannot be told
    // about Auto Makeup; only the level is left.
    expect(thr.set(0.9)).toBe(false);
    expect(bindControl(model, plan, "ch1/ratio@comp")!.set(0.9)).toBe(false);
    expect(auto.set(0)).toBe(false);
    expect(level.set(0.5)).toBe(true);
    expect(plan.nodeParams.ch1?.comp?.oneKnobLevel).toBe(50);
  });

  it("refuses the band values while EQ 1-knob is on", () => {
    const gain = bindControl(model, plan, "ch1/gain@eq.low")!;
    expect(gain.set(0.75)).toBe(true);
    bindControl(model, plan, "ch1/oneKnob@eq")!.set(1);
    expect(gain.set(0.25)).toBe(false);
    expect(bindControl(model, plan, "ch1/bandOn@eq.low")!.set(0)).toBe(false);
    expect(bindControl(model, plan, "ch1/oneKnobLevel@eq")!.set(0.4)).toBe(true);
    expect(plan.nodeParams.ch1?.eqOneKnob?.level).toBe(40);
  });

  it("refuses Q and gain the filter type does not read", () => {
    const q = bindControl(model, plan, "ch1/q@eq.low")!;
    const gain = bindControl(model, plan, "ch1/gain@eq.low")!;
    // LOW ships as a shelf: a shelf reads no Q, but does read gain.
    expect(q.set(0.5)).toBe(false);
    expect(gain.set(0.5)).toBe(true);
    // A pass filter reads neither.
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, eqBands: [{ type: EQ_TYPE_PASS }] };
    expect(bindControl(model, plan, "ch1/q@eq.low")!.set(0.5)).toBe(false);
    expect(bindControl(model, plan, "ch1/gain@eq.low")!.set(0.5)).toBe(false);
    // A mid band is fixed peaking, which reads both.
    expect(bindControl(model, plan, "ch1/q@eq.lowMid")!.set(0.5)).toBe(true);
    expect(bindControl(model, plan, "ch1/gain@eq.lowMid")!.set(0.5)).toBe(true);
  });

  it("refuses a stereo channel's EQ at the rates the device bypasses it", () => {
    // Measured: at 176.4 / 192 kHz a stereo channel's EQ passes the signal
    // untouched while still storing and returning its parameters.
    const gain = bindControl(model, plan, "ch_5_6/gain@eq.low")!;
    expect(gain.set(0.75)).toBe(true);
    plan.sampleRate = 192000;
    expect(bindControl(model, plan, "ch_5_6/gain@eq.low")!.set(0.25)).toBe(false);
    expect(bindControl(model, plan, "ch_5_6/oneKnob@eq")!.set(1)).toBe(false);
    // A mono channel's EQ is unaffected by the rate.
    expect(bindControl(model, plan, "ch1/gain@eq.low")!.set(0.25)).toBe(true);
  });

  it("drops COMP entirely in SSMCS mode, keeping GATE and losing the EQ", () => {
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, compEqType: COMP_EQ_SSMCS };
    expect(bindControl(model, plan, "ch1/threshold@comp")).toBeNull();
    expect(bindControl(model, plan, "ch1/gain@eq.low")).toBeNull();
    expect(bindControl(model, plan, "ch1/threshold@gate")).not.toBeNull();
  });
});

/**
 * A write this catalog accepts reaches the wire.
 *
 * Everything above asks whether an id resolves and whether a value round-trips through
 * the control's own `get`, and BOTH are satisfied by a control that reads and writes one
 * key of its own that nothing else knows about. The value then never reaches
 * `planToCommands`, the screen never moves, and the controller's own feedback confirms
 * the position it invented — because the feedback reads the same private key back.
 *
 * That is what the SSMCS side-chain controls did: the screen flattens `ssmcs.sc.q` onto
 * the key `scQ` to keep it apart from the compressor's rows, and the catalog translated
 * that back for the ID but not for the PLAN KEY. Every assertion above passed. So this
 * one is stated from OUTSIDE the catalog — move the control, and require the commands
 * the plan implies to differ.
 */
describe("every writable control reaches the device", () => {
  /** Move to a value the control is not already at, so a no-op cannot pass. A toggle
   *  has to be flipped rather than nudged: it reads `>= 0.5`, so 0 -> 0.4 writes the
   *  state it already had and every toggle would report itself inert. */
  const away = (c: { kind: string; get(): number }): number =>
    c.kind === "toggle" ? 1 - c.get() : c.get() > 0.5 ? c.get() - 0.4 : c.get() + 0.4;
  const shape = (list: ReturnType<typeof planToCommands>): string =>
    list.map((c) => `${c.name}:${c.x}:${c.y}=${c.vdValue}`).join(",");

  it.each(["URX22", "URX44", "URX44V"] as const)("on %s, with both COMP/EQ banks in play", (modelId) => {
    const m = getModel(modelId);
    const p = defaultPlan(modelId);
    ensureFixedConnections(m, p);
    // One mono channel into the morphing bank, so both banks' controls are listed: a
    // plan carrying only one of them leaves the other's half of this unasked.
    p.nodeParams.ch1 = { ...p.nodeParams.ch1, compEqType: COMP_EQ_SSMCS };

    const inert: string[] = [];
    let moved = 0;
    for (const desc of listControls(m, p)) {
      const c = bindControl(m, p, desc.id)!;
      const before = shape(planToCommands(m, p));
      // A control the device owns refuses the write outright; that refusal is its own
      // assertion elsewhere, and it is not what this one is about.
      if (!c.set(away(c))) continue;
      moved++;
      if (shape(planToCommands(m, p)) === before) inert.push(desc.id);
    }
    // The positive control: a run that wrote nothing would report no inert control
    // either, and read exactly like a pass.
    expect(moved).toBeGreaterThan(0);
    expect(inert).toEqual([]);
  });
});

// The property the engine's echo guard is built on. A feedback message crosses the
// wire at 7 or 14 bits; if the decoded value snaps to a DIFFERENT plan value, the echo
// of that message is an edit rather than a no-op, and under Live sync it reaches the
// unit. The engine therefore guards the 7-bit forms and deliberately leaves the 14-bit
// ones unguarded — a cc14 echo arrives as two halves it cannot match anyway. That
// exclusion is only safe while the 14-bit round trip is exact for EVERY control, which
// is what this pins. Measured 2026-08-09: at 7 bits 90 of 282 controls on a URX44V fail
// the same check (the tuning screens' EQ frequency and Q, GATE attack / hold / decay,
// COMP attack / release / ratio), which is why the guard exists at all.
describe("feedback round trip", () => {
  const STEPS = 257; // finer than 7-bit, so every CC bucket is entered from both sides
  /** Any 14-bit address; `wireRaw` reads only its resolution here. */
  const PAIR = { type: "cc14", channel: 0, controller: 7 } as const;

  /** A plan with one mono channel in the morphing bank. On the factory plan no channel is
   *  in SSMCS mode, so the strip's own continuous controls — Comp Drive, Morphing, Out
   *  Gain, the compressor's, the side-chain filter's and each band's — are not listed at
   *  all, and none of them had ever been asked whether its 14-bit round trip is exact. */
  const seeded = (id: "URX22" | "URX44" | "URX44V"): Plan => {
    const p = defaultPlan(id);
    p.nodeParams.ch1 = { ...p.nodeParams.ch1, compEqType: COMP_EQ_SSMCS };
    return p;
  };

  // What that sweep cannot see, stated where it is blind. It compares `c.get()` either side
  // of the trip, and the FX delay time's codec snaps its READING to the wire's grid — so a
  // value between two positions round-trips as "unchanged" there while the plan underneath
  // it has moved. The control is offered all the same (a controller reaches 16384 of its
  // 27000 settings), so what is pinned is the SIZE of the move and that it happens once.
  it("snaps the FX delay time to the wire grid once, and no further", () => {
    const m = getModel("URX44V");
    const plan = seeded("URX44V");
    ensureFixedConnections(m, plan);
    const id = controlId("bus.fx2", "fx", "fx.delay");
    const c = bindControl(m, plan, id)!;
    const raw = (): number => plan.nodeParams["bus.fx2"]!.fxEffect!.params!.delay!;
    // Deliberately OFF the wire grid — the factory default is one such value, which is why
    // it is the seed: the case has to fail if the snap ever grows past a raw.
    plan.nodeParams["bus.fx2"]!.fxEffect!.params = { ...plan.nodeParams["bus.fx2"]!.fxEffect!.params, delay: 5000 };
    const echo = (): void => {
      expect(c.set(wireRaw(PAIR, c.get()) / wireSteps(PAIR))).toBe(true);
    };
    echo();
    const settled = raw();
    expect(Math.abs(settled - 5000), "one echo moves it by at most one raw").toBeLessThanOrEqual(1);
    echo();
    echo();
    expect(raw(), "and no further: the snapped value is on the grid").toBe(settled);
  });

  it.each(["URX22", "URX44", "URX44V"] as const)("is exact at 14 bits for every %s control", (id) => {
    const m = getModel(id);
    const offenders = new Set<string>();
    const listed = listControls(m, seeded(id)).filter((d) => d.kind === "continuous");
    // The positive control for the seeding: the strip's own controls have to be among the
    // ones swept, or this case has quietly gone back to the factory plan's set.
    expect(listed.filter((d) => d.id.includes("@ssmcs")).length).toBeGreaterThan(10);
    for (const desc of listed) {
      // One plan per control: `set` is absolute, so a sweep cannot accumulate, but a
      // neighbouring control's writes could change what this one is allowed to hold.
      const p = seeded(id);
      ensureFixedConnections(m, p);
      const c = bindControl(m, p, desc.id);
      if (!c) continue;
      for (let i = 0; i < STEPS; i++) {
        if (!c.set(i / (STEPS - 1))) continue; // device-locked in this plan
        const v = c.get();
        // The engine's own encoder, not a copy of it: a pin that re-implements the
        // encoding keeps passing against an encoding the engine no longer uses, which
        // is the one failure it exists to catch.
        const raw = wireRaw(PAIR, v);
        if (!c.set(raw / wireSteps(PAIR))) continue;
        if (c.get() !== v) offenders.add(desc.id);
      }
    }
    expect([...offenders]).toEqual([]);
  });
});

// A mapping outlives the state that locked the control it names, and nothing on the MIDI
// side re-reads the screen. So each lock is asked here in BOTH directions from one mapping:
// the control is bound once, and the plan is moved under it.
describe("a mapping cannot reach past a lock the screen draws", () => {
  const holding = (node: string, sel: number, params: Record<number, number>, fam: InsertFxFamily): void => {
    const keyed: Record<string, number> = {};
    for (const [slot, v] of Object.entries(params)) keyed[insertFxParamKey(fam, Number(slot))] = v;
    plan.nodeParams[node] = { ...plan.nodeParams[node], insertFx: sel, insertFxParams: keyed };
  };
  const slotVal = (node: string, fam: InsertFxFamily, slot: number): number | undefined =>
    plan.nodeParams[node]?.insertFxParams?.[insertFxParamKey(fam, slot)];
  /** Drive a bound control and say whether it took, without asking the control twice. */
  const push = (cid: string, v: number): boolean => {
    const c = bindControl(model, plan, cid);
    if (!c) throw new Error(`no control ${cid}`);
    return c.set(v);
  };

  // The eighth lock, and the only one outside insert FX. While tempo Sync is on the unit
  // recomputes the delay time from BPM and the note value and announces the result, so the
  // screen locks the row and the catalogue has to refuse the write — `fxRowOwners` is the one
  // list both read. Asked in BOTH directions, like every case around it: without the second
  // half a `set` that never takes at all would satisfy the first.
  it("refuses the FX delay time while tempo Sync is on, and takes it back when it is off", () => {
    const cid = controlId("bus.fx2", "fx", "fx.delay");
    const fxParamsOf = (): Record<string, number> | undefined => plan.nodeParams["bus.fx2"]?.fxEffect?.params;
    const hold = (sync: number): void => {
      plan.nodeParams["bus.fx2"] = {
        ...plan.nodeParams["bus.fx2"],
        fxEffect: { ...plan.nodeParams["bus.fx2"]?.fxEffect, type: 1024, params: { delay: 5000, sync } },
      };
    };
    hold(1);
    expect(push(cid, 0.75), "while the unit is computing it").toBe(false);
    expect(fxParamsOf()?.delay, "and the value did not move").toBe(5000);
    hold(0);
    expect(push(cid, 0.75), "with Sync off it is the operator's again").toBe(true);
    expect(fxParamsOf()?.delay).not.toBe(5000);
  });

  it("refuses the slots the multi-band compressor's 1-Knob is driving, and takes them back", () => {
    const th = MBC_BANDS[0].threshold;
    const cid = controlId("bus.stereo", "insfx", `insfx.mbc.${th}`);
    holding("bus.stereo", 1792, { [MBC_ONE_KNOB.on.slot]: 1, [th]: 100 }, "mbc");
    expect(push(cid, 0.75), "while the knob is on").toBe(false);
    expect(slotVal("bus.stereo", "mbc", th)).toBe(100);
    // The positive control: the same mapping, the same value, with the knob off.
    holding("bus.stereo", 1792, { [MBC_ONE_KNOB.on.slot]: 0, [th]: 100 }, "mbc");
    expect(push(cid, 0.75), "with the knob off").toBe(true);
    expect(slotVal("bus.stereo", "mbc", th)).not.toBe(100);
  });

  it("refuses the 1-Knob's own Level while the knob is off", () => {
    const cid = controlId("bus.stereo", "insfx", `insfx.mbc.${MBC_ONE_KNOB.level.slot}`);
    holding("bus.stereo", 1792, { [MBC_ONE_KNOB.on.slot]: 0, [MBC_ONE_KNOB.level.slot]: 4 }, "mbc");
    expect(push(cid, 0.5), "while the knob is off").toBe(false);
    expect(slotVal("bus.stereo", "mbc", MBC_ONE_KNOB.level.slot)).toBe(4);
    holding("bus.stereo", 1792, { [MBC_ONE_KNOB.on.slot]: 1, [MBC_ONE_KNOB.level.slot]: 4 }, "mbc");
    expect(push(cid, 0.5), "with the knob on").toBe(true);
    expect(slotVal("bus.stereo", "mbc", MBC_ONE_KNOB.level.slot)).not.toBe(4);
  });

  it("takes a guitar amp's Speed whatever the modulation reads", () => {
    // The screen TAGS this row while the modulation is not the vibrato — its value is not
    // in the signal there — but it does not refuse the write, because the unit stores it
    // and takes one. A mapping is refused only where the screen refuses the gesture.
    const cid = controlId("ch1", "insfx", `insfx.guitar-clean.${GUITAR_MOD.speed}`);
    for (const mod of [1, GUITAR_MOD.vib] as const) {
      holding("ch1", 256, { [GUITAR_MOD.slot]: mod, [GUITAR_MOD.speed]: 50 }, "guitar-clean");
      expect(push(cid, 0.9), `modulation ${mod}`).toBe(true);
      expect(slotVal("ch1", "guitar-clean", GUITAR_MOD.speed), `modulation ${mod}`).not.toBe(50);
    }
  });

  // The two companders are ONE family, and the only thing separating them is what their
  // five values come up at. So a control's default has to be asked of the SELECTOR: asked
  // of the family alone it answers with Compander-H's for both, and a node holding
  // Compander-S with nothing stored yet — offline, a demo, any plan before its first
  // device read — has every pickup crossing point and every feedback value taken from the
  // other effect.
  it("takes an unsaved compander value from the selector rather than the family", () => {
    const slot = 6;
    const cid = controlId("bus.stereo", "insfx", `insfx.compander.${slot}`);
    const defOf = (sel: number): number => insertFxParams("compander", sel).find((d) => d.slot === slot)!.def;
    expect(defOf(COMPANDER_S), "the two must differ, or this proves nothing").not.toBe(defOf(COMPANDER_H));

    const readBack = (sel: number): number => {
      // Nothing stored: the catalogue's default is the whole answer.
      plan.nodeParams["bus.stereo"] = { insertFx: sel, insertFxParams: {} };
      const c = bindControl(model, plan, cid);
      if (!c) throw new Error(`no control ${cid}`);
      // Through the control's own codec rather than a second copy of it: what a pickup
      // crosses and what feedback sends is this number, and writing it back is what says
      // which raw it stood for.
      c.set(c.get());
      return plan.nodeParams["bus.stereo"].insertFxParams![insertFxParamKey("compander", slot)];
    };
    expect(readBack(COMPANDER_S)).toBe(defOf(COMPANDER_S));
    expect(readBack(COMPANDER_H)).toBe(defOf(COMPANDER_H));
  });

  // A TOGGLE reaches the plan too, and by a branch of its own: the slot descriptors split
  // into a switch and a slider before either is bound, so a lock proved on the sliders says
  // nothing about the other half. The guitar amp's gate is the switch a mapping can hold.
  it("writes an insert-FX switch through a mapping, where nothing locks it", () => {
    const gate = 24;
    const cid = controlId("ch1", "insfx", `insfx.guitar-clean.${gate}`);
    holding("ch1", 256, { [gate]: 0 }, "guitar-clean");
    expect(push(cid, 1)).toBe(true);
    expect(slotVal("ch1", "guitar-clean", gate)).toBe(1);
    expect(push(cid, 0)).toBe(true);
    expect(slotVal("ch1", "guitar-clean", gate)).toBe(0);
  });

  // Pitch Fix's own driven set has no MIDI half to lock, and that is worth asserting
  // rather than assuming: the Scale is an enum row, which offers no control at all (a
  // select has no normalized domain), and the twelve notes are a keyboard the screen
  // builds by hand rather than descriptors the catalogue walks. Give either one a
  // descriptor and this fails, which is where the lock would then be needed.
  it("offers no mapping at all for the slots Pitch Fix's MIDI Control owns", () => {
    holding("ch1", 512, { [PITCH_MIDI_ENABLE_SLOT]: 1, [PITCH_SCALE_SLOT]: 0 }, "pitch");
    const driven = pitchDeviceDriven(plan.nodeParams["ch1"]?.insertFxParams);
    expect(driven.size, "the unit is driving something to begin with").toBeGreaterThan(0);
    const ids = new Set(listControls(model, plan).map((c) => c.id));
    for (const slot of driven) {
      expect(ids, `pitch slot ${slot}`).not.toContain(controlId("ch1", "insfx", `insfx.pitch.${slot}`));
    }
  });

  // Not an insert effect: the same shape one rate above, where the bus itself is gone.
  it("refuses a send into a bus the sample rate has removed — level AND mute", () => {
    const level = controlId("ch1", "level", "bus.fx2");
    const mute = controlId("ch1", "mute", "bus.fx2");
    const send = () => conn("ch1", "bus.fx2");
    send().params = { ...send().params, level: -10, on: true };
    plan.sampleRate = 192000;
    expect(push(level, 0.8), "level at 192 kHz").toBe(false);
    expect(push(mute, 1), "mute at 192 kHz").toBe(false);
    expect(send().params?.level).toBe(-10);
    expect(send().params?.on).toBe(true);
    // …and both take at a rate the bus survives, so this is not a send nothing can write.
    plan.sampleRate = 48000;
    expect(push(level, 0.8), "level at 48 kHz").toBe(true);
    expect(push(mute, 1), "mute at 48 kHz").toBe(true);
    expect(send().params?.level).not.toBe(-10);
    expect(send().params?.on).toBe(false);
  });
});

// A gang whose members do not merely share an address but share a LOCK: the EQ 1-knob computes
// the four bands while it is on, so a band cannot be written until the knob is off — and the
// knob is in the same gang. Driven through the real engine and the real catalogue, because what
// is being asked is an interaction between the two.
describe("a gang whose first member unlocks another", () => {
  const ONE = controlId("ch1", "oneKnob", EQ_SCOPE);
  const LOW = controlId("ch1", "bandOn", eqBandScope(0));

  const knobOnBandStored = (knobOn = true, bandOn = true): void => {
    const bands = (plan.nodeParams.ch1?.eqBands ?? []).slice();
    bands[0] = { ...bands[0], on: bandOn };
    plan.nodeParams.ch1 = {
      ...plan.nodeParams.ch1,
      eqOneKnob: { ...plan.nodeParams.ch1?.eqOneKnob, on: knobOn },
      eqBands: bands,
    };
  };

  /** Drive one press through the real engine and report what the plan ended up holding. */
  const press = (order: readonly string[], button: "edge" | "state", value: number, knobOn = true, bandOn = true) => {
    knobOnBandStored(knobOn, bandOn);
    // The premise, stated rather than assumed: the knob reads as it was seeded, and the band
    // READS off exactly when the knob owns it. Without this a run where the seed did not take
    // proves nothing — with the knob off the band would read off because it IS off.
    expect(bindControl(model, plan, ONE)!.get(), "the knob is where the case put it").toBe(knobOn ? 1 : 0);
    expect(bindControl(model, plan, LOW)!.get(), "the band reads off only while the knob owns it").toBe(
      knobOn ? 0 : bandOn ? 1 : 0,
    );
    expect(plan.nodeParams.ch1?.eqBands?.[0]?.on, "…whatever it is holding").toBe(bandOn);

    const engine = new MidiEngine({
      resolve: (cid) => bindControl(model, plan, cid),
      gate: () => null,
      refused: () => {},
      applied: () => {},
      send: () => {},
      learned: () => {},
      learnPending: () => {},
      now: () => 0,
    });
    const addr = { type: "cc", channel: 0, controller: 9 } as const;
    engine.setMappings(order.map((control) => ({ control, addr, mode: "absolute", button }) as const));
    engine.onMessage([0xb0, 9, value]);
    return { oneKnob: plan.nodeParams.ch1?.eqOneKnob?.on, low: plan.nodeParams.ch1?.eqBands?.[0]?.on };
  };

  // BOTH learn orders. The order decides which member commits first, and only one of them ever
  // worked: with the band learned first there was nothing to write to when its turn came, and
  // nothing came back for it afterwards.
  it.each([
    [[ONE, LOW], "the knob learned first"],
    [[LOW, ONE], "the band learned first"],
  ])("switches the whole gang off, %s", (order) => {
    const after = press(order, "state", 0);
    expect(after.oneKnob, "the knob went off").toBe(false);
    // …and so did the band. Left behind, it comes back the moment the knob releases it — the
    // operator switched one physical control off and an EQ band arrived on.
    expect(after.low, "and the band it was hiding").toBe(false);
  });

  // The learn order must not decide the OUTCOME, in either button mode. It is the order two
  // assignments happened to be made in — nothing the operator can see at the moment of a press,
  // and nothing the press means. Edge is where it showed: its target is a flip of what the
  // control reads, so a member re-decided after the release flipped a value the operator was
  // never shown, while the one that got in first flipped the value they were.
  it.each([
    ["edge", 127],
    ["state", 0],
  ] as const)("lands on the same values from either learn order, in %s mode", (button, value) => {
    const knobFirst = press([ONE, LOW], button, value);
    const bandFirst = press([LOW, ONE], button, value);
    expect(knobFirst).toEqual(bandFirst);
  });

  // …and what edge lands ON, so the case above cannot be satisfied by both orders agreeing on
  // the wrong thing. A locked band READS off, and a flip of what the operator was shown turns
  // it on — the knob goes off in the same press, which is what makes that value reachable.
  it("flips an edge gang from what the screen was showing", () => {
    const after = press([ONE, LOW], "edge", 127);
    expect(after.oneKnob, "the knob was on and flips off").toBe(false);
    expect(after.low, "the band read off and flips on").toBe(true);
  });

  // The whole table: the lock going ON as well as coming off, both button modes, both learn
  // orders. The direction that ADDS the lock is the one the retry cannot save — the governed
  // value has to be written before the governor takes it, and after that there is nothing to
  // write to and no way back.
  it.each([
    ["the lock coming off", true, true],
    ["the lock going on", false, false],
  ] as const)("%s lands the same way from either learn order, in either mode", (_label, knobOn, bandOn) => {
    for (const [button, value] of [
      ["edge", 127],
      ["state", knobOn ? 0 : 127],
    ] as const) {
      const knobFirst = press([ONE, LOW], button, value, knobOn, bandOn);
      const bandFirst = press([LOW, ONE], button, value, knobOn, bandOn);
      expect(bandFirst, `${button}: the learn order decided the outcome`).toEqual(knobFirst);
      // The knob moved in both, which is the positive control: two orders agreeing that
      // NOTHING happened would satisfy the line above.
      expect(knobFirst.oneKnob, `${button}: the knob moved`).toBe(!knobOn);
    }
  });

  // …and what the locking direction lands on. The band is writable when the press arrives and
  // the knob is about to take it, so the band's own value has to be written first — left to
  // the order the assignments were made in, it was written or lost by luck.
  it("writes a band the knob is about to take over", () => {
    const after = press([ONE, LOW], "state", 127, false, false);
    expect(after.oneKnob, "the knob went on").toBe(true);
    expect(after.low, "and the band took the press before it was locked").toBe(true);
  });
});

// The insert effect's BYPASS. It is the face on the CONSOLE strip rather than a row on the
// tuning screen, and it is a flag of the node's own rather than a slot of the engine array —
// so it takes a param of its own, the shape `gateOn` / `compOn` / `eqOn` take.
describe("the insert effect's bypass", () => {
  const id = controlId("ch1", "insertFxOn");
  const hold = (sel: number): void => {
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, insertFx: sel };
  };

  it("is offered only while the node holds an effect", () => {
    // The factory plan holds none, and there is then no insert to switch: the strip draws an
    // opener where the face would be, so a control offered here would be one the operator has
    // no way to see.
    expect(listControls(model, plan).some((c) => c.id === id)).toBe(false);
    expect(bindControl(model, plan, id)).toBeNull();
    hold(INSERT_FX_OPTIONS[1].value);
    expect(listControls(model, plan).some((c) => c.id === id)).toBe(true);
    expect(bindControl(model, plan, id)).not.toBeNull();
  });

  it("reads engaged for a held effect with no stored flag, and follows the bypass", () => {
    hold(INSERT_FX_OPTIONS[1].value);
    // ABSENT means engaged — what the unit does on a selector write, and the same predicate
    // the strip's face is drawn from rather than a second reading of the field. The factory
    // plan carries the flag as `false`, so the state has to be built rather than assumed.
    delete plan.nodeParams.ch1!.insertFxOn;
    expect(plan.nodeParams.ch1?.insertFxOn, "the state this case reads from").toBeUndefined();
    expect(bindControl(model, plan, id)!.get(), "absent = engaged").toBe(1);
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, insertFxOn: false };
    expect(bindControl(model, plan, id)!.get(), "and a stored bypass reads as off").toBe(0);
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, insertFxOn: true };
    expect(bindControl(model, plan, id)!.get(), "…and back").toBe(1);
  });

  // The rate lock, at each effect's own ceiling and one step past it. Above it the strip draws
  // this face OFF and refuses the press, so the catalogue has to answer the same way — a
  // mapping outlives the rate it was made at, and the LED would otherwise report the stored
  // value against a face that reads OFF.
  it.each([
    [512, "Pitch Fix", 48000, 96000],
    [256, "Clean", 96000, 176400],
  ] as const)("refuses %i (%s) above its ceiling, and takes it at the ceiling", (sel, _label, ceiling, above) => {
    hold(sel);
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, insertFxOn: true };

    // AT the ceiling the control is the operator's, which is the positive control: without it
    // a catalogue that refused at every rate would satisfy the half below.
    plan.sampleRate = ceiling;
    expect(bindControl(model, plan, id)!.get(), `${ceiling}: reads the stored value`).toBe(1);
    expect(bindControl(model, plan, id)!.set(0), `${ceiling}: takes the write`).toBe(true);
    expect(plan.nodeParams.ch1?.insertFxOn).toBe(false);

    // …and one step past it the face is drawn OFF and inoperable.
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, insertFxOn: true };
    plan.sampleRate = above;
    // The mapping stays RESOLVABLE on purpose: it survives the rate going back, and a control
    // that vanished would take its assignment with it.
    const locked = bindControl(model, plan, id);
    expect(locked, `${above}: still bound`).not.toBeNull();
    expect(locked!.get(), `${above}: reads OFF, as the face is drawn`).toBe(0);
    expect(locked!.set(0), `${above}: refuses the write`).toBe(false);
    expect(plan.nodeParams.ch1?.insertFxOn, `${above}: and the plan is untouched`).toBe(true);
  });

  it("writes the bypass and nothing else", () => {
    hold(INSERT_FX_OPTIONS[1].value);
    const before = { ...plan.nodeParams.ch1 };
    expect(bindControl(model, plan, id)!.set(0)).toBe(true);
    expect(plan.nodeParams.ch1?.insertFxOn).toBe(false);
    expect(bindControl(model, plan, id)!.set(1)).toBe(true);
    expect(plan.nodeParams.ch1?.insertFxOn).toBe(true);
    // The selection is the popover's, not this control's: a press that also released or
    // changed the effect would be the defect the face's own comment names.
    const moved = [...new Set([...Object.keys(before), ...Object.keys(plan.nodeParams.ch1 ?? {})])].filter(
      (k) => (before as Record<string, unknown>)[k] !== (plan.nodeParams.ch1 as Record<string, unknown>)[k],
    );
    expect(moved).toEqual(["insertFxOn"]);
  });
});

// The dependency the gang orders itself by, declared across every processor that has one. It
// is a control ID, so a typo or a renamed scope leaves it naming nothing — and a governor that
// resolves to no control silently puts the ordering back to the one the mappings happened to
// be learned in, which is the defect it exists to remove.
describe("the lock dependencies the catalogue declares", () => {
  const listFor = (seed: (p: Plan) => void): ReturnType<typeof listControls> => {
    seed(plan);
    return listControls(model, plan);
  };

  it("names a governor that exists, wherever one is named", () => {
    const seeded = listFor((p) => {
      p.nodeParams.ch1 = { ...p.nodeParams.ch1, insertFx: 512 };
      p.nodeParams["bus.fx2"] = { fxEffect: { type: 1024, params: { sync: 1, bpm: 120, note: 9, delay: 5000 } } };
    });
    const ids = new Set(seeded.map((c) => c.id));
    const named = seeded.filter((c) => c.governedBy !== undefined);
    // The positive control: a run that declared none would satisfy the loop below.
    expect(named.length, "the catalogue declares dependencies at all").toBeGreaterThan(0);
    expect(named.filter((c) => !ids.has(c.governedBy!)).map((c) => `${c.id} -> ${c.governedBy}`)).toEqual([]);
    // …and nothing waits for itself, which would be a control that is never written.
    expect(named.filter((c) => c.governedBy === c.id).map((c) => c.id)).toEqual([]);
  });

  // One per family that HAS a governor among its controls, so a processor that loses its
  // declaration is red here rather than only in whichever gang someone happens to build.
  //
  // Pitch Fix is deliberately not among them. Its MIDI Control decides which of its slots the
  // unit drives, exactly as the 1-knobs do, but it is a writable slot with no parameter row —
  // no mapping can name it, so it can be in no gang and there is nothing for its slots to wait
  // for. The case above is what holds that: a declaration pointing at it would name a control
  // that does not exist, and the ordering would silently go back to the learn order.
  it.each([
    ["EQ", (p: Plan) => void p, `ch1/bandOn@${eqBandScope(0)}`, controlId("ch1", "oneKnob", EQ_SCOPE)],
    ["COMP", (p: Plan) => void p, "ch1/threshold@comp", controlId("ch1", "oneKnob", COMP_SCOPE)],
    [
      "the multi-band compressor",
      (p: Plan) => {
        p.nodeParams["bus.mix1"] = { insertFx: 1792 };
      },
      `bus.mix1/insfx@${INSFX_SCOPE}.mbc.${MBC_ONE_KNOB.level.slot}`,
      controlId("bus.mix1", "insfx", `${INSFX_SCOPE}.mbc.${MBC_ONE_KNOB.on.slot}`),
    ],
    [
      "FX Sync",
      (p: Plan) => {
        p.nodeParams["bus.fx2"] = { fxEffect: { type: 1024, params: { sync: 1, bpm: 120, note: 9, delay: 5000 } } };
      },
      `bus.fx2/fx@${FX_SCOPE}.delay`,
      controlId("bus.fx2", "fx", `${FX_SCOPE}.sync`),
    ],
  ])("%s names the control that governs it", (_family, seed, dependent, governor) => {
    const found = listFor(seed).find((c) => c.id === dependent);
    if (!found) throw new Error(`${dependent} is not in the catalogue — the case addresses nothing`);
    expect(found.governedBy).toBe(governor);
  });
});

// The governor and the governed need not be the same channel. A BAL-linked pair mirrors its
// whole node params, so its two 1-knobs are ONE governor: a gang holding CH 1's band and CH 2's
// knob has to be ordered against both, and keyed by control id alone it was not.
//
// PAN and an unlinked pair are the negative conditions: there the two channels keep their own EQ
// and COMP, so CH 2's knob governs nothing of CH 1's and the learn order has nothing to decide.
// They pin the OUTCOME rather than the key — normalising in PAN as well is a mutation these do
// not catch, and cannot: the insert effect is the only thing PAN mirrors, and no family a linked
// CH pair can hold has a driver among its controls, so there is no relation there to key wrongly.
describe("a governor across a BAL-linked pair", () => {
  const knobOf = (ch: string): string => controlId(ch, "oneKnob", EQ_SCOPE);
  const lowOf = (ch: string): string => controlId(ch, "bandOn", eqBandScope(0));

  const press = (
    order: readonly string[],
    button: "edge" | "state",
    value: number,
    link: number | null,
    knobOn: boolean,
  ): Record<string, boolean | undefined> => {
    for (const ch of ["ch1", "ch2"]) {
      const bands = (plan.nodeParams[ch]?.eqBands ?? []).slice();
      bands[0] = { ...bands[0], on: knobOn };
      plan.nodeParams[ch] = {
        ...plan.nodeParams[ch],
        eqOneKnob: { ...plan.nodeParams[ch]?.eqOneKnob, on: knobOn },
        eqBands: bands,
      };
    }
    if (link !== null) plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, stereoLink: true, panBal: link };
    const engine = new MidiEngine({
      resolve: (cid) => bindControl(model, plan, cid),
      gate: () => null,
      refused: () => {},
      // The funnel's own mirrors, which are what make the pair one governor.
      applied: (c) => {
        mirrorBalPair(model, plan, c.node);
        mirrorLinkedInsertFx(model, plan, c.node);
      },
      send: () => {},
      learned: () => {},
      learnPending: () => {},
      now: () => 0,
    });
    const addr = { type: "cc", channel: 0, controller: 9 } as const;
    engine.setMappings(order.map((control) => ({ control, addr, mode: "absolute", button }) as const));
    engine.onMessage([0xb0, 9, value]);
    return {
      ch1Knob: plan.nodeParams.ch1?.eqOneKnob?.on,
      ch1Low: plan.nodeParams.ch1?.eqBands?.[0]?.on,
      ch2Knob: plan.nodeParams.ch2?.eqOneKnob?.on,
      ch2Low: plan.nodeParams.ch2?.eqBands?.[0]?.on,
    };
  };

  // governor channel x governed channel x learn order x lock direction x button mode, against
  // each link state. The outcome may differ BETWEEN link states — that is what linking means —
  // so what each row asserts is that the learn order does not decide it.
  it.each([
    ["BAL", PAN_BAL_BAL],
    ["PAN", PAN_BAL_PAN],
    ["unlinked", null],
  ])("does not let the learn order decide the outcome, %s", (_label, link) => {
    for (const governor of ["ch1", "ch2"])
      for (const governed of ["ch1", "ch2"])
        for (const [button, onValue, offValue] of [
          ["edge", 127, 127],
          ["state", 127, 0],
        ] as const)
          for (const knobOn of [false, true]) {
            const value = knobOn ? offValue : onValue;
            const a = press([lowOf(governed), knobOf(governor)], button, value, link, knobOn);
            const b = press([knobOf(governor), lowOf(governed)], button, value, link, knobOn);
            expect(b, `${button} governor=${governor} governed=${governed} knobOn=${knobOn}`).toEqual(a);
            // The positive control: the knob really moved, so two orders agreeing that nothing
            // happened cannot satisfy the line above.
            expect(a[`${governor}Knob`], `${button}: the knob moved`).toBe(!knobOn);
          }
  });

  // …and what BAL lands on, since agreement alone is satisfied by both orders being wrong. The
  // band is writable when the press arrives and the knob is about to take it over, so its value
  // is written first — and the mirror carries it to the partner.
  it("writes the band before the pair's knob takes it, from either channel", () => {
    for (const governor of ["ch1", "ch2"]) {
      const after = press([knobOf(governor), lowOf("ch1")], "state", 127, PAN_BAL_BAL, false);
      expect(after.ch1Knob, `${governor}: the pair's knob went on`).toBe(true);
      expect(after.ch1Low, `${governor}: and the band took the press first`).toBe(true);
      expect(after.ch2Low, `${governor}: on both members, which the mirror carries`).toBe(true);
    }
  });
});

// Members a MIRROR keeps equal are ONE value, so a gang holding both is one decision. Written in
// turn they were two, and a mirror settles on whichever went last: a pair that starts at different
// values then ends wherever the learn order put it. Such a plan is reachable — it saves and loads
// with nothing reported — so the pair has to decide, not the order two assignments were made in.
describe("a gang holding both members of a mirrored pair", () => {
  const ON = (ch: string): string => controlId(ch, "insertFxOn");

  const press = (first: "ch1" | "ch2", ch1On: boolean, ch2On: boolean): Record<string, unknown> => {
    plan.nodeParams.ch1 = {
      ...plan.nodeParams.ch1,
      stereoLink: true,
      panBal: PAN_BAL_PAN,
      insertFx: INSERT_FX_OPTIONS[1].value,
      insertFxOn: ch1On,
    };
    plan.nodeParams.ch2 = { ...plan.nodeParams.ch2, insertFx: INSERT_FX_OPTIONS[1].value, insertFxOn: ch2On };
    const engine = new MidiEngine({
      resolve: (cid) => bindControl(model, plan, cid),
      gate: () => null,
      refused: () => {},
      applied: (c) => {
        mirrorBalPair(model, plan, c.node);
        mirrorLinkedInsertFx(model, plan, c.node);
      },
      send: () => {},
      learned: () => {},
      learnPending: () => {},
      now: () => 0,
    });
    const addr = { type: "cc", channel: 0, controller: 7 } as const;
    const order = first === "ch1" ? ["ch1", "ch2"] : ["ch2", "ch1"];
    engine.setMappings(order.map((ch) => ({ control: ON(ch), addr, mode: "absolute" }) as const));
    engine.onMessage([0xb0, 7, 127]);
    return { ch1: plan.nodeParams.ch1?.insertFxOn, ch2: plan.nodeParams.ch2?.insertFxOn };
  };

  // The reachable state this exists for: a plan holding the two disagreeing survives a round trip
  // with nothing reported, so nothing upstream makes them equal before a press arrives.
  it("is a state a plan can hold", () => {
    plan.nodeParams.ch1 = {
      ...plan.nodeParams.ch1,
      stereoLink: true,
      panBal: PAN_BAL_PAN,
      insertFx: INSERT_FX_OPTIONS[1].value,
      insertFxOn: true,
    };
    plan.nodeParams.ch2 = { ...plan.nodeParams.ch2, insertFx: INSERT_FX_OPTIONS[1].value, insertFxOn: false };
    const back = deserialize(serialize(plan));
    expect([back.nodeParams.ch1?.insertFxOn, back.nodeParams.ch2?.insertFxOn]).toEqual([true, false]);
    expect(planProblems(model, back)).toEqual([]);
  });

  it.each([
    ["disagreeing, primary on", true, false],
    ["disagreeing, primary off", false, true],
    ["agreeing", true, true],
  ])("lands the same way from either learn order — %s", (_label, ch1On, ch2On) => {
    const a = press("ch1", ch1On, ch2On);
    const b = press("ch2", ch1On, ch2On);
    expect(b, "the learn order decided the outcome").toEqual(a);
    // Both members end equal, which is what the mirror means — and the positive control, since
    // two orders agreeing on a SPLIT pair would satisfy the line above.
    expect(a.ch1, "the pair agrees afterwards").toBe(a.ch2);
    // …and the value is the PAIR's: the primary's own before-value is what flips.
    expect(a.ch1, "the primary's value is the one that moved").toBe(!ch1On);
  });
});

// What a mirror covers is a property of the NODE and the link mode, not of one parameter. BAL
// replaces the partner's whole node params and every send, so a BAL pair's CH ON is one value the
// same way its insert effect is — declared per parameter it was the insert effect's alone.
describe("what a mirrored pair covers, by link mode", () => {
  const press = (first: "ch1" | "ch2", link: number, ch1On: boolean, ch2On: boolean) => {
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, stereoLink: true, panBal: link, on: ch1On };
    plan.nodeParams.ch2 = { ...plan.nodeParams.ch2, on: ch2On };
    const engine = new MidiEngine({
      resolve: (cid) => bindControl(model, plan, cid),
      gate: () => null,
      refused: () => {},
      applied: (c) => {
        mirrorBalPair(model, plan, c.node);
        mirrorLinkedInsertFx(model, plan, c.node);
      },
      send: () => {},
      learned: () => {},
      learnPending: () => {},
      now: () => 0,
    });
    const addr = { type: "cc", channel: 0, controller: 7 } as const;
    const order = first === "ch1" ? ["ch1", "ch2"] : ["ch2", "ch1"];
    engine.setMappings(order.map((ch) => ({ control: controlId(ch, "chOn"), addr, mode: "absolute" }) as const));
    engine.onMessage([0xb0, 7, 127]);
    return { ch1: plan.nodeParams.ch1?.on, ch2: plan.nodeParams.ch2?.on };
  };

  it("BAL: CH ON is one value, so the learn order cannot pick it", () => {
    const back = deserialize(
      serialize({
        ...plan,
        nodeParams: {
          ...plan.nodeParams,
          ch1: { ...plan.nodeParams.ch1, stereoLink: true, panBal: PAN_BAL_BAL, on: true },
          ch2: { ...plan.nodeParams.ch2, on: false },
        },
      }),
    );
    // Reachable, like the insert-FX pair: nothing makes the two agree before a press arrives.
    expect([back.nodeParams.ch1?.on, back.nodeParams.ch2?.on]).toEqual([true, false]);
    expect(planProblems(model, back)).toEqual([]);

    const a = press("ch1", PAN_BAL_BAL, true, false);
    const b = press("ch2", PAN_BAL_BAL, true, false);
    expect(b, "the learn order decided the outcome").toEqual(a);
    expect(a.ch1, "the pair agrees afterwards").toBe(a.ch2);
    expect(a.ch1, "the primary's value is the one that moved").toBe(false);
  });

  // The negative condition, and the reason the declaration cannot simply be "a linked pair":
  // PAN keeps each channel's own CH ON, so these are two values and each flips its own.
  it("PAN: CH ON is each channel's own, and stays two values", () => {
    const a = press("ch1", PAN_BAL_PAN, true, false);
    expect(a).toEqual({ ch1: false, ch2: true });
    expect(press("ch2", PAN_BAL_PAN, true, false), "and the order still decides nothing").toEqual(a);
  });
});

// `button` is deliberately not ganged — two controls behind one button may want edge and state —
// so a gang can hold a member that IGNORES a message beside one that acts on it. The member that
// ignored it still holds its group's seat: dropped before the grouping, its partner spoke for the
// pair and a release the primary refuses turned the pair off.
describe("a mirrored gang whose members read the press differently", () => {
  it("lets the primary's silence stand for the pair", () => {
    plan.nodeParams.ch1 = {
      ...plan.nodeParams.ch1,
      stereoLink: true,
      panBal: PAN_BAL_PAN,
      insertFx: INSERT_FX_OPTIONS[1].value,
      insertFxOn: true,
    };
    plan.nodeParams.ch2 = { ...plan.nodeParams.ch2, insertFx: INSERT_FX_OPTIONS[1].value, insertFxOn: true };
    const engine = new MidiEngine({
      resolve: (cid) => bindControl(model, plan, cid),
      gate: () => null,
      refused: () => {},
      applied: (c) => {
        mirrorBalPair(model, plan, c.node);
        mirrorLinkedInsertFx(model, plan, c.node);
      },
      send: () => {},
      learned: () => {},
      learnPending: () => {},
      now: () => 0,
    });
    const addr = { type: "cc", channel: 0, controller: 7 } as const;
    engine.setMappings([
      { control: controlId("ch1", "insertFxOn"), addr, mode: "absolute", button: "edge" },
      { control: controlId("ch2", "insertFxOn"), addr, mode: "absolute", button: "state" },
    ]);

    // A release: edge ignores anything under 64, state would read it as off.
    engine.onMessage([0xb0, 7, 0]);
    expect([plan.nodeParams.ch1?.insertFxOn, plan.nodeParams.ch2?.insertFxOn], "the release changed nothing").toEqual([
      true,
      true,
    ]);
    // The positive control: the same gang DOES act on a press, so the case above is the release
    // being ignored rather than the gang being inert.
    engine.onMessage([0xb0, 7, 127]);
    expect([plan.nodeParams.ch1?.insertFxOn, plan.nodeParams.ch2?.insertFxOn], "…and a press does").toEqual([
      false,
      false,
    ]);
  });
});

// One incoming CC matches TWO addresses — its own, and the 14-bit pair it belongs to as either
// half: a controller under 32 is that pair's MSB and one from 32 to 63 is its LSB, folded back onto
// the MSB the pair is keyed by. So
// a message can reach two gangs at once, and a gang is the members sharing ONE address. Collapsed
// across that boundary, a member on the other address decided for this one.
describe("a mirrored pair bound to two different addresses", () => {
  it("does not let a 14-bit binding speak for the plain CC beside it", () => {
    plan.nodeParams.ch1 = {
      ...plan.nodeParams.ch1,
      stereoLink: true,
      panBal: PAN_BAL_PAN,
      insertFx: INSERT_FX_OPTIONS[1].value,
      insertFxOn: true,
    };
    plan.nodeParams.ch2 = { ...plan.nodeParams.ch2, insertFx: INSERT_FX_OPTIONS[1].value, insertFxOn: true };
    const engine = new MidiEngine({
      resolve: (cid) => bindControl(model, plan, cid),
      gate: () => null,
      refused: () => {},
      applied: (c) => {
        mirrorBalPair(model, plan, c.node);
        mirrorLinkedInsertFx(model, plan, c.node);
      },
      send: () => {},
      learned: () => {},
      learnPending: () => {},
      now: () => 0,
    });
    // The pair primary takes the 14-bit address, which a toggle binds to inertly by design; the
    // secondary takes the plain CC the same controller carries.
    engine.setMappings([
      {
        control: controlId("ch1", "insertFxOn"),
        addr: { type: "cc14", channel: 0, controller: 7 },
        mode: "absolute",
        button: "state",
      },
      {
        control: controlId("ch2", "insertFxOn"),
        addr: { type: "cc", channel: 0, controller: 7 },
        mode: "absolute",
        button: "state",
      },
    ]);

    engine.onMessage([0xb0, 7, 0]);
    expect(
      [plan.nodeParams.ch1?.insertFxOn, plan.nodeParams.ch2?.insertFxOn],
      "the plain CC's binding acted, and the mirror carried it",
    ).toEqual([false, false]);
  });
});
