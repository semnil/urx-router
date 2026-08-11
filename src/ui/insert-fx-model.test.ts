// The insert-FX editor's value model. The engine-slot map is keyed by family + slot
// so a value stored by one effect is never read by the next one the selector names;
// the bare slot number is the device-shaped namespace a readback writes. A rendered
// panel shows the right number either way, so these are the only checks on it.

import { describe, expect, it } from "vitest";
import {
  PITCH_MAJOR_ON,
  insertFxVal,
  parkOutgoingInsertFxParams,
  pitchMidiMode,
  pitchMidiPatch,
  pitchScalePatch,
  reKeyInsertFxParams,
} from "./insert-fx-model";
import {
  PITCH_MIDI_ENABLE_SLOT,
  PITCH_MIDI_REALTIME_SLOT,
  PITCH_NOTE_SLOTS,
  PITCH_SCALE_CHROMATIC,
  PITCH_SCALE_CUSTOM,
  PITCH_SCALE_MAJOR,
  PITCH_SCALE_SLOT,
  insertFxParamKey,
} from "../core/control/insert-fx-effect";
import { emptyPlan } from "../core/plan";
import type { Plan } from "../core/plan";

// A real selector value, so the family lookup resolves (a value with no family
// deliberately drops the bare slots instead of re-keying them).
const PITCH_SELECTOR = 512;

const planWith = (params: Record<string, number>, insertFx?: number): Plan => {
  const plan = emptyPlan("URX44V");
  plan.nodeParams["ch1"] = { insertFxParams: params, ...(insertFx === undefined ? {} : { insertFx }) };
  return plan;
};

describe("insertFxVal", () => {
  it("reads the family's own key first", () => {
    const plan = planWith({ [insertFxParamKey("mbc", 3)]: 42, "3": 7 });
    expect(insertFxVal(plan, "ch1", "mbc", 3, 0)).toBe(42);
  });

  // A readback writes bare slot numbers; they read as the selected family's until
  // the first edit replaces them with the qualified key.
  it("falls back to the bare slot a readback wrote", () => {
    expect(insertFxVal(planWith({ "3": 7 }), "ch1", "mbc", 3, 0)).toBe(7);
  });

  it("falls back to the caller's default when neither key is stored", () => {
    expect(insertFxVal(planWith({}), "ch1", "mbc", 3, 5)).toBe(5);
    expect(insertFxVal(emptyPlan("URX44V"), "ch1", "mbc", 3, 5)).toBe(5);
  });

  // Two families' slot 3 are different parameters under different laws.
  it("does not read another family's value for the same slot", () => {
    const plan = planWith({ [insertFxParamKey("pitch", 3)]: 99 });
    expect(insertFxVal(plan, "ch1", "mbc", 3, 0)).toBe(0);
  });

  it("reads a stored zero rather than skipping to the default", () => {
    expect(insertFxVal(planWith({ [insertFxParamKey("mbc", 3)]: 0 }), "ch1", "mbc", 3, 5)).toBe(0);
  });
});

describe("reKeyInsertFxParams", () => {
  it("writes under the family's key and drops the bare slot it came from", () => {
    const next = reKeyInsertFxParams({ "3": 7, "9": 1 }, "mbc", { 3: 42 });
    expect(next[insertFxParamKey("mbc", 3)]).toBe(42);
    expect(next["3"]).toBeUndefined();
    // Untouched slots keep their bare keys until they are edited in turn.
    expect(next["9"]).toBe(1);
  });

  it("leaves the input map alone", () => {
    const params = { "3": 7 };
    reKeyInsertFxParams(params, "mbc", { 3: 42 });
    expect(params).toEqual({ "3": 7 });
  });

  it("applies every slot in the patch", () => {
    const next = reKeyInsertFxParams({}, "pitch", { 1: 10, 2: 20 });
    expect(next[insertFxParamKey("pitch", 1)]).toBe(10);
    expect(next[insertFxParamKey("pitch", 2)]).toBe(20);
  });

  it("returns a copy when the patch is empty", () => {
    const params = { "3": 7 };
    const next = reKeyInsertFxParams(params, "mbc", {});
    expect(next).toEqual(params);
    expect(next).not.toBe(params);
  });
});

