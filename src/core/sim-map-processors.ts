// The SIM table's processor paths: SSMCS, the 1-knob EQ and COMP, the ducker, the FX
// channels' effect, the insert FX, BUS Type and the COMP / EQ order.
//
// The plan holds SSMCS and the FX channels' effect values as the unit's raw integers,
// and the simulator holds what its screens print (hertz, milliseconds, a place on a
// filter's scale). Each such value is converted through the simulator's own readings
// of the raws: a write is taken only where a raw reads exactly the value written.

import type { DeviceModel } from "../models/types";
import { parseRef, ref } from "../models/types";
import { incomingConnection, type FxEffectParams, type NodeParams, type Plan } from "./plan";
import { canConnect } from "./routing";
import { insertFxMenu, insertFxRateLock } from "./constraints";
import { effectiveInsertFx, insertFxControl } from "./control/translate";
import {
  BUS_TYPE_OPTIONS,
  COMP_EQ_OPTIONS,
  compOneKnobPatch,
  EQ_ONE_KNOB_TYPE_OPTIONS,
  INSERT_FX_NONE,
  insertFxEngaged,
  SWEET_SPOT_DATA_OPTIONS,
} from "./control/params";
import {
  SSMCS_ATTACK_RAW_MAX,
  SSMCS_ATTACK_RAW_MIN,
  SSMCS_COMP_DRIVE_MAX,
  SSMCS_COMP_DRIVE_MIN,
  SSMCS_EQ_HIGH_FREQ_RAW_MIN,
  SSMCS_EQ_LOW_FREQ_RAW_MAX,
  SSMCS_FREQ_RAW_MAX,
  SSMCS_FREQ_RAW_MIN,
  SSMCS_GAIN_MAX,
  SSMCS_GAIN_MIN,
  SSMCS_MORPHING_MAX,
  SSMCS_MORPHING_MIN,
  SSMCS_Q_RAW_MAX,
  SSMCS_Q_RAW_MIN,
  SSMCS_RATIO_RAW_MAX,
  SSMCS_RATIO_RAW_MIN,
  SSMCS_RELEASE_RAW_MAX,
  SSMCS_RELEASE_RAW_MIN,
  ssmcsAttackMs,
  ssmcsCompDrive,
  ssmcsGainDb,
  ssmcsQ,
  ssmcsRatio,
  ssmcsReleaseMs,
} from "./control/vd";
import {
  FX_CHANNEL_NODE_INDEX,
  FX_EFFECT_ARRAY_PARAM,
  fxDescRawToSend,
  fxEffectTypes,
  fxFamilyOf,
  fxParams,
  fxRowOwners,
  initDelayMs,
  resolveFxEffectType,
  revxFreqHz,
  type FxFamily,
  type FxParamDesc,
} from "./control/fx-effect";
import { R40 } from "./control/preferred-numbers";
import {
  insertFxDefaults,
  insertFxFamilyOf,
  insertFxLockedSlots,
  insertFxParamKey,
  insertFxParams,
  insertFxSlotVal,
  insertFxSwitchOn,
  insertFxWritableSlots,
  MBC_BAND_PARAM,
  MBC_BANDS,
  MBC_GLOBAL,
  MBC_RELEASE_MS,
  mbcXoverHz,
  parkOutgoingInsertFxParams,
  pitchKeyChoice,
  pitchMidiMode,
  pitchMidiModeChange,
  pitchMidiPatch,
  pitchScaleChoice,
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
  mbcOneKnobSwitch,
  reKeyInsertFxParams,
  seedInsertFxParams,
  type InsertFxFamily,
} from "./control/insert-fx-effect";
import {
  bool,
  enumValue,
  groupValue,
  isMasterBus,
  isMonoChannel,
  isStereoChannel,
  nodeValue,
  np,
  refused,
  simStripId,
  UNCHANGED,
  type SimBinding,
  type SimEdit,
  type SimRefusal,
  type SimValue,
} from "./sim-map-base";

const KNEES = ["Soft", "Medium", "Hard"] as const;
/** The tempo-sync note values, in the simulator's spelling, by the plan's raw. */
const NOTE_VALUES = [
  "---",
  "1/32T",
  "1/16T",
  "1/16",
  "1/8T",
  "1/16.",
  "1/8",
  "1/4T",
  "1/8.",
  "1/4",
  "1/4.",
  "1/2",
  "1/2.",
  "whole",
  "whole x2",
] as const;
/** The FX filters' THRU ends, in raw: the HPF reads THRU up to here, the LPF from here. */
const FX2_HPF_THRU_TOP = 5;
const FX2_LPF_THRU = 122;
/** The lowest raw of the FX filters' LPF window. */
const FX2_LPF_FIRST = 21;

/** The raw in `min..max` that reads exactly `v`, the held raw first. Null where none does. */
function rawFor(v: SimValue, min: number, max: number, show: (raw: number) => SimValue, held: unknown): number | null {
  if (typeof held === "number" && held >= min && held <= max && show(held) === v) return held;
  for (let raw = min; raw <= max; raw++) if (show(raw) === v) return raw;
  return null;
}

/** How a plan leaf reads on the SIM, and the leaf a SIM value writes. */
interface Codec {
  show(raw: unknown): SimValue | undefined;
  take(v: SimValue, held: unknown): number | boolean | null;
  values?: readonly SimValue[];
}

