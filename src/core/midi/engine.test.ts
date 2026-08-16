import { describe, it, expect, beforeEach } from "vitest";
import { MidiEngine } from "./engine";
import type { MidiAddr, MidiMapping } from "./mapping";
import { encodeCc, encodeNote } from "./message";
import { fake, type Fake } from "./fake-control.test-util";

let controls: Map<string, Fake>;
let applied: string[];
let sent: number[][];
let learned: MidiAddr[];
let pendingCount: number;
let clock: number;
let gateReason: string | null;
let refusals: string[];
let engine: MidiEngine;

beforeEach(() => {
  controls = new Map();
  applied = [];
  sent = [];
  learned = [];
  pendingCount = 0;
  clock = 0;
  gateReason = null;
  refusals = [];
  engine = new MidiEngine({
    resolve: (id) => controls.get(id) ?? null,
    applied: (c) => applied.push(c.id),
    gate: () => gateReason,
    refused: (reason) => refusals.push(reason),
    send: (bytes) => sent.push(bytes),
    learned: (addr) => learned.push(addr),
    learnPending: () => pendingCount++,
    now: () => clock,
  });
});

const map = (control: string, addr: MidiAddr, mode: MidiMapping["mode"] = "absolute"): void => {
  engine.setMappings([...engine.getMappings(), { control, addr, mode }]);
};

