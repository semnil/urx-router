import { test, expect, scrollsByWheel, textContrast } from "./fixtures";
import type { Page } from "./fixtures";
import { LIVE_COMMANDS, answerTimingOf, stubTauriBoot, stubTauriDevice } from "./tauri-stub";
import { chooseOption } from "./choose-option";

// Preferences modal (toolbar gear). The gear is an independent entry available
// in every build; rows that need the desktop shell render disabled with a
// "Desktop app only" tag in a plain browser, which is exactly what this harness
// serves (the built bundle without VITE_DEMO, no Tauri shell).

test.describe("plain browser", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("urx-lang", "en"));
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  // The tag says why the row is locked, so it keeps the dim tier's ink while the row it
  // sits on dims; in the light theme that tier has no room for a fade.
  test("the desktop-only tag clears AA in the light theme", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("urx-theme", "light"));
    await page.reload();
    await page.click("#btn-prefs");
    const tag = page.locator("#prefs-device-scope").locator("..").locator(".prefs-lock");
    await expect(tag).toHaveText("Desktop app only");
    expect(await textContrast(page, tag)).toBeGreaterThanOrEqual(4.5);
  });

  test("the gear opens the modal; desktop-only rows are locked and tagged", async ({ page }) => {
    await page.click("#btn-prefs");
    await expect(page.locator("#prefs-modal")).toBeVisible();
    await expect(page.locator("#prefs-title")).toHaveText("Preferences");
    // Device scope: locked (needs the desktop shell), tagged, buttons disabled.
    const scopeRow = page.locator("#prefs-device-scope").locator("..");
    await expect(scopeRow).toHaveClass(/locked/);
    await expect(scopeRow.locator(".prefs-lock")).toHaveText("Desktop app only");
    await expect(page.locator("#prefs-device-scope button").first()).toBeDisabled();
    // Sleep suppression needs the shell to reach the OS, so it locks the same way.
    const sleepRow = page.locator("#prefs-prevent-sleep").locator("..");
    await expect(sleepRow).toHaveClass(/locked/);
    await expect(sleepRow.locator(".prefs-lock")).toHaveText("Desktop app only");
    await expect(page.locator("#prefs-prevent-sleep button").first()).toBeDisabled();
    // Save scope applies in every build.
    await expect(page.locator("#prefs-save-scope button").first()).toBeEnabled();
    // Version shows; the manual update check needs the desktop shell.
    await expect(page.locator("#prefs-version")).toContainText("URX Router");
    await expect(page.locator("#prefs-update-now")).toHaveCount(0);
    await page.click("#prefs-modal .consent-btn-secondary");
    await expect(page.locator("#prefs-modal")).toBeHidden();
  });

  test("a press outside the box closes the modal (the MIDI panel idiom)", async ({ page }) => {
    await page.click("#btn-prefs");
    await expect(page.locator("#prefs-modal")).toBeVisible();
    await page.click("#prefs-modal", { position: { x: 8, y: 8 } });
    await expect(page.locator("#prefs-modal")).toBeHidden();
    // A press inside the box does not close it.
    await page.click("#btn-prefs");
    await page.click("#prefs-title");
    await expect(page.locator("#prefs-modal")).toBeVisible();
    // Escape closes too, like the toolbar menus.
    await page.keyboard.press("Escape");
    await expect(page.locator("#prefs-modal")).toBeHidden();
  });

  // The scrim says the app is unreachable; `inert` is what makes that true for the
  // keyboard. Only the consent gate used to claim it, so a Tab from any other modal
  // walked into the graph behind it.
  test("the app behind the modal is out of the tab order, and back in on close", async ({ page }) => {
    const appInert = () => page.evaluate(() => (document.getElementById("app") as HTMLElement).inert);
    expect(await appInert()).toBe(false);
    await page.click("#btn-prefs");
    await expect(page.locator("#prefs-modal")).toBeVisible();
    expect(await appInert()).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.locator("#prefs-modal")).toBeHidden();
    expect(await appInert()).toBe(false);
  });

  test("a changed setting applies immediately and survives a reload", async ({ page }) => {
    await page.click("#btn-prefs");
    await page.click('#prefs-save-scope button:has-text("Scene only")');
    await expect(page.locator("#prefs-save-scope button.on")).toHaveText("Scene only");
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("urx-settings") ?? "{}"));
    expect(stored.saveScope).toBe("scene");
    await page.reload();
    await page.click("#btn-prefs");
    await expect(page.locator("#prefs-save-scope button.on")).toHaveText("Scene only");
  });

  test("the language dropdown switches the UI language and persists it", async ({ page }) => {
    await page.click("#btn-prefs");
    await expect(page.locator("#prefs-lang")).toHaveValue("en");
    await chooseOption(page.locator("#prefs-lang"), "ja");
    // The open modal re-renders itself in the new language.
    await expect(page.locator("#prefs-title")).toHaveText("環境設定");
    expect(await page.evaluate(() => localStorage.getItem("urx-lang"))).toBe("ja");
  });

  test("the theme dropdown applies the palette immediately and persists the mode", async ({ page }) => {
    await page.click("#btn-prefs");
    await chooseOption(page.locator("#prefs-theme"), "light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(await page.evaluate(() => localStorage.getItem("urx-theme"))).toBe("light");
  });

  test("fine-tuning latch: Shift toggles instead of holding", async ({ page }) => {
    await page.click("#btn-prefs");
    await page.click('#prefs-fine button:has-text("Latch")');
    await page.click("#prefs-modal .consent-btn-secondary");
    // One press latches fine mode on through the keyup...
    await page.keyboard.down("Shift");
    await page.keyboard.up("Shift");
    await expect(page.locator("html")).toHaveClass(/fine-mode/);
    // ...and the next press releases it.
    await page.keyboard.down("Shift");
    await page.keyboard.up("Shift");
    await expect(page.locator("html")).not.toHaveClass(/fine-mode/);
  });

  test("a shrunken window scrolls the grid while Close stays pinned in view @webkit", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 420 });
    await page.click("#btn-prefs");
    const box = page.locator("#prefs-box");
    await expect(box).toBeVisible();
    // The box caps below the viewport; the grid inside it carries the overflow.
    const metrics = await box.evaluate((el) => {
      const grid = el.querySelector(".prefs-grid")!;
      return {
        boxClient: el.clientHeight,
        viewport: window.innerHeight,
        gridClient: grid.clientHeight,
        gridScroll: grid.scrollHeight,
      };
    });
    expect(metrics.boxClient).toBeLessThanOrEqual(metrics.viewport);
    expect(metrics.gridScroll).toBeGreaterThan(metrics.gridClient);
    // Content taller than its box is not the same fact as content the operator can REACH:
    // a grid that clips reports both heights the same way. The wheel is what separates them.
    await scrollsByWheel(page, page.locator(".prefs-grid"), "y");
    // Close is pinned below the grid — visible and clickable without scrolling.
    const close = page.locator("#prefs-modal .consent-btn-secondary");
    const closeBox = await close.boundingBox();
    expect(closeBox).not.toBeNull();
    expect(closeBox!.y + closeBox!.height).toBeLessThanOrEqual(420);
    await close.click();
    await expect(page.locator("#prefs-modal")).toBeHidden();
  });

  // A change rebuilds the modal, and the grid it rebuilds is the scrolling region. The
  // control the operator used and the offset they scrolled to both survive it, or the next
  // Tab starts again from the top of the box and a scrolled grid jumps back to its start.
  test("a change keeps the focused control and the grid's scroll offset", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 420 });
    await page.click("#btn-prefs");
    const grid = page.locator(".prefs-grid");
    const scale = page.getByRole("combobox", { name: "Export scale", exact: true });
    await scale.focus();
    const before = await grid.evaluate((el) => el.scrollTop);
    // The premise: focusing the row scrolled the grid, so there is an offset to lose.
    expect(before).toBeGreaterThan(0);
    await chooseOption(scale, "3");
    await expect(scale).toHaveValue("3");
    await expect(scale).toBeFocused();
    expect(await grid.evaluate((el) => el.scrollTop)).toBe(before);

    // A face pressed from the keyboard rebuilds the modal the same way.
    const latch = page.locator('#prefs-fine button:has-text("Latch")');
    await latch.focus();
    const at = await grid.evaluate((el) => el.scrollTop);
    await page.keyboard.press("Space");
    await expect(latch).toHaveAttribute("aria-pressed", "true");
    await expect(latch).toBeFocused();
    expect(await grid.evaluate((el) => el.scrollTop)).toBe(at);
  });
});

