// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetSettingsCache, updateSettings } from "../core/settings";
import {
  copyText,
  el,
  focusables,
  holdAppInert,
  holdInertOnBlur,
  onOff,
  onWheelStep,
  popLeft,
  popTop,
  preserveFocus,
  scrubFloat,
  settingsChoice,
  settingsNote,
  settingsPill,
  settingsRow,
  settingsSection,
  settingsSelect,
  sliderRow,
  wheelStep,
  wireDismiss,
} from "./dom";

// preserveFocus carries keyboard focus across a rebuild of a panel's contents. Two of
// its properties are load-bearing and neither is visible from the outside:
//
//   - the key is the caller's, and the inspector's is the row's LABEL. An index key
//     would hand focus to whatever control moved into the slot when a lock removes the
//     focused one — the case the restore exists for, since that is exactly when the
//     rebuilt panel has one row fewer.
//   - capture runs BEFORE the rebuild, with the element still focused, and the restore
//     ANSWERS the element it focused. That pair is what lets a caller carry a caret
//     over a rebuild (refreshInspector does; the plan already holds every keystroke, so
//     without it the rebuilt field jumps to the end).

// The panel shape both real callers build: a labelled row wrapping one control.
const row = (label: string, control: HTMLElement): HTMLElement => {
  const el = document.createElement("div");
  el.className = "param";
  el.dataset.paramLabel = label;
  el.append(control);
  return el;
};

const slider = (): HTMLInputElement => {
  const input = document.createElement("input");
  input.type = "range";
  return input;
};

// The inspector's rule, restated here because it is the rule under test.
const labelKey = (el: HTMLElement): string => el.closest<HTMLElement>(".param")?.dataset.paramLabel ?? "";

