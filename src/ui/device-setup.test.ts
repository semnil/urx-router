// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { BRIGHTNESS_MAX, defaultDeviceSetup, type DeviceSetup } from "../core/control/device-setup";
import { getModel } from "../models";
import { DeviceSetupPanel, type DeviceSetupHooks } from "./device-setup";
import { resetSettingsCache } from "../core/settings";
import { t } from "../i18n";

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

function install(model: "URX22" | "URX44" | "URX44V" = "URX44V") {
  let modelId = model;
  const hooks: DeviceSetupHooks = {
    model: () => getModel(modelId),
    apply: vi.fn(async () => true),
    confirmDiscard: vi.fn(async () => true),
  };
  const panel = new DeviceSetupPanel(hooks);
  return { panel, hooks, setModel: (next: typeof modelId) => void (modelId = next) };
}

beforeEach(() => {
  document.body.innerHTML = `
    <div id="device-setup-modal" hidden>
      <div id="device-setup-box"></div>
    </div>
  `;
});

describe("DeviceSetupPanel", () => {
  it("opens from a coerced snapshot and locks settings absent from the model", () => {
    const { panel } = install("URX22");
    const setup: DeviceSetup = { ...defaultDeviceSetup(), brightness: 999, timeZone: 999 };

    panel.open(setup);

    expect(panel.isOpen()).toBe(true);
    expect(document.querySelector("#device-setup-title")).not.toBeNull();
    expect((document.querySelector("#device-setup-brightness") as HTMLInputElement).value).toBe(String(BRIGHTNESS_MAX));
    expect((document.querySelector("#device-setup-timezone") as HTMLSelectElement).disabled).toBe(true);
    expect(document.querySelectorAll(".prefs-row.locked").length).toBeGreaterThanOrEqual(5);
    expect(document.querySelector("#device-setup-pending")?.textContent).toBe("");
    expect((document.querySelector("#device-setup-apply") as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(document.querySelector(".consent-btn-secondary"));

    panel.close();
    expect(panel.isOpen()).toBe(false);
    expect(document.querySelector("#device-setup-box")?.childElementCount).toBe(0);
    panel.refresh();
    expect(document.querySelector("#device-setup-box")?.childElementCount).toBe(0);
  });

  // `onWheelStep` calls back once per configured wheel step, and the first `edit()`
  // re-renders and REPLACES the slider — so calls 2..n used to read the detached old
  // element, whose value had not moved, and compute the same target. One notch moved
  // brightness by a single detent whatever the preference said, and re-rendered three
  // times doing it. Every other slider here honours it through the shared helper.
  // (WHEEL_STEP_CHOICES is 1 / 2 / 4, so 4 is the setting that separates the two.)
  it("steps brightness by the whole wheel-steps preference, not by one", () => {
    localStorage.setItem("urx-settings", JSON.stringify({ wheelSteps: 4 }));
    resetSettingsCache();
    const { panel } = install();
    panel.open({ ...defaultDeviceSetup(), brightness: 4 });

    const slider = document.querySelector("#device-setup-brightness") as HTMLInputElement;
    slider.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));

    // Read off the re-rendered element, since the one above is detached by now.
    const after = document.querySelector("#device-setup-brightness") as HTMLInputElement;
    expect(Number(after.value)).toBe(8);
  });

  // The row's own wheel wiring steps the DRAFT rather than the element, so it does not go
  // through the shared `wheelStep` and does not inherit its inert guard. `wheel` reaches a
  // disabled range in both engines, and macOS delivers scroll to an unfocused window — so
  // without a guard of its own a notch over the background app writes the value the app
  // just declared out of reach, and the re-render puts a live row back under the still-held
  // pointer.
  it("ignores a wheel notch while brightness is held inert", () => {
    localStorage.clear(); // the case above leaves a wheel-steps preference behind
    resetSettingsCache();
    const { panel } = install();
    panel.open({ ...defaultDeviceSetup(), brightness: 4 });

    const slider = document.querySelector("#device-setup-brightness") as HTMLInputElement;
    slider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
    window.dispatchEvent(new FocusEvent("blur"));
    const held = document.querySelector("#device-setup-brightness") as HTMLInputElement;
    expect(held.disabled).toBe(true);

    held.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    expect(Number((document.querySelector("#device-setup-brightness") as HTMLInputElement).value)).toBe(4);

    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    const freed = document.querySelector("#device-setup-brightness") as HTMLInputElement;
    expect(freed.disabled).toBe(false);
    freed.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    expect(Number((document.querySelector("#device-setup-brightness") as HTMLInputElement).value)).toBe(5);
  });

  it("marks a committed edit, sends its exact diff, and moves the baseline only after success", async () => {
    const flight = deferred<boolean>();
    const { panel, hooks } = install();
    vi.mocked(hooks.apply).mockReturnValueOnce(flight.promise);
    panel.open(defaultDeviceSetup());

    const slider = document.querySelector("#device-setup-brightness") as HTMLInputElement;
    slider.value = "4";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    expect(slider.parentElement?.querySelector(".param-val")?.textContent).toBe("4");
    expect(document.querySelector("#device-setup-pending")?.textContent).toBe("");

    slider.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.querySelector(".prefs-row.dirty #device-setup-brightness")).not.toBeNull();
    expect(document.querySelector("#device-setup-pending")?.textContent).not.toBe("");

    (document.querySelector("#device-setup-apply") as HTMLButtonElement).click();
    await Promise.resolve();
    expect(hooks.apply).toHaveBeenCalledWith([{ kind: "num", name: "BRIGHTNESS", y: 0, value: 4 }], 1);
    expect((document.querySelector("#device-setup-apply") as HTMLButtonElement).disabled).toBe(true);
    expect((document.querySelector(".consent-btn-secondary") as HTMLButtonElement).disabled).toBe(true);
    await panel.requestClose();
    expect(panel.isOpen()).toBe(true);
    expect(hooks.confirmDiscard).not.toHaveBeenCalled();

    flight.resolve(true);
    await vi.waitFor(() => expect(document.querySelector("#device-setup-pending")?.textContent).toBe(""));
    expect((document.querySelector("#device-setup-apply") as HTMLButtonElement).disabled).toBe(true);

    await panel.requestClose();
    expect(panel.isOpen()).toBe(false);
    expect(hooks.confirmDiscard).not.toHaveBeenCalled();
  });

  // The rows stay live while an apply is in flight, and what the apply sends is the diff
  // taken when it was pressed. An edit made during the flight is not in it, so it has to
  // stay pending: marked, counted, and asked about on Close — not adopted into the
  // baseline as though the unit had received it.
  it("keeps an edit made while the apply is in flight pending", async () => {
    const flight = deferred<boolean>();
    const { panel, hooks } = install();
    vi.mocked(hooks.apply).mockReturnValueOnce(flight.promise);
    panel.open(defaultDeviceSetup());

    change(document.querySelector("#device-setup-language") as HTMLSelectElement, "1");
    (document.querySelector("#device-setup-apply") as HTMLButtonElement).click();
    await Promise.resolve();
    expect(hooks.apply).toHaveBeenCalledWith([{ kind: "num", name: "DEVICE_LANGUAGE", y: 0, value: 1 }], 1);

    change(document.querySelector("#device-setup-apo-time") as HTMLSelectElement, "2");
    flight.resolve(true);
    await vi.waitFor(() =>
      expect((document.querySelector("#device-setup-apply") as HTMLButtonElement).disabled).toBe(false),
    );
    expect(document.querySelector("#device-setup-pending")?.textContent).toBe(t().deviceSetup.pending(1));
    expect(document.querySelectorAll(".prefs-row.dirty")).toHaveLength(1);
    expect(document.querySelector(".prefs-row.dirty #device-setup-apo-time")).not.toBeNull();

    await panel.requestClose();
    expect(hooks.confirmDiscard).toHaveBeenCalledOnce();
  });

  // The same window, edited back to where the baseline was: the unit received 1, so a
  // screen showing 0 owes it a write — the language row is pending, not settled.
  it("keeps a row edited back during the flight pending against what was sent", async () => {
    const flight = deferred<boolean>();
    const { panel, hooks } = install();
    vi.mocked(hooks.apply).mockReturnValueOnce(flight.promise);
    panel.open(defaultDeviceSetup());

    change(document.querySelector("#device-setup-language") as HTMLSelectElement, "1");
    (document.querySelector("#device-setup-apply") as HTMLButtonElement).click();
    await Promise.resolve();
    change(document.querySelector("#device-setup-language") as HTMLSelectElement, "0");
    flight.resolve(true);
    await vi.waitFor(() =>
      expect((document.querySelector("#device-setup-apply") as HTMLButtonElement).disabled).toBe(false),
    );
    expect(document.querySelector("#device-setup-pending")?.textContent).toBe(t().deviceSetup.pending(1));
    expect(document.querySelector(".prefs-row.dirty #device-setup-language")).not.toBeNull();

    (document.querySelector("#device-setup-apply") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(hooks.apply).toHaveBeenCalledTimes(2));
    expect(vi.mocked(hooks.apply).mock.calls[1]).toEqual([
      [{ kind: "num", name: "DEVICE_LANGUAGE", y: 0, value: 0 }],
      1,
    ]);
  });

  it("keeps a failed apply pending so the same writes can be retried", async () => {
    const { panel, hooks } = install();
    vi.mocked(hooks.apply).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    panel.open(defaultDeviceSetup());

    change(document.querySelector("#device-setup-language") as HTMLSelectElement, "1");
    (document.querySelector("#device-setup-apply") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(hooks.apply).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect((document.querySelector("#device-setup-apply") as HTMLButtonElement).disabled).toBe(false),
    );
    const first = vi.mocked(hooks.apply).mock.calls[0];
    expect(document.querySelector("#device-setup-pending")?.textContent).not.toBe("");

    (document.querySelector("#device-setup-apply") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(hooks.apply).toHaveBeenCalledTimes(2));
    expect(vi.mocked(hooks.apply).mock.calls[1]).toEqual(first);
    await vi.waitFor(() => expect(document.querySelector("#device-setup-pending")?.textContent).toBe(""));
  });

  it("waits for discard confirmation and ignores dismissal while it is in flight", async () => {
    const answer = deferred<boolean>();
    const { panel, hooks } = install();
    vi.mocked(hooks.confirmDiscard).mockReturnValueOnce(answer.promise).mockResolvedValueOnce(true);
    panel.open(defaultDeviceSetup());
    change(document.querySelector("#device-setup-language") as HTMLSelectElement, "1");

    const closing = panel.requestClose();
    await Promise.resolve();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(panel.isOpen()).toBe(true);
    expect(hooks.confirmDiscard).toHaveBeenCalledOnce();

    answer.resolve(false);
    await closing;
    expect(panel.isOpen()).toBe(true);

    await panel.requestClose();
    expect(panel.isOpen()).toBe(false);
    expect(hooks.confirmDiscard).toHaveBeenCalledTimes(2);
  });

  // Every edit and every bank tab rebuilds the box, including a brightness step taken from
  // the keyboard. The grid the rebuild replaces is the box's scrolling region, so neither
  // the control the operator used nor the offset they scrolled to may go with it.
  it("keeps the focused control and the grid's scroll offset across a rebuild", () => {
    const { panel } = install();
    panel.open(defaultDeviceSetup());
    const grid = (): HTMLElement => document.querySelector("#device-setup-box .prefs-grid") as HTMLElement;
    const first = grid();
    first.scrollTop = 400;

    const tab = (): HTMLButtonElement => document.querySelectorAll<HTMLButtonElement>("#device-setup-banks button")[2];
    const pressed = tab();
    pressed.focus();
    pressed.click();
    expect(grid()).not.toBe(first); // the tab really rebuilt the grid
    expect(tab().getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(tab());
    expect(document.activeElement).not.toBe(pressed);
    expect(grid().scrollTop).toBe(400);

    const fn = (): HTMLSelectElement => document.querySelector<HTMLSelectElement>(".udk-row select")!;
    const picked = fn();
    picked.focus();
    change(picked, "Monitor");
    expect(fn().value).toBe("Monitor");
    expect(document.activeElement).toBe(fn());
    expect(document.activeElement).not.toBe(picked);
    expect(grid().scrollTop).toBe(400);

    const slider = (): HTMLInputElement => document.querySelector("#device-setup-brightness") as HTMLInputElement;
    const stepped = slider();
    stepped.focus();
    stepped.value = "4";
    stepped.dispatchEvent(new Event("change", { bubbles: true }));
    expect(slider().value).toBe("4");
    expect(document.activeElement).toBe(slider());
    expect(document.activeElement).not.toBe(stepped);
    expect(grid().scrollTop).toBe(400);
  });

  it("edits the selected user-defined-knob bank as one three-column write", async () => {
    const { panel, hooks } = install();
    panel.open(defaultDeviceSetup());

    const banks = document.querySelectorAll<HTMLButtonElement>("#device-setup-banks button");
    banks[1].click();
    expect(banks[1].getAttribute("aria-pressed")).toBe("false"); // the click rebuilt the bank buttons
    expect(
      document.querySelectorAll<HTMLButtonElement>("#device-setup-banks button")[1].getAttribute("aria-pressed"),
    ).toBe("true");

    // Each of a knob's three selects is named by the knob and its column's head.
    const named = [...document.querySelectorAll<HTMLSelectElement>(".udk-row select")].map((s) =>
      (s.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .map((ref) => document.getElementById(ref)?.textContent ?? "")
        .join(" "),
    );
    const knob = document.querySelector(".udk-row .knob")!.textContent;
    const heads = [...document.querySelectorAll(".udk-head .cols span")].map((h) => h.textContent);
    expect(heads).toHaveLength(3);
    expect(named.slice(0, 3)).toEqual(heads.map((h) => `${knob} ${h}`));

    const fn = document.querySelector<HTMLSelectElement>(".udk-row select")!;
    change(fn, "Monitor");
    const row = document.querySelector(".udk-row");
    expect(row?.classList.contains("dirty")).toBe(true);
    const values = [...row!.querySelectorAll<HTMLSelectElement>("select")].map((select) => select.value);
    expect(values).toEqual(["Monitor", "Monitor 1", "Level"]);

    (document.querySelector("#device-setup-apply") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(hooks.apply).toHaveBeenCalledOnce());
    expect(hooks.apply).toHaveBeenCalledWith(
      [
        { kind: "str", name: "UDK_FUNCTION", y: 4, value: "Monitor" },
        { kind: "str", name: "UDK_PARAM1", y: 4, value: "Monitor 1" },
        { kind: "str", name: "UDK_PARAM2", y: 4, value: "Level" },
      ],
      1,
    );
  });
});
