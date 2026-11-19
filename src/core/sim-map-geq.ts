// The SIM table's part for an output bus's EQ Type and Flex12GEQ (System firmware V1.5): the
// bus's EQ Type, the GEQ Link, and each side's [GEQ], GEQ Limit and 31 bands, read from the plan
// and written through the same helpers the GEQ tuning screen uses (core/geq.ts), so the link's
// mirror, the limit's clamp and the twelve-band rule apply to an edit on the LCD as to one there.
// The GEQ's paths form one group (`SimGroup`): a press that writes many of them at once — a
// Paste, a Compare, Gain Flat, Default — is one edit, decided on the state it leaves.

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
  setGeqGains,
  setGeqLimit,
  setGeqLink,
  setGeqOn,
  EQ_TYPE_GEQ,
} from "./geq";
import { geqBandWritable } from "./control/translate";
import type { NodeParams, Plan } from "./plan";
import {
  bool,
  np,
  num,
  refused,
  simStripId,
  type SimBinding,
  type SimEdit,
  type SimGroup,
  type SimValue,
} from "./sim-map-base";

/** The simulator's spelling of each, in the order of the plan's numbers. */
const EQ_TYPES = ["4band PEQ", "Flex12GEQ"] as const;
const GEQ_LIMITS = ["±15dB", "±12dB", "±6dB", "-24dB"] as const;
const GEQ_LINKS = ["Off", "L>R", "R>L"] as const;
const SIDES = ["l", "r"] as const;

/** The EQ Type's edit, as the patch `setEqType` makes: the type, and the EQ ON and GEQ Link it
 *  switches with it where it does. */
function eqTypeEdit(id: string, next: NodeParams): SimEdit {
  const patch: NodeParams = { eqType: next.eqType };
  if (next.eqOn !== undefined) patch.eqOn = next.eqOn;
  if (next.geq !== undefined) patch.geq = next.geq;
  return { kind: "node", id, patch };
}

/** The plan's number of a simulator label, or -1. */
function numberOf(labels: readonly string[], values: readonly { value: number }[], v: SimValue): number {
  const i = typeof v === "string" ? labels.indexOf(v) : -1;
  return i < 0 ? -1 : (values[i]?.value ?? -1);
}

/** A GEQ path past `<base>.geq.`: the Link, or one side's [GEQ], Limit or band. */
const GEQ_PATH = /^(?:(link)|([lr])\.(on|limit|band\.(\d+)))$/;

/**
 * The writes of one press to a bus's GEQ, as one edit: the Link first, since it decides what the
 * others carry to the other side, then each side's [GEQ] and Limit in the order they came, then
 * the bands over all of that (`setGeqGains`). During Live sync STEREO's bands above 20 Hz take no
 * write over the link (`geqBandWritable`), so a press that would move one is refused whole; one the
 * Link or a Limit moves is the unit's own move, and stays.
 */
function geqGroup(id: string, base: string): SimGroup {
  const head = `${base}.geq.`;
  return {
    key: head,
    write: (plan, values, live) => {
      const writes: { link: boolean; side: number; what: string; x: number; v: SimValue }[] = [];
      for (const [path, v] of values) {
        const m = GEQ_PATH.exec(path.slice(head.length));
        if (!path.startsWith(head) || !m) return refused("value");
        writes.push({ link: m[1] !== undefined, side: m[2] === "r" ? 1 : 0, what: m[3] ?? "link", x: Number(m[4]), v });
      }
      let cur: NodeParams = { ...plan.nodeParams[id] };
      for (const w of writes.filter((w) => w.link)) {
        const link = numberOf(GEQ_LINKS, GEQ_LINK_OPTIONS, w.v);
        if (link < 0) return refused("value");
        cur = setGeqLink(cur, id, link);
      }
      const gains: [number, number, number][] = [];
      for (const w of writes.filter((w) => !w.link)) {
        if (w.what === "on") {
          const on = bool(w.v);
          if (on === null) return refused("value");
          cur = setGeqOn(cur, id, w.side, on);
        } else if (w.what === "limit") {
          const limit = numberOf(GEQ_LIMITS, GEQ_LIMIT_OPTIONS, w.v);
          if (limit < 0) return refused("value");
          cur = setGeqLimit(cur, id, w.side, limit);
        } else {
          const db = num(w.v);
          if (db === null) return refused("value");
          gains.push([w.side, w.x, db]);
        }
      }
      const next = gains.length ? setGeqGains(cur, id, gains) : cur;
      if (next === null) return refused("full");
      if (live)
        for (const s of [0, 1]) {
          const was = geqSideState(cur, s).gains;
          if (geqSideState(next, s).gains.some((g, x) => g !== was[x] && !geqBandWritable(id, x)))
            return refused("unwritable");
        }
      return { kind: "node", id, patch: { geq: next.geq } };
    },
  };
}

export function geqBindings(model: DeviceModel, out: Map<string, SimBinding>): void {
  for (const node of model.nodes) {
    const id = node.id;
    if (!hasGeq(id)) continue;
    const base = `ch.${simStripId(id)}`;
    const bands = (side: string): string[] =>
      Array.from({ length: GEQ_BAND_COUNT }, (_, x) => `${base}.geq.${side}.band.${x}`);
    const other = (side: string): string => (side === "l" ? "r" : "l");
    const group = geqGroup(id, base);
    /** A GEQ path, written through the group; `write` alone is the press of that one path outside
     *  a session. */
    const grouped = (path: string, rest: Omit<SimBinding, "write" | "together">): SimBinding => ({
      ...rest,
      together: group,
      write: (plan, v) => group.write(plan, new Map([[path, v]]), false),
    });

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
        return eqTypeEdit(id, setEqType(plan.nodeParams[id], id, type));
      },
    });

    out.set(
      `${base}.geq.link`,
      grouped(`${base}.geq.link`, {
        values: GEQ_LINKS,
        // Turning the link on copies one side's limit and bands onto the other.
        moves: SIDES.flatMap((side) => [`${base}.geq.${side}.limit`, ...bands(side)]),
        read: (plan) => GEQ_LINKS[geqLink(np(plan, id), id)],
      }),
    );

    SIDES.forEach((side, s) => {
      const at = `${base}.geq.${side}`;
      const state = (plan: Plan) => geqSideState(np(plan, id), s);
      out.set(`${at}.on`, grouped(`${at}.on`, { read: (plan) => state(plan).on }));
      out.set(
        `${at}.limit`,
        grouped(`${at}.limit`, {
          values: GEQ_LIMITS,
          // A limit pulls the side's bands into its range, and the link carries it to the other side.
          moves: [`${base}.geq.${other(side)}.limit`, ...bands(side), ...bands(other(side))],
          read: (plan) => GEQ_LIMITS[state(plan).limit],
        }),
      );
      for (let x = 0; x < GEQ_BAND_COUNT; x++)
        out.set(
          `${at}.band.${x}`,
          grouped(`${at}.band.${x}`, {
            // The link carries a band to the other side.
            moves: [`${base}.geq.${other(side)}.band.${x}`],
            read: (plan) => state(plan).gains[x],
          }),
        );
    });
  }
}
