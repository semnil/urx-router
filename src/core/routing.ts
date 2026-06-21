// Connection constraint engine. A wire is legal only when the DeviceModel
// declares a matching rule, and single-input receivers (selectors / patches)
// reject a second wire.

import { isSingleInput, parseRef } from "../models/types";
import type { DeviceModel, RoutingRule } from "../models/types";
import type { Plan } from "./plan";
import { hasConnection } from "./plan";

// Language-agnostic failure codes. The UI maps these to localized messages so
// core stays free of any i18n dependency.
export type ConnectError = "noRule" | "duplicate" | "singleInput";

export interface ConnectResult {
  ok: boolean;
  reason?: ConnectError;
}

function findRule(model: DeviceModel, from: string, to: string): RoutingRule | undefined {
  return model.rules.find((rule) => rule.from === from && rule.to === to);
}

export function ruleKind(model: DeviceModel, from: string, to: string): RoutingRule["kind"] | undefined {
  return findRule(model, from, to)?.kind;
}

/** Whether this route is a structural wire that the user may not remove. */
export function isFixedConnection(model: DeviceModel, from: string, to: string): boolean {
  return findRule(model, from, to)?.fixed === true;
}

// Whether a send carries a PRE/POST tap: a send's PRE/POST is taken relative to
// the STEREO main-fader level, so only the STEREO main-fader paths (CH / FX
// channel → STEREO, which ARE that reference) carry no tap. Every other send
// (-> MIX / FX) does. This is independent of `fixed`: the FX channel → MIX sends
// are fixed (non-removable routing) yet still expose a PRE/POST tap.
export function sendHasTap(model: DeviceModel, from: string, to: string): boolean {
  return ruleKind(model, from, to) === "send" && parseRef(to).nodeId !== "bus.stereo";
}

// Whether a route carries a per-send ON switch (the SEND_ON of a CH/FX -> MIX/FX
// send, or the MIX -> STEREO "TO ST"). Every tapped send has one; so does the fixed
// MIX -> STEREO sendSwitch. The fixed CH/FX -> STEREO main-fader paths do not (they
// are the channel/return fader itself). Lets the UI ask the topology rather than
// re-deriving it from tap + kind proxies.
export function sendHasOn(model: DeviceModel, from: string, to: string): boolean {
  if (sendHasTap(model, from, to)) return true;
  return isFixedConnection(model, from, to) && ruleKind(model, from, to) === "sendSwitch";
}

export function canConnect(model: DeviceModel, plan: Plan, from: string, to: string): ConnectResult {
  const rule = findRule(model, from, to);
  if (!rule) return { ok: false, reason: "noRule" };
  if (hasConnection(plan, from, to)) return { ok: false, reason: "duplicate" };
  // A single-input receiver rejects a second single-input (source/patch) wire.
  // Summing / switch sends to the same port are ignored here, so a bus keeps
  // accepting them.
  if (isSingleInput(rule.kind) && plan.connections.some((c) => c.to === to && isSingleInput(c.kind))) {
    return { ok: false, reason: "singleInput" };
  }
  return { ok: true };
}

/** The mono channel that shares its input source with `nodeId`, if any. */
export function partnerChannel(model: DeviceModel, nodeId: string): string | undefined {
  for (const [a, b] of model.channelPairs) {
    if (a === nodeId) return b;
    if (b === nodeId) return a;
  }
  return undefined;
}

/** The primary (odd, first-listed) channel of the pair containing `nodeId`, or
 *  null when it is not part of a pair. Pair-level state (Signal Type, PAN/BAL)
 *  lives on the primary. */
export function pairPrimary(model: DeviceModel, nodeId: string): string | null {
  for (const [a, b] of model.channelPairs) if (a === nodeId || b === nodeId) return a;
  return null;
}

/** Input-port refs that the given output port may currently connect to. */
export function legalTargets(model: DeviceModel, plan: Plan, from: string): Set<string> {
  const targets = new Set<string>();
  for (const rule of model.rules) {
    if (rule.from !== from) continue;
    if (canConnect(model, plan, from, rule.to).ok) targets.add(rule.to);
  }
  return targets;
}

/** Output-port refs that may currently connect into the given input port. */
export function legalSources(model: DeviceModel, plan: Plan, to: string): Set<string> {
  const sources = new Set<string>();
  for (const rule of model.rules) {
    if (rule.to !== to) continue;
    if (canConnect(model, plan, rule.from, to).ok) sources.add(rule.from);
  }
  return sources;
}
