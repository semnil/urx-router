#!/usr/bin/env node
// Flags a source comment that records where a fact CAME FROM instead of what the code does.
//
// A comment carries the behaviour and the assumptions the code rests on. A reading, a
// capture date, or a hedge naming the run that established a fact is a derivation: it goes
// stale at the next measurement, and it has a home already — the pull request, the
// documents under docs/, or the private ledgers. Two shapes are enforced:
//
//   provenance hedge   "(measured)", "-- measured", "Measured on a URX44V", "measured by
//                      driving ...". The claim beside it stays; only the sourcing goes.
//   capture date       an ISO date in a comment, which is a reading's timestamp and is
//                      wrong the moment anyone re-measures.
//
// The word itself is NOT the target: "the level meters are measured" describes the data,
// and "the measured EQ model" names a model. Only the shapes above are refused, which is
// deliberate — a checker wide enough to catch every phrasing teaches evasion instead.
//
// COMMENTS ONLY. `Object.entries(measured)` is an identifier and must not be reported, so
// the file is lexed rather than grepped.
//
// THE LEDGER. This idiom predates the rule by a long way — the count is in the ledger file
// itself, which is the only place it stays true — and removing it in one sweep would be a
// comment-only diff across a third of the tree, which no one can review and which deletes
// provenance that in places has no other home. So `comment-provenance-baseline.json` holds
// a per-file CEILING: a file may carry what it carried, and no more. A new one fails, and a
// file that has been cleaned prints its lower count in the ledger's own shape so lowering it
// is a paste. What the ceiling cannot see is a file cleaned and later re-dirtied back up to
// its old number; the count is the thing being watched, not which lines it came from.
//
//   node scripts/check-comment-provenance.mjs [path ...]  check files/directories (cwd)
//   node scripts/check-comment-provenance.mjs --hook      check the file named in a Claude
//                                                         Code PostToolUse payload on stdin
//   node scripts/check-comment-provenance.mjs --update    LOWER the ledger to what the tree
//                                                         now carries; it refuses to raise
//   node scripts/check-comment-provenance.mjs --reseed    take the counts as they are, for a
//                                                         RULE change that grows the corpus
//
// Exits 1 on findings above the ledger; --hook exits 2 so the message is fed back to Claude.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_ANYWHERE = new Set(["node_modules", ".git", "dist", "dist-trace", "coverage", "target"]);
const SKIP_PATHS = new Set(["reference", "src-tauri/target", ".claude/skills/urx-routing-planner-workspace"]);
// `.tsx` is deliberately absent. JSX text is neither code nor a comment, and read as code a
// URL in it opens a line comment at the `//` — `<div>https://x.test/(measured)</div>` was
// reported as a finding. This tree carries no JSX at all, so lexing it would be a state
// machine written against no input; the day one arrives, the extension and the JSX state go
// in together rather than the extension alone.
const EXTS = new Set([".ts", ".mjs", ".cjs", ".js", ".css", ".rs", ".yml", ".yaml", ".sh", ".html", ".toml", ".py"]);
/** Which comment syntax a file is read with. Rust is not JavaScript with different
 *  keywords: its block comments NEST, its raw strings carry any number of hashes, and a
 *  leading `'` is a lifetime far more often than a character literal — read as a quote it
 *  runs to the next one and takes every comment in between with it. */
const dialect = (path) => {
  const ext = extname(path).toLowerCase();
  if (ext === ".css") return "css";
  if (ext === ".rs") return "rust";
  if (ext === ".sh") return "shell";
  // A `run:` block holds shell only where something runs it. GitHub Actions is the one
  // thing in this tree that does, so ordinary YAML keeps its `run:` as the text it is.
  if (ext === ".yml" || ext === ".yaml")
    return /(^|\/)\.github\/(workflows|actions)\//.test(path.split(sep).join("/")) ? "yaml-actions" : "yaml";
  if (ext === ".html") return "html";
  if (ext === ".toml") return "toml";
  if (ext === ".py") return "python";
  return "js";
};
// This checker and its own pins quote the shapes they refuse, so they are not scanned.
const SELF = /(^|\/)check-comment-provenance(\.test)?\.mjs$/;
/** The enforced shapes, each named for what it is so the finding can say it. */
const RULES = [
  {
    id: "hedge-parenthetical",
    // "(measured)" / "(measured, ...)" — the appositive that says where a fact came from.
    // `\b` is asserted only around the LATIN word: JavaScript's word class is ASCII, so a
    // boundary next to 実 or 測 never matches and the Japanese half would silently never
    // fire. The full-width parenthesis is the pair that form is actually written in.
    re: /[(（](?:measured\b|実測)[^)）]*[)）]/gi,
    say: "a parenthetical naming the run behind the claim",
  },
  {
    id: "hedge-dash",
    // "-- measured, ..." / "— measured." — the same appositive, set off by a dash.
    re: /(?:—|--)\s*(?:measured\b|実測)/gi,
    say: "a dash appositive naming the run behind the claim",
  },
  {
    id: "hedge-sentence",
    // "Measured on a URX44V", "Measured with the faces rendered", "measured by driving ...".
    // `against` and `in` are deliberately absent: "the drag is measured against the cap"
    // and "measured in ms" are the code's own vocabulary, and a rule that cannot tell them
    // from provenance would be teaching people to reword rather than to move the reading.
    re: /\bmeasured\s+(?:on|at|with|by|before)\b/gi,
    say: "a sentence recording how the fact was measured",
  },
  {
    id: "hedge-sentence-ja",
    // The same sentence in Japanese. Its boundary is the particle or punctuation that
    // follows, not `\b` — and a following Latin word (実測 on a URX44V) counts too, which
    // is the shape a mixed comment takes.
    // 値 is deliberately absent: 実測値 NAMES the data, the way "the measured EQ model"
    // does in English, and refusing it would be refusing the thing rather than its sourcing.
    // 日 stays — a measurement's DATE is provenance whatever language it is written in.
    re: /実測(?:[でにをはがのしすさ済日]|[:：]|\s*[A-Za-z(（])/g,
    say: "a sentence recording how the fact was measured",
  },
  {
    id: "capture-date",
    // A reading's timestamp. Dates belong to the run, and the run is written up elsewhere.
    re: /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/g,
    say: "a capture date",
  },
];

// Whether a `/` opens a PATTERN or divides is not decidable from the preceding character:
// `)` ends a value after a call and starts an expression after `if (…)`, `}` ends a value
// after an object literal and starts one after a block, and `+` is an operator in `a + /re/`
// and part of a postfix `++` in `x++ / 2`. So the lexer carries the goal as STATE, the way
// the grammar does: the last significant token, plus a stack per bracket kind saying what
// that bracket was.

/** After these keywords a `/` opens a PATTERN; after any other name — an identifier, or a
 *  keyword that IS a value like `this` — it divides. */
const REGEX_AFTER = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "case",
  "do",
  "else",
  "yield",
  "await",
  "new",
  "delete",
  "void",
  "throw",
  "extends",
  // `export default /re/.test(x)` — an expression follows, so a `/` here opens a pattern.
  // Absent, the goal divided and then desynchronised on a quote inside what was the
  // pattern, losing the comment after it.
  "default",
  // A `/` can never DIVIDE one of these — `break / x` is not a program — so whatever the
  // newline in between, the slash begins a new statement and opens a pattern.
  "break",
  "continue",
  "debugger",
]);
/** A `(` that follows one of these heads a control structure, so its `)` does not end a
 *  value and a `/` after it opens a pattern. Every other `(` is a call or a group. */
/** Modifiers a declaration may wear before `function` or `class`. They are transparent:
 *  what decides declaration-versus-expression is the token before the whole run. */
const MODIFIERS = new Set(["async", "export", "default", "declare", "abstract"]);
const CONTROL_HEADS = new Set(["if", "for", "while", "with", "switch", "catch"]);
/** A `{` after one of these is an OBJECT literal, because each demands an expression. After
 *  anything else — a `)`, a `;`, `=>`, another block, the start of input — it is a block. */
const OBJECT_AFTER = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "instanceof",
  "yield",
  "await",
  "new",
  "delete",
  "void",
  "throw",
  // TypeScript type positions. A brace after one of these is a type literal, and a generic
  // constraint puts one at the SIGNATURE's own paren depth — `function<T extends {}>() {}`
  // — where a block reading takes the flag the real body was waiting for. A list of
  // keywords rather than a type grammar, and that is the limit: a brace inside a type this
  // list does not name can still be read as a block.
  "extends",
  "implements",
  "satisfies",
  "infer",
  "keyof",
  "readonly",
  "asserts",
  "as",
  "is",
]);

const isIdStart = (c) => /[A-Za-z_$]/.test(c);
const isIdPart = (c) => /[A-Za-z0-9_$]/.test(c);

/**
 * Comment spans of one source file, as {line, text, start, end}.
 *
 * For JavaScript and TypeScript this is ONE reading, the lexical goal's own. It was the
 * union of three for a while — the goal's, one where every ambiguous slash divides, one
 * where every ambiguous slash opens a pattern — so that a miss needed all three to miss.
 * That is withdrawn. A forced reading has no grammar, so what it produces where it differs
 * from the goal is a recovery or an invention with nothing to tell them apart: three rounds
 * of review each found one valid, Prettier-stable file it refused — `[/\//, "…"]`,
 * `[/[//]/, "…"]`, `[a / "x///y", "…"]` — and each proposed discriminator turned out to have
 * the same shape as the recovery it was meant to keep.
 *
 * What the union was covering was five defects in the goal, every one of them determinate
 * and now fixed: `export default` and `break` were missing from the keywords a pattern may
 * follow, a postfix `!` left no value behind, a brace after `=>` took the body flag a
 * declaration was waiting for, and the modifier-run walk started one token too far back. So
 * the trade is a MISS class this reading can still have, for a FALSE-POSITIVE class it
 * cannot: a defect here is a grammar bug with one correct answer, which is the kind that can
 * be fixed once and pinned.
 */
export function comments(src, mode = "js") {
  if (mode === "rust") return rustComments(src);
  if (mode === "yaml" || mode === "yaml-actions") return yamlComments(src, mode === "yaml-actions");
  if (mode === "toml") return tomlComments(src);
  if (mode === "python") return pyComments(src);
  if (mode === "shell") return shellComments(src);
  if (mode === "html") return htmlComments(src);
  return scanJs(src, mode);
}

