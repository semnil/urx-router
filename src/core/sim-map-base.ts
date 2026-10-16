// The shapes and helpers every part of the SIM table shares: what an edit made on the SIM
// writes, what a binding answers, and the node-id spelling the simulator uses for a strip.
// The table itself is assembled in sim-map.ts from the parts that use these.

import type { NodeParams, Plan } from "./plan";

export type SimValue = number | string | boolean;

/** What an edit made on the SIM writes, in the terms of the funnel that takes it. */
export type SimEdit =
  | { kind: "node"; id: string; patch: NodeParams; written?: readonly string[]; defaults?: readonly string[] }
  | {
      kind: "send";
      from: string;
      to: string;
      patch: { level?: number; pan?: number; tap?: "pre" | "post"; on?: boolean; oscL?: boolean; oscR?: boolean };
    }
  | { kind: "name"; id: string; name: string }
  | { kind: "color"; id: string; color: string | null }
  /** Draw a wire from an output port to an input port, replacing what the input takes alone.
   *  `tap` draws it from the channel's Rec Point tap. */
  | { kind: "connect"; from: string; to: string; tap?: boolean }
  | { kind: "disconnect"; from: string; to: string }
  | { kind: "rate"; rate: number }
  /** The value written is the one the plan already holds: taken, and nothing changes. */
  | { kind: "none" }
  /** Several edits applied in order as one change, where one choice on the LCD takes more
   *  than one gesture on the board. */
  | { kind: "steps"; steps: readonly SimEdit[] };

/** The edit for a value the plan already holds. */
export const UNCHANGED: SimEdit = { kind: "none" };

/** A refusal: the edit is not taken, and the SIM puts the value back. */
export interface SimRefusal {
  refused: string;
}

export interface SimBinding {
  read(plan: Plan): SimValue | undefined;
  /** Absent for a value the SIM shows and does not edit. */
  write?(plan: Plan, value: SimValue): SimEdit | SimRefusal;
  /** The labels an enumeration takes, in the simulator's spelling. */
  values?: readonly SimValue[];
  /** Other paths that read the same plan value, and so move with this one. */
  moves?: readonly string[];
}

export const isRefusal = (r: SimEdit | SimRefusal): r is SimRefusal => "refused" in r;

/** The simulator's id of a strip, from the plan's node id. */
export function simStripId(nodeId: string): string {
  return nodeId === "bus.fx1" ? "fx1" : nodeId === "bus.fx2" ? "fx2" : nodeId;
}

/** The simulator's name of a send's destination, from the plan's bus id. */
export function simSendTarget(busId: string): string {
  return busId === "bus.fx1" ? "fx1" : busId === "bus.fx2" ? "fx2" : busId;
}

export const isMonoChannel = (id: string): boolean => /^ch\d+$/.test(id);
export const isStereoChannel = (id: string): boolean => /^ch_\d+_\d+$/.test(id);
export const isFx = (id: string): boolean => id === "bus.fx1" || id === "bus.fx2";
export const isMasterBus = (id: string): boolean => id === "bus.stereo" || id === "bus.mix1" || id === "bus.mix2";

export const MAIN = "bus.stereo";
export const SEND_TARGETS = ["bus.mix1", "bus.mix2", "bus.fx1", "bus.fx2"] as const;

export const num = (v: SimValue): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const bool = (v: SimValue): boolean | null => (typeof v === "boolean" ? v : null);
export const refused = (why: string): SimRefusal => ({ refused: why });

export function np(plan: Plan, id: string): NodeParams {
  return plan.nodeParams[id] ?? {};
}

/** A node param read straight, with what an absent key stands for. */
export function nodeValue(id: string, key: keyof NodeParams, absent: SimValue, kind: "number" | "boolean"): SimBinding {
  return {
    read: (plan) => (np(plan, id)[key] as SimValue | undefined) ?? absent,
    write: (_plan, v) => {
      const value = kind === "number" ? num(v) : bool(v);
      return value === null ? refused("value") : { kind: "node", id, patch: { [key]: value } as NodeParams };
    },
  };
}

/** A field of an object-valued node param (`gate`, `comp`, `ducker`, …), read straight. */
export function groupValue(id: string, group: keyof NodeParams, field: string, kind: "number" | "boolean"): SimBinding {
  return {
    read: (plan) => (np(plan, id)[group] as Record<string, SimValue> | undefined)?.[field],
    write: (plan, v) => {
      const value = kind === "number" ? num(v) : bool(v);
      if (value === null) return refused("value");
      const held = (np(plan, id)[group] ?? {}) as Record<string, unknown>;
      return {
        kind: "node",
        id,
        patch: { [group]: { ...held, [field]: value } } as NodeParams,
        written: [`${String(group)}.${field}`],
      };
    },
  };
}

/** An enumeration the plan holds as an index into `labels`, the simulator's spelling of each. */
export function enumValue(
  labels: readonly string[],
  read: (plan: Plan) => number | undefined,
  write: (plan: Plan, index: number) => SimEdit | SimRefusal,
): SimBinding {
  return {
    values: labels,
    read: (plan) => {
      const index = read(plan);
      return index === undefined ? undefined : labels[index];
    },
    write: (plan, v) => {
      const index = typeof v === "string" ? labels.indexOf(v) : -1;
      return index < 0 ? refused("value") : write(plan, index);
    },
  };
}
