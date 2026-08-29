// @vitest-environment jsdom
import { afterEach, describe, it, expect } from "vitest";
import { Console } from "./console";
import { consoleHost, type ConsoleHost } from "./console.test-util";
import { getModel } from "../models";
import { defaultPlan } from "../models/initial-state";
import { COMP_EQ_COMP_FIRST, COMP_EQ_SSMCS } from "../core/control/params";
import type { Plan } from "../core/plan";
import { t } from "../i18n";

describe("Console UI", () => {
  it("threads modelId URX22 correctly to resolve meters (e.g. ch_3_4 input tap)", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);

    const model = getModel("URX22");
    const plan = defaultPlan("URX22");

    const hooks = {
      getModel: () => model,
      getPlan: () => plan,
      onChange: () => {},
    };

    const consoleInstance = new Console(host, hooks);
    consoleInstance.show();

    // Re-read the map each time: a render swaps in a fresh one.
    const refs = () => (consoleInstance as any).refs;
    const stripRef = refs().get("ch_3_4");

    expect(stripRef).toBeDefined();
    // Default tap for ch_3_4 is post (post-ducker) which maps to [120, 0] / [120, 1]
    expect(stripRef.tap).toBeDefined();
    expect(stripRef.tap.key).toBe("post");
    expect(stripRef.tap.l).toEqual([120, 0]);
    expect(stripRef.tap.r).toEqual([120, 1]);

    // Change the tap of ch_3_4 to input
    (consoleInstance as any).setTap("ch_3_4", "input");

    const updatedStripRef = refs().get("ch_3_4");
    expect(updatedStripRef.tap).toBeDefined();
    expect(updatedStripRef.tap.key).toBe("input");
    expect(updatedStripRef.tap.l).toEqual([101, 0]);
    expect(updatedStripRef.tap.r).toEqual([101, 1]);

    // Clean up
    consoleInstance.hide();
    document.body.removeChild(host);
  });

  // A re-render replaces every strip element. While Live sync streams, that must not
  // show: the meter's ballistics carry onto the fresh lanes and the rebuilt strips are
  // painted in the same task, so no frame draws them at the floor with a blank readout
  // (device follow re-renders on every device-side edit — this was the 10 s blink).
  it("carries the live meters across a re-render with no blank frame", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const model = getModel("URX44V");
    const plan = defaultPlan("URX44V");
    const consoleInstance = new Console(host, { getModel: () => model, getPlan: () => plan, onChange: () => {} });
    const priv = consoleInstance as any;
    consoleInstance.show();
    consoleInstance.setLive(true);

    // Nothing streamed yet: the readout holds "—" rather than claiming silence.
    expect(priv.refs.get("ch1").readMtr.textContent).toBe("—");

    priv.store.apply({ meterId: 115, x: 0, value: -100 }); // CH 1 POST = -10.0 dBFS
    priv.paintMeters(); // one animation-loop frame
    const lit = priv.refs.get("ch1").lanes[0].v;
    expect(lit).toBeGreaterThan(0);
    expect(priv.refs.get("ch1").readMtr.textContent).toBe("-10.0");

    consoleInstance.refresh(); // full re-render — new elements for every strip
    const fresh = priv.refs.get("ch1");
    expect(fresh.lanes[0].v).toBeCloseTo(lit, 5); // ballistics carried, no re-attack
    expect(fresh.readMtr.textContent).toBe("-10.0"); // redrawn before the browser drew

    // A device-side edit rebuilds a single strip, faster than the readout's throttle:
    // the same redraw has to happen there, or the value flickers against "—".
    consoleInstance.refreshStrip("ch1");
    expect(priv.refs.get("ch1").readMtr.textContent).toBe("-10.0");
    expect(priv.refs.get("ch1").lanes[0].v).toBeCloseTo(lit, 5);

    consoleInstance.setLive(false);
    consoleInstance.hide();
    document.body.removeChild(host);
  });

  // Same rebuild, same problem for the keyboard: a control being ridden with the arrow
  // keys must still be the focused one afterwards.
  it("hands keyboard focus back to the same control after a re-render", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const model = getModel("URX44V");
    const plan = defaultPlan("URX44V");
    const consoleInstance = new Console(host, { getModel: () => model, getPlan: () => plan, onChange: () => {} });
    consoleInstance.show();

    const faderOf = (): HTMLElement => host.querySelector<HTMLElement>('.con-strip [role="slider"]')!;
    const before = faderOf();
    before.focus();
    expect(document.activeElement).toBe(before);

    consoleInstance.refresh();
    const after = faderOf();
    expect(after).not.toBe(before); // the strip really was rebuilt
    expect(document.activeElement).toBe(after);

    consoleInstance.hide();
    document.body.removeChild(host);
  });

  // Above 96 kHz no insert effect can run. The face must not hand over a toggle that
  // silently selects one the device would refuse — and it does not, because a press on a
  // strip holding nothing opens the type list instead of writing anything at all. What
  // the rate changes is which entries that list offers, and the reason it names on the
  // face: at 192 kHz it is the rate rather than the slots.
  it("offers no effect above 96 kHz, and takes none by being pressed", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const model = getModel("URX44V");
    const plan = defaultPlan("URX44V");
    const consoleInstance = new Console(host, { getModel: () => model, getPlan: () => plan, onChange: () => {} });

    const face = (): HTMLElement | null => host.querySelector<HTMLElement>(".con-ifxface");
    const rows = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(".con-ifxpop .irow")];

    plan.sampleRate = 192000;
    consoleInstance.show();
    expect(face()).not.toBeNull();
    expect(face()!.title).toBe(t().inspector.insFxRateLocked);
    // Pressing it selects nothing and opens nothing: this strip holds none and every
    // effect is above the ceiling, so the list behind it would be one already-selected
    // row and a column of refusals. The face carries the reason instead.
    const before = plan.nodeParams["ch1"]?.insertFx;
    const beforeOn = plan.nodeParams["ch1"]?.insertFxOn;
    face()!.click();
    expect(plan.nodeParams["ch1"]?.insertFx).toBe(before);
    expect(plan.nodeParams["ch1"]?.insertFxOn).toBe(beforeOn);
    expect(rows().length).toBe(0);

    // Below the menu-wide ceiling the face names nothing, because something CAN be taken —
    // and it opens again, which is what says the lock above is the rate and not the face.
    // Not everything is offered: 96 kHz is still above Pitch Fix's own 48, and that
    // per-effect reading is the one a menu-wide answer cannot give.
    plan.sampleRate = 96000;
    consoleInstance.refresh();
    expect(face()!.title).toBe("");
    face()!.click();
    expect(rows().length).toBeGreaterThan(1);
    expect(
      rows()
        .filter((r) => !r.classList.contains("off"))
        .map((r) => r.querySelector(".nm")!.textContent)
        .includes("No Effect"),
    ).toBe(true);
    expect(
      rows()
        .filter((r) => r.classList.contains("off"))
        .map((r) => r.querySelector(".nm")!.textContent),
    ).toEqual(["Pitch Fix"]);

    consoleInstance.hide();
    document.body.removeChild(host);
  });
});

