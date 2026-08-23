// The rules over comments that record a fact's provenance, shown the arrangements they
// exist to reject and the good ones each is a mutation of. A rule that fires on everything
// is as useless as one that fires on nothing, so both sides are asserted throughout.
//
// Three of these were run by hand against the real tree before this file existed: a new
// hedge in a file the ledger does not name, one more in a file already at its ceiling, and
// a cleaned file printing its lower count. The hand runs measured the guard on one day;
// this is the same measurement on every run.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { byFile, comments, findingsIn, hookDecision, repoPath, verdict } from "./check-comment-provenance.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const shapes = (src, path = "x.ts") => findingsIn(src, path).map((f) => f.rule);

describe("what counts as a comment", () => {
  // The reason this is a lexer and not a grep: `Object.entries(measured)` is an identifier,
  // and a checker that reported it would be answering about code.
  it("reads comments and not code", () => {
    expect(comments("const a = 1; // note\n").map((c) => c.text)).toEqual([" note"]);
    expect(shapes("for (const k of Object.entries(measured)) {}\n")).toEqual([]);
    expect(shapes("// for (const k of Object.entries(measured)) {}\n")).toEqual(["hedge-parenthetical"]);
  });

  // `${}` holds CODE, and a comment in it is a comment. Reading the literal whole — which is
  // what a string-shaped reading does — lost it, and the nested case lost it twice over.
  it("reads a comment inside a template interpolation, however deep", () => {
    expect(shapes("const x = `${foo /* measured on URX44V */}`;\n")).toEqual(["hedge-sentence"]);
    expect(shapes("const x = `${ `${b /* (measured) */}` }`;\n")).toEqual(["hedge-parenthetical"]);
    // …and the literal's own text is still text, not code.
    expect(shapes("const x = `${a} plain (measured) text`;\n")).toEqual([]);
  });

  // A brace inside an interpolation must not be read as the interpolation closing, or the
  // rest of the file is lexed one frame out of step.
  it("keeps its place through a brace inside the interpolation", () => {
    expect(shapes("const x = `${ {a: 1} }`; // (measured)\n")).toEqual(["hedge-parenthetical"]);
  });

  it("does not read a string as a comment", () => {
    expect(shapes('const s = "a (measured) value";\n')).toEqual([]);
    expect(shapes("const s = 'a (measured) value';\n")).toEqual([]);
    expect(shapes("const s = `a (measured) value`;\n")).toEqual([]);
  });

  // A regex can contain `//`, and division cannot. Read as division, the rest of the line
  // would be swallowed as a comment and every finding after it lost.
  it("does not read a regex literal as a comment", () => {
    expect(shapes("const re = /a\\/\\/(measured)/;\n")).toEqual([]);
    expect(shapes("const half = total / 2; // (measured)\n")).toEqual(["hedge-parenthetical"]);
  });

  it("reports the line a block comment's hit is on, not the block's first line", () => {
    const found = findingsIn("/**\n * one\n * two (measured)\n */\n", "x.ts");
    expect(found.map((f) => f.line)).toEqual([3]);
  });

  // CSS has no line comment, so `//` there is a malformed declaration and not a comment.
  // Treating it as one would swallow the rest of the line and lose whatever followed.
  it("reads only the block form in CSS", () => {
    expect(findingsIn("a { color: red; } /* (measured) */\n", "x.css").map((f) => f.rule)).toEqual([
      "hedge-parenthetical",
    ]);
    expect(findingsIn("a { color: red; } // (measured)\n", "x.css").map((f) => f.rule)).toEqual([]);
  });
});

describe("which shapes are refused", () => {
  it("refuses the appositives that name a run", () => {
    expect(shapes("// a fact (measured), and more\n")).toEqual(["hedge-parenthetical"]);
    expect(shapes("// a fact — measured, and more\n")).toEqual(["hedge-dash"]);
    expect(shapes("// a fact -- measured.\n")).toEqual(["hedge-dash"]);
  });

  it("refuses a sentence recording the method", () => {
    for (const s of ["Measured on a URX44V", "measured with the faces rendered", "Measured before the fix"]) {
      expect(shapes(`// ${s}: the thing happened.\n`), s).toEqual(["hedge-sentence"]);
    }
  });

  // JavaScript's word class is ASCII, so `\b` next to 実 or 測 never matches: written with
  // one, every Japanese case below came back empty while the English ones passed.
  it("refuses the same shapes written in Japanese", () => {
    expect(shapes("// 事実 (実測)\n")).toEqual(["hedge-parenthetical"]);
    expect(shapes("// 事実（実測）\n")).toEqual(["hedge-parenthetical"]);
    expect(shapes("// 事実 — 実測\n")).toEqual(["hedge-dash"]);
    expect(shapes("// 実測 on URX44V\n")).toEqual(["hedge-sentence-ja"]);
    expect(shapes("// 実測で確認した\n")).toEqual(["hedge-sentence-ja"]);
  });

  it("refuses a capture date", () => {
    expect(shapes("// The address moved (URX44V, 2026-07-28).\n")).toEqual(["capture-date"]);
  });

  // The good arrangements each of the above is a mutation of. The word itself is not the
  // target: a comment may say the data IS a measurement, and may compare against one.
  it("takes the word where it describes the data rather than the sourcing", () => {
    expect(shapes("// the level meters and the reduction are measured, so no curve is drawn\n")).toEqual([]);
    expect(shapes("// the measured EQ model, which a textbook biquad would not reproduce\n")).toEqual([]);
    expect(shapes("// the drag is measured against the cap's own top edge\n")).toEqual([]);
    expect(shapes("// a floor measured in device units\n")).toEqual([]);
  });

  it("takes a version or an address that merely looks like a date", () => {
    expect(shapes("// System 1.3.1.0 on the unit\n")).toEqual([]);
    expect(shapes("// the address is 133:0:2 on every model\n")).toEqual([]);
  });
});

