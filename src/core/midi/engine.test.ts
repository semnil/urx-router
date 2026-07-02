import { describe, it, expect, beforeEach } from "vitest";
import { MidiEngine } from "./engine";
import type { BoundControl } from "./controls";
import type { MidiAddr, MidiMapping } from "./mapping";
import { encodeCc, encodeNote } from "./message";

// A scripted control: value held locally, optional lock, snap to `step`.
interface Fake extends BoundControl {
  value: number;
  locked: boolean;
}

function fake(id: string, kind: "continuous" | "toggle", value = 0, step = 1 / 40): Fake {
  const f: Fake = {
    id,
    node: id.split("/")[0],
    param: "level",
    kind,
    step,
    value,
    locked: false,
    get: () => f.value,
    set: (v) => {
      if (f.locked) return false;
      const clamped = Math.max(0, Math.min(1, v));
      f.value = kind === "toggle" ? (clamped >= 0.5 ? 1 : 0) : Math.round(clamped / step) * step;
      return true;
    },
  };
  return f;
}

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

const map = (control: string, addr: MidiAddr, mode: MidiMapping["mode"] = "absolute", encoding?: MidiMapping["encoding"]): void => {
  engine.setMappings([...engine.getMappings(), { control, addr, mode, ...(encoding ? { encoding } : {}) }]);
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

  it("toggles on note-on and on a CC rising edge only", () => {
    const c = fake("ch1/mute", "toggle");
    controls.set(c.id, c);
    map(c.id, { type: "note", channel: 0, note: 60 });
    engine.onMessage(encodeNote(0, 60, true));
    expect(c.value).toBe(1);
    engine.onMessage(encodeNote(0, 60, false)); // release: no re-toggle
    expect(c.value).toBe(1);
    engine.onMessage(encodeNote(0, 60, true));
    expect(c.value).toBe(0);

    const d = fake("ch2/mute", "toggle");
    controls.set(d.id, d);
    map(d.id, { type: "cc", channel: 0, controller: 20 });
    engine.onMessage(encodeCc(0, 20, 127)); // rising → toggle
    expect(d.value).toBe(1);
    engine.onMessage(encodeCc(0, 20, 100)); // still high → no re-toggle
    expect(d.value).toBe(1);
    engine.onMessage(encodeCc(0, 20, 0)); // falling → no toggle
    engine.onMessage(encodeCc(0, 20, 127)); // rising again → toggle back
    expect(d.value).toBe(0);
  });

  it("state-mode toggles follow an alternating one-message-per-press sender (Stream Deck style)", () => {
    // Regression for the Stream Deck MIDI plugin's toggle buttons: one CC per
    // press, alternating 127 / 0 — edge mode misses every second press, so a
    // per-mapping "state" behavior applies the value as the state instead.
    const c = fake("ch1/mute", "toggle");
    controls.set(c.id, c);
    engine.setMappings([{ control: c.id, addr: { type: "cc", channel: 0, controller: 20 }, mode: "absolute", button: "state" }]);
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
    engine.setMappings([{ control: n.id, addr: { type: "note", channel: 0, note: 60 }, mode: "absolute", button: "state" }]);
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

  it("relative CC walks one detent per click in each encoding", () => {
    const c = fake("ch1/level", "continuous", 0.5);
    controls.set(c.id, c);
    map(c.id, { type: "cc", channel: 0, controller: 7 }, "relative", "twos");
    engine.onMessage(encodeCc(0, 7, 1)); // +1
    expect(c.value).toBeCloseTo(0.5 + 1 / 40, 9);
    engine.onMessage(encodeCc(0, 7, 127)); // -1 (two's complement)
    expect(c.value).toBeCloseTo(0.5, 9);

    engine.setMappings([{ control: c.id, addr: { type: "cc", channel: 0, controller: 7 }, mode: "relative", encoding: "offset64" }]);
    engine.onMessage(encodeCc(0, 7, 66)); // +2
    expect(c.value).toBeCloseTo(0.5 + 2 / 40, 9);

    engine.setMappings([{ control: c.id, addr: { type: "cc", channel: 0, controller: 7 }, mode: "relative", encoding: "signbit" }]);
    engine.onMessage(encodeCc(0, 7, 65)); // -1
    expect(c.value).toBeCloseTo(0.5 + 1 / 40, 9);
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
