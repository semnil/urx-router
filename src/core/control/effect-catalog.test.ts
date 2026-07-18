// Effect-catalog internal consistency (boundary-value + contract sweep). The
// round-trip suites move RAW values through the device and the calibration suites
// pin interior display anchors, but nothing checks the descriptor tables against
// themselves: that each slider's factory default sits inside its own rawMin/rawMax,
// that each select's default is a real option, and that every formatter returns a
// finite label at both range endpoints (a broken taper or a NaN at an extreme
// would silently mislabel the inspector). These would catch a catalog typo — a
// def outside its bounds, a dropped option, a format that divides to NaN — that
// the value-domain tests, which only probe calibrated interior points, do not.

import { describe, expect, it } from "vitest";
import { DELAY_PARAMS, REVR3_PARAMS, REVX_PARAMS, fxParams, type FxParamDesc } from "./fx-effect";
import { MBC_BAND_PARAM, insertFxParams, type InsertFxFamily, type InsertFxParamDesc } from "./insert-fx-effect";

// A label must be a non-empty string with no NaN/undefined leaking into it.
function assertLabel(label: string, ctx: string): void {
  expect.soft(typeof label, ctx).toBe("string");
  expect.soft(label.includes("NaN"), `${ctx} -> "${label}"`).toBe(false);
  expect.soft(label.includes("undefined"), `${ctx} -> "${label}"`).toBe(false);
}

// Shared descriptor shape between the two catalogs for the consistency checks.
type Desc = FxParamDesc | InsertFxParamDesc;

function checkDesc(d: Desc, ctx: string): void {
  if (d.control === "slider") {
    expect.soft(d.rawMin, `${ctx} rawMin`).toBeTypeOf("number");
    expect.soft(d.rawMax, `${ctx} rawMax`).toBeTypeOf("number");
    const lo = d.rawMin as number;
    const hi = d.rawMax as number;
    expect.soft(lo, `${ctx} rawMin <= rawMax`).toBeLessThanOrEqual(hi);
    // The factory default must be settable on the slider it belongs to.
    expect.soft(d.def, `${ctx} def >= rawMin`).toBeGreaterThanOrEqual(lo);
    expect.soft(d.def, `${ctx} def <= rawMax`).toBeLessThanOrEqual(hi);
    if (d.format) {
      // Formatter is finite (no NaN/undefined) across both endpoints and the default.
      for (const raw of [lo, hi, d.def]) assertLabel(d.format(raw, {}), `${ctx} format(${raw})`);
    }
  } else if (d.control === "select") {
    expect.soft(d.options, `${ctx} options`).toBeDefined();
    const values = (d.options ?? []).map((o) => o.value);
    // The default selection must be one of the offered options.
    expect.soft(values, `${ctx} def is an option`).toContain(d.def);
  }
}

describe("FX-channel effect descriptors are internally consistent", () => {
  const families: [string, FxParamDesc[]][] = [
    ["revx", REVX_PARAMS],
    ["revr3", REVR3_PARAMS],
    ["delay", DELAY_PARAMS],
    ["fxParams(revx)", fxParams("revx")],
  ];
  for (const [name, descs] of families) {
    it(`${name}: defaults in bounds, formatters finite at endpoints`, () => {
      for (const d of descs) checkDesc(d, `${name}.${d.key}`);
    });
  }
});

describe("Insert-FX effect descriptors are internally consistent", () => {
  const families: InsertFxFamily[] = [
    "guitar-clean",
    "guitar-crunch",
    "guitar-lead",
    "guitar-drive",
    "pitch",
    "compander",
  ];
  for (const fam of families) {
    it(`${fam}: defaults in bounds, formatters finite at endpoints`, () => {
      for (const d of insertFxParams(fam)) checkDesc(d, `${fam}.slot${d.slot}`);
    });
  }

  it("MBC per-band params: defaults in bounds, formatters finite at endpoints", () => {
    // MBC uses the structured MBC_BAND_PARAM layout rather than a flat descriptor list.
    for (const key of ["attack", "threshold", "ratio", "gain"] as const) {
      const p = MBC_BAND_PARAM[key];
      expect.soft(p.rawMin, `${key} rawMin <= rawMax`).toBeLessThanOrEqual(p.rawMax);
      expect.soft(p.def, `${key} def >= rawMin`).toBeGreaterThanOrEqual(p.rawMin);
      expect.soft(p.def, `${key} def <= rawMax`).toBeLessThanOrEqual(p.rawMax);
      for (const raw of [p.rawMin, p.rawMax, p.def]) assertLabel(p.format(raw), `MBC.${key} format(${raw})`);
    }
  });
});
