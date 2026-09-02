// Everything the plan loader reports about a document, in one place. Split out of
// constraints.ts, which is the sample-rate-dependent feature limits and nothing else:
// a rate limit is a warning about a plan the app itself authored, while these are the
// checks a plan built ELSEWHERE (a file, a ?plan= link, a generator) has to pass.
// routing.ts cannot host them — constraints -> translate -> routing is a real
// dependency chain — so they live here. Language-agnostic: the UI maps codes to
// messages. Nothing here runs on a device readback (see insertFxSlotProblems).

import type { DeviceModel } from "../models/types";
import { insertFxCensus } from "./constraints";
import { FX_CHANNEL_NODE_INDEX, FX_LEVEL_MAX, FX_LEVEL_MIN, fxEffectTypes, fxParams } from "./control/fx-effect";
import type { InsertFxSlot } from "./control/params";
import { isPlainRecord } from "./plan";
import type { Plan } from "./plan";
import { validatePlan } from "./routing";
import type { PlanProblem } from "./routing";

/** One device-wide 1-of insert-FX slot claimed by more than one node. Not a wire,
 *  so it carries the contended slot and its holders instead of two endpoints. */
export interface InsertFxSlotProblem {
  reason: "insertFxSlot";
  slot: InsertFxSlot;
  /** Every node whose selection claims the slot, in model order (two or more). */
  nodes: string[];
}

// Insert-FX slot collisions in a whole plan. The screens cannot author one
// (insertFxMenu locks a slot another node holds), so a plan carrying one came
// from outside — a file, a ?plan= link, a generator. Unlike an illegal wire this
// does not refuse the document: the loader reports it and offers to open it anyway,
// since the plan is otherwise usable and only the unit decides what it runs.
// A device readback deliberately does not run this: the unit is the authority for
// what it is actually running, and refusing there would leave the operator unable
// to read the hardware at all.
export function insertFxSlotProblems(model: DeviceModel, plan: Plan): InsertFxSlotProblem[] {
  return [...insertFxCensus(model, plan)]
    .filter(([, nodes]) => nodes.length > 1)
    .map(([slot, nodes]) => ({ reason: "insertFxSlot" as const, slot, nodes: [...nodes] }));
}

/** One stored parameter outside the range its own control admits. `translate.ts` bounds
 *  every FX slot to the same rawMin/rawMax the slider declares, so a document holding one
 *  means a different thing on screen than on the wire: the panel shows what the plan holds
 *  and the unit receives the bound. The loader normalizes the document to the bound and
 *  says so, which is the only reading under which the two agree.
 *
 *  A plan the app itself authored cannot carry one — the sliders stop at the window and the
 *  write bounds anything else — so this is a document from a file an older build saved, a
 *  hand-edited one, or a `?plan=` payload. Like every check in this file it does NOT run on
 *  a device readback: the unit is the authority for what it is running, and it can hold a
 *  raw this app's range excludes, because its own encoder stops at the window but the wire
 *  does not. A `.urxf` import takes the same exemption for the same reason and by the same
 *  route — it is a FILE, but one the unit wrote, and it reaches the plan through the readback
 *  rather than through this funnel.
 *
 *  SCOPE: the FX channel effect, and nothing else. `translate.ts` bounds twenty addresses by
 *  a window, and this reads one family of them. The others (insert-FX, SSMCS, the two 1-knob
 *  levels, the oscillator interval) have the same shape, and one of them — the oscillator —
 *  is scene-external, so a scene-scoped write would not send it while a whole-plan repair
 *  would still move it. The FX catalogue is the family whose windows have actually moved, so
 *  it is the family a shipped document can be outside of. The name says `param` because the
 *  shape is general; the walk is deliberately not. */
