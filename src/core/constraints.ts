// Sample-rate-dependent feature limits. Transcribed from device-model.md
// ("Sample-rate-dependent constraints"): above 96 kHz the insert FX and the FX2
// bus are unavailable, and the stereo channels' EQ drops out at 176.4 / 192 kHz.
// Phase 2 surfaces these as warnings only; it does not forbid the connections
// themselves. Language-agnostic — the UI maps codes to messages.

import { parseRef } from "../models/types";
import type { DeviceModel } from "../models/types";
import { isStereoChannel } from "./control/translate";
import type { Plan } from "./plan";
import { directOutTarget } from "./routing";

/** Selectable rates in Hz (44.1 kHz … 192 kHz). */
export const SAMPLE_RATES = [44100, 48000, 88200, 96000, 176400, 192000];

export const DEFAULT_SAMPLE_RATE = 48000;

export type RateWarning = "insFx" | "stereoEq" | "fx2";

export interface RateConstraints {
  warnings: RateWarning[];
  /** Node ids to badge as unavailable at the current rate. */
  disabledNodes: string[];
}

const FX2_NODE = "bus.fx2";

/** Rate above which the >96 kHz feature drops (INS FX, FX2, stereo EQ) kick in. */
const HI_RATE_HZ = 96000;

// The stereo channels' EQ is inert at 176.4 / 192 kHz — the block diagram flags the
// CH 5/6-11/12 EQ as "Disabled when sample rate is 176.4 kHz or 192 kHz". Mono
// channel and output-bus EQ are unaffected. Callers force the control OFF and lock
// it at those rates; the plan value is left intact so lowering the rate restores it.
export function channelEqUnavailable(nodeId: string, sampleRate: number): boolean {
  return isStereoChannel(nodeId) && sampleRate > HI_RATE_HZ;
}

export function rateConstraints(model: DeviceModel, sampleRate: number): RateConstraints {
  const warnings: RateWarning[] = [];
  const disabledNodes: string[] = [];
  const has = (id: string): boolean => model.nodes.some((n) => n.id === id);

  // Above 96 kHz (i.e. 176.4 / 192 kHz) the insert FX, FX2 and stereo-channel EQ
  // drop out.
  if (sampleRate > HI_RATE_HZ) {
    warnings.push("insFx");
    // The stereo channels' EQ goes inert (see channelEqUnavailable). The strip still
    // passes audio — only its EQ dies — so this is a text warning, not a dimmed node.
    if (model.nodes.some((n) => n.kind === "channel" && isStereoChannel(n.id))) warnings.push("stereoEq");
    if (has(FX2_NODE)) {
      warnings.push("fx2");
      disabledNodes.push(FX2_NODE);
    }
  }
  return { warnings, disabledNodes };
}

// True when `channelId` is a stereo channel whose Ducker is on. The Ducker sits
// post-fader on the main path, so a PRE (pre-fader) send taps ahead of it and is
// not ducked — the inspector notes this on such a send.
export function channelDuckerOn(model: DeviceModel, plan: Plan, channelId: string): boolean {
  return model.nodes.some(
    (n) => n.kind === "ducker" && n.attachTo === channelId && plan.nodeParams[n.id]?.duckerOn === true,
  );
}

// Channels whose Ducker is ON while the channel is also tapped straight to a USB
// direct out (USB MAIN / SUB). That tap is the channel Rec Point, which the block
// diagram places ahead of the fader and Ducker, so the ducked signal never reaches
// the USB output — a silent surprise on a live output worth flagging (route via a
// STEREO / MIX bus instead). microSD Rec is deliberately excluded: recording the
// dry (pre-Ducker) signal is a standard workflow, and the Rec Point control already
// makes that tap an explicit choice, so a standing warning there would be noise.
// Returns the affected host-channel ids (the UI resolves them to labels).
export function duckerBypassWarnings(model: DeviceModel, plan: Plan): string[] {
  const hosts: string[] = [];
  for (const node of model.nodes) {
    if (node.kind !== "ducker" || !node.attachTo) continue;
    if (plan.nodeParams[node.id]?.duckerOn !== true) continue;
    const host = node.attachTo;
    const tapped = plan.connections.some(
      (c) => parseRef(c.from).nodeId === host && directOutTarget(model, c.from, c.to) === "usb",
    );
    if (tapped) hosts.push(host);
  }
  return hosts;
}

/** Human label for a rate, e.g. 44100 → "44.1 kHz". */
export function formatRate(sampleRate: number): string {
  return `${sampleRate / 1000} kHz`;
}
