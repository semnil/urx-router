import { test, expect, type Page } from "./fixtures";
import { LIVE_COMMANDS, deviceValueOf, notifyBurst, setDeviceValue, stubTauriDevice, writesOf } from "./tauri-stub";
import { PARAMS } from "../src/core/control/params";
import { IDLE_FULL_MS } from "../src/core/control/follow";
import { DEBOUNCE_MS } from "../src/core/control/live";

// An edit made in the Inspector straight after a device-side change has been followed. The
// unit's own panel turns CH 1's HPF on; the follow layer re-reads the node and reflects it;
// the operator turns it back off while the panel shows it. That edit has to reach the unit
// and stay — the whole-device read the session runs once it has been idle reads the unit's
// value back, and it must find the operator's OFF there rather than put the ON back.

// What the status line says as a notify is followed: the notify's own line, then one per
// read once it has landed — the read the notify schedules is scoped to the node and counts
// a handful of values, the idle whole-device read hundreds.
const FOLLOWING = /^← device…$/;
const SCOPED_READ = /^← device \(\d{1,2}\)$/;
const FULL_READ = /^← device \(\d{3,}\)$/;

// When OFF is pressed, counted from the notify: half a flush debounce before the idle
// whole-device read is due, so that read starts while the edit is still waiting to be sent.
const PRESS_AFTER_NOTIFY_MS = IDLE_FULL_MS - DEBOUNCE_MS / 2;

type Step = "notify" | "scoped" | "click" | "full";

declare global {
  interface Window {
    /** What the in-page observer saw and did, in order, each with its `performance.now()`. */
    __followEdit: Array<[Step, number]>;
  }
}

const hpfRow = (page: Page) =>
  page
    .locator("#inspector .param")
    .filter({ has: page.locator(".toggle") })
    .filter({ hasText: "HPF" })
    .first();

// The scoped read's line is replaced by the whole-device read's once the session idles, so the
// press is made inside the page rather than by the driver, whose round trips put it at no fixed
// point between the two reads. The observer records each status line as it is written. The
// notify's own line is written in the task that arms the idle timer, and from it the observer
// times the press; at that moment it presses OFF only if the scoped read has landed, the
// Inspector shows HPF ON and the whole-device read has not landed.
function pressOffBeforeIdleRead([following, scoped, full, pressAfter]: [string, string, string, number]): void {
  const followingLine = new RegExp(following);
  const scopedRead = new RegExp(scoped);
  const fullRead = new RegExp(full);
  const steps: Array<[Step, number]> = [];
  window.__followEdit = steps;
  const seen = (step: Step): boolean => steps.some(([s]) => s === step);
  const status = document.querySelector("#statusbar")!;
  const hpfToggle = (): Element | null | undefined =>
    [...document.querySelectorAll("#inspector .param")]
      .find((p) => p.querySelector(".toggle") && p.textContent?.includes("HPF"))
      ?.querySelector(".toggle");
  const press = (): void => {
    if (!seen("scoped") || seen("full")) return;
    const group = hpfToggle();
    const off = [...(group?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "OFF");
    if (group?.querySelector("button.on")?.textContent !== "ON" || !off) return;
    steps.push(["click", performance.now()]);
    off.click();
  };
  const observer = new MutationObserver((records) => {
    // Each line as it was written: two writes in one task leave only the last as the text.
    for (const r of records)
      for (const n of r.addedNodes) {
        const line = n.textContent ?? "";
        if (!seen("notify") && followingLine.test(line)) {
          steps.push(["notify", performance.now()]);
          setTimeout(press, pressAfter);
        }
        if (!seen("scoped") && !seen("full") && scopedRead.test(line)) steps.push(["scoped", performance.now()]);
        if (!seen("full") && fullRead.test(line)) steps.push(["full", performance.now()]);
      }
    if (seen("full")) observer.disconnect();
  });
  observer.observe(status, { childList: true });
}

test("an edit still unsent when the idle whole-device read starts reaches the unit and stays", async ({ page }) => {
  test.setTimeout(120_000);
  await stubTauriDevice(page, { commands: LIVE_COMMANDS, values: { 766: 48000, 848: 0 } });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  await page.locator(`#graph-host g.node[data-id="ch1"]`).click();
  await expect(hpfRow(page).locator("button.on")).toHaveText("OFF");

  await page.evaluate(pressOffBeforeIdleRead, [
    FOLLOWING.source,
    SCOPED_READ.source,
    FULL_READ.source,
    PRESS_AFTER_NOTIFY_MS,
  ] as [string, string, string, number]);

  // CH 1 is y 0. The unit's panel turns its HPF on, announced as the unit announces it.
  await setDeviceValue(page, PARAMS.HPF_ON.id, 0, 1);
  await notifyBurst(page, [{ paramId: PARAMS.HPF_ON.id, y: 0, value: 1 }]);

  // The scoped read lands, OFF is pressed, and only then does the whole-device read land.
  const steps = () => page.evaluate(() => window.__followEdit.map(([s]) => s));
  await expect.poll(steps, { timeout: 30_000 }).toContain("full");
  expect(await steps()).toEqual(["notify", "scoped", "click", "full"]);

  await expect
    .poll(async () => (await writesOf(page)).filter(([id]) => id === PARAMS.HPF_ON.id))
    .toEqual([[PARAMS.HPF_ON.id, 0]]);
  // Had the edit not reached the unit, the whole-device read would have put the unit's ON back.
  expect(await deviceValueOf(page, PARAMS.HPF_ON.id, 0)).toBe(0);
  await page.locator(`#graph-host g.node[data-id="ch1"]`).click();
  await expect(hpfRow(page).locator("button.on")).toHaveText("OFF");
});
