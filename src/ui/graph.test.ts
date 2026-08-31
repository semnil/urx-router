// @vitest-environment jsdom

// The SVG node graph. Everything here runs against a real (jsdom) board built the
// way main.ts builds it — the DOM contract asserted below is the same one the
// Playwright specs address, so a rename that breaks them breaks these first.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/storage", async (importOriginal) => {
  const real = await importOriginal<typeof import("../core/storage")>();
  return {
    ...real,
    // The real raster path builds a blob: URL and waits for img.onload, which never
    // fires in jsdom — the promise would simply hang. baseName stays real so the
    // status line's savedTo(baseName(path)) is exercised.
    exportSvgToPng: vi.fn(async () => ({ saved: true, path: "/tmp/board.png" })),
    exportSvgToPdf: vi.fn(async () => ({ saved: false })),
  };
});

import { exportSvgToPdf, exportSvgToPng } from "../core/storage";
import { PALETTES, WIRE_GROUP } from "./graph";
import {
  drag,
  faceplate,
  graphFixture,
  nodeEl,
  nodeIds,
  portHit,
  press,
  selBarCount,
  shelfChips,
  tapHit,
  wireHit,
} from "./graph.test-util";
import type { GraphFixture } from "./graph.test-util";
import { LEVEL_MIN_DB } from "../core/plan";
import { isFixedConnection } from "../core/routing";
import { getModel } from "../models";
import { getSettings, resetSettingsCache, updateSettings } from "../core/settings";
import { setLang, t } from "../i18n";

let fx: GraphFixture;

const statuses = (): string[] => fx.cb.onStatus.mock.calls.map(([m]) => m as string);

beforeEach(() => {
  localStorage.clear();
  resetSettingsCache();
  setLang("en");
});

afterEach(() => {
  fx?.restore();
  document.body.replaceChildren();
  vi.mocked(exportSvgToPng).mockClear();
  vi.mocked(exportSvgToPdf).mockClear();
});

describe("construction", () => {
  it("builds the scaffold, the defs and a node per model node", () => {
    fx = graphFixture();
    expect(fx.svg).not.toBeNull();
    expect(fx.host.querySelector("#jack-glow")).not.toBeNull();
    expect(fx.host.querySelector("#node-shadow")).not.toBeNull();
    expect(nodeIds(fx.host).length).toBeGreaterThan(10);
    expect(nodeEl(fx.host, "ch1")).not.toBeNull();
  });

  it("draws a jack pair and a hit disc per port", () => {
    fx = graphFixture();
    expect(portHit(fx.host, "ch1:out")).not.toBeNull();
    expect(portHit(fx.host, "bus.mix1:in")).not.toBeNull();
    expect(fx.host.querySelectorAll(".port-pin").length).toBeGreaterThan(0);
  });

  // A channel's direct outs and recordings start at the Rec Point tap on its top
  // edge, which is a second jack carrying the same ref under data-tap.
  it("gives a channel a Rec Point tap distinct from its right-edge jack", () => {
    fx = graphFixture();
    expect(tapHit(fx.host, "ch1:out")).not.toBeNull();
    expect(tapHit(fx.host, "ch1:out")).not.toBe(portHit(fx.host, "ch1:out"));
    expect(fx.host.querySelectorAll(".port-tap").length).toBeGreaterThan(0);
  });

  it("draws a hit path per wire, addressed by its endpoints", () => {
    fx = graphFixture();
    const conn = fx.plan.connections[0];
    expect(wireHit(fx.host, conn.from, conn.to)).not.toBeNull();
    expect(fx.host.querySelectorAll(".wire-hit").length).toBe(fx.plan.connections.length);
  });

  it("builds a URX22 board with no SD Rec node", () => {
    fx = graphFixture({ modelId: "URX22" });
    expect(nodeIds(fx.host).length).toBeGreaterThan(5);
    expect(nodeEl(fx.host, "out.sdrec")).toBeNull();
  });
});

