// @vitest-environment jsdom

// The app entry, booted whole against the real index.html markup.
//
// main.ts exports nothing and runs entirely as top-level side effects, so it can
// only be driven by importing it — which means one boot per test file and
// `vi.resetModules()` between the tests that need different seeded storage. The
// four globals below are the ones jsdom does not provide and main.ts calls
// unguarded; nothing else is stubbed, and in particular `window.__TAURI_INTERNALS__`
// is deliberately left undefined so `isTauri()` stays false and no IPC is attempted.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./core/storage", async (importOriginal) => {
  const real = await importOriginal<typeof import("./core/storage")>();
  return {
    ...real,
    openTextDocument: vi.fn(async () => null),
    saveTextDocument: vi.fn(async () => ({ saved: true, path: "/tmp/plan.json" })),
    readTextByPath: vi.fn(async () => null),
    downloadText: vi.fn(),
    exportSvgToPng: vi.fn(async () => ({ saved: true, path: "/tmp/board.png" })),
    exportSvgToPdf: vi.fn(async () => ({ saved: true, path: "/tmp/board.pdf" })),
  };
});

import { openTextDocument, readTextByPath, saveTextDocument } from "./core/storage";
import { t } from "./i18n";
import { $, bootApp, installAppGlobals, restoreAppGlobals, statusText } from "./main.test-util";

// The boot fixture — the markup, the globals and the module import — is
// `main.test-util.ts`, shared with the other two entry suites. `tauri: false` is the
// point of this file: with no shell `isTauri()` stays false and no IPC is attempted,
// so everything below is the browser path.
const boot = (seed: Record<string, string> = {}): Promise<unknown> => bootApp({ seed, tauri: false });
const status = statusText;

beforeEach(installAppGlobals);
afterEach(restoreAppGlobals);

describe("boot", () => {
  it("paints the board, the inspector and the status line", async () => {
    await boot();
    expect(status()).toContain("URX44V");
    expect($("graph-host").querySelector("svg")).not.toBeNull();
    expect($("graph-host").querySelectorAll("g.node[data-id]").length).toBeGreaterThan(5);
    expect($("inspector").childElementCount).toBeGreaterThan(0);
  });

  it("offers every model and the remembered one", async () => {
    await boot();
    const picker = $<HTMLSelectElement>("model-picker");
    expect(picker.options.length).toBeGreaterThan(1);
    expect(picker.value).toBe("URX44V");
  });

  it("restores the remembered model", async () => {
    await boot({ "urx-model": "URX22" });
    expect($<HTMLSelectElement>("model-picker").value).toBe("URX22");
    expect(status()).toContain("URX22");
  });

  it("falls back to the default model when the remembered one is not a model", async () => {
    await boot({ "urx-model": "URX99" });
    expect($<HTMLSelectElement>("model-picker").value).toBe("URX44V");
  });

  it("restores the remembered sample rate", async () => {
    await boot({ "urx-rate": "96000" });
    expect($<HTMLSelectElement>("rate-picker").value).toBe("96000");
  });

  // The badge exists to warn that the rate picker will not stick. Before any device
  // has been read the state is unknown, which is its own thing — never "off", which
  // is the state in which the picker IS trusted.
  it("draws the Follow USB badge as unknown until a device is read", async () => {
    await boot();
    const badge = $("follow-usb");
    expect(badge.dataset.state).toBe("unknown");
    expect(badge.getAttribute("aria-pressed")).toBe("mixed");
  });
});

