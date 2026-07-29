import { test, expect, type Page } from "@playwright/test";

// Dynamics tuning screens (GATE / COMP). The meter half needs a live session,
// which is desktop-only, so this spec stubs the Tauri IPC bridge before boot — and
// unlike the other specs it keeps the meter channel, so it can push readings in and
// assert what the screen makes of them. That is the only way to cover the parts the
// measurements decided: GR's two idle values, and "no frame yet" printing "—"
// rather than a number.
//
// Both processors run on one host, so the two halves below share every helper.

declare global {
  interface Window {
    __dynTest: {
      meterChannel: { onmessage: (batch: Array<{ meter_id: number; x: number; value: number }>) => void } | null;
      paramChannel: {
        onmessage: (batch: Array<{ param_id: number; x: number; y: number; value: number }>) => void;
      } | null;
      meterAddrs: Array<[number, number]>;
      subscribes: number;
      unsubscribes: number;
      sets: Array<{ id: number; value: number }>;
    };
  }
}

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const section = (page: Page, title: RegExp) =>
  page.locator("#inspector .insp-section", { has: page.locator("summary", { hasText: title }) });

const box = (page: Page) => page.locator("#dyn-screen-box");
const readout = (page: Page, label: string) => box(page).locator(".gt-ro", { hasText: label });
const paramRow = (page: Page, label: string) => box(page).locator(".prefs-row", { hasText: label });

/** Push a device-side parameter change, the way turning a knob on the unit does. */
const pushParam = (page: Page, paramId: number, x: number, y: number, value: number) =>
  page.evaluate(
    ([id, xx, yy, v]) => window.__dynTest.paramChannel?.onmessage([{ param_id: id, x: xx, y: yy, value: v }]),
    [paramId, x, y, value],
  );

/** Deliver one batch of meter readings through the captured channel. */
const pushMeters = (page: Page, ...frames: Array<[number, number, number]>) =>
  page.evaluate(
    (list) => window.__dynTest.meterChannel?.onmessage(list.map(([meter_id, x, value]) => ({ meter_id, x, value }))),
    frames,
  );

/** The three taps this screen streams, in signal order. */
const GATE_TAPS = [
  [106, 0],
  [107, 0],
  [108, 0],
];
const expectGateTaps = (page: Page) =>
  expect.poll(() => page.evaluate(() => window.__dynTest.meterAddrs)).toEqual(GATE_TAPS);

/** Open a screen from the CONSOLE strip (the entry that leaves the console visible).
 *  A mono strip carries one opener per processor, in chip order: GATE then COMP. */
const openFromConsole = async (page: Page, which = 0) => {
  await page.click("#btn-view-console");
  await page.locator(".con-strip").nth(0).locator(".con-chip-open").nth(which).click();
  await expect(box(page)).toBeVisible();
};

/** Open a screen from the inspector's matching section (the GRAPH-side entry).
 *  The disclosure starts folded (both processors ship off) but its state persists
 *  per section kind, so this unfolds only when it is actually closed — a second
 *  call in the same session would otherwise fold it again and hide the launcher. */
