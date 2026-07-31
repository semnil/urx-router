// Reversible plan patches: the unit of undo / redo.
//
// This file is a second encoding of the `Plan` interface. A field that reaches
// the plan without reaching the differ is an edit the user cannot undo, and
// nothing at runtime would say so. Two guards stand in for that: HISTORY_FIELDS
// is a mapped type over `keyof Plan`, so tsc fails when a field is added, and
// plan-history.contract.test.ts drives one real mutation per table entry through
// diff -> apply -> invert, so a table entry the differ does not actually read
// fails too.
//
// A patch is a diff, not a snapshot, and its entries are keyed as finely as the
// edit funnels write: per node-parameter key, per wire, per record entry. That is
// load-bearing rather than tidy. While Live sync is up, device-side operations
// land in the same plan object outside any edit funnel (follow's applyDirect), so
// a whole-plan restore would rewind an untouched channel the operator had just
// moved on the hardware, and the next live flush would write that stale value
// back over them. An inverse patch only ever writes the keys the app authored.
//
// Entries within one patch are independent by construction (one per field + key),
// so apply order does not matter and inverting only swaps each entry's direction.

import type { NodePos, Plan, PlanConnection } from "./plan";
import { removeConnection } from "./plan";
import { parseRef } from "../models/types";

/** How one Plan field takes part in a patch. Documentation and a tsc trip-wire:
 *  the differ below names its fields explicitly, and the contract test fails when
 *  a table entry is not actually diffed. */
type Strategy =
  /** Identifies the document, never patched: a change means the history is void. */
  | "document"
  /** A single comparable value, carried whole. */
  | "scalar"
  /** A string array with set semantics, carried whole (order is not meaning). */
  | "stringSet"
  /** Record keyed by node id whose values the funnels replace wholesale. */
  | "recordSlot"
  /** Record keyed by node id, diffed per key of the value record. */
  | "recordKeys"
  /** The connection array, keyed by (from, to). */
  | "wires";

export const HISTORY_FIELDS: { [K in Exclude<keyof Plan, "unreadNodes">]: Strategy } = {
  modelId: "document",
  sampleRate: "scalar",
  positions: "recordSlot",
  connections: "wires",
  nodeParams: "recordKeys",
  nodeNames: "recordSlot",
  nodeColors: "recordSlot",
  hidden: "stringSet",
  notes: "recordSlot",
  noteCollapsed: "stringSet",
};

/** Presence plus value. A tag rather than `value: undefined`, because the two are
 *  distinct plan states: `'gain' in np` stays true after structuredClone of an
 *  explicit undefined, and scene-scope.ts branches on Object.keys().length, so a
 *  resurrected husk changes what a scene-scoped save writes. */
export type Slot<V> = { present: false } | { present: true; value: V };

/** Per-key slots inside one NodeParams / ConnParams record. */
export type KeySlots = Record<string, Slot<unknown>>;

/** A wire's presence plus the index it held, so undoing a delete puts it back
 *  where it was rather than at the tail: the array's order is the wires' draw
 *  order and the order a saved plan serializes in. */
export type WireSlot = { present: false } | { present: true; value: PlanConnection; at: number };

export type PlanPatchEntry =
  | { field: "sampleRate"; before: number; after: number }
  | { field: "hidden" | "noteCollapsed"; before: string[]; after: string[] }
  | { field: "nodeNames" | "nodeColors" | "notes"; key: string; before: Slot<string>; after: Slot<string> }
  | { field: "positions"; key: string; before: Slot<NodePos>; after: Slot<NodePos> }
  | { field: "nodeParams"; key: string; before: KeySlots; after: KeySlots }
  | { field: "connections"; key: string; before: WireSlot; after: WireSlot }
  | { field: "connParams"; key: string; before: KeySlots; after: KeySlots }
  /** Whole-array fallback, emitted only when a plan holds two wires under one
   *  (from, to) — the keyed diff cannot address them apart, and dropping one would
   *  be an edit that silently cannot be undone. Unreachable through the UI. */
  | { field: "connectionsAll"; before: PlanConnection[]; after: PlanConnection[] };

export type PlanPatch = PlanPatchEntry[];

export type PatchField = PlanPatchEntry["field"];

/** What a patch names, derived without applying it. `fields` drives the reflect and
 *  the sample-rate refusal; `nodes` — the node ids its keys carry, both ends of a
 *  wire — names the subject on the status line when a patch touched exactly one. */
export interface PatchTouch {
  fields: Set<PatchField>;
  nodes: Set<string>;
}

/** How many undo entries are kept. Patches hold one gesture's keys, so the cap
 *  bounds an unbounded session rather than relieving memory pressure. */
export const MAX_ENTRIES = 100;

