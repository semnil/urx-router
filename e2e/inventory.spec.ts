import { test, expect } from "./fixtures";
import { allItems, Inventory, itemsFor, itemsUnder, type Item } from "./inventory";
import { en } from "../src/i18n/en";
import { LIVE_COMMANDS, stubTauriBoot, stubTauriDevice } from "./tauri-stub";
import { planParam } from "./plan-param";
import { listControls } from "../src/core/midi/controls";
import { getModel } from "../src/models";
import { defaultPlan } from "../src/models/initial-state";
import { selectWire } from "./graph-helpers";
import { COMP_EQ_SSMCS } from "../src/core/control/params";

// Display-item coverage for every dialog, window, menu and popover: each one is
// driven through the states it has, and everything the message catalog holds for
// it must be on screen in at least one of them.
//
// The defect this answers is an item that silently stopped being displayed — the
// MIDI window's Behavior key, dropped along with the overlay panel it used to
// live on, its two catalog entries left behind with nothing reading them. Per-item
// assertions cannot catch that class: the item nobody thought to assert is the one
// nobody notices is gone. So the expected set is DERIVED from the catalog, and the
// ledger below refuses a message that nothing accounts for.
//
// **Scope is stated, not implied.** The ledger runs over the WHOLE catalog, not
// over the namespaces the surfaces happen to name, because a namespace nobody has
// thought about is exactly the case that needs to fail loudly. A message is
// accounted for in one of four ways, each of which has to be written down:
// a surface claims it; a surface hands it to a named other one (`elsewhere`); a
// surface pins that it is never shown here (`neverShown`, asserted as ABSENT); or
// its namespace is not a dialog at all (OUT_OF_SCOPE).

interface Surface {
  /** Message roots this surface answers for, whole. */
  roots?: string[];
  /** Individual messages it shows from another namespace. */
  keys?: string[];
  /** Messages under those roots that a DIFFERENT, NAMED surface prints. The ledger
   *  holds that surface to it, so a rename cannot leave the note quietly false. */
  elsewhere?: Record<string, SurfaceName>;
  /** Messages this surface never prints, with what does print them instead. Pinned
   *  rather than merely skipped: `wronglyShown` fails if one turns up here after all. */
  neverShown?: Record<string, string>;
  /** Messages the app shows only through a label attribute (see InventoryOptions). */
  viaAttribute?: string[];
  /** Messages rendered inside a larger run (see InventoryOptions). */
  composed?: string[];
}

// Named up front so `elsewhere` can be typed by them: a note that hands a message
// to another surface names that surface, and the ledger holds it to that rather
// than trusting prose a rename would leave quietly false.
const SURFACE_NAMES = [
  "consent",
  "dropzone",
  "loadReport",
  "rateChoice",
  "licenses",
  "deviceSetup",
  "dynScreen",
  "prefs",
  "midiWindow",
  "toolbar",
  "consolePopovers",
] as const;
type SurfaceName = (typeof SURFACE_NAMES)[number];

