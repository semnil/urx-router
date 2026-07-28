import { describe, expect, it } from "vitest";
import {
  AUTO_POWER_OFF_MAX,
  AUTO_POWER_OFF_MIN,
  BRIGHTNESS_MAX,
  BRIGHTNESS_MIN,
  UDK_FUNCTIONS,
  UDK_SLOTS,
  UDK_UNASSIGNED,
  coerceDeviceSetup,
  defaultDeviceSetup,
  diffDeviceSetup,
  normalizeUdk,
  setupSupport,
  udkSlot,
} from "./device-setup";
import type { DeviceSetup } from "./device-setup";
import { PARAMS } from "./params";
import type { ParamSpec } from "./params";
import { planToCommands } from "./translate";
import { TIME_ZONE_CITIES } from "./timezones";
import { getModel } from "../../models";
import { defaultPlan } from "../../models/initial-state";

const MODELS = ["URX22", "URX44", "URX44V"] as const;
const setup = (patch: Partial<DeviceSetup> = {}): DeviceSetup => ({ ...defaultDeviceSetup(), ...patch });
const V = getModel("URX44V");

describe("device setup catalog", () => {
  it("is outside the plan: no plan-external param is ever emitted", () => {
    // The whole reason these live in their own module. A plan travels between
    // units, so emitting brightness / language / knob assignments would push one
    // operator's preferences onto another operator's hardware. Derived from the
    // catalog flag rather than a hand-copied name list, so a SETUP param added
    // later is covered without editing this test.
    const external = new Set<number>(
      Object.values(PARAMS as Record<string, ParamSpec>)
        .filter((spec) => spec.planExternal === true)
        .map((spec) => spec.id),
    );
    expect(external.size).toBeGreaterThan(0);
    for (const id of MODELS) {
      const emitted = planToCommands(getModel(id), defaultPlan(id));
      expect(emitted.filter((c) => external.has(c.paramId))).toEqual([]);
    }
  });

  it("gates the pages from the hardware the model is fitted with", () => {
    // Derived from DeviceModel's capability flags, not a second list of model ids:
    // the HDMI page needs the HDMI input, and the Date/Time menu exists to stamp
    // microSD recordings.
    expect(setupSupport(getModel("URX44V"))).toEqual({ hdmi: true, dateTime: true });
    expect(setupSupport(getModel("URX44"))).toEqual({ hdmi: false, dateTime: true });
    expect(setupSupport(getModel("URX22"))).toEqual({ hdmi: false, dateTime: false });
  });
});

describe("coerceDeviceSetup", () => {
  it("clamps to the ranges the unit's own menus offer", () => {
    const wild = coerceDeviceSetup(
      setup({ brightness: 99, autoPowerOffTime: 0, timeZone: 65535, language: 7, dateFormat: -3 }),
    );
    expect(wild.brightness).toBe(BRIGHTNESS_MAX);
    expect(wild.autoPowerOffTime).toBe(AUTO_POWER_OFF_MIN);
    expect(wild.timeZone).toBe(TIME_ZONE_CITIES.length - 1);
    expect(wild.language).toBe(2);
    expect(wild.dateFormat).toBe(0);
    expect(coerceDeviceSetup(setup({ brightness: -3 })).brightness).toBe(BRIGHTNESS_MIN);
    expect(coerceDeviceSetup(setup({ autoPowerOffTime: 999 })).autoPowerOffTime).toBe(AUTO_POWER_OFF_MAX);
  });
});

describe("normalizeUdk", () => {
  it("reduces an unknown function to No Assign with both columns empty", () => {
    expect(normalizeUdk({ fn: "Nonsense", p1: "Monitor 1", p2: "Level" })).toEqual(UDK_UNASSIGNED);
  });

  it("re-seeds the parameter columns the chosen function allows", () => {
    // The device stores whatever it is given and reconciles nothing, so an
    // inconsistent triple would be displayed on the unit verbatim.
    expect(normalizeUdk({ fn: "Monitor", p1: "", p2: "" })).toEqual({ fn: "Monitor", p1: "Monitor 1", p2: "Level" });
    expect(normalizeUdk({ fn: "Oscillator", p1: "Monitor 2", p2: "Level" })).toEqual({
      fn: "Oscillator",
      p1: "Level",
      p2: "",
    });
  });

  it("keeps a legal choice", () => {
    expect(normalizeUdk({ fn: "Phones", p1: "Phones 2", p2: "Level" })).toEqual({
      fn: "Phones",
      p1: "Phones 2",
      p2: "Level",
    });
  });

  it("accepts every catalog entry unchanged", () => {
    for (const f of UDK_FUNCTIONS) {
      const a = { fn: f.fn, p1: f.p1[0] ?? "", p2: f.p2[0] ?? "" };
      expect(normalizeUdk(a)).toEqual(a);
    }
  });
});

