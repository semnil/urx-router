import { describe, it, expect } from "vitest";
import { MidiEngine } from "./engine";
import { encodeCc } from "./message";
import { fake } from "./fake-control";

// Reproduction of the real rig, from the measured MIDI bus trace:
//  - the Stream Deck "Push" button sends ONE CC 127 per press and NO release 0
//    (confirmed: two captures, a 0 never appears);
//  - URX Router's feedback returns as exactly one self-echo on the shared IAC
//    bus at ~0.13 ms (measured), and feedback is debounced 120 ms in the UI.
// The harness loops every sent feedback message back into onMessage after the
// measured echo delay, and drives the button as a bare 127-per-press sender.

class Bus {
  clock = 0;
  private queue: Array<{ at: number; run: () => void }> = [];
  private control = fake("ch1/mute", "toggle");
  private engine: MidiEngine;
  private feedbackPending = false;
  applied: number[] = []; // mute value after each applied edit
  constructor() {
    this.engine = new MidiEngine({
      resolve: () => this.control,
      applied: () => {
        this.applied.push(this.control.value);
        this.scheduleFeedback();
      },
      // Measured: one self-echo on the shared IAC bus at ~0.13 ms.
      send: (bytes) => this.after(0.13, () => this.engine.onMessage(bytes)),
      learned: () => {},
      learnPending: () => {},
      now: () => this.clock,
    });
    this.engine.setMappings([
      { control: "ch1/mute", addr: { type: "cc", channel: 0, controller: 0 }, mode: "absolute", button: "edge" },
    ]);
  }
  private after(ms: number, run: () => void): void {
    this.queue.push({ at: this.clock + ms, run });
  }
  private scheduleFeedback(): void {
    if (this.feedbackPending) return;
    this.feedbackPending = true;
    this.after(120, () => {
      this.feedbackPending = false;
      this.engine.feedback();
    });
  }
  // A Push press: one CC 127, no release 0 (the measured button behavior).
  press(at: number): void {
    this.queue.push({ at, run: () => this.engine.onMessage(encodeCc(0, 0, 127)) });
  }
  run(): void {
    while (this.queue.length) {
      this.queue.sort((a, b) => a.at - b.at);
      const ev = this.queue.shift()!;
      this.clock = ev.at;
      ev.run();
    }
  }
  get mute(): number {
    return this.control.value;
  }
}

describe("edge-mode Push button that sends only 127 (no release), on the measured IAC bus", () => {
  it("flips the mute on every press and the self-echo never double-flips it", () => {
    const bus = new Bus();
    bus.press(1000);
    bus.press(2000);
    bus.press(3000);
    bus.run();
    expect(bus.applied).toEqual([1, 0, 1]); // ON, OFF, ON — one flip per press
    expect(bus.mute).toBe(1);
  });
});
