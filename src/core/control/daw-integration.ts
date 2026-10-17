// SETUP > Software Integration: whether a compatible DAW holds the unit (param 816), and the MIX
// bus each FX bus is fed from post-fader while one does (879 / 880). State of the unit outside the
// plan, read and written by the live session and shown on the SIM view's glass, which names the
// buses as urx-lcd-sim does — MIX 1, MIX 2.

import { vdGet, vdSet } from "../platform";
import { PARAMS } from "./params";
import { addrKey } from "./translate";
import { writeSettle } from "./settle";

export type IntegrationSend = "MIX 1" | "MIX 2";
export type IntegrationSlot = "fx1Send" | "fx2Send";

/** What the session holds of SETUP > Software Integration. */
export interface DawIntegration {
  /** Whether a compatible DAW holds the unit, which is what makes the screen usable on it. */
  active: boolean;
  fx1Send: IntegrationSend | null;
  fx2Send: IntegrationSend | null;
}

/** Each bus's 879 / 880 value. */
const SENDS: ReadonlyArray<{ send: IntegrationSend; raw: number }> = [
  { send: "MIX 1", raw: 288 },
  { send: "MIX 2", raw: 290 },
];

const SLOT_PARAM: Record<IntegrationSlot, number> = {
  fx1Send: PARAMS.POST_FADER_SEND_FX1.id,
  fx2Send: PARAMS.POST_FADER_SEND_FX2.id,
};
export const INTEGRATION_SLOTS = Object.keys(SLOT_PARAM) as IntegrationSlot[];

/** The glass's path for one slot, as urx-lcd-sim names it. */
const glassPath = (slot: IntegrationSlot): string => `setup.integration.${slot}`;
/** The glass's paths of both slots. */
export const INTEGRATION_GLASS_PATHS: readonly string[] = INTEGRATION_SLOTS.map(glassPath);

/** One value of SETUP > Software Integration the session holds. */
export type IntegrationField = keyof DawIntegration;
const FIELD_PARAM: Record<IntegrationField, number> = { active: PARAMS.DAW_INTEGRATION.id, ...SLOT_PARAM };
export const INTEGRATION_FIELDS = Object.keys(FIELD_PARAM) as IntegrationField[];

/** The value an 816 / 879 / 880 address carries, or null for any other param. */
export function integrationFieldOf(paramId: number): IntegrationField | null {
  return INTEGRATION_FIELDS.find((f) => FIELD_PARAM[f] === paramId) ?? null;
}

/** `read` taken over `held` value by value, keeping each value `moved` names: it changed while the
 *  read was out, and the change is newer than the read's answer. */
export function mergeIntegrationRead(
  held: DawIntegration | null,
  read: DawIntegration,
  moved: ReadonlySet<IntegrationField>,
): DawIntegration {
  if (!held) return read;
  return {
    active: moved.has("active") ? held.active : read.active,
    fx1Send: moved.has("fx1Send") ? held.fx1Send : read.fx1Send,
    fx2Send: moved.has("fx2Send") ? held.fx2Send : read.fx2Send,
  };
}

/** The notify addresses of SETUP > Software Integration, which a session registers. */
export function dawIntegrationNotifyAddrs(): [number, number, number][] {
  return INTEGRATION_FIELDS.map((f): [number, number, number] => [FIELD_PARAM[f], 0, 0]);
}

/** The bus an 879 / 880 value names, or null for a value that names neither. */
export function decodeIntegrationSend(raw: number): IntegrationSend | null {
  return SENDS.find((s) => s.raw === raw)?.send ?? null;
}

/** The 879 / 880 value for `send`, or null for a name that is neither bus. */
export function encodeIntegrationSend(send: string): number | null {
  return SENDS.find((s) => s.send === send)?.raw ?? null;
}

/** `state` with one notify of SETUP > Software Integration taken in, or null for any other param. */
export function withIntegrationNotify(state: DawIntegration, paramId: number, value: number): DawIntegration | null {
  const field = integrationFieldOf(paramId);
  if (field === null) return null;
  return field === "active" ? { ...state, active: value !== 0 } : { ...state, [field]: decodeIntegrationSend(value) };
}

/** Read 816, 879 and 880. The caller must have connected first. */
export async function readDawIntegration(): Promise<DawIntegration> {
  const active = (await vdGet(PARAMS.DAW_INTEGRATION.id, 0, 0)) !== 0;
  const fx1Send = decodeIntegrationSend(await vdGet(SLOT_PARAM.fx1Send, 0, 0));
  const fx2Send = decodeIntegrationSend(await vdGet(SLOT_PARAM.fx2Send, 0, 0));
  return { active, fx1Send, fx2Send };
}

/** Write one slot, resolving once the unit has announced it — or once the settle window has
 *  passed, for a write that changed nothing and so is announced by nothing. The caller must have
 *  connected first. */
export async function writeIntegrationSend(slot: IntegrationSlot, raw: number): Promise<void> {
  const id = SLOT_PARAM[slot];
  const mark = writeSettle.mark();
  await vdSet(id, 0, 0, raw);
  await writeSettle.settle(new Map([[addrKey(id, 0, 0), mark]]));
}

/** The glass's value of each slot `state` knows, by path. */
export function integrationGlassValues(state: DawIntegration): Map<string, IntegrationSend> {
  const out = new Map<string, IntegrationSend>();
  for (const slot of INTEGRATION_SLOTS) {
    const send = state[slot];
    if (send !== null) out.set(glassPath(slot), send);
  }
  return out;
}

/** The slot a glass path is, or null for any other path. */
export function integrationSlotAt(path: string): IntegrationSlot | null {
  return INTEGRATION_SLOTS.find((s) => glassPath(s) === path) ?? null;
}