describe("incoming application", () => {
  it("applies an absolute CC normalized onto the control", () => {
    const c = fake("ch1/level", "continuous");
    controls.set(c.id, c);
    map(c.id, { type: "cc", channel: 0, controller: 7 });
    engine.onMessage(encodeCc(0, 7, 127));
    expect(c.value).toBe(1);
    expect(applied).toEqual(["ch1/level"]);
    // snapped no-op: same detent again → no second applied
    engine.onMessage(encodeCc(0, 7, 127));
    expect(applied).toEqual(["ch1/level"]);
  });

  it("ignores unmapped addresses and stale mappings", () => {
    map("gone/level", { type: "cc", channel: 0, controller: 7 });
    engine.onMessage(encodeCc(0, 7, 64)); // resolves to null — must not throw
    engine.onMessage(encodeCc(0, 8, 64)); // unmapped controller
    expect(applied).toEqual([]);
  });

  it("swallows edits on a device-locked control", () => {
    const c = fake("ch1/level", "continuous");
    c.locked = true;
    controls.set(c.id, c);
    map(c.id, { type: "cc", channel: 0, controller: 7 });
    engine.onMessage(encodeCc(0, 7, 127));
    expect(c.value).toBe(0);
    expect(applied).toEqual([]);
  });

  it("edge mode flips on each on-value; the release is ignored", () => {
    const c = fake("ch1/mute", "toggle");
    controls.set(c.id, c);
    map(c.id, { type: "note", channel: 0, note: 60 });
    engine.onMessage(encodeNote(0, 60, true));
    expect(c.value).toBe(1);
    engine.onMessage(encodeNote(0, 60, false)); // release: ignored, no re-toggle
    expect(c.value).toBe(1);
    engine.onMessage(encodeNote(0, 60, true));
    expect(c.value).toBe(0);

    const d = fake("ch2/mute", "toggle");
    controls.set(d.id, d);
    map(d.id, { type: "cc", channel: 0, controller: 20 });
    engine.onMessage(encodeCc(0, 20, 127)); // on → toggle
    expect(d.value).toBe(1);
    // A button that sends a fixed on-value per press with no release-to-0 between
    // (e.g. a Stream Deck "Push" set to 127 only) must flip on every press, not
    // just the first — no rising-edge requirement.
    engine.onMessage(encodeCc(0, 20, 127)); // on again → toggle back
    expect(d.value).toBe(0);
    engine.onMessage(encodeCc(0, 20, 127)); // and again
    expect(d.value).toBe(1);
    engine.onMessage(encodeCc(0, 20, 0)); // release (< 64) → ignored
    expect(d.value).toBe(1);
  });

  it("state-mode toggles follow an alternating one-message-per-press sender (Stream Deck style)", () => {
    // Regression for the Stream Deck MIDI plugin's toggle buttons: one CC per
    // press, alternating 127 / 0 — edge mode misses every second press, so a
    // per-mapping "state" behavior applies the value as the state instead.
    const c = fake("ch1/mute", "toggle");
    controls.set(c.id, c);
    engine.setMappings([
      { control: c.id, addr: { type: "cc", channel: 0, controller: 20 }, mode: "absolute", button: "state" },
    ]);
    const seen: number[] = [];
    for (const value of [127, 0, 127, 0, 127]) {
      engine.onMessage(encodeCc(0, 20, value));
      seen.push(c.value);
    }
    seen.forEach((v, i) => expect(v).toBe(i % 2 === 0 ? 1 : 0)); // every press responds
    expect(applied.length).toBe(5);
    engine.onMessage(encodeCc(0, 20, 127)); // same state again → no-op, not dirty
    expect(applied.length).toBe(5);

    // A note binding in state mode acts as "on while held".
    const n = fake("ch2/mute", "toggle");
    controls.set(n.id, n);
    engine.setMappings([
      { control: n.id, addr: { type: "note", channel: 0, note: 60 }, mode: "absolute", button: "state" },
    ]);
    engine.onMessage(encodeNote(0, 60, true));
    expect(n.value).toBe(1);
    engine.onMessage(encodeNote(0, 60, false));
    expect(n.value).toBe(0);
  });

  it("pickup swallows input until the physical value reaches or crosses the plan value", () => {
    const c = fake("ch1/level", "continuous", 0.5);
    controls.set(c.id, c);
    map(c.id, { type: "cc", channel: 0, controller: 7 }, "pickup");
    engine.onMessage(encodeCc(0, 7, 20)); // far below → swallowed
    expect(c.value).toBe(0.5);
    engine.onMessage(encodeCc(0, 7, 40)); // still below → swallowed
    expect(c.value).toBe(0.5);
    engine.onMessage(encodeCc(0, 7, 70)); // crossed 0.5 → engaged, applies
    expect(c.value).toBeCloseTo(0.55, 5); // 70/127 snapped to the 1/40 grid
    engine.onMessage(encodeCc(0, 7, 20)); // engaged: tracks anywhere now
    expect(c.value).toBeCloseTo(0.15, 5);
  });

  // A held pass (the output side shut until a Live-sync readback settles) still owes the
  // receive side its bookkeeping: the plan value moved, so a non-motorized fader no
  // longer matches it and has to pick it up again. Skipping the pass entirely left the
  // engagement standing, and the next twitch of the physical control tracked from
  // wherever it stood and pulled the plan with it.
  it("un-engages pickup on a held pass, with nothing on the wire", () => {
    const c = fake("ch1/level", "continuous", 0.5);
    controls.set(c.id, c);
    map(c.id, { type: "cc", channel: 0, controller: 7 }, "pickup");
    engine.onMessage(encodeCc(0, 7, 64)); // within the window of 0.5 → engaged
    engine.onMessage(encodeCc(0, 7, 127)); // tracks
    expect(c.value).toBe(1);

    c.value = 0.2; // the plan moves from somewhere else (a console edit, device follow)
    sent.length = 0;
    clock += 400; // past RECENT_MS: an address still being swept defers its whole pass
    engine.feedback(false, false);
    expect(sent).toEqual([]);

    // Not engaged any more: a value neither near nor crossing 0.2 is swallowed.
    engine.onMessage(encodeCc(0, 7, 120));
    expect(c.value).toBe(0.2);
  });

  it("assembles a 14-bit CC pair from both halves", () => {
    const c = fake("ch1/level", "continuous", 0, 1 / 16383);
    controls.set(c.id, c);
    map(c.id, { type: "cc14", channel: 0, controller: 7 });
    engine.onMessage(encodeCc(0, 7, 64)); // MSB alone: coarse value
    expect(c.value).toBeCloseTo((64 << 7) / 16383, 6);
    engine.onMessage(encodeCc(0, 39, 32)); // LSB refines
    expect(c.value).toBeCloseTo(((64 << 7) | 32) / 16383, 6);
  });

  it("assembles a 14-bit CC pair regardless of arrival order (LSB before MSB)", () => {
    const c = fake("ch1/level", "continuous", 0, 1 / 16383);
    controls.set(c.id, c);
    map(c.id, { type: "cc14", channel: 0, controller: 7 });
    engine.onMessage(encodeCc(0, 39, 32)); // LSB first: MSB still 0 → tiny value
    expect(c.value).toBeCloseTo(32 / 16383, 6);
    engine.onMessage(encodeCc(0, 7, 64)); // MSB completes the pair
    expect(c.value).toBeCloseTo(((64 << 7) | 32) / 16383, 6);
  });

  it("pickup engages on an exact touch of the plan value, then tracks", () => {
    const c = fake("ch1/level", "continuous", 0.5);
    controls.set(c.id, c);
    map(c.id, { type: "cc", channel: 0, controller: 7 }, "pickup");
    engine.onMessage(encodeCc(0, 7, 64)); // 64/127 ≈ 0.504, within the ±2-step window → engaged
    engine.onMessage(encodeCc(0, 7, 127)); // now tracks anywhere
    expect(c.value).toBe(1);
  });

  it("pickup engages when the physical value crosses the plan value from above", () => {
    const c = fake("ch1/level", "continuous", 0.5);
    controls.set(c.id, c);
    map(c.id, { type: "cc", channel: 0, controller: 7 }, "pickup");
    engine.onMessage(encodeCc(0, 7, 90)); // far above → swallowed, records the position
    expect(c.value).toBe(0.5);
    engine.onMessage(encodeCc(0, 7, 20)); // sweeps down through 0.5 → engaged, applies
    expect(c.value).toBeCloseTo(0.15, 5); // 20/127 snapped to the 1/40 grid
  });

  it("drives a continuous control from a note as a momentary full / zero switch", () => {
    const c = fake("ch1/level", "continuous", 0.3);
    controls.set(c.id, c);
    map(c.id, { type: "note", channel: 0, note: 60 });
    engine.onMessage(encodeNote(0, 60, true)); // press → full
    expect(c.value).toBe(1);
    engine.onMessage(encodeNote(0, 60, false)); // release → zero
    expect(c.value).toBe(0);
  });

  it("a pitch bend bound to a toggle does nothing", () => {
    const t = fake("ch1/mute", "toggle", 0);
    controls.set(t.id, t);
    map(t.id, { type: "pitchbend", channel: 0 });
    engine.onMessage([0xe0, 0x7f, 0x7f]); // full-scale bend
    expect(t.value).toBe(0);
    expect(applied).toEqual([]);
  });

  it("clears half-assembled 14-bit pair state and engaged pickup on a mapping replace", () => {
    // A remap must not carry a stale MSB half or a still-engaged pickup into the
    // next set (setMappings resets pair / pickup / echo-guard state).
    const c = fake("ch1/level", "continuous", 0, 1 / 16383);
    controls.set(c.id, c);
    map(c.id, { type: "cc14", channel: 0, controller: 7 });
    engine.onMessage(encodeCc(0, 7, 127)); // MSB only → coarse-high
    expect(c.value).toBeCloseTo((127 << 7) / 16383, 6);
    // Replace the mappings (same address): the retained MSB must not survive.
    engine.setMappings([{ control: c.id, addr: { type: "cc14", channel: 0, controller: 7 }, mode: "absolute" }]);
    engine.onMessage(encodeCc(0, 39, 64)); // LSB only → assembles against a fresh MSB 0
    expect(c.value).toBeCloseTo(64 / 16383, 6);
  });
});