describe("view state", () => {
  it("switches to CONSOLE and back, remembering the choice", async () => {
    await boot();
    $("btn-view-console").click();
    expect($("graph-host").hidden).toBe(true);
    expect($("console-host").hidden).toBe(false);
    expect(localStorage.getItem("urx-view")).toBe("console");

    $("btn-view-graph").click();
    expect($("graph-host").hidden).toBe(false);
    expect(localStorage.getItem("urx-view")).toBe("graph");
  });

  it("restores the remembered view", async () => {
    await boot({ "urx-view": "console" });
    expect($("console-host").hidden).toBe(false);
    expect($("graph-host").hidden).toBe(true);
  });

  it("remembers the label source", async () => {
    await boot();
    const btn = $("btn-labels");
    const before = btn.getAttribute("aria-pressed");
    btn.click();
    expect(btn.getAttribute("aria-pressed")).not.toBe(before);
    expect(localStorage.getItem("urx-labels")).not.toBeNull();
  });

  it("remembers the off-send declutter", async () => {
    await boot();
    const btn = $("btn-hide-off");
    btn.click();
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("urx-hide-off")).not.toBeNull();
  });

  it("restores the remembered declutter", async () => {
    await boot({ "urx-hide-off": "1" });
    expect($("btn-hide-off").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("the ?reset entry", () => {
  // Cleared synchronously before anything below reads localStorage, and the flag is
  // stripped so a later manual reload does not clear again.
  it("clears storage and strips the flag from the URL", async () => {
    history.replaceState(null, "", "/?reset");
    localStorage.setItem("urx-view", "console");
    await boot({ "urx-view": "console" });
    expect(location.search).not.toContain("reset");
    // The seeded view did not survive, so the board is on screen rather than the console.
    expect($("graph-host").hidden).toBe(false);
    history.replaceState(null, "", "/");
  });
});

describe("model and rate pickers", () => {
  it("switches the model and remembers it", async () => {
    await boot();
    const picker = $<HTMLSelectElement>("model-picker");
    picker.value = "URX22";
    picker.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(localStorage.getItem("urx-model")).toBe("URX22"));
    expect(status()).toContain("URX22");
  });

  it("switches the rate and remembers it", async () => {
    await boot();
    const rate = $<HTMLSelectElement>("rate-picker");
    const other = [...rate.options].find((o) => o.value !== rate.value)!;
    rate.value = other.value;
    rate.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(localStorage.getItem("urx-rate")).toBe(other.value));
  });
});

describe("file flow", () => {
  it("does nothing when the open dialog is dismissed", async () => {
    await boot();
    const before = status();
    $("btn-open").click();
    await vi.waitFor(() => expect(openTextDocument).toHaveBeenCalled());
    expect(status()).toBe(before);
  });

  it("loads a plan document the dialog returns", async () => {
    await boot();
    const { serialize } = await import("./core/plan");
    const { defaultPlan } = await import("./models/initial-state");
    vi.mocked(openTextDocument).mockResolvedValueOnce({
      text: serialize(defaultPlan("URX22")),
      path: "/x/loaded.json",
    });
    $("btn-open").click();
    await vi.waitFor(() => expect(status()).toContain("loaded"));
    expect($<HTMLSelectElement>("model-picker").value).toBe("URX22");
  });

  // A decode failure surfaces the copyable report instead of loading, leaving the
  // plan on screen.
  it("reports an unreadable document without replacing the board", async () => {
    await boot();
    const nodes = $("graph-host").querySelectorAll("g.node[data-id]").length;
    vi.mocked(openTextDocument).mockResolvedValueOnce({ text: "{", path: "/x/bad.json" });
    $("btn-open").click();
    await vi.waitFor(() => expect(vi.mocked(openTextDocument)).toHaveBeenCalled());
    expect($("graph-host").querySelectorAll("g.node[data-id]").length).toBe(nodes);
  });

  it("saves through the shell and reports where it landed", async () => {
    await boot();
    $("btn-save").click();
    await vi.waitFor(() => expect(saveTextDocument).toHaveBeenCalled());
    expect(status()).toContain("plan.json");
  });

  it("starts a new plan", async () => {
    await boot();
    $("btn-new").click();
    await vi.waitFor(() => expect($("graph-host").querySelector("svg")).not.toBeNull());
    expect($("graph-host").querySelectorAll("g.node[data-id]").length).toBeGreaterThan(5);
  });
});

// What a document the app cannot open — or can only partly vouch for — does on its way
// in. The two classes are split deliberately and surface differently, and the split is
// what these pin: an illegal wire is a plan this app cannot represent and is REFUSED,
// while an insert-FX slot claimed twice is a plan the app itself writes after a device
// readback, so refusing that one made Fetch → Save → reopen impossible for its own
// document. The two REFUSAL cases assert the board is untouched, because the board exists
// before the decode is attempted and a load that silently did nothing looks identical; the
// warning case deliberately loads, which is the whole of what separates them.
describe("a document the loader will not simply open", () => {
  const nodes = (): number => $("graph-host").querySelectorAll("g.node[data-id]").length;

  /** A plan document with `edit` applied to its parsed form, so a case can put something
   *  in a file that no app gesture can author. */
  async function documentWith(edit: (plan: Record<string, unknown>) => void): Promise<string> {
    const { serialize } = await import("./core/plan");
    const { defaultPlan } = await import("./models/initial-state");
    const doc = JSON.parse(serialize(defaultPlan("URX44V"))) as Record<string, unknown>;
    // `serialize` writes the plan's fields at the document root — the `plan` key belongs to
    // the in-memory `PlanDocument` the loader returns, not to the file — so this edits the
    // root object itself.
    edit(doc);
    return JSON.stringify(doc);
  }

  it("refuses a plan for a model it does not know, naming the model", async () => {
    await boot();
    const before = nodes();
    vi.mocked(openTextDocument).mockResolvedValueOnce({
      text: await documentWith((plan) => void (plan.modelId = "URX99")),
      path: "/x/alien.json",
    });
    $("btn-open").click();

    await vi.waitFor(() => expect(vi.mocked(alert)).toHaveBeenCalled());
    expect(String(vi.mocked(alert).mock.calls.at(-1)![0])).toContain("URX99");
    expect(nodes()).toBe(before);
    expect($("load-report").hidden).toBe(true); // a refusal is the dialog, not the report
  });

  // The report's first line carries WHICH of the two classes it is, and that is the half a
  // substring match on the problem list would miss.
  //
  // The wire is duplicated from a REAL connection rather than invented out of two port
  // names because `duplicate` is the reason under test and only an existing wire can be
  // duplicated. An invented pair is not dropped on the way in — measured: the loader's
  // filter is `isPlanConnection`, which checks SHAPE (a `kind` in `CONNECTION_KINDS`, two
  // string refs), so a wire carrying a valid kind and two refs that resolve to nothing
  // survives the load and reports as `noRule`. Dropping happens to a wire with no kind.
  it("reports a wire the plan carries twice as a validation failure", async () => {
    await boot();
    const before = nodes();
    let wire = "";
    const text = await documentWith((plan) => {
      const conns = plan.connections as Array<Record<string, unknown>>;
      wire = `${String(conns[0].from)} -> ${String(conns[0].to)}`;
      conns.push({ ...conns[0] });
    });
    vi.mocked(openTextDocument).mockResolvedValueOnce({ text, path: "/x/illegal.json" });
    $("btn-open").click();

    await vi.waitFor(() => expect($("load-report").hidden).toBe(false));
    expect($("load-report-body").textContent?.split("\n")[0]).toBe("URX Router plan validation failed");
    expect($("load-report-body").textContent).toContain(`[duplicate] ${wire}`);
    expect(nodes()).toBe(before);
    // A refusal offers no way past itself — that button belongs to the warning class.
    expect($("load-report").querySelector("#load-report-proceed")).toBeNull();
  });

  // The warning class: reported, and openable anyway from the report itself. Two mono
  // channels are given the same 1-of insert-FX slot — the screens cannot author that
  // (the menu locks a slot another node holds), so it can only arrive from outside.
  it("warns about an insert-FX slot claimed twice, and opens the plan anyway on request", async () => {
    await boot();
    vi.mocked(openTextDocument).mockResolvedValueOnce({
      text: await documentWith((plan) => {
        const params = plan.nodeParams as Record<string, Record<string, unknown>>;
        // Pitch Fix, whose slot is device-wide 1-of. ch1 and ch3 rather than ch1/ch2:
        // a STEREO-linked pair shares one claim, and the census would collapse them.
        params.ch1 = { ...params.ch1, insertFx: 512 };
        params.ch3 = { ...params.ch3, insertFx: 512 };
      }),
      path: "/x/contended.json",
    });
    $("btn-open").click();

    await vi.waitFor(() => expect($("load-report").hidden).toBe(false));
    expect($("load-report-body").textContent?.split("\n")[0]).toBe("URX Router plan validation warnings");
    expect($("load-report-body").textContent).toContain("[insertFxSlot]");

    // "Load anyway" is offered on this class and only this class, and it loads.
    const proceed = $("load-report").querySelector<HTMLButtonElement>("#load-report-proceed");
    expect(proceed).not.toBeNull();
    proceed!.click();
    await vi.waitFor(() => expect(statusText()).toContain("contended.json"));
  });

  // A recent entry whose file no longer opens is dropped without a prompt, so the status
  // line has to say so — the list mutated under the operator. Seeded through the stored
  // list rather than by saving first: what is under test is the removal, and a save would
  // put this case's outcome behind the save path's own behaviour.
  it("drops a recent entry whose file no longer reads, and says so", async () => {
    const entry = { path: "/x/gone.json", name: "gone.json", modelId: "URX44V" };
    await boot({ "urx-recent": JSON.stringify([entry]) });
    const row = $("inspector").querySelector<HTMLButtonElement>(".recent-row");
    expect(row, "the seeded recent entry is on screen").not.toBeNull();

    vi.mocked(readTextByPath).mockRejectedValueOnce(new Error("ENOENT"));
    row!.click();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.recentRemoved("gone.json")));
    // Removing the entry is not the whole of it: WHY it would not open has to reach the
    // operator too, or the list mutates with no stated reason. `showLoadError` is that
    // surface, and off Tauri it lands on window.alert carrying the underlying failure.
    expect(vi.mocked(alert)).toHaveBeenCalled();
    expect(String(vi.mocked(alert).mock.calls.at(-1)![0])).toContain("ENOENT");
    // Removed from the list as well as reported — keeping it would only reproduce the
    // same error on the next press.
    expect($("inspector").querySelector(".recent-row")).toBeNull();
    expect(localStorage.getItem("urx-recent")).not.toContain("gone.json");
  });
});

