// SETUP > GENERAL — the unit's device-wide utility settings, read and written
// directly rather than through the plan.
//
// These belong to the unit, not to a routing plan: a plan travels as a file, a
// recent-files entry and a share URL, and `planToCommands` writes absolute state,
// so carrying them would push one operator's screen brightness, menu language,
// power-off timer and knob assignments onto another operator's hardware. They are
// catalogued in params.ts (the one place an address may be written down) but no
// translate/readback group covers them; this module is their whole surface, in the
// shape Follow USB (848) already established: bare vdGet / vdSet, no diff engine,
// no snapshot.
//
// Reads and writes are sequential and abort on the first failure, per the standing
// device-link rule: a half-read screen would invite the operator to "apply" a diff
// against values that were never established.

import type { DeviceModel } from "../../models/types";
import { vdGet, vdGetStr, vdSet, vdSetStr } from "../platform";
import { PARAMS } from "./params";
import type { ParamName } from "./params";
import { clamp } from "./vd";
import { TIME_ZONE_CITIES } from "./timezones";

/** Screen brightness, as the unit's own menu offers it. The dump's minimum is 0,
 *  which the unit never shows; 0 is untested and the screen is the only way back
 *  from a dark screen, so the app's floor is the menu's floor. */
export const BRIGHTNESS_MIN = 1;
export const BRIGHTNESS_MAX = 10;

/** Auto Power Off idle time, in minutes ("2–20 minutes in one-minute increments,
 *  the default setting is 20 minutes"). The dump's max of 255 is not a device range. */
export const AUTO_POWER_OFF_MIN = 2;
export const AUTO_POWER_OFF_MAX = 20;

/** User Defined Knobs: banks 1–4 × knobs A–D, addressed as one flat y = 0..15. */
export const UDK_BANKS = [1, 2, 3, 4] as const;
export const UDK_KNOBS = ["A", "B", "C", "D"] as const;
export const UDK_SLOTS = UDK_BANKS.length * UDK_KNOBS.length;

/** y for a bank/knob pair. Banks are contiguous: bank 1 holds y 0..3. */
export function udkSlot(bankIndex: number, knobIndex: number): number {
  return bankIndex * UDK_KNOBS.length + knobIndex;
}

/** One knob's assignment. The device stores the three columns as free-form strings
 *  and validates nothing, so the exact user-guide spelling is this app's job. */
export interface UdkAssignment {
  fn: string;
  p1: string;
  p2: string;
}

/** The assignable functions and the values each one allows in its two parameter
 *  columns, from the user guide's "Functions that can be assigned to the user
 *  defined knobs". An empty column means the function takes no such parameter. */
export const UDK_FUNCTIONS: readonly { fn: string; p1: readonly string[]; p2: readonly string[] }[] = [
  { fn: "No Assign", p1: [], p2: [] },
  { fn: "Brightness", p1: ["Screen"], p2: [] },
  { fn: "Monitor", p1: ["Monitor 1", "Monitor 2"], p2: ["Level"] },
  { fn: "Phones", p1: ["Phones 1", "Phones 2"], p2: ["Level"] },
  { fn: "Oscillator", p1: ["Level"], p2: [] },
];

export const UDK_UNASSIGNED: UdkAssignment = { fn: "No Assign", p1: "", p2: "" };

/** Force a triple onto the catalog: an unknown function becomes No Assign, and each
 *  parameter column is either the first legal value or empty. The device accepts an
 *  inconsistent triple verbatim and keeps showing it, so every write goes through here. */
export function normalizeUdk(a: UdkAssignment): UdkAssignment {
  const entry = UDK_FUNCTIONS.find((f) => f.fn === a.fn);
  if (!entry || entry.fn === UDK_UNASSIGNED.fn) return { ...UDK_UNASSIGNED };
  const p1 = entry.p1.includes(a.p1) ? a.p1 : (entry.p1[0] ?? "");
  const p2 = entry.p2.includes(a.p2) ? a.p2 : (entry.p2[0] ?? "");
  return { fn: entry.fn, p1, p2 };
}

// Enum choices, labelled with the strings the unit itself shows and kept here
// beside the addresses rather than in i18n — the same place fx-effect.ts and
// insert-fx-effect.ts keep their device enum labels. Each list is indexed BY the
// device value, so position is the encoding; nothing else pairs the two.
export const HDMI_CHANNEL_LABELS = ["2 Channels", "Multi Channels"];
export const USB_SUPPRESSION_LABELS = ["None", "2 Channels"];
export const DATE_FORMAT_LABELS = ["MM/DD/YYYY", "DD/MM/YYYY", "YYYY/MM/DD"];
export const TIME_FORMAT_LABELS = ["24h", "12h"];
export const DEVICE_LANGUAGE_LABELS = ["English", "日本語", "简体中文"];

/** Auto Power Off idle times the unit offers, in minutes. */
export const AUTO_POWER_OFF_TIMES = Array.from(
  { length: AUTO_POWER_OFF_MAX - AUTO_POWER_OFF_MIN + 1 },
  (_, i) => AUTO_POWER_OFF_MIN + i,
);

