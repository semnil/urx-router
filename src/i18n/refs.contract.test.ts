// Every leaf in the catalog is reached by the application's own code.
//
// `e2e/inventory.spec.ts` answers the harder half of this — a message some surface
// SHOWS — by driving each surface and reading the screen. It cannot answer the
// easier half, because a key nothing references does not fail there in a way that
// names it: the surface simply renders without it, and the assertion is about what
// IS on screen. The gap is real and was measured, at `d23b206^`, where `modeDesc`
// sat in both catalogs referenced by nothing at all.
//
// So this is the floor under that guard, and deliberately the loose one: it asks
// only whether the leaf's own name occurs anywhere in the shipped sources. A leaf
// whose name collides with an unrelated property (`on`, `open`, `name`) therefore
// passes on the collision. That is a miss, not a false alarm, and it is the shape
// every gap below has but one: they lean into silence. **The exception is
// destructuring**, four paragraphs down — the one form that makes this report a key
// that IS in use. Read that before treating a failure here as settled.
//
// Two forms reach a leaf without ever naming it, and both vouch for the namespace
// they are applied to: a computed index (`t().error[err.code]`, `m.inspector[key]`)
// and a spread into something indexed later (`{ ...m.mode }`, then `text[v]`).
// Nothing else does — in particular NOT `const m = t().prefs`, which is the house
// idiom and would vouch for almost everything: written that way the rule covered
// 44 of 48 namespaces and 687 of 713 leaves, i.e. it checked 26 of them (measured
// 2026-08-12, which is why the rule is not written that way).
//
// What it costs as written, same measurement: 22 namespaces are vouched wholesale
// and 359 of 713 leaves sit inside one — `inspector` and `dynTuning` are indexed
// by key, so their members cannot be named from the text. Inside those, this check
// is asleep and the inventory spec is the only guard.
//
// THE EXCEPTION the top of this header points at. One reference form is not recognised
// and is reported as unreferenced: destructuring (`const { title } = t().ns`). No leaf is
// reached only that way today — the house idiom binds the namespace and keeps the dots —
// so the check passes, and a first such use fails here rather than silently, which is the
// bearable end of a false alarm. It is still one: a failure naming a key you can see used
// through a destructured binding is this, not a dead key. Adding it means following
// bindings, which is a parser rather than a scan.
//
// Tests are excluded from the scan on purpose: a key referenced only by a test is
// dead in the application, which is exactly what this is here to find.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { en } from "./en";

// From the repo root, the way main.test-util.ts reads index.html. NOT
// `new URL(..).pathname`: that is a URL path. A Windows checkout gets `/G:/…`, which
// resolves against the current drive — that half is Windows-only. A directory with a
// space in it arrives percent-encoded on every platform, which is the half that reaches
// macOS and Linux too (reproduced locally). Either way readdirSync throws.
const SRC = resolve(process.cwd(), "src");

/** Every `.ts` under src/, minus the catalogs themselves and the test layer. */
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, out);
    else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test-util.ts") &&
      path !== join(SRC, "i18n", "en.ts") &&
      path !== join(SRC, "i18n", "ja.ts")
    )
      out.push(path);
  }
  return out;
}

/** Leaf = a string, a function, or an array — anything that is not a plain namespace. */
function leaves(node: unknown, path: string[] = [], out: string[][] = []): string[][] {
  if (node !== null && typeof node === "object" && !Array.isArray(node)) {
    for (const [key, value] of Object.entries(node)) leaves(value, [...path, key], out);
  } else out.push(path);
  return out;
}

