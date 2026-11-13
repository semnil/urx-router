// Flex12GEQ (System firmware V1.5): the 31-band graphic EQ an output bus (STEREO, MIX 1, MIX 2)
// can run instead of its 4-band PEQ, with at most twelve bands away from 0 dB at once.
//
// This module is the plan's side of it — the values a bus carries and the edits the unit makes
// to them on its own, so an edit made here leaves the plan where the unit would be after the same
// operation on its panel:
//   - narrowing the GEQ Limit pulls every band of that side into the new range, and widening it
//     again does not restore them;
//   - turning the GEQ Link on copies the source side's bands and limit onto the other side, and
//     while it is on, a band or limit written on one side is written on the other too;
//   - once twelve bands of a side are away from 0 dB, a band at 0 dB cannot be moved (the unit
//     greys it out); the control link would take a thirteenth, so the app holds the rule itself;
//   - switching the EQ Type to Flex12GEQ turns the bus's EQ ON on, and on a MIX turns the GEQ Link
//     off;
//   - above 48 kHz the bus is put back to 4band PEQ and its bands to 0 dB, and returning to 48 kHz
//     leaves it there.
// The device layer's addresses for all of it are in control/params.ts.

import type { GeqParams, GeqSide, NodeParams, Plan } from "./plan";

/** EQ Type values, as the unit holds them. 1 is declared by the descriptor and never seen. */
export const EQ_TYPE_PEQ = 0;
export const EQ_TYPE_GEQ = 2;

/** The bands, 20 Hz to 20 kHz on the ISO 1/3-octave series, as the unit's GEQ screen labels them. */
export const GEQ_BAND_LABELS = [
  "20",
  "25",
  "31.5",
  "40",
  "50",
  "63",
  "80",
  "100",
  "125",
  "160",
  "200",
  "250",
  "315",
  "400",
  "500",
  "630",
  "800",
  "1k",
  "1.25k",
  "1.6k",
  "2k",
  "2.5k",
  "3.15k",
  "4k",
  "5k",
  "6.3k",
  "8k",
  "10k",
  "12.5k",
  "16k",
  "20k",
] as const;
export const GEQ_BAND_COUNT = GEQ_BAND_LABELS.length;

/** How many bands of one side may be away from 0 dB at once. */
export const GEQ_MAX_ACTIVE = 12;

/** One step of a band gain on the unit, in dB (a drag and a knob click alike, pushed or not). */
export const GEQ_STEP_DB = 0.5;

/** GEQ Limit values, as the unit holds them, and the range each one allows (dB). */
export const GEQ_LIMIT_15 = 0;
export const GEQ_LIMIT_RANGES: readonly (readonly [number, number])[] = [
  [-15, 15],
  [-12, 12],
  [-6, 6],
  [-24, 0],
];

/** GEQ Link values: off, the L side copied onto R, the R side copied onto L. */
export const GEQ_LINK_OFF = 0;
export const GEQ_LINK_L_TO_R = 1;
export const GEQ_LINK_R_TO_L = 2;

/** The menus each number takes. */
export const EQ_TYPE_OPTIONS = [
  { value: EQ_TYPE_PEQ, label: "4band PEQ" },
  { value: EQ_TYPE_GEQ, label: "Flex12GEQ" },
] as const;
export const GEQ_LIMIT_OPTIONS = [
  { value: 0, label: "±15 dB" },
  { value: 1, label: "±12 dB" },
  { value: 2, label: "±6 dB" },
  { value: 3, label: "-24 dB" },
] as const;
export const GEQ_LINK_OPTIONS = [
  { value: GEQ_LINK_OFF },
  { value: GEQ_LINK_L_TO_R },
  { value: GEQ_LINK_R_TO_L },
] as const;

/** The highest sample rate a bus can run Flex12GEQ at. */
export const GEQ_MAX_RATE = 48000;

