// @vitest-environment jsdom

// The desktop shell's own surfaces: the menus and gates, the update check and the launch flags.
//
// The setup, the teardown and the helpers every desktop case shares are `main.device.test-util.ts`'s,
// which also states what the device table does and does not model.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FAKE_LAUNCH_FLAGS_OFF } from "../e2e/race/fake-flags";
import { $, APP_BODY, bootApp, deviceCommands, statusText, unwrittenRead } from "./main.test-util";
import type { TauriShell } from "./main.test-util";
import { PARAMS } from "./core/control/params";
import { t } from "./i18n";
import {
  SLOW,
  bootDevice,
  invoked,
  live,
  captureWarnings,
  confirms,
  chooseRate,
  errors,
  byMessage,
} from "./main.device.test-util";

describe("the desktop-only surfaces", () => {
  it("opens the device setup modal", SLOW, async () => {
    const shell = await bootDevice({ vd_get: 0, vd_get_str: "" });
    $("btn-device-setup").click();
    await vi.waitFor(() => expect($("device-setup-modal").hidden).toBe(false), { timeout: 20_000 });
    expect(shell.count("vd_connect")).toBeGreaterThan(0);
  });

  // While a session is up the screen reads and writes over the session's connection: no second
  // connection, the session stays up, and a change applied there goes to the unit behind the
  // session's own writes.
  it("opens the device setup modal during Live sync and applies a change over the session", SLOW, async () => {
    const shell = await bootDevice({}, true, { [`${PARAMS.DEVICE_LANGUAGE.id}/0/0`]: 0 });
    live().click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    const connects = shell.count("vd_connect");
    expect($<HTMLButtonElement>("btn-device-setup").disabled, "the entry stays open").toBe(false);
    $("btn-device-setup").click();
    await vi.waitFor(() => expect($("device-setup-modal").hidden).toBe(false), { timeout: 20_000 });
    const lang = document.querySelector<HTMLSelectElement>("#device-setup-language")!;
    expect(lang.value, "the session read the unit's settings").toBe("0");
    lang.value = "1";
    lang.dispatchEvent(new Event("change", { bubbles: true }));
    $<HTMLButtonElement>("device-setup-apply").click();
    await vi.waitFor(
      () =>
        expect(
          shell.invokes.some(
            (cmd, i) =>
              cmd === "vd_set" && shell.args[i]?.paramId === PARAMS.DEVICE_LANGUAGE.id && shell.args[i]?.value === 1,
          ),
        ).toBe(true),
      { timeout: 10_000 },
    );
    expect(shell.count("vd_connect"), "over the session's own connection").toBe(connects);
    expect(live().getAttribute("aria-checked"), "and the session is still up").toBe("true");
  });

  it("ends the session when a device setup change applied during Live sync is refused", SLOW, async () => {
    const shell = await bootDevice({}, true, { [`${PARAMS.DEVICE_LANGUAGE.id}/0/0`]: 0 });
    live().click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    $("btn-device-setup").click();
    await vi.waitFor(() => expect($("device-setup-modal").hidden).toBe(false), { timeout: 20_000 });
    const lang = document.querySelector<HTMLSelectElement>("#device-setup-language")!;
    lang.value = "1";
    lang.dispatchEvent(new Event("change", { bubbles: true }));
    shell.failOnce("vd_set", new Error("setup write refused"));
    $<HTMLButtonElement>("device-setup-apply").click();
    await invoked(shell, "vd_disconnect");
    expect(errors(shell).join(" "), "the refused write is what ended it").toContain("setup write refused");
  });

  // A second pick of the entry while the session's read is outstanding starts no second read, so
  // no later open replaces what was edited on the screen the first one opened. Once that screen
  // is closed, the entry reads again.
  it("starts one read for two picks during Live sync, and keeps the first screen's edits", SLOW, async () => {
    const shell = await bootDevice({}, true, { [`${PARAMS.DEVICE_LANGUAGE.id}/0/0`]: 0 });
    live().click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    const releases: ((v: number) => void)[] = [];
    shell.answer("vd_get", (a: Record<string, unknown>) => {
      if (a.paramId === PARAMS.BRIGHTNESS.id) return new Promise<number>((resolve) => releases.push(resolve));
      return unwrittenRead(a);
    });
    $("btn-device-setup").click();
    $("btn-device-setup").click();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases[0](4);
    await vi.waitFor(() => expect($("device-setup-modal").hidden).toBe(false), { timeout: 20_000 });
    const language = document.querySelector<HTMLSelectElement>("#device-setup-language")!;
    language.value = "1";
    language.dispatchEvent(new Event("change", { bubbles: true }));
    // The first open's read has run to its end, so a second read, had one been queued behind it,
    // would have begun by now.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(releases, "one read for the two picks").toHaveLength(1);
    expect(document.querySelector<HTMLSelectElement>("#device-setup-language")!.value).toBe("1");
    expect($("device-setup-pending").textContent).not.toBe("");

    // The control: with the screen closed the entry reads again.
    language.value = "0";
    language.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector<HTMLButtonElement>("#device-setup-modal .consent-btn-secondary")!.click();
    await vi.waitFor(() => expect($("device-setup-modal").hidden).toBe(true));
    $("btn-device-setup").click();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1](4);
    await vi.waitFor(() => expect($("device-setup-modal").hidden).toBe(false), { timeout: 20_000 });
  });

  it("opens the MIDI control window through the shell", SLOW, async () => {
    const shell = await bootDevice({ open_midi_window: null });
    $("btn-midi").click();
    await vi.waitFor(() => expect(shell.count("open_midi_window")).toBe(1), { timeout: 10_000 });
  });

  // The experimental actions are in the DOM but hidden until the launch flag says so
  // — they drive destructive round trips against a real unit.
  it("keeps the experimental actions hidden on an ordinary launch", SLOW, async () => {
    await bootDevice();
    expect($("btn-selftest").hidden).toBe(true);
    expect($("btn-compare").hidden).toBe(true);
  });

  it("reveals them when the launch flag is set", SLOW, async () => {
    await bootDevice({ experimental_enabled: true });
    await vi.waitFor(() => expect($("btn-selftest").hidden).toBe(false), { timeout: 10_000 });
    expect($("btn-compare").hidden).toBe(false);
  });

  // The settings-file import is one of them, and `e2e/race/t3b-undo.spec.ts` skips a
  // case on it being unreachable from that harness — which rests on two facts with
  // nothing between them: the app hides the entry without the flag, and the race fake
  // never answers the flag true.
  //
  // The second half is two statements, and BOTH are needed. The list the fake answers
  // from is imported (`fake-flags.ts` has no imports of its own, so this side can take it
  // without pulling Playwright's types into the src build) — but importing a list only
  // says what the list holds. That the FAKE reads it is the other half, and nothing in
  // the type system carries it: deleting the fake's `includes` block and its import
  // compiles silently, and a guard that only checked the constant would stay green while
  // the reason it exists for became false.
  //
  // So the fake's source is read for the usage. Two earlier versions read it by PROXIMITY
  // and both broke on a correct edit rather than on a wrong one: the first cut the switch
  // arm out by index (a comment containing "return" failed it on a docs edit; the group
  // becoming the last arm widened the cut past the end of the block), and the second asked
  // that `FAKE_LAUNCH_FLAGS_OFF` and a `return false;` sit within 200 characters of each
  // other — which the fix for the defect below necessarily broke, because that fix is
  // precisely to move the name away from the answer.
  //
  // The pin is therefore on the PROPERTY and not on a layout. The name must be absent from
  // the serialised callback and present in the tuple handed to it; the answer is looked up
  // through whatever that callback calls its LAST parameter, read out of the source rather
  // than hard-coded, so a rename is not a failure. What no text scan can see is whether the
  // list that arrives holds the right strings — the race tier is what answers that, and it
  // runs on the version-bump PR alone, which is how the defect below entered `main` and
  // survived three further merges.
  //
  // One family of the old fragility survives by design: the absence check reads code, so
  // comments are stripped before it — writing the identifier in a comment inside the
  // callback is not closing over it, and failing on that would be the third repeat of
  // "a docs edit broke the pin", with a message that is false besides.
  it("keeps the settings import behind the flag, and the race fake never sets it", SLOW, async () => {
    await bootDevice();
    expect($("btn-open-settings").hidden).toBe(true);
    expect(FAKE_LAUNCH_FLAGS_OFF).toContain("experimental_enabled");

    const fake = readFileSync(resolve(process.cwd(), "e2e/race/fake-device.ts"), "utf8");
    // Stripped ONCE, before any index is taken, so every read below is of code. Doing it
    // per-assertion is how the two halves came apart: the absence half read stripped text
    // while the presence half read the raw file, and a literal list with `// from
    // FAKE_LAUNCH_FLAGS_OFF` beside it satisfied the pin while the list stopped crossing.
    const code = fake.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code, "the race fake no longer answers from FAKE_LAUNCH_FLAGS_OFF").toContain("FAKE_LAUNCH_FLAGS_OFF");

    // The callback handed to addInitScript is serialised and evaluated in the PAGE, where
    // this module's bindings do not exist. Naming the import inside it compiles, type-checks
    // and collects, then throws on the fake's first command — "Can't find variable: X" in
    // JavaScriptCore, "X is not defined" in V8 — which presents as a live session that never
    // comes up rather than as an error. The argument tuple is the only channel that crosses,
    // and the only one the type checker covers: the callback's annotation and the `as` cast
    // are the same tuple type, so an arity mismatch is a compile error.
    const open = code.indexOf("addInitScript(");
    const args = code.indexOf("[cfg, opts.storage", open);
    expect(open, "installFake no longer installs through addInitScript").toBeGreaterThan(-1);
    expect(args, "the init script's argument tuple moved").toBeGreaterThan(open);
    const body = code.slice(open, args);
    expect(body, "the init script closes over FAKE_LAUNCH_FLAGS_OFF instead of being handed it").not.toContain(
      "FAKE_LAUNCH_FLAGS_OFF",
    );
    expect(code.slice(args, args + 200), "the init script is not handed the flag list").toContain(
      "FAKE_LAUNCH_FLAGS_OFF",
    );

    // …and it still answers those commands false, through the parameter it arrived on. The
    // name is escaped before it becomes a pattern: `$` is legal in an identifier and is an
    // anchor in a regular expression, so `$flags` would otherwise match nothing and report
    // the answer as missing.
    const param = /addInitScript\(\s*\(\[[^\]]*,\s*([A-Za-z_$][\w$]*)\s*\]/.exec(body)?.[1];
    expect(param, "the init script's last parameter is not a plain binding").toBeTruthy();
    const name = String(param).replace(/[$]/g, "\\$&");
    expect(body).toMatch(new RegExp(`(?<![\\w$])${name}\\.includes\\(cmd\\)[\\s\\S]{0,80}?return false;`));
  });
});