function scanJs(src, mode = "js") {
  const css = mode === "css";
  const out = [];
  let line = 1;
  let i = 0;
  // {kind: "value"|"name"|"punct", text, regexOk?, paren?, brace?, postfix?}
  let last = null;
  const parens = []; // "control" | "call"
  const braces = []; // "block" | "object" | "value-body" (a function or class EXPRESSION)
  // One entry per `function`/`class` keyword still waiting for its body brace, because they
  // NEST: `function (x = function(){}) {}` sets a second while the first is outstanding, and
  // a single slot loses the outer one.
  const pendingBodies = []; // {depth, value}
  // The tokens behind `last`, most recent first. A single previous NAME is not enough: a
  // declaration can wear a run of modifiers (`export async function`), and what decides it
  // is the token before all of them.
  const history = [];
  const setLast = (tok) => {
    if (last) history.unshift(last);
    if (history.length > 8) history.pop();
    last = tok;
    return tok;
  };
  const tpl = []; // the brace-stack depth each open `${` returns to
  let angles = 0; // open TypeScript type-argument lists
  let typeParams = false; // whether the open run is a declaration's parameters
  let angleDepth = 0; // the bracket depth the open run started at
  /**
   * The open decorator run, or null.
   *
   * A decorator is transparent to declaration-versus-expression, and it is neither one
   * token nor one shape: `@sealed` ends on a name, `@a.b` on a dotted one, `@dec(…)` on a
   * `)`, and what it decorates comes after. So the run has two phases — reading its own
   * EXPRESSION, then waiting for its TARGET — and it carries the bracket depth it opened
   * at, which is what keeps its arguments out of the decision. Held as a single token, a
   * `{` in `@dec({ x: 1 })` ended the run and a `class` in `@dec(class X {} / 2)` consumed
   * it, and a member's own decorator was consumed by the class EXPRESSION its initialiser
   * held.
   */
  let decorator = null; // {from, depth, phase: "expr"|"target", seen}
  // Type arguments are a bracket too: `@dec<string>()` puts a run between the decorator's
  // name and its call, and counted at the same depth the `string` inside it was read as the
  // decorated thing and ended the run. That is the whole of what the decorator needs from
  // them — the `<` itself may leave the expression phase, since what follows at the run's
  // own depth is still the target.
  const bracketDepth = () => braces.length + parens.length + angles;
  /** The token in front of a declaration's whole modifier run, which is what decides it. */
  const beforeModifiers = () => {
    const chain = [last, ...history];
    let k = 0;
    while (k < chain.length && chain[k]?.kind === "name" && !chain[k].property && MODIFIERS.has(chain[k].text)) k++;
    return chain[k] ?? null;
  };
  let gapSpaced = false; // whitespace has been seen since the last significant token
  let gapCommented = false; // …and a comment has been seen since it too

  // The span carries its SOURCE RANGE, not only its line: two comments on one line are two
  // comments, and a key of line-plus-text folded them into one — under which a file at a
  // ceiling of 1 took a second copy of the same comment without going over.
  const push = (startLine, text, start, end) => {
    text.split("\n").forEach((t, n) => out.push({ line: startLine + n, text: t, start, end }));
  };
  const value = () => setLast({ kind: "value", text: "" });
  const punct = (text, extra = {}) => setLast({ kind: "punct", text, ...extra });
  const afterDot = () => last?.kind === "punct" && last.text === ".";
  /** True where the grammar would be looking for an expression, so a `/` opens a pattern. */
  const regexAllowed = () => {
    if (!last) return true;
    if (last.kind === "value") return false;
    if (last.kind === "name") return last.regexOk;
    const t = last.text;
    if (t === ")") return last.paren === "control";
    if (t === "}") return last.brace === "block"; // "object" and "value-body" end a value
    if (t === "]") return false;
    if (t === "++" || t === "--" || t === "!") return !last.postfix;
    return true;
  };
  /** Whether the token just read ends a value, which is what makes a `++` postfix. */
  const endsValue = () => {
    if (!last) return false;
    if (last.kind === "value") return true;
    if (last.kind === "name") return !last.regexOk;
    if (last.text === "}") return last.brace !== "block";
    if (last.text === "!") return last.postfix === true;
    return last.text === ")" || last.text === "]";
  };
  /** True where a STATEMENT could begin, which is what separates a function declaration
   *  from a function expression. */
  /** True where a STATEMENT could begin after `tok`, which is what separates a function
   *  declaration from a function expression. */
  const startsStatement = (tok) => {
    if (!tok) return true;
    if (tok.kind === "name") return tok.text === "else" || tok.text === "do";
    if (tok.kind === "value") return false;
    const t = tok.text;
    // A `case 1:` label ends with a colon and what follows it is a statement, so a
    // `function` there is a DECLARATION. Read as an expression, its body brace became a
    // value and the `/` after it divided into a pattern that swallowed the line.
    return t === ";" || t === "{" || t === ":" || (t === "}" && tok.brace === "block");
  };
  const braceKind = () => {
    if (!last) return "block";
    if (last.kind === "name") return OBJECT_AFTER.has(last.text) ? "object" : "block";
    if (last.kind === "value") return "object";
    const t = last.text;
    if (t === ">" && last.typeParams) return "block";
    return t === ")" || t === "]" || t === "}" || t === ";" || t === "{" || t === "=>" ? "block" : "object";
  };

  /** Consume a quoted string starting at `i`, which is its opening quote. */
  const quoted = (q) => {
    i++;
    while (i < src.length && src[i] !== q) {
      // A line continuation is a backslash and a NEWLINE, and skipping the pair without
      // counting it reports every finding below by one line too few.
      if (src[i] === "\\") {
        if (src[i + 1] === "\n") line++;
        i++;
      } else if (src[i] === "\n") line++;
      i++;
    }
    i++;
  };
  /** Consume a template literal from its opening backtick, or from the `}` that resumed it,
   *  stopping at a `${`. Returns whether an interpolation opened. */
  const template = () => {
    i++;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") {
        if (src[i + 1] === "\n") line++;
        i += 2;
        continue;
      }
      if (c === "\n") line++;
      if (c === "`") {
        i++;
        return false;
      }
      if (c === "$" && src[i + 1] === "{") {
        i += 2;
        return true;
      }
      i++;
    }
    return false;
  };

  while (i < src.length) {
    const c = src[i];
    // Whether the gap since the previous significant token began with whitespace. A block
    // comment is trivia and a type argument list may sit behind one — Prettier writes
    // `f/* c */ <string>` and normalises every comparison to `a /* c */ < b`, so what
    // separates them is the space BEFORE the comment, not the one after it. Read off the
    // raw character in front of the `<`, the first was a comparison and the second a type
    // argument list, each the opposite of what it is.
    const tight = !gapSpaced;
    const trivia = /\s/.test(c) || src.startsWith("//", i) || src.startsWith("/*", i);
    if (!trivia) {
      gapSpaced = false;
      gapCommented = false;
    } else if (!/\s/.test(c)) {
      gapCommented = true;
    } else if (!gapCommented) {
      gapSpaced = true;
    }
    // Where the decorator's own expression ends. It is a name, optionally dotted, optionally
    // called — so a second name at the run's depth, or anything that is not part of that
    // shape, is the TARGET rather than more of the decorator. The call's arguments are
    // deeper and never reach this.
    if (!trivia && decorator?.phase === "expr" && decorator.depth === bracketDepth() && c !== "@") {
      if (c === ".") decorator.seen = 0;
      else if (c === "(" && decorator.seen === 1) {
        // The arguments; the `)` that returns to this depth ends the expression.
      } else if (isIdStart(c)) {
        if (decorator.seen === 0) decorator.seen = 1;
        else decorator.phase = "target";
      } else decorator.phase = "target";
    }
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (!css && two === "//") {
      const nl = src.indexOf("\n", i);
      const stop = nl === -1 ? src.length : nl;
      push(line, src.slice(i + 2, stop), i, stop);
      i = stop;
      continue;
    }
    if (two === "/*") {
      const close = src.indexOf("*/", i + 2);
      const stop = close === -1 ? src.length : close;
      push(line, src.slice(i + 2, stop), i, stop + 2);
      line += (src.slice(i, stop).match(/\n/g) ?? []).length;
      i = stop + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      quoted(c);
      value();
      continue;
    }
    if (!css && c === "`") {
      const opened = template();
      if (opened) tpl.push(braces.length);
      // Inside `${` the grammar is at an EXPRESSION start, so a regex may open there; only
      // a literal that CLOSED leaves a value behind.
      if (opened) punct("${");
      else value();
      continue;
    }
    if (isIdStart(c)) {
      let j = i;
      while (j < src.length && isIdPart(src[j])) j++;
      const text = src.slice(i, j);
      // A private member is `#name`, and its name is no more a keyword than `obj.catch` is:
      // read as one, `#catch(x)` heads a control structure and its `)` starts an expression.
      const property = afterDot() || (last?.kind === "punct" && last.text === "#");
      // `property` outlives the regex question: `obj.catch(x)` is a call, and reading its
      // `catch` as the control keyword makes the `)` start an expression.
      // The TARGET of a decorator run. A modifier keeps it waiting and a body-carrying
      // keyword consumes it; anything else is a member, and the run ends there rather than
      // outliving it — `@dec field = class Inner {}` had the class EXPRESSION consume it.
      if (decorator?.phase === "target" && decorator.depth === bracketDepth() && !property) {
        const keeps = MODIFIERS.has(text) || text === "function" || text === "class" || text === "interface";
        if (!keeps) decorator = null;
      }
      if ((text === "function" || text === "class" || text === "interface") && !property) {
        // Walk back over the modifier run — `export`, `default`, `async` — because what
        // separates a declaration from an expression is the token BEFORE all of them.
        // Reading only the one immediately behind made `export function` an expression and
        // `= async function` a declaration, each the opposite of what it is.
        // The run starts at the token immediately before the keyword, which is `last` —
        // `history` begins one further back. Walked from `history` alone, the token right
        // in front was never looked at, so `case 1: function g() {}` was decided by the `1`
        // rather than by the label's colon and read as an expression.
        // A DECORATOR is transparent to that decision, and it is not one token: `@sealed`
        // ends on a name and `@dec(1)` on a `)`, so the walk cannot step back over one.
        // What decides the declaration is the token in front of the whole run, recorded
        // when it opened — without it, `@sealed class C<T> {}` was decided by `sealed` and
        // read as an expression.
        // The PHASE is what says the arguments are not the target — a `class` inside them is
        // read at a depth the run's transitions never reach, so it never leaves "expr".
        const decorated = decorator?.phase === "target";
        const from = decorated ? decorator.from : beforeModifiers();
        if (decorated) decorator = null;
        pendingBodies.push({ depth: parens.length, value: !startsStatement(from) });
      }
      setLast({ kind: "name", text, property, regexOk: !property && REGEX_AFTER.has(text) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9a-fA-FxXoObBnEe._]/.test(src[j])) j++;
      i = j;
      value();
      continue;
    }
    if (!css && c === "/") {
      if (regexAllowed()) {
        let j = i + 1;
        let cls = false;
        while (j < src.length && src[j] !== "\n") {
          if (src[j] === "\\") j++;
          else if (src[j] === "[") cls = true;
          else if (src[j] === "]") cls = false;
          else if (src[j] === "/" && !cls) break;
          j++;
        }
        if (src[j] === "/") {
          i = j + 1;
          while (i < src.length && isIdPart(src[i])) i++; // flags
          value();
          continue;
        }
      }
      punct("/");
      i++;
      continue;
    }
    // A `!` after a value is TypeScript's non-null assertion and leaves a value behind, so
    // the `/` after it divides. Read as an ordinary punctuator it allowed a pattern, which
    // swallowed the rest of the line and the comment on it. `!=` and a prefix `!` are not
    // that: the first is an operator and the second wants an expression after it.
    if (c === "!" && src[i + 1] !== "=" && endsValue()) {
      punct("!", { postfix: true });
      i++;
      continue;
    }
    if (c === "(") {
      // `for await (…)` heads a control structure just as `for (…)` does, so the `await`
      // between them is transparent — read as the head it made the `)` end a value.
      const head =
        last?.kind === "name" && !last.property
          ? last.text === "await" && history[0]?.kind === "name" && history[0].text === "for"
            ? "for"
            : last.text
          : "";
      parens.push(CONTROL_HEADS.has(head) ? "control" : "call");
      punct("(");
      i++;
      continue;
    }
    if (c === ")") {
      punct(")", { paren: parens.pop() ?? "call" });
      i++;
      continue;
    }
    if (c === "{") {
      let kind = braceKind();
      // Only a brace in BLOCK position is a body: a TypeScript return type sits at the same
      // paren depth (`function (): { x: number } { … }`) and would otherwise take the flag,
      // leaving the real body to be read as a block.
      const pending = pendingBodies[pendingBodies.length - 1];
      // …and a brace right after `=>` is an arrow's body or a function TYPE's, never a
      // declaration's. Inside `function<T extends () => {}>()` it took the flag the real
      // body was waiting for, and the `/` after that body then opened a pattern.
      if (pending && pending.depth === parens.length && kind === "block" && last?.text !== "=>") {
        if (pending.value) kind = "value-body";
        pendingBodies.pop();
      }
      braces.push(kind);
      punct("{");
      i++;
      continue;
    }
    if (c === "}") {
      if (tpl.length && tpl[tpl.length - 1] === braces.length) {
        tpl.pop();
        i--; // template() steps past one character, and this `}` is it
        const opened = template();
        if (opened) tpl.push(braces.length);
        if (opened) punct("${");
        else value();
        continue;
      }
      punct("}", { brace: braces.pop() ?? "block" });
      i++;
      continue;
    }
    if (two === "++" || two === "--") {
      punct(two, { postfix: endsValue() });
      i += 2;
      continue;
    }
    if (two === "=>") {
      punct("=>");
      i += 2;
      continue;
    }
    // TypeScript type arguments. `f<string> / 2` divides an instantiation expression, while
    // `a < b > /re/.test(c)` compares and then matches — one grammar cannot tell them apart,
    // and what separates them in FORMATTED text is the space: Prettier writes every
    // comparison as `a < b` and every type argument list tight against its name (measured
    // both ways, and `format` is one of the four checks a merge waits for). So a `<` counts
    // only where it touches the name in front of it. Read as an operator, the `>` left the
    // grammar expecting an expression and the `/` after it opened a pattern that swallowed
    // the line.
    // Inside a type there is no comparison for a `<` to be, so a nested generic signature
    // opens whatever sits in front of it: `f<new <U>() => U>` and `T extends <U>() => U`
    // both put one after a space, and unread its `>` closed the run around it.
    if (c === "<" && (angles > 0 || (tight && endsValue()))) {
      // A DECLARATION's type parameters are not an instantiation expression: what follows
      // `class C<T>` is the body, and closing the run on a value made that brace an object
      // literal — after which the `}` ended a value and the pattern on the next line was
      // read as a division that walked into it.
      if (angles === 0) {
        const pending = pendingBodies[pendingBodies.length - 1];
        typeParams = Boolean(pending && pending.depth === parens.length);
        angleDepth = braces.length + parens.length;
      }
      angles++;
      punct("<");
      i++;
      continue;
    }
    if (c === ">" && angles > 0) {
      angles--;
      if (angles > 0) punct(">");
      else if (typeParams) punct(">", { typeParams: true });
      else value();
      i++;
      continue;
    }
    if (c === "@") {
      if (decorator === null) {
        const from = beforeModifiers();
        if (startsStatement(from)) decorator = { from, depth: bracketDepth(), phase: "expr", seen: 0 };
      } else if (decorator.depth === bracketDepth()) {
        // Another decorator on the same target.
        decorator.phase = "expr";
        decorator.seen = 0;
      }
      punct("@");
      i++;
      continue;
    }
    // A `<` that opened nothing must not poison the rest of the file: a statement boundary
    // ends any run that never closed. Nor may a body that never arrived — an ambient
    // `declare function f(): T;` pushes one and no brace ever consumes it, and the next type
    // argument list then read itself as that declaration's parameters.
    // …and the boundary is the one at the run's OWN depth. A type literal separates its
    // properties with `;` too — `f<{ a: string; b: number }>` — and reset there, the outer
    // run was lost half way through and the `/` after its `>` opened a pattern.
    if (c === ";" && (angles === 0 || braces.length + parens.length === angleDepth)) {
      angles = 0;
      if (decorator && decorator.depth >= bracketDepth()) decorator = null;
      while (pendingBodies.length && pendingBodies[pendingBodies.length - 1].depth >= parens.length)
        pendingBodies.pop();
    }
    punct(c);
    i++;
  }
  return out;
}

