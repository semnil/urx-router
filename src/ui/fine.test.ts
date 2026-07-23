// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { initFineMode, fineActive } from "./fine";

const shift = (type: "keydown" | "keyup"): void => {
  window.dispatchEvent(new KeyboardEvent(type, { key: "Shift" }));
};

describe("fine mode (hold Shift)", () => {
  beforeAll(() => initFineMode());
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
