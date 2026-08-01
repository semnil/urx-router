// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { focusables, preserveFocus } from "./dom";

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
  host = document.createElement("div");
  document.body.replaceChildren(host);
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
});
