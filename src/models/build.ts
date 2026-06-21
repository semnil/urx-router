// Generates a DeviceModel from per-model parameters. The node set and the
// routing rules below are a direct transcription of the official V1.2 block
// diagram (see docs/device-model.md). Keep the two in sync.

import { ref } from "./types";
import type {
  ConnectionKind,
  DeviceModel,
  DeviceNode,
  ModelId,
  NodeKind,
  Port,
  RoutingRule,
} from "./types";

export interface ModelParams {
  id: ModelId;
  name: string;
  /** Mono channel count (CH 1..monoCh). */
  monoCh: number;
  /** Stereo channel count (paired channels following the mono ones). */
  stereoCh: number;
  /** MIC/LINE combo input count. */
  micLine: number;
  /** USB DAW return/record channel count. */
  usbDaw: number;
  hasSD: boolean;
  hasHDMI: boolean;
  hasLineOut: boolean;
}

// Base layout column per node kind. Buses split across two columns by signal
// stage (see layoutCol below), so `bus` here is only the mix-bus column; outputs
// shift right to make room for the downstream derived-bus column.
const COL: Record<DeviceNode["column"], number> = {
  input: 0,
  channel: 1,
  bus: 2,
  output: 4,
  // Duckers sit in the channel column (hung under their parent), never a column
  // of their own; this entry exists only to satisfy the exhaustive Record type.
  ducker: 1,
};

// Monitor / streaming buses are fed only by the mix buses, so they sit downstream
// in their own column (3) instead of crowding the channel-to-bus convergence.
const DERIVED_BUSES = new Set(["bus.stream", "bus.mon1", "bus.mon2"]);

// Layout column index for a node. OSCILLATOR is a generator that feeds the mix
// buses, so it joins the channel column rather than the bus stage; this keeps
// every wire flowing strictly left-to-right.
const layoutCol = (node: Omit<DeviceNode, "pos">): number => {
  if (node.column === "bus") {
    if (node.id === "bus.osc") return COL.channel;
    return DERIVED_BUSES.has(node.id) ? 3 : COL.bus;
  }
  return COL[node.column];
};

const inPort = (): Port[] => [{ id: "in", label: "in", direction: "in" }];
const outPort = (): Port[] => [{ id: "out", label: "out", direction: "out" }];
const ioPort = (): Port[] => [
  { id: "in", label: "in", direction: "in" },
  { id: "out", label: "out", direction: "out" },
];