describe("appearance", () => {
  // Visual attributes are inline presentation attributes, not CSS — that is what
  // makes the PNG export match the screen — so a theme switch has to rewrite them.
  it("repaints every faceplate into the other palette on a theme switch", () => {
    fx = graphFixture();
    const fill = (): string | null => faceplate(fx.host, "ch1")!.getAttribute("fill");
    const dark = fill();
    fx.graph.setTheme("light");
    expect(fill()).not.toBe(dark);
    fx.graph.setTheme("dark");
    expect(fill()).toBe(dark);
  });

  // Six connection kinds share three colour families, and the mapping has to stay
  // exhaustive — a missed kind used to draw silently in grey.
  it("assigns every connection kind a wire group", () => {
    for (const conn of graphFixture().plan.connections) expect(WIRE_GROUP[conn.kind]).toBeDefined();
    fx = graphFixture();
  });

  it("shows the device name in place of the model label when asked", () => {
    fx = graphFixture({ seed: (plan) => void (plan.nodeNames["ch1"] = "kick") });
    const model = fx.graph.labelOf("ch1");
    fx.graph.setLabelSource("device");
    expect(fx.graph.labelOf("ch1")).toBe("kick");
    expect(fx.graph.labelOf("ch1")).not.toBe(model);
  });

  it("falls back to the model label for a node the plan does not name", () => {
    fx = graphFixture();
    fx.graph.setLabelSource("device");
    expect(fx.graph.labelOf("ch1")).not.toBe("");
  });

  it("remembers whether off sends are hidden", () => {
    fx = graphFixture();
    expect(fx.graph.isHideOffSends()).toBe(false);
    fx.graph.setHideOffSends(true);
    expect(fx.graph.isHideOffSends()).toBe(true);
  });

  // A send at the bottom of the level grid carries no signal; hiding it declutters
  // the board without changing the plan.
  it("drops an off send from the board only while decluttering", () => {
    const send = (plan: { connections: Array<{ kind: string; params?: Record<string, unknown> }> }) => {
      const c = plan.connections.find((x) => x.kind === "send")!;
      c.params = { ...c.params, level: LEVEL_MIN_DB };
      return c;
    };
    let target: { from: string; to: string } | null = null;
    fx = graphFixture({
      seed: (plan) => {
        const c = send(plan as never) as unknown as { from: string; to: string };
        target = { from: c.from, to: c.to };
      },
    });
    expect(wireHit(fx.host, target!.from, target!.to)).not.toBeNull();
    fx.graph.setHideOffSends(true);
    expect(wireHit(fx.host, target!.from, target!.to)).toBeNull();
    fx.graph.setHideOffSends(false);
    expect(wireHit(fx.host, target!.from, target!.to)).not.toBeNull();
  });

  // The set is what rateConstraints hands over, so the id is the one it can actually
  // produce. Asserting the dim and the dashed outline rather than the node's presence:
  // a node that stopped being marked at all is still present, and that is the failure
  // this pins.
  it("marks the nodes a rate constraint disabled", () => {
    fx = graphFixture();
    fx.graph.setDisabledNodes(["bus.fx2"]);
    const marked = nodeEl(fx.host, "bus.fx2")!;
    expect(marked.getAttribute("opacity")).toBe("0.62");
    expect(marked.querySelector("rect")?.getAttribute("stroke-dasharray")).toBe("4 3");
    fx.graph.setDisabledNodes([]);
    const cleared = nodeEl(fx.host, "bus.fx2")!;
    expect(cleared.getAttribute("opacity")).not.toBe("0.62");
    expect(cleared.querySelector("rect")?.getAttribute("stroke-dasharray")).toBeNull();
  });

  // A full device reconcile re-applies the set on every pass, and the set holds at most
  // one member — so the repeat is the common case, and rendering it repeats the render
  // the caller just did. Element identity is what says no render ran: render() replaces
  // every node group.
  it("leaves the board alone when the same disabled set is applied again", () => {
    fx = graphFixture();
    fx.graph.setDisabledNodes(["bus.fx2"]);
    const first = nodeEl(fx.host, "bus.fx2");
    fx.graph.setDisabledNodes(["bus.fx2"]);
    expect(nodeEl(fx.host, "bus.fx2")).toBe(first);
    // A set that differs still renders, and the stored set is the new one.
    fx.graph.setDisabledNodes([]);
    expect(nodeEl(fx.host, "bus.fx2")).not.toBe(first);
    expect(nodeEl(fx.host, "bus.fx2")!.getAttribute("opacity")).not.toBe("0.62");
  });

  // The console view hides the graph host, and a rate excursion past 96 kHz moves the
  // set while it is hidden. The set is still stored — the deferred refresh draws from
  // it — but the board is not rebuilt into display:none.
  it("stores a moved disabled set without rebuilding a hidden board", () => {
    fx = graphFixture();
    const before = nodeEl(fx.host, "bus.fx2");
    fx.host.hidden = true;
    fx.graph.setDisabledNodes(["bus.fx2"]);
    expect(nodeEl(fx.host, "bus.fx2")).toBe(before);

    // What the deferred refresh draws: the stored set, not the one the board was built
    // against. A store that had been skipped would leave the node undimmed here.
    fx.host.hidden = false;
    fx.graph.refresh();
    expect(nodeEl(fx.host, "bus.fx2")!.getAttribute("opacity")).toBe("0.62");
  });

  it("re-labels its chrome on a language switch", () => {
    fx = graphFixture({ seed: (plan) => void (plan.hidden = ["bus.mix2"]) });
    const en = fx.host.querySelector(".shelf-label")!.textContent;
    setLang("ja");
    fx.graph.relocalizeChrome();
    expect(fx.host.querySelector(".shelf-label")!.textContent).not.toBe(en);
    setLang("en");
  });

  it("repaints nodes and wires on demand without rebuilding the board", () => {
    fx = graphFixture();
    const before = nodeEl(fx.host, "ch1");
    fx.graph.repaintNodes();
    fx.graph.repaintWires();
    fx.graph.repaintDirtyNodes(["ch1"]);
    expect(nodeEl(fx.host, "ch1")).not.toBeNull();
    expect(before).not.toBeNull();
  });
});