/**
 * Comment spans of a Rust file.
 *
 * Three things separate it from the JavaScript reader, each of which loses comments when
 * borrowed from there: block comments NEST, so the first `*&#47;` does not necessarily close
 * one; a raw string is `r`, any number of `#`, a quote, and closes only on a quote followed
 * by the same number of hashes; and `'` is a LIFETIME unless it is a complete character
 * literal, so a quote scanner runs to the next apostrophe and swallows whatever lies
 * between. There is no regex literal, so none of the goal state is needed.
 */
export function rustComments(src) {
  const out = [];
  let line = 1;
  let i = 0;
  const push = (startLine, text) => {
    text.split("\n").forEach((t, n) => out.push({ line: startLine + n, text: t }));
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (src.startsWith("//", i)) {
      const nl = src.indexOf("\n", i);
      const stop = nl === -1 ? src.length : nl;
      push(line, src.slice(i + 2, stop));
      i = stop;
      continue;
    }
    if (src.startsWith("/*", i)) {
      let j = i + 2;
      let depth = 1;
      while (j < src.length && depth > 0) {
        if (src.startsWith("/*", j)) {
          depth++;
          j += 2;
        } else if (src.startsWith("*/", j)) {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      const body = src.slice(i + 2, Math.max(i + 2, j - 2));
      push(line, body);
      line += (src.slice(i, j).match(/\n/g) ?? []).length;
      i = j;
      continue;
    }
    // A raw string: r, br, then hashes, then the quote. It closes on a quote followed by
    // the same number of hashes, and nothing inside it escapes.
    // The delimiter is scanned to its quote rather than inside a fixed window: rustc takes
    // up to 255 hashes, and a 16-character slice stops reading at 15.
    const raw = /^b?r(#*)"/.exec(src.slice(i, i + 264));
    if (raw) {
      const close = '"' + raw[1];
      const from = i + raw[0].length;
      const end = src.indexOf(close, from);
      const stop = end === -1 ? src.length : end + close.length;
      line += (src.slice(i, stop).match(/\n/g) ?? []).length;
      i = stop;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        // The same line continuation the JavaScript reader counts: `\` and a NEWLINE.
        if (src[i] === "\\") {
          if (src[i + 1] === "\n") line++;
          i++;
        } else if (src[i] === "\n") line++;
        i++;
      }
      i++;
      continue;
    }
    if (c === "'") {
      // A character literal is `'x'`, `'\n'` or `'\u{1F600}'`; anything else beginning with
      // an apostrophe is a lifetime, and consuming it as a quote would swallow the rest.
      const lit = /^'(\\u\{[0-9a-fA-F]{1,6}\}|\\.|[^\\'])'/.exec(src.slice(i, i + 12));
      i += lit ? lit[0].length : 1;
      continue;
    }
    i++;
  }
  return out;
}

/**
 * Comment spans of a YAML file.
 *
 * Line-oriented, because a `#` is a comment only outside YAML's three string forms: a
 * quoted scalar, which MAY span lines; a BLOCK scalar, whose body is every following line
 * indented past the line that opened it; and a plain scalar, where a `#` only opens a
 * comment after whitespace.
 *
 * One block scalar is not data: a workflow's `run:` holds shell source, and its comments
 * are comments. Its body goes to the shell reader with its offsets carried over, so a span
 * found there points at the same characters it would in a `.sh` file.
 */
