// Live level-meter model for the CONSOLE view. The Rust vd worker streams raw
// meter readings (deci-dBFS; 32767 = OVER) for the addresses we subscribe to; this
// maps each console node to its broker meter address(es), decodes the raw value to
// dBFS, and holds the latest reading per node behind a small store the UI samples
// each animation frame. Meter ids were confirmed on a real URX44V (see the private
// reference notes); models without a mapping simply show no live meter.

import { vdMetersSubscribe, type MeterUpdate } from "./platform";

// Ladder span and sentinels, from the device level_meter table (unit dBFS).
export const METER_TOP_DB = 0; // ladder top (0 dBFS); OVER lights the clip cap above it
export const METER_FLOOR_DB = -60; // ladder bottom (table index 0)
export const METER_OVER_RAW = 32767; // broker OVER / clip sentinel
const METER_SILENCE_RAW = -1280; // resting value with no signal (below the table floor)

/** A node's meter address(es): L (and R for stereo). Mono buses omit `r`. */
interface MeterAddr {
  l: readonly [number, number];
  r?: readonly [number, number];
}

// Node id → meter address (meterId, x). x = 0/1 → L/R; stereo buses pack two
// stereo pairs into one meter id (e.g. MIX1 = 124:0/1, MIX2 = 124:2/3). Confirmed
// on URX44V: inputs 100 (mono CH1-4) / 101 (stereo CH5-12), STEREO 104, MIX 124,
// FX 131, STREAMING 127, MONITOR 129, OSC 135.
const NODE_METERS: Record<string, MeterAddr> = {
  ch1: { l: [100, 0] },
  ch2: { l: [100, 1] },
  ch3: { l: [100, 2] },
  ch4: { l: [100, 3] },
  ch_5_6: { l: [101, 0], r: [101, 1] },
  ch_7_8: { l: [101, 2], r: [101, 3] },
  ch_9_10: { l: [101, 4], r: [101, 5] },
  ch_11_12: { l: [101, 6], r: [101, 7] },
  "bus.stereo": { l: [104, 0], r: [104, 1] },
  "bus.mix1": { l: [124, 0], r: [124, 1] },
  "bus.mix2": { l: [124, 2], r: [124, 3] },
  "bus.fx1": { l: [131, 0] },
  "bus.fx2": { l: [131, 1] },
  "bus.stream": { l: [127, 0], r: [127, 1] },
  "bus.mon1": { l: [129, 0], r: [129, 1] },
  "bus.mon2": { l: [129, 2], r: [129, 3] },
  "bus.osc": { l: [135, 0] },
};

const addrKey = (meterId: number, x: number): string => `${meterId}:${x}`;

/** Decode a raw broker meter value to dBFS. OVER and the silence floor both
 *  resolve to a number; callers test `isOver` separately for the clip cap. */
export function decodeMeterDb(raw: number): number {
  if (raw === METER_OVER_RAW) return METER_TOP_DB;
  return raw / 10;
}

/** Whether a node has a live meter mapping (so the UI can show a meter lane). */
export function hasMeter(nodeId: string): boolean {
  return nodeId in NODE_METERS;
}

/** A node's decoded live reading: L/R dBFS plus an over (clip) flag per side. */
export interface MeterReading {
  l: number;
  r: number;
  overL: boolean;
  overR: boolean;
  stereo: boolean;
}

/** Holds the latest raw reading per meter address and resolves per-node readings. */
export class MeterStore {
  private raw = new Map<string, number>();

  apply(m: MeterUpdate): void {
    this.raw.set(addrKey(m.meterId, m.x), m.value);
  }

  clear(): void {
    this.raw.clear();
  }

  /** Decoded reading for a node, or null when the node has no meter mapping. */
  reading(nodeId: string): MeterReading | null {
    const addr = NODE_METERS[nodeId];
    if (!addr) return null;
    const lRaw = this.raw.get(addrKey(addr.l[0], addr.l[1])) ?? METER_SILENCE_RAW;
    const rRaw = addr.r ? this.raw.get(addrKey(addr.r[0], addr.r[1])) ?? METER_SILENCE_RAW : lRaw;
    return {
      l: decodeMeterDb(lRaw),
      r: decodeMeterDb(rRaw),
      overL: lRaw === METER_OVER_RAW,
      overR: rRaw === METER_OVER_RAW,
      stereo: addr.r !== undefined,
    };
  }
}

/** Distinct meter addresses ([meterId, x]) for the given nodes. Nodes without a
 *  mapping (other models, non-metered buses) are skipped, so subscriptions stay
 *  scoped to the strips actually on screen for the current model. */
export function metersForNodes(nodeIds: Iterable<string>): Array<[number, number]> {
  const seen = new Set<string>();
  const out: Array<[number, number]> = [];
  for (const id of nodeIds) {
    const addr = NODE_METERS[id];
    if (!addr) continue;
    for (const a of [addr.l, addr.r]) {
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
