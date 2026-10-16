// The SIM table's routing and setup paths: sources and patches, which the plan holds as
// wires, the sends' switches, a strip's colour, Signal Type and PAN/BAL, the monitors, the
// oscillator, the recorder's tracks, D.Gain and the sampling frequency.

import type { DeviceModel } from "../models/types";
import { ref } from "../models/types";
import { sendConnection, type Plan } from "./plan";
import {
  directOutTarget,
  isBalLinkedPair,
  isStereoLinkedPair,
  dropWire,
  pairPrimary,
  partnerChannel,
  requiresSource,
  sendHasOn,
} from "./routing";
import { SAMPLE_RATES, nodeRateDisabled, trackCountCeiling } from "./constraints";
import {
  COLOR_OFF,
  COLOR_PALETTE,
  COMP_EQ_SSMCS,
  DELAY_FRAME_RATE_OPTIONS,
  OSC_MODE_OPTIONS,
  PAN_BAL_OPTIONS,
  REC_POINT_DEFAULT,
  REC_POINT_OPTIONS,
  SD_REC_TRACK_COUNT_DEFAULT,
  SD_REC_TRACK_COUNT_OPTIONS,
  hexToColorIndex,
  recPointOptionsFor,
} from "./control/params";
import {
  MAIN,
  SEND_TARGETS,
  bool,
  enumValue,
  groupValue,
  isFx,
  isMasterBus,
  isMonoChannel,
  isStereoChannel,
  nodeValue,
  np,
  num,
  refused,
  simSendTarget,
  simStripId,
  UNCHANGED,
  type SimBinding,
  type SimEdit,
  type SimRefusal,
} from "./sim-map-base";

const NONE = "None";

/** The simulator's channel colours, in the unit's palette order: index i is `COLOR_PALETTE[i]`. */
const SIM_COLORS = [
  "#1965ff",
  "#ff8200",
  "#e6e710",
  "#8c4ade",
  "#29b5d6",
  "#ff499c",
  "#ce4529",
  "#29c26b",
  "#8ce63a",
  "#e6e6e6",
] as const;
const SIM_COLOR_OFF = "Off";

const SIGNAL_TYPES = ["MONO x 2", "STEREO"] as const;

/** An edit that changes nothing: what writing the value a path already holds hands over. */

/** A node param read straight, with nothing standing in for an absent one. */
function plainValue(id: string, key: "level" | "phonesLevel" | "dGain"): SimBinding {
  return {
    read: (plan) => np(plan, id)[key],
    write: (_plan, v) => {
      const value = num(v);
      return value === null ? refused("value") : { kind: "node", id, patch: { [key]: value } };
    },
  };
}

/** A strip's colour: the simulator's swatch for the plan's palette entry, and Off for none. */
function colorValue(id: string): SimBinding {
  return {
    values: [...SIM_COLORS, SIM_COLOR_OFF],
    read: (plan) => {
      const held = plan.nodeColors[id];
      if (held === undefined) return undefined;
      if (held === COLOR_OFF) return SIM_COLOR_OFF;
      const index = hexToColorIndex(held);
      return index === null ? undefined : SIM_COLORS[index];
    },
    write: (_plan, v) => {
      if (v === SIM_COLOR_OFF) return { kind: "color", id, color: COLOR_OFF };
      const index = typeof v === "string" ? (SIM_COLORS as readonly string[]).indexOf(v.toLowerCase()) : -1;
      return index < 0 ? refused("value") : { kind: "color", id, color: COLOR_PALETTE[index].hex };
    },
  };
}

/** A send's ON switch. A send the plan does not wire reads off and cannot be switched on, and
 *  one into or out of a bus the sample rate has taken away takes no edit. */
function sendOn(model: DeviceModel, from: string, to: string, absent: boolean): SimBinding {
  return {
    read: (plan) => {
      const conn = sendConnection(plan, from, to);
      return conn ? (conn.params?.on ?? absent) : false;
    },
    write: (plan, v) => {
      const on = bool(v);
      if (on === null) return refused("value");
      if (!sendHasOn(model, ref(from, "out"), ref(to, "in"))) return refused("noSwitch");
      if (!sendConnection(plan, from, to)) return on ? refused("unwired") : UNCHANGED;
      if (nodeRateDisabled(from, plan.sampleRate) || nodeRateDisabled(to, plan.sampleRate)) return refused("rate");
      return { kind: "send", from, to, patch: { on } };
    },
  };
}

