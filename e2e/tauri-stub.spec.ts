import { test, expect, type Page } from "./fixtures";
import { answerTimingOf, stubTauriBoot, stubTauriDevice } from "./tauri-stub";

// The shell answers a command on a later task, never in the microtasks of the task that sent it,
// and in the order the commands were asked. Both shared stubs answer the same way, refusals
// included, so a case is not run against an order the app never meets.
const STUBS: Array<[string, (page: Page) => Promise<void>]> = [
  ["stubTauriBoot", (page) => stubTauriBoot(page)],
  ["stubTauriDevice", (page) => stubTauriDevice(page)],
];

for (const [name, stub] of STUBS) {
  test(`${name} answers each command on a later task, in the order asked`, async ({ page }) => {
    await stub(page);
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    const cmds = ["experimental_enabled", "stub_unknown_command", "reset_storage_requested"];
    expect(await answerTimingOf(page, cmds)).toEqual({ inSendingTask: [], order: cmds });
  });
}