/** A raw integer in `min..max`, read through `show`. */
function stops(min: number, max: number, show: (raw: number) => SimValue, values?: readonly SimValue[]): Codec {
  return {
    show: (raw) =>
      typeof raw === "number" && Number.isFinite(raw) ? show(Math.min(max, Math.max(min, Math.round(raw)))) : undefined,
    take: (v, held) => rawFor(v, min, max, show, held),
    values,
  };
}

/** A switch the plan holds as a boolean. */
const FLAG: Codec = {
  show: (raw) => (typeof raw === "boolean" ? raw : undefined),
  take: (v) => bool(v),
};

/** A list the plan holds as an index from `first`. */
const labelled = (labels: readonly string[], first: number): Codec =>
  stops(first, first + labels.length - 1, (raw) => labels[raw - first], labels);

function leafOf(obj: unknown, path: readonly string[]): unknown {
  let cur = obj;
  for (const key of path) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[key] : undefined;
  return cur;
}

function withLeaf(obj: unknown, path: readonly string[], value: unknown): Record<string, unknown> {
  const held = obj && typeof obj === "object" ? (obj as Record<string, unknown>) : {};
  const [head, ...rest] = path;
  return { ...held, [head]: rest.length ? withLeaf(held[head], rest, value) : value };
}

/** A leaf inside the SSMCS group, the way the SSMCS screens and the Inspector write one. */
function ssmcsValue(id: string, path: readonly string[], codec: Codec): SimBinding {
  return {
    values: codec.values,
    read: (plan) => codec.show(leafOf(np(plan, id).ssmcs, path)),
    write: (plan, v) => {
      const held = np(plan, id).ssmcs;
      const raw = codec.take(v, leafOf(held, path));
      if (raw === null) return refused("value");
      return {
        kind: "node",
        id,
        patch: { ssmcs: withLeaf(held, path, raw) } as NodeParams,
        written: [`ssmcs.${path.join(".")}`],
      };
    },
  };
}

/** An SSMCS EQ / side-chain frequency in hertz: the R40 grade four raws below 20 Hz names, to three figures. */
const ssmcsHz = (raw: number): number =>
  Number((R40[(raw + 8) % R40.length] * 10 ** Math.floor((raw + 8) / R40.length)).toPrecision(3));
const ssmcsQStop = (raw: number): number => Number(ssmcsQ(raw).toFixed(2));

/** The SSMCS paths of a channel, below `ch.<id>.ssmcs`. */
function ssmcsBindings(id: string, base: string, out: Map<string, SimBinding>): void {
  const gain = stops(SSMCS_GAIN_MIN, SSMCS_GAIN_MAX, ssmcsGainDb);
  const q = stops(SSMCS_Q_RAW_MIN, SSMCS_Q_RAW_MAX, ssmcsQStop);
  const freq = (min: number, max: number): Codec => stops(min, max, ssmcsHz);
  const sweetSpot = SWEET_SPOT_DATA_OPTIONS.map((o) => o.label);
  const rows: [string, readonly string[], Codec][] = [
    ["on", ["on"], FLAG],
    ["data", ["sweetSpotData"], labelled(sweetSpot, SWEET_SPOT_DATA_OPTIONS[0].value)],
    ["compDrive", ["compDrive"], stops(SSMCS_COMP_DRIVE_MIN, SSMCS_COMP_DRIVE_MAX, ssmcsCompDrive)],
    ["morphing", ["morphing"], stops(SSMCS_MORPHING_MIN, SSMCS_MORPHING_MAX, (raw) => raw)],
    ["outGain", ["outGain"], gain],
    ["comp.knee", ["comp", "knee"], labelled(KNEES, 0)],
    ["comp.attack", ["comp", "attack"], stops(SSMCS_ATTACK_RAW_MIN, SSMCS_ATTACK_RAW_MAX, ssmcsAttackMs)],
    ["comp.release", ["comp", "release"], stops(SSMCS_RELEASE_RAW_MIN, SSMCS_RELEASE_RAW_MAX, ssmcsReleaseMs)],
    ["comp.ratio", ["comp", "ratio"], stops(SSMCS_RATIO_RAW_MIN, SSMCS_RATIO_RAW_MAX, ssmcsRatio)],
    ["sc.on", ["sc", "on"], FLAG],
    ["sc.q", ["sc", "q"], q],
    ["sc.freq", ["sc", "freq"], freq(SSMCS_FREQ_RAW_MIN, SSMCS_FREQ_RAW_MAX)],
    ["sc.gain", ["sc", "gain"], gain],
    ["eq.low.on", ["eq", "low", "on"], FLAG],
    ["eq.low.freq", ["eq", "low", "freq"], freq(SSMCS_FREQ_RAW_MIN, SSMCS_EQ_LOW_FREQ_RAW_MAX)],
    ["eq.low.gain", ["eq", "low", "gain"], gain],
    ["eq.mid.on", ["eq", "mid", "on"], FLAG],
    ["eq.mid.q", ["eq", "mid", "q"], q],
    ["eq.mid.freq", ["eq", "mid", "freq"], freq(SSMCS_FREQ_RAW_MIN, SSMCS_FREQ_RAW_MAX)],
    ["eq.mid.gain", ["eq", "mid", "gain"], gain],
    ["eq.high.on", ["eq", "high", "on"], FLAG],
    ["eq.high.freq", ["eq", "high", "freq"], freq(SSMCS_EQ_HIGH_FREQ_RAW_MIN, SSMCS_FREQ_RAW_MAX)],
    ["eq.high.gain", ["eq", "high", "gain"], gain],
  ];
  for (const [path, leaf, codec] of rows) out.set(`${base}.ssmcs.${path}`, ssmcsValue(id, leaf, codec));
}

