// Parser check against files the hardware actually wrote. The samples live in the
// private reference repository (reference/work/urxf/samples, excluded from this one), so
// this suite runs where they are present and skips where they are not — CI and a
// fresh clone see it skip, with the reason on the describe name. urxf.test.ts is
// the portable suite; this one is what proves the format notes match the device.

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parseUrxf, paramSourceOf } from "./urxf";
import { applySourceState } from "./readback";
import { getModel } from "../../models";
import { emptyPlan } from "../plan";

const DIR = "reference/work/urxf/samples";
const present = existsSync(DIR);
const read = (name: string): Uint8Array => new Uint8Array(readFileSync(`${DIR}/${name}`));

describe.skipIf(!present)("device-written settings files (private samples)", () => {
  it("parses every sample into a CURRENT chunk plus its scenes", () => {
    const files = readdirSync(DIR).filter((name) => name.endsWith(".urxf"));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const file = parseUrxf(read(name));
      expect(file.model, name).toBe("URX");
      // CURRENT carries 820 parameters, each scene the 695-parameter subset.
      expect(file.chunks[0].name, name).toBe("CURRENT");
      expect(file.chunks[0].params.size, name).toBe(820);
      for (const scene of file.chunks.slice(1)) {
        expect(scene.name, name).toBe("SCENE");
        expect(scene.params.size, name).toBe(695);
        expect(scene.label, name).not.toBe("");
      }
    }
  });

  // Values confirmed against the device's own display. The first three are the
  // decode traps: an unsigned 4-byte bitmask read as signed goes negative, and a
  // 4-byte ASCII field read by width alone comes back as an integer.
  it("decodes the documented values of a configured unit", () => {
    const current = parseUrxf(read("01-configured.urxf")).chunks[0];
    expect(current.params.get(705)).toEqual([2147483904]);
    expect(current.params.get(91)?.slice(0, 4)).toEqual(["0001", "0001", "0001", "0001"]);
    expect(current.params.get(18)?.slice(0, 4)).toEqual(["ch 1", "ch 2", "ch 3", "ch 4"]);
    expect(current.params.get(96)?.[0]).toBe(184); // SSMCS COMP Attack
    expect(current.params.get(97)?.[0]).toBe(159); // SSMCS COMP Release
    expect(current.params.get(95)?.[0]).toBe(100); // Comp Drive 5.00
    expect(current.params.get(839)).toEqual([8]); // microSD Rec track count
  });

  it("keeps a two-scene file's scenes apart", () => {
    const file = parseUrxf(read("13-two-scenes.urxf"));
    expect(file.chunks.map((chunk) => chunk.label)).toEqual(["", "My Data 1", "My Data 2"]);
  });

  // The whole point of the reader: a real file drives the device→plan inverse and
  // lands the unit's settings cleanly — no failures, no unread nodes. The one
  // structural gap (oscillator ON, which no file carries) is filled with its
  // load-time value rather than reported as a failure.
  it("imports a real file onto a plan with no failures", async () => {
    const file = parseUrxf(read("01-configured.urxf"));
    const plan = emptyPlan("URX44V");
    const result = await applySourceState(getModel("URX44V"), plan, paramSourceOf(file.chunks[0]));
    expect(result.applied).toBeGreaterThan(100);
    expect(result.errors).toEqual([]);
    expect(result.unreadNodes).toEqual(new Set());
    expect(plan.nodeParams["bus.osc"]?.osc?.on).toBe(false);
    expect(plan.nodeNames?.ch1).toBe("ch 1");
    expect(plan.sampleRate).toBe(48000);
  });
});