const SURFACES: Record<SurfaceName, Surface> = {
  consent: {
    roots: ["consent"],
  },
  dropzone: {
    roots: ["dropzone"],
    neverShown: {
      // The .urxf caption needs the settings-file import registered, which needs
      // the Tauri shell; and under Tauri the drop arrives as a shell event, so the
      // DOM drag events this suite dispatches never reach the overlay at all.
      "dropzone.planOrSettings": "the .urxf registration and the DOM drag path exclude each other",
    },
  },
  loadReport: {
    roots: ["loadReport", "compareReport"],
  },
  rateChoice: {
    roots: ["rateChoice"],
  },
  licenses: {
    roots: ["licenses"],
    neverShown: {
      // An unparseable notice is a packaging defect, so the box is never opened at
      // all and the shell's own error dialog carries it (main.ts, showError).
      "licenses.error": "the shell's native error dialog",
    },
  },
  deviceSetup: {
    roots: ["deviceSetup"],
    elsewhere: { "deviceSetup.menuItem": "toolbar" },
    // The Date/Time section prints its two notes as one paragraph.
    composed: ["deviceSetup.clockNote", "deviceSetup.timeZoneNote"],
  },
  dynScreen: {
    roots: ["dynTuning"],
    // The peak readout is the prefix in front of its own value ("pk -12.0").
    composed: ["dynTuning.peakPrefix"],
  },
  prefs: {
    roots: ["prefs"],
    // The gear button carries the modal's own title as its tooltip; the heading
    // inside prints it as text, so this only says which channel is enough.
    viaAttribute: ["prefs.title"],
    // Under --experimental the scope note gains a sentence about the diagnostics,
    // printed as one paragraph with the note it extends.
    composed: ["prefs.diagNote"],
    neverShown: {
      "prefs.planNoteShare": "the demo bundle only, and this suite serves the desktop-shaped one",
    },
  },
  midiWindow: {
    roots: ["midi"],
    elsewhere: { "midi.menuItem": "toolbar" },
    // The delete button is an icon with its meaning in the tooltip, and the Linked
    // marker explains itself the same way — both by design, in a table that has no
    // room for the sentence.
    viaAttribute: ["midi.remove", "midi.linkedHint"],
    // The control vocabularies are composed into one label per assignment
    // ("CH 1 · GATE · Threshold"), never printed alone.
    composed: ["midi.param", "midi.scope", "midi.scopedParam"],
    neverShown: {
      // ui/midi.ts routes all four through the MAIN window's status line.
      "midi.windowError": "the main window's status line",
      "midi.inputError": "the main window's status line",
      "midi.outputError": "the main window's status line",
      "midi.outputStalled": "the main window's status line",
    },
  },
  toolbar: {
    roots: ["toolbar"],
    keys: ["midi.menuItem", "deviceSetup.menuItem", "licenses.title", "prefs.title"],
    // The toolbar is a strip of short labels, so what each control means is in its
    // tooltip. The live tally is the tag alone — the model it used to name is the
    // model picker's, which locks for the session rather than repeating itself here.
    viaAttribute: [
      "toolbar.viewGraphHint",
      "toolbar.viewConsoleHint",
      "toolbar.viewHint",
      "toolbar.hideOffSendsHint",
      "toolbar.labelsHint",
      "toolbar.liveSyncHint",
      "toolbar.followUsbOnHint",
      "toolbar.followUsbOffHint",
      "toolbar.followUsbUnknownHint",
      "prefs.title",
    ],
    neverShown: {
      "toolbar.desktopApp": "the demo bundle only",
      "toolbar.desktopAppHint": "the demo bundle only",
      "toolbar.shareUrl": "the demo bundle only",
      "toolbar.shareUrlHint": "the demo bundle only",
      "toolbar.downloadJson": "the demo bundle only",
      "toolbar.downloadJsonHint": "the demo bundle only",
    },
  },
  consolePopovers: {
    keys: ["console.meterPoint", "console.meterPointHint", "console.sendPan"],
  },
};

/**
 * Namespaces this suite does not answer for, and why. Not a convenience list: it
 * is the countable statement of what a green run does NOT prove, and it is what
 * makes a namespace added tomorrow fail here instead of passing unnoticed.
 */
const OUT_OF_SCOPE: Record<string, string> = {
  appMenu: "the macOS application menu — native chrome, outside the webview",
  console: "the CONSOLE view — a view, not a dialog (its two popovers are claimed above)",
  inspector: "the inspector — an always-on panel, not a dialog",
  shelf: "the graph's hidden-node shelf — canvas chrome, not a dialog",
  selbar: "the graph's multi-selection bar — canvas chrome, not a dialog",
  tooltip: "canvas tooltips — hover affordances on the graph",
  warning: "the warning cards — inline on the graph and the inspector",
  status: "the status line — one strip below every view, driven by most other specs",
  linkStats:
    "the link ledger — a status-bar readout and its panel, covered field by field in linkstats.spec.ts, whose expectation tables are typed over the view's own key lists",
  confirm: "the shell's native confirm dialogs — outside the webview",
  filter: "EQ filter-type names — a value vocabulary, printed wherever a band is",
  error: "error text — routed to the status line or a native dialog by its caller",
};

const names = SURFACE_NAMES;

/** Everything a surface's roots and keys hold, before either excuse applies. */
function allItemsOf(name: SurfaceName): Item[] {
  const s = SURFACES[name];
  return [...itemsUnder(...(s.roots ?? [])), ...itemsFor(...(s.keys ?? []))];
}

const excusedOf = (name: SurfaceName): Item[] => itemsFor(...Object.keys(SURFACES[name].neverShown ?? {}));

/** The items one surface must show: its roots and keys, less what it hands to
 *  another surface and what it pins as never shown here. */
