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
  /** The sampling frequency during Live sync under the Scene only device scope, which leaves the rate
   *  out. */
  rateScope: string;
  /** The sampling frequency during Live sync while Follow USB is on or not yet read. */
  rateFollowUsb: string;
  /** The recorder's Track Count while Live sync is up. */
  trackCountLive: string;
  /** SETUP > Software Integration while no session holds a unit a compatible DAW holds. */
  integrationOff: string;
  /** A SETUP > GENERAL setting the app writes, while Live sync is down. */
  setupOffline: string;
}

/** Whether the device link is held, whether Live sync is up, and what the session knows of the rate
 *  and Follow USB. */
export interface SimLockState {
  linked: boolean;
  live: boolean;
  /** Whether the session takes a rate chosen on the LCD: Live sync whose scope carries the rate,
   *  with Follow USB off. */
  rateOpen: boolean;
  /** Whether the session's device scope leaves the rate out (Scene only). */
  rateScope: boolean;
  /** Whether the unit is known to have Follow USB on. */
  followUsbOn: boolean;
}

/** Why a rate chosen in the app does not reach the unit: a link held by anything but a Live sync
 *  session, a session whose device scope leaves the rate out, and a session that does not know
 *  Follow USB to be off. */
export type RateHold = "link" | "scope" | "followUsb";

/** The hold on a rate chosen in the app, or null where it reaches the unit. The toolbar's rate, the
 *  LCD's Sampling Frequency and an undo / redo that would move the rate are held for the same one. */
export function rateHold(state: Pick<SimLockState, "linked" | "live" | "rateOpen" | "rateScope">): RateHold | null {
  if (!state.linked || state.rateOpen) return null;
  if (!state.live) return "link";
  return state.rateScope ? "scope" : "followUsb";
}

/** The tooltip the rate is held with, or null where it is not held. */
export function rateHoldReason(
  state: Pick<SimLockState, "linked" | "live" | "rateOpen" | "rateScope">,
  reasons: Pick<SimLockReasons, "rateLinked" | "rateScope" | "rateFollowUsb">,
): string | null {
  const hold = rateHold(state);
  if (hold === null) return null;
  return { link: reasons.rateLinked, scope: reasons.rateScope, followUsb: reasons.rateFollowUsb }[hold];
}

/** The SETUP > GENERAL screens of settings the app does not write: the operation mode, which a session
 *  reads and shows, and the unit's clock. */
export const UNIT_ONLY_SCREENS = ["setup.mode", "setup.datetime.set"] as const;

/** The SETUP > GENERAL screens of settings the app writes to the unit, during Live sync only. */
export const SETUP_WRITTEN_SCREENS = [
  "setup.language",
  "setup.brightness",
  "setup.udk",
  "setup.peripheral",
  "setup.power",
  "setup.datetime",
] as const;

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

/** The locks for the paths the SIM table binds and for `setupPaths`, the SETUP > GENERAL settings the
 *  app writes. */
export function simLocks(
  paths: Iterable<string>,
  setupPaths: Iterable<string>,
  state: SimLockState,
  reasons: SimLockReasons,
): SimLockSpec[] {
  const out: SimLockSpec[] = [];
  for (const id of UNIT_ONLY_SCREENS) out.push({ target: { kind: "screen", id }, reason: reasons.unitOnly });
  // The app writes the unit's SETUP > GENERAL settings over the Live sync session alone: the screens
  // and, for a screen already open when the session ends, their values.
  if (!state.live)
    for (const target of [
      ...SETUP_WRITTEN_SCREENS.map((id) => ({ kind: "screen", id }) as const),
      ...[...setupPaths].map((path) => ({ kind: "path", path }) as const),
    ])
      out.push({ target, reason: reasons.setupOffline });
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
  const rateHeld = state.followUsbOn ? null : rateHoldReason(state, reasons);
  if (rateHeld !== null) out.push({ target: { kind: "screen", id: "setup.rate" }, reason: rateHeld });
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