let host: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  resetSettingsCache();
  host = document.createElement("div");
  document.body.replaceChildren(host);
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("preserveFocus", () => {
  it("restores the control with the same LABEL, not the one in the same slot", () => {
    host.append(row("Level", slider()), row("Pan", slider()));
    const pan = focusables(host)[1];
    pan.focus();
    expect(document.activeElement).toBe(pan);

    const restore = preserveFocus(
      host,
      (active) => labelKey(active),
      (key) => focusables(host).find((el) => labelKey(el) === key),
    );
    // The rebuild a lock produces: the focused row keeps its label, and the row above it
    // is gone — so "Pan" is now at index 0, where "Level" used to be.
    host.replaceChildren(row("Pan", slider()), row("Send", slider()));
    const focused = restore();

    expect(focused).toBe(focusables(host)[0]);
    expect(labelKey(document.activeElement as HTMLElement)).toBe("Pan");
  });

  it("drops focus when the rebuilt panel has no row of that label", () => {
    host.append(row("Level", slider()));
    focusables(host)[0].focus();
    const restore = preserveFocus(
      host,
      (active) => labelKey(active),
      (key) => focusables(host).find((el) => labelKey(el) === key),
    );
    host.replaceChildren(row("Pan", slider()));
    expect(restore()).toBeNull();
    expect(document.activeElement).not.toBe(focusables(host)[0]);
  });

  it("leaves a focus outside the host alone", () => {
    host.append(row("Level", slider()));
    const outside = slider();
    document.body.append(outside);
    outside.focus();

    let captured = 0;
    const restore = preserveFocus(
      host,
      (active) => {
        captured++;
        return labelKey(active);
      },
      (key) => focusables(host).find((el) => labelKey(el) === key),
    );
    host.replaceChildren(row("Level", slider()));

    expect(captured).toBe(0); // never asked about an element it does not own
    expect(restore()).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it("carries a text surface's caret over the rebuild", () => {
    const name = document.createElement("input");
    name.type = "text";
    name.value = "CH 1 vocal";
    host.append(row("Name", name));
    name.focus();
    name.setSelectionRange(2, 5);

    // The caller's idiom: the caret is read in the capture, while the old field is still
    // focused, and written onto the element the restore answers.
    const carried: { caret: [number | null, number | null] | null } = { caret: null };
    const restore = preserveFocus(
      host,
      (active) => {
        if (active instanceof HTMLInputElement) carried.caret = [active.selectionStart, active.selectionEnd];
        return labelKey(active);
      },
      (key) => focusables(host).find((el) => labelKey(el) === key),
    );
    const rebuilt = document.createElement("input");
    rebuilt.type = "text";
    rebuilt.value = "CH 1 vocal";
    host.replaceChildren(row("Name", rebuilt));
    const focused = restore();
    if (carried.caret && focused instanceof HTMLInputElement) focused.setSelectionRange(...carried.caret);

    expect(document.activeElement).toBe(rebuilt);
    expect([rebuilt.selectionStart, rebuilt.selectionEnd]).toEqual([2, 5]);
  });

  it("restores a non-zero scroll offset before focus", () => {
    host.append(row("Level", slider()));
    focusables(host)[0].focus();
    const scrollTop = vi.fn(() => 42);
    const restore = preserveFocus(
      host,
      (active) => labelKey(active),
      (key) => focusables(host).find((control) => labelKey(control) === key),
      scrollTop,
    );

    host.replaceChildren(row("Level", slider()));
    expect(restore()).toBe(focusables(host)[0]);
    expect(scrollTop).toHaveBeenCalledOnce();
    expect(host.scrollTop).toBe(42);
  });
});

describe("wheel helpers", () => {
  it("uses the configured detent count and Shift-remapped horizontal wheel", () => {
    updateSettings({ wheelSteps: 2 });
    const target = document.createElement("div");
    const step = vi.fn();
    onWheelStep(target, step);

    const up = new WheelEvent("wheel", { deltaY: -1, bubbles: true, cancelable: true });
    target.dispatchEvent(up);
    expect(up.defaultPrevented).toBe(true);
    expect(step.mock.calls).toEqual([[1], [1]]);

    const horizontal = new WheelEvent("wheel", { deltaX: 3, shiftKey: true, bubbles: true, cancelable: true });
    target.dispatchEvent(horizontal);
    expect(horizontal.defaultPrevented).toBe(true);
    expect(step.mock.calls.slice(2)).toEqual([[-1], [-1]]);

    const ignored = new WheelEvent("wheel", { deltaX: 3, bubbles: true, cancelable: true });
    target.dispatchEvent(ignored);
    expect(ignored.defaultPrevented).toBe(false);
    expect(step).toHaveBeenCalledTimes(4);
  });

  it("honours a blocked wheel and clamps range inputs", () => {
    const blockedTarget = document.createElement("div");
    const blockedStep = vi.fn();
    onWheelStep(blockedTarget, blockedStep, () => true);
    const blocked = new WheelEvent("wheel", { deltaY: -1, cancelable: true });
    blockedTarget.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(false);
    expect(blockedStep).not.toHaveBeenCalled();

    const range = slider();
    range.min = "0";
    range.max = "1";
    range.step = "0.1";
    range.value = "0.9";
    const input = vi.fn();
    range.addEventListener("input", input);
    wheelStep(range);
    range.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, cancelable: true }));
    range.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, cancelable: true }));
    expect(range.value).toBe("1");
    expect(input).toHaveBeenCalledOnce();
    expect(scrubFloat(2.7000000000000002)).toBe(2.7);
  });
});