function itemsOf(name: SurfaceName): Item[] {
  const s = SURFACES[name];
  return allItemsOf(name).filter((i) => !s.elsewhere?.[i.key] && !s.neverShown?.[i.key]);
}

function inventoryOf(name: SurfaceName): Inventory {
  const s = SURFACES[name];
  return new Inventory(itemsOf(name), { viaAttribute: s.viaAttribute, composed: s.composed });
}

/** Assert a surface showed everything it claims, and nothing it swore it would not. */
function expectComplete(name: SurfaceName, inv: Inventory): void {
  expect(inv.missing()).toEqual([]);
  expect(inv.wronglyShown(excusedOf(name))).toEqual([]);
}

// ---- the ledger -------------------------------------------------------------

test("every message in the catalog is claimed by a surface or excused by name", () => {
  const claimed = new Set(names.flatMap((n) => itemsOf(n).map((i) => i.key)));
  const excused = new Set(names.flatMap((n) => Object.keys(SURFACES[n].neverShown ?? {})));

  // Over the WHOLE catalog: a new namespace is unaccounted for until someone says
  // what shows it, or says in OUT_OF_SCOPE that this suite does not.
  const unaccounted = allItems()
    .map((i) => i.key)
    .filter((k) => !claimed.has(k) && !excused.has(k) && !(k.split(".")[0] in OUT_OF_SCOPE));
  expect(unaccounted).toEqual([]);

  // An `elsewhere` note names the surface that takes over, so the ledger can hold
  // that one to it rather than trusting the prose.
  for (const n of names)
    for (const [key, owner] of Object.entries(SURFACES[n].elsewhere ?? {}))
      expect(itemsOf(owner).map((i) => i.key)).toContain(key);

  // An excuse for a message that has left the catalog must not still be listed;
  // one that has stopped being true is caught in that surface's own run, by
  // `wronglyShown`, which is the only place the answer can be observed.
  const live = new Set(allItems().map((i) => i.key));
  expect([...excused].filter((k) => !live.has(k))).toEqual([]);
  expect(Object.keys(OUT_OF_SCOPE).filter((ns) => !(ns in en))).toEqual([]);
});

// ---- the surfaces -----------------------------------------------------------

test("the consent gate shows its disclaimer, both actions and the acceptance line", async ({ page }) => {
  await stubTauriBoot(page);
  // The shared stub pre-accepts so every other spec skips the gate; this is the
  // one that wants it, so drop the flag after the stub has written it.
  await page.addInitScript(() => localStorage.removeItem("urx-disclaimer-accepted"));
  await page.goto("/");
  await expect(page.locator("#consent")).toBeVisible();

  const inv = inventoryOf("consent");
  await inv.take(page, "#consent");
  expectComplete("consent", inv);
});

test("the drag & drop overlay names what it takes", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["{}"], "plan.json", { type: "application/json" }));
    window.dispatchEvent(new DragEvent("dragenter", { dataTransfer: transfer, bubbles: true, cancelable: true }));
  });
  await expect(page.locator("#dropzone")).toBeVisible();

  const inv = inventoryOf("dropzone");
  await inv.take(page, "#dropzone");
  expectComplete("dropzone", inv);
});

test("the load report shows all three framings and both Copy faces", async ({ page }) => {
  const inv = inventoryOf("loadReport");
  // Clipboard access is unavailable in this context, and the modal falls back to
  // selecting the report instead of reporting "Copied" — so the write is stubbed
  // to resolve, which is the state a desktop press is in.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.resolve() } });
  });

  // A refusal: the plan is not loaded, and nothing offers to load it anyway.
  await page.goto("/?plan=z!!!not-deflate");
  await expect(page.locator("#load-report")).toBeVisible();
  await inv.take(page, "#load-report");
  await page.click("#load-report-copy");
  await expect(page.locator("#load-report-copy")).toHaveText("Copied");
  await inv.take(page, "#load-report");

  // A warning: an insert-FX slot collision, which the plan can be opened despite.
  const slotPlan = {
    format: "urx-router-plan",
    version: 1,
    modelId: "URX44V",
    connections: [],
    nodeParams: { ch1: { insertFx: 256 }, ch2: { insertFx: 257 } },
  };
  await page.goto(`/?plan=${planParam(slotPlan)}`);
  await expect(page.locator("#load-report-proceed")).toBeVisible();
  await inv.take(page, "#load-report");

  // The read-only device comparison borrows the same modal under its own framing.
  await stubTauriDevice(page, { commands: { experimental_enabled: true } });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-device");
  await page.click("#btn-compare");
  await expect(page.locator("#load-report-title")).toHaveText("Device comparison");
  await inv.take(page, "#load-report");

  expectComplete("loadReport", inv);
});

