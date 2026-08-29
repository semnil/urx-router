// @vitest-environment jsdom

// The INS FX tuning screen's descriptor. What it has to get right is the pair of
// indirections nothing else on this screen has: the family is a PLAN value rather than a
// property of the descriptor, and a field names an engine SLOT rather than a parameter —
// so the same key means a different thing under every family, and an edit that lands under
// the wrong one is a value the next selector write reads as its own.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dynHost } from "./dyn-screen.test-util";
import type { DynHost } from "./dyn-screen.test-util";
import { DynScreen } from "./dyn-screen";
import type { DynCtx, DynValues } from "./dyn-screen";
import { INSFX_DYN, companderResponse, insertFxScreenFamily } from "./insert-fx-screen";
import { planToCommands } from "../core/control/translate";
import {
  MBC_BANDS,
  MBC_GLOBAL,
  PITCH_KEY_SLOT,
  PITCH_NOTE_SLOTS,
  PITCH_SCALE_SLOT,
  PITCH_SCALE_MAJOR,
  insertFxLockedSlots,
  insertFxParamKey,
  insertFxParams,
} from "../core/control/insert-fx-effect";
import { INSERT_FX_NONE, INSERT_FX_OPTIONS, OUTPUT_INSERT_FX_OPTIONS } from "../core/control/params";
import { recorder, vals } from "./dyn-plot.test-util";
import { t } from "../i18n";

let h: DynHost;

/** Every label on the panel, rows AND knob cards. A guitar amp lays its continuous values
 *  out as cards rather than rows, so a collector that named only the rows would report a
 *  face as empty the moment the layout changed — a green test for a panel with nothing on
 *  it. One copy: this selector has already been widened once, and the edit has to reach
 *  every reader of it. */
const rowLabels = (): string[] =>
  [...h.box.querySelectorAll<HTMLElement>(".prefs-row .lbl, .gt-knob .lbl")].map((e) => e.textContent ?? "");

const valueOf = (label: string): number =>
  [...INSERT_FX_OPTIONS, ...OUTPUT_INSERT_FX_OPTIONS].find((o) => o.label === label)!.value;

/** Put an effect on a node and answer the context the descriptor is asked against. */
const holding = (nodeId: string, label: string): DynCtx => {
  h.plan.nodeParams[nodeId] = { ...h.plan.nodeParams[nodeId], insertFx: valueOf(label) };
  return { model: h.model, plan: h.plan, nodeId, sel: 0, m: t() };
};

beforeEach(() => {
  localStorage.clear();
  h = dynHost({ plotSize: { w: 0, h: 0 } });
});

afterEach(() => {
  h?.restore();
  document.body.replaceChildren();
});

describe("what the screen binds to", () => {
  it("refuses a node holding nothing — there is no effect to tune", () => {
    const ctx: DynCtx = { model: h.model, plan: h.plan, nodeId: "ch1", sel: 0, m: t() };
    expect(INSFX_DYN.bind(ctx)).toBeNull();
    h.plan.nodeParams.ch1 = { insertFx: INSERT_FX_NONE };
    expect(INSFX_DYN.bind(ctx)).toBeNull();
    expect(insertFxScreenFamily(h.model, h.plan, "ch1")).toBeNull();
  });

  it("refuses a node with no insert FX at all", () => {
    // A stereo input channel has no insert effect, so a plan value on it names nothing.
    expect(INSFX_DYN.bind(holding("ch_5_6", "Clean"))).toBeNull();
  });

  it("binds every family it shows whole", () => {
    for (const label of ["Clean", "Crunch", "Lead", "Drive", "Pitch Fix", "Compander-H", "Compander-S"]) {
      const binding = INSFX_DYN.bind(holding("ch1", label));
      expect(binding, label).not.toBeNull();
      expect(binding!.fields.length, label).toBeGreaterThan(0);
    }
  });

  it("binds the multi-band compressor's first face, three cards to a row", () => {
    // What the three bands share: the two crossovers and the levels they come back at.
    // Three columns is what makes the four faces the same height — six cards and four are
    // both two rows — so the segment that moves between them does not resize the modal.
    const binding = INSFX_DYN.bind(holding("bus.mix1", "M.B.Comp"));
    expect(binding).not.toBeNull();
    expect(binding!.fields).toHaveLength(6);
    expect(binding!.knobGrid).toBe(true);
    expect(binding!.knobCols).toBe(3);
    // The 1-Knob pair is not among them: the app never writes it, so it is not a field.
    const slots = binding!.fields.map((f) => Number(/:(\d+)$/.exec(f.key)?.[1]));
    expect(slots).not.toContain(MBC_GLOBAL.oneKnobOn);
    expect(slots).not.toContain(MBC_GLOBAL.oneKnobLevel);
  });

  it("names the effect in the title, so the heading is not just a slot", () => {
    const ctx = holding("ch1", "Compander-S");
    expect(INSFX_DYN.title(t(), ctx)).toContain("Compander-S");
    expect(INSFX_DYN.title(t(), ctx)).toContain(t().dynTuning.insfx.title);
  });
});

describe("the meter lanes", () => {
  it("takes a mono channel's taps either side of the insert point, with its own reduction", () => {
    const lanes = INSFX_DYN.bind(holding("ch2", "Compander-H"))!.lanes;
    expect(lanes.map((l) => l.key)).toEqual(["in", "out", "gr"]);
    // PRE INS FX (112) into the effect, PRE FADER (113) out of it, input insert GR (132).
    expect(lanes[0].tap!.l).toEqual([112, 1]);
    expect(lanes[1].tap!.l).toEqual([113, 1]);
    expect(lanes[2].sameSlot).toBe(true);
  });

  it("addresses the input reduction at x0 whichever channel holds the effect", () => {
    // 132's x is not the mono channel, so the level taps move with the channel and the
    // reduction does not. Pinned against the taps beside it: a table that indexed it by
    // channel would track them, and three of its four rows would address a dead meter.
    for (const [node, x] of [
      ["ch1", 0],
      ["ch2", 1],
      ["ch4", 3],
    ] as const) {
      // One holder at a time: the compander is a device-wide slot, and with two of them
      // the lane is withheld (below), so a sweep that left the previous one set would be
      // asking a different question from the second iteration on.
      for (const other of ["ch1", "ch2", "ch3", "ch4"]) {
        if (other !== node) h.plan.nodeParams[other] = { ...h.plan.nodeParams[other], insertFx: INSERT_FX_NONE };
      }
      const lanes = INSFX_DYN.bind(holding(node, "Compander-H"))!.lanes;
      expect(lanes[0].tap!.l, node).toEqual([112, x]);
      expect(lanes[2].gr, node).toEqual([132, 0]);
    }
  });

  it("takes an output bus's post tap and the band-indexed output reduction", () => {
    const lanes = INSFX_DYN.bind(holding("bus.mix1", "Compander-S"))!.lanes;
    // The output effect's GR is addressed by BAND, not by bus: only one runs device-wide.
    expect(lanes[2].gr).toEqual([133, 0]);
    // A bus tap is stereo, and the effect sits AFTER the fader there — so the output side
    // is POST rather than the channel's PRE FADER.
    expect(lanes[1].tap!.r).toBeDefined();
    expect(lanes[1].label).toBe(t().dynTuning.insfx.tapOutBus);
    expect(lanes[0].label).toBe(t().dynTuning.insfx.tapIn);
  });

  it("meters the band its own face is about, and none on MAIN", () => {
    // The three faces carry the same lane LABEL — the bar above names the band — so the
    // address is the only thing that says which reduction a face shows. Nothing else
    // checks it: a face wired to the wrong band would draw a plausible number.
    for (const [sel, x] of [
      [1, 0],
      [2, 1],
      [3, 2],
    ] as const) {
      const lanes = INSFX_DYN.bind({ ...holding("bus.mix1", "M.B.Comp"), sel })!.lanes;
      expect(
        lanes.map((l) => l.key),
        `sel ${sel}`,
      ).toEqual(["in", "out", "gr"]);
      expect(lanes[2].gr, `sel ${sel}`).toEqual([133, x]);
      expect(lanes[2].label, `sel ${sel}`).toBe(t().dynTuning.insfx.tapGr);
    }
    // MAIN sets the crossovers and the levels the bands are mixed back at; three
    // reductions beside those say which band is working and nothing about what is set.
    expect(INSFX_DYN.bind({ ...holding("bus.mix1", "M.B.Comp"), sel: 0 })!.lanes.map((l) => l.key)).toEqual([
      "in",
      "out",
    ]);
  });

  it("gives the reduction lane to the compander alone, on the input side", () => {
    // The unit reports no reduction for a guitar amp or for Pitch Fix: with a Drive amp's
    // own noise gate taking the output to the floor, and with Pitch Fix running and shifted
    // twelve semitones, 132 holds the not-engaged value on every band. A lane there is a
    // bar that cannot move, which reads as "none right now" rather than as "never".
    for (const type of ["Clean", "Crunch", "Lead", "Drive", "Pitch Fix"]) {
      expect(
        INSFX_DYN.bind(holding("ch1", type))!.lanes.map((l) => l.key),
        type,
      ).toEqual(["in", "out"]);
    }
    for (const [node, type] of [
      ["ch1", "Compander-H"],
      ["ch1", "Compander-S"],
      ["bus.mix1", "Compander-S"],
    ] as const) {
      const lanes = INSFX_DYN.bind(holding(node, type))!.lanes;
      expect(
        lanes.map((l) => l.key),
        type,
      ).toEqual(["in", "out", "gr"]);
      expect(lanes[2].kind).toBe("gr");
    }
  });

  it("drops the input reduction lane when the plan holds two companders", () => {
    // 132 reports ONE channel's reduction: with two holders it followed the second and
    // ignored the first, so on the first one's screen the lane would draw its neighbour's
    // number. The app's own menu locks the compander to one node, so this state arrives
    // only from a plan whose slot conflict the operator waved through at load.
    holding("ch1", "Compander-H");
    expect(INSFX_DYN.bind(holding("ch2", "Compander-H"))!.lanes.map((l) => l.key)).toEqual(["in", "out"]);
    expect(INSFX_DYN.bind(holding("ch1", "Compander-H"))!.lanes.map((l) => l.key)).toEqual(["in", "out"]);
    // The output effect keeps its lane: `133` is indexed by the effect's own band and one
    // output effect runs device-wide, so nothing else can be occupying it.
    expect(INSFX_DYN.bind(holding("bus.mix1", "Compander-S"))!.lanes.map((l) => l.key)).toEqual(["in", "out", "gr"]);
    // …and clearing one hands the lane back to the other.
    h.plan.nodeParams.ch2!.insertFx = INSERT_FX_NONE;
    expect(INSFX_DYN.bind(holding("ch1", "Compander-H"))!.lanes.map((l) => l.key)).toEqual(["in", "out", "gr"]);
  });
});

