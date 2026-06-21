// Factory initial state for URX22, INFERRED from the captured URX44V defaults
// (initial-urx44v.ts) — URX22 has no device capture yet. The mapping rule:
//   - URX22 has 2 mono channels (CH1/2) instead of 4, and its 4 stereo channels
//     are CH3/4, 5/6, 7/8, 9/10 (build.ts shifts the stereo numbering with the
//     mono count). Stereo defaults are copied by POSITION among the stereo group,
//     so URX22 CH3/4 <- URX44V CH5/6, CH5/6 <- CH7/8, CH7/8 <- CH9/10, CH9/10 <- CH11/12.
//   - No LINE OUT and no microSD on URX22, so the MONITOR 2 -> LINE OUT default
//     patch is dropped and no SD nodes are seeded.
//   - Hi-Z lives on CH2 (HI_Z_CHANNELS in translate.ts), so only CH2 carries hiZ.
// Values not affected by the model differences mirror URX44V verbatim. Treat the
// whole file as an unverified estimate until a real URX22 reset can be captured.

import type { NodeParams, PlanConnection } from "../core/plan";
import { SSMCS_INITIAL } from "../core/plan";

const EQ_FLAT = (): NodeParams["eqBands"] => [
  { on: true, q: 0.71, freq: 125, gain: 0, type: 1 },
  { on: true, q: 0.71, freq: 1000, gain: 0 },
  { on: true, q: 0.71, freq: 4000, gain: 0 },
  { on: true, q: 0.71, freq: 10000, gain: 0, type: 1 },
];

const monoChannel = (hiZ?: boolean): NodeParams => ({
  on: true,
  gain: -8,
  hpf: false,
  hpfFreq: 80,
  phantom: false,
  clipSafe: false,
  ...(hiZ === undefined ? {} : { hiZ }),
  compEqType: 0,
  recPoint: 4,
  phase: false,
  gateOn: false,
  compOn: false,
  eqOn: true,
  eqOneKnob: { on: false, type: 0, level: 0 },
  eqBands: EQ_FLAT(),
  gate: { threshold: -50, range: -56, attack: 20.17, hold: 15.3, decay: 150.2 },
  comp: { threshold: -18, ratio: 3, gain: 2, attack: 34.58, release: 218, knee: 1, autoMakeup: false, oneKnob: false, oneKnobLevel: 0 },
  ssmcs: SSMCS_INITIAL,
  insertFx: -1,
});

const stereoChannel = (gain: number): NodeParams => ({
  on: true,
  gain,
  phaseL: false,
  phaseR: false,
  eqOn: true,
  eqOneKnob: { on: false, type: 0, level: 0 },
  eqBands: EQ_FLAT(),
});

const outputBus = (): NodeParams => ({
  level: 0,
  insertFx: -1,
  eqOn: true,
  eqOneKnob: { on: false, type: 0, level: 0 },
  eqBands: EQ_FLAT(),
});

const ducker = (): NodeParams => ({
  duckerOn: false,
  ducker: { threshold: -40, range: -24, attack: 20.17, decay: 1000 },
});

export const URX22_NODE_PARAMS: Record<string, NodeParams> = {
  ch1: monoChannel(),
  ch2: monoChannel(false),
  ch_3_4: stereoChannel(0),
  ch_5_6: stereoChannel(-14),
  ch_7_8: stereoChannel(0),
  ch_9_10: stereoChannel(-14),
  "bus.stereo": { ...outputBus(), on: true },
  "bus.mix1": { ...outputBus(), busType: 0 },
  "bus.mix2": { ...outputBus(), busType: 0 },
  // FX channels ship ON at the factory (param 338, def 1), like URX44V.
  "bus.fx1": { on: true },
  "bus.fx2": { on: true },
  "out.ducker1": ducker(),
  "out.ducker2": ducker(),
  "out.ducker3": ducker(),
  "out.ducker4": ducker(),
  "bus.mon1": { level: 0, cueInterrupt: true, mono: false, phonesLevel: 2 },
  "bus.mon2": { level: 0, cueInterrupt: true, mono: false, phonesLevel: 2 },
  "bus.osc": { osc: { on: false, level: -14, mode: 0, freq: 1000, width: 0.1, interval: 1 } },
  // STREAMING DELAY factory state (off, 1.00 ms, 30 fps), inferred from URX44V.
  "bus.stream": { delay: { on: false, time: 1, frameRate: 5 } },
};

const CHANNELS = ["ch1", "ch2", "ch_3_4", "ch_5_6", "ch_7_8", "ch_9_10"];