/** An enumeration held as a node param's own value, among `options`. */
function optionValue(
  id: string,
  key: "busType" | "compEqType",
  options: readonly { value: number; label: string }[],
  absent: number,
): SimBinding {
  return enumValue(
    options.map((o) => o.label),
    (plan) => {
      const i = options.findIndex((o) => o.value === (np(plan, id)[key] ?? absent));
      return i < 0 ? undefined : i;
    },
    (_plan, i) => ({ kind: "node", id, patch: { [key]: options[i].value } }),
  );
}

/** The 1-knob EQ's type, as the EQ tuning screen writes it. */
function eqOneKnobType(id: string): SimBinding {
  const options = EQ_ONE_KNOB_TYPE_OPTIONS;
  return enumValue(
    options.map((o) => o.label),
    (plan) => {
      const type = np(plan, id).eqOneKnob?.type;
      const i = options.findIndex((o) => o.value === type);
      return i < 0 ? undefined : i;
    },
    (plan, i) => ({
      kind: "node",
      id,
      patch: { eqOneKnob: { ...np(plan, id).eqOneKnob, type: options[i].value } },
      written: ["eqOneKnob.type"],
    }),
  );
}

/** A mid band's shape, which is a bell and nothing else on both sides. */
const MID_SHAPE = "Bell";
function midShape(id: string): SimBinding {
  return {
    values: [MID_SHAPE],
    read: () => MID_SHAPE,
    write: (_plan, v) => (v === MID_SHAPE ? UNCHANGED : refused("value")),
  };
}

/** The insert FX a node holds, written as the Inspector's selector writes it. */
function insertFxEffect(model: DeviceModel, id: string): SimBinding | null {
  const ifx = insertFxControl(model, id);
  if (!ifx) return null;
  const options = ifx.options;
  return enumValue(
    options.map((o) => o.label),
    (plan) => {
      const held = effectiveInsertFx(model, plan, id) ?? INSERT_FX_NONE;
      const i = options.findIndex((o) => o.value === held);
      return i < 0 ? undefined : i;
    },
    (plan, i) => {
      const sel = options[i].value;
      if ((effectiveInsertFx(model, plan, id) ?? INSERT_FX_NONE) === sel) return UNCHANGED;
      const lock = insertFxMenu(model, plan, id).find((e) => e.option.value === sel)?.lock;
      if (lock) return refused(lock);
      const patch: NodeParams = sel === INSERT_FX_NONE ? { insertFx: sel } : { insertFx: sel, insertFxOn: true };
      const parked = parkOutgoingInsertFxParams(plan.nodeParams[id]);
      const { params, seeded } = seedInsertFxParams(parked ?? undefined, sel);
      if (parked || seeded.length > 0) patch.insertFxParams = params;
      return { kind: "node", id, patch, defaults: seeded.map((key) => `insertFxParams.${key}`) };
    },
  );
}

/** The insert FX's ON switch, which is off whenever nothing is selected. */
function insertFxOn(model: DeviceModel, id: string): SimBinding {
  return {
    read: (plan) => insertFxEngaged(np(plan, id)),
    write: (plan, v) => {
      const on = bool(v);
      if (on === null) return refused("value");
      const held = insertFxEngaged(np(plan, id));
      const eff = effectiveInsertFx(model, plan, id);
      if (eff === undefined || eff === INSERT_FX_NONE) return on === held ? UNCHANGED : refused("noEffect");
      if (insertFxRateLock(insertFxMenu(model, plan, id), eff).locked) return on === held ? UNCHANGED : refused("rate");
      return { kind: "node", id, patch: { insertFxOn: on } };
    },
  };
}

/** How one engine slot's raw reads on the SIM, and the raw a SIM value writes within the slot's window. */
interface InsertLaw {
  show(raw: number): SimValue | undefined;
  take(v: SimValue, window: { rawMin: number; rawMax: number }): number | null;
  values?: readonly SimValue[];
}

/** A raw that reads `(raw - offset) / factor`: a value off that grid, or outside the window, writes nothing. */
function linear(factor: number, offset = 0): InsertLaw {
  return {
    show: (raw) => (raw - offset) / factor,
    take: (v, w) => {
      if (typeof v !== "number" || !Number.isFinite(v)) return null;
      const raw = Math.round(v * factor) + offset;
      return (raw - offset) / factor === v && raw >= w.rawMin && raw <= w.rawMax ? raw : null;
    },
  };
}

/** A raw read through a table: a value writes the raw in the window that reads exactly it. */
function reading(show: (raw: number) => number | undefined): InsertLaw {
  return { show, take: (v, w) => rawFor(v, w.rawMin, w.rawMax, (raw) => show(raw) ?? Number.NaN, undefined) };
}

/** A list of names, each the label of the raw it is. */
function named(options: readonly { value: number; label: string }[]): InsertLaw {
  return {
    values: options.map((o) => o.label),
    show: (raw) => options.find((o) => o.value === raw)?.label,
    take: (v) => options.find((o) => o.label === v)?.value ?? null,
  };
}

