// Which of the LCD simulator's controls the SIM view holds shut, and why. The simulator draws a
// held control with a padlock and the reason as its tooltip, and takes no edit through it.
import type { DeviceModel } from "../models/types";
import type { Plan } from "./plan";
import { nodeRateDisabled } from "./constraints";
import { insertDrivenPaths } from "./sim-map-processors";

export type SimLockTarget =
  { kind: "path"; path: string } | { kind: "screen"; id: string } | { kind: "op"; op: (typeof UNIT_OPS)[number] };

export interface SimLockSpec {
  target: SimLockTarget;
  reason: string;
}

/** The reasons a lock gives, in the language on screen. */
export interface SimLockReasons {
  /** A SETUP > GENERAL setting the unit takes from its own panel alone. */
  unitOnly: string;
  /** A value the unit does not take from the link. */
  notAccepted: string;
  /** The unit's own operations: scenes, the card, the recorder and playback. */
  unitOp: string;
  /** The sampling frequency while the device link is held. */
  rateLinked: string;
  /** The recorder's Track Count while Live sync is up. */
  trackCountLive: string;
  /** An FX 2 send at a rate that takes FX 2 out. */
  fx2Rate: string;
  /** An insert effect's value the insert screen holds shut for the effect's current values. */
  deviceDriven: string;
}

/** Whether the device link is held, and whether Live sync is up. */
export interface SimLockState {
  linked: boolean;
  live: boolean;
}

/** The SETUP > GENERAL screens of settings the app neither reads nor writes: the operation mode,
 *  Software Integration and the unit's clock. */
export const UNIT_ONLY_SCREENS = ["setup.mode", "setup.integration", "setup.datetime.set"] as const;

/** Every operation of the unit's own the simulator can ask for. */
export const UNIT_OPS = [
  "scene.recall",
  "scene.store",
  "scene.protect",
  "scene.delete",
  "settings.save",
  "settings.load",
  "card.insert",
  "card.eject",
  "card.format",
  "card.test",
  "card.delete",
  "card.rename",
  "card.newFolder",
  "recorder.arm",
  "recorder.record",
  "recorder.pause",
  "recorder.stop",
  "playback.start",
  "playback.pause",
  "playback.stop",
] as const;

/** The locks for `plan` on `model`, given the paths the SIM table binds. */
export function simLocks(
  model: DeviceModel,
  plan: Plan,
  paths: Iterable<string>,
  state: SimLockState,
  reasons: SimLockReasons,
): SimLockSpec[] {
  const out: SimLockSpec[] = [];
  for (const id of UNIT_ONLY_SCREENS) out.push({ target: { kind: "screen", id }, reason: reasons.unitOnly });
  for (const op of UNIT_OPS) out.push({ target: { kind: "op", op }, reason: reasons.unitOp });
  out.push({ target: { kind: "path", path: "sd.usbStorage" }, reason: reasons.unitOp });
  if (state.linked) out.push({ target: { kind: "screen", id: "setup.rate" }, reason: reasons.rateLinked });
  const fx2Out = model.nodes.some((n) => n.id === "bus.fx2") && nodeRateDisabled("bus.fx2", plan.sampleRate);
  for (const path of paths) {
    // A channel's send into an FX bus: while Live sync is up PRE / POST is the unit's own, as on the
    // CONSOLE and in the Inspector, and FX 2 leaves with the rate.
    const send = /\.send\.(fx1|fx2)\.(on|level|pre|balance)$/.exec(path);
    if (send && send[2] === "pre" && state.live)
      out.push({ target: { kind: "path", path }, reason: reasons.notAccepted });
    else if (send && send[1] === "fx2" && fx2Out) out.push({ target: { kind: "path", path }, reason: reasons.fx2Rate });
    if (path === "sd.trackCount" && state.live)
      out.push({ target: { kind: "path", path }, reason: reasons.trackCountLive });
  }
  for (const path of insertDrivenPaths(model, plan))
    out.push({ target: { kind: "path", path }, reason: reasons.deviceDriven });
  return out;
}
