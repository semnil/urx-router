// The Flex12GEQ screen of an output bus (STEREO, MIX 1, MIX 2): thirty-one vertical faders,
// one side at a time, with the side's [GEQ] button, the GEQ Link, the side's GEQ Limit, the
// count of bands still free and Gain Flat beside them.
//
// What the faders allow is what the unit's GEQ screen allows: a band moves on 0.5 dB steps
// inside the side's limit, and once twelve bands are away from 0 dB the rest are shut until one
// returns. Three things shut a fader, and each says which:
//   - the twelve-band rule;
//   - STEREO's bands above 20 Hz while Live sync is up: the link refuses a write to them, so
//     they show the unit's value and move on the unit only (known-issues.md);
//   - a rate above 48 kHz, where the unit offers no Flex12GEQ at all.
// The edits themselves — the limit's clamp, the link's copy, the twelve-band refusal — are
// core/geq.ts, so this screen, the inspector and MIDI make the same move.

import {
  activeBands,
  flattenGeqSide,
  GEQ_BAND_LABELS,
  GEQ_LIMIT_OPTIONS,
  GEQ_LIMIT_RANGES,
  GEQ_LINK_L_TO_R,
  GEQ_LINK_OFF,
  GEQ_LINK_R_TO_L,
  GEQ_MAX_ACTIVE,
  GEQ_STEP_DB,
  eqTypeOf,
  EQ_TYPE_GEQ,
  geqBandMovable,
  geqLink,
  geqSideState,
  geqUnavailable,
  hasGeq,
  setGeqGain,
  setGeqLimit,
  setGeqLink,
  setGeqOn,
} from "../core/geq";
import { geqBandWritable } from "../core/control/translate";
import { controlId, geqBandScope, GEQ_SIDE_SCOPES } from "../core/midi/controls";
import type { DynField, GeqFieldKey } from "../core/control/translate";
import type { NodeParams } from "../core/plan";
import { el, onOff, settingsRow, settingsSection } from "./dom";
import type { SettingsRowOptions } from "./dom";
import { enumRow, levelLane, pairTap } from "./dyn-chan";
import { flagOffNote } from "./dyn-screen";
import type { DynCtx, DynProcessor } from "./dyn-screen";

/** Level-lane ruler, as the 4-band EQ's: the stages either side are programme level. */
const LO_DB = -60;
const TICK_STEP = 6;

