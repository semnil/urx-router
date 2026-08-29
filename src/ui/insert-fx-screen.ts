// The INS FX tuning screen: the selected insert effect's own parameters beside the level
// taps either side of it.
//
// One descriptor for every effect family, not one per family. What a node holds is a
// SELECTOR value that the operator changes elsewhere and that a device follow can change
// underneath an open screen, so the family is resolved from the plan on every call rather
// than baked into the registry — which is what lets a follow re-bind the same modal
// instead of closing one screen and opening another.
//
// The screen deliberately does NOT carry an EFFECT TYPE selector. A selector write is not
// reversible — the device refills the bound engine array with that type's defaults
// (insert-fx-effect.ts is canonical on this) — so it stays on the surfaces that already
// treat it as a selection: the Inspector's Insert FX row.
//
// Values are RAW broker integers keyed by engine SLOT, so a field names a family and a
// slot rather than a parameter (`ifx:compander:6`), and the catalogue's own formatter
// prints it. The catalogue is the single value definition: nothing here restates a range,
// a default or an enum.

import {
  insertFxDeviceDriven,
  insertFxInactiveSlots,
  insertFxLockedSlots,
  insertFxFamilyOf,
  insertFxParamKey,
  insertFxParams,
  MBC_BANDS,
  MBC_ONE_KNOB,
  mbcBandCurve,
  mbcXoverHz,
  pitchDeviceDriven,
  mbcXoverLabel,
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
import { formatRate, insertFxCensus, insertFxMenu, insertFxRateLock } from "../core/constraints";
import { insertFxSelected } from "../core/control/params";
import { controlId, INSFX_SCOPE } from "../core/midi/controls";
import { effectiveInsertFx, insertFxControl } from "../core/control/translate";
import type { DynField, InsertFxFieldKey } from "../core/control/translate";
import { insertFxInGrAddr, insertFxOutGrAddr, tapFor } from "../core/meters";
import type { NodeParams, Plan } from "../core/plan";
import type { DeviceModel } from "../models/types";
import { el, onOff, onOffButton, settingsRow, settingsSection, sliderRow } from "./dom";
import type { SettingsRowOptions } from "./dom";
import { enumRow } from "./dyn-chan";
import { curveMarks, drawTransferCurve, transferPlot } from "./dyn-plot";
import { splitDisplay } from "./dyn-screen";
import type { DynPlotGeo } from "./dyn-screen";
import { GAIN_TICKS, drawFreqAxes, freqGeo } from "./dyn-freq-plot";
import { EQ_FREQ_MAX_HZ, EQ_FREQ_MIN_HZ } from "../core/control/vd";
import type { DynBinding, DynCtx, DynLane, DynProcessor, DynRowCtx, DynValues } from "./dyn-screen";
import {
  insertFxVal,
  pitchKeyPatch,
  pitchMidiMode,
  pitchMidiPatch,
  pitchScalePatch,
  reKeyInsertFxParams,
} from "./insert-fx-model";
import type { Messages } from "../i18n/en";

/** Lane ruler floor. The taps either side of an insert effect are ordinary channel
 *  meters, so this is a reading range and not a parameter domain — no value on this
 *  screen rides the ruler, and nothing here carries a fader cap. It reaches the lowest
 *  threshold the compander takes, so a level under the window is still on the ruler. */
const LO_DB = -54;
const TICK_STEP = 6;

/** The transfer plot's own axes, which are not the lane ruler's: this one is a threshold
 *  domain, and it runs BELOW the compander's lowest threshold (-54 dB) so that the window
 *  edge and the expander slope under it are inside the frame rather than on its floor.
 *  Output shares the range because Out Gain only attenuates — nothing this block does puts
 *  a level above its input. */
const CURVE_LO_DB = -60;
const CURVE_OUT_TICKS = [0, -12, -24, -36, -48];

/** A field's key is its family and its engine slot. Both halves are needed: an insert-FX
 *  value has no plan sub-object to borrow a name from, and a row can outlive the family it
 *  was built for (translate.ts's `InsertFxFieldKey` carries how). */
const slotKey = (fam: InsertFxFamily, slot: number): InsertFxFieldKey => `ifx:${fam}:${slot}`;
const keyParts = (key: string): { fam: InsertFxFamily; slot: number } | null => {
  const m = /^ifx:([\w-]+):(\d+)$/.exec(key);
  return m ? { fam: m[1] as InsertFxFamily, slot: Number(m[2]) } : null;
};

/**
 * A guitar amp on ONE face, in TWO groups with a row break between them.
 *
 * Above the break is the amp, in the order the unit's own screen lists it: what makes it
 * this type, the level it is driven at, the master and Output, then the tone stack. Below
 * it is everything the signal meets after the amp — the modulation group and the CABINET.
 *
 * Output is in the first group because it is a level of the amp rather than something the
 * cabinet does, and the tone stack goes last within that group so the four controls that
 * belong to one stack read as one run instead of splitting whatever falls between them.
 *
 * Every guitar row is named here. A row the catalogue gains and this list does not name
 * still appears, after the ones it does, rather than disappearing from the face silently.
 */
const GUITAR_ORDER: readonly string[] = [
  // The type switch, which Clean does not have — its face opens on Volume instead.
  "type",
  "ampType",
  // Slot 7 under whichever of its two names this type prints.
  "volume",
  "gain",
  // What the type brings of its own.
  "distortion",
  "blend",
  "master",
  "output",
  // The tone stack, high to low and then Presence, which is how the effect guide's own
  // common table lists it.
  "treble",
  "middle",
  "bass",
  "presence",
  // ── the break ──
  "mod",
  "modSpeed",
  "modDepth",
  // The cabinet.
  "gate",
  "gateLevel",
  "spType",
  "micPosition",
];

/** The rows below the break, derived from the order above rather than listed again: the
 *  split is a position in that list, so moving a row across it is one edit and not two.
 *
 *  Only the Clean amp carries Modulation at all, so on the other three the first row here
 *  is the cabinet's own switch. The break goes in front of whichever of these the type
 *  actually has, which keeps the same two groups on all four faces. */
const GUITAR_AFTER_BREAK: ReadonlySet<string> = new Set(GUITAR_ORDER.slice(GUITAR_ORDER.indexOf("mod")));

/**
 * Pitch Fix on ONE face, Correction first.
 *
 * Correction leads because it is the switch the whole effect hangs off — everything below
 * it describes a correction that is not happening while it is off — so it holds the first
 * card, which is the first thing read and the first thing reachable. That is a departure
 * from the unit's own read order, which puts it fourth, and it is the only row here that
 * departs from it.
 *
 * Then what the correction DOES to a note, then what it is aimed at. MIDI Control, the
 * Scale and the twelve notes are not in the flat catalogue at all and are built beside the
 * Key: the mode decides where the notes come from, and the Scale is rooted at the Key.
 */
const PITCH_ORDER: readonly string[] = [
  "correction",
  "coarse",
  "fine",
  "formant",
  "key",
  "mix",
  "limitLow",
  "limitHigh",
  "speed",
  "tolerance",
];

/**
 * The multi-band compressor's panel: one band per row of four, then the four values that
 * belong to the effect rather than to a band.
 *
 * Two orders, because the rows repeat. WITHIN a band it is the band's own Bypass — which
 * decides whether anything below it reaches the signal — then what the compressor does in
 * the order it does it: where it starts working, how hard, how fast it gets there, and what
 * it puts back, which is the band's own make-up. ACROSS the panel it is the three make-up
 * levels in the order the crossovers split the bands, then Out Gain, then the crossovers
 * themselves.
 *
 * A band's make-up is on BOTH its own face and MAIN: it is one value, and the two faces
 * ask different questions of it — how the band comes back against the other two, and how
 * it comes back against the compression this face sets.
 *
 * A label the first list does not name keeps its catalogue position after the ones it
 * does, the way `rankIn` treats every other family.
 */
const MBC_BAND_ORDER: readonly string[] = ["bypass", "threshold", "ratio", "attack", "release", "gain"];
const MBC_MAIN_ORDER: readonly string[] = ["gain", "outGain", "xoverLowMid", "xoverMidHigh"];
/** The four faces, in the order the bar offers them: what the three bands SHARE, then each
 *  of them. `sel` is the index, so the band a face is about is `MBC_FACES[sel - 1]`. */
const MBC_FACES = ["low", "mid", "high"] as const;
const MBC_BAND_RANK: Record<string, number> = { low: 0, mid: 1, high: 2 };

/** The unit's own word for a band, which is what a qualified label is qualified by. */
const bandName = (band: "low" | "mid" | "high", m: Messages): string => {
  const t = m.inspector.insertFxEffect;
  return band === "low" ? t.bandLow : band === "mid" ? t.bandMid : t.bandHigh;
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
  compander: ["threshold", "ratio", "width", "gain", "attack", "release"],
  pitch: PITCH_ORDER,
  "guitar-clean": GUITAR_ORDER,
  "guitar-crunch": GUITAR_ORDER,
  "guitar-lead": GUITAR_ORDER,
  "guitar-drive": GUITAR_ORDER,
};

/** The unit's three MIDI Control modes, in its own order and its own words (the effect
 *  guide prints "Off, Setting, Real Time"). ONE list: the SCALE face's summary and the
 *  read-only row under it both print it, and two copies would drift. */
const PITCH_MIDI_MODES = ["Off", "Setting", "Real Time"] as const;

/** Clean's modulation selector (slot 19) and the value that puts it on vibrato. The unit
 *  prints no name beside it, which is why the app supplies one. */

const isGuitar = (fam: InsertFxFamily): boolean => fam.startsWith("guitar-");
/** The families whose continuous values are laid out as knob cards. */
const isKnobGrid = (fam: InsertFxFamily): boolean => isGuitar(fam) || fam === "pitch" || fam === "mbc";
/** …and the ones whose PANEL takes the flexible column, because their display has no
 *  reading of its own but the level taps. The multi-band compressor is not one: its
 *  display is a plot and a rack, which is the compander's arrangement. */
const isPanelFirst = (fam: InsertFxFamily): boolean => isGuitar(fam) || fam === "pitch";
/** The families this screen shows as more than one face. The multi-band compressor alone:
 *  it is three compressors and the two frequencies that decide what each of them hears, and
 *  a panel carrying all of that at once says nothing about which values belong together.
 *  Every other family is one processor, and one processor is one face. */
const isBanked = (fam: InsertFxFamily): boolean => fam === "mbc";

/** The two companders differ in ONE number that the family does not carry: the slope
 *  below the window. `compander` is both of them, so the expander ratio is read off the
 *  selector value the node holds rather than off the family. */
const COMPANDER_H = 1793;
/** Expander slopes, from the same block in the AG08 controller guide these effects share:
 *  H drops 5 dB for every dB under the window, S drops 1.5. */
const EXPANDER_RATIO = { h: 5, s: 1.5 } as const;

/** Which engine slot a value lives in, asked of the catalogue by NAME. The numbers are the
 *  device's and belong in one place; written here as literals they would be a second copy
 *  that drifts silently — a slot number is valid-looking whatever it points at, so a curve
 *  would simply be drawn from the wrong parameter. Throws rather than falling back: a
 *  missing row is a catalogue change, not a runtime condition. Only for the rows that
 *  occur ONCE: a name the multi-band compressor repeats per band would answer with
 *  whichever band the catalogue lists first. */
function slotOf(fam: InsertFxFamily, label: string): number {
  const row = insertFxParams(fam).find((p) => p.label === label && p.band === undefined);
  if (!row) throw new Error(`${fam} catalogue has no "${label}" row`);
  return row.slot;
}
const companderSlot = (label: string): number => slotOf("compander", label);

/**
 * Why nothing this screen sets reaches the signal, or null when something does.
 *
 * A bypassed effect is still editable — the plan holds the values and the unit stores
 * them — and the two level lanes beside the note read the same thing while it is off.
 *
 * The rate comes first: above the held effect's own ceiling the unit is running no DSP at
 * all, which the Inspector and the CONSOLE chip already say. Saying it in different words
 * on the third surface — or not at all — is how one panel tells the operator the effect is
 * off while another hands them a live editor for it.
 */
function offNote(ctx: DynCtx): string | null {
  const np = ctx.plan.nodeParams[ctx.nodeId];
  if (!insertFxSelected(np)) return null;
  const { locked, entry } = insertFxRateLock(insertFxMenu(ctx.model, ctx.plan, ctx.nodeId), np?.insertFx);
  if (locked) {
    return entry?.option.maxRate === undefined
      ? ctx.m.inspector.insFxRateLocked
      : ctx.m.inspector.insFxRateLockedAt(entry.option.label, formatRate(entry.option.maxRate));
  }
  return np?.insertFxOn === false ? ctx.m.dynTuning.insfx.bypassed : null;
}

/** True where this family's response is DEFINED by its parameters, and so can be drawn
 *  without inventing anything. A guitar amp's frequency response and a pitch tracker are
 *  not, which is why those two faces are a lane rack alone. The multi-band compressor's
 *  is three of them, one per band; what is NOT derivable there is the filter response,
 *  and nothing here draws one. */
const hasCurve = (fam: InsertFxFamily | null): boolean => fam === "compander" || fam === "mbc";

/** The catalogue default for one slot, so a curve drawn before a plan carries a value is
 *  drawn from the same number the panel shows. */
const MBC_DEFAULTS: ReadonlyMap<number, number> = new Map(insertFxParams("mbc").map((d) => [d.slot, d.def]));

/** One multi-band value for a figure to draw, falling back to the catalogue's own default.
 *  Both figures read through it: written out per figure, a change to the fallback rule
 *  reached one curve and not the other. */
const mbcRaw = (v: DynValues, slot: number): number => {
  const n = v.get(slotKey("mbc", slot));
  return Number.isFinite(n) ? n : (MBC_DEFAULTS.get(slot) ?? 0);
};

/** The multi-band compressor's first face, which is the one that is not a band. */
const isMbcMain = (ctx: DynCtx): boolean => familyOf(ctx) === "mbc" && MBC_FACES[ctx.sel - 1] === undefined;
/** Whether this face is ONE band's rather than the set's. */
const isMbcBandFace = (ctx: DynCtx): boolean => familyOf(ctx) === "mbc" && MBC_FACES[ctx.sel - 1] !== undefined;
/** Whether a row's band belongs in its name here. On a band's own face the face is what
 *  says which band it is, so only the rows MAIN carries as well keep the name: named there
 *  and bare here, one value would read as two. Read off MAIN's own order rather than a
 *  label spelled here, so the two cannot disagree about which rows those are.
 *
 *  `bandFace` is passed in because it cannot change between the rows of one panel, and the
 *  field labels and the row builders both ask through here — a toggle and a slider on the
 *  same face must not end up named by different rules. */
const qualifyBand = (bandFace: boolean, d: InsertFxParamDesc): boolean => !bandFace || MBC_MAIN_ORDER.includes(d.label);

/**
 * The three bands' input→output transfers, in dBFS.
 *
 * Each is a plain compressor — unity up to its own threshold, the set ratio above it — with
 * that band's make-up added. Out Gain is not in any of them: it is applied to the SUM of
 * the three, so folding it into each would say every band is trimmed on its own.
 *
 * A band whose make-up is at the bottom of its range puts out nothing at all. It is drawn
 * at a level under the frame rather than at the floor, so the line leaves the plot instead
 * of lying along its bottom edge where a very quiet band would also be.
 */
function mbcResponses(v: DynValues): {
  band: "low" | "mid" | "high";
  gainDb: number;
  out: (inDb: number) => number;
}[] {
  return MBC_BANDS.map((b) => {
    const c = mbcBandCurve({ threshold: mbcRaw(v, b.threshold), ratio: mbcRaw(v, b.ratio), gain: mbcRaw(v, b.gain) });
    const silent = c.gainDb === -Infinity;
    return {
      band: b.band,
      // What the annotation over the curve takes off before it calls the rest a reduction.
      gainDb: silent ? 0 : c.gainDb,
      out: (inDb: number): number =>
        silent
          ? CURVE_LO_DB - 40
          : (inDb <= c.thresholdDb ? inDb : c.thresholdDb + (inDb - c.thresholdDb) / c.ratio) + c.gainDb,
    };
  });
}

/** Which families the unit meters a reduction for. Not "which are dynamics processors" —
 *  a guitar amp carries a noise gate and Pitch Fix attenuates, and neither moves the
 *  meter. The compander and the multi-band compressor are the two, and the pair is what
 *  decides whether a face gets a reduction lane at all. */
const hasReduction = (fam: InsertFxFamily | null): boolean => fam === "compander" || fam === "mbc";

/**
 * The compander's input→output transfer, in dBFS, as the shared block defines it: a
 * window that passes unchanged, an expander below it, the set ratio above the threshold,
 * and a limiter above 0 dB. Out Gain moves the whole curve down (its range only
 * attenuates), so it is added at the end rather than folded into a segment.
 *
 * Read once per redraw rather than per sample point: the curve evaluates this ~120 times
 * and each `v.get` walks the plan.
 */
export function companderResponse(
  v: DynValues,
  fam: InsertFxFamily,
  selector: number | undefined,
): (inDb: number) => number {
  const raw = (slot: number, def: number): number => {
    const n = v.get(slotKey(fam, slot));
    return Number.isFinite(n) ? n / 100 : def;
  };
  const thr = raw(companderSlot("threshold"), -10);
  const ratio = Math.max(1, raw(companderSlot("ratio"), 3.5));
  const width = Math.max(0, raw(companderSlot("width"), 6));
  const gain = raw(companderSlot("gain"), 0);
  const expand = selector === COMPANDER_H ? EXPANDER_RATIO.h : EXPANDER_RATIO.s;
  const windowLo = thr - width;
  // What the compressor puts out at 0 dBFS. Above that the limiter holds it there, so the
  // ceiling is read off the segment below rather than written as a second constant.
  const ceiling = thr + (0 - thr) / ratio;
  return (inDb) => {
    const out =
      inDb <= windowLo
        ? windowLo + (inDb - windowLo) * expand
        : inDb <= thr
          ? inDb
          : inDb <= 0
            ? thr + (inDb - thr) / ratio
            : ceiling;
    return out + gain;
  };
}

/** The family a node holds, or null where it holds nothing (No Effect, or nothing at all).
 *  Asked of the value the DEVICE path acts on, not of the raw plan value: a node's control
 *  may not carry what the plan holds, and the emit path coerces such a value to No Effect
 *  and writes no engine parameter for it. */
function familyOf(ctx: DynCtx): InsertFxFamily | null {
  const v = effectiveInsertFx(ctx.model, ctx.plan, ctx.nodeId);
  return v === undefined ? null : insertFxFamilyOf(v);
}

/**
 * The family this screen shows for a node, or null. `bind` refuses on the same answer, so
 * the Inspector's choice between its own editor and the launcher cannot disagree with
 * whether the screen would open.
 *
 * A value the node's own control does not carry answers null as well, because the emit path
 * turns it into No Effect and writes no engine parameter — an editor over it would collect
 * edits nothing ever sends.
 *
 * One family answers null: the multi-band compressor's bands and globals are a structured
 * layout rather than a list, and the flat catalogue carries none of it.
 */
export function insertFxScreenFamily(model: DeviceModel, plan: Plan, nodeId: string): InsertFxFamily | null {
  const v = effectiveInsertFx(model, plan, nodeId);
  const fam = v === undefined ? null : insertFxFamilyOf(v);
  return fam && rowsOf(fam).length ? fam : null;
}

/** The catalogue rows this screen shows, in display order, for one face of one family.
 *
 *  `type` is the selector value the node holds. Only the compander reads it, and only for
 *  its defaults — the two share every row and come up at different values, so a screen that
 *  did not pass it printed Compander-H's numbers on a Compander-S. */
function rowsOf(fam: InsertFxFamily, sel = 0, type?: number): InsertFxParamDesc[] {
  const descs = insertFxParams(fam, type);
  if (fam === "mbc") return mbcRows(descs, sel);
  const order = ROW_ORDER[fam];
  if (!order) return [...descs];
  return [...descs].sort((a, b) => rankIn(order, descs, a) - rankIn(order, descs, b));
}

/** A label the order does not name keeps its catalogue position after the ones it does, so
 *  a parameter added to the catalogue appears rather than disappearing silently. */
function rankIn(order: readonly string[], descs: InsertFxParamDesc[], d: InsertFxParamDesc): number {
  const i = order.indexOf(d.label);
  return i < 0 ? order.length + descs.indexOf(d) : i;
}

/**
 * One face of the multi-band compressor.
 *
 * The split is what the effect IS: three compressors and the two frequencies that decide
 * what each of them hears. MAIN carries the crossovers and the levels the three bands are
 * mixed back at; a band face carries that band's own dynamics. Sixteen values on one panel
 * fits, and is still sixteen values with nothing saying which four belong together.
 *
 * Release is on every band face and is ONE value — the unit shares it across the three —
 * which is why it is ordered with the dynamics rather than with the levels.
 */
function mbcRows(descs: InsertFxParamDesc[], sel: number): InsertFxParamDesc[] {
  const band = MBC_FACES[sel - 1];
  if (band === undefined) {
    // MAIN: the three make-up gains in band order, then Out Gain, and ahead of the two
    // crossovers that decide the bands they belong to. The Bypasses are not here — each
    // belongs to one band and is on that band's own face.
    const on = descs.filter((d) => MBC_MAIN_ORDER.includes(d.label));
    return on.sort((a, b) => mainRank(descs, a) - mainRank(descs, b));
  }
  // Its make-up is here as well as on MAIN — last, after the dynamics it is the make-up
  // for — because it is the level this band comes back at and MAIN is where it is weighed
  // against the other two.
  const on = descs.filter((d) => d.band === band || d.label === "release");
  return on.sort((a, b) => rankIn(MBC_BAND_ORDER, descs, a) - rankIn(MBC_BAND_ORDER, descs, b));
}

/** A MAIN row's position: the three band gains in band order, then Out Gain — which is one
 *  value and sorts after the three that repeat — then the two crossovers. */
function mainRank(descs: InsertFxParamDesc[], d: InsertFxParamDesc): number {
  const within = d.band === undefined ? 0 : MBC_BAND_RANK[d.band];
  return rankIn(MBC_MAIN_ORDER, descs, d) * 10 + within;
}

/** The catalogue row one field key came from. Read from the KEY rather than from the plan:
 *  a row built for one family must go on printing that family's parameter even if the plan
 *  has since moved to another. Searched across the whole family rather than one face's
 *  rows — a slot is one parameter under a family whichever face shows it. */
function descOf(_ctx: DynCtx, key: string): InsertFxParamDesc | undefined {
  const parts = keyParts(key);
  return parts ? insertFxParams(parts.fam).find((d) => d.slot === parts.slot) : undefined;
}

const labelOf = (d: InsertFxParamDesc, m: Messages, qualify = true): string => {
  const t = m.inspector.insertFxEffect.params as Record<string, string | undefined>;
  const name = t[d.label] ?? d.label;
  // Named by its band where the three of them share a face: MAIN carries all three make-up
  // gains, and three cards saying Gain are three different parameters. `qualifyBand` is
  // what decides, and it is asked with the descriptor.
  return d.band !== undefined && qualify ? `${bandName(d.band, m)} ${name}` : name;
};

/**
 * What a MIDI assignment on an insert-FX value is called, from the scope its id carries.
 *
 * The scope is `insfx.<family>.<slot>` because the node can change what it holds, so the
 * id names the value it was made on rather than a position in whatever is there now. What
 * it prints is the screen's own name and the row's label, the way every other processor's
 * assignment reads — the family stays in the id and is not spelled, because naming it
 * would need a word per family and the compander's two types share one engine, so there
 * is no device string that covers a family. Null for a scope naming a family or a slot the
 * catalogue does not have, which is a mapping saved against a build that carried one.
 */
export function insertFxControlLabel(scope: string | undefined, m: Messages): string | null {
  const parts = scope?.split(".");
  if (!parts || parts.length !== 3 || parts[0] !== "insfx") return null;
  const d = insertFxParams(parts[1] as InsertFxFamily).find((p) => p.slot === Number(parts[2]));
  return d ? `${m.dynTuning.insfx.title} · ${labelOf(d, m)}` : null;
}

/** Read one catalogue row's current raw. */
const rawOf = (ctx: DynCtx, fam: InsertFxFamily, d: InsertFxParamDesc): number =>
  insertFxVal(ctx.plan, ctx.nodeId, fam, d.slot, d.def);

/**
 * The meter lanes either side of the effect.
 *
 * The two reduction meters are indexed differently, which is the whole reason this is not
 * one table: the output one is per BAND of the single output effect the device runs at a
 * time, and the input one is per neither. `meters.ts` carries both.
 *
 * Only a family the unit meters a reduction for gets the third lane. It is not that the
 * reduction is unavailable for the others — the unit reports none: with a guitar amp's own
 * noise gate taking the output to the floor, and with Pitch Fix running and shifted, `132`
 * holds the value that means the block is not engaged. A lane drawn there is a bar that
 * cannot move, which reads as "no reduction right now" rather than as "never".
 */
function lanesOf(ctx: DynCtx, isOutput: boolean): DynLane[] {
  const g = ctx.m.dynTuning;
  const inTap = tapFor(ctx.nodeId, "preinsfx", ctx.model.id) ?? null;
  const outTap = tapFor(ctx.nodeId, isOutput ? "post" : "prefader", ctx.model.id) ?? null;
  const fam = familyOf(ctx);
  const lanes: DynLane[] = [
    { key: "in", label: g.insfx.tapIn, caption: g.laneIn, kind: "level", tap: inTap },
    {
      key: "out",
      label: isOutput ? g.insfx.tapOutBus : g.insfx.tapOut,
      caption: g.laneOut,
      kind: "level",
      tap: outTap,
    },
  ];
  // The multi-band compressor is metered per BAND, and a band face carries the one that
  // belongs to it. MAIN carries none: it sets the crossovers and the levels the bands are
  // mixed back at, and three reductions beside those say which band is working without
  // saying anything about what is being set.
  if (fam === "mbc" && isOutput) {
    const band = MBC_FACES[ctx.sel - 1];
    if (band !== undefined) {
      lanes.push({
        key: "gr",
        // The same label every insert-FX reduction carries. WHICH band it is is the face's
        // to say — the bar above names it, and only one reduction is on this face.
        label: g.insfx.tapGr,
        kind: "gr",
        gr: insertFxOutGrAddr(MBC_BAND_RANK[band]),
        // Merged into the OUTPUT column, as every reduction on every screen is: one band's
        // reduction against the level it was taken off reads better than a column of its
        // own, and there is only one of them on this face to merge.
        sameSlot: true,
      });
    }
    return lanes;
  }
  // …and, on the input side, only where the value can be attributed to THIS node. `132`
  // reports one channel's reduction whichever channel holds the effect, and with two
  // holders it carries the one whose selector was written last and ignores the other
  // entirely — so on that other one's screen the lane would draw its neighbour's number,
  // which is a value and looks like an answer. The app's own menu makes the compander a device-wide slot and locks every
  // other node out of it, so one holder is the ordinary case; two is reachable only by
  // loading a plan whose slot conflict the operator waved through.
  if (hasReduction(fam) && (isOutput || (insertFxCensus(ctx.model, ctx.plan).get("compander")?.length ?? 0) <= 1)) {
    lanes.push({
      key: "gr",
      label: g.insfx.tapGr,
      kind: "gr",
      gr: isOutput ? insertFxOutGrAddr(0) : insertFxInGrAddr(),
      // Merged into the OUTPUT column, as every reduction on every screen is. No offset:
      // the rule is to subtract whatever gain the processor adds, and these effects add
      // none — the compander's makeup reaches 0 dB and only attenuates below it, so the
      // level bar and the reduction hanging off the top of the same ruler cannot meet.
      sameSlot: true,
    });
  }
  return lanes;
}

/**
 * The screen's one descriptor. Every family is one processor here — what a family with
 * several faces has instead is a `sel`, since its faces are the same panel over other
 * slots (the multi-band compressor's four).
 */
function insFxFace(): DynProcessor {
  const plot = transferPlot({
    loDb: CURVE_LO_DB,
    outLoDb: CURVE_LO_DB,
    outTicks: CURVE_OUT_TICKS,
    hint: (m) => m.dynTuning.insfx.curveHint,
    // The dot and the curve belong to the families whose response is DEFINED by their
    // parameters; on the others the column carries no plot at all, so nothing here is
    // reached. The multi-band compressor's MAIN face is the one exception inside a family
    // that has one: its axis is frequency, and a level plotted against frequency is a
    // reading of nothing.
    on: (ctx) => hasCurve(familyOf(ctx)) && !isMbcMain(ctx),
    // The reduction as a NUMBER, beside the curve it is happening on. The bar overlay
    // and its tile in the METER column are the same value read two other ways; what the
    // plot was missing is the one that belongs to the response — the annotation hanging
    // off the top is the curve's own arithmetic at full scale, which does not move with
    // the signal. Nothing is drawn without a reading: a parked figure would say the
    // effect is passing everything, which is a different state from not being metered.
    liveExtra: (c, g, read, tok) => {
      const gr = read("gr");
      if (gr === null || gr >= 0) return;
      c.save();
      c.fillStyle = tok["--gr"];
      c.textAlign = "right";
      c.font = "700 11px var(--mono), monospace";
      c.fillText(`GR ${gr.toFixed(1)} dB`, g.w - g.pad.r - 4, g.pad.t + 12);
      c.restore();
    },
  });
  return {
    key: "insfx",
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
      const fam = insertFxScreenFamily(ctx.model, ctx.plan, ctx.nodeId);
      if (!ifx || !fam) return null;
      const fields: DynField[] = rowsOf(fam, ctx.sel, effectiveInsertFx(ctx.model, ctx.plan, ctx.nodeId))
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
        // A guitar amp is a dozen continuous values against a display that is a level rack
        // and nothing else, and the real control it stands for is a row of knobs. Both
        // halves of that arrangement ride together: the columns swap AND the sliders
        // become knobs, so neither is a guitar amp with the other one missing.
        // Pitch Fix takes the same arrangement for the same reason: a dozen continuous
        // values against a display with no reading of its own but the level taps, which is
        // what the column reversal is for. Its display column carried a READ-ONLY copy of
        // the controls beside it — the Key, the Scale and the twelve notes, drawn twice on
        // one face — and there was no lane rack on that face at all.
        ...(isPanelFirst(fam) ? { paramsFirst: true as const } : {}),
        ...(isKnobGrid(fam) ? { knobGrid: true as const } : {}),
        // The multi-band compressor takes the amp's knobs — its values are the same kind of
        // thing — but THREE to a row rather than six, and with the display column still
        // first, because its display is a plot rather than a rack alone. Three is what
        // makes the four faces the same height: MAIN is six cards and a band face four, so
        // both are two rows, and the segment that moves between them does not resize the
        // modal under the pointer.
        ...(fam === "mbc" ? { knobCols: 3 } : {}),
      };
    },

    // The faces a family has, offered only where there is more than one. A family with a
    // single face answers nothing and the host reserves the bar's space instead, so the
    // controls below start at the same height on every effect.
    bar: (ctx) => {
      const fam = familyOf(ctx);
      if (!fam || !isBanked(fam)) return undefined;
      const g = ctx.m.dynTuning.insfx;
      const t = ctx.m.inspector.insertFxEffect;
      return {
        label: ctx.m.dynTuning.display,
        items: [
          { label: g.faceMain, id: "dyn-face-insfx-main", face: INSFX_DYN, sel: 0 },
          { label: t.bandLow, id: "dyn-face-insfx-low", face: INSFX_DYN, sel: 1 },
          { label: t.bandMid, id: "dyn-face-insfx-mid", face: INSFX_DYN, sel: 2 },
          { label: t.bandHigh, id: "dyn-face-insfx-high", face: INSFX_DYN, sel: 3 },
        ],
      };
    },

    read: (ctx) => {
      const fam = familyOf(ctx);
      if (!fam) return {};
      const out: Record<string, unknown> = {};
      // Every row of the family, not only this face's: `rowStates` reads the modulation
      // selector, which is on the amp face, to lock two rows beside it.
      const type = effectiveInsertFx(ctx.model, ctx.plan, ctx.nodeId);
      for (const d of insertFxParams(fam, type)) out[slotKey(fam, d.slot)] = rawOf(ctx, fam, d);
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

    // Two paths per slot, because the re-key WRITES one and REMOVES the other: the
    // family-qualified key the plan stores under, and the bare slot a readback wrote, whose
    // absence afterwards is as much this edit's assertion as the value it put in. The
    // Inspector's own funnel names the same pair; without this the Scale selector — which
    // writes twelve mask slots at once, several of them already holding the value it writes
    // — leaves those to a diff that can only see what moved.
    written: (_ctx, patch) =>
      Object.keys(patch).flatMap((key) => {
        const parts = keyParts(key);
        return parts
          ? [`insertFxParams.${insertFxParamKey(parts.fam, parts.slot)}`, `insertFxParams.${parts.slot}`]
          : [];
      }),

    // A field carries a family and a slot, and a slot means a different parameter under
    // every family, so both of these read the catalogue row out of the key itself.
    fieldLabel: (f, m, ctx) => {
      const d = descOf(ctx, f.key);
      return d && labelOf(d, m, qualifyBand(isMbcBandFace(ctx), d));
    },
    fieldText: (f, v, ctx) => descOf(ctx, f.key)?.format?.(v),

    // The MIDI id a row arms into. Scoped by FAMILY and SLOT (controls.ts INSFX_SCOPE
    // says why): a field key already carries both, and a mapping made on one family does
    // not bind while the node holds another. An enum row answers null — a select has no
    // normalized domain — which is the treatment COMP's knee already gets.
    controlId: (ctx, key) => {
      const parts = keyParts(key);
      const d = parts && descOf(ctx, key);
      if (!parts || !d || d.control === "select") return null;
      return controlId(ctx.nodeId, "insfx", `${INSFX_SCOPE}.${parts.fam}.${parts.slot}`);
    },

    // Speed and Depth drive a vibrato the selector beside them can switch off. The rows
    // stay where they are, tagged and still editable, rather than being dropped: a panel
    // that loses two rows moves everything under them out from under the pointer.
    rowStates: (ctx, vals) => {
      const fam = familyOf(ctx);
      if (!fam) return null;
      const params = ctx.plan.nodeParams[ctx.nodeId]?.insertFxParams;
      /** One state for each slot in `slots`, or null for none — the shape all three
       *  branches below answer in, so the key convention is written once. */
      const statesFor = (slots: Iterable<number>, opts: SettingsRowOptions): Map<string, SettingsRowOptions> | null => {
        const out = new Map<string, SettingsRowOptions>();
        for (const slot of slots) out.set(slotKey(fam, slot), opts);
        return out.size ? out : null;
      };
      // While the multi-band compressor's 1-knob is on, the unit is setting these from its
      // own level. The set comes from the WRITER's own list rather than being spelled
      // again: a row locked while the plan still sends it is the drift.
      //
      // Locked and NOT tagged, which is the one place this screen departs from COMP's
      // treatment. A tag says why THIS row cannot be touched, and it earns its space where
      // some rows carry it and others do not; here it is every row for one reason, so
      // sixteen copies of one word carry nothing a reader did not have from the first. The
      // reason is on the panel's own line instead — and the cost of the other way was
      // measured: the word wraps inside a card and the panel grew 414px, which is the
      // resize under the pointer that "no row is ever removed" exists to stop.
      if (fam === "mbc") {
        // The 1-Knob's own Level is locked too while the knob is off, and it is not a row
        // of this panel — `mbcOneKnobSection` draws it, and asks the same predicate.
        const locked = insertFxLockedSlots(fam, params);
        return statesFor(
          [...locked].filter((slot) => slot !== MBC_ONE_KNOB.level.slot),
          { locked: true },
        );
      }
      // …and while Pitch Fix's MIDI Control is on, the unit is deriving the mask from its
      // own port. Same list as the writer's, for the same reason.
      if (fam === "pitch") {
        return statesFor(insertFxLockedSlots(fam, params), {
          locked: true,
          tag: ctx.m.dynTuning.insfx.deviceOnlyTag,
        });
      }
      // …and Clean's Speed and Depth are heard on the vibrato alone. TAGGED AND LIVE: the
      // unit stores them and takes a write whatever the modulation reads, so the row says
      // when its value applies rather than refusing the gesture.
      return statesFor(insertFxInactiveSlots(fam, params), { tag: ctx.m.dynTuning.insfx.vibOnly });
    },

    // Everything that is not a slider — the guitar amp's cabinet selectors and its gate
    // switch. Placed in front of the slider that follows them in display order, so the
    // panel reads in one order rather than sliders-then-the-rest.
    rows: (ctx) => {
      const fam = familyOf(ctx);
      if (!fam) return {};
      const descs = rowsOf(fam, ctx.sel, effectiveInsertFx(ctx.model, ctx.plan, ctx.nodeId));
      // One question about the panel rather than about a row, so it is asked once.
      const bandFace = isMbcBandFace(ctx);
      const before: Record<string, HTMLElement[]> = {};
      const tail: HTMLElement[] = [];
      let pending: HTMLElement[] = [];
      // The guitar amps' one row break, in front of the first row of the second group the
      // type actually has. `pending` is what carries it: a break pushed here rides in
      // front of whatever row follows, whether that row is a slider the loop attaches it
      // to or a selector it accumulates beside.
      let breakBefore = isGuitar(fam) ? descs.find((d) => GUITAR_AFTER_BREAK.has(d.label)) : undefined;
      for (const d of descs) {
        if (d === breakBefore) {
          pending.push(rowBreak());
          breakBefore = undefined;
        }
        if (d.control === "slider") {
          if (pending.length) {
            before[slotKey(fam, d.slot)] = pending;
            pending = [];
          }
          continue;
        }
        const key = slotKey(fam, d.slot);
        const cur = rawOf(ctx, fam, d);
        const label = labelOf(d, ctx.m, qualifyBand(bandFace, d));
        // Pitch Fix's Key comes with a neighbour on each side, so the three are pushed
        // together here rather than as three guards on one predicate spread down the body.
        //
        // MIDI Control goes in FRONT: it decides where the notes the correction aims at
        // come from, and from Setting on, the Key's own Scale is the unit's. The Key
        // itself is a plain enum in the catalogue, but writing it alone would leave the
        // mask spelling the old root — the unit re-derives on a Key write and an offline
        // plan has to agree with what it would have derived. The Scale is not in the flat
        // catalogue at all and belongs behind the Key, which is the value it is rooted at;
        // the twelve notes it derives go to the tail instead, because one control twelve
        // buttons wide takes a whole row and mid-panel it would end the row it lands in
        // and leave the rest of it empty.
        if (fam === "pitch" && d.label === "key") {
          pending.push(
            pitchMidiRow(ctx),
            enumRow(label, d.options ?? [], cur, (v) => ctx.set(slotPatch(pitchKeyPatch(scaleOf(ctx), v)))),
            pitchScaleRow(ctx, deviceOwned(ctx)),
          );
          continue;
        }
        pending.push(
          d.control === "toggle"
            ? ctx.midi(
                settingsRow(
                  label,
                  // A knob grid gives every control one card, so its switch is the
                  // one-button form: the pair splits a card between two words where the
                  // single button prints the state it is in.
                  isKnobGrid(fam)
                    ? onOffButton(cur !== 0, (on) => ctx.set({ [key]: on ? 1 : 0 }))
                    : onOff(cur !== 0, (on) => ctx.set({ [key]: on ? 1 : 0 })),
                ),
                key,
              )
            : enumRow(label, d.options ?? [], cur, (v) => ctx.set({ [key]: v })),
        );
      }
      tail.push(...pending);
      if (fam === "pitch") tail.push(pitchNotesRow(ctx, deviceOwned(ctx)));
      return { before, tail };
    },

    // The multi-band compressor's 1-Knob, above the panel it governs — a stage of its own,
    // the way the EQ's is, rather than two more cards in a grid of four-per-band rows.
    sections: (ctx) => (familyOf(ctx) === "mbc" ? [mbcOneKnobSection(ctx)] : []),

    // The companders' response IS defined by their parameters, so they take the plot the
    // compressor screens use — same axes, same live dot, same reduction rule. So does each
    // band of the multi-band compressor. The guitar amps and Pitch Fix take the lane rack
    // alone: a frequency response and a pitch tracker are not derivable from these values,
    // and the unit meters neither.
    ...plot,
    // …and the multi-band compressor's MAIN face takes a different pair of axes on the same
    // canvas, the way the SSMCS strip's side-chain segment does. Frequency across, band
    // make-up up: what MAIN sets is where the bands are split and how loud each comes back,
    // and both of those are on those two axes. Overridden AFTER the spread, delegating to
    // the factory everywhere else, so one face's axes cannot silently become every face's.
    plotGeo: (w, h, ctx) => (isMbcMain(ctx) ? freqGeo(w, h) : plot.plotGeo!(w, h, ctx)),
    drawAxes: (c, g, tok, ctx) => (isMbcMain(ctx) ? drawFreqAxes(c, g, tok) : plot.drawAxes!(c, g, tok, ctx)),
    // AFTER the spread: `transferPlot` supplies a display of its own, and this screen's is
    // the one that decides whether there is a plot in the column at all.
    display: (parts, ctx) => (hasCurve(familyOf(ctx)) ? splitDisplay(parts) : parts.lanes()),
    // …and the note under it. Saying that nothing reaches the signal outranks describing
    // what the curve would do to it, so the curve's own line takes the space only when
    // there is nothing else to say — the arrangement the compressor screens have, where
    // that line is the only one there is. Null keeps the line's space either way.
    // Per family: the compander explains its curve, and Pitch Fix explains that its display
    // is the correction's TARGET rather than a reading of the signal — which is what every
    // other screen's display column carries, so without a line the twelve notes read as
    // something the unit is tracking. A guitar face has a lane rack and nothing to explain.
    hint: (ctx) => {
      const off = offNote(ctx);
      if (off) return off;
      const fam = familyOf(ctx);
      const g = ctx.m.dynTuning.insfx;
      if (fam === "mbc") {
        // Who owns the panel outranks what the figure is doing, the same way the bypass
        // note outranks both.
        if (insertFxDeviceDriven("mbc", ctx.plan.nodeParams[ctx.nodeId]?.insertFxParams).size) return g.mbcOneKnob;
        return isMbcMain(ctx) ? g.mbcMainHint : g.mbcBandHint;
      }
      // …and nothing where the column is the level taps alone: a guitar amp's face and
      // Pitch Fix's both are, and a line under a lane rack has nothing to explain.
      return hasCurve(fam) ? g.curveHint : null;
    },
    drawCurve: (c, g, v, tok, ctx) => {
      const fam = familyOf(ctx);
      if (!hasCurve(fam) || !fam) return;
      // Three lines on one pair of axes, in one colour, told apart by shape and by name:
      // they are three bands of one effect, and giving each its own colour would say they
      // are three different kinds of thing. No reduction annotation — that one is the
      // curve's own arithmetic at full scale, and three of them would be drawn on top of
      // each other; the unit meters all three and the rack beside this shows them.
      if (fam === "mbc") {
        if (isMbcMain(ctx)) return drawMbcBands(c, g, v, tok, ctx);
        const band = MBC_FACES[ctx.sel - 1];
        const r = mbcResponses(v).find((x) => x.band === band);
        if (r) drawTransferCurve(c, g, tok, { out: r.out, gainDb: r.gainDb, loDb: CURVE_LO_DB });
        return;
      }
      const selector = effectiveInsertFx(ctx.model, ctx.plan, ctx.nodeId);
      drawTransferCurve(c, g, tok, {
        out: companderResponse(v, fam, selector),
        // The reduction annotation `drawTransferCurve` hangs off the top measures how far
        // the curve sits below unity once the processor's own make-up is taken out. This
        // block's Out Gain only ever attenuates, so there is none to take out.
        gainDb: 0,
        loDb: CURVE_LO_DB,
      });
      // The two coordinates the curve's shape is BUILT from, named on the axis they live
      // on. Both are kinks in the line and nothing else: without a mark, reading the
      // threshold off the plot means finding where the slope changes and estimating it.
      const thr = v.get(slotKey("compander", companderSlot("threshold"))) / 100;
      const width = v.get(slotKey("compander", companderSlot("width"))) / 100;
      curveMarks(c, g, tok, [
        { at: thr - width, tag: "W" },
        { at: thr, tag: "T" },
      ]);
      // Which expander the window's lower slope is, which the two Companders differ in and
      // no row on the screen carries — the family is one and the selector decides it.
      c.fillStyle = tok["--plot-dim"];
      c.textAlign = "left";
      c.font = "600 9px var(--mono), monospace";
      c.fillText(
        `EXPANDER ${selector === COMPANDER_H ? EXPANDER_RATIO.h : EXPANDER_RATIO.s}:1`,
        g.pad.l + 4,
        g.pad.t + 11,
      );
    },
  };
}

