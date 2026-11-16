import { test, expect } from "./fixtures";
import { LIVE_COMMANDS, stubTauriDevice } from "./tauri-stub";
import { PARAMS } from "../src/core/control/params";
import { en } from "../src/i18n/en";

// The status line during Live sync: what an operation wrote leads the line, and the session's
// sync and follow status is printed behind it (main.ts, ledBy). A line too long for the bar is cut
// in its lead, so the status behind it stays readable at the narrowest window the app allows.

// The window's minimum width (src-tauri/tauri.conf.json `minWidth`).
test.use({ viewport: { width: 960, height: 720 } });

test("at the minimum width a long line is cut in its lead, and the send behind it stays whole @webkit", async ({
  page,
}) => {
  // Follow USB off, so the session writes a rate chosen in the app; every bus on Flex12GEQ, so
  // the rate's line names what 88.2 kHz takes off and is longer than the bar.
  await stubTauriDevice(page, {
    commands: LIVE_COMMANDS,
    confirm: "Ok",
    values: { [PARAMS.SAMPLE_RATE.id]: 48_000, [PARAMS.FOLLOW_USB.id]: 0, [PARAMS.OUT_EQ_TYPE.id]: 2 },
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  // The bar's right end is taken by the session's CUE readout.
  await expect(page.locator("#cue-bar")).toBeVisible();

  await page.locator("#rate-picker").evaluate((el: HTMLSelectElement) => {
    el.value = "88200";
    el.dispatchEvent(new Event("change"));
  });
  const lead = page.locator("#statusbar > .status-lead");
  const tail = page.locator("#statusbar > .status-tail");
  await expect(lead).toContainText("went back to 4band PEQ", { timeout: 20_000 });
  await expect(tail).toHaveText(/^ — → device \(\d+\)$/, { timeout: 20_000 });
  const sent = (await tail.textContent())!.replace(/^ — /, "");
  await expect(page.locator("#statusbar")).toHaveAttribute("title", (await page.locator("#statusbar").textContent())!);

  const box = await page.evaluate(() => {
    const rect = (el: Element | null) => el!.getBoundingClientRect();
    const lead = document.querySelector("#statusbar > .status-lead") as HTMLElement;
    const tail = document.querySelector("#statusbar > .status-tail") as HTMLElement;
    return {
      bar: rect(document.getElementById("statusbar")).right,
      cue: rect(document.getElementById("cue-bar")).left,
      tailLeft: rect(tail).left,
      tailRight: rect(tail).right,
      leadRight: rect(lead).right,
      leadCut: lead.scrollWidth > lead.clientWidth,
      tailCut: tail.scrollWidth > tail.clientWidth,
    };
  });
  expect(box.tailRight, "the send ends inside the line").toBeLessThanOrEqual(box.bar + 0.5);
  expect(box.tailCut, "the send is not cut").toBe(false);
  expect(box.tailLeft, "the send follows the lead").toBeGreaterThanOrEqual(box.leadRight - 0.5);
  expect(box.bar, "the line ends before the CUE readout").toBeLessThanOrEqual(box.cue + 0.5);
  expect(box.leadCut, "the premise: the line is longer than the bar, and its lead is what is cut").toBe(true);
  const n = Number(/\d+/.exec(sent)![0]);
  expect(sent, "the send's own line").toBe(en.status.liveSynced(n));
  // The send is announced without the rate's line, which was announced when it was written.
  const said = page.locator("#statusbar-said");
  await expect(said).toHaveText(new RegExp(`\\(${n}\\)$`));
  await expect(said).not.toContainText("4band PEQ");
});