export function buildModel(p: ModelParams): DeviceModel {
  const nodes: DeviceNode[] = [];
  const rules: RoutingRule[] = [];
  // Row counter keyed by the numeric layout column, so the two bus columns and
  // the channel-shared OSCILLATOR each stack independently.
  const rowByCol = new Map<number, number>();

  function add(node: Omit<DeviceNode, "pos">): void {
    const col = layoutCol(node);
    const row = rowByCol.get(col) ?? 0;
    nodes.push({ ...node, pos: { col, row } });
    rowByCol.set(col, row + 1);
  }
  function r(from: string, to: string, kind: ConnectionKind, fixed = false): void {
    rules.push(fixed ? { from, to, kind, fixed } : { from, to, kind });
  }

  // --- Input sources -------------------------------------------------------
  // The device exposes MIC/LINE and USB DAW as fixed 2-channel pairs, so each is
  // one node here. The front mini jack is wired into the MIC/LINE 1 input path
  // and is not a separate selectable source. "All Input" / "All USB DAW" are
  // bulk-set actions (one tap rewrites every channel's source from a fixed
  // table), not selectable sources, so they are not input nodes.
  const inputs: string[] = [];
  const addInput = (id: string, label: string): void => {
    add({ id, kind: "input", label, column: "input", ports: outPort() });
    inputs.push(id);
  };
  for (let i = 1; i <= p.micLine; i += 2) addInput(`in.micline_${i}_${i + 1}`, `MIC/LINE ${i}/${i + 1}`);
  addInput("in.aux", "AUX IN");
  if (p.hasSD) addInput("in.sdplay", "microSD Playback");
  addInput("in.usbmain_a", "USB MAIN A");
  addInput("in.usbmain_b", "USB MAIN B");
  addInput("in.usbmain_c", "USB MAIN C");
  for (let i = 1; i <= p.usbDaw; i += 2) addInput(`in.usbdaw_${i}_${i + 1}`, `USB DAW ${i}/${i + 1}`);
  addInput("in.usbsub", "USB SUB");
  if (p.hasHDMI) addInput("in.hdmi", "HDMI (down-mix)");

  // --- Mixer channels ------------------------------------------------------
  // Mono channels are paired (CH1/2, CH3/4): selecting an input source on one
  // also fixes its partner (channelPairs drives that link in the UI).
  const channels: string[] = [];
  const channelPairs: [string, string][] = [];
  for (let n = 1; n <= p.monoCh; n++) {
    const id = `ch${n}`;
    add({ id, kind: "channel", label: `CH ${n}`, column: "channel", ports: ioPort() });
    channels.push(id);
  }
  for (let n = 1; n + 1 <= p.monoCh; n += 2) channelPairs.push([`ch${n}`, `ch${n + 1}`]);
  const stereoStart = p.monoCh + 1;
  for (let k = 0; k < p.stereoCh; k++) {
    const a = stereoStart + 2 * k;
    const b = a + 1;
    const id = `ch_${a}_${b}`;
    add({ id, kind: "channel", label: `CH ${a}/${b}`, column: "channel", ports: ioPort() });
    channels.push(id);
    // Each stereo channel carries one ducker hung directly below it; reserve the
    // next grid row so the default layout leaves room for that hanging node.
    // Graph.autoLayout reserves the same whole row (snap-to-ROW_GAP) so Arrange
    // on a fresh board moves nothing — keep the two in step.
    rowByCol.set(COL.channel, (rowByCol.get(COL.channel) ?? 0) + 1);
  }

  // --- Buses ---------------------------------------------------------------
  // `kind` defaults to "bus" but can differ from the "bus" layout column: the
  // OSCILLATOR is a signal source (kind "input") and the MONITORs are output
  // destinations (kind "output"), neither of which the device colors in CH
  // SETTING. Their kind drives the canvas rail color and hides the channel-only
  // name field, while column "bus" keeps their existing position.
  const addBus = (id: string, label: string, ports: Port[] = ioPort(), kind: NodeKind = "bus"): void =>
    add({ id, kind, label, column: "bus", ports });
  addBus("bus.stereo", "STEREO (MAIN)");
  addBus("bus.mix1", "MIX 1");
  addBus("bus.mix2", "MIX 2");
  addBus("bus.fx1", "FX 1");
  addBus("bus.fx2", "FX 2");
  // CUE is a temporary solo/monitor bus: its routing is wiped at power-off and
  // cannot hold a persistent assignment, so it is omitted as an editable node.
  addBus("bus.stream", "STREAMING");
  addBus("bus.mon1", "MONITOR 1", ioPort(), "output");
  addBus("bus.mon2", "MONITOR 2", ioPort(), "output");
  addBus("bus.osc", "OSCILLATOR", outPort(), "input"); // tone generator: output-only source

  // --- Outputs -------------------------------------------------------------
  const addOut = (id: string, label: string, sublabel?: string): void =>
    add({ id, kind: "output", label, sublabel, column: "output", ports: inPort() });
  addOut("out.main", "MAIN OUT");
  if (p.hasLineOut) addOut("out.line", "LINE OUT");
  // PHONES 1/2/front and HDMI THRU are fixed 1:1 passthroughs (no source
  // select); like DAW Rec they are omitted as editable nodes (see rules 7, 11).
  addOut("out.usbmain_a", "USB MAIN OUT A");
  addOut("out.usbmain_b", "USB MAIN OUT B");
  addOut("out.usbmain_c", "USB MAIN OUT C");
  addOut("out.usbsub", "USB SUB OUT");
  if (p.hasSD) addOut("out.sdrec", "microSD Rec");
  // Ducker key-source selectors (sidechain trigger): one per stereo channel. The
  // host stereo pair (shown in the sublabel and by the hung position) is the
  // node's identity, so the label needs no ordinal (see device-model.md).
  // Each is its own "ducker" kind and hangs under its parent channel (attachTo)
  // rather than living in the output column.
  for (let d = 1; d <= 4; d++) {
    const a = stereoStart + 2 * (d - 1);
    add({
      id: `out.ducker${d}`,
      kind: "ducker",
      label: "Ducker",
      sublabel: `CH ${a}/${a + 1} · Source`,
      column: "channel",
      ports: inPort(),
      attachTo: `ch_${a}_${a + 1}`,
    });
  }

  // --- Routing rules -------------------------------------------------------
  // 1. Each channel selects one input source.
  for (const ch of channels)
    for (const inp of inputs) r(ref(inp, "out"), ref(ch, "in"), "source");

  // 2. Channel -> bus sends (summing, with level/pan). Every send is fixed (always
  //    wired, non-removable): the device has no "remove this routing", only a
  //    per-send ON switch (SEND_ON = conn.params.on) and level. The send to STEREO
  //    is the channel's main fader path (outside the SEND blocks in the diagram, no
  //    PRE/POST); the MIX 1/2 and FX 1/2 sends carry LEVEL/PAN(BAL)/PRE-POST plus
  //    the ON toggle. So "wire present = SEND_ON" is gone — on/off lives in params.
  const sendBuses = ["bus.stereo", "bus.mix1", "bus.mix2", "bus.fx1", "bus.fx2"];
  for (const ch of channels)
    for (const b of sendBuses) r(ref(ch, "out"), ref(b, "in"), "send", true);

  // 3. FX channels -> STEREO / MIX buses. All are fixed (always wired): the device
  //    has no "remove this routing", only a per-send ON switch (SEND_ON) and level.
  //    The STEREO send is the FX main path (no PRE/POST); the MIX 1/2 sends carry
  //    LEVEL/BAL/PRE-POST plus an ON toggle (conn.params.on).
  for (const fx of ["bus.fx1", "bus.fx2"])
    for (const b of ["bus.stereo", "bus.mix1", "bus.mix2"]) r(ref(fx, "out"), ref(b, "in"), "send", true);

  // 3b. MIX 1 / 2 -> STEREO ("TO ST"): ON/OFF switch only, no level/pan. The block
  //     diagram routes it as a fixed path, so it is non-removable like the sends;
  //     its on/off is the TO ST switch, carried in conn.params.on (off at factory).
  for (const mix of ["bus.mix1", "bus.mix2"]) r(ref(mix, "out"), ref("bus.stereo", "in"), "sendSwitch", true);

  // 4. Oscillator -> STEREO / MIX / FX buses. The assign is on/off per output
  //    channel (no level/pan — the OSC has one global level), so it is a switch,
  //    not a summing send; stereo buses carry independent L/R in the wire params.
  for (const b of ["bus.stereo", "bus.mix1", "bus.mix2", "bus.fx1", "bus.fx2"])
    r(ref("bus.osc", "out"), ref(b, "in"), "sendSwitch");

  // 5. Streaming source select.
  for (const s of ["bus.stereo", "bus.mix1", "bus.mix2"])
    r(ref(s, "out"), ref("bus.stream", "in"), "source");

  // 6. Monitor source select.
  for (const mon of ["bus.mon1", "bus.mon2"])
    for (const s of ["bus.stereo", "bus.mix1", "bus.mix2"]) r(ref(s, "out"), ref(mon, "in"), "source");

  // 7. Output patch: analog outs (MAIN / LINE). PHONES 1/2/front are fixed to
  //    MONITOR 1 / MONITOR 2 / MONITOR 1 respectively (no source select), so
  //    they carry no rule.
  const patchSources = ["bus.stereo", "bus.mix1", "bus.mix2", "bus.stream", "bus.mon1", "bus.mon2"];
  const analogOuts = p.hasLineOut ? ["out.main", "out.line"] : ["out.main"];
  for (const o of analogOuts)
    for (const s of patchSources) r(ref(s, "out"), ref(o, "in"), "patch");

  // 8. USB OUT signal assign (single source each).
  const usbOuts = ["out.usbmain_a", "out.usbmain_b", "out.usbmain_c", "out.usbsub"];
  for (const o of usbOuts) {
    for (const s of ["bus.stereo", "bus.stream", "bus.mix1", "bus.mix2"])
      r(ref(s, "out"), ref(o, "in"), "patch");
    for (const c of channels) r(ref(c, "out"), ref(o, "in"), "patch");
  }

  // 9. DAW Rec — CH n OUT is hard-wired 1:1 to USB DAW OUT n in the block
  //    diagram with no source select, so it is not an editable node here.
  // 10. SD Rec — a record-source assign (block diagram: "SD Rec Signal Assign";
  //     RECORDER menu has only Track Count + Source select + a read-only level
  //     meter — no per-source level / pan / PRE-POST). Modeled as an ON/OFF assign
  //     (`sendSwitch`); the recorded tap is the channel's Rec Point.
  if (p.hasSD) {
    for (const c of channels) r(ref(c, "out"), ref("out.sdrec", "in"), "sendSwitch");
    for (const s of ["bus.stereo", "bus.mix1", "bus.mix2"])
      r(ref(s, "out"), ref("out.sdrec", "in"), "sendSwitch");
  }

  // 11. HDMI THRU — fixed 1:1 passthrough of the HDMI input with no source
  //     select, so (like DAW Rec) it is not an editable node (URX44V). The HDMI
  //     input remains a selectable channel source.

  // 12. Ducker key source — each ducker selects one trigger from CH / STEREO / MIX.
  const duckerSources = [...channels, "bus.stereo", "bus.mix1", "bus.mix2"];
  for (let d = 1; d <= 4; d++)
    for (const s of duckerSources) r(ref(s, "out"), ref(`out.ducker${d}`, "in"), "key");

  return { id: p.id, name: p.name, nodes, rules, channelPairs };
}