/**
 * What MAIN sets, on MAIN's own axes: where the two crossovers split the spectrum, and
 * what each band is mixed back at.
 *
 * A step and two boundaries, and NOT a filter response — the unit's slopes are derivable
 * from nothing the app holds, so the step is drawn as a step and the hint says so. Every
 * coordinate here is a parameter value the panel beside it carries.
 *
 * Drawn on the CANVAS rather than as elements, which is what makes it follow a knob: the
 * host redraws this layer whenever a value moves, while the display column is built once
 * per panel. Built as a strip of divs it showed the crossover it had when the panel was
 * built and went on showing it while the knob beside it read something else.
 */
function drawMbcBands(
  c: CanvasRenderingContext2D,
  g: DynPlotGeo,
  v: DynValues,
  tok: Record<string, string>,
  ctx: DynCtx,
): void {
  const edge = [
    mbcXoverHz(mbcRaw(v, slotOf("mbc", "xoverLowMid"))),
    mbcXoverHz(mbcRaw(v, slotOf("mbc", "xoverMidHigh"))),
  ];
  const at = (hz: number): number => Math.min(g.px(EQ_FREQ_MAX_HZ), Math.max(g.px(EQ_FREQ_MIN_HZ), g.px(hz)));
  // The band a frequency belongs to is decided by the LOWER of the two boundaries first,
  // so a crossover set below its neighbour leaves that band no width rather than
  // reordering the three into a picture that reads as valid.
  const cuts = [at(edge[0]), Math.max(at(edge[0]), at(edge[1]))];
  const bounds = [g.px(EQ_FREQ_MIN_HZ), cuts[0], cuts[1], g.px(EQ_FREQ_MAX_HZ)];

  c.save();
  c.strokeStyle = tok["--led"];
  c.lineWidth = 2;
  c.beginPath();
  for (const [i, b] of MBC_BANDS.entries()) {
    const gainDb = mbcBandCurve({
      threshold: mbcRaw(v, b.threshold),
      ratio: mbcRaw(v, b.ratio),
      gain: mbcRaw(v, b.gain),
    }).gainDb;
    // A band with no make-up left puts out nothing; it leaves the frame rather than lying
    // along the floor, where a merely quiet band would be drawn too.
    const y = g.py(gainDb === -Infinity ? GAIN_TICKS[GAIN_TICKS.length - 1] - 12 : gainDb);
    c.moveTo(bounds[i], y);
    c.lineTo(bounds[i + 1], y);
  }
  c.stroke();

  // The two boundaries, in the dim ink the compander's own threshold marks take: they are
  // where the step changes and nothing else, so reading one off the plot would otherwise
  // mean finding the jump and estimating it.
  // The same dash the shared mark recipe uses (`curveMarks`) — the two are one visual
  // vocabulary, and they disagreed by a pixel the day this one was written.
  c.setLineDash([2, 3]);
  c.strokeStyle = tok["--plot-dim"];
  c.lineWidth = 1;
  c.fillStyle = tok["--plot-dim"];
  c.font = "600 9px var(--mono), monospace";
  c.textAlign = "center";
  for (const [i, x] of cuts.entries()) {
    c.beginPath();
    c.moveTo(x + 0.5, g.pad.t);
    c.lineTo(x + 0.5, g.h - g.pad.b);
    c.stroke();
    // Stacked rather than side by side: the two can be set within a few Hz of each other,
    // and two labels on one line then overprint. Held inside the frame as well, so a
    // crossover at the end of its range reads instead of running off the edge.
    const label = mbcXoverLabel(mbcRaw(v, slotOf("mbc", i === 0 ? "xoverLowMid" : "xoverMidHigh")));
    const half = c.measureText(label).width / 2 + 2;
    const tx = Math.min(g.w - g.pad.r - half, Math.max(g.pad.l + half, x));
    c.fillText(label, tx, g.pad.t + 10 + i * 11);
  }
  c.setLineDash([]);

  // Each band named inside the width it was given, so the three segments of the step read
  // as bands rather than as three unrelated levels.
  c.fillStyle = tok["--plot-faint"];
  for (const [i, b] of MBC_BANDS.entries()) {
    if (bounds[i + 1] - bounds[i] < 26) continue;
    c.fillText(bandName(b.band, ctx.m), (bounds[i] + bounds[i + 1]) / 2, g.h - g.pad.b - 6);
  }
  c.restore();
}

