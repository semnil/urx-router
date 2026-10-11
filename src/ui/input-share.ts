// Which other channels read the jack or source a channel shows its input stage from — the one
// answer the Inspector's share line and the CONSOLE gain knob's tooltip both print. A stereo
// channel reading one jack is named with that side; one reading a source is named as the pair.

import { inputStageReaders } from "../core/control/translate";
import { shownStage } from "../core/stereo-side";
import type { Plan } from "../core/plan";
import type { DeviceModel } from "../models/types";
import { sideLabel } from "../models";
import { getLang, t } from "../i18n";

export interface InputShare {
  /** The other readers, joined as a list in the active language ("CH 3 and CH 5 (L)"). */
  others: string;
  /** The jack ("MIC/LINE 1") or source ("AUX IN") they share. */
  holder: string;
  kind: "jack" | "source";
}

/** The other channels reading what `channelId` shows, or null when none does. */
export function inputShare(model: DeviceModel, plan: Plan, channelId: string): InputShare | null {
  const stage = shownStage(model, plan, channelId);
  if (stage.kind === "none") return null;
  const m = t().inspector;
  const label = (id: string): string => model.nodes.find((n) => n.id === id)?.label ?? id;
  const names = inputStageReaders(model, plan, stage.node, stage.kind === "jack" ? stage.side : undefined)
    .filter((r) => r.channel !== channelId)
    .map((r) =>
      r.side ? (r.side === "L" ? m.sideL : m.sideR)(sideLabel(model, r.channel, r.side)) : label(r.channel),
    );
  if (!names.length) return null;
  return {
    others: new Intl.ListFormat(getLang(), { type: "conjunction" }).format(names),
    holder: stage.kind === "jack" ? sideLabel(model, stage.node, stage.side) : label(stage.node),
    kind: stage.kind === "jack" ? "jack" : "source",
  };
}