test("the rate-choice modal shows all three answers and the high-rate note", async ({ page }) => {
  const inv = inventoryOf("rateChoice");
  const startWrite = async (): Promise<void> => {
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await page.click("#btn-device");
    await page.click("#btn-write");
    await expect(page.locator("#rate-choice")).toBeVisible();
  };

  await stubTauriDevice(page, { values: { 766: 96000, 848: 1 } });
  await startWrite();
  await inv.take(page, "#rate-choice");

  // The extra note appears only when the rate the write would settle on costs the
  // plan a feature, which 192 kHz does (stereo CH EQ is forced off there). It is
  // the DEVICE's rate that decides, so the plan's is left where the stub puts it.
  await stubTauriDevice(page, { values: { 766: 192000, 848: 1 } });
  await startWrite();
  await inv.take(page, "#rate-choice");

  expectComplete("rateChoice", inv);
});

// The cargo-about structure in miniature, as licenses.spec.ts builds it. A copy
// rather than a shared fixture: Playwright refuses one spec importing another
// (measured), and lifting twelve lines of HTML into a module of its own would owe
// the reusable-assets index a row for something nothing else will reach for.
// Three crates and two texts, because the count line is written in the plural and
// the singular is a branch the catalog probe does not yield.
const NOTICE = `<html><body><main class="container"><ul class="licenses-list">
  <li class="license"><h3 id="Apache-2.0">Apache License 2.0</h3>
    <ul class="license-used-by"><li><a href="#">alpha 1.0.0</a></li><li><a href="#">beta 2.1.0</a></li></ul>
    <pre class="license-text">APACHE TEXT ONE</pre></li>
  <li class="license"><h3 id="Apache-2.0">Apache License 2.0</h3>
    <ul class="license-used-by"><li><a href="#">gamma 0.3.0</a></li></ul>
    <pre class="license-text">APACHE TEXT TWO</pre></li>
</ul></main></body></html>`;

test("the licenses modal shows its title, the family meta and its close action", async ({ page }) => {
  await stubTauriBoot(page, { third_party_licenses: NOTICE });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-file");
  await page.click("#btn-licenses");
  await expect(page.locator("#licenses-modal")).toBeVisible();

  const inv = inventoryOf("licenses");
  await inv.take(page, "#licenses-modal");
  expectComplete("licenses", inv);
});

test("the device setup screen shows every page, on the model that has it and the one that does not", async ({
  page,
}) => {
  const inv = inventoryOf("deviceSetup");
  const openSetup = async (): Promise<void> => {
    await page.click("#btn-device");
    await page.click("#btn-device-setup");
    await expect(page.locator("#device-setup-modal")).toBeVisible();
  };

  // The URX44V has every page, so this pass covers the notes that describe them.
  await stubTauriDevice(page);
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await openSetup();
  await inv.take(page, "#device-setup-modal");
  // Two edits reveal the footer's pending count, which nothing else prints. Two,
  // not one: the count is written in the plural, and its singular form is a branch
  // the catalog probe does not yield.
  await page.locator("#device-setup-brightness").fill("3");
  await page.locator("#device-setup-brightness").dispatchEvent("change");
  await page.selectOption("#device-setup-apo-time", { index: 1 });
  await expect(page.locator("#device-setup-pending")).toContainText("unapplied changes");
  await inv.take(page, "#device-setup-modal");

  // The URX22 has neither Date/Time nor HDMI, and says so where those pages were.
  await stubTauriDevice(page, { model: "URX22" });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX22");
  await openSetup();
  await inv.take(page, "#device-setup-modal");

  expectComplete("deviceSetup", inv);
});

