// Why an undo or redo entry is held back rather than applied, judged on the plan it would
// leave behind.
//
// Lifted out of main.ts so the decision is drivable without booting the app: the states it
// refuses — +48V and Hi-Z both on, an input holding two sources, STREAMING holding none, and
// during Live sync an HPF frequency the control link cannot take — are ones the board and the
// Inspector never produce, so a case can only reach them by handing this the plan an entry
// would leave.

import type { DeviceModel } from "../models/types";
import { parseRef } from "../models/types";
import type { Plan } from "../core/plan";
import { jackName, phantomHiZNewlyBothOn } from "../core/input-lock";
import { wireShapeBroken } from "../core/routing";
import { hpfFreqLeftOut } from "../core/control/translate";
import { formatHz } from "../core/control/fx-effect";
import { t } from "../i18n";

/** The status line an entry earns instead of being applied, or null when it may apply.
 *  `labelOf` names a node the way the board does. `live` is whether a Live sync session is up:
 *  the session sends what the plan holds, and an HPF frequency outside the control link's
 *  window is one it cannot send, so an entry that would put one there is held back rather than
 *  leaving the plan and the unit apart. Offline the plan keeps such a value. */
export function undoRefusal(
  model: DeviceModel,
  plan: Plan,
  after: Plan,
  labelOf: (id: string) => string,
  live = false,
): string | null {
  const jacks = phantomHiZNewlyBothOn(model, plan, after).map((j) => jackName(model, after, j, labelOf));
  if (jacks.length) return t().status.undoPhantomHiZ(jacks.join(", "));
  const receivers = wireShapeBroken(model, plan, after).map((to) => labelOf(parseRef(to).nodeId));
  if (receivers.length) return t().status.undoWireShape(receivers.join(", "));
  if (!live) return null;
  const moved = hpfFreqLeftOut(model, after).filter(({ node, hz }) => plan.nodeParams[node]?.hpfFreq !== hz);
  return moved.length
    ? t().status.undoHpfFreq(moved.map(({ node, hz }) => `${labelOf(node)} (${formatHz(hz)})`).join(", "))
    : null;
}