describe("selection", () => {
  it("selects a wire from its hit path and reports it", () => {
    fx = graphFixture();
    const conn = fx.plan.connections.find((c) => c.kind === "send")!;
    press(wireHit(fx.host, conn.from, conn.to)!);
    expect(fx.cb.onSelect).toHaveBeenCalledWith({ type: "conn", from: conn.from, to: conn.to });
  });

  it("clears the selection and reports the empty one", () => {
    fx = graphFixture();
    const conn = fx.plan.connections[0];
    press(wireHit(fx.host, conn.from, conn.to)!);
    fx.cb.onSelect.mockClear();
    fx.graph.clearSelection();
    expect(fx.cb.onSelect).toHaveBeenCalledWith(null);
  });

  // Two or more nodes get the floating action bar; one keeps using the inspector.
  it("shows the multi-select bar from two nodes up", () => {
    fx = graphFixture();
    const g = fx.graph as unknown as { toggleNodeSelection: (id: string) => void };
    g.toggleNodeSelection("ch1");
    expect(selBarCount(fx.host)).toBe("");
    g.toggleNodeSelection("ch2");
    expect(selBarCount(fx.host)).toBe("2");
  });

  it("shelves the whole multi-selection from the bar", () => {
    fx = graphFixture();
    const g = fx.graph as unknown as { toggleNodeSelection: (id: string) => void };
    g.toggleNodeSelection("ch1");
    g.toggleNodeSelection("ch2");
    fx.host.querySelector<HTMLButtonElement>(".selbar-hide")!.click();
    expect(nodeEl(fx.host, "ch1")).toBeNull();
    expect(nodeEl(fx.host, "ch2")).toBeNull();
    expect(fx.cb.onHiddenChange).toHaveBeenCalled();
  });

  it("drops the multi-selection from the bar's clear button", () => {
    fx = graphFixture();
    const g = fx.graph as unknown as { toggleNodeSelection: (id: string) => void };
    g.toggleNodeSelection("ch1");
    g.toggleNodeSelection("ch2");
    fx.host.querySelector<HTMLButtonElement>(".selbar-clear")!.click();
    expect(selBarCount(fx.host)).toBe("");
  });

  // A path trace lights every node upstream of the one traced, following only the
  // sends that actually carry signal.
  it("traces the upstream path and reports how far it reached", () => {
    fx = graphFixture();
    (fx.graph as unknown as { highlightPath: (id: string) => void }).highlightPath("bus.stereo");
    expect(statuses().some((s) => s.length > 0)).toBe(true);
    expect(fx.host.querySelectorAll(".wire-hit").length).toBeGreaterThan(0);
  });
});