test("the desktop shell unlocks the device rows (stubbed Tauri)", async ({ page }) => {
  await stubTauriBoot(page);
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-prefs");
  await expect(page.locator("#prefs-device-scope button").first()).toBeEnabled();
  const scopeRow = page.locator("#prefs-device-scope").locator("..");
  await expect(scopeRow.locator(".prefs-lock")).toHaveCount(0);
  await expect(page.locator("#prefs-update-now")).toBeVisible();
});

test("every dismissal locks while a check is in flight (stubbed Tauri)", async ({ page }) => {
  await stubTauriBoot(page);
  // Delay the updater answer so the in-flight window is observable.
  await page.addInitScript(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<unknown> } })
      .__TAURI_INTERNALS__;
    const invoke = internals.invoke.bind(internals);
    internals.invoke = (cmd: string, ...rest: unknown[]) => {
      if (cmd === "plugin:updater|check") return new Promise((r) => setTimeout(() => r(null), 700));
      return (invoke as (...a: unknown[]) => Promise<unknown>)(cmd, ...rest);
    };
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-prefs");
  await page.click("#prefs-update-now");
  // In flight: outside press, Escape and the Close button are all inert.
  await expect(page.locator("#prefs-update-note")).toHaveText("Checking…");
  await page.click("#prefs-modal", { position: { x: 8, y: 8 } });
  await page.keyboard.press("Escape");
  await expect(page.locator("#prefs-modal")).toBeVisible();
  await expect(page.locator("#prefs-modal .consent-btn-secondary")).toBeDisabled();
  // The grid's controls are disabled for the flight, Check now among them.
  await expect(page.locator("#prefs-lang")).toBeDisabled();
  await expect(page.locator("#prefs-device-scope button").first()).toBeDisabled();
  await expect(page.locator("#prefs-update-now")).toBeDisabled();
  // Settled: the outcome lands and every dismissal and control returns.
  await expect(page.locator("#prefs-update-note")).toHaveText("Already up to date.");
  await expect(page.locator("#prefs-modal .consent-btn-secondary")).toBeEnabled();
  await expect(page.locator("#prefs-lang")).toBeEnabled();
  await expect(page.locator("#prefs-device-scope button").first()).toBeEnabled();
  await expect(page.locator("#prefs-update-now")).toBeEnabled();
  await expect(page.locator("#prefs-update-now")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#prefs-modal")).toBeHidden();
});

