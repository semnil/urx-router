// Live level-meter model for the CONSOLE view. The Rust vd worker streams raw
// meter readings (deci-dBFS; 32767 = OVER) for the addresses we subscribe to; this
// maps each console node to its signal-chain tap points (each a broker meter
// address), decodes the raw value to dBFS, and holds the latest reading per address
// behind a small store the UI samples each animation frame. A node exposes several
// tap points (INPUT → PRE GATE → … → POST); the console lets each strip pick which
// one its meter shows. Tap → meter_id was confirmed on a real URX44V by a stage
// probe (see the private reference notes); models without a mapping show no meter.

import { vdMetersSubscribe, type MeterUpdate } from "./platform";

// Ladder span and sentinels, from the device level_meter table (unit dBFS).
export const METER_TOP_DB = 0; // ladder top (0 dBFS); OVER lights the clip cap above it
export const METER_FLOOR_DB = -60; // ladder bottom (table index 0)
export const METER_OVER_RAW = 32767; // broker OVER / clip sentinel
const METER_SILENCE_RAW = -1280; // resting value with no signal (below the table floor)

// Color-zone boundaries (dBFS), grounded in EBU R68-2000: green up to the alignment
// level (-18 dBFS), red from the permitted maximum level (-9 dBFS = alignment + 9 dB),
// yellow between. The OVER sentinel flags the true clip at 0 dBFS.
export const METER_GREEN_TOP_DB = -18;
export const METER_YELLOW_TOP_DB = -9;

/** A meter tap point on a node's signal chain. `key` is the stable id used by the
 *  selector; `label` is the device-vocabulary name (INPUT / PRE GATE / … / POST).
 *  `l` (and `r` for stereo) is the broker meter address [meterId, x]. The taps of a
 *  node are listed in signal-flow order (most upstream first). */
export interface MeterTap {
  key: string;
  label: string;
  l: readonly [number, number];
  r?: readonly [number, number];
}

/** A tap is stereo when it carries a second (R) meter address. Single source of the
 *  "meter this point as L/R" predicate — the console builds one bar column per channel. */
export const isStereoTap = (tap: MeterTap | null | undefined): boolean => tap?.r !== undefined;

// Mono input channel CH1-4 (x = channel index 0..3): the full processing chain.
// meter_id per tap confirmed on URX44V (reference/.local vd-meters.md stage probe).
const monoTaps = (i: number): MeterTap[] => [
  { key: "input", label: "INPUT", l: [100, i] },
  { key: "pregate", label: "PRE GATE", l: [106, i] },
  { key: "precomp", label: "PRE COMP", l: [108, i] },
  { key: "preeq", label: "PRE EQ", l: [111, i] },
  { key: "preinsfx", label: "PRE INS FX", l: [112, i] },
  { key: "prefader", label: "PRE FADER", l: [113, i] },
  { key: "post", label: "POST", l: [115, i] },
];
// Stereo input channel CH5-12 (pair p = 0..3, L = 2p / R = 2p+1): chain (block
// diagram) is INPUT → EQ → LEVEL → DUCKER (no HPF/GATE/COMP/INS FX). Metered at
// INPUT (101), PRE FADER (114, post-EQ), PRE DUCKER (116, post-fader) and
// POST (120, post-ducker). PRE EQ ≡ INPUT here.
const stereoTaps = (p: number): MeterTap[] => [
  { key: "input", label: "INPUT", l: [101, 2 * p], r: [101, 2 * p + 1] },
  { key: "prefader", label: "PRE FADER", l: [114, 2 * p], r: [114, 2 * p + 1] },
  { key: "preducker", label: "PRE DUCKER", l: [116, 2 * p], r: [116, 2 * p + 1] },
  { key: "post", label: "POST", l: [120, 2 * p], r: [120, 2 * p + 1] },
];
// Output bus chain (block diagram): sum → EQ → LEVEL → BAL → out INS FX → out
// (x = stereo pair: MIX1/STEREO = 0/1, MIX2 = 2/3). Four meters: PRE EQ (sum),
// PRE FADER (post-EQ), PRE INS FX (post-fader), POST (post-insert).
const busTaps = (sum: number, postEq: number, postFader: number, postInsfx: number, x: number): MeterTap[] => [
  { key: "preeq", label: "PRE EQ", l: [sum, x], r: [sum, x + 1] },
  { key: "prefader", label: "PRE FADER", l: [postEq, x], r: [postEq, x + 1] },
  { key: "preinsfx", label: "PRE INS FX", l: [postFader, x], r: [postFader, x + 1] },
  { key: "post", label: "POST", l: [postInsfx, x], r: [postInsfx, x + 1] },
];
// FX channel (effect → fader → STEREO): PRE FADER (131, mono effect out) and POST
// (118, stereo post-fader). FX1 = 131:0 / 118:0,1; FX2 = 131:1 / 118:2,3.
const fxTaps = (mono: number, l: number): MeterTap[] => [
  { key: "prefader", label: "PRE FADER", l: [131, mono] },
  { key: "post", label: "POST", l: [118, l], r: [118, l + 1] },
];
// Single-point node (monitor / oscillator): one output meter, no chain to choose.
const single = (l: readonly [number, number], r?: readonly [number, number]): MeterTap[] => [
  r ? { key: "post", label: "OUT", l, r } : { key: "post", label: "OUT", l },
];

