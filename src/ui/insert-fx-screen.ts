// The INS FX tuning screen: the selected insert effect's own parameters beside the level
// taps either side of it.
//
// One descriptor for every effect family, not one per family. What a node holds is a
// SELECTOR value that the operator changes elsewhere and that a device follow can change
// underneath an open screen, so the family is resolved from the plan on every call rather
// than baked into the registry — which is what lets a follow re-bind the same modal
// instead of closing one screen and opening another.
//
// The screen deliberately does NOT carry an Effect Type selector. A selector write is not
// reversible — the device refills the bound engine array with that type's defaults
// (insert-fx-effect.ts is canonical on this) — so it stays on the surfaces that already
// treat it as a selection: the Inspector's Insert FX row.
//
// Values are RAW broker integers keyed by engine SLOT, so a field names its slot rather
// than a parameter (`ifx6`), and the catalogue's own formatter prints it. The catalogue is
// the single value definition: nothing here restates a range, a default or an enum.

import {
  insertFxFamilyOf,
  insertFxParams,
  PITCH_KEY_SLOT,
  PITCH_MIDI_ENABLE_SLOT,
  PITCH_MIDI_REALTIME_SLOT,
  PITCH_NOTE_SLOTS,
  PITCH_SCALE_CHROMATIC,
  PITCH_SCALE_CUSTOM,
  PITCH_SCALE_HARMONIC_MINOR,
  PITCH_SCALE_MAJOR,
  PITCH_SCALE_MELODIC_MINOR,
  PITCH_SCALE_NATURAL_MINOR,
  PITCH_SCALE_PENTATONIC,
  PITCH_SCALE_SINGLE,
  PITCH_SCALE_SLOT,
  SEMITONE_NAMES,
} from "../core/control/insert-fx-effect";
import type { InsertFxFamily, InsertFxParamDesc } from "../core/control/insert-fx-effect";
import { formatRate, insertFxMenu, insertFxSelectedEntry } from "../core/constraints";
import { insertFxSelected } from "../core/control/params";
import { insertFxControl } from "../core/control/translate";
import type { DynField, InsertFxFieldKey } from "../core/control/translate";
import { grAddr, insertFxOutGrAddr, tapFor } from "../core/meters";
import type { NodeParams, Plan } from "../core/plan";
import { el, onOff, settingsRow } from "./dom";
import type { SettingsRowOptions } from "./dom";
import { enumRow } from "./dyn-chan";
import type { DynBinding, DynCtx, DynLane, DynProcessor, DynRowCtx } from "./dyn-screen";
import { insertFxVal, pitchKeyPatch, pitchMidiMode, pitchScalePatch, reKeyInsertFxParams } from "./insert-fx-model";
import type { Messages } from "../i18n/en";

/** Lane ruler floor. The taps either side of an insert effect are ordinary channel
 *  meters, so this is a reading range and not a parameter domain — no value on this
 *  screen rides the ruler, and nothing here carries a fader cap. */
const LO_DB = -48;
const TICK_STEP = 6;

/** A field's key is its family and its engine slot. Both halves are needed: an insert-FX
 *  value has no plan sub-object to borrow a name from, and a row can outlive the family it
 *  was built for (translate.ts's `InsertFxFieldKey` carries how). */
const slotKey = (fam: InsertFxFamily, slot: number): InsertFxFieldKey => `ifx:${fam}:${slot}`;
const keyParts = (key: string): { fam: InsertFxFamily; slot: number } | null => {
  const m = /^ifx:([\w-]+):(\d+)$/.exec(key);
  return m ? { fam: m[1] as InsertFxFamily, slot: Number(m[2]) } : null;
};

/**
 * The order a family's rows are shown in, where it is not the catalogue's own.
 *
 * The catalogue lists the device's read order, which is what the emit path and the
 * Inspector want. The compander is grouped by what the transfer response shows instead —
 * the three values that shape the curve, then the makeup, then the two that decide how
 * fast the signal reaches it.
 */
const ROW_ORDER: Partial<Record<InsertFxFamily, readonly string[]>> = {
  compander: ["threshold", "ratio", "width", "outGain", "attack", "release"],
};

/** Which face a row belongs to. A guitar amp is split into the amp and its cabinet, and
 *  Pitch Fix into what the correction does to a note and what decides which notes exist. */
export type InsFxFace = "amp" | "cab";

