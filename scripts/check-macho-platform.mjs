#!/usr/bin/env node
// Reads the macOS platform version off a built Mach-O and compares it with the one
// src-tauri/.cargo/config.toml declares. The rules are in scripts/macho-platform.mjs; this is
// the half that spawns `vtool` and touches the filesystem.
//
//   node scripts/check-macho-platform.mjs "<path to the binary>"
//
// Run from .github/workflows/release.yml on the packaged macOS binary. macOS only — `vtool`
// ships with the Xcode command line tools, and a run without it fails rather than skipping,
// since a check that reports success when it could not look is the failure it is meant to catch.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { compare, parseDeclared, parseVtool } from "./macho-platform.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = resolve(repoRoot, "src-tauri/.cargo/config.toml");

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/check-macho-platform.mjs <path to a Mach-O binary>");
  process.exit(2);
}

const declared = parseDeclared(readFileSync(CONFIG, "utf8"));
const vtoolText = execFileSync("vtool", ["-show-build", target], { encoding: "utf8" });
const result = compare(declared, parseVtool(vtoolText));

if (!result.ok) {
  console.error(`FAIL ${target}`);
  console.error(`  ${result.reason}`);
  console.error("  The link argument in src-tauri/.cargo/config.toml did not reach this binary.");
  console.error("  A RUSTFLAGS set in the environment replaces that table rather than adding to it.");
  process.exit(1);
}
console.log(`ok ${target}: ${result.reason}`);
