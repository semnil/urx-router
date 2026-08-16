// @vitest-environment jsdom

// The morphing strip's three faces: what each one binds, what it puts on screen, where
// an edit lands in the plan's nested shape, and what moving between the faces does to
// the screen and to the meter registration.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const subscribed: Array<Array<[number, number]>> = [];
/** How long a registration takes to come back. Zero is the default, so every case that
 *  only reads `subscribed` stays synchronous; the overlap case gives it a duration,
 *  because two registrations cannot be observed overlapping if each finishes inside its
 *  own call. `peakInFlight` is what that case reads. */
let subDelayMs = 0;
let inFlight = 0;
let peakInFlight = 0;
/** The live registration's own callback, so a case can push a meter frame the way the
 *  broker would. The GR peak is folded here rather than off the store, so this is the
 *  only way in. */
let feedFrame: ((m: { meterId: number; x: number; value: number }) => void) | undefined;
vi.mock("../core/meters", async (importOriginal) => {
  const real = await importOriginal<typeof import("../core/meters")>();
  return {
    ...real,
    subscribeMeters: (
      store: { apply: (m: { meterId: number; x: number; value: number }) => void },
      addrs: Array<[number, number]>,
      onUpdate?: (m: { meterId: number; x: number; value: number }) => void,
    ) => {
      subscribed.push(addrs);
      // Both halves of a frame's path, so a case can push one the way the broker would:
      // the store is what a level lane paints from, and the callback is where the GR
      // peak is folded (deliberately not off the store, which is last-write-win).
      feedFrame = (m) => {
        store.apply(m);
        onUpdate?.(m);
      };
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      const done = (): (() => void) => {
        inFlight--;
        return () => {};
      };
      return subDelayMs
        ? new Promise<() => void>((r) => setTimeout(() => r(done()), subDelayMs))
        : Promise.resolve(done());
    },
  };
});

import { dynHost, pickBand, readouts, rowsByKey, segments } from "./dyn-screen.test-util";
import type { DynHost } from "./dyn-screen.test-util";
import { NAMED_TOKENS, recorder, vals } from "./dyn-plot.test-util";
import { DynScreen } from "./dyn-screen";
import { SC_SEL, SSMCS_COMP_DYN, SSMCS_DYN, SSMCS_EQ_DYN } from "./dyn-ssmcs";
import { COMP_DYN } from "./dyn-comp";
import { EQ_DYN } from "./dyn-eq";
import { FREQ_PAD } from "./dyn-freq-plot";
import { sidechainTap, tapFor, tapsFor } from "../core/meters";
import { COMP_EQ_COMP_FIRST, COMP_EQ_SSMCS, COMP_KNEE_OPTIONS } from "../core/control/params";
import { isSsmcsScKey, ssmcsCompFields, ssmcsMainFields, ssmcsPlanKey } from "../core/control/translate";
import type { DynField } from "../core/control/translate";
import { SSMCS_INITIAL } from "../core/plan";
import type { SsmcsParams } from "../core/plan";
import { setLang, t } from "../i18n";
import type { DynCtx, DynProcessor } from "./dyn-screen";

let h: DynHost | undefined;
let screen: DynScreen | undefined;

const ssmcsChannel = "ch1";

/** The host, with one mono channel switched into the morphing bank. */
function host(mode = COMP_EQ_SSMCS): DynHost {
  const created = dynHost({ plotSize: { w: 700, h: 320 } });
  created.plan.nodeParams[ssmcsChannel] = { ...created.plan.nodeParams[ssmcsChannel], compEqType: mode };
  return created;
}

const open = (proc: DynProcessor, host: DynHost): DynScreen => {
  const s = new DynScreen(host.hooks);
  s.open(proc, ssmcsChannel);
  return s;
};

const ctxOf = (host: DynHost, sel = 0): DynCtx => ({
  model: host.model,
  plan: host.plan,
  nodeId: ssmcsChannel,
  sel,
  m: t(),
});

/** The screen's parameter rows in the order they were built, by their visible label. */
const rowLabels = (box: HTMLElement): string[] =>
  [...box.querySelectorAll<HTMLElement>(".prefs-row")].map((r) => r.querySelector(".lbl")?.textContent ?? "");

/** Let the registration queue drain. Registrations are serialized — one is chained behind
 *  the previous one's SETTLEMENT — so the next is several microtask turns away rather than
 *  synchronous, and a counted number of `await Promise.resolve()` lands mid-chain. */
const settleSubs = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The plan's SSMCS sub-object after the screen's writes. */
const strip = (host: DynHost): SsmcsParams => host.plan.nodeParams[ssmcsChannel]?.ssmcs ?? {};

/** Drive a slider the way a drag does: set the position, fire `input`. */
function slide(input: HTMLInputElement, position: number): void {
  input.value = String(position);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  setLang("en");
  localStorage.clear();
  subscribed.length = 0;
  subDelayMs = 0;
  inFlight = 0;
  peakInFlight = 0;
});

afterEach(() => {
  screen?.close();
  screen = undefined;
  h?.restore();
  h = undefined;
  document.body.replaceChildren();
});

describe("which channels the morphing strip opens on", () => {
  // The exclusivity is one fact, so it is asserted from both sides: a COMP->EQ channel
  // refuses all three faces, and an SSMCS channel refuses the two screens the bank
  // replaces. Either half alone would pass with both banks offered at once.
  it("refuses a channel in COMP->EQ mode, where COMP and the 4-band EQ open", () => {
    h = host(COMP_EQ_COMP_FIRST);
    const ctx = ctxOf(h);
    for (const proc of [SSMCS_DYN, SSMCS_COMP_DYN, SSMCS_EQ_DYN]) expect(proc.bind(ctx)).toBeNull();
    expect(COMP_DYN.bind(ctx)).not.toBeNull();
    expect(EQ_DYN.bind(ctx)).not.toBeNull();
  });

  it("opens on a channel in SSMCS mode, where COMP and the 4-band EQ refuse", () => {
    h = host();
    const ctx = ctxOf(h);
    for (const proc of [SSMCS_DYN, SSMCS_COMP_DYN, SSMCS_EQ_DYN]) expect(proc.bind(ctx)).not.toBeNull();
    expect(COMP_DYN.bind(ctx)).toBeNull();
    expect(EQ_DYN.bind(ctx)).toBeNull();
  });

  it("refuses a stereo channel, which has no morphing strip at all", () => {
    h = host();
    h.plan.nodeParams.ch_5_6 = { ...h.plan.nodeParams.ch_5_6, compEqType: COMP_EQ_SSMCS };
    const ctx = { ...ctxOf(h), nodeId: "ch_5_6" };
    for (const proc of [SSMCS_DYN, SSMCS_COMP_DYN, SSMCS_EQ_DYN]) expect(proc.bind(ctx)).toBeNull();
  });
});

