// Which values a confirmed write lets the plan take back, lifted out of the entry so it is
// drivable without booting the app — the decision has three inputs and two of them are plans,
// which is exactly the shape a case has to be able to hand it.
//
// The write path sends the value a control admits, so a plan holding anything else names a
// setting the unit is not at from the moment such a write lands, and `comparePlan` cannot
// report it: it compares the normalised value too and finds the device agreeing.

import type { Plan } from "../core/plan";
import type { ParamRangeProblem } from "../core/plan-validate";
import { paramRangeProblems } from "../core/plan-validate";
import { paramRangeAddrs } from "../core/control/translate";
import type { DeviceModel } from "../models/types";

/** The stored value a problem was reported against, read back out of a plan. */
function storedNow(plan: Plan, p: ParamRangeProblem): unknown {
  const fx = plan.nodeParams[p.node]?.fxEffect;
  if (!fx) return undefined;
  return p.where === "field" ? (fx as unknown as Record<string, unknown>)[p.key] : fx.params?.[p.key];
}

/**
 * The values the plan may take back after a converge, given the addresses the device confirmed.
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
  return problems.filter(
    (p, i) =>
      p.action === "bound" && addrs[i] !== undefined && confirmed.has(addrs[i]!) && storedNow(live, p) === p.stored,
  );
}
