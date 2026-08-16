// The rules over the recorded macOS platform version, shown the broken arrangements they exist
// to reject. Every vtool block below is real output recorded on an Apple silicon machine — the
// shipped 1.9.0 binary, a local release build, and three binaries produced with `cc` for the
// shapes a release cannot be made to take on demand. None of it is transcribed by hand, because
// what this parses is another tool's output and an invented sample agrees with whatever the
// parser already does.
//
// Every case is paired with the good arrangement it is a mutation of: a checker that fails on
// everything proves as little as one that fails on nothing.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compare, parseDeclared, parseVtool } from "./macho-platform.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = resolve(repoRoot, "src-tauri/.cargo/config.toml");

const GOOD_CONFIG = `[target.aarch64-apple-darwin]
rustflags = ["-C", "link-arg=-Wl,-platform_version,macos,11.0,26.5"]
`;

// What the shipped 1.9.0 installer carries: linked on the macos-14 runner image.
const VTOOL_SDK_14 = `/Applications/URX Router.app/Contents/MacOS/urx-router:
Load command 10
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform MACOS
    minos 11.0
      sdk 14.5
   ntools 1
     tool LD
  version 1053.12
`;

// A local release build carrying the link argument.
const VTOOL_SDK_26 = `t-a:
Load command 8
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform MACOS
    minos 11.0
      sdk 26.5
   ntools 1
     tool LD
  version 1267.0
`;

// Two architectures joined with lipo, one of which did not get the argument.
const VTOOL_FAT = `t-fat (architecture x86_64):
Load command 8
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform MACOS
    minos 11.0
      sdk 15.4
   ntools 1
     tool LD
  version 1267.0
t-fat (architecture arm64):
Load command 8
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform MACOS
    minos 11.0
      sdk 26.5
   ntools 1
     tool LD
  version 1267.0
`;

// The pre-LC_BUILD_VERSION load command, from `cc -mmacosx-version-min=10.9`. It carries an
// `sdk` line of its own — 26.5, which is the value the config declares — and no platform at
// all, so a parser that scanned for `sdk` without first finding its block would pass this.
const VTOOL_VERSION_MIN = `t-old:
Load command 8
      cmd LC_VERSION_MIN_MACOSX
  cmdsize 16
  version 10.9
      sdk 26.5
`;

describe("parseDeclared", () => {
  it("reads the platform, floor and sdk out of the link argument", () => {
    expect(parseDeclared(GOOD_CONFIG)).toEqual({ platform: "macos", minos: "11.0", sdk: "26.5" });
  });

  it("refuses a config whose only occurrence is commented out", () => {
    const reverted = GOOD_CONFIG.split("\n")
      .map((line) => (line.startsWith("rustflags") ? `# ${line}` : line))
      .join("\n");
    expect(() => parseDeclared(reverted)).toThrow(/no -platform_version/);
  });

  it("refuses a config that states nothing", () => {
    expect(() => parseDeclared("[target.aarch64-apple-darwin]\n")).toThrow(/no -platform_version/);
  });

  it("reads the repository's own config", () => {
    const declared = parseDeclared(readFileSync(CONFIG, "utf8"));
    expect(declared.platform).toBe("macos");
    expect(declared.minos).toMatch(/^\d+\.\d+$/);
    expect(declared.sdk).toMatch(/^\d+\.\d+$/);
  });
});

describe("parseVtool", () => {
  it("reads one LC_BUILD_VERSION block", () => {
    expect(parseVtool(VTOOL_SDK_26)).toEqual([{ platform: "macos", minos: "11.0", sdk: "26.5" }]);
  });

  it("reads one block per architecture", () => {
    expect(parseVtool(VTOOL_FAT).map((b) => b.sdk)).toEqual(["15.4", "26.5"]);
  });

  it("refuses output carrying no LC_BUILD_VERSION, sdk line or not", () => {
    expect(() => parseVtool(VTOOL_VERSION_MIN)).toThrow(/no complete LC_BUILD_VERSION/);
  });
});

describe("compare", () => {
  const declared = parseDeclared(GOOD_CONFIG);

  it("passes a binary carrying the declared values", () => {
    expect(compare(declared, parseVtool(VTOOL_SDK_26))).toMatchObject({ ok: true });
  });

  it("fails the shipped binary the link argument was written for", () => {
    const result = compare(declared, parseVtool(VTOOL_SDK_14));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("sdk 14.5");
    expect(result.reason).toContain("26.5");
  });

  it("fails when one architecture of several did not get the argument", () => {
    expect(compare(declared, parseVtool(VTOOL_FAT))).toMatchObject({ ok: false });
  });

  it("fails on the floor alone, not only on the sdk", () => {
    const moved = { ...declared, minos: "12.0" };
    expect(compare(moved, parseVtool(VTOOL_SDK_26))).toMatchObject({ ok: false });
  });

  it("fails when nothing describes the declared platform", () => {
    const ios = parseVtool(VTOOL_SDK_26).map((b) => ({ ...b, platform: "ios" }));
    const result = compare(declared, ios);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no LC_BUILD_VERSION for platform macos");
  });
});
