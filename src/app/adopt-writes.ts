// Which values a confirmed write lets the plan take back, lifted out of the entry so it is
// drivable without booting the app — the decision has three inputs and two of them are plans,
// which is exactly the shape a case has to be able to hand it.
//
// The write path sends the value a control admits, so a plan holding anything else names a
// setting the unit is not at from the moment such a write lands, and `comparePlan` cannot
// report it: it compares the normalised value too and finds the device agreeing.

import type { Plan } from "../core/plan";
import type { ParamRangeProblem } from "../core/plan-validate";
import { applyParamRange, paramRangeProblems } from "../core/plan-validate";
import { cmdAddr, paramRangeAddrs, planToCommandOrigins, planToCommands } from "../core/control/translate";
import { nodeParamContestPath } from "../core/plan-history";
import type { DeviceModel } from "../models/types";

/** The stored value a problem was reported against, read back out of a plan. */
function storedNow(plan: Plan, p: ParamRangeProblem): unknown {
  const np = plan.nodeParams[p.node];
  if (p.where === "node")
    return p.key
      .split(".")
      .reduce<unknown>(
        (v, k) => (v !== null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined),
        np,
      );
  const fx = np?.fxEffect;
  if (!fx) return undefined;
  return p.where === "field" ? (fx as unknown as Record<string, unknown>)[p.key] : fx.params?.[p.key];
}

/**
 * The node-param bounds among `leaves` that the device's confirmation covers.
 *
 * A leaf's addresses are the ones whose command took its value from that leaf
 * (`planToCommandOrigins`), so a value the emit sends to every linked instance names each of
 * them, and a shared address another owner's command won names none. Every one of them has to
 * be confirmed. And the bound has to be what was SENT there: the plan holding it emits the same
 * value at each of those addresses as the plan the converge ran against. A leaf the load bounds
 * to a narrower window than the write does (a gain, the oscillator level, the HPF frequency)
 * passes it only where the encoder's own clamp lands on the bound; elsewhere the unit holds the
 * value the write let through.
 */
function confirmedNodeLeaves(
  model: DeviceModel,
  sent: Plan,
  leaves: ParamRangeProblem[],
  confirmed: ReadonlySet<number>,
): Set<ParamRangeProblem> {
  const out = new Set<ParamRangeProblem>();
  if (!leaves.length) return out;
  const addrsOf = new Map<string, number[]>();
  for (const [addr, origin] of planToCommandOrigins(model, sent)) {
    if (typeof origin !== "string") continue;
    const list = addrsOf.get(origin);
    if (list) list.push(addr);
    else addrsOf.set(origin, [addr]);
  }
  const sentAt = new Map(planToCommands(model, sent).map((c) => [cmdAddr(c), c.vdValue]));
  for (const p of leaves) {
    const addrs = addrsOf.get(nodeParamContestPath(p.node, p.key)) ?? [];
    if (!addrs.length || !addrs.every((a) => confirmed.has(a))) continue;
    const bounded: Plan = {
      ...sent,
      nodeParams: { ...sent.nodeParams, [p.node]: structuredClone(sent.nodeParams[p.node]!) },
    };
    applyParamRange(bounded, [p]);
    const after = new Map(planToCommands(model, bounded).map((c) => [cmdAddr(c), c.vdValue]));
    if (addrs.every((a) => after.get(a) === sentAt.get(a))) out.add(p);
  }
  return out;
}

/**
 * The values the plan may take back after a converge, given the addresses the device confirmed:
 * an FX channel's effect parameter, and any node-param leaf the write bounds — an insert-FX
 * engine raw a device read stored as the unit reported it is the one a plan reaches here with.
 *
 * `sent` is the plan the converge ran against and `live` the plan the values would be written
 * into. They are the same object on the write path and DIFFERENT on the live one, which clones
 * before its await — and the difference is not cosmetic: an address means a different key under
 * a different effect type (slot 10 is the delay LPF and Rev.R3's Diffusion), so resolving the
 * join against `live` answers with whatever type is selected by the time the answer is used.
 * Every address here is therefore resolved against `sent`, the plan those addresses came from.
 *
 * Applying them to `live` then needs its own condition, since the two plans may disagree about
 * the value as well as the type: a key is taken back only where `live` still holds what `sent`
 * held. Anything else moved after the write went out, and the device's confirmation is about a
 * value the plan no longer names.
 *
 * BOUND only. A drop removes the key, and the load path splits the two for a reason its own
 * comment gives — "now read as the nearest value it can send" is false of a value that was
 * discarded. No input reaching here produces one today, since the load path repairs every
 * document and a device read yields finite numbers; the filter stands because that is a
 * property of `readback.ts` rather than a guarantee.
 */
export function confirmedAdoptions(
  model: DeviceModel,
  sent: Plan,
  live: Plan,
  confirmed: ReadonlySet<number>,
): ParamRangeProblem[] {
  if (!confirmed.size) return [];
  const problems = paramRangeProblems(sent);
  const addrs = paramRangeAddrs(model, sent, problems);
  const unmoved = (p: ParamRangeProblem): boolean => p.action === "bound" && storedNow(live, p) === p.stored;
  const leaves = confirmedNodeLeaves(
    model,
    sent,
    problems.filter((p) => p.where === "node" && unmoved(p)),
    confirmed,
  );
  return problems.filter(
    (p, i) => unmoved(p) && (leaves.has(p) || (addrs[i] !== undefined && confirmed.has(addrs[i]!))),
  );
}