describe("reading and writing engine slots", () => {
  it("stores an edit under the family's own key, not the bare slot", () => {
    const ctx = holding("ch1", "Compander-H");
    const patch = INSFX_DYN.patch(ctx, { "ifx:compander:6": -2000 });
    expect(patch.insertFxParams).toEqual({ [insertFxParamKey("compander", 6)]: -2000 });
  });

  it("replaces a bare slot a readback wrote rather than leaving both to answer", () => {
    const ctx = holding("ch1", "Compander-H");
    h.plan.nodeParams.ch1!.insertFxParams = { "6": -1234 };
    // The bare key is the device-shaped namespace, read as the selected family's until
    // the first edit re-keys it. Two keys for one slot is what must not survive.
    expect(INSFX_DYN.read(ctx)["ifx:compander:6"]).toBe(-1234);
    const patch = INSFX_DYN.patch(ctx, { "ifx:compander:6": -2000 });
    expect(patch.insertFxParams!["6"]).toBeUndefined();
    expect(patch.insertFxParams![insertFxParamKey("compander", 6)]).toBe(-2000);
  });

  it("writes a mirrored slot with its twin", () => {
    // Three Pitch Fix values are stored twice and the device reads both, so an edit that
    // wrote one of them would be half applied.
    const ctx = holding("ch1", "Pitch Fix");
    const mirrored = insertFxParams("pitch").find((d) => d.mirror !== undefined)!;
    const written = INSFX_DYN.patch(ctx, { [`ifx:pitch:${mirrored.slot}`]: 7 }).insertFxParams!;
    expect(written[insertFxParamKey("pitch", mirrored.slot)]).toBe(7);
    expect(written[insertFxParamKey("pitch", mirrored.mirror!)]).toBe(7);
  });

  it("reads a value the plan does not carry as the SELECTED TYPE's own default", () => {
    // The two companders are one family and come up at different values in all five of
    // their slots. Read from the family alone, a Compander-S showed Compander-H's numbers
    // until a device read replaced them — so the pair is the assertion, not either half.
    // Ratio (slot 7): H 350 = 3.5:1, S 400 = 4.0:1.
    expect(INSFX_DYN.read(holding("ch1", "Compander-S"))["ifx:compander:7"]).toBe(400);
    expect(INSFX_DYN.read(holding("ch1", "Compander-H"))["ifx:compander:7"]).toBe(350);
  });

  it("keeps one family's stored values out of another's", () => {
    const ctx = holding("ch1", "Compander-H");
    h.plan.nodeParams.ch1!.insertFxParams = { [insertFxParamKey("guitar-clean", 7)]: 99 };
    // Slot 7 is the compander's Ratio and the guitar amp's Volume. Reading the guitar's
    // value here would show 99 as a ratio and write it back as one.
    expect(INSFX_DYN.read(ctx)["ifx:compander:7"]).toBe(350);
    // …and the fallback is this type's, which is what says the 99 was rejected rather than
    // the whole read having answered with a family-wide constant.
    expect(INSFX_DYN.read(holding("ch1", "Compander-S"))["ifx:compander:7"]).toBe(400);
  });
});

describe("the rendered screen", () => {
  // Both shapes: a guitar amp lays its continuous values out as knob cards rather than as

  it("shows the compander's rows grouped by what shapes the response", () => {
    holding("ch1", "Compander-H");
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "ch1");
    const m = t().inspector.insertFxEffect.params;
    const order: string[] = [m.threshold, m.ratio, m.width, m.gain, m.attack, m.release];
    expect(rowLabels().filter((l) => order.includes(l))).toEqual(order);
    screen.close();
  });

  it("prints a raw through the catalogue's own formatter", () => {
    holding("ch1", "Compander-H");
    h.plan.nodeParams.ch1!.insertFxParams = { [insertFxParamKey("compander", 6)]: -2000 };
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "ch1");
    // -2000 raw is -20.0 dB; the raw itself must not reach the screen.
    const shown = [...h.box.querySelectorAll<HTMLElement>(".gt-val")].map((e) => e.textContent);
    expect(shown).toContain("-20.0 dB");
    expect(shown).not.toContain("-2000");
    screen.close();
  });

  // What `labelsOn` above cannot see, and what shipped broken because of it: a discrete
  // control is not a FIELD, so a face can have the right fields in the right order and
  // still put its selectors somewhere else. These read the panel the operator sees.
  // Membership and order only. Whether a child is one COLUMN wide is deliberately not
  // asked here: what made a discrete control span the grid was a stylesheet rule, not a
  // class, and this host loads no stylesheet and lays nothing out — an "is it a card"
  // flag read off the class list is satisfied by exactly the arrangement it names. The
  // rectangle is e2e/insertfx.spec.ts's question, in a browser, on the built bundle.
  /** The row break reads as a NAME here rather than as the empty string a card with no
   *  label would also produce, so its position is pinned and a label that went missing
   *  still fails. */
  const BREAK = "\u2014break\u2014";
  const panelCards = (): string[] =>
    [...h.box.querySelectorAll<HTMLElement>(".gt-knobs > *")].map((e) =>
      e.classList.contains("gt-break") ? BREAK : (e.querySelector<HTMLElement>(".lbl")?.textContent ?? ""),
    );
  /** Controls in the parameters section but not in the panel. Reached FROM the panel: a
   *  container named by a class that does not exist matches nothing, and a count of
   *  nothing is zero — the assertion passing for the reason it was written to catch. */
  const outsideThePanel = (): number => {
    const grid = h.box.querySelector(".gt-knobs");
    const sec = grid?.closest(".prefs-section");
    if (!sec) return -1;
    return [...sec.querySelectorAll(".prefs-row")].filter((r) => !r.closest(".gt-knobs")).length;
  };

  it("puts every control of a guitar amp in the one panel, in the order the design gives", () => {
    const m = t().inspector.insertFxEffect.params;
    // Two groups with the break between them. Above it the amp — what makes it this type,
    // its level, the master and Output, then the tone stack as one run. Below it the
    // modulation group and the cabinet, in the order the effect guide's own common table
    // lists them.
    //
    // Only the Clean amp has Modulation, so on the other three the break falls in front of
    // the cabinet's own switch instead: the two groups are the same on all four faces.
    const stack = [m.treble, m.middle, m.bass, m.presence];
    const cab = [m.gate, m.gateLevel, m.spType, m.micPosition];
    const cases: Array<[string, string[]]> = [
      ["Clean", [m.volume, m.distortion, m.blend, m.output, ...stack, BREAK, m.mod, m.modSpeed, m.modDepth, ...cab]],
      ["Crunch", [m.type, m.gain, m.output, ...stack, BREAK, ...cab]],
      ["Lead", [m.type, m.gain, m.master, m.output, ...stack, BREAK, ...cab]],
      ["Drive", [m.ampType, m.gain, m.master, m.output, ...stack, BREAK, ...cab]],
    ];
    for (const [type, order] of cases) {
      holding("ch1", type);
      const screen = new DynScreen(h.hooks);
      screen.open(INSFX_DYN, "ch1");
      expect(panelCards(), type).toEqual(order);
      // Nothing on the face is outside the panel: a control appended beside it renders as
      // a full-width row an amp's width from the label naming it.
      expect(outsideThePanel(), type).toBe(0);
      // The switch prints the state it is in rather than both words it could be, and there
      // is no bar left to reach a second face with.
      const sw = h.box.querySelector<HTMLButtonElement>(".gt-knobs .prefs-switch")!;
      expect(sw.textContent, type).toBe(t().inspector.off);
      expect(h.box.querySelector(".gt-knobs .prefs-toggle"), type).toBeNull();
      expect(h.box.querySelector(".gt-facebar button"), type).toBeNull();
      screen.close();
    }
    // …and the modulation selector's WORDING, which the list above cannot pin: every
    // expectation there is built from the catalogue that printed it, so the row could be
    // renamed to anything and the order would still match. The design names it Modulation.
    holding("ch1", "Clean");
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "ch1");
    expect(panelCards()).toContain("Modulation");
    screen.close();
  });

  it("shows no plot: an amp's response and a pitch trace are not derivable", () => {
    holding("ch1", "Drive");
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "ch1");
    expect(h.box.querySelector(".gt-ladders")).not.toBeNull();
    expect(h.box.querySelector("canvas")).toBeNull();
    screen.close();
  });

  it("closes itself when a follow takes the effect away underneath it", () => {
    holding("ch1", "Compander-H");
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "ch1");
    expect(screen.isOpen()).toBe(true);
    h.plan.nodeParams.ch1!.insertFx = INSERT_FX_NONE;
    screen.refresh();
    expect(screen.isOpen()).toBe(false);
  });
});