describe("holdInertOnBlur", () => {
  // Every native range in the app is wired through this, so the cases live with the helper
  // rather than with any one surface. The reading behind it: the engine owns a native
  // drag, so no listener the app drops ends it — measured on the shipping WKWebView, a
  // slider dragged with the button held went on writing while another application was
  // frontmost, and it RESUMED when focus came back if the treatment only ended it once.
  const range = (live?: () => HTMLInputElement | null): HTMLInputElement => {
    const input = document.createElement("input");
    input.type = "range";
    input.min = "0";
    input.max = "100";
    input.value = "50";
    document.body.append(input);
    holdInertOnBlur(input, { live });
    return input;
  };
  const press = (el: HTMLElement): void =>
    void el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
  const up = (): void => void window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));

  it("disables the control while the window is away and re-arms it when the button comes up", () => {
    const input = range();
    press(input);
    input.focus();
    window.dispatchEvent(new FocusEvent("blur"));
    expect(input.disabled).toBe(true);

    // Focus returning is deliberately NOT the re-arm: with the button still down the
    // engine picked the drag back up, which is the reading this shape exists for.
    window.dispatchEvent(new FocusEvent("focus"));
    expect(input.disabled).toBe(true);

    up();
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it("re-arms on a move that reports no buttons, the release the window never heard", () => {
    const input = range();
    press(input);
    window.dispatchEvent(new FocusEvent("blur"));
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, buttons: 1 }));
    expect(input.disabled).toBe(true);
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, buttons: 0 }));
    expect(input.disabled).toBe(false);
  });

  it("does nothing to a drag that ended normally, or to a blur with no press behind it", () => {
    const input = range();
    press(input);
    up();
    window.dispatchEvent(new FocusEvent("blur"));
    expect(input.disabled).toBe(false);

    window.dispatchEvent(new FocusEvent("blur"));
    expect(input.disabled).toBe(false);
  });

  it("leaves the live row's own disabled state alone, and does not focus a locked one", () => {
    const replacement = document.createElement("input");
    replacement.type = "range";
    replacement.disabled = true; // what a rebuild does to a row the device has taken over
    const input = range(() => replacement);
    press(input);
    input.focus();
    window.dispatchEvent(new FocusEvent("blur"));
    // The surface rebuilt the row while the press was still down.
    input.replaceWith(replacement);
    up();
    expect(replacement.disabled).toBe(true);
    expect(document.activeElement).not.toBe(replacement);
  });
  it("answers only the pointer that armed it, so a second one cannot re-arm the row", () => {
    const input = range();
    press(input);
    window.dispatchEvent(new FocusEvent("blur"));
    // A finger resting while a mouse moves, or a hovering pen: no buttons of its own.
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 99, buttons: 0 }));
    expect(input.disabled).toBe(true);
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 99 }));
    expect(input.disabled).toBe(true);
    up();
    expect(input.disabled).toBe(false);
  });

  it("does not take focus back from whatever the operator touched next", () => {
    const input = range();
    const other = document.createElement("input");
    other.type = "text";
    document.body.append(other);
    press(input);
    input.focus();
    window.dispatchEvent(new FocusEvent("blur"));
    // The press that ends the hold is often the next gesture, on another control.
    other.focus();
    up();
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(other);
  });

  it("holds the row the surface rebuilt, when the rebuild lands on the same blur", () => {
    const replacement = document.createElement("input");
    replacement.type = "range";
    const input = range(() => replacement);
    // A surface registers its blur listener when it is built, so it runs FIRST and the
    // element this gesture started on is already detached by the time the hold applies.
    window.addEventListener("blur", () => input.replaceWith(replacement));
    press(input);
    window.dispatchEvent(new FocusEvent("blur"));
    expect(replacement.disabled).toBe(true);
    up();
    expect(replacement.disabled).toBe(false);
  });

  it("commits through `beforeDisable` before anything is held", () => {
    const input = document.createElement("input");
    input.type = "range";
    input.min = "0";
    input.max = "100";
    input.value = "50";
    document.body.append(input);
    const committed: Array<{ value: string; disabled: boolean }> = [];
    holdInertOnBlur(input, { beforeDisable: () => committed.push({ value: input.value, disabled: input.disabled }) });
    press(input);
    input.value = "70";
    window.dispatchEvent(new FocusEvent("blur"));
    // Chromium fires the pending `change` at the disable and WebKit fires none, so the
    // caller commits here — with the value still readable and the row not yet inert.
    expect(committed).toEqual([{ value: "70", disabled: false }]);
    expect(input.disabled).toBe(true);
  });

  it("ignores a wheel notch while the row is held inert", () => {
    const input = range();
    wheelStep(input);
    press(input);
    window.dispatchEvent(new FocusEvent("blur"));
    input.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    expect(input.value).toBe("50");
    up();
    input.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    expect(input.value).not.toBe("50");
  });
});

