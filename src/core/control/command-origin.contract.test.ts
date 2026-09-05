// The stamp against what the emit actually depends on.
//
// `planToCommandOrigins` names the plan key each command's value came from, recorded as the
// command is built. That recording reads the emit's own order — a value is read immediately
// before the command carrying it is built — which is what keeps the two from drifting the way a
// second spelling kept by hand at each of a hundred-odd command sites would. What it cannot do
// is prove itself: the rule is about when a read belongs to a command, and a rule is not a
// measurement.
//
// So this measures. Every leaf of a factory-filled plan is moved, one at a time and in both
// directions, and the addresses whose value follows it are that leaf's. The stamp has to agree:
// a command stamped with a key must be one that key really moves, and one stamped as the emit's
// own constant must be a command no leaf moves at all. Both directions matter — the first is a
// warning about the wrong strip, the second a write that goes out unmentioned.
//
// It is the expensive reading (one emit per leaf) deliberately: the cheap one ships, and this
// says the cheap one is right.

import { describe, expect, it } from "vitest";
import { cmdAddr, planToCommandOrigins, planToCommands } from "./translate";
import { nodeParamContestPath, walkParamLeaves } from "../plan-history";
import { isPlainRecord, type NodeParams, type Plan } from "../plan";
import { getModel } from "../../models";
import { MODEL_IDS } from "../../models";
import { defaultPlan, fillFactoryParams } from "../../models/initial-state";
import type { ModelId } from "../../models/types";

/** The plan a document naming nothing becomes, which is where every key is the fill's. */
function filled(modelId: ModelId): Plan {
  const plan = defaultPlan(modelId);
  plan.nodeParams = {};
  fillFactoryParams(modelId, plan);
  return plan;
}

/** One leaf moved off its value: a step either way for a number, the other way for a switch,
 *  and — for `by` 0 — taken out altogether.
 *
 *  All three, because no one of them moves every value. A step does not move an enum whose
 *  neighbouring integers are not on its option list: `insertFx` sits at -1 (No Effect), where
 *  -2 and 0 both resolve back to -1. Taking the value out does move that one, since the emit
 *  skips the block without it. */
function shift(value: unknown, target: string, by: number, path: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((v, i) => shift(v, target, by, [...path, String(i)]));
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = shift(v, target, by, [...path, key]);
    return out;
  }
  if (path.join(".") !== target) return value;
  if (by === 0) return undefined;
  if (typeof value === "number") return value + by;
  if (typeof value === "boolean") return !value;
  return value;
}

describe.each(MODEL_IDS)("planToCommandOrigins on %s", (modelId) => {
  const model = getModel(modelId);
  const plan = filled(modelId);
  const base = planToCommands(model, plan, "all");
  const held = new Map(base.map((c) => [cmdAddr(c), c.vdValue]));

  /** Every address each leaf actually moves, measured rather than declared. */
  const moves = new Map<number, Set<string>>();
  for (const [nodeId, params] of Object.entries(plan.nodeParams)) {
    const leaves: string[] = [];
    walkParamLeaves(params, (leaf) => leaves.push(leaf));
    for (const leaf of leaves) {
      for (const by of [1, -1, 0]) {
        const nodeParams = { ...plan.nodeParams, [nodeId]: shift(params, leaf, by) as NodeParams };
        const after = new Map(
          planToCommands(model, { ...plan, nodeParams }, "all").map((c) => [cmdAddr(c), c.vdValue]),
        );
        for (const [addr, value] of held) {
          // A different value, or — where the leaf was taken out — an address the emit no
          // longer sends at all. Both are the command following that leaf.
          const moved = after.has(addr) ? after.get(addr) !== value : by === 0;
          if (!moved) continue;
          if (!moves.has(addr)) moves.set(addr, new Set());
          moves.get(addr)!.add(nodeParamContestPath(nodeId, leaf));
        }
      }
    }
  }

  const origins = planToCommandOrigins(model, plan, "all");

  it("stamps every command it emits", () => {
    expect(base.length).toBeGreaterThan(100);
    // Absent is the third answer — a command that went through no factory — and nothing here
    // may produce one, or the caller has to treat a whole plan as unvouched.
    expect(base.filter((c) => origins.get(cmdAddr(c)) === undefined)).toEqual([]);
  });

  it("names a key only where that key really moves the command", () => {
    const wrong = base.filter((c) => {
      const stamped = origins.get(cmdAddr(c));
      if (typeof stamped !== "string") return false;
      // An address NO leaf moves is one no key owns, so a name on it is wrong for the same
      // reason a mismatched name is — and reading an absent measurement as "nothing to check"
      // is what let a fader that comes off a connection be named for whichever parameter had
      // last been read carrying a zero.
      return !(moves.get(cmdAddr(c))?.has(stamped) ?? false);
    });
    expect(wrong.map((c) => `${c.node} ${c.name}`)).toEqual([]);
  });

  it("calls a command the emit's own only where no key moves it", () => {
    const missed = base.filter((c) => origins.get(cmdAddr(c)) === null && (moves.get(cmdAddr(c))?.size ?? 0) > 0);
    expect(missed.map((c) => `${c.node} ${c.name}`)).toEqual([]);
  });

  // The positive control: both readings above are satisfied by a run that measured nothing, so
  // this states that the two kinds are each a real population on this model.
  it("finds both kinds", () => {
    const stamped = base.map((c) => origins.get(cmdAddr(c)));
    expect(stamped.filter((s) => typeof s === "string").length).toBeGreaterThan(100);
    expect(stamped.filter((s) => s === null).length).toBeGreaterThan(10);
    expect(moves.size).toBeGreaterThan(100);
  });
});