describe("the guitar amp's two faces", () => {
  const labelsOn = (proc: typeof INSFX_DYN, ctx: DynCtx): string[] => {
    const fields = proc.bind(ctx)!.fields;
    return fields.map((f) => proc.fieldLabel!(f, t(), ctx) ?? f.key);
  };

  it("offers a face bar to the family that has faces, and to no other", () => {
    // One processor per family here, and a family with several faces has a `sel` rather
    // than a second descriptor — its faces are the same panel over other slots. The
    // multi-band compressor is the only one: three compressors and the two frequencies
    // that decide what each hears. Everything else is one processor and one face.
    for (const label of ["Clean", "Drive", "Pitch Fix", "Compander-H"]) {
      expect(INSFX_DYN.bar!(holding("ch1", label)), label).toBeUndefined();
    }
    expect(INSFX_DYN.bar!(holding("bus.mix1", "M.B.Comp"))!.items).toHaveLength(4);
  });

  it("leads the amp face with what makes it this amp, then the level it is driven at", () => {
    const m = t().inspector.insertFxEffect.params;
    expect(labelsOn(INSFX_DYN, holding("ch1", "Clean"))).toEqual([
      m.volume,
      m.distortion,
      m.blend,
      m.output,
      m.treble,
      m.middle,
      m.bass,
      m.presence,
      m.modSpeed,
      m.modDepth,
      m.gateLevel,
    ]);
    expect(labelsOn(INSFX_DYN, holding("ch1", "Drive"))).toEqual([
      m.gain,
      m.master,
      m.output,
      m.treble,
      m.middle,
      m.bass,
      m.presence,
      m.gateLevel,
    ]);
  });

  it("reverses the columns where the panel is the point, and leaves them where the display is", () => {
    // A guitar amp and Pitch Fix are both a dozen continuous values against a column with
    // no reading of its own but the level taps. The companders' and the multi-band
    // compressor's displays are the point of their screens and keep the ordinary order.
    expect(INSFX_DYN.bind(holding("ch1", "Lead"))!.paramsFirst).toBe(true);
    expect(INSFX_DYN.bind(holding("ch1", "Pitch Fix"))!.paramsFirst).toBe(true);
    expect(INSFX_DYN.bind(holding("ch1", "Compander-S"))!.paramsFirst).toBeUndefined();
    expect(INSFX_DYN.bind(holding("bus.mix1", "M.B.Comp"))!.paramsFirst).toBeUndefined();
  });

  it("tags Speed and Depth while the modulation is not vibrato, and leaves them writable", () => {
    const ctx = holding("ch1", "Clean");
    // The modulation selector is slot 19, its factory value Off.
    const off = INSFX_DYN.rowStates!(ctx, INSFX_DYN.read(ctx))!;
    // The tag says WHEN the value applies. It is not a lock: the unit stores both whatever
    // the modulation reads and takes a write to either, so refusing the gesture here would
    // be the app forbidding what the unit allows.
    expect(off.get("ifx:guitar-clean:20")?.tag).toBe(t().dynTuning.insfx.vibOnly);
    expect(off.get("ifx:guitar-clean:21")?.tag).toBe(t().dynTuning.insfx.vibOnly);
    expect(off.get("ifx:guitar-clean:20")?.locked).toBeUndefined();
    expect(off.get("ifx:guitar-clean:21")?.locked).toBeUndefined();
    // …and nothing on this family is locked, which is what the MIDI surface asks too.
    expect(insertFxLockedSlots("guitar-clean", h.plan.nodeParams.ch1?.insertFxParams).size).toBe(0);
    // …and the rendered rows agree, which is the half a state map cannot show: the host
    // applies these states, so a row that stopped being live would still read `locked:
    // undefined` here.
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "ch1");
    for (const slot of [20, 21]) {
      const card = h.box.querySelector<HTMLElement>(`.gt-knob:has(input[data-dyn="ifx:guitar-clean:${slot}"])`)!;
      expect(card.classList.contains("locked"), String(slot)).toBe(false);
      expect(card.querySelector<HTMLInputElement>("input")!.disabled, String(slot)).toBe(false);
      expect(card.querySelector(".gt-knobtag")?.textContent, String(slot)).toBe(t().dynTuning.insfx.vibOnly);
    }
    screen.close();

    // The positive control: on the vibrato the tag goes, so the tag is about the setting
    // rather than about every Clean panel.
    h.plan.nodeParams.ch1!.insertFxParams = { "19": 2 };
    expect(INSFX_DYN.rowStates!(ctx, INSFX_DYN.read(ctx))).toBeNull();
  });
});

