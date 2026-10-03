// The time stop tables, stop for stop, against the tables the unit announced while each knob
// was turned from end to end. Those live in the private reference repository (excluded from
// this one), so this suite runs where they are present and skips where they are not — CI and
// a fresh clone see it skip, with the reason on the describe name. dyn-time-stops.test.ts is
// the portable suite.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { DUCKER_DECAY_STOPS_MS, DYN_ATTACK_STOPS_MS, DYN_HOLD_STOPS_MS, DYN_RELEASE_STOPS_MS } from "./dyn-time-stops";
import { attackToVd, holdToVd, releaseToVd } from "./vd";

const DIR = "reference/work/lcd-sim-20261003";
const present = existsSync(DIR);

/** The `stops:` line under one address's heading in a stops file, as raw integers. */
function stopsOf(file: string, addr: string): number[] {
  let current = "";
  for (const line of readFileSync(`${DIR}/${file}`, "utf8").split("\n")) {
    const heading = /^## (\S+):/.exec(line);
    if (heading) current = heading[1];
    const stops = /^stops: (.*)$/.exec(line);
    if (stops && current === addr) return stops[1].trim().split(/\s+/).map(Number);
  }
  throw new Error(`${file} carries no stops for ${addr}`);
}

describe.skipIf(!present)("the time stop tables against the unit's (private reference)", () => {
  it.each([
    ["GATE attack", "d4r402-gate-stops.txt", "31:0:0", DYN_ATTACK_STOPS_MS, attackToVd],
    ["GATE hold", "d4r402-gate-stops.txt", "32:0:0", DYN_HOLD_STOPS_MS, holdToVd],
    ["GATE decay", "d4r402-gate-stops.txt", "33:0:0", DYN_RELEASE_STOPS_MS, releaseToVd],
    ["COMP attack", "d4r402-comp-stops.txt", "39:0:0", DYN_ATTACK_STOPS_MS, attackToVd],
    ["COMP release", "d4r402-comp-stops.txt", "40:0:0", DYN_RELEASE_STOPS_MS, releaseToVd],
    ["DUCKER attack", "d4r402-duck-stops.txt", "262:0:0", DYN_ATTACK_STOPS_MS, attackToVd],
    ["DUCKER decay", "d4r402-duck-stops.txt", "263:0:0", DUCKER_DECAY_STOPS_MS, releaseToVd],
  ] as const)("%s is the unit's table, stop for stop", (_name, file, addr, ms, toRaw) => {
    expect(ms.map((v) => toRaw(v))).toEqual(stopsOf(file, addr));
  });
});