/** A slot→raw patch, as the field keys `patch` speaks. */
const slotPatch = (patch: Record<number, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(patch).map(([slot, raw]) => [slotKey("pitch", Number(slot)), raw]));

const scaleOf = (ctx: DynCtx): number =>
  insertFxVal(ctx.plan, ctx.nodeId, "pitch", PITCH_SCALE_SLOT, PITCH_SCALE_CHROMATIC);

/**
 * The Scale selector, beside the Key it is rooted at.
 *
 * Every preset is selectable: the unit derives the twelve-note mask from the Scale and the
 * Key for all eight, and the app authors the same offsets — which is what lets a preset be
 * shown as itself instead of collapsing to Custom.
 */
function pitchScaleRow(ctx: DynRowCtx, owned: SettingsRowOptions | undefined): HTMLElement {
  const t = ctx.m.inspector.insertFxEffect;
  const scale = scaleOf(ctx);
  // Read at the gesture, not here: `ctx.live()` is the whole reason the Key that reaches
  // the mask is the one the plan holds when the operator picks, rather than the one drawn.
  const keyNow = (): number => insertFxVal(ctx.live().plan, ctx.nodeId, "pitch", PITCH_KEY_SLOT, 0);
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
  return enumRow(
    t.scale,
    scales,
    scales.some((o) => o.value === scale) ? scale : PITCH_SCALE_CUSTOM,
    (v) => ctx.set(slotPatch(pitchScalePatch(v, keyNow()))),
    owned,
  );
}