describe("the first-run consent gate", () => {
  // Desktop only, and it stands between the launch and the device layer: the Windows
  // installer shows the same notice, but a macOS drag-install and every auto-update
  // bypass it.
  //
  // `consent: false` is the whole premise. A first version of this cleared the key
  // between two boots — and the second boot's own pre-accept simply wrote it back, so
  // the closing assertion was reading the fixture rather than the gate.
  const bootUngated = (over: Record<string, unknown> = {}): Promise<TauriShell> =>
    bootApp({
      tauri: deviceCommands({ "plugin:dialog|message": "Ok", ...over }),
      consent: false,
    }) as Promise<TauriShell>;

  // The headless launch actions reach the device layer with nothing on screen to press, so
  // the gate's inert app does not hold them: they wait on the consent itself, and say so.
  for (const [flag, tag] of [
    ["self_test_requested", "self-test"],
    ["prepare_modified_requested", "prepare-modified"],
  ] as const) {
    it(`holds the --${tag} launch until the gate is accepted`, SLOW, async () => {
      const log = captureWarnings();
      try {
        const shell = await bootUngated({ experimental_enabled: true, [flag]: true });
        await vi.waitFor(() => expect(log.lines).toContain(`[${tag}] waiting for first-run consent`), {
          timeout: 10_000,
        });
        expect($("consent").hidden).toBe(false);
        expect(shell.count("vd_connect")).toBe(0);

        $("consent-agree").click();
        await invoked(shell, "vd_connect");
        await vi.waitFor(
          () => expect(log.lines.some((l) => /^\[(self-test|prepare-modified)\] [A-Z]/.test(l))).toBe(true),
          {
            timeout: 25_000,
          },
        );
      } finally {
        log.restore();
      }
    });
  }

  it("blocks the launch until it is accepted, then remembers", SLOW, async () => {
    const shell = await bootUngated();
    await vi.waitFor(() => expect($("consent").hidden).toBe(false), { timeout: 10_000 });
    expect($("app").inert).toBe(true); // the app behind the scrim is off the tab order
    expect(localStorage.getItem("urx-disclaimer-accepted")).toBeNull();
    expect(shell.count("plugin:updater|check")).toBe(0); // boot() is held at the gate

    $("consent-agree").click();
    await vi.waitFor(() => expect($("consent").hidden).toBe(true), { timeout: 10_000 });
    expect($("app").inert).toBe(false);
    expect(localStorage.getItem("urx-disclaimer-accepted")).toBe("1");
    await invoked(shell, "plugin:updater|check"); // and the rest of boot() ran
  });

  // Declining quits: `exitApp` resolves never in the real shell (the process is gone),
  // so the stub holds too — answering it would let boot() run on past a gate that was
  // refused, which is the opposite of what the case is about.
  it("quits without storing anything when it is declined", SLOW, async () => {
    const shell = await bootUngated({ "plugin:process|exit": () => new Promise(() => {}) });
    await vi.waitFor(() => expect($("consent").hidden).toBe(false), { timeout: 10_000 });

    $("consent-quit").click();
    await invoked(shell, "plugin:process|exit");
    expect(localStorage.getItem("urx-disclaimer-accepted")).toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(shell.count("plugin:updater|check")).toBe(0);
  });
});

