// The rules over the macOS platform version a built binary records, and over the one place
// the repository states it: the `-platform_version` link argument in src-tauri/.cargo/config.toml.
// Pure, so scripts/macho-platform.test.mjs can put the broken arrangements in front of it that
// only a release run could otherwise produce; scripts/check-macho-platform.mjs is the half that
// spawns `vtool` and reads a file.
//
// What this exists to catch is a silent revert. The linker fills LC_BUILD_VERSION from the SDK
// it links against, so without the config line the value is a property of whichever Xcode the
// build ran under — and macOS 26 reads that value to choose the window's title bar. RUSTFLAGS in
// the environment REPLACES a `[target.*] rustflags` table rather than adding to it, so one added
// to a workflow for an unrelated reason drops the argument with nothing to show for it.

/** The link argument the config states, in the form the linker takes it. */
const LINK_ARG = /-Wl,-platform_version,([A-Za-z0-9_]+),([0-9][0-9.]*),([0-9][0-9.]*)/;

// Matched on the whole file rather than per line, because the argument is one element of a TOML
// array that may be wrapped across lines. A commented-out line is still a match to a regex, so
// the comment strip below runs first — a config whose only occurrence is inside a `#` comment
// states nothing, and reading it as a declaration is how a revert passes for a policy.
const stripComments = (text) =>
  text
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");

/**
 * The platform this repository declares, from src-tauri/.cargo/config.toml's text.
 * Throws rather than returning null: every caller here treats an unreadable declaration as a
 * failure, and a checker that silently compares against `undefined` passes everything.
 */
export function parseDeclared(configText) {
  const m = LINK_ARG.exec(stripComments(configText));
  if (!m) throw new Error("no -platform_version link argument in the cargo config");
  const [, platform, minos, sdk] = m;
  return { platform: platform.toLowerCase(), minos, sdk };
}

/**
 * What a binary records, from `vtool -show-build` output. Reads the LC_BUILD_VERSION block only:
 * a fat binary prints one block per architecture and an older Mach-O prints LC_VERSION_MIN_MACOSX
 * instead, which carries no sdk field at all and must not be read as one that happens to match.
 */
export function parseVtool(vtoolText) {
  const blocks = [];
  let current = null;
  for (const raw of vtoolText.split("\n")) {
    const line = raw.trim();
    if (line === "cmd LC_BUILD_VERSION") {
      current = {};
      blocks.push(current);
      continue;
    }
    if (line.startsWith("cmd ")) {
      current = null;
      continue;
    }
    if (!current) continue;
    const m = /^(platform|minos|sdk) (\S+)$/.exec(line);
    if (m) current[m[1]] = m[1] === "platform" ? m[2].toLowerCase() : m[2];
  }
  const complete = blocks.filter((b) => b.platform && b.minos && b.sdk);
  if (complete.length === 0) throw new Error("no complete LC_BUILD_VERSION in the vtool output");
  return complete;
}

/**
 * Every LC_BUILD_VERSION for the declared platform has to carry the declared values, and there
 * has to be one. A binary with no block for that platform is a failure rather than a pass by
 * absence — that is what a dropped link argument on a cross build looks like.
 */
export function compare(declared, blocks) {
  const mine = blocks.filter((b) => b.platform === declared.platform);
  if (mine.length === 0) {
    return { ok: false, reason: `no LC_BUILD_VERSION for platform ${declared.platform}` };
  }
  const bad = mine.filter((b) => b.minos !== declared.minos || b.sdk !== declared.sdk);
  if (bad.length > 0) {
    const shown = bad.map((b) => `minos ${b.minos} / sdk ${b.sdk}`).join(", ");
    return {
      ok: false,
      reason: `binary records ${shown}, config declares minos ${declared.minos} / sdk ${declared.sdk}`,
    };
  }
  return { ok: true, reason: `minos ${declared.minos} / sdk ${declared.sdk}` };
}
