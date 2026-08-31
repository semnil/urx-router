// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  desktop: true,
  resetFine: vi.fn(),
}));

vi.mock("../core/platform", () => ({ isTauri: () => mocks.desktop }));
vi.mock("../core/env", () => ({ DEMO: false }));
vi.mock("./fine", () => ({ resetFine: mocks.resetFine }));

import { getSettings, resetSettingsCache } from "../core/settings";
import { setLang, t } from "../i18n";
import { PrefsPanel, type PrefsHooks, type UpdateCheckOutcome } from "./prefs";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function change(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function row(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>(".prefs-row")].find(
    (candidate) => candidate.querySelector(".lbl")?.textContent === label,
  );
  if (!found) throw new Error(`missing preference row: ${label}`);
  return found;
}

function install() {
  let live = false;
  const hooks: PrefsHooks = {
    isLive: () => live,
    onRecentChanged: vi.fn(),
    onWarningsChanged: vi.fn(),
    onFineChanged: vi.fn(),
    checkUpdates: vi.fn(async (): Promise<UpdateCheckOutcome> => ({ kind: "upToDate" })),
    setPreventSleep: vi.fn(async () => null),
    isExperimental: () => false,
    themeMode: () => "auto",
    onThemeMode: vi.fn(),
  };
  const panel = new PrefsPanel(hooks);
  return { panel, hooks, setLive: (next: boolean) => void (live = next) };
}

beforeEach(() => {
  mocks.desktop = true;
  mocks.resetFine.mockReset();
  localStorage.clear();
  resetSettingsCache();
  setLang("en");
  document.body.innerHTML = `
    <div id="prefs-modal" hidden>
      <div id="prefs-box"></div>
    </div>
  `;
});

