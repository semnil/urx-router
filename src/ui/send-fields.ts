// Which per-send controls a connection shows, and what a wire with none of them
// says instead. Split out of inspector.ts: this is the row-ordering + visibility
// layer, and it is decided entirely by the routing rules and the destination
// bus's params — no DOM, and no message text (sendlessNote returns a catalog key
// so the module stays language-independent like core/*).

import type { ConnectionKind, DeviceModel } from "../models/types";
import { parseRef } from "../models/types";
import type { Plan } from "../core/plan";
import { directOutTarget, duckerKeySource, isBalLinkedPair, mixSendLocks, ruleKind, sendHasTap } from "../core/routing";
import { isAnalogOutput, isMonitorBus } from "../core/constraints";
import { fxChannelIndex, isStereoChannel } from "../core/control/translate";

export type ParamField = "level" | "pan" | "tap";

// Per-kind editable send parameters. Only summing sends carry LEVEL / PRE-POST /
// PAN per the block diagram (device-model.md §2); selectors and output patches
// are assignments without per-connection mix parameters. PRE-POST is further
// dropped for the fixed STEREO / FX-channel main paths (see sendHasTap). Ordered
// top-to-bottom as the device SEND TO screen reads it (ON — the wire itself — then
// PRE, Pan, Level); the fixed main path drops tap and so shows Pan then Level.
export const PARAM_FIELDS: Record<ConnectionKind, ParamField[]> = {
  send: ["tap", "pan", "level"],
  sendSwitch: [],
  source: [],
  patch: [],
  key: [],
  record: [],
};

// Whether a channel's send pan should read as a BALANCE: a native stereo channel,
// or a STEREO-linked MONO IN pair switched to BAL mode (Signal Type, PAN/BAL).
export function isBalanceChannel(model: DeviceModel, plan: Plan, id: string): boolean {
  return isStereoChannel(id) || fxChannelIndex(id) !== null || isBalLinkedPair(model, plan, id);
}

/** The send fields a wire shows, with the destination locks that decided them. A
 *  MIX 1 / MIX 2 destination governs them: FIXED bus type drops the LEVEL (fixed
 *  send level); Pan Link (VARI only) drops the PAN (it follows the source channel
 *  PAN). PRE/POST is taken against the channel's STEREO main-fader level, so the
 *  fixed STEREO / FX-channel main paths show LEVEL / PAN but no PRE/POST. */
export function sendFields(
  model: DeviceModel,
  plan: Plan,
  kind: ConnectionKind,
  from: string,
  to: string,
): { fields: ParamField[]; busFixed: boolean; panLinked: boolean } {
  const { busFixed, panLinked } = mixSendLocks(plan, parseRef(to).nodeId);
  const fields = PARAM_FIELDS[kind].filter(
    (f) => (f !== "tap" || sendHasTap(model, from, to)) && (f !== "level" || !busFixed) && (f !== "pan" || !panLinked),
  );
  return { fields, busFixed, panLinked };
}

/** The note a wire with no send parameters carries, as a message key. A USB direct
 *  out is a live output where the missing fader / Ducker is a surprise (route via a
 *  bus to include them); a microSD Rec tap records the Rec Point stage on purpose,
 *  so it points at Rec Point instead. A channel ducker key is the same pre-fader
 *  Rec Point tap, so the source channel's fader / mute do not move the trigger (a
 *  bus key is post-fader — no note). A patch into MAIN / LINE OUT says whether the
 *  path it takes can be switched to mono at all: MONO is the MONITOR bus's switch,
 *  so a STEREO / MIX / STREAMING patch has none and the note names the routing
 *  change that gets one. Anything else falls back to the generic note. */
export function sendlessNote(
  model: DeviceModel,
  from: string,
  to: string,
): "directOutTap" | "sdRecTap" | "duckerKeyTap" | "patchViaMonitor" | "patchNoMono" | "selectionOnly" {
  const directOut = directOutTarget(model, from, to);
  if (directOut === "usb") return "directOutTap";
  if (directOut === "sdRec") return "sdRecTap";
  if (ruleKind(model, from, to) === "patch" && isAnalogOutput(parseRef(to).nodeId))
    return isMonitorBus(parseRef(from).nodeId) ? "patchViaMonitor" : "patchNoMono";
  return duckerKeySource(model, from, to) === "channel" ? "duckerKeyTap" : "selectionOnly";
}