describe("the ledger's verdict", () => {
  const at = (path, n) => byFile(findingsIn(`// x (measured)\n`.repeat(n), path));

  it("fails a file the ledger does not name at all — which is what makes a NEW one red", () => {
    const { over } = verdict(at("src/new.ts", 1), {});
    expect(over.map((o) => [o.path, o.count, o.ceiling])).toEqual([["src/new.ts", 1, 0]]);
  });

  it("fails one MORE in a file already at its ceiling", () => {
    expect(verdict(at("src/a.ts", 3), { "src/a.ts": 2 }).over).toHaveLength(1);
    expect(verdict(at("src/a.ts", 2), { "src/a.ts": 2 }).over).toEqual([]);
  });

  it("reports a cleaned file as under, so lowering the ceiling is a paste", () => {
    const { over, under } = verdict(at("src/a.ts", 1), { "src/a.ts": 3 });
    expect(over).toEqual([]);
    expect(under).toEqual([{ path: "src/a.ts", ceiling: 3, count: 1 }]);
  });

  it("reports a file that left the tree entirely, so its row does not outlive it", () => {
    expect(verdict({}, { "src/gone.ts": 4 }).under).toEqual([{ path: "src/gone.ts", ceiling: 4, count: 0 }]);
  });
});

describe("what the edit-time hook decides", () => {
  const inRepo = (rel) => join(HERE, "..", rel);

  // The first version refused on ANY finding, which refused every edit to each of the 103
  // files the ledger names — an unmodified src/core/meters.ts came back exit 2 with its
  // seven ledgered comments listed.
  it("allows a ledgered file that is at its ceiling", () => {
    const src = `// x (measured)\n`.repeat(7);
    expect(hookDecision(inRepo("src/core/meters.ts"), src, { "src/core/meters.ts": 7 }).exit).toBe(0);
  });

  it("refuses one MORE than the ceiling, and names both numbers", () => {
    const src = `// x (measured)\n`.repeat(8);
    const d = hookDecision(inRepo("src/core/meters.ts"), src, { "src/core/meters.ts": 7 });
    expect([d.exit, d.ceiling, d.findings.length]).toEqual([2, 7, 8]);
  });

  it("refuses the first one in a file the ledger does not name", () => {
    expect(hookDecision(inRepo("src/core/new.ts"), "// x (measured)\n", {}).exit).toBe(2);
  });

  // The ledger is this tree's, and a relative path that escapes the root names nothing.
  it("skips a file outside the repository rather than reporting it as ../../..", () => {
    const d = hookDecision("/tmp/elsewhere.ts", "// x (measured)\n", {});
    expect(d.exit).toBe(0);
    expect(repoPath("/tmp/elsewhere.ts").startsWith("..")).toBe(true);
  });
});

describe("what a partial scan may conclude", () => {
  const at = (path, n) => byFile(findingsIn(`// x (measured)\n`.repeat(n), path));

  // The documented single-path invocation printed "delete the row" for 102 files it had
  // never opened. A row outside the scan was not examined and says nothing either way.
  it("says nothing about a ledger row it did not read", () => {
    const ledger = { "src/a.ts": 1, "src/b.ts": 4 };
    const scanned = new Set(["src/a.ts"]);
    expect(verdict(at("src/a.ts", 1), ledger, scanned).under).toEqual([]);
  });

  it("still fails on a file it DID read that is over its ceiling", () => {
    const { over } = verdict(at("src/a.ts", 2), { "src/a.ts": 1, "src/b.ts": 4 }, new Set(["src/a.ts"]));
    expect(over.map((o) => o.path)).toEqual(["src/a.ts"]);
  });

  // The whole-tree run is the only one that can call a row emptied, because it is the only
  // one that looked everywhere.
  it("reports a vanished row only when the scan was the whole tree", () => {
    expect(verdict({}, { "src/gone.ts": 4 }, null).under).toEqual([{ path: "src/gone.ts", ceiling: 4, count: 0 }]);
    expect(verdict({}, { "src/gone.ts": 4 }, new Set(["src/other.ts"])).under).toEqual([]);
  });
});

describe("the ledger that ships", () => {
  const ledger = JSON.parse(readFileSync(join(HERE, "comment-provenance-baseline.json"), "utf8"));

  it("names every ceiling as a positive integer, sorted, with no zero rows", () => {
    const paths = Object.keys(ledger.files);
    expect(paths).toEqual([...paths].sort());
    for (const [path, n] of Object.entries(ledger.files)) {
      expect(Number.isInteger(n) && n > 0, `${path} = ${n}`).toBe(true);
    }
  });

  // The count is the statement of what a green run does NOT prove, so it has to be visible
  // rather than a number only the checker knows.
  it("still says out loud how large the backlog is", () => {
    const total = Object.values(ledger.files).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
    expect(ledger.note).toMatch(/ceiling/i);
  });
});
