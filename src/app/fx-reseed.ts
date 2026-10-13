// Which FX channels' EFFECT TYPE defaults a park leaves standing.
//
// An Inspector EFFECT TYPE selection puts the incoming type's factory values in the plan, which
// is what the unit holds once the type write refills the array. The park in front of that write
// reads the outgoing array and is handed those keys to leave standing. Lifted out of main.ts so
// the record's lifetime can be driven without a session: it protects exactly one park, the one
// in front of a type write that is still pending.

import type { Plan } from "../core/plan";
import { silentKey } from "../core/control/params";
import { fxTypeDefaults } from "../core/control/fx-effect";

/** The part of a park's scope that decides whether it stands in front of a head write. */
export interface ParkScope {
  only?: ReadonlySet<string>;
  keepHeads?: boolean;
}

/**
 * The FX parameter keys, per channel, this park leaves standing, and the records it spends.
 *
 * `reseeds` maps a channel to the type an Inspector selection put it on. A record is answered
 * only by the park in front of that channel's type write — `keepHeads`, with the channel's FX
 * family in `only` — and is spent there. A record no type write is pending for is dropped by
 * any park: the channel has left the type, or `typeSent` says the unit was last sent it, so no
 * refill follows. Every other record is left for its own park.
 */
export function takeFxReseeds(
  reseeds: Map<string, number>,
  plan: Plan,
  scope: ParkScope,
  typeSent: (nodeId: string, type: number) => boolean,
): Map<string, ReadonlySet<string>> {
  const keep = new Map<string, ReadonlySet<string>>();
  for (const [id, type] of reseeds) {
    const pending = plan.nodeParams[id]?.fxEffect?.type === type && !typeSent(id, type);
    const ahead = scope.keepHeads === true && scope.only?.has(silentKey("fx", id)) === true;
    if (pending && ahead) keep.set(id, new Set(fxTypeDefaults(undefined, type).keys));
    if (!pending || ahead) reseeds.delete(id);
  }
  return keep;
}
