// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { compositionGate, inspectorNodes } from "./inspector";

// The panel renders one selection, and which controls it renders is derived from that
// selection's endpoint NODES — not only from the selected object. A device-side change
// on a node the panel is not "showing" can still remove a control it is rendering (a
// bus's Pan Link removes the send PAN on every wire into it), so the caller that
// decides whether to repaint has to know the footprint. These pin it.

describe("inspectorNodes", () => {
  it("reports nothing for an empty selection", () => {
    expect(inspectorNodes(null)).toEqual([]);
  });

  it("reports the node itself for a node selection", () => {
    expect(inspectorNodes({ type: "node", id: "ch1" })).toEqual(["ch1"]);
  });

  it("reports BOTH endpoints for a wire — the destination is why this exists", () => {
    // The destination bus's BUS Type / Pan Link decide which of the send controls the
    // panel draws at all; the source channel's Signal Type decides the pan's label.
    expect(inspectorNodes({ type: "conn", from: "ch1:out", to: "bus.mix1:in" })).toEqual(["ch1", "bus.mix1"]);
  });
});

// The panel rebuilds itself with replaceChildren, which ends an in-flight IME
// composition — so a device-driven reflect arriving while a node name is being typed in
// kana commits the interim characters and restarts composition, ~20 times a second
// through a knob sweep. These pin the bookkeeping that holds the rebuild; whether the
// real webview behaves as described is a WKWebView question neither jsdom nor Chromium
// answers.

describe("compositionGate", () => {
  const host = (): HTMLElement => {
    const el = document.createElement("div");
    el.append(document.createElement("input"));
    document.body.replaceChildren(el);
    return el;
  };
  const fire = (el: HTMLElement, type: string): void => {
    el.querySelector("input")!.dispatchEvent(new Event(type, { bubbles: true }));
  };

  it("lets a rebuild through when nothing is composing", () => {
    let rebuilds = 0;
    const gate = compositionGate(host(), () => rebuilds++);
    expect(gate.held()).toBe(false);
    expect(rebuilds).toBe(0); // the caller rebuilds; the gate does not
  });

  it("holds every rebuild asked for during a composition and runs one when it ends", () => {
    let rebuilds = 0;
    const el = host();
    const gate = compositionGate(el, () => rebuilds++);
    fire(el, "compositionstart");
    expect(gate.held()).toBe(true);
    expect(gate.held()).toBe(true); // a knob sweep asks many times over
    expect(rebuilds).toBe(0);
    fire(el, "compositionend");
    expect(rebuilds).toBe(1); // one rebuild, carrying everything that landed meanwhile
    expect(gate.held()).toBe(false);
  });

  it("runs nothing on an end that held no rebuild", () => {
    let rebuilds = 0;
    const el = host();
    compositionGate(el, () => rebuilds++);
    fire(el, "compositionstart");
    fire(el, "compositionend");
    expect(rebuilds).toBe(0);
  });

  it("releases on focusout, so a field that goes away cannot wedge the panel", () => {
    let rebuilds = 0;
    const el = host();
    const gate = compositionGate(el, () => rebuilds++);
    fire(el, "compositionstart");
    expect(gate.held()).toBe(true);
    fire(el, "focusout");
    expect(rebuilds).toBe(1);
    expect(gate.held()).toBe(false);
    // And the composition's own end afterwards is not a second rebuild.
    fire(el, "compositionend");
    expect(rebuilds).toBe(1);
  });
});
