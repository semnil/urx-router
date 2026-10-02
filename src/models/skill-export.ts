// Single source of truth for the urx-routing-planner skill's bundled routing
// data. The skill ships a self-contained copy of every node and legal route so
// it works without this repo, but that copy must never drift from the live
// DeviceModel. These pure renderers derive the skill artifacts straight from
// MODELS; skill-export.test.ts both regenerates them (UPDATE_SKILL=1) and guards
// against drift in CI. Keep the output byte-for-byte identical to the committed
// files so the guard stays a pure equality check.

import { MODEL_IDS, getModel } from "./index";
import { fullLabel } from "./types";
import type { ConnectionKind, DeviceModel, NodeKind } from "./types";
import { INSERT_FX_OPTIONS, OUTPUT_INSERT_FX_OPTIONS } from "../core/control/params";
import { isPlainRecord, type NodeParams } from "../core/plan";
import { factoryNodeParams } from "./initial-state";
import { monoPairsInto } from "../core/routing";
import { hasHiZInput, nodeLeafRules, type LeafRule } from "../core/control/translate";
import { HI_Z_A_GAIN_MAX_DB } from "../core/control/vd";
import { FX_CHANNEL_NODE_INDEX, fxEffectTypes, fxParams } from "../core/control/fx-effect";
import {
  insertFxDeviceDriven,
  insertFxDriverSlots,
  insertFxFamilyOf,
  insertFxWritableSlots,
} from "../core/control/insert-fx-effect";

// Compact, machine-readable shape consumed by scripts/plan_tool.py. A rule is a
// [from, to, kind, fixed] tuple; nodes keep array order so the JSON mirrors the
// model exactly.
export interface SkillModel {
  name: string;
  nodes: Record<string, { kind: NodeKind; label: string }>;
  rules: [string, string, ConnectionKind, boolean][];
  /** The MONO IN pairs, primary first. Carried because a pair whose Signal Type is
   *  STEREO holds one insert effect between its two channels, so the validator has to
   *  collapse it to one slot holder the way `insertFxCensus` does — a rule it cannot
   *  reach from the routing data, and one it would otherwise have to spell out itself;
   *  and because a USB output takes a pair's two channels as two wires, which the
   *  validator derives from these pairs and the patch rules the way routing.ts
   *  `monoPairsInto` does. */
  channelPairs: [string, string][];
  /** Receivers that always hold exactly one source, keyed by input ref, each with the source
   *  the app's load gives a document that names none. Carried so the validator reports that
   *  completion from the model rather than spelling STREAMING out itself. */
  requiredSources: Record<string, string>;
  /** Per insert-FX selector, the channels' and the output buses': everything a reader needs to work out what a write
   *  SENDS for that effect's engine values. Model-INDEPENDENT — carried per model because the
   *  file is keyed by model id, and a key beside those would read as a fourth model to
   *  anything that asks `modelId in models`.
   *
   *  It travels as ONE entry because it is read as one, and no part of it is guessable from
   *  another: the four guitar amps are one resource slot and four namespaces, the resource
   *  slot's own name ("guitar amp") is a display word matching no namespace, a value outside
   *  its slot's range reaches the unit as the end of that range, and a slot the unit is
   *  driving itself is not sent at all. */
  insertFxParamSpace: Record<
    string,
    {
      /** The namespace stored values live under (`guitar-clean`, `pitch`, …). */
      family: string;
      /** Every slot a write can send, with the range it is bounded to, the second slot a
       *  mirrored value also goes to, and whether it is sent under the DRIVER name. */
      slots: { slot: number; rawMin: number; rawMax: number; mirror?: number; driver?: true }[];
      /** The slots the unit drives ITSELF while `gate` is non-zero, which the write then
       *  leaves out. Absent for a family that drives nothing. */
      driven?: { gate: number; slots: number[] };
    }
  >;
  /** Per FX-channel node id: the effect types its menu offers, and what each parameter key
   *  ADMITS. Both are what `plan_tool.py` needs to answer the two questions it could not:
   *  a `type` the menu does not offer (dropped on load, since a menu has no nearest member)
   *  and a finite number outside what its control admits (bounded on load).
   *
   *  The admitted set is the CONTROL's rather than a window, because that is what the app
   *  normalises against: a toggle takes 0 and 1 with no bounds written down, a select takes
   *  its option values, and only a slider has a window. A key is listed ONCE per channel —
   *  the catalogue pins that one channel never gives a key two different windows, which is
   *  why the app can bound a key whichever of its types named it. */
  fxChannels: Record<
    string,
    {
      types: number[];
      params: Record<string, { control: string; rawMin?: number; rawMax?: number; options?: number[] }>;
    }
  >;
  /** The channels carrying the HI-Z switch, and A.Gain's upper bound while it is on. With HI-Z
   *  on, the load turns +48V off and bounds A.Gain to that value. */
  hiZ: { channels: string[]; gainMaxDb: number };
  /** Per node, every on/off leaf the model's factory values carry, in the validator's path
   *  spelling (`eqBands[0].on`). The load converts a number written at one of them to on, or to
   *  off for 0 (`booleanParamProblems`). */
  booleanLeaves: Record<string, string[]>;
  /** The model's factory values, which the load completes a document from. Per node, the
   *  params `factoryNodeParams` answers; the load drops a value whose kind is not the factory
   *  value's at the same path (`paramRangeProblems`). */
  factory: { nodeParams: Record<string, NodeParams> };
  /** Per node, every leaf the write bounds, in the validator's path spelling, with the rule it
   *  is bounded by (`nodeLeafRules`): a window, an integer window, a window whose value then
   *  moves to the nearest of `steps`, a menu with its default, or a leaf the write never sends
   *  (`unsent`). The load bounds a value outside it to the value the write sends, and removes an
   *  unsent one (`paramRangeProblems`). A rule that depends on the node's own state carries the
   *  rule that state gives under the state's name — `hiZ` while HI-Z is on — beside the rule the
   *  factory state gives. The insert-FX engine keys are not here: which rule a key takes is its
   *  family's, which `insertFxParamSpace` carries. */
  leafRules: Record<string, Record<string, LeafRule & Partial<Record<LeafContext, LeafRule>>>>;
}