const openFromInspector = async (page: Page, id: string, kind: "gate" | "comp" = "gate") => {
  await node(page, id).click();
  const sec = section(page, kind === "gate" ? /^GATE$/ : /^COMP$/);
  if (!(await sec.evaluate((el) => (el as HTMLDetailsElement).open))) await sec.locator("summary").click();
  await sec.locator(`#btn-${kind}-screen`).click();
  await expect(box(page)).toBeVisible();
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-model", "URX44V");
    localStorage.setItem("urx-disclaimer-accepted", "1"); // skip the consent gate
    const state: Window["__dynTest"] = {
      meterChannel: null,
      paramChannel: null,
      meterAddrs: [],
      subscribes: 0,
      unsubscribes: 0,
      sets: [],
    };
    window.__dynTest = state;
    class Channel {
      onmessage: (data: unknown) => void = () => {};
    }
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      Channel,
      invoke: (cmd: string, args: Record<string, unknown>) => {
        switch (cmd) {
          case "experimental_enabled":
          case "self_test_requested":
          case "reset_storage_requested":
            return Promise.resolve(false);
          case "plugin:updater|check":
            return Promise.resolve(null);
          case "vd_connect":
            return Promise.resolve({ model: "URX44V", label: "Stub URX", firmware: "", epoch: 1 });
          case "vd_disconnect":
            return Promise.resolve();
          case "vd_get":
            return Promise.resolve(0);
          case "vd_get_str":
            return Promise.resolve("");
          case "vd_set":
            state.sets.push({ id: args.id as number, value: args.value as number });
            return Promise.resolve();
          case "vd_set_str":
            return Promise.resolve();
          // Live sync needs exactly these two beyond the reads.
          case "vd_params_subscribe":
            state.paramChannel = args.channel as Window["__dynTest"]["paramChannel"];
            return Promise.resolve();
          case "vd_params_unsubscribe":
          case "vd_watch_link":
            return Promise.resolve();
          case "vd_meters_subscribe":
            state.subscribes++;
            state.meterAddrs = args.addrs as Array<[number, number]>;
            state.meterChannel = args.channel as Window["__dynTest"]["meterChannel"];
            return Promise.resolve();
          case "vd_meters_unsubscribe":
            state.unsubscribes++;
            return Promise.resolve();
          case "plugin:dialog|message":
            return Promise.resolve("Ok");
          default:
            return Promise.reject(new Error(`stub: unhandled command ${cmd}`));
        }
      },
    };
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("gate: opens from the inspector for a mono channel, scoped to that channel", async ({ page }) => {
  await openFromInspector(page, "ch1");
  await expect(box(page).locator(".gt-ch")).toHaveText("CH 1");
  // No in-screen channel switch: the scope is fixed by where it was opened from.
  await expect(box(page).locator("select")).toHaveCount(0);
  await box(page).locator(".consent-btn-primary").click();
  await expect(box(page)).toBeHidden();
});

test("has no launcher on a stereo channel, which has no gate", async ({ page }) => {
  await node(page, "ch_5_6").click();
  await expect(section(page, /^GATE$/)).toHaveCount(0);
  await expect(page.locator("#btn-gate-screen")).toHaveCount(0);
});

test("opens from the CONSOLE strip, and only on mono strips", async ({ page }) => {
  await page.click("#btn-view-console");
  const strips = page.locator(".con-strip");
  // CH1-4 carry one opener per processor; CH5/6 onward have neither.
  await expect(strips.nth(0).locator(".con-chip-open")).toHaveCount(2);
  await expect(strips.nth(4).locator(".con-chip-open")).toHaveCount(0);
  await strips.nth(0).locator(".con-chip-open").first().click();
  await expect(box(page)).toBeVisible();
  await expect(box(page).locator(".gt-ch")).toHaveText("CH 1");
});

test("the opener does not toggle the gate it sits beside", async ({ page }) => {
  await page.click("#btn-view-console");
  const gateChip = page.locator(".con-strip").nth(0).locator(".con-chip", { hasText: "GATE" });
  const before = await gateChip.getAttribute("aria-pressed");
  await page.locator(".con-strip").nth(0).locator(".con-chip-open").first().click();
  await expect(box(page)).toBeVisible();
  await box(page).locator(".consent-btn-primary").click();
  await expect(gateChip).toHaveAttribute("aria-pressed", before ?? "false");
});

test("switches between the ladder and the curve, replacing one with the other", async ({ page }) => {
  await openFromInspector(page, "ch1");
  await expect(box(page).locator(".gt-ladders")).toBeVisible();
  await expect(box(page).locator("#dyn-curve")).toHaveCount(0);

  await box(page).locator("#dyn-mode-curve").click();
  await expect(box(page).locator("#dyn-curve")).toBeVisible();
  await expect(box(page).locator(".gt-ladders")).toHaveCount(0);
  // The hint earns its place only where the gesture is not self-evident.
  await expect(box(page).locator(".gt-note")).toBeVisible();

  await box(page).locator("#dyn-mode-ladder").click();
  await expect(box(page).locator(".gt-ladders")).toBeVisible();
  await expect(box(page).locator(".gt-note")).toBeEmpty();
});

test("does not change height when the display mode is switched", async ({ page }) => {
  // The hint belongs to CURVE alone, but its box is reserved in both modes: adding
  // it on the switch grew the modal, moving the Close action and the parameter rows
  // out from under the pointer. A hint that grew to two lines would bring that back,
  // so this pins the equality rather than the reservation.
  await openFromInspector(page, "ch1");
  const height = async () => (await box(page).boundingBox())?.height ?? 0;
  const ladder = await height();
  await box(page).locator("#dyn-mode-curve").click();
  await expect(box(page).locator("#dyn-curve")).toBeVisible();
  expect(await height()).toBe(ladder);
  await box(page).locator("#dyn-mode-ladder").click();
  await expect(box(page).locator(".gt-ladders")).toBeVisible();
  expect(await height()).toBe(ladder);
});