export function yamlComments(src, actions = false) {
  const out = [];
  const lines = src.split("\n");
  // The absolute offset each line starts at, so a span can name its characters and not only
  // its line — two comments at one line number are two comments.
  const starts = [];
  for (let n = 0, at = 0; n < lines.length; n++) {
    starts.push(at);
    at += lines[n].length + 1;
  }
  // A quoted scalar that did not close on its line: `'` closes on a doubled `''`, `"` on an
  // unescaped `"`. Read one line at a time, a scan that opened one ran off the end and read
  // the NEXT line's `#` as a comment — the line was string content.
  let quote = null;
  // A key whose value is not on its own line: an explicit `? run` waiting for the `: value`
  // written at its column, and an ordinary `run:` with nothing after it, whose value is the
  // next node indented further. Carries the path the key was read at, and the anchor it
  // wears, so the value found later belongs where the key is.
  let pending = null;
  /** A workflow's `run:` written as a QUOTED scalar, handed to the shell reader with its
   *  offsets carried over. GitHub runs the value, not the way it was written. */
  /** The scalars an anchor was put on, by name. A value written once and referred to by
   *  alias is the same value, and the finding points at where its text actually is. */
  const anchors = new Map();
  const lineOf = (offset) => {
    let k = 0;
    while (k + 1 < starts.length && starts[k + 1] <= offset) k++;
    return k + 1;
  };
  /** Hand one decoded value to the shell reader, with its offsets carried over. */
  const readShell = ({ text, map }) => {
    for (const span of shellComments(text)) {
      const start = map[span.start];
      out.push({
        line: lineOf(start),
        text: span.text,
        start,
        end: span.end < map.length ? map[span.end] : map[map.length - 1] + 1,
      });
    }
  };
  const takeValues = (head, n, under, carried, carriedAnchor) => {
    if (!actions) return;
    // What GitHub runs is a STEP's `run`, so what decides an entry is the path to it and not
    // the name of its key alone.
    const runs = (entry) => {
      const key = entry.key ?? carried;
      return key != null && isRunPath([...under, ...entry.within, key]);
    };
    for (const entry of yamlQuotedAll(head)) {
      const isRun = runs(entry);
      // An anchor written in front of the key belongs to the value the key owns, wherever
      // that value is written.
      const anchor = entry.anchor ?? (entry.key === null ? carriedAnchor : null);
      // A value carrying an anchor is decoded wherever it is written: `run: *script` reads it
      // later, and by then the line it was written on is behind us.
      if (!isRun && !anchor) continue;
      const value = decodeQuoted(src, starts[n] + entry.at);
      if (!value) continue;
      if (anchor) anchors.set(anchor, value);
      if (isRun) readShell(value);
    }
    // Aliases after the anchors on the line, since an alias cannot refer forward.
    for (const entry of yamlAliasAll(head)) {
      if (!runs(entry)) continue;
      const held = anchors.get(entry.name);
      if (held) readShell(held);
    }
  };
  // The block-mapping keys open above the line being read, with the column each one starts
  // at, and the path they make to what is written under them.
  const stack = [];
  let under = [];
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    let i = 0;
    if (quote) {
      const close = closeQuote(raw, 0, quote);
      if (close === -1) continue;
      i = close;
      quote = null;
    }
    let prev = i === 0 ? "\n" : "x";
    let comment = -1;
    while (i < raw.length) {
      const c = raw[i];
      if (c === '"' || c === "'") {
        const close = closeQuote(raw, i + 1, c);
        if (close === -1) {
          quote = c;
          i = raw.length;
          break;
        }
        i = close;
        prev = "x";
        continue;
      }
      if (c === "#" && /\s|\n/.test(prev)) {
        comment = i;
        out.push({ line: n + 1, text: raw.slice(i + 1), start: starts[n] + i, end: starts[n] + raw.length });
        break;
      }
      prev = c;
      i++;
    }
    const head = (comment === -1 ? raw : raw.slice(0, comment)).replace(/\s+$/, "");
    // A blank line and a comment-only line are not nodes, so a key still waiting for its
    // value survives them. Cleared on every line that was not itself an explicit key, a
    // comment written between `? run` and its `: |` lost the key.
    if (head.trim() === "") continue;
    const indent = head.length - head.trimStart().length;
    const explicit = yamlExplicitKey(head);
    const block = lineEntries(head).find((e) => e.depth === 0) ?? null;
    const opens = explicit ?? block?.key ?? null;
    // A SEQUENCE entry written with nothing after its dash. Its own node begins somewhere to
    // the right, so nothing to the left of that is unwound — and taken at its indentation,
    // an indentationless sequence's dash sits at the column of the key that owns it and
    // unwound that key, which put its entries at the path of the mapping above.
    const dashes = /^[ \t]*-(?:[ \t]+-)*$/.test(head);
    // The value of a key is not always on the key's own line: an explicit entry writes it
    // behind a `:` at the key's own column, and an ordinary `run:` with nothing after it
    // takes the next node indented further. Either way it is the same key, read at the same
    // path, and a line that opens a key of its own is neither.
    const carries =
      pending !== null && opens === null && (pending.explicit ? indent === pending.col : indent > pending.col);
    // A key is unwound by anything written at its column or to the left of it, and what is
    // left is the path to this line. A line that opens no key of its own — a `: value`, a
    // value on its own line, or a flow collection continued across lines — pushes nothing.
    const col =
      explicit !== null ? /^[ \t]*(?:-[ \t]+)*/.exec(head)[0].length : dashes ? head.length : (block?.col ?? indent);
    while (stack.length && stack[stack.length - 1].col >= col) stack.pop();
    under = stack.map((s) => s.key);
    if (opens !== null) stack.push({ col, key: opens });
    // The path this line's value sits at, and the key it belongs to where that key is on an
    // earlier line.
    const path = carries ? pending.under : under;
    const carried = carries ? pending.key : null;
    const held = carries ? pending.anchor : null;
    // The column an indentation indicator counts from is the OWNING node's, which for a
    // value on its own line is the key's, on the line above.
    const owner = carries ? pending.col : undefined;
    if (quote) {
      // The value of a `run:` written as a quoted scalar that spans lines starts here, and
      // the lines it covers are skipped above — so the handoff has to happen before them.
      takeValues(head, n, path, carried, held);
      continue;
    }
    if (explicit !== null) {
      pending = { key: explicit, under, col, explicit: true, anchor: null };
      continue;
    }
    // The header is the line's VALUE, so the indicator has to sit right after `key:` or a
    // `-` sequence entry. Its two indicators come in EITHER order (`|2-` and `|-2` are one
    // scalar each), and reading only chomping-then-digit left `|2-` a plain scalar whose
    // body was then read as lines of YAML.
    // An anchor or a tag may sit between the `:` and the indicator — `run: &script |` is a
    // block scalar, and read as a plain one its body was scanned as YAML, where the `#`
    // lines of a here-document inside it are comments.
    // A value on its own line carries no key and no dash in front of the indicator, and the
    // column its indentation indicator counts from is the key's, on the line above.
    const m =
      /(?::|(?:^|\s)-)[ \t]*(?:[&!]\S+[ \t]+)*[|>](?:[1-9][-+]?|[-+][1-9]?)?$/.exec(head) ??
      (carries ? /^[ \t]*(?:[&!]\S+[ \t]+)*[|>](?:[1-9][-+]?|[-+][1-9]?)?$/.exec(head) : null);
    // A key whose line ends after its colon — or after the properties behind it — owns the
    // node on the next line, not nothing.
    pending =
      !m && block !== null && /^(?:[&!]\S+[ \t]*)*$/.test(head.slice(block.at))
        ? { key: block.key, under, col: block.col, explicit: false, anchor: anchorName(head.slice(block.at)) }
        : null;
    if (!m) {
      takeValues(head, n, path, carried, held);
      continue;
    }
    // What the block ends at is the column of the node it belongs to, which for a header
    // written on the key's own line is that line's indentation. A header on a line of its
    // OWN can sit at the body's indentation instead, and measured against itself such a
    // block had no body at all and was never read.
    const stop = carries ? owner : indent;
    let end = n + 1;
    while (end < lines.length) {
      const body = lines[end];
      // A blank line stays inside the block; anything indented no further than the node the
      // block belongs to ends it.
      if (body.trim() !== "" && body.length - body.trimStart().length <= stop) break;
      end++;
    }
    const blockAnchor = anchorName(m[0]) ?? held;
    const blockKey = yamlKey(head) ?? carried;
    const blockRuns = blockKey != null && isRunPath([...path, blockKey]);
    if (actions && (blockRuns || blockAnchor) && end > n + 1) {
      // What the shell is handed is the block's VALUE, which is these lines with their
      // common indentation removed — the indentation indicator's if it has one, and the
      // first non-empty line's otherwise. Handed the raw lines instead, a here-document's
      // `EOF` never equalled its indented delimiter line, so the scan swallowed the rest of
      // the block as body and every comment after it went unread.
      // Each character's offset in the source comes back with it, so a span found in the
      // value points at the characters it came from.
      const built = blockValue(head, lines.slice(n + 1, end), owner);
      const value = built.text;
      const at = built.from.map(([li, col]) =>
        col < 0 ? starts[n + 1 + li] + lines[n + 1 + li].length : starts[n + 1 + li] + col,
      );
      if (blockAnchor) anchors.set(blockAnchor, { text: value, map: at });
      if (blockRuns) readShell({ text: value, map: at });
    }
    n = end - 1;
  }
  // One source range is ONE comment, however many aliases read the value it is in: the text
  // is written once, and counted per reference the ledger would grow with every `*script`.
  const seen = new Set();
  return out
    .sort((a, b) => a.start - b.start)
    .filter((span) => {
      const key = span.start + "\u0000" + span.end + "\u0000" + span.line;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** What a `\`-escape stands for in a YAML double-quoted scalar, beside the numeric forms. */
const YAML_ESCAPES = {
  0: "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  N: "\u0085",
  _: "\u00a0",
  L: "\u2028",
  P: "\u2029",
};

/**
 * The mapping key a block scalar is the value of, plain or quoted, or null for a scalar
 * that is a sequence entry rather than a mapping value.
 *
 * A quoted key is the SAME key: `"run": |` is what GitHub reads as `run`, and matched as a
 * plain scalar only, that block was left as text. The escapes of a double-quoted scalar are
 * decoded, so a key spelled `"r\u0075n"` is not a way round the reader either.
 */
export function yamlKey(head) {
  const m = new RegExp(KEY_SOURCE + PROPERTY_SOURCE + "[|>]").exec(head);
  return m ? scalarText(m) : null;
}

/** The anchors and tags a node may wear in front of its value, captured as one run so the
 *  ANCHOR name in it can be read back: a value written once and referred to by alias is the
 *  same value, and `run: *script` is the shell its anchor holds. */
const PROPERTY_SOURCE = "((?:[&!]\\S+[ \\t]+)*)";
/** The anchor name in such a run, or null. */
const anchorName = (properties) => /&([^\s&!]+)/.exec(properties ?? "")?.[1] ?? null;

/** The three shapes a mapping key is written in, and the run of spaces after its colon. */
const KEY_SOURCE = "(?:^|[\\s\\-{[,])(?:\"((?:[^\"\\\\]|\\\\.)*)\"|'((?:[^']|'')*)'|([\\w.-]+))[ \\t]*:[ \\t]*";

/**
 * A mapping entry whose value is a QUOTED scalar: its key, and where the opening quote is.
 *
 * A workflow's `run: "echo ok # why"` is the same shell as the block form — GitHub runs the
 * VALUE — and read as a YAML string it was skipped whole, so the only `run:` bodies this
 * looked at were the ones written with `|`.
 */
export function yamlQuoted(head) {
  return yamlQuotedAll(head)[0] ?? null;
}

/**
 * EVERY mapping entry on one line: its key, the column that key starts at, the keys of the
 * flow collections it sits inside, where its value begins, and the anchor it wears.
 *
 * The line is read once, with quoted scalars skipped whole, so a `key:` written in a string
 * is not an entry. A FLOW collection puts what is written in it on the line its own key is
 * on — `steps: [{ run: "…" }]` is a step's `run` — so the keys it was opened under belong
 * to the path of each entry inside it, and an anonymous `[` or `{` contributes none.
 */
export function lineEntries(head) {
  const found = [];
  const scope = [];
  let pending = null;
  const re = new RegExp(KEY_SOURCE + PROPERTY_SOURCE + "|([\"'])|([{\\[])|([}\\]])", "g");
  for (let m; (m = re.exec(head));) {
    if (m[5] !== undefined) {
      // A scalar that does not close on this line runs into the next, so nothing written
      // after it here is on this line at all.
      const value = decodeQuoted(head, m.index);
      if (!value) break;
      re.lastIndex = value.end;
      continue;
    }
    if (m[6] !== undefined || m[7] !== undefined) {
      if (m[6] !== undefined) scope.push(pending);
      else scope.pop();
      pending = null;
      continue;
    }
    const raw = m[1] !== undefined ? '"' + m[1] + '"' : m[2] !== undefined ? "'" + m[2] + "'" : m[3];
    const key = scalarText(m);
    found.push({
      key,
      col: head.startsWith(raw, m.index) ? m.index : m.index + 1,
      depth: scope.length,
      within: scope.filter((k) => k !== null),
      at: m.index + m[0].length,
      anchor: anchorName(m[4]),
    });
    pending = key;
  }
  return found;
}

/**
 * EVERY mapping entry on the line whose value is a quoted scalar.
 *
 * A FLOW mapping puts several on one — `steps: [{ name: "x", run: "…" }]` — and read as the
 * first one only, a `run` behind any other key was never looked at. The node property a
 * block scalar may wear is allowed in front of each: `run: &script "…"` is the same value.
 */
export function yamlQuotedAll(head) {
  const found = lineEntries(head).filter((e) => head[e.at] === '"' || head[e.at] === "'");
  if (found.length) return found;
  // A value line has no key on it; the key was written on an earlier one. An EXPLICIT entry
  // writes a `:` in front of it and an ordinary key writes nothing at all, so the marker is
  // optional — which key it belongs to is the caller's to know, and an entry with none is
  // dropped there.
  const bare = new RegExp("^[ \\t]*(?:-[ \\t]+)*(?::[ \\t]*)?" + PROPERTY_SOURCE + "([\"'])").exec(head);
  return bare ? [{ key: null, at: bare[0].length - 1, within: [], anchor: anchorName(bare[1]) }] : [];
}

/** The characters an anchor name is made of: everything but whitespace and the flow
 *  indicators that end a node written inside a `[` or a `{`. */
const ALIAS_NAME = /\*([^\s,[\]{}]+)/y;

/**
 * EVERY mapping entry on the line whose value is an ALIAS — `run: *script`, which is the
 * value its anchor holds. GitHub Actions supports anchors, and read as neither a block nor
 * a quoted scalar the shell behind one was never looked at.
 *
 * A flow mapping ends the name with `,`, `]` or `}` rather than with the line, so matched
 * to the end of the line instead, `steps: [{ run: *script }]` was no alias at all.
 */
export function yamlAliasAll(head) {
  const found = [];
  for (const entry of lineEntries(head)) {
    ALIAS_NAME.lastIndex = entry.at;
    const m = ALIAS_NAME.exec(head);
    if (m) found.push({ key: entry.key, within: entry.within, name: m[1] });
  }
  if (found.length) return found;
  const bare = new RegExp("^[ \\t]*(?:-[ \\t]+)*(?::[ \\t]*)?" + PROPERTY_SOURCE + "\\*([^\\s,[\\]{}]+)").exec(head);
  return bare ? [{ key: null, within: [], name: bare[2] }] : [];
}

/** Where GitHub Actions RUNS a value as shell: a step of a workflow's job, and a step of a
 *  composite action. Decided by the key's NAME alone, an environment variable or an action
 *  input that happens to be called `run` was lexed against a grammar it is not written in. */
const ANY_JOB = Symbol("any job");
const RUN_PATHS = [
  ["jobs", ANY_JOB, "steps", "run"],
  ["runs", "steps", "run"],
];
const isRunPath = (path) =>
  RUN_PATHS.some((want) => want.length === path.length && want.every((seg, k) => seg === ANY_JOB || seg === path[k]));

/**
 * The VALUE of a quoted scalar whose opening quote is at `at`, with each character's offset
 * in the source, so a span found in it points at the characters it came from.
 *
 * A newline inside one FOLDS to a single space, with the indentation after it dropped, which
 * is what YAML hands its consumer — and what the shell would be given to run.
 */
/** How many characters the line break at `k` takes, or 0 if there is none. */
const lineBreak = (src, k) => (src[k] === "\r" ? (src[k + 1] === "\n" ? 2 : 1) : src[k] === "\n" ? 1 : 0);

export function decodeQuoted(src, at) {
  const q = src[at];
  const text = [];
  const map = [];
  let i = at + 1;
  while (i < src.length) {
    if (src[i] === q) {
      if (q === "'" && src[i + 1] === "'") {
        text.push("'");
        map.push(i);
        i += 2;
        continue;
      }
      return { text: text.join(""), map, end: i + 1 };
    }
    // A run of line breaks FOLDS: one becomes a space, n of them become n-1 newlines, and
    // the whitespace on either side is dropped. A `\` immediately in front of the first one
    // ESCAPES it in a double-quoted scalar, and the run then yields n-1 newlines and no
    // space — nor is the whitespace before the `\` dropped. Turned into a single space
    // whatever it was, an escaped break lost a comment that continued past it and a blank
    // line invented one that had ended at it. Measured against Ruby's YAML.
    // A line break is `\n`, `\r\n` or `\r`. Matched as `\n` alone, a CRLF file's escaped
    // break was read as an escaped `\r` followed by an ordinary fold, so the value carried
    // a carriage return and a space where the source had joined two halves of one word.
    const escaped = q === '"' && src[i] === "\\" && lineBreak(src, i + 1) > 0;
    if (escaped || lineBreak(src, i) > 0) {
      if (!escaped) {
        while (text.length && (text[text.length - 1] === " " || text[text.length - 1] === "\t")) {
          text.pop();
          map.pop();
        }
      }
      let j = escaped ? i + 1 : i;
      let breaks = 0;
      for (;;) {
        const width = lineBreak(src, j);
        if (!width) break;
        breaks++;
        j += width;
        while (j < src.length && (src[j] === " " || src[j] === "\t")) j++;
      }
      if (!escaped && breaks === 1) {
        text.push(" ");
        map.push(i);
      } else {
        for (let k = 1; k < breaks; k++) {
          text.push("\n");
          map.push(i);
        }
      }
      i = j;
      continue;
    }
    if (q === '"' && src[i] === "\\") {
      const e = /^(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[\s\S])/.exec(src.slice(i + 1));
      if (!e) return null;
      const ch = /^[xuU]/.test(e[1]) ? String.fromCodePoint(parseInt(e[1].slice(1), 16)) : (YAML_ESCAPES[e[1]] ?? e[1]);
      text.push(ch);
      map.push(i);
      i += 1 + e[1].length;
      continue;
    }
    text.push(src[i]);
    map.push(i);
    i++;
  }
  return null;
}

/**
 * The key of an EXPLICIT mapping entry — `? run` on its own line, with the `: |` that
 * carries its value on a later one.
 *
 * The same key written the other way round, and read only where the two sit on one line, a
 * workflow's `run` block written this way was left as text.
 */
export function yamlExplicitKey(head) {
  const m = /^[ \t]*(?:-[ \t]+)*\?[ \t]+(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([\w.-]+))[ \t]*$/.exec(head);
  return m ? scalarText(m) : null;
}

/** The three capture groups every key match uses, decoded: double-quoted, single-quoted,
 *  plain. A double-quoted scalar's escapes are decoded, so an encoded spelling of a key is
 *  not a way round the reader. */
function scalarText(m) {
  if (m[3] !== undefined) return m[3];
  if (m[2] !== undefined) return m[2].replace(/''/g, "'");
  return m[1].replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[\s\S])/g, (_, e) =>
    /^[xuU]/.test(e) ? String.fromCodePoint(parseInt(e.slice(1), 16)) : (YAML_ESCAPES[e] ?? e),
  );
}

/**
 * How many columns YAML removes from a block scalar's body, which is what makes the value
 * the value rather than the lines it was written on.
 *
 * Without an indentation indicator it is the first non-empty line's own indentation. WITH
 * one, the count is from the column of the node the scalar BELONGS TO, and that is not the
 * header line's indentation: for `- run: |2` it is the key's column, and for a bare `- |2`
 * it is the sequence entry's dash. Measured against Ruby's YAML, which the differential at
 * the foot of the pins re-measures rather than trusting this comment.
 */
export function blockStrip(head, body, owner) {
  const digit = /[|>][-+]?([1-9])|[|>]([1-9])[-+]?/.exec(head);
  const columns = digit ? Number(digit[1] ?? digit[2]) : 0;
  if (!columns) {
    const first = body.find((l) => l.trim() !== "") ?? "";
    return first.length - first.trimStart().length;
  }
  if (owner !== undefined) return owner + columns;
  const lead = /^(\s*)((?:-\s+)*)/.exec(head);
  const rest = lead[1].length + lead[2].length;
  const entry = lead[2] !== "" && /^(?:[&!]\S+[ \t]+)*[|>]/.test(head.slice(rest));
  return (entry ? lead[1].length + lead[2].lastIndexOf("-") : rest) + columns;
}

/**
 * The VALUE of a block scalar, and where each of its characters came from.
 *
 * A `>` block FOLDS its line breaks and a `|` block keeps them, which is the whole
 * difference between the two headers. Read as a literal, `>` split a sentence written across
 * two lines and the comment on it went unmatched. What a fold keeps literal: an empty line,
 * and a line indented FURTHER than the block. Measured against Ruby's YAML.
 *
 * `from[i]` is `[lineIndex, column]` into `body`, or `[lineIndex, -1]` for a break emitted
 * after that line.
 */
export function blockValue(head, body, owner) {
  const strip = blockStrip(head, body, owner);
  const folded = /([|>])(?:[1-9][-+]?|[-+][1-9]?)?$/.exec(head)?.[1] === ">";
  const text = [];
  const from = [];
  let blanks = 0;
  let started = false;
  let deeper = false;
  for (let k = 0; k < body.length; k++) {
    const line = body[k];
    const at = Math.min(strip, line.length);
    const content = line.slice(at);
    if (!folded) {
      for (let col = at; col < line.length; col++) {
        text.push(line[col]);
        from.push([k, col]);
      }
      text.push("\n");
      from.push([k, -1]);
      continue;
    }
    if (content.trim() === "") {
      blanks++;
      continue;
    }
    const more = /^[ \t]/.test(content);
    if (started) {
      const breaks = blanks > 0 || more || deeper ? Math.max(blanks, 1) : 0;
      for (let z = 0; z < breaks; z++) {
        text.push("\n");
        from.push([k - 1, -1]);
      }
      if (breaks === 0) {
        text.push(" ");
        from.push([k - 1, -1]);
      }
    }
    for (let col = at; col < line.length; col++) {
      text.push(line[col]);
      from.push([k, col]);
    }
    started = true;
    deeper = more;
    blanks = 0;
  }
  // The trailing break a block carries. Chomping decides how many, and no comment's extent
  // turns on that — a comment ends at a break or at the end of the value either way.
  if (folded && started) {
    text.push("\n");
    from.push([body.length - 1, -1]);
  }
  return { text: text.join(""), from };
}

/** The index just past the closing `q` at or after `from`, or -1 if the line does not close it. */
function closeQuote(line, from, q) {
  let i = from;
  while (i < line.length) {
    if (q === '"' && line[i] === "\\") {
      i += 2;
      continue;
    }
    if (line[i] === q) {
      // A single-quoted scalar escapes its quote by DOUBLING it, so `''` inside one is a
      // literal `'` and not the end of the string.
      if (q === "'" && line[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return -1;
}

/**
 * Comment spans of a TOML file.
 *
 * Its comment is YAML's — a `#` outside a string, to the end of the line — and its strings
 * are not: TOML has no block scalar and four string forms, two of which SPAN LINES. Read as
 * YAML, the `#` in a `"""…"""` value was reported as a comment, because a line-oriented
 * scan closes every quote at the newline.
 */
export function tomlComments(src) {
  const out = [];
  let line = 1;
  let i = 0;
  let prev = "\n";
  const count = (text) => (text.match(/\n/g) ?? []).length;
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      line++;
      prev = c;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = src.startsWith(c.repeat(3), i);
      const close = triple ? c.repeat(3) : c;
      let j = i + close.length;
      while (j < src.length) {
        // A literal string (`'`) has no escapes at all, so a backslash in one is a character.
        if (c === '"' && src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src.startsWith(close, j)) {
          // Up to two of the delimiter's own characters may sit INSIDE a multi-line value,
          // and what closes it is the last three of the run. Closed at the first three,
          // `""""quoted""""` left a fourth quote behind that opened a string of its own and
          // swallowed the comment after it; tomllib reads that value as `"quoted"`.
          if (triple) {
            let run = 0;
            while (src[j + run] === c) run++;
            if (run > 3) j += Math.min(run - 3, 2);
          }
          break;
        }
        if (!triple && src[j] === "\n") break;
        j++;
      }
      line += count(src.slice(i, Math.min(j, src.length)));
      i = src.startsWith(close, j) ? j + close.length : j;
      prev = "x";
      continue;
    }
    if (c === "#") {
      const nl = src.indexOf("\n", i);
      const stop = nl === -1 ? src.length : nl;
      out.push({ line, text: src.slice(i + 1, stop), start: i, end: stop });
      i = stop;
      continue;
    }
    prev = c;
    i++;
  }
  return out;
}

/**
 * Comment spans of a Python file.
 *
 * A `#` outside a string literal — and, since PEP 701, inside a multi-line f-string's
 * replacement FIELD, which is Python code the string only looks like it contains. Read as
 * one opaque string, `f"""{ 1  # why \n }"""` carried a comment CPython's own tokenizer
 * reports and this saw nothing at all.
 *
 * The three parts are the f-string body (text, `{{` an escape, `{` a field), the field
 * itself (code, where a comment is legal only when the f-string is triple-quoted — a
 * single-line one cannot hold the newline that would end it), and the format spec after a
 * `:` or a `!` conversion, which is f-string TEXT again: a `#` there is a fill character.
 *
 * A docstring is a string and not a comment, which is the same line every other reader here
 * draws — what the language stores as a value is data. A backslash escapes the quote in a
 * RAW string too (`r"\""` is one string), so the escape is read the same way in both.
 */
export function pyComments(src) {
  const out = [];
  let line = 1;
  let i = 0;

  const comment = () => {
    const nl = src.indexOf("\n", i);
    const stop = nl === -1 ? src.length : nl;
    out.push({ line, text: src.slice(i + 1, stop), start: i, end: stop });
    i = stop;
  };

  /** Whether the letters immediately before `at` are a prefix that gives the string
   *  REPLACEMENT FIELDS — `f`, and since PEP 750 `t` as well, in either case alone or
   *  beside an `r`. Read as an ordinary string, a template string's fields were skipped
   *  whole and the comments CPython reports inside them were never looked at. */
  const fieldPrefix = (at) => {
    let k = at;
    while (k > 0 && /[A-Za-z]/.test(src[k - 1])) k--;
    const pre = src.slice(k, at);
    return pre.length > 0 && pre.length <= 2 && /[ft]/i.test(pre) && !/\w/.test(src[k - 1] ?? " ");
  };

  /** Consume a string whose opening quote is at `i`. `fmt` = its prefix carried an `f`. */
  const string = (fmt) => {
    const q = src[i];
    const triple = src.startsWith(q.repeat(3), i);
    const close = triple ? q.repeat(3) : q;
    i += close.length;
    for (;;) {
      if (i >= src.length) return;
      if (src.startsWith(close, i)) {
        i += close.length;
        return;
      }
      if (src[i] === "\\") {
        if (src[i + 1] === "\n") line++;
        i += 2;
        continue;
      }
      if (src[i] === "\n") {
        if (!triple) return;
        line++;
        i++;
        continue;
      }
      if (fmt && (src[i] === "{" || src[i] === "}") && src[i + 1] === src[i]) {
        i += 2;
        continue;
      }
      if (fmt && src[i] === "{") {
        i++;
        field();
        continue;
      }
      i++;
    }
  };

  /** Consume a replacement field whose `{` has been read.
   *
   *  A comment is legal here only in a MULTI-LINE f-string — a single-line one cannot hold
   *  the newline that would end one — and that condition is not carried, because no valid
   *  program separates the two: reaching a `#` here at all takes a newline to come after it.
   *  A branch nothing can turn red is a branch that says it was tested. */
  const field = () => {
    let depth = 0;
    for (;;) {
      if (i >= src.length) return;
      const c = src[i];
      if (c === "\n") {
        line++;
        i++;
        continue;
      }
      if (c === "#") {
        comment();
        continue;
      }
      if (c === '"' || c === "'") {
        string(fieldPrefix(i));
        continue;
      }
      if (c === "(" || c === "[" || c === "{") {
        depth++;
        i++;
        continue;
      }
      if (c === ")" || c === "]") {
        depth--;
        i++;
        continue;
      }
      if (c === "}") {
        i++;
        if (depth === 0) return;
        depth--;
        continue;
      }
      // A conversion is `!s`, `!r` or `!a`, and what follows it is the FIELD again — a
      // comment may sit between it and the `}`. Read as the start of the format spec, the
      // comment after `{1!s` was scanned as fill text. `!=` is an operator, and so is a `!`
      // before an identifier that merely starts with one of the three letters.
      if (depth === 0 && c === "!" && /[sra]/.test(src[i + 1] ?? "") && !/\w/.test(src[i + 2] ?? "")) {
        i += 2;
        continue;
      }
      // Only a `:` at the field's own depth ends the expression.
      if (depth === 0 && c === ":") {
        i++;
        spec();
        return;
      }
      i++;
    }
  };

  /** The format spec, which is f-string text: a `#` in it is a fill character. */
  const spec = () => {
    for (;;) {
      if (i >= src.length) return;
      const c = src[i];
      if (c === "}") {
        i++;
        return;
      }
      if (c === "\n") {
        line++;
        i++;
        continue;
      }
      if (c === "{") {
        i++;
        field();
        continue;
      }
      i++;
    }
  };

  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === "#") {
      comment();
      continue;
    }
    if (c === '"' || c === "'") {
      string(fieldPrefix(i));
      continue;
    }
    i++;
  }
  return out;
}
/** The reserved words that open a compound list, after which the NEXT word is at a command
 *  position again — on the same line. Restored only by a newline or a control operator,
 *  `if true; then case x in …` never reached `case`, so its arms' `)` closed whatever was
 *  around them. `in` is deliberately absent: it introduces a pattern or a word list, not a
 *  command, and reading `for x in case` as a keyword would plant a marker nothing pops. */
const COMMAND_OPENERS = new Set(["then", "do", "else", "elif", "if", "while", "until", "time"]);

/**
 * Comment spans of a shell script.
 *
 * A `#` opens a comment at a word start. What is not a word start: a single-quoted string,
 * a HERE-DOCUMENT's body, and the middle of a word. Inside a DOUBLE-quoted string a `#` is
 * text — but a `$( … )` within one is code again, and a comment there is a comment.
 *
 * Both halves of a here-document cost a comment each when they are read as one thing. The
 * REST OF THE DECLARATION LINE is still code (`cat <<EOF # why`), and the delimiter is a
 * WORD rather than an identifier: read as `[A-Za-z_]\w*`, `<<END-DATA` looked for a line
 * saying `END`, never found one, and swallowed the file from there to the end.
 */
export function shellComments(src) {
  const out = [];
  let line = 1;
  let i = 0;
  let prev = "\n";
  // `$( … )` and a plain `( … )` subshell both nest, and counting only the first made any
  // `)` close the substitution: `$( (x); # why` left the comment outside it. A BACKTICK
  // substitution is a third frame: its body is code even inside a double quote, which a
  // `$(`-only state read as string text.
  // Each frame carries the state of the command it INTERRUPTS. A `$( … )` is a word in the
  // command around it, and sharing one command position across every frame let an inner `;`
  // leave the outer one open — `$($(printf printf;) case y)` then read the outer `case` as a
  // keyword and the `)` that closed the substitution as its pattern's.
  const stack = []; // {kind: "subst"|"group"|"backtick", cmdStart, timed, cases}
  const dq = []; // the stack depth each open double quote was opened at
  const inDoubleQuote = () => dq.length > 0 && dq[dq.length - 1] === stack.length;
  const pending = []; // here-documents whose bodies start after this line's newline
  // The stack depth each open `case` was read at. Its patterns end on a `)` that never had
  // an opener, and popped unconditionally that `)` closed the substitution around it — so a
  // comment inside a case arm fell outside and was never read.
  const cases = [];
  // Whether a command word could start here, which is what separates the keyword `case`
  // from the argument in `echo case`.
  let cmdStart = true;
  // Whether the word just read was `time`, which is the one reserved word that takes an
  // option before the command it measures.
  let timed = false;
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      line++;
      i++;
      prev = c;
      cmdStart = true;
      timed = false;
      while (pending.length) {
        const { dash, word } = pending.shift();
        for (;;) {
          const nl = src.indexOf("\n", i);
          const stop = nl === -1 ? src.length : nl;
          const text = src.slice(i, stop);
          if ((dash ? text.replace(/^\t+/, "") : text) === word || nl === -1) {
            i = nl === -1 ? src.length : nl + 1;
            if (nl !== -1) line++;
            break;
          }
          line++;
          i = stop + 1;
        }
      }
      continue;
    }
    if (c === "\\") {
      if (src[i + 1] === "\n") line++;
      i += 2;
      prev = "x";
      continue;
    }
    // `<<<` is a here-STRING and takes no body; matched as a here-document it would look for
    // a delimiter line that never comes. Consumed WHOLE, because stepping over one `<` and
    // looking again finds a `<<` in the remaining two.
    if (!inDoubleQuote() && src.startsWith("<<<", i)) {
      i += 3;
      prev = "x";
      continue;
    }
    if (!inDoubleQuote() && src.startsWith("<<", i)) {
      let j = i + 2;
      const dash = src[j] === "-";
      if (dash) j++;
      while (src[j] === " " || src[j] === "\t") j++;
      const word = [];
      while (j < src.length && !/[\s;&|<>()]/.test(src[j])) {
        if (src[j] === "'" || src[j] === '"') {
          const q = src[j++];
          while (j < src.length && src[j] !== q) word.push(src[j++]);
          j++;
          continue;
        }
        if (src[j] === "\\") {
          j++;
          if (j < src.length) word.push(src[j++]);
          continue;
        }
        word.push(src[j++]);
      }
      if (word.length) {
        pending.push({ dash, word: word.join("") });
        i = j;
        prev = "x";
        continue;
      }
    }
    if (c === "'" && !inDoubleQuote()) {
      i++;
      while (i < src.length && src[i] !== "'") {
        if (src[i] === "\n") line++;
        i++;
      }
      i++;
      prev = "x";
      continue;
    }
    if (c === '"') {
      if (inDoubleQuote()) dq.pop();
      else dq.push(stack.length);
      prev = "x";
      i++;
      continue;
    }
    const open = (kind) => {
      stack.push({ kind, cmdStart, timed, cases: cases.length });
      cmdStart = true;
      timed = false;
    };
    // A closed frame leaves a WORD behind in the command it interrupted, so the position it
    // returns to is the one after a word.
    const close = () => {
      const frame = stack.pop();
      cases.length = frame.cases;
      cmdStart = false;
      timed = false;
    };
    if (c === "`") {
      // Backticks do not nest — the inner ones have to be escaped — so one frame toggles.
      if (stack[stack.length - 1]?.kind === "backtick") close();
      else open("backtick");
      i++;
      prev = "(";
      continue;
    }
    if (c === "$" && src[i + 1] === "(") {
      open("subst");
      i += 2;
      prev = "(";
      continue;
    }
    if (c === "(" && !inDoubleQuote()) {
      open("group");
      i++;
      prev = "(";
      continue;
    }
    if (c === ")" && !inDoubleQuote()) {
      // A case PATTERN's `)` has no opener. It is the one at the depth the `case` was read
      // at — an optional leading `(` in a pattern raises the depth and is closed normally.
      if (cases.length && stack.length === cases[cases.length - 1]) {
        i++;
        prev = c;
        cmdStart = true;
        timed = false;
        continue;
      }
      if (stack.length) close();
      i++;
      prev = c;
      continue;
    }
    // A whole WORD is read at a command position rather than four characters matched
    // against two names: what a reserved word does to the position is the question, and a
    // word that is not one ends it.
    // An OPTION at a command position is not the command: `time -p case x in …` puts one
    // between the reserved word and the next command, and read as an ordinary word it ended
    // the position, so `case` was not a keyword and its arm's `)` closed the substitution.
    // Only after `time`, though — read as transparent everywhere, `-p case x` made `-p` the
    // option of nothing and `case` a keyword, so the `)` that CLOSED the substitution was
    // taken for a pattern's and the string after it was read as code.
    if (cmdStart && timed && c === "-") {
      let j = i;
      while (j < src.length && !/[\s;&|<>()]/.test(src[j])) j++;
      i = j;
      prev = "x";
      continue;
    }
    if (cmdStart && /[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      if (word === "case") cases.push(stack.length);
      else if (word === "esac") cases.pop();
      timed = word === "time";
      cmdStart = COMMAND_OPENERS.has(word);
      i = j;
      prev = "x";
      continue;
    }
    if (c === "#" && !inDoubleQuote() && /[\s\n(;&|]|^$/.test(prev)) {
      const nl = src.indexOf("\n", i);
      const stop = nl === -1 ? src.length : nl;
      out.push({ line, text: src.slice(i + 1, stop), start: i, end: stop });
      i = stop;
      continue;
    }
    // Whitespace CARRIES the command position rather than ending it: cleared by every
    // space, an indented `case` — the shape a `$( … )` block is written in — stopped being
    // a keyword, its arms' `)` closed the substitution, and their comments fell back inside
    // the double quote around it.
    if (c !== " " && c !== "\t") {
      cmdStart = c === ";" || c === "&" || c === "|" || c === "{" || c === "!";
      // …and `time` measures ONE command. Carried past the boundary, `time; -p case x` read
      // the `-p` as its option and `case` as a keyword, so the `)` that closed the
      // substitution was taken for a pattern's and the string after it was read as code.
      timed = false;
    }
    prev = c;
    i++;
  }
  return out;
}

/** Comment spans of an HTML file: `<!-- … -->` and nothing else. */
export function htmlComments(src) {
  const out = [];
  let line = 1;
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("<!--", i)) {
      const close = src.indexOf("-->", i + 4);
      const stop = close === -1 ? src.length : close;
      const body = src.slice(i + 4, stop);
      body.split("\n").forEach((t, n) => out.push({ line: line + n, text: t }));
      line += (src.slice(i, stop).match(/\n/g) ?? []).length;
      i = stop + 3;
      continue;
    }
    if (src[i] === "\n") line++;
    i++;
  }
  return out;
}