/** Every value the screen holds. Fields the model does not have are still present
 *  (the row renders locked, showing what the unit would report) but are neither read
 *  nor written — see `setupSupport`. */
export interface DeviceSetup {
  brightness: number;
  autoPowerOff: boolean;
  autoPowerOffTime: number;
  hdcp: boolean;
  hdmiChannels: number;
  dateFormat: number;
  timeFormat: number;
  timeZone: number;
  language: number;
  usbSuppression: number;
  knobs: UdkAssignment[];
}

/** Which SETUP pages the model actually has, derived from the hardware it is fitted
 *  with rather than from a second list of model ids: the HDMI page needs the HDMI
 *  input, and the Date/Time menu exists to date-stamp microSD recordings, so a model
 *  without the recorder has no such menu. */
export interface SetupSupport {
  hdmi: boolean;
  dateTime: boolean;
}

export function setupSupport(model: DeviceModel): SetupSupport {
  return { hdmi: model.hasHDMI, dateTime: model.hasSD };
}

/** The value a screen starts from before a device is read: the factory settings, so
 *  a locked or unread row shows something defined rather than zero. */
export function defaultDeviceSetup(): DeviceSetup {
  return {
    brightness: BRIGHTNESS_MAX,
    autoPowerOff: true,
    autoPowerOffTime: AUTO_POWER_OFF_MAX,
    hdcp: true,
    hdmiChannels: 0,
    dateFormat: 0,
    timeFormat: 0,
    timeZone: 139,
    language: 0,
    usbSuppression: 0,
    knobs: Array.from({ length: UDK_SLOTS }, () => ({ ...UDK_UNASSIGNED })),
  };
}

/** Bring a value into range on the way out to hardware. The last line before a
 *  write, matching translate.ts's coercion: the broker stores an out-of-range Time
 *  Zone index verbatim instead of clamping, so nothing downstream will catch it. */
export function coerceDeviceSetup(s: DeviceSetup): DeviceSetup {
  return {
    ...s,
    brightness: clamp(Math.round(s.brightness), BRIGHTNESS_MIN, BRIGHTNESS_MAX),
    autoPowerOffTime: clamp(Math.round(s.autoPowerOffTime), AUTO_POWER_OFF_MIN, AUTO_POWER_OFF_MAX),
    hdmiChannels: clamp(Math.round(s.hdmiChannels), 0, HDMI_CHANNEL_LABELS.length - 1),
    dateFormat: clamp(Math.round(s.dateFormat), 0, DATE_FORMAT_LABELS.length - 1),
    timeFormat: clamp(Math.round(s.timeFormat), 0, TIME_FORMAT_LABELS.length - 1),
    timeZone: clamp(Math.round(s.timeZone), 0, TIME_ZONE_CITIES.length - 1),
    language: clamp(Math.round(s.language), 0, DEVICE_LANGUAGE_LABELS.length - 1),
    usbSuppression: clamp(Math.round(s.usbSuppression), 0, USB_SUPPRESSION_LABELS.length - 1),
    knobs: s.knobs.map(normalizeUdk),
  };
}

/** One pending hardware write. `y` is the parameter instance (0 for every global,
 *  the knob slot for the User Defined Knobs strings). */
export type SetupWrite =
  | { kind: "num"; name: ParamName; y: number; value: number }
  | { kind: "str"; name: ParamName; y: number; value: string };

/** Read the whole screen from the connected device. Rejects on the first failure:
 *  a partial read cannot be diffed against without inviting a write of values that
 *  were never established. */
export async function readDeviceSetup(model: DeviceModel): Promise<DeviceSetup> {
  const support = setupSupport(model);
  const setup = defaultDeviceSetup();
  // Every read is a blocking round trip: the vd protocol carries no request id, so
  // the worker completes one command before dequeuing the next and there is nothing
  // to parallelize. That makes it worth not asking for values that cannot be used.
  const num = async (name: ParamName, y = 0): Promise<number> => vdGet(PARAMS[name].id, 0, y);
  // trimEnd, not trim: the device right-pads its stored strings, and a leading space
  // would be the device's own spelling if it ever used one.
  const str = async (name: ParamName, y: number): Promise<string> => (await vdGetStr(PARAMS[name].id, 0, y)).trimEnd();

  setup.brightness = await num("BRIGHTNESS");
  setup.autoPowerOff = (await num("AUTO_POWER_OFF")) !== 0;
  setup.autoPowerOffTime = await num("AUTO_POWER_OFF_TIME");
  setup.language = await num("DEVICE_LANGUAGE");
  setup.usbSuppression = await num("USB_SUPPRESSION");
  if (support.hdmi) {
    setup.hdcp = (await num("HDMI_HDCP")) !== 0;
    setup.hdmiChannels = await num("HDMI_INPUT_CHANNELS");
  }
  if (support.dateTime) {
    setup.dateFormat = await num("DATE_FORMAT");
    setup.timeFormat = await num("TIME_FORMAT");
    setup.timeZone = await num("TIME_ZONE");
  }
  for (let y = 0; y < UDK_SLOTS; y++) {
    const fn = await str("UDK_FUNCTION", y);
    const entry = UDK_FUNCTIONS.find((f) => f.fn === fn);
    // Parameter 1 only carries information where the function offers a choice
    // (Monitor / Phones); elsewhere — and for Parameter 2, which never offers more
    // than one value — normalizeUdk would overwrite whatever came back, so reading
    // it would cost a round trip for a value that is discarded. On a factory unit
    // (every knob No Assign) that skips 32 of the 58 reads this screen makes.
    const p1 = entry && entry.p1.length > 1 ? await str("UDK_PARAM1", y) : "";
    setup.knobs[y] = normalizeUdk({ fn, p1, p2: "" });
  }
  return setup;
}

