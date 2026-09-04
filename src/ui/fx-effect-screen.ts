// The FX EFFECT tuning screen: the effect an FX channel holds, beside the levels going
// into it and coming out of it.
//
// One descriptor for all three parameter families (Rev-X on FX1, Rev.R3 on FX2, the two
// delays on both). What a channel holds is an EFFECT TYPE the operator changes elsewhere
// and a device follow can change underneath an open screen, so the family is resolved from
// the plan on every call — which is what lets a follow re-bind the same modal instead of
// closing one screen and opening another.
//
// The screen deliberately carries no EFFECT TYPE selector. Every other write here names
// ONE slot; the selector is the one that replaces the contents of slots nobody named — the
// unit refills the engine array with the new type's defaults — so it stays on the surfaces
// that treat it as a selection: the CONSOLE strip's popover and the Inspector's row.
//
// Values are RAW broker integers and `src/core/control/fx-effect.ts` is their single
// definition: nothing here restates a range, a default, an enum or a conversion.

import {
  FX_CHANNEL_NODE_INDEX,
  FX_LEVEL_DEFAULT,
  FX_LEVEL_MAX,
  FX_LEVEL_MIN,
  fxEffectTypes,
  fxFamilyOf,
  fxParams,
  fxRowOwners,
  resolveFxEffectType,
} from "../core/control/fx-effect";
import type { FxFamily, FxParamDesc } from "../core/control/fx-effect";
import { nodeRateDisabled } from "../core/constraints";
import { controlId, FX_LEVEL_SCOPE, FX_ON_SCOPE, FX_SCOPE } from "../core/midi/controls";
import type { DynField, FxFieldKey } from "../core/control/translate";
import { tapFor } from "../core/meters";
import type { FxEffectParams, NodeParams } from "../core/plan";
import type { DynBinding, DynCtx, DynLane, DynProcessor } from "./dyn-screen";
import { enumRow, rowBreak } from "./dyn-chan";
import { onOffButton, settingsRow } from "./dom";
import type { Messages } from "../i18n/en";

/** Lane ruler floor. Not one value on this screen is a level — Mix is 0–100, the times are
 *  ms and seconds, the filters Hz, the ratios dimensionless — and no lane carries a fader
 *  cap, so nothing rides this ruler and only legibility decides where it stops. That is the
 *  same position the three screens whose values are likewise off the ruler take. */
const LO_DB = -60;
const TICK_STEP = 6;

/** Mix is slot 2 of every effect array and lives in `fxEffect.level` rather than in the
 *  per-type params map, so it is the one row with no catalogue descriptor. It is a field
 *  here all the same: it is a continuous value the operator sets on this screen, and the
 *  device's own array order puts it in front of everything the type brings.
 *
 *  Its window comes from the catalogue like every other row's. Spelled out here it was a
 *  third copy — the writer and the MIDI codec take theirs from `fx-effect.ts` — and the
 *  three would drift silently in both directions: a MIDI move landing somewhere a drag
 *  cannot, and a readout showing a default the writer does not send. */
const MIX_KEY = "level";

/** A field's key is the plan key it edits, under one prefix.
 *
 *  NOT the family and the slot the insert-FX screen keys by: the two delay types are both
 *  family `delay` and both put the delay time on slot 6, so `fx:delay:6` would name two
 *  different parameters — they take different RANGES, and a Mono time handed to a Ping Pong
 *  descriptor is clamped at the unit while the plan goes on showing what it was set to. The
 *  catalogue's own keys already carry a family name exactly where two families would
 *  collide (`revxHpf` / `revr3Hpf` / `delayHpf`, `delay` / `pingPongDelay`) and share one
 *  where the parameter really is one (`reverbTime` is slot 7 of both reverbs), so they are
 *  unique AND they mean the right thing. The purpose is the insert-FX screen's: a device
 *  follow can replace the effect while a knob is under the pointer, and the drag goes on
 *  firing at a row that is already detached — keyed this way that write lands in the
 *  outgoing family's own stored value instead of under the incoming family's parameter. */
const fieldKey = (planKey: string): FxFieldKey => `fx:${planKey}`;
const planKeyOf = (key: string): string | null => (key.startsWith("fx:") ? key.slice(3) : null);