/** The output buses that carry a Flex12GEQ, and the GEQ Link each ships with. */
export const GEQ_BUSES: Readonly<Record<string, { linkFactory: number }>> = {
  "bus.stereo": { linkFactory: GEQ_LINK_OFF },
  "bus.mix1": { linkFactory: GEQ_LINK_L_TO_R },
  "bus.mix2": { linkFactory: GEQ_LINK_L_TO_R },
};

export const hasGeq = (nodeId: string): boolean => nodeId in GEQ_BUSES;

/** Whether a rate leaves Flex12GEQ out of reach (the unit drops the EQ Type item above 48 kHz). */
export const geqUnavailable = (sampleRate: number): boolean => sampleRate > GEQ_MAX_RATE;

/** One side's values, filled with the unit's defaults where the plan names none. */
export interface GeqSideState {
  on: boolean;
  limit: number;
  gains: number[];
}

/** The factory GEQ of a bus: no link on STEREO, L → R on a MIX, both sides on, ±15 dB, every band 0. */
export function geqFactory(nodeId: string): GeqParams {
  const side = (): GeqSide => ({ on: true, limit: GEQ_LIMIT_15, bands: GEQ_BAND_LABELS.map(() => ({ gain: 0 })) });
  return { link: GEQ_BUSES[nodeId]?.linkFactory ?? GEQ_LINK_OFF, sides: [side(), side()] };
}

export function geqSideState(np: NodeParams | undefined, side: number): GeqSideState {
  const s = np?.geq?.sides?.[side];
  return {
    on: s?.on ?? true,
    limit: s?.limit ?? GEQ_LIMIT_15,
    gains: GEQ_BAND_LABELS.map((_, x) => s?.bands?.[x]?.gain ?? 0),
  };
}

export const geqLink = (np: NodeParams | undefined, nodeId: string): number =>
  np?.geq?.link ?? GEQ_BUSES[nodeId]?.linkFactory ?? GEQ_LINK_OFF;

export const eqTypeOf = (np: NodeParams | undefined): number => np?.eqType ?? EQ_TYPE_PEQ;

/** How many of these gains are away from 0 dB. */
export const activeBands = (gains: readonly number[]): number => gains.filter((g) => g !== 0).length;

/** Whether band `x` of a side can be moved: a band already away from 0 dB always can, a band at
 *  0 dB only while fewer than twelve are away from it. */
export function geqBandMovable(gains: readonly number[], x: number): boolean {
  return gains[x] !== 0 || activeBands(gains) < GEQ_MAX_ACTIVE;
}

/** A gain pulled into a limit's range and onto the unit's 0.5 dB steps. */
export function geqClamp(db: number, limit: number): number {
  const [lo, hi] = GEQ_LIMIT_RANGES[limit] ?? GEQ_LIMIT_RANGES[GEQ_LIMIT_15];
  const stepped = Math.round(db / GEQ_STEP_DB) * GEQ_STEP_DB;
  return Math.min(hi, Math.max(lo, stepped)) + 0; // + 0 turns -0 into 0
}

function withSides(np: NodeParams | undefined, nodeId: string, sides: GeqSideState[], link?: number): NodeParams {
  return {
    ...np,
    geq: {
      ...np?.geq,
      link: link ?? geqLink(np, nodeId),
      sides: sides.map((s) => ({ on: s.on, limit: s.limit, bands: s.gains.map((gain) => ({ gain })) })),
    },
  };
}

const bothSides = (np: NodeParams | undefined): GeqSideState[] => [geqSideState(np, 0), geqSideState(np, 1)];

/** The other side a write on `side` reaches while the link is on, or null. */
function mirrorOf(np: NodeParams | undefined, nodeId: string, side: number): number | null {
  return geqLink(np, nodeId) === GEQ_LINK_OFF ? null : 1 - side;
}

/**
 * Set one band. The gain is pulled into the side's limit and onto 0.5 dB steps; a band at 0 dB
 * that the twelve-band rule holds back is refused (null), as the unit's greyed-out band is. While
 * the link is on, the other side takes the same gain.
 */
