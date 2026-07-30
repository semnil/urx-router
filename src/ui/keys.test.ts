// @vitest-environment jsdom
// Both predicates decide who a keystroke belongs to, and getting either wrong is
// silent: an undo that quietly does nothing, or a fine-mode latch that flips on a
// chord. The truth tables are pinned here rather than at each caller.
import { describe, expect, it } from "vitest";
import { isChord, ownsNativeUndo } from "./keys";

const el = (tag: string, type?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (type) (node as HTMLInputElement).type = type;
  return node;
};

describe("ownsNativeUndo", () => {
  it("claims the text surfaces", () => {
    expect(ownsNativeUndo(el("textarea"))).toBe(true);
    for (const type of ["text", "search", "url", "tel", "email", "password", "number"]) {
      expect(ownsNativeUndo(el("input", type)), type).toBe(true);
    }
    const editable = el("div");
    editable.setAttribute("contenteditable", "true");
    expect(ownsNativeUndo(editable)).toBe(true);
    // A child of an editable region is where a keystroke actually lands.
    const inner = el("span");
    editable.append(inner);
    expect(ownsNativeUndo(inner)).toBe(true);
  });

  it("does not claim an explicitly non-editable region", () => {
    const off = el("div");
    off.setAttribute("contenteditable", "false");
    expect(ownsNativeUndo(off)).toBe(false);
  });

  it("leaves everything with no undo stack of its own", () => {
    expect(ownsNativeUndo(el("select"))).toBe(false);
    expect(ownsNativeUndo(el("button"))).toBe(false);
    expect(ownsNativeUndo(el("div"))).toBe(false);
    for (const type of ["range", "checkbox", "radio", "color", "file"]) {
      expect(ownsNativeUndo(el("input", type)), type).toBe(false);
    }
  });

  it("treats an unknown input type as text, the way the DOM does", () => {
    const node = document.createElement("input");
    node.setAttribute("type", "totally-new");
    expect(ownsNativeUndo(node)).toBe(true);
  });

  it("is safe on a null or non-element target", () => {
    expect(ownsNativeUndo(null)).toBe(false);
    expect(ownsNativeUndo(window)).toBe(false);
  });
});

describe("isChord", () => {
  const key = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent("keydown", init);

  it("claims a command-modified key", () => {
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      expect(isChord(key({ key: "z", ...init }))).toBe(true);
    }
  });

  it("does not claim a bare key, Shift included", () => {
    expect(isChord(key({ key: "Shift", shiftKey: true }))).toBe(false);
    expect(isChord(key({ key: "z" }))).toBe(false);
  });

  it("claims the Shift of a chord, which is the case fine mode must not latch on", () => {
    expect(isChord(key({ key: "Shift", shiftKey: true, metaKey: true }))).toBe(true);
  });
});