/** A switch held as 1 / 0. */
const SWITCH: InsertLaw = {
  show: (raw) => insertFxSwitchOn(raw),
  take: (v) => (typeof v === "boolean" ? (v ? 1 : 0) : null),
};
const TENTHS = linear(10);
const WHOLE = linear(1);

/** One of the simulator's insert rows: what it reads off the engine's slots, and the raws a value of it writes, by slot. */
interface InsertRow {
  values?: readonly SimValue[];
  read(raw: (slot: number) => number): SimValue | undefined;
  /** The slots the row itself names, at the raws `v` reads as. */
  take(v: SimValue): Record<number, number> | null;
  /** What the plan takes for `v`, where the row moves more than its own slots: the slots `take`
   *  names and the ones the unit moves with them. */
  patch?(v: SimValue, raw: (slot: number) => number): Record<number, number> | null;
}

/** A row that is one slot of `family`, writing the slot the catalogue mirrors it onto as well. */
function slotRow(family: InsertFxFamily, slot: number, law: InsertLaw): InsertRow {
  const spec = insertFxWritableSlots(family).find((s) => s.slot === slot);
  if (!spec) throw new Error(`${family} has no slot ${slot}`);
  return {
    values: law.values,
    read: (raw) => law.show(raw(slot)),
    take: (v) => {
      const raw = law.take(v, spec);
      if (raw === null) return null;
      return spec.mirror === undefined ? { [slot]: raw } : { [slot]: raw, [spec.mirror]: raw };
    },
  };
}

/** A select of the catalogue's, under the labels it carries. */
function optionRow(family: InsertFxFamily, slot: number): InsertRow {
  return slotRow(family, slot, named(insertFxParams(family).find((d) => d.slot === slot)?.options ?? []));
}

/** Pitch Fix's Scale names, in the simulator's spelling, by the slot's raw. */
const PITCH_SCALE_NAMES = [
  { value: PITCH_SCALE_CUSTOM, label: "Custom" },
  { value: PITCH_SCALE_SINGLE, label: "Single" },
  { value: PITCH_SCALE_MAJOR, label: "Major" },
  { value: PITCH_SCALE_NATURAL_MINOR, label: "Natural Minor" },
  { value: PITCH_SCALE_HARMONIC_MINOR, label: "Harmonic Minor" },
  { value: PITCH_SCALE_MELODIC_MINOR, label: "Melodic Minor" },
  { value: PITCH_SCALE_PENTATONIC, label: "Pentatonic" },
  { value: PITCH_SCALE_CHROMATIC, label: "Chromatic" },
];
/** MIDI Control's three settings: Off with the enable bit clear, Setting with it set, Real Time with both bits set. */
const PITCH_MIDI_MODES = ["Off", "Setting", "Real Time"] as const;

/** MIDI Control's mode as `raw` holds it: 0 Off, 1 Setting, 2 Real Time. */
const pitchModeOf = (raw: (slot: number) => number): number =>
  pitchMidiMode(raw(PITCH_MIDI_ENABLE_SLOT), raw(PITCH_MIDI_REALTIME_SLOT));

const pitchMidiControl: InsertRow = {
  values: PITCH_MIDI_MODES,
  read: (raw) => PITCH_MIDI_MODES[pitchModeOf(raw)],
  take: (v) => {
    const mode = PITCH_MIDI_MODES.indexOf(v as (typeof PITCH_MIDI_MODES)[number]);
    return mode < 0 ? null : pitchMidiPatch(mode);
  },
  // The Scale and the mask move with the mode the way the unit moves them.
  patch: (v, raw) => {
    const mode = PITCH_MIDI_MODES.indexOf(v as (typeof PITCH_MIDI_MODES)[number]);
    if (mode < 0) return null;
    return pitchMidiModeChange(pitchModeOf(raw), mode, raw(PITCH_SCALE_SLOT), raw(PITCH_KEY_SLOT));
  },
};

/** Pitch Fix's Scale: a named scale fills the mask in at the Key, except under Real Time. */
function pitchScaleRow(): InsertRow {
  const row = slotRow("pitch", PITCH_SCALE_SLOT, named(PITCH_SCALE_NAMES));
  return {
    ...row,
    patch: (v, raw) => {
      const own = row.take(v);
      return own ? pitchScaleChoice(pitchModeOf(raw), own[PITCH_SCALE_SLOT]!, raw(PITCH_KEY_SLOT)) : null;
    },
  };
}

/** Pitch Fix's Key: it re-roots the mask of a named scale, except under Real Time. */
function pitchKeyRow(): InsertRow {
  const row = optionRow("pitch", PITCH_KEY_SLOT);
  return {
    ...row,
    patch: (v, raw) => {
      const own = row.take(v);
      return own ? pitchKeyChoice(pitchModeOf(raw), raw(PITCH_SCALE_SLOT), own[PITCH_KEY_SLOT]!) : null;
    },
  };
}

/** A number the catalogue prints first in a slot's reading ("30 ms", "2.0:1"). */
const printed =
  (format: (raw: number) => string) =>
  (raw: number): number =>
    Number.parseFloat(format(raw));

/** The M.B.Comp rows its 1-knob switch moves besides itself: the Level and the values it holds
 *  fixed (`mbcOneKnobSwitch`). */