test("the channel tuning screens show every processor, both displays and their notes", async ({ page }) => {
  const inv = inventoryOf("dynScreen");
  // The inspector's own section headings, as dyntuning.spec.ts addresses them.
  const SECTION_OF = { gate: /^GATE$/, comp: /^COMP$/, eq: /^EQ$/, ducker: /^Ducker$/, ssmcs: /^SSMCS$/ };

  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-model", "URX44V");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");

  const box = page.locator("#dyn-screen-box");
  /** A row by its EXACT label: "1-Knob" substring-matches "1-Knob Level" too, and
   *  picking by DOM order instead would silently follow a row inserted above it. */
  const exactRow = (label: string) => box.locator(".prefs-row").filter({ has: page.getByText(label, { exact: true }) });

  const openFromInspector = async (kind: keyof typeof SECTION_OF, id = "ch1"): Promise<void> => {
    await page.locator(`#graph-host g.node[data-id="${id}"]`).click();
    const sec = page.locator("#inspector .insp-section", {
      has: page.locator("summary", { hasText: SECTION_OF[kind] }),
    });
    if (!(await sec.evaluate((el) => (el as HTMLDetailsElement).open))) await sec.locator("summary").click();
    // The button that opens the screen is part of the feature's display surface,
    // and it is the only place its "…screen" wording appears.
    await inv.take(page, "#inspector");
    await sec.locator(`#btn-${kind}-screen`).click();
    await expect(box).toBeVisible();
  };

  for (const kind of ["gate", "comp"] as const) {
    await openFromInspector(kind);
    await inv.take(page, "#dyn-screen-modal");
    await page.click("#dyn-mode-curve");
    await inv.take(page, "#dyn-screen-modal");
    await page.click("#dyn-mode-ladder");
    // COMP's 1-knob hands three values over to the device, which is the one state
    // that tags a row as device-driven.
    if (kind === "comp") {
      await exactRow("1-Knob").locator("button", { hasText: "On" }).click();
      await expect(page.locator("#dyn-oneknob-level")).toBeEnabled();
      await inv.take(page, "#dyn-screen-modal");
    }
    await page.locator("#dyn-screen-modal .consent-btn-secondary").click();
  }

  await openFromInspector("eq");
  await inv.take(page, "#dyn-screen-modal");
  // A band whose filter type is fixed, and one whose type leaves Q unused, are
  // both marked — the segmented bar is what reaches them.
  for (const band of ["low", "lowmid", "highmid", "high"]) {
    await page.click(`#dyn-band-${band}`);
    await inv.take(page, "#dyn-screen-modal");
  }
  // The EQ's own 1-knob replaces the band block with the note explaining why.
  await box
    .locator(".prefs-section")
    .filter({ has: page.locator("h3", { hasText: "1-knob" }) })
    .locator("button", { hasText: "ON" })
    .click();
  await inv.take(page, "#dyn-screen-modal");
  await page.locator("#dyn-screen-modal .consent-btn-secondary").click();

  // DUCKER opens on the ducker node rather than on a channel, so it is reached from
  // that node's own inspector section. Both key states are driven: the default plan
  // wires CH 1 to every ducker, so the lane names it first, and the wire is then
  // deleted so the lane can say there is none — a state the unit really has, and one
  // it reports as engaged rather than as silence.
  const openDucker = () => openFromInspector("ducker", "out.ducker1");

  await openDucker();
  await inv.take(page, "#dyn-screen-modal");
  await page.locator("#dyn-screen-modal .consent-btn-secondary").click();

  await selectWire(page, "ch1:out", "out.ducker1:in");
  await page.keyboard.press("Delete");
  await openDucker();
  await inv.take(page, "#dyn-screen-modal");
  await page.locator("#dyn-screen-modal .consent-btn-secondary").click();

  // The morphing strip replaces COMP and the 4-band EQ, so its three faces are reached
  // by switching the channel's bank first. Once open they move between each other from
  // the title row, which is where the face labels are.
  await page.locator('#graph-host g.node[data-id="ch1"]').click();
  await page.locator("#inspector .param", { hasText: "COMP/EQ Type" }).locator("select").selectOption("1");
  await openFromInspector("ssmcs");
  await inv.take(page, "#dyn-screen-modal");
  await page.click("#dyn-face-ssmcs-comp");
  await inv.take(page, "#dyn-screen-modal");
  await page.click("#dyn-mode-curve");
  await inv.take(page, "#dyn-screen-modal");
  await page.click("#dyn-face-ssmcs-eq");
  // A shelf band is what tags a Q row as unread; MID is the one that reads it.
  for (const band of ["low", "mid", "high"]) {
    await page.click(`#dyn-ssmcs-band-${band}`);
    await inv.take(page, "#dyn-screen-modal");
  }

  expectComplete("dynScreen", inv);
});