/**
 * Each family on ONE face, in TWO groups with a row break between them.
 *
 * Above the break is TIME — what the effect does to the signal over time, in the order the
 * device's own array holds it: Mix first, because slot 2 is where the array puts it and it
 * is the amount of all of this that is heard. Below the break is BAND AND BALANCE — the
 * values that decide which part of the spectrum the group above applies to, and how the
 * parts are weighed against each other.
 *
 * Room Size sits beside Reverb Time on the REV-X face although the official guide's table
 * order puts it fourth: the two are one value. The seconds printed on Reverb Time are
 * `base(raw) × 3^(RoomSize/31)`, so turning Room Size moves the number on the OTHER card,
 * and cards that do that to each other are read together.
 *
 * Hi Ratio and Low Ratio are lengths of reverb and so belong to time, but WHICH BAND each
 * one is the length of is set by Low Freq below the break, and the HPF and LPF ride the
 * same axis. The per-band values are read as one group.
 *
 * Every row of every family is named here. A row the catalogue gains and these lists do not
 * name still appears, after the ones they do, rather than disappearing from the face.
 */
const REVX_ORDER: readonly string[] = [
  MIX_KEY,
  "reverbTime",
  "roomSize",
  "revxInitialDelay",
  "decay",
  "revxDiffusion",
  // ── the break ──
  "revxHiRatio",
  "lowRatio",
  "lowFreq",
  "revxHpf",
  "revxLpf",
];
const REVR3_ORDER: readonly string[] = [
  MIX_KEY,
  "reverbTime",
  "revr3InitialDelay",
  "erRevDelay",
  "revr3Diffusion",
  "density",
  // ── the break ──
  "revr3HiRatio",
  "erRevBalance",
  "revr3Feedback",
  "revr3Hpf",
  "revr3Lpf",
];
const DELAY_ORDER: readonly string[] = [
  MIX_KEY,
  "delay",
  "pingPongDelay",
  "sync",
  "note",
  "bpm",
  // ── the break ──
  "delayFeedback",
  "delayHiRatio",
  "delayHpf",
  "delayLpf",
];

/** The row each family's SECOND group opens on. The break is placed in front of it rather
 *  than counted into the list, so moving a row across the boundary is one edit. */
const BREAK_AT: Record<FxFamily, string> = {
  revx: "revxHiRatio",
  revr3: "revr3HiRatio",
  delay: "delayFeedback",
};

const ORDER: Record<FxFamily, readonly string[]> = {
  revx: REVX_ORDER,
  revr3: REVR3_ORDER,
  delay: DELAY_ORDER,
};

/** Six columns on every family. It is what puts each family's first group on one row and
 *  drops the break on a row boundary, and it is what makes the three faces the same height
 *  at every width where the modal has two columns of its own. */
const KNOB_COLS = 6;

/** Which FX channel a node is, or null where it is not one. */
function fxIndexOf(ctx: DynCtx): number | null {
  return FX_CHANNEL_NODE_INDEX[ctx.nodeId] ?? null;
}

/** The channel's own EFFECT TYPE, resolved against the menu that channel actually offers —
 *  the same answer the writer and the Inspector take, so a hand-edited or `?plan=` value
 *  this channel has no effect for shows the effect the unit would be set to. */
function typeOf(ctx: DynCtx): number | null {
  const fxIndex = fxIndexOf(ctx);
  if (fxIndex === null) return null;
  return resolveFxEffectType(fxIndex, ctx.plan.nodeParams[ctx.nodeId]?.fxEffect?.type);
}

const fxOf = (ctx: DynCtx): FxEffectParams => ctx.plan.nodeParams[ctx.nodeId]?.fxEffect ?? {};

/** The catalogue rows for the held type, in this face's order. Anything the order does not
 *  name follows the rows it does. */
function rowsOf(type: number): FxParamDesc[] {
  const order = ORDER[fxFamilyOf(type)];
  const rank = (d: FxParamDesc): number => {
    const i = order.indexOf(d.key);
    return i === -1 ? order.length : i;
  };
  return [...fxParams(type)].sort((a, b) => rank(a) - rank(b));
}

/** One row's current raw, falling back to the catalogue's own default. */
const rawOf = (ctx: DynCtx, d: FxParamDesc): number => fxOf(ctx).params?.[d.key] ?? d.def;

/**
 * The two ends of the effect.
 *
 * `131` is the FX send sum arriving at the effect — mono, because the sum is — and `103`
 * is the effect's own output, before the channel fader. So the pair really is the input and
 * the output of the thing this screen sets, which is what the shared captions claim; the
 * channel's post-fader level is the CONSOLE strip's to show, and the fader is not this
 * screen's.
 *
 * No reduction lane. The five reduction meters the unit reports are all identified, and an
 * FX channel's effect has none — a reverb and a delay take no gain off, so there is nothing
 * a bar there could ever move for.
 */
