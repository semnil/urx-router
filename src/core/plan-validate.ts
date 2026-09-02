// Everything the plan loader reports about a document, in one place. Split out of
// constraints.ts, which is the sample-rate-dependent feature limits and nothing else:
// a rate limit is a warning about a plan the app itself authored, while these are the
// checks a plan built ELSEWHERE (a file, a ?plan= link, a generator) has to pass.
// routing.ts cannot host them — constraints -> translate -> routing is a real
// dependency chain — so they live here. Language-agnostic: the UI maps codes to
// messages. Nothing here runs on a device readback (see insertFxSlotProblems).

import type { DeviceModel } from "../models/types";
import { insertFxCensus } from "./constraints";
import { FX_CHANNEL_NODE_INDEX, fxEffectTypes, fxParams } from "./control/fx-effect";
import type { InsertFxSlot } from "./control/params";
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

/** The FX effect level's own bounds, which `pushFxEffectCommands` spells as a literal rather
 *  than as a descriptor. Named here so the two cannot drift apart unnoticed. */
const FX_LEVEL_MIN = 0;
const FX_LEVEL_MAX = 100;

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
  /** Which half of the effect object holds it. `level` is a field of its own, bounded by a
   *  literal two lines above the parameter loop in `pushFxEffectCommands`; everything else is
   *  a `params` key bounded by its own descriptor. */
  where: "level" | "params";
  /** The catalogue key, as the plan stores it. */
  key: string;
  stored: number;
  /** What the write path would send in its place, and what the loader stores. */
  bound: number;
}

/** Every FX parameter a plan holds outside its own control's range, in model order.
 *  Reads the type through `resolveFxEffectType` like every other consumer, so the window
 *  asked about is the one the write path will bound against. */
export function paramRangeProblems(plan: Plan): ParamRangeProblem[] {
  const out: ParamRangeProblem[] = [];
  const take = (
    node: string,
    where: "level" | "params",
    key: string,
    stored: number | undefined,
    lo: number | undefined,
    hi: number | undefined,
  ): void => {
    // An ABSENT value is not a problem: the emit substitutes the catalogue default and the
    // panel shows that same default, so the two already agree. `?? stored` on each end is
    // live rather than defensive — `sync` and `note` carry no window at all, and a bound
    // substituted for a missing end would clamp them to it.
    if (stored === undefined) return;
    const bound = Math.min(Math.max(stored, lo ?? stored), hi ?? stored);
    if (bound !== stored) out.push({ reason: "paramRange", node, where, key, stored, bound });
  };
  for (const [node, fxIndex] of Object.entries(FX_CHANNEL_NODE_INDEX)) {
    const fx = plan.nodeParams[node]?.fxEffect;
    if (!fx) continue;
    // The effect's own level, which `pushFxEffectCommands` bounds two lines ABOVE the
    // parameter loop and by a literal rather than by a descriptor. Named here because the
    // sentence this section opens with says every FX slot, and a slot bounded by a literal
    // is no less bounded.
    take(node, "level", "level", fx.level, FX_LEVEL_MIN, FX_LEVEL_MAX);
    if (!fx.params) continue;
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
        take(node, "params", d.key, fx.params[d.key], d.rawMin, d.rawMax);
      }
    }
  }
  return out;
}

/** Write each reported bound into the plan. Separate from finding them so a caller can
 *  report without repairing, and so a test can assert the two halves apart. */
export function applyParamRange(plan: Plan, problems: ParamRangeProblem[]): void {
  for (const p of problems) {
    const fx = plan.nodeParams[p.node]!.fxEffect!;
    if (p.where === "level") fx.level = p.bound;
    else fx.params![p.key] = p.bound;
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
