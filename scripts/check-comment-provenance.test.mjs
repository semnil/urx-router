// The rules over comments that record a fact's provenance, shown the arrangements they
// exist to reject and the good ones each is a mutation of. A rule that fires on everything
// is as useless as one that fires on nothing, so both sides are asserted throughout.
//
// Three of these were run by hand against the real tree before this file existed: a new
// hedge in a file the ledger does not name, one more in a file already at its ceiling, and
// a cleaned file printing its lower count. The hand runs measured the guard on one day;
// this is the same measurement on every run.
import { describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, extname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  byFile,
  comments,
  escapesRoot,
  findingsIn,
  hookDecision,
  htmlComments,
  nextLedger,
  pyComments,
  repoPath,
  shellComments,
  tomlComments,
  blockStrip,
  scanTargets,
  trackedSources,
  yamlComments,
  yamlExplicitKey,
  yamlKey,
  rustComments,
  verdict,
} from "./check-comment-provenance.mjs";
import { formatTargets, JS_FAMILY } from "./format.mjs";
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

  // What separates a function DECLARATION from an EXPRESSION is the token before the whole
  // modifier run, not the one immediately behind the keyword. Reading only that one made
  // `export function` an expression and `= async function` a declaration — each the opposite
  // of what it is — and a TypeScript return type sits at the body's own paren depth.
  it("reads through a modifier run, and does not mistake a return type for a body", () => {
    expect(shapes("const n = async function() {} / 2; // measured on URX44V\n")).toEqual(["hedge-sentence"]);
    expect(shapes('export function f() {} /["]/.test("x"); // measured on URX44V\n')).toEqual(["hedge-sentence"]);
    expect(shapes('export async function f() {} /["]/.test("x"); // measured on URX44V\n')).toEqual(["hedge-sentence"]);
    expect(shapes('export default function f() {} /["]/.test("x"); // measured on URX44V\n')).toEqual([
      "hedge-sentence",
    ]);
    expect(
      shapes("const n = function (): { x: number } {\n  return { x: 1 };\n} / 2; // measured on URX44V\n"),
    ).toEqual(["hedge-sentence"]);
  });

  // These five were reaching the check as "valid syntax hides a comment", and each was met
  // for a while by a UNION of three readings — the goal's, one forcing division, one
  // forcing a pattern — so that a miss needed all three to miss. That is withdrawn: what
  // the union was covering is five determinate defects in the goal, and each is fixed here.
  // Two keywords a pattern may follow (`export default`, and `break` across the newline the
  // grammar ends a statement at), a postfix `!` that left no value behind, a brace after
  // `=>` taking the body flag a declaration was waiting for, and a modifier-run walk that
  // began one token behind the keyword, deciding `case 1: function g()` by the `1`.
  it("reads each of the shapes the union was carried for", () => {
    expect(shapes("const f = +function<T extends () => {}>() {} / 2; // measured on URX44V\n")).toEqual([
      "hedge-sentence",
    ]);
    expect(shapes(`export default /["']/.test("x"); // measured on URX44V\n`)).toEqual(["hedge-sentence"]);
    expect(shapes('switch (k) { case 1: function g() {} /["]/.test("y"); // measured on URX44V\n }\n')).toEqual([
      "hedge-sentence",
    ]);
    expect(shapes('function h() { while (t) { break\n /["]/.test("z"); } } // measured on URX44V\n')).toEqual([
      "hedge-sentence",
    ]);
    expect(shapes("const n = x! / 2; // (measured)\n")).toEqual(["hedge-parenthetical"]);
    expect(shapes("const n = f()! / 2; // (measured)\n")).toEqual(["hedge-parenthetical"]);
  });

  // …and the four files a forced reading refused. Every one is valid JavaScript that
  // Prettier leaves exactly as it is, so the formatter could never have answered for them:
  // a forced reading walks into a pattern or a string the goal read correctly and calls
  // what it finds there a comment. THAT is what a single reading cannot do.
  it("invents no comment inside a pattern or a string it read correctly", () => {
    expect(shapes('const values = [/\\//, "(measured)"];\n')).toEqual([]);
    expect(shapes('const values = [/[//]/, "(measured)"];\n')).toEqual([]);
    expect(shapes('const values = [a / "x///y", "(measured)"];\n')).toEqual([]);
    expect(shapes("const measured = 2;\nconst n = +/x//(measured);\n")).toEqual([]);
    // …and the comment after such a pattern is still read.
    expect(shapes("const values = [/\\//]; // (measured)\n")).toEqual(["hedge-parenthetical"]);
    expect(shapes('const values = [a / "x///y"]; // (measured)\n')).toEqual(["hedge-parenthetical"]);
  });

  // The one reading is a lexical GOAL and not a character rule, and a `!` is where those two
  // answers differ: after a value it is TypeScript's non-null assertion and leaves one
  // behind, before one it is negation and wants an expression.

  // `f<string> / 2` divides an instantiation expression and `a < b > /re/.test(c)` compares
  // and then matches. One grammar cannot tell them apart; what separates them in FORMATTED
  // text is the space, and Prettier writes every comparison as `a < b` and every type
  // argument list tight against its name. Read as an operator, the `>` left the grammar
  // expecting an expression and the `/` after it opened a pattern that took the line.
  it("closes a TypeScript type argument list on a value, and leaves a comparison alone", () => {
    expect(shapes("const x = f<string> / 2; // (measured)\n")).toEqual(["hedge-parenthetical"]);
    expect(shapes("const x = f<A<B>> / 2; // (measured)\n")).toEqual(["hedge-parenthetical"]);
    expect(shapes("const m = new Map<string, number>(); // (measured)\n")).toEqual(["hedge-parenthetical"]);
    // …and the comparison, where a pattern may follow the `>` and does. The pattern carries
    // a quote, so reading the `>` as a value's end does not merely divide — it desynchronises
    // on that quote and the comment is gone.
    expect(shapes('const r = a < b > /["]/.test("d"); // (measured)\n')).toEqual(["hedge-parenthetical"]);
    // …and the operators a `>` is half of are still themselves.
    expect(shapes("const u = a >= b; // (measured)\n")).toEqual(["hedge-parenthetical"]);
    expect(shapes("const w = a >> 2; // (measured)\n")).toEqual(["hedge-parenthetical"]);
    expect(shapes("const v = (x) => x / 2; // (measured)\n")).toEqual(["hedge-parenthetical"]);
    // …and a `<` that closes nothing does not poison the statements after it: written
    // without the spaces Prettier would put there, it would otherwise leave a run open for
    // the next `>` to close.
    expect(shapes('const t = a<b;\nconst r = c > /["]/.test("d"); // (measured)\n')).toEqual(["hedge-parenthetical"]);
  });

  it("tells a postfix ! from a prefix one", () => {
    expect(shapes("const n = !/x/.test(a) ? 1 : 2; // (measured)\n")).toEqual(["hedge-parenthetical"]);
    expect(shapes("const n = a != b; // (measured)\n")).toEqual(["hedge-parenthetical"]);
    expect(shapes("const n = x! / 2 / 3; // (measured)\n")).toEqual(["hedge-parenthetical"]);
  });

  // Two comments on one line are two comments. Keyed by line and text they folded into one,
  // under which a file at a ceiling of 1 took a second copy of the same comment for free.
  it("counts two identical comments on one line as two", () => {
    expect(findingsIn("/* (measured) */ const x = 1; /* (measured) */\n", "x.ts")).toHaveLength(2);
    const grouped = byFile(findingsIn("/* (measured) */ const x = 1; /* (measured) */\n", "src/a.ts"));
    expect(verdict(grouped, { "src/a.ts": 1 }).over).toHaveLength(1);
  });

  // The union's cost is a FALSE positive where a real regex carries something that reads as
  // a comment. Every negative control has to survive it, or the union bought the misses back
  // as noise.
  it("still reads a string, a template and a regex as themselves", () => {
    expect(shapes('const s = "a (measured) value";\n')).toEqual([]);
    expect(shapes("const re = /a\\/\\/(measured)/;\n")).toEqual([]);
    expect(shapes("const x = `${a} plain (measured) text`;\n")).toEqual([]);
    expect(shapes("for (const k of Object.entries(measured)) {}\n")).toEqual([]);
  });

  // A generic constraint puts a brace at the SIGNATURE's own paren depth, where a block
  // reading takes the flag the real body was waiting for — and the comment after the
  // division then vanishes, which is a check that can be stepped around by writing one.
  it("reads a brace in a TypeScript type position as a type, not as a body", () => {
    expect(shapes("const n = function<T extends {}>() {} / 2; // measured on URX44V\n")).toEqual(["hedge-sentence"]);
    expect(shapes("const n = function<T extends { a: number }>() {} / 2; // measured on URX44V\n")).toEqual([
      "hedge-sentence",
    ]);
    expect(shapes("const n = function<T extends { a: 1 }, U extends {}>() {} / 2; // measured on URX44V\n")).toEqual([
      "hedge-sentence",
    ]);
    expect(shapes('function f(x: unknown): asserts x is { a: 1 } {} /["]/.test("y"); // measured on URX44V\n')).toEqual(
      ["hedge-sentence"],
    );
    // …and a class heritage is still a heritage: the brace after `extends Y` is the body.
    expect(shapes('class X extends Y {} /["]/.test("z"); // (measured)\n')).toEqual(["hedge-parenthetical"]);
    expect(shapes('class X extends /["]/.constructor {} // measured on URX44V\n')).toEqual(["hedge-sentence"]);
  });

  // A line continuation is a backslash and a NEWLINE. Skipping the pair without counting it
  // reports every finding below it one line too few, which is a wrong file:line in a message
  // whose whole job is to point at one.
  it("counts a line continuation, in a string and in a template", () => {
    expect(findingsIn('const a = "x\\\n y";\n// (measured)\n', "x.ts").map((f) => f.line)).toEqual([3]);
    expect(findingsIn("const a = `x\\\n y`;\n// (measured)\n", "x.ts").map((f) => f.line)).toEqual([3]);
    expect(findingsIn('const a = "x\\\r\n y";\r\n// (measured)\r\n', "x.ts").map((f) => f.line)).toEqual([3]);
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

  // The JavaScript reader learned to count a continuation; the Rust one had not, and the
  // finding below it came back one line short.
  it("counts a line continuation in a Rust string, LF and CRLF alike", () => {
    expect(findingsIn('let s = "a\\\nb";\n// measured on URX44V\n', "x.rs").map((f) => f.line)).toEqual([3]);
    expect(findingsIn('let s = "a\\\r\nb";\r\n// measured on URX44V\r\n', "x.rs").map((f) => f.line)).toEqual([3]);
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
// below scanned the tree on import, and could reach process.exit. Both halves are asked by
// RUNNING the module — the guard is a comparison between two spellings of one path, and a
// test that reads the comparison cannot tell which spellings reach it.
describe("importing the module", () => {
  const checker = join(HERE, "check-comment-provenance.mjs");

  it("does not run the command line", () => {
    const out = execFileSync(process.execPath, ["-e", `import(${JSON.stringify(checker)})`], {
      cwd: join(HERE, ".."),
      encoding: "utf8",
    });
    expect(out).toBe("");
  });

  // …and still runs it when it IS the program, reached by a path that is not the one node
  // resolves. `process.argv[1]` stays as typed while `import.meta.url` is the real path, so
  // comparing the two as strings answered "not the program" and the run exited 0 having
  // scanned nothing. Every path under macOS's temporary directory is such a path.
  it("runs it through a symlinked path, rather than exiting 0 having scanned nothing", () => {
    const tmp = mkdtempSync(join(tmpdir(), "prov-link-"));
    const link = join(tmp, "linked");
    symlinkSync(join(HERE, ".."), link, "dir");
    const out = execFileSync(process.execPath, [join(link, "scripts", "check-comment-provenance.mjs"), "src-tauri"], {
      cwd: join(HERE, ".."),
      encoding: "utf8",
    });
    rmSync(tmp, { recursive: true, force: true });
    expect(out).toMatch(/source file\(s\)/);
    expect(Number(/OK: (\d+) source file/.exec(out)[1])).toBeGreaterThan(0);
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
// A `#` opens a comment at a line start or after whitespace, and not inside a quoted
// scalar; HTML has only the one form. Both were outside the extension list, so the workflows
// and index.html were never read at all.
describe("what counts as a comment in the # languages and in HTML", () => {
  // YAML's two string forms are a quoted scalar and a BLOCK scalar, and a shared
  // quote-and-hash scan reported the second one's body as comments.
  it("reads a YAML block scalar's body as text", () => {
    expect(findingsIn("message: |\n  # measured on URX44V\n", "x.yml")).toEqual([]);
    expect(findingsIn("message: >-\n  # measured on URX44V\n", "x.yml")).toEqual([]);
    // …and the block ends where the indentation does.
    expect(findingsIn("message: |\n  body\nkey: 1  # measured on URX44V\n", "x.yml").map((f) => f.line)).toEqual([3]);
  });

  // A here-document's body is text, and a `$( … )` inside a double-quoted string is code
  // again — the first was reported and the second was lost.
  it("reads a shell here-document as text and a command substitution as code", () => {
    expect(findingsIn("cat <<EOF\n# measured on URX44V\nEOF\n", "x.sh")).toEqual([]);
    expect(findingsIn("cat <<-EOF\n\t# measured on URX44V\n\tEOF\n", "x.sh")).toEqual([]);
    expect(findingsIn("cat <<EOF\nbody\nEOF\necho x  # measured on URX44V\n", "x.sh").map((f) => f.line)).toEqual([4]);
    expect(findingsIn('x="$(echo a  # measured on URX44V\n)"\n', "x.sh").map((f) => f.rule)).toEqual([
      "hedge-sentence",
    ]);
    expect(findingsIn('echo "a # measured on URX44V"\n', "x.sh")).toEqual([]);
    expect(findingsIn("echo 'a # measured on URX44V'\n", "x.sh")).toEqual([]);
  });

  it("keeps each reader to its own language", () => {
    expect(yamlComments("a: 1  # note\n").map((c) => c.text.trim())).toEqual(["note"]);
    expect(shellComments("echo 1  # note\n").map((c) => c.text.trim())).toEqual(["note"]);
  });

  it("reads a YAML comment, and not a hash inside a quoted scalar", () => {
    expect(
      findingsIn('key: value  # (measured)\nother: "a # not a comment (measured)"\n', "x.yml").map((f) => f.line),
    ).toEqual([1]);
    expect(yamlComments("a: 1\n# note\n").map((c) => c.text.trim())).toEqual(["note"]);
  });

  it("reads a shell comment the same way", () => {
    expect(findingsIn("echo hi  # measured on URX44V\n", "x.sh").map((f) => f.rule)).toEqual(["hedge-sentence"]);
  });

  it("reads an HTML comment, and reports the line inside a multi-line one", () => {
    expect(findingsIn("<p>a</p>\n<!-- (measured) -->\n", "x.html").map((f) => f.line)).toEqual([2]);
    // One span per line the body covers, the opener's own remainder included — the same
    // shape the block-comment reader produces, so a finding's line is the line it is on.
    expect(htmlComments("<!--\n a\n b\n-->\n").map((c) => [c.line, c.text])).toEqual([
      [1, ""],
      [2, " a"],
      [3, " b"],
      [4, ""],
    ]);
  });

  // The header's two indicators come in EITHER order, and a block scalar is a VALUE — so it
  // sits after a `-` sequence entry as readily as after a key. Read as chomping-then-digit
  // and only after a `:`, `|2-` and `- |` were plain scalars whose bodies were then scanned
  // as YAML, and three lines of string content were reported as comments. Ruby's own YAML
  // parser is the positive control: it loaded the `|2-` body, the `- |` body and the
  // two-line quoted scalar below as string values.
  it("opens a block scalar on either indicator order, and on a sequence entry", () => {
    expect(findingsIn("a: |2-\n    # measured on URX44V\n", "x.yml")).toEqual([]);
    expect(findingsIn("a: |-2\n    # measured on URX44V\n", "x.yml")).toEqual([]);
    expect(findingsIn("b:\n  - |\n    # measured on URX44V\n", "x.yml")).toEqual([]);
    expect(findingsIn("- |\n  # measured on URX44V\n", "x.yml")).toEqual([]);
    // …and a plain scalar that merely ends in a pipe still opens nothing.
    expect(findingsIn("cmd: a | b  # measured on URX44V\n", "x.yml").map((f) => f.line)).toEqual([1]);
  });

  // A quoted scalar may span lines. Closed at the newline, the scan ran off the end and read
  // the NEXT line's `#` as a comment — the line was the middle of a string.
  it("carries a quoted scalar across the line it did not close on", () => {
    expect(findingsIn('c: "first\n  second # measured on URX44V"\n', "x.yml")).toEqual([]);
    expect(findingsIn("c: 'first\n  second # measured on URX44V'\n", "x.yml")).toEqual([]);
    // …and a doubled quote inside a single-quoted scalar is a character, not the end of it.
    expect(findingsIn("c: 'it''s # measured on URX44V'\n", "x.yml")).toEqual([]);
    // …while the line after it closes is YAML again.
    expect(findingsIn('c: "first\n  second"\nd: 1 # measured on URX44V\n', "x.yml").map((f) => f.line)).toEqual([3]);
  });

  // One block scalar is not data. A workflow's `run:` is shell source, and read as text its
  // comments were the only comments in this repository that nothing looked at.
  it("reads a run: block as the shell it is, and every other block as text", () => {
    const wf = (key) => `jobs:\n  a:\n    steps:\n      - ${key}: |\n          echo hi  # measured on URX44V\n`;
    const path = ".github/workflows/x.yml";
    expect(findingsIn(wf("run"), path).map((f) => f.line)).toEqual([5]);
    expect(findingsIn(wf("message"), path)).toEqual([]);
    // …and the shell reader's own rules apply inside it: a hash in a string is not a comment.
    expect(
      findingsIn('jobs:\n  a:\n    steps:\n      - run: |\n          echo "# measured on URX44V"\n', path),
    ).toEqual([]);
  });

  // The rest of a here-document's DECLARATION line is still code, and the delimiter is a
  // WORD. Read as one thing and as an identifier, `cat <<EOF # why` lost its comment, and
  // `<<END-DATA` looked for a line saying `END`: never finding one, it swallowed the file
  // from there to the end, taking every later comment with it. `bash -n` is the control.
  it("reads the rest of a here-document's declaration line, and takes its delimiter as a word", () => {
    expect(findingsIn("cat <<EOF  # measured on URX44V\nbody\nEOF\n", "x.sh").map((f) => f.line)).toEqual([1]);
    expect(findingsIn("cat <<END-DATA\ndata\nEND-DATA\n# measured on URX44V\n", "x.sh").map((f) => f.line)).toEqual([
      4,
    ]);
    expect(findingsIn("cat <<'E O F'\ndata\nE O F\n# measured on URX44V\n", "x.sh").map((f) => f.line)).toEqual([4]);
    // …and a here-STRING has no body at all, so nothing after it is swallowed.
    expect(findingsIn("cat <<<word\n# measured on URX44V\n", "x.sh").map((f) => f.line)).toEqual([2]);
    // …and two on one line take their bodies in order.
    expect(findingsIn("f <<A <<B\na\nA\nb\nB\n# measured on URX44V\n", "x.sh").map((f) => f.line)).toEqual([6]);
  });

  // A `)` closes whatever is innermost. Counted as one depth, a plain subshell's `)` closed
  // the substitution and the comment after it fell outside.
  it("closes a command substitution on its own paren, not on any", () => {
    expect(findingsIn("x=$( (printf a); # measured on URX44V\n)\n", "x.sh").map((f) => f.line)).toEqual([1]);
    expect(findingsIn('x="$( (printf a); # measured on URX44V\n)"\n', "x.sh").map((f) => f.line)).toEqual([1]);
    // …and a paren inside a double-quoted string is a character.
    expect(findingsIn('echo "a ) # measured on URX44V"\n', "x.sh")).toEqual([]);
  });

  // What the shell is handed has to be the block's VALUE. YAML strips the block's common
  // indentation, and the raw lines have it: a here-document's delimiter line then read as
  // `          EOF` never equalled the `EOF` it was declared with, so the scan swallowed the
  // rest of the block and every comment after it. `bash -n` on what Ruby's YAML returns for
  // this block exits 0.
  it("hands a run: block the value, not the lines it was written on", () => {
    const wf = [
      "jobs:",
      "  a:",
      "    steps:",
      "      - run: |",
      "          cat <<EOF",
      "          body",
      "          EOF",
      "          echo x  # measured on URX44V",
      "",
    ].join("\n");
    expect(findingsIn(wf, ".github/workflows/x.yml").map((f) => f.line)).toEqual([8]);
    // …and the indentation indicator decides it where one is given.
    // …and where an indicator is given it is what decides the value, not the first line:
    // Ruby loads this block as "    deep continuation\n# measured on URX44V\n", so a reader
    // taking the first line's own indentation strips four columns too many and eats the `#`.
    const indicated = [
      "jobs:",
      "  a:",
      "    steps:",
      "      - run: |2",
      "              deep continuation",
      "          # measured on URX44V",
      "",
    ].join("\n");
    expect(findingsIn(indicated, ".github/workflows/x.yml").map((f) => f.line)).toEqual([6]);
  });

  // A `run:` holds shell only where something runs it, and nothing in this tree runs one
  // outside GitHub Actions. Read as shell everywhere, an ordinary document's `run:` block
  // would have its text lexed against a grammar it was never written in.
  it("reads a run: block as shell under .github, and as text anywhere else", () => {
    const wf = "jobs:\n  a:\n    steps:\n      - run: |\n          echo hi  # measured on URX44V\n";
    expect(findingsIn(wf, ".github/workflows/ci.yml").map((f) => f.line)).toEqual([5]);
    expect(findingsIn(wf, ".github/actions/install/action.yml").map((f) => f.line)).toEqual([5]);
    expect(findingsIn(wf, "docs/example.yml")).toEqual([]);
    expect(findingsIn(wf, "x.yml")).toEqual([]);
  });

  // A quoted key is the SAME key — Ruby's YAML loads `"run": |` and `"r\u0075n": |` with the
  // key `run` — and matched as a plain scalar only, both blocks were left as text.
  it("reads a run: block whose key is quoted, escapes decoded", () => {
    const wf = (key) => `jobs:\n  a:\n    steps:\n      - ${key}: |\n          echo hi  # measured on URX44V\n`;
    for (const key of ["run", '"run"', "'run'", '"r\\u0075n"']) {
      expect(
        findingsIn(wf(key), ".github/workflows/x.yml").map((f) => f.line),
        key,
      ).toEqual([5]);
    }
    for (const key of ['"message"', "'shell'"]) {
      expect(findingsIn(wf(key), ".github/workflows/x.yml"), key).toEqual([]);
    }
  });

  it("names the key a block scalar is the value of, and nothing for a sequence entry", () => {
    expect(yamlKey("      - run: |")).toBe("run");
    expect(yamlKey('      - "run": |')).toBe("run");
    expect(yamlKey("      - 'run': |")).toBe("run");
    expect(yamlKey('      - "r\\u0075n": |')).toBe("run");
    expect(yamlKey("      - 'it''s': |")).toBe("it's");
    expect(yamlKey("      - message: |")).toBe("message");
    expect(yamlKey("      - |")).toBe(null);
  });

  // A command position survives WHITESPACE. Cleared by every space, an indented `case` — the
  // shape a `$( … )` block is written in — stopped being a keyword, its arms' `)` closed the
  // substitution, and the comments inside them fell back into the double quote around it,
  // where a `#` is text. `bash -n` accepts both of these and running them prints `a`.

  // An anchor or a tag may sit between the `:` and the indicator — `run: &script |` is a
  // block scalar, and GitHub Actions supports anchors. Read as a plain scalar, its body was
  // scanned as YAML, where the `#` lines of a here-document inside it are comments.
  it("opens a block scalar behind an anchor or a tag", () => {
    const anchored = "x-common: &script |\n  cat <<EOF\n  # measured on URX44V\n  EOF\n";
    expect(findingsIn(anchored, ".github/workflows/x.yml")).toEqual([]);
    const tagged = "x-common: !!str |\n  cat <<EOF\n  # measured on URX44V\n  EOF\n";
    expect(findingsIn(tagged, ".github/workflows/x.yml")).toEqual([]);
    // …and the key behind the property is still the key, so a run: block is still shell.
    const run = "jobs:\n  a:\n    steps:\n      - run: &script |\n          echo hi  # measured on URX44V\n";
    expect(findingsIn(run, ".github/workflows/x.yml").map((f) => f.line)).toEqual([5]);
    expect(yamlKey("      - run: &script |")).toBe("run");
    expect(yamlKey('      - "run": !!str |')).toBe("run");
  });

  // A reserved word that opens a compound list leaves the next word at a command position
  // too, ON THE SAME LINE. Restored only by a newline or a control operator, `if true; then
  // case x in …` never reached `case`, so the arm's `)` closed the substitution around it
  // and the comment fell back into the double quote. `bash -n` accepts both of these and
  // running them prints what they print.
  it("restores the command position after a reserved word, on the same line", () => {
    const ifThen = 'value="$(if true; then case x in x) # measured on URX44V\n  printf x;; esac; fi)"\n';
    expect(findingsIn(ifThen, "x.sh").map((f) => f.line)).toEqual([1]);
    const whileDo = 'value="$(while false; do case x in x) # measured on URX44V\n  printf x;; esac; done)"\n';
    expect(findingsIn(whileDo, "x.sh").map((f) => f.line)).toEqual([1]);
    // …and a word that opens nothing still ends the position, however it is spelled.
    expect(findingsIn('y="$(printf then; printf a)"  # measured on URX44V\n', "x.sh").map((f) => f.line)).toEqual([1]);
  });

  // The same key written the other way round. An EXPLICIT mapping entry puts `? run` on one
  // line and the `: |` that carries its value on the next, and read only where the two sit
  // together, a workflow's run block written this way was left as text.

  // A blank line and a comment-only line are not nodes, so an explicit key still waiting for
  // its value survives them. Cleared on every line that was not itself an explicit key, a
  // comment written between `? run` and its `: |` lost the key and the block stayed text.
  it("carries an explicit key across a comment and a blank line", () => {
    const commented = "steps:\n  - ? run\n    # separator\n    : |\n        echo ok # measured on URX44V\n";
    expect(findingsIn(commented, ".github/workflows/x.yml").map((f) => f.line)).toEqual([5]);
    const blank = "steps:\n  - ? run\n\n    : |\n        echo ok # measured on URX44V\n";
    expect(findingsIn(blank, ".github/workflows/x.yml").map((f) => f.line)).toEqual([5]);
    // …and a real node between them still ends the entry.
    const interrupted = "steps:\n  - ? run\n  - name: x\n    y: |\n        echo ok # measured on URX44V\n";
    expect(findingsIn(interrupted, ".github/workflows/x.yml")).toEqual([]);
  });

  // An OPTION at a command position is not the command. `time -p case x in …` puts one
  // between the reserved word and the next command, and read as an ordinary word it ended
  // the position, so `case` was not a keyword and its arm's `)` closed the substitution.
  // `bash -n` accepts all three of these.
  it("keeps the command position through a reserved word's options", () => {
    expect(
      findingsIn('v="$(time -p case x in x) # measured on URX44V\n printf x;; esac)"\n', "x.sh").map((f) => f.line),
    ).toEqual([1]);
    expect(
      findingsIn('v="$(time case x in x) # measured on URX44V\n printf x;; esac)"\n', "x.sh").map((f) => f.line),
    ).toEqual([1]);
    expect(
      findingsIn('v="$(! case x in x) # measured on URX44V\n printf x;; esac)"\n', "x.sh").map((f) => f.line),
    ).toEqual([1]);
  });

  it("carries an explicit mapping key to the line its value is on", () => {
    const explicit = "steps:\n  - ? run\n    : |\n        echo hi  # measured on URX44V\n";
    expect(findingsIn(explicit, ".github/workflows/x.yml").map((f) => f.line)).toEqual([4]);
    const quoted = 'steps:\n  - ? "run"\n    : |\n        echo hi  # measured on URX44V\n';
    expect(findingsIn(quoted, ".github/workflows/x.yml").map((f) => f.line)).toEqual([4]);
    // …and the key belongs to the entry it was written for, not to a later one.
    const other = "steps:\n  - ? message\n    : |\n        echo hi  # measured on URX44V\n";
    expect(findingsIn(other, ".github/workflows/x.yml")).toEqual([]);
    expect(yamlExplicitKey("  - ? run")).toBe("run");
    expect(yamlExplicitKey('  - ? "r\\u0075n"')).toBe("run");
    expect(yamlExplicitKey("  - run: |")).toBe(null);
  });

  // `!` is the negation operator, and what follows it is the pipeline it negates — a command
  // position. Read as an ordinary punctuator it ended one, so `! case x in …` never reached
  // `case` and the arm's `)` closed the substitution around it. `bash -n` accepts it.
  it("keeps the command position through a negation", () => {
    const negated = 'value="$(! case x in x) # measured on URX44V\n  printf x;; esac)"\n';
    expect(findingsIn(negated, "x.sh").map((f) => f.line)).toEqual([1]);
    // …and an ordinary negated pipeline is still just a pipeline.
    expect(findingsIn('y="$(! printf a)"  # measured on URX44V\n', "x.sh").map((f) => f.line)).toEqual([1]);
  });

  it("keeps the command position through the whitespace in front of a keyword", () => {
    const indented = 'y="$(\n  case x in\n    x)  # measured on URX44V\n      printf a\n      ;;\n  esac\n)"\n';
    expect(findingsIn(indented, "x.sh").map((f) => f.line)).toEqual([3]);
    const afterSemicolon = 'y="$(printf b; case x in x)  # measured on URX44V\n printf a;; esac)"\n';
    expect(findingsIn(afterSemicolon, "x.sh").map((f) => f.line)).toEqual([1]);
    // …and it is still not a keyword after a word, however much space follows that word.
    expect(findingsIn('y="$(echo   case; printf a)"  # measured on URX44V\n', "x.sh").map((f) => f.line)).toEqual([1]);
  });

  // A backtick substitution's body is CODE even inside a double quote, and read as string
  // text a comment in one was never looked at. `bash -n` accepts the script and running it
  // prints `a`.
  it("reads a backtick substitution inside a double quote as code", () => {
    expect(findingsIn('x="`echo a  # measured on URX44V\n`"\n', "x.sh").map((f) => f.line)).toEqual([1]);
    // …and the text after it closes is string again.
    expect(findingsIn('x="`echo a` # measured on URX44V"\n', "x.sh")).toEqual([]);
    // …and an escaped backtick opens nothing.
    expect(findingsIn('x="\\` # measured on URX44V"\n', "x.sh")).toEqual([]);
  });

  // A case PATTERN's `)` has no opener. Popped unconditionally it closed the substitution
  // around it, so the arm's comment fell outside the `$( … )` and back inside the double
  // quote, where a `#` is text. `bash -n` accepts it and running it prints `a`.
  it("does not let a case pattern's paren close the substitution around it", () => {
    const src = 'y="$(case x in\n  x)  # measured on URX44V\n    printf a\n    ;;\nesac)"\n';
    expect(findingsIn(src, "x.sh").map((f) => f.line)).toEqual([2]);
    // …and a pattern written with its optional leading paren closes that one, not the case.
    expect(
      findingsIn('y="$(case x in\n  (x)  # measured on URX44V\n    printf a\n  ;;\nesac)"\n', "x.sh").map(
        (f) => f.line,
      ),
    ).toEqual([2]);
    // …and `case` is a keyword only where a command could start. Read as one after `echo`,
    // its marker sits at the substitution's own depth, so the `)` that closes the
    // substitution is taken for a pattern terminator, the double quote never reopens, and
    // the comment outside it is read as string text.
    expect(findingsIn('y="$(echo case; printf a)"  # measured on URX44V\n', "x.sh").map((f) => f.line)).toEqual([1]);
  });

  // Up to two of the delimiter's own characters may sit INSIDE a TOML multi-line value, and
  // the last three of the run are what close it. Closed at the first three, `""""quoted""""`
  // left a fourth quote that opened a string of its own and swallowed the comment after it.
  // Python's tomllib loads that value as `"quoted"`.
  it("closes a TOML multi-line string on the last three quotes of the run", () => {
    expect(findingsIn('value = """"quoted"""" # measured on URX44V\n', "x.toml").map((f) => f.line)).toEqual([1]);
    expect(findingsIn("value = ''''quoted'''' # measured on URX44V\n", "x.toml").map((f) => f.line)).toEqual([1]);
    expect(findingsIn('value = """a""quoted""""" # measured on URX44V\n', "x.toml").map((f) => f.line)).toEqual([1]);
    // …and the ordinary terminator still ends it where the run is exactly three.
    expect(findingsIn('value = """quoted""" # measured on URX44V\n', "x.toml").map((f) => f.line)).toEqual([1]);
  });
});

// TOML's comment is YAML's; its strings are not. It has no block scalar, and two of its four
// string forms SPAN LINES — read by a line-oriented scanner that closes every quote at the
// newline, the `#` in a `"""…"""` value was reported as a comment. Python's tomllib is the
// positive control: it loaded that value as a string.

// How many columns YAML removes from a block scalar's body is what makes the value the
// value. Without an indicator it is the first non-empty line's indentation; WITH one the
// count is from the column of the node the scalar belongs to, which is not the header
// line's — for `- run: |2` it is the key's column and for a bare `- |2` the dash's. The
// table is what Ruby answers; the differential below re-measures it.
const BLOCKS = [
  ["key: |2\n    a\n     b\n", 0, 2],
  ["m:\n  key: |2\n      a\n       b\n", 1, 4],
  ["s:\n  - run: |2\n      a\n       b\n", 1, 6],
  ["s:\n  - run: |\n      a\n       b\n", 1, 6],
  ["s:\n  - |2\n      a\n       b\n", 1, 4],
  ["s:\n  - |\n      a\n       b\n", 1, 6],
  ["key: |1\n   a\n", 0, 1],
  ["key: |4\n        a\n", 0, 4],
  ["jobs:\n  a:\n    steps:\n      - run: |2\n              deep\n          x\n", 3, 10],
];

describe("what a block scalar's value is indented by", () => {
  const stripOf = ([doc, head]) => {
    const lines = doc.split("\n");
    return blockStrip(lines[head], lines.slice(head + 1));
  };

  it("counts from the owning node's column, not from the header line's", () => {
    for (const block of BLOCKS) expect(stripOf(block), block[0]).toBe(block[2]);
  });
});

// The table above is a copy of Ruby's answers, and a copy can drift from what it copied.
// Where ruby exists — this machine, and the ubuntu runner ci.yml uses — ask it directly:
// the columns removed are the raw line's indentation minus what survived in the value.
// Skipped elsewhere, and the skip is named rather than silent.
const ruby = spawnSync("ruby", ["-e", "puts 1"], { encoding: "utf8" });
const rubyAvailable = !ruby.error && ruby.status === 0;

describe.skipIf(!rubyAvailable)("block scalars, differentially against Ruby's YAML", () => {
  it("removes what Ruby removes, on every block in the table", () => {
    const script = `
      require "yaml"
      require "json"
      def scalar(o)
        case o
        when String then o.include?("\\n") ? o : nil
        when Array then o.map { |v| scalar(v) }.compact.first
        when Hash then o.values.map { |v| scalar(v) }.compact.first
        end
      end
      puts JSON.generate(JSON.parse(STDIN.read).map { |doc| scalar(YAML.load(doc)) })
    `;
    const run = spawnSync("ruby", ["-e", script], {
      input: JSON.stringify(BLOCKS.map(([doc]) => doc)),
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    const values = JSON.parse(run.stdout);
    const measured = BLOCKS.map(([doc, head], n) => {
      const raw = doc
        .split("\n")
        .slice(head + 1)
        .find((l) => l.trim() !== "");
      const kept = values[n].split("\n")[0];
      return raw.length - raw.trimStart().length - (kept.length - kept.trimStart().length);
    });
    expect(measured).toEqual(BLOCKS.map((b) => b[2]));
  });
});

describe("what counts as a comment in TOML", () => {
  it("carries a multi-line string past the newline that did not close it", () => {
    expect(findingsIn('name = """\nblock # measured on URX44V string\n"""\n', "x.toml")).toEqual([]);
    expect(findingsIn("name = '''\nblock # measured on URX44V string\n'''\n", "x.toml")).toEqual([]);
    expect(findingsIn('name = "a # measured on URX44V"\n', "x.toml")).toEqual([]);
    // …and a literal string has no escapes at all, so a trailing backslash does not extend it.
    expect(findingsIn("name = 'a\\'\nother = 1  # measured on URX44V\n", "x.toml").map((f) => f.line)).toEqual([2]);
  });

  it("still reads a TOML comment, and reports its line", () => {
    expect(tomlComments('# note\nname = "x"  # second\n').map((c) => [c.line, c.text.trim()])).toEqual([
      [1, "note"],
      [2, "second"],
    ]);
  });

  // The two languages disagree about where a comment may start, which is the reading that
  // separates them: TOML ends a value at a `#` wherever it appears, and YAML needs a space
  // in front of one or the `#` is part of the plain scalar. Python's tomllib loads
  // `a = 1# …` as the integer 1; Ruby's YAML loads `a: 1# …` as the string "1# …".
  it("ends a value at a hash with no space in front of it", () => {
    expect(findingsIn("a = 1# measured on URX44V\n", "x.toml").map((f) => f.line)).toEqual([1]);
    expect(findingsIn("a: 1# measured on URX44V\n", "x.yml")).toEqual([]);
  });

  // A block scalar is a YAML shape. A reader that looks for one in TOML has a state TOML can
  // never leave, which is why the two are separate rather than sharing the hash rule.
  it("does not open a YAML block scalar in a TOML value", () => {
    expect(findingsIn('cmd = "a | b"\nx = 1  # measured on URX44V\n', "x.toml").map((f) => f.line)).toEqual([2]);
  });
});

// The skill ships a Python script, and nothing read it: `.py` was in no extension list and
// `.claude` was under no scan root, so naming the file on the command line printed
// `0 source file(s)` and exited 0.
describe("what counts as a comment in Python", () => {
  it("reads a hash comment, and not one inside a string", () => {
    expect(findingsIn("# measured on URX44V\nx = 1\n", "x.py").map((f) => f.line)).toEqual([1]);
    expect(findingsIn("x = 1  # measured on URX44V\n", "x.py").map((f) => f.line)).toEqual([1]);
    expect(findingsIn('x = "a # measured on URX44V"\n', "x.py")).toEqual([]);
    expect(findingsIn("x = 'a # measured on URX44V'\n", "x.py")).toEqual([]);
  });

  // A docstring is a string, which is the line every other reader here draws: what the
  // language stores as a value is data. Stated by a case rather than left to be inferred:
  // a docstring is what Python uses where another language writes a comment, so the choice
  // is worth asserting instead of leaving to be read off the scanner.
  it("reads a triple-quoted string as a string, across the lines it spans", () => {
    expect(findingsIn('"""\ndoc # measured on URX44V\n"""\nx = 1\n', "x.py")).toEqual([]);
    expect(findingsIn("'''\ndoc # measured on URX44V\n'''\n", "x.py")).toEqual([]);
    // …and the code after it is code again, on the right line.
    expect(findingsIn('"""\ndoc\n"""\nx = 1  # measured on URX44V\n', "x.py").map((f) => f.line)).toEqual([4]);
  });

  // A backslash escapes the quote in a RAW string too, so both are read the same way.
  it("does not end a raw string on an escaped quote", () => {
    expect(pyComments('x = r"\\"# not a comment"\ny = 1  # note\n').map((c) => [c.line, c.text.trim()])).toEqual([
      [2, "note"],
    ]);
  });
});

// PEP 701 made a replacement field ordinary Python, comments included, so a multi-line
// f-string is not the opaque string a docstring is. The table below is what CPython's own
// tokenizer answers, and the differential at the foot of this describe re-measures it
// wherever python3 exists — a table alone would pin whatever the reader happened to do.
const F_STRINGS = [
  ['value = f"""{\n    1  # measured on URX44V\n}"""\n', [2]],
  ['v = f"{x}"  # c\n', [1]],
  // A `#` in a FORMAT SPEC is a fill character, and a `!` is the conversion unless it is `!=`.
  ['v = f"{x:#>10}"  # c\n', [1]],
  // The same where the field spans lines and a comment in it WOULD be one: read without a
  // format-spec state, the fill character opens a comment that swallows the rest of the line.
  ['v = f"""{\n  x:#>10\n}"""\nw = 1  # c\n', [4]],
  ['v = f"{x:>{w}}"  # c\n', [1]],
  ['v = f"{x!r}"  # c\n', [1]],
  // A conversion ends the EXPRESSION and not the field: what follows `!s` is the field
  // again, so a comment may sit between it and the `}`. Read as the format spec's opening,
  // this comment was scanned as fill text.
  ['value = f"""{1!s  # measured on URX44V\n}"""\n', [1]],
  ['v = f"{x!s:>10}"  # c\n', [1]],
  ['v = f"{a != b}"  # c\n', [1]],
  // …and a `!` before an identifier that merely starts with one of the three letters is an
  // operator, not a conversion.
  ['v = f"{a if not sub else b}"  # c\n', [1]],
  // A field may carry the same quote the string is written with, which is also PEP 701.
  ['v = f"{d["a"]}"  # c\n', [1]],
  ['v = f"{{x}}"  # c\n', [1]],
  ['v = f"a # b {x}"  # c\n', [1]],
  ['v = f"""{\n  a  # one\n}{\n  b  # two\n}"""\n', [2, 4]],
  ['v = f"""{ f"{y}" }"""  # c\n', [1]],
  ['v = fr"""{\n  1  # c\n}"""\n', [2]],
  ['v = rb"# not"\nw = 1  # c\n', [2]],
  ['def f(): return "# not"\nx = 1  # c\n', [2]],
];

// PEP 750's template strings carry replacement fields exactly as f-strings do, and read as
// ordinary strings their fields were skipped whole. Their own table, because a CPython
// older than 3.14 cannot compile one at all — the differential below says how many it had
// to leave out rather than passing over them in silence.
const T_STRINGS = [
  ['value = t"""{1  # measured on URX44V\n}"""\n', [1]],
  ['v = t"{x}"  # c\n', [1]],
  ['v = tr"""{\n  1  # c\n}"""\n', [2]],
  ['v = t"{x:#>10}"  # c\n', [1]],
];

const PY_CASES = [...F_STRINGS, ...T_STRINGS];

describe("what counts as a comment inside an f-string", () => {
  it("reads a replacement field as code and a format spec as text", () => {
    for (const [src, lines] of PY_CASES) {
      expect(
        pyComments(src).map((c) => c.line),
        src,
      ).toEqual(lines);
    }
  });
});

// The table above is a copy of CPython's answers, and a copy can drift from what it copied.
// Where python3 exists — this machine, and the ubuntu runner ci.yml uses — ask it directly.
// Skipped elsewhere, and the skip is named rather than silent.
const python = spawnSync("python3", ["-c", "print(1)"], { encoding: "utf8" });
const pythonAvailable = !python.error && python.status === 0;

describe.skipIf(!pythonAvailable)("f-strings, differentially against CPython's tokenizer", () => {
  it("agrees with tokenize on every case this interpreter can compile", () => {
    // A case the running CPython cannot compile is reported as `null` rather than dropped:
    // a template string needs 3.14, and a differential that quietly skipped what it could
    // not parse would read the same whether it measured four cases or none.
    const script = [
      "import io, json, sys, tokenize",
      "out = []",
      "for src in json.loads(sys.argv[1]):",
      "    try:",
      "        compile(src, '<case>', 'exec')",
      "    except SyntaxError:",
      "        out.append(None)",
      "        continue",
      "    lines = []",
      "    for t in tokenize.tokenize(io.BytesIO(src.encode()).readline):",
      "        if t.type == tokenize.COMMENT:",
      "            lines.append(t.start[0])",
      "    out.append(lines)",
      "print(json.dumps(out))",
    ].join("\n");
    const run = spawnSync("python3", ["-c", script, JSON.stringify(PY_CASES.map(([src]) => src))], {
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    const answers = JSON.parse(run.stdout);
    // Only a template string may go unread here, and only on a CPython older than 3.14 —
    // which is a POSITION in the list, not a shape to be matched.
    const uncompiled = answers.flatMap((a, n) => (a === null ? [n] : []));
    expect(uncompiled.filter((n) => n < F_STRINGS.length)).toEqual([]);
    if (uncompiled.length) console.warn(`template strings not compiled by this python3: ${uncompiled.length}`);
    const compiled = PY_CASES.filter((_, n) => answers[n] !== null);
    expect(compiled.length).toBeGreaterThanOrEqual(F_STRINGS.length);
    expect(answers.filter((a) => a !== null)).toEqual(compiled.map(([, lines]) => lines));
  });
});

describe("what the default scan reaches", () => {
  const ledger = JSON.parse(readFileSync(join(HERE, "comment-provenance-baseline.json"), "utf8"));
  const ROOT = join(HERE, "..");
  // A stub git, so a rule can be shown a tree this repository does not have. The real one is
  // asked for in the cases below that need it.
  const listing =
    (...rels) =>
    () =>
      rels.map((r) => r + "\0").join("");
  const rel = (paths) => paths.map((p) => relative(ROOT, p).split(sep).join("/"));

  it("keeps the extensions it reads, and drops its own two files from what it SCANS", () => {
    const listed = listing(
      "src/a.ts",
      "README.md",
      "scripts/check-comment-provenance.mjs",
      "scripts/check-comment-provenance.test.mjs",
      "anywhere/deep/b.py",
    );
    const inventory = trackedSources(ROOT, listed, () => true);
    // The inventory keeps them, because the formatter takes this list too.
    expect(rel(inventory)).toEqual([
      "src/a.ts",
      "scripts/check-comment-provenance.mjs",
      "scripts/check-comment-provenance.test.mjs",
      "anywhere/deep/b.py",
    ]);
    expect(rel(scanTargets(inventory))).toEqual(["src/a.ts", "anywhere/deep/b.py"]);
  });

  // The list of directories this replaced is the mutation, and it is shown beside the good
  // arrangement rather than described: the Python file the skill ships sat outside all five
  // of its roots, and the scan reported `0 source file(s)` while naming it on the command
  // line — a green run over a file it had not opened.
  it("reaches a tracked file no list of roots named", () => {
    const NAMED_ROOTS = ["src", "e2e", "scripts", "src-tauri", ".github"];
    const skill = ".claude/skills/urx-routing-planner/scripts/plan_tool.py";
    expect(rel(trackedSources())).toContain(skill);
    expect(NAMED_ROOTS.some((r) => skill.startsWith(r + "/"))).toBe(false);
  });

  it("drops a tracked path that is not in the worktree rather than reading it", () => {
    expect(trackedSources(ROOT, listing("src/gone.ts"), () => false)).toEqual([]);
  });

  // A scan that cannot ask git must not answer with a smaller tree. Silently walking a few
  // directories instead is the arrangement above, and it reads as success.
  it("throws when git cannot answer, instead of scanning what it can reach", () => {
    expect(() =>
      trackedSources(ROOT, () => {
        throw new Error("not a git repository");
      }),
    ).toThrow(/not a git repository/);
  });

  it("exits 1 rather than scanning nothing, when the tree is not a repository", () => {
    const tmp = mkdtempSync(join(tmpdir(), "prov-norepo-"));
    mkdirSync(join(tmp, "scripts"));
    copyFileSync(join(HERE, "check-comment-provenance.mjs"), join(tmp, "scripts", "check-comment-provenance.mjs"));
    copyFileSync(
      join(HERE, "comment-provenance-baseline.json"),
      join(tmp, "scripts", "comment-provenance-baseline.json"),
    );
    let status = 0;
    let stderr = "";
    try {
      execFileSync(process.execPath, [join(tmp, "scripts", "check-comment-provenance.mjs")], {
        cwd: tmp,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      status = err.status;
      stderr = err.stderr;
    }
    rmSync(tmp, { recursive: true, force: true });
    expect(status).toBe(1);
    expect(stderr).toMatch(/Cannot list this repository's files/);
  });

  // The flags are asked of a real git rather than read off the source: `--others` is what
  // puts a file written but not yet added in scope, and `--exclude-standard` is the whole of
  // what keeps node_modules, dist and the private reference tree out.
  it("scans a file not yet added, and never one the ignore rules cover", () => {
    const tmp = mkdtempSync(join(tmpdir(), "prov-repo-"));
    const git = (...args) => execFileSync("git", ["-C", tmp, ...args], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(tmp, ".gitignore"), "ignored/\n");
    mkdirSync(join(tmp, "ignored"));
    writeFileSync(join(tmp, "ignored", "a.ts"), "// x\n");
    writeFileSync(join(tmp, "added.ts"), "// x\n");
    writeFileSync(join(tmp, "written.ts"), "// x\n");
    git("add", "added.ts");
    const out = trackedSources(tmp).map((p) => relative(tmp, p).split(sep).join("/"));
    rmSync(tmp, { recursive: true, force: true });
    expect(out.sort()).toEqual(["added.ts", "written.ts"]);
  });

  // Named twice — as itself, or once under a directory that also contains it — a file was
  // read twice and its findings counted twice, so a path sitting at its ceiling failed
  // against itself. The run below names one that carries a ledgered finding.
  it("reads a file named twice once", () => {
    const once = execFileSync(
      process.execPath,
      [join(HERE, "check-comment-provenance.mjs"), "src/core/control/client.ts"],
      { cwd: ROOT, encoding: "utf8" },
    );
    const twice = execFileSync(
      process.execPath,
      [join(HERE, "check-comment-provenance.mjs"), "src/core/control/client.ts", "src/core/control/client.ts"],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(Number(/OK: (\d+) source file/.exec(once)[1])).toBe(1);
    expect(twice).toBe(once);
    // …and the same file reached through a directory and by name is still one file.
    const both = execFileSync(
      process.execPath,
      [join(HERE, "check-comment-provenance.mjs"), "src/core/control", "src/core/control/client.ts"],
      { cwd: ROOT, encoding: "utf8" },
    );
    const dir = execFileSync(process.execPath, [join(HERE, "check-comment-provenance.mjs"), "src/core/control"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(both).toBe(dir);
  });

  // `resolve()` is not one name per file: on macOS `/tmp` and `/private/tmp` are the same
  // directory, so a file named through each was read twice — and the second spelling has no
  // ledger row at all, so a file at its ceiling failed against a copy of itself.

  // A path that is not there is a question this cannot answer, and `0 source file(s)` with
  // exit 0 says the opposite — a typo in a hook's payload or in a CI step read as a clean
  // tree.
  it("fails on a named path that does not exist, rather than scanning nothing", () => {
    let status = 0;
    let stderr = "";
    try {
      execFileSync(process.execPath, [join(HERE, "check-comment-provenance.mjs"), "does-not-exist.ts"], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      status = err.status;
      stderr = err.stderr;
    }
    expect(status).toBe(1);
    expect(stderr).toMatch(/does-not-exist\.ts: no such file or directory/);
    // …and one that does exist is still read.
    const ok = execFileSync(
      process.execPath,
      [join(HERE, "check-comment-provenance.mjs"), "src/core/control/client.ts"],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(ok).toMatch(/OK: 1 source file/);
  });

  it("reads a file named through a link and by its own path once", () => {
    const tmp = mkdtempSync(join(tmpdir(), "prov-link-dedupe-"));
    symlinkSync(ROOT, join(tmp, "link"), "dir");
    const direct = execFileSync(
      process.execPath,
      [join(HERE, "check-comment-provenance.mjs"), "src/core/control/client.ts"],
      { cwd: ROOT, encoding: "utf8" },
    );
    const both = execFileSync(
      process.execPath,
      [
        join(HERE, "check-comment-provenance.mjs"),
        "src/core/control/client.ts",
        join(tmp, "link", "src", "core", "control", "client.ts"),
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    rmSync(tmp, { recursive: true, force: true });
    expect(both).toBe(direct);
  });

  it("reaches build.rs, which sits beside src rather than inside it", () => {
    const collected = execFileSync(process.execPath, [join(HERE, "check-comment-provenance.mjs"), "src-tauri"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(collected).toMatch(/source file\(s\)/);
    // The count a `src-tauri/src`-only root would give, plus build.rs.
    const files = Number(/OK: (\d+) source file/.exec(collected)[1]);
    const srcOnly = execFileSync(process.execPath, [join(HERE, "check-comment-provenance.mjs"), "src-tauri/src"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(files).toBeGreaterThan(Number(/OK: (\d+) source file/.exec(srcOnly)[1]));
  });

  // …and the ledger proves the scan actually opened them, which a file list alone cannot.
  // A dialect the lexer knows but the extension list does not claim is a dialect nothing
  // reads. The reading and the SCANNING are separate gates, and only running the scan asks
  // the second one.
  it("actually opens the YAML the workflows are written in", () => {
    const out = execFileSync(process.execPath, [join(HERE, "check-comment-provenance.mjs"), ".github"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(Number(/OK: (\d+) source file/.exec(out)[1])).toBeGreaterThan(0);
    expect(Number(/, (\d+) ledgered finding/.exec(out)[1])).toBeGreaterThan(0);
  });

  it("has ledgered what those roots carry", () => {
    expect(Object.keys(ledger.files).some((p) => p.endsWith(".rs"))).toBe(true);
    expect(Object.keys(ledger.files).some((p) => p.startsWith(".github/"))).toBe(true);
    expect(ledger.files["vitest.config.ts"]).toBeGreaterThan(0);
  });
});

// The union's false positive is unreachable in FORMATTED text, and that argument is only as
// wide as the formatter's reach. So the two file lists are one list, and this is where that
// is measured rather than stated.
describe("what the formatter reaches", () => {
  const ROOT = join(HERE, "..");
  const rel = (paths) => paths.map((p) => relative(ROOT, p).split(sep).join("/"));

  it("keeps what Prettier parses out of everything the checker reads", () => {
    const sources = ["src/a.ts", "x.mjs", "e2e/b.cjs", "src/style.css", "midi.html", "s.sh", "a.yml", "p.py", "c.rs"];
    expect(formatTargets(sources.map((p) => join(ROOT, p)))).toEqual([
      "e2e/b.cjs",
      "midi.html",
      "src/a.ts",
      "src/style.css",
      "x.mjs",
    ]);
  });

  // The glob list this replaced, beside the derived one. Both are asked about the same three
  // files, and the glob answers for one of them: a `.mjs` at the repository root and one
  // under e2e/ were scanned by the checker and formatted by nothing, which is what made the
  // false positive reachable in a file that `pnpm format` left exactly as it found it.
  it("covers a JavaScript file the glob list it replaced did not", () => {
    const GLOBS = [/^src\/.*\.ts$/, /^e2e\/.*\.ts$/, /^scripts\/.*\.mjs$/, /^[^/]*\.ts$/];
    const outside = ["x.mjs", "e2e/helper.mjs", "src/legacy.js"];
    const covered = formatTargets(outside.map((p) => join(ROOT, p)));
    expect(covered).toEqual(["e2e/helper.mjs", "src/legacy.js", "x.mjs"]);
    expect(outside.filter((p) => GLOBS.some((g) => g.test(p)))).toEqual([]);
  });

  // The property itself, over the tree as it stands: nothing the union reads is outside the
  // formatter. It is an identity by construction, and asserted anyway — a filter narrowed by
  // one extension would leave it false without anything else changing.
  it("leaves no file the union reads unformatted", () => {
    const sources = trackedSources();
    const unionRead = rel(sources).filter((p) => JS_FAMILY.has(extname(p).toLowerCase()));
    const formatted = new Set(formatTargets(sources));
    expect(unionRead.length).toBeGreaterThan(300);
    expect(unionRead.filter((p) => !formatted.has(p))).toEqual([]);
  });

  // Being scanned and being formatted are different questions, and one filter answered
  // both: the self-exclusion sat in the inventory, so `pnpm format` skipped this checker
  // and its pins — narrower than the `scripts/**/*.mjs` glob it replaced, and it shipped a
  // commit of unformatted edits past a green `format` check.
  it("formats its own two files, which it does not scan", () => {
    const sources = trackedSources();
    const formatted = new Set(formatTargets(sources));
    const scanned = new Set(rel(scanTargets(sources)));
    for (const own of ["scripts/check-comment-provenance.mjs", "scripts/check-comment-provenance.test.mjs"]) {
      expect(formatted.has(own), own).toBe(true);
      expect(scanned.has(own), own).toBe(false);
    }
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

// A count in prose is wrong the moment the corpus moves, and this one moved three times
// while the header still said 318 across 103 files. The ledger file is where it stays true.
describe("what the header may claim", () => {
  it("states no finding or file count of its own", () => {
    const header = readFileSync(join(HERE, "check-comment-provenance.mjs"), "utf8").split("\nimport ")[0];
    expect(header).not.toMatch(/\b\d{2,}\s+(?:comments?|findings?|files?)\b/);
    expect(header).toMatch(/the count is in the ledger file/i);
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