/** The catalog paths `text` names nowhere, by the rules in the header. */
function unreferenced(catalog: unknown, text: string): string[] {
  const named = new Set<string>();
  for (const [, name] of text.matchAll(/\.([A-Za-z_$][\w$]*)/g)) named.add(name);
  for (const [, name] of text.matchAll(/\[\s*["'`]([^"'`]+)["'`]\s*\]/g)) named.add(name);
  const wholesale = new Set<string>();
  // `.foo[` and `.foo?.[` pick a member at runtime. The optional-chaining punctuator is
  // spelled out rather than made optional one character at a time: `\??` matched a bare
  // `?`, which missed `?.[` entirely AND vouched for the namespace on the left of a
  // ternary (`cond.ns ? [1] : [2]`) — both measured 2026-08-13.
  for (const [, name] of text.matchAll(/\.([A-Za-z_$][\w$]*)\s*(?:\?\.)?\s*\[/g)) wholesale.add(name);
  // `...x.foo` — the namespace itself is taken away, to be indexed out of reach of this
  // scan. The lookahead rejects a match that is not the END of the property chain, which
  // is three things at once: a CALL (`...list.filter(…)`), its generic form
  // (`...el.querySelectorAll<T>(…)`), and a middle segment reached by backtracking —
  // `[...a.b.c.filter(x)]` otherwise vouched for `c`, measured 2026-08-13.
  for (const [, name] of text.matchAll(/\.\.\.\s*[\w$]+(?:\.[\w$]+)*\.([\w$]+)\s*(?![\w$(<.])/g)) wholesale.add(name);

  return leaves(catalog)
    .filter((path) => !path.slice(0, -1).some((seg) => wholesale.has(seg)) && !named.has(path[path.length - 1]))
    .map((path) => path.join("."));
}

describe("i18n catalog references", () => {
  it("every message in en.ts is reached from the application's own sources", () => {
    const text = sources(SRC)
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    expect(unreferenced(en, text)).toEqual([]);
  });

  // The rest show the rule a case it must report and the near-misses it must not,
  // so a regex edit that quietly stops finding anything fails here rather than
  // passing everywhere.
  const catalog = { ns: { alive: "a", dead: "b" }, other: { x: "c" } };

  it("reports a leaf no source names", () => {
    expect(unreferenced(catalog, "el.textContent = m.ns.alive; use(m.other.x);")).toEqual(["ns.dead"]);
  });

  it("takes an indexed namespace as reaching all of it", () => {
    expect(unreferenced(catalog, "el.textContent = m.ns[kind]; use(m.other.x);")).toEqual([]);
  });

  it("takes a spread namespace as reaching all of it", () => {
    expect(unreferenced(catalog, "const all = { ...m.ns }; use(all[v], m.other.x);")).toEqual([]);
  });

  // Each rule below is one an edit has already broken: `?.[` was written as an optional
  // `?` and matched neither the syntax it meant nor only the syntax it meant, and the
  // chain lookahead was written without `.` and vouched for middle segments. Both went
  // in without a case and both were wrong, which is what these are for.
  it("takes an optional-chained index as reaching all of it", () => {
    expect(unreferenced(catalog, "el.textContent = m.ns?.[kind]; use(m.other.x);")).toEqual([]);
  });

  it("does not let a ternary vouch for the namespace on its left", () => {
    expect(unreferenced(catalog, "const v = cond.ns ? [1] : [2]; use(m.other.x);")).toEqual(["ns.alive", "ns.dead"]);
  });

  it("does not vouch for a middle segment of a spread chain", () => {
    const deep = { c: { only: "a" }, other: { x: "c" } };
    expect(unreferenced(deep, "const rows = [...a.b.c.filter((r) => r.on)]; use(m.other.x);")).toEqual(["c.only"]);
  });

  it("does not let a generic call spread vouch for a same-named namespace", () => {
    const generics = { querySelectorAll: { only: "a" }, other: { x: "c" } };
    expect(unreferenced(generics, "const all = [...el.querySelectorAll<HTMLElement>(sel)]; use(m.other.x);")).toEqual([
      "querySelectorAll.only",
    ]);
  });

  it("does not let an array method spread vouch for a same-named namespace", () => {
    const arrays = { filter: { only: "a" }, other: { x: "c" } };
    expect(unreferenced(arrays, "const rows = [...list.filter((c) => c.on)]; use(m.other.x);")).toEqual([
      "filter.only",
    ]);
  });
});
