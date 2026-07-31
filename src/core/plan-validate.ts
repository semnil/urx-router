// Everything the plan loader reports about a document, in one place. Split out of
// constraints.ts, which is the sample-rate-dependent feature limits and nothing else:
// a rate limit is a warning about a plan the app itself authored, while these are the
// checks a plan built ELSEWHERE (a file, a ?plan= link, a generator) has to pass.
// routing.ts cannot host them — constraints -> translate -> routing is a real
// dependency chain — so they live here. Language-agnostic: the UI maps codes to
// messages. Nothing here runs on a device readback (see insertFxSlotProblems).

import type { DeviceModel } from "../models/types";
import { insertFxCensus } from "./constraints";
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

/** Everything a plan load reports: an illegal wire (refused) or a slot claimed twice (warned). */
export type LoadProblem = PlanProblem | InsertFxSlotProblem;

// Every violation the plan loader reports on a file / ?plan= link / drop, in one
// list so a load path cannot pick up half of them. The caller splits them by
// reason — a wire violation refuses the document, a slot collision only warns.
// Both halves check a plan built elsewhere; neither runs on a device readback.
export function planProblems(model: DeviceModel, plan: Plan): LoadProblem[] {
  return [...validatePlan(model, plan), ...insertFxSlotProblems(model, plan)];
}
