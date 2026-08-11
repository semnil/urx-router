// A scripted BoundControl for engine tests: value held locally, an optional
// lock, and continuous writes snapped to `step`. Not a test file itself (vitest
// collects only *.test.ts), so the engine specs import it instead of each
// declaring their own — a change to BoundControl's shape is then edited here.
//
// Two answers are deliberate, because a spec's verdict reads them. `set` refuses
// while `locked` and reports it with `false` rather than accepting the write and
// dropping it, so a case about a locked control cannot pass on a silent no-op.
// And a continuous write is clamped to 0..1 and snapped to `step`, so a readback
// is the quantised value the engine would put on the wire, never the raw one the
// caller asked for — an unsnapped hold would let a rounding bug through.

import type { BoundControl } from "./controls";

export interface Fake extends BoundControl {
  value: number;
  locked: boolean;
}

export function fake(id: string, kind: "continuous" | "toggle", value = 0, step = 1 / 40): Fake {
  const f: Fake = {
    id,
    node: id.split("/")[0],
    param: "level",
    kind,
    value,
    locked: false,
    get: () => f.value,
    set: (v) => {
      if (f.locked) return false;
      const clamped = Math.max(0, Math.min(1, v));
      f.value = kind === "toggle" ? (clamped >= 0.5 ? 1 : 0) : Math.round(clamped / step) * step;
      return true;
    },
  };
  return f;
}