/** One choice of a source select: the simulator's label and the out ref it draws, or null for none. */
interface Choice {
  label: string;
  from: string | null;
}

/** An input that takes one source, read as the label of the wire into it. Choosing another
 *  draws that wire in place of the one there; None removes it, except where the unit never
 *  leaves the input without a source. */
function sourceSelect(model: DeviceModel, to: string, choices: readonly Choice[], moves?: string[]): SimBinding {
  return {
    values: choices.map((c) => c.label),
    ...(moves ? { moves } : {}),
    read: (plan) => {
      const wires = plan.connections.filter((c) => c.to === to);
      if (wires.length === 0) return choices.some((c) => c.from === null) ? NONE : undefined;
      if (wires.length > 1) return undefined;
      return choices.find((c) => c.from === wires[0].from)?.label;
    },
    write: (plan, v) => {
      if (v === NONE && requiresSource(model, to)) return refused("required");
      const choice = choices.find((c) => c.label === v);
      if (!choice) return refused("value");
      const wires = plan.connections.filter((c) => c.to === to);
      if (choice.from === null) {
        if (wires.length === 0) return UNCHANGED;
        return wires.length === 1 ? { kind: "disconnect", from: wires[0].from, to } : refused("unreachable");
      }
      if (wires.length === 1 && wires[0].from === choice.from) return UNCHANGED;
      return connectEdit(model, choice.from, to);
    },
  };
}

function connectEdit(model: DeviceModel, from: string, to: string): SimEdit {
  return directOutTarget(model, from, to) !== null
    ? { kind: "connect", from, to, tap: true }
    : { kind: "connect", from, to };
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x) => b.includes(x));

/** The edits that take the wires into the USB output `to` from `held` to `want`: drops and
 *  deletes the board takes, at most three, the fewest found first. Null where none reach it. */
function usbRoute(model: DeviceModel, plan: Plan, to: string, want: readonly string[]): SimEdit[] | null {
  type State = { connections: Plan["connections"]; edits: SimEdit[] };
  let frontier: State[] = [{ connections: plan.connections, edits: [] }];
  for (let depth = 0; depth < 3; depth++) {
    const next: State[] = [];
    for (const state of frontier) {
      const held = state.connections.filter((c) => c.to === to).map((c) => c.from);
      for (const from of want) {
        if (held.includes(from)) continue;
        const drop = dropWire(model, { ...plan, connections: state.connections }, from, to);
        if (!drop.ok) continue;
        next.push({ connections: drop.connections, edits: [...state.edits, connectEdit(model, from, to)] });
      }
      for (const from of held) {
        const connections = state.connections.filter((c) => !(c.from === from && c.to === to));
        next.push({ connections, edits: [...state.edits, { kind: "disconnect", from, to }] });
      }
    }
    const done = next.find((s) =>
      sameSet(
        s.connections.filter((c) => c.to === to).map((c) => c.from),
        want,
      ),
    );
    if (done) return done.edits;
    frontier = next;
  }
  return null;
}

/** A USB output's patch: one source, or the two channels of a MONO IN pair under one label,
 *  each taken in one choice as the unit's own list takes it — by as many drops and deletes on
 *  the board as it needs. */
function usbPatch(model: DeviceModel, to: string, choices: readonly { label: string; froms: string[] }[]): SimBinding {
  return {
    values: choices.map((c) => c.label),
    read: (plan) => {
      const held = plan.connections.filter((c) => c.to === to).map((c) => c.from);
      return choices.find((c) => sameSet(c.froms, held))?.label;
    },
    write: (plan, v) => {
      const choice = choices.find((c) => c.label === v);
      if (!choice) return refused("value");
      const held = plan.connections.filter((c) => c.to === to).map((c) => c.from);
      if (sameSet(held, choice.froms)) return UNCHANGED;
      const edits = usbRoute(model, plan, to, choice.froms);
      if (!edits) return refused("unreachable");
      return edits.length === 1 ? edits[0] : { kind: "steps", steps: edits };
    },
  };
}