test("remembers the display mode across opens and reloads", async ({ page }) => {
  await openFromInspector(page, "ch1");
  await box(page).locator("#dyn-mode-curve").click();
  await expect(box(page).locator("#dyn-curve")).toBeVisible();
  await box(page).locator(".consent-btn-primary").click();

  // Same session, reopened: still CURVE.
  await openFromInspector(page, "ch1");
  await expect(box(page).locator("#dyn-curve")).toBeVisible();
  await box(page).locator(".consent-btn-primary").click();

  // And across a reload — the pick is stored, not just held in the instance.
  await page.reload();
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await openFromInspector(page, "ch1");
  await expect(box(page).locator("#dyn-curve")).toBeVisible();
  await expect(box(page).locator("#dyn-mode-curve")).toHaveAttribute("aria-pressed", "true");
});

test("the threshold cap moves with the value and shares its ruler", async ({ page }) => {
  await openFromInspector(page, "ch1");
  const cap = box(page).locator("#dyn-threshold-cap");
  const slider = paramRow(page, "Threshold").locator("input[type=range]");

  const capPos = () =>
    page.evaluate(() => document.getElementById("dyn-threshold-cap")?.style.getPropertyValue("--pos"));

  // -50 dB on a -72..0 ruler sits 22/72 up from the floor, i.e. 69.44% down.
  // The ruler is linear in dB precisely so this stays proportional.
  await expect(cap).toHaveAttribute("aria-valuenow", "-50");
  await expect.poll(capPos).toBe("69.44%");

  await slider.fill("-36"); // half way
  await expect(cap).toHaveAttribute("aria-valuenow", "-36");
  await expect.poll(capPos).toBe("50.00%");

  // The cap is a slider in its own right: arrow keys step it by 1 dB.
  await cap.focus();
  await cap.press("ArrowUp");
  await expect(cap).toHaveAttribute("aria-valuenow", "-35");
  await expect(slider).toHaveValue("-35");
});

test("prints — for a tap that has not reported, never a floor value", async ({ page }) => {
  await openFromInspector(page, "ch1");
  // Not live: no frame has arrived, and a GR of 0 dB would claim the gate is
  // passing everything.
  for (const label of ["Pre Gate", "Gate GR", "Pre Comp"]) {
    await expect(readout(page, label).locator(".v")).toHaveText("—");
    await expect(readout(page, label).locator(".p")).toHaveText("pk —");
  }
});