// A ref is "nodeId:portId", so NUL cannot occur in either half of a wire key.
const WIRE_SEP = "\u0000";

function wireKey(from: string, to: string): string {
  return `${from}${WIRE_SEP}${to}`;
}

/** The node ids a wire key names (source node, destination node). */
function wireNodes(key: string): string[] {
  return key
    .split(WIRE_SEP)
    .filter((ref) => ref.length > 0)
    .map((ref) => parseRef(ref).nodeId);
}

/** A clone of the plan's undoable state — everything except the transient device
 *  provenance, which is a Set, is never serialized, and only ever enters the plan
 *  through a readback rather than an edit. Rest-spread rather than a field list,
 *  so a field added to Plan reaches the baseline even before it reaches the differ. */
export function clonePlanState(plan: Plan): Plan {
  const { unreadNodes: _provenance, ...state } = plan;
  return structuredClone(state) as Plan;
}

// Structural equality over plan values. Hole-aware and own-key-aware, because both
// distinctions are real here: eqBands is written by index and stays sparse (a
// readback fills only the bands it read), and an explicit undefined key survives
// structuredClone while JSON.stringify drops it — so stringify would call a husk
// and a clean record equal. NaN compares equal to itself so a non-finite value
// (which the plan loader drops, but which a live edit could in principle produce)
// cannot make every commit report a change forever.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const arrA = Array.isArray(a);
  if (arrA !== Array.isArray(b)) return false;
  if (arrA) {
    const x = a as unknown[];
    const y = b as unknown[];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) {
      if (i in x !== i in y) return false;
      if (!deepEqual(x[i], y[i])) return false;
    }
    return true;
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  if (keys.length !== Object.keys(y).length) return false;
  for (const k of keys) {
    if (!Object.hasOwn(y, k)) return false;
    if (!deepEqual(x[k], y[k])) return false;
  }
  return true;
}

/** A slot for a value that is going into a patch — cloned here, and only here, so
 *  the entry cannot alias the plan it came from. Comparison never calls this: a diff
 *  over a plan that did not change would otherwise clone every value in it. */
function slotOf<V>(rec: Record<string, V> | undefined, key: string): Slot<V> {
  if (!rec || !Object.hasOwn(rec, key)) return { present: false };
  return { present: true, value: structuredClone(rec[key]) };
}

type AnyRecord = Record<string, unknown> | undefined;

/** Whether two records hold the same value under `key`, presence included. */
function sameAt(before: AnyRecord, after: AnyRecord, key: string): boolean {
  const inBefore = before !== undefined && Object.hasOwn(before, key);
  const inAfter = after !== undefined && Object.hasOwn(after, key);
  if (!inBefore || !inAfter) return inBefore === inAfter;
  return deepEqual(before![key], after![key]);
}

/** Every key either record holds, `after` first so the common case walks one array
 *  and adds nothing. */
function unionKeys(before: AnyRecord, after: AnyRecord): string[] {
  const afterKeys = after ? Object.keys(after) : [];
  if (!before) return afterKeys;
  const keys = afterKeys.slice();
  for (const key of Object.keys(before)) {
    if (!Object.hasOwn(after ?? {}, key)) keys.push(key);
  }
  return keys;
}

/** Per-key slots for the keys that differ between two value records; null when
 *  they hold the same keys with the same values. */
function diffKeys(before: AnyRecord, after: AnyRecord): [KeySlots, KeySlots] | null {
  const b: KeySlots = {};
  const a: KeySlots = {};
  let changed = false;
  for (const key of unionKeys(before, after)) {
    if (sameAt(before, after, key)) continue;
    b[key] = slotOf(before, key);
    a[key] = slotOf(after, key);
    changed = true;
  }
  return changed ? [b, a] : null;
}

/** Slot entries for one node-id-keyed record (positions / names / colors / notes). */
function diffRecordSlots(
  field: "positions" | "nodeNames" | "nodeColors" | "notes",
  before: AnyRecord,
  after: AnyRecord,
  out: PlanPatch,
): void {
  for (const id of unionKeys(before, after)) {
    if (sameAt(before, after, id)) continue;
    // NodePos and string share the same presence handling; the union is
    // discriminated by `field` for the consumer, not here.
    out.push({ field, key: id, before: slotOf(before, id), after: slotOf(after, id) } as PlanPatchEntry);
  }
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every((v) => seen.has(v));
}

/** Index the connection array by (from, to), keeping each wire's position; null
 *  when a side holds two wires under one key, which the keyed diff cannot address
 *  apart. */
