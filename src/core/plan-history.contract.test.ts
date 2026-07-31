// Drift guard between the `Plan` interface and the undo/redo differ.
//
// plan-history.ts is a second encoding of Plan. A field that reaches the plan
// without reaching the differ is an edit the user cannot undo, and nothing at
// runtime reports it — the symptom is a Ctrl+Z that silently does nothing for one
// control. Two directions are pinned here:
//
//   1. every Plan field has a HISTORY_FIELDS entry (the mapped type already fails
//      tsc, so this catches the reverse: a table entry for a field Plan dropped);
//   2. every table entry is actually read by diffPlans — MUTATIONS drives one real
//      mutation per field through diff -> apply -> invert, and through the
//      in-context apply (entryInContext is a fourth per-field switch, and tsc only
//      catches a MISSING case there, never a wrong one).
//
// When a Plan field is added: give it a HISTORY_FIELDS strategy, teach diffPlans,
// applyPatch and entryInContext, and add a MUTATIONS case. Do not weaken the
// assertions.

import { describe, expect, it } from "vitest";
import {
  applyPatch,
  applyPatchInContext,
  clonePlanState,
  diffPlans,
  HISTORY_FIELDS,
  invertPatch,
} from "./plan-history";
import { emptyPlan } from "./plan";
import type { Plan } from "./plan";
import { defaultPlan } from "../models/initial-state";
import { MODEL_IDS } from "../models";

/** One real mutation per Plan field, other than the field that identifies the
 *  document (a change there voids the history instead of being patched).
 *
 *  `elsewhere` is a SECOND mutation of the very keys the first one touches, to a
 *  third value: it stands for the edit someone else made while the patch was in
 *  flight, and the in-context apply must leave it alone. It has to move every key
 *  the patch carries, or the part it left standing lands and the assertion passes
 *  for the wrong reason. */
const MUTATIONS: Array<[Exclude<keyof Plan, "unreadNodes" | "modelId">, (p: Plan) => void, (p: Plan) => void]> = [
  [
    "sampleRate",
    (p) => {
      p.sampleRate = p.sampleRate === 48000 ? 96000 : 48000;
    },
    (p) => {
      p.sampleRate = 176400;
    },
  ],
  [
    "positions",
    (p) => {
      p.positions.ch1 = { x: 123, y: 456 };
    },
    (p) => {
      p.positions.ch1 = { x: 7, y: 8 };
    },
  ],
  [
    "connections",
    (p) => {
      p.connections = [...p.connections, { from: "ch1:out", to: "bus.mix2:in", kind: "send", params: { level: -6 } }];
    },
    (p) => {
      p.connections = [...p.connections, { from: "ch1:out", to: "bus.mix2:in", kind: "send", params: { level: -24 } }];
    },
  ],
  [
    "nodeParams",
    (p) => {
      p.nodeParams.ch1 = { ...p.nodeParams.ch1, hpf: true, hpfFreq: 120 };
    },
    (p) => {
      p.nodeParams.ch1 = { ...p.nodeParams.ch1, hpf: true, hpfFreq: 200 };
    },
  ],
  [
    "nodeNames",
    (p) => {
      p.nodeNames.ch1 = "SNARE";
    },
    (p) => {
      p.nodeNames.ch1 = "KICK";
    },
  ],
  [
    "nodeColors",
    (p) => {
      p.nodeColors.ch1 = "#33cc99";
    },
    (p) => {
      p.nodeColors.ch1 = "#ff8800";
    },
  ],
  [
    "hidden",
    (p) => {
      p.hidden = [...p.hidden, "ch2"];
    },
    (p) => {
      p.hidden = [...p.hidden, "ch3"];
    },
  ],
  [
    "notes",
    (p) => {
      p.notes.ch1 = "kick in, gate on";
    },
    (p) => {
      p.notes.ch1 = "hats, gate off";
    },
  ],
  [
    "noteCollapsed",
    (p) => {
      p.notes.ch1 = "kick in";
      p.noteCollapsed = [...p.noteCollapsed, "ch1"];
    },
    (p) => {
      p.notes.ch1 = "hats";
      p.noteCollapsed = [...p.noteCollapsed, "ch2"];
    },
  ],
];

describe("the history differ covers the whole Plan", () => {
  it("HISTORY_FIELDS names exactly the Plan fields a new plan carries", () => {
    expect(
      Object.keys(HISTORY_FIELDS).sort(),
      "a Plan field is not taught to the history differ — add a HISTORY_FIELDS strategy, teach diffPlans / applyPatch, and add a MUTATIONS case",
    ).toEqual(Object.keys(emptyPlan("URX44V")).sort());
  });

  it("MUTATIONS covers every field except the document identity", () => {
    const covered = MUTATIONS.map(([field]) => field).sort();
    const expected = Object.entries(HISTORY_FIELDS)
      .filter(([, strategy]) => strategy !== "document")
      .map(([field]) => field)
      .sort();
    expect(covered, "a HISTORY_FIELDS entry has no MUTATIONS case, so nothing proves the differ reads it").toEqual(
      expected,
    );
  });

  it.each(MUTATIONS)("round-trips a %s change through diff -> apply -> invert", (field, mutate) => {
    const before = defaultPlan("URX44V");
    const after = clonePlanState(before);
    mutate(after);

    const patch = diffPlans(before, after);
    expect(patch.length, `${field} produced no patch — diffPlans does not read it`).toBeGreaterThan(0);

    // toStrictEqual, not toEqual: toEqual ignores keys whose value is undefined, so
    // it would pass on the resurrected husk this design forbids.
    const plan = clonePlanState(before);
    applyPatch(plan, patch);
    expect(plan, `${field} did not reach the after state`).toStrictEqual(after);
    applyPatch(plan, invertPatch(patch));
    expect(plan, `${field} did not come back`).toStrictEqual(clonePlanState(before));
  });

  it.each(MUTATIONS)("applies a %s patch only where its own before-state still stands", (field, mutate, elsewhere) => {
    const before = defaultPlan("URX44V");
    const after = clonePlanState(before);
    mutate(after);
    const patch = diffPlans(before, after);

    // In context: the whole patch lands, exactly as applyPatch would have placed it.
    const own = clonePlanState(before);
    applyPatchInContext(own, patch);
    expect(own, `${field} did not land against its own before-state`).toStrictEqual(after);

    // Out of context: someone moved the same keys after the patch was taken, and
    // that authorship is what must not be overwritten.
    const moved = clonePlanState(before);
    elsewhere(moved);
    const untouched = clonePlanState(moved);
    applyPatchInContext(moved, patch);
    expect(moved, `${field} overwrote a value authored after the patch was taken`).toStrictEqual(untouched);
  });

  it("is deterministic for every model's factory plan", () => {
    for (const id of MODEL_IDS) {
      const before = defaultPlan(id);
      const after = clonePlanState(before);
      after.nodeParams.ch1 = { ...after.nodeParams.ch1, hpf: true };
      expect(diffPlans(before, after)).toEqual(diffPlans(before, after));
    }
  });

  it("reports no change between a factory plan and its own clone, for every model", () => {
    for (const id of MODEL_IDS) {
      const plan = defaultPlan(id);
      expect(diffPlans(plan, clonePlanState(plan)), `${id} diffs against itself`).toEqual([]);
    }
  });
});