describe("the update check", () => {
  it("asks the updater on a desktop launch", SLOW, async () => {
    const shell = await bootDevice();
    await vi.waitFor(() => expect(shell.count("plugin:updater|check")).toBe(1), { timeout: 10_000 });
  });

  // An updater that cannot reach its endpoint is not worth a dialog on every launch —
  // it says nothing about the plan on screen. The failure goes into the boot the case
  // measures: handed to a shell that is then replaced by another `bootDevice()`, it
  // would apply to nothing and the case would pass with the updater never failing.
  //
  // Nothing in the DOM separates a swallowed failure from a successful check, so the
  // rejection ledger is what carries the case: `boot()` is launched with `void`, so a
  // throw that escaped `checkForUpdates` would land nowhere at all. Measured with the
  // catch removed — the rejection arrives, and without this listener the case still
  // reports green (vitest attributes it to the FILE, as one "error" beside a passing
  // test).
  it("survives an updater that cannot reach its endpoint", SLOW, async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => void rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const shell = await bootDevice({
        "plugin:updater|check": () => {
          throw new Error("offline");
        },
      });
      await invoked(shell, "plugin:updater|check");
      expect(shell.count("plugin:dialog|message")).toBe(0); // silent at the launch check
      expect(statusText()).toContain("URX44V");
      await new Promise((r) => setTimeout(r, 100)); // a rejection lands a macrotask later
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  // An update on offer is a confirm, and declining it must download nothing. The updater's
  // own commands are the observable for the decline — a declined check leaves no trace on
  // screen, so asserting the status would be asserting on the boot line.
  //
  // But everything after the wait is a zero, and a case whose whole verdict is absences
  // passes on any flow that never got as far as asking: an offer that regressed into an
  // error report, a version the frame failed to name, `checkUpdate` throwing after its
  // dialog. So the ASKING is pinned first, by message and by version.
  it("downloads nothing when the offered update is declined", SLOW, async () => {
    const shell = await bootDevice({ "plugin:updater|check": { rid: 7, version: "9.9.9" } }, false);
    await vi.waitFor(() => expect(confirms(shell).length).toBeGreaterThan(0), { timeout: 25_000 });
    await new Promise((r) => setTimeout(r, 100));
    expect(confirms(shell)).toEqual([t().confirm.update("9.9.9")]);
    expect(errors(shell)).toEqual([]);
    expect(shell.count("plugin:updater|download_and_install")).toBe(0);
    expect(shell.count("plugin:process|restart")).toBe(0);
  });

  // Accepted: the status says what is happening and the app restarts into the new bundle.
  // The restart never resolves in the real shell — the process is gone — so the stub holds
  // too, which is also what keeps the status line readable at the end.
  //
  // The accept arm also closes the Preferences modal, and this case does NOT cover that:
  // it drives the LAUNCH check, where `prefs.close()` is a documented no-op because the
  // modal was never open. Closing it matters only for a check started from inside
  // Preferences, which nothing here reaches — so the title claims the two halves that are
  // asserted below and not the third.
  it("downloads and restarts when the update is accepted", SLOW, async () => {
    let refuse!: (e: Error) => void;
    const shell = await bootDevice({
      "plugin:updater|check": { rid: 7, version: "9.9.9" },
      prepare_for_exit: null,
      "plugin:updater|download_and_install": null,
      "plugin:process|restart": () => new Promise((_, r) => (refuse = r)),
    });
    await invoked(shell, "plugin:process|restart");
    expect(shell.count("plugin:updater|download_and_install")).toBe(1);
    expect(statusText()).toBe(t().status.updateDownloading);
    // The real relaunch never answers; this one is refused so the link the install took is
    // given back before the next case.
    refuse(new Error("teardown"));
    await vi.waitFor(() => expect($<HTMLSelectElement>("rate-picker").disabled).toBe(false), { timeout: 10_000 });
  });

  // Once accepted, "Downloading update…" is on screen with the modal closed, so a
  // failure has to clear that and surface — otherwise it reads as a download that never
  // ends. This is the one updater failure that is NOT silent, which is why it is a case
  // of its own beside the silent launch check above.
  it("surfaces a download that failed after the update was accepted", SLOW, async () => {
    const shell = await bootDevice({
      "plugin:updater|check": { rid: 7, version: "9.9.9" },
      prepare_for_exit: null,
      "plugin:updater|download_and_install": () => {
        throw new Error("half-written");
      },
    });
    await invoked(shell, "plugin:updater|download_and_install");
    // showError clears the status line before raising the dialog, so the stuck
    // "Downloading…" is gone rather than merely covered.
    await vi.waitFor(() => expect(statusText()).toBe(""), { timeout: 10_000 });
    expect(shell.count("plugin:process|restart")).toBe(0);
    // An error dialog, and the one that names this failure — the install, not the check that
    // found the update — with its cause. A cleared status line on its own is also what a
    // silent swallow leaves behind.
    await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 10_000 });
    expect(errors(shell).at(-1)).toBe(t().status.updateInstallFailed("half-written"));
    expect(errors(shell).at(-1)).toContain("half-written");
  });

  // An install that succeeded and a relaunch that did not: the new bundle is on disk, so the
  // line says to reopen the app rather than that the update failed.
  it("says the update is installed when only the relaunch failed", SLOW, async () => {
    const shell = await bootDevice({
      "plugin:updater|check": { rid: 7, version: "9.9.9" },
      prepare_for_exit: null,
      "plugin:updater|download_and_install": null,
      "plugin:process|restart": () => {
        throw new Error("relaunch refused");
      },
    });
    await invoked(shell, "plugin:process|restart");
    await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 10_000 });
    expect(errors(shell).at(-1)).toBe(t().status.updateRestartFailed("relaunch refused"));
  });

  // The install ends the app, so it asks about unsaved edits first — before anything is
  // downloaded — and declining keeps them and installs nothing.
  it("asks the discard confirm before installing over unsaved edits", SLOW, async () => {
    const shell = await bootDevice({
      "plugin:updater|check": null,
      prepare_for_exit: null,
      "plugin:updater|download_and_install": null,
      "plugin:dialog|message": byMessage((m) => m !== t().confirm.discard),
    });
    await invoked(shell, "plugin:updater|check");
    shell.answer("plugin:updater|check", { rid: 7, version: "9.9.9" });
    chooseRate(96_000); // unsaved
    $("btn-prefs").click();
    $<HTMLButtonElement>("prefs-update-now").click();
    await vi.waitFor(() => expect(confirms(shell)).toEqual([t().confirm.update("9.9.9"), t().confirm.discard]), {
      timeout: 10_000,
    });
    await vi.waitFor(() => expect($("prefs-update-note").textContent).toBe(t().prefs.updateAvailable("9.9.9")), {
      timeout: 10_000,
    });
    expect(shell.count("prepare_for_exit")).toBe(0);
    expect(shell.count("plugin:updater|download_and_install")).toBe(0);
  });

  // The install also ends a device action, so it takes the link: refused while one holds it,
  // and nothing can start one while the bundle downloads.
  it("refuses to install while Live sync holds the link", SLOW, async () => {
    const shell = await bootDevice({
      "plugin:updater|check": null,
      prepare_for_exit: null,
      "plugin:updater|download_and_install": null,
    });
    await invoked(shell, "plugin:updater|check");
    shell.answer("plugin:updater|check", { rid: 7, version: "9.9.9" });
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    $("btn-prefs").click();
    $<HTMLButtonElement>("prefs-update-now").click();
    await vi.waitFor(() => expect($("prefs-update-note").textContent).toBe(t().status.deviceLinkBusy), {
      timeout: 10_000,
    });
    expect(shell.count("plugin:updater|download_and_install")).toBe(0);
    $("prefs-modal").querySelector<HTMLButtonElement>(".consent-btn-secondary")!.click();
  });

  it("saves and closes what the exit would, then holds the link through the download", SLOW, async () => {
    let fail!: (e: Error) => void;
    const shell = await bootDevice({
      "plugin:updater|check": { rid: 7, version: "9.9.9" },
      prepare_for_exit: null,
      "plugin:updater|download_and_install": () => new Promise((_, r) => (fail = r)),
    });
    await invoked(shell, "plugin:updater|download_and_install");
    expect(shell.invokes.indexOf("prepare_for_exit")).toBeGreaterThan(-1);
    expect(shell.invokes.indexOf("prepare_for_exit")).toBeLessThan(
      shell.invokes.indexOf("plugin:updater|download_and_install"),
    );
    expect($<HTMLButtonElement>("btn-fetch").disabled).toBe(true);
    expect($<HTMLButtonElement>("btn-live").disabled).toBe(true);
    // …and a download that fails gives the link back.
    fail(new Error("half-written"));
    await vi.waitFor(() => expect($<HTMLButtonElement>("btn-fetch").disabled).toBe(false), { timeout: 10_000 });
  });

  // The Preferences lock covers the check and its confirm, not the download an accepted update
  // runs after it: a modal reopened while the bundle is still downloading closes as any other.
  it("leaves a Preferences reopened during an accepted download closable", SLOW, async () => {
    let fail!: (e: Error) => void;
    const shell = await bootDevice({
      "plugin:updater|check": null,
      prepare_for_exit: null,
      "plugin:updater|download_and_install": () => new Promise((_, r) => (fail = r)),
    });
    // The launch check finds nothing; the one from Preferences finds the update.
    await invoked(shell, "plugin:updater|check");
    shell.answer("plugin:updater|check", { rid: 7, version: "9.9.9" });
    $("btn-prefs").click();
    $<HTMLButtonElement>("prefs-update-now").click();
    await invoked(shell, "plugin:updater|download_and_install");
    expect($("prefs-modal").hidden).toBe(true);
    $("btn-prefs").click();
    expect($("prefs-modal").hidden).toBe(false);
    $("prefs-modal").querySelector<HTMLButtonElement>(".consent-btn-secondary")!.click();
    expect($("prefs-modal").hidden).toBe(true);
    fail(new Error("teardown"));
    await vi.waitFor(() => expect($<HTMLSelectElement>("rate-picker").disabled).toBe(false), { timeout: 10_000 });
  });
});

