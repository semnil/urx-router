// The MIDI control window's entry point.
//
// This window is a view. It has no plan, no device model, no MIDI port and no
// engine: it renders the state the main window sends and reports what the operator
// did (ui/midi-protocol.ts). That is not a simplification for its own sake — a MIDI
// input port delivers its bursts to the window that opened it, so a window with no
// plan must never open one.
//
// It shares an origin with the main window, so the language and theme it starts in
// come straight out of the same localStorage keys; every state push then carries
// both, which is what makes a switch in the main window reach this one.
//
// Everything past the host element lives in ui/midi-window-app.ts (state + relay)
// and ui/midi-window-view.ts (state → DOM), so both are reachable from a unit test.

import "./style.css";
import { startMidiWindow } from "./ui/midi-window-app";

startMidiWindow(document.getElementById("midi-window") as HTMLElement);
