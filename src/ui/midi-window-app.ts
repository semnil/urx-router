// The MIDI control window's controller: it holds the last state the main window
// pushed, relays the operator's intents back, and repaints through the view.
//
// Split out of src/midi-window.ts so the relay contract — a malformed payload
// changes nothing, a state push switches language before painting, a reload asks
// for the state again, a teardown reports itself — is drivable without a window.
// The window's entry point does nothing but hand this module its host element.

import { midiUiAttachWindow, midiUiToMain } from "../core/platform";
import { LANGS, setLang } from "../i18n";
import type { Lang } from "../i18n";
import { parseRelay } from "./midi-protocol";
import type { MidiUiIntent, MidiUiState } from "./midi-protocol";
import { renderMidiWindow } from "./midi-window-view";

/** What the window shows before the main window has answered its `ready`: no ports,
 *  no mappings, learn off. Built fresh per start so one window cannot inherit
 *  another's leftovers. */
export function initialMidiUiState(): MidiUiState {
  return {
    inputs: [],
    outputs: [],
    input: null,
    output: null,
    rows: [],
    learnOn: false,
    armed: null,
    status: "",
    lang: "en",
    theme: "dark",
  };
}

/**
 * Wire the window: paint the empty state, subscribe to the relay, ask the main
 * window for the current state, and report the teardown.
 *
 * A send that fails is dropped — the far side of the relay is a window that may
 * already be gone, and there is nothing this view could do about it.
 */
export function startMidiWindow(host: HTMLElement): void {
  let state = initialMidiUiState();
  const send = (intent: MidiUiIntent): void => void midiUiToMain(JSON.stringify(intent)).catch(() => {});
  const paint = (): void => renderMidiWindow(host, state, send);

  void midiUiAttachWindow((payload) => {
    const next = parseRelay<MidiUiState>(payload);
    if (!next) return;
    state = next;
    // The relay carries opaque JSON, so `lang` is a claim rather than a Lang: an
    // unregistered value would leave the catalog lookup undefined and every later
    // paint would throw, blanking the window for good. Keep the current language
    // instead — the rest of the state is still worth showing.
    if (LANGS.includes(state.lang)) setLang(state.lang as Lang);
    paint();
  });

  // The main window holds the state; this one asks for it on boot and after any
  // reload, so a reloaded window is never left rendering an empty list.
  send({ type: "ready" });

  // Closing the window has to reach the main window even when the OS tears it down
  // without a Rust-side Destroyed (a reload, a crashed webview): learn mode is armed
  // against a control the operator can no longer see.
  window.addEventListener("pagehide", () => send({ type: "closed" }));

  paint();
}