test("the Preferences modal shows every section in both the browser and the desktop build", async ({ page }) => {
  const inv = inventoryOf("prefs");

  // Browser: the desktop-gated rows render locked, which is where the tag prints.
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-prefs");
  await expect(page.locator("#prefs-modal")).toBeVisible();
  await inv.take(page, "#prefs-modal");
  await inv.take(page, "#btn-prefs");

  // Desktop, under --experimental (one note in the device section names the
  // diagnostics' coverage and appears nowhere else). The manual update check has
  // three answers, all three of which the row prints, and the sleep hold can be
  // refused by the OS — a state only a Live sync session can reach, since with no
  // session the toggle stores the preference and never asks.
  await stubTauriDevice(page, { commands: { experimental_enabled: true, ...LIVE_COMMANDS } });
  await page.addInitScript(() => {
    const internals = (
      window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, ...args: unknown[]) => Promise<unknown> } }
    ).__TAURI_INTERNALS__;
    const invoke = internals.invoke.bind(internals);
    // The outcome is read per call and the answer is HELD until the test releases
    // it, so the in-flight wording is on screen for exactly as long as the test
    // needs rather than for a guessed number of milliseconds.
    const w = window as unknown as { __update: string; __releaseUpdate: () => void };
    internals.invoke = (cmd: string, ...rest: unknown[]) => {
      if (cmd === "plugin:updater|check")
        return new Promise((resolve, reject) => {
          w.__releaseUpdate = () => {
            if (w.__update === "none") resolve(null);
            else if (w.__update === "fail") reject(new Error("network unreachable"));
            else resolve({ version: "9.9.9", currentVersion: "1.0.0" });
          };
        });
      // Declining the offered update keeps the modal open on the version note.
      if (cmd === "plugin:dialog|confirm") return Promise.resolve(false);
      if (cmd === "set_keep_awake") return Promise.reject(new Error("PowerCreateRequest failed"));
      return invoke(cmd, ...rest);
    };
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-prefs");
  await expect(page.locator("#prefs-modal")).toBeVisible();
  await inv.take(page, "#prefs-modal");

  // All three answers the check can come back with. The row is re-runnable in
  // place — every outcome re-enables the button and leaves the modal open — so
  // this needs no reload between them.
  const checkUpdate = async (outcome: string, settled: RegExp): Promise<void> => {
    await page.evaluate((v) => ((window as unknown as { __update: string }).__update = v), outcome);
    await page.click("#prefs-update-now");
    await expect(page.locator("#prefs-update-note")).toHaveText("Checking…");
    await inv.take(page, "#prefs-modal");
    await page.evaluate(() => (window as unknown as { __releaseUpdate: () => void }).__releaseUpdate());
    await expect(page.locator("#prefs-update-note")).toHaveText(settled);
    await inv.take(page, "#prefs-modal");
  };
  await checkUpdate("declined", /9\.9\.9/);
  await checkUpdate("none", /up to date/);
  await checkUpdate("fail", /failed/);

  // The refused hold, whose reason lands on the note under the row. The OS is only
  // asked while a session is up: with none running the toggle stores the preference
  // and nothing can refuse it.
  await page.click("#prefs-modal .consent-btn-secondary");
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true");
  await page.click("#btn-prefs");
  await page.click('#prefs-prevent-sleep button:has-text("ON")');
  await expect(page.locator("#prefs-sleep-error")).not.toHaveText("");
  await inv.take(page, "#prefs-modal");

  expectComplete("prefs", inv);
});