function lanesOf(ctx: DynCtx): DynLane[] {
  const g = ctx.m.dynTuning;
  return [
    {
      key: "in",
      label: g.fx.tapIn,
      caption: g.laneIn,
      kind: "level",
      tap: tapFor(ctx.nodeId, "input", ctx.model.id) ?? null,
    },
    {
      key: "out",
      label: g.fx.tapOut,
      caption: g.laneOut,
      kind: "level",
      tap: tapFor(ctx.nodeId, "prefader", ctx.model.id) ?? null,
    },
  ];
}

/**
 * Why nothing this screen sets reaches the signal, or null when something does.
 *
 * The rate first, then the bypass — the order the insert-FX screen takes, and for its
 * reason: above 96 kHz the FX2 bus is gone, which the CONSOLE strip and the Inspector
 * already say, and saying it in different words on a third surface (or not at all) is how
 * one panel tells the operator the effect is off while another hands them a live editor.
 *
 * Neither state closes the screen or locks a row. The unit accepts and keeps a parameter
 * write at any rate, and a bypassed effect is still an effect to tune — the plan holds the
 * values, the unit stores them, and the two lanes go on reading the signal that is passing
 * through untouched.
 */
function offNote(ctx: DynCtx): string | null {
  if (nodeRateDisabled(ctx.nodeId, ctx.plan.sampleRate)) return ctx.m.inspector.fx2RateLocked;
  return fxOf(ctx).on === false ? ctx.m.dynTuning.fx.bypassed : null;
}

/** The rows the unit owns, tagged with which of the two things it is doing. Both stay on
 *  the panel and stay readable — the computed one is where the derived time is read — and
 *  neither is removed, so the face keeps its height whatever Sync is set to.
 *
 *  The cost of locking the note value is that it cannot be chosen before Sync is switched
 *  on; switching Sync on first is the one extra gesture. It is locked all the same, because
 *  a control the unit is not reading is a control whose value means nothing yet.
 *
 *  The lock the OPERATOR sees; the writer honours the same list by leaving a computed slot
 *  out of what it sends, so the gesture and the command agree about who owns the row. */
function lockedRows(ctx: DynCtx, type: number): ReadonlyMap<string, { locked: true; tag: string }> | null {
  const g = ctx.m.dynTuning.fx;
  const owners = fxRowOwners(type, fxOf(ctx).params);
  const out = new Map<string, { locked: true; tag: string }>();
  for (const [planKey, why] of owners) {
    out.set(fieldKey(planKey), { locked: true, tag: why === "computed" ? g.syncedTag : g.syncOffTag });
  }
  return out.size ? out : null;
}

/** The label an i18n table has for a catalogue row. The catalogue's `label` is the shared
 *  name (both reverbs' `hpf`), which is what keeps one message per parameter rather than one
 *  per family. */
const labelOf = (d: FxParamDesc, m: Messages): string =>
  m.inspector.fxEffect.params[d.label as keyof Messages["inspector"]["fxEffect"]["params"]] ?? d.label;

/**
 * The words a MIDI assignment prints for one of this screen's control ids, or null when the
 * scope is not one of them. The screen's own title leads, the way the insert effect's does:
 * a scope is built from the PLAN KEY, so printed raw an assignment read "FX 1 · fx.reverbTime
 * · fx" — three tokens, none of them a word that appears on any surface the operator sees.
 *
 * Resolved across every type BOTH channels offer rather than against the one a channel holds
 * now: an assignment outlives the effect it was made on, and a list that fell back to the raw
 * key the moment the type changed would print the token exactly where the name is most needed.
 * The catalogue shares a key wherever two families really are one parameter and separates the
 * ones that only look alike, so the first descriptor found under a key is the right label.
 */
export function fxControlLabel(scope: string | undefined, m: Messages): string | null {
  if (scope === undefined || !scope.startsWith(`${FX_SCOPE}.`)) return null;
  const head = m.dynTuning.fx.title;
  if (scope === FX_LEVEL_SCOPE) return `${head} · ${m.inspector.fxEffect.level}`;
  if (scope === FX_ON_SCOPE) return `${head} · ${m.inspector.fxEffect.effectOn}`;
  const key = scope.slice(FX_SCOPE.length + 1);
  for (const fxIndex of [0, 1]) {
    for (const opt of fxEffectTypes(fxIndex)) {
      const d = fxParams(opt.value).find((x) => x.key === key);
      if (d) return `${head} · ${labelOf(d, m)}`;
    }
  }
  return null;
}