test.describe("with a live session", () => {
  test.beforeEach(async ({ page }) => {
    await page.click("#btn-device");
    await page.click("#btn-live");
    await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true");
  });

  test("subscribes to exactly the three taps of the opened channel", async ({ page }) => {
    await openFromInspector(page, "ch1");
    // 106 PRE GATE / 107 GATE GR / 108 PRE COMP, all on CH1's x0.
    await expectGateTaps(page);
  });

  test("hands the meter slot back when it closes", async ({ page }) => {
    await page.click("#btn-view-console");
    const before = await page.evaluate(() => window.__dynTest.subscribes);
    await page.locator(".con-strip").nth(0).locator(".con-chip-open").first().click();
    await expect(box(page)).toBeVisible();
    // Taking the slot: the console released, this screen registered its three.
    await expect.poll(() => page.evaluate(() => window.__dynTest.unsubscribes)).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => window.__dynTest.subscribes)).toBeGreaterThan(before);

    const taken = await page.evaluate(() => window.__dynTest.subscribes);
    await box(page).locator(".consent-btn-primary").click();
    await expect(box(page)).toBeHidden();
    // Giving it back: the console re-registers its own set.
    await expect.poll(() => page.evaluate(() => window.__dynTest.subscribes)).toBeGreaterThan(taken);
    await expect.poll(() => page.evaluate(() => window.__dynTest.meterAddrs.length)).toBeGreaterThan(3);
  });

  test("reads both GR idle values as no reduction, and a reduction as itself", async ({ page }) => {
    await openFromInspector(page, "ch1");
    const gr = readout(page, "Gate GR").locator(".v");

    // Measured: the gate reports 0 while switched off …
    await pushMeters(page, [107, 0, 0]);
    await expect(gr).toHaveText("0.0");
    // … and the OVER sentinel while switched on and open. Neither is a clip.
    await pushMeters(page, [107, 0, 32767]);
    await expect(gr).toHaveText("0.0");
    // A real reduction is deci-dB.
    await pushMeters(page, [107, 0, -239]);
    await expect(gr).toHaveText("-23.9");
  });

  test("keeps the level taps and the reduction on separate readouts", async ({ page }) => {
    await openFromInspector(page, "ch1");
    await pushMeters(page, [106, 0, -153], [107, 0, -239], [108, 0, -153]);
    await expect(readout(page, "Pre Gate").locator(".v")).toHaveText("-15.3");
    await expect(readout(page, "Gate GR").locator(".v")).toHaveText("-23.9");
    await expect(readout(page, "Pre Comp").locator(".v")).toHaveText("-15.3");
  });

  test("holds the deepest reduction, which the device does not hold itself", async ({ page }) => {
    await openFromInspector(page, "ch1");
    // A single deep frame followed by idle ones: the live value returns to 0 but
    // the peak keeps the reading that arrived, which is the only trace a gate
    // action shorter than a frame leaves.
    await pushMeters(page, [107, 0, -400]);
    await expect(readout(page, "Gate GR").locator(".p")).toHaveText("pk -40.0");
    await pushMeters(page, [107, 0, 32767]);
    await expect(readout(page, "Gate GR").locator(".v")).toHaveText("0.0");
    await expect(readout(page, "Gate GR").locator(".p")).toHaveText("pk -40.0");
  });

  test("keeps its meters when the device is operated under it", async ({ page }) => {
    // Opened from the CONSOLE, so that view is visible behind the modal. Turning a
    // knob on the unit arrives as a param notify; follow applies it and, once the
    // device goes quiet, runs a full reconcile as its missed-notify safety net.
    // That reconcile re-renders the console, and a console render re-subscribes —
    // which would take the meter slot back out from under this screen.
    await openFromConsole(page);
    await expectGateTaps(page);

    await pushParam(page, 1, 0, 0, 300); // HA_GAIN on CH1 — a direct-follow scalar
    // IDLE_FULL_MS is 900 ms; wait past it for the safety-net reconcile.
    await page.waitForTimeout(1800);

    // The screen still owns its three addresses, so its meters keep updating.
    await expectGateTaps(page);
    await pushMeters(page, [107, 0, -239]);
    await expect(readout(page, "Gate GR").locator(".v")).toHaveText("-23.9");
  });
});

// ---------------------------------------------------------------------------
// COMP. Same host, same machinery; what differs is what the device says about a
// compressor — the reduction it reports, who owns the values, and the fact that
// SSMCS replaces the compressor outright.