describe("the MAIN face", () => {
  beforeEach(() => {
    h = host();
    screen = open(SSMCS_DYN, h);
  });

  it("carries the preset selector and the three morphing sliders", () => {
    expect([...rowsByKey(h!.box).keys()]).toEqual(["compDrive", "morphing", "outGain"]);
    // The preset is a dropdown, not a slider, so it is the row `rows.lead` built.
    const preset = h!.box.querySelector<HTMLSelectElement>("select");
    expect(preset?.options.length).toBe(34);
    expect(rowLabels(h!.box)[0]).toBe(t().inspector.ssmcs.sweetSpotData);
  });

  // The reduction comes AFTER the output it was taken off, on this face as on every other:
  // it is merged into that column, and the tiles are in lane order. This face draws no rack
  // (its display is the two plots), so the order is the only thing the merge decides here.
  it("meters all four taps and prints them as four tiles", () => {
    const tiles = readouts(h!.box);
    expect(tiles.map((r) => r.label)).toEqual([
      t().dynTuning.comp.tapIn,
      t().dynTuning.comp.tapOut,
      t().dynTuning.comp.tapGr,
      t().dynTuning.ssmcs.tapOut,
    ]);
    // Two columns, which is what four tiles take.
    expect(h!.box.querySelector<HTMLElement>(".gt-readouts")?.style.getPropertyValue("--gt-ro-cols")).toBe("2");
    expect(tiles.filter((r) => r.gr).length).toBe(1);
  });

  it("shows the two curves without a lane rack", () => {
    expect(h!.box.querySelector("#dyn-curve")).not.toBeNull();
    expect(h!.box.querySelector(".gt-ladderbox")).toBeNull();
  });

  // The GR tile's peak is folded in the subscription's own callback rather than off the
  // store, because the store is last-write-win: a batch carrying more than one frame for
  // an address would drop all but the last before any reader saw them. This face has no
  // lane rack, so the tile is the only place that reduction is shown — and the fold keeps
  // the DEEPEST reduction, which is the lower number, not the later one.
  it("holds the deepest reduction on the GR tile", async () => {
    h!.setLive(true);
    screen!.refresh();
    await settleSubs();
    const paint = (): void => {
      for (let i = 0; i < 5; i++) h!.frame();
    };
    const gr = (): { value: string; peak: string } => readouts(h!.box).find((r) => r.gr)!;

    // COMP GR on CH 1 is meter 110, index 0; the wire is deci-dB, so -95 is -9.5 dB.
    feedFrame?.({ meterId: 110, x: 0, value: -95 });
    paint();
    expect(gr().peak).toContain("9.5");

    // A shallower reduction arrives: the readout follows it, the hold does not.
    feedFrame?.({ meterId: 110, x: 0, value: -20 });
    paint();
    expect(gr().value).toContain("2.0");
    expect(gr().peak).toContain("9.5");
  });

  it("writes an edit to the strip's own values", () => {
    // A value the factory capture does NOT hold, so "preserved" and "reset to factory"
    // are different readings — and read WITHOUT a fallback, or a patch that wiped the
    // sub-object would satisfy the assertion with the constant it names.
    h!.plan.nodeParams[ssmcsChannel] = {
      ...h!.plan.nodeParams[ssmcsChannel],
      ssmcs: { ...SSMCS_INITIAL, comp: { ...SSMCS_INITIAL.comp, attack: 200 } },
    };
    const rows = rowsByKey(h!.box);
    slide(rows.get("morphing")!, 62);
    expect(strip(h!).morphing).toBe(62);
    slide(rows.get("outGain")!, 200);
    expect(strip(h!).outGain).toBe(200);
    // The nested sub-objects the plan already held survive a top-level write.
    expect(strip(h!).comp?.attack).toBe(200);
    expect(strip(h!).sc?.freq).toBe(SSMCS_INITIAL.sc.freq);
  });

  it("writes the preset the selector picked", () => {
    const preset = h!.box.querySelector<HTMLSelectElement>("select")!;
    preset.value = "14";
    preset.dispatchEvent(new Event("change", { bubbles: true }));
    expect(strip(h!).sweetSpotData).toBe(14);
  });

  it("prints Comp Drive through the device's own curve, and Morphing as its raw position", () => {
    const box = h!.box;
    const text = (key: string): string => box.querySelector(`[data-dyn-val="${key}"]`)?.textContent ?? "";
    // raw 100 = 5.00 on the unit's display, raw 180 = 0.0 dB; Morphing has no unit and
    // reads as the number the device holds.
    expect(text("compDrive")).toBe("5.00");
    expect(text("outGain")).toBe("0.0 dB");
    expect(text("morphing")).toBe("0");
  });
});