function indexWires(conns: PlanConnection[]): Map<string, { conn: PlanConnection; at: number }> | null {
  const out = new Map<string, { conn: PlanConnection; at: number }>();
  for (const [at, conn] of conns.entries()) {
    const key = wireKey(conn.from, conn.to);
    if (out.has(key)) return null;
    out.set(key, { conn, at });
  }
  return out;
}

function wireSlot(hit: { conn: PlanConnection; at: number } | undefined): WireSlot {
  return hit ? { present: true, value: structuredClone(hit.conn), at: hit.at } : { present: false };
}

function diffWires(before: PlanConnection[], after: PlanConnection[], out: PlanPatch): void {
  const b = indexWires(before);
  const a = indexWires(after);
  if (!b || !a) {
    if (!deepEqual(before, after)) {
      out.push({ field: "connectionsAll", before: structuredClone(before), after: structuredClone(after) });
    }
    return;
  }
  for (const key of new Set([...b.keys(), ...a.keys()])) {
    const bh = b.get(key);
    const ah = a.get(key);
    // A presence change, or a kind change (kind is a function of (from, to) in the
    // routing rules, so only a hand-authored plan gets here) replaces the wire
    // whole, which covers a params change in the same entry.
    if (!bh || !ah || bh.conn.kind !== ah.conn.kind) {
      out.push({ field: "connections", key, before: wireSlot(bh), after: wireSlot(ah) });
      continue;
    }
    const slots = diffKeys(bh.conn.params as AnyRecord, ah.conn.params as AnyRecord);
    if (slots) out.push({ field: "connParams", key, before: slots[0], after: slots[1] });
  }
}

/** The minimal patch taking `before` to `after`; empty when they hold the same
 *  undoable state. A model change yields an empty patch: the two are different
 *  documents, and the caller resets the history rather than patching across them. */
export function diffPlans(before: Plan, after: Plan): PlanPatch {
  if (before.modelId !== after.modelId) return [];
  const out: PlanPatch = [];
  if (before.sampleRate !== after.sampleRate) {
    out.push({ field: "sampleRate", before: before.sampleRate, after: after.sampleRate });
  }
  for (const field of ["hidden", "noteCollapsed"] as const) {
    if (!sameStringSet(before[field], after[field])) {
      out.push({ field, before: [...before[field]], after: [...after[field]] });
    }
  }
  diffRecordSlots("positions", before.positions, after.positions, out);
  diffRecordSlots("nodeNames", before.nodeNames, after.nodeNames, out);
  diffRecordSlots("nodeColors", before.nodeColors, after.nodeColors, out);
  diffRecordSlots("notes", before.notes, after.notes, out);
  const bp = before.nodeParams ?? {};
  const ap = after.nodeParams ?? {};
  for (const id of new Set([...Object.keys(bp), ...Object.keys(ap)])) {
    const slots = diffKeys(bp[id] as AnyRecord, ap[id] as AnyRecord);
    if (slots) out.push({ field: "nodeParams", key: id, before: slots[0], after: slots[1] });
  }
  diffWires(before.connections, after.connections, out);
  return out;
}

/** The patch that undoes `patch`. Entries are independent, so only each entry's
 *  direction is swapped. */
export function invertPatch(patch: PlanPatch): PlanPatch {
  return patch.map((e) => ({ ...e, before: e.after, after: e.before }) as PlanPatchEntry);
}

export function patchTouch(patch: PlanPatch): PatchTouch {
  const fields = new Set<PatchField>();
  const nodes = new Set<string>();
  for (const e of patch) {
    fields.add(e.field);
    switch (e.field) {
      case "connections":
      case "connParams":
        for (const id of wireNodes(e.key)) nodes.add(id);
        break;
      case "connectionsAll":
        for (const c of [...e.before, ...e.after]) {
          nodes.add(parseRef(c.from).nodeId);
          nodes.add(parseRef(c.to).nodeId);
        }
        break;
      case "sampleRate":
      case "hidden":
      case "noteCollapsed":
        break;
      default:
        nodes.add(e.key);
    }
  }
  return { fields, nodes };
}

/** Write the patch's `after` side onto the plan, mutating it in place — the plan
 *  object is never replaced, because the graph, the console strips, the inspector
 *  closures and the MIDI bindings all hold the reference they were built with.
 *  Returns the entries whose target was not where the patch expected it (a wire
 *  removed since); each was applied by a fallback or skipped. */