// Node id → tap points (signal order). Confirmed on URX44V by stage probe + block
// diagram: mono CH1-4, stereo CH5-12 (101/114/116/120), STEREO master 104/121/123/125,
// MIX 105/122/124/126, FX channels 131/118, plus single-meter monitors / oscillator.
const NODE_TAPS: Record<string, MeterTap[]> = {
  ch1: monoTaps(0),
  ch2: monoTaps(1),
  ch3: monoTaps(2),
  ch4: monoTaps(3),
  ch_5_6: stereoTaps(0),
  ch_7_8: stereoTaps(1),
  ch_9_10: stereoTaps(2),
  ch_11_12: stereoTaps(3),
  "bus.stereo": busTaps(104, 121, 123, 125, 0),
  "bus.mix1": busTaps(105, 122, 124, 126, 0),
  "bus.mix2": busTaps(105, 122, 124, 126, 2),
  "bus.fx1": fxTaps(0, 0),
  "bus.fx2": fxTaps(1, 2),
  // STREAMING has no level fader; its pre/post-DELAY meters read the same level
  // (delay is lossless), so one output meter is enough — shown on a meter-only strip.
  "bus.stream": single([127, 0], [127, 1]),
  "bus.mon1": single([129, 0], [129, 1]),
  "bus.mon2": single([129, 2], [129, 3]),
  "bus.osc": single([135, 0]),
};

const addrKey = (meterId: number, x: number): string => `${meterId}:${x}`;

/** Decode a raw broker meter value to dBFS. OVER and the silence floor both
 *  resolve to a number; callers test `isOver` separately for the clip cap. */
export function decodeMeterDb(raw: number): number {
  if (raw === METER_OVER_RAW) return METER_TOP_DB;
  return raw / 10;
}

/** The tap points a node exposes (signal order), or [] when it has no meter. */
export function tapsFor(nodeId: string): MeterTap[] {
  return NODE_TAPS[nodeId] ?? [];
}

/** Whether a node has any live meter mapping (so the UI can show a meter lane). */
export function hasMeter(nodeId: string): boolean {
  return (NODE_TAPS[nodeId]?.length ?? 0) > 0;
}

/** Default tap = POST (the conventional post-fader / output meter) for every strip
 *  that has it; falls back to the most downstream point only if a node has no POST. */
export function defaultTapKey(nodeId: string): string {
  const taps = NODE_TAPS[nodeId];
  if (!taps || !taps.length) return "post";
  return taps.some((t) => t.key === "post") ? "post" : taps[taps.length - 1].key;
}

/** Resolve a node's tap by key, falling back to its default (most downstream). */
export function tapFor(nodeId: string, key: string): MeterTap | undefined {
  const taps = NODE_TAPS[nodeId];
  if (!taps || !taps.length) return undefined;
  return taps.find((t) => t.key === key) ?? taps[taps.length - 1];
}

/** A decoded live reading: L/R dBFS plus an over (clip) flag per side. */
export interface MeterReading {
  l: number;
  r: number;
  overL: boolean;
  overR: boolean;
  stereo: boolean;
}

/** Holds the latest raw reading per meter address and resolves per-tap readings. */
export class MeterStore {
  private raw = new Map<string, number>();

  apply(m: MeterUpdate): void {
    this.raw.set(addrKey(m.meterId, m.x), m.value);
  }

  clear(): void {
    this.raw.clear();
  }

  /** Decoded reading for an already-resolved tap (the hot path: callers resolve the
   *  tap once per render and pass it each frame, avoiding a lookup per frame). */
  readingTap(tap: MeterTap | null): MeterReading | null {
    if (!tap) return null;
    const lRaw = this.raw.get(addrKey(tap.l[0], tap.l[1])) ?? METER_SILENCE_RAW;
    const rRaw = tap.r ? this.raw.get(addrKey(tap.r[0], tap.r[1])) ?? METER_SILENCE_RAW : lRaw;
    return {
      l: decodeMeterDb(lRaw),
      r: decodeMeterDb(rRaw),
      overL: lRaw === METER_OVER_RAW,
      overR: rRaw === METER_OVER_RAW,
      stereo: tap.r !== undefined,
    };
  }

  /** Decoded reading for a node's tap by key (resolves the tap, then decodes). */
  reading(nodeId: string, tapKey: string): MeterReading | null {
    return this.readingTap(tapFor(nodeId, tapKey) ?? null);
  }
}

/** Distinct meter addresses ([meterId, x]) for the given taps. Used to scope the
 *  broker subscription to exactly the tap each on-screen strip currently shows. */
export function tapAddrs(taps: Iterable<MeterTap>): Array<[number, number]> {
  const seen = new Set<string>();
  const out: Array<[number, number]> = [];
  for (const t of taps) {
    for (const a of [t.l, t.r]) {
      if (!a) continue;
      const k = addrKey(a[0], a[1]);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push([a[0], a[1]]);
    }
  }
  return out;
}

/**
 * Subscribe to the given meter addresses, routing readings into `store`. Returns
 * an unsubscribe function. No-op (returns a noop) outside Tauri / when not
 * connected.
 */
export function subscribeMeters(store: MeterStore, addrs: Array<[number, number]>): () => void {
  return vdMetersSubscribe(addrs, (m) => store.apply(m));
}