const MBC_ONE_KNOB_MOVES: readonly string[] = [
  "oneKnobLevel",
  ...MBC_BANDS.flatMap((b) => [`${b.band}Attack`, `${b.band}Bypass`]),
  "release",
  "xoverLowMid",
  "xoverMidHigh",
  "outGain",
];

/** The rows of each family the simulator names on an insert, by its key. */
function familyRows(family: InsertFxFamily): Record<string, InsertRow> {
  const at = (slot: number, law: InsertLaw) => slotRow(family, slot, law);
  switch (family) {
    case "compander":
      return {
        threshold: at(6, linear(100)),
        ratio: at(7, linear(100)),
        attack: at(8, linear(1000)),
        release: at(9, linear(10)),
        gain: at(10, linear(100)),
        width: at(11, linear(100)),
      };
    case "mbc": {
      const rows: Record<string, InsertRow> = {
        oneKnobOn: at(MBC_GLOBAL.oneKnobOn, SWITCH),
        oneKnobLevel: at(MBC_GLOBAL.oneKnobLevel, WHOLE),
        xoverLowMid: at(MBC_GLOBAL.xoverLowMid, reading(mbcXoverHz)),
        xoverMidHigh: at(MBC_GLOBAL.xoverMidHigh, reading(mbcXoverHz)),
        release: at(
          MBC_GLOBAL.release,
          reading((raw) => MBC_RELEASE_MS[raw]),
        ),
        outGain: at(MBC_GLOBAL.outGain, linear(1, 64)),
      };
      for (const b of MBC_BANDS) {
        rows[`${b.band}Bypass`] = at(b.bypass, SWITCH);
        rows[`${b.band}Threshold`] = at(b.threshold, linear(1, 127));
        rows[`${b.band}Ratio`] = at(b.ratio, reading(printed(MBC_BAND_PARAM.ratio.format)));
        rows[`${b.band}Attack`] = at(b.attack, reading(printed(MBC_BAND_PARAM.attack.format)));
        rows[`${b.band}Gain`] = at(b.gain, WHOLE);
      }
      return rows;
    }
    case "pitch": {
      const rows: Record<string, InsertRow> = {
        correction: at(13, SWITCH),
        coarse: at(6, WHOLE),
        fine: at(7, WHOLE),
        formant: at(8, linear(1, 64)),
        midiControl: pitchMidiControl,
        key: pitchKeyRow(),
        scale: pitchScaleRow(),
        mix: at(14, WHOLE),
        limitLow: at(20, WHOLE),
        limitHigh: at(21, WHOLE),
        speed: at(18, WHOLE),
        tolerance: at(19, WHOLE),
      };
      PITCH_NOTE_SLOTS.forEach((slot, semitone) => (rows[`note${semitone}`] = at(slot, SWITCH)));
      return rows;
    }
    default: {
      // The four guitar amps share every row but slot 6 and the few each adds; slot 7 is Volume on Clean.
      const rows: Record<string, InsertRow> = {
        [family === "guitar-clean" ? "volume" : "gain"]: at(7, TENTHS),
        bass: at(9, TENTHS),
        middle: at(10, TENTHS),
        treble: at(11, TENTHS),
        presence: at(12, TENTHS),
        output: at(14, WHOLE),
        spType: optionRow(family, 16),
        micPosition: optionRow(family, 18),
        gate: at(24, SWITCH),
        gateLevel: at(25, TENTHS),
      };
      if (family === "guitar-clean")
        Object.assign(rows, {
          blend: at(6, TENTHS),
          distortion: at(8, TENTHS),
          mod: optionRow(family, 19),
          modSpeed: at(20, TENTHS),
          modDepth: at(21, TENTHS),
        });
      if (family === "guitar-crunch") rows.type = at(6, WHOLE);
      if (family === "guitar-lead") Object.assign(rows, { type: at(6, WHOLE), master: at(13, TENTHS) });
      if (family === "guitar-drive") Object.assign(rows, { ampType: at(6, WHOLE), master: at(13, TENTHS) });
      return rows;
    }
  }
}

const FAMILY_ROWS = new Map<InsertFxFamily, Record<string, InsertRow>>();
function insertRows(family: InsertFxFamily): Record<string, InsertRow> {
  let rows = FAMILY_ROWS.get(family);
  if (!rows) FAMILY_ROWS.set(family, (rows = familyRows(family)));
  return rows;
}

/** The families of the effects a node's insert offers. */
function insertFamilies(model: DeviceModel, id: string): InsertFxFamily[] {
  const options = insertFxControl(model, id)?.options ?? [];
  return [...new Set(options.flatMap((o) => insertFxFamilyOf(o.value) ?? []))];
}

/**
 * One row of a node's insert, which names a different engine slot under each effect. A row
 * the selected effect does not carry reads nothing and takes no edit, and neither does a slot
 * the app holds shut for the effect's current values (`insertFxLockedSlots`, which carries the
 * slots the unit drives itself) or an effect the rate takes out.
 */