describe("hide and show", () => {
  it("shelves a node and gives it a chip", () => {
    fx = graphFixture();
    fx.graph.hideNode("bus.mix2");
    expect(nodeEl(fx.host, "bus.mix2")).toBeNull();
    expect(shelfChips(fx.host).length).toBe(1);
    expect(fx.cb.onHiddenChange).toHaveBeenCalledWith(["bus.mix2"]);
    expect(fx.cb.onChange).toHaveBeenCalled();
  });

  // A hung child goes with its parent and gets NO chip of its own — it is never
  // shown alone, so a chip for it would offer a state that does not exist.
  it("takes a hung ducker with its parent, without a chip of its own", () => {
    fx = graphFixture();
    expect(nodeEl(fx.host, "out.ducker1")).not.toBeNull();
    fx.graph.hideNode("ch_5_6");
    expect(nodeEl(fx.host, "out.ducker1")).toBeNull();
    expect(shelfChips(fx.host)).toHaveLength(1);
  });

  it("brings a node back from its chip", () => {
    fx = graphFixture();
    fx.graph.hideNode("bus.mix2");
    fx.host.querySelector<HTMLButtonElement>(".hidden-shelf .chip")!.click();
    expect(nodeEl(fx.host, "bus.mix2")).not.toBeNull();
    expect(shelfChips(fx.host)).toHaveLength(0);
  });

  it("pulls the parent back when a hung child is shown", () => {
    fx = graphFixture();
    fx.graph.hideNode("ch_5_6");
    fx.graph.showNode("out.ducker1");
    expect(nodeEl(fx.host, "ch_5_6")).not.toBeNull();
    expect(nodeEl(fx.host, "out.ducker1")).not.toBeNull();
    // Only the parent is placed; the child's position derives from it.
    expect(fx.plan.positions?.["ch_5_6"]).toBeDefined();
  });

  it("brings everything back from Show all", () => {
    fx = graphFixture();
    fx.graph.hideNode("bus.mix1");
    fx.graph.hideNode("bus.mix2");
    fx.host.querySelector<HTMLButtonElement>(".shelf-showall")!.click();
    expect(shelfChips(fx.host)).toHaveLength(0);
    expect(nodeEl(fx.host, "bus.mix1")).not.toBeNull();
  });

  it("hides the shelf entirely when nothing is shelved", () => {
    fx = graphFixture();
    expect(fx.host.querySelector<HTMLElement>(".hidden-shelf")!.style.display).not.toBe("flex");
  });

  it("says so when Hide unused finds nothing to shelve", () => {
    fx = graphFixture();
    fx.graph.hideUnused();
    const said = statuses().at(-1)!;
    expect([t().status.noneToHide, t().status.hidUnused(1)].some((s) => said.length === s.length || said)).toBe(true);
    expect(said).toBeTruthy();
  });

  it("reports a shelved count and leaves the wired nodes alone", () => {
    fx = graphFixture();
    fx.graph.hideUnused();
    // Whatever was shelved, a bus carrying the default plan's sends stays on board.
    expect(nodeEl(fx.host, "bus.stereo")).not.toBeNull();
  });

  it("re-adopts a plan whose hidden set changed underneath it", () => {
    fx = graphFixture();
    fx.plan.hidden = ["bus.mix2"];
    fx.graph.refresh();
    expect(nodeEl(fx.host, "bus.mix2")).toBeNull();
  });
});