describe("learn", () => {
  it("binds a note / pitch bend immediately", () => {
    engine.startLearn();
    engine.onMessage(encodeNote(2, 61, true));
    expect(learned).toEqual([{ type: "note", channel: 2, note: 61 }]);
    expect(engine.isLearning()).toBe(false);
    engine.startLearn();
    engine.onMessage([0xe3, 0, 64]);
    expect(learned[1]).toEqual({ type: "pitchbend", channel: 3 });
  });

  it("binds a CC on its second message, upgrading a pair to cc14", () => {
    engine.startLearn();
    engine.onMessage(encodeCc(0, 7, 10));
    expect(pendingCount).toBe(1);
    engine.onMessage(encodeCc(0, 7, 11));
    expect(learned).toEqual([{ type: "cc", channel: 0, controller: 7 }]);

    engine.startLearn();
    engine.onMessage(encodeCc(0, 7, 10)); // MSB
    engine.onMessage(encodeCc(0, 39, 3)); // LSB partner → 14-bit control
    expect(learned[1]).toEqual({ type: "cc14", channel: 0, controller: 7 });

    engine.startLearn();
    engine.onMessage(encodeCc(0, 41, 3)); // LSB first
    engine.onMessage(encodeCc(0, 9, 10)); // then MSB
    expect(learned[2]).toEqual({ type: "cc14", channel: 0, controller: 9 });
  });

  it("commits a lone CC via flushLearn and replaces a switched candidate", () => {
    engine.startLearn();
    engine.onMessage(encodeCc(0, 30, 127)); // a button that sends one message
    engine.flushLearn();
    expect(learned).toEqual([{ type: "cc", channel: 0, controller: 30 }]);

    engine.startLearn();
    engine.onMessage(encodeCc(0, 7, 1));
    engine.onMessage(encodeCc(0, 20, 1)); // user moved a different knob
    expect(engine.isLearning()).toBe(true);
    engine.onMessage(encodeCc(0, 20, 2));
    expect(learned[1]).toEqual({ type: "cc", channel: 0, controller: 20 });
  });

  it("does not edit controls while learning", () => {
    const c = fake("ch1/level", "continuous");
    controls.set(c.id, c);
    map(c.id, { type: "cc", channel: 0, controller: 7 });
    engine.startLearn();
    engine.onMessage(encodeCc(0, 7, 127));
    expect(c.value).toBe(0);
    engine.cancelLearn();
    expect(engine.isLearning()).toBe(false);
  });

  it("ignores a note release while learning (a lifted pad must not bind)", () => {
    engine.startLearn();
    engine.onMessage(encodeNote(0, 60, false)); // release only: no candidate, still learning
    expect(learned).toEqual([]);
    expect(engine.isLearning()).toBe(true);
    engine.onMessage(encodeNote(0, 60, true)); // the actual press binds
    expect(learned).toEqual([{ type: "note", channel: 0, note: 60 }]);
    expect(engine.isLearning()).toBe(false);
  });

  it("cancel drops a pending CC candidate, and flushLearn is a no-op when idle", () => {
    engine.flushLearn(); // idle: nothing pending, must not bind or throw
    expect(learned).toEqual([]);
    engine.startLearn();
    engine.onMessage(encodeCc(0, 30, 100)); // one CC: a pending candidate
    expect(pendingCount).toBe(1);
    engine.cancelLearn();
    expect(engine.isLearning()).toBe(false);
    engine.flushLearn(); // the cancelled candidate must not resurrect
    expect(learned).toEqual([]);
  });
});

