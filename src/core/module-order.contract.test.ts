// The values the core modules build at module scope do not depend on which of them is imported
// first.
//
// plan.ts, constraints.ts, translate.ts and a few more import each other in a cycle. Inside a
// cycle, the module imported first is evaluated LAST, so a module-scope expression that reads a
// binding from a module still being evaluated reads it uninitialised — and a table built from it
// keeps that hole for the life of the process. The app's own entry reaches the cycle in an order
// where nothing is read early, while a unit test can import any module first. control/vd.ts,
// whose constants every GATE / COMP / DUCKER field table reads, imports nothing from the cycle,
// so those constants are initialised in every order.
//
// The cycle is DERIVED from the import graph rather than listed, so a module that joins it later
// is an entry here the day it joins. Each module of the cycle — and vd.ts, whose constants the
// field tables read — is imported first in turn, the rest after it, and everything they export
// is compared against the order that starts at plan.ts: the exported values, the tables a
// zero-argument export returns, and the channel field tables on every node of every model.
import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "..");

/** Value imports only: `import type` and brace lists holding nothing but types are erased at
 *  compile time and cannot order evaluation. Re-exports with `from` are edges as well. */
function valueEdges(): Map<string, Set<string>> {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.ts$/.test(name) && !/\.test(-util)?\.ts$/.test(name) && !/\.d\.ts$/.test(name)) files.push(p);
    }
  };
  walk(srcRoot);
  const resolveSpec = (from: string, spec: string): string | null => {
    if (!spec.startsWith(".")) return null;
    const base = resolve(dirname(from), spec);
    for (const c of [base, `${base}.ts`, join(base, "index.ts")]) {
      if (existsSync(c) && statSync(c).isFile()) return c;
    }
    return null;
  };
  const re = /^\s*(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm;
  const edges = new Map<string, Set<string>>();
  for (const f of files) {
    const deps = new Set<string>();
    for (const m of readFileSync(f, "utf8").matchAll(re)) {
      if (m[2]) continue;
      const spec = m[4] ?? m[5];
      const inner = /^\{([\s\S]*)\}$/.exec((m[3] ?? "").trim());
      if (inner) {
        const parts = inner[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (parts.length && parts.every((p) => p.startsWith("type "))) continue;
      }
      const target = spec ? resolveSpec(f, spec) : null;
      if (target) deps.add(target);
    }
    edges.set(f, deps);
  }
  return edges;
}

/** The strongly connected component holding `start` (Tarjan). */
function cycleOf(edges: Map<string, Set<string>>, start: string): string[] {
  let n = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  let found: string[] = [start];
  const strong = (v: string): void => {
    idx.set(v, n);
    low.set(v, n);
    n++;
    stack.push(v);
    on.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        on.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.includes(start)) found = comp;
    }
  };
  for (const v of edges.keys()) if (!idx.has(v)) strong(v);
  return found;
}

function snap(v: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (v === undefined) return "[undefined]";
  if (typeof v === "number" && !Number.isFinite(v)) return `[${String(v)}]`;
  if (v === null || typeof v !== "object") return typeof v === "function" ? "[fn]" : v;
  if (seen.has(v)) return "[cycle]";
  if (depth > 6) return "[deep]";
  seen.add(v);
  if (Array.isArray(v)) return v.slice(0, 500).map((x) => snap(x, depth + 1, seen));
  if (v instanceof Set) return { "[set]": [...v].slice(0, 500).map((x) => snap(x, depth + 1, seen)) };
  if (v instanceof Map) return { "[map]": [...v].slice(0, 500).map(([k, x]) => [String(k), snap(x, depth + 1, seen)]) };
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).slice(0, 500)) out[k] = snap((v as Record<string, unknown>)[k], depth + 1, seen);
  return out;
}

const PLAN = resolve(here, "plan.ts");
const VD = resolve(here, "control/vd.ts");
const edges = valueEdges();
const cycle = cycleOf(edges, PLAN);
const entries = [...new Set([PLAN, ...cycle, VD])];
const spec = (abs: string): string => {
  const r = relative(here, abs).replace(/\.ts$/, "");
  return r.startsWith(".") ? r : `./${r}`;
};

async function snapshotStartingAt(first: string): Promise<Record<string, unknown>> {
  vi.resetModules();
  const mods = new Map<string, Record<string, unknown>>();
  mods.set(first, await import(/* @vite-ignore */ spec(first)));
  for (const m of entries) if (!mods.has(m)) mods.set(m, await import(/* @vite-ignore */ spec(m)));
  const { getModel } = await import("../models");
  const out: Record<string, unknown> = {};
  for (const [m, exp] of mods) {
    const name = relative(srcRoot, m);
    for (const [k, v] of Object.entries(exp)) {
      out[`${name}:${k}`] = snap(v);
      if (typeof v === "function" && v.length === 0) {
        try {
          out[`${name}:${k}()`] = snap((v as () => unknown)());
        } catch (e) {
          out[`${name}:${k}()`] = `[throws ${(e as Error).message}]`;
        }
      }
    }
  }
  const translate = mods.get(resolve(here, "control/translate.ts"))!;
  const channelDynamics = translate.channelDynamics as (m: unknown, id: string, type: number) => unknown;
  for (const id of ["URX22", "URX44", "URX44V"] as const) {
    const model = getModel(id);
    for (const node of model.nodes) {
      for (const type of [0, 1]) {
        const d = channelDynamics(model, node.id, type);
        if (d) out[`channelDynamics(${id},${node.id},${type})`] = snap(d);
      }
    }
  }
  return out;
}

describe("the core modules' import cycle", () => {
  // Positive controls: a scanner that found no edges, or a cycle that lost translate.ts, would
  // leave every comparison below agreeing with itself.
  it("is found in the import graph, with the field tables' module in it", () => {
    let count = 0;
    for (const d of edges.values()) count += d.size;
    expect(count).toBeGreaterThan(100);
    expect(cycle).toContain(resolve(here, "control/translate.ts"));
    expect(entries).toContain(VD);
  });

  it("builds the same module-scope values whichever of its modules is imported first", async () => {
    const reference = await snapshotStartingAt(PLAN);
    // The channel field tables are what the defect this pins emptied; they have to be here.
    const tables = Object.keys(reference).filter((k) => k.startsWith("channelDynamics("));
    expect(tables.length).toBeGreaterThan(0);
    const ratio = (
      reference["channelDynamics(URX44V,ch1,0)"] as { comp: Array<{ key: string; min: unknown }> }
    ).comp.find((f) => f.key === "ratio");
    expect(ratio?.min).toBe(1);

    for (const first of entries) {
      if (first === PLAN) continue;
      const s = await snapshotStartingAt(first);
      const differing = [...new Set([...Object.keys(reference), ...Object.keys(s)])].filter(
        (k) => JSON.stringify(reference[k]) !== JSON.stringify(s[k]),
      );
      expect(differing, `imported first: ${relative(srcRoot, first)}`).toEqual([]);
    }
  }, 120_000);
});
