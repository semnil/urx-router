// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { inspectorNodes } from "./inspector";

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
