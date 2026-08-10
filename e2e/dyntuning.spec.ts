import { test, expect, type Page } from "./fixtures";

// Channel tuning screens (GATE / COMP / EQ). The meter half needs a live session,
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
      mem: Record<string, number>;
      /** Reads the app has issued. The only evidence a test has that a background
       *  reconcile ran at all — it is hundreds of reads and nothing else it does is
       *  observable from here. */
      gets: number;
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
/** A row by its exact label. `paramRow` matches on a substring, so "1-Knob" also picks up
 *  "1-Knob Level" — and a pin that asserts a row did *not* move would keep passing while
 *  silently measuring the other one. */
const exactRow = (page: Page, label: string) =>
  box(page)
    .locator(".prefs-row")
    .filter({ has: page.getByText(label, { exact: true }) });

/** The panel's height. Three tests pin it, so they read it the same strict way: a
 *  `boundingBox()?.height ?? 0` would compare 0 to 0 — and pass — if `#dyn-screen-box`
 *  ever stopped resolving, which is exactly what these tests exist to catch. */
const panelHeight = (page: Page) => box(page).evaluate((el) => el.getBoundingClientRect().height);

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
const SECTION_OF = { gate: /^GATE$/, comp: /^COMP$/, eq: /^EQ$/, ducker: /^Ducker$/ };
const openFromInspector = async (page: Page, id: string, kind: keyof typeof SECTION_OF = "gate") => {
  await node(page, id).click();
  const sec = section(page, SECTION_OF[kind]);
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
      mem: {},
      gets: 0,
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
            // Answer reads with what was written: a blanket 0 would let a scoped
            // readback undo the state the test just set (1-knob back off, and its
            // level row out from under the pointer).
            state.gets++;
            return Promise.resolve(state.mem[`${args.paramId}:${args.x}:${args.y}`] ?? 0);
          case "vd_get_str":
            return Promise.resolve("");
          case "vd_set":
            state.mem[`${args.paramId}:${args.x}:${args.y}`] = args.value as number;
            state.sets.push({ id: args.paramId as number, value: args.value as number });
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

test("opens from the CONSOLE strip, one opener per processor the strip actually has", async ({ page }) => {
  await page.click("#btn-view-console");
  const strips = page.locator(".con-strip");
  // A mono channel has three (GATE / COMP / EQ); a stereo channel has neither gate
  // nor compressor, so its EQ and the ducker hung under it; a MONITOR bus has no
  // processor at all. The ducker's opener sits on the parent strip because a hung
  // node has no strip of its own — but it opens the DUCKER node's screen.
  await expect(strips.nth(0).locator(".con-chip-open")).toHaveCount(3);
  await expect(strips.nth(4).locator(".con-chip-open")).toHaveCount(2);
  await expect(
    page.locator(".con-strip", { has: page.getByText("MONITOR 1", { exact: true }) }).locator(".con-chip-open"),
  ).toHaveCount(0);
  await strips.nth(0).locator(".con-chip-open").first().click();
  await expect(box(page)).toBeVisible();
  await expect(box(page).locator(".gt-ch")).toHaveText("CH 1");
});

test("an opener line ends flush with the two-per-row chips above it", async ({ page }) => {
  await page.click("#btn-view-console");
  const strip = page.locator(".con-strip").nth(0);
  // The opener takes a quarter of the row and the pair's gap comes out of its wider
  // neighbour alone, so a GATE + opener line reaches the same right edge as a MUTE / +48
  // one. Subtracting the gap from both bases instead leaves the openers short by it.
  const pair = await strip.locator(".con-chip", { hasText: "+48" }).boundingBox();
  const opener = await strip.locator(".con-chip-open").first().boundingBox();
  expect(Math.abs(pair!.x + pair!.width - (opener!.x + opener!.width))).toBeLessThan(1);
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
  const height = () => panelHeight(page);
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

    const getsBefore = await page.evaluate(() => window.__dynTest.gets);
    await pushParam(page, 1, 0, 0, 300); // HA_GAIN on CH1 — a direct-follow scalar
    // IDLE_FULL_MS is 900 ms, and the reconcile that follows reads the whole device.
    // Waited for by its READS rather than by a clock: a blind 1800 ms left 900 ms for
    // several hundred sequential commands plus a console re-render, and if that tail
    // had not run the case saw the untouched subscription and passed with the slot
    // theft it exists to catch never having had the chance to happen.
    await expect
      .poll(() => page.evaluate(() => window.__dynTest.gets), { timeout: 30_000 })
      .toBeGreaterThan(getsBefore + 100);
    // …and then for the reads to STOP, because the re-render that could steal the slot
    // is the reconcile's epilogue, not its body.
    let quiet = await page.evaluate(() => window.__dynTest.gets);
    for (let same = 0; same < 3;) {
      await page.waitForTimeout(150);
      const now = await page.evaluate(() => window.__dynTest.gets);
      same = now === quiet ? same + 1 : 0;
      quiet = now;
    }

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

    // 1-knob off: the level it would drive is on screen but not editable.
    await expect(page.locator("#dyn-oneknob-level")).toBeDisabled();

    // 1-knob on: the device computes threshold / ratio / gain from one level and
    // announces each recomputation, so they stay on screen and stop being editable.
    await paramRow(page, "1-Knob").locator("button", { hasText: "On" }).click();
    await expect(page.locator("#dyn-oneknob-level")).toBeEnabled();
    for (const label of ["Threshold", "Ratio", "Gain"]) {
      await expect(paramRow(page, label).locator("input[type=range]")).toBeDisabled();
    }
    // Auto Makeup cannot be operated while 1-knob is on. Its row keeps its place
    // rather than going, so nothing below it moves; it only stops being editable.
    await expect(paramRow(page, "Auto Makeup")).toHaveClass(/locked/);

    await paramRow(page, "1-Knob").locator("button", { hasText: "Off" }).click();
    await expect(paramRow(page, "Threshold").locator("input[type=range]")).toBeEnabled();

    // Auto Makeup drives the makeup gain alone.
    await paramRow(page, "Auto Makeup").locator("button", { hasText: "On" }).click();
    await expect(paramRow(page, "Gain").locator("input[type=range]")).toBeDisabled();
    await expect(paramRow(page, "Threshold").locator("input[type=range]")).toBeEnabled();
  });

  test("does not move under the pointer that toggles 1-knob", async ({ page }) => {
    await openFromInspector(page, "ch1", "comp");
    // Exact label: the toggle's own row, never the "1-Knob Level" row below it.
    const knob = exactRow(page, "1-Knob");
    const geo = async () => ({
      panel: await panelHeight(page),
      knobTop: await knob.evaluate((el) => el.getBoundingClientRect().top),
    });
    const before = await geo();

    // Auto Makeup and 1-Knob Level are alternatives of different shapes — a toggle row
    // against a slider row — so swapping them in and out both shortened the panel and
    // lifted the row being clicked. Both stay, so neither figure moves.
    await knob.locator("button", { hasText: "On" }).click();
    await expect(page.locator("#dyn-oneknob-level")).toBeEnabled();
    expect(await geo()).toEqual(before);

    await knob.locator("button", { hasText: "Off" }).click();
    await expect(page.locator("#dyn-oneknob-level")).toBeDisabled();
    expect(await geo()).toEqual(before);
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

test.describe("comp, dragging while the device follows", () => {
  test.beforeEach(async ({ page }) => {
    await page.click("#btn-device");
    await page.click("#btn-live");
    await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true");
  });

  test("the 1-knob level survives its own edit and the follow it provokes", async ({ page }) => {
    // The unit answers every level change by recomputing threshold / ratio / gain
    // and announcing all four addresses, which arrives back here as a refresh.
    // Rebuilding the column then — or on the slider's own input event — replaces
    // the element under the pointer, and the drag ends after two or three steps.
    await openFromInspector(page, "ch1", "comp");
    await paramRow(page, "1-Knob").locator("button", { hasText: "On" }).click();
    const slider = page.locator("#dyn-oneknob-level");
    const box = (await slider.boundingBox()) as { x: number; y: number; width: number; height: number };

    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(box.x + 4 + (box.width - 8) * (i / 10) * 0.8, box.y + box.height / 2);
      if (i % 3 === 0) {
        await pushParam(page, 43, 0, 0, 40);
        await pushParam(page, 35, 0, 0, -3200);
      }
    }
    await page.mouse.up();

    // A drag across 80% of the track lands near 80, not at the two or three steps
    // a rebuild-per-input allows.
    await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(60);
  });
});

// The EQ is the same host arranged differently: no display-mode choice (its response and
// its levels are not alternatives, so both are on screen), the segmented bar selects a
// band instead, and it exists on four kinds of node rather than only a mono channel.
const params = (page: Page) => box(page).locator(".prefs-section", { hasText: "Parameters" });
const bandRow = (page: Page, label: string) =>
  params(page)
    .locator(".prefs-row")
    .filter({ has: page.getByText(label, { exact: true }) });
/** The band pill on the Parameters heading. Scoped to the heading, since the locked rows
 *  below carry the same tag element. */
const bandPill = (page: Page) => params(page).locator("h3 .prefs-lock");

test.describe("eq", () => {
  test("shows the response and the levels at once, with the bar selecting a band", async ({ page }) => {
    await openFromInspector(page, "ch1", "eq");
    await expect(box(page).locator("#dyn-curve")).toBeVisible();
    await expect(box(page).locator(".gt-ladders")).toBeVisible();
    // Nothing to switch between, so the display-mode buttons do not exist.
    await expect(box(page).locator("#dyn-mode-ladder")).toHaveCount(0);
    await expect(box(page).locator("#dyn-band-low")).toHaveAttribute("aria-pressed", "true");
    await expect(bandPill(page)).toHaveText("LOW");
  });

  test("says which values the filter type does not read, and never drops their rows", async ({ page }) => {
    await openFromInspector(page, "ch1", "eq");
    // Band / Type / Q / Freq / Gain, whatever is selected. A row that disappeared would
    // take the panel's height with it and move every row below under the pointer, which
    // is the same reason the 1-knob's own rows stay when 1-knob is off.
    const rows = ["Band", "Type", "Q", "Freq", "Gain"];
    for (const r of rows) await expect(bandRow(page, r)).toHaveCount(1);

    // A shelf reads no Q; the LOW band ships as one.
    await expect(bandRow(page, "Q")).toHaveClass(/locked/);
    await expect(bandRow(page, "Q").locator(".prefs-lock")).toHaveText("Unused by this type");
    await expect(bandRow(page, "Gain").locator("input[type=range]")).toBeEnabled();

    // A pass filter reads neither Q nor gain (measured: Q 0.71 and Q 4.00 draw an
    // identical high-pass), so both lock — and both rows stay.
    await bandRow(page, "Type").locator("select").selectOption("2");
    for (const r of rows) await expect(bandRow(page, r)).toHaveCount(1);
    await expect(bandRow(page, "Gain")).toHaveClass(/locked/);
    await expect(bandRow(page, "Freq").locator("input[type=range]")).toBeEnabled();

    // Peaking reads all three.
    await bandRow(page, "Type").locator("select").selectOption("0");
    await expect(bandRow(page, "Q").locator("input[type=range]")).toBeEnabled();
    await expect(bandRow(page, "Gain").locator("input[type=range]")).toBeEnabled();

    // The two mid bands have no filter type at all — the device rejects the write — so
    // the row offers that one value, locked.
    await box(page).locator("#dyn-band-lowmid").click();
    await expect(bandRow(page, "Type")).toHaveClass(/locked/);
    await expect(bandRow(page, "Type").locator(".prefs-lock")).toHaveText("Fixed on this band");
    await expect(bandRow(page, "Type").locator("option")).toHaveText(["Peaking"]);
    await expect(bandRow(page, "Q").locator("input[type=range]")).toBeEnabled();
  });

  test("keeps the panel exactly as tall through every band and every type", async ({ page }) => {
    await openFromInspector(page, "ch1", "eq");
    const height = () => panelHeight(page);
    const first = await height();
    for (const band of ["low", "lowmid", "highmid", "high"]) {
      await box(page).locator(`#dyn-band-${band}`).click();
      expect(await height(), `band ${band}`).toBe(first);
    }
    await box(page).locator("#dyn-band-low").click();
    for (const type of ["0", "1", "2"]) {
      await bandRow(page, "Type").locator("select").selectOption(type);
      expect(await height(), `LOW type ${type}`).toBe(first);
    }
    // Including the state where the whole band block is reserved out of sight.
    // By heading: the reserved note in the Parameters section names the 1-knob too.
    const oneKnob = box(page)
      .locator(".prefs-section")
      .filter({ has: page.locator("h3", { hasText: "1-knob" }) });
    await oneKnob.locator("button", { hasText: "ON" }).click();
    expect(await height(), "1-knob on").toBe(first);
    await oneKnob.locator("button", { hasText: "OFF" }).click();
    expect(await height(), "1-knob off again").toBe(first);
  });

  test("the selected band survives a row that rebuilds the screen", async ({ page }) => {
    await openFromInspector(page, "ch1", "eq");
    await box(page).locator("#dyn-band-highmid").click();
    // Band ON changes which rows exist, so it rebuilds — the band must not snap back.
    await bandRow(page, "Band").locator("button", { hasText: "OFF" }).click();
    await expect(box(page).locator("#dyn-band-highmid")).toHaveAttribute("aria-pressed", "true");
    await expect(bandPill(page)).toHaveText("HIGH MID");
  });

  test("reopens on LOW, where a display mode is remembered instead", async ({ page }) => {
    await openFromInspector(page, "ch1", "eq");
    await box(page).locator("#dyn-band-high").click();
    await box(page).locator(".consent-btn-primary").click();
    await openFromInspector(page, "ch1", "eq");
    // The bar is a cursor into the parameters, not a way of reading the processor: it
    // resets, where GATE's and COMP's LADDER/CURVE choice persists.
    await expect(box(page).locator("#dyn-band-low")).toHaveAttribute("aria-pressed", "true");
  });

  test("carries the taps that bracket the EQ on this kind of node", async ({ page }) => {
    // Mono channel: PRE EQ (111) -> PRE INS FX (112), one bar each.
    await openFromInspector(page, "ch1", "eq");
    await expect(box(page).locator(".gt-cap-label .sub")).toHaveText(["111", "112"]);
    await expect(box(page).locator(".gt-slot.stereo")).toHaveCount(0);
    await box(page).locator(".consent-btn-primary").click();

    // Stereo channel: its INPUT tap (101) is the pre-EQ point, PRE FADER (114) the post,
    // and both carry L and R — two bars in one lane, under one caption.
    await openFromInspector(page, "ch_5_6", "eq");
    await expect(box(page).locator(".gt-cap-label .sub")).toHaveText(["101", "114"]);
    await expect(box(page).locator(".gt-slot.stereo")).toHaveCount(2);
    await expect(box(page).locator(".gt-slot.stereo").first().locator(".gt-side")).toHaveCount(2);
    await box(page).locator(".consent-btn-primary").click();

    // An output bus: the sum (104) and post-EQ (121) taps of the STEREO master.
    await openFromInspector(page, "bus.stereo", "eq");
    await expect(box(page).locator(".gt-cap-label .sub")).toHaveText(["104", "121"]);
  });

  test("has no gain-reduction lane, because an EQ has no reduction to meter", async ({ page }) => {
    await openFromInspector(page, "ch1", "eq");
    await expect(box(page).locator(".gt-slot-gr")).toHaveCount(0);
    await expect(box(page).locator(".gt-ro")).toHaveCount(2);
  });

  test.describe("with a live session", () => {
    test.beforeEach(async ({ page }) => {
      await page.click("#btn-device");
      await page.click("#btn-live");
      await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true");
    });

    test("subscribes to both sides of a stereo node's EQ, L and R", async ({ page }) => {
      await openFromInspector(page, "ch_5_6", "eq");
      const addrs = await page.evaluate(() => window.__dynTest.meterAddrs);
      expect(addrs).toEqual([
        [101, 0],
        [101, 1],
        [114, 0],
        [114, 1],
      ]);
    });
  });
});

// DUCKER. The one screen that does not open on the node it tunes: it opens on the
// ducker, reads its key from wherever the key wire starts, and brackets the reduction
// with the HOST channel's meters. Every case below pins something a measurement
// decided, because each is a plausible thing to "tidy" back the other way.
test.describe("ducker", () => {
  const openDucker = (page: Page, id = "out.ducker1") => openFromInspector(page, id, "ducker");

  test("titles itself with the host channel, not with the node it opened on", async ({ page }) => {
    await openDucker(page);
    // The ducker node's own canvas label is "Ducker", which beside a title reading
    // Ducker names nothing. CH 5/6 is what it attenuates.
    await expect(box(page).locator("#dyn-screen-title .gt-ch")).toHaveText("CH 5/6");
  });

  test("the key lane names its source, and says so when there is none", async ({ page }) => {
    await openDucker(page);
    // `:not([aria-hidden])` because the tick column leads with a two-line spacer
    // carrying this very class, so `.first()` would read the spacer's blank text.
    const keyCaption = box(page).locator(".gt-cap-label:not([aria-hidden])").first();
    // The factory plan keys every ducker from CH 1.
    await expect(keyCaption).toContainText("Key");
    await expect(keyCaption).toContainText("CH 1");
    await page.locator("#dyn-screen-modal .consent-btn-primary").click();

    await page.locator('.wire-hit[data-from="ch1:out"][data-to="out.ducker1:in"]').dispatchEvent("pointerdown");
    await page.keyboard.press("Delete");
    await openDucker(page);
    // A keyless ducker is engaged at unity on the unit, so the lane says there is no
    // key rather than drawing an empty bar that would read as silence.
    await expect(box(page).locator(".gt-cap-label:not([aria-hidden])").first()).toContainText("none");
  });

  test("the key lane draws ONE bar, whatever the key source's width", async ({ page }) => {
    // Key it from a stereo bus, whose tap has two sides. The unit sums them before
    // its detector, and the threshold cap can only ride a ruler in its own
    // coordinate — so the lane folds to that one number instead of drawing L and R.
    await page.locator('.wire-hit[data-from="ch1:out"][data-to="out.ducker1:in"]').dispatchEvent("pointerdown");
    await page.keyboard.press("Delete");
    await page.locator('[data-ref="bus.stereo:out"]').dispatchEvent("pointerdown");
    await page.locator('[data-ref="out.ducker1:in"]').dispatchEvent("pointerup");
    await openDucker(page);
    const keySlot = box(page).locator(".gt-slot").first();
    await expect(keySlot.locator(".gt-bar")).toHaveCount(1);
  });

  test("opens from the CONSOLE strip of the channel it hangs under", async ({ page }) => {
    await page.click("#btn-view-console");
    // Strip 4 is CH 5/6 — the first stereo channel, and ducker 1's host. Its second
    // opener is the ducker's; the first is the EQ's.
    const strip = page.locator(".con-strip").nth(4);
    await strip.locator(".con-chip-open").nth(1).click();
    await expect(box(page)).toBeVisible();
    await expect(box(page).locator("#dyn-screen-title")).toContainText("Ducker");
    // Opened on the ducker node, so its values are the ducker's: the screen writes
    // through `nodeParams["out.ducker1"].ducker`, not through the strip's channel.
    await expect(box(page).locator(".gt-cap-label:not([aria-hidden])").first()).toContainText("Key");
  });

  test("shows the envelope and the lanes at once, with nothing to choose between them", async ({ page }) => {
    await openDucker(page);
    // Both, as the EQ does. The envelope's live overlay is a reduction depth, which is
    // read against the meter carrying the same quantity rather than instead of it.
    await expect(box(page).locator("canvas")).toBeVisible();
    // THREE slots for four lanes: the reduction is drawn in the POST lane's. Measured:
    // over a LEVEL that is still at operating level the two fight for the same pixels
    // (on PRE DUCKER at -6 dBFS a -24 dB block buries the bar's top entirely), while
    // over POST they are complementary — they meet only if the pre-ducker signal
    // reaches 0 dBFS, and the gap between them IS that signal's headroom.
    await expect(box(page).locator(".gt-slot")).toHaveCount(3);
    await expect(box(page).locator(".gt-ro")).toHaveCount(4);
    await expect(box(page).locator(".gt-readouts.two")).toHaveCount(1);
    // The reduction has no scale of its own — it cannot, sharing a slot. It rides the
    // shared ruler, which stays on the threshold's domain.
    await expect(box(page).locator(".gt-grwrap.own")).toHaveCount(0);
    // And no display bar: a heading over a segment with nothing to pick would name a
    // choice that does not exist.
    await expect(box(page).locator(".gt-modes")).toHaveCount(0);
  });

  test.describe("with a live session", () => {
    test.beforeEach(async ({ page }) => {
      await page.click("#btn-device");
      await page.click("#btn-live");
      await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true");
    });

    test("subscribes to the key tap, the host's pair and its own reduction", async ({ page }) => {
      await openDucker(page);
      // CH 1's Rec Point tap (113) for the key — ahead of that channel's own fader,
      // so the source's fader does not move the trigger. Then CH 5/6's PRE DUCKER
      // (116) and POST (120) pairs, and 119:0 — ducker 1's own reduction, measured
      // as the index of the ducker rather than of its host channel.
      await expect
        .poll(() => page.evaluate(() => window.__dynTest.meterAddrs))
        .toEqual([
          [113, 0],
          [116, 0],
          [116, 1],
          [120, 0],
          [120, 1],
          [119, 0],
        ]);
    });

    test("ducker 3 meters its own reduction, not its host channel's pair index", async ({ page }) => {
      await openDucker(page, "out.ducker3");
      const addrs = await page.evaluate(() => window.__dynTest.meterAddrs);
      // 119:2 for ducker 3. On a URX44V that is also CH 9/10's pair index, which is
      // the coincidence this asserts against: the address comes from the ducker.
      expect(addrs).toContainEqual([119, 2]);
    });
  });
});

// The note under the display is a FIXED two lines with `overflow: hidden`, so the
// panel keeps its height across display modes. That makes a note too long for it get
// cut with nothing to say so — which is what shipped: measured, the COMP and EQ notes
// already wrapped below about 1150 px of window and their Japanese counterparts below
// about 1300, and the ducker's second line was missing on a real unit.
//
// The display inventory cannot catch this class. It answers presence, and a clipped
// element whose text still renders passes. So this measures the geometry, at the
// narrowest window the shell allows (tauri.conf.json minWidth 960) because that is
// the width that decides it.
test.describe("the note under the display fits the space reserved for it", () => {
  test.use({ viewport: { width: 960, height: 700 } });

  const noteOverflow = (page: Page) =>
    box(page)
      .locator(".gt-note")
      .evaluate((n) => ({ text: (n.textContent ?? "").trim(), over: n.scrollHeight - n.clientHeight }));

  for (const lang of ["en", "ja"] as const) {
    test(`in ${lang}, on every screen and every display mode`, async ({ page }) => {
      await page.addInitScript((l) => localStorage.setItem("urx-lang", l), lang);
      await page.reload();
      await expect(page.locator("#model-picker")).toHaveValue("URX44V");

      const check = async (): Promise<void> => {
        const { text, over } = await noteOverflow(page);
        expect(over, `clipped: "${text}"`).toBeLessThanOrEqual(0);
      };
      for (const [nodeId, kind, second] of [
        ["ch1", "gate", "#dyn-mode-curve"],
        ["ch1", "comp", "#dyn-mode-curve"],
        ["ch1", "eq", null],
      ] as const) {
        await openFromInspector(page, nodeId, kind);
        await check();
        if (second) {
          await page.click(second);
          await check();
        }
        await box(page).locator(".consent-btn-primary").click();
      }

      await openFromInspector(page, "out.ducker1", "ducker");
      await check();
    });
  }
});

// The envelope carries NO live overlay, deliberately. It had a dashed rule at the live
// reduction while that reduction lived in a column of its own; once the reduction
// became a block on the POST bar beside this plot, the rule was a second display of one
// quantity, and the weaker of the two — a time axis gives a live reading no position.
// So the plot shows what the settings do, and the meter shows what is happening.
test.describe("ducker envelope", () => {
  const openDucker = async (page: Page): Promise<void> => {
    await page.click("#btn-device");
    await page.click("#btn-live");
    await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true");
    await openFromInspector(page, "out.ducker1", "ducker");
  };

  test("does not repaint when only a meter moves, since nothing on it is live", async ({ page }) => {
    await openDucker(page);
    const before = await box(page).locator("canvas").screenshot();
    await pushMeters(page, [119, 0, -240], [120, 0, -300], [120, 1, -300]);
    await expect(readout(page, "Ducker GR").locator(".v")).toHaveText("-24.0");
    // The reduction reached the readout and the meter; the plot is unchanged.
    expect(await box(page).locator("canvas").screenshot()).toEqual(before);
  });

  test("at unity the readout still separates no reduction from no feed", async ({ page }) => {
    await openDucker(page);
    await pushMeters(page, [119, 0, 0]);
    await expect(readout(page, "Ducker GR").locator(".v")).toHaveText("0.0");
  });
});
