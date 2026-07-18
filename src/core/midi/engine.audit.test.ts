// QA audit (core/midi/engine.ts): incoming-application invariants found during a
// robustness audit of the MIDI engine. Comments tagged "AUDIT" flag a divergence
// from the ideal contract (see the QA report); each test pins the CURRENT behavior
// so the suite stays green and the pin tracks the eventual fix.
//
// The gang-head audit below tracked a FIXED defect: a gang whose first-learned
// member no longer resolved stranded every live member (pickup never engaged,
// feedback never emitted). isHead now picks the first RESOLVING member, and these
// tests pin that contract so a regression to list-position ownership is caught.

import { describe, it, expect, beforeEach } from "vitest";
import { MidiEngine } from "./engine";
import type { MidiMapping } from "./mapping";
import { encodeCc } from "./message";
import { fake, type Fake } from "./fake-control";

let controls: Map<string, Fake>;
let applied: string[];
let clock: number;
let engine: MidiEngine;

beforeEach(() => {
  controls = new Map();
  applied = [];
  clock = 0;
  engine = new MidiEngine({
    resolve: (id) => controls.get(id) ?? null,
    applied: (c) => applied.push(c.id),
    send: () => {},
    learned: () => {},
    learnPending: () => {},
    now: () => clock,
  });
});

describe("gang pickup with a stale list head", () => {
  // The address' head owns pickup engagement (continuousTarget only calls
  // pickupEngaged for isHead; members read the cached engaged flag). Head
  // ownership skips mappings whose control does not resolve, so a stale
  // first-learned member cannot hold the state hostage.
  it("engages the live member when the first-learned mapping is stale", () => {
    const member = fake("ch2/level@bus.mix1", "continuous", 0.5);
    controls.set(member.id, member);
    const maps: MidiMapping[] = [
      // First learned = a control that does not resolve for this plan (e.g. a
      // send whose connection was removed, or a mapping kept for another model).
      { control: "gone/level@bus.mix1", addr: { type: "cc", channel: 0, controller: 7 }, mode: "pickup" },
      { control: member.id, addr: { type: "cc", channel: 0, controller: 7 }, mode: "pickup" },
    ];
    engine.setMappings(maps);
    engine.onMessage(encodeCc(0, 7, 20)); // below the member value: records the sweep start
    engine.onMessage(encodeCc(0, 7, 70)); // crosses 0.5 — engages, the live member owning pickup
    expect(member.value).toBeCloseTo(0.55, 5);
    expect(applied).toEqual([member.id]);
  });

  // Same root cause on the outgoing path: feedback() only emits for the head, so
  // a stale first-learned member used to silence the whole gang's controller LEDs.
  it("feeds back through the live member when the first-learned mapping is stale", () => {
    const sent: number[][] = [];
    const member = fake("ch2/level@bus.mix1", "continuous", 1);
    controls.set(member.id, member);
    const e = new MidiEngine({
      resolve: (id) => controls.get(id) ?? null,
      applied: () => {},
      send: (bytes) => sent.push([...bytes]),
      learned: () => {},
      learnPending: () => {},
      now: () => clock,
    });
    e.setMappings([
      { control: "gone/level@bus.mix1", addr: { type: "cc", channel: 0, controller: 7 }, mode: "absolute" },
      { control: member.id, addr: { type: "cc", channel: 0, controller: 7 }, mode: "absolute" },
    ] as MidiMapping[]);
    expect(e.feedback()).toBe(false);
    expect(sent).toEqual([[0xb0, 7, 127]]); // one message, from the live member
  });

  it("shows the working baseline: a live head engages the same member", () => {
    const head = fake("ch1/level@bus.mix1", "continuous", 0.5);
    const member = fake("ch2/level@bus.mix1", "continuous", 0.5);
    controls.set(head.id, head);
    controls.set(member.id, member);
    engine.setMappings([
      { control: head.id, addr: { type: "cc", channel: 0, controller: 7 }, mode: "pickup" },
      { control: member.id, addr: { type: "cc", channel: 0, controller: 7 }, mode: "pickup" },
    ] as MidiMapping[]);
    engine.onMessage(encodeCc(0, 7, 20));
    engine.onMessage(encodeCc(0, 7, 70));
    expect(member.value).toBeCloseTo(0.55, 5);
    expect(head.value).toBeCloseTo(0.55, 5);
  });

  // Absolute-mode members are unaffected: continuousTarget returns the incoming
  // value without consulting head-owned pickup state.
  it("does not affect absolute-mode members behind a stale head", () => {
    const member = fake("ch2/level@bus.mix1", "continuous", 0);
    controls.set(member.id, member);
    engine.setMappings([
      { control: "gone/level@bus.mix1", addr: { type: "cc", channel: 0, controller: 7 }, mode: "absolute" },
      { control: member.id, addr: { type: "cc", channel: 0, controller: 7 }, mode: "absolute" },
    ] as MidiMapping[]);
    engine.onMessage(encodeCc(0, 7, 127));
    expect(member.value).toBe(1); // absolute still applies
  });
});