/** The cabinet's four rows, in the order the signal meets them. */
const CAB_ORDER: readonly string[] = ["gate", "gateLevel", "spType", "micPosition"];

/** Pitch Fix's second face: what the correction is aimed at, rather than what it does. */
const PITCH_SCALE_ORDER: readonly string[] = ["key", "speed", "tolerance", "noteLow", "noteHigh"];

/**
 * The amp's own rows: this type's own values first, then the tone stack, then the
 * modulation group, then the output.
 *
 * The type-specific values lead because they are what makes one amp a different amp, and
 * the modulation group is placed by name rather than with them because it is a stage of
 * its own — Clean's Cho/Off/Vib and its Speed and Depth are type-specific too, and putting
 * them at the head would separate Speed and Depth from the switch that drives them AND
 * from the output they sit before.
 *
 * Every guitar row is named here. A row the catalogue gains and this list does not name
 * still appears, after the ones it does, rather than disappearing from a face silently.
 */
const AMP_ORDER: readonly string[] = [
  // Pitch Fix's first face, in the unit's own read order.
  "coarse",
  "fine",
  "formant",
  "correction",
  "mix",
  // The guitar amps.
  "blend",
  "distortion",
  "character",
  "ampType",
  "master",
  "volume",
  "gain",
  "bass",
  "middle",
  "treble",
  "presence",
  "mod",
  "modSpeed",
  "modDepth",
  "output",
];

/**
 * The height each bank reserves for its faces, where the stylesheet's shared 520px is not
 * enough for the taller one. Without it the modal resizes on the segment that moves between
 * them, which is what the reserve exists to stop.
 *
 * Measured with the faces rendered, Chromium on macOS at 1280x900, in both languages:
 * the guitar amp's AMP face is 614px (EN) / 622px (JA) against its cabinet's 520, and the
 * Pitch Fix SCALE face is 522px (JA) against PITCH's 520. Each number carries the headroom
 * a wider font stack takes, on the same reasoning as the shipped bank's own.
 */
const FACE_RESERVE: Partial<Record<InsertFxFamily, number>> = {
  "guitar-clean": 650,
  "guitar-crunch": 650,
  "guitar-lead": 650,
  "guitar-drive": 650,
  pitch: 560,
};

/** Clean's Cho/Off/Vib selector (slot 19) and the value that puts it on vibrato. */
const MOD_SLOT = 19;
const MOD_VIB = 2;
const MOD_SPEED_SLOT = 20;
const MOD_DEPTH_SLOT = 21;

const isGuitar = (fam: InsertFxFamily): boolean => fam.startsWith("guitar-");
/** The families this screen shows as two faces. */
const isBanked = (fam: InsertFxFamily): boolean => isGuitar(fam) || fam === "pitch";
/** The second face's own rows, for a family that has one. */
const secondFaceOrder = (fam: InsertFxFamily): readonly string[] => (fam === "pitch" ? PITCH_SCALE_ORDER : CAB_ORDER);

/** The family a node holds, or null where it holds nothing (No Effect, or nothing at all). */
function familyOf(ctx: DynCtx): InsertFxFamily | null {
  const v = ctx.plan.nodeParams[ctx.nodeId]?.insertFx;
  return v === undefined ? null : insertFxFamilyOf(v);
}

/**
 * The family this screen shows for a node, or null. `bind` refuses on the same answer, so
 * the Inspector's choice between its own editor and the launcher cannot disagree with
 * whether the screen would open.
 *
 * One family answers null: the multi-band compressor's bands and globals are a structured
 * layout rather than a list, and the flat catalogue carries none of it.
 */
export function insertFxScreenFamily(plan: Plan, nodeId: string): InsertFxFamily | null {
  const v = plan.nodeParams[nodeId]?.insertFx;
  const fam = v === undefined ? null : insertFxFamilyOf(v);
  return fam && rowsOf(fam).length ? fam : null;
}

/**
 * The catalogue rows this screen shows, in display order.
 *
 * Empty for the multi-band compressor, whose bands and globals are a structured layout
 * rather than a list. An empty answer is what makes `bind` refuse, and refusing is what
 * keeps the Inspector's own editor in front of a family this screen does not show whole.
 */