describe("feedback", () => {
  it("sends changed values once and encodes per address kind", () => {
    const c = fake("ch1/level", "continuous", 0.5);
    const m = fake("ch1/mute", "toggle", 1);
    controls.set(c.id, c);
    controls.set(m.id, m);
    map(c.id, { type: "cc", channel: 0, controller: 7 });
    map(m.id, { type: "note", channel: 0, note: 60 });
    expect(engine.feedback()).toBe(false);
    expect(sent).toEqual([encodeCc(0, 7, 64), encodeNote(0, 60, true)]);
    sent.length = 0;
    expect(engine.feedback()).toBe(false); // unchanged → nothing re-sent
    expect(sent).toEqual([]);
    m.value = 0;
    engine.feedback();
    expect(sent).toEqual([encodeNote(0, 60, false)]);
  });

  // A send that failed never reached the controller, so the cache must not claim
  // it did — otherwise the LED or fader keeps showing the wrong state until that
  // value happens to change again on its own.
  it("re-sends everything after forgetFeedback", () => {
    const m = fake("ch1/mute", "toggle", 1);
    controls.set(m.id, m);
    map(m.id, { type: "note", channel: 0, note: 60 });
    engine.feedback();
    expect(sent).toEqual([encodeNote(0, 60, true)]);
    sent.length = 0;
    engine.feedback(); // unchanged → nothing goes out
    expect(sent).toEqual([]);
    engine.forgetFeedback();
    engine.feedback();
    expect(sent).toEqual([encodeNote(0, 60, true)]);
  });

  it("sends a 14-bit value as an MSB/LSB pair", () => {
    const c = fake("ch1/level", "continuous", 1, 1 / 16383);
    controls.set(c.id, c);
    map(c.id, { type: "cc14", channel: 0, controller: 7 });
    engine.feedback();
    expect(sent).toEqual([encodeCc(0, 7, 127), encodeCc(0, 39, 127)]);
  });

  it("defers feedback to an address that is still sending, then settles", () => {
    const c = fake("ch1/level", "continuous");
    controls.set(c.id, c);
    map(c.id, { type: "cc", channel: 0, controller: 7 });
    clock = 1000;
    engine.onMessage(encodeCc(0, 7, 100));
    // The controller already shows 100-ish: the applied value is remembered as
    // sent, so an immediate pass has nothing to say for this address.
    expect(engine.feedback()).toBe(false);
    expect(sent).toEqual([]);
    // An external edit while the knob is still hot: deferred, not fought over.
    c.value = 0.25;
    clock = 1100;
    expect(engine.feedback()).toBe(true);
    expect(sent).toEqual([]);
    clock = 1500; // quiet gap passed → the settle pass emits
    expect(engine.feedback()).toBe(false);
    expect(sent).toEqual([encodeCc(0, 7, 32)]);
  });

  it("confirms an incoming toggle back to the controller LED promptly", () => {
    const m = fake("ch1/mute", "toggle", 0);
    controls.set(m.id, m);
    map(m.id, { type: "note", channel: 0, note: 60 });
    engine.feedback(); // baseline: off
    sent.length = 0;
    clock = 1000;
    engine.onMessage(encodeNote(0, 60, true)); // press toggles to muted
    expect(m.value).toBe(1);
    // A momentary button cannot know the new state: the very next feedback pass
    // must light the LED — no quiet-gap deferral, no sent-cache suppression.
    expect(engine.feedback()).toBe(false);
    expect(sent).toEqual([encodeNote(0, 60, true)]);
  });

  it("drops an echo of just-sent toggle feedback instead of flipping back", () => {
    // A controller that mirrors feedback (a shared virtual MIDI bus, or a
    // plugin that re-sends its state when feedback changes it) returns the
    // just-sent value; an edge-mode toggle must not flip straight back.
    const mute = fake("ch1/mute", "toggle", 0);
    controls.set("ch1/mute", mute);
    map("ch1/mute", { type: "cc", channel: 0, controller: 20 });
    mute.value = 1; // muted via the UI
    engine.feedback();
    expect(sent).toEqual([encodeCc(0, 20, 127)]);
    clock += 5; // inside the window: the measured echo latency is 0.13-5 ms
    engine.onMessage(encodeCc(0, 20, 127)); // the echo
    expect(mute.value).toBe(1);
    expect(applied).toEqual([]);
    // A real press lands after the echo window and still flips.
    clock += 400;
    engine.onMessage(encodeCc(0, 20, 127));
    expect(mute.value).toBe(0);
    expect(applied).toEqual(["ch1/mute"]);
  });

  it("consumes the echo one-shot — an equal real press right after still applies", () => {
    // The transports deliver exactly one echo per sent message, so the guard
    // must disarm on the first match: a same-value press following the echo is
    // a real press (edge-mode presses are always 127) and must flip.
    const mute = fake("ch1/mute", "toggle", 0);
    controls.set("ch1/mute", mute);
    map("ch1/mute", { type: "cc", channel: 0, controller: 20 });
    mute.value = 1;
    engine.feedback(); // confirm 127
    clock += 10;
    engine.onMessage(encodeCc(0, 20, 127)); // the echo — dropped
    expect(mute.value).toBe(1);
    clock += 100; // still well inside the window
    engine.onMessage(encodeCc(0, 20, 127)); // a real press
    expect(mute.value).toBe(0);
    expect(applied).toEqual(["ch1/mute"]);
  });

  // The one-shot consumption above is asked of edge mode, where a same-value message
  // is a press and the flip is the observable. State mode has neither: the incoming
  // value IS the state, so a same-state message is a no-op whether the guard ate it or
  // the mode did — which is exactly why `e2e/race/t4b-midi.spec.ts` skips its variant
  // as not falsifiable through any observable that harness has.
  //
  // Here it is falsifiable, but only with care: the guard matches on the value last
  // SENT, so a follow-up carrying the other state gets through whether or not the echo
  // disarmed it, and a case written that way passes for the wrong reason (measured
  // while writing this). The discriminator has to repeat the SAME bytes after moving
  // the control elsewhere by another route — the app's own edit, which sends no
  // feedback and so leaves both the armed flag and lastSent as they were.
  it("consumes the echo one-shot in state mode too, where the message itself cannot show it", () => {
    const mute = fake("ch1/mute", "toggle", 0);
    controls.set("ch1/mute", mute);
    engine.setMappings([
      { control: "ch1/mute", addr: { type: "cc", channel: 0, controller: 20 }, mode: "absolute", button: "state" },
    ]);
    mute.value = 1;
    engine.feedback(); // confirm 127, arming the guard for this address
    clock += 10;

    engine.onMessage(encodeCc(0, 20, 127)); // the echo: same state, indistinguishable on its own
    expect(mute.value).toBe(1);
    expect(applied).toEqual([]);

    // Something else clears it — an app-side edit, which does not re-arm the guard.
    mute.value = 0;
    clock += 100; // still well inside the 300 ms window

    engine.onMessage(encodeCc(0, 20, 127)); // the same bytes again: a real press this time
    expect(mute.value).toBe(1); // …which lands only because the echo disarmed the guard
    expect(applied).toEqual(["ch1/mute"]);
  });

  it("drops a note feedback echo the same way", () => {
    const mute = fake("ch1/mute", "toggle", 0);
    controls.set("ch1/mute", mute);
    map("ch1/mute", { type: "note", channel: 0, note: 60 });
    mute.value = 1;
    engine.feedback();
    expect(sent).toEqual([encodeNote(0, 60, true)]);
    clock += 5; // inside the window: the measured echo latency is 0.13-5 ms
    engine.onMessage(encodeNote(0, 60, true)); // the echo
    expect(mute.value).toBe(1);
    clock += 400;
    engine.onMessage(encodeNote(0, 60, true));
    expect(mute.value).toBe(0);
  });

  it("only guards echoes within the echo window; a later equal message flips the toggle", () => {
    // The receive-side echo guard spans ECHO_MS. A same-value message that arrives
    // after the window is treated as a genuine press, not an echo — which is what the
    // window has to be short enough to allow: on a controller that never echoes, every
    // physical press arms the guard through its own LED confirm, so a window far wider
    // than the measured 0.13-5 ms echo latency swallows the operator's next press.
    const mute = fake("ch1/mute", "toggle", 0);
    controls.set("ch1/mute", mute);
    map("ch1/mute", { type: "cc", channel: 0, controller: 20 });
    mute.value = 1;
    engine.feedback(); // sends 127, arms the guard at clock 0
    expect(sent).toEqual([encodeCc(0, 20, 127)]);
    clock = ECHO_WINDOW; // exactly at the window edge → guard expired
    engine.onMessage(encodeCc(0, 20, 127)); // no longer treated as an echo → edge flips
    expect(mute.value).toBe(0);
    expect(applied).toEqual(["ch1/mute"]);
  });

  // The window's size is the property, not merely that one exists. A plain controller
  // with no loopback never sends an echo to consume the guard, and every physical edge
  // press re-arms it through its own LED confirm — so a double-tap lands inside it and
  // the second press is dropped as "the echo". Measured echo latency on the transports
  // this guard is for is 0.13-5 ms; a double-tap is 200 ms and up.
  it("lets a double-tap through, which is what keeps the window near the measured echo", () => {
    const mute = fake("ch1/mute", "toggle", 0);
    controls.set("ch1/mute", mute);
    map("ch1/mute", { type: "cc", channel: 0, controller: 20 });

    clock = 0;
    engine.onMessage(encodeCc(0, 20, 127)); // first press
    expect(mute.value).toBe(1);
    clock = 120;
    engine.feedback(); // the LED confirm, which arms the guard with 127
    clock = 200; // the second tap of a double-tap
    engine.onMessage(encodeCc(0, 20, 127));
    expect(mute.value).toBe(0);
  });

  // Finer than the 7 bits a plain CC carries, and a power of two so the fake's own
  // snapping is exact — the tuning screens' grids in the shape that matters here.
  const FINE = 1 / 256;
  const ECHO_WINDOW = 50; // ECHO_MS in engine.ts, which does not export it

  it("drops a continuous control's feedback echo, which a fine grid would take as an edit", () => {
    // The measured case (2026-08-09): a plan grid finer than the 7 bits the value
    // crossed on decodes to a NEIGHBOURING detent, so applying the echo moves the
    // value — and under Live sync that reaches the unit, once per feedback pass.
    const c = fake("ch1/attack@gate", "continuous", 0, FINE);
    controls.set(c.id, c);
    map(c.id, { type: "cc", channel: 0, controller: 40 });
    c.set(0.01);
    const before = c.value; // 3/256
    engine.feedback();
    const echo = Math.round(before * 127); // 1
    expect(sent).toEqual([encodeCc(0, 40, echo)]);
    clock += 5; // the loopback latency measured on a real bus
    engine.onMessage(encodeCc(0, 40, echo));
    expect(c.value).toBe(before);
    expect(applied).toEqual([]);
    // The guard is what prevented that, not the value being harmless: the identical
    // message past the window IS applied, and lands a detent away.
    clock += ECHO_WINDOW;
    engine.onMessage(encodeCc(0, 40, echo));
    expect(c.value).not.toBe(before);
    expect(applied).toEqual([c.id]);
  });

  it("drops the echo of a continuous control bound to a note, which applies full-scale", () => {
    // A note address carries on/off and nothing else, so the echo of a fader at 0.6
    // comes back as note-on and `continuousTarget` reads it as 1.0 — a full-scale move
    // rather than one detent, which makes it the worst of the family. It is recognised
    // because the sent cache holds the WIRE value (wireRaw) rather than the position;
    // a cache holding 76 against a wire carrying 127 missed this echo entirely.
    const c = fake("ch1/level", "continuous", 0.6);
    controls.set(c.id, c);
    map(c.id, { type: "note", channel: 0, note: 60 });
    engine.feedback();
    expect(sent).toEqual([encodeNote(0, 60, true)]);
    clock += 5;
    engine.onMessage(encodeNote(0, 60, true)); // the echo
    expect(c.value).toBe(0.6);
    expect(applied).toEqual([]);
    clock += ECHO_WINDOW; // past the window it is a genuine press, and slams to full
    engine.onMessage(encodeNote(0, 60, true));
    expect(c.value).toBe(1);
    expect(applied).toEqual([c.id]);
  });

  it("leaves a 14-bit echo unguarded, because at 14 bits it re-enters the same value", () => {
    // A cc14 echo arrives as two 7-bit halves that cannot be matched against the
    // 14-bit cache, and does not need to be: the round trip is exact for every
    // control (pinned in controls.test.ts), so applying it changes nothing. Pinned
    // here is that the guard does not pretend otherwise — the halves reach `apply`
    // and re-enter the same value rather than being swallowed by a stale arm.
    const c = fake("ch1/level", "continuous", 0.5, FINE);
    controls.set(c.id, c);
    map(c.id, { type: "cc14", channel: 0, controller: 7 });
    engine.feedback();
    const raw = Math.round(0.5 * 16383);
    expect(sent).toEqual([encodeCc(0, 7, (raw >> 7) & 0x7f), encodeCc(0, 39, raw & 0x7f)]);
    clock += 5;
    engine.onMessage(encodeCc(0, 7, (raw >> 7) & 0x7f));
    engine.onMessage(encodeCc(0, 39, raw & 0x7f));
    expect(c.value).toBe(0.5);
    expect(applied).toEqual([]); // re-entered the same value, so nothing was reported
  });

  it("resync forgets the sent cache and re-emits everything", () => {
    const c = fake("ch1/level", "continuous", 0.5);
    controls.set(c.id, c);
    map(c.id, { type: "cc", channel: 0, controller: 7 });
    engine.feedback();
    sent.length = 0;
    engine.feedback(true);
    expect(sent).toEqual([encodeCc(0, 7, 64)]);
  });
});

