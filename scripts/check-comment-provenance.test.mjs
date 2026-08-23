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
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  byFile,
  comments,
  escapesRoot,
  findingsIn,
  hookDecision,
  nextLedger,
  repoPath,
  rustComments,
  verdict,
} from "./check-comment-provenance.mjs";
import { win32 } from "node:path";

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
  // The character before the slash is a letter, so the operator test alone reads this as
  // division — and the `"` inside the character class then opens a string that swallows the
  // rest of the line, comment included. Valid JavaScript, and it returned [].
  it("reads a regex that a KEYWORD introduces, not only one an operator does", () => {
    expect(shapes('function f(x) { return /["]/.test(x); } // measured on URX44V\n')).toEqual(["hedge-sentence"]);
    expect(shapes('const y = typeof /["]/; // (measured)\n')).toEqual(["hedge-parenthetical"]);
    // …and an identifier is still not a keyword: after a variable a slash divides.
    expect(shapes("const q = a / b / c; // (measured)\n")).toEqual(["hedge-parenthetical"]);
  });

  // The identifier before the slash has to be a TOKEN, not the characters that happen to
  // have accumulated. Each of these is valid JavaScript and each returned [].
  it("treats the identifier before a slash as one token, ended and spent correctly", () => {
    // whitespace ENDS a token: this is `return` then `await`, not `returnawait`
    expect(shapes('function f(x){ return await /["]/.test(x); } // measured on URX44V\n')).toEqual(["hedge-sentence"]);
    // a token after a dot is a PROPERTY, so the slash divides and the comment survives
    expect(shapes("const n = obj.return / 2; // measured on URX44V\n")).toEqual(["hedge-sentence"]);
    // reading a regex SPENDS the token, so the next slash divides
    expect(shapes("function g(){ return /x/ / 2; } // measured on URX44V\n")).toEqual(["hedge-sentence"]);
    // punctuation spends it too
    expect(shapes("const r = arr[0] / 2; // (measured)\n")).toEqual(["hedge-parenthetical"]);
  });

  // Where the grammar looks for an EXPRESSION a slash opens a pattern, and where it has a
  // value it divides. Neither is decidable from the preceding character: `)` ends a value
  // after a call and starts an expression after `if (…)`, `}` ends one after an object
  // literal and starts one after a block, and `+` is an operator in `a + /re/` and half of a
  // postfix `++` in `x++ / 2`. Every case here is valid JavaScript that returned [].
  it("decides regex-versus-division from the grammatical position, not the last character", () => {
    // a control `)` starts an expression; a call `)` and a group `)` end a value
    expect(shapes('if (x) /["]/.test(y); // measured on URX44V\n')).toEqual(["hedge-sentence"]);
    expect(shapes("while (n) /x/.test(s); // (measured)\n")).toEqual(["hedge-parenthetical"]);
    expect(shapes("const g = fn(1) / 2; // (measured)\n")).toEqual(["hedge-parenthetical"]);
    expect(shapes("const d = (a + b) / 2; // (measured)\n")).toEqual(["hedge-parenthetical"]);
    // a postfix ++ ends a value
    expect(shapes("const n = x++ / 2; // measured on URX44V\n")).toEqual(["hedge-sentence"]);
    expect(shapes("let i = 0; i-- / 2; // (measured)\n")).toEqual(["hedge-parenthetical"]);
    // `{}` after `return` is an OBJECT, so the slash divides; after `=>` it is a block
    expect(shapes("function f() { return {} / 2; } // measured on URX44V\n")).toEqual(["hedge-sentence"]);
    expect(shapes("const f = (a) => { return 1; }; // (measured)\n")).toEqual(["hedge-parenthetical"]);
    // a newline ENDS a token: this is `return` then `await`, not `returnawait`
    expect(shapes('function f(x){\nreturn\nawait /["]/.test(x);\n} // measured on URX44V\n')).toEqual([
      "hedge-sentence",
    ]);
    // a keyword that IS a value, and a regex's own flags
    expect(shapes("const h = this / 2; // (measured)\n")).toEqual(["hedge-parenthetical"]);
    expect(shapes("const j = /re/g.test(x) / 2; // (measured)\n")).toEqual(["hedge-parenthetical"]);
  });

  // Four more positions the goal has to hold, each valid JavaScript that returned [].
  it("holds the goal through interpolations, properties and value-ending bodies", () => {
    // `${` opens an EXPRESSION, so a regex may start there
    expect(shapes('const s = `${ /["]/.test(x) /* measured on URX44V */ }`;\n')).toEqual(["hedge-sentence"]);
    // a control keyword used as a PROPERTY heads a call, not a control structure
    expect(shapes("const n = obj.catch(x) / 2; // measured on URX44V\n")).toEqual(["hedge-sentence"]);
    // a function or class EXPRESSION ends a value at its brace; a DECLARATION ends a statement
    expect(shapes("const n = function() {} / 2; // measured on URX44V\n")).toEqual(["hedge-sentence"]);
    expect(shapes("const n = class {} / 2; // measured on URX44V\n")).toEqual(["hedge-sentence"]);
    expect(shapes("function f() {} /x/.test(s); // (measured)\n")).toEqual(["hedge-parenthetical"]);
    // …and a default parameter's own object literal does not take the body's flag
    expect(shapes("function f(a = {}) {} /x/.test(s); // (measured)\n")).toEqual(["hedge-parenthetical"]);
  });

  // Five more positions, each valid JavaScript that returned []. The body flag is a STACK
  // because these nest, and `async`, `for await` and `#name` are each a token the state has
  // to see through rather than take at face value.
  it("holds the goal through modifiers, nesting, private members and heritage", () => {
    // `async` is transparent: this is a DECLARATION, so its brace ends a statement
    expect(shapes('async function f() {} /["]/.test(x); // measured on URX44V\n')).toEqual(["hedge-sentence"]);
    // a function expression inside a default parameter, with the outer one still outstanding
    expect(shapes("const n = function (x = function(){}) {} / 2; // measured on URX44V\n")).toEqual(["hedge-sentence"]);
    // `for await (…)` heads a control structure just as `for (…)` does
    expect(
      shapes('async function f(xs) {\n  for await (const x of xs) /["]/.test(x); // measured on URX44V\n}\n'),
    ).toEqual(["hedge-sentence"]);
    // A private member's name is no more a keyword than a property's. The comment has to be
    // on the SAME line as the division: a newline stops the regex scan, so with it below the
    // brace the comment survives the mis-reading and the case measures nothing.
    expect(shapes("class C { #catch(x){return x} g(x){ return this.#catch(x) / 2 } } // measured on URX44V\n")).toEqual(
      ["hedge-sentence"],
    );
    // `extends` takes an expression
    expect(shapes('class X extends /["]/.constructor {} // measured on URX44V\n')).toEqual(["hedge-sentence"]);
  });

  // A line continuation is a backslash and a NEWLINE. Skipping the pair without counting it
  // reports every finding below it one line too few, which is a wrong file:line in a message
  // whose whole job is to point at one.
  it("counts a line continuation, in a string and in a template", () => {
    expect(findingsIn('const a = "x\\\n y";\n// (measured)\n', "x.ts").map((f) => f.line)).toEqual([3]);
    expect(findingsIn("const a = `x\\\n y`;\n// (measured)\n", "x.ts").map((f) => f.line)).toEqual([3]);
  });

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