function rowsOf(fam: InsertFxFamily, face: InsFxFace = "amp"): InsertFxParamDesc[] {
  const descs = insertFxParams(fam);
  const second = secondFaceOrder(fam);
  const order = isBanked(fam) ? (face === "cab" ? second : AMP_ORDER) : ROW_ORDER[fam];
  if (!order) return [...descs];
  if (isBanked(fam)) {
    // The second face names its own rows; the first takes everything else.
    const onFace = (d: InsertFxParamDesc): boolean =>
      face === "cab" ? second.includes(d.label) : !second.includes(d.label);
    return descs.filter(onFace).sort((a, b) => rankIn(order, descs, a) - rankIn(order, descs, b));
  }
  return [...descs].sort((a, b) => rankIn(order, descs, a) - rankIn(order, descs, b));
}

/** A label the order does not name keeps its catalogue position after the ones it does, so
 *  a parameter added to the catalogue appears rather than disappearing silently. */
function rankIn(order: readonly string[], descs: InsertFxParamDesc[], d: InsertFxParamDesc): number {
  const i = order.indexOf(d.label);
  return i < 0 ? order.length + descs.indexOf(d) : i;
}

/** The catalogue row one field key came from. Read from the KEY rather than from the plan:
 *  a row built for one family must go on printing that family's parameter even if the plan
 *  has since moved to another. Searched across the whole family rather than one face's
 *  rows — a slot is one parameter under a family whichever face shows it. */
function descOf(_ctx: DynCtx, key: string): InsertFxParamDesc | undefined {
  const parts = keyParts(key);
  return parts ? insertFxParams(parts.fam).find((d) => d.slot === parts.slot) : undefined;
}

const labelOf = (d: InsertFxParamDesc, m: Messages): string => {
  const t = m.inspector.insertFxEffect.params as Record<string, string | undefined>;
  return t[d.label] ?? d.label;
};

/** Read one catalogue row's current raw. */
const rawOf = (ctx: DynCtx, fam: InsertFxFamily, d: InsertFxParamDesc): number =>
  insertFxVal(ctx.plan, ctx.nodeId, fam, d.slot, d.def);

/**
 * The meter lanes either side of the effect.
 *
 * The two reduction meters are indexed differently, which is the whole reason this is not
 * one table: the input one is per MONO CH, and the output one is per BAND of the single
 * output effect the device runs at a time. `meters.ts` carries the measurements.
 */
function lanesOf(ctx: DynCtx, isOutput: boolean): DynLane[] {
  const g = ctx.m.dynTuning;
  const inTap = tapFor(ctx.nodeId, "preinsfx", ctx.model.id) ?? null;
  const outTap = tapFor(ctx.nodeId, isOutput ? "post" : "prefader", ctx.model.id) ?? null;
  return [
    { key: "in", label: g.insfx.tapIn, caption: g.laneIn, kind: "level", tap: inTap },
    {
      key: "out",
      label: isOutput ? g.insfx.tapOutBus : g.insfx.tapOut,
      caption: g.laneOut,
      kind: "level",
      tap: outTap,
    },
    {
      key: "gr",
      label: g.insfx.tapGr,
      kind: "gr",
      gr: isOutput ? insertFxOutGrAddr(0) : grAddr("insfx", ctx.nodeId, ctx.model.id),
      // Merged into the OUTPUT column, as every reduction on every screen is. No offset:
      // the rule is to subtract whatever gain the processor adds, and these effects add
      // none — the compander's makeup reaches 0 dB and only attenuates below it, so the
      // level bar and the reduction hanging off the top of the same ruler cannot meet.
      sameSlot: true,
    },
  ];
}

/**
 * One face of the screen. A guitar amp is two — the amp and its cabinet — and every other
 * family is one, so the CAB face refuses to bind anywhere else and the bar that reaches it
 * is only offered where there is something on the other side of it.
 */