describe("the COMP face", () => {
  beforeEach(() => {
    h = host();
    screen = open(SSMCS_COMP_DYN, h);
  });

  /** Press one of the bank bar's four segments. Re-queried per press: selecting rebuilds
   *  the column the bar is in, so a button held from before is no longer in the document. */
  const segment = (i: number): void => segments(h!.box)[i].click();
  /** This face's own two: the transfer curve, and the side-chain filter. */
  const CURVE_SEG = 1;
  const SC_SEG = 2;

  // Each segment carries the sliders whose effect is on the plot beside it, and nothing
  // else: a slider whose curve is not the one drawn moves nothing the operator can see.
  it("gives each segment the sliders that move the curve beside it", () => {
    expect([...rowsByKey(h!.box).keys()]).toEqual(["attack", "release", "ratio"]);
    // Knee closes the compressor's group, after Ratio rather than above everything, which
    // is where `lead` would have put it.
    const at = (label: string): number => rowLabels(h!.box).indexOf(label);
    expect(at(t().inspector.dyn.ratio)).toBeLessThan(at(t().inspector.dyn.knee));
    expect(at(t().inspector.ssmcs.sideChain)).toBe(-1);

    segment(SC_SEG);
    expect([...rowsByKey(h!.box).keys()]).toEqual(["scQ", "scFreq", "scGain"]);
    // And Side Chain opens the filter's group, above its first slider.
    const scAt = (label: string): number => rowLabels(h!.box).indexOf(label);
    expect(scAt(t().inspector.ssmcs.sideChain)).toBeLessThan(scAt(t().inspector.q));
    expect(scAt(t().inspector.dyn.knee)).toBe(-1);
  });

  it("switches the side-chain filter from the row above the filter's own sliders", () => {
    segment(SC_SEG);
    const off = [...h!.box.querySelectorAll<HTMLButtonElement>(".prefs-row .prefs-toggle button")].find(
      (b) => b.textContent === "OFF",
    )!;
    off.click();
    expect(strip(h!).sc?.on).toBe(false);
    // The compressor's own values are in a different sub-object and are not disturbed.
    expect(strip(h!).comp?.ratio).toBe(SSMCS_INITIAL.comp.ratio);
  });

  // One bar over the whole bank, and this face is two of its segments. COMP reuses the
  // shipped COMP screen's own hint rather than getting one of its own, because the picture
  // and the gesture are the same ones — asserted against the string because that reuse is a
  // claim the documents make and a count would pass with a second copy of the sentence.
  it("stands on the bank bar, and its two segments each say what they show", () => {
    const modes = [...h!.box.querySelectorAll<HTMLButtonElement>(".gt-modes button")];
    expect(modes.map((b) => b.textContent)).toEqual([
      t().dynTuning.ssmcs.faceMain,
      t().dynTuning.ssmcs.faceComp,
      // The filter's own row label, not a second spelling of the device's term.
      t().inspector.ssmcs.sideChain,
      t().dynTuning.ssmcs.faceEq,
    ]);
    modes[1].click();
    expect(h!.box.querySelector(".gt-note")?.textContent).toBe(t().dynTuning.comp.curveHint);
    modes[2].click();
    expect(h!.box.querySelector(".gt-note")?.textContent).toBe(t().dynTuning.ssmcs.scHint);
  });

  // Both segments stand beside a plot and both merge the reduction into the PRE EQ column
  // it was taken off — the DUCKER screen's arrangement. What differs is the side-chain
  // lane: the curve is the compressor's own pair, so it goes; the filter's face keeps it,
  // because what the filter DOES is the difference between the input and what the detector
  // hears, and dropping the input leaves that face unable to answer its own question.
  it("keeps the side-chain lane on the filter's segment and drops it on the curve's", () => {
    const lanesAt = (sel: number): { key: string; kind: string; sameSlot: boolean }[] =>
      SSMCS_COMP_DYN.bind(ctxOf(h!, sel))!.lanes.map((l) => ({
        key: l.key,
        kind: l.kind,
        sameSlot: l.sameSlot === true,
      }));
    expect(lanesAt(0)).toEqual([
      { key: "in", kind: "level", sameSlot: false },
      { key: "out", kind: "level", sameSlot: false },
      { key: "gr", kind: "gr", sameSlot: true },
    ]);
    expect(lanesAt(SC_SEL)).toEqual([
      { key: "in", kind: "level", sameSlot: false },
      { key: "sc", kind: "level", sameSlot: false },
      { key: "out", kind: "level", sameSlot: false },
      { key: "gr", kind: "gr", sameSlot: true },
    ]);
    // Four tiles want one row of four; three take the default.
    expect(SSMCS_COMP_DYN.bind(ctxOf(h!, SC_SEL))!.readoutCols).toBe(4);
    expect(SSMCS_COMP_DYN.bind(ctxOf(h!, 0))!.readoutCols).toBeUndefined();
    // The filter's segment adds exactly one address to the curve's.
    const taps = (sel: number): string[] =>
      SSMCS_COMP_DYN.bind(ctxOf(h!, sel))!
        .lanes.map((l) => JSON.stringify(l.tap ?? l.gr ?? null))
        .sort();
    expect(taps(SC_SEL).filter((x) => !taps(0).includes(x))).toEqual([
      JSON.stringify(sidechainTap(ssmcsChannel, h!.model.id)),
    ]);
  });

  // The side-chain lane is the compressor's key signal, not a point on the strip. It reads
  // `109`, which is the filter's output: measured on a URX44V, `109` - `108` = 0.0 dB with
  // the filter flat and swings the filter's full ±18 dB with it engaged, while the audio
  // path (`111` - `108`) does not move at all. So it stands between the input and the
  // reduction — the causal order — and it is NOT metered as a stage the audio passes.
  it("meters the side chain from 109, off the same channel as PRE COMP", () => {
    const sc = SSMCS_COMP_DYN.bind(ctxOf(h!, SC_SEL))!.lanes.find((l) => l.key === "sc")!;
    const pre = tapFor(ssmcsChannel, "precomp", h!.model.id)!;
    expect(sc.tap?.l).toEqual([109, pre.l[1]]);
    expect(sc.tap?.r).toBeUndefined();
    expect(sc.label).toBe(t().inspector.ssmcs.sideChain);
    // The negative control: `109` is not a console meter point. A channel's offered taps
    // are the chain the signal passes through, and this is not one of them — as a meter
    // point it would read floor on every channel that is not SSMCS with both its
    // compressor and its side chain on.
    expect(tapsFor(ssmcsChannel, h!.model.id).some((tp) => tp.l[0] === 109)).toBe(false);
  });

  it("shows the plot beside the lanes on both of its segments", () => {
    for (const i of [SC_SEG, CURVE_SEG]) {
      segment(i);
      expect(h!.box.querySelector(".gt-splitdisplay")).not.toBeNull();
      expect(h!.box.querySelector("#dyn-curve")).not.toBeNull();
      expect(h!.box.querySelector(".gt-ladderbox")).not.toBeNull();
    }
  });

  it("draws the side-chain lane from the feed, as a level rather than as a reduction", async () => {
    // Second of the four, and not a reduction cell: `109` is a level in dBFS, so it takes
    // the level ruler and none of the GR treatment.
    segment(SC_SEG);
    const cells = readouts(h!.box);
    expect(cells.map((c) => c.label)).toEqual([
      t().dynTuning.comp.tapIn,
      t().inspector.ssmcs.sideChain,
      t().dynTuning.comp.tapOut,
      t().dynTuning.comp.tapGr,
    ]);
    expect(cells[1].gr).toBe(false);
    expect(cells[3].gr).toBe(true);

    h!.setLive(true);
    screen!.refresh();
    await settleSubs();
    // The filter boosting: `108` at -40, `109` 12 dB above it. The lane shows `109`'s own
    // level rather than the difference — the difference is what the curve beside it draws.
    const paint = (): void => {
      for (let i = 0; i < 5; i++) h!.frame();
    };
    feedFrame!({ meterId: 108, x: 0, value: -400 });
    feedFrame!({ meterId: 109, x: 0, value: -280 });
    paint();
    expect(readouts(h!.box)[1].value).toContain("28");
    // And it follows `109` alone: moving PRE COMP does not move it.
    feedFrame!({ meterId: 108, x: 0, value: -200 });
    paint();
    expect(readouts(h!.box)[1].value).toContain("28");
    expect(readouts(h!.box)[0].value).toContain("20");
  });

  it("has no threshold cap on its input meter", () => {
    // The bank's corner is driven by a value the unit never shows, so the lane rack's
    // one gesture has no value to carry — the cap element must not be built at all.
    expect(h!.box.querySelector(".gt-cap")).toBeNull();
  });

  // The knee is the one row here that is a segmented choice rather than a slider, and it
  // is the only control on this face whose write nothing else reaches: the curve cases set
  // the knee in the PLAN and read what was drawn, so they would pass with the segment
  // wired to nothing. Driven from the catalogue rather than from three literals, so an
  // option added to `COMP_KNEE_OPTIONS` is pressed the day it appears.
  it("writes the knee the segment selected", () => {
    const buttons = (): HTMLButtonElement[] => {
      const row = [...h!.box.querySelectorAll<HTMLElement>(".prefs-row")].find(
        (r) => r.querySelector(".lbl")?.textContent === t().inspector.dyn.knee,
      )!;
      return [...row.querySelectorAll<HTMLButtonElement>("button")];
    };
    expect(buttons().map((b) => b.textContent)).toEqual(COMP_KNEE_OPTIONS.map((o) => o.label));
    for (const [i, opt] of COMP_KNEE_OPTIONS.entries()) {
      buttons()[i].click();
      expect(strip(h!).comp?.knee, opt.label).toBe(opt.value);
      // The pressed segment is the one that reads as pressed, and the compressor's other
      // values are a different key in the same sub-object and survive.
      expect(buttons()[i].getAttribute("aria-pressed"), opt.label).toBe("true");
      expect(strip(h!).comp?.ratio, opt.label).toBe(SSMCS_INITIAL.comp.ratio);
    }
  });

  it("splits a write between the compressor and the filter", () => {
    slide(rowsByKey(h!.box).get("attack")!, 200);
    segment(SC_SEG);
    slide(rowsByKey(h!.box).get("scFreq")!, 44);
    expect(strip(h!).comp?.attack).toBe(200);
    expect(strip(h!).sc?.freq).toBe(44);
    // Neither write flattened the other's group away.
    expect(strip(h!).sc?.q).toBe(SSMCS_INITIAL.sc.q);
    expect(strip(h!).comp?.ratio).toBe(SSMCS_INITIAL.comp.ratio);
  });

  it("prints every value through its own device curve", () => {
    const text = (key: string): string => h!.box.querySelector(`[data-dyn-val="${key}"]`)?.textContent ?? "";
    expect(text("attack")).toBe("4.126 ms");
    expect(text("release")).toBe("91.61 ms");
    expect(text("ratio")).toBe("2.50:1");
    segment(SC_SEG);
    expect(text("scQ")).toBe("1.00");
    expect(text("scFreq")).toBe("89 Hz");
    expect(text("scGain")).toBe("-4.7 dB");
  });
});

