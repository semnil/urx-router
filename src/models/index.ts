// Registry of the three supported hardware models.

import { buildModel } from "./build";
import type { ModelParams } from "./build";
import type { DeviceModel, ModelId } from "./types";

const PARAMS: ModelParams[] = [
  {
    id: "URX22",
    name: "URX22",
    monoCh: 2,
    stereoCh: 4,
    micLine: 2,
    usbDaw: 10,
    hasSD: false,
    hasHDMI: false,
    hasLineOut: false,
  },
  {
    id: "URX44",
    name: "URX44",
    monoCh: 4,
    stereoCh: 4,
    micLine: 4,
    usbDaw: 12,
    hasSD: true,
    hasHDMI: false,
    hasLineOut: true,
  },
  {
    id: "URX44V",
    name: "URX44V",
    monoCh: 4,
    stereoCh: 4,
    micLine: 4,
    usbDaw: 12,
    hasSD: true,
    hasHDMI: true,
    hasLineOut: true,
  },
];

export const MODEL_IDS: ModelId[] = PARAMS.map((p) => p.id);

export const MODELS: Record<ModelId, DeviceModel> = Object.fromEntries(
  PARAMS.map((p) => [p.id, buildModel(p)]),
) as Record<ModelId, DeviceModel>;

export function getModel(id: ModelId): DeviceModel {
  return MODELS[id];
}

/** The name of one side of a two-sided node (a MIC/LINE input node's jack, a stereo
 *  channel's channel); a node with no sides answers its own label. */
export function sideLabel(model: DeviceModel, nodeId: string, side: "L" | "R"): string {
  const node = model.nodes.find((n) => n.id === nodeId);
  if (!node) return nodeId;
  return node.sideLabels?.[side === "R" ? 1 : 0] ?? node.label;
}