export function applyPatch(plan: Plan, patch: PlanPatch): string[] {
  const missing: string[] = [];
  for (const e of patch) {
    switch (e.field) {
      case "sampleRate":
        plan.sampleRate = e.after;
        break;
      case "hidden":
      case "noteCollapsed":
        plan[e.field] = [...e.after];
        break;
      case "positions":
      case "nodeNames":
      case "nodeColors":
      case "notes": {
        const rec = plan[e.field] as Record<string, unknown>;
        if (e.after.present) rec[e.key] = structuredClone(e.after.value);
        else delete rec[e.key];
        break;
      }
      case "nodeParams": {
        const np = (plan.nodeParams[e.key] ??= {}) as Record<string, unknown>;
        applySlots(np, e.after);
        // An entry left empty is dropped rather than kept as a husk: absence is the
        // documented "use the device default" state, and a husk changes what a
        // scene-scoped save writes.
        if (!Object.keys(np).length) delete plan.nodeParams[e.key];
        break;
      }
      case "connections": {
        const found = plan.connections.findIndex((c) => wireKey(c.from, c.to) === e.key);
        if (!e.after.present) {
          if (found < 0) missing.push(`connections ${e.key}`);
          else {
            const [from, to] = e.key.split(WIRE_SEP);
            removeConnection(plan, from, to);
          }
          break;
        }
        // Re-created at the index it held, so the wires' draw order and a saved
        // plan's array order come back unchanged. A wire still present is replaced
        // where it sits, since the array may have shifted around it since.
        const wire = structuredClone(e.after.value);
        if (found >= 0) plan.connections[found] = wire;
        else plan.connections.splice(Math.min(e.after.at, plan.connections.length), 0, wire);
        break;
      }
      case "connParams": {
        const conn = plan.connections.find((c) => wireKey(c.from, c.to) === e.key);
        if (!conn) {
          missing.push(`connParams ${e.key}`);
          break;
        }
        const params = (conn.params ??= {}) as Record<string, unknown>;
        applySlots(params, e.after);
        if (!Object.keys(params).length) delete conn.params;
        break;
      }
      case "connectionsAll":
        plan.connections = structuredClone(e.after);
        break;
    }
  }
  return missing;
}

function applySlots(rec: Record<string, unknown>, slots: KeySlots): void {
  for (const [key, slot] of Object.entries(slots)) {
    if (slot.present) rec[key] = structuredClone(slot.value);
    else delete rec[key];
  }
}

/** The undo / redo stacks over a rolling baseline. Pure: no timers, no DOM, no
 *  device. The baseline is what a commit diffs against, and is re-taken by every
 *  operation that settles the plan — a device readback included, which is what
 *  keeps device-authored values out of the next entry. */
export class PlanHistoryStack {
  private baseline: Plan;
  private undoStack: PlanPatch[] = [];
  private redoStack: PlanPatch[] = [];

  constructor(
    plan: Plan,
    private readonly cap: number = MAX_ENTRIES,
  ) {
    this.baseline = clonePlanState(plan);
  }

  /** Re-take the baseline, keeping both stacks: the plan settled at values no
   *  entry should describe (a one-node device readback), while the entries already
   *  recorded still undo the edits they were taken for. */
  rebase(plan: Plan): void {
    this.baseline = clonePlanState(plan);
  }

  /** Re-take the baseline and drop both stacks: a different document, or every
   *  value re-authored by the device. */
  reset(plan: Plan): void {
    this.baseline = clonePlanState(plan);
    this.undoStack = [];
    this.redoStack = [];
  }

  /** Close an entry covering everything the plan gained since the last baseline.
   *  Returns the pushed patch, or null when nothing changed — a mis-grab that
   *  moved no value records nothing and leaves the redo stack alone. */
  record(plan: Plan): PlanPatch | null {
    if (this.baseline.modelId !== plan.modelId) {
      // loadPlan resets on a model change; this is the backstop, since a patch
      // across two documents names node ids the other model does not have.
      this.reset(plan);
      return null;
    }
    const patch = diffPlans(this.baseline, plan);
    this.baseline = clonePlanState(plan);
    if (!patch.length) return null;
    this.undoStack.push(patch);
    if (this.undoStack.length > this.cap) this.undoStack.shift();
    this.redoStack = [];
    return patch;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  depth(): { undo: number; redo: number } {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
  }

  /** The next entry to undo, without consuming it — so a refusal that inspects
   *  what the patch touches does not spend the entry. */
  peekUndo(): PlanPatch | null {
    return this.undoStack.at(-1) ?? null;
  }

  peekRedo(): PlanPatch | null {
    return this.redoStack.at(-1) ?? null;
  }

  /** Consume the next undo entry and return the patch to apply (its inverse). */
  takeUndo(): PlanPatch | null {
    const patch = this.undoStack.pop();
    if (!patch) return null;
    this.redoStack.push(patch);
    return invertPatch(patch);
  }

  /** Consume the next redo entry and return the patch to apply (as recorded). */
  takeRedo(): PlanPatch | null {
    const patch = this.redoStack.pop();
    if (!patch) return null;
    this.undoStack.push(patch);
    return patch;
  }
}