/** Findings in one file's comments. */
export function findingsIn(src, path) {
  const found = [];
  for (const { line, text } of comments(src, dialect(path))) {
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      for (const m of text.matchAll(rule.re))
        found.push({ path, line, rule: rule.id, say: rule.say, hit: m[0].trim() });
    }
  }
  return found;
}

function collect(root, dir = root, found = []) {
  if (statSync(dir).isFile()) {
    if (EXTS.has(extname(dir).toLowerCase()) && !SELF.test(dir.split(sep).join("/"))) found.push(dir);
    return found;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = relative(root, path).split(sep).join("/");
    if (entry.isDirectory()) {
      if (!SKIP_ANYWHERE.has(entry.name) && !SKIP_PATHS.has(rel)) collect(root, path, found);
    } else if (EXTS.has(extname(entry.name).toLowerCase()) && !SELF.test(rel)) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Every source this repository carries, asked of git rather than of a list of directories.
 *
 * A hand-written root list answers a question nobody asked: it says which directories were
 * thought of, and a file outside all of them is not reported as unscanned but as absent.
 * `.claude/skills/urx-routing-planner/scripts/plan_tool.py` sat outside five named roots and
 * scanned as `0 source file(s)` — a green run naming the file it had not opened. What the
 * check is asking is whether this REPOSITORY carries a violation, and what the repository
 * carries is what git tracks, so nothing has to be kept in step by hand.
 *
 * It throws rather than falling back to a walk: a scan that quietly reads a different set
 * than it was asked for is the failure this replaces.
 */
export function trackedSources(root = ROOT, run = gitLsFiles, exists = existsSync) {
  const listed = run(root)
    .split("\0")
    .filter(Boolean)
    .filter((rel) => EXTS.has(extname(rel).toLowerCase()));
  // A tracked path can be missing from the worktree (deleted, not yet committed). Reading it
  // would throw in the middle of the scan; it is simply not there to carry a comment.
  return listed.map((rel) => join(root, rel)).filter((abs) => exists(abs));
}

/**
 * The sources this check READS, which is the inventory minus its own two files.
 *
 * Separate from the inventory because the formatter takes that list too, and folding the
 * self-exclusion into it made `pnpm format` skip this file and its pins — narrower than the
 * `scripts/**` glob it replaced. Not being scanned and not being formatted are different
 * questions, and one filter cannot answer both.
 */
export const scanTargets = (sources) => sources.filter((path) => !SELF.test(path.split(sep).join("/")));

// `--others --exclude-standard` as well as the index: a file written but not yet added is
// source this repository is about to carry, and a check that waits for `git add` reports a
// violation one step after it could have. `--exclude-standard` is what keeps node_modules,
// dist and the private reference tree out — the same answer the skip lists were maintained
// by hand to give.
const gitLsFiles = (root) =>
  execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    maxBuffer: 1 << 28,
  }).toString();

