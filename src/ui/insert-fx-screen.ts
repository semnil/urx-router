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

import { insertFxFamilyOf, insertFxParams } from "../core/control/insert-fx-effect";
import type { InsertFxFamily, InsertFxParamDesc } from "../core/control/insert-fx-effect";
import { insertFxControl } from "../core/control/translate";
import type { DynField, InsertFxFieldKey } from "../core/control/translate";
import { grAddr, insertFxOutGrAddr, tapFor } from "../core/meters";
import type { NodeParams, Plan } from "../core/plan";
import { onOff, settingsRow } from "./dom";
import { enumRow } from "./dyn-chan";
import type { DynBinding, DynCtx, DynLane, DynProcessor } from "./dyn-screen";
import { insertFxVal, reKeyInsertFxParams } from "./insert-fx-model";
import type { Messages } from "../i18n/en";

/** Lane ruler floor. The taps either side of an insert effect are ordinary channel
 *  meters, so this is a reading range and not a parameter domain — no value on this
 *  screen rides the ruler, and nothing here carries a fader cap. */
const LO_DB = -48;
const TICK_STEP = 6;

/** A field's key is its engine slot: an insert-FX value has no plan sub-object named
 *  after it to borrow a name from. */
const slotKey = (slot: number): InsertFxFieldKey => `ifx${slot}`;
const slotOf = (key: string): number => Number(key.slice(3));

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
 * Two families answer null. The multi-band compressor's values are not in the flat
 * catalogue at all. Pitch Fix's are, but only in part: its Key, its Scale and its twelve-
 * note mask are edited through rules of their own (a note edit sets Custom; only two
 * presets have a pattern this app can author), and a screen built from the flat rows alone
 * would be an editor missing the half that decides what the effect corrects to.
 */
export function insertFxScreenFamily(plan: Plan, nodeId: string): InsertFxFamily | null {
  const v = plan.nodeParams[nodeId]?.insertFx;
  const fam = v === undefined ? null : insertFxFamilyOf(v);
  return fam && fam !== "pitch" && rowsOf(fam).length ? fam : null;
}

/**
 * The catalogue rows this screen shows, in display order.
 *
 * Empty for the multi-band compressor, whose bands and globals are a structured layout
 * rather than a list. An empty answer is what makes `bind` refuse, and refusing is what
 * keeps the Inspector's own editor in front of a family this screen does not show whole.
 */
function rowsOf(fam: InsertFxFamily): InsertFxParamDesc[] {
  const descs = insertFxParams(fam);
  const order = ROW_ORDER[fam];
  if (!order) return [...descs];
  // A label the order does not name keeps its catalogue position after the ones it does,
  // so a parameter added to the catalogue appears rather than disappearing silently.
  const rank = (d: InsertFxParamDesc): number => {
    const i = order.indexOf(d.label);
    return i < 0 ? order.length + descs.indexOf(d) : i;
  };
  return [...descs].sort((a, b) => rank(a) - rank(b));
}

/** The catalogue row one field key came from. */
function descOf(ctx: DynCtx, key: string): InsertFxParamDesc | undefined {
  const fam = familyOf(ctx);
  const slot = slotOf(key);
  return fam ? rowsOf(fam).find((d) => d.slot === slot) : undefined;
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

export const INSFX_DYN: DynProcessor = {
  key: "insfx",
  loDb: LO_DB,
  tickStep: TICK_STEP,
  // The effect's own name is in the title because the screen shows one effect and the
  // selector that picked it is on another surface: without it the heading names a slot
  // rather than what is in it.
  title: (m, ctx) => {
    const fam = familyOf(ctx);
    const value = ctx.plan.nodeParams[ctx.nodeId]?.insertFx;
    const name = insertFxControl(ctx.model, ctx.nodeId)?.options.find((o) => o.value === value)?.label;
    return fam && name ? `${m.dynTuning.insfx.title} — ${name}` : m.dynTuning.insfx.title;
  },

  bind: (ctx): DynBinding | null => {
    const ifx = insertFxControl(ctx.model, ctx.nodeId);
    const fam = insertFxScreenFamily(ctx.plan, ctx.nodeId);
    if (!ifx || !fam) return null;
    const fields: DynField[] = rowsOf(fam)
      .filter((d) => d.control === "slider")
      .map((d) => ({
        key: slotKey(d.slot),
        min: d.rawMin ?? 0,
        max: d.rawMax ?? 0,
        step: d.rawStep ?? 1,
        def: d.def,
        // Raw broker integers throughout: the catalogue's formatter is what turns one
        // into the device's own reading, supplied through `fieldText`.
        unit: "raw",
      }));
    return { fields, lanes: lanesOf(ctx, ifx.isOutput) };
  },

  read: (ctx) => {
    const fam = familyOf(ctx);
    if (!fam) return {};
    const out: Record<string, unknown> = {};
    for (const d of rowsOf(fam)) out[slotKey(d.slot)] = rawOf(ctx, fam, d);
    return out;
  },

  patch: (ctx, patch): NodeParams => {
    const fam = familyOf(ctx);
    if (!fam) return {};
    const slots: Record<number, number> = {};
    for (const [key, v] of Object.entries(patch)) {
      const raw = typeof v === "boolean" ? (v ? 1 : 0) : v;
      const slot = slotOf(key);
      slots[slot] = raw;
      // Three Pitch Fix values are stored twice; the catalogue names the second slot and
      // the device reads both, so an edit that wrote one of them would be half applied.
      const mirror = rowsOf(fam).find((d) => d.slot === slot)?.mirror;
      if (mirror !== undefined) slots[mirror] = raw;
    }
    return { insertFxParams: reKeyInsertFxParams(ctx.plan.nodeParams[ctx.nodeId]?.insertFxParams ?? {}, fam, slots) };
  },

  // A field carries a slot, and a slot means a different parameter under every family, so
  // both of these need the ctx to know which catalogue row they are printing.
  fieldLabel: (f, m, ctx) => {
    const d = descOf(ctx, f.key);
    return d && labelOf(d, m);
  },
  fieldText: (f, v, ctx) => descOf(ctx, f.key)?.format?.(v),

  // Everything that is not a slider — the guitar amp's cabinet selectors and its gate
  // switch. Placed in front of the slider that follows them in display order, so the
  // panel reads in one order rather than sliders-then-the-rest.
  rows: (ctx) => {
    const fam = familyOf(ctx);
    if (!fam) return {};
    const descs = rowsOf(fam);
    const before: Record<string, HTMLElement[]> = {};
    const tail: HTMLElement[] = [];
    let pending: HTMLElement[] = [];
    for (const d of descs) {
      if (d.control === "slider") {
        if (pending.length) {
          before[slotKey(d.slot)] = pending;
          pending = [];
        }
        continue;
      }
      const key = slotKey(d.slot);
      const cur = rawOf(ctx, fam, d);
      const label = labelOf(d, ctx.m);
      pending.push(
        d.control === "toggle"
          ? ctx.midi(
              settingsRow(
                label,
                onOff(cur !== 0, (on) => ctx.set({ [key]: on ? 1 : 0 })),
              ),
              key,
            )
          : enumRow(label, d.options ?? [], cur, (v) => ctx.set({ [key]: v })),
      );
    }
    tail.push(...pending);
    return { before, tail };
  },

  // Lanes only. Nothing here draws a response: the level meters and the reduction are
  // measured, and a guitar amp's EQ curve or a pitch tracker would be an invention. The
  // families whose response IS defined by their parameters (the companders, the
  // multi-band compressor) get a plot with their own faces.
  display: (parts) => parts.lanes(),
};