function insFxFace(face: InsFxFace): DynProcessor {
  return {
    key: face === "amp" ? "insfx" : "insfxCab",
    loDb: LO_DB,
    tickStep: TICK_STEP,
    // One reserved height across every family, not only across the two guitar faces: a
    // device follow can replace the effect inside this modal, and a panel whose controls
    // start at a different height each time is the same resize under the pointer that the
    // reserve exists to stop.
    banked: true,
    // The effect's own name is in the title because the screen shows one effect and the
    // selector that picked it is on another surface: without it the heading names a slot
    // rather than what is in it.
    title: (m, ctx) => {
      const fam = familyOf(ctx);
      const value = ctx.plan.nodeParams[ctx.nodeId]?.insertFx;
      const name = insertFxControl(ctx.model, ctx.nodeId)?.options.find((o) => o.value === value)?.label;
      return fam && name ? `${m.dynTuning.insfx.title} — ${name}` : m.dynTuning.insfx.title;
    },
    // What this bank is a bank of. The faces belong to the effect the node HOLDS, so a
    // follow that replaces it takes the screen back to the amp face rather than leaving a
    // CAB segment selected on a compander that has no cabinet.
    bankIdentity: (ctx) => familyOf(ctx) ?? "",

    bind: (ctx): DynBinding | null => {
      const ifx = insertFxControl(ctx.model, ctx.nodeId);
      const fam = insertFxScreenFamily(ctx.plan, ctx.nodeId);
      if (!ifx || !fam) return null;
      // Only a banked family has a second face; nothing else may be reached on one.
      if (face === "cab" && !isBanked(fam)) return null;
      const fields: DynField[] = rowsOf(fam, face)
        .filter((d) => d.control === "slider")
        .map((d) => ({
          key: slotKey(fam, d.slot),
          min: d.rawMin ?? 0,
          max: d.rawMax ?? 0,
          step: d.rawStep ?? 1,
          def: d.def,
          // Raw broker integers throughout: the catalogue's formatter is what turns one
          // into the device's own reading, supplied through `fieldText`.
          unit: "raw",
        }));
      return {
        fields,
        lanes: lanesOf(ctx, ifx.isOutput),
        // A guitar amp's panel is a dozen controls and its display is a level rack with
        // nothing else in it, so the two columns swap. The companders keep the ordinary
        // order: their display is the point of the screen. The reserve rides with it: both
        // of the amp's faces answer the same number, which is what keeps the modal still
        // when the segment moves between them.
        ...(isGuitar(fam) ? { paramsFirst: true as const } : {}),
        ...(FACE_RESERVE[fam] === undefined ? {} : { faceReserve: FACE_RESERVE[fam] }),
      };
    },

    // Two segments over two faces, offered only where there are two. A family with one
    // face answers nothing and the host reserves the bar's space instead, so the controls
    // below start at the same height on every effect.
    bar: (ctx) => {
      const fam = familyOf(ctx);
      if (!fam || !isBanked(fam)) return undefined;
      const g = ctx.m.dynTuning.insfx;
      const [first, second] = fam === "pitch" ? [g.facePitch, g.faceScale] : [g.faceAmp, g.faceCab];
      return {
        label: g.faceBar,
        items: [
          { label: first, id: "dyn-face-insfx-amp", face: INSFX_DYN, sel: 0 },
          { label: second, id: "dyn-face-insfx-cab", face: INSFX_CAB_DYN, sel: 0 },
        ],
      };
    },

    read: (ctx) => {
      const fam = familyOf(ctx);
      if (!fam) return {};
      const out: Record<string, unknown> = {};
      // Every row of the family, not only this face's: `rowStates` reads the Cho/Off/Vib
      // selector, which is on the amp face, to lock two rows beside it.
      for (const d of insertFxParams(fam)) out[slotKey(fam, d.slot)] = rawOf(ctx, fam, d);
      return out;
    },

    // The family comes from the KEY, not from the plan. A device follow can replace the
    // effect while a slider is under the pointer, and the drag goes on firing at a row that
    // is already detached; resolving the family here would put that value under the
    // INCOMING family's slot of the same number, which is a different parameter on a
    // different scale (guitar and compander share 7, 9, 10 and 11). Keyed this way it lands
    // in the outgoing family's parked values, where a selector change would have parked it.
    patch: (ctx, patch): NodeParams => {
      let params = ctx.plan.nodeParams[ctx.nodeId]?.insertFxParams ?? {};
      const byFamily = new Map<InsertFxFamily, Record<number, number>>();
      for (const [key, v] of Object.entries(patch)) {
        const parts = keyParts(key);
        if (!parts) continue;
        const raw = typeof v === "boolean" ? (v ? 1 : 0) : v;
        const slots = byFamily.get(parts.fam) ?? {};
        slots[parts.slot] = raw;
        // Three Pitch Fix values are stored twice; the catalogue names the second slot and
        // the device reads both, so an edit that wrote one of them would be half applied.
        const mirror = insertFxParams(parts.fam).find((d) => d.slot === parts.slot)?.mirror;
        if (mirror !== undefined) slots[mirror] = raw;
        byFamily.set(parts.fam, slots);
      }
      for (const [fam, slots] of byFamily) params = reKeyInsertFxParams(params, fam, slots);
      return { insertFxParams: params };
    },

    // A field carries a slot, and a slot means a different parameter under every family, so
    // both of these need the ctx to know which catalogue row they are printing.
    fieldLabel: (f, m, ctx) => {
      const d = descOf(ctx, f.key);
      return d && labelOf(d, m);
    },
    fieldText: (f, v, ctx) => descOf(ctx, f.key)?.format?.(v),

    // The one line under the display. A bypassed effect is still editable — the plan holds
    // the values and the unit stores them — but nothing it is set to reaches the signal,
    // and the two level lanes beside the note read the same thing while it is off. Null
    // where there is nothing to say, which keeps the line's space either way.
    hint: (ctx) => {
      const np = ctx.plan.nodeParams[ctx.nodeId];
      if (!insertFxSelected(np)) return null;
      // The rate first: above the held effect's own ceiling the unit is running no DSP at
      // all, which the Inspector and the CONSOLE chip already say. Saying it in different
      // words on the third surface — or not at all — is how one panel tells the operator
      // the effect is off while another hands them a live editor for it.
      const entry = insertFxSelectedEntry(insertFxMenu(ctx.model, ctx.plan, ctx.nodeId), np?.insertFx);
      if (entry?.lock === "rate") {
        return entry.option.maxRate === undefined
          ? ctx.m.inspector.insFxRateLocked
          : ctx.m.inspector.insFxRateLockedAt(entry.option.label, formatRate(entry.option.maxRate));
      }
      return np?.insertFxOn === false ? ctx.m.dynTuning.insfx.bypassed : null;
    },

    // Speed and Depth drive a vibrato the selector beside them can switch off. The rows
    // stay where they are, dimmed and tagged, rather than being dropped: a panel that
    // loses two rows moves everything under them out from under the pointer.
    rowStates: (ctx, vals) => {
      const fam = familyOf(ctx);
      if (!fam || !isGuitar(fam)) return null;
      const mod = vals[slotKey(fam, MOD_SLOT)];
      if (mod === undefined || mod === MOD_VIB) return null;
      const out = new Map<string, SettingsRowOptions>();
      for (const slot of [MOD_SPEED_SLOT, MOD_DEPTH_SLOT]) {
        out.set(slotKey(fam, slot), { tag: ctx.m.dynTuning.insfx.vibOnly, locked: true });
      }
      return out;
    },

    // Everything that is not a slider — the guitar amp's cabinet selectors and its gate
    // switch. Placed in front of the slider that follows them in display order, so the
    // panel reads in one order rather than sliders-then-the-rest.
    rows: (ctx) => {
      const fam = familyOf(ctx);
      if (!fam) return {};
      const descs = rowsOf(fam, face);
      const before: Record<string, HTMLElement[]> = {};
      const tail: HTMLElement[] = [];
      let pending: HTMLElement[] = [];
      for (const d of descs) {
        if (d.control === "slider") {
          if (pending.length) {
            before[slotKey(fam, d.slot)] = pending;
            pending = [];
          }
          continue;
        }
        const key = slotKey(fam, d.slot);
        const cur = rawOf(ctx, fam, d);
        const label = labelOf(d, ctx.m);
        // The Key is a plain enum in the catalogue, but writing it alone would leave the
        // mask spelling the old root: the unit re-derives on a Key write and an offline
        // plan has to agree with what it would have derived.
        pending.push(
          fam === "pitch" && d.label === "key"
            ? enumRow(label, d.options ?? [], cur, (v) => ctx.set(slotPatch(pitchKeyPatch(scaleOf(ctx), v))))
            : d.control === "toggle"
              ? ctx.midi(
                  settingsRow(
                    label,
                    onOff(cur !== 0, (on) => ctx.set({ [key]: on ? 1 : 0 })),
                  ),
                  key,
                )
              : enumRow(label, d.options ?? [], cur, (v) => ctx.set({ [key]: v })),
        );
        // The Scale and the twelve notes are not in the flat catalogue at all; they belong
        // beside the Key, which is the value they are rooted at.
        if (fam === "pitch" && d.label === "key") pending.push(...pitchScaleRows(ctx));
      }
      tail.push(...pending);
      if (fam === "pitch" && face === "cab") tail.push(pitchMidiRow(ctx));
      return { before, tail };
    },

    // Lanes only. Nothing here draws a response: the level meters and the reduction are
    // measured, and a guitar amp's EQ curve or a pitch tracker would be an invention. The
    // families whose response IS defined by their parameters (the companders, the
    // multi-band compressor) get a plot with their own faces.
    display: (parts) => parts.lanes(),
  };
}

