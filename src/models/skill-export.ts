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

// Compact, machine-readable shape consumed by scripts/plan_tool.py. A rule is a
// [from, to, kind, fixed] tuple; nodes keep array order so the JSON mirrors the
// model exactly.
export interface SkillModel {
  name: string;
  nodes: Record<string, { kind: NodeKind; label: string }>;
  rules: [string, string, ConnectionKind, boolean][];
}

function skillModel(model: DeviceModel): SkillModel {
  const nodes: SkillModel["nodes"] = {};
  for (const n of model.nodes) nodes[n.id] = { kind: n.kind, label: fullLabel(n) };
  return {
    name: model.name,
    nodes,
    rules: model.rules.map((r) => [r.from, r.to, r.kind, Boolean(r.fixed)]),
  };
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
