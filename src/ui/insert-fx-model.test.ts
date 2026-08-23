// The insert-FX editor's value model. The engine-slot map is keyed by family + slot
// so a value stored by one effect is never read by the next one the selector names;
// the bare slot number is the device-shaped namespace a readback writes. A rendered
// panel shows the right number either way, so these are the only checks on it.

import { describe, expect, it } from "vitest";
import {
  insertFxVal,
  parkOutgoingInsertFxParams,
  pitchMidiMode,
  pitchKeyPatch,
  pitchScalePatch,
  reKeyInsertFxParams,
} from "./insert-fx-model";
import {
  PITCH_NOTE_SLOTS,
  PITCH_SCALE_CHROMATIC,
  PITCH_KEY_SLOT,
  PITCH_SCALE_CUSTOM,
  PITCH_SCALE_SINGLE,
  PITCH_SCALE_NATURAL_MINOR,
  PITCH_SCALE_HARMONIC_MINOR,
  PITCH_SCALE_MELODIC_MINOR,
  PITCH_SCALE_PENTATONIC,
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
  /** The semitones a patch turns on, as indices from C. */
  const onNotes = (patch: Record<number, number>): number[] =>
    PITCH_NOTE_SLOTS.map((s, i) => [i, patch[s]] as const)
      .filter(([, v]) => v === 1)
      .map(([i]) => i);

  it("turns every note on for Chromatic", () => {
    const patch = pitchScalePatch(PITCH_SCALE_CHROMATIC, 0);
    expect(patch[PITCH_SCALE_SLOT]).toBe(PITCH_SCALE_CHROMATIC);
    expect(PITCH_NOTE_SLOTS.every((s) => patch[s] === 1)).toBe(true);
  });

  it("clears exactly the non-major semitones for Major at C", () => {
    const patch = pitchScalePatch(PITCH_SCALE_MAJOR, 0);
    expect(patch[PITCH_SCALE_SLOT]).toBe(PITCH_SCALE_MAJOR);
    expect(onNotes(patch)).toEqual([0, 2, 4, 5, 7, 9, 11]);
  });

  // The slots are ABSOLUTE semitones, so the preset's offsets are rooted at the Key. A mask
  // written from C at another key is a different scale — which is what this app used to
  // send: Major at Key G reached the unit as C major, over the G major the unit had just
  // derived for itself. G major is C D E F# G A B.
  it("roots the pattern at the Key", () => {
    expect(onNotes(pitchScalePatch(PITCH_SCALE_MAJOR, 7))).toEqual([0, 2, 4, 6, 7, 9, 11]);
    // Single is the root alone, which is the clearest reading of the same rule.
    expect(onNotes(pitchScalePatch(PITCH_SCALE_SINGLE, 7))).toEqual([7]);
    expect(onNotes(pitchScalePatch(PITCH_SCALE_SINGLE, 0))).toEqual([0]);
  });

  it("authors every preset, each with the pattern the unit derives", () => {
    // Read off a URX44V at Key = C and Key = G; the offsets came back identical at both.
    const OFFSETS: Record<number, number[]> = {
      [PITCH_SCALE_SINGLE]: [0],
      [PITCH_SCALE_MAJOR]: [0, 2, 4, 5, 7, 9, 11],
      [PITCH_SCALE_NATURAL_MINOR]: [0, 2, 3, 5, 7, 8, 10],
      [PITCH_SCALE_HARMONIC_MINOR]: [0, 2, 3, 5, 7, 8, 11],
      [PITCH_SCALE_MELODIC_MINOR]: [0, 2, 3, 5, 7, 9, 11],
      [PITCH_SCALE_PENTATONIC]: [0, 2, 4, 7, 9],
    };
    for (const [scale, offsets] of Object.entries(OFFSETS)) {
      for (const key of [0, 3, 7, 11]) {
        const on = onNotes(pitchScalePatch(Number(scale), key));
        expect(
          on.slice().sort((a, b) => a - b),
          `scale ${scale} at key ${key}`,
        ).toEqual(offsets.map((o) => (o + key) % 12).sort((a, b) => a - b));
      }
    }
  });

  // The Key half of the same rule, which is the half that regressed: a mask rooted at C,
  // written at another key, is a different scale. The unit re-derives on a Key write, so a
  // plan written offline has to carry what it would have derived.
  it("re-roots the mask when the Key moves, keeping the scale it spells", () => {
    const patch = pitchKeyPatch(PITCH_SCALE_MAJOR, 7);
    expect(patch[PITCH_KEY_SLOT]).toBe(7);
    expect(patch[PITCH_SCALE_SLOT]).toBe(PITCH_SCALE_MAJOR);
    expect(onNotes(patch)).toEqual([0, 2, 4, 6, 7, 9, 11]); // G major, written from C
  });

  it("writes the Key alone under Custom, which names no pattern", () => {
    expect(pitchKeyPatch(PITCH_SCALE_CUSTOM, 7)).toEqual({
      [PITCH_KEY_SLOT]: 7,
      [PITCH_SCALE_SLOT]: PITCH_SCALE_CUSTOM,
    });
  });

  // Custom is not a pattern: it names whatever mask is already there, which is also what
  // the unit sets the enum to on its own when a note is edited.
  it("sets the scale slot alone for Custom", () => {
    expect(pitchScalePatch(PITCH_SCALE_CUSTOM, 7)).toEqual({ [PITCH_SCALE_SLOT]: PITCH_SCALE_CUSTOM });
  });
});

describe("pitch MIDI control tri-state", () => {
  it("folds the two engine bits into one three-way", () => {
    expect(pitchMidiMode(0, 0)).toBe(0);
    expect(pitchMidiMode(0, 1)).toBe(0); // enable off wins whatever realtime says
    expect(pitchMidiMode(1, 0)).toBe(1);
    expect(pitchMidiMode(1, 1)).toBe(2);
  });

  // There is no writer. Switching the enable bit on erases a full note mask, and the notes
  // it listens for arrive on a port of the unit's own — so this module decodes the mode and
  // has nothing that encodes one.
  it("carries no encoder", async () => {
    const mod = (await import("./insert-fx-model")) as Record<string, unknown>;
    expect(Object.keys(mod).filter((k) => /midi/i.test(k))).toEqual(["pitchMidiMode"]);
  });
});
