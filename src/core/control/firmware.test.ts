import { describe, expect, it } from "vitest";
import { firmwareMismatch, SUPPORTED_SYSTEM_FIRMWARE } from "./firmware";

describe("firmwareMismatch", () => {
  it("does not warn when the device matches the validated System firmware", () => {
    expect(firmwareMismatch(SUPPORTED_SYSTEM_FIRMWARE)).toBe(false);
  });

  it("warns when the device reports a different System firmware", () => {
    expect(firmwareMismatch(`${SUPPORTED_SYSTEM_FIRMWARE}-other`)).toBe(true);
  });

  it("skips the check when the device reports no firmware (empty)", () => {
    expect(firmwareMismatch("")).toBe(false);
  });
});
