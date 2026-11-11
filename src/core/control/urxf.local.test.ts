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

// How many parameters a chunk carries follows the System firmware that wrote it. A unit on 1.5
// writes a CURRENT of 830 where an earlier one writes 820, and a scene it stores carries 712
// where an earlier scene carries 695 — and a scene stored before the update keeps its 695 in a
// file the updated unit writes, so one file can hold both.
const WRITTEN_BY_SYSTEM_1_5 = new Set(["31-v15-ten-scenes.urxf"]);

describe.skipIf(!present)("device-written settings files (private samples)", () => {
  it("parses every sample into a CURRENT chunk plus its scenes", () => {
    const files = readdirSync(DIR).filter((name) => name.endsWith(".urxf"));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const file = parseUrxf(read(name));
      expect(file.model, name).toBe("URX");
      const v15 = WRITTEN_BY_SYSTEM_1_5.has(name);
      expect(file.chunks[0].name, name).toBe("CURRENT");
      expect(file.chunks[0].params.size, name).toBe(v15 ? 830 : 820);
      for (const scene of file.chunks.slice(1)) {
        expect(scene.name, name).toBe("SCENE");
        expect(v15 ? [695, 712] : [695], name).toContain(scene.params.size);
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

  // Every SCENE chunk in this file declares a length past its F + D pair, the rest filled
  // with leftover fragments that include `F_SCENE` block heads and `#ChunkData` record heads.
  it("reads a file whose scene chunks carry bytes past their values block", async () => {
    const file = parseUrxf(read("29-pre-simple-11-scenes.urxf"));
    const result = await applySourceState(getModel("URX44V"), emptyPlan("URX44V"), paramSourceOf(file.chunks[0]));
    expect(result.errors).toEqual([]);
    expect(result.unreadNodes).toEqual(new Set());
    expect(file.chunks.map((chunk) => chunk.label)).toEqual([
      "",
      "Initial Data",
      "Initial Data",
      "Initial Data",
      "t1",
      "Initial Data",
      "Initial Data",
      "Initial Data",
      "Initial Data",
      "SENDS",
    ]);
  });

  // Nine scenes stored before the unit was updated, and one stored after. The later one adds the
  // Output Patch and the STREAMING settings a scene keeps since System 1.5; CURRENT adds the ten
  // parameters that firmware introduced, none of which the app names.
  it("reads a file a unit on System 1.5 wrote, and imports its CURRENT with no failures", async () => {
    const file = parseUrxf(read("31-v15-ten-scenes.urxf"));
    expect(file.chunks.map((chunk) => chunk.params.size)).toEqual([830, ...Array(9).fill(695), 712]);
    expect(file.chunks.at(-1)?.label).toBe("TEST3");
    const earlier = new Set(file.chunks[1].params.keys());
    const added = (chunk: (typeof file.chunks)[number], than: Set<number>): number[] =>
      [...chunk.params.keys()].filter((id) => !than.has(id)).sort((a, b) => a - b);
    expect(added(file.chunks.at(-1)!, earlier)).toEqual([
      702, 703, 704, 705, 706, 707, 708, 729, 730, 731, 732, 733, 734, 735, 868, 893, 894,
    ]);
    const before = new Set(parseUrxf(read("29-pre-simple-11-scenes.urxf")).chunks[0].params.keys());
    expect(added(file.chunks[0], before)).toEqual([893, 894, 897, 898, 899, 900, 901, 902, 903, 904]);

    const result = await applySourceState(getModel("URX44V"), emptyPlan("URX44V"), paramSourceOf(file.chunks[0]));
    expect(result.applied).toBeGreaterThan(100);
    expect(result.errors).toEqual([]);
    expect(result.unreadNodes).toEqual(new Set());
  });

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
