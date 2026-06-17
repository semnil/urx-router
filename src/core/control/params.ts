// Catalog of confirmed URX44V control parameters. Each entry binds a semantic
// name to the broker's numeric param_id, the instance axis its y index runs over,
// and the value encoding (see vd.ts). Only parameters validated against the
// broker dump (reference/.local/control-protocol-research.md §12 / vd-derived-map.md)
// are listed here; inferred-but-unconfirmed ids are deliberately omitted so live
// control never writes a guessed address to hardware.

/**
 * Instance dimension a parameter's y index addresses:
 *   input  — mixer input channel, y = 0..11
 *   output — mixer output, y = 0..7
 *   global — a single fixed slot or small fixed set (e.g. monitor y = 0..3)
 */
export type ParamAxis = "input" | "output" | "global";

/** Value encoding, mapping to the converters in vd.ts. */
export type ParamEncoding = "level" | "gain" | "monitor" | "pan" | "bool" | "freq";

export interface ParamSpec {
  /** Broker param_id (first field of the "{id}:{x}:{y}" address). */
  id: number;
  axis: ParamAxis;
  encoding: ParamEncoding;
}

// Confirmed anchors. Validated: their ids match both the original sniff and the
// /vd/parameters descriptor (table_id + min/max/default).
export const PARAMS = {
  /** Input channel main fader → STEREO (level_gain, default 0 dB). */
  CH_FADER: { id: 139, axis: "input", encoding: "level" },
  /** Input channel ON / mute (default ON). */
  CH_ON: { id: 140, axis: "input", encoding: "bool" },
  /** Input channel PAN/BAL (±63). */
  CH_PAN: { id: 141, axis: "input", encoding: "pan" },
  /** Input channel HPF ON. */
  HPF_ON: { id: 25, axis: "input", encoding: "bool" },
  /** Input channel HPF cutoff frequency (40 … 120 Hz). Confirmed by live scan. */
  HPF_FREQ: { id: 26, axis: "input", encoding: "freq" },
  /** Input channel +48V phantom power (analog mic channels). Confirmed by live scan. */
  PHANTOM: { id: 0, axis: "input", encoding: "bool" },
  /** Input channel head-amp (HA) gain (-16 … +70 dB). */
  HA_GAIN: { id: 1, axis: "input", encoding: "gain" },
  /** Output (mix) fader level. */
  OUT_FADER: { id: 674, axis: "output", encoding: "level" },
  /** Output (mix) EQ ON. */
  OUT_EQ_ON: { id: 591, axis: "output", encoding: "bool" },
  /** Monitor level (y = monitor 0..3). Wider -96 dB floor than the fader. */
  MONITOR_LEVEL: { id: 724, axis: "global", encoding: "monitor" },
  /** STEREO master ON (y = 0). */
  STEREO_MASTER_ON: { id: 582, axis: "global", encoding: "bool" },
} as const satisfies Record<string, ParamSpec>;

export type ParamName = keyof typeof PARAMS;

// Digital-channel input gain (D.Gain) is NOT param 1 (the analog A.Gain): each
// stereo channel has its own dedicated, non-sequential param, written to both
// L/R instances (y = 0 and 1) which the device keeps linked. Keyed by node id so
// each model uses its own. Confirmed on URX44V by live scan (research §12.8);
// ch_5_6..9_10 assumed identical on URX44/URX22, and ch_3_4 (URX22 only) is an
// UNVERIFIED guess (extrapolated -4 from ch_5_6=9).
export const D_GAIN_PARAM: Record<string, number> = {
  ch_3_4: 5,
  ch_5_6: 9,
  ch_7_8: 13,
  ch_9_10: 17,
  ch_11_12: 15,
};

// Stereo channels use a SEPARATE device block from mono channels: a single
// fader / ON / pan param indexed by stereo-channel position (0..N), not the mono
// params 139/140/141. Encodings match (level_gain / onoff / ±63). The index is
// the channel's position among the model's stereo channels (so it shifts with
// the mono count — e.g. URX22's first stereo channel is index 0). HPF does not
// exist on these channels. Confirmed on URX44V (research §12.9); URX44/URX22 inferred.
export const STEREO_FADER = 266;
export const STEREO_ON = 267;
export const STEREO_PAN = 268;
