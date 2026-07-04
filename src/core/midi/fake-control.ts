import type { BoundControl } from "./controls";

// A scripted BoundControl for engine tests: value held locally, an optional
// lock, and continuous writes snapped to `step`. Shared by the engine specs so
// a change to BoundControl's shape is edited in one place.
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