describe("overlay and popover helpers", () => {
  it("attaches, pauses and detaches outside/Escape dismissal", () => {
    let inert = false;
    const keep = document.createElement("button");
    const close = vi.fn();
    const dismiss = wireDismiss({ keep: (target) => target === keep, inert: () => inert, close });
    dismiss.attach();

    keep.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(close).not.toHaveBeenCalled();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(close).toHaveBeenCalledOnce();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(close).toHaveBeenCalledOnce();

    inert = true;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(close).toHaveBeenCalledOnce();
    inert = false;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(close).toHaveBeenCalledTimes(2);

    dismiss.detach();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("clamps horizontal placement and flips vertical placement", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 300 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 200 });
    expect(popLeft(-20, 100)).toBe(6);
    expect(popLeft(80, 100)).toBe(80);
    expect(popLeft(250, 100)).toBe(194);

    const anchor = { top: 80, bottom: 100 } as DOMRect;
    expect(popTop(anchor, 40, 8)).toBe(108);
    expect(popTop({ top: 170, bottom: 190 } as DOMRect, 60, 8)).toBe(102);
    expect(popTop({ top: 10, bottom: 190 } as DOMRect, 60, 8)).toBe(6);
  });

  it("reports clipboard capability, success and rejection", async () => {
    expect(await copyText("plan")).toBe(false);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    expect(await copyText("plan")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("plan");
    writeText.mockRejectedValueOnce(new Error("denied"));
    expect(await copyText("plan")).toBe(false);
  });
});

describe("settings builders", () => {
  it("builds sections, notes, pills and locked labelled rows", () => {
    expect(el("div", "card").className).toBe("card");
    expect(settingsPill("Desktop").outerHTML).toBe('<span class="prefs-lock">Desktop</span>');
    expect(settingsNote("Stored immediately").textContent).toBe("Stored immediately");

    const section = settingsSection("Files", { text: "Desktop", shown: false });
    expect(section.querySelector("h3")?.firstChild?.textContent).toBe("Files");
    expect(section.querySelector(".prefs-lock")?.classList.contains("gt-reserved")).toBe(true);

    const control = document.createElement("div");
    control.append(document.createElement("button"), document.createElement("select"), document.createElement("input"));
    const legend = document.createElement("em");
    legend.textContent = "FINE";
    const built = settingsRow("Level", control, { locked: true, tag: "Unavailable", cls: "dirty", legend });
    expect(built.className).toBe("prefs-row dirty locked");
    expect(
      [
        ...built.querySelectorAll<HTMLButtonElement | HTMLSelectElement | HTMLInputElement>("button,select,input"),
      ].every((c) => c.disabled),
    ).toBe(true);
    expect(built.querySelector(".lblc")?.children[1]).toBe(legend);
    expect(built.querySelector(".prefs-lock")?.textContent).toBe("Unavailable");
  });

  it("selects only inactive choices and handles empty or numeric selects", () => {
    const pick = vi.fn();
    const choices = settingsChoice(["A", "B"], 0, pick, true);
    const buttons = choices.querySelectorAll<HTMLButtonElement>("button");
    buttons[0].click();
    buttons[1].click();
    expect(choices.className).toBe("prefs-toggle narrow");
    expect(pick).toHaveBeenCalledOnce();
    expect(pick).toHaveBeenCalledWith(1);

    const apply = vi.fn();
    const select = settingsSelect([1, 2, 4], 2, String, apply);
    changeSelect(select, "4");
    expect(apply).toHaveBeenCalledWith(4);
    changeSelect(select, "99");
    expect(apply).toHaveBeenCalledOnce();

    const empty = settingsSelect<string>([], "", String, apply, "None");
    expect(empty.disabled).toBe(true);
    expect(empty.textContent).toBe("None");
  });

  it("wires ON/OFF and slider rows through their public callbacks", () => {
    const toggle = vi.fn();
    const faces = onOff(false, toggle).querySelectorAll<HTMLButtonElement>("button");
    faces[0].click();
    expect(toggle).toHaveBeenCalledWith(true);

    const inputValue = vi.fn();
    const built = sliderRow({
      label: "Gain",
      id: "gain",
      min: -10,
      max: 10,
      step: 0.5,
      value: 1,
      format: (value) => `${value} dB`,
      onInput: inputValue,
    });
    const input = built.querySelector("#gain") as HTMLInputElement;
    expect(input.getAttribute("aria-label")).toBe("Gain");
    expect(input.getAttribute("aria-valuetext")).toBe("1 dB");
    input.value = "1.5";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(inputValue).toHaveBeenCalledWith(1.5);
    expect(input.getAttribute("aria-valuetext")).toBe("1.5 dB");
  });
});