describe("plan gate", () => {
  it("reports one refusal per gated window, not per message", () => {
    const c = fake("ch1/level", "continuous");
    controls.set(c.id, c);
    map(c.id, { type: "cc", channel: 0, controller: 7 });
    gateReason = "busy";
    for (const value of [10, 20, 30, 40]) engine.onMessage(encodeCc(0, 7, value));
    expect(refusals).toEqual(["busy"]); // a whole sweep, one status line
    expect(c.value).toBe(0);
  });

  it("reports a second window that raised the same reason, with no traffic in between", () => {
    const c = fake("ch1/level", "continuous");
    controls.set(c.id, c);
    map(c.id, { type: "cc", channel: 0, controller: 7 });
    gateReason = "busy";
    engine.onMessage(encodeCc(0, 7, 10));
    expect(refusals).toEqual(["busy"]);
    // The window ends with the latch and no message arrives while it is down, so the
    // engine is told; both latches name themselves the same way, which is why the
    // reason string cannot decide this.
    gateReason = null;
    engine.gateReleased();
    gateReason = "busy";
    engine.onMessage(encodeCc(0, 7, 20));
    expect(refusals).toEqual(["busy", "busy"]);
  });

  it("clears the window on a message that passes the gate", () => {
    const c = fake("ch1/level", "continuous");
    controls.set(c.id, c);
    map(c.id, { type: "cc", channel: 0, controller: 7 });
    gateReason = "busy";
    engine.onMessage(encodeCc(0, 7, 10));
    gateReason = null;
    engine.onMessage(encodeCc(0, 7, 127)); // applies, and ends the reported window
    expect(c.value).toBe(1);
    gateReason = "busy";
    engine.onMessage(encodeCc(0, 7, 10));
    expect(refusals).toEqual(["busy", "busy"]);
  });

  it("stays silent for a mapping that resolves to nothing", () => {
    map("gone/level", { type: "cc", channel: 0, controller: 7 });
    gateReason = "busy";
    engine.onMessage(encodeCc(0, 7, 10));
    expect(refusals).toEqual([]);
  });
});