function insertFxParam(model: DeviceModel, id: string, key: string, families: readonly InsertFxFamily[]): SimBinding {
  const held = (plan: Plan) => {
    const sel = effectiveInsertFx(model, plan, id);
    const family = sel === undefined ? null : insertFxFamilyOf(sel);
    const row = family ? insertRows(family)[key] : undefined;
    if (sel === undefined || !family || !row) return null;
    const params = np(plan, id).insertFxParams;
    const defaults = insertFxDefaults(family, sel);
    const raw = (slot: number): number => insertFxSlotVal(params, family, slot, defaults[slot]);
    return { sel, family, row, params, raw };
  };
  return {
    values: families.map((f) => insertRows(f)[key]?.values).find((v) => v !== undefined),
    read: (plan) => {
      const h = held(plan);
      return h?.row.read(h.raw);
    },
    write: (plan, v) => {
      const h = held(plan);
      if (!h) return refused("type");
      const own = h.row.take(v);
      if (!own) return refused("value");
      if (h.row.read(h.raw) === v) return UNCHANGED;
      if (insertFxRateLock(insertFxMenu(model, plan, id), h.sel).locked) return refused("rate");
      const locked = insertFxLockedSlots(h.family, h.params);
      if (Object.keys(own).some((slot) => locked.has(Number(slot)))) return refused("locked");
      // The multi-band compressor's 1-knob, switched on, also sets the Level and the values it
      // holds fixed, as the unit does.
      const raws =
        h.family === "mbc" && key === "oneKnobOn"
          ? mbcOneKnobSwitch(h.params, (own[MBC_GLOBAL.oneKnobOn] ?? 0) !== 0)
          : own;
      const all = h.row.patch ? h.row.patch(v, h.raw) : raws;
      if (!all) return refused("value");
      const slots = Object.keys(all).map(Number);
      return {
        kind: "node",
        id,
        patch: { insertFxParams: reKeyInsertFxParams(h.params ?? {}, h.family, all) },
        written: slots.flatMap((slot) => [
          `insertFxParams.${insertFxParamKey(h.family, slot)}`,
          `insertFxParams.${slot}`,
        ]),
      };
    },
  };
}

/** The paths of the insert rows the unit drives itself for the effect each node now holds. */
export function insertDrivenPaths(model: DeviceModel, plan: Plan): string[] {
  const out: string[] = [];
  for (const node of model.nodes) {
    const id = node.id;
    if (!insertFxEffect(model, id)) continue;
    const sel = effectiveInsertFx(model, plan, id);
    const family = sel === undefined ? null : insertFxFamilyOf(sel);
    if (sel === undefined || !family) continue;
    const params = np(plan, id).insertFxParams;
    const locked = insertFxLockedSlots(family, params);
    if (locked.size === 0) continue;
    const defaults = insertFxDefaults(family, sel);
    const raw = (slot: number): number => insertFxSlotVal(params, family, slot, defaults[slot]);
    for (const [key, row] of Object.entries(insertRows(family))) {
      const shown = row.read(raw);
      const slots = shown === undefined ? null : row.take(shown);
      if (slots && Object.keys(slots).some((slot) => locked.has(Number(slot))))
        out.push(`ch.${simStripId(id)}.insFx.${key}`);
    }
  }
  return out;
}

/** The 1-knob EQ's kept band gain: the plan holds none, so it reads nothing and a write of it changes nothing. */
const EQ_ONE_KNOB_BASE: SimBinding = { read: () => undefined, write: () => UNCHANGED };

/** The simulator's name of a ducker key source, from the plan's node id. */
function keyLabel(nodeId: string): string | null {
  if (nodeId === "bus.stereo") return "ST";
  const mix = /^bus\.mix(\d+)$/.exec(nodeId);
  if (mix) return `MIX ${mix[1]}`;
  const mono = /^ch(\d+)$/.exec(nodeId);
  if (mono) return mono[1];
  const stereo = /^ch_(\d+)_(\d+)$/.exec(nodeId);
  return stereo ? `${stereo[1]}/${stereo[2]}` : null;
}

/** A ducker's key source: the one key wire into the ducker, drawn the way the board draws one. */
function duckerSource(model: DeviceModel, ducker: string): SimBinding {
  const to = ref(ducker, "in");
  const sources = model.rules
    .filter((r) => r.kind === "key" && r.to === to)
    .flatMap((r) => {
      const label = keyLabel(parseRef(r.from).nodeId);
      return label === null ? [] : [{ label, from: r.from }];
    });
  return {
    values: sources.map((s) => s.label),
    read: (plan) => {
      const from = incomingConnection(plan, to, "key")?.from;
      return sources.find((s) => s.from === from)?.label;
    },
    write: (plan, v) => {
      const source = sources.find((s) => s.label === v);
      if (!source) return refused("value");
      if (incomingConnection(plan, to, "key")?.from === source.from) return UNCHANGED;
      const reason = canConnect(model, plan, source.from, to).reason;
      return !reason || reason === "singleInput" ? { kind: "connect", from: source.from, to } : refused(reason);
    },
  };
}

/** The ducker paths of the stereo channel each ducker hangs under. */
function duckerBindings(model: DeviceModel, out: Map<string, SimBinding>): void {
  for (const node of model.nodes) {
    if (node.kind !== "ducker" || !node.attachTo) continue;
    const base = `ch.${simStripId(node.attachTo)}.ducker`;
    out.set(`${base}.on`, nodeValue(node.id, "duckerOn", false, "boolean"));
    out.set(`${base}.source`, duckerSource(model, node.id));
    for (const f of ["threshold", "range", "attack", "decay"])
      out.set(`${base}.${f}`, groupValue(node.id, "ducker", f, "number"));
  }
}