const LEDGER = new URL("./comment-provenance-baseline.json", import.meta.url);
// The ledger is keyed by repo-relative path, and the hook is handed an absolute one. This
// script lives in <root>/scripts/, which is what makes the root derivable without asking
// git — the hook runs with no cwd guarantee of its own.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
/** One name per file on disk. `resolve()` is not that: `/tmp` and `/private/tmp` are the
 *  same directory on macOS, so a file named through each was read twice and its findings
 *  counted twice — against a ceiling that had no row for the second spelling at all. */
const canonical = (path) => {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
};

export const repoPath = (path) => relative(ROOT, canonical(path)).split(sep).join("/");

/**
 * True when a `relative()` result leaves the root it was taken from.
 *
 * `startsWith("..")` is not that test on Windows: `relative()` between two DRIVES cannot
 * express the step, so it returns the target ABSOLUTE — `C:\tmp\x.ts` against a repo on
 * `G:` — and a check for a leading `..` reads that as a path inside the tree with a ceiling
 * of zero. The same holds for a UNC root. `p` is the path module to reason with, so the
 * Windows semantics are testable from any platform.
 */
export function escapesRoot(rel, p = { isAbsolute, sep }) {
  return rel === ".." || rel.startsWith(".." + p.sep) || rel.startsWith("../") || p.isAbsolute(rel);
}

