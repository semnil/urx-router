// The LCD simulator's SETUP > GENERAL paths over the unit's own settings (control/device-setup.ts),
// which the unit holds outside the plan: what the glass shows for a reading of them, and which
// field an edit on the glass changes.
import type { DeviceModel } from "../models/types";
import {
  AUTO_POWER_OFF_MAX,
  AUTO_POWER_OFF_MIN,
  BRIGHTNESS_MAX,
  BRIGHTNESS_MIN,
  DATE_FORMAT_LABELS,
  HDMI_CHANNEL_LABELS,
  setupSupport,
  TIME_FORMAT_LABELS,
  UDK_BANKS,
  UDK_FUNCTIONS,
  UDK_KNOBS,
  udkSlot,
  USB_SUPPRESSION_LABELS,
  type DeviceSetup,
  type UdkAssignment,
} from "./control/device-setup";
import { TIME_ZONE_CITIES } from "./control/timezones";
import type { SimValue } from "./sim-map-base";

/** The simulator's names for the unit's languages, by the unit's value. */
const LANGUAGES = ["English", "Japanese", "Chinese"];

/** The glass's path for the User Defined Knob at `slot`. */
const udkPath = (slot: number): string =>
  `setup.udk.${UDK_BANKS[Math.floor(slot / UDK_KNOBS.length)]}.${UDK_KNOBS[slot % UDK_KNOBS.length]}`;
const UDK_PATH = /^setup\.udk\.(\d)\.([A-D])$/;

/** The simulator's name for a knob assignment: the function and its parameters as the unit's
 *  readout prints them. */
function udkName(a: UdkAssignment): string {
  if (a.fn === "No Assign") return a.fn;
  return a.p2 ? `${a.p1} ${a.p2}` : `${a.fn} ${a.p1}`;
}

/** Every assignment the unit offers, by the simulator's name. */
const UDK_BY_NAME = new Map<string, UdkAssignment>(
  UDK_FUNCTIONS.flatMap((f) =>
    (f.p1.length ? f.p1 : [""]).map((p1): [string, UdkAssignment] => {
      const a = { fn: f.fn, p1, p2: f.p2[0] ?? "" };
      return [udkName(a), a];
    }),
  ),
);

/** What the glass shows for a reading of the unit's settings, path by path. A knob on a
 *  function the unit's catalog does not offer, and a time zone past the city list, are left out
 *  rather than shown as an entry the unit is not on. */
export function setupGlassValues(model: DeviceModel, setup: DeviceSetup): Map<string, SimValue> {
  const support = setupSupport(model);
  const out = new Map<string, SimValue>([
    ["setup.brightness", setup.brightness],
    ["setup.power.autoPowerOff", setup.autoPowerOff],
    ["setup.power.autoPowerOffMinutes", setup.autoPowerOffTime],
    ["setup.udk.bank", setup.knobBank + 1],
  ]);
  const label = (path: string, list: readonly string[], value: number): void => {
    const name = list[value];
    if (name !== undefined) out.set(path, name);
  };
  label("setup.language", LANGUAGES, setup.language);
  label("setup.peripheral.usbSuppression", USB_SUPPRESSION_LABELS, setup.usbSuppression);
  if (support.hdmi) {
    out.set("setup.peripheral.hdmiEnable", setup.hdcp);
    label("setup.peripheral.hdmiChannels", HDMI_CHANNEL_LABELS, setup.hdmiChannels);
  }
  if (support.dateTime) {
    label("setup.dateTime.dateFormat", DATE_FORMAT_LABELS, setup.dateFormat);
    label("setup.dateTime.timeFormat", TIME_FORMAT_LABELS, setup.timeFormat);
    label("setup.dateTime.timeZone", TIME_ZONE_CITIES, setup.timeZone);
  }
  setup.knobs.forEach((a, slot) => {
    const name = udkName(a);
    if (UDK_BY_NAME.has(name)) out.set(udkPath(slot), name);
  });
  return out;
}

/** Whether `path` is one of the unit's settings an edit on the glass changes on `model`. */
export function isSetupGlassPath(model: DeviceModel, path: string): boolean {
  return setupGlassEdit(model, path, undefined) !== null;
}

/**
 * The field an edit of `path` to `value` changes, `"refused"` for a value the unit does not take
 * there, or null for a path that is none of the unit's settings on `model`. The knob bank is not
 * one: the unit's bank is read and never written.
 */
export function setupGlassEdit(
  model: DeviceModel,
  path: string,
  value: SimValue | undefined,
): Partial<DeviceSetup> | "refused" | null {
  const support = setupSupport(model);
  const index = (list: readonly string[]): number | "refused" => {
    const i = typeof value === "string" ? list.indexOf(value) : -1;
    return i < 0 ? "refused" : i;
  };
  const within = (min: number, max: number): number | "refused" =>
    typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : "refused";
  const flag = (): boolean | "refused" => (typeof value === "boolean" ? value : "refused");
  const field = <K extends keyof DeviceSetup>(
    key: K,
    v: DeviceSetup[K] | "refused",
  ): Partial<DeviceSetup> | "refused" => (v === "refused" ? v : ({ [key]: v } as Partial<DeviceSetup>));
  switch (path) {
    case "setup.brightness":
      return field("brightness", within(BRIGHTNESS_MIN, BRIGHTNESS_MAX));
    case "setup.power.autoPowerOff":
      return field("autoPowerOff", flag());
    case "setup.power.autoPowerOffMinutes":
      return field("autoPowerOffTime", within(AUTO_POWER_OFF_MIN, AUTO_POWER_OFF_MAX));
    case "setup.language":
      return field("language", index(LANGUAGES));
    case "setup.peripheral.usbSuppression":
      return field("usbSuppression", index(USB_SUPPRESSION_LABELS));
    case "setup.peripheral.hdmiEnable":
      return support.hdmi ? field("hdcp", flag()) : null;
    case "setup.peripheral.hdmiChannels":
      return support.hdmi ? field("hdmiChannels", index(HDMI_CHANNEL_LABELS)) : null;
    case "setup.dateTime.dateFormat":
      return support.dateTime ? field("dateFormat", index(DATE_FORMAT_LABELS)) : null;
    case "setup.dateTime.timeFormat":
      return support.dateTime ? field("timeFormat", index(TIME_FORMAT_LABELS)) : null;
    case "setup.dateTime.timeZone":
      return support.dateTime ? field("timeZone", index(TIME_ZONE_CITIES)) : null;
  }
  const knob = UDK_PATH.exec(path);
  if (!knob) return null;
  const bank = UDK_BANKS.indexOf(Number(knob[1]) as (typeof UDK_BANKS)[number]);
  const slot = udkSlot(bank, UDK_KNOBS.indexOf(knob[2] as (typeof UDK_KNOBS)[number]));
  if (bank < 0) return null;
  const a = typeof value === "string" ? UDK_BY_NAME.get(value) : undefined;
  return a ? { knobs: knobEdit(slot, a) } : "refused";
}

/** A knob list carrying one assignment, for `withSetupEdit` to lay over a reading. */
function knobEdit(slot: number, a: UdkAssignment): UdkAssignment[] {
  const knobs: UdkAssignment[] = [];
  knobs[slot] = a;
  return knobs;
}

/** `setup` with an edit from `setupGlassEdit` laid over it. */
export function withSetupEdit(setup: DeviceSetup, edit: Partial<DeviceSetup>): DeviceSetup {
  const { knobs, ...rest } = edit;
  return {
    ...setup,
    ...rest,
    knobs: knobs ? setup.knobs.map((k, i) => knobs[i] ?? k) : setup.knobs,
  };
}