/**
 * The twelve semitones the Scale derives, as one control.
 *
 * ABSOLUTE semitones — slot 22 is C whatever the Key is — so the buttons are named from C
 * and are not laid out as a keyboard, which would imply a root that is not there. Editing
 * one takes the Scale to Custom: the unit does that itself, and the app writes it too
 * because the plan is what the next flush emits and a plan still spelling a preset would
 * re-derive the mask over the edit.
 */
function pitchNotesRow(ctx: DynRowCtx, owned: SettingsRowOptions | undefined): HTMLElement {
  const t = ctx.m.inspector.insertFxEffect;
  const notes = el("span", "ctl gt-notes");
  PITCH_NOTE_SLOTS.forEach((slot, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = SEMITONE_NAMES[i];
    const on = insertFxVal(ctx.plan, ctx.nodeId, "pitch", slot, 1) !== 0;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
    // What the button SHOWS is the value it was drawn from; what it WRITES is the negation
    // of the value the plan holds when it is pressed. A follow that moved this note under a
    // deferred rebuild would otherwise be written straight back.
    b.addEventListener("click", () => {
      const now = insertFxVal(ctx.live().plan, ctx.nodeId, "pitch", slot, 1) !== 0;
      ctx.set({ [slotKey("pitch", slot)]: now ? 0 : 1, [slotKey("pitch", PITCH_SCALE_SLOT)]: PITCH_SCALE_CUSTOM });
    });
    notes.append(b);
  });
  return settingsRow(t.scaleNotes, notes, owned);
}