// The rows' ranges and grid come from the field tables in `core/control/translate.ts`,
// where every other screen's do — one raw step is one device detent, so a screen that
// carried its own numbers would let the slider stop between two values the unit has. The
// assertion is the WIRING, driven from the tables themselves: naming the numbers here
// would be the same constants written a second time, and they would agree however wrong
// both were.
describe("the sliders' ranges", () => {
  const check = (fields: readonly DynField[], box: HTMLElement): void => {
    const rows = rowsByKey(box);
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) {
      const el = rows.get(f.key);
      expect(el, f.key).toBeDefined();
      expect(el!.min, f.key).toBe(String(f.min));
      expect(el!.max, f.key).toBe(String(f.max));
      expect(el!.step, f.key).toBe(String(f.step));
    }
  };

  it("gives the MAIN face's three sliders the main table's", () => {
    h = host();
    screen = open(SSMCS_DYN, h);
    check(ssmcsMainFields(), h.box);
  });

  it("gives the COMP face's sliders the compressor table's, side chain included", () => {
    h = host();
    screen = open(SSMCS_COMP_DYN, h);
    const fields = ssmcsCompFields();
    // Each segment carries half the table, so each half is checked on the segment that
    // shows it — and the two halves are asserted to be the whole table, or a field that
    // reached neither segment would be checked by neither pass.
    const comp = fields.filter((f) => !isSsmcsScKey(f.key));
    const sc = fields.filter((f) => isSsmcsScKey(f.key));
    expect(comp.length + sc.length).toBe(fields.length);
    check(comp, h.box);
    segments(h.box)[2].click();
    check(sc, h.box);
  });

  // The table's default and a fresh channel's value are one fact, not two: both are the
  // factory capture. A default that drifted from it would seed a new plan with one value
  // and fall back to another on a plan that never carried the key.
  it("defaults every field to the factory capture", () => {
    for (const f of ssmcsMainFields()) expect(f.def, f.key).toBe(SSMCS_INITIAL[f.key as "compDrive"]);
    for (const f of ssmcsCompFields()) {
      const from = isSsmcsScKey(f.key) ? SSMCS_INITIAL.sc : SSMCS_INITIAL.comp;
      expect(f.def, f.key).toBe((from as Record<string, number>)[ssmcsPlanKey(f.key)]);
    }
  });
});

describe("the EQ face", () => {
  beforeEach(() => {
    h = host();
    screen = open(SSMCS_EQ_DYN, h);
  });

  const band = (name: "LOW" | "MID" | "HIGH"): void => pickBand(h!.box, { LOW: 0, MID: 1, HIGH: 2 }[name]);

  it("keeps four rows on every band, with the shelves' Q locked", () => {
    for (const name of ["LOW", "MID", "HIGH"] as const) {
      band(name);
      expect([...rowsByKey(h!.box).keys()], name).toEqual(["q", "freq", "gain"]);
      expect(h!.box.querySelectorAll(".prefs-row").length, name).toBe(4);
      const q = rowsByKey(h!.box).get("q")!;
      expect(q.disabled, `${name} Q`).toBe(name !== "MID");
    }
  });

  it("meters the two taps that bracket the EQ", () => {
    expect(readouts(h!.box).map((r) => r.label)).toEqual([t().dynTuning.comp.tapOut, t().dynTuning.ssmcs.tapOut]);
  });

  it("writes to the band the bar has selected, leaving the others alone", () => {
    band("MID");
    slide(rowsByKey(h!.box).get("gain")!, 243);
    expect(strip(h!).eq?.mid?.gain).toBe(243);
    band("HIGH");
    slide(rowsByKey(h!.box).get("freq")!, 100);
    expect(strip(h!).eq?.high?.freq).toBe(100);
    expect(strip(h!).eq?.mid?.gain).toBe(243);
    expect(strip(h!).eq?.low?.freq).toBe(SSMCS_INITIAL.eq.low.freq);
  });

  it("toggles the band the bar has selected", () => {
    band("MID");
    h!.box.querySelectorAll<HTMLButtonElement>(".prefs-row .prefs-toggle button")[1].click(); // OFF
    expect(strip(h!).eq?.mid?.on).toBe(false);
    expect(strip(h!).eq?.low?.on).toBe(SSMCS_INITIAL.eq.low.on);
  });

  it("offers each band its own frequency floor as well as its ceiling", () => {
    band("LOW");
    expect(rowsByKey(h!.box).get("freq")!.min).toBe("4");
    band("MID");
    expect(rowsByKey(h!.box).get("freq")!.min).toBe("4");
  });

  it("offers each band its own frequency range", () => {
    band("LOW");
    expect(rowsByKey(h!.box).get("freq")!.max).toBe("72");
    band("HIGH");
    expect(rowsByKey(h!.box).get("freq")!.min).toBe("60");
    band("MID");
    expect(rowsByKey(h!.box).get("freq")!.max).toBe("124");
  });

  // A shelf carries no Q on the device, so the locked row has no value of its own to
  // show. What stands in it is MID's factory Q — the value, not a zero and not the band's
  // own missing one, so the row reads as a number the way its neighbours do.
  it("stands MID's factory Q in the shelves' locked row", () => {
    const shown = (): string => h!.box.querySelector('[data-dyn-val="q"]')?.textContent ?? "";
    band("MID");
    const midQ = shown();
    expect(midQ).not.toBe("");
    for (const name of ["LOW", "HIGH"] as const) {
      band(name);
      expect(shown(), name).toBe(midQ);
    }
    // And it is the FACTORY value that stands there, not whatever MID happens to hold:
    // moving MID's Q must not move what the shelves display.
    band("MID");
    slide(rowsByKey(h!.box).get("q")!, SSMCS_INITIAL.eq.mid.q + 8);
    const moved = shown();
    expect(moved).not.toBe(midQ);
    band("LOW");
    expect(shown()).toBe(midQ);
  });

  // No band bar to read a pressed state off, so the band on screen is named by what the
  // Parameters heading carries — the band's own name.
  const shownBand = (): string | undefined =>
    h!.box.querySelector<HTMLElement>(".prefs-section .prefs-lock")?.textContent ?? undefined;

  it("starts on LOW every time it opens", () => {
    band("HIGH");
    expect(shownBand()).toBe(t().inspector.ssmcs.bands.high);
    screen!.close();
    screen = open(SSMCS_EQ_DYN, h!);
    expect(shownBand()).toBe(t().inspector.ssmcs.bands.low);
  });
});

