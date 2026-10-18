import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { LIVE_COMMANDS, heldReadsOf, setHeldReads, stubTauriDevice, writesOf } from "./tauri-stub";
import { PARAMS } from "../src/core/control/params";
import { buildUrxf } from "../src/core/control/urxf.test-util";
import type { Field } from "../src/core/control/urxf.test-util";
import { en } from "../src/i18n/en";

// A settings file imported during Live sync is an edit: the session writes what it carries, and an
// undo and a redo take it back off the unit and put it back as one step. The import is armed by an
// experimental launch, which the stub reports.

/** The file moves CH 1's input source off the jack the unit holds, and carries `more` besides. */
const settingsFile = (more: Field[] = []): number[] => [
  ...buildUrxf([
    {
      chunk: "CURRENT",
      block: "CSF_BACKUP",
      label: "",
      fields: [{ id: PARAMS.INPUT_SOURCE.id, typecode: 1, elemSize: 4, values: [0x80000100] }, ...more],
    },
  ]),
];

/** A session up on a unit at 48 kHz with Follow USB `followUsb`, the import armed with `file`, and
 *  every confirm answered Ok. */
const liveWith = async (page: Page, file: number[], followUsb: 0 | 1): Promise<void> => {
  await stubTauriDevice(page, {
    confirm: "Ok",
    values: { [PARAMS.SAMPLE_RATE.id]: 48_000, [PARAMS.FOLLOW_USB.id]: followUsb },
    commands: {
      ...LIVE_COMMANDS,
      experimental_enabled: true,
      "plugin:dialog|open": "/urx/backup.urxf",
      read_binary_file: file,
      "plugin:dialog|save": null,
    },
  });
  await page.goto("/");
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true");
};

const importFile = async (page: Page): Promise<void> => {
  await page.click("#btn-file");
  await page.click("#btn-open-settings");
};

/** The values written to `paramId`, in order. */
const written = async (page: Page, paramId: number): Promise<number[]> =>
  (await writesOf(page)).filter(([id]) => id === paramId).map(([, value]) => value);
const sources = (page: Page): Promise<number[]> => written(page, PARAMS.INPUT_SOURCE.id);

// A follow read in flight refuses the press and leaves the step where it was, so the same press goes
// again.
const press = (page: Page, key: string): Promise<void> =>
  expect
    .poll(async () => {
      await page.keyboard.press(key);
      return page.locator("#statusbar").textContent();
    })
    .not.toBe(en.status.undoDeviceBusy);

test("a settings file imported during Live sync is one undo step the session writes", async ({ page }) => {
  await liveWith(page, settingsFile(), 0);
  // The whole-device read the import's write arms is held at the oscillator, so it cannot merge
  // and redraw the board's flags before they are counted.
  await setHeldReads(page, [PARAMS.OSC_ON.id]);
  await importFile(page);
  await expect.poll(() => sources(page)).toEqual([256]);
  await expect.poll(() => heldReadsOf(page)).toBeGreaterThan(0);
  // The nodes the file does not carry hold what the session read from the unit: none is flagged.
  expect(await page.locator("#graph-host g.node text", { hasText: /^\?$/ }).count(), "nodes flagged unread").toBe(0);
  await setHeldReads(page, []);

  await press(page, "ControlOrMeta+z");
  await expect.poll(() => sources(page)).toEqual([256, 0]);
  await press(page, "ControlOrMeta+Shift+z");
  await expect.poll(() => sources(page)).toEqual([256, 0, 256]);
});
