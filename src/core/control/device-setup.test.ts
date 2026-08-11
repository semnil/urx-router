import { beforeEach, describe, expect, it, vi } from "vitest";

// The read/send halves talk to the device through platform's four vd primitives;
// everything else in this file is pure, so mock only those.
vi.mock("../platform", () => ({ vdGet: vi.fn(), vdSet: vi.fn(), vdGetStr: vi.fn(), vdSetStr: vi.fn() }));

import { vdGet, vdGetStr, vdSet, vdSetStr } from "../platform";
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
  readDeviceSetup,
  sendDeviceSetup,
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

describe("readDeviceSetup", () => {
  const numFor = new Map<number, number>();
  const strFor = new Map<string, string>();

  beforeEach(() => {
    vi.mocked(vdGet).mockReset();
    vi.mocked(vdGetStr).mockReset();
    vi.mocked(vdSet).mockReset();
    vi.mocked(vdSetStr).mockReset();
    numFor.clear();
    strFor.clear();
    vi.mocked(vdGet).mockImplementation((id) => Promise.resolve(numFor.get(id) ?? 0));
    vi.mocked(vdGetStr).mockImplementation((id, _x, y) =>
      Promise.resolve(strFor.get(`${id}:${y}`) ?? UDK_UNASSIGNED.fn),
    );
  });

  it("reads every global the model has, one blocking round trip each", async () => {
    numFor.set(PARAMS.BRIGHTNESS.id, 5);
    numFor.set(PARAMS.AUTO_POWER_OFF.id, 1);
    numFor.set(PARAMS.AUTO_POWER_OFF_TIME.id, 120);
    numFor.set(PARAMS.DEVICE_LANGUAGE.id, 1);
    numFor.set(PARAMS.USB_SUPPRESSION.id, 1);
    numFor.set(PARAMS.HDMI_HDCP.id, 1);
    numFor.set(PARAMS.HDMI_INPUT_CHANNELS.id, 2);
    numFor.set(PARAMS.DATE_FORMAT.id, 1);
    numFor.set(PARAMS.TIME_FORMAT.id, 1);
    numFor.set(PARAMS.TIME_ZONE.id, 30);

    const setup = await readDeviceSetup(V);
    expect(setup).toMatchObject({
      brightness: 5,
      autoPowerOff: true,
      autoPowerOffTime: 120,
      language: 1,
      usbSuppression: 1,
      hdcp: true,
      hdmiChannels: 2,
      dateFormat: 1,
      timeFormat: 1,
      timeZone: 30,
    });
    expect(setup.knobs).toHaveLength(UDK_SLOTS);
  });

  // Booleans come back as broker numbers; anything non-zero is on.
  it("reads a zero toggle as off", async () => {
    numFor.set(PARAMS.AUTO_POWER_OFF.id, 0);
    numFor.set(PARAMS.HDMI_HDCP.id, 0);
    const setup = await readDeviceSetup(V);
    expect(setup.autoPowerOff).toBe(false);
    expect(setup.hdcp).toBe(false);
  });

  // Every read is a blocking round trip, so it is worth not asking for values that
  // cannot be used: a model with no HDMI and no SD skips both pages.
  it("skips the pages the model is not fitted with", async () => {
    const model = getModel("URX22");
    expect(setupSupport(model)).toEqual({ hdmi: false, dateTime: false });
    await readDeviceSetup(model);
    const asked = vi.mocked(vdGet).mock.calls.map(([id]) => id);
    for (const name of ["HDMI_HDCP", "HDMI_INPUT_CHANNELS", "DATE_FORMAT", "TIME_FORMAT", "TIME_ZONE"] as const) {
      expect(asked).not.toContain(PARAMS[name].id);
    }
    expect(asked).toContain(PARAMS.BRIGHTNESS.id);
  });

  // Parameter 1 only carries information where the function offers a choice, and
  // Parameter 2 never offers more than one value — reading either elsewhere would
  // cost a round trip for a value normalizeUdk discards.
  it("reads a knob's parameter column only where the function offers a choice", async () => {
    const fnId = PARAMS.UDK_FUNCTION.id;
    strFor.set(`${fnId}:0`, "Monitor");
    strFor.set(`${fnId}:1`, "Brightness");
    strFor.set(`${PARAMS.UDK_PARAM1.id}:0`, "Monitor 2");

    const setup = await readDeviceSetup(V);
    expect(setup.knobs[0]).toEqual({ fn: "Monitor", p1: "Monitor 2", p2: "Level" });
    expect(setup.knobs[1]).toEqual({ fn: "Brightness", p1: "Screen", p2: "" });

    const p1Reads = vi.mocked(vdGetStr).mock.calls.filter(([id]) => id === PARAMS.UDK_PARAM1.id);
    expect(p1Reads.map(([, , y]) => y)).toEqual([0]);
    expect(vi.mocked(vdGetStr).mock.calls.filter(([id]) => id === PARAMS.UDK_PARAM2.id)).toHaveLength(0);
  });

  // On a factory unit every knob is No Assign, which skips the parameter reads
  // entirely — the saving the split above exists for.
  it("reads no parameter column at all on a factory unit", async () => {
    await readDeviceSetup(V);
    expect(vi.mocked(vdGetStr).mock.calls.every(([id]) => id === PARAMS.UDK_FUNCTION.id)).toBe(true);
  });

  // The device right-pads its stored strings; a leading space would be the device's
  // own spelling if it ever used one.
  it("trims the device's right padding but not a leading space", async () => {
    strFor.set(`${PARAMS.UDK_FUNCTION.id}:0`, "Oscillator   ");
    const setup = await readDeviceSetup(V);
    expect(setup.knobs[0].fn).toBe("Oscillator");
  });

  it("reduces a function the catalog does not have to No Assign", async () => {
    strFor.set(`${PARAMS.UDK_FUNCTION.id}:0`, "Warp Drive");
    const setup = await readDeviceSetup(V);
    expect(setup.knobs[0]).toEqual({ ...UDK_UNASSIGNED });
  });

  // A partial read cannot be diffed against without inviting a write of values that
  // were never established.
  it("rejects on the first failure rather than reporting a partial screen", async () => {
    vi.mocked(vdGet).mockImplementation((id) =>
      id === PARAMS.DEVICE_LANGUAGE.id ? Promise.reject(new Error("timeout")) : Promise.resolve(0),
    );
    await expect(readDeviceSetup(V)).rejects.toThrow("timeout");
    expect(vi.mocked(vdGetStr)).not.toHaveBeenCalled();
  });
});