describe("moving between the faces", () => {
  const face = (id: string): HTMLElement => h.box.querySelector<HTMLElement>(`#${id}`)!;

  it("gives a guitar amp reversed columns and no bar to swap", () => {
    // Its panel is up to fifteen controls and its display is a level rack with nothing else
    // in it, so the two columns swap. And there is nothing to switch between any more: the
    // cabinet joined the amp on one face, and a bar with one item is a control that does
    // nothing.
    holding("ch1", "Clean");
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "ch1");
    const m = t().inspector.insertFxEffect.params;
    const labels = rowLabels;
    expect(h.box.querySelector<HTMLElement>(".prefs-grid")!.classList.contains("gt-paramsleft")).toBe(true);
    // Both halves on the one face: the amp's and the cabinet's.
    expect(labels()).toContain(m.blend);
    expect(labels()).toContain(m.spType);
    expect(h.box.querySelector("#dyn-face-insfx-cab")).toBeNull();
    screen.close();
  });

  it("swaps the multi-band compressor's faces without closing", () => {
    holding("bus.mix1", "M.B.Comp");
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "bus.mix1");
    const m = t().inspector.insertFxEffect.params;
    const labels = rowLabels;
    expect(labels()).toContain(m.xoverLowMid);

    face("dyn-face-insfx-low").click();
    expect(screen.isOpen()).toBe(true);
    expect(labels()).toContain(m.threshold);
    expect(labels()).not.toContain(m.xoverLowMid);
    screen.close();
  });

  it("opens each band face on that band's own Bypass, and closes it on that band's make-up", () => {
    // The Bypass decides whether anything under it reaches the signal, so it leads; the
    // make-up is last because it is what the compression above it is finally weighed at,
    // and it carries its band name because MAIN carries the same value.
    holding("bus.mix1", "M.B.Comp");
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "bus.mix1");
    const m = t().inspector.insertFxEffect;
    for (const [id, band] of [
      ["low", m.bandLow],
      ["mid", m.bandMid],
      ["high", m.bandHigh],
    ] as const) {
      face(`dyn-face-insfx-${id}`).click();
      expect(rowLabels(), id).toEqual([
        t().inspector.on,
        m.params.oneKnobLevel,
        m.params.bypass,
        m.params.threshold,
        m.params.ratio,
        m.params.attack,
        m.params.release,
        `${band} ${m.params.gain}`,
      ]);
    }
    // …and MAIN carries none of them: each belongs to one band.
    face("dyn-face-insfx-main").click();
    expect(rowLabels()).not.toContain(m.params.bypass);
    screen.close();
  });

  it("draws a band's Bypass locked while the 1-Knob owns it, not only in the state map", () => {
    // The host applies `rowStates` to the FIELDS it lays out; a row the descriptor builds
    // has to ask for the same answer itself. The Bypass is the first locked row on this
    // screen that is not a slider, and drawn live it writes a plan value the writer is
    // refusing to send — the drift the lock exists to stop. Asserted on the RENDERED row,
    // because the map said `locked: true` throughout the version that had the defect.
    const bypassCard = (): HTMLElement =>
      [...h.box.querySelectorAll<HTMLElement>(".prefs-row .lbl, .gt-knob .lbl")]
        .find((lbl) => lbl.textContent === t().inspector.insertFxEffect.params.bypass)!
        .closest<HTMLElement>(".prefs-row, .gt-knob")!;

    // The positive control first: with the knob off the row is live, so what the assertion
    // below reads is the knob rather than a row this screen always disables.
    holding("bus.mix1", "M.B.Comp");
    h.plan.nodeParams["bus.mix1"]!.insertFxOn = true;
    const off = new DynScreen(h.hooks);
    off.open(INSFX_DYN, "bus.mix1");
    face("dyn-face-insfx-low").click();
    expect(bypassCard().classList.contains("locked")).toBe(false);
    expect(bypassCard().querySelector("button")!.disabled).toBe(false);
    off.close();

    h.plan.nodeParams["bus.mix1"]!.insertFxParams = {
      [insertFxParamKey("mbc", MBC_GLOBAL.oneKnobOn)]: 1,
      [insertFxParamKey("mbc", MBC_GLOBAL.oneKnobLevel)]: 24,
    };
    const on = new DynScreen(h.hooks);
    on.open(INSFX_DYN, "bus.mix1");
    face("dyn-face-insfx-low").click();
    expect(bypassCard().classList.contains("locked")).toBe(true);
    expect(bypassCard().querySelector("button")!.disabled).toBe(true);
    on.close();
  });

  it("goes back to the first face, and the ordinary columns, when a follow replaces the effect", () => {
    holding("bus.mix1", "M.B.Comp");
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "bus.mix1");
    face("dyn-face-insfx-low").click();
    expect(h.box.querySelector("#dyn-face-insfx-low")!.getAttribute("aria-pressed")).toBe("true");

    // The device says the bus now holds a compander. The other faces do not exist there,
    // and reading that as "the processor is gone" would close a screen that has something
    // to show.
    h.plan.nodeParams["bus.mix1"]!.insertFx = valueOf("Compander-H");
    screen.refresh();
    expect(screen.isOpen()).toBe(true);
    const m = t().inspector.insertFxEffect.params;
    const labels = rowLabels();
    expect(labels).toContain(m.width);
    expect(h.box.querySelector("#dyn-face-insfx-low")).toBeNull();
    // …and the ordinary columns with it: the compander's display is the point of its
    // screen, so it does not take the reversal a panel-first family takes.
    expect(h.box.querySelector<HTMLElement>(".prefs-grid")!.classList.contains("gt-paramsleft")).toBe(false);
    screen.close();
  });

  it("puts Pitch Fix on one face, Correction first, with the level rack beside it", () => {
    // Its display column used to carry a READ-ONLY copy of the controls next to it — the
    // Key, the Scale and the twelve notes, drawn twice on one face — and no lane rack at
    // all. Correction leads because it is the switch the whole effect hangs off: everything
    // under it describes a correction that is not happening while it is off.
    holding("ch1", "Pitch Fix");
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "ch1");
    const m = t().inspector.insertFxEffect;
    // Everything both former faces carried, on this one, in the order the unit lists it:
    // the switch, what the correction does to a note, then what it is aimed at — MIDI
    // Control in front of the Key, because it decides where those notes come from — and
    // then the range it works over and how fast it gets there.
    expect(rowLabels()).toEqual([
      m.params.correction,
      m.params.coarse,
      m.params.fine,
      m.params.formant,
      m.params.midiControl,
      m.params.key,
      m.scale,
      m.params.mix,
      m.params.limitLow,
      m.params.limitHigh,
      m.params.speed,
      m.params.tolerance,
      m.scaleNotes,
    ]);
    // The panel takes the flexible column and the meters the narrow one, and there is no
    // bar to a second face.
    expect(h.box.querySelector<HTMLElement>(".prefs-grid")!.classList.contains("gt-paramsleft")).toBe(true);
    expect(h.box.querySelector(".gt-facebar button")).toBeNull();
    expect(h.box.querySelector(".gt-ladders")).not.toBeNull();
    // …and no second copy of the twelve notes: one grid of them, not two.
    expect(h.box.querySelectorAll(".gt-notes").length).toBe(1);
    expect(h.box.querySelector(".gt-scaleview")).toBeNull();
    screen.close();
  });
});

describe("a bypassed effect", () => {
  const note = (): string => h.box.querySelector<HTMLElement>(".gt-note")!.textContent ?? "";

  it("says so, and still lets the values be edited", () => {
    holding("ch1", "Compander-H");
    h.plan.nodeParams.ch1!.insertFxOn = false;
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "ch1");
    expect(note()).toBe(t().dynTuning.insfx.bypassed);
    // The rows are live: the plan holds the values and the unit stores them whether or
    // not the effect is in the path.
    const slider = h.box.querySelector<HTMLInputElement>('input[data-dyn="ifx:compander:6"]')!;
    expect(slider.disabled).toBe(false);
    screen.close();
  });

  // Engaged, the line stops saying why nothing reaches the signal — because something
  // does. What takes its place depends on whether there is a curve to explain: the
  // compander's says what its three segments do, the same line the compressor screens
  // carry, and a family with no curve says nothing at all. Both keep the line's space, so
  // the controls below it start at the same height either way.
  it("explains the curve while a compander is engaged, and keeps the line's space", () => {
    holding("ch1", "Compander-H");
    h.plan.nodeParams.ch1!.insertFxOn = true;
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "ch1");
    expect(note()).toBe(t().dynTuning.insfx.curveHint);
    expect(h.box.querySelector(".gt-note")).not.toBeNull();
    screen.close();
  });

  it("says nothing while a family with no curve is engaged, and keeps the line's space", () => {
    holding("ch1", "Clean");
    h.plan.nodeParams.ch1!.insertFxOn = true;
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "ch1");
    expect(note()).toBe("");
    expect(h.box.querySelector(".gt-note")).not.toBeNull();
    screen.close();
  });
});

