// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { armOnActivate, markMidi, type MidiLearnHooks } from "./midi-learn";

function installHooks() {
  let active = false;
  let armed: string | null = null;
  const hooks: MidiLearnHooks = {
    learnActive: () => active,
    armedId: () => armed,
    isMapped: (id) => id === "gain",
    addrOf: (id) => (id === "gain" ? "CH 1 CC 21" : null),
    arm: vi.fn((id: string) => void (armed = id)),
  };
  return {
    hooks,
    setActive: (next: boolean) => void (active = next),
    setArmed: (next: string | null) => void (armed = next),
  };
}

beforeEach(() => document.body.replaceChildren());

describe("markMidi", () => {
  it("keeps the existing tooltip and marks active, armed mappings", () => {
    const { hooks, setActive, setArmed } = installHooks();
    const control = document.createElement("button");
    control.title = "Output level";

    markMidi(control, "gain", hooks);
    expect(control.title).toBe("Output level\nCH 1 CC 21");
    expect(control.className).toBe("");

    setActive(true);
    setArmed("gain");
    control.title = "";
    markMidi(control, "gain", hooks);
    expect(control.title).toBe("CH 1 CC 21");
    expect(control.classList.contains("midi-target")).toBe(true);
    expect(control.classList.contains("midi-armed")).toBe(true);
    expect(control.classList.contains("midi-mapped")).toBe(true);
  });

  it("does nothing without both a control id and hooks", () => {
    const { hooks } = installHooks();
    const control = document.createElement("button");
    markMidi(control, undefined, hooks);
    markMidi(control, "gain", undefined);
    expect(control.outerHTML).toBe("<button></button>");
  });
});

describe("armOnActivate", () => {
  it("leaves ordinary activation untouched outside learn mode", () => {
    const { hooks } = installHooks();
    const parent = document.createElement("div");
    const control = document.createElement("button");
    const click = vi.fn();
    parent.addEventListener("click", click);
    parent.append(control);
    armOnActivate(control, "gain", hooks);

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    control.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(click).toHaveBeenCalledOnce();
    expect(hooks.arm).not.toHaveBeenCalled();
  });

  it("arms pointer and keyboard activation while swallowing edits", () => {
    const { hooks, setActive } = installHooks();
    const parent = document.createElement("div");
    const control = document.createElement("input");
    const bubbled = vi.fn();
    parent.addEventListener("pointerdown", bubbled);
    parent.addEventListener("click", bubbled);
    parent.addEventListener("keydown", bubbled);
    parent.append(control);
    armOnActivate(control, "gain", hooks);
    setActive(true);

    const pointer = new Event("pointerdown", { bubbles: true, cancelable: true });
    control.dispatchEvent(pointer);
    expect(pointer.defaultPrevented).toBe(true);
    expect(hooks.arm).toHaveBeenLastCalledWith("gain");

    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    control.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);

    const edit = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
    control.dispatchEvent(edit);
    expect(edit.defaultPrevented).toBe(true);
    expect(hooks.arm).toHaveBeenCalledTimes(1);

    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    control.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(hooks.arm).toHaveBeenCalledTimes(2);

    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    control.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(bubbled).toHaveBeenCalledOnce();
  });

  it("does not install interception without hooks", () => {
    const control = document.createElement("button");
    armOnActivate(control, "gain", undefined);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    control.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