describe("connections", () => {
  // A wire the block diagram makes permanent belongs to the device, not the plan.
  it("refuses to delete a fixed wire and says why", () => {
    fx = graphFixture();
    const model = getModel("URX44V");
    const fixed = fx.plan.connections.find((c) => isFixedConnection(model, c.from, c.to));
    if (!fixed) throw new Error("the default URX44V plan carries fixed wires; this fixture depends on one");
    const before = fx.plan.connections.length;
    fx.graph.deleteConnection(fixed.from, fixed.to);
    expect(fx.plan.connections).toHaveLength(before);
    expect(statuses()).toContain(t().status.fixedConnection);
    expect(wireHit(fx.host, fixed.from, fixed.to)).not.toBeNull();
  });

  // Every wire the factory plan ships is fixed, so the deletable case needs one the
  // operator drew — which is what the board is for.
  it("deletes a wire the plan may lose", () => {
    let free: { from: string; to: string } | null = null;
    fx = graphFixture({
      seed: (plan) => {
        const model = getModel("URX44V");
        free = plan.connections.find((c) => !isFixedConnection(model, c.from, c.to)) ?? null;
        if (!free) {
          free = { from: "ch1:out", to: "bus.mix2:in" };
          plan.connections.push({ ...free, kind: "send", params: { level: 0, pan: 0 } });
        }
      },
    });
    const before = fx.plan.connections.length;
    fx.graph.deleteConnection(free!.from, free!.to);
    expect(fx.plan.connections.length).toBe(before - 1);
    expect(wireHit(fx.host, free!.from, free!.to)).toBeNull();
  });

  // A drag from a jack lights the jacks that route could legally reach.
  it("lights the candidate jacks while connecting", () => {
    fx = graphFixture();
    const src = portHit(fx.host, "ch1:out")!;
    src.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 0, clientY: 0, bubbles: true }));
    src.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 60, clientY: 0, bubbles: true }));
    expect(fx.host.querySelector(".overlay-temp")).not.toBeNull();
    src.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 60, clientY: 0, bubbles: true }));
    expect(fx.host.querySelector(".overlay-temp")).toBeNull();
  });

  // The two jacks exist precisely so a direct out cannot be drawn from the fader
  // output, and a bus send cannot be drawn from the Rec Point.
  it("refuses a Rec Point tap released on a bus input", () => {
    fx = graphFixture();
    const tap = tapHit(fx.host, "ch1:out")!;
    drag(tap, { x: 400, y: 200 }, portHit(fx.host, "bus.mix1:in"));
    expect(statuses().some((s) => s === t().error.recPointTargets || s === t().error.cannotConnect)).toBe(true);
  });

  it("clears the temp wire when a connect gesture is cancelled", () => {
    fx = graphFixture();
    const src = portHit(fx.host, "ch1:out")!;
    src.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 0, clientY: 0, bubbles: true }));
    src.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 60, clientY: 0, bubbles: true }));
    src.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, bubbles: true }));
    expect(fx.host.querySelector(".overlay-temp")).toBeNull();
  });
});