test.describe("comp", () => {
  test("opens from the inspector and from the CONSOLE, scoped to that channel", async ({ page }) => {
    await openFromInspector(page, "ch1", "comp");
    await expect(box(page).locator(".gt-ch")).toHaveText("CH 1");
    await expect(box(page).locator("h2")).toContainText("Comp");
    await box(page).locator(".consent-btn-primary").click();

    // The strip's second opener is COMP's, in chip order.
    await openFromConsole(page, 1);
    await expect(box(page).locator("h2")).toContainText("Comp");
  });

  test("has no launcher where the channel has no compressor", async ({ page }) => {
    // Stereo channels have no COMP section at all.
    await node(page, "ch_5_6").click();
    await expect(page.locator("#btn-comp-screen")).toHaveCount(0);
    // Nor does a mono channel switched to SSMCS, where the morphing strip replaces
    // the compressor — the section stays, but its own controls do.
    await node(page, "ch1").click();
    const type = page.locator("#inspector .param", { hasText: "COMP/EQ Type" }).locator("select");
    await type.selectOption({ label: "SSMCS" });
    await expect(page.locator("#btn-comp-screen")).toHaveCount(0);
    await page.click("#btn-view-console");
    await expect(page.locator(".con-strip").nth(0).locator(".con-chip-open")).toHaveCount(1);
  });

  test("carries the compressor's own ladder domain", async ({ page }) => {
    await openFromInspector(page, "ch1", "comp");
    const cap = box(page).locator("#dyn-threshold-cap");
    // -18 dB on the -54..0 ruler the COMP threshold actually spans sits two thirds
    // up, i.e. 33.33% down. On the gate's -72..0 ruler the same value would be 25%.
    await expect(cap).toHaveAttribute("aria-valuenow", "-18");
    await expect
      .poll(() => page.evaluate(() => document.getElementById("dyn-threshold-cap")?.style.getPropertyValue("--pos")))
      .toBe("33.33%");
    await expect(cap).toHaveAttribute("aria-valuemin", "-54");
  });

  test("gives the reduction a scale of its own, which the gate does not", async ({ page }) => {
    // A compressor's reduction is a few dB of a 54 dB ruler, so its lane is
    // labelled separately rather than read off the level lanes' ticks.
    await openFromInspector(page, "ch1", "comp");
    await expect(box(page).locator(".gt-grwrap.own .gt-scale")).toHaveCount(1);
    await box(page).locator(".consent-btn-primary").click();

    await openFromInspector(page, "ch1", "gate");
    await expect(box(page).locator(".gt-grwrap.own")).toHaveCount(0);
  });

  test("remembers a display mode per processor", async ({ page }) => {
    await openFromInspector(page, "ch1", "comp");
    await box(page).locator("#dyn-mode-curve").click();
    await expect(box(page).locator("#dyn-curve")).toBeVisible();
    await box(page).locator(".consent-btn-primary").click();

    // The gate's own pick is untouched by the compressor's.
    await openFromInspector(page, "ch1", "gate");
    await expect(box(page).locator(".gt-ladders")).toBeVisible();
    await box(page).locator(".consent-btn-primary").click();

    await openFromInspector(page, "ch1", "comp");
    await expect(box(page).locator("#dyn-curve")).toBeVisible();
  });

  test("hands the values the device drives back to it, read-only", async ({ page }) => {
    await openFromInspector(page, "ch1", "comp");
    const thr = paramRow(page, "Threshold").locator("input[type=range]");
    await expect(thr).toBeEnabled();

    // 1-knob on: the device computes threshold / ratio / gain from one level and
    // announces each recomputation, so they stay on screen and stop being editable.
    await paramRow(page, "1-Knob").locator("button", { hasText: "On" }).click();
    await expect(paramRow(page, "1-Knob Level")).toBeVisible();
    for (const label of ["Threshold", "Ratio", "Gain"]) {
      await expect(paramRow(page, label).locator("input[type=range]")).toBeDisabled();
    }
    // Auto Makeup cannot be operated while 1-knob is on, so its row is gone.
    await expect(paramRow(page, "Auto Makeup")).toHaveCount(0);

    await paramRow(page, "1-Knob").locator("button", { hasText: "Off" }).click();
    await expect(paramRow(page, "Threshold").locator("input[type=range]")).toBeEnabled();

    // Auto Makeup drives the makeup gain alone.
    await paramRow(page, "Auto Makeup").locator("button", { hasText: "On" }).click();
    await expect(paramRow(page, "Gain").locator("input[type=range]")).toBeDisabled();
    await expect(paramRow(page, "Threshold").locator("input[type=range]")).toBeEnabled();
  });

  test.describe("with a live session", () => {
    test.beforeEach(async ({ page }) => {
      await page.click("#btn-device");
      await page.click("#btn-live");
      await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true");
    });

    test("subscribes to the compressor's own three taps", async ({ page }) => {
      await openFromInspector(page, "ch1", "comp");
      // 108 PRE COMP / 110 COMP GR / 111 PRE EQ, all on CH1's x0.
      await expect
        .poll(() => page.evaluate(() => window.__dynTest.meterAddrs))
        .toEqual([
          [108, 0],
          [110, 0],
          [111, 0],
        ]);
    });

    test("reads the reduction, and both idle values as none", async ({ page }) => {
      await openFromInspector(page, "ch1", "comp");
      const gr = readout(page, "Comp GR").locator(".v");
      // Measured: 0 while the compressor is off, the OVER sentinel while it is on
      // with nothing to reduce. Neither is a clip, and neither is a reduction.
      await pushMeters(page, [110, 0, 0]);
      await expect(gr).toHaveText("0.0");
      await pushMeters(page, [110, 0, 32767]);
      await expect(gr).toHaveText("0.0");
      await pushMeters(page, [110, 0, -80]);
      await expect(gr).toHaveText("-8.0");
      // The makeup gain is not in this figure — measured by sweeping it against a
      // held compression — so the lane reads the same at any makeup setting.
      await expect(readout(page, "Pre EQ").locator(".v")).toHaveText("—");
    });
  });
});
