// The SIM tab's view of the plan: which of the LCD simulator's paths the plan answers,
// what each reads, and what an edit of it writes.
//
// The simulator names a value by a dotted path (`ch.ch1.gate.threshold`) in the units
// its screens show. The plan holds the same value under a node id and a param key, in
// the same units for nearly all of them; the enumerations are the exceptions, and each
// is converted here. A path the table does not carry is one the SIM shows at the
// simulator's own value and cannot edit.
//
// An edit is described rather than applied: the host hands it to the same funnels the
// Inspector and the tuning screens use, so the undo history, live sync and device
// follow treat it as one of theirs.

import type { DeviceModel } from "../models/types";
import { LEVEL_OFF_DB, jackKey, sendConnection, type EqBand, type Plan } from "./plan";
import { hiZPatch, inputOnRefused } from "./input-lock";
import { nodeRateDisabled } from "./constraints";
import { inputStageOf } from "./control/translate";
import {
  MAIN,
  SEND_TARGETS,
  bool,
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
  type SimValue,
} from "./sim-map-base";
import { processorBindings } from "./sim-map-processors";
import { routingBindings } from "./sim-map-routing";

export { isRefusal, type SimBinding, type SimEdit, type SimRefusal, type SimValue } from "./sim-map-base";

const EQ_BANDS = ["low", "lowMid", "highMid", "high"] as const;
/** A band's shape by the plan's EQ type (0 peaking, 1 shelving, 2 pass), for the outer bands. */
const LOW_SHAPES = ["Bell", "L.Shelf", "HPF"] as const;
const HIGH_SHAPES = ["Bell", "H.Shelf", "LPF"] as const;
const KNEES = ["Soft", "Medium", "Hard"] as const;

/** An EQ band's field. */
function bandValue(id: string, index: number, field: "freq" | "gain" | "q" | "on"): SimBinding {
  return {
    read: (plan) => np(plan, id).eqBands?.[index]?.[field],
    write: (plan, v) => {
      const value = field === "on" ? bool(v) : num(v);
      const bands = np(plan, id).eqBands;
      if (value === null || !bands?.[index]) return refused("value");
      const next = bands.map((b, i) => (i === index ? ({ ...b, [field]: value } as EqBand) : b));
      return { kind: "node", id, patch: { eqBands: next }, written: [`eqBands.${index}.${field}`] };
    },
  };
}

/** An outer band's shape, which the plan holds as its EQ type. */
function bandShape(id: string, index: number): SimBinding {
  const shapes: readonly string[] = index === 0 ? LOW_SHAPES : HIGH_SHAPES;
  return {
    read: (plan) => {
      const type = np(plan, id).eqBands?.[index]?.type;
      return type === undefined ? undefined : shapes[type];
    },
    write: (plan, v) => {
      const type = typeof v === "string" ? shapes.indexOf(v) : -1;
      const bands = np(plan, id).eqBands;
      if (type < 0 || !bands?.[index]) return refused("value");
      const next = bands.map((b, i) => (i === index ? { ...b, type } : b));
      return { kind: "node", id, patch: { eqBands: next }, written: [`eqBands.${index}.type`] };
    },
  };
}

/** A send's level, pan or tap. On a send the plan does not wire, the SIM shows it off and takes no edit,
 *  and none into or out of a node the rate takes out, which the unit's own screen does not offer. */
function sendValue(from: string, to: string, field: "level" | "pan" | "pre", absent: SimValue): SimBinding {
  return {
    read: (plan) => {
      const params = sendConnection(plan, from, to)?.params;
      if (!params) return absent;
      if (field === "pre") return params.tap === "pre";
      return params[field] ?? absent;
    },
    write: (plan, v) => {
      if (!sendConnection(plan, from, to)) return refused("unwired");
      if (nodeRateDisabled(from, plan.sampleRate) || nodeRateDisabled(to, plan.sampleRate)) return refused("rate");
      if (field === "pre") {
        const pre = bool(v);
        return pre === null ? refused("value") : { kind: "send", from, to, patch: { tap: pre ? "pre" : "post" } };
      }
      const value = num(v);
      return value === null ? refused("value") : { kind: "send", from, to, patch: { [field]: value } };
    },
  };
}

/** One field of the jack or source a channel reads. */
function inputValue(model: DeviceModel, channel: string, field: "gain" | "phantom" | "hiZ" | "clipSafe"): SimBinding {
  const jack = (plan: Plan) => {
    const stage = inputStageOf(model, plan, channel);
    return stage.kind === "jack" ? stage : null;
  };
  return {
    read: (plan) => {
      const stage = jack(plan);
      if (!stage) return undefined;
      const held = np(plan, stage.node)[jackKey(field, stage.side)];
      return held ?? (field === "gain" ? undefined : false);
    },
    write: (plan, v) => {
      const stage = jack(plan);
      if (!stage) return refused("unread");
      const jnp = np(plan, stage.node);
      if (field === "gain") {
        const value = num(v);
        return value === null
          ? refused("value")
          : { kind: "node", id: stage.node, patch: { [jackKey("gain", stage.side)]: value } };
      }
      const on = bool(v);
      if (on === null) return refused("value");
      if (field === "hiZ" && !stage.hiZ) return on ? refused("noHiZ") : UNCHANGED;
      if (on && (field === "phantom" || field === "hiZ") && inputOnRefused(model.id, stage, jnp, field))
        return refused(field);
      const patch = field === "hiZ" ? hiZPatch(jnp, stage.side, on) : { [jackKey(field, stage.side)]: on };
      return { kind: "node", id: stage.node, patch };
    },
  };
}