describe("moving between the faces", () => {
  beforeEach(() => {
    h = host();
    h.setLive(true);
    screen = open(SSMCS_DYN, h);
  });

  const face = (name: "main" | "comp" | "eq"): HTMLButtonElement =>
    h!.box.querySelector<HTMLButtonElement>(`#dyn-face-ssmcs-${name}`)!;

  it("keeps one title and moves the pressed segment", () => {
    const title = (): string => h!.box.querySelector("#dyn-screen-title")?.textContent ?? "";
    expect(title()).toContain(t().inspector.ssmcs.title);
    expect(face("main").getAttribute("aria-pressed")).toBe("true");
    face("comp").click();
    // Naming each face would print the shipped COMP screen's own title here.
    expect(title()).toContain(t().inspector.ssmcs.title);
    expect(title()).not.toContain(t().dynTuning.comp.title);
    expect(face("comp").getAttribute("aria-pressed")).toBe("true");
    expect(face("main").getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps the face segment out of the heading the dialog names itself with", () => {
    // #dyn-screen-modal carries aria-labelledby="dyn-screen-title", so a button inside
    // that heading joins the dialog's accessible name.
    const heading = h!.box.querySelector("#dyn-screen-title")!;
    expect(heading.querySelectorAll("button").length).toBe(0);
    expect(heading.textContent).toBe(`CH 1${t().inspector.ssmcs.title}`);
    expect(face("comp").isConnected).toBe(true);
  });

  it("stays open on the same channel rather than closing and reopening", () => {
    const closes = h!.closed();
    face("eq").click();
    expect(screen!.isOpen()).toBe(true);
    expect(h!.closed()).toBe(closes);
    expect(h!.box.querySelector("#dyn-screen-title")?.textContent).toContain("CH 1");
  });

  it("re-subscribes to the face's own taps", async () => {
    const last = (): string => subscribed[subscribed.length - 1].map((a) => a.join(":")).join(",");
    const mono = 0; // CH 1's index in the meter tables
    expect(last()).toBe(`108:${mono},111:${mono},110:${mono},112:${mono}`);
    face("comp").click();
    await settleSubs();
    // COMP opens on the transfer curve, which is the compressor's own pair — one address
    // fewer than MAIN, and not the side chain's `109`. The order is the RACK's, and this
    // face merges the reduction onto the output column, so `111` comes before `110`.
    expect(last()).toBe(`108:${mono},111:${mono},110:${mono}`);
    // Its other segment adds exactly that one, which is what makes moving between the two
    // a re-subscription rather than a redraw.
    segments(h!.box)[2].click();
    await settleSubs();
    expect(last()).toBe(`108:${mono},109:${mono},111:${mono},110:${mono}`);
    face("eq").click();
    await settleSubs();
    expect(last()).toBe(`111:${mono},112:${mono}`);
    face("main").click();
    await settleSubs();
    expect(last()).toBe(`108:${mono},111:${mono},110:${mono},112:${mono}`);
  });

  // The registrations are serialized because a session holds ONE meter subscription and a
  // subscribe replaces it silently: two in flight together land in the order the transport
  // delivered them, which can be the face that was left — and the screen's own handle then
  // unsubscribes addresses the later call had already replaced, so the meters stop with
  // nothing raised. What the serialization buys is that the LAST registration issued is
  // the last one the broker sees. Registration is given a duration here, because two that
  // each finish inside their own call cannot be caught overlapping.
  it("never has two registrations in flight at once", async () => {
    subDelayMs = 5;
    peakInFlight = 0;
    face("comp").click();
    face("eq").click();
    face("main").click();
    await settleSubs(80);
    expect(peakInFlight).toBe(1);
    const mono = 0;
    expect(subscribed[subscribed.length - 1].map((a) => a.join(":")).join(",")).toBe(
      `108:${mono},111:${mono},110:${mono},112:${mono}`,
    );
  });

  // A GR peak hold is a caption's worth of history, and every face reads a DIFFERENT
  // address set. Carried across a move it would print the peak of one tap under another
  // tap's caption — the COMP face's GR under MAIN's, which is the same lane key and a
  // different meaning. The hold is dropped rather than re-derived, because the value it
  // would need has not arrived yet on the face being moved to.
  it("drops the peak holds when the face moves", async () => {
    const paint = (): void => {
      for (let i = 0; i < 5; i++) h!.frame();
    };
    const peak = (): string => readouts(h!.box)[0].peak;
    // The cell prints its prefix whether or not it holds anything, so "nothing held" is
    // this string and not the empty one — comparing against the bare dash would pass on
    // every reading there is.
    const nothing = `${t().dynTuning.peakPrefix} ${t().dynTuning.noReading}`;
    expect(peak()).toBe(nothing);

    // Pre Comp on CH 1: meter 108, index 0. Loud, so the hold is unmistakably a hold.
    feedFrame?.({ meterId: 108, x: 0, value: -60 });
    paint();
    const held = peak();
    expect(held).not.toBe(nothing);

    face("comp").click();
    await settleSubs();
    paint();
    // The COMP face reads the same first tap, so the caption is the same one — which is
    // exactly why a carried hold would be invisible here rather than obviously wrong.
    expect(peak()).toBe(nothing);
  });

  // A face is moved to with Enter or Space as well as with the pointer, and the press
  // replaces the whole dialog body — the button that was pressed included. Without the
  // restore, `document.activeElement` falls back to the body and a keyboard user has to
  // tab in from the top of the modal again.
  it("leaves focus on the face segment it was pressed from", () => {
    face("comp").focus();
    face("comp").click();
    expect(document.activeElement?.id).toBe("dyn-face-ssmcs-comp");
    // The new button, not the detached one the press was made on.
    expect(document.activeElement?.isConnected).toBe(true);
  });

  // The other half of the same rule: a pointer press must not leave focus behind on a
  // control the operator never focused.
  it("does not take focus on a press that came from nowhere", () => {
    (document.activeElement as HTMLElement | null)?.blur();
    face("eq").click();
    expect(document.activeElement?.id).not.toBe("dyn-face-ssmcs-eq");
  });

  it("closes itself when the channel leaves the morphing bank underneath it", () => {
    face("comp").click();
    h!.plan.nodeParams[ssmcsChannel] = { ...h!.plan.nodeParams[ssmcsChannel], compEqType: COMP_EQ_COMP_FIRST };
    screen!.refresh();
    expect(screen!.isOpen()).toBe(false);
  });
});

describe("what the curves draw", () => {
  beforeEach(() => {
    h = host();
  });

  /** Every `fillText` the descriptor made, with the style it was drawn in. */
  const draw = (proc: DynProcessor, sel = 0): void => {
    const ctx = ctxOf(h!, sel);
    const geo = proc.plotGeo(700, 320, ctx);
    proc.drawAxes(h!.canvas.ctx, geo, NAMED_TOKENS, ctx);
    proc.drawCurve(h!.canvas.ctx, geo, vals(), NAMED_TOKENS, ctx);
  };

  /** The curve's own points, on a recorder nothing else has drawn into. */
  const recordCurve = (proc: DynProcessor, sel = 0): ReturnType<typeof recorder> => {
    const ctx = ctxOf(h!, sel);
    const rec = recorder();
    proc.drawCurve(rec.ctx, proc.plotGeo(700, 320, ctx), vals(), NAMED_TOKENS, ctx);
    return rec;
  };
  /** The 120-segment stroke, before any annotation. */
  const curveYs = (proc: DynProcessor, sel = 0): number[] => recordCurve(proc, sel).ys.slice(0, 121);

  /** The reduction annotation's text, by the token it is drawn in, on a recorder nothing
   *  else has drawn into — the shared canvas KEEPS what earlier draws put there, so a case
   *  that walks several settings would read the first one's label back at the second. Named
   *  once for a second reason: a `--gr` that moved would leave every copy of this filter
   *  matching nothing, and a copy asserting a count would stay green on the empty list. */
  const grTexts = (proc: DynProcessor = SSMCS_COMP_DYN, sel = 0): string[] =>
    recordCurve(proc, sel)
      .texts.filter((tx) => tx.style === "--gr")
      .map((tx) => tx.text);

  /** Put the strip's compressor at one setting, everything else factory. Comp Drive is a
   *  second argument rather than a helper of its own because the corner is a function of
   *  BOTH it and the threshold, so a case about the corner has to set the pair. */
  const withComp = (comp: Partial<typeof SSMCS_INITIAL.comp>, compDrive = SSMCS_INITIAL.compDrive): void => {
    h!.plan.nodeParams[ssmcsChannel] = {
      ...h!.plan.nodeParams[ssmcsChannel],
      ssmcs: { ...SSMCS_INITIAL, compDrive, comp: { ...SSMCS_INITIAL.comp, ...comp } },
    };
  };

  // ---- the COMP face's third segment: the side-chain filter ------------------------
  //
  // The plot's whole job is to move with Q, Freq and Gain, so each of the three is moved
  // on its own and the curve is asked what changed. Reading the drawn geometry rather
  // than the response function keeps the descriptor in the loop: a face wired to the
  // wrong state, or to no state, passes a test of the model alone.

  /** Put the side-chain filter at one setting, everything else factory. Typed against the
   *  plan's shape rather than the factory capture's, whose `on` is the literal `true`. */
  const withSc = (sc: Partial<{ on: boolean; q: number; freq: number; gain: number }>): void => {
    h!.plan.nodeParams[ssmcsChannel] = {
      ...h!.plan.nodeParams[ssmcsChannel],
      ssmcs: { ...SSMCS_INITIAL, sc: { ...SSMCS_INITIAL.sc, ...sc } },
    };
  };
  /** The frequency plot is sampled per PIXEL COLUMN, not in the transfer plot's 120
   *  segments, so `curveYs` above would slice the curve off inside its first octave. The
   *  points come out in one run per stroke, and the fill traces the same points first,
   *  so the leading run is the curve whether or not the face shades it. */
  const SC_W = 700;
  const SC_COLS = SC_W - FREQ_PAD.l - FREQ_PAD.r + 1;
  /** Pixels per octave on that plot, from the frame the geo actually builds. */
  const PX_PER_OCT = (SC_W - FREQ_PAD.l - FREQ_PAD.r) / Math.log2(20000 / 20);
  const scYs = (): { ys: number[]; zero: number } => {
    const ctx = ctxOf(h!, SC_SEL);
    const rec = recorder();
    const geo = SSMCS_COMP_DYN.plotGeo(SC_W, 320, ctx);
    SSMCS_COMP_DYN.drawCurve(rec.ctx, geo, vals(), NAMED_TOKENS, ctx);
    // The baseline is the plot's OWN 0 dB line, not the curve's leftmost sample: the
    // filter's factory frequency is 89 Hz, where a bell still has most of its skirt
    // inside the frame at 20 Hz, and taking that sample as zero measured a bell half
    // again as wide as the one drawn.
    return { ys: rec.ys.slice(0, SC_COLS), zero: geo.py(0) };
  };

  /** dB per pixel down the gain axis, from the frame the geo builds: the axis spans
   *  +18 .. -18 over the padded height. */
  const PX_PER_DB = (320 - FREQ_PAD.t - FREQ_PAD.b) / 36;

  /** Where the curve's extremum sits, what it PLOTS there in dB (positive = above the
   *  0 dB line), and how many OCTAVES wide it is at half that — which is the reading a Q
   *  is, and the one a pixel count would leave a reader to convert. */
  const peak = (): { at: number; plottedDb: number; octaves: number } => {
    const { ys, zero } = scYs();
    let at = 0;
    for (let i = 0; i < ys.length; i++) if (Math.abs(ys[i] - zero) > Math.abs(ys[at] - zero)) at = i;
    const half = Math.abs(ys[at] - zero) / 2;
    const inside = ys.filter((y) => Math.abs(y - zero) >= half).length;
    return { at, plottedDb: (zero - ys[at]) / PX_PER_DB, octaves: inside / PX_PER_OCT };
  };

  it("moves the side-chain curve with the frequency set on it", () => {
    withSc({ freq: 32 }); // raw 32 = 100 Hz
    const low = peak().at;
    withSc({ freq: 112 }); // raw 112 = 10 kHz
    const high = peak().at;
    expect(low).toBeLessThan(high);
  });

  // The plot is the REDUCTION the filter buys, not the gain it applies: lifting a band in
  // the detector makes the compressor clamp down harder there, so a boost draws DOWNWARD.
  // Asserted as the plotted value in dB rather than as a sign, because the magnitude is
  // the half that a flipped-but-scaled curve would still satisfy.
  it("draws a boost as reduction, downward, and a cut upward", () => {
    withSc({ freq: 72, gain: 360 }); // filter +18 dB
    expect(peak().plottedDb).toBeCloseTo(-18, 0);
    withSc({ freq: 72, gain: 240 }); // filter +6 dB
    expect(peak().plottedDb).toBeCloseTo(-6, 0);
    withSc({ freq: 72, gain: 0 }); // filter -18 dB
    expect(peak().plottedDb).toBeCloseTo(18, 0);
  });

  it("narrows it with the Q, by the measured law rather than the number on the screen", () => {
    withSc({ q: 0, freq: 72, gain: 360 }); // displayed Q 0.50 at 1 kHz
    const wide = peak().octaves;
    withSc({ q: 60, freq: 72, gain: 360 }); // displayed Q 16.0
    const narrow = peak().octaves;
    expect(narrow).toBeLessThan(wide);
    // The device's Q is NOT the biquad's: the strip's bell measures 0.238 x Q x A^0.39,
    // so a displayed 1.00 at +18 dB is a biquad Q near 0.356 and the bell is far wider
    // than its number reads -- 3.3 octaves at half gain against the 1.4 the displayed
    // number would give if taken at face value. Pinned as that span, so a "correction"
    // back to the printed Q fails here rather than drawing a bell the unit does not have.
    withSc({ q: 12, freq: 72, gain: 360 }); // displayed 1.00 at 1 kHz
    expect(peak().octaves).toBeGreaterThan(2.9);
    expect(peak().octaves).toBeLessThan(3.7);
  });

  it("draws flat when the filter is switched out, and when it is set to 0 dB", () => {
    for (const sc of [
      { on: false, gain: 360 },
      { on: true, gain: 180 },
    ]) {
      withSc(sc);
      const { ys } = scYs();
      expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(0.5);
    }
  });

  // The two flat states are not the same state — the filter switched out, and the filter
  // engaged doing nothing — and the curve cannot tell them apart. The marker is where
  // that distinction lives, so it is what this asserts.
  it("dims the marker only when the filter is switched out", () => {
    const marker = (): { style: string; alpha: number; y: number } => {
      const rec = recorder();
      const ctx = ctxOf(h!, SC_SEL);
      SSMCS_COMP_DYN.drawCurve(rec.ctx, SSMCS_COMP_DYN.plotGeo(700, 320, ctx), vals(), NAMED_TOKENS, ctx);
      const tx = rec.texts.find((t2) => t2.text === "SC")!;
      return { style: tx.style, alpha: tx.alpha, y: tx.y };
    };
    withSc({ on: true, freq: 72, gain: 360 });
    const lit = marker();
    expect(lit.style).toBe("--plot-ink");
    expect(lit.alpha).toBe(1);

    withSc({ on: false, freq: 72, gain: 360 });
    const out = marker();
    expect(out.alpha).toBeLessThan(1);
    // And it rises to the 0 dB line with the curve, rather than staying at the reduction
    // the filter is set to buy while the filter is switched out. Up, because a +18 dB
    // filter plots as -18 dB of reduction — near the bottom of the frame.
    expect(out.y).toBeLessThan(lit.y);

    // The other flat state is NOT dimmed: engaged at 0 dB is a filter that is running and
    // doing nothing, which is the distinction this marker exists to carry.
    withSc({ on: true, freq: 72, gain: 180 });
    const flat = marker();
    expect(flat.alpha).toBe(1);
    expect(flat.y).toBeCloseTo(out.y, 5);
  });

  // Found by looking at the thing rather than by asserting about it: at +18 dB the pill
  // sat exactly on the clip's top edge and lost its upper half. The value was right and
  // every DOM assertion passed.
  it("keeps the marker whole inside the frame at full boost and full cut", () => {
    const ctx = ctxOf(h!, SC_SEL);
    const geo = SSMCS_COMP_DYN.plotGeo(700, 320, ctx);
    for (const gain of [360, 0]) {
      withSc({ on: true, freq: 72, gain });
      const rec = recorder();
      SSMCS_COMP_DYN.drawCurve(rec.ctx, geo, vals(), NAMED_TOKENS, ctx);
      // The pill is the face the label was written on: the one covering the marker's x.
      const label = rec.texts.find((t2) => t2.text === "SC")!;
      const pill = rec.faces.find((f) => f.x0 <= label.x && f.x1 >= label.x && f.y1 - f.y0 < 20)!;
      expect(pill.y0, `gain ${gain}`).toBeGreaterThanOrEqual(geo.pad.t);
      expect(pill.y1, `gain ${gain}`).toBeLessThanOrEqual(320 - geo.pad.b);
    }
  });

  // The one plot in this app that shades the area under its curve, and the reason is that
  // here the area is the reading: the band the compressor was made to react to. A change
  // that drops the fill leaves a curve that looks like the EQ's and says something else.
  it("shades the area under the side-chain curve, which no other face does", () => {
    withSc({ on: true, gain: 360 });
    const shaded = (proc: DynProcessor, sel: number): number => {
      const rec = recorder();
      const ctx = ctxOf(h!, sel);
      proc.drawCurve(rec.ctx, proc.plotGeo(700, 320, ctx), vals(), NAMED_TOKENS, ctx);
      return rec.faces.filter((f) => f.style === "--led" && f.x1 - f.x0 > 400).length;
    };
    expect(shaded(SSMCS_COMP_DYN, SC_SEL)).toBe(1);
    expect(shaded(SSMCS_EQ_DYN, 0)).toBe(0);
    expect(shaded(SSMCS_COMP_DYN, 0)).toBe(0); // the transfer plot, this face's other segment
  });

  // Two levels plotted against a frequency axis is a reading of nothing, so the side-chain
  // segment carries no live dot. Asserted through `liveOn`, which is what the HOST reads —
  // it decides whether to repaint the canvas at all, so a segment that answered true and
  // then drew nothing would cost a full clear + blit per feed frame for no pixel change.
  // The dot itself is asserted on the segment that has one, or "no dot" would pass against
  // a `drawLive` that had stopped drawing anywhere.
  it("puts no live dot on the side chain's frequency axes", () => {
    expect(SSMCS_COMP_DYN.liveOn?.(ctxOf(h!, 0))).toBe(true);
    expect(SSMCS_COMP_DYN.liveOn?.(ctxOf(h!, SC_SEL))).toBe(false);

    const ctx = ctxOf(h!, 0);
    const rec = recorder();
    SSMCS_COMP_DYN.drawLive?.(rec.ctx, SSMCS_COMP_DYN.plotGeo(700, 320, ctx), () => -12, NAMED_TOKENS, ctx);
    expect(rec.faces.length).toBeGreaterThan(0); // in against out, which the dot means
  });

  // Out Gain reached NEITHER curve before this, so a slider worth ±18 dB moved nothing on
  // screen. It is drawn on the compressor's baseline: the unit applies it after the EQ
  // (measured — `117` moves tap `112` one-for-one and leaves `108` and `111` alone), but
  // the EQ plot's gain axis IS the band gain range, so an offset there pushes the response
  // off the frame. Both halves are asserted, because "on the EQ curve" is the arrangement
  // this replaced and each direction is its own defect.
  it("puts Out Gain on the compressor's baseline and not on the EQ's curve", () => {
    const withOut = (outGain: number): void => {
      h!.plan.nodeParams[ssmcsChannel] = {
        ...h!.plan.nodeParams[ssmcsChannel],
        ssmcs: { ...SSMCS_INITIAL, outGain },
      };
    };
    const eqYs = (proc: DynProcessor, sel = 0): number[] => recordCurve(proc, sel).ys;
    withOut(180); // 0.0 dB
    const eqFlat = eqYs(SSMCS_EQ_DYN);
    const compFlat = eqYs(SSMCS_COMP_DYN, 0);
    withOut(300); // +12.0 dB
    // The whole transfer curve rises by the gain. Its output axis runs -54 .. +18, so
    // 12 dB is 12/72 of the padded height — asserted as that rather than as "it moved",
    // which a curve carrying the gain twice would also satisfy.
    const geo = SSMCS_COMP_DYN.plotGeo(700, 320, ctxOf(h!, 0));
    const perDb = (geo.py(-54) - geo.py(18)) / 72;
    const compLifted = eqYs(SSMCS_COMP_DYN, 0);
    expect(compLifted.length).toBe(compFlat.length);
    // The 120-segment stroke only: the two points after it are the reduction annotation's
    // dashed line, which is read off the curve with the gain terms taken back out and so
    // correctly does NOT move with Out Gain.
    for (let i = 0; i < 121; i++) expect(compFlat[i] - compLifted[i], `point ${i}`).toBeCloseTo(12 * perDb, 1);
    // And the EQ's curve does not move at all — the axis it would have run off is the
    // reason the gain is drawn on the other plot.
    expect(eqYs(SSMCS_EQ_DYN)).toEqual(eqFlat);
  });

  it("labels the reduction the ratio buys at full scale, with the gain terms taken back out", () => {
    draw(SSMCS_COMP_DYN);
    // Factory: threshold raw 100 and Comp Drive raw 100, which put the corner at
    // 0.2 x (100 - 100) - 20 = -20 dBFS; ratio raw 30 -> 2.50:1; knee raw 1 (Medium)
    // reaches 10.0 dB above the corner, so 0 dBFS is past the knee and lands on the
    // asymptote at -20 + 20/2.5 = -12.0. The VALUE is the assertion — a count passes
    // whatever number the model computed, which is how a wrong corner would go unseen.
    expect(grTexts()).toEqual(["-12.0 dB"]);
  });

  it("ramps the corner from full scale below the drive the threshold takes over at", () => {
    // Drive raw 20 with the threshold at its minimum: the corner is 20/31 of the -26.2 dBFS
    // the threshold asks for at the ramp's top, = -16.9, and 0 dBFS is past a Medium knee's
    // 10.0 dB upper reach, so the asymptote puts it at -16.9 + 16.9/2.5. Reading the corner
    // straight off the threshold instead — which is what the drive's whole range used to do
    // — puts it at -24.0 and this label at -14.4.
    withComp({ threshold: 0 }, 20);
    expect(grTexts()).toEqual(["-10.1 dB"]);
  });

  it("joins the ramp to the threshold's own line at the drive they meet", () => {
    // The label is 0.6 x the corner here (past a Medium knee, ratio 2.50:1), so it reads the
    // corner directly. Below the meeting drive the corner falls 31sts of -26.2 dBFS — 0.85 dB
    // a step, half a dB of label — and above it 0.2 dB a step. The join is the assertion: the
    // last ramped step has to LAND on what the line above asks for at 31, which it does only
    // while the ramp's top and that line are the same expression. Re-measuring the top on its
    // own puts a step here that no other case sees — an anchor of -26.5 draws -14.9 at 29,
    // which is where this fails first.
    for (const [drive, label] of [
      [29, "-14.7 dB"],
      [30, "-15.2 dB"],
      [31, "-15.7 dB"],
      [32, "-15.8 dB"],
    ] as const) {
      withComp({ threshold: 0 }, drive);
      expect(grTexts(), `drive ${drive}`).toEqual([label]);
    }
  });

  it("leaves the factory threshold's whole drive range where it already was", () => {
    // At threshold raw 100 — the factory value — the ramp asks for -0.2 x drive and so does
    // the line above it, at every drive and for any ramp constant. So the region this adds
    // is invisible along that one column, and a low drive there still draws what it drew.
    // Not a check on the constant (the first test is that): a check that correcting the
    // corner did not move the picture the operator starts from.
    withComp({ threshold: 100 }, 20);
    expect(grTexts()).toEqual(["-2.9 dB"]);
  });

  /**
   * The curve has no step in it.
   *
   * A compressor's transfer curve bends; it does not jump. The first version of this
   * model interpolated the knee with a quadratic centred between the two measured edges
   * while the leg above it stayed anchored to the threshold — and for an ASYMMETRIC knee
   * those two do not meet, so the drawing carried a vertical step at the upper edge
   * (0.45 dB at the factory settings, 0.60 dB on Soft). Nothing saw it: the only
   * assertions on this plot were a label count.
   *
   * The bound is the 1:1 leg's own rise, which every sample below the knee already has,
   * so a step of any size fails and the ordinary slope does not.
   */
  /** One sample's rise on the 1:1 leg, in canvas px: the plot's dB-per-px times the
   *  0.45 dB one of the 120 segments covers. Nothing the curve draws may move faster. */
  const UNITY_STEP = (320 - 14 - 28) / (18 - -54) / ((0 - -54) / 120) ** -1;

  /** Consecutive-sample deltas of the drawn polyline, in canvas px. Canvas y grows
   *  downward, so a rising output is a NEGATIVE delta and a positive one is the curve
   *  turning back on itself. */
  const deltas = (): number[] => {
    const ys = curveYs(SSMCS_COMP_DYN);
    return ys.slice(1).map((y, i) => y - ys[i]);
  };

  it.each([
    ["Soft", 0],
    ["Medium", 1],
  ])("bends rather than steps through a %s knee", (_name, knee) => {
    withComp({ knee });
    const steps = deltas().map(Math.abs);
    expect(Math.max(...steps)).toBeLessThanOrEqual(UNITY_STEP + 0.01);
    // The positive control: a curve that never bent would pass the bound trivially.
    expect(Math.min(...steps)).toBeLessThan(UNITY_STEP - 0.5);
  });

  /**
   * The curve never turns back on itself.
   *
   * A compressor's transfer curve rises. Two shapes on screen at an infinite ratio said
   * otherwise, and both came from the makeup being carried by the compressed leg alone:
   * on Hard the corner STEPPED DOWN by the whole makeup, there being 0 dB of knee to
   * spread it across, and on Medium the ramp outran the knee's own rise, so the curve
   * climbed past the plateau and came back down onto it. The case above sees neither —
   * it asks only at the factory ratio, where the compressed leg still rises fast enough
   * to cover a factory makeup.
   *
   * Swept rather than sampled at one setting, because which combinations fold is exactly
   * what was not obvious: of the 2100 settings a first sweep covered, 515 folded and every
   * one of them needed a makeup away from 0 dB.
   */
  it("never turns back on itself, at any setting of the four terms that shape it", () => {
    const folded: string[] = [];
    for (const knee of [0, 1, 2])
      for (const ratio of [0, 30, 60, 90, 120])
        for (const makeup of [0, 50, 100, 150, 200])
          for (const compDrive of [40, 100, 200]) {
            withComp({ knee, ratio, makeup }, compDrive);
            const worst = Math.max(...deltas());
            if (worst > 0.01)
              folded.push(`knee=${knee} ratio=${ratio} makeup=${makeup} drive=${compDrive} +${worst.toFixed(2)}px`);
          }
    expect(folded).toEqual([]);
  });

  /**
   * A Hard knee at an infinite ratio is two straight segments meeting at one point.
   *
   * The shape is what the setting means, so it is asserted as a shape: no sample moves
   * faster than the 1:1 leg (no step at the corner), and the samples fall into exactly two
   * populations — moving at the 1:1 rate, and not moving at all. A monotonicity check alone
   * would pass on a step DOWN turned into a step UP, and the step bound alone would pass on
   * a curve that was one straight line and nothing else.
   */
  it("meets the plateau at a single point on a Hard knee", () => {
    withComp({ knee: 2, ratio: 120, makeup: 0 });
    const steps = deltas().map(Math.abs);
    expect(Math.max(...steps)).toBeLessThanOrEqual(UNITY_STEP + 0.01);
    expect(steps.filter((s) => s > UNITY_STEP - 0.01).length).toBeGreaterThan(10);
    expect(steps.filter((s) => s < 0.01).length).toBeGreaterThan(10);
    // One sample in between and no more: the corner falls inside a segment rather than on
    // a sample, so exactly one of the 120 covers part of each leg. A bend would put a run
    // of them at intermediate rates.
    expect(steps.filter((s) => s > 0.01 && s < UNITY_STEP - 0.01).length).toBeLessThanOrEqual(1);
  });

  it("draws no reduction label when the drive has the compressor switched out", () => {
    withComp({}, 0);
    expect(grTexts()).toEqual([]);
  });

  it("marks all three bands on the EQ face, lighting only the selected one", () => {
    draw(SSMCS_EQ_DYN, 1);
    const lit = h!.canvas.faces.filter((f) => f.style === "--led-face");
    const dim = h!.canvas.faces.filter((f) => f.style === "--plot-dim");
    expect(lit.length).toBe(1);
    expect(dim.length).toBe(2);
  });

  it("keeps a switched-off band's marker on the composite curve", () => {
    h!.plan.nodeParams[ssmcsChannel] = {
      ...h!.plan.nodeParams[ssmcsChannel],
      ssmcs: { ...SSMCS_INITIAL, eq: { ...SSMCS_INITIAL.eq, mid: { ...SSMCS_INITIAL.eq.mid, on: false } } },
    };
    draw(SSMCS_EQ_DYN, 1);
    // Still three markers: switching a band off takes it out of the response, not off
    // the plot — its frequency is what the operator is still reading.
    expect(h!.canvas.faces.filter((f) => f.style === "--led-face" || f.style === "--plot-dim").length).toBe(3);
  });

  it("draws both halves on MAIN, each inside its own frame", () => {
    draw(SSMCS_DYN);
    // The two plots' x ranges do not overlap: the EQ half starts past the divider.
    const marks = h!.canvas.faces.filter((f) => f.style === "--plot-dim");
    expect(marks.length).toBe(3);
    expect(Math.min(...marks.map((m) => m.x0))).toBeGreaterThan(350);
    // And no band is lit — none of them is being edited on this face.
    expect(h!.canvas.faces.filter((f) => f.style === "--led-face").length).toBe(0);
  });
});