/** A slot→raw patch, as the field keys `patch` speaks. */
const slotPatch = (patch: Record<number, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(patch).map(([slot, raw]) => [slotKey("pitch", Number(slot)), raw]));

const scaleOf = (ctx: DynCtx): number =>
  insertFxVal(ctx.plan, ctx.nodeId, "pitch", PITCH_SCALE_SLOT, PITCH_SCALE_CHROMATIC);

/**
 * The Scale selector and the twelve notes it turns on.
 *
 * Every preset is selectable: the unit derives the mask from the Scale and the Key for all
 * eight, measured at two keys, and the app authors the same offsets. The twelve slots are
 * ABSOLUTE semitones — slot 22 is C whatever the Key is — so the buttons are named from C
 * and are not laid out as a keyboard, which would imply a root that is not there.
 *
 * Editing a note takes the Scale to Custom. The unit does that itself; the app writes it
 * too, because the plan is what the next flush emits and a plan still spelling a preset
 * would re-derive the mask over the edit.
 */
function pitchScaleRows(ctx: DynRowCtx): HTMLElement[] {
  const t = ctx.m.inspector.insertFxEffect;
  const scale = scaleOf(ctx);
  const key = insertFxVal(ctx.plan, ctx.nodeId, "pitch", PITCH_KEY_SLOT, 0);
  const scales = [
    { value: PITCH_SCALE_CHROMATIC, label: t.scaleChromatic },
    { value: PITCH_SCALE_MAJOR, label: t.scaleMajor },
    { value: PITCH_SCALE_CUSTOM, label: t.scaleCustom },
    { value: PITCH_SCALE_SINGLE, label: t.scaleSingle },
    { value: PITCH_SCALE_NATURAL_MINOR, label: t.scaleNaturalMinor },
    { value: PITCH_SCALE_HARMONIC_MINOR, label: t.scaleHarmonicMinor },
    { value: PITCH_SCALE_MELODIC_MINOR, label: t.scaleMelodicMinor },
    { value: PITCH_SCALE_PENTATONIC, label: t.scalePentatonic },
  ];
  const notes = el("span", "ctl gt-notes");
  PITCH_NOTE_SLOTS.forEach((slot, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = SEMITONE_NAMES[i];
    const on = insertFxVal(ctx.plan, ctx.nodeId, "pitch", slot, 1) !== 0;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
    b.addEventListener("click", () =>
      ctx.set({ [slotKey("pitch", slot)]: on ? 0 : 1, [slotKey("pitch", PITCH_SCALE_SLOT)]: PITCH_SCALE_CUSTOM }),
    );
    notes.append(b);
  });
  return [
    enumRow(t.scale, scales, scales.some((o) => o.value === scale) ? scale : PITCH_SCALE_CUSTOM, (v) =>
      ctx.set(slotPatch(pitchScalePatch(v, key))),
    ),
    settingsRow(t.scaleNotes, notes),
  ];
}

