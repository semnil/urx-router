import { describe, expect, it } from "vitest";
import { parseRelay } from "./midi-protocol";

describe("parseRelay", () => {
  it("accepts object and array payloads without changing their shape", () => {
    expect(parseRelay<{ type: string }>(`{"type":"ready"}`)).toEqual({ type: "ready" });
    expect(parseRelay<number[]>("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it.each(["null", "true", "42", `"ready"`, "not json"])("rejects non-message payload %s", (payload) => {
    expect(parseRelay(payload)).toBeNull();
  });
});