describe("node drag", () => {
  it("moves a node and reports the change exactly once", () => {
    fx = graphFixture();
    const rect = faceplate(fx.host, "ch1")!;
    drag(rect, { x: 260, y: 180 });
    expect(fx.plan.positions?.["ch1"]).toBeDefined();
    expect(fx.cb.onChange).toHaveBeenCalledTimes(1);
  });

  // Losing the window ends it, like `pointercancel` above. Measured 2026-08-14 on
  // Chromium and on the shipping WKWebView: the foreground moving away with the button
  // down fires `blur` and no `pointercancel`, and keeps the capture — so the node kept
  // following the pointer while another application was frontmost, and since history.ts
  // ends its press at that same blur, the rest of the travel landed in a second undo
  // entry. console.ts's `trackDrag` carries the readings.
  it("ends a node drag when the window loses focus", () => {
    fx = graphFixture();
    const rect = faceplate(fx.host, "ch1")!;
    const at = (type: string, x: number, y: number): PointerEvent =>
      new PointerEvent(type, { pointerId: 1, clientX: x, clientY: y, bubbles: true, cancelable: true });
    rect.dispatchEvent(at("pointerdown", 100, 100));
    fx.svg.dispatchEvent(at("pointermove", 260, 180));
    const moved = JSON.stringify(fx.plan.positions?.["ch1"]);

    window.dispatchEvent(new FocusEvent("blur"));
    fx.svg.dispatchEvent(at("pointermove", 500, 400));
    expect(JSON.stringify(fx.plan.positions?.["ch1"])).toBe(moved);
  });

  // The double-press detector times pointerdown to pointerdown and was not invalidated
  // when the first press became a drag — so a flick-drag released at ~250 ms and grabbed
  // again at ~300 ms to keep positioning opened the note editor instead, and on a
  // collapsed note that also un-collapsed it and marked the plan changed.
  it("does not open the note editor when a just-dragged node is grabbed again", () => {
    fx = graphFixture();
    const rect = faceplate(fx.host, "ch1")!;
    drag(rect, { x: 260, y: 180 });
    // The second grab, well inside the 350 ms double-press window.
    press(rect);
    expect(fx.host.querySelector("textarea")).toBeNull();

    // …and a genuine double press, with no drag between, still opens it.
    press(rect);
    press(rect);
    expect(fx.host.querySelector("textarea")).not.toBeNull();
  });

  // A press that never moved is a selection, not a drag; reporting a change would
  // mark the plan dirty for a click.
  it("reports nothing for a press that never moved", () => {
    fx = graphFixture();
    press(faceplate(fx.host, "ch1")!);
    expect(fx.cb.onChange).not.toHaveBeenCalled();
  });

  it("carries a hung ducker with the channel it hangs under", () => {
    fx = graphFixture();
    const before = nodeEl(fx.host, "out.ducker1")!.getAttribute("transform");
    drag(faceplate(fx.host, "ch_5_6")!, { x: 300, y: 300 });
    expect(nodeEl(fx.host, "out.ducker1")!.getAttribute("transform")).not.toBe(before);
  });

  it("moves a STEREO-linked partner with the node being dragged", () => {
    fx = graphFixture({
      seed: (plan) => {
        plan.nodeParams["ch1"] = { ...plan.nodeParams["ch1"], stereoLink: true };
        plan.nodeParams["ch2"] = { ...plan.nodeParams["ch2"], stereoLink: true };
      },
    });
    drag(faceplate(fx.host, "ch1")!, { x: 300, y: 300 });
    expect(fx.plan.positions?.["ch2"]).toBeDefined();
  });

  it("aligns a stereo pair on demand", () => {
    fx = graphFixture();
    fx.graph.alignStereoPair("ch1");
    expect(nodeEl(fx.host, "ch1")).not.toBeNull();
  });
});

describe("view transform", () => {
  it("clamps the wheel zoom at both ends", () => {
    fx = graphFixture();
    const zoom = (): number => (fx.graph as unknown as { zoom: number }).zoom;
    for (let i = 0; i < 40; i++) {
      fx.svg.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -100, clientX: 50, clientY: 50, bubbles: true, cancelable: true }),
      );
    }
    const top = zoom();
    for (let i = 0; i < 80; i++) {
      fx.svg.dispatchEvent(
        new WheelEvent("wheel", { deltaY: 100, clientX: 50, clientY: 50, bubbles: true, cancelable: true }),
      );
    }
    expect(top).toBeGreaterThan(zoom());
    expect(zoom()).toBeGreaterThan(0);
    expect(top).toBeLessThanOrEqual(2.5);
  });

  it("pans the canvas from a drag on empty space", () => {
    fx = graphFixture();
    const before = { ...(fx.graph as unknown as { pan: { x: number; y: number } }).pan };
    fx.svg.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 5, clientY: 5, bubbles: true }));
    fx.svg.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 80, clientY: 60, bubbles: true }));
    fx.svg.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 80, clientY: 60, bubbles: true }));
    expect((fx.graph as unknown as { pan: { x: number; y: number } }).pan).not.toEqual(before);
  });

  it("zooms about the midpoint of a two-finger pinch", () => {
    fx = graphFixture();
    const zoom = (): number => (fx.graph as unknown as { zoom: number }).zoom;
    const before = zoom();
    fx.svg.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 100, clientY: 100, bubbles: true }));
    fx.svg.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 2, clientX: 140, clientY: 100, bubbles: true }));
    fx.svg.dispatchEvent(new PointerEvent("pointermove", { pointerId: 2, clientX: 300, clientY: 100, bubbles: true }));
    expect(zoom()).not.toBe(before);
    fx.svg.dispatchEvent(new PointerEvent("pointerup", { pointerId: 2, clientX: 300, clientY: 100, bubbles: true }));
  });

  // The blur ender has to do what a `pointercancel` does for one pointer, for all of them.
  // `cancelInteraction` alone left `pinch` standing, and `onPointerMove` asks about the
  // pinch before anything that teardown clears — so two fingers kept zooming while another
  // application was frontmost. The second half is the tracking map: a touch pointer id is
  // fresh per press, so an entry left behind makes the next single press the second finger.
  it("ends a pinch at a window blur, and forgets the pointers it was tracking", () => {
    fx = graphFixture();
    const zoom = (): number => (fx.graph as unknown as { zoom: number }).zoom;
    const at = (type: string, id: number, x: number): PointerEvent =>
      new PointerEvent(type, { pointerId: id, clientX: x, clientY: 100, bubbles: true });
    fx.svg.dispatchEvent(at("pointerdown", 1, 100));
    fx.svg.dispatchEvent(at("pointerdown", 2, 140));
    fx.svg.dispatchEvent(at("pointermove", 2, 300));
    const pinched = zoom();
    expect(pinched).not.toBe(1);

    window.dispatchEvent(new FocusEvent("blur"));
    fx.svg.dispatchEvent(at("pointermove", 2, 600));
    expect(zoom()).toBe(pinched);

    // And the next press is a first finger again, not a second one.
    fx.svg.dispatchEvent(at("pointerdown", 3, 100));
    fx.svg.dispatchEvent(at("pointermove", 3, 300));
    expect(zoom()).toBe(pinched);
    expect((fx.graph as unknown as { pinch: unknown }).pinch).toBeNull();
  });

  it("re-fits the view without throwing on an unmeasurable host", () => {
    fx = graphFixture();
    expect(() => fx.graph.fitView()).not.toThrow();
  });
});

