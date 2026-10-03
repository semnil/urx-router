import { test, expect } from "./fixtures";
import type { Page } from "./fixtures";
import { chooseOption } from "./choose-option";
import { answerTimingOf, installAnswerQueue } from "./tauri-stub";
import { en } from "../src/i18n/en";

// A native save / image export that fails after the dialog returned a path must
// surface as an error dialog, keep the plan dirty and show no success status — a
// silently dropped rejection would read as a successful save. Bespoke stub (like
// midi.spec.ts): the shared stubTauriBoot serves constants only, and these flows
// need rejecting write commands plus a dialog sink recording the shown messages.
// Each command is recorded when it is sent and answered on a later task, through the
// queue the shared stubs settle through, as the shell's IPC answers.

async function stubFailingWrites(page: Page): Promise<void> {
  await page.addInitScript(installAnswerQueue);
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-model", "URX44V");
    localStorage.setItem("urx-disclaimer-accepted", "1"); // skip the consent gate
    const constants: Record<string, unknown> = {
      experimental_enabled: false,
      self_test_requested: false,
      reset_storage_requested: false,
      "plugin:updater|check": null,
      "plugin:dialog|save": "/tmp/urx-e2e-out",
    };
    const dialogs: string[] = [];
    (window as unknown as { __urxDialogs: string[] }).__urxDialogs = dialogs;
    const internals = {
      Channel: class {
        onmessage: (data: unknown) => void = () => {};
      },
      invoke: (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
        if (cmd === "plugin:dialog|message") {
          dialogs.push(String(args?.message ?? ""));
          return Promise.resolve("Ok");
        }
        if (cmd === "write_text_file" || cmd === "write_binary_file") return Promise.reject(new Error("disk full"));
        return cmd in constants
          ? Promise.resolve(constants[cmd])
          : Promise.reject(new Error(`stub: unhandled command ${cmd}`));
      },
    };
    // The table above records and answers a command when it is sent; the answer itself
    // settles through the queue.
    const answer = internals.invoke;
    internals.invoke = (cmd, args) => window.__urxAnswerLater(answer(cmd, args));
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = internals;
  });
}

function shownDialogs(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __urxDialogs: string[] }).__urxDialogs);
}

test.beforeEach(async ({ page }) => {
  await stubFailingWrites(page);
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("this spec's stub answers each command on a later task, in the order asked", async ({ page }) => {
  const cmds = ["experimental_enabled", "write_text_file", "stub_unknown_command"];
  expect(await answerTimingOf(page, cmds)).toEqual({ inSendingTask: [], order: cmds });
});

test("a failed native save shows an error and keeps the plan dirty (Tauri)", async ({ page }) => {
  // Dirty the plan (the rate change funnels through markChanged), then save.
  await chooseOption(page.locator("#rate-picker"), "96000");
  await page.click("#btn-file");
  await page.click("#btn-save");

  // The write rejection surfaces as a modal, and no success status is shown.
  await expect.poll(() => shownDialogs(page)).toContainEqual(expect.stringContaining("Save error:"));
  expect(await shownDialogs(page)).toContainEqual(expect.stringContaining("disk full"));
  // Neither success message is on the status line; the dialog answers a path, so a save
  // that went through would name the file.
  for (const saved of [en.status.savedTo("urx-e2e-out"), en.status.planSaved])
    await expect(page.locator("#statusbar")).not.toContainText(saved);

  // The plan stayed dirty: creating a new plan asks to discard the changes.
  await page.click("#btn-file");
  await page.click("#btn-new");
  await expect.poll(() => shownDialogs(page)).toContainEqual(expect.stringContaining("unsaved changes"));
});

test("a failed PNG export shows an error dialog (Tauri)", async ({ page }) => {
  await page.click("#btn-file");
  await page.click("#btn-export");
  await expect.poll(() => shownDialogs(page)).toContainEqual(expect.stringContaining("Export error:"));
});