const bandKey = (x: number): GeqFieldKey => `band${x}`;
const bandOf = (key: string): number | null => {
  const m = /^band(\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
};

/** What the unit calls a bus's two sides on its GEQ screen. */
function sideNames(nodeId: string): [string, string] {
  if (nodeId === "bus.stereo") return ["ST L", "ST R"];
  const n = nodeId === "bus.mix2" ? 2 : 1;
  return [`MIX ${n} L`, `MIX ${n} R`];
}

/** The GEQ Link menu as the unit's dialog words it for this bus. */
function linkOptions(nodeId: string, off: string): { value: number; label: string }[] {
  const [l, r] =
    nodeId === "bus.stereo" ? ["ST L", "ST R"] : nodeId === "bus.mix2" ? ["Mix2L", "Mix2R"] : ["Mix1L", "Mix1R"];
  return [
    { value: GEQ_LINK_OFF, label: off },
    { value: GEQ_LINK_L_TO_R, label: `${l} → ${r}` },
    { value: GEQ_LINK_R_TO_L, label: `${r} → ${l}` },
  ];
}

const np = (ctx: DynCtx): NodeParams | undefined => ctx.plan.nodeParams[ctx.nodeId];

/** One band as a field, on the side's limit: the fader's travel is the range the unit allows. */
function bandField(x: number, limit: number): DynField {
  const [min, max] = GEQ_LIMIT_RANGES[limit] ?? GEQ_LIMIT_RANGES[0];
  return { key: bandKey(x), min, max, step: GEQ_STEP_DB, def: 0, unit: "db" };
}

/** The plan paths an edit of `patch` on side `side` asserts — the side's, and the other side's
 *  too where the link carries the edit across. */
function writtenPaths(ctx: DynCtx, patch: Record<string, number | boolean>): string[] {
  const side = ctx.sel;
  const linked = geqLink(np(ctx), ctx.nodeId) !== GEQ_LINK_OFF;
  const sides = (carried: boolean): number[] => (carried && linked ? [side, 1 - side] : [side]);
  const out: string[] = [];
  for (const k of Object.keys(patch)) {
    const x = bandOf(k);
    if (x !== null) for (const s of sides(true)) out.push(`geq.sides.${s}.bands.${x}.gain`);
    else if (k === "on") out.push(`geq.sides.${side}.on`);
    else if (k === "limit")
      for (const s of sides(true))
        out.push(`geq.sides.${s}.limit`, ...GEQ_BAND_LABELS.map((_, b) => `geq.sides.${s}.bands.${b}.gain`));
    else if (k === "link")
      out.push(
        "geq.link",
        ...[0, 1].flatMap((s) => [
          `geq.sides.${s}.limit`,
          ...GEQ_BAND_LABELS.map((_, b) => `geq.sides.${s}.bands.${b}.gain`),
        ]),
      );
    else if (k === "flat")
      for (const s of sides(true)) out.push(...GEQ_BAND_LABELS.map((_, b) => `geq.sides.${s}.bands.${b}.gain`));
  }
  return out;
}

export const GEQ_DYN: DynProcessor = {
  key: "geq",
  loDb: LO_DB,
  tickStep: TICK_STEP,
  title: (m) => m.dynTuning.geq.title,

  bind: (ctx) => {
    if (!hasGeq(ctx.nodeId)) return null;
    const limit = geqSideState(np(ctx), ctx.sel).limit;
    return {
      fields: GEQ_BAND_LABELS.map((_, x) => bandField(x, limit)),
      lanes: [
        levelLane("in", pairTap(ctx, "preeq"), ctx.m.dynTuning.laneIn),
        levelLane("out", pairTap(ctx, "prefader"), ctx.m.dynTuning.laneOut),
      ],
      faderRack: true,
    };
  },

  // The side is the cursor the faders edit: the unit's screen shows one side at a time too.
  bar: (ctx) => {
    const [l, r] = sideNames(ctx.nodeId);
    return {
      label: ctx.m.dynTuning.geq.side,
      items: [
        { label: l, id: "geq-l", sel: 0 },
        { label: r, id: "geq-r", sel: 1 },
      ],
    };
  },

  offNote: (ctx) => {
    const off = flagOffNote(ctx, "eqOn");
    if (off) return off;
    if (eqTypeOf(np(ctx)) !== EQ_TYPE_GEQ) return ctx.m.dynTuning.geq.notSelected;
    return geqSideState(np(ctx), ctx.sel).on ? null : ctx.m.dynTuning.geq.sideOff;
  },
  hint: (ctx) => ctx.m.dynTuning.geq.hint,

  read: (ctx) => {
    const s = geqSideState(np(ctx), ctx.sel);
    const out: Record<string, unknown> = { on: s.on, limit: s.limit, link: geqLink(np(ctx), ctx.nodeId) };
    s.gains.forEach((g, x) => (out[bandKey(x)] = g));
    return out;
  },

  // Each key goes through core/geq.ts, which makes the unit's own moves with it (the clamp, the
  // link's copy, the twelve-band refusal). A band the rule refuses leaves the plan as it was.
  patch: (ctx, patch) => {
    let cur: NodeParams = { ...np(ctx) };
    const side = ctx.sel;
    for (const [k, v] of Object.entries(patch)) {
      const x = bandOf(k);
      if (x !== null) cur = setGeqGain(cur, ctx.nodeId, side, x, Number(v)) ?? cur;
      else if (k === "on") cur = setGeqOn(cur, ctx.nodeId, side, v === true);
      else if (k === "limit") cur = setGeqLimit(cur, ctx.nodeId, side, Number(v));
      else if (k === "link") cur = setGeqLink(cur, ctx.nodeId, Number(v));
      else if (k === "flat") cur = flattenGeqSide(cur, ctx.nodeId, side);
    }
    return { geq: cur.geq };
  },
  written: writtenPaths,

  rowStates: (ctx, vals) => {
    const out = new Map<string, SettingsRowOptions>();
    const m = ctx.m;
    // Every lock here keeps the row a MIDI-learn target: each is a state the value is in now, and
    // a mapping outlives it.
    if (geqUnavailable(ctx.plan.sampleRate)) {
      const locked = { tag: m.inspector.geqRateLocked, locked: true, assignable: true };
      for (const k of [...GEQ_BAND_LABELS.map((_, x) => bandKey(x)), "on", "limit", "link", "flat"]) out.set(k, locked);
      return out;
    }
    const gains = GEQ_BAND_LABELS.map((_, x) =>
      typeof vals[bandKey(x)] === "number" ? (vals[bandKey(x)] as number) : 0,
    );
    GEQ_BAND_LABELS.forEach((_, x) => {
      if (ctx.liveSync && !geqBandWritable(ctx.nodeId, x))
        out.set(bandKey(x), { tag: m.dynTuning.geq.unwritable, locked: true, assignable: true });
      else if (!geqBandMovable(gains, x))
        out.set(bandKey(x), { tag: m.dynTuning.geq.full, locked: true, assignable: true });
    });
    return out.size ? out : null;
  },

  // A band's gain and the side's [GEQ] are what MIDI reaches; the Link, the Limit and Gain Flat
  // are not offered.
  controlId: (ctx, key) => {
    const x = bandOf(key);
    if (x !== null) return controlId(ctx.nodeId, "gain", geqBandScope(ctx.sel, x));
    return key === "on" ? controlId(ctx.nodeId, "geqOn", GEQ_SIDE_SCOPES[ctx.sel]) : null;
  },

  fieldLabel: (f) => {
    const x = bandOf(f.key);
    return x === null ? undefined : GEQ_BAND_LABELS[x];
  },
  // A rack of thirty-one has no room for a unit on every cell; the screen's own heading says dB. A
  // boost carries no sign, as on the unit's own GEQ screen: only a cut is marked.
  fieldText: (_f, v) => v.toFixed(1),

  sections: ({ m, vals, states, set, nodeId, midi }) => {
    const g = m.dynTuning.geq;
    const sec = settingsSection(g.section);
    const gains = GEQ_BAND_LABELS.map((_, x) =>
      typeof vals[bandKey(x)] === "number" ? (vals[bandKey(x)] as number) : 0,
    );
    const locked = (key: string): SettingsRowOptions => states.get(key) ?? {};
    sec.append(
      midi(
        settingsRow(
          g.button,
          onOff(vals.on === true, (v) => set({ on: v })),
          locked("on"),
        ),
        "on",
      ),
    );
    sec.append(
      enumRow(
        g.link,
        linkOptions(nodeId, g.linkOff),
        Number(vals.link ?? GEQ_LINK_OFF),
        (v) => set({ link: v }),
        locked("link"),
      ),
    );
    sec.append(
      enumRow(
        g.limit,
        GEQ_LIMIT_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
        Number(vals.limit ?? 0),
        (v) => set({ limit: v }),
        locked("limit"),
      ),
    );
    const avail = el("span", "param-val gt-val");
    avail.textContent = String(Math.max(0, GEQ_MAX_ACTIVE - activeBands(gains)));
    sec.append(settingsRow(g.available, avail));
    const flat = document.createElement("button");
    flat.className = "prefs-btn";
    flat.type = "button";
    flat.textContent = g.gainFlat;
    if (locked("flat").locked) flat.disabled = true;
    flat.addEventListener("click", () => set({ flat: true }));
    sec.append(settingsRow("", flat));
    return [sec];
  },

  display: (parts) => parts.faders(),
};
