import { describe, it, expect, beforeEach } from "vitest";
import { MidiEngine } from "./engine";
import type { MidiAddr, MidiMapping } from "./mapping";
import { encodeCc, encodeNote } from "./message";
import { fake, type Fake } from "./fake-control";

let controls: Map<string, Fake>;
let applied: string[];
let sent: number[][];
let learned: MidiAddr[];
let pendingCount: number;
let clock: number;
let engine: MidiEngine;

beforeEach(() => {
  controls = new Map();
  applied = [];
  sent = [];
  learned = [];
  pendingCount = 0;
  clock = 0;
  engine = new MidiEngine({
    resolve: (id) => controls.get(id) ?? null,
    applied: (c) => applied.push(c.id),
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
    clock += 50;
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

  it("drops a note feedback echo the same way", () => {
    const mute = fake("ch1/mute", "toggle", 0);
    controls.set("ch1/mute", mute);
    map("ch1/mute", { type: "note", channel: 0, note: 60 });
    mute.value = 1;
    engine.feedback();
    expect(sent).toEqual([encodeNote(0, 60, true)]);
    clock += 50;
    engine.onMessage(encodeNote(0, 60, true)); // the echo
    expect(mute.value).toBe(1);
    clock += 400;
    engine.onMessage(encodeNote(0, 60, true));
    expect(mute.value).toBe(0);
  });

  it("only guards echoes within the echo window; a later equal message flips the toggle", () => {
    // The receive-side echo guard spans ECHO_MS (300 ms). A same-value message
    // that arrives after the window is treated as a genuine press, not an echo.
    const mute = fake("ch1/mute", "toggle", 0);
    controls.set("ch1/mute", mute);
    map("ch1/mute", { type: "cc", channel: 0, controller: 20 });
    mute.value = 1;
    engine.feedback(); // sends 127, arms the guard at clock 0
    expect(sent).toEqual([encodeCc(0, 20, 127)]);
    clock = 300; // exactly at the window edge → guard expired
    engine.onMessage(encodeCc(0, 20, 127)); // no longer treated as an echo → edge flips
    expect(mute.value).toBe(0);
    expect(applied).toEqual(["ch1/mute"]);
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
    clock += 50;
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
