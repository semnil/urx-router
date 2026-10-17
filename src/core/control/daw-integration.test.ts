import { describe, expect, it } from "vitest";
import {
  dawIntegrationNotifyAddrs,
  decodeIntegrationSend,
  encodeIntegrationSend,
  integrationGlassValues,
  integrationSlotAt,
  withIntegrationNotify,
  type DawIntegration,
} from "./daw-integration";

const OFF: DawIntegration = { active: false, fx1Send: "MIX 1", fx2Send: "MIX 1" };

describe("SETUP > Software Integration (816 / 879 / 880)", () => {
  it("decodes the value the unit holds for each bus, and encodes it back", () => {
    for (const [send, raw] of [
      ["MIX 1", 288],
      ["MIX 2", 290],
    ] as const) {
      expect(decodeIntegrationSend(raw)).toBe(send);
      expect(encodeIntegrationSend(send)).toBe(raw);
    }
    for (const raw of [0, 256, 289, 291, 4294967295]) expect(decodeIntegrationSend(raw), String(raw)).toBeNull();
    expect(encodeIntegrationSend("MIX 3")).toBeNull();
  });

  it("takes any value but 0 at 816 as a DAW holding the unit, and each send at its own address", () => {
    expect(withIntegrationNotify(OFF, 816, 2)?.active).toBe(true);
    expect(withIntegrationNotify(OFF, 816, 1)?.active).toBe(true);
    expect(withIntegrationNotify({ ...OFF, active: true }, 816, 0)?.active).toBe(false);
    expect(withIntegrationNotify(OFF, 879, 290)).toEqual({ ...OFF, fx1Send: "MIX 2" });
    expect(withIntegrationNotify(OFF, 880, 290)).toEqual({ ...OFF, fx2Send: "MIX 2" });
    expect(withIntegrationNotify(OFF, 817, 1), "the operation mode is another param").toBeNull();
    expect(dawIntegrationNotifyAddrs()).toEqual([
      [816, 0, 0],
      [879, 0, 0],
      [880, 0, 0],
    ]);
  });

  it("names each send by the glass's path, and shows none it could not decode", () => {
    expect([...integrationGlassValues({ active: true, fx1Send: "MIX 2", fx2Send: null })]).toEqual([
      ["setup.integration.fx1Send", "MIX 2"],
    ]);
    expect(integrationSlotAt("setup.integration.fx1Send")).toBe("fx1Send");
    expect(integrationSlotAt("setup.integration.fx2Send")).toBe("fx2Send");
    expect(integrationSlotAt("setup.integration")).toBeNull();
  });
});