// The compander is the one family whose response is DEFINED by its parameters, so it is
// the one that carries a curve. What the curve is, is the block's own three segments — an
// expander under the window, the set ratio over the threshold, a limiter past 0 dBFS — and
// the two variants differ in the expander's slope alone.
//
// Asserted on the response itself rather than on pixels: the shape is arithmetic, and a
// straight line through the middle would render perfectly and mean nothing. That the
// screen REACHES it is the DOM case below.
describe("the compander's transfer curve", () => {
  /** The factory compander, in the raws the plan stores: Threshold -10 dB, Ratio 3.5:1,
   *  Width 6 dB, Out Gain 0 dB. Read off the catalogue so the arithmetic below is stated
   *  in the same numbers the panel prints. */
  const factory = (): DynValues => {
    const raws = new Map<string, number>();
    for (const d of insertFxParams("compander")) raws.set(`ifx:compander:${d.slot}`, d.def);
    return { get: (k: string) => raws.get(k) ?? 0 } as DynValues;
  };

  it("passes the window, holds back above the threshold, and stops past 0 dB", () => {
    const out = companderResponse(factory(), "compander", valueOf("Compander-H"));
    // The window is Threshold - Width … Threshold = -16 … -10, and passes unchanged.
    expect(out(-16)).toBeCloseTo(-16, 6);
    expect(out(-13)).toBeCloseTo(-13, 6);
    expect(out(-10)).toBeCloseTo(-10, 6);
    // Above it, the set ratio: -10 + (in + 10) / 3.5.
    expect(out(-3)).toBeCloseTo(-10 + 7 / 3.5, 6);
    expect(out(0)).toBeCloseTo(-10 + 10 / 3.5, 6);
    // …and past 0 dBFS nothing more gets out.
    expect(out(6)).toBeCloseTo(out(0), 6);
    expect(out(24)).toBeCloseTo(out(0), 6);
  });

  it("drops five times as fast on H as one and a half on S, below the window", () => {
    const h = companderResponse(factory(), "compander", valueOf("Compander-H"));
    const s = companderResponse(factory(), "compander", valueOf("Compander-S"));
    // 4 dB under the window: H is 20 dB down from it, S is 6.
    expect(h(-20)).toBeCloseTo(-16 - 4 * 5, 6);
    expect(s(-20)).toBeCloseTo(-16 - 4 * 1.5, 6);
    // …and they are the same everywhere else, which is what says the slope is the ONLY
    // difference rather than two unrelated curves.
    for (const inDb of [-16, -13, -10, -3, 0, 6]) expect(h(inDb)).toBeCloseTo(s(inDb), 6);
  });

  it("moves the whole curve down by Out Gain", () => {
    const raws = new Map<string, number>();
    for (const d of insertFxParams("compander")) raws.set(`ifx:compander:${d.slot}`, d.def);
    const gainSlot = insertFxParams("compander").find((d) => d.label === "gain")!.slot;
    raws.set(`ifx:compander:${gainSlot}`, -600); // -6 dB
    const v = { get: (k: string) => raws.get(k) ?? 0 } as DynValues;
    const out = companderResponse(v, "compander", valueOf("Compander-H"));
    const plain = companderResponse(factory(), "compander", valueOf("Compander-H"));
    for (const inDb of [-30, -13, -3, 6]) expect(out(inDb)).toBeCloseTo(plain(inDb) - 6, 6);
  });

  it("puts a plot in the column for a compander and none for a guitar amp", () => {
    holding("bus.stereo", "Compander-H");
    const withCurve = new DynScreen(h.hooks);
    withCurve.open(INSFX_DYN, "bus.stereo");
    expect(h.box.querySelector("#dyn-curve")).not.toBeNull();
    withCurve.close();

    holding("ch1", "Clean");
    const without = new DynScreen(h.hooks);
    without.open(INSFX_DYN, "ch1");
    // A guitar amp's frequency response is not derivable from these values and the unit
    // meters none of it, so the column is the lane rack alone.
    expect(h.box.querySelector("#dyn-curve")).toBeNull();
    without.close();
  });
});

describe("a gesture that outlives the family it started under", () => {
  it("writes a stale row's value under the family that row was built for", () => {
    // A device follow can replace the effect while a slider is under the pointer, and the
    // drag goes on firing at a row that is already detached. Guitar and compander share
    // slots 7, 9, 10 and 11, where they are different parameters on different scales — so
    // resolving the family at write time would put a guitar value into a compander's
    // Release. Keyed by family, it lands in the outgoing family's parked values instead.
    const ctx = holding("ch1", "Clean");
    ctx.plan.nodeParams.ch1!.insertFxParams = { [insertFxParamKey("compander", 9)]: 2290 };
    // The follow has landed: the plan now holds a compander.
    ctx.plan.nodeParams.ch1!.insertFx = valueOf("Compander-H");
    const written = INSFX_DYN.patch(ctx, { "ifx:guitar-clean:9": 30 }).insertFxParams!;
    expect(written[insertFxParamKey("guitar-clean", 9)]).toBe(30);
    // …and the compander's own Release is still what the device read put there.
    expect(written[insertFxParamKey("compander", 9)]).toBe(2290);
  });

  it("prints a stale row through the formatter of the family that built it", () => {
    const ctx = holding("ch1", "Compander-H");
    const guitarBass = { key: "ifx:guitar-clean:9", min: 0, max: 100, step: 1, def: 50, unit: "raw" } as const;
    // Slot 9 is the guitar's Bass (a 0..10 knob) and the compander's Release (ms). A row
    // that says Bass has to go on saying Bass.
    expect(INSFX_DYN.fieldLabel!(guitarBass, t(), ctx)).toBe(t().inspector.insertFxEffect.params.bass);
    expect(INSFX_DYN.fieldText!(guitarBass, 30, ctx)).toBe("3.0");
  });
});

describe("what the compander's plot draws beside its curve", () => {
  const TOK: Record<string, string> = { "--plot-dim": "#dim", "--gr": "#rose", "--led": "#led" };
  const W = 600;
  const H = 320;

  it("marks the window edge and the threshold, which are kinks and nothing else", () => {
    // Both coordinates the curve's SHAPE is built from. Without a mark, reading either off
    // the plot means finding where the slope changes and estimating it.
    const ctx = holding("ch1", "Compander-H");
    const geo = INSFX_DYN.plotGeo!(W, H, ctx);
    const r = recorder();
    // Threshold -30 dB, Width 24 dB — so the window edge is at -54.
    INSFX_DYN.drawCurve!(r.ctx, geo, vals({ "ifx:compander:6": -3000, "ifx:compander:11": 2400 }), TOK, ctx);
    const marks = r.texts.filter((x) => x.text === "W" || x.text === "T");
    expect(marks.map((x) => x.text).sort()).toEqual(["T", "W"]);
    // Within a pixel: the mark is snapped to a half-pixel so the 1px rule lands on one
    // device pixel instead of straddling two, which is a hairline either side of the value.
    const at = (tag: string): number => marks.find((x) => x.text === tag)!.x;
    expect(Math.abs(at("T") - geo.px(-30))).toBeLessThanOrEqual(1);
    expect(Math.abs(at("W") - geo.px(-54))).toBeLessThanOrEqual(1);
    // Not in the reduction's ink: rose means gain reduction on every screen and these are
    // settings. `--plot-dim` is also a token the canvas is HANDED (palette.contract).
    expect(marks.every((x) => x.style === TOK["--plot-dim"])).toBe(true);
  });

  it("names which expander the window's lower slope is, which no row carries", () => {
    // The two Companders differ in this one number and share a family, so the screen's rows
    // cannot say it — the selector decides it.
    for (const [type, slope] of [
      ["Compander-H", "5:1"],
      ["Compander-S", "1.5:1"],
    ] as const) {
      const ctx = holding("ch1", type);
      const r = recorder();
      INSFX_DYN.drawCurve!(r.ctx, INSFX_DYN.plotGeo!(W, H, ctx), vals({}), TOK, ctx);
      expect(
        r.texts.map((x) => x.text),
        type,
      ).toContain(`EXPANDER ${slope}`);
    }
  });

  it("puts the LIVE reduction on the plot, and nothing there without a reading", () => {
    // The annotation hanging off the curve is the model's arithmetic at full scale and does
    // not move with the signal; this is the number the meter is reporting. On the live
    // layer, because the static one is not redrawn per frame.
    const ctx = holding("ch1", "Compander-H");
    const geo = INSFX_DYN.plotGeo!(W, H, ctx);
    const lit = recorder();
    INSFX_DYN.drawLive!(lit.ctx, geo, (k) => (k === "gr" ? -9 : k === "in" ? -20 : -29), TOK, ctx);
    expect(lit.texts.map((x) => x.text)).toContain("GR -9.0 dB");
    // No feed: a parked figure would say the effect is passing everything, which is a
    // different state from not being metered.
    const dark = recorder();
    INSFX_DYN.drawLive!(dark.ctx, geo, () => null, TOK, ctx);
    expect(dark.texts.filter((x) => x.text.startsWith("GR "))).toEqual([]);
  });
});

