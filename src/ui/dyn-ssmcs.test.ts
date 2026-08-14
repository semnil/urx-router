// @vitest-environment jsdom

// The morphing strip's three faces: what each one binds, what it puts on screen, where
// an edit lands in the plan's nested shape, and what moving between the faces does to
// the screen and to the meter registration.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const subscribed: Array<Array<[number, number]>> = [];
vi.mock("../core/meters", async (importOriginal) => {
  const real = await importOriginal<typeof import("../core/meters")>();
  return {
    ...real,
    subscribeMeters: (_store: unknown, addrs: Array<[number, number]>) => {
      subscribed.push(addrs);
      return Promise.resolve(() => {});
    },
  };
});

import { dynHost, readouts, rowsByKey } from "./dyn-screen.test-util";
import type { DynHost } from "./dyn-screen.test-util";
import { NAMED_TOKENS, vals } from "./dyn-plot.test-util";
import { DynScreen } from "./dyn-screen";
import { SSMCS_COMP_DYN, SSMCS_DYN, SSMCS_EQ_DYN } from "./dyn-ssmcs";
import { COMP_DYN } from "./dyn-comp";
import { EQ_DYN } from "./dyn-eq";
import { COMP_EQ_COMP_FIRST, COMP_EQ_SSMCS } from "../core/control/params";
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

  it("meters all four taps and prints them as four tiles", () => {
    const tiles = readouts(h!.box);
    expect(tiles.map((r) => r.label)).toEqual([
      t().dynTuning.comp.tapIn,
      t().dynTuning.comp.tapGr,
      t().dynTuning.comp.tapOut,
      t().dynTuning.ssmcs.tapOut,
    ]);
    // Two columns, which is what four tiles take.
    expect(h!.box.querySelector(".gt-readouts")?.classList.contains("two")).toBe(true);
    expect(tiles.filter((r) => r.gr).length).toBe(1);
  });

  it("shows the two curves without a lane rack", () => {
    expect(h!.box.querySelector("#dyn-curve")).not.toBeNull();
    expect(h!.box.querySelector(".gt-ladderbox")).toBeNull();
  });

  it("writes an edit to the strip's own values", () => {
    const rows = rowsByKey(h!.box);
    slide(rows.get("morphing")!, 62);
    expect(strip(h!).morphing).toBe(62);
    slide(rows.get("outGain")!, 200);
    expect(strip(h!).outGain).toBe(200);
    // The nested sub-objects the plan already held survive a top-level write.
    expect(strip(h!).comp?.attack ?? SSMCS_INITIAL.comp.attack).toBe(SSMCS_INITIAL.comp.attack);
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

  it("reads the compressor and its side-chain filter in the unit's own order", () => {
    expect([...rowsByKey(h!.box).keys()]).toEqual(["attack", "release", "ratio", "scQ", "scFreq", "scGain"]);
    // Knee closes the compressor's rows and Side Chain opens the filter's, so both land
    // between Ratio and the filter's first slider — not above everything, which is where
    // `lead` would have put them.
    const labels = rowLabels(h!.box);
    const at = (label: string): number => labels.indexOf(label);
    expect(at(t().inspector.dyn.ratio)).toBeLessThan(at(t().inspector.dyn.knee));
    expect(at(t().inspector.dyn.knee)).toBeLessThan(at(t().inspector.ssmcs.sideChain));
    expect(at(t().inspector.ssmcs.sideChain)).toBeLessThan(at(t().inspector.q));
  });

  it("has no threshold cap on its input meter", () => {
    // The bank's corner is driven by a value the unit never shows, so the lane rack's
    // one gesture has no value to carry — the cap element must not be built at all.
    expect(h!.box.querySelector(".gt-cap")).toBeNull();
  });

  it("splits a write between the compressor and the filter", () => {
    const rows = rowsByKey(h!.box);
    slide(rows.get("attack")!, 200);
    slide(rows.get("scFreq")!, 44);
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
    expect(text("scQ")).toBe("1.00");
    expect(text("scFreq")).toBe("89 Hz");
    expect(text("scGain")).toBe("-4.7 dB");
  });
});

describe("the EQ face", () => {
  beforeEach(() => {
    h = host();
    screen = open(SSMCS_EQ_DYN, h);
  });

  const band = (name: "LOW" | "MID" | "HIGH"): HTMLButtonElement =>
    h!.box.querySelector<HTMLButtonElement>(`#dyn-ssmcs-band-${name.toLowerCase()}`)!;

  it("keeps four rows on every band, with the shelves' Q locked", () => {
    for (const name of ["LOW", "MID", "HIGH"] as const) {
      band(name).click();
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
    band("MID").click();
    slide(rowsByKey(h!.box).get("gain")!, 243);
    expect(strip(h!).eq?.mid?.gain).toBe(243);
    band("HIGH").click();
    slide(rowsByKey(h!.box).get("freq")!, 100);
    expect(strip(h!).eq?.high?.freq).toBe(100);
    expect(strip(h!).eq?.mid?.gain).toBe(243);
    expect(strip(h!).eq?.low?.freq ?? SSMCS_INITIAL.eq.low.freq).toBe(SSMCS_INITIAL.eq.low.freq);
  });

  it("offers each band its own frequency range", () => {
    band("LOW").click();
    expect(rowsByKey(h!.box).get("freq")!.max).toBe("72");
    band("HIGH").click();
    expect(rowsByKey(h!.box).get("freq")!.min).toBe("60");
    band("MID").click();
    expect(rowsByKey(h!.box).get("freq")!.max).toBe("124");
  });

  it("starts on LOW every time it opens", () => {
    band("HIGH").click();
    expect(band("HIGH").getAttribute("aria-pressed")).toBe("true");
    screen!.close();
    screen = open(SSMCS_EQ_DYN, h!);
    expect(band("LOW").getAttribute("aria-pressed")).toBe("true");
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

  it("stays open on the same channel rather than closing and reopening", () => {
    const closes = h!.closed();
    face("eq").click();
    expect(screen!.isOpen()).toBe(true);
    expect(h!.closed()).toBe(closes);
    expect(h!.box.querySelector("#dyn-screen-title")?.textContent).toContain("CH 1");
  });

  it("re-subscribes to the face's own taps", () => {
    const last = (): string => subscribed[subscribed.length - 1].map((a) => a.join(":")).join(",");
    const mono = 0; // CH 1's index in the meter tables
    expect(last()).toBe(`108:${mono},110:${mono},111:${mono},112:${mono}`);
    face("comp").click();
    expect(last()).toBe(`108:${mono},110:${mono},111:${mono}`);
    face("eq").click();
    expect(last()).toBe(`111:${mono},112:${mono}`);
    face("main").click();
    expect(last()).toBe(`108:${mono},110:${mono},111:${mono},112:${mono}`);
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

  it("labels the reduction the ratio buys at full scale", () => {
    draw(SSMCS_COMP_DYN);
    // At the factory settings the curve leaves 14.4 dB of reduction at 0 dBFS once the
    // drive's gain and the makeup are taken back out. The label is the annotation's,
    // and the only text drawn in the reduction token.
    expect(h!.canvas.texts.filter((tx) => tx.style === "--gr").length).toBe(1);
  });

  it("draws no reduction label when the drive has the compressor switched out", () => {
    h!.plan.nodeParams[ssmcsChannel] = {
      ...h!.plan.nodeParams[ssmcsChannel],
      ssmcs: { ...SSMCS_INITIAL, compDrive: 0 },
    };
    draw(SSMCS_COMP_DYN);
    expect(h!.canvas.texts.filter((tx) => tx.style === "--gr").length).toBe(0);
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