describe("sendDeviceSetup", () => {
  beforeEach(() => {
    vi.mocked(vdSet).mockReset().mockResolvedValue(undefined);
    vi.mocked(vdSetStr).mockReset().mockResolvedValue(undefined);
  });

  it("routes each write to the transport its kind names, in order", async () => {
    await sendDeviceSetup([
      { kind: "num", name: "BRIGHTNESS", y: 0, value: 3 },
      { kind: "str", name: "UDK_FUNCTION", y: 2, value: "Phones" },
    ]);
    expect(vi.mocked(vdSet).mock.calls).toEqual([[PARAMS.BRIGHTNESS.id, 0, 0, 3]]);
    expect(vi.mocked(vdSetStr).mock.calls).toEqual([[PARAMS.UDK_FUNCTION.id, 0, 2, "Phones"]]);
  });

  // Order matters within a knob's triple, and stopping keeps the unit in a state the
  // operator can re-apply from: the next read shows what landed.
  it("stops at the first failure instead of writing past it", async () => {
    vi.mocked(vdSet).mockRejectedValue(new Error("nak"));
    await expect(
      sendDeviceSetup([
        { kind: "num", name: "BRIGHTNESS", y: 0, value: 3 },
        { kind: "num", name: "TIME_ZONE", y: 0, value: 1 },
      ]),
    ).rejects.toThrow("nak");
    expect(vi.mocked(vdSet)).toHaveBeenCalledTimes(1);
  });

  it("writes nothing for an empty change set", async () => {
    await sendDeviceSetup([]);
    expect(vi.mocked(vdSet)).not.toHaveBeenCalled();
    expect(vi.mocked(vdSetStr)).not.toHaveBeenCalled();
  });
});
