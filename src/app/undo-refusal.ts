// Why an undo or redo entry is held back rather than applied, judged on the plan it would
// leave behind.
//
// Lifted out of main.ts so the decision is drivable without booting the app: the states it
// refuses — +48V and Hi-Z both on, an input holding two sources, STREAMING holding none —
// are ones the board and the Inspector never produce, so a case can only reach them by
// handing this the plan an entry would leave.

import type { DeviceModel } from "../models/types";
import { parseRef } from "../models/types";
import type { Plan } from "../core/plan";
import { phantomHiZNewlyBothOn } from "../core/input-lock";
import { wireShapeBroken } from "../core/routing";
import { t } from "../i18n";

/** The status line an entry earns instead of being applied, or null when it may apply.
 *  `labelOf` names a node the way the board does. */
export function undoRefusal(
  model: DeviceModel,
  plan: Plan,
  after: Plan,
  labelOf: (id: string) => string,
): string | null {
  const channels = phantomHiZNewlyBothOn(model, plan, after).map(labelOf);
  if (channels.length) return t().status.undoPhantomHiZ(channels.join(", "));
  const receivers = wireShapeBroken(model, plan, after).map((to) => labelOf(parseRef(to).nodeId));
  return receivers.length ? t().status.undoWireShape(receivers.join(", ")) : null;
}