describe("the --reset-storage launch", () => {
  // The flag arrives async — after the synchronous init has already read localStorage —
  // so the only way to re-init clean is to clear and reload once. jsdom cannot navigate
  // and its `reload` is non-configurable (so it cannot be stubbed either): the call
  // prints "Not implemented: navigation to another Document" and returns. That line in
  // the output is this case working, not failing.
  //
  // sessionStorage is cleared by hand here. `restoreAppGlobals` does not touch it — only
  // this flow reads it — so without the clear the second case's state would leak into
  // whichever of the two ran later.
  it("clears storage and holds the rest of boot for the reload", SLOW, async () => {
    sessionStorage.clear();
    const shell = await bootDevice({ reset_storage_requested: true });
    await vi.waitFor(() => expect(sessionStorage.getItem("urx-reset-done")).toBe("1"), { timeout: 10_000 });

    // The seeds the fixture wrote are gone, which is the whole point: the model, the
    // language and the accepted consent all live in localStorage.
    expect(localStorage.getItem("urx-model")).toBeNull();
    expect(localStorage.getItem("urx-disclaimer-accepted")).toBeNull();
    // …and boot() never ran past the reset, so nothing downstream of it happened.
    await new Promise((r) => setTimeout(r, 100));
    expect(shell.count("plugin:updater|check")).toBe(0);
  });

  // A startup that throws before it reaches boot(). The markup is the one the app cannot
  // start on (no rate picker, which its init fills unguarded), standing in for any store
  // value that breaks the synchronous init: the reset is what recovers from those, so it
  // cannot wait for the init to finish.
  it("clears storage when the app's own startup throws", SLOW, async () => {
    sessionStorage.clear();
    const shell = (await bootApp({
      tauri: deviceCommands({ reset_storage_requested: true }),
      body: APP_BODY.replace('<select id="rate-picker"></select>', ""),
      initThrows: true,
    }))!;
    await vi.waitFor(() => expect(sessionStorage.getItem("urx-reset-done")).toBe("1"), { timeout: 10_000 });
    expect(shell.count("reset_storage_requested")).toBe(1);
    expect(localStorage.getItem("urx-model")).toBeNull();
    sessionStorage.clear();
  });

  // The flag is still set on the launch that follows the reload, so without the guard the
  // app would clear and reload forever. Set BEFORE the boot, since the module reads it
  // during its own startup.
  it("clears once per launch rather than looping the reload", SLOW, async () => {
    sessionStorage.clear();
    sessionStorage.setItem("urx-reset-done", "1");
    const shell = await bootDevice({ reset_storage_requested: true });
    await invoked(shell, "plugin:updater|check"); // boot() ran on through

    expect(localStorage.getItem("urx-model")).toBe("URX44V"); // the second clear did not happen
    sessionStorage.clear();
  });
});
