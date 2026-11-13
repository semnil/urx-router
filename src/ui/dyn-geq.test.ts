// @vitest-environment jsdom

// The Flex12GEQ screen: thirty-one faders on one side at a time, and the three states that shut a
// fader — the twelve-band rule, STEREO's bands above 20 Hz while Live sync is up, and a rate above
// 48 kHz. The edits themselves are core/geq.ts's and are pinned there; this pins that the screen
// hands them over and shows what they leave.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const subscribed = vi.hoisted(() => ({ count: 0 }));
vi.mock("../core/meters", async (importOriginal) => {
  const real = await importOriginal<typeof import("../core/meters")>();
  return {
    ...real,
    subscribeMeters: () => {
      subscribed.count++;
      return Promise.resolve(() => {});
    },
  };
});

import { DynScreen } from "./dyn-screen";
import { GEQ_DYN } from "./dyn-geq";
import { dynHost } from "./dyn-screen.test-util";
import type { DynHost } from "./dyn-screen.test-util";
import type { DynCtx } from "./dyn-screen";
import { EQ_TYPE_GEQ, EQ_TYPE_PEQ, GEQ_BAND_COUNT, geqFactory, geqSideState } from "../core/geq";
import type { NodeParams } from "../core/plan";
import { setLang, t } from "../i18n";

let host: DynHost | undefined;
let screen: DynScreen | undefined;

beforeEach(() => {
  setLang("en");
  localStorage.clear();
});

afterEach(() => {
  screen?.close();
  host?.restore();
  host = screen = undefined;
  document.body.replaceChildren();
});

/** A bus on Flex12GEQ with these gains on its L side (index → dB), opened on that side. */
function open(nodeId: string, opts: { gains?: Record<number, number>; live?: boolean; rate?: number } = {}): DynHost {
  const h = (host = dynHost({ live: opts.live }));
  const geq = geqFactory(nodeId);
  geq.sides![0].bands = geq.sides![0].bands!.map((b, x) => ({ gain: opts.gains?.[x] ?? b.gain }));
  h.plan.nodeParams[nodeId] = { ...h.plan.nodeParams[nodeId], eqType: EQ_TYPE_GEQ, eqOn: true, geq };
  if (opts.rate) h.plan.sampleRate = opts.rate;
  screen = new DynScreen(h.hooks);
  screen.open(GEQ_DYN, nodeId);
  expect(screen.isOpen()).toBe(true);
  return h;
}

const card = (x: number): HTMLElement => host!.box.querySelector<HTMLElement>(`.gt-fader[data-dyn-fader="band${x}"]`)!;
const fader = (x: number): HTMLInputElement => card(x).querySelector<HTMLInputElement>("input")!;
const move = (x: number, db: number): void => {
  fader(x).value = String(db);
  fader(x).dispatchEvent(new Event("input", { bubbles: true }));
};
const gains = (nodeId: string, side: number): number[] => geqSideState(host!.plan.nodeParams[nodeId], side).gains;
const available = (): string => {
  const row = [...host!.box.querySelectorAll<HTMLElement>(".prefs-row")].find((r) =>
    r.textContent?.startsWith(t().dynTuning.geq.available),
  );
  return row?.querySelector(".param-val")?.textContent ?? "";
};

describe("the faders", () => {
  it("are thirty-one, named as the unit labels its bands, on the side's limit and its 0.5 dB step", () => {
    open("bus.stereo");
    const cards = [...host!.box.querySelectorAll<HTMLElement>(".gt-fader")];
    expect(cards).toHaveLength(GEQ_BAND_COUNT);
    expect([cards[0], cards[17], cards[30]].map((c) => c.querySelector(".lbl")?.textContent)).toEqual([
      "20",
      "1k",
      "20k",
    ]);
    expect([fader(0).min, fader(0).max, fader(0).step]).toEqual(["-15", "15", "0.5"]);
  });

  it("write their band, and the GEQ Link takes the write to the other side and names it", () => {
    open("bus.mix1");
    move(17, -3);
    expect([gains("bus.mix1", 0)[17], gains("bus.mix1", 1)[17]], "a MIX ships linked L → R").toEqual([-3, -3]);
    expect(host!.patches.at(-1)?.written).toEqual(["geq.sides.0.bands.17.gain", "geq.sides.1.bands.17.gain"]);
  });

  // The unit's own GEQ screen marks a cut and prints a boost with no sign.
  it("print a cut with its sign and a boost without one, as the unit does", () => {
    open("bus.stereo");
    move(5, 3);
    move(9, -4.5);
    const reading = (x: number) => card(x).querySelector(".gt-val")?.textContent;
    expect([reading(5), reading(9), reading(0)]).toEqual(["3.0", "-4.5", "0.0"]);
  });

  it("show the other side when the side bar switches to it", () => {
    open("bus.stereo");
    host!.plan.nodeParams["bus.stereo"]!.geq!.sides![1].bands![5] = { gain: 4.5 };
    host!.box.querySelector<HTMLElement>("#geq-r")!.click();
    expect(fader(5).value).toBe("4.5");
    move(5, 6);
    expect([gains("bus.stereo", 0)[5], gains("bus.stereo", 1)[5]], "STEREO ships unlinked").toEqual([0, 6]);
  });
});