test("the toolbar and its three menus show every entry, in each of their states", async ({ page }) => {
  const inv = inventoryOf("toolbar");

  const takeMenus = async (): Promise<void> => {
    await inv.take(page, "#toolbar");
    for (const [trigger, panel] of [
      ["#btn-file", "#file-menu"],
      ["#btn-device", "#device-menu"],
      ["#btn-view", "#view-menu"],
    ]) {
      await page.click(trigger);
      await inv.take(page, panel);
      await page.keyboard.press("Escape");
    }
  };

  // A desktop shell with --experimental: every menu entry is present at once.
  await stubTauriDevice(page, {
    commands: { experimental_enabled: true, ...LIVE_COMMANDS },
    values: { 766: 48000, 848: 1 },
    confirm: "Ok",
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await takeMenus();

  // Both faces of the two View toggles, each of which names its next action.
  await page.click("#btn-view");
  await page.click("#btn-hide-off");
  await page.click("#btn-view");
  await page.click("#btn-labels");
  await takeMenus();

  // Live sync: the toggle's hint, and the on-air tally that only a session prints.
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#live-tally")).toBeVisible();
  await takeMenus();
  await page.click("#btn-device");
  await page.click("#btn-live");

  // The clock badge reads the device on the write path, and each of its three
  // states carries a hint of its own: unknown until the read lands (above), then
  // whichever of on / off the unit answered. The rate matches the plan in both, so
  // nothing has to be settled first.
  await page.click("#btn-device");
  await page.click("#btn-write");
  await expect(page.locator("#follow-usb")).toHaveAttribute("aria-pressed", "true");
  await inv.take(page, "#toolbar");

  await stubTauriDevice(page, {
    commands: { experimental_enabled: true },
    values: { 766: 48000, 848: 0 },
    // The self-test below confirms before it starts; the other three do not.
    confirm: "Ok",
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-device");
  await page.click("#btn-write");
  await expect(page.locator("#follow-usb")).toHaveAttribute("aria-pressed", "false");
  await inv.take(page, "#toolbar");

  // Each device action renames itself while it runs. A read that never answers is
  // what holds one open: the four are started in turn, each on a fresh load, and
  // the menu is reopened to read the label the entry now carries.
  await page.addInitScript(() => {
    const internals = (
      window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, ...args: unknown[]) => Promise<unknown> } }
    ).__TAURI_INTERNALS__;
    const invoke = internals.invoke.bind(internals);
    internals.invoke = (cmd: string, ...rest: unknown[]) =>
      cmd === "vd_get" ? new Promise(() => {}) : invoke(cmd, ...rest);
  });
  for (const entry of ["#btn-fetch", "#btn-write", "#btn-compare", "#btn-selftest"]) {
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await page.click("#btn-device");
    await page.click(entry);
    await page.click("#btn-device");
    await expect(page.locator(entry)).toContainText("Cancel");
    await inv.take(page, "#device-menu");
    await page.keyboard.press("Escape");
  }

  expectComplete("toolbar", inv);
});

test("the console popovers name what they set", async ({ page }) => {
  const inv = inventoryOf("consolePopovers");
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-view-console");
  await expect(page.locator("#console-host")).toBeVisible();

  const ch1 = page.locator(".con-strip", { has: page.getByText("CH 1", { exact: true }) });
  await ch1.locator(".con-tap").click();
  await expect(page.locator(".con-tappop")).toBeVisible();
  await inv.take(page, ".con-tappop");
  await page.keyboard.press("Escape");

  await ch1.locator(".con-panbtn").click();
  await expect(page.locator(".con-spop")).toBeVisible();
  await inv.take(page, ".con-spop");

  expectComplete("consolePopovers", inv);
});

// One mapping per control the model offers, so the window renders the whole
// assignment vocabulary at once: every param token, every processor scope and
// every send target reaches its own row. Addresses are spread over all 16 MIDI
// channels so the list is not one enormous gang; the deliberate gang is added
// separately below, for the two messages only a shared address prints.
function everyControlMapping(): Array<Record<string, unknown>> {
  const model = getModel("URX44V");
  const plan = defaultPlan("URX44V");
  // ONE mono channel into the morphing bank, so both banks' scopes are in the list:
  // a default plan carries no SSMCS channel, and switching every mono channel would
  // take COMP and the 4-band EQ out instead.
  plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, compEqType: COMP_EQ_SSMCS };
  const controls = listControls(model, plan);
  return controls.map((c, i) => ({
    control: c.id,
    addr: { type: "cc", channel: Math.floor(i / 128) % 16, controller: i % 128 },
    mode: "absolute",
    button: "state",
  }));
}