test("Check now reports 'up to date' inline and keeps the modal open (stubbed Tauri)", async ({ page }) => {
  // stubTauriBoot answers plugin:updater|check with null = no update available.
  await stubTauriBoot(page);
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-prefs");
  await page.click("#prefs-update-now");
  await expect(page.locator("#prefs-update-note")).toHaveText("Already up to date.");
  await expect(page.locator("#prefs-modal")).toBeVisible();
  await expect(page.locator("#prefs-update-now")).toBeEnabled();
});

/** Record every set_keep_awake the shell is asked for, and optionally refuse it —
 *  the point of the setting is what reaches the OS, which a constant stub cannot
 *  show. Registered after stubTauriBoot so it wraps that stub's invoke. */
async function recordKeepAwake(page: Page, refuse = false): Promise<void> {
  await page.addInitScript((deny: boolean) => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }
    ).__TAURI_INTERNALS__;
    const invoke = internals.invoke.bind(internals);
    const calls: boolean[] = [];
    (window as unknown as { __urxKeepAwake: boolean[] }).__urxKeepAwake = calls;
    internals.invoke = (cmd: string, ...rest: unknown[]) => {
      if (cmd !== "set_keep_awake") return (invoke as (...a: unknown[]) => Promise<unknown>)(cmd, ...rest);
      calls.push(Boolean((rest[0] as { on?: boolean })?.on));
      // Recorded when it is sent; the answer settles through the stub's queue.
      return window.__urxAnswerLater(
        deny ? Promise.reject(new Error("PowerCreateRequest failed")) : Promise.resolve(null),
      );
    };
  }, refuse);
}