/** How one of the simulator's effect rows reads the plan's raw: the catalogue row it is, by label, and its reading. */
interface FxRow {
  label: string;
  show(raw: number): SimValue;
  values?: readonly SimValue[];
}

const revxHz = (raw: number): number => Number(revxFreqHz(raw).toFixed(4));
const tenths = (raw: number): number => raw / 10;
const whole = (raw: number): number => raw;
/** An FX2 / delay HPF's place on the simulator's scale: 0 is THRU, then one place a raw. */
const fx2HpfPlace = (raw: number): number => Math.max(0, raw - FX2_HPF_THRU_TOP);
/** An FX2 / delay LPF's place on the simulator's scale: one place a raw, the top one THRU. */
const fx2LpfPlace = (raw: number): number => Math.min(raw, FX2_LPF_THRU) - FX2_LPF_FIRST;

/**
 * The rows of each family the simulator names on the FX channels, by its key. A channel carries
 * the keys of every family its types come from; a row the selected family does not carry reads
 * nothing and takes no edit.
 */
const FX_ROWS: Record<FxFamily, Record<string, FxRow>> = {
  revx: {
    diffusion: { label: "diffusion", show: whole },
    hiRatio: { label: "hiRatio", show: tenths },
    lowRatio: { label: "lowRatio", show: tenths },
    lowFreq: { label: "lowFreq", show: revxHz },
    revTime: { label: "reverbTime", show: whole },
    initialDelay: { label: "initialDelay", show: (raw) => Number(initDelayMs(raw).toFixed(1)) },
    decay: { label: "decay", show: whole },
    roomSize: { label: "roomSize", show: whole },
    hpf: { label: "hpf", show: revxHz },
    lpf: { label: "lpf", show: revxHz },
  },
  revr3: {
    hpf: { label: "hpf", show: fx2HpfPlace },
    lpf: { label: "lpf", show: fx2LpfPlace },
    feedback: { label: "feedback", show: whole },
    hiRatio: { label: "hiRatio", show: tenths },
  },
  delay: {
    hpf: { label: "hpf", show: fx2HpfPlace },
    lpf: { label: "lpf", show: fx2LpfPlace },
    delay: { label: "delayTime", show: tenths },
    feedback: { label: "feedback", show: whole },
    hiRatio: { label: "hiRatio", show: tenths },
    sync: { label: "sync", show: (raw) => raw !== 0 },
    bpm: { label: "bpm", show: whole },
    note: { label: "note", show: (raw) => NOTE_VALUES[raw], values: NOTE_VALUES },
  },
};

/** The raws a catalogue row's own control admits. */
function descRange(d: FxParamDesc): [number, number] {
  if (d.control === "toggle") return [0, 1];
  if (d.control === "select") {
    const values = (d.options ?? []).map((o) => o.value);
    return [Math.min(...values), Math.max(...values)];
  }
  return [d.rawMin ?? d.def, d.rawMax ?? d.def];
}

/** One effect row of an FX channel, which names a different plan key under each type. */
function fxEffectValue(id: string, fxIndex: number, key: string, families: readonly FxFamily[]): SimBinding {
  const rowOf = (plan: Plan) => {
    const type = resolveFxEffectType(fxIndex, np(plan, id).fxEffect?.type);
    const row = FX_ROWS[fxFamilyOf(type)][key];
    const desc = row && fxParams(type).find((d) => d.label === row.label);
    if (!row || !desc) return null;
    const [min, max] = descRange(desc);
    return { type, desc, codec: stops(min, max, row.show, row.values) };
  };
  return {
    values: families.map((f) => FX_ROWS[f][key]?.values).find((v) => v !== undefined),
    read: (plan) => {
      const row = rowOf(plan);
      return row?.codec.show(np(plan, id).fxEffect?.params?.[row.desc.key] ?? row.desc.def);
    },
    write: (plan, v) => {
      const row = rowOf(plan);
      if (!row) return refused("type");
      const fx: FxEffectParams = np(plan, id).fxEffect ?? {};
      const raw = row.codec.take(v, fx.params?.[row.desc.key] ?? row.desc.def);
      if (typeof raw !== "number") return refused("value");
      const edit: SimEdit = {
        kind: "node",
        id,
        patch: { fxEffect: { ...fx, params: { ...fx.params, [row.desc.key]: raw } } },
        written: [`fxEffect.params.${row.desc.key}`],
      };
      // A value the unit drives — the delay time under tempo Sync — turned by hand, as the unit's
      // own panel turns it: the unit takes it and keeps Sync on, and the plan's writer leaves it out.
      if (fxRowOwners(row.type, fx.params).get(row.desc.key) !== "computed") return edit;
      const value = fxDescRawToSend(row.desc, raw);
      return {
        kind: "steps",
        steps: [edit, { kind: "deviceWrite", param: FX_EFFECT_ARRAY_PARAM[fxIndex]!, y: row.desc.slot, value }],
      };
    },
  };
}

/** The values the plan holds for FX channel `id`'s rows the unit drives under its current settings
 *  (the delay time under tempo Sync), as the writes that would put them on the unit. The plan's
 *  writer leaves these out. */