/**
 * The multi-band compressor's 1-Knob.
 *
 * A stage above the panel rather than cards in it: it decides whose the values below are,
 * which is where the EQ's own 1-knob section sits for the same reason — and the grid under
 * it is three cards to a row because that is what makes the four faces the same height.
 *
 * The Level is locked while the knob is OFF, which is the COMP knob's own treatment: it
 * drives nothing there, and the row stays rather than being dropped so the section does not
 * change height on a switch.
 */
function mbcOneKnobSection(ctx: DynRowCtx): HTMLElement {
  const t = ctx.m.inspector.insertFxEffect;
  const raw = (slot: number): number => insertFxVal(ctx.plan, ctx.nodeId, "mbc", slot, 0);
  const on = raw(MBC_ONE_KNOB.on.slot) !== 0;
  const locked = insertFxLockedSlots("mbc", ctx.plan.nodeParams[ctx.nodeId]?.insertFxParams);
  const set = (slot: number, v: number): void => ctx.set({ [slotKey("mbc", slot)]: v });
  // A CONTINUOUS value writes without rebuilding. `set` re-renders the screen, which
  // replaces the element the pointer is holding, so a drag ends after its first step and
  // the slider can only be moved one detent at a time. The switch above keeps `set`: it
  // changes what the rest of the panel is (locks, the note under the display), and it is
  // one press rather than a gesture that has to survive.
  const setValue = (slot: number, v: number): void => ctx.setValue({ [slotKey("mbc", slot)]: v });
  const sec = settingsSection(t.oneKnob);
  sec.append(
    ctx.midi(
      settingsRow(
        ctx.m.inspector.on,
        onOff(on, (v) => set(MBC_ONE_KNOB.on.slot, v ? 1 : 0)),
      ),
      slotKey("mbc", MBC_ONE_KNOB.on.slot),
    ),
    ctx.midi(
      // Not `oneKnobLevelRow`: that one is the COMP knob's own 0-100 % scale, and this
      // level is a bare 0-48 the unit prints as a number. What they share is the row
      // shape, which is `sliderRow` underneath both — and the `setValue` that goes with
      // it, which is the half this row lost by not calling that helper.
      sliderRow({
        label: t.params.oneKnobLevel,
        min: MBC_ONE_KNOB.level.rawMin,
        max: MBC_ONE_KNOB.level.rawMax,
        step: 1,
        value: raw(MBC_ONE_KNOB.level.slot),
        format: String,
        onInput: (v: number) => setValue(MBC_ONE_KNOB.level.slot, v),
        row: locked.has(MBC_ONE_KNOB.level.slot) ? { locked: true } : undefined,
      }),
      slotKey("mbc", MBC_ONE_KNOB.level.slot),
    ),
  );
  return sec;
}

