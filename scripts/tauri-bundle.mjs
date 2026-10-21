#!/usr/bin/env node
// The Tauri CLI as release.yml's build job hands it to tauri-action (its `tauriScript` input).
//
// tauri-action runs `<tauriScript> build <args>`. This turns that `build` into `bundle`, so the
// job that holds the signing material packages, signs and notarizes the binary the compile job
// built and compiles nothing itself; every other argument is passed through as given. A first
// argument other than `build` is refused, so a tauri-action that starts asking for something
// else fails here instead of being bundled.
//
// The CLI is the `@tauri-apps/cli` this checkout installed, started with the node running this
// script.

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The Tauri CLI arguments for the arguments tauri-action passed. */
export function bundleArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "build") {
    throw new Error(`tauri-bundle: expected tauri-action to ask for "build", got ${JSON.stringify(command ?? null)}`);
  }
  return ["bundle", ...rest];
}

/** The path of the installed CLI's launcher. */
export function cliPath() {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve("@tauri-apps/cli/package.json");
  return join(dirname(manifest), require(manifest).bin.tauri);
}

/**
 * Whether this module is the program rather than an import, compared as real paths: node
 * resolves the entry module's symlinks before it stamps `import.meta.url`, and leaves
 * `process.argv[1]` as it was typed.
 */
function isEntry(url) {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(fileURLToPath(url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isEntry(import.meta.url)) {
  let args;
  try {
    args = bundleArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const run = spawnSync(process.execPath, [cliPath(), ...args], { stdio: "inherit" });
  if (run.error) {
    console.error(`tauri-bundle: ${run.error.message}`);
    process.exit(1);
  }
  process.exit(run.status ?? 1);
}
