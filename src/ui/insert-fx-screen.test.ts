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
import type { DynCtx } from "./dyn-screen";
import { INSFX_CAB_DYN, INSFX_DYN, insertFxScreenFamily } from "./insert-fx-screen";
import { planToCommands } from "../core/control/translate";
import { PITCH_KEY_SLOT, PITCH_SCALE_MAJOR, insertFxParamKey, insertFxParams } from "../core/control/insert-fx-effect";
import { INSERT_FX_NONE, INSERT_FX_OPTIONS, OUTPUT_INSERT_FX_OPTIONS } from "../core/control/params";
import { t } from "../i18n";

let h: DynHost;

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

  it("refuses the family it would show only in part", () => {
    // The multi-band compressor's bands and globals are a structured layout, and the flat
    // catalogue carries none of it. Opening on it would be an editor with nothing in it.
    expect(INSFX_DYN.bind(holding("bus.mix1", "M.Band Comp"))).toBeNull();
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
    expect(lanes[2].gr).toEqual([132, 1]);
    expect(lanes[2].sameSlot).toBe(true);
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

  it("gives every family the same three lanes, addressed the same way", () => {
    // The rack keeps one shape across the families, so moving between them does not move
    // the readouts. A guitar amp subscribes to the input-insert reduction exactly as a
    // compander does — what it reads there is the unit's business, not the descriptor's.
    const amp = INSFX_DYN.bind(holding("ch1", "Crunch"))!.lanes;
    const comp = INSFX_DYN.bind(holding("ch1", "Compander-H"))!.lanes;
    expect(amp.map((l) => l.key)).toEqual(comp.map((l) => l.key));
    expect(amp[2].kind).toBe("gr");
    expect(amp[2].gr).toEqual(comp[2].gr);
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

  it("reads a value the plan does not carry as the catalogue's own default", () => {
    const ctx = holding("ch1", "Compander-S");
    // ratio, slot 7, factory 350 = 3.5:1.
    expect(INSFX_DYN.read(ctx)["ifx:compander:7"]).toBe(350);
  });

  it("keeps one family's stored values out of another's", () => {
    const ctx = holding("ch1", "Compander-H");
    h.plan.nodeParams.ch1!.insertFxParams = { [insertFxParamKey("guitar-clean", 7)]: 99 };
    // Slot 7 is the compander's Ratio and the guitar amp's Volume. Reading the guitar's
    // value here would show 99 as a ratio and write it back as one.
    expect(INSFX_DYN.read(ctx)["ifx:compander:7"]).toBe(350);
  });
});

describe("the rendered screen", () => {
  const rowLabels = (): string[] =>
    [...h.box.querySelectorAll<HTMLElement>(".prefs-row .lbl")].map((e) => e.textContent ?? "");

  it("shows the compander's rows grouped by what shapes the response", () => {
    holding("ch1", "Compander-H");
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "ch1");
    const m = t().inspector.insertFxEffect.params;
    const order: string[] = [m.threshold, m.ratio, m.width, m.outGain, m.attack, m.release];
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

  it("puts the cabinet's four rows on their own face, in the order the signal meets them", () => {
    const ctx = holding("ch1", "Clean");
    const m = t().inspector.insertFxEffect.params;
    // Gate is a toggle and SP Type / Mic Position are selects, so the sliders alone are
    // Gate Level; the rest of the face is asserted through the rendered screen below.
    expect(labelsOn(INSFX_CAB_DYN, ctx)).toEqual([m.gateLevel]);
    // …and none of them is left on the amp face.
    for (const cab of [m.gate, m.gateLevel, m.spType, m.micPosition]) {
      expect(labelsOn(INSFX_DYN, ctx)).not.toContain(cab);
    }
  });

  it("leads the amp face with the values that make one amp a different amp", () => {
    const m = t().inspector.insertFxEffect.params;
    expect(labelsOn(INSFX_DYN, holding("ch1", "Clean"))).toEqual([
      m.blend,
      m.distortion,
      m.volume,
      m.bass,
      m.middle,
      m.treble,
      m.presence,
      m.modSpeed,
      m.modDepth,
      m.output,
    ]);
    expect(labelsOn(INSFX_DYN, holding("ch1", "Drive"))).toEqual([
      m.master,
      m.gain,
      m.bass,
      m.middle,
      m.treble,
      m.presence,
      m.output,
    ]);
  });

  it("offers the face bar only where there is a second face", () => {
    expect(INSFX_DYN.bar!(holding("ch1", "Crunch"))).toBeTruthy();
    expect(INSFX_DYN.bar!(holding("ch1", "Compander-H"))).toBeUndefined();
    // …and the second face cannot be reached on a family that has none.
    expect(INSFX_CAB_DYN.bind(holding("ch1", "Compander-H"))).toBeNull();
  });

  it("reverses the columns for an amp and leaves them for a compander", () => {
    expect(INSFX_DYN.bind(holding("ch1", "Lead"))!.paramsFirst).toBe(true);
    expect(INSFX_DYN.bind(holding("ch1", "Compander-S"))!.paramsFirst).toBeUndefined();
  });

  it("locks Speed and Depth in place while the modulation is not vibrato", () => {
    const ctx = holding("ch1", "Clean");
    // Cho/Off/Vib is slot 19, its factory value Off.
    const off = INSFX_DYN.rowStates!(ctx, INSFX_DYN.read(ctx))!;
    expect(off.get("ifx:guitar-clean:20")?.locked).toBe(true);
    expect(off.get("ifx:guitar-clean:21")?.tag).toBe(t().dynTuning.insfx.vibOnly);
    h.plan.nodeParams.ch1!.insertFxParams = { "19": 2 };
    expect(INSFX_DYN.rowStates!(ctx, INSFX_DYN.read(ctx))).toBeNull();
  });
});

describe("moving between the faces", () => {
  const face = (id: string): HTMLElement => h.box.querySelector<HTMLElement>(`#${id}`)!;

  it("swaps the face without closing, and the columns follow the family", () => {
    holding("ch1", "Clean");
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "ch1");
    const grid = (): HTMLElement => h.box.querySelector<HTMLElement>(".prefs-grid")!;
    expect(grid().classList.contains("gt-paramsleft")).toBe(true);
    const m = t().inspector.insertFxEffect.params;
    const labels = (): string[] =>
      [...h.box.querySelectorAll<HTMLElement>(".prefs-row .lbl")].map((e) => e.textContent ?? "");
    expect(labels()).toContain(m.blend);

    face("dyn-face-insfx-cab").click();
    expect(screen.isOpen()).toBe(true);
    expect(labels()).toContain(m.spType);
    expect(labels()).not.toContain(m.blend);
    screen.close();
  });

  it("goes back to the amp face when a follow replaces the effect", () => {
    holding("ch1", "Clean");
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "ch1");
    face("dyn-face-insfx-cab").click();
    expect(h.box.querySelector("#dyn-face-insfx-cab")!.getAttribute("aria-pressed")).toBe("true");

    // The device says the channel now holds a compander. The CAB face does not exist
    // there, and reading that as "the processor is gone" would close a screen that has
    // something to show.
    h.plan.nodeParams.ch1!.insertFx = valueOf("Compander-H");
    screen.refresh();
    expect(screen.isOpen()).toBe(true);
    const m = t().inspector.insertFxEffect.params;
    const labels = [...h.box.querySelectorAll<HTMLElement>(".prefs-row .lbl")].map((e) => e.textContent ?? "");
    expect(labels).toContain(m.width);
    // …and the reversed columns went back with it.
    expect(h.box.querySelector<HTMLElement>(".prefs-grid")!.classList.contains("gt-paramsleft")).toBe(false);
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

  it("says nothing while the effect is engaged, and keeps the line's space", () => {
    holding("ch1", "Compander-H");
    h.plan.nodeParams.ch1!.insertFxOn = true;
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "ch1");
    expect(note()).toBe("");
    expect(h.box.querySelector(".gt-note")).not.toBeNull();
    screen.close();
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
});

describe("a plan value the device path will not act on", () => {
  it("refuses the screen for a bus holding a CHANNEL effect, at a rate that runs it", () => {
    // 48 kHz, so nothing here is about the ceiling. The bus's own control does not carry a
    // guitar amp or Pitch Fix, and translate.ts coerces such a value to No Effect and emits
    // no engine parameter at all — measured before the fix: bind answered 4 editable fields
    // while planToCommands emitted 0 INSERT_FX_EFFECT commands for the node.
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
    // Measured before the fix: the plan read Key = 7 and the mask written was C major.
    holding("ch1", "Pitch Fix");
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_CAB_DYN, "ch1");
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
    screen.open(INSFX_CAB_DYN, "ch1");
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

  it("returns to the first face when the type moves within the family", () => {
    holding("ch1", "Clean");
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "ch1");
    h.box.querySelector<HTMLElement>("#dyn-face-insfx-cab")!.click();
    expect(h.box.querySelector("#dyn-face-insfx-cab")!.getAttribute("aria-pressed")).toBe("true");
    h.plan.nodeParams.ch1!.insertFx = valueOf("Drive");
    screen.refresh();
    expect(screen.isOpen()).toBe(true);
    expect(h.box.querySelector("#dyn-face-insfx-amp")!.getAttribute("aria-pressed")).toBe("true");
    screen.close();
  });
});