function skillModel(model: DeviceModel): SkillModel {
  const nodes: SkillModel["nodes"] = {};
  for (const n of model.nodes) nodes[n.id] = { kind: n.kind, label: fullLabel(n) };
  return {
    name: model.name,
    nodes,
    rules: model.rules.map((r) => [r.from, r.to, r.kind, Boolean(r.fixed)]),
    channelPairs: model.channelPairs.map(([a, b]) => [a, b]),
    requiredSources: { ...model.requiredSources },
    insertFxParamSpace: insertFxParamSpaceBySelector(),
    fxChannels: fxChannelCatalogue(),
    hiZ: {
      channels: model.nodes.filter((n) => hasHiZInput(model.id, n.id)).map((n) => n.id),
      gainMaxDb: HI_Z_A_GAIN_MAX_DB,
    },
    booleanLeaves: booleanLeaves(model),
    factory: { nodeParams: factoryParams(model) },
    leafRules: leafRules(model),
  };
}

/** Each node's bounded leaves, asked of the emit's own rule table with the factory params. */
function leafRules(model: DeviceModel): SkillModel["leafRules"] {
  const out: SkillModel["leafRules"] = {};
  for (const n of model.nodes) {
    const factory = factoryNodeParams(model.id, n.id);
    const rules: SkillModel["leafRules"][string] = {};
    for (const [path, rule] of nodeLeafRules(model, n.id, factory)) {
      const entry: SkillModel["leafRules"][string][string] = { ...rule };
      // The same table asked again under each state that changes a rule, and the rule kept
      // where it differs.
      for (const [context, state] of leafContexts(model, n.id)) {
        const other = nodeLeafRules(model, n.id, { ...factory, ...state }).find(([p]) => p === path)?.[1];
        if (other && JSON.stringify(other) !== JSON.stringify(rule)) entry[context] = other;
      }
      rules[path.replace(/\.([0-9]+)(?=\.|$)/g, "[$1]")] = entry;
    }
    if (Object.keys(rules).length > 0) out[n.id] = rules;
  }
  return out;
}

/** A node state a rule can depend on, by the name the validator asks it under. */
type LeafContext = "hiZ";

/** The states that change a node's rules, each as the params that put the node in it. */
function leafContexts(model: DeviceModel, nodeId: string): [LeafContext, NodeParams][] {
  return hasHiZInput(model.id, nodeId) ? [["hiZ", { hiZ: true }]] : [];
}

