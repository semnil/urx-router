// @vitest-environment jsdom

// The EQ tuning screen's descriptor: what an edit writes back, which rows stop being
// the operator's and why, and what a control id binds to. `dyn-screen.test.ts` owns
// the host's contract; this file owns the EQ's own answers to it.
//
// Three separate things take a row away from the operator here, and they are not
// interchangeable — the rate (the device ignores a stereo channel's EQ above 96 kHz),
// the 1-knob (the device computes all four bands from one level) and the filter type
// (a pass filter reads no gain, the two mid bands have no type). A case that asserts
// "locked" without saying which of the three is asserting almost nothing, so each one
// below names its own tag as well.
//
// Rows are addressed by their label rather than by a data attribute: only the slider
// rows carry `data-dyn`, and three of the rows that matter here (the band's ON, the
// two 1-knob selectors) are a segmented choice and a select.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DynScreen } from "./dyn-screen";
import { DYN_PROCESSORS } from "./dyn-registry";
import { dynHost } from "./dyn-screen.test-util";
import type { DynHost } from "./dyn-screen.test-util";
import type { MidiLearnHooks } from "./midi-learn";
import { setLang, t } from "../i18n";

const EQ = DYN_PROCESSORS.eq;

let host: DynHost;

beforeEach(() => {
  setLang("en");
  localStorage.clear();
});

afterEach(() => {
  host?.restore();
  document.body.replaceChildren();
});

const open = (id = "ch1"): DynScreen => {
  const screen = new DynScreen(host.hooks);
  screen.open(EQ, id);
  return screen;
};

/** A section by its heading. Both sections that matter here carry a row labelled ON —
 *  the band's own and the 1-knob's — so an unscoped lookup silently answers with
 *  whichever the screen happened to build first. */
function section(title: string): HTMLElement {
  const hit = [...host.box.querySelectorAll<HTMLElement>(".prefs-section")].find((s) =>
    (s.firstElementChild?.textContent ?? "").startsWith(title),
  );
  if (!hit) throw new Error(`no section headed "${title}"`);
  return hit;
}

/** The settings row whose label reads `label`, inside `within` (default: the box). */
function row(label: string, within?: HTMLElement): HTMLElement {
  const scope = within ?? host.box;
  const hit = [...scope.querySelectorAll<HTMLElement>(".prefs-row")].find(
    (r) => r.querySelector(".lbl")?.textContent === label,
  );
  if (!hit) {
    const have = [...scope.querySelectorAll<HTMLElement>(".prefs-row .lbl")].map((l) => l.textContent).join(" / ");
    throw new Error(`no row labelled "${label}" (have: ${have})`);
  }
  return hit;
}

const locked = (label: string, within?: HTMLElement): boolean => row(label, within).classList.contains("locked");
const tagOf = (label: string, within?: HTMLElement): string | null =>
  row(label, within).querySelector(".prefs-lock")?.textContent ?? null;

/**
 * Move a slider row by `steps` of its own step, and let the screen see both events a
 * real drag ends with. Relative, not absolute: the frequency slider is an INDEX into
 * the device's frequency table (measured: min 0, max 1000, and index 265 = 125 Hz), so
 * writing a hertz value into it lands somewhere else entirely and the case then
 * asserts against a number nobody chose.
 */