// Every head is clamped to the tallest one, measured off-screen once and cached. What
// the cache is keyed by decides whether a head that grew a row gets the space: keyed by
// model and hidden set alone, switching a channel back to COMP->EQ added a chip row the
// remembered height had no room for, and the head stayed clipped until something rebuilt
// the view under a different key (a model switch, a hide/show, a reload).
//
// jsdom lays nothing out, so the height comes from `headHeight` (console.test-util.ts):
// a stand-in that counts the head's chips. Only its direction is faithful — a head with
// more chips measures taller — which is the whole of what the cache key has to track.
// It doubles as the re-measure counter, since a call to it IS the view laying the strips
// out again; that is the only observable for a key term that changes no height, which is
// what the sample rate was measured to be (console.ts, `mainHeadHeight`).
describe("the head-height cache", () => {
  const chips = (head: HTMLElement): number => head.querySelectorAll(".con-chip").length;
  const px = (head: HTMLElement): number => 40 + 12 * chips(head);
  const headH = (h: ConsoleHost): string => h.host.style.getPropertyValue("--head-h");
  /** The tallest head as the stand-in measures it now, whatever the cache says. */
  const tallest = (h: ConsoleHost): number =>
    Math.max(...[...h.host.querySelectorAll<HTMLElement>(".con-head")].map(px));

  let h: ConsoleHost;
  let measures = 0;
  /** Mount with the content-derived head height, counting each off-screen measure. */
  const mount = (plan: Plan): ConsoleHost => {
    measures = 0;
    return consoleHost({
      modelId: "URX44V",
      plan,
      headHeight: (head) => {
        measures++;
        return px(head);
      },
    });
  };
  /** Every mono channel's COMP/EQ type at once — one channel's would not move the
   *  tallest head, since the others keep the openers it lost. */
  const setCompEq = (plan: Plan, type: number): void => {
    for (const [id, np] of Object.entries(plan.nodeParams))
      if (np?.compEqType !== undefined) plan.nodeParams[id] = { ...np, compEqType: type };
  };

  afterEach(() => h?.restore());

  /** The head's chips as text, over every strip — what a type change actually swaps. */
  const chipText = (h: ConsoleHost): string =>
    [...h.host.querySelectorAll<HTMLElement>(".con-head .con-chip")].map((c) => c.textContent).join(",");

  // The type change swaps what a mono strip's chips ARE — the morphing strip's own master
  // and its one opener stand where COMP's and EQ's two openers stand — and in SSMCS mode it
  // also costs one processing ROW, because SSMCS spends its spare slot on the SC chip and
  // the INS FX pair can then no longer share a row with EQ. So a spacer goes in beside EQ,
  // which is two chips in this stand-in's arithmetic: a row, not a rounding.
  //
  // What the cache has to do is therefore RE-MEASURE and land on the taller number, not
  // keep the one it had. Both are asserted, and so is the swap itself — without it a head
  // that never changed would satisfy the re-measure count on its own.
  it("re-measures when the COMP/EQ type changes, and follows the row it costs", () => {
    const plan = defaultPlan("URX44V");
    setCompEq(plan, COMP_EQ_SSMCS);
    h = mount(plan);
    const inSsmcs = headH(h);
    const chipsInSsmcs = chipText(h);
    const measuredOnce = measures;
    expect(measuredOnce).toBeGreaterThan(0);
    expect(inSsmcs).toBe(`${tallest(h)}px`);
    expect(chipsInSsmcs).toContain("SSMCS");

    setCompEq(plan, COMP_EQ_COMP_FIRST);
    h.view.refresh();

    expect(measures).toBeGreaterThan(measuredOnce);
    expect(chipText(h)).not.toBe(chipsInSsmcs);
    expect(chipText(h)).not.toContain("SSMCS");
    expect(headH(h)).toBe(`${tallest(h)}px`);
    // One row exactly, and in the direction that says which of the two modes is taller.
    // A row is two chips wide, and the stand-in prices a chip at 12 (`px`, above).
    expect(parseInt(inSsmcs) - parseInt(headH(h))).toBe(2 * 12);
  });

  // The rate is the other key term, and it is in the key for a different reason: it
  // changes what a stereo head CARRIES (above 96 kHz the EQ opener goes) without changing
  // its height, because the parity spacer takes the freed slot. So what a rate change has
  // to produce is the re-measure — the height it lands on is the same one.
  it("re-measures when the sample rate changes, at the same height", () => {
    const plan = defaultPlan("URX44V");
    h = mount(plan);
    const at48 = headH(h);
    const measuredOnce = measures;
    expect(measuredOnce).toBeGreaterThan(0);

    plan.sampleRate = 192000;
    h.view.refresh();

    expect(measures).toBeGreaterThan(measuredOnce);
    expect(headH(h)).toBe(at48);
    expect(headH(h)).toBe(`${tallest(h)}px`);
  });

  // …and it is still a cache. A re-render that changes none of its inputs must not pay
  // for a second off-screen build of every strip — which is the cost the key exists to
  // avoid, and what a key of "everything" would give up.
  it("does not re-measure when nothing that shapes a head changed", () => {
    h = mount(defaultPlan("URX44V"));
    const measuredOnce = measures;
    expect(measuredOnce).toBeGreaterThan(0);

    h.view.refresh();

    expect(measures).toBe(measuredOnce);
  });
});