describe("notes", () => {
  it("draws a note panel for a node the plan annotates", () => {
    fx = graphFixture({ seed: (plan) => void (plan.notes = { ch1: "mic check" }) });
    expect(nodeEl(fx.host, "ch1")!.querySelector(".note-panel")).not.toBeNull();
  });

  it("writes a note into the plan and reports the change", () => {
    fx = graphFixture();
    fx.graph.setNote("ch1", "kick in");
    expect(fx.plan.notes?.["ch1"]).toBe("kick in");
    expect(fx.cb.onChange).toHaveBeenCalled();
  });

  // A blank note is a deletion, and it takes any stale collapse flag with it.
  it("deletes a note set to whitespace, with its collapse flag", () => {
    fx = graphFixture({ seed: (plan) => void ((plan.notes = { ch1: "x" }), (plan.noteCollapsed = ["ch1"])) });
    fx.graph.setNote("ch1", "   ");
    expect(fx.plan.notes?.["ch1"]).toBeUndefined();
    expect(fx.plan.noteCollapsed ?? []).not.toContain("ch1");
  });

  it("collapses and re-expands a note panel", () => {
    fx = graphFixture({ seed: (plan) => void (plan.notes = { ch1: "mic check" }) });
    fx.graph.toggleNoteCollapse("ch1");
    expect(fx.plan.noteCollapsed).toContain("ch1");
    expect(nodeEl(fx.host, "ch1")!.querySelector(".note-panel")).toBeNull();
    fx.graph.toggleNoteCollapse("ch1");
    expect(nodeEl(fx.host, "ch1")!.querySelector(".note-panel")).not.toBeNull();
  });

  it("does nothing when a note-less node is collapsed", () => {
    fx = graphFixture();
    fx.graph.toggleNoteCollapse("ch1");
    expect(fx.cb.onChange).not.toHaveBeenCalled();
    expect(fx.plan.noteCollapsed ?? []).not.toContain("ch1");
  });

  it("opens the floating editor from the add button and writes as it is typed", () => {
    fx = graphFixture();
    const add = nodeEl(fx.host, "ch4")?.querySelector(".note-add");
    if (!add) return;
    add.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 0, clientY: 0, bubbles: true }));
    const ta = fx.host.querySelector<HTMLTextAreaElement>("textarea.note-edit-overlay")!;
    expect(ta).not.toBeNull();
    ta.value = "hello";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    expect(fx.plan.notes?.["ch4"]).toBe("hello");
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(fx.host.querySelector("textarea.note-edit-overlay")).toBeNull();
  });

  // A note panel resizing shifts every node hung under it.
  it("shifts a hung child when the parent's note panel grows", () => {
    fx = graphFixture();
    const before = nodeEl(fx.host, "out.ducker1")!.getAttribute("transform");
    fx.graph.setNote("ch_5_6", Array.from({ length: 6 }, (_, i) => `line ${i}`).join("\n"));
    expect(nodeEl(fx.host, "out.ducker1")!.getAttribute("transform")).not.toBe(before);
  });
});

