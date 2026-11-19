// The SIM table's part for an output bus's EQ Type and Flex12GEQ (System firmware V1.5): the
// bus's EQ Type, the GEQ Link, and each side's [GEQ], GEQ Limit and 31 bands, read from the plan
// and written through the same helpers the GEQ tuning screen uses (core/geq.ts), so the link's
// mirror, the limit's clamp and the twelve-band rule apply to an edit on the LCD as to one there.

import type { DeviceModel } from "../models/types";
import {
  EQ_TYPE_OPTIONS,
  GEQ_BAND_COUNT,
  GEQ_LINK_OPTIONS,
  GEQ_LIMIT_OPTIONS,
  eqTypeOf,
  geqLink,
  geqSideState,
  geqUnavailable,
  hasGeq,
  setEqType,
  setGeqGain,
  setGeqLimit,
  setGeqLink,
  setGeqOn,
  EQ_TYPE_GEQ,
} from "./geq";
import type { NodeParams, Plan } from "./plan";
import {
  bool,
  np,
  num,
  refused,
  simStripId,
  type SimBinding,
  type SimEdit,
  type SimRefusal,
  type SimValue,
} from "./sim-map-base";

/** The simulator's spelling of each, in the order of the plan's numbers. */
const EQ_TYPES = ["4band PEQ", "Flex12GEQ"] as const;
const GEQ_LIMITS = ["±15dB", "±12dB", "±6dB", "-24dB"] as const;
const GEQ_LINKS = ["Off", "L>R", "R>L"] as const;
const SIDES = ["l", "r"] as const;

/** An edit of the bus's params, as the patch the GEQ tuning screen's helpers return. */
function geqEdit(id: string, next: NodeParams | null): SimEdit | SimRefusal {
  if (next === null) return refused("value");
  const patch: NodeParams = {};
  if (next.eqType !== undefined) patch.eqType = next.eqType;
  if (next.eqOn !== undefined) patch.eqOn = next.eqOn;
  if (next.geq !== undefined) patch.geq = next.geq;
  return { kind: "node", id, patch };
}

/** The plan's number of a simulator label, or -1. */
function numberOf(labels: readonly string[], values: readonly { value: number }[], v: SimValue): number {
  const i = typeof v === "string" ? labels.indexOf(v) : -1;
  return i < 0 ? -1 : (values[i]?.value ?? -1);
}

export function geqBindings(model: DeviceModel, out: Map<string, SimBinding>): void {
  for (const node of model.nodes) {
    const id = node.id;
    if (!hasGeq(id)) continue;
    const base = `ch.${simStripId(id)}`;
    const bands = (side: string): string[] =>
      Array.from({ length: GEQ_BAND_COUNT }, (_, x) => `${base}.geq.${side}.band.${x}`);
    const other = (side: string): string => (side === "l" ? "r" : "l");

    out.set(`${base}.eqType`, {
      values: EQ_TYPES,
      // Switching to Flex12GEQ turns EQ ON on and, on a MIX, the GEQ Link off.
      moves: [`${base}.eq.on`, `${base}.geq.link`],
      read: (plan) => EQ_TYPES[EQ_TYPE_OPTIONS.findIndex((o) => o.value === eqTypeOf(np(plan, id)))],
      write: (plan, v) => {
        const type = numberOf(EQ_TYPES, EQ_TYPE_OPTIONS, v);
        if (type < 0) return refused("value");
        // The unit takes Flex12GEQ only up to 48 kHz, as the toolbar's rate picker and the GEQ screen hold it.
        if (type === EQ_TYPE_GEQ && geqUnavailable(plan.sampleRate)) return refused("rate");
        return geqEdit(id, setEqType(plan.nodeParams[id], id, type));
      },
    });

    out.set(`${base}.geq.link`, {
      values: GEQ_LINKS,
      // Turning the link on copies one side's limit and bands onto the other.
      moves: SIDES.flatMap((side) => [`${base}.geq.${side}.limit`, ...bands(side)]),
      read: (plan) => GEQ_LINKS[geqLink(np(plan, id), id)],
      write: (plan, v) => {
        const link = numberOf(GEQ_LINKS, GEQ_LINK_OPTIONS, v);
        return link < 0 ? refused("value") : geqEdit(id, setGeqLink(plan.nodeParams[id], id, link));
      },
    });

    SIDES.forEach((side, s) => {
      const at = `${base}.geq.${side}`;
      const state = (plan: Plan) => geqSideState(np(plan, id), s);
      out.set(`${at}.on`, {
        read: (plan) => state(plan).on,
        write: (plan, v) => {
          const on = bool(v);
          return on === null ? refused("value") : geqEdit(id, setGeqOn(plan.nodeParams[id], id, s, on));
        },
      });
      out.set(`${at}.limit`, {
        values: GEQ_LIMITS,
        // A limit pulls the side's bands into its range, and the link carries it to the other side.
        moves: [`${base}.geq.${other(side)}.limit`, ...bands(side), ...bands(other(side))],
        read: (plan) => GEQ_LIMITS[state(plan).limit],
        write: (plan, v) => {
          const limit = numberOf(GEQ_LIMITS, GEQ_LIMIT_OPTIONS, v);
          return limit < 0 ? refused("value") : geqEdit(id, setGeqLimit(plan.nodeParams[id], id, s, limit));
        },
      });
      for (let x = 0; x < GEQ_BAND_COUNT; x++) {
        out.set(`${at}.band.${x}`, {
          // The link carries a band to the other side.
          moves: [`${base}.geq.${other(side)}.band.${x}`],
          read: (plan) => state(plan).gains[x],
          write: (plan, v) => {
            const db = num(v);
            return db === null ? refused("value") : geqEdit(id, setGeqGain(plan.nodeParams[id], id, s, x, db));
          },
        });
      }
    });
  }
}