describe("what the note under the display says", () => {
  const note = (): string => h.box.querySelector<HTMLElement>(".gt-note")!.textContent ?? "";

  it("names the effect and its ceiling when the rate has switched it off", () => {
    // The Inspector and the CONSOLE chip both say this; the screen said nothing, and opened
    // a live editor over DSP the unit had already dropped.
    holding("ch1", "Pitch Fix");
    h.plan.sampleRate = 88200;
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "ch1");
    expect(note()).toContain("Pitch Fix");
    expect(note()).toContain("48 kHz");
    screen.close();
  });

  it("names the ceiling on a bus too, for an effect the bus itself carries", () => {
    // The rate half of the same question on an output node. A CHANNEL effect on a bus does
    // not reach here at all — the screen refuses that plan, since the emit path drops it —
    // so the case that does reach here is an effect the bus's own control lists.
    holding("bus.mix1", "Compander-H");
    h.plan.sampleRate = 192000;
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "bus.mix1");
    expect(note()).toContain("Compander-H");
    screen.close();
  });

  it("says the effect is bypassed only when the rate is not the reason", () => {
    holding("ch1", "Compander-H");
    h.plan.sampleRate = 48000;
    h.plan.nodeParams.ch1!.insertFxOn = false;
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "ch1");
    expect(note()).toBe(t().dynTuning.insfx.bypassed);
    screen.close();
  });

  it("explains a figure and says nothing where there is none", () => {
    // The line under the display describes what the display is. Pitch Fix has none to
    // describe any more — its column is the level taps, the same as a guitar amp's — and
    // it used to carry a line because its column held a read-only copy of its own controls
    // that read as something the unit was tracking.
    // Engaged and at a rate that runs it: both of the other notes outrank this one, which
    // is the point of the ordering and would otherwise be what this case measured.
    const engaged = (label: string): void => {
      holding("ch1", label);
      h.plan.sampleRate = 48000;
      h.plan.nodeParams.ch1!.insertFxOn = true;
    };
    engaged("Pitch Fix");
    const pitch = new DynScreen(h.hooks);
    pitch.open(INSFX_DYN, "ch1");
    expect(note()).toBe("");
    pitch.close();
    // …and it is the pitch line, not one every family gets: the compander keeps its own.
    engaged("Compander-H");
    const comp = new DynScreen(h.hooks);
    comp.open(INSFX_DYN, "ch1");
    expect(note()).toBe(t().dynTuning.insfx.curveHint);
    comp.close();
    // A guitar face has a lane rack and nothing to explain.
    engaged("Clean");
    const amp = new DynScreen(h.hooks);
    amp.open(INSFX_DYN, "ch1");
    expect(note()).toBe("");
    amp.close();
  });
});

describe("a plan value the device path will not act on", () => {
  it("refuses the screen for a bus holding a CHANNEL effect, at a rate that runs it", () => {
    // 48 kHz, so nothing here is about the ceiling. The bus's own control does not carry a
    // guitar amp or Pitch Fix, and translate.ts coerces such a value to No Effect and emits
    // no engine parameter at all, so an editor over it collects edits nothing ever sends.
    h.plan.sampleRate = 48000;
    h.plan.nodeParams["bus.mix1"] = { insertFx: valueOf("Pitch Fix") };
    const ctx: DynCtx = { model: h.model, plan: h.plan, nodeId: "bus.mix1", sel: 0, m: t() };
    expect(insertFxScreenFamily(h.model, h.plan, "bus.mix1")).toBeNull();
    expect(INSFX_DYN.bind(ctx)).toBeNull();
    const cmds = planToCommands(h.model, h.plan);
    expect(cmds.filter((c) => c.name === "INSERT_FX_EFFECT")).toHaveLength(0);
  });

  it("still opens for an effect the node's own control does carry", () => {
    // The control that says the refusal above is about the option list and not about buses.
    h.plan.sampleRate = 48000;
    h.plan.nodeParams["bus.mix1"] = { insertFx: valueOf("Compander-H") };
    const ctx: DynCtx = { model: h.model, plan: h.plan, nodeId: "bus.mix1", sel: 0, m: t() };
    expect(insertFxScreenFamily(h.model, h.plan, "bus.mix1")).toBe("compander");
    expect(INSFX_DYN.bind(ctx)?.fields.length).toBeGreaterThan(0);
  });
});

describe("what an edit tells the write witness it asserted", () => {
  it("names the qualified key AND the bare slot the re-key removes, per patched slot", () => {
    // The funnel drops a named GROUP and falls back to the plan's own diff, which sees only
    // what MOVED — so a slot written the value it already holds is invisible there and a
    // device read in flight takes it back. The Scale selector writes twelve mask slots at
    // once with several already correct, which is exactly that case.
    const ctx = holding("ch1", "Pitch Fix");
    const written = INSFX_DYN.written!(ctx, { "ifx:pitch:22": 1, "ifx:pitch:27": 0 });
    expect(written).toEqual([
      "insertFxParams.pitch:22",
      "insertFxParams.22",
      "insertFxParams.pitch:27",
      "insertFxParams.27",
    ]);
  });

  it("is what the host forwards to the funnel", () => {
    // Asserted through the screen rather than on the descriptor alone: a hook nothing calls
    // is the same as no hook, and the host's own call is the half a descriptor test cannot
    // see. The plan path is the family-qualified key, NOT the field key the row carries.
    holding("ch1", "Compander-H");
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "ch1");
    const slider = h.box.querySelector<HTMLInputElement>('input[data-dyn="ifx:compander:6"]')!;
    slider.value = String(Number(slider.value) + Number(slider.step || 1));
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    const call = h.patches.at(-1)!;
    expect(call.written).toEqual(["insertFxParams.compander:6", "insertFxParams.6"]);
    screen.close();
  });
});

describe("a gesture taken while the rebuild is deferred", () => {
  const K = (slot: number): string => insertFxParamKey("pitch", slot);
  const MASK = [22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33];
  const maskOf = (): number[] => {
    const p = h.plan.nodeParams.ch1!.insertFxParams!;
    return MASK.map((s) => p[K(s)] ?? 0);
  };
  /** A press anywhere in the box defers the rebuild, then the plan moves underneath. */
  const followKeyTo = (screen: DynScreen, key: number): void => {
    h.box.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    h.plan.nodeParams.ch1!.insertFxParams = {
      ...(h.plan.nodeParams.ch1!.insertFxParams ?? {}),
      [K(PITCH_KEY_SLOT)]: key,
    };
    screen.refresh();
  };

  it("roots a Scale at the Key the plan holds, not the one the row was drawn with", () => {
    holding("ch1", "Pitch Fix");
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "ch1");
    const sel = [...h.box.querySelectorAll<HTMLSelectElement>("select")].find((s) =>
      [...s.options].some((o) => o.textContent === t().inspector.insertFxEffect.scaleMajor),
    )!;
    followKeyTo(screen, 7);
    sel.value = String(PITCH_SCALE_MAJOR);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    expect(maskOf()).toEqual([1, 0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1]); // G major
    screen.close();
  });

  it("toggles a note from the value the plan holds, not the one the button shows", () => {
    holding("ch1", "Pitch Fix");
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "ch1");
    const f = h.box.querySelectorAll<HTMLButtonElement>(".gt-notes button")[5]!; // F
    expect(f.getAttribute("aria-pressed")).toBe("true");
    // A follow switches F off under the deferred rebuild; the button still shows it on.
    h.box.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    h.plan.nodeParams.ch1!.insertFxParams = { ...(h.plan.nodeParams.ch1!.insertFxParams ?? {}), [K(27)]: 0 };
    screen.refresh();
    expect(f.getAttribute("aria-pressed")).toBe("true");
    f.click();
    // Pressing it turns it ON, because OFF is what the plan holds. Reading the button's own
    // state would have written 0 over a 0 and left the operator pressing a dead control.
    expect(h.plan.nodeParams.ch1!.insertFxParams![K(27)]).toBe(1);
    screen.close();
  });
});

describe("the bank identity", () => {
  it("moves when the TYPE moves inside one family, not only between families", () => {
    // A Clean amp and a Drive amp are different rows on the same face, so an identity that
    // only told families apart would leave the CAB segment selected and the panel showing
    // the amp face's rows for a type it no longer holds.
    const clean = INSFX_DYN.bankIdentity!(holding("ch1", "Clean"));
    const drive = INSFX_DYN.bankIdentity!(holding("ch1", "Drive"));
    const comp = INSFX_DYN.bankIdentity!(holding("ch1", "Compander-H"));
    expect(new Set([clean, drive, comp]).size).toBe(3);
  });
});

