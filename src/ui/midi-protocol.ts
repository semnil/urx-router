// What crosses between the main window and the MIDI control window.
//
// The MIDI window is a view: it renders `MidiUiState` and reports `MidiUiIntent`.
// Everything it would need to compute — which controls exist, what a control is
// called, whether a mapping is a gang member — is resolved in the main window,
// where the plan and the engine live. The window therefore holds no model, no plan
// and no MIDI port, and a message it cannot understand costs it nothing.
//
// Both sides share this file rather than a copied shape, so a field added on one
// side fails to compile on the other.

import type { ControlKind } from "../core/midi/controls";
import type { ButtonMode, TakeMode } from "../core/midi/mapping";
import type { Lang } from "../i18n";

/** One assignment, already resolved for display. */
export interface MidiUiRow {
  /** The control id — the key every intent names a row by. */
  control: string;
  /** Localized ("CH 1 · GATE · Threshold"). */
  label: string;
  /** Full address text, or absent for a gang member (it has no address of its own). */
  addr?: string;
  kind: ControlKind;
  /** Which behaviour control this row offers, or absent for none. A continuous
   *  control takes a take-in mode and a toggle a button behaviour — except on an
   *  address that can never fire a toggle (pitch bend and a 14-bit CC pair, which
   *  `toggleTarget` refuses), where offering one would suggest the binding does
   *  something. Decided in the main window: which addresses those are is engine
   *  knowledge, and this window holds none. */
  option?: "mode" | "button";
  mode: TakeMode;
  button?: ButtonMode;
  /** Shares one physical control with the assignment above it. */
  linked: boolean;
}

export interface MidiUiState {
  inputs: string[];
  outputs: string[];
  input: string | null;
  output: string | null;
  rows: MidiUiRow[];
  learnOn: boolean;
  /** The localized name of the armed control, or null when nothing is armed. */
  armed: string | null;
  /** The last thing worth saying — a binding, a port failure. */
  status: string;
  lang: Lang;
  theme: "dark" | "light";
}

export type MidiUiIntent =
  /** The window booted (or reloaded) and wants the current state. */
  | { type: "ready" }
  /** The window is going away: drop learn mode. */
  | { type: "closed" }
  | { type: "learn"; on: boolean }
  | { type: "remove"; control: string }
  | { type: "mode"; control: string; mode: TakeMode }
  | { type: "button"; control: string; button: ButtonMode }
  | { type: "port"; dir: "in" | "out"; name: string | null }
  | { type: "refreshPorts" };

/** Parse a relayed payload, or null when it is not the shape this side expects.
 *  The relay carries opaque strings, and a window that reloads mid-flight can
 *  deliver a message from the previous session. */
export function parseRelay<T>(payload: string): T | null {
  try {
    const v: unknown = JSON.parse(payload);
    return typeof v === "object" && v !== null ? (v as T) : null;
  } catch {
    return null;
  }
}