test("the keep-awake recorder answers on a later task, in the order asked (stubbed Tauri)", async ({ page }) => {
  await stubTauriBoot(page);
  await recordKeepAwake(page, true);
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  const cmds = ["set_keep_awake", "experimental_enabled"];
  expect(await answerTimingOf(page, cmds)).toEqual({ inSendingTask: [], order: cmds });
});

const keepAwakeCalls = (page: Page): Promise<boolean[]> =>
  page.evaluate(() => (window as unknown as { __urxKeepAwake: boolean[] }).__urxKeepAwake);

const storedSettings = (page: Page): Promise<Record<string, unknown>> =>
  page.evaluate(() => JSON.parse(localStorage.getItem("urx-settings") ?? "{}"));

test("the toggle stores the preference off-line without asking the OS (stubbed Tauri)", async ({ page }) => {
  await stubTauriBoot(page);
  await recordKeepAwake(page);
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-prefs");
  await page.click('#prefs-prevent-sleep button:has-text("ON")');
  await expect(page.locator("#prefs-prevent-sleep button.on")).toHaveText("ON");
  expect((await storedSettings(page)).preventSleep).toBe(true);
  // The hold belongs to a Live sync session, so with none running the preference
  // is the only thing that changes — nothing reaches the OS, at the toggle or at
  // the next launch.
  expect(await keepAwakeCalls(page)).toEqual([]);
  await page.reload();
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  expect(await keepAwakeCalls(page)).toEqual([]);
});

test("Live sync takes the hold and ending it releases (stubbed device)", async ({ page }) => {
  await stubTauriDevice(page, { commands: LIVE_COMMANDS });
  await page.addInitScript(() => localStorage.setItem("urx-settings", JSON.stringify({ preventSleep: true })));
  await recordKeepAwake(page);
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  // Nothing held while the board is off-line, however the preference reads.
  expect(await keepAwakeCalls(page)).toEqual([]);
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => keepAwakeCalls(page)).toEqual([true]);
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => keepAwakeCalls(page)).toEqual([true, false]);
});

test("with the preference off a session holds nothing (stubbed device)", async ({ page }) => {
  await stubTauriDevice(page, { commands: LIVE_COMMANDS });
  await recordKeepAwake(page);
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true");
  // Only the difference is sent: the target never leaves false, so the OS is
  // never called at all.
  expect(await keepAwakeCalls(page)).toEqual([]);
});

test("a refused hold leaves the row OFF and says why (stubbed device)", async ({ page }) => {
  await stubTauriDevice(page, { commands: LIVE_COMMANDS });
  await recordKeepAwake(page, true);
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true");
  await page.click("#btn-prefs");
  await page.click('#prefs-prevent-sleep button:has-text("ON")');
  await expect(page.locator("#prefs-sleep-error")).toContainText("Could not change the sleep setting");
  // The OS refused, so the row and the stored preference both stay off — an ON
  // face here would claim a suppression nothing is holding.
  await expect(page.locator("#prefs-prevent-sleep button.on")).toHaveText("OFF");
  expect((await storedSettings(page)).preventSleep).toBeFalsy();
  // Reopening drops the explanation rather than re-reporting a stale failure.
  await page.keyboard.press("Escape");
  await page.click("#btn-prefs");
  await expect(page.locator("#prefs-sleep-error")).toBeEmpty();
});