/** The per-file ceilings, keyed by repo-relative path. */
export function readLedger() {
  try {
    return JSON.parse(readFileSync(LEDGER, "utf8")).files ?? {};
  } catch {
    return {};
  }
}

/** Findings grouped by repo-relative path. */
export function byFile(found) {
  const out = {};
  for (const f of found) {
    const key = repoPath(f.path);
    (out[key] ??= []).push(f);
  }
  return out;
}

/**
 * The ledger's verdict on one scan: what is over its ceiling, and what is under it.
 *
 * A file the ledger does not name has a ceiling of zero, which is what makes a NEW comment
 * fail rather than quietly joining the backlog.
 */
export function verdict(grouped, ledger, scanned = null) {
  const over = [];
  const under = [];
  // `scanned` is the set of paths this run actually read. A ledger row outside it was not
  // examined, and reporting it as emptied would name 102 files a one-file run never opened
  // — which is what the documented single-path invocation printed before this argument
  // existed. Null means the whole tree was read, and only then is an absent row a removal.
  const inScope = (path) => scanned === null || scanned.has(path);
  for (const [path, findings] of Object.entries(grouped)) {
    const ceiling = ledger[path] ?? 0;
    if (findings.length > ceiling) over.push({ path, ceiling, count: findings.length, findings });
    else if (findings.length < ceiling) under.push({ path, ceiling, count: findings.length });
  }
  for (const path of Object.keys(ledger)) {
    if (!grouped[path] && inScope(path)) under.push({ path, ceiling: ledger[path], count: 0 });
  }
  over.sort((a, b) => a.path.localeCompare(b.path));
  under.sort((a, b) => a.path.localeCompare(b.path));
  return { over, under };
}

