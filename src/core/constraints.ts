// Sample-rate-dependent feature limits. Transcribed from device-model.md
// ("Sample-rate-dependent constraints"): above 96 kHz the insert FX and the FX2
// bus are unavailable, and on models with HDMI the HDMI EQ is unavailable at
// 176.4 / 192 kHz. Phase 2 surfaces these as warnings only; it does not forbid
// the connections themselves. Language-agnostic — the UI maps codes to messages.

import type { DeviceModel } from "../models/types";

/** Selectable rates in Hz (44.1 kHz … 192 kHz). */
export const SAMPLE_RATES = [44100, 48000, 88200, 96000, 176400, 192000];

export const DEFAULT_SAMPLE_RATE = 48000;

export type RateWarning = "insFx" | "fx2" | "hdmiEq";

export interface RateConstraints {
  warnings: RateWarning[];
  /** Node ids to badge as unavailable at the current rate. */
  disabledNodes: string[];
}

const FX2_NODE = "bus.fx2";
const HDMI_NODE = "in.hdmi";

export function rateConstraints(model: DeviceModel, sampleRate: number): RateConstraints {
  const warnings: RateWarning[] = [];
  const disabledNodes: string[] = [];
  const has = (id: string): boolean => model.nodes.some((n) => n.id === id);

  // Above 96 kHz (i.e. 176.4 / 192 kHz) the insert FX and FX2 drop out.
  if (sampleRate > 96000) {
    warnings.push("insFx");
    if (has(FX2_NODE)) {
      warnings.push("fx2");
      disabledNodes.push(FX2_NODE);
    }
    if (has(HDMI_NODE)) warnings.push("hdmiEq");
  }
  return { warnings, disabledNodes };
}

/** Human label for a rate, e.g. 44100 → "44.1 kHz". */
export function formatRate(sampleRate: number): string {
  return `${sampleRate / 1000} kHz`;
}