/** Which row a change belongs to: a scalar field, or one User Defined Knobs slot. */
export type SetupField = Exclude<keyof DeviceSetup, "knobs"> | `knob${number}`;

export const knobField = (slot: number): SetupField => `knob${slot}`;

/** One thing the operator changed, the row it belongs to, and the writes it takes.
 *  A knob is one change worth three writes — counting writes would report "3
 *  unapplied changes" for a single dropdown. The screen counts these, marks the
 *  named rows, and sends the flattened writes, so what is highlighted, what is
 *  counted and what is written cannot drift apart. */
export interface SetupChange {
  field: SetupField;
  writes: SetupWrite[];
}

/** What applying `next` would send, given what the device reported as `current`.
 *  Only differences are written, so an unchanged screen sends nothing at all.
 *  Fields the model does not have are skipped: their rows are locked, and writing
 *  a page the unit does not have is a guess about hardware. */
export function deviceSetupChanges(model: DeviceModel, current: DeviceSetup, next: DeviceSetup): SetupChange[] {
  const support = setupSupport(model);
  const to = coerceDeviceSetup(next);
  const from = coerceDeviceSetup(current);
  const changes: SetupChange[] = [];
  const num = (field: SetupField, name: ParamName, a: number, b: number): void => {
    if (a !== b) changes.push({ field, writes: [{ kind: "num", name, y: 0, value: b }] });
  };

  num("brightness", "BRIGHTNESS", from.brightness, to.brightness);
  num("autoPowerOff", "AUTO_POWER_OFF", from.autoPowerOff ? 1 : 0, to.autoPowerOff ? 1 : 0);
  num("autoPowerOffTime", "AUTO_POWER_OFF_TIME", from.autoPowerOffTime, to.autoPowerOffTime);
  num("language", "DEVICE_LANGUAGE", from.language, to.language);
  num("usbSuppression", "USB_SUPPRESSION", from.usbSuppression, to.usbSuppression);
  if (support.hdmi) {
    num("hdcp", "HDMI_HDCP", from.hdcp ? 1 : 0, to.hdcp ? 1 : 0);
    num("hdmiChannels", "HDMI_INPUT_CHANNELS", from.hdmiChannels, to.hdmiChannels);
  }
  if (support.dateTime) {
    num("dateFormat", "DATE_FORMAT", from.dateFormat, to.dateFormat);
    num("timeFormat", "TIME_FORMAT", from.timeFormat, to.timeFormat);
    num("timeZone", "TIME_ZONE", from.timeZone, to.timeZone);
  }
  for (let y = 0; y < UDK_SLOTS; y++) {
    const a = from.knobs[y] ?? UDK_UNASSIGNED;
    const b = to.knobs[y] ?? UDK_UNASSIGNED;
    // All three columns go together or none do. The device does not reconcile a
    // partial write: writing only the function leaves the old parameters beside it,
    // and the unit then shows a triple no menu could have produced.
    if (a.fn !== b.fn || a.p1 !== b.p1 || a.p2 !== b.p2) {
      changes.push({
        field: knobField(y),
        writes: [
          { kind: "str", name: "UDK_FUNCTION", y, value: b.fn },
          { kind: "str", name: "UDK_PARAM1", y, value: b.p1 },
          { kind: "str", name: "UDK_PARAM2", y, value: b.p2 },
        ],
      });
    }
  }
  return changes;
}

/** The writes those changes imply, in order. */
export function diffDeviceSetup(model: DeviceModel, current: DeviceSetup, next: DeviceSetup): SetupWrite[] {
  return deviceSetupChanges(model, current, next).flatMap((c) => c.writes);
}

/** Send the writes in order, stopping at the first failure. Order matters within a
 *  knob's triple, and stopping keeps the unit in a state the operator can re-apply
 *  from: the next read shows what landed, and the diff is computed again. */
export async function sendDeviceSetup(writes: SetupWrite[]): Promise<void> {
  for (const w of writes) {
    const id = PARAMS[w.name].id;
    if (w.kind === "num") await vdSet(id, 0, w.y, w.value);
    else await vdSetStr(id, 0, w.y, w.value);
  }
}
