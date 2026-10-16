import { describe, expect, it } from "vitest";
import { getModel } from "../models";
import { defaultPlan } from "../models/initial-state";
import type { DeviceModel, ModelId } from "../models/types";
import { setPlanSampleRate, sendConnection, type Plan } from "./plan";
import { canConnect, ruleKind } from "./routing";
import { isRefusal, readSim, simBindings, type SimBinding, type SimEdit, type SimValue } from "./sim-map";

/** What the host's funnels do with an edit, as far as the plan's values go. */
function apply(model: DeviceModel, plan: Plan, edit: SimEdit): void {
  switch (edit.kind) {
    case "node":
      plan.nodeParams[edit.id] = { ...plan.nodeParams[edit.id], ...edit.patch };
      break;
    case "send": {
      const conn = sendConnection(plan, edit.from, edit.to);
      if (conn) conn.params = { ...conn.params, ...edit.patch };
      break;
    }
    case "name":
      plan.nodeNames = { ...plan.nodeNames, [edit.id]: edit.name };
      break;
    case "color":
      if (edit.color) plan.nodeColors = { ...plan.nodeColors, [edit.id]: edit.color };
      else delete plan.nodeColors[edit.id];
      break;
    case "connect": {
      // The board's connect: a wire into an input that takes one source replaces the one there.
      const kind = ruleKind(model, edit.from, edit.to);
      if (!kind) break;
      const reason = canConnect(model, plan, edit.from, edit.to).reason;
      if (reason === "singleInput" || reason === "monoPairOnly")
        plan.connections = plan.connections.filter((c) => c.to !== edit.to);
      else if (reason) break;
      plan.connections.push({ from: edit.from, to: edit.to, kind });
      break;
    }
    case "disconnect":
      plan.connections = plan.connections.filter((c) => !(c.from === edit.from && c.to === edit.to));
      break;
    case "rate":
      setPlanSampleRate(plan, edit.rate);
      break;
    case "none":
      break;
    case "steps":
      for (const step of edit.steps) apply(model, plan, step);
      break;
  }
}

const SHAPES: Record<string, string> = {
  "L.Shelf": "HPF",
  "H.Shelf": "Bell",
  Bell: "L.Shelf",
  HPF: "Bell",
  LPF: "Bell",
};
const KNEES: Record<string, string> = { Soft: "Medium", Medium: "Hard", Hard: "Soft" };

/** A value other than `v` that the path takes. */
function another(path: string, binding: SimBinding, v: SimValue): SimValue {
  if (binding.values) return binding.values.find((x) => x !== v) ?? v;
  if (typeof v === "boolean") return !v;
  if (typeof v === "number") return v <= -90 ? -20 : v - 1;
  if (path.endsWith(".shape")) return path.includes(".high.") && v === "H.Shelf" ? "LPF" : (SHAPES[v] ?? v);
  if (path.endsWith(".knee")) return KNEES[v] ?? v;
  return `${v}x`.slice(0, 8);
}

