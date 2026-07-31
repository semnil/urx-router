// Read-only probe over the module state the race harness cannot reach from outside
// (docs/{en,ja}/live-race-harness.md). Present only in a trace build — `TRACE` folds
// to a constant, so a plain build drops the whole module the way DEMO drops the
// control layer, and ci.yml greps the bundle to keep it dropped.
//
// It answers exactly the two questions the fake device's IPC log cannot:
//   - WHO wrote which plan key (invariant 13, authorship attribution). Every writer
//     samples through one call, and the delta is taken by the differ the undo stack
//     already uses — a key that reaches the plan without reaching that differ is an
//     edit the user cannot undo, so reusing it means the ledger and the undo entries
//     can never disagree about what a gesture touched.
//   - What the live snapshot HOLDS (invariant 3, snapshot poisoning in its general
//     form). A poisoned snapshot is one that records a value that was never sent;
//     the IPC log has the sends, so the missing half is the snapshot itself.
//
// Sampling is explicit rather than a Proxy: the plan is mutated in place by eight
// writers through paths that assign whole nodes, whole connection params and whole
// arrays, and a Proxy would report the assignment without knowing who made it.

import type { Plan } from "../core/plan";
import { clonePlanState, diffPlans, type PlanPatch } from "../core/plan-history";

/** Who a plan write is attributed to. The set is the writers the harness document
 *  names; "unknown" is a bug in the instrumentation, not a writer. */
export type WriteSource =
  | "ui"
  | "midi"
  | "refetch"
  | "follow-direct"
  | "follow-scoped"
  | "follow-full"
  | "device-action"
  | "undo"
  | "load"
  | "unknown";

export interface LedgerEntry {
  seq: number;
  /** ms since the probe was installed. */
  t: number;
  source: WriteSource;
  /** Plan field the differ named. */
  field: string;
  /** The differ's key within that field (a node id, a wire key); absent for scalars. */
  key?: string;
  /** The changed sub-keys, for the record-shaped fields. */
  subKeys?: string[];
}

export interface TraceProbeHooks {
  getPlan: () => Plan;
  /** The live snapshot as address → value, or null with no session. */
  liveSnapshot: () => Record<string, number> | null;
  /** Undo / redo depth, so a case can count entries without driving the UI. */
  depth: () => { undo: number; redo: number };
}

export interface TraceProbe {
  /** Take the delta since the last sample and attribute it to `source`. Returns the
   *  number of ledger entries added, so a caller can assert a gesture wrote nothing. */
  sample: (source: WriteSource) => number;
}

export function installTraceProbe(hooks: TraceProbeHooks): TraceProbe {
  const t0 = performance.now();
  const ledger: LedgerEntry[] = [];
  let seq = 0;
  let last = clonePlanState(hooks.getPlan());

  const record = (source: WriteSource, patch: PlanPatch): number => {
    const t = +(performance.now() - t0).toFixed(3);
    for (const e of patch) {
      const entry: LedgerEntry = { seq: ++seq, t, source, field: e.field };
      if ("key" in e) entry.key = e.key;
      if (e.field === "nodeParams" || e.field === "connParams") {
        // The union of both sides: a key that was removed is as much a write as one
        // that was added, and only one side carries it.
        entry.subKeys = [...new Set([...Object.keys(e.before), ...Object.keys(e.after)])].sort();
      }
      ledger.push(entry);
    }
    return patch.length;
  };

  const probe: TraceProbe = {
    sample: (source) => {
      const now = hooks.getPlan();
      const patch = diffPlans(last, now);
      last = clonePlanState(now);
      // A model change makes diffPlans return an empty patch by contract (the two
      // plans are different documents), so a load is recorded as one bare entry
      // rather than silently as nothing.
      if (!patch.length && source === "load") {
        ledger.push({ seq: ++seq, t: +(performance.now() - t0).toFixed(3), source, field: "plan" });
        return 1;
      }
      return record(source, patch);
    },
  };

  (window as unknown as { __urxTrace: unknown }).__urxTrace = {
    ledger,
    snapshot: () => hooks.liveSnapshot(),
    depth: () => hooks.depth(),
    sample: probe.sample,
    clear: () => {
      ledger.length = 0;
      last = clonePlanState(hooks.getPlan());
    },
  };
  return probe;
}