/** The oscillator's assign to one side of a bus: on where the wire from the oscillator is drawn
 *  and that side is not switched off. Turning a side on where no wire is draws it with the other
 *  side off, as the unit's separate L and R buttons do; an FX bus, which is mono, is switched by
 *  the wire alone. */
function oscAssign(bus: string, side: "L" | "R" | null): SimBinding {
  const from = "bus.osc";
  const key = side === "R" ? "oscR" : "oscL";
  return {
    read: (plan) => {
      const conn = sendConnection(plan, from, bus);
      return conn ? conn.params?.[key] !== false : false;
    },
    write: (plan, v) => {
      const on = bool(v);
      if (on === null) return refused("value");
      const conn = sendConnection(plan, from, bus);
      if (!conn) {
        if (!on) return UNCHANGED;
        const connect: SimEdit = { kind: "connect", from: ref(from, "out"), to: ref(bus, "in") };
        if (side === null) return connect;
        const other = side === "R" ? "oscL" : "oscR";
        return { kind: "steps", steps: [connect, { kind: "send", from, to: bus, patch: { [other]: false } }] };
      }
      if (side === null && !on) return { kind: "disconnect", from: ref(from, "out"), to: ref(bus, "in") };
      return { kind: "send", from, to: bus, patch: { [key]: on } };
    },
  };
}

