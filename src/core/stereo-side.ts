// The side a stereo channel shows: one per channel, L until switched. It decides which jack's
// input stage the channel's surfaces show and edit, and which side's polarity invert the one φ
// acts on. UI state, not plan state — not saved, not undoable, not in a `?plan=` link — and
// reset when the model changes.

import { inputStageOf, isStereoChannel, type InputStage } from "./control/translate";
import type { JackSide, Plan } from "./plan";
import type { DeviceModel } from "../models/types";

const sides = new Map<string, JackSide>();
const listeners = new Set<(channelId: string, side: JackSide) => void>();

/** The side a stereo channel shows; L for a channel never switched and for any other node. */
export function displayedSide(channelId: string): JackSide {
  return sides.get(channelId) ?? "L";
}

/** Show `side` on a stereo channel. True when that changed the side; a listener hears each change once. */
export function setDisplayedSide(channelId: string, side: JackSide): boolean {
  if (!isStereoChannel(channelId) || displayedSide(channelId) === side) return false;
  sides.set(channelId, side);
  for (const fn of listeners) fn(channelId, side);
  return true;
}

/** Hear every change of a channel's displayed side. Returns the unsubscribe. */
export function onDisplayedSideChange(fn: (channelId: string, side: JackSide) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Every stereo channel back to L. */
export function resetDisplayedSides(): void {
  sides.clear();
}

/** The input stage a channel's surfaces show: a stereo channel's on its displayed side. */
export function shownStage(model: DeviceModel, plan: Plan, channelId: string): InputStage {
  return inputStageOf(model, plan, channelId, displayedSide(channelId));
}
