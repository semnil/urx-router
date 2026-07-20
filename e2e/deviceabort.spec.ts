import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

// The device paths abort rather than continue once a premise has failed: a write
// whose diff could not be read never writes, a unit whose firmware version could
// not be read is not touched at all, and a send that stops part-way offers a
// retry instead of a breakdown the user cannot act on. Bespoke stub (like
// saveerror.spec.ts): stubTauriBoot serves constants only, and these flows need
// per-command handlers plus a dialog sink recording what was shown.

interface StubOptions {
  /** null = the firmware read did not land (the Q-1 gate). */
  firmware?: string | null;
  /** Reject every vd_get, so the write's diff cannot establish device values. */
  failReads?: boolean;
  /** Reject every vd_set after this many succeed, so the send stops part-way. */
  writesBeforeFailure?: number;
}

async function stubDevice(page: Page, opts: StubOptions = {}): Promise<void> {
  await page.addInitScript((o: StubOptions) => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-model", "URX44V");
    localStorage.setItem("urx-disclaimer-accepted", "1"); // skip the consent gate
    const constants: Record<string, unknown> = {
      experimental_enabled: false,
      self_test_requested: false,
      reset_storage_requested: false,
      "plugin:updater|check": null,
      vd_disconnect: null,
      vd_set_str: null,
      vd_get_str: "",
    };
    const dialogs: string[] = [];
    let writes = 0;
    let sets = 0;
    const w = window as unknown as { __urxDialogs: string[]; __urxSets: () => number };
    w.__urxDialogs = dialogs;
    w.__urxSets = () => sets;
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      Channel: class {
        onmessage: (data: unknown) => void = () => {};
      },
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "plugin:dialog|message") {
          dialogs.push(String(args?.message ?? ""));
          // Decline every confirm: a test that reaches one has already failed to
          // abort, so agreeing would mask the very thing under test.
          return Promise.resolve("Cancel");
        }
        if (cmd === "vd_connect") {
          return Promise.resolve({
            model: "URX44V",
            label: "URX44V",
            firmware: o.firmware === undefined ? "1.3.0.1" : o.firmware,
            epoch: 1,
          });
        }
        if (cmd === "vd_get") {
          return o.failReads ? Promise.reject(new Error("read timeout")) : Promise.resolve(0);
        }
        if (cmd === "vd_set") {
          sets++;
          writes++;
          if (o.writesBeforeFailure !== undefined && writes > o.writesBeforeFailure) {
            return Promise.reject(new Error("device nak"));
          }
          return Promise.resolve(null);
        }
        return cmd in constants
          ? Promise.resolve(constants[cmd])
          : Promise.reject(new Error(`stub: unhandled command ${cmd}`));
      },
    };
  }, opts);
}

const dialogsOf = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __urxDialogs: string[] }).__urxDialogs);
const setsOf = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __urxSets: () => number }).__urxSets());

test("a write whose diff cannot be read is canceled before anything is sent", async ({ page }) => {
  await stubDevice(page, { failReads: true });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");

  await page.click("#btn-device"); // the device actions live in a menu
  await page.click("#btn-write");

  await expect(page.locator("#statusbar")).toContainText("Write canceled");
  await expect(page.locator("#statusbar")).toContainText("could not be read");
  // The abort happens before the confirm, so nothing reached the device.
  expect(await setsOf(page)).toBe(0);
  expect(await dialogsOf(page)).not.toContainEqual(expect.stringContaining("Write "));
});

test("a unit whose firmware version could not be read is not touched", async ({ page }) => {
  await stubDevice(page, { firmware: null });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");

  await page.click("#btn-device"); // the device actions live in a menu
  await page.click("#btn-fetch");

  await expect
    .poll(() => dialogsOf(page))
    .toContainEqual(expect.stringContaining("firmware version could not be read"));
  expect(await setsOf(page)).toBe(0);
});

test("a device that reports no firmware version is still usable", async ({ page }) => {
  // Empty is not the same as unread: the unit answered, it just has no System
  // entry, which disables the mismatch warning by design rather than blocking.
  await stubDevice(page, { firmware: "" });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");

  await page.click("#btn-device"); // the device actions live in a menu
  await page.click("#btn-fetch");

  await expect.poll(() => dialogsOf(page)).not.toContainEqual(expect.stringContaining("firmware version"));
});