describe("what shuts a fader", () => {
  const twelve = Object.fromEntries(Array.from({ length: 12 }, (_, x) => [x, -1]));

  it("twelve bands away from 0 dB shut every band at 0 dB, say why, and leave none free", () => {
    open("bus.stereo", { gains: twelve });
    expect(fader(20).disabled).toBe(true);
    expect(card(20).classList.contains("locked")).toBe(true);
    expect(card(20).title).toBe(t().dynTuning.geq.full);
    expect(fader(3).disabled, "a band in use still moves").toBe(false);
    expect(available()).toBe("0");
    move(3, 0);
    expect(fader(20).disabled, "returning one frees the rest").toBe(false);
    expect(available()).toBe("1");
  });

  it("Live sync shuts STEREO's bands above 20 Hz, and no band of a MIX", () => {
    open("bus.stereo", { live: true });
    expect(fader(0).disabled).toBe(false);
    expect([fader(1).disabled, card(1).title]).toEqual([true, t().dynTuning.geq.unwritable]);
    expect(fader(30).disabled).toBe(true);
    screen!.close();
    host!.restore();
    open("bus.mix2", { live: true });
    expect(Array.from({ length: GEQ_BAND_COUNT }, (_, x) => fader(x).disabled).some(Boolean)).toBe(false);
  });

  it("a rate above 48 kHz shuts every fader and every row", () => {
    open("bus.mix1", { rate: 96000 });
    expect(Array.from({ length: GEQ_BAND_COUNT }, (_, x) => fader(x).disabled).every(Boolean)).toBe(true);
    expect(card(0).title).toBe(t().inspector.geqRateLocked);
    const selects = [...host!.box.querySelectorAll<HTMLSelectElement>(".prefs-row select")];
    expect(selects.length, "the Link and the Limit").toBe(2);
    expect(selects.every((s) => s.disabled)).toBe(true);
  });
});

describe("a Live sync session under the screen", () => {
  const flat = (): HTMLButtonElement =>
    [...host!.box.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === t().dynTuning.geq.gainFlat,
    )!;

  // Gain Flat writes every band of the side; the link takes none of STEREO's above 20 Hz, so run
  // during a session it would flatten the plan's and leave the unit's.
  it("holds Gain Flat on STEREO, says why, and leaves a MIX's alone", () => {
    open("bus.stereo", { gains: { 17: -6 }, live: true });
    expect(flat().disabled).toBe(true);
    expect(flat().closest(".prefs-row")?.textContent).toContain(t().dynTuning.geq.flatUnwritable);
    flat().click();
    expect(gains("bus.stereo", 0)[17], "nothing flattened").toBe(-6);
    screen!.close();
    host!.restore();
    open("bus.mix1", { gains: { 17: -6 }, live: true });
    expect(flat().disabled).toBe(false);
    flat().click();
    expect(gains("bus.mix1", 0)[17]).toBe(0);
  });

  it("draws what the faders allow again when a session starts or ends, on one subscription", () => {
    open("bus.stereo");
    expect([fader(1).disabled, flat().disabled], "no session").toEqual([false, false]);
    subscribed.count = 0;
    host!.setLive(true);
    screen!.setLive(true);
    expect([fader(1).disabled, fader(0).disabled, flat().disabled], "a session").toEqual([true, false, true]);
    expect(subscribed.count, "the meters subscribed once").toBe(1);
    host!.setLive(false);
    screen!.setLive(false);
    expect([fader(1).disabled, flat().disabled], "the session ended").toEqual([false, false]);
    expect(subscribed.count).toBe(1);
  });
});

