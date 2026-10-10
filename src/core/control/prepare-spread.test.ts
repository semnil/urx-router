// The spread on its own, with the self-test's silence pass taken out. prepare.test.ts keeps the
// real `floorSilent`, and either layer turning +48V off hides the other one's removal there, so
// this file is what fails when the spread itself would turn a jack's +48V on.
import { describe, expect, it, vi } from "vitest";
import { emptyPlan } from "../plan";

vi.mock("./selftest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./selftest")>()),
  floorSilent: () => {},
}));

import { buildModifiedPlan } from "./prepare";

describe("buildModifiedPlan's spread", () => {
  it("leaves every jack's +48V off, while turning its other switches to their non-default", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["in.micline_1_2"] = { phantomL: false, phantomR: true, clipSafeL: false, clipSafeR: false };
    const np = buildModifiedPlan(plan).nodeParams["in.micline_1_2"];
    expect(np.phantomL).toBe(false);
    expect(np.phantomR).toBe(false);
    expect(np.clipSafeL, "the positive control: a boolean beside them is spread").toBe(true);
    expect(np.clipSafeR).toBe(true);
  });
});