describe.each(["URX22", "URX44", "URX44V"] as ModelId[])("an edit on the SIM of a %s plan", (modelId) => {
  const model = getModel(modelId);
  const bindings = simBindings(model);

  it("reads back the value it wrote, at every path it writes", () => {
    const misses: string[] = [];
    let written = 0;
    for (const [path, binding] of bindings) {
      if (!binding.write) continue;
      const plan = defaultPlan(modelId);
      const before = binding.read(plan);
      if (before === undefined) continue;
      const next = another(path, binding, before);
      const edit = binding.write(plan, next);
      if (isRefusal(edit)) continue;
      const all = readSim(bindings, plan);
      apply(model, plan, edit);
      written++;
      if (binding.read(plan) !== next)
        misses.push(`${path}: wrote ${JSON.stringify(next)}, read ${JSON.stringify(binding.read(plan))}`);
      // No other path reads the value it wrote: two paths reading one value is a misread table.
      const moved = [...readSim(bindings, plan)]
        .filter(([p, v]) => p !== path && all.get(p) !== v && !binding.moves?.includes(p))
        .map(([p]) => p);
      if (moved.length) misses.push(`${path} also moved ${moved.join(", ")}`);
    }
    expect(misses).toEqual([]);
    expect(written, "a real share of the table was written").toBeGreaterThan(100);
  });

  it("leaves the plan's EQ bands as they are while 1-knob EQ drives them, and takes them once it is off", () => {
    const band = [...bindings.entries()].filter(
      // The middle bands' shape is fixed: it takes its one value and nothing else.
      ([p]) => /^ch\.ch1\.eq\.(low|lowMid|highMid|high)\.(freq|gain|q|on|shape)$/.test(p) && !/Mid\.shape$/.test(p),
    );
    expect(band.length, "every band field of CH 1").toBe(4 * 4 + 2);
    for (const on of [true, false]) {
      const moved: string[] = [];
      for (const [path, binding] of band) {
        const plan = defaultPlan(modelId);
        plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, eqOneKnob: { on, type: 0, level: 50 } };
        const before = binding.read(plan);
        if (before === undefined) continue;
        const edit = binding.write!(plan, another(path, binding, before));
        if (isRefusal(edit)) continue;
        apply(model, plan, edit);
        if (binding.read(plan) !== before) moved.push(path);
      }
      expect(moved, on ? "1-knob on" : "1-knob off").toEqual(on ? [] : band.map(([p]) => p));
    }
  });

  it("carries no EQ on an FX channel or on STREAMING, which have none", () => {
    const eq = [...bindings.keys()].filter((p) => /^ch\.(fx1|fx2|bus\.stream)\.eq\./.test(p));
    expect(eq).toEqual([]);
    expect(bindings.has("ch.ch1.eq.on"), "a channel's EQ is carried").toBe(true);
  });

  it("refuses a value of the wrong kind, and an enumeration it does not hold", () => {
    const plan = defaultPlan(modelId);
    expect(isRefusal(bindings.get("ch.ch1.on")!.write!(plan, 3))).toBe(true);
    expect(isRefusal(bindings.get("ch.ch1.gate.threshold")!.write!(plan, "loud"))).toBe(true);
    expect(isRefusal(bindings.get("ch.ch1.comp.knee")!.write!(plan, "Firm"))).toBe(true);
    expect(isRefusal(bindings.get("ch.ch1.eq.low.shape")!.write!(plan, "LPF")), "LPF is the high band's").toBe(true);
  });

  it("takes no edit of a send the plan does not wire, and shows it off", () => {
    const plan = defaultPlan(modelId);
    plan.connections = plan.connections.filter((c) => !(c.from === "ch1:out" && c.to === "bus.mix1:in"));
    const level = bindings.get("ch.ch1.send.bus.mix1.level")!;
    expect(level.read(plan)).toBe(-96.5);
    expect(level.write!(plan, -10)).toEqual({ refused: "unwired" });
  });

  /** A mono channel whose jack carries HI-Z on a new plan. */
  function hiZChannel(): string {
    const plan = defaultPlan(modelId);
    const found = ["ch1", "ch2", "ch3", "ch4"].find((ch) => {
      const write = bindings.get(`ch.${ch}.hiZ`)?.write;
      return write !== undefined && !isRefusal(write(plan, true));
    });
    if (!found) throw new Error(`no ${modelId} channel reads a jack with HI-Z`);
    return found;
  }

  it("refuses HI-Z on a jack that has none", () => {
    const plan = defaultPlan(modelId);
    const without = ["ch1", "ch2", "ch3", "ch4"]
      .filter((ch) => bindings.has(`ch.${ch}.hiZ`))
      .find((ch) => {
        const r = bindings.get(`ch.${ch}.hiZ`)!.write!(plan, true);
        return isRefusal(r) && r.refused === "noHiZ";
      });
    expect(without, `some ${modelId} channel reads a jack without HI-Z`).toBeDefined();
  });

  it("refuses +48V on a jack whose HI-Z is on, and HI-Z on a jack carrying +48V", () => {
    const ch = hiZChannel();
    const plan = defaultPlan(modelId);
    const on = bindings.get(`ch.${ch}.hiZ`)!.write!(plan, true);
    if (isRefusal(on)) throw new Error(on.refused);
    apply(model, plan, on);
    expect(bindings.get(`ch.${ch}.phantom`)!.write!(plan, true)).toEqual({ refused: "phantom" });

    const other = defaultPlan(modelId);
    const phantom = bindings.get(`ch.${ch}.phantom`)!.write!(other, true);
    if (isRefusal(phantom)) throw new Error(phantom.refused);
    apply(model, other, phantom);
    expect(bindings.get(`ch.${ch}.hiZ`)!.write!(other, true)).toEqual({ refused: "hiZ" });
  });

  it("writes A.Gain down to +40 dB as HI-Z goes on over it, on the jack the channel reads", () => {
    const ch = hiZChannel();
    const plan = defaultPlan(modelId);
    const up = bindings.get(`ch.${ch}.gain`)!.write!(plan, 60);
    if (isRefusal(up)) throw new Error(up.refused);
    apply(model, plan, up);
    const on = bindings.get(`ch.${ch}.hiZ`)!.write!(plan, true);
    if (isRefusal(on)) throw new Error(on.refused);
    apply(model, plan, on);
    expect(bindings.get(`ch.${ch}.gain`)!.read(plan)).toBe(40);
  });
});