describe("diffDeviceSetup", () => {
  it("sends nothing when nothing changed", () => {
    expect(diffDeviceSetup(V, setup(), setup())).toEqual([]);
  });

  it("sends only what differs", () => {
    const writes = diffDeviceSetup(V, setup(), setup({ brightness: 4 }));
    expect(writes).toEqual([{ kind: "num", name: "BRIGHTNESS", y: 0, value: 4 }]);
  });

  it("writes a knob's three columns together, even when one changed", () => {
    const knobs = defaultDeviceSetup().knobs.slice();
    knobs[udkSlot(1, 2)] = { fn: "Monitor", p1: "Monitor 2", p2: "Level" };
    const writes = diffDeviceSetup(V, setup(), setup({ knobs }));
    expect(writes).toEqual([
      { kind: "str", name: "UDK_FUNCTION", y: 6, value: "Monitor" },
      { kind: "str", name: "UDK_PARAM1", y: 6, value: "Monitor 2" },
      { kind: "str", name: "UDK_PARAM2", y: 6, value: "Level" },
    ]);
  });

  it("skips pages the model does not have", () => {
    const next = setup({ hdcp: false, hdmiChannels: 1, dateFormat: 2, timeFormat: 1, timeZone: 0, brightness: 3 });
    const names = (model: (typeof MODELS)[number]): string[] =>
      diffDeviceSetup(getModel(model), setup(), next).map((w) => w.name);
    expect(names("URX44V")).toEqual([
      "BRIGHTNESS",
      "HDMI_HDCP",
      "HDMI_INPUT_CHANNELS",
      "DATE_FORMAT",
      "TIME_FORMAT",
      "TIME_ZONE",
    ]);
    expect(names("URX44")).toEqual(["BRIGHTNESS", "DATE_FORMAT", "TIME_FORMAT", "TIME_ZONE"]);
    expect(names("URX22")).toEqual(["BRIGHTNESS"]);
  });

  it("coerces on the way out, so an out-of-range draft cannot reach hardware", () => {
    // The broker stores an out-of-range Time Zone index verbatim rather than
    // clamping, so nothing downstream would catch it.
    const writes = diffDeviceSetup(V, setup(), setup({ timeZone: 9999 }));
    expect(writes).toEqual([{ kind: "num", name: "TIME_ZONE", y: 0, value: TIME_ZONE_CITIES.length - 1 }]);
  });

  it("normalizes an inconsistent triple before sending it", () => {
    const knobs = defaultDeviceSetup().knobs.slice();
    knobs[0] = { fn: "Oscillator", p1: "Phones 1", p2: "Level" };
    expect(diffDeviceSetup(V, setup(), setup({ knobs }))).toEqual([
      { kind: "str", name: "UDK_FUNCTION", y: 0, value: "Oscillator" },
      { kind: "str", name: "UDK_PARAM1", y: 0, value: "Level" },
      { kind: "str", name: "UDK_PARAM2", y: 0, value: "" },
    ]);
  });
});

describe("time zone table", () => {
  it("holds the anchors the unit reported at their measured indices", () => {
    // Index IS the value written to the device, so these two are the contract:
    // 139 is also the broker's default, and 140 was read off the unit's screen.
    expect(TIME_ZONE_CITIES[139]).toBe("Tokyo");
    expect(TIME_ZONE_CITIES[140]).toBe("Ulaan Bataar");
    expect(TIME_ZONE_CITIES[0]).toBe("Abu Dhabi");
    expect(TIME_ZONE_CITIES.at(-1)).toBe("Zagreb");
    expect(TIME_ZONE_CITIES).toHaveLength(154);
  });

  it("keeps the one non-alphabetical pair the unit has", () => {
    // Sorting the array would shift every index from 76 onward.
    expect(TIME_ZONE_CITIES[75]).toBe("La Paz (Mexico)");
    expect(TIME_ZONE_CITIES[76]).toBe("La Paz (Bolivia)");
    expect([...TIME_ZONE_CITIES]).not.toEqual([...TIME_ZONE_CITIES].sort());
  });

  it("has no duplicates (a repeat would make one index unreachable in a picker)", () => {
    expect(new Set(TIME_ZONE_CITIES).size).toBe(TIME_ZONE_CITIES.length);
  });
});

describe("udkSlot", () => {
  it("lays banks out contiguously across the 16 slots", () => {
    expect(udkSlot(0, 0)).toBe(0);
    expect(udkSlot(0, 3)).toBe(3);
    expect(udkSlot(1, 0)).toBe(4);
    expect(udkSlot(3, 3)).toBe(UDK_SLOTS - 1);
  });
});