/**
 * How the Scale row and the twelve notes are drawn while the unit owns them, or undefined.
 *
 * `rowStates` cannot reach either: it is keyed by FIELD, and these two are rows this file
 * builds by hand. So the same question is asked here, of the same list the writer reads.
 */
function deviceOwned(ctx: DynRowCtx): SettingsRowOptions | undefined {
  return pitchDeviceDriven(ctx.plan.nodeParams[ctx.nodeId]?.insertFxParams).size
    ? { locked: true, tag: ctx.m.dynTuning.insfx.deviceOnlyTag }
    : undefined;
}

/** The one element that ends a row of a knob grid: it spans every column, so what follows
 *  it starts a row of its own. Empty and hidden — it separates two groups and names
 *  neither, and a caption here would be a heading inside a panel that has one already. */
function rowBreak(): HTMLElement {
  const b = el("span", "gt-break");
  b.setAttribute("aria-hidden", "true");
  return b;
}

/**
 * MIDI Control.
 *
 * Two bits for three modes, so the write names both — setting the enable bit alone would
 * leave whichever real-time bit was there and land on a mode nobody chose.
 *
 * Switching it on clears the twelve-note mask and takes the Scale to Custom. That is the
 * unit's own behaviour when the mode is changed on its front panel, and it is what the
 * operator asked for by changing it: from there the notes the correction aims at come from
 * a USB-MIDI port of the unit's own, so the mask and the Scale are the unit's while it is
 * on (`pitchDeviceDriven`) — locked here, and not emitted by the writer.
 */
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
    PITCH_MIDI_MODES.map((label, value) => ({ value, label })),
    mode,
    (v) => ctx.set(slotPatch(pitchMidiPatch(v))),
  );
  row.title = t.midiControlDeviceOnly;
  return row;
}

/** The descriptor a launcher opens. */
export const INSFX_DYN = insFxFace();