/**
 * What the hook should do about one edited file: the same ceiling the scan applies.
 *
 * Its own function so it can be pinned rather than only hand-run. Refusing on any finding
 * at all — which is what the first version did — refuses every edit to each of the files
 * the ledger already names, so the backlog would stop the work instead of the other way
 * round. A path outside this repository has no row and never will, and reported by relative
 * path would read as "../../../tmp/x.ts", naming nothing.
 */
export function hookDecision(path, src, ledger) {
  const key = repoPath(path);
  if (escapesRoot(relative(ROOT, resolve(path))))
    return { exit: 0, key, ceiling: 0, findings: [], reason: "outside this repository" };
  const findings = findingsIn(src, path);
  const ceiling = ledger[key] ?? 0;
  return {
    exit: findings.length > ceiling ? 2 : 0,
    key,
    ceiling,
    findings,
    reason: findings.length > ceiling ? "above its ceiling" : "at or below its ceiling",
  };
}

/**
 * The ledger the tree earns, and what a write of it would give away.
 *
 * The ledger only ever shrinks — that is the whole of what it promises. `--update` taking
 * the current counts unconditionally breaks it: a run that adds a comment, is refused by the
 * scan, and then updates the ledger has the ceiling raised to fit, and the next whole-tree
 * scan is green with the violation inside it. So a write reports what it would RAISE, and
 * the caller refuses on that rather than applying it.
 *
 * `scope` is the set of paths the run read; rows outside it are carried over untouched.
 */
export function nextLedger(grouped, ledger, scope = null) {
  const inScope = (path) => scope === null || scope.has(path);
  const files = {};
  const raised = [];
  for (const [path, ceiling] of Object.entries(ledger)) {
    if (!inScope(path)) {
      files[path] = ceiling;
      continue;
    }
    const count = grouped[path]?.length ?? 0;
    if (count > ceiling) raised.push({ path, ceiling, count });
    if (count > 0) files[path] = Math.min(ceiling, count);
  }
  for (const [path, findings] of Object.entries(grouped)) {
    if (path in ledger || !inScope(path)) continue;
    raised.push({ path, ceiling: 0, count: findings.length });
  }
  return { files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))), raised };
}

const report = (found) => {
  for (const f of found) {
    console.error(`${f.path}:${f.line}  ${f.say}: ${JSON.stringify(f.hit)}`);
  }
  console.error(
    `\n${found.length} comment(s) record where a fact came from. Keep the claim; move the run,` +
      ` the reading and the date to the pull request or to docs/, which is where they stay findable.`,
  );
};

// Everything below is the command line. Guarded, because importing this module ran ALL of
// it: the pins import `findingsIn`, and each import scanned the tree with vitest's own argv
// and could reach `process.exit`. A test that imports a checker must not run it.
/**
 * Whether THIS module is the program, rather than something a test imported.
 *
 * Compared as REAL paths on both sides. Node resolves the entry module's symlinks before it
 * stamps `import.meta.url`, and leaves `process.argv[1]` exactly as it was typed, so on a
 * path through a link the two are different strings for one file — on macOS every path under
 * `/tmp` and `/var/folders` is one. Read as "not the program", the command line was skipped
 * and the process exited 0 having scanned nothing, which is the shape of a green run that
 * asked no question.
 */
function isEntry(url) {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(fileURLToPath(url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
const invokedDirectly = isEntry(import.meta.url);
const hook = invokedDirectly && process.argv.includes("--hook");
if (hook) {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let path;
  try {
    path = JSON.parse(raw)?.tool_input?.file_path;
  } catch {
    process.exit(0);
  }
  if (!path || !EXTS.has(extname(path).toLowerCase()) || SELF.test(path.split(sep).join("/"))) process.exit(0);
  if (!existsSync(path)) process.exit(0);
  const d = hookDecision(path, readFileSync(path, "utf8"), readLedger());
  if (d.exit === 0) process.exit(0);
  console.error(`${d.key}: ${d.findings.length} finding(s), ledger allows ${d.ceiling}`);
  report(d.findings);
  process.exit(2);
}

if (invokedDirectly) {
  const roots = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  let targets;
  if (roots.length) {
    // Named twice — as itself, or once under a directory that also contains it — a file was
    // read twice and its findings counted twice, so a path at its ceiling failed against
    // itself. Resolved, because `./src/a.ts` and `src/a.ts` are one file.
    // A path that is not there is a question this cannot answer, and answering `0 source
    // file(s)` with exit 0 says the opposite — a typo in a hook's payload or a CI step read
    // as a clean tree.
    const missing = roots.filter((root) => !existsSync(root));
    if (missing.length) {
      for (const root of missing) console.error(`${root}: no such file or directory`);
      console.error(`\n${missing.length} named path(s) do not exist. Nothing was scanned for them.`);
      process.exit(1);
    }
    const named = new Map();
    for (const root of roots) {
      for (const path of collect(root)) named.set(canonical(path), path);
    }
    targets = [...named.values()];
  } else {
    try {
      targets = scanTargets(trackedSources());
    } catch (err) {
      console.error(`Cannot list this repository's files: ${err.message}`);
      console.error("The whole-tree scan reads what git tracks. Name paths to scan without it.");
      process.exit(1);
    }
  }
  const found = targets.flatMap((p) => findingsIn(readFileSync(p, "utf8"), p));
  const grouped = byFile(found);

  // What this run actually read. A partial scan compares only these, so a ledger row it never
  // opened is neither reported as emptied nor dropped from the file.
  const scanned = new Set(targets.map((p) => repoPath(p)));
  const partial = roots.length > 0;

  const reseed = process.argv.includes("--reseed");
  if (process.argv.includes("--update") || reseed) {
    // A partial write MERGES: rewriting the whole ledger from a subset would delete every row
    // the run never looked at, silently taking the ceiling of 102 files to zero.
    const { files: lowered, raised } = nextLedger(grouped, readLedger(), partial ? scanned : null);
    if (raised.length && !reseed) {
      for (const r of raised) {
        console.error(`${r.path}: ${r.count} finding(s), ledger allows ${r.ceiling}`);
      }
      console.error(
        `\n--update lowers a ceiling; it does not raise one. ${raised.length} file(s) above theirs.` +
          ` Move the run, the reading and the date to the pull request or to docs/.` +
          ` A RULE change that legitimately grows the corpus is --reseed, which is a separate` +
          ` decision and shows in the diff as one.`,
      );
      process.exit(1);
    }
    const files = reseed
      ? Object.fromEntries(
          Object.entries({
            ...(partial ? Object.fromEntries(Object.entries(readLedger()).filter(([p]) => !scanned.has(p))) : {}),
            ...Object.fromEntries(Object.entries(grouped).map(([path, f]) => [path, f.length])),
          })
            .filter(([, n]) => n > 0)
            .sort(([a], [b]) => a.localeCompare(b)),
        )
      : lowered;
    writeFileSync(
      LEDGER,
      JSON.stringify(
        {
          note: "Per-file ceiling for comments that record a fact's provenance. See scripts/check-comment-provenance.mjs. A file may carry what it carried and no more; a cleaned file's lower count belongs here.",
          files,
        },
        null,
        2,
      ) + "\n",
    );
    const total = Object.values(files).reduce((a, b) => a + b, 0);
    console.log(
      `ledger ${reseed ? "reseeded" : partial ? "merged" : "written"}: ${Object.keys(files).length} file(s),` +
        ` ${total} finding(s)` +
        (partial ? ` (${scanned.size} scanned, the rest carried over)` : ""),
    );
    process.exit(0);
  }

  const { over, under } = verdict(grouped, readLedger(), partial ? scanned : null);
  if (over.length) {
    for (const f of over) {
      console.error(`${f.path}: ${f.count} finding(s), ledger allows ${f.ceiling}`);
      for (const x of f.findings) console.error(`  ${f.path}:${x.line}  ${x.say}: ${JSON.stringify(x.hit)}`);
    }
    console.error(
      `\n${over.length} file(s) above the ledger. Keep the claim; move the run, the reading and` +
        ` the date to the pull request or to docs/, which is where they stay findable.`,
    );
    process.exit(1);
  }
  console.log(
    `OK: ${targets.length} source file(s)${partial ? " (partial scan)" : ""}, ${found.length} ledgered finding(s),` +
      ` none above its ceiling`,
  );
  if (under.length) {
    console.log(`\n${under.length} file(s) now carry fewer than the ledger allows. Paste to lower it:`);
    for (const f of under)
      console.log(`    ${JSON.stringify(f.path)}: ${f.count},${f.count ? "" : "   // (delete the row)"}`);
  }
}
