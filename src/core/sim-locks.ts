// Which of the LCD simulator's controls the SIM view holds shut, and why. The simulator draws a
// held control with a padlock and the reason as its tooltip, and takes no edit through it. Only
// what the app cannot do is held this way — a value it does not write, a function it does not
// carry, a state it cannot read. A control the unit itself holds still or hides is left to the
// simulator, which draws it as the unit does.
import { INTEGRATION_GLASS_PATHS } from "./control/daw-integration";

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
  /** The sampling frequency during Live sync while Follow USB is on. */
  rateFollowUsb: string;
  /** The recorder's Track Count while Live sync is up. */
  trackCountLive: string;
  /** SETUP > Software Integration while no session holds a unit a compatible DAW holds. */
  integrationOff: string;
}

/** Whether the device link is held, whether Live sync is up, and what the session knows of the rate
 *  and Follow USB. */
export interface SimLockState {
  linked: boolean;
  live: boolean;
  /** Whether the session takes a rate chosen on the LCD: Live sync whose scope carries the rate,
   *  with Follow USB off. */
  rateOpen: boolean;
  /** Whether Follow USB may be what holds the rate during Live sync: on, or not yet read. */
  rateFollowUsb: boolean;
  /** Whether the unit is known to have Follow USB on. */
  followUsbOn: boolean;
}

/** The SETUP > GENERAL screens of settings the app neither reads nor writes: the operation mode and
 *  the unit's clock. */
export const UNIT_ONLY_SCREENS = ["setup.mode", "setup.datetime.set"] as const;

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

/** The locks for the paths the SIM table binds. */
export function simLocks(paths: Iterable<string>, state: SimLockState, reasons: SimLockReasons): SimLockSpec[] {
  const out: SimLockSpec[] = [];
  for (const id of UNIT_ONLY_SCREENS) out.push({ target: { kind: "screen", id }, reason: reasons.unitOnly });
  // Software Integration's values are the session's, and whether a compatible DAW holds the unit is
  // read only while Live sync is up: the screen and, for a screen already open, its two sends.
  if (!state.live)
    for (const target of [
      { kind: "screen", id: "setup.integration" } as const,
      ...INTEGRATION_GLASS_PATHS.map((path) => ({ kind: "path", path }) as const),
    ])
      out.push({ target, reason: reasons.integrationOff });
  for (const op of UNIT_OPS) out.push({ target: { kind: "op", op }, reason: reasons.unitOp });
  out.push({ target: { kind: "path", path: "sd.usbStorage" }, reason: reasons.unitOp });
  // While Follow USB is on the unit takes no rate from its own screen either, which the simulator
  // shows from the Follow USB it is given.
  if (state.linked && !state.rateOpen && !state.followUsbOn)
    out.push({
      target: { kind: "screen", id: "setup.rate" },
      reason: state.rateFollowUsb ? reasons.rateFollowUsb : reasons.rateLinked,
    });
  for (const path of paths) {
    // A channel's PRE / POST into an FX bus: while Live sync is up it is the unit's own, as on the
    // CONSOLE and in the Inspector.
    if (/\.send\.(fx1|fx2)\.pre$/.test(path) && state.live)
      out.push({ target: { kind: "path", path }, reason: reasons.notAccepted });
    if (path === "sd.trackCount" && state.live)
      out.push({ target: { kind: "path", path }, reason: reasons.trackCountLive });
  }
  return out;
}