/** MIDI Control, shown and never written. The unit takes those notes on a USB-MIDI port of
 *  its own — not the port this app reads external control from — and switching it on erases
 *  a twelve-note mask that is FULL, taking the Scale enum to Custom with it. */
function pitchMidiRow(ctx: DynRowCtx): HTMLElement {
  const t = ctx.m.inspector.insertFxEffect;
  const mode = pitchMidiMode(
    insertFxVal(ctx.plan, ctx.nodeId, "pitch", PITCH_MIDI_ENABLE_SLOT, 0),
    insertFxVal(ctx.plan, ctx.nodeId, "pitch", PITCH_MIDI_REALTIME_SLOT, 0),
  );
  // A select, like the Key and the Scale above it: three buttons do not fit the row, and
  // "Real Time" wrapped onto a second line, which moved everything below it.
  const row = enumRow(
    t.params.midiControl,
    [
      { value: 0, label: "Off" },
      { value: 1, label: "Setting" },
      { value: 2, label: "Real Time" },
    ],
    mode,
    () => {},
    { locked: true, tag: t.midiControlTag },
  );
  row.title = t.midiControlDeviceOnly;
  return row;
}

/** The face a launcher opens on, and the one the bar reaches from it. */
export const INSFX_DYN = insFxFace("amp");
export const INSFX_CAB_DYN = insFxFace("cab");