describe("gang (several controls on one address)", () => {
  it("drives every ganged control from one incoming message", () => {
    const a = fake("ch1/level@bus.mix1", "continuous");
    const b = fake("ch2/level@bus.mix1", "continuous");
    controls.set(a.id, a);
    controls.set(b.id, b);
    map(a.id, { type: "cc", channel: 0, controller: 7 });
    map(b.id, { type: "cc", channel: 0, controller: 7 });
    engine.onMessage(encodeCc(0, 7, 127));
    expect(a.value).toBe(1);
    expect(b.value).toBe(1);
    expect(applied).toEqual([a.id, b.id]);
  });

  it("feeds back only from the list head (the first learned)", () => {
    const a = fake("ch1/level@bus.mix1", "continuous", 0.5);
    const b = fake("ch2/level@bus.mix1", "continuous", 1);
    controls.set(a.id, a);
    controls.set(b.id, b);
    map(a.id, { type: "cc", channel: 0, controller: 7 });
    map(b.id, { type: "cc", channel: 0, controller: 7 });
    // The head (0.5 → 64) alone drives the one physical control; the member's
    // divergent value (1.0) must not emit a second, fighting message.
    engine.feedback();
    expect(sent).toEqual([encodeCc(0, 7, 64)]);
  });

  it("drops a toggle feedback echo for the whole gang, not just the head", () => {
    const a = fake("ch1/mute", "toggle", 0);
    const b = fake("ch2/mute", "toggle", 0);
    controls.set(a.id, a);
    controls.set(b.id, b);
    map(a.id, { type: "cc", channel: 0, controller: 20 });
    map(b.id, { type: "cc", channel: 0, controller: 20 });
    engine.onMessage(encodeCc(0, 20, 127)); // a real press flips both
    expect([a.value, b.value]).toEqual([1, 1]);
    engine.feedback(); // the head arms the address' echo guard
    expect(sent).toEqual([encodeCc(0, 20, 127)]);
    clock += 5; // inside the window: the measured echo latency is 0.13-5 ms
    engine.onMessage(encodeCc(0, 20, 127)); // the echo: neither member may flip
    expect([a.value, b.value]).toEqual([1, 1]);
    clock += 400;
    engine.onMessage(encodeCc(0, 20, 127)); // a real press past the window flips both
    expect([a.value, b.value]).toEqual([0, 0]);
  });

  it("engages pickup from the head; members cross over together", () => {
    const a = fake("ch1/level@bus.mix1", "continuous", 0.5);
    const b = fake("ch2/level@bus.mix1", "continuous", 0.5);
    controls.set(a.id, a);
    controls.set(b.id, b);
    map(a.id, { type: "cc", channel: 0, controller: 7 }, "pickup");
    map(b.id, { type: "cc", channel: 0, controller: 7 }, "pickup");
    engine.onMessage(encodeCc(0, 7, 20)); // below the head value → both swallowed
    expect([a.value, b.value]).toEqual([0.5, 0.5]);
    engine.onMessage(encodeCc(0, 7, 70)); // crosses the head value → both engage
    expect(a.value).toBeCloseTo(0.55, 5);
    expect(b.value).toBeCloseTo(0.55, 5);
  });
});