// The morphing strip's own master, which is the one head chip whose value does not sit at
// the top level of `nodeParams` — `boolChip`'s writer cannot reach it, so the strip builds
// its own. What that costs is a second writer for one flag, and nothing else asserted it
// wrote anywhere: the E2E case beside it only asks that the chip EXISTS.
describe("the SSMCS chip", () => {
  let h: ConsoleHost;
  afterEach(() => h?.restore());

  const mount = (): ConsoleHost => {
    const plan = defaultPlan("URX44V");
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, compEqType: COMP_EQ_SSMCS };
    return consoleHost({ modelId: "URX44V", plan });
  };
  const chip = (host: ConsoleHost, label: string): HTMLElement =>
    [...host.host.querySelectorAll<HTMLElement>(".con-chip")].find((c) => c.textContent === label)!;

  it("writes the strip's own on flag, and lights with it", () => {
    h = mount();
    const c = chip(h, "SSMCS");
    // It ships on, and the plan's nested value is what the chip reads.
    expect(c.getAttribute("aria-pressed")).toBe("true");

    c.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(h.plan.nodeParams.ch1?.ssmcs?.on).toBe(false);
    expect(chip(h, "SSMCS").getAttribute("aria-pressed")).toBe("false");

    // The rest of the strip's values are a level down from the flag and survive it: a
    // writer that replaced `ssmcs` instead of merging into it would take them with it.
    expect(h.plan.nodeParams.ch1?.ssmcs?.comp?.attack).toBeDefined();

    chip(h, "SSMCS").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(h.plan.nodeParams.ch1?.ssmcs?.on).toBe(true);
  });

  it("is not offered on a channel in the other bank", () => {
    h = consoleHost({ modelId: "URX44V" });
    expect(chip(h, "SSMCS")).toBeUndefined();
    // The positive control: the chips this strip DOES carry are found the same way.
    expect(chip(h, "GATE")).toBeDefined();
  });

  /** What each opener chip on CH 1's head says it opens, in the order they are laid out.
   *  By aria-label rather than by position: every opener carries the same "▸" glyph, so
   *  a count answers nothing about which screen a press reaches. */
  const openers = (host: ConsoleHost): string[] =>
    [...host.strip("ch1").root.querySelectorAll<HTMLElement>(".con-chip-open")].map(
      (c) => c.getAttribute("aria-label") ?? "",
    );

  // The morphing bank carries ONE opener, beside its own chip: its COMP and EQ faces are
  // reached from inside the screen, and the strip's COMP and EQ chips read exactly as they
  // do on a channel that has no strip at all. Asserted by what each opener opens — the
  // chips are identical glyphs, so a count answers nothing about which screen a press
  // reaches, and a position follows whatever was inserted above it.
  //
  // INS FX wears the same glyph and is deliberately not in either list: it is the one
  // disclosure in this row that opens a POPOVER rather than a screen, because the effect
  // type has to be settled before a screen has anything to show. Named here so that its
  // absence is a statement rather than an omission — and asserted as present, so a row
  // that stopped carrying it cannot pass as this rule holding.
  const insFxOpen = (h: ConsoleHost): string[] =>
    [...h.strip("ch1").root.querySelectorAll<HTMLElement>(".con-ifxopen")].map(
      (c) => c.getAttribute("aria-label") ?? "",
    );

  it("carries one opener in the morphing bank and three in the other", () => {
    h = mount();
    expect(openers(h)).toEqual([t().dynTuning.gate.open, t().dynTuning.ssmcs.open, t().inspector.insertFx]);
    expect(insFxOpen(h)).toEqual([t().inspector.insertFx]);

    h.restore();
    h = consoleHost({ modelId: "URX44V" });
    expect(openers(h)).toEqual([
      t().dynTuning.gate.open,
      t().dynTuning.comp.open,
      t().dynTuning.eq.open,
      t().inspector.insertFx,
    ]);
    expect(insFxOpen(h)).toEqual([t().inspector.insertFx]);
  });
});