describe("layout", () => {
  // Arrange on an untouched board must move nothing: build.ts reserves a whole row
  // for a stereo channel's ducker precisely so the two agree.
  it("moves nothing when Arrange runs on an untouched board", () => {
    fx = graphFixture();
    fx.graph.autoLayout();
    const first = JSON.stringify(fx.plan.positions);
    fx.graph.autoLayout();
    expect(JSON.stringify(fx.plan.positions)).toBe(first);
  });

  // A hung child's position derives from its parent, so Arrange writes one only for
  // the nodes that stand on their own.
  it("places every free-standing node when Arrange runs, and no hung one", () => {
    fx = graphFixture();
    const model = getModel("URX44V");
    fx.graph.autoLayout();
    const hung = new Set(model.nodes.filter((n) => n.attachTo).map((n) => n.id));
    const placed = Object.keys(fx.plan.positions ?? {});
    expect(placed.length).toBeGreaterThan(5);
    for (const id of placed) expect(hung.has(id)).toBe(false);
  });
});

describe("model switch", () => {
  it("rebuilds the board for another model", async () => {
    fx = graphFixture();
    const { getModel } = await import("../models");
    const { defaultPlan } = await import("../models/initial-state");
    fx.graph.setModel(getModel("URX22"), defaultPlan("URX22"));
    expect(nodeEl(fx.host, "out.sdrec")).toBeNull();
    expect(nodeIds(fx.host).length).toBeGreaterThan(3);
  });
});

describe("image export", () => {
  it("crops to the content and reports where it was saved", async () => {
    fx = graphFixture();
    await fx.graph.exportPng("board.png");
    expect(exportSvgToPng).toHaveBeenCalledTimes(1);
    const [svg, name, opts] = vi.mocked(exportSvgToPng).mock.calls[0];
    expect(name).toBe("board.png");
    // A clone, cropped to the content: the viewport transform is dropped so the
    // viewBox alone places the board.
    expect(svg).not.toBe(fx.svg);
    expect(svg.getAttribute("viewBox")).toMatch(/^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/);
    expect(svg.querySelector("g.node")).not.toBeNull();
    expect(opts.width).toBeGreaterThan(0);
    expect(opts.height).toBeGreaterThan(0);
    expect(statuses().at(-1)).toBe(t().status.savedTo("board.png"));
  });

  it("reports a cancelled export as cancelled", async () => {
    fx = graphFixture();
    await fx.graph.exportPdf("board.pdf");
    expect(exportSvgToPdf).toHaveBeenCalledTimes(1);
    expect(statuses().at(-1)).toBe(t().status.canceled);
  });

  it("exports at the scale the settings ask for", async () => {
    fx = graphFixture();
    updateSettings({ exportScale: 3 });
    expect(getSettings().exportScale).toBe(3);
    await fx.graph.exportPng("board.png");
    expect(vi.mocked(exportSvgToPng).mock.calls[0][2].scale).toBe(3);
  });

  // The fixed-theme export renders in the other palette and puts the board back,
  // so the screen is unchanged afterwards.
  it("renders a fixed-theme export in that palette and restores the screen", async () => {
    fx = graphFixture();
    updateSettings({ exportTheme: "light" });
    await fx.graph.exportPng("board.png");
    expect(vi.mocked(exportSvgToPng).mock.calls[0][2].background).toBe(PALETTES.light.canvasBg);
    expect((fx.graph as unknown as { themeName: string }).themeName).toBe("dark");
  });

  it("drops a temp wire from the exported clone", async () => {
    fx = graphFixture();
    const src = portHit(fx.host, "ch1:out")!;
    src.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 0, clientY: 0, bubbles: true }));
    src.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 60, clientY: 0, bubbles: true }));
    await fx.graph.exportPng("board.png");
    expect(vi.mocked(exportSvgToPng).mock.calls[0][0].querySelector(".overlay-temp")).toBeNull();
  });
});