describe("parkOutgoingInsertFxParams", () => {
  // A bare slot left behind would be read as the NEW family's, whose slot means a
  // different parameter under a different law, and emitted as absolute state.
  it("qualifies the outgoing family's bare slots before the selector moves", () => {
    const plan = planWith({ "3": 7 }, PITCH_SELECTOR);
    const parked = parkOutgoingInsertFxParams(plan.nodeParams["ch1"])!;
    expect(parked["3"]).toBeUndefined();
    expect(parked[insertFxParamKey("pitch", 3)]).toBe(7);
  });

  // An entry the family already holds under its own key was authored; the bare one
  // was only read back, so the authored value wins.
  it("keeps an authored value over the bare one it shadows", () => {
    const plan = planWith({ "3": 7, [insertFxParamKey("pitch", 3)]: 42 }, PITCH_SELECTOR);
    expect(parkOutgoingInsertFxParams(plan.nodeParams["ch1"])![insertFxParamKey("pitch", 3)]).toBe(42);
  });

  it("has nothing to park on a node that carries no engine values", () => {
    expect(parkOutgoingInsertFxParams(undefined)).toBeNull();
    expect(parkOutgoingInsertFxParams({})).toBeNull();
  });

  // Nothing can address a bare slot with no family — the emit path needs one to
  // pick the slot layout — and leaving it is what lets the NEXT effect read values
  // another one wrote.
  it("drops the bare slots when the node names no effect", () => {
    const parked = parkOutgoingInsertFxParams({ insertFxParams: { "3": 7 } })!;
    expect(parked).toEqual({});
  });

  it("keeps an already-qualified value even with no family to park against", () => {
    const params = { [insertFxParamKey("pitch", 3)]: 7 };
    expect(parkOutgoingInsertFxParams({ insertFxParams: params })).toEqual(params);
  });
});

describe("pitch scale presets", () => {
  it("turns every note on for Chromatic", () => {
    const patch = pitchScalePatch(PITCH_SCALE_CHROMATIC);
    expect(patch[PITCH_SCALE_SLOT]).toBe(PITCH_SCALE_CHROMATIC);
    expect(PITCH_NOTE_SLOTS.every((s) => patch[s] === 1)).toBe(true);
  });

  // Calibration confirmed Major clears the five non-major semitones.
  it("clears exactly the non-major semitones for Major", () => {
    const patch = pitchScalePatch(PITCH_SCALE_MAJOR);
    expect(patch[PITCH_SCALE_SLOT]).toBe(PITCH_SCALE_MAJOR);
    const off = PITCH_NOTE_SLOTS.map((s, i) => [i, patch[s]] as const).filter(([, v]) => v === 0);
    expect(off.map(([i]) => i)).toEqual([1, 3, 6, 8, 10]);
    expect(PITCH_MAJOR_ON).toEqual(new Set([0, 2, 4, 5, 7, 9, 11]));
  });

  // Every other preset is a device value the app only displays, so it sets the scale
  // slot alone and leaves the note pattern as it was read back.
  it("sets the scale slot alone for a preset the app does not author", () => {
    expect(pitchScalePatch(PITCH_SCALE_CUSTOM)).toEqual({ [PITCH_SCALE_SLOT]: PITCH_SCALE_CUSTOM });
  });
});

describe("pitch MIDI control tri-state", () => {
  it("folds the two engine bits into one three-way", () => {
    expect(pitchMidiMode(0, 0)).toBe(0);
    expect(pitchMidiMode(0, 1)).toBe(0); // enable off wins whatever realtime says
    expect(pitchMidiMode(1, 0)).toBe(1);
    expect(pitchMidiMode(1, 1)).toBe(2);
  });

  it("writes the two bits back for each mode", () => {
    expect(pitchMidiPatch(0)).toEqual({ [PITCH_MIDI_ENABLE_SLOT]: 0, [PITCH_MIDI_REALTIME_SLOT]: 0 });
    expect(pitchMidiPatch(1)).toEqual({ [PITCH_MIDI_ENABLE_SLOT]: 1, [PITCH_MIDI_REALTIME_SLOT]: 0 });
    expect(pitchMidiPatch(2)).toEqual({ [PITCH_MIDI_ENABLE_SLOT]: 1, [PITCH_MIDI_REALTIME_SLOT]: 1 });
  });

  it("round-trips every mode through the bits and back", () => {
    for (const mode of [0, 1, 2] as const) {
      const bits = pitchMidiPatch(mode);
      expect(pitchMidiMode(bits[PITCH_MIDI_ENABLE_SLOT], bits[PITCH_MIDI_REALTIME_SLOT])).toBe(mode);
    }
  });
});
