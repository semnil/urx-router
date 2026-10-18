import { test, expect } from "./fixtures";
import { LIVE_COMMANDS, stubTauriDevice, writesOf } from "./tauri-stub";
import { PARAMS } from "../src/core/control/params";
import { buildUrxf } from "../src/core/control/urxf.test-util";
import { en } from "../src/i18n/en";

// A settings file imported during Live sync is an edit: the session writes what it carries, and an
// undo and a redo take it back off the unit and put it back as one step. The import is armed by an
// experimental launch, which the stub reports.

test("a settings file imported during Live sync is one undo step the session writes", async ({ page }) => {
  // The file moves CH 1's input source off the jack the unit holds, and carries nothing else.
  const file = buildUrxf([
    {
      chunk: "CURRENT",
      block: "CSF_BACKUP",
      label: "",
      fields: [{ id: PARAMS.INPUT_SOURCE.id, typecode: 1, elemSize: 4, values: [0x80000100] }],
    },
  ]);
  await stubTauriDevice(page, {
    confirm: "Ok",
    values: { [PARAMS.SAMPLE_RATE.id]: 48_000, [PARAMS.FOLLOW_USB.id]: 0 },
    commands: {
      ...LIVE_COMMANDS,
      experimental_enabled: true,
      "plugin:dialog|open": "/urx/backup.urxf",
      read_binary_file: [...file],
      "plugin:dialog|save": null,
    },
  });
  await page.goto("/");
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true");

  const sources = async (): Promise<number[]> =>
    (await writesOf(page)).filter(([id]) => id === PARAMS.INPUT_SOURCE.id).map(([, value]) => value);
  await page.click("#btn-file");
  await page.click("#btn-open-settings");
  await expect.poll(sources).toEqual([256]);

  // A follow read in flight refuses the press and leaves the step where it was, so the same press
  // goes again.
  const press = (key: string): Promise<void> =>
    expect
      .poll(async () => {
        await page.keyboard.press(key);
        return page.locator("#statusbar").textContent();
      })
      .not.toBe(en.status.undoDeviceBusy);
  await press("ControlOrMeta+z");
  await expect.poll(sources).toEqual([256, 0]);
  await press("ControlOrMeta+Shift+z");
  await expect.poll(sources).toEqual([256, 0, 256]);
});