describe("PrefsPanel", () => {
  it("renders browser-only locks and dismisses only from outside or Escape", () => {
    mocks.desktop = false;
    const { panel } = install();
    panel.open();

    expect(panel.isOpen()).toBe(true);
    expect(document.querySelector("#prefs-title")).not.toBeNull();
    expect(document.querySelector("#prefs-update-now")).toBeNull();
    expect(
      [...document.querySelectorAll<HTMLButtonElement>("#prefs-device-scope button")].every((b) => b.disabled),
    ).toBe(true);
    expect(row(t().prefs.preventSleep).classList.contains("locked")).toBe(true);
    expect(document.activeElement).toBe(document.querySelector(".consent-btn-secondary"));

    document.querySelector("#prefs-box")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(panel.isOpen()).toBe(true);
    document.querySelector("#prefs-modal")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(panel.isOpen()).toBe(false);

    panel.open();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.isOpen()).toBe(false);
  });

  it("applies immediate settings and notifies each owning surface", () => {
    const { panel, hooks, setLive } = install();
    panel.open();

    change(document.querySelector("#prefs-theme") as HTMLSelectElement, "dark");
    expect(hooks.onThemeMode).toHaveBeenCalledWith("dark");

    document.querySelectorAll<HTMLButtonElement>("#prefs-device-scope button")[1].click();
    expect(getSettings().deviceScope).toBe("scene");

    row(t().prefs.warnRate).querySelectorAll<HTMLButtonElement>("button")[1].click();
    expect(getSettings().warnRate).toBe(false);
    expect(hooks.onWarningsChanged).toHaveBeenCalledOnce();

    // Its own row and its own key. The panel is the only writer of any settings key, and
    // the rows are built from two helpers, so one wired to another's key silences the
    // wrong card — or moves a setting the operator was not touching — with nothing to see
    // it. Every key the panel writes is pressed somewhere in this case for that reason.
    //
    // Pressed back ON as well, which takes two more readings the OFF press cannot. A row
    // whose buttons both wrote its OFF value reads the same from one press; and the panel
    // re-renders on apply, so the ON button is live here only if the rebuilt row read the
    // stored value back — a row built from a constant leaves ON already selected, where a
    // press is a no-op the widget swallows.
    const ducker = (i: number): void =>
      row(t().prefs.warnDucker).querySelectorAll<HTMLButtonElement>("button")[i].click();
    ducker(1);
    expect(getSettings().warnDucker).toBe(false);
    expect(hooks.onWarningsChanged).toHaveBeenCalledTimes(2);
    ducker(0);
    expect(getSettings().warnDucker).toBe(true);
    expect(hooks.onWarningsChanged).toHaveBeenCalledTimes(3);

    // The third row of the same section, and the one that must NOT notify: it gates a
    // device-write confirmation rather than a card, so there is nothing on screen to
    // repaint. Its key is the reading that separates it from the two above.
    row(t().prefs.warnFirmware).querySelectorAll<HTMLButtonElement>("button")[1].click();
    expect(getSettings().warnFirmware).toBe(false);
    expect(getSettings().warnRate).toBe(false);
    expect(getSettings().warnDucker).toBe(true);
    expect(hooks.onWarningsChanged).toHaveBeenCalledTimes(3);

    row(t().prefs.fine).querySelectorAll<HTMLButtonElement>("button")[1].click();
    expect(getSettings().fineLatch).toBe(true);
    expect(mocks.resetFine).toHaveBeenCalledOnce();
    expect(hooks.onFineChanged).toHaveBeenCalledOnce();

    change(document.querySelector("#prefs-wheel") as HTMLSelectElement, "4");
    expect(getSettings().wheelSteps).toBe(4);

    row(t().prefs.saveScope).querySelectorAll<HTMLButtonElement>("button")[1].click();
    expect(getSettings().saveScope).toBe("scene");

    change(row(t().prefs.exportScale).querySelector("select")!, "3");
    expect(getSettings().exportScale).toBe(3);

    change(row(t().prefs.exportBg).querySelector("select")!, "dark");
    expect(getSettings().exportTheme).toBe("dark");

    change(row(t().prefs.recent).querySelector("select")!, "12");
    expect(getSettings().recentMax).toBe(12);
    expect(hooks.onRecentChanged).toHaveBeenLastCalledWith([]);
    row(t().prefs.recent).querySelector<HTMLButtonElement>(".prefs-btn")!.click();
    expect(hooks.onRecentChanged).toHaveBeenLastCalledWith([]);

    row(t().prefs.updateLaunch).querySelectorAll<HTMLButtonElement>("button")[1].click();
    expect(getSettings().updateCheck).toBe(false);

    change(document.querySelector("#prefs-lang") as HTMLSelectElement, "ja");
    expect(document.documentElement.lang).toBe("ja");

    setLang("en");
    setLive(true);
    panel.refresh();
    const scope = row(t().prefs.scope);
    expect(scope.classList.contains("locked")).toBe(true);
    expect(scope.querySelector(".prefs-lock")).toBeNull();
  });

  it("stores the sleep preference only when the OS hold succeeds", async () => {
    const { panel, hooks } = install();
    vi.mocked(hooks.setPreventSleep).mockResolvedValueOnce("permission denied").mockResolvedValueOnce(null);
    panel.open();

    row(t().prefs.preventSleep).querySelectorAll<HTMLButtonElement>("button")[0].click();
    await vi.waitFor(() => expect(document.querySelector("#prefs-sleep-error")?.textContent).toBe("permission denied"));
    expect(getSettings().preventSleep).toBe(false);

    row(t().prefs.preventSleep).querySelectorAll<HTMLButtonElement>("button")[0].click();
    await vi.waitFor(() => expect(getSettings().preventSleep).toBe(true));
    expect(document.querySelector("#prefs-sleep-error")?.textContent).toBe("");
    expect(hooks.setPreventSleep).toHaveBeenNthCalledWith(1, true);
    expect(hooks.setPreventSleep).toHaveBeenNthCalledWith(2, true);
  });

  it("locks dismissal during an update check and reports every terminal outcome", async () => {
    const flight = deferred<UpdateCheckOutcome>();
    const { panel, hooks } = install();
    vi.mocked(hooks.checkUpdates).mockReturnValueOnce(flight.promise);
    panel.open();

    const title = document.querySelector("#prefs-title");
    (document.querySelector("#prefs-update-now") as HTMLButtonElement).click();
    expect(document.querySelector("#prefs-update-note")?.textContent).toBe(t().prefs.checking);
    expect((document.querySelector(".consent-btn-secondary") as HTMLButtonElement).disabled).toBe(true);
    panel.requestClose();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    panel.refresh();
    expect(panel.isOpen()).toBe(true);
    expect(document.querySelector("#prefs-title")).toBe(title);

    flight.resolve({ kind: "upToDate" });
    await vi.waitFor(() => expect(document.querySelector("#prefs-update-note")?.textContent).toBe(t().prefs.upToDate));

    vi.mocked(hooks.checkUpdates).mockResolvedValueOnce({ kind: "declined", version: "9.9.9" });
    (document.querySelector("#prefs-update-now") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(document.querySelector("#prefs-update-note")?.textContent).toBe(t().prefs.updateAvailable("9.9.9")),
    );

    vi.mocked(hooks.checkUpdates).mockRejectedValueOnce(new Error("network"));
    (document.querySelector("#prefs-update-now") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(document.querySelector("#prefs-update-note")?.textContent).toBe(t().prefs.updateCheckFailed),
    );
    expect(document.querySelector("#prefs-update-note")?.classList.contains("warn")).toBe(true);

    vi.mocked(hooks.checkUpdates).mockResolvedValueOnce({ kind: "installing" });
    (document.querySelector("#prefs-update-now") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector("#prefs-update-note")?.textContent).toBe(""));

    panel.requestClose();
    expect(panel.isOpen()).toBe(false);
  });
});