export function setGeqGain(
  np: NodeParams | undefined,
  nodeId: string,
  side: number,
  x: number,
  db: number,
): NodeParams | null {
  const sides = bothSides(np);
  if (!geqBandMovable(sides[side].gains, x)) return null;
  const targets = [side, mirrorOf(np, nodeId, side)].filter((s): s is number => s !== null);
  for (const s of targets) {
    if (!geqBandMovable(sides[s].gains, x)) continue;
    sides[s].gains[x] = geqClamp(db, sides[s].limit);
  }
  return withSides(np, nodeId, sides);
}

/** Set one side's GEQ Limit, pulling its bands into the new range (the other side too while linked). */
export function setGeqLimit(np: NodeParams | undefined, nodeId: string, side: number, limit: number): NodeParams {
  const sides = bothSides(np);
  for (const s of [side, mirrorOf(np, nodeId, side)]) {
    if (s === null) continue;
    sides[s].limit = limit;
    sides[s].gains = sides[s].gains.map((g) => geqClamp(g, limit));
  }
  return withSides(np, nodeId, sides);
}

/** Set one side's [GEQ] button. The link does not carry it. */
export function setGeqOn(np: NodeParams | undefined, nodeId: string, side: number, on: boolean): NodeParams {
  const sides = bothSides(np);
  sides[side].on = on;
  return withSides(np, nodeId, sides);
}

/** Set the GEQ Link. Turning it on copies the source side's bands and limit onto the other side. */
export function setGeqLink(np: NodeParams | undefined, nodeId: string, link: number): NodeParams {
  const sides = bothSides(np);
  if (link !== GEQ_LINK_OFF) {
    const [from, to] = link === GEQ_LINK_L_TO_R ? [0, 1] : [1, 0];
    sides[to].limit = sides[from].limit;
    sides[to].gains = [...sides[from].gains];
  }
  return withSides(np, nodeId, sides, link);
}

/** Gain Flat: every band of one side back to 0 dB (the other side too while linked). */
export function flattenGeqSide(np: NodeParams | undefined, nodeId: string, side: number): NodeParams {
  const sides = bothSides(np);
  for (const s of [side, mirrorOf(np, nodeId, side)]) if (s !== null) sides[s].gains = sides[s].gains.map(() => 0);
  return withSides(np, nodeId, sides);
}

/**
 * Set the EQ Type. Switching to Flex12GEQ turns the bus's EQ ON on and, on a MIX, the GEQ Link off,
 * as the unit does when the type is switched on its panel or over the link.
 */
export function setEqType(np: NodeParams | undefined, nodeId: string, type: number): NodeParams {
  if (type !== EQ_TYPE_GEQ || eqTypeOf(np) === EQ_TYPE_GEQ) return { ...np, eqType: type };
  const next: NodeParams = { ...np, eqType: type, eqOn: true };
  return nodeId === "bus.stereo" ? next : { ...next, geq: { ...next.geq, link: GEQ_LINK_OFF } };
}

/** The buses a move to `rate` would take from Flex12GEQ back to 4band PEQ — what `geqOffAtRate`
 *  changes, asked without changing anything, for a question put before the move. */
export function geqAboveRate(plan: Plan, rate: number): string[] {
  if (!geqUnavailable(rate)) return [];
  return Object.keys(GEQ_BUSES).filter((nodeId) => eqTypeOf(plan.nodeParams[nodeId]) === EQ_TYPE_GEQ);
}

/**
 * What a rate above 48 kHz does to the plan's buses: each one on Flex12GEQ goes back to 4band PEQ
 * with every band at 0 dB, as the unit does, and stays there at a lower rate. Returns the buses it
 * changed.
 */
export function geqOffAtRate(plan: Plan, rate: number): string[] {
  const off = geqAboveRate(plan, rate);
  for (const nodeId of off) {
    const np = plan.nodeParams[nodeId];
    const sides = bothSides(np).map((s) => ({ ...s, gains: s.gains.map(() => 0) }));
    plan.nodeParams[nodeId] = { ...withSides(np, nodeId, sides), eqType: EQ_TYPE_PEQ };
  }
  return off;
}