function fxFace(): DynProcessor {
  return {
    key: "fx",
    loDb: LO_DB,
    tickStep: TICK_STEP,

    // The effect's own name, because the screen shows one effect and the selector that
    // picked it is on another surface: without it the heading names a channel rather than
    // what is in it. The host prints the channel beside this.
    title: (m, ctx) => {
      const fxIndex = fxIndexOf(ctx);
      const type = typeOf(ctx);
      const name =
        fxIndex === null || type === null ? undefined : fxEffectTypes(fxIndex).find((o) => o.value === type)?.label;
      return name ? `${m.dynTuning.fx.title} — ${name}` : m.dynTuning.fx.title;
    },

    bind: (ctx): DynBinding | null => {
      const type = typeOf(ctx);
      if (type === null) return null;
      const fields: DynField[] = [];
      for (const key of [MIX_KEY]) {
        fields.push({
          key: fieldKey(key),
          min: FX_LEVEL_MIN,
          max: FX_LEVEL_MAX,
          step: 1,
          def: FX_LEVEL_DEFAULT,
          unit: "raw",
        });
      }
      for (const d of rowsOf(type)) {
        if (d.control !== "slider") continue;
        fields.push({
          key: fieldKey(d.key),
          min: d.rawMin ?? 0,
          max: d.rawMax ?? 0,
          // Linear positions on every row, the delay time included. The knob's resolution
          // is the face's width and not the mapping — a logarithmic delay time resolves no
          // finer at the bottom and lands COARSER than the unit's own 5 ms detent at the
          // top — and the law here is linear in ms, so a linear position walks the unit's
          // own grid. The keyboard and the wheel are what carry precision: both move one
          // step, which is 0.1 ms.
          step: d.rawStep ?? 1,
          def: d.def,
          // Raw broker integers throughout: the catalogue's formatter is what turns one
          // into the unit's own reading, supplied through `fieldText`.
          unit: "raw",
        });
      }
      return {
        fields,
        lanes: lanesOf(ctx),
        // A dozen continuous values against a display that is a level rack and nothing
        // else — the arrangement the guitar amp already takes, and the one the unit's own
        // INS FX screen uses, where the parameters are on the left and the input/output
        // meters on the right.
        paramsFirst: true,
        knobGrid: true,
        knobCols: KNOB_COLS,
      };
    },

    read: (ctx) => {
      const type = typeOf(ctx);
      if (type === null) return {};
      const fx = fxOf(ctx);
      const out: Record<string, unknown> = { [fieldKey(MIX_KEY)]: fx.level ?? FX_LEVEL_DEFAULT };
      for (const d of fxParams(type)) out[fieldKey(d.key)] = rawOf(ctx, d);
      return out;
    },

    // The plan key comes from the KEY, not from the type: a device follow can replace the
    // effect while a knob is under the pointer, and the drag goes on firing at a row that is
    // already detached. Keyed this way that write lands under the outgoing family's own
    // name, which is where it lives anyway — an FX channel's params map holds every family's
    // values side by side, so nothing is parked and nothing is lost.
    patch: (ctx, patch): NodeParams => {
      const fx = fxOf(ctx);
      const next: FxEffectParams = { ...fx };
      let params: Record<string, number> | undefined;
      for (const [key, v] of Object.entries(patch)) {
        const planKey = planKeyOf(key);
        if (!planKey) continue;
        const raw = typeof v === "boolean" ? (v ? 1 : 0) : v;
        if (planKey === MIX_KEY) {
          next.level = raw;
          continue;
        }
        params = { ...(params ?? fx.params ?? {}), [planKey]: raw };
      }
      if (params) next.params = params;
      return { fxEffect: next };
    },

    // `patch` rebuilds the whole `fxEffect` group, so the funnel would either claim every
    // sibling it copied or fall back to a diff that cannot see a write landing on the value
    // already there. Both halves are named: Mix sits at the top level and the rest inside
    // `params`.
    written: (_ctx, patch) =>
      Object.keys(patch).flatMap((key) => {
        const planKey = planKeyOf(key);
        if (!planKey) return [];
        return planKey === MIX_KEY ? [`fxEffect.${MIX_KEY}`] : [`fxEffect.params.${planKey}`];
      }),

    fieldLabel: (f, m, ctx) => {
      const planKey = planKeyOf(f.key);
      if (planKey === MIX_KEY) return m.inspector.fxEffect.level;
      const type = typeOf(ctx);
      const d = type === null ? undefined : fxParams(type).find((x) => x.key === planKey);
      return d && labelOf(d, m);
    },

    // The catalogue's formatter and nothing else — the seconds, the milliseconds, the
    // hertz and the THRU at a filter's end all come from the one place they are defined.
    fieldText: (f, v, ctx) => {
      const planKey = planKeyOf(f.key);
      if (planKey === MIX_KEY) return String(v);
      const type = typeOf(ctx);
      if (type === null) return undefined;
      const d = fxParams(type).find((x) => x.key === planKey);
      if (!d?.format) return undefined;
      // The sibling values a formatter folds in, taken from the plan and overridden with
      // the value being shown: during a drag the card is drawn before the plan has the new
      // number, and Room Size folded in stale would print the seconds it was leaving.
      const ctxVals: Record<string, number> = {};
      for (const x of fxParams(type)) ctxVals[x.key] = rawOf(ctx, x);
      if (planKey) ctxVals[planKey] = v;
      return d.format(v, ctxVals);
    },

    rowStates: (ctx) => {
      const type = typeOf(ctx);
      return type === null ? null : lockedRows(ctx, type);
    },

    // Everything that is not a knob — the delay's Sync switch and its Note value. Placed in
    // front of the knob that follows them in the face's order, so the panel reads in one
    // order rather than knobs-then-the-rest, and the row break rides in front of whatever
    // row opens the second group.
    rows: (ctx) => {
      const type = typeOf(ctx);
      if (type === null) return {};
      const before: Record<string, HTMLElement[]> = {};
      const tail: HTMLElement[] = [];
      let pending: HTMLElement[] = [];
      const breakKey = BREAK_AT[fxFamilyOf(type)];
      for (const d of rowsOf(type)) {
        if (d.key === breakKey) pending.push(rowBreak());
        if (d.control === "slider") {
          if (pending.length) {
            before[fieldKey(d.key)] = pending;
            pending = [];
          }
          continue;
        }
        const key = fieldKey(d.key);
        const cur = rawOf(ctx, d);
        const label = labelOf(d, ctx.m);
        // What `rowStates` said about this row. The host applies that answer to the FIELDS
        // it lays out and to nothing else, so a row built here has to ask for it — and one
        // that does not is drawn live while the operator has no way to know the value is
        // not being read.
        const state = ctx.states.get(key) ?? {};
        pending.push(
          d.control === "toggle"
            ? ctx.midi(
                settingsRow(
                  label,
                  // A knob grid gives every control one card, so a switch takes the
                  // one-button form: the pair would split a card between two words where a
                  // single button prints the state it is in.
                  onOffButton(cur !== 0, (on) => ctx.set({ [key]: on ? 1 : 0 })),
                  state,
                ),
                key,
              )
            : enumRow(label, d.options ?? [], cur, (v) => ctx.set({ [key]: v }), state),
        );
      }
      tail.push(...pending);
      return { before, tail };
    },

    // The MIDI id a row arms into, scoped by the PLAN KEY the field edits — the same key,
    // for the same reason: a family and a slot would name the two delay types' time slot
    // identically, and a mapping made on one would drive the other. An enum answers null;
    // a select has no normalized domain, which is the treatment COMP's knee already gets.
    controlId: (ctx, key) => {
      const planKey = planKeyOf(key);
      if (!planKey) return null;
      if (planKey === MIX_KEY) return controlId(ctx.nodeId, "fx", FX_LEVEL_SCOPE);
      const type = typeOf(ctx);
      const d = type === null ? undefined : fxParams(type).find((x) => x.key === planKey);
      // An enum answers null — a select has no normalized domain, which is the treatment
      // COMP's knee already gets. Everything continuous is armable: a control whose own grid
      // is finer than the wire is handled by the catalogue's codec rather than refused here.
      if (!d || d.control === "select") return null;
      return controlId(ctx.nodeId, "fx", `${FX_SCOPE}.${planKey}`);
    },

    // A level rack and nothing else. Neither reverb's decay nor a delay's repeats is
    // derivable from these values — the algorithms are the unit's, the frequency a Hi Ratio
    // starts acting at is not a parameter at all, and a feedback percentage has not been
    // measured against an amplitude — so a curve here would be an invention. The same
    // position the guitar amp and Pitch Fix take.
    display: (parts) => parts.lanes(),

    // The line under the display. It carries why nothing is reaching the signal when that
    // is the case, and prints nothing otherwise — there is no figure here to explain, and
    // the reserve keeps the rack in the same place either way.
    hint: (ctx) => offNote(ctx),
  };
}

export const FX_DYN = fxFace();

/** The face's row order, per family. Exported for the pin that asserts every slider of every
 *  type is named by its family's list — the claim the table's own header makes. */
export const ORDER_FOR_TEST = ORDER;
