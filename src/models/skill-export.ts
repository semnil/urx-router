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
import { INSERT_FX_OPTIONS } from "../core/control/params";
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
   *  reach from the routing data, and one it would otherwise have to spell out itself. */
  channelPairs: [string, string][];
  /** Per channel insert-FX selector: everything a reader needs to work out what a write
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
}

function skillModel(model: DeviceModel): SkillModel {
  const nodes: SkillModel["nodes"] = {};
  for (const n of model.nodes) nodes[n.id] = { kind: n.kind, label: fullLabel(n) };
  return {
    name: model.name,
    nodes,
    rules: model.rules.map((r) => [r.from, r.to, r.kind, Boolean(r.fixed)]),
    channelPairs: model.channelPairs.map(([a, b]) => [a, b]),
    insertFxParamSpace: insertFxParamSpaceBySelector(),
  };
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
  for (const option of INSERT_FX_OPTIONS) {
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
  patch: "output patch select (single-input)",
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
    "their params (level/pan/on) but not delete them.",
    "",
  );
  for (const kind of ROUTE_KIND_ORDER) {
    const group = model.rules.filter((r) => r.kind === kind);
    if (group.length === 0) continue;
    lines.push(`### kind: \`${kind}\``, `_${ROUTE_KIND_DESC[kind]}_`, "");
    // Rows are grouped by destination (sorted) so the same selector's sources sit
    // together; sources within a row keep model order. fixed marks a destination
    // any of whose wires is structural.
    const dests = [...new Set(group.map((r) => r.to))].sort();
    for (const to of dests) {
      const into = group.filter((r) => r.to === to);
      const fixed = into.some((r) => r.fixed);
      const sources = into.map((r) => `\`${r.from}\``).join(", ");
      lines.push(`- **-> \`${to}\`**${fixed ? " *(fixed)*" : ""}: ${sources}`);
    }
    lines.push("");
  }

  // Single trailing newline (the join supplies inter-line breaks; drop the last
  // blank pushed after the final route group).
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n") + "\n";
}