// The multi-band compressor: four faces over nineteen values the app writes, two the unit
// does not let it, and three reductions the unit meters separately. Everything below is
// about keeping those apart — a value on the wrong face is a control whose neighbours say
// nothing about it, and a value in the wrong group is either a control that does nothing or
// a write that discards the operator's whole setting.
describe("the multi-band compressor", () => {
  const TOK: Record<string, string> = {
    "--plot-dim": "#dim",
    "--plot-faint": "#faint",
    "--gr": "#rose",
    "--led": "#led",
  };
  const W = 600;
  const H = 320;
  const MAIN = 0;
  const LOW = 1;

  // Engaged, because a bypassed effect's note outranks everything the panel would say and
  // this describe is about what the panel says.
  const mbc = (sel = MAIN, params: Record<string, number> = {}): DynCtx => {
    const ctx = holding("bus.mix1", "M.B.Comp");
    h.plan.nodeParams["bus.mix1"]!.insertFxOn = true;
    h.plan.nodeParams["bus.mix1"]!.insertFxParams = params;
    return { ...ctx, sel };
  };
  const oneKnobOn = (): Record<string, number> => ({
    [insertFxParamKey("mbc", MBC_GLOBAL.oneKnobOn)]: 1,
    [insertFxParamKey("mbc", MBC_GLOBAL.oneKnobLevel)]: 24,
  });
  const slotsOf = (ctx: DynCtx): number[] => INSFX_DYN.bind(ctx)!.fields.map((f) => Number(/:(\d+)$/.exec(f.key)?.[1]));

  it("splits the continuous values into what the bands share and what each band is", () => {
    // MAIN: the levels the three bands are mixed back at, then Out Gain, then the two
    // crossovers that decide what each band hears. A band face: that band's dynamics, the
    // Release the three of them share, and last the level that band comes back at. Sixteen
    // on one panel fits and is still nineteen with nothing saying which five belong together.
    //
    // The three Bypasses are not here: `fields` is the CONTINUOUS half, and a toggle is a
    // row. Where each of them renders is pinned by the band face's own card order.
    expect(slotsOf(mbc(MAIN))).toEqual([11, 16, 21, 26, 23, 24]);
    expect(slotsOf(mbc(1))).toEqual([9, 10, 8, 25, 11]);
    expect(slotsOf(mbc(2))).toEqual([14, 15, 13, 25, 16]);
    expect(slotsOf(mbc(3))).toEqual([19, 20, 18, 25, 21]);
    // Every continuous writable slot is reachable. Two kinds are on more than one face: the
    // Release the three bands share, and each band's own make-up, which MAIN weighs against
    // the other two and the band's own face weighs against the compression above it.
    const all = [MAIN, 1, 2, 3].flatMap((s) => slotsOf(mbc(s)));
    expect(new Set(all).size).toBe(16);
    expect(all.filter((x) => x === 25)).toHaveLength(3);
    for (const gain of [11, 16, 21])
      expect(
        all.filter((x) => x === gain),
        String(gain),
      ).toHaveLength(2);
  });

  it("names a row by its band where the three share a face, and for the make-up everywhere", () => {
    const m = t().inspector.insertFxEffect;
    const label = (ctx: DynCtx, slot: number): string | undefined =>
      INSFX_DYN.fieldLabel!(
        INSFX_DYN.bind(ctx)!.fields.find((f) => f.key === `ifx:mbc:${slot}`)!,
        t(),
        ctx,
      );
    // MAIN carries all three make-up gains, so three cards saying Gain are three different
    // parameters and the panel is what has to tell them apart.
    expect(label(mbc(MAIN), 11)).toBe(`${m.bandLow} ${m.params.gain}`);
    expect(label(mbc(MAIN), 16)).toBe(`${m.bandMid} ${m.params.gain}`);
    // …and on the band's own face the face says which band it is, so repeating it on every
    // card is a word that carries nothing.
    expect(label(mbc(1), 9)).toBe(m.params.threshold);
    expect(label(mbc(1), 25)).toBe(m.params.release);
    // The make-up is the exception, because it is the one row MAIN carries as well: named
    // there and bare here, one value would read as two.
    expect(label(mbc(1), 11)).toBe(`${m.bandLow} ${m.params.gain}`);
    expect(label(mbc(3), 21)).toBe(`${m.bandHigh} ${m.params.gain}`);
  });

  it("offers the four faces on one descriptor, since they are one panel over other slots", () => {
    const bar = INSFX_DYN.bar!(mbc(MAIN))!;
    const g = t().dynTuning.insfx;
    const m = t().inspector.insertFxEffect;
    expect(bar.items.map((i) => i.label)).toEqual([g.faceMain, m.bandLow, m.bandMid, m.bandHigh]);
    expect(bar.items.map((i) => i.sel)).toEqual([0, 1, 2, 3]);
    // One descriptor, not four: Pitch Fix needs a second because its other face builds rows
    // this one cannot, and these four do not.
    expect(bar.items.every((i) => i.face === INSFX_DYN)).toBe(true);
  });

  it("gives a band face its own reduction and MAIN none", () => {
    // 133's x is the effect's BAND, not the bus: one output insert effect runs device-wide.
    for (const [sel, addr] of [
      [1, [133, 0]],
      [2, [133, 1]],
      [3, [133, 2]],
    ] as const) {
      const lanes = INSFX_DYN.bind(mbc(sel))!.lanes;
      expect(
        lanes.map((l) => l.key),
        String(sel),
      ).toEqual(["in", "out", "gr"]);
      expect(lanes[2].gr, String(sel)).toEqual(addr);
    }
    // MAIN sets the crossovers and the levels the bands come back at; three reductions
    // beside those say which band is working without saying anything about what is set.
    expect(INSFX_DYN.bind(mbc(MAIN))!.lanes.map((l) => l.key)).toEqual(["in", "out"]);
  });

  it("locks everything a Level change reasserts while 1-Knob is on, and Out Gain never", () => {
    // The positive control first: with the knob off the same call answers null, so the
    // assertion below is about the knob rather than about a screen that locks everything.
    expect(INSFX_DYN.rowStates!(mbc(MAIN), {})).toBeNull();
    const states = INSFX_DYN.rowStates!(mbc(MAIN, oneKnobOn()), {})!;
    const slotOf = (key: string): number => Number(/:(\d+)$/.exec(key)?.[1]);
    const locked = [...states.keys()].map(slotOf).sort((a, b) => a - b);
    // Nine the Level recomputes (Threshold, Ratio, Gain per band) and nine it pins back to
    // fixed values whatever was written over them (the three Attacks, the three Bypasses,
    // Release, both crossovers). Out Gain is the one writable slot the knob leaves alone.
    expect(locked).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
    expect([...states.values()].every((o) => o.locked === true)).toBe(true);
    expect(locked).toContain(MBC_BANDS[0].attack);
    expect(locked).toContain(MBC_BANDS[0].bypass);
    expect(locked).toContain(MBC_GLOBAL.release);
    expect(locked).not.toContain(MBC_GLOBAL.outGain);
    // …and NOT tagged: eighteen copies of one word carry nothing, and the word wraps inside
    // a card and grows the panel, which is the resize the lock exists to avoid.
    expect([...states.values()].every((o) => o.tag === undefined)).toBe(true);
  });

  it("says what each face's figure is, and who owns the panel when that changes", () => {
    const g = t().dynTuning.insfx;
    expect(INSFX_DYN.hint!(mbc(MAIN))).toBe(g.mbcMainHint);
    expect(INSFX_DYN.hint!(mbc(LOW))).toBe(g.mbcBandHint);
    expect(INSFX_DYN.hint!(mbc(MAIN, oneKnobOn()))).toBe(g.mbcOneKnob);
  });

  it("names a bypassed band's figure as its values rather than as the band", () => {
    // The curve is drawn from Threshold / Ratio / Gain and does not read the Bypass, which
    // is the right shape — a bypassed EFFECT keeps its curve too — so the line under the
    // display is what carries the state. Only that band's face changes: the Bypass is one
    // control per band.
    const g = t().dynTuning.insfx;
    const bypassed = (band: number): DynCtx => mbc(band, { [insertFxParamKey("mbc", MBC_BANDS[band - 1].bypass)]: 1 });
    for (const band of [1, 2, 3]) {
      expect(INSFX_DYN.hint!(bypassed(band)), `band ${band}`).toBe(g.mbcBandBypassed);
      // …and the OTHER two faces are unaffected by it.
      for (const other of [1, 2, 3].filter((b) => b !== band)) {
        expect(INSFX_DYN.hint!({ ...bypassed(band), sel: other }), `${band} seen from ${other}`).toBe(g.mbcBandHint);
      }
      expect(INSFX_DYN.hint!({ ...bypassed(band), sel: MAIN }), `${band} seen from MAIN`).toBe(g.mbcMainHint);
    }
    // The 1-Knob owns the Bypass, so its own line still outranks this one.
    expect(INSFX_DYN.hint!(mbc(LOW, { ...oneKnobOn(), [insertFxParamKey("mbc", MBC_BANDS[0].bypass)]: 1 }))).toBe(
      g.mbcOneKnob,
    );
  });

  it("offers the 1-Knob on every face, and writes it", () => {
    // It is an operator control, like the COMP and EQ knobs it is the third of — and it is
    // on every face because it decides whose the rows below are wherever they are.
    const face = (id: string): HTMLElement => h.box.querySelector<HTMLElement>(`#${id}`)!;
    for (const sel of [MAIN, 1, 2, 3]) {
      mbc(sel, oneKnobOn());
      const screen = new DynScreen(h.hooks);
      screen.open(INSFX_DYN, "bus.mix1");
      if (sel !== MAIN) face(`dyn-face-insfx-${["low", "mid", "high"][sel - 1]}`).click();
      const rows = [...h.box.querySelectorAll<HTMLElement>(".prefs-section .prefs-row")];
      expect(rows.length, String(sel)).toBeGreaterThanOrEqual(2);
      expect(rows[0].classList.contains("locked"), String(sel)).toBe(false);
      expect(
        [...rows[0].querySelectorAll("button")].some((b) => b.disabled),
        String(sel),
      ).toBe(false);
      expect(rows[1].textContent, String(sel)).toContain("24");
      screen.close();
    }
  });

  it("locks the Level while the knob is off, which is the COMP knob's own treatment", () => {
    // It drives nothing there. The row STAYS rather than being dropped, so the section does
    // not change height on a switch — the same rule COMP's own 1-knob rows follow.
    mbc(MAIN);
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "bus.mix1");
    const rows = [...h.box.querySelectorAll<HTMLElement>(".prefs-section .prefs-row")];
    expect(rows[0].classList.contains("locked")).toBe(false);
    expect(rows[1].classList.contains("locked")).toBe(true);
    screen.close();
  });

  it("writes both bits of Pitch Fix's MIDI Control, and locks the mask it clears", () => {
    // Two bits for three modes, so the write names both; and from Setting on, the notes the
    // correction aims at come from a port of the unit's own, so the mask is the unit's.
    const ctx = holding("ch1", "Pitch Fix");
    h.plan.nodeParams.ch1!.insertFxOn = true;
    expect(INSFX_DYN.rowStates!(ctx, {})).toBeNull();
    h.plan.nodeParams.ch1!.insertFxParams = { [insertFxParamKey("pitch", 34)]: 1 };
    const states = INSFX_DYN.rowStates!(ctx, {})!;
    const slots = [...states.keys()].map((k) => Number(/:(\d+)$/.exec(k)?.[1]));
    expect(slots).toContain(PITCH_SCALE_SLOT);
    expect(slots.length).toBe(1 + PITCH_NOTE_SLOTS.length);
    expect([...states.values()].every((o) => o.locked === true)).toBe(true);
  });

  it("draws MAIN's crossovers and band levels on the canvas, where a value change reaches", () => {
    // Frequency across, band make-up up. Both of those are what MAIN sets, and the figure
    // is on the CANVAS rather than in the column so the host's own redraw carries a knob
    // move into it — as elements it showed the crossover the panel was built with.
    const ctx = mbc(MAIN);
    const geo = INSFX_DYN.plotGeo!(W, H, ctx);
    const r = recorder();
    INSFX_DYN.drawCurve!(
      r.ctx,
      geo,
      vals({ "ifx:mbc:23": 37, "ifx:mbc:24": 94, "ifx:mbc:11": 45, "ifx:mbc:16": 39, "ifx:mbc:21": 30 }),
      TOK,
      ctx,
    );
    const m = t().inspector.insertFxEffect;
    // The two boundaries, printed through the catalogue's own formatter so the plot and the
    // card beside it cannot say the frequency differently, and the three band names.
    const texts = r.texts.map((x) => x.text);
    expect(texts).toContain("125 Hz");
    expect(texts).toContain("3.35 kHz");
    expect(texts).toEqual(expect.arrayContaining([m.bandLow, m.bandMid, m.bandHigh]));
    // Three segments at three different heights: the step IS the three make-up gains.
    const levels = [0, 1, 2].map((i) => r.ys[i * 2]);
    expect(new Set(levels).size).toBe(3);
    // …and the boundaries land where the frequencies do.
    const at = (hz: number): number => geo.px(hz);
    const marks = r.texts.filter((x) => x.text === "125 Hz" || x.text === "3.35 kHz");
    expect(Math.abs(marks[0].x - at(125))).toBeLessThanOrEqual(1);
    expect(Math.abs(marks[1].x - at(3350))).toBeLessThanOrEqual(1);
  });

  it("gives a band with no room between the crossovers no width, rather than reordering them", () => {
    // The two are separately ranged and overlap, so M-H can be set below L-M. Reordering
    // them would draw a picture that reads as valid.
    const ctx = mbc(MAIN);
    const geo = INSFX_DYN.plotGeo!(W, H, ctx);
    const r = recorder();
    INSFX_DYN.drawCurve!(r.ctx, geo, vals({ "ifx:mbc:23": 90, "ifx:mbc:24": 30 }), TOK, ctx);
    // The step's three segments, as the x pairs they were stroked from: MID is empty and
    // HIGH begins where LOW ended rather than before it.
    const xs = [0, 1, 2].map((i) => [r.xs[i * 2], r.xs[i * 2 + 1]]);
    expect(xs[1][1] - xs[1][0]).toBe(0);
    expect(xs[2][0]).toBe(xs[0][1]);
    expect(xs[2][1]).toBeGreaterThan(xs[2][0]);
  });

  it("draws the band the face names, and only that one", () => {
    // The three bands are set apart, and each face is asked which one it drew. A face
    // drawing all three, or drawing the wrong one, both fail here; a point count would only
    // catch the first.
    const raws = { "ifx:mbc:11": 45, "ifx:mbc:16": 30, "ifx:mbc:21": 39 };
    const floors = [1, 2, 3].map((sel) => {
      const ctx = mbc(sel);
      const r = recorder();
      INSFX_DYN.drawCurve!(r.ctx, INSFX_DYN.plotGeo!(W, H, ctx), vals(raws), TOK, ctx);
      return { ys: r.ys, floor: r.ys[0] };
    });
    const geo = INSFX_DYN.plotGeo!(W, H, mbc(1));
    // Each band's make-up lifts its own floor: raw 45 / 30 / 39 are +8 / -7 / +2 dB.
    expect(floors[0].floor).toBeCloseTo(geo.py(-60 + 8), 6);
    expect(floors[1].floor).toBeCloseTo(geo.py(-60 - 7), 6);
    expect(floors[2].floor).toBeCloseTo(geo.py(-60 + 2), 6);
    // …and one curve, not three: a second band would put another 121 points on the canvas.
    expect(floors[0].ys.length).toBeLessThan(2 * 121);
  });

  it("takes a band with no make-up left off the frame rather than along its floor", () => {
    // Gain raw 0 is -∞ on the unit, which is a band putting out nothing — and a line lying
    // on the plot's bottom edge is where a very quiet band would be drawn too.
    const ctx = mbc(LOW);
    const geo = INSFX_DYN.plotGeo!(W, H, ctx);
    const r = recorder();
    INSFX_DYN.drawCurve!(r.ctx, geo, vals({ "ifx:mbc:11": 0 }), TOK, ctx);
    expect(r.ys[0]).toBeGreaterThan(geo.py(-60));
    // The positive control: with make-up the same face draws inside the frame.
    const ok = recorder();
    INSFX_DYN.drawCurve!(ok.ctx, geo, vals({ "ifx:mbc:9": 107, "ifx:mbc:10": 2, "ifx:mbc:11": 39 }), TOK, ctx);
    expect(ok.ys[0]).toBeLessThanOrEqual(geo.py(-60));
  });
});