describe("menus", () => {
  it("opens a menu, focuses its first item and closes on Escape", async () => {
    await boot();
    const trigger = $("btn-file");
    trigger.click();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect($("file-menu").hidden).toBe(false);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect($("file-menu").hidden).toBe(true);
  });

  it("walks the items with the arrow keys", async () => {
    await boot();
    $("btn-file").click();
    const first = document.activeElement;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).not.toBe(first);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(first);
  });

  it("closes on a press outside it", async () => {
    await boot();
    $("btn-file").click();
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect($("file-menu").hidden).toBe(true);
  });
});

describe("keyboard", () => {
  it("clears the graph selection on Escape", async () => {
    await boot();
    const wire = $("graph-host").querySelector(".wire-hit")!;
    wire.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, bubbles: true }));
    wire.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect($("inspector").childElementCount).toBeGreaterThan(0);
  });

  // Deletion acts on the graph's selection, so it must not fire from the CONSOLE
  // view — the console renders no deletable kinds.
  it("does not delete from the CONSOLE view", async () => {
    await boot();
    $("btn-view-console").click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    $("btn-view-graph").click();
    expect($("graph-host").querySelectorAll(".wire-hit").length).toBeGreaterThan(0);
  });
});

describe("localization", () => {
  it("boots into the remembered language", async () => {
    await boot({ "urx-lang": "ja" });
    expect(document.documentElement.lang).toBe("ja");
    expect($("btn-file").textContent).not.toBe("");
  });
});
