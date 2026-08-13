// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compositionGate, inspectorNodes, renderInspector } from "./inspector";
import type { InspectorActions } from "./inspector";
import { resetSectionCache } from "./inspector-sections";
import type { Selection } from "./graph";
import { getModel, MODEL_IDS } from "../models";
import { defaultPlan } from "../models/initial-state";
import { emptyPlan } from "../core/plan";
import type { Plan } from "../core/plan";
import { resetSettingsCache } from "../core/settings";
import { insertFxMenu } from "../core/constraints";
import { insertFxControl } from "../core/control/translate";
import { COMP_EQ_SSMCS, INSERT_FX_NONE } from "../core/control/params";
import { setLang, t } from "../i18n";

// The panel renders one selection, and which controls it renders is derived from that
// selection's endpoint NODES — not only from the selected object. A device-side change
// on a node the panel is not "showing" can still remove a control it is rendering (a
// bus's Pan Link removes the send PAN on every wire into it), so the caller that
// decides whether to repaint has to know the footprint. These pin it.

describe("inspectorNodes", () => {
  const u44v = getModel("URX44V");

  it("reports nothing for an empty selection", () => {
    expect(inspectorNodes(u44v, emptyPlan("URX44V"), null)).toEqual([]);
  });

  it("reports the node itself for a node selection", () => {
    expect(inspectorNodes(u44v, emptyPlan("URX44V"), { type: "node", id: "ch1" })).toEqual(["ch1"]);
  });

  // An analog output's MONO row reads a MONITOR bus's switch, so the footprint has to
  // carry a node the panel is not "showing". Without it a MIDI-driven MONO change
  // reaches the plan and the device while the row keeps reporting the old state.
  it("reports the monitor an analog output is patched from, and only that one", () => {
    const patched = (from: string, to: string): Plan => {
      const plan = emptyPlan("URX44V");
      plan.connections.push({ from: `${from}:out`, to: `${to}:in`, kind: "patch" });
      return plan;
    };
    expect(inspectorNodes(u44v, patched("bus.mon1", "out.main"), nodeSel("out.main"))).toEqual([
      "out.main",
      "bus.mon1",
    ]);
    // NOT both monitors. bus.mon1/2 carry three directly-following params, so naming a
    // monitor this output does not read would rebuild the panel at the follow rate on
    // a knob turn that changes nothing it shows.
    expect(inspectorNodes(u44v, patched("bus.mon2", "out.main"), nodeSel("out.main"))).toEqual([
      "out.main",
      "bus.mon2",
    ]);
    // And none at all when the patch carries no MONO switch, or there is no patch.
    expect(inspectorNodes(u44v, patched("bus.stereo", "out.main"), nodeSel("out.main"))).toEqual(["out.main"]);
    expect(inspectorNodes(u44v, emptyPlan("URX44V"), nodeSel("out.main"))).toEqual(["out.main"]);
    // Not every output: a USB output has no MONO row, so it has nothing extra to watch.
    expect(inspectorNodes(u44v, patched("bus.stereo", "out.usbmain_a"), nodeSel("out.usbmain_a"))).toEqual([
      "out.usbmain_a",
    ]);
  });

  it("reports BOTH endpoints for a wire — the destination is why this exists", () => {
    // The destination bus's BUS Type / Pan Link decide which of the send controls the
    // panel draws at all; the source channel's Signal Type decides the pan's label.
    expect(inspectorNodes(u44v, emptyPlan("URX44V"), { type: "conn", from: "ch1:out", to: "bus.mix1:in" })).toEqual([
      "ch1",
      "bus.mix1",
    ]);
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

// The panel itself. It needs no module mocks: platform resolves its IPC lazily per
// call, storage is localStorage inside try/catch, and there is no canvas, observer
// or timer anywhere in the file.

const nodeSel = (id: string): Selection => ({ type: "node", id });
const connSel = (from: string, to: string): Selection => ({ type: "conn", from, to });

const actions = (): InspectorActions => ({
  onDeleteConnection: vi.fn(),
  onUpdateParams: vi.fn(),
  onUpdateNodeParams: vi.fn(),
  onRenameNode: vi.fn(),
  onRecolorNode: vi.fn(),
  onOpenRecent: vi.fn(),
  onHideNode: vi.fn(),
  onOpenDynScreen: vi.fn(),
  onClose: vi.fn(),
});

let panel: HTMLElement;
let act: InspectorActions;

/** The row order the panel put on screen — the highest-value assertion here, since
 *  every device screen's order is a claim the source comments make in prose. */
const rowLabels = (host: HTMLElement = panel): string[] =>
  [...host.querySelectorAll<HTMLElement>(".param")].map((r) => r.dataset.paramLabel ?? "");

const sectionByTitle = (title: string): HTMLDetailsElement | undefined =>
  [...panel.querySelectorAll<HTMLDetailsElement>("details.insp-section")].find(
    (d) => d.querySelector(".sec-title")?.textContent === title,
  );

/** Drive every control the panel rendered. One coverage pass, deliberately broad:
 *  the claims worth stating live in the named tests below it. */
function driveEverything(host: HTMLElement): void {
  for (const b of host.querySelectorAll("button")) b.click();
  for (const i of host.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
    for (const v of [i.max, i.min]) {
      i.value = v;
      i.dispatchEvent(new Event("input", { bubbles: true }));
    }
    i.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true, cancelable: true }));
  }
  for (const i of host.querySelectorAll<HTMLInputElement>('input[type="text"]')) {
    i.value = "renamed";
    i.dispatchEvent(new Event("input", { bubbles: true }));
  }
  for (const s of host.querySelectorAll("select")) {
    for (const o of [...s.options]) {
      s.value = o.value;
      s.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  for (const d of host.querySelectorAll<HTMLDetailsElement>("details.insp-section")) {
    d.open = !d.open;
    d.dispatchEvent(new Event("toggle"));
  }
}

beforeEach(() => {
  localStorage.clear();
  resetSettingsCache();
  resetSectionCache();
  setLang("en");
  panel = document.createElement("div");
  document.body.replaceChildren(panel);
  act = actions();
});

describe("renderInspector — empty selection", () => {
  it("prints the hint and the wire legend instead of rows", () => {
    renderInspector(panel, getModel("URX44V"), defaultPlan("URX44V"), null, act);
    expect(panel.textContent).toContain(t().inspector.hint);
    expect(rowLabels()).toEqual([]);
  });

  it("lists recent plans and opens the one that was clicked", () => {
    const recent = [
      { path: "/a/one.json", name: "one", modelId: "URX44V" as const },
      { path: "/b/two.json", name: "two", modelId: "URX22" as const },
    ];
    renderInspector(panel, getModel("URX44V"), defaultPlan("URX44V"), null, act, recent);
    const rows = [...panel.querySelectorAll<HTMLButtonElement>("button.recent-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".recent-name")!.textContent).toBe("one");
    expect(rows[1].querySelector(".recent-model")!.textContent).toContain("URX22");
    rows[1].click();
    expect(act.onOpenRecent).toHaveBeenCalledWith("/b/two.json");
  });

  it("replaces the previous render rather than appending to it", () => {
    renderInspector(panel, getModel("URX44V"), defaultPlan("URX44V"), nodeSel("ch1"), act);
    const first = rowLabels().length;
    renderInspector(panel, getModel("URX44V"), defaultPlan("URX44V"), nodeSel("ch1"), act);
    expect(rowLabels()).toHaveLength(first);
  });
});

describe("renderInspector — every node of every model", () => {
  it.each(MODEL_IDS)("renders every %s node without throwing, and names each one", (id) => {
    const model = getModel(id);
    const plan = defaultPlan(id);
    for (const node of model.nodes) {
      const host = document.createElement("div");
      document.body.append(host);
      expect(() => renderInspector(host, model, plan, nodeSel(node.id), act)).not.toThrow();
      expect(host.textContent).toContain(node.label);
      host.remove();
    }
  });

  it.each(MODEL_IDS)("renders every %s connection without throwing", (id) => {
    const model = getModel(id);
    const plan = defaultPlan(id);
    for (const conn of plan.connections) {
      const host = document.createElement("div");
      document.body.append(host);
      expect(() => renderInspector(host, model, plan, connSel(conn.from, conn.to), act)).not.toThrow();
      host.remove();
    }
  });

  // A selection naming something the model does not have must not render a panel
  // full of controls for a node that is not there.
  it("renders nothing for a node the model does not have", () => {
    renderInspector(panel, getModel("URX44V"), defaultPlan("URX44V"), nodeSel("no-such-node"), act);
    expect(rowLabels()).toEqual([]);
  });
});

describe("device screen row orders", () => {
  const labelsFor = (id: string): string[] => {
    renderInspector(panel, getModel("URX44V"), defaultPlan("URX44V"), nodeSel(id), act);
    return rowLabels();
  };

  // The order the unit's own INPUT screen reads in, which is the reason the rows
  // are appended in the sequence they are.
  it("reads a MONO IN channel's INPUT section in the device's order", () => {
    const m = t().inspector;
    const labels = labelsFor("ch1");
    const wanted = [m.phantom, m.gainAnalog, m.clipSafe, m.phase, m.hpf, m.hpfFreq, m.compEqType];
    expect(wanted.every((l) => labels.includes(l))).toBe(true);
    const idx = wanted.map((l) => labels.indexOf(l));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  // ON, PRE, Pan, Level — the device SEND TO screen order. The source here is a
  // stereo channel, so its pan reads as a BALANCE.
  it("reads a send's SEND TO controls as ON, PRE, Pan, Level", () => {
    const model = getModel("URX44V");
    const plan = defaultPlan("URX44V");
    const send = plan.connections.find((c) => c.kind === "send" && c.to.startsWith("bus.mix"))!;
    renderInspector(panel, model, plan, connSel(send.from, send.to), act);
    const m = t().inspector;
    const seen = rowLabels();
    expect(seen).toEqual([m.sendOn, m.prePost, m.balance, m.level]);
  });

  // The device's own name for each row, so a label that stopped resolving would
  // show up here rather than being quietly filtered out of an order check.
  it("names every channel row from the catalog rather than a key", () => {
    const labels = labelsFor("ch1").filter(Boolean);
    expect(labels.length).toBeGreaterThan(5);
    expect(labels.every((l) => l !== "undefined")).toBe(true);
  });
});

describe("node controls report their edits", () => {
  it("renames a node from the name field", () => {
    renderInspector(panel, getModel("URX44V"), defaultPlan("URX44V"), nodeSel("ch1"), act);
    const field = panel.querySelector<HTMLInputElement>('input[type="text"]')!;
    field.value = "Kick";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    expect(act.onRenameNode).toHaveBeenCalledWith("ch1", "Kick");
  });

  // The device's CH SETTING name is a fixed-width byte field. The panel does not
  // re-render on a rename (that is what keeps focus while typing), so cutting the
  // value only on the way out would leave the box showing text the plan does not
  // hold. `maxlength` cannot stand in for it: it counts UTF-16 units, so 63 of it
  // admits 63 Japanese characters — 189 bytes.
  it("cuts a name to the device's field width in the box as well as in the report", () => {
    renderInspector(panel, getModel("URX44V"), defaultPlan("URX44V"), nodeSel("ch1"), act);
    const field = panel.querySelector<HTMLInputElement>('input[type="text"]')!;
    field.value = "あ".repeat(60);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    expect(field.value).toBe("あ".repeat(21));
    expect(act.onRenameNode).toHaveBeenCalledWith("ch1", "あ".repeat(21));
  });

  // Rewriting `value` mid-composition takes the text out from under the IME's
  // conversion candidates, so the cut is held until the composition ends.
  it("holds the cut until an IME composition ends", () => {
    renderInspector(panel, getModel("URX44V"), defaultPlan("URX44V"), nodeSel("ch1"), act);
    const field = panel.querySelector<HTMLInputElement>('input[type="text"]')!;
    field.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    field.value = "あ".repeat(60);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    expect(field.value).toBe("あ".repeat(60));
    field.dispatchEvent(new Event("compositionend", { bubbles: true }));
    expect(field.value).toBe("あ".repeat(21));
    expect(act.onRenameNode).toHaveBeenLastCalledWith("ch1", "あ".repeat(21));
  });

  it("recolors a node from a swatch and clears it from the none swatch", () => {
    renderInspector(panel, getModel("URX44V"), defaultPlan("URX44V"), nodeSel("ch1"), act);
    const swatches = [...panel.querySelectorAll<HTMLButtonElement>("button.swatch")];
    expect(swatches.length).toBeGreaterThan(1);
    swatches.at(-1)!.click();
    swatches[0].click();
    const calls = vi.mocked(act.onRecolorNode).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls.every(([id]) => id === "ch1")).toBe(true);
    expect(calls.some(([, color]) => color === null)).toBe(true);
  });

  it("hides a node and closes the panel from their own buttons", () => {
    renderInspector(panel, getModel("URX44V"), defaultPlan("URX44V"), nodeSel("ch1"), act);
    panel.querySelector<HTMLButtonElement>("button.subtle")?.click();
    panel.querySelector<HTMLButtonElement>("button.inspector-close")!.click();
    expect(act.onClose).toHaveBeenCalled();
  });

  it("opens a tuning screen from its launcher", () => {
    renderInspector(panel, getModel("URX44V"), defaultPlan("URX44V"), nodeSel("ch1"), act);
    const gate = panel.querySelector<HTMLButtonElement>("#btn-gate-screen");
    if (!gate) throw new Error("the GATE launcher is the reason this channel has a tuning screen");
    gate.click();
    expect(act.onOpenDynScreen).toHaveBeenCalledWith("gate", "ch1");
  });

  it("deletes a deletable connection and refuses a fixed one", () => {
    const model = getModel("URX44V");
    const plan = defaultPlan("URX44V");
    const send = plan.connections.find((c) => c.kind === "send")!;
    renderInspector(panel, model, plan, connSel(send.from, send.to), act);
    const del = panel.querySelector<HTMLButtonElement>("button.danger");
    if (del) {
      del.click();
      expect(act.onDeleteConnection).toHaveBeenCalledWith(send.from, send.to);
    } else {
      expect(panel.textContent).toContain(t().inspector.fixedConnection);
    }
  });
});

describe("insert FX", () => {
  const fxNode = (): { model: ReturnType<typeof getModel>; plan: Plan; id: string } => {
    const model = getModel("URX44V");
    const plan = defaultPlan("URX44V");
    const id = model.nodes.find((n) => insertFxControl(model, n.id))!.id;
    return { model, plan, id };
  };

  // Selecting an effect auto-engages it on the device, so the plan mirrors that;
  // selecting No Effect leaves the dormant switch state alone.
  it("engages an effect on selection and leaves the switch alone for No Effect", () => {
    const { model, plan, id } = fxNode();
    renderInspector(panel, model, plan, nodeSel(id), act);
    const sel = [...panel.querySelectorAll<HTMLSelectElement>("select")].find((s) =>
      [...s.options].some((o) => Number(o.value) === INSERT_FX_NONE),
    );
    if (!sel) return;
    const real = [...sel.options].find((o) => Number(o.value) !== INSERT_FX_NONE);
    if (real) {
      sel.value = real.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      const patch = vi.mocked(act.onUpdateNodeParams).mock.calls.at(-1)![1];
      expect(patch.insertFxOn).toBe(true);
      expect(patch.insertFx).toBe(Number(real.value));
    }
    vi.mocked(act.onUpdateNodeParams).mockClear();
    sel.value = String(INSERT_FX_NONE);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    const none = vi.mocked(act.onUpdateNodeParams).mock.calls.at(-1)![1];
    expect(none.insertFx).toBe(INSERT_FX_NONE);
    expect(none.insertFxOn).toBeUndefined();
  });

  // A bare slot number left behind after a selector change would be read as the NEW
  // family's slot, under a different law, and emitted as absolute state on the next
  // device flush.
  it("parks the outgoing effect's engine values under its own family", () => {
    const { model, plan, id } = fxNode();
    plan.nodeParams[id] = { ...plan.nodeParams[id], insertFx: 1, insertFxParams: { "3": 42 } };
    renderInspector(panel, model, plan, nodeSel(id), act);
    const sel = [...panel.querySelectorAll<HTMLSelectElement>("select")].find((s) =>
      [...s.options].some((o) => Number(o.value) === INSERT_FX_NONE),
    );
    if (!sel) return;
    sel.value = String(INSERT_FX_NONE);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    const patch = vi.mocked(act.onUpdateNodeParams).mock.calls.at(-1)![1];
    expect(patch.insertFxParams).toBeDefined();
    expect(Object.keys(patch.insertFxParams!)).not.toContain("3");
  });
});

describe("section fold state", () => {
  it("persists a hand-folded disclosure across renders", () => {
    const model = getModel("URX44V");
    const plan = defaultPlan("URX44V");
    renderInspector(panel, model, plan, nodeSel("ch1"), act);
    const first = [...panel.querySelectorAll<HTMLDetailsElement>("details.insp-section")].find((d) => d.open);
    if (!first) return;
    const title = first.querySelector(".sec-title")!.textContent!;
    first.open = false;
    first.dispatchEvent(new Event("toggle"));

    renderInspector(panel, model, plan, nodeSel("ch1"), act);
    expect(sectionByTitle(title)!.open).toBe(false);
  });

  // The cache is loaded once and re-persisted on every write, so clearing storage
  // alone does not put a later render back at the defaults.
  it("returns to the defaults once the cache is reset with storage", () => {
    const model = getModel("URX44V");
    const plan = defaultPlan("URX44V");
    renderInspector(panel, model, plan, nodeSel("ch1"), act);
    const first = [...panel.querySelectorAll<HTMLDetailsElement>("details.insp-section")].find((d) => d.open);
    if (!first) return;
    const title = first.querySelector(".sec-title")!.textContent!;
    first.open = false;
    first.dispatchEvent(new Event("toggle"));

    localStorage.clear();
    resetSectionCache();
    renderInspector(panel, model, plan, nodeSel("ch1"), act);
    expect(sectionByTitle(title)!.open).toBe(true);
  });

  // The property set when a section is built queues one echo toggle event; it must
  // not be recorded as a hand fold.
  it("does not record the echo toggle a freshly built section queues", () => {
    const model = getModel("URX44V");
    const plan = defaultPlan("URX44V");
    renderInspector(panel, model, plan, nodeSel("ch1"), act);
    for (const d of panel.querySelectorAll<HTMLDetailsElement>("details.insp-section")) {
      d.dispatchEvent(new Event("toggle"));
    }
    expect(localStorage.getItem("urx-inspector-sections")).toBeNull();
  });
});

describe("live-connected presentation", () => {
  // The tap is always editable in the planner — the plan records intent — and is
  // turned read-only only while live and the device cannot accept the write.
  it("locks a CH to FX tap only while live", () => {
    const model = getModel("URX44V");
    const plan = defaultPlan("URX44V");
    const toFx = plan.connections.find((c) => c.kind === "send" && c.to.startsWith("bus.fx"));
    if (!toFx) return;
    renderInspector(panel, model, plan, connSel(toFx.from, toFx.to), act, [], false);
    const offline = [...panel.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.disabled).length;
    renderInspector(panel, model, plan, connSel(toFx.from, toFx.to), act, [], true);
    const live = [...panel.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.disabled).length;
    expect(live).toBeGreaterThanOrEqual(offline);
  });
});

describe("localization", () => {
  it("renders the active catalog and re-renders into a switched one", () => {
    const model = getModel("URX44V");
    const plan = defaultPlan("URX44V");
    renderInspector(panel, model, plan, null, act);
    const en = panel.textContent;
    setLang("ja");
    renderInspector(panel, model, plan, null, act);
    expect(panel.textContent).toContain(t().inspector.hint);
    expect(panel.textContent).not.toBe(en);
  });
});

// One broad pass over every control of every node and every wire, in both languages.
// It asserts only that nothing throws and that the panel keeps rendering — the claims
// worth stating are the named tests above.
describe("coverage sweep: every control of every selection", () => {
  it.each(MODEL_IDS)("drives every control the %s panel renders", (id) => {
    const model = getModel(id);
    for (const lang of ["en", "ja"] as const) {
      setLang(lang);
      const plan = defaultPlan(id);
      for (const node of model.nodes) {
        const host = document.createElement("div");
        document.body.append(host);
        renderInspector(host, model, plan, nodeSel(node.id), actions(), [], lang === "ja");
        expect(() => driveEverything(host)).not.toThrow();
        host.remove();
      }
      for (const conn of plan.connections) {
        const host = document.createElement("div");
        document.body.append(host);
        renderInspector(host, model, plan, connSel(conn.from, conn.to), actions(), [], false);
        expect(() => driveEverything(host)).not.toThrow();
        host.remove();
      }
    }
    setLang("en");
  });

  // SSMCS replaces the whole channel strip, so it is a second panel shape entirely.
  it("drives the SSMCS channel strip", () => {
    const model = getModel("URX44V");
    const plan = defaultPlan("URX44V");
    plan.nodeParams["ch1"] = { ...plan.nodeParams["ch1"], compEqType: COMP_EQ_SSMCS };
    renderInspector(panel, model, plan, nodeSel("ch1"), act);
    expect(() => driveEverything(panel)).not.toThrow();
    expect(rowLabels().length).toBeGreaterThan(0);
  });

  // Every insert-FX family has its own editor; the selector is what reaches them.
  it("drives every insert-FX family's editor", () => {
    const model = getModel("URX44V");
    const id = model.nodes.find((n) => insertFxControl(model, n.id))?.id;
    if (!id) return;
    for (const { option } of insertFxMenu(model, defaultPlan("URX44V"), id)) {
      const plan = defaultPlan("URX44V");
      plan.nodeParams[id] = { ...plan.nodeParams[id], insertFx: option.value, insertFxOn: true };
      const host = document.createElement("div");
      document.body.append(host);
      renderInspector(host, model, plan, nodeSel(id), actions());
      expect(() => driveEverything(host)).not.toThrow();
      host.remove();
    }
  });
});

// MAIN / LINE OUT carry no MONO control of their own — the device puts [MONO] on
// the MONITOR buses — so the row reports what the output's own patch decides, and
// it is present whether or not that patch exists. It is a statement, not a warning:
// every state below is legal, which is why nothing here is gated on a preference.

describe("renderInspector — the analog outputs' MONO row", () => {
  const model = getModel("URX44V");
  const fieldValue = (label: string, host: HTMLElement = panel): string | undefined =>
    [...host.querySelectorAll<HTMLElement>(".field")]
      .find((f) => f.querySelector(".field-key")?.textContent === label)
      ?.querySelector(".field-val")?.textContent ?? undefined;

  const patched = (from: string, to: string, mono?: boolean): Plan => {
    const plan = defaultPlan("URX44V");
    plan.connections = plan.connections.filter((c) => !c.to.startsWith(`${to}:`));
    plan.connections.push({ from: `${from}:out`, to: `${to}:in`, kind: "patch" });
    if (mono !== undefined) plan.nodeParams[from] = { ...plan.nodeParams[from], mono };
    return plan;
  };

  it("names the way out when the patch has no mono at all", () => {
    renderInspector(panel, model, patched("bus.stereo", "out.main"), nodeSel("out.main"), act);
    expect(fieldValue(t().inspector.mono)).toBe(t().inspector.monoUnavailable);
    expect(panel.textContent).toContain(t().inspector.patchNoMono);
  });

  it("names the monitor that owns the switch, and drops the way-out note", () => {
    renderInspector(panel, model, patched("bus.mon1", "out.main", true), nodeSel("out.main"), act);
    // Exact, not toContain: "MONITOR" carries the letters of "ON", so a substring
    // check for the ON state also passes on "OFF, from MONITOR 1" — an outputMono
    // stuck at off would have kept this green.
    expect(fieldValue(t().inspector.mono)).toBe(t().inspector.monoVia(t().inspector.on, "MONITOR 1"));
    expect(panel.textContent).not.toContain(t().inspector.patchNoMono);
  });

  it("distinguishes a monitor patch whose switch is off from one that has no switch", () => {
    renderInspector(panel, model, patched("bus.mon2", "out.line", false), nodeSel("out.line"), act);
    expect(fieldValue(t().inspector.mono)).toContain(t().inspector.off);
    expect(fieldValue(t().inspector.mono)).not.toBe(t().inspector.monoUnavailable);
  });

  // An output with nothing patched into it still says where mono would come from —
  // the case a warning keyed on a wire could never reach.
  it("shows the row on an unpatched output", () => {
    const plan = defaultPlan("URX44V");
    plan.connections = plan.connections.filter((c) => !c.to.startsWith("out.main:"));
    renderInspector(panel, model, plan, nodeSel("out.main"), act);
    expect(fieldValue(t().inspector.mono)).toBe(t().inspector.monoUnavailable);
  });

  // Scope: the row belongs where a routing change can remove the lock. A USB output
  // cannot take a MONITOR source at all, so a standing note there would be a lock
  // nothing can unlock.
  it("stays off the USB outputs and the buses", () => {
    for (const id of ["out.usbmain_a", "out.usbsub", "bus.stereo", "bus.mon1"]) {
      const host = document.createElement("div");
      document.body.append(host);
      renderInspector(host, model, defaultPlan("URX44V"), nodeSel(id), actions());
      expect(fieldValue(t().inspector.mono, host)).toBeUndefined();
      host.remove();
    }
  });

  // The block diagram takes each monitor's PHONES after the MONO block, so a pair of
  // speakers switched to mono takes the headphones with it. Only while it is on: off,
  // the note has nothing to be about.
  it("warns on the MONITOR node that its PHONES follows MONO, only while MONO is on", () => {
    const plan = defaultPlan("URX44V");
    plan.nodeParams["bus.mon1"] = { ...plan.nodeParams["bus.mon1"], mono: false };
    renderInspector(panel, model, plan, nodeSel("bus.mon1"), act);
    expect(panel.textContent).not.toContain(t().inspector.monoPhonesShared);

    plan.nodeParams["bus.mon1"] = { ...plan.nodeParams["bus.mon1"], mono: true };
    renderInspector(panel, model, plan, nodeSel("bus.mon1"), act);
    expect(panel.textContent).toContain(t().inspector.monoPhonesShared);
  });

  // The value is composed by a message function, so each language composes its own —
  // the row is the only place either one is built, and the English case above cannot
  // stand in for it.
  it("composes the value in the active language", () => {
    setLang("ja");
    try {
      renderInspector(panel, model, patched("bus.mon1", "out.main", true), nodeSel("out.main"), act);
      expect(fieldValue(t().inspector.mono)).toBe(t().inspector.monoVia(t().inspector.on, "MONITOR 1"));
      expect(fieldValue(t().inspector.mono)).toContain("MONITOR 1");
      renderInspector(panel, model, patched("bus.stereo", "out.main"), nodeSel("out.main"), act);
      expect(fieldValue(t().inspector.mono)).toBe(t().inspector.monoUnavailable);
    } finally {
      setLang("en");
    }
  });
});