export function fxHeldWrites(plan: Plan, id: string): { param: number; y: number; value: number }[] {
  const fxIndex = FX_CHANNEL_NODE_INDEX[id];
  if (fxIndex === undefined) return [];
  const fx: FxEffectParams = np(plan, id).fxEffect ?? {};
  const type = resolveFxEffectType(fxIndex, fx.type);
  const owners = fxRowOwners(type, fx.params);
  return fxParams(type)
    .filter((d) => owners.get(d.key) === "computed")
    .map((d) => ({
      param: FX_EFFECT_ARRAY_PARAM[fxIndex]!,
      y: d.slot,
      value: fxDescRawToSend(d, fx.params?.[d.key] ?? d.def),
    }));
}

/** An FX channel's EFFECT TYPE and the rows of its effect. */
function fxEffectBindings(id: string, fxIndex: number, out: Map<string, SimBinding>): void {
  const base = `ch.${simStripId(id)}.effect`;
  const types = fxEffectTypes(fxIndex);
  const families = [...new Set(types.map((t) => fxFamilyOf(t.value)))];
  const keys = [...new Set(families.flatMap((f) => Object.keys(FX_ROWS[f])))];
  out.set(`${base}.type`, {
    ...enumValue(
      types.map((t) => t.label),
      (plan) => {
        const type = resolveFxEffectType(fxIndex, np(plan, id).fxEffect?.type);
        return types.findIndex((t) => t.value === type);
      },
      (_plan, i): SimEdit | SimRefusal => ({ kind: "fxType", id, type: types[i].value }),
    ),
    moves: keys.map((k) => `${base}.${k}`),
  });
  for (const key of keys) out.set(`${base}.${key}`, fxEffectValue(id, fxIndex, key, families));
}

/** A mono channel's COMP 1-knob switch. Switched on, it also takes the group's attack, release,
 *  Auto Makeup and level to the values the unit gives them (`compOneKnobPatch`), so those paths
 *  move with it. */
function compOneKnobOn(id: string, moves: readonly string[]): SimBinding {
  const read = groupValue(id, "comp", "oneKnob", "boolean").read;
  return {
    read,
    write: (plan, v) => {
      const on = bool(v);
      if (on === null) return refused("value");
      const held = np(plan, id).comp ?? {};
      const patch = compOneKnobPatch(held, on);
      return {
        kind: "node",
        id,
        patch: { comp: { ...held, ...patch } },
        written: Object.keys(patch).map((k) => `comp.${k}`),
      };
    },
    moves,
  };
}

/** Add the processor paths the plan of `model` answers to `out`. */
export function processorBindings(model: DeviceModel, out: Map<string, SimBinding>): void {
  for (const node of model.nodes) {
    const id = node.id;
    const ch = `ch.${simStripId(id)}`;

    if (isMonoChannel(id) || isStereoChannel(id) || isMasterBus(id)) {
      out.set(`${ch}.eq.lowMid.shape`, midShape(id));
      out.set(`${ch}.eq.highMid.shape`, midShape(id));
      out.set(`${ch}.eq.oneKnob.on`, groupValue(id, "eqOneKnob", "on", "boolean"));
      out.set(`${ch}.eq.oneKnob.type`, eqOneKnobType(id));
      out.set(`${ch}.eq.oneKnob.level`, groupValue(id, "eqOneKnob", "level", "number"));
      for (const band of ["low", "lowMid", "highMid", "high"])
        out.set(`${ch}.eq.oneKnob.base.${band}`, EQ_ONE_KNOB_BASE);
    }

    if (isMonoChannel(id)) {
      out.set(
        `${ch}.comp.oneKnob.on`,
        compOneKnobOn(id, [
          `${ch}.comp.oneKnob.level`,
          `${ch}.comp.attack`,
          `${ch}.comp.release`,
          `${ch}.comp.autoMakeup`,
        ]),
      );
      out.set(`${ch}.comp.oneKnob.level`, groupValue(id, "comp", "oneKnobLevel", "number"));
      out.set(`${ch}.compEqOrder`, optionValue(id, "compEqType", COMP_EQ_OPTIONS, COMP_EQ_OPTIONS[0].value));
      ssmcsBindings(id, ch, out);
    }

    const effect = insertFxEffect(model, id);
    if (effect) {
      const families = insertFamilies(model, id);
      const keys = [...new Set(families.flatMap((f) => Object.keys(insertRows(f))))];
      out.set(`${ch}.insFx.effect`, {
        ...effect,
        moves: [`${ch}.insFx.on`, ...keys.map((key) => `${ch}.insFx.${key}`)],
      });
      out.set(`${ch}.insFx.on`, insertFxOn(model, id));
      for (const key of keys) {
        const binding = insertFxParam(model, id, key, families);
        // The M.B.Comp 1-knob switch moves the Level and the values it holds fixed as well.
        const moves = key === "oneKnobOn" ? MBC_ONE_KNOB_MOVES.map((k) => `${ch}.insFx.${k}`) : undefined;
        out.set(`${ch}.insFx.${key}`, moves ? { ...binding, moves } : binding);
      }
    }

    if (id === "bus.mix1" || id === "bus.mix2")
      out.set(`${ch}.busType`, optionValue(id, "busType", BUS_TYPE_OPTIONS, BUS_TYPE_OPTIONS[0].value));

    const fxIndex = FX_CHANNEL_NODE_INDEX[id];
    if (fxIndex !== undefined) fxEffectBindings(id, fxIndex, out);
  }
  duckerBindings(model, out);
}