// A cc14 EMISSION lands on the plain-CC address space as well: the two bytes go out as
// CC n and CC n+32. The arming decision asks about the address being emitted, so it
// never covered them — and a knob learned as plain CC 39 beside a fader learned as
// cc14 7/39 (learn creates both) took the fader's LSB as a value edit, applied it, and
// wrote it to the unit while live. Its own corrective feedback then echoed back into
// the fader's unguarded LSB half.
describe("cc14 feedback and a plain-CC binding on the same controller", () => {
  it("arms the plain-CC guards the emission actually touches", () => {
    const fader = fake("ch1/level", "continuous", 0, 1 / 16383);
    const knob = fake("ch2/level", "continuous", 0.5);
    controls.set(fader.id, fader);
    controls.set(knob.id, knob);
    map(fader.id, { type: "cc14", channel: 0, controller: 7 });
    map(knob.id, { type: "cc", channel: 0, controller: 39 });

    // A first pass sends both, so each address' cache holds its own value.
    engine.feedback();
    sent.length = 0;

    // Now only the FADER moves: the pass emits the cc14 pair alone, and its LSB byte
    // goes out on CC 39 — the knob's address, which the knob itself did not send.
    fader.value = ((64 << 7) | 32) / 16383;
    engine.feedback();
    expect(sent).toEqual([encodeCc(0, 7, 64), encodeCc(0, 39, 32)]);

    // That LSB coming back off a reflecting bus must not edit the knob.
    const before = knob.value;
    clock += 5;
    engine.onMessage(encodeCc(0, 39, 32));
    expect(knob.value).toBe(before);
    expect(applied).not.toContain(knob.id);
  });
});