describe("holdAppInert", () => {
  // The scrims are siblings of #app, not children, so inerting the app alone says
  // nothing about a modal stacked under another modal — which is how a Tab from a
  // load report reached the Preferences rows behind it.
  const app = (): HTMLElement => document.getElementById("app") as HTMLElement;
  let a: HTMLElement;
  let b: HTMLElement;

  beforeEach(() => {
    document.body.replaceChildren();
    const appHost = el("div", "");
    appHost.id = "app";
    a = el("div", "consent-scrim");
    b = el("div", "consent-scrim");
    document.body.append(appHost, a, b);
  });

  // toBeFalsy for a value nothing has written yet: jsdom does not implement `inert`
  // as an IDL attribute, so an untouched element reads undefined rather than false.
  // Every later assertion is exact, because by then the helper has written it.
  it("inerts the app while held, and gives it back on release", () => {
    expect(app().inert).toBeFalsy();
    const release = holdAppInert(a);
    expect(app().inert).toBe(true);
    expect(a.inert).toBeFalsy(); // the modal that holds it stays reachable
    release();
    expect(app().inert).toBe(false);
  });

  it("leaves only the topmost modal reachable", () => {
    const releaseA = holdAppInert(a);
    const releaseB = holdAppInert(b);
    expect(a.inert).toBe(true); // the one underneath
    expect(b.inert).toBe(false);
    releaseB();
    expect(a.inert).toBe(false); // back on top
    expect(app().inert).toBe(true);
    releaseA();
    expect(app().inert).toBe(false);
  });

  it("releases by identity, so a lower modal can close first", () => {
    const releaseA = holdAppInert(a);
    holdAppInert(b);
    releaseA();
    expect(a.inert).toBe(false); // no longer holding anything
    expect(b.inert).toBe(false); // still the top
    expect(app().inert).toBe(true);
  });

  it("ignores a second release of the same claim", () => {
    const releaseA = holdAppInert(a);
    holdAppInert(b);
    releaseA();
    releaseA();
    expect(app().inert).toBe(true); // b still holds it
  });

  // The overlay ladder, not the claim order, says which one is in front: a decision
  // gate is drawn over a tool modal whenever it opens, and a modal that opens on an
  // await (the licenses notice, Device setup) claims AFTER the gate that arrived
  // while it was loading. Taking the last claim as the top inerted the gate the
  // operator was looking at and handed focus to the modal behind it.
  it("leaves the modal the ladder draws on top reachable, not the last to claim", () => {
    a.style.zIndex = "130"; // a decision gate
    b.style.zIndex = "100"; // a tool modal, opened late
    const releaseGate = holdAppInert(a);
    holdAppInert(b);
    expect(a.inert).toBe(false);
    expect(b.inert).toBe(true);
    // Closing the gate hands the one underneath back, exactly as the reverse order does.
    releaseGate();
    expect(b.inert).toBe(false);
    expect(app().inert).toBe(true);
  });

  it("settles an equal z-index on document order, the tiebreak the painter uses", () => {
    a.style.zIndex = "100";
    b.style.zIndex = "100"; // b follows a in the document
    holdAppInert(b);
    holdAppInert(a);
    expect(b.inert).toBe(false);
    expect(a.inert).toBe(true);
  });
});

function changeSelect(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}
