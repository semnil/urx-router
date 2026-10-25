// The Node range rule, shown the arrangements it exists to reject beside the ones it accepts, and
// then asked of this repository: package.json's engines must be the set where the direct
// dependencies' own ranges and the codec's floor meet.
import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CODEC_FLOOR, contains, formatRange, intersect, parseRange, readEngines, sameSet } from "./node-engines.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("a Node range", () => {
  // Each range with versions on both sides of every bound it has, so a bound read one patch off
  // is a failure here.
  it.each([
    ["^22.22.2", ["22.22.2", "22.99.0"], ["22.22.1", "23.0.0"]],
    [">=26.0.0", ["26.0.0", "40.0.0"], ["25.99.99"]],
    [">= 10", ["10.0.0"], ["9.99.99"]],
    [">=22.15.0", ["22.15.0"], ["22.14.9"]],
    [">=20", ["20.0.0"], ["19.99.0"]],
    [">1.2", ["1.3.0"], ["1.2.99"]],
    [">1.2.3", ["1.2.4"], ["1.2.3"]],
    ["<1.2", ["1.1.99"], ["1.2.0"]],
    ["<=1.2", ["1.2.99"], ["1.3.0"]],
    ["<=1.2.3", ["1.2.3"], ["1.2.4"]],
    ["~1.2.3", ["1.2.3", "1.2.99"], ["1.2.2", "1.3.0"]],
    ["~1", ["1.0.0", "1.99.0"], ["2.0.0"]],
    ["^0.2.3", ["0.2.3", "0.2.99"], ["0.2.2", "0.3.0"]],
    ["^0.0.3", ["0.0.3"], ["0.0.4"]],
    ["^0", ["0.99.0"], ["1.0.0"]],
    ["1.2", ["1.2.0", "1.2.99"], ["1.1.99", "1.3.0"]],
    ["=1.2.3", ["1.2.3"], ["1.2.2", "1.2.4"]],
    [">=1.2.0 <1.4.0", ["1.2.0", "1.3.9"], ["1.1.9", "1.4.0"]],
    ["^20.19.0 || >=22.12.0", ["20.19.0", "22.12.0", "30.0.0"], ["20.18.9", "21.0.0", "22.11.9"]],
  ])("%s", (range, admitted, refused) => {
    const set = parseRange(range);
    for (const version of admitted) expect(contains(set, version), `${range} admits ${version}`).toBe(true);
    for (const version of refused) expect(contains(set, version), `${range} refuses ${version}`).toBe(false);
  });

  it.each(["1.0.0 - 2.0.0", "1.x", "*", "22.0.0-rc.1", "", "^22 ||"])(
    "refuses %j rather than reading it some other way",
    (range) => {
      expect(() => parseRange(range)).toThrow(/Node range/);
    },
  );
});

describe("two ranges compared as sets", () => {
  it("are the same set however they are spelled", () => {
    const written = parseRange("^22.22.2 || ^24.15.0 || >=26.0.0");
    const spelledOut = parseRange(">=22.22.2 <23 || >=24.15.0 <25.0.0 || >=26");
    expect(sameSet(written, spelledOut)).toBe(true);
  });

  it("are different sets when one bound moves by a patch", () => {
    expect(sameSet(parseRange("^24.15.0"), parseRange("^24.15.1"))).toBe(false);
    expect(sameSet(parseRange(">=26.0.0"), parseRange(">=26.0.0 <99"))).toBe(false);
  });

  it("meet where every one of them admits a version", () => {
    const met = intersect([
      parseRange(CODEC_FLOOR),
      parseRange("^22.22.2 || ^24.15.0 || >=26.0.0"),
      parseRange("^22.12.0 || ^24.0.0 || >=26.0.0"),
      parseRange("^20.19.0 || >=22.12.0"),
      parseRange(">=22.15.0"),
    ]);
    expect(formatRange(met)).toBe("^22.22.2 || ^24.15.0 || >=26.0.0");
  });

  it("keep the codec's floor when every dependency admits less", () => {
    expect(formatRange(intersect([parseRange(CODEC_FLOOR), parseRange(">=18")]))).toBe(">=21.2.0");
  });
});

describe("this repository", () => {
  it("declares, as package.json's engines.node, where the dependencies' ranges and the codec's floor meet", () => {
    const { declared, required, declaring } = readEngines(repo);
    const listed = declaring.map((entry) => `  ${entry.name} ${entry.version}: ${entry.range}`).join("\n");
    expect(
      sameSet(parseRange(declared), required),
      `package.json engines.node is "${declared}", while the direct dependencies and the codec's ` +
        `${CODEC_FLOOR} meet at "${formatRange(required)}":\n${listed}`,
    ).toBe(true);
  });
});
