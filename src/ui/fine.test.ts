// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { initFineMode, fineActive, resetFine } from "./fine";
import { resetSettingsCache, updateSettings } from "../core/settings";
import { pinSettingsReset } from "../core/settings-reset.test-util";

const shift = (type: "keydown" | "keyup"): void => {
  window.dispatchEvent(new KeyboardEvent(type, { key: "Shift" }));
};

beforeAll(() => initFineMode());
beforeEach(() => {
  localStorage.clear();
  resetSettingsCache();
});

pinSettingsReset();

describe("fine mode (hold Shift)", () => {
  beforeEach(() => {
    shift("keyup"); // start every test coarse
    document.body.replaceChildren();
  });

  it("tracks Shift onto the root class and reports via fineActive", () => {
    expect(fineActive()).toBe(false);
    shift("keydown");
    expect(fineActive()).toBe(true);
    expect(document.documentElement.classList.contains("fine-mode")).toBe(true);
    shift("keyup");
    expect(fineActive()).toBe(false);
    expect(document.documentElement.classList.contains("fine-mode")).toBe(false);
  });

  it("swaps the step attribute of opted-in sliders and restores it", () => {
    const slider = document.createElement("input");
    slider.type = "range";
    slider.step = "0.5";
    slider.dataset.coarseStep = "0.5";
    slider.dataset.fineStep = "0.1";
    const plain = document.createElement("input");
    plain.type = "range";
    plain.step = "1";
    document.body.append(slider, plain);
    shift("keydown");
    expect(slider.step).toBe("0.1");
    expect(plain.step).toBe("1"); // no opt-in, untouched
    shift("keyup");
    expect(slider.step).toBe("0.5");
  });

  it("a non-Shift key changes nothing", () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(fineActive()).toBe(false);
  });

  it("window blur resets a held Shift (missed keyup never latches)", () => {
    shift("keydown");
    expect(fineActive()).toBe(true);
    window.dispatchEvent(new Event("blur"));
    expect(fineActive()).toBe(false);
    expect(document.documentElement.classList.contains("fine-mode")).toBe(false);
  });
});

describe("fine mode (latch)", () => {
  beforeEach(() => {
    updateSettings({ fineLatch: true });
    resetFine();
    document.body.replaceChildren();
  });
  afterEach(() => resetFine());

  const press = (target: EventTarget, init: KeyboardEventInit = {}): void => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true, ...init }));
  };
  const field = (build: () => HTMLElement): HTMLElement => {
    const el = build();
    document.body.append(el);
    return el;
  };

  // A capital letter typed into the Inspector's Name field is a Shift press the field owns.
  it("ignores a Shift typed into a text surface", () => {
    const text = field(() => Object.assign(document.createElement("input"), { type: "text" }));
    const area = field(() => document.createElement("textarea"));
    press(text);
    expect(fineActive()).toBe(false);
    press(area);
    expect(fineActive()).toBe(false);
  });

  it("ignores a Shift pressed during an IME composition", () => {
    press(window, { isComposing: true });
    expect(fineActive()).toBe(false);
  });

  it("flips on a Shift pressed over a slider or the page", () => {
    const range = field(() => Object.assign(document.createElement("input"), { type: "range" }));
    press(range);
    expect(fineActive()).toBe(true);
    press(window);
    expect(fineActive()).toBe(false);
  });
});