test("the MIDI window shows its whole shell, both vocabularies and every control label", async ({ page }) => {
  const inv = inventoryOf("midiWindow");
  const mappings = everyControlMapping();
  // Two mappings on one address: the second is a gang member, which is the only
  // state that prints the Linked marker and its explanation.
  mappings.push({ ...mappings[0], control: mappings[1].control });

  await page.context().addInitScript((list) => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-model", "URX44V");
    localStorage.setItem("urx-disclaimer-accepted", "1");
    // Seeded once, so the test can empty the list and reload into that state —
    // an init script that rewrote it on every navigation could never get there.
    if (localStorage.getItem("urx-midi") === null)
      localStorage.setItem("urx-midi", JSON.stringify({ models: { URX44V: list } }));
    window.__midiTest = {
      inChannel: null,
      inputPort: null,
      outputPort: null,
      sent: [],
      windowOpened: false,
      openPortsDelayMs: 0,
      openPortsAnswered: 0,
    };
    const relay = new BroadcastChannel("urx-midi-ui");
    let toMain: { onmessage: (d: unknown) => void } | null = null;
    let toWindow: { onmessage: (d: unknown) => void } | null = null;
    relay.onmessage = (e: MessageEvent<{ dir: string; payload: string }>) => {
      if (e.data.dir === "main") toMain?.onmessage(e.data.payload);
      else toWindow?.onmessage(e.data.payload);
    };
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
          case "midi_list_inputs":
            return Promise.resolve(["Stub In"]);
          case "midi_list_outputs":
            return Promise.resolve(["Stub Out"]);
          // Keep the input channel: a binding is what prints the "Assigned"
          // line, and a binding needs a message to actually arrive. Installed
          // under `__midiTest`, the shape midi.spec.ts already publishes — this
          // suite has one name for a captured MIDI channel, not three.
          case "midi_open_input":
            window.__midiTest.inChannel = args.channel as Window["__midiTest"]["inChannel"];
            window.__midiTest.inputPort = args.port as string;
            return Promise.resolve(null);
          case "open_midi_window":
          case "close_midi_window":
          case "focus_midi_window":
          case "midi_close_input":
          case "midi_open_output":
          case "midi_close_output":
          case "midi_send":
            return Promise.resolve(null);
          case "midi_window_open":
            return Promise.resolve(false);
          case "midi_ui_attach_main":
            toMain = args.channel as { onmessage: (d: unknown) => void };
            return Promise.resolve(null);
          case "midi_ui_attach_window":
            toWindow = args.channel as { onmessage: (d: unknown) => void };
            return Promise.resolve(null);
          case "midi_ui_to_main":
            relay.postMessage({ dir: "main", payload: args.payload });
            return Promise.resolve(null);
          case "midi_ui_to_window":
            relay.postMessage({ dir: "window", payload: args.payload });
            return Promise.resolve(null);
          default:
            return Promise.reject(new Error(`stub: unhandled command ${cmd}`));
        }
      },
    };
  }, mappings);

  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-device");
  await page.click("#btn-midi");
  const win = await page.context().newPage();
  await win.goto("/midi.html");
  await expect(win.locator(".mw-title")).toHaveText("MIDI CONTROL");
  await expect(win.locator(".mw-list tr").first()).toBeVisible();
  await inv.take(win, "#midi-window");

  // Learn on with nothing armed, then armed at a control: three hints in all,
  // and only one of them is on screen at a time.
  await win.locator(".mw-in").selectOption("Stub In");
  await win.locator(".mw-learnbtn").click();
  await expect(win.locator(".mw-learnbtn")).toHaveAttribute("aria-pressed", "true");
  await inv.take(win, "#midi-window");
  await page.click("#btn-view-console");
  await page
    .locator(".con-strip", { has: page.getByText("CH 1", { exact: true }) })
    .locator(".con-fader")
    .click();
  await expect(win.locator(".mw-hint")).toContainText("Move a MIDI control");
  await inv.take(win, "#midi-window");
  // The binding lands, and its confirmation is mirrored onto the window's status
  // line — the only place that message is ever printed here.
  await page.evaluate(() => {
    window.__midiTest.inChannel!.onmessage([{ bytes: [0xb0, 100, 64] }, { bytes: [0xb0, 100, 65] }]);
  });
  await expect(win.locator(".mw-status")).toContainText("Assigned");
  await inv.take(win, "#midi-window");

  // The empty list, whose own line replaces the table. The window is a view — the
  // main window holds the mappings — so the store is emptied and the main window
  // reloaded onto it before the window asks for state again.
  await page.evaluate(() => localStorage.setItem("urx-midi", JSON.stringify({ models: { URX44V: [] } })));
  await page.reload();
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await win.reload();
  await expect(win.locator(".mw-empty")).toBeVisible();
  await inv.take(win, "#midi-window");

  expectComplete("midiWindow", inv);
});
