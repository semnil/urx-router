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
export type ParamEncoding = "level" | "gain" | "pan" | "bool";

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
  /** Input channel head-amp (HA) gain (-16 … +70 dB). */
  HA_GAIN: { id: 1, axis: "input", encoding: "gain" },
  /** Output (mix) fader level. */
  OUT_FADER: { id: 674, axis: "output", encoding: "level" },
  /** Output (mix) EQ ON. */
  OUT_EQ_ON: { id: 591, axis: "output", encoding: "bool" },
  /** Monitor level (y = monitor 0..3). */
  MONITOR_LEVEL: { id: 724, axis: "global", encoding: "level" },
  /** STEREO master ON (y = 0). */
  STEREO_MASTER_ON: { id: 582, axis: "global", encoding: "bool" },
} as const satisfies Record<string, ParamSpec>;

export type ParamName = keyof typeof PARAMS;
