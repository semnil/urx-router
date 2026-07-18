import { readFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
import { decodeParam, planParam } from "./plan-param";

// A rename marker makes the shared / downloaded output distinguishable from a
// default plan without depending on canvas interactions.
const markedPlan = {
  format: "urx-router-plan",
  version: 1,
  modelId: "URX44V",
  connections: [],
  nodeNames: { ch1: "SHARED-MARK" },
};

// The share / download buttons ship hidden outside the demo build; the dev
// server is not a demo build, so reveal them the way the demo boot does
// ([data-demo-only] → hidden = false). Their handlers are wired regardless.
async function revealDemoButtons(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>("[data-demo-only]")) el.hidden = false;
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
});

test("Share URL copies a ?plan= link that round-trips the plan", async ({ page }) => {
  // Capture clipboard writes deterministically (headless clipboard permissions
  // vary), before the app code reads navigator.clipboard.
  await page.addInitScript(() => {
    const copied: string[] = [];
    (window as { __copied?: string[] }).__copied = copied;
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: (text: string): Promise<void> => {
          copied.push(text);
          return Promise.resolve();
        },
      },
    });
  });
  await page.goto(`/?plan=${planParam(markedPlan)}`);
  await expect(page.locator("#statusbar")).toContainText("Plan loaded");
  await revealDemoButtons(page);
  // Edit the plan before sharing (rename CH 1 via the inspector), so a link
  // merely echoing the entry URL cannot pass: the copied payload must be
  // re-encoded from the live plan state.
  await page.locator('#graph-host g.node[data-id="ch1"]').click();
  const nameInput = page.locator("#inspector input[type='text']");
  await expect(nameInput).toHaveValue("SHARED-MARK");
  await nameInput.fill("EDITED-MARK");
  await page.locator("#btn-share").click();
  await expect(page.locator("#statusbar")).toContainText("Share URL copied");
  const copied = await page.evaluate(() => (window as { __copied?: string[] }).__copied ?? []);
  expect(copied).toHaveLength(1);
  const link = copied[0];
  // The address bar carries the same link (the copy-by-hand fallback).
  expect(page.url()).toBe(link);
  // The encoded payload is the current plan: the post-load edit is in, and the
  // fixed sends materialized by ensureFixedConnections are in (the entry URL's
  // payload had connections: [] and the pre-edit name).
  const encoded = new URL(link).searchParams.get("plan");
  expect(encoded).toBeTruthy();
  const decoded = JSON.parse(decodeParam(String(encoded))) as {
    modelId: string;
    connections: unknown[];
    nodeNames: Record<string, string>;
  };
  expect(decoded.modelId).toBe("URX44V");
  expect(decoded.nodeNames.ch1).toBe("EDITED-MARK");
  expect(decoded.connections.length).toBeGreaterThan(0);
  // The emitted link loads cleanly through the deep-link entry, edit included.
  await page.goto(link);
  await expect(page.locator("#statusbar")).toContainText("Plan loaded");
  await expect(page.locator("#load-report")).toBeHidden();
  await page.locator('#graph-host g.node[data-id="ch1"]').click();
  await expect(page.locator("#inspector input[type='text']")).toHaveValue("EDITED-MARK");
});

test("share falls back to the address bar when the clipboard rejects", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: (): Promise<void> => Promise.reject(new Error("denied")) },
    });
  });
  await page.goto(`/?plan=${planParam(markedPlan)}`);
  await expect(page.locator("#statusbar")).toContainText("Plan loaded");
  await revealDemoButtons(page);
  await page.locator("#btn-share").click();
  await expect(page.locator("#statusbar")).toContainText("copy the share URL from the address bar");
  // The address bar still carries a decodable link (the copy-by-hand fallback).
  const encoded = new URL(page.url()).searchParams.get("plan");
  expect(encoded).toBeTruthy();
  const decoded = JSON.parse(decodeParam(String(encoded))) as { modelId: string };
  expect(decoded.modelId).toBe("URX44V");
});

test("Download JSON saves a plan file the desktop app can open", async ({ page }, testInfo) => {
  await page.goto(`/?plan=${planParam(markedPlan)}`);
  await expect(page.locator("#statusbar")).toContainText("Plan loaded");
  await revealDemoButtons(page);
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btn-download")]);
  expect(download.suggestedFilename()).toBe("URX44V-plan.json");
  const path = testInfo.outputPath("URX44V-plan.json");
  await download.saveAs(path);
  const saved = JSON.parse(await readFile(path, "utf8")) as {
    format: string;
    modelId: string;
    nodeNames: Record<string, string>;
  };
  // The file is a regular plan document (what the desktop Save writes), with
  // the loaded plan's content intact.
  expect(saved.format).toBe("urx-router-plan");
  expect(saved.modelId).toBe("URX44V");
  expect(saved.nodeNames.ch1).toBe("SHARED-MARK");
  await expect(page.locator("#statusbar")).toContainText("Plan JSON downloaded");
});