export interface ParamRangeProblem {
  reason: "paramRange";
  node: string;
  /** Which container holds it: the node's `fxEffect` value itself, a field of that object
   *  (`type` / `level` / `params`), or a member of its `params` map. `level` is bounded by a
   *  literal two lines above the parameter loop in `pushFxEffectCommands`; a `params` member
   *  is bounded by its own descriptor. */
  where: "effect" | "field" | "params";
  /** The field or catalogue key, as the plan stores it. `fxEffect` for the object itself. */
  key: string;
  /** What the document carries. NOT always a number: the sanitiser keeps a boolean leaf and a
   *  non-empty object, since node params have toggles and groups, and a document can put
   *  either under a key that holds a number. */
  stored: unknown;
  /** `bound` writes the value the window admits; `drop` removes the key.
   *
   *  A leaf that is not a finite number is DROPPED rather than replaced by a default, because
   *  the default is the one thing about a key that is not shared: the window is the same under
   *  every type a channel offers (the catalogue pins that), but `FX_TYPE_DEFAULTS` gives each
   *  type its own value. Writing one type's default is therefore a guess about which type is
   *  selected — and the emit already substitutes the SELECTED type's default for a key that is
   *  absent, so dropping it lands on the same value now and stays right if the type changes.
   *
   *  A `type` outside the channel's menu is dropped for a different reason: a menu is a set,
   *  so there is no nearest member to bound to, and `resolveFxEffectType` already answers the
   *  channel's own default for it. Same for the two containers — an `fxEffect` or a `params`
   *  that is not an object holds nothing to bound. All four cases emit exactly what the same
   *  document emits with the key absent, so the drop moves no value; what it changes is that
   *  the plan stops carrying something the write path silently ignores, and the load says so. */
  action: "bound" | "drop";
  /** The value the loader writes. Absent for `drop`, which writes nothing. */
  bound?: number;
}

/** Every FX parameter a plan holds outside its own control's range, in model order.
 *  Reads the type through `resolveFxEffectType` like every other consumer, so the window
 *  asked about is the one the write path will bound against. */
export function paramRangeProblems(plan: Plan): ParamRangeProblem[] {
  const out: ParamRangeProblem[] = [];
  const take = (
    node: string,
    where: "field" | "params",
    key: string,
    stored: number | undefined,
    lo: number | undefined,
    hi: number | undefined,
  ): void => {
    // An ABSENT value is not a problem: the emit substitutes the catalogue default and the
    // panel shows that same default, so the two already agree, and reporting it would write
    // a key the document never carried.
    if (stored === undefined) return;
    // Not a finite NUMBER — a boolean, which the document sanitiser keeps — so there is no
    // value to bound. Dropped rather than defaulted, for the reason on `action`.
    if (typeof stored !== "number" || !Number.isFinite(stored)) {
      out.push({ reason: "paramRange", node, where, key, stored, action: "drop" });
      return;
    }
    // The window, and only the window. It is the same under every type the channel offers, so
    // whichever type named the key, this is the pair the emit will bound against.
    const bound = Math.min(Math.max(stored, lo ?? stored), hi ?? stored);
    if (bound !== stored) out.push({ reason: "paramRange", node, where, key, stored, action: "bound", bound });
  };
  for (const [node, fxIndex] of Object.entries(FX_CHANNEL_NODE_INDEX)) {
    const fx: unknown = plan.nodeParams[node]?.fxEffect;
    if (fx === undefined) continue;
    // The effect OBJECT. The sanitiser keeps a boolean and a non-empty array of objects, and
    // every reader of the plan treats one as no effect at all — thirteen addresses the write
    // path then never sends, with the document still holding what it holds.
    if (!isPlainRecord(fx)) {
      out.push({ reason: "paramRange", node, where: "effect", key: "fxEffect", stored: fx, action: "drop" });
      continue;
    }
    // The effect TYPE, against the channel's MENU rather than a window.
    if (fx.type !== undefined && !fxEffectTypes(fxIndex).some((o) => o.value === fx.type)) {
      out.push({ reason: "paramRange", node, where: "field", key: "type", stored: fx.type, action: "drop" });
    }
    // The effect's own level, which `pushFxEffectCommands` bounds two lines ABOVE the
    // parameter loop and by a literal rather than by a descriptor. Named here because the
    // sentence this section opens with says every FX slot, and a slot bounded by a literal
    // is no less bounded.
    take(node, "field", "level", fx.level as number | undefined, FX_LEVEL_MIN, FX_LEVEL_MAX);
    // The parameter MAP, which the readers below and the write path both skip when it is not
    // an object — the same silent loss as an unreadable effect, one channel's worth of raws.
    if (fx.params !== undefined && !isPlainRecord(fx.params)) {
      out.push({ reason: "paramRange", node, where: "field", key: "params", stored: fx.params, action: "drop" });
      continue;
    }
    const fxParamsMap = fx.params as Record<string, number> | undefined;
    if (!fxParamsMap) continue;
    // EVERY type the CHANNEL offers, not only the one selected. The migration leaves a key
    // the selected type does not own exactly where it is (fx-effect.ts), so a document saved
    // under another type keeps the raw untouched, and selecting that type later brings it
    // back — the load was the one chance to repair it. The catalogue pins that one channel
    // never gives a key two different windows, so whichever of its types names the key, the
    // window found is the window the write path will bound against.
    const seen = new Set<string>();
    for (const type of fxEffectTypes(fxIndex)) {
      for (const d of fxParams(type.value)) {
        if (seen.has(d.key)) continue;
        seen.add(d.key);
        take(node, "params", d.key, fxParamsMap[d.key], d.rawMin, d.rawMax);
      }
    }
  }
  return out;
}