// CH SETTING colors, mirroring the URX44V capture by analogy (URX22 has no real
// capture): channels and FX buses Blue, MIX and STREAMING buses Orange, STEREO
// master Red. Hex are the COLOR_PALETTE entries (Blue 0 / Orange 1 / Red 6).
export const URX22_NODE_COLORS: Record<string, string> = {
  ...Object.fromEntries(CHANNELS.map((id) => [id, "#4a78c0"])),
  "bus.fx1": "#4a78c0",
  "bus.fx2": "#4a78c0",
  "bus.mix1": "#e8913a",
  "bus.mix2": "#e8913a",
  "bus.stream": "#e8913a",
  "bus.stereo": "#d9534f",
};

// CH SETTING names, mirroring the URX44V capture by analogy: mono channels ship
// "ch 1"/"ch 2", stereo channels their pair label "3/ 4"…, buses their short
// labels.
export const URX22_NODE_NAMES: Record<string, string> = {
  ch1: "ch 1",
  ch2: "ch 2",
  ch_3_4: "3/ 4",
  ch_5_6: "5/ 6",
  ch_7_8: "7/ 8",
  ch_9_10: "9/10",
  "bus.fx1": "FX 1",
  "bus.fx2": "FX 2",
  "bus.mix1": "MIX1",
  "bus.mix2": "MIX2",
  "bus.stream": "Strm",
  "bus.stereo": "ST",
};

const stereoSend = (from: string): PlanConnection => ({
  from: `${from}:out`,
  to: "bus.stereo:in",
  kind: "send",
  params: { level: 0, pan: 0 },
});

const mixSend = (from: string, mix: string): PlanConnection => ({
  from: `${from}:out`,
  to: `${mix}:in`,
  kind: "send",
  params: { level: -96.5, pan: 0, tap: "post" },
});

const fxSend = (from: string, fx: string): PlanConnection => ({
  from: `${from}:out`,
  to: `${fx}:in`,
  kind: "send",
  params: { level: -96.5, tap: "post" },
});

export const URX22_CONNECTIONS: PlanConnection[] = [
  ...CHANNELS.map(stereoSend),
  { from: "bus.fx1:out", to: "bus.stereo:in", kind: "send", params: { level: -96.5 } },
  { from: "bus.fx2:out", to: "bus.stereo:in", kind: "send", params: { level: -96.5 } },
  // FX channel → MIX sends ship ON at the factory (at -∞), like URX44V. Inferred.
  { from: "bus.fx1:out", to: "bus.mix1:in", kind: "send", params: { level: -96.5, pan: 0, tap: "post" } },
  { from: "bus.fx1:out", to: "bus.mix2:in", kind: "send", params: { level: -96.5, pan: 0, tap: "post" } },
  { from: "bus.fx2:out", to: "bus.mix1:in", kind: "send", params: { level: -96.5, pan: 0, tap: "post" } },
  { from: "bus.fx2:out", to: "bus.mix2:in", kind: "send", params: { level: -96.5, pan: 0, tap: "post" } },
  ...CHANNELS.flatMap((ch) => [
    mixSend(ch, "bus.mix1"),
    mixSend(ch, "bus.mix2"),
    fxSend(ch, "bus.fx1"),
    fxSend(ch, "bus.fx2"),
  ]),
  { from: "ch1:out", to: "out.ducker1:in", kind: "key" },
  { from: "ch1:out", to: "out.ducker2:in", kind: "key" },
  { from: "ch1:out", to: "out.ducker3:in", kind: "key" },
  { from: "ch1:out", to: "out.ducker4:in", kind: "key" },
  { from: "bus.osc:out", to: "bus.stereo:in", kind: "sendSwitch", params: { oscL: true, oscR: true } },
  { from: "in.micline_1_2:out", to: "ch1:in", kind: "source" },
  { from: "in.micline_1_2:out", to: "ch2:in", kind: "source" },
  // Stereo sources, copied by position from URX44V (see header): CH3/4=AUX,
  // CH5/6=USB MAIN A, CH7/8=USB MAIN B, CH9/10=USB MAIN C.
  { from: "in.aux:out", to: "ch_3_4:in", kind: "source" },
  { from: "in.usbmain_a:out", to: "ch_5_6:in", kind: "source" },
  { from: "in.usbmain_b:out", to: "ch_7_8:in", kind: "source" },
  { from: "in.usbmain_c:out", to: "ch_9_10:in", kind: "source" },
  { from: "bus.stereo:out", to: "bus.stream:in", kind: "source" },
  { from: "bus.stereo:out", to: "out.usbmain_a:in", kind: "patch" },
  { from: "bus.stereo:out", to: "out.usbmain_b:in", kind: "patch" },
  { from: "bus.stereo:out", to: "out.usbmain_c:in", kind: "patch" },
  { from: "bus.stereo:out", to: "out.usbsub:in", kind: "patch" },
  { from: "bus.stereo:out", to: "bus.mon1:in", kind: "source" },
  { from: "bus.stereo:out", to: "bus.mon2:in", kind: "source" },
  { from: "bus.stereo:out", to: "out.main:in", kind: "patch" },
];