/** Add the routing and setup paths the plan of `model` answers to `out`. */
export function routingBindings(model: DeviceModel, out: Map<string, SimBinding>): void {
  const has = (id: string): boolean => model.nodes.some((n) => n.id === id);
  const channels = model.nodes.filter((n) => isMonoChannel(n.id) || isStereoChannel(n.id)).map((n) => n.id);

  // A channel's source: the input nodes in the order the simulator lists them.
  const inputChoices: Choice[] = [{ label: NONE, from: null }];
  const inputs = model.nodes.filter((n) => n.kind === "input" && n.id.startsWith("in.")).map((n) => n.id);
  const inputLabel = (id: string): string | null => {
    const mic = /^in\.micline_(\d+)_(\d+)$/.exec(id);
    if (mic) return `MIC/LINE ${mic[1]}/${mic[2]}`;
    const daw = /^in\.usbdaw_(\d+)_(\d+)$/.exec(id);
    if (daw) return `USB DAW ${daw[1]}/${daw[2]}`;
    const fixed: Record<string, string> = {
      "in.aux": "AUX IN",
      "in.usbmain_a": "USB MAIN A",
      "in.usbmain_b": "USB MAIN B",
      "in.usbmain_c": "USB MAIN C",
      "in.usbsub": "USB SUB",
      "in.sdplay": "microSD Playback",
      "in.hdmi": "HDMI",
    };
    return fixed[id] ?? null;
  };
  const inputOrder = (id: string): number => {
    if (id.startsWith("in.micline_")) return 0;
    if (id === "in.aux") return 1;
    if (id.startsWith("in.usbmain_")) return 2;
    if (id === "in.usbsub") return 3;
    if (id.startsWith("in.usbdaw_")) return 4;
    return id === "in.sdplay" ? 5 : 6;
  };
  for (const id of [...inputs].sort((a, b) => inputOrder(a) - inputOrder(b))) {
    const label = inputLabel(id);
    if (label) inputChoices.push({ label, from: ref(id, "out") });
  }

  for (const id of channels) {
    const ch = `ch.${simStripId(id)}`;
    const partner = partnerChannel(model, id);
    out.set(
      `${ch}.source`,
      sourceSelect(model, ref(id, "in"), inputChoices, partner ? [`ch.${simStripId(partner)}.source`] : undefined),
    );

    const stereo = isStereoChannel(id);
    const recLabels = REC_POINT_OPTIONS.filter((o) => !stereo || o.stereo).map((o) => o.label);
    out.set(
      `${ch}.recPoint`,
      enumValue(
        recLabels,
        (plan) => {
          const value = np(plan, id).recPoint ?? REC_POINT_DEFAULT;
          const index = recLabels.indexOf(REC_POINT_OPTIONS.find((o) => o.value === value)?.label ?? "");
          return index < 0 ? undefined : index;
        },
        (plan, index) => {
          const ssmcs = np(plan, id).compEqType === COMP_EQ_SSMCS;
          const option = recPointOptionsFor(stereo, ssmcs).find((o) => o.label === recLabels[index]);
          return option ? { kind: "node", id, patch: { recPoint: option.value } } : refused("recPoint");
        },
      ),
    );

    // A MONO IN pair's Signal Type and PAN/BAL: held on the primary, read by both members.
    const primary = pairPrimary(model, id);
    if (primary && partner) {
      const other = `ch.${simStripId(partner)}`;
      out.set(`${ch}.signalType`, {
        ...enumValue(
          SIGNAL_TYPES,
          (plan) => (np(plan, primary).stereoLink === true ? 1 : 0),
          (_plan, index) => ({ kind: "node", id: primary, patch: { stereoLink: index === 1 } }),
        ),
        moves: [`${other}.signalType`],
      });
      const panBalLabels = PAN_BAL_OPTIONS.map((o) => o.label);
      out.set(`${ch}.panBal`, {
        ...enumValue(
          panBalLabels,
          (plan) => {
            const index = PAN_BAL_OPTIONS.findIndex((o) => o.value === (np(plan, primary).panBal ?? 0));
            return index < 0 ? undefined : index;
          },
          (plan, index) => {
            const value = PAN_BAL_OPTIONS[index].value;
            if (isStereoLinkedPair(model, plan, primary))
              return { kind: "node", id: primary, patch: { panBal: value } };
            return value === (np(plan, primary).panBal ?? 0) ? UNCHANGED : refused("unlinked");
          },
        ),
        moves: [`${other}.panBal`],
      });
      // The pair's one balance, read off the primary's main path while the pair is in BAL.
      if (id === primary) {
        out.set(`${ch}.balance`, {
          moves: [`${ch}.pan`],
          read: (plan) =>
            isBalLinkedPair(model, plan, id) ? (sendConnection(plan, id, MAIN)?.params?.pan ?? 0) : undefined,
          write: (plan, v) => {
            const pan = num(v);
            if (pan === null) return refused("value");
            if (!isBalLinkedPair(model, plan, id)) return refused("notBal");
            if (!sendConnection(plan, id, MAIN)) return refused("unwired");
            return { kind: "send", from: id, to: MAIN, patch: { pan } };
          },
        });
        const pan = out.get(`${ch}.pan`);
        if (pan) out.set(`${ch}.pan`, { ...pan, moves: [...(pan.moves ?? []), `${ch}.balance`] });
      }
    }
  }

  // Every strip's colour, and the sends' switches.
  for (const node of model.nodes) {
    const id = node.id;
    const strip = isMonoChannel(id) || isStereoChannel(id) || isFx(id);
    if (!strip && !isMasterBus(id) && id !== "bus.stream") continue;
    const ch = `ch.${simStripId(id)}`;
    out.set(`${ch}.color`, colorValue(id));
    if (strip) {
      out.set(`${ch}.send.${simSendTarget(MAIN)}.on`, sendOn(model, id, MAIN, true));
      for (const to of SEND_TARGETS) {
        if (to === id || !has(to) || (isFx(id) && isFx(to))) continue;
        out.set(`${ch}.send.${simSendTarget(to)}.on`, sendOn(model, id, to, true));
      }
    }
    if (id === "bus.mix1" || id === "bus.mix2") {
      out.set(`${ch}.panLink`, nodeValue(id, "panLink", false, "boolean"));
      out.set(`${ch}.send.${simSendTarget(MAIN)}.on`, sendOn(model, id, MAIN, false));
    }
  }
  for (const fx of ["bus.fx1", "bus.fx2"]) {
    if (!has(fx)) continue;
    out.set(`ch.${simStripId(fx)}.balance`, {
      read: (plan) => {
        const conn = sendConnection(plan, fx, MAIN);
        return conn ? (conn.params?.pan ?? 0) : undefined;
      },
      write: (plan, v) => {
        const pan = num(v);
        if (pan === null) return refused("value");
        return sendConnection(plan, fx, MAIN)
          ? { kind: "send", from: fx, to: MAIN, patch: { pan } }
          : refused("unwired");
      },
    });
  }

  // STREAMING: its name, its delay and its source, which is never none.
  const busChoices: Choice[] = [
    { label: "STEREO", from: ref("bus.stereo", "out") },
    { label: "MIX 1", from: ref("bus.mix1", "out") },
    { label: "MIX 2", from: ref("bus.mix2", "out") },
  ];
  out.set("ch.bus.stream.name", {
    read: (plan) => plan.nodeNames?.["bus.stream"],
    write: (_plan, v) => (typeof v === "string" ? { kind: "name", id: "bus.stream", name: v } : refused("value")),
  });
  out.set("ch.bus.stream.delay.on", groupValue("bus.stream", "delay", "on", "boolean"));
  out.set("ch.bus.stream.delay.ms", groupValue("bus.stream", "delay", "time", "number"));
  const frameRates = DELAY_FRAME_RATE_OPTIONS.map((o) => o.label);
  out.set(
    "ch.bus.stream.delay.frameRate",
    enumValue(
      frameRates,
      (plan) => {
        const value = np(plan, "bus.stream").delay?.frameRate;
        const index = DELAY_FRAME_RATE_OPTIONS.findIndex((o) => o.value === value);
        return index < 0 ? undefined : index;
      },
      (plan, index) => ({
        kind: "node",
        id: "bus.stream",
        patch: { delay: { ...(np(plan, "bus.stream").delay ?? {}), frameRate: DELAY_FRAME_RATE_OPTIONS[index].value } },
        written: ["delay.frameRate"],
      }),
    ),
  );
  out.set("ch.bus.stream.source", sourceSelect(model, ref("bus.stream", "in"), busChoices));

  // The two monitors and the phones they feed.
  for (const n of [1, 2]) {
    const mon = `bus.mon${n}`;
    out.set(`monitor.${n}.on`, nodeValue(mon, "on", true, "boolean"));
    out.set(`monitor.${n}.level`, plainValue(mon, "level"));
    out.set(`monitor.${n}.mono`, nodeValue(mon, "mono", false, "boolean"));
    out.set(`monitor.${n}.cueInterrupt`, nodeValue(mon, "cueInterrupt", true, "boolean"));
    out.set(`monitor.${n}.source`, sourceSelect(model, ref(mon, "in"), [{ label: NONE, from: null }, ...busChoices]));
    out.set(`phones.${n}.level`, plainValue(mon, "phonesLevel"));
  }

  // The oscillator and where it is assigned.
  out.set("osc.on", groupValue("bus.osc", "osc", "on", "boolean"));
  out.set("osc.level", groupValue("bus.osc", "osc", "level", "number"));
  out.set("osc.frequency", groupValue("bus.osc", "osc", "freq", "number"));
  out.set("osc.width", groupValue("bus.osc", "osc", "width", "number"));
  out.set("osc.interval", groupValue("bus.osc", "osc", "interval", "number"));
  const modes = OSC_MODE_OPTIONS.map((o) => o.label);
  out.set(
    "osc.mode",
    enumValue(
      modes,
      (plan) => {
        const index = OSC_MODE_OPTIONS.findIndex((o) => o.value === np(plan, "bus.osc").osc?.mode);
        return index < 0 ? undefined : index;
      },
      (plan, index) => ({
        kind: "node",
        id: "bus.osc",
        patch: { osc: { ...(np(plan, "bus.osc").osc ?? {}), mode: OSC_MODE_OPTIONS[index].value } },
        written: ["osc.mode"],
      }),
    ),
  );
  for (const [name, bus] of [
    ["mix1", "bus.mix1"],
    ["mix2", "bus.mix2"],
    ["stereo", "bus.stereo"],
  ] as const) {
    out.set(`osc.assign.${name}L`, oscAssign(bus, "L"));
    out.set(`osc.assign.${name}R`, oscAssign(bus, "R"));
  }
  for (const fx of ["bus.fx1", "bus.fx2"]) if (has(fx)) out.set(`osc.assign.${simStripId(fx)}`, oscAssign(fx, null));

  // D.Gain of the sources the simulator names from the start.
  for (const [path, id] of [
    ["usb-main-a", "in.usbmain_a"],
    ["usb-main-b", "in.usbmain_b"],
    ["usb-main-c", "in.usbmain_c"],
    ["usb-sub", "in.usbsub"],
  ] as const)
    if (has(id)) out.set(`source.${path}.digitalGain`, plainValue(id, "dGain"));

  // The output patches.
  const analogChoices: Choice[] = [
    { label: NONE, from: null },
    { label: "STEREO", from: ref("bus.stereo", "out") },
    { label: "STREAMING", from: ref("bus.stream", "out") },
    { label: "MIX 1", from: ref("bus.mix1", "out") },
    { label: "MIX 2", from: ref("bus.mix2", "out") },
    { label: "MONITOR 1", from: ref("bus.mon1", "out") },
    { label: "MONITOR 2", from: ref("bus.mon2", "out") },
  ];
  out.set("setup.outputPatch.mainOut", sourceSelect(model, ref("out.main", "in"), analogChoices));
  if (has("out.line")) out.set("setup.outputPatch.lineOut", sourceSelect(model, ref("out.line", "in"), analogChoices));
  const usbChoices: { label: string; froms: string[] }[] = [
    { label: NONE, froms: [] },
    ...analogChoices.slice(1, 5).map((c) => ({ label: c.label, froms: [c.from as string] })),
  ];
  const total = channels.reduce((n, id) => n + (isStereoChannel(id) ? 2 : 1), 0);
  for (let i = 1; i < total; i += 2) {
    const stereoId = `ch_${i}_${i + 1}`;
    const froms = has(stereoId) ? [stereoId] : [`ch${i}`, `ch${i + 1}`].filter(has);
    if (froms.length > 0) usbChoices.push({ label: `CH ${i}/${i + 1}`, froms: froms.map((f) => ref(f, "out")) });
  }
  for (const id of channels.filter(isMonoChannel))
    usbChoices.push({ label: `CH ${id.slice(2)}`, froms: [ref(id, "out")] });
  for (const [path, id] of [
    ["usbMainA", "out.usbmain_a"],
    ["usbMainB", "out.usbmain_b"],
    ["usbMainC", "out.usbmain_c"],
    ["usbSub", "out.usbsub"],
  ] as const)
    out.set(`setup.outputPatch.${path}`, usbPatch(model, ref(id, "in"), usbChoices));

  // The microSD recorder: its Track Count and each track pair's source.
  if (has("out.sdrec")) {
    out.set("sd.trackCount", {
      values: SD_REC_TRACK_COUNT_OPTIONS.map((o) => o.value),
      read: (plan) => np(plan, "out.sdrec").sdRecTrackCount ?? SD_REC_TRACK_COUNT_DEFAULT,
      write: (plan, v) => {
        const count = num(v);
        if (count === null || !SD_REC_TRACK_COUNT_OPTIONS.some((o) => o.value === count)) return refused("value");
        if (count > trackCountCeiling(plan.sampleRate)) return refused("rate");
        return { kind: "node", id: "out.sdrec", patch: { sdRecTrackCount: count } };
      },
    });
    const recChoices: Choice[] = [
      { label: NONE, from: null },
      { label: "STEREO", from: ref("bus.stereo", "out") },
      ...model.channelPairs.map(([a, b]) => ({ label: `CH ${a.slice(2)}/${b.slice(2)}`, from: ref(a, "out") })),
      ...channels
        .filter(isStereoChannel)
        .map((id) => ({ label: `CH ${id.slice(3).replace("_", "/")}`, from: ref(id, "out") })),
      { label: "MIX 1", from: ref("bus.mix1", "out") },
      { label: "MIX 2", from: ref("bus.mix2", "out") },
    ];
    for (let slot = 0; has(`out.sdrec.t${slot + 1}`); slot++)
      out.set(`sd.track.${slot}`, sourceSelect(model, ref(`out.sdrec.t${slot + 1}`, "in"), recChoices));
  }

  // The sampling frequency, changed the way the toolbar's rate picker changes it.
  out.set("setup.samplingFrequency", {
    values: SAMPLE_RATES,
    ...(has("out.sdrec") ? { moves: ["sd.trackCount"] } : {}),
    read: (plan) => plan.sampleRate,
    write: (_plan, v): SimEdit | SimRefusal => {
      const rate = num(v);
      return rate !== null && SAMPLE_RATES.includes(rate) ? { kind: "rate", rate } : refused("value");
    },
  });
}