describe("the rows beside the faders", () => {
  it("narrow the faders and pull the side's bands in with the GEQ Limit", () => {
    open("bus.stereo", { gains: { 7: -10, 17: 10 } });
    const limit = [...host!.box.querySelectorAll<HTMLElement>(".prefs-row")]
      .find((r) => r.textContent?.startsWith(t().dynTuning.geq.limit))!
      .querySelector<HTMLSelectElement>("select")!;
    limit.value = "2"; // ±6 dB
    limit.dispatchEvent(new Event("change", { bubbles: true }));
    expect([gains("bus.stereo", 0)[7], gains("bus.stereo", 0)[17]]).toEqual([-6, 6]);
    expect([fader(0).min, fader(0).max]).toEqual(["-6", "6"]);
  });

  it("switch the shown side's [GEQ] alone, and the GEQ Link copies a side across and names both", () => {
    open("bus.stereo", { gains: { 7: -3 } });
    const row = (label: string): HTMLElement =>
      [...host!.box.querySelectorAll<HTMLElement>(".prefs-row")].find(
        (r) => r.querySelector(".lbl")?.textContent === label,
      )!;
    [...row(t().dynTuning.geq.button).querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "OFF")!
      .click();
    expect([
      geqSideState(host!.plan.nodeParams["bus.stereo"], 0).on,
      geqSideState(host!.plan.nodeParams["bus.stereo"], 1).on,
    ]).toEqual([false, true]);
    expect(host!.patches.at(-1)?.written).toEqual(["geq.sides.0.on"]);

    const link = row(t().dynTuning.geq.link).querySelector<HTMLSelectElement>("select")!;
    link.value = "1"; // ST L → ST R
    link.dispatchEvent(new Event("change", { bubbles: true }));
    expect(gains("bus.stereo", 1)[7], "R took L's bands").toBe(-3);
    const written = host!.patches.at(-1)?.written ?? [];
    expect(written[0]).toBe("geq.link");
    expect(written).toContain("geq.sides.1.limit");
    expect(written).toContain("geq.sides.1.bands.7.gain");
    expect(written).toHaveLength(1 + 2 * (1 + GEQ_BAND_COUNT));
  });

  it("Gain Flat returns the shown side to 0 dB", () => {
    open("bus.stereo", { gains: { 7: -10, 17: 10 } });
    const flat = [...host!.box.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === t().dynTuning.geq.gainFlat,
    )!;
    flat.click();
    expect(gains("bus.stereo", 0).every((g) => g === 0)).toBe(true);
    expect(available()).toBe("12");
  });
});

describe("the note over the screen", () => {
  const ctx = (np: NodeParams, sel = 0): DynCtx => {
    const h = (host = dynHost());
    h.plan.nodeParams["bus.mix1"] = { ...h.plan.nodeParams["bus.mix1"], ...np };
    return { model: h.model, plan: h.plan, nodeId: "bus.mix1", sel, m: t() };
  };
  const off = { ...geqFactory("bus.mix1"), sides: [{ on: false }, { on: true }] };

  it("says EQ ON is off first, then that the bus runs 4band PEQ, then that the side is off", () => {
    expect(GEQ_DYN.offNote!(ctx({ eqOn: false, eqType: EQ_TYPE_PEQ, geq: off }))).toBe(t().dynTuning.bypassed);
    host!.restore();
    expect(GEQ_DYN.offNote!(ctx({ eqOn: true, eqType: EQ_TYPE_PEQ, geq: off }))).toBe(t().dynTuning.geq.notSelected);
    host!.restore();
    expect(GEQ_DYN.offNote!(ctx({ eqOn: true, eqType: EQ_TYPE_GEQ, geq: off }))).toBe(t().dynTuning.geq.sideOff);
    host!.restore();
    expect(GEQ_DYN.offNote!(ctx({ eqOn: true, eqType: EQ_TYPE_GEQ, geq: off }, 1))).toBeNull();
  });
});