/** Each node's factory params, for every node the model's factory values describe. */
function factoryParams(model: DeviceModel): SkillModel["factory"]["nodeParams"] {
  const out: SkillModel["factory"]["nodeParams"] = {};
  for (const n of model.nodes) {
    const np = factoryNodeParams(model.id, n.id);
    if (np) out[n.id] = np;
  }
  return out;
}

/** The on/off leaves of each node's factory values, the set `booleanParamProblems` reads. */
function booleanLeaves(model: DeviceModel): SkillModel["booleanLeaves"] {
  const out: SkillModel["booleanLeaves"] = {};
  const walk = (value: unknown, path: string, found: string[]): void => {
    if (typeof value === "boolean") found.push(path);
    else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`, found));
    else if (isPlainRecord(value))
      for (const [key, v] of Object.entries(value)) walk(v, path ? `${path}.${key}` : key, found);
  };
  for (const n of model.nodes) {
    const found: string[] = [];
    walk(factoryNodeParams(model.id, n.id), "", found);
    if (found.length > 0) out[n.id] = found;
  }
  return out;
}

/** The FX channels' menus and admitted sets, derived from the app's own catalogue. */
function fxChannelCatalogue(): SkillModel["fxChannels"] {
  const out: SkillModel["fxChannels"] = {};
  for (const [nodeId, fxIndex] of Object.entries(FX_CHANNEL_NODE_INDEX)) {
    const params: SkillModel["fxChannels"][string]["params"] = {};
    for (const type of fxEffectTypes(fxIndex)) {
      for (const d of fxParams(type.value)) {
        if (params[d.key]) continue;
        params[d.key] = {
          control: d.control,
          ...(d.rawMin !== undefined ? { rawMin: d.rawMin } : {}),
          ...(d.rawMax !== undefined ? { rawMax: d.rawMax } : {}),
          ...(d.options ? { options: d.options.map((o) => o.value).sort((a, b) => a - b) } : {}),
        };
      }
    }
    out[nodeId] = { types: fxEffectTypes(fxIndex).map((o) => o.value), params };
  }
  return out;
}

/**
 * Where one channel insert-FX selector's engine values live, and which of them a write sends.
 *
 * `plan_tool.py` compares the two members of a STEREO-linked pair by the state a write would
 * leave, and needs both halves to do it: the NAMESPACE, because the loader re-keys a bare
 * slot under the selected family and a value under any other family is not sent; and the
 * SLOTS, because an engine value the write skips is not part of the state either (slot 0 is
 * the engine's own type id). Neither is derivable from routing data, and the resource-slot
 * name the tool shows an author ("guitar amp") is not the namespace — it is one word over
 * four families.
 *
 * Both are derived from the app's own catalogue, so a family renamed or a slot added arrives
 * here with it. Keyed by SELECTOR because that is what a document carries.
 */
function insertFxParamSpaceBySelector(): SkillModel["insertFxParamSpace"] {
  const out: SkillModel["insertFxParamSpace"] = {};
  for (const option of [...INSERT_FX_OPTIONS, ...OUTPUT_INSERT_FX_OPTIONS]) {
    if (String(option.value) in out) continue;
    const family = insertFxFamilyOf(option.value);
    if (!family) continue;
    const drivers = insertFxDriverSlots(family);
    const slots = [...insertFxWritableSlots(family)]
      .sort((a, b) => a.slot - b.slot)
      .map((s) => ({
        slot: s.slot,
        rawMin: s.rawMin,
        rawMax: s.rawMax,
        ...(s.mirror !== undefined ? { mirror: s.mirror } : {}),
        ...(drivers.has(s.slot) ? { driver: true as const } : {}),
      }));
    // The driven set is decided at write time by ONE slot's value, so what goes out is that
    // slot and the set it gates — asked of the catalogue with the gate on and again with it
    // off, rather than restated here. A family that drives nothing answers the same both
    // times and carries no entry.
    const gate = [...drivers].find(
      (g) => insertFxDeviceDriven(family, { [`${family}:${g}`]: 1 }).size > insertFxDeviceDriven(family, {}).size,
    );
    const driven = gate === undefined ? [] : [...insertFxDeviceDriven(family, { [`${family}:${gate}`]: 1 })];
    out[String(option.value)] = {
      family,
      slots,
      ...(gate !== undefined && driven.length > 0 ? { driven: { gate, slots: driven.sort((a, b) => a - b) } } : {}),
    };
  }
  return out;
}

/** The full models.json payload (every supported model), in registry order. */
export function skillModelsJson(): string {
  const out: Record<string, SkillModel> = {};
  for (const id of MODEL_IDS) out[id] = skillModel(getModel(id));
  return JSON.stringify(out);
}

// Display order for the node tables and the legal-route sections. Node groups
// follow the layout pipeline; route groups list the single-input selectors
// before the summing sends. A kind absent from a model is simply skipped.
const NODE_KIND_ORDER: NodeKind[] = ["input", "channel", "bus", "output", "ducker"];
const ROUTE_KIND_ORDER: ConnectionKind[] = ["source", "patch", "key", "record", "send", "sendSwitch"];

const ROUTE_KIND_DESC: Record<ConnectionKind, string> = {
  source: "input source select (single-input: at most one wire into the destination)",
  patch: "output patch select (single-input; a USB output also takes a MONO IN pair as two wires)",
  key: "ducker side-chain key select (single-input)",
  record: "microSD record-track source select (single-input)",
  send: "summing send into a bus (many sources allowed; carries level/pan/tap)",
  sendSwitch: "ON/OFF assign into a bus (no level/pan)",
};

export function renderModelMarkdown(model: DeviceModel): string {
  const lines: string[] = [];
  lines.push(`# ${model.name} (${model.id}) — routing reference`, "");
  lines.push(
    "Ground truth extracted from the URX Router device model. Use the exact node ids",
    "and `from`/`to` refs below; only routes listed here are legal.",
    "",
  );

  lines.push("## Nodes", "");
  for (const kind of NODE_KIND_ORDER) {
    const group = model.nodes.filter((n) => n.kind === kind);
    if (group.length === 0) continue;
    lines.push(`### ${kind}`, "", "| id | label | ports |", "|---|---|---|");
    for (const n of group) {
      const ports = n.ports.map((p) => `${p.id} (${p.direction})`).join(", ");
      lines.push(`| \`${n.id}\` | ${fullLabel(n)} | ${ports} |`);
    }
    lines.push("");
  }

  lines.push("## Legal routes", "");
  lines.push(
    "Each row is a legal wire from -> to with its kind. fixed wires are structural:",
    "they always exist (seeded into every plan) and cannot be removed; you may set",
    "their params (level/pan/on) but not delete them. *(fixed)* after a destination marks",
    "every source in that row; after a source, that source alone.",
    "",
  );
  for (const kind of ROUTE_KIND_ORDER) {
    const group = model.rules.filter((r) => r.kind === kind);
    if (group.length === 0) continue;
    lines.push(`### kind: \`${kind}\``, `_${ROUTE_KIND_DESC[kind]}_`, "");
    // Rows are grouped by destination (sorted) so the same selector's sources sit
    // together; sources within a row keep model order. fixed marks a destination
    // all of whose wires are structural; a row that mixes structural and removable
    // wires marks each structural source instead.
    // A destination that takes a MONO IN pair as two wires says which pairs, and which
    // channel's slot each half is written with.
    const dests = [...new Set(group.map((r) => r.to))].sort();
    for (const to of dests) {
      const into = group.filter((r) => r.to === to);
      const fixed = into.every((r) => r.fixed);
      const sources = into.map((r) => `\`${r.from}\`${!fixed && r.fixed ? " *(fixed)*" : ""}`).join(", ");
      const pairs = kind === "patch" ? monoPairsInto(model, to) : [];
      const pairNote = pairs.length
        ? ` — or two wires, one from each channel of a MONO IN pair (${pairs
            .map(([a, b]) => `\`${a}:out\` + \`${b}:out\``)
            .join(", ")}), written L = the first channel, R = the second`
        : "";
      // A receiver the unit never leaves without a source says so, and what a plan naming
      // none is given on load.
      const required = model.requiredSources[to];
      const requiredNote = required
        ? ` — always exactly one wire (the unit's list offers no None); a plan naming none gets \`${required}\` on load`
        : "";
      lines.push(`- **-> \`${to}\`**${fixed ? " *(fixed)*" : ""}: ${sources}${pairNote}${requiredNote}`);
    }
    lines.push("");
  }

  // Single trailing newline (the join supplies inter-line breaks; drop the last
  // blank pushed after the final route group).
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n") + "\n";
}