// Rust is not JavaScript with different keywords, and each of these loses comments when
// read by the JavaScript lexer. The crate carries a third of the ledger's backlog, and none
// of it was being read at all: the extension was not claimed.
describe("what counts as a comment in Rust", () => {
  const rs = (src) => findingsIn(src, "x.rs").map((f) => f.rule);

  it("closes a block comment on the NESTING depth, not the first close", () => {
    expect(rs("/* outer /* nested */ still inside (measured) */\n")).toEqual(["hedge-parenthetical"]);
    expect(rustComments("/* a /* b */ c */ after\n").map((c) => c.text.trim())).toEqual(["a /* b */ c"]);
  });

  it("reads a raw string as a string, whatever its hash count", () => {
    expect(rs('let s = r#"a (measured) string"#; // real (measured)\n')).toEqual(["hedge-parenthetical"]);
    expect(rs('let s = br##"x (measured)"##; // (measured)\n')).toEqual(["hedge-parenthetical"]);
  });

  // A lifetime has no closing apostrophe: consumed as a quote it runs to the next one and
  // takes every comment in between with it.
  it("tells a lifetime from a character literal", () => {
    // An ODD number of them, deliberately: with an even count a naive quote scanner pairs
    // them off and the comment survives by accident, which is what two earlier versions of
    // this case asserted. The unpaired one opens a string that runs to the end of the file.
    expect(rs("fn f<'a>(x: &'a str, y: &'a u8) {} // measured on URX44V\n")).toEqual(["hedge-sentence"]);
    expect(rs("let c = 'x'; // (measured)\n")).toEqual(["hedge-parenthetical"]);
  });

  // rustc takes up to 255 hashes. Reading the delimiter inside a fixed window stops at 15,
  // and the rest of the string is then lexed as code.
  it("reads a raw string whose delimiter is longer than any fixed window", () => {
    const h = "#".repeat(15);
    // The inner quote is bare, which is what a raw string is FOR. Read as an ordinary string
    // it closes there and the rest of the line becomes a comment.
    expect(rs(`let s = r${h}"a " // measured on URX44V"${h};\n`)).toEqual([]);
    expect(rs(`let s = r${"#".repeat(40)}"x (measured)"${"#".repeat(40)}; // real (measured)\n`)).toEqual([
      "hedge-parenthetical",
    ]);
  });

  it("still reads an ordinary string as a string", () => {
    expect(rs('let s = "a (measured) value";\n')).toEqual([]);
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

  // 実測値 NAMES the data, the way "the measured EQ model" does. Refusing it would refuse
  // the thing rather than its sourcing — the same equivalence class, in the other language.
  it("takes the Japanese word where it names the data rather than the sourcing", () => {
    expect(shapes("// 実測値は device units で保持する\n")).toEqual([]);
    expect(shapes("// 実測データをそのまま渡す\n")).toEqual([]);
    // …while a date stays provenance in either language.
    expect(shapes("// 実測日 2026-01-01\n")).toEqual(["hedge-sentence-ja", "capture-date"]);
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

// Importing this module used to run its whole command line, with vitest's argv: every pin
// below scanned the tree on import, and could reach process.exit.
describe("importing the module", () => {
  it("does not run the command line", () => {
    const src = readFileSync(join(HERE, "check-comment-provenance.mjs"), "utf8");
    expect(src).toMatch(
      /const invokedDirectly = [\s\S]*?import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/,
    );
    expect(src).toMatch(/if \(invokedDirectly\) \{/);
    expect(src).toMatch(/const hook = invokedDirectly &&/);
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

describe("what counts as outside the repository", () => {
  // `relative()` between two DRIVES cannot express the step, so it returns the target
  // ABSOLUTE — and `startsWith("..")` reads that as a path INSIDE the tree with a ceiling of
  // zero, which refuses an edit to a file the ledger has no business knowing about.
  it("knows a different Windows drive is outside, where a leading .. cannot say so", () => {
    const rel = win32.relative("G:\\repo", "C:\\tmp\\outside.ts");
    expect(rel.startsWith("..")).toBe(false); // the reading the first version trusted
    expect(escapesRoot(rel, win32)).toBe(true);
  });

  it("knows a UNC root is outside too", () => {
    expect(escapesRoot(win32.relative("G:\\repo", "\\\\srv\\share\\x.ts"), win32)).toBe(true);
  });

  it("still calls a path under the root inside it", () => {
    expect(escapesRoot(win32.relative("G:\\repo", "G:\\repo\\src\\a.ts"), win32)).toBe(false);
    expect(escapesRoot("src/a.ts")).toBe(false);
    expect(escapesRoot("../elsewhere.ts")).toBe(true);
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

// JSX text is neither code nor a comment: read as code, a URL in it opens a line comment at
// the `//`. Nothing here lexes that, so the extension is not claimed — and this asserts the
// claim rather than the absence, since a `.tsx` silently scanned is the failure.
// The scan's default roots ARE the contract: a source the check never opens is a source it
// does not check, however well it lexes. The root configs and the Rust crate were both
// outside them, and both carry findings.
describe("what the default scan reaches", () => {
  const src = readFileSync(join(HERE, "check-comment-provenance.mjs"), "utf8");
  const roots = /const DEFAULT_ROOTS = \[([^\]]*)\]/.exec(src)[1];
  const ledger = JSON.parse(readFileSync(join(HERE, "comment-provenance-baseline.json"), "utf8"));

  it("names the Rust crate and the configs at the repository root", () => {
    // The CRATE, not its `src`: `build.rs` sits beside it and was Rust the scan never opened.
    expect(roots).toContain('"src-tauri"');
    expect(roots).not.toContain('"src-tauri/src"');
    expect(roots).toContain("ROOT_CONFIGS");
    expect(src).toMatch(/ROOT_CONFIGS = \[[^\]]*"vitest\.config\.ts"/);
  });

  it("reaches build.rs, which sits beside src rather than inside it", () => {
    const collected = execFileSync(process.execPath, [join(HERE, "check-comment-provenance.mjs"), "src-tauri"], {
      cwd: join(HERE, ".."),
      encoding: "utf8",
    });
    expect(collected).toMatch(/source file\(s\)/);
    // The count a `src-tauri/src`-only root would give, plus build.rs.
    const files = Number(/OK: (\d+) source file/.exec(collected)[1]);
    const srcOnly = execFileSync(process.execPath, [join(HERE, "check-comment-provenance.mjs"), "src-tauri/src"], {
      cwd: join(HERE, ".."),
      encoding: "utf8",
    });
    expect(files).toBeGreaterThan(Number(/OK: (\d+) source file/.exec(srcOnly)[1]));
  });

  // …and the ledger proves the scan actually opened them, which the root list alone cannot.
  it("has ledgered what those roots carry", () => {
    expect(Object.keys(ledger.files).some((p) => p.endsWith(".rs"))).toBe(true);
    expect(ledger.files["vitest.config.ts"]).toBeGreaterThan(0);
  });
});

describe("which file kinds are claimed", () => {
  const ledger = JSON.parse(readFileSync(join(HERE, "comment-provenance-baseline.json"), "utf8"));

  it("claims no .tsx while no JSX state exists", () => {
    const src = readFileSync(join(HERE, "check-comment-provenance.mjs"), "utf8");
    const exts = /const EXTS = new Set\(\[([^\]]*)\]\)/.exec(src)[1];
    expect(exts).not.toContain(".tsx");
    expect(exts).toContain(".ts");
    expect(Object.keys(ledger.files).some((p) => p.endsWith(".tsx"))).toBe(false);
  });
});

// The ledger only ever shrinks — that is the whole of what it promises. A write that takes
// the current counts unconditionally breaks it: add a comment, be refused by the scan, run
// --update, and the ceiling is raised to fit while the next whole-tree scan is green.
describe("what a ledger write may do", () => {
  const at = (path, n) => byFile(findingsIn(`// x (measured)\n`.repeat(n), path));

  it("refuses to raise a ceiling, and says which file would have", () => {
    const { raised } = nextLedger(at("src/a.ts", 8), { "src/a.ts": 7 });
    expect(raised).toEqual([{ path: "src/a.ts", ceiling: 7, count: 8 }]);
  });

  it("refuses to add a row for a file the ledger does not name", () => {
    expect(nextLedger(at("src/new.ts", 1), {}).raised).toEqual([{ path: "src/new.ts", ceiling: 0, count: 1 }]);
  });

  it("lowers a cleaned file, and drops a row that reached zero", () => {
    const { files, raised } = nextLedger(at("src/a.ts", 3), { "src/a.ts": 8, "src/b.ts": 2 });
    expect(raised).toEqual([]);
    expect(files).toEqual({ "src/a.ts": 3 });
  });

  it("carries a row outside the scanned set over untouched", () => {
    const { files, raised } = nextLedger(at("src/a.ts", 1), { "src/a.ts": 4, "src/b.ts": 9 }, new Set(["src/a.ts"]));
    expect(raised).toEqual([]);
    expect(files).toEqual({ "src/a.ts": 1, "src/b.ts": 9 });
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