function nudgeSlider(label: string, steps: number, within?: HTMLElement): void {
  const input = row(label, within).querySelector<HTMLInputElement>("input[type=range]")!;
  input.value = String(Number(input.value) + steps * Number(input.step || 1));
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Press one option of a segmented choice row. */
function choose(label: string, text: string, within?: HTMLElement): void {
  const btn = [...row(label, within).querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === text,
  )!;
  btn.click();
}

/** The band bar — for the EQ the segmented bar selects the band. */
const selectBand = (n: number): void => {
  [...host.box.querySelectorAll<HTMLButtonElement>(".gt-modes button")][n].click();
};

const PARAMS = (): HTMLElement => section(t().dynTuning.parameters);
const ONE_KNOB = (): HTMLElement => section(t().inspector.eqOneKnob);

// The band's five rows, by the labels they actually carry. The band's own on/off row
// is labelled "Band" rather than ON — the ON row belongs to the 1-knob section.
const BAND_ROWS = [
  t().dynTuning.eq.band,
  t().inspector.type,
  t().inspector.q,
  t().inspector.frequency,
  t().inspector.eqGain,
];

describe("what an edit writes back", () => {
  // The bands are an array and the 1-knob is a sibling object, so a patch has to be
  // split by key. Merged into one sub-object, an edit to one band would take the
  // other three with it.
  it("writes a band edit into that band alone", () => {
    host = dynHost();
    open();
    const before = host.plan.nodeParams["ch1"]!.eqBands!.map((b) => ({ ...b }));

    nudgeSlider(t().inspector.frequency, 20, PARAMS());

    const patch = host.patches.at(-1)!;
    expect(patch.id).toBe("ch1");
    expect(patch.patch.eqBands).toBeDefined();
    expect(patch.patch.eqOneKnob).toBeUndefined();
    const after = host.plan.nodeParams["ch1"]!.eqBands!;
    expect(after[0].freq).toBeGreaterThan(before[0].freq!);
    for (let i = 1; i < before.length; i++) expect(after[i]).toEqual(before[i]);
  });

  it("writes the selected band, not always the first", () => {
    host = dynHost();
    open();
    const before = host.plan.nodeParams["ch1"]!.eqBands!.map((b) => ({ ...b }));
    selectBand(2);
    nudgeSlider(t().inspector.frequency, 20, PARAMS());
    const bands = host.plan.nodeParams["ch1"]!.eqBands!;
    expect(bands[2].freq).toBeGreaterThan(before[2].freq!);
    expect(bands[0].freq).toBe(before[0].freq);
  });

  it("writes a 1-knob edit into eqOneKnob alone", () => {
    host = dynHost();
    open();
    choose(t().inspector.on, t().inspector.on, ONE_KNOB());
    const patch = host.patches.at(-1)!;
    expect(patch.patch.eqOneKnob).toEqual(expect.objectContaining({ on: true }));
    expect(patch.patch.eqBands).toBeUndefined();
  });

  it("keeps the band's other values when one of them is edited", () => {
    host = dynHost();
    open();
    selectBand(1);
    const q = host.plan.nodeParams["ch1"]!.eqBands![1].q;
    nudgeSlider(t().inspector.eqGain, 6, PARAMS());
    expect(host.plan.nodeParams["ch1"]!.eqBands![1].q).toBe(q);
    expect(host.plan.nodeParams["ch1"]!.eqBands![1].gain).toBe(3);
  });

  it("writes the 1-knob level as a number, not a string", () => {
    host = dynHost();
    host.plan.nodeParams["ch1"]!.eqOneKnob = { on: true, type: 0, level: 0 };
    open();
    nudgeSlider(t().inspector.eqOneKnobLevel, 4, ONE_KNOB());
    expect(host.plan.nodeParams["ch1"]!.eqOneKnob!.level).toBe(4);
    expect(typeof host.plan.nodeParams["ch1"]!.eqOneKnob!.level).toBe("number");
  });
});

describe("the rate lock", () => {
  // Above 96 kHz the unit does not apply a stereo channel's EQ at all — measured, a
  // 1 kHz high-pass passes 500 Hz untouched at 176.4 and 192 kHz while the parameters
  // are still stored and returned. So every row goes read-only, band and 1-knob alike,
  // and each says the rate is why.
  it("locks every row above 96 kHz, with the rate as the reason", () => {
    host = dynHost();
    host.plan.sampleRate = 192000;
    const screen = open("ch_5_6");
    expect(screen.isOpen()).toBe(true);

    for (const label of BAND_ROWS) {
      expect(locked(label, PARAMS()), `row "${label}"`).toBe(true);
      expect(tagOf(label, PARAMS())).toBe(t().inspector.eqRateLocked);
    }
    for (const label of [t().inspector.on, t().inspector.eqOneKnobType, t().inspector.eqOneKnobLevel]) {
      expect(locked(label, ONE_KNOB()), `row "${label}"`).toBe(true);
      expect(tagOf(label, ONE_KNOB())).toBe(t().inspector.eqRateLocked);
    }
  });

  it("leaves the rows editable at 96 kHz", () => {
    host = dynHost();
    host.plan.sampleRate = 96000;
    open("ch_5_6");
    expect(locked(t().inspector.frequency, PARAMS())).toBe(false);
  });
});

describe("the 1-knob", () => {
  const oneKnobOn = (): void => void (host.plan.nodeParams["ch1"]!.eqOneKnob = { on: true, type: 0, level: 0 });

  // With 1-knob on the device computes all four bands, so the band rows are reserved
  // out of sight rather than removed: a panel that changes height moves everything
  // below it — including Close — under the pointer.
  it("reserves the band rows rather than dropping them", () => {
    host = dynHost();
    oneKnobOn();
    open();
    for (const label of BAND_ROWS) {
      expect(row(label, PARAMS()).classList.contains("gt-reserved"), `row "${label}"`).toBe(true);
      expect(locked(label, PARAMS())).toBe(true);
    }
  });

  // The tags are kept rather than dropped: invisible, but a tag pill makes a row
  // taller, so keeping them is what makes a reserved row exactly as tall as the row it
  // stands in for.
  it("keeps a reserved row's tag so it stays the height it replaces", () => {
    host = dynHost();
    oneKnobOn();
    open();
    expect(tagOf(t().inspector.q, PARAMS())).toBe(t().dynTuning.eq.unusedByType);
  });

  // The empty space needs to say what owns those values, or five rows of nothing read
  // as a rendering fault.
  it("explains the reserved space", () => {
    host = dynHost();
    oneKnobOn();
    open();
    expect(host.box.querySelector(".gt-reserved-note")?.textContent).toBe(t().dynTuning.eq.oneKnobDrives);
  });

  // …but not when the rate has already taken the whole EQ: the note would claim the
  // 1-knob drives bands the device is ignoring outright.
  it("leaves the note off when the rate has locked the EQ instead", () => {
    host = dynHost();
    host.plan.sampleRate = 192000;
    host.plan.nodeParams["ch_5_6"]!.eqOneKnob = { on: true, type: 0, level: 0 };
    open("ch_5_6");
    expect(host.box.querySelector(".gt-reserved-note")).toBeNull();
  });

  // Type and Level stay on screen with 1-knob off, locked — the section would
  // otherwise shrink to one row on every toggle, moving everything under it.
  it("keeps its Type and Level rows on screen, locked, while it is off", () => {
    host = dynHost();
    open();
    expect(host.plan.nodeParams["ch1"]!.eqOneKnob?.on).not.toBe(true);
    expect(locked(t().inspector.eqOneKnobType, ONE_KNOB())).toBe(true);
    expect(locked(t().inspector.eqOneKnobLevel, ONE_KNOB())).toBe(true);
  });

  it("hands them back when it is switched on", () => {
    host = dynHost();
    oneKnobOn();
    open();
    expect(locked(t().inspector.eqOneKnobType, ONE_KNOB())).toBe(false);
    expect(locked(t().inspector.eqOneKnobLevel, ONE_KNOB())).toBe(false);
  });

  it("has no reserved rows while it is off", () => {
    host = dynHost();
    open();
    expect(host.box.querySelector(".gt-reserved")).toBeNull();
    expect(host.box.querySelector(".gt-reserved-note")).toBeNull();
  });
});

describe("the filter type", () => {
  // A row the type does not read stays visible and says why — the operator still owns
  // the band, unlike the two cases above.
  it("locks Q on a band that is not peaking, naming the type as the reason", () => {
    host = dynHost();
    open();
    expect(locked(t().inspector.q, PARAMS())).toBe(true);
    expect(tagOf(t().inspector.q, PARAMS())).toBe(t().dynTuning.eq.unusedByType);
    expect(locked(t().inspector.eqGain, PARAMS())).toBe(false);
  });

  // The two mid bands have no type at all — the device rejects the write (measured
  // 400) — so the row offers the one value it can be, locked, rather than vanishing.
  it("offers the mid bands their one fixed type, locked", () => {
    host = dynHost();
    open();
    selectBand(1);
    expect(locked(t().inspector.type, PARAMS())).toBe(true);
    expect(tagOf(t().inspector.type, PARAMS())).toBe(t().dynTuning.eq.fixedBand);
    expect(row(t().inspector.type, PARAMS()).querySelectorAll("option")).toHaveLength(1);
  });

  it("leaves Q editable once the band is peaking", () => {
    host = dynHost();
    open();
    selectBand(1); // a mid band is fixed peaking
    expect(locked(t().inspector.q, PARAMS())).toBe(false);
  });
});

describe("what a control id binds to", () => {
  // `markMidi` leaves no attribute behind, so the ids are collected through the hooks
  // the screen asks — which is also the only thing that proves a row was offered for
  // learning at all.
  const seenIds = (): { hooks: MidiLearnHooks; ids: string[] } => {
    const ids: string[] = [];
    return {
      ids,
      hooks: {
        learnActive: () => true,
        armedId: () => null,
        isMapped: () => false,
        addrOf: (id) => {
          ids.push(id);
          return null;
        },
        arm: () => {},
      },
    };
  };

  // A band value binds to THAT band, not to whichever the bar has selected: a mapping
  // has to keep working with this screen closed, and the bar resets to LOW on reopen.
  it("scopes a band row to its own band, and follows the bar", () => {
    const { hooks, ids } = seenIds();
    host = dynHost({ midi: hooks });
    open();
    const low = [...ids];
    expect(low.some((i) => i.includes("freq"))).toBe(true);

    ids.length = 0;
    selectBand(2);
    expect(ids.some((i) => i.includes("freq"))).toBe(true);
    expect(ids).not.toEqual(low);
  });

  // The 1-knob is the processor's own, so it takes the bare `eq` scope rather than a
  // band's — and the two enum selectors have no control at all, because a MIDI value
  // cannot pick a filter type.
  it("gives the 1-knob level a control and the type selectors none", () => {
    const { hooks, ids } = seenIds();
    host = dynHost({ midi: hooks });
    host.plan.nodeParams["ch1"]!.eqOneKnob = { on: true, type: 0, level: 0 };
    open();
    expect(ids.some((i) => i.includes("oneKnobLevel"))).toBe(true);
    expect(ids.some((i) => i.includes("oneKnob") && !i.includes("oneKnobLevel"))).toBe(true);
    expect(ids.some((i) => i.includes("oneKnobType"))).toBe(false);
    expect(ids.some((i) => i.includes("type"))).toBe(false);
  });
});