/** Write each reported bound into the plan. Separate from finding them so a caller can
 *  report without repairing, and so a test can assert the two halves apart. */
export function applyParamRange(plan: Plan, problems: ParamRangeProblem[]): void {
  for (const p of problems) {
    const np = plan.nodeParams[p.node]!;
    if (p.where === "effect") {
      delete np.fxEffect;
      continue;
    }
    const fx = np.fxEffect!;
    if (p.where === "field") {
      // `level` is the only field carrying a window, so a bound here is that field and a
      // drop is any of the three.
      if (p.action === "drop") delete (fx as unknown as Record<string, unknown>)[p.key];
      else fx.level = p.bound;
    } else if (p.action === "drop") {
      delete fx.params![p.key];
    } else {
      fx.params![p.key] = p.bound!;
    }
  }
}

/** Everything a plan load reports: an illegal wire (refused), a slot claimed twice (the
 *  operator decides), or a value outside its range (normalized, then reported). */
export type LoadProblem = PlanProblem | InsertFxSlotProblem | ParamRangeProblem;

// Every violation the plan loader reports on a file / ?plan= link / drop, in one
// list so a load path cannot pick up half of them. The caller splits them by
// reason — a wire violation refuses the document, a slot collision only warns.
// Both halves check a plan built elsewhere; neither runs on a device readback.
export function planProblems(model: DeviceModel, plan: Plan): LoadProblem[] {
  return [...validatePlan(model, plan), ...insertFxSlotProblems(model, plan), ...paramRangeProblems(plan)];
}

/** Which side of that split a problem falls on: true refuses the document, false warns
 *  and offers to open it anyway. One seat, because the rule was written out three times
 *  — the loader, the report's caller and a test — and moving a reason between the sides
 *  in one of them would leave the others agreeing with the old split. */
export function isRefusal(problem: LoadProblem): boolean {
  return problem.reason !== "insertFxSlot" && problem.reason !== "paramRange";
}

/** Whether a problem stops the load until the operator answers. A refusal does not — there
 *  is nothing to answer — and a normalized range does not either: it is repaired before the
 *  document opens and reported on the status line, which is where architecture.md puts a
 *  partial success. Only the slot collision leaves a document the app can open and the unit
 *  cannot run, which is a decision and nobody else's. */
export function needsDecision(problem: LoadProblem): boolean {
  return problem.reason === "insertFxSlot";
}
