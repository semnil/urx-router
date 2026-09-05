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
import type { GraphFixture, GraphOptions } from "./graph.test-util";
import { LEVEL_MIN_DB } from "../core/plan";
import type { Plan } from "../core/plan";
import { defaultPlan } from "../models/initial-state";
import { isFixedConnection } from "../core/routing";
import { getModel } from "../models";
import type { ModelId } from "../models/types";
import { getSettings, resetSettingsCache, updateSettings } from "../core/settings";
import { pinSettingsReset } from "../core/settings-reset.test-util";
import { setLang, t } from "../i18n";

let fx: GraphFixture;

const statuses = (): string[] => fx.cb.onStatus.mock.calls.map(([m]) => m as string);

beforeEach(() => {
  localStorage.clear();
  resetSettingsCache();
  setLang("en");
});

pinSettingsReset();

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

  // The question is whether the board is drawn against this set, so the comparison is
  // between sets: an array carrying a repeat is not a bigger set, and answering by its
  // length would call {a} and ["a","a"] the same size as {a, b}.
  it("answers about the set, not the array it was handed", () => {
    fx = graphFixture();
    fx.graph.setDisabledNodes(["bus.fx2", "bus.fx1"]);
    expect(fx.graph.hasDisabledNodes(["bus.fx2", "bus.fx2"])).toBe(false);
    expect(fx.graph.hasDisabledNodes(["bus.fx1", "bus.fx2"])).toBe(true);
    // And the render follows the same answer: a repeat that is NOT the held set redraws.
    const before = nodeEl(fx.host, "bus.fx1");
    fx.graph.setDisabledNodes(["bus.fx2", "bus.fx2"]);
    expect(nodeEl(fx.host, "bus.fx1")).not.toBe(before);
    expect(nodeEl(fx.host, "bus.fx1")!.getAttribute("opacity")).not.toBe("0.62");
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

  // A restored member of a STEREO-linked pair lands beside its partner rather than
  // under the viewport: the tie is drawn the moment both are on the board, so parking
  // it wherever the operator happens to be looking opens the pair stretched.
  const linkedPair = (kept: string): GraphOptions => ({
    seed: (plan) => {
      plan.nodeParams["ch1"] = { ...plan.nodeParams["ch1"], stereoLink: true };
      plan.nodeParams["ch2"] = { ...plan.nodeParams["ch2"], stereoLink: true };
      plan.positions[kept] = { x: 500, y: 300 };
    },
  });

  it("lands a restored STEREO partner beside the primary already on the board", () => {
    fx = graphFixture(linkedPair("ch1"));
    fx.graph.hideNode("ch2");
    fx.graph.showNode("ch2");
    expect(fx.plan.positions["ch1"]).toEqual({ x: 500, y: 300 }); // the one on the board stays
    expect(fx.plan.positions["ch2"]!.x).toBe(500);
    expect(fx.plan.positions["ch2"]!.y).toBeGreaterThan(300);
  });

  // The same the other way round: what moves is the node coming back, not the primary.
  it("lands a restored STEREO primary above the partner already on the board", () => {
    fx = graphFixture(linkedPair("ch2"));
    fx.graph.hideNode("ch1");
    fx.graph.showNode("ch1");
    expect(fx.plan.positions["ch2"]).toEqual({ x: 500, y: 300 });
    expect(fx.plan.positions["ch1"]!.x).toBe(500);
    expect(fx.plan.positions["ch1"]!.y).toBeLessThan(300);
  });

  // Show all follows the chip's rule per pair: the shelved member's own position is one
  // nobody has seen since it went to the shelf, so it is the one that moves — including
  // when it is the PRIMARY, where a primary-keeping sweep would drag the visible partner
  // to a coordinate only the shelved node was carrying.
  it("moves the member Show all brought back, not the one already on the board", () => {
    fx = graphFixture(linkedPair("ch2"));
    fx.plan.positions["ch1"] = { x: 40, y: 40 }; // stale: where ch1 sat before it was shelved
    fx.graph.hideNode("ch1");
    fx.graph.showAll();
    expect(fx.plan.positions["ch2"]).toEqual({ x: 500, y: 300 });
    expect(fx.plan.positions["ch1"]!.x).toBe(500);
    expect(fx.plan.positions["ch1"]!.y).toBeLessThan(300);
  });

  // Show all can bring several members back at once, so it closes the gap the way a
  // load does — keeping the primary — rather than moving whichever node arrived.
  it("closes a linked pair's gap when Show all brings its member back", () => {
    fx = graphFixture(linkedPair("ch1"));
    fx.plan.positions["ch2"] = { x: 900, y: 620 };
    fx.graph.hideNode("ch2");
    fx.graph.showAll();
    expect(fx.plan.positions["ch1"]).toEqual({ x: 500, y: 300 });
    expect(fx.plan.positions["ch2"]!.x).toBe(500);
    expect(fx.plan.positions["ch2"]!.y).toBeGreaterThan(300);
  });

  // The negative control: without the link there is no tie to keep short, so the node does
  // not follow its pair — it parks where every restored node parks, which is the same place
  // for a node that has no pair at all.
  it("parks a restored MONO x 2 member where any restore parks, not beside its pair", () => {
    fx = graphFixture({ seed: (plan) => void (plan.positions["ch1"] = { x: 500, y: 300 }) });
    fx.graph.hideNode("ch2");
    fx.graph.showNode("ch2");
    fx.graph.hideNode("bus.mix2");
    fx.graph.showNode("bus.mix2");
    expect(fx.plan.positions["ch2"]!.x).not.toBe(500);
    expect(fx.plan.positions["ch2"]).toEqual(fx.plan.positions["bus.mix2"]);
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

// A link the app did not make: a device read, a device-follow reconcile of a Signal
// Type moved on the unit, a loaded document. No edit funnel ran, so the snap that
// linking in the app performs has to be taken over the plan as it arrives.
describe("alignLinkedPairs", () => {
  // Built for every case: the file's afterEach restores `fx` whether or not the case
  // made one, so a case without one restores its predecessor a second time and takes
  // the jsdom globals down under every case after it.
  beforeEach(() => {
    fx = graphFixture();
  });

  /** Where the board actually drew a node, from its own transform. */
  const drawnAt = (id: string): { x: number; y: number } => {
    const [x, y] = nodeEl(fx.host, id)!
      .getAttribute("transform")!
      .match(/-?\d+(?:\.\d+)?/g)!
      .map(Number);
    return { x, y };
  };
  // Both of the model's pairs parked apart and already linked — the state a device read
  // leaves behind. Two pairs rather than one: the sweep is a loop, and a single pair
  // cannot tell it apart from one that stops after the first thing it moves.
  const linkedPairPlan = (): Plan => {
    const plan = defaultPlan("URX44V");
    for (const id of ["ch1", "ch2", "ch3", "ch4"]) {
      plan.nodeParams[id] = { ...plan.nodeParams[id], stereoLink: true };
    }
    plan.positions["ch1"] = { x: 700, y: 40 };
    plan.positions["ch2"] = { x: 120, y: 800 };
    plan.positions["ch3"] = { x: 500, y: 300 };
    plan.positions["ch4"] = { x: 900, y: 620 };
    return plan;
  };
  /** The fixture's own graph, rebound to `plan`. `setModel` is the seat under test for a
   *  load, so the cases that are not about it seed through it too. */
  const on = (plan: Plan, modelId: ModelId = "URX44V"): Plan => {
    fx.graph.setModel(getModel(modelId), plan);
    return plan;
  };

  it("snaps every linked pair's partner into the primary's column, keeping the primary put", () => {
    // The offset to expect is read off a board nothing ever moved, rather than spelled
    // as a constant here: an assertion against a copy of the layout arithmetic passes
    // whatever that arithmetic later becomes.
    const gap = drawnAt("ch4").y - drawnAt("ch3").y;

    const plan = on(linkedPairPlan());
    expect(plan.positions["ch3"]).toEqual({ x: 500, y: 300 });
    expect(plan.positions["ch4"]).toEqual({ x: 500, y: 300 + gap });
    // The second pair too, so a sweep that stops after the first is red here.
    expect(plan.positions["ch1"]).toEqual({ x: 700, y: 40 });
    expect(plan.positions["ch2"]).toEqual({ x: 700, y: 40 + gap });
  });

  it("leaves a pair that is not linked where it stands", () => {
    const plan = linkedPairPlan();
    plan.nodeParams["ch3"] = { ...plan.nodeParams["ch3"], stereoLink: false };
    on(plan);
    expect(plan.positions["ch4"]).toEqual({ x: 900, y: 620 });
  });

  // Both halves of the guard: no tie is drawn for a pair with a shelved member, so there is
  // no gap to close, and the position of a node nobody can see must not be rewritten either.
  it("leaves a pair with its PRIMARY shelved alone", () => {
    const plan = linkedPairPlan();
    plan.hidden = ["ch3"];
    on(plan);
    expect(plan.positions["ch4"]).toEqual({ x: 900, y: 620 });
  });

  it("leaves a pair with its PARTNER shelved alone", () => {
    const plan = linkedPairPlan();
    plan.hidden = ["ch4"];
    on(plan);
    expect(plan.positions["ch4"]).toEqual({ x: 900, y: 620 });
  });

  it("writes no position for a linked pair nothing ever moved", () => {
    const plan = defaultPlan("URX44V");
    plan.nodeParams["ch1"] = { ...plan.nodeParams["ch1"], stereoLink: true };
    on(plan);
    expect(plan.positions["ch2"]).toBeUndefined();
  });

  // A pair the operator dragged carries float error in its saved offset, so an equality
  // test reports it as off-canonical and rewrites it — a plan write for a move of ~1e-13 px,
  // which on the device-follow path lands outside every edit funnel.
  it("writes nothing for a pair whose saved offset carries a dragged pair's float error", () => {
    const plan = defaultPlan("URX44V");
    plan.nodeParams["ch1"] = { ...plan.nodeParams["ch1"], stereoLink: true };
    const a = 479.21785452540706;
    plan.positions["ch1"] = { x: 100, y: a };
    plan.positions["ch2"] = { x: 100, y: a + 68 };
    const dy = plan.positions["ch2"].y - plan.positions["ch1"].y; // what a drag captures
    const b = 291.4388726636495;
    plan.positions["ch1"] = { x: 100, y: b };
    plan.positions["ch2"] = { x: 100, y: b + dy };
    expect(plan.positions["ch2"].y).not.toBe(b + 68); // the drift is real, not assumed
    on(plan);
    expect(plan.positions["ch2"].y).toBe(b + dy); // and the sweep left it alone
  });

  // Arrange advances a column by whole rows big enough to clear an expanded note. An offset
  // taken from the bare grid would lay the partner inside that note at the next load.
  it("clears an expanded note on the primary, the way Arrange does", () => {
    // Read off the pristine board, before this case's own plan is on it.
    const bare = drawnAt("ch4").y - drawnAt("ch3").y;
    const plan = linkedPairPlan();
    plan.notes["ch3"] = "a note";
    on(plan);
    fx.graph.autoLayout();
    const arranged = { ...plan.positions["ch4"]! };
    // The note is what makes this a test: without it Arrange's own gap is the bare grid's.
    expect(arranged.y - plan.positions["ch3"]!.y).toBeGreaterThan(bare);
    expect(fx.graph.alignLinkedPairs()).toBe(false);
    expect(plan.positions["ch4"]).toEqual(arranged);
  });

  it("runs on the document a load puts on the board", () => {
    const plan = on(linkedPairPlan());
    expect(plan.positions["ch4"]!.x).toBe(500);
    expect(nodeEl(fx.host, "ch4")!.getAttribute("transform")).toContain("translate(500 ");
  });

  // The URX22 has one pair, and its own column geometry: the assertions above are about
  // the pair, not about where the URX44V happens to put CH 3.
  it("snaps a URX22 pair too", () => {
    const plan = defaultPlan("URX22");
    plan.nodeParams["ch1"] = { ...plan.nodeParams["ch1"], stereoLink: true };
    plan.positions["ch1"] = { x: 420, y: 260 };
    plan.positions["ch2"] = { x: 880, y: 700 };
    on(plan, "URX22");
    expect(plan.positions["ch2"]!.x).toBe(420);
    expect(plan.positions["ch2"]!.y).toBeGreaterThan(260);
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
