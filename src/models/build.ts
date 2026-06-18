// Generates a DeviceModel from per-model parameters. The node set and the
// routing rules below are a direct transcription of the official V1.2 block
// diagram (see docs/device-model.md). Keep the two in sync.

import { ref } from "./types";
import type {
  ConnectionKind,
  DeviceModel,
  DeviceNode,
  ModelId,
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

const COL: Record<DeviceNode["column"], number> = {
  input: 0,
  channel: 1,
  bus: 2,
  output: 3,
  // Duckers sit in the channel column (hung under their parent), never a column
  // of their own; this entry exists only to satisfy the exhaustive Record type.
  ducker: 1,
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
  const rowByCol: Record<DeviceNode["column"], number> = {
    input: 0,
    channel: 0,
    bus: 0,
    output: 0,
    ducker: 0,
  };

  function add(node: Omit<DeviceNode, "pos">): void {
    nodes.push({ ...node, pos: { col: COL[node.column], row: rowByCol[node.column]++ } });
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
    rowByCol.channel++;
  }

  // --- Buses ---------------------------------------------------------------
  const addBus = (id: string, label: string, ports: Port[] = ioPort()): void =>
    add({ id, kind: "bus", label, column: "bus", ports });
  addBus("bus.stereo", "STEREO (MAIN)");
  addBus("bus.mix1", "MIX 1");
  addBus("bus.mix2", "MIX 2");
  addBus("bus.fx1", "FX 1");
  addBus("bus.fx2", "FX 2");
  // CUE is a temporary solo/monitor bus: its routing is wiped at power-off and
  // cannot hold a persistent assignment, so it is omitted as an editable node.
  addBus("bus.stream", "STREAMING");
  addBus("bus.mon1", "MONITOR 1");
  addBus("bus.mon2", "MONITOR 2");
  addBus("bus.osc", "OSCILLATOR", outPort()); // tone generator: output only

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

  // 2. Channel -> bus sends (summing, with level/pan). The send to STEREO is the
  //    channel's main fader path (outside the SEND blocks in the diagram): it is
  //    always wired and cannot be removed, so it is marked fixed.
  const sendBuses = ["bus.stereo", "bus.mix1", "bus.mix2", "bus.fx1", "bus.fx2"];
  for (const ch of channels)
    for (const b of sendBuses) r(ref(ch, "out"), ref(b, "in"), "send", b === "bus.stereo");

  // 3. FX returns -> mix buses. The return to STEREO is the FX main path and is
  //    likewise always wired (fixed); the MIX 1/2 sends remain optional.
  for (const fx of ["bus.fx1", "bus.fx2"])
    for (const b of ["bus.stereo", "bus.mix1", "bus.mix2"])
      r(ref(fx, "out"), ref(b, "in"), "send", b === "bus.stereo");

  // 3b. MIX 1 / 2 -> STEREO ("TO ST"): ON/OFF switch only, no level/pan.
  for (const mix of ["bus.mix1", "bus.mix2"]) r(ref(mix, "out"), ref("bus.stereo", "in"), "sendSwitch");

  // 4. Oscillator -> mix / FX buses.
  for (const b of ["bus.stereo", "bus.mix1", "bus.mix2", "bus.fx1", "bus.fx2"])
    r(ref("bus.osc", "out"), ref(b, "in"), "send");

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
  // 10. SD Rec — source-selectable record group (STEREO / MIX / CH).
  if (p.hasSD) {
    for (const c of channels) r(ref(c, "out"), ref("out.sdrec", "in"), "send");
    for (const s of ["bus.stereo", "bus.mix1", "bus.mix2"])
      r(ref(s, "out"), ref("out.sdrec", "in"), "send");
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
