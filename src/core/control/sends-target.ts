// The destination HOME's [Sends] tab shows (param 763): UI state of the unit outside the plan,
// read and written by the live session and shown on the SIM view's glass. The glass names the
// destinations as urx-lcd-sim does — ST, MIX1, MIX2, FX1, FX2.

import type { DeviceModel } from "../../models/types";
import { nodeRateDisabled } from "../constraints";
import { vdGet, vdSet } from "../platform";
import { PARAMS } from "./params";
import { addrKey } from "./translate";
import { writeSettle } from "./settle";

export type SendsTarget = "ST" | "MIX1" | "MIX2" | "FX1" | "FX2";

/** Each destination's 763 value and the board node it names. */
const TARGETS: ReadonlyArray<{ target: SendsTarget; raw: number; node: string }> = [
  { target: "ST", raw: 0, node: "bus.stereo" },
  { target: "FX1", raw: 16, node: "bus.fx1" },
  { target: "FX2", raw: 17, node: "bus.fx2" },
  { target: "MIX1", raw: 32, node: "bus.mix1" },
  { target: "MIX2", raw: 34, node: "bus.mix2" },
];

/** The notify address of 763, registered by the session for the reason LCD_SELECTION_ADDR is. */
export const SENDS_TARGET_ADDR: [number, number, number] = [PARAMS.SENDS_TARGET.id, 0, 0];

const onModel = (model: DeviceModel, node: string): boolean => model.nodes.some((n) => n.id === node);

/** The destination a 763 value names on `model`, or null for a value that names none of its buses. */
export function decodeSendsTarget(model: DeviceModel, raw: number): SendsTarget | null {
  const hit = TARGETS.find((t) => t.raw === raw);
  return hit && onModel(model, hit.node) ? hit.target : null;
}

/**
 * The 763 value to write for `target` at `sampleRate` on `model`, or null when the unit is not to
 * be given it: a destination the model has no bus for, or FX 2 at a rate that takes FX 2 out —
 * the unit takes that write although its own list does not offer FX 2 there.
 */
export function encodeSendsTarget(model: DeviceModel, target: string, sampleRate: number): number | null {
  const hit = TARGETS.find((t) => t.target === target);
  if (!hit || !onModel(model, hit.node) || nodeRateDisabled(hit.node, sampleRate)) return null;
  return hit.raw;
}

/** Read 763. The caller must have connected first. */
export function readSendsTarget(): Promise<number> {
  return vdGet(PARAMS.SENDS_TARGET.id, 0, 0);
}

/** Write 763, resolving once the unit has announced it — or once the settle window has passed,
 *  for a write that changed nothing and so is announced by nothing. The caller must have
 *  connected first. */
export async function writeSendsTarget(raw: number): Promise<void> {
  const [id, x, y] = SENDS_TARGET_ADDR;
  const mark = writeSettle.mark();
  await vdSet(id, x, y, raw);
  await writeSettle.settle(new Map([[addrKey(id, x, y), mark]]));
}
