// vd protocol value layer: address building and value encoding for the URX
// Device Center broker. This is the pure, device-independent backbone of live
// control — it turns plan-domain values (dB, pan -100..+100, on/off) into the
// integers the broker expects, and back. Transport (the WebSocket client) and
// the plan→command translation build on top of this. Language-agnostic.
//
// Encodings were established by reverse-engineering the broker's /vd/parameters
// and /vd/table responses (see reference/.local/control-protocol-research.md §12):
//   level: signed int16 centi-dB (dB×100); -32768 is the -∞ (off) sentinel; max +1000 (+10 dB).
//   pan:   signed ±63 (L63 … C=0 … R63).
//   bool:  0 / 1.
// Parameter addresses are "{param_id}:{x}:{y}" where x is 0 except for EQ bands
// and y is the instance index (input ch 0..11, output 0..7, or a fixed slot).

import { LEVEL_MAX_DB, LEVEL_MIN_DB } from "../plan";

/** The broker's -∞ / off sentinel for level (centi-dB) parameters. */
export const VD_LEVEL_OFF = -32768;
/** Highest level the device accepts: +10.00 dB. */
export const VD_LEVEL_MAX = 1000;
/** Pan extent on the device: ±63 (full L … full R). */
export const VD_PAN_MAX = 63;

// HA gain is one param (id 1) but its usable range depends on the input type:
// analog preamp channels (A.Gain) run -8 … +70 dB, digital channels (D.Gain)
// -24 … +24 dB. Encoded as centi-dB like level but with no -∞ sentinel.
export const A_GAIN_MIN_DB = -8;
export const A_GAIN_MAX_DB = 70;
export const D_GAIN_MIN_DB = -24;
export const D_GAIN_MAX_DB = 24;

// Monitor level uses the level_gain table down to -96 dB (lower floor than the
// channel fader): -∞ then -96.0 … +10.0 dB. The slider's bottom notch
// (MONITOR_OFF_DB, just under -96) is the -∞ / off position.
export const MONITOR_MIN_DB = -96;
export const MONITOR_MAX_DB = 10;
export const MONITOR_OFF_DB = -96.5;

/** Plan pan range, matching the inspector slider (-100 … +100). */
export const PAN_MIN = -100;
export const PAN_MAX = 100;

// HPF cutoff frequency (param 26): broker value is Hz×10 (the 0.1 Hz unit shared
// with EQ frequency). Range 40 … 120 Hz, default 80 Hz, 20 Hz steps — i.e. the
// five detents 40/60/80/100/120 Hz (confirmed by live scan: broker 400 … 1200).
export const HPF_FREQ_MIN_HZ = 40;
export const HPF_FREQ_MAX_HZ = 120;
export const HPF_FREQ_STEP_HZ = 20;
export const HPF_FREQ_DEFAULT_HZ = 80;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Plan dB → broker centi-dB. The plan floor (LEVEL_MIN_DB) reads as -∞ in the UI
 * and maps to the device's off sentinel; everything else is dB×100, clamped to
 * the device ceiling.
 */
export function levelToVd(db: number): number {
  if (db <= LEVEL_MIN_DB) return VD_LEVEL_OFF;
  return clamp(Math.round(db * 100), VD_LEVEL_OFF + 1, VD_LEVEL_MAX);
}

/** Broker centi-dB → plan dB. The off sentinel maps back to the plan floor. */
export function vdToLevel(value: number): number {
  if (value <= VD_LEVEL_OFF) return LEVEL_MIN_DB;
  return clamp(value / 100, LEVEL_MIN_DB, LEVEL_MAX_DB);
}

/** Plan pan (-100 … +100) → broker ±63. */
export function panToVd(pan: number): number {
  const p = clamp(pan, PAN_MIN, PAN_MAX);
  return clamp(Math.round((p / PAN_MAX) * VD_PAN_MAX), -VD_PAN_MAX, VD_PAN_MAX);
}

/** Broker ±63 → plan pan (-100 … +100). */
export function vdToPan(value: number): number {
  return clamp(Math.round((value / VD_PAN_MAX) * PAN_MAX), PAN_MIN, PAN_MAX);
}

// HA gain converters clamp to the union of the analog/digital ranges; the UI
// slider enforces the tighter per-type bounds.
const GAIN_MIN_DB = D_GAIN_MIN_DB; // -24, the lower of the two
const GAIN_MAX_DB = A_GAIN_MAX_DB; // +70, the higher of the two

/** Plan HA gain dB → broker centi-dB (no -∞). */
export function gainToVd(db: number): number {
  return clamp(Math.round(db * 100), GAIN_MIN_DB * 100, GAIN_MAX_DB * 100);
}

/** Broker centi-dB → plan HA gain dB. */
export function vdToGain(value: number): number {
  return clamp(Math.round(value / 100), GAIN_MIN_DB, GAIN_MAX_DB);
}

/** Plan monitor dB → broker centi-dB. Below -96 dB is the -∞ (off) sentinel. */
export function monitorLevelToVd(db: number): number {
  if (db < MONITOR_MIN_DB) return VD_LEVEL_OFF;
  return clamp(Math.round(db * 100), MONITOR_MIN_DB * 100, VD_LEVEL_MAX);
}

/** Broker centi-dB → plan monitor dB. The off sentinel maps to the slider floor. */
export function vdToMonitorLevel(value: number): number {
  if (value <= VD_LEVEL_OFF) return MONITOR_OFF_DB;
  return clamp(value / 100, MONITOR_MIN_DB, MONITOR_MAX_DB);
}

/** Plan HPF frequency (Hz) → broker 0.1 Hz units. */
export function freqToVd(hz: number): number {
  return clamp(Math.round(hz * 10), HPF_FREQ_MIN_HZ * 10, HPF_FREQ_MAX_HZ * 10);
}

/** Broker 0.1 Hz units → plan HPF frequency (Hz). */
export function vdToFreq(value: number): number {
  return clamp(Math.round(value / 10), HPF_FREQ_MIN_HZ, HPF_FREQ_MAX_HZ);
}

/** On/off → broker 0/1. */
export function boolToVd(on: boolean): number {
  return on ? 1 : 0;
}

/** Broker value → on/off (anything non-zero is on). */
export function vdToBool(value: number): boolean {
  return value !== 0;
}

/** Build a parameter address "{param_id}:{x}:{y}". x is 0 outside EQ bands. */
export function vdAddr(paramId: number, y: number, x = 0): string {
  return `${paramId}:${x}:${y}`;
}

/** A single value-set request: the broker REST-style uri plus its payload. */
export interface VdSetRequest {
  uri: string;
  data: { current_value: number };
}

/** Build a value-set request for a parameter instance. */
export function vdSet(paramId: number, y: number, value: number, x = 0): VdSetRequest {
  return {
    uri: `/vd/parameters/${vdAddr(paramId, y, x)}?operation=value`,
    data: { current_value: value },
  };
}