/** Every path of the simulator the plan of `model` answers. */
export function simBindings(model: DeviceModel): Map<string, SimBinding> {
  const out = new Map<string, SimBinding>();
  const has = (id: string): boolean => model.nodes.some((n) => n.id === id);

  for (const node of model.nodes) {
    const id = node.id;
    if (!isMonoChannel(id) && !isStereoChannel(id) && !isFx(id) && !isMasterBus(id)) continue;
    const ch = `ch.${simStripId(id)}`;

    out.set(`${ch}.name`, {
      read: (plan) => plan.nodeNames?.[id],
      write: (_plan, v) => (typeof v === "string" ? { kind: "name", id, name: v } : refused("value")),
    });
    out.set(`${ch}.on`, nodeValue(id, "on", true, "boolean"));

    // The fader: a channel's and an FX channel's is its send into STEREO, a bus's its own level.
    if (isMasterBus(id)) {
      out.set(`${ch}.level`, nodeValue(id, "level", 0, "number"));
      out.set(`${ch}.balance`, nodeValue(id, "pan", 0, "number"));
    } else {
      out.set(`${ch}.level`, sendValue(id, MAIN, "level", LEVEL_OFF_DB));
      if (isMonoChannel(id)) out.set(`${ch}.pan`, sendValue(id, MAIN, "pan", 0));
      if (isStereoChannel(id)) out.set(`${ch}.balance`, sendValue(id, MAIN, "pan", 0));
    }

    // The sends into MIX 1/2 and FX 1/2.
    if (!isMasterBus(id)) {
      for (const to of SEND_TARGETS) {
        // An FX channel sends into the MIX buses alone.
        if (to === id || !has(to) || (isFx(id) && isFx(to))) continue;
        const send = `${ch}.send.${simSendTarget(to)}`;
        out.set(`${send}.level`, sendValue(id, to, "level", LEVEL_OFF_DB));
        out.set(`${send}.pre`, sendValue(id, to, "pre", false));
        if (to === "bus.mix1" || to === "bus.mix2") out.set(`${send}.balance`, sendValue(id, to, "pan", 0));
      }
    }

    // EQ, on every strip that carries one: an FX channel has none.
    if (!isFx(id)) {
      out.set(`${ch}.eq.on`, nodeValue(id, "eqOn", true, "boolean"));
      EQ_BANDS.forEach((band, i) => {
        for (const field of ["freq", "gain", "q", "on"] as const)
          out.set(`${ch}.eq.${band}.${field}`, bandValue(id, i, field));
        if (i === 0 || i === 3) out.set(`${ch}.eq.${band}.shape`, bandShape(id, i));
      });
    }

    if (isMonoChannel(id)) {
      out.set(`${ch}.hpf.on`, nodeValue(id, "hpf", false, "boolean"));
      out.set(`${ch}.hpf.freq`, nodeValue(id, "hpfFreq", 80, "number"));
      out.set(`${ch}.phase`, nodeValue(id, "phase", false, "boolean"));
      out.set(`${ch}.gate.on`, nodeValue(id, "gateOn", false, "boolean"));
      for (const f of ["threshold", "range", "attack", "hold", "decay"])
        out.set(`${ch}.gate.${f}`, groupValue(id, "gate", f, "number"));
      out.set(`${ch}.comp.on`, nodeValue(id, "compOn", false, "boolean"));
      for (const f of ["threshold", "ratio", "gain", "attack", "release"])
        out.set(`${ch}.comp.${f}`, groupValue(id, "comp", f, "number"));
      out.set(`${ch}.comp.autoMakeup`, groupValue(id, "comp", "autoMakeup", "boolean"));
      out.set(`${ch}.comp.knee`, {
        read: (plan) => {
          const knee = np(plan, id).comp?.knee;
          return knee === undefined ? undefined : KNEES[knee];
        },
        write: (plan, v) => {
          const knee = typeof v === "string" ? (KNEES as readonly string[]).indexOf(v) : -1;
          if (knee < 0) return refused("value");
          return { kind: "node", id, patch: { comp: { ...(np(plan, id).comp ?? {}), knee } }, written: ["comp.knee"] };
        },
      });
      for (const field of ["gain", "phantom", "hiZ", "clipSafe"] as const)
        out.set(`${ch}.${field}`, inputValue(model, id, field));
    }

    if (isStereoChannel(id)) {
      out.set(`${ch}.phase.l`, nodeValue(id, "phaseL", false, "boolean"));
      out.set(`${ch}.phase.r`, nodeValue(id, "phaseR", false, "boolean"));
    }
  }

  // The unit's sampling frequency: shown, and changed only where the plan's rate is chosen.
  out.set("setup.samplingFrequency", { read: (plan) => plan.sampleRate });
  processorBindings(model, out);
  routingBindings(model, out);
  return out;
}

/** Every value the plan answers for the SIM, by path. */
export function readSim(bindings: ReadonlyMap<string, SimBinding>, plan: Plan): Map<string, SimValue> {
  const out = new Map<string, SimValue>();
  for (const [path, binding] of bindings) {
    const value = binding.read(plan);
    if (value !== undefined) out.set(path, value);
  }
  return out;
}
