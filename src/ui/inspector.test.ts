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
import { resetSettingsCache, updateSettings } from "../core/settings";
import { pinSettingsReset } from "../core/settings-reset.test-util";
import { holdInertOnBlur, resetPointerTracking } from "./dom";
import { insertFxMenu } from "../core/constraints";
import { insertFxControl } from "../core/control/translate";
import { COMP_EQ_SSMCS, INSERT_FX_NONE, INSERT_FX_OPTIONS, OUTPUT_INSERT_FX_OPTIONS } from "../core/control/params";
import { planToCommands } from "../core/control/translate";
import { fxParams } from "../core/control/fx-effect";
import type { DeviceModel } from "../models/types";
import { setLang, t } from "../i18n";

const DUCKER = "out.ducker1";
const HOST = "ch_5_6"; // the stereo pair out.ducker1 hangs off (models/build.ts)

/** A plan whose CH 5/6 is tapped straight to a USB direct out — what makes its ducker one
 *  the bypass warning card is about, and so one the panel reads for any selection. Two
 *  describes build on it; the second is at the foot of the file. */
const tapped = (): Plan => {
  const plan = defaultPlan("URX44V");
  plan.connections = plan.connections.filter((c) => c.to !== "out.usbmain_b:in");
  plan.connections.push({ from: HOST + ":out", to: "out.usbmain_b:in", kind: "patch" });
  return plan;
};

pinSettingsReset();

// The panel renders one selection, but what it DRAWS is derived from more nodes than that
// selection names — a bus's Pan Link removes the send PAN on every wire into it, an analog
// output reports MONO from a monitor bus, and the ducker-bypass card is plan-wide. A device
// or MIDI change on a node the panel is not "showing" can therefore move what is on screen,
// so the caller that decides whether to repaint has to know the footprint. These pin it.

describe("inspectorNodes", () => {
  const u44v = getModel("URX44V");

  const rendered = (plan: Plan, sel: Selection): string => {
    const el = document.createElement("div");
    renderInspector(el, u44v, plan, sel, actions());
    return el.textContent ?? "";
  };

  it("reports nothing for an empty selection while no ducker is on a direct out", () => {
    expect(inspectorNodes(u44v, emptyPlan("URX44V"), null)).toEqual([]);
    // …and the card's own duckers once one is, because it is drawn with no selection too.
    expect(inspectorNodes(u44v, tapped(), null)).toEqual([DUCKER]);
  });

  it("reports the node itself for a node selection", () => {
    expect(inspectorNodes(u44v, emptyPlan("URX44V"), { type: "node", id: "ch1" })).toEqual(["ch1"]);
  });

  // The footprint's ducker half is not defensive: the two surfaces below are each rendered
  // from a ducker node's params while the selection names neither the ducker nor its host. A
  // caller that filters dirty nodes through this function drops the repaint otherwise, which
  // is what a MIDI-driven Ducker on/off does — it reaches the plan through the direct-follow
  // branch, where nothing else refreshes the panel.
  //
  // They take DIFFERENT plans on purpose. On a tapped plan the wire's own source ducker is
  // already a bypass candidate, so each half covers for the other and dropping either one
  // from the footprint leaves both green.
  it("names the ducker a send's PRE note is read from — with no direct out anywhere", () => {
    const plan = defaultPlan("URX44V"); // no channel is tapped to a USB out, so no card
    const wire = connSel(HOST + ":out", "bus.mix1:in");
    const send = plan.connections.find((c) => c.from === HOST + ":out" && c.to === "bus.mix1:in")!;
    send.params = { ...send.params, tap: "pre" };
    const shows = (): boolean => rendered(plan, wire).includes(t().inspector.duckerPreSend);

    expect(shows()).toBe(false);
    expect(rendered(plan, wire)).not.toContain(t().warning.duckerTitle); // the other half is absent
    plan.nodeParams[DUCKER] = { ...plan.nodeParams[DUCKER], duckerOn: true };
    expect(shows()).toBe(true);
    expect(inspectorNodes(u44v, plan, wire)).toContain(DUCKER);
    // …and only for the wire whose source it hangs off. A send from another channel reads
    // its own host's Ducker, which CH 5/6's is not.
    expect(inspectorNodes(u44v, plan, connSel("ch1:out", "bus.mix1:in"))).not.toContain(DUCKER);
  });

  it("names the ducker the plan-wide warning card is read from", () => {
    const plan = tapped();
    const elsewhere = nodeSel("bus.mix1"); // names neither the ducker nor its host
    const warns = (): boolean => rendered(plan, elsewhere).includes(t().warning.duckerTitle);

    expect(warns()).toBe(false);
    plan.nodeParams[DUCKER] = { ...plan.nodeParams[DUCKER], duckerOn: true };
    expect(warns()).toBe(true);
    expect(inspectorNodes(u44v, plan, elsewhere)).toContain(DUCKER);
  });

  // The card is preference-gated (Preferences > Warnings); the footprint is deliberately
  // not, and the source comment states that as a decision. Both halves are pinned in one
  // case because they are one decision, and because nothing else in the tree renders the
  // panel with the preference off: a later change that consulted it in inspectorNodes
  // would under-name — a panel left describing the state before the change — and no case
  // would go red. Over-naming, what this pins, costs a rebuild that draws the same thing.
  it("drops the card with the warning preference off, and names its ducker either way", () => {
    // At 192 kHz, so the sample-rate card is up beside this one. The two cards have
    // separate switches, and on a plan carrying only one of them a gate reading both
    // preferences satisfies every assertion here.
    const plan: Plan = { ...tapped(), sampleRate: 192_000 };
    plan.nodeParams[DUCKER] = { ...plan.nodeParams[DUCKER], duckerOn: true };
    const elsewhere = nodeSel("bus.mix1"); // names neither the ducker nor its host

    // The preference on (the default) is the positive control: without it the assertions
    // below also pass on a plan that raises no card at all.
    expect(rendered(plan, elsewhere)).toContain(t().warning.duckerTitle);
    expect(inspectorNodes(u44v, plan, elsewhere)).toContain(DUCKER);

    updateSettings({ warnDucker: false });
    expect(rendered(plan, elsewhere)).not.toContain(t().warning.duckerTitle);
    expect(rendered(plan, elsewhere)).toContain(t().warning.title); // the other switch stands
    expect(inspectorNodes(u44v, plan, elsewhere)).toContain(DUCKER);
  });

  // The other half of the same claim, and what keeps the set from being "every ducker":
  // `duckerOn` is a toggle whose default edge binding flips on every CC >= 64, so one knob
  // sweep bound to it applies 64 times. A ducker the panel does not read must not be named,
  // or that sweep repaints the panel at the direct branch's ~20 Hz for a picture that did
  // not move — the cost the monitor case below is narrowed for.
  it("does NOT name a ducker whose state cannot change what is drawn", () => {
    const plan = tapped(); // only out.ducker1's host carries the tap
    const others = u44v.nodes.filter((n) => n.kind === "ducker" && n.id !== DUCKER).map((n) => n.id);
    expect(others.length).toBeGreaterThan(0); // or the assertions below are vacuous
    const selections: Selection[] = [null, nodeSel("ch1"), connSel("ch1:out", "bus.mix1:in")];
    for (const sel of selections) {
      const named = inspectorNodes(u44v, plan, sel);
      expect(others.filter((id) => named.includes(id))).toEqual([]);
    }
    // Turning one of them ON does not change that: it is not on a direct out, and it is not
    // the selected wire's source, so nothing the panel draws reads it.
    plan.nodeParams[others[0]] = { ...plan.nodeParams[others[0]], duckerOn: true };
    expect(inspectorNodes(u44v, plan, nodeSel("ch1"))).not.toContain(others[0]);
  });

  // The same rule applied to the note's own half. Its gate is the WIRE's, not the source
  // channel's, so every other wire out of a ducker-carrying channel must leave that ducker
  // out — a POST send and a STEREO send draw no note whatever the Ducker does.
  it("does NOT name a wire's source ducker where the note cannot be drawn", () => {
    const plan = defaultPlan("URX44V");
    plan.nodeParams[DUCKER] = { ...plan.nodeParams[DUCKER], duckerOn: true };
    const named = (from: string, to: string): boolean => inspectorNodes(u44v, plan, connSel(from, to)).includes(DUCKER);
    const send = plan.connections.find((c) => c.from === HOST + ":out" && c.to === "bus.mix1:in")!;

    // The wire the note IS drawn under — the positive control, so the negatives below are
    // this gate and not a footprint that names no ducker at all.
    send.params = { ...send.params, tap: "pre" };
    expect(named(HOST + ":out", "bus.mix1:in")).toBe(true);
    // POST on the very same wire: the note is gone, so its ducker is out of the footprint.
    send.params = { ...send.params, tap: "post" };
    expect(named(HOST + ":out", "bus.mix1:in")).toBe(false);
    // The channel's STEREO send carries no tap at all (sendHasTap is false for bus.stereo),
    // and its Rec Point tap to microSD is not a send.
    expect(named(HOST + ":out", "bus.stereo:in")).toBe(false);
    for (const c of plan.connections.filter((w) => w.from === HOST + ":out" && w.to.startsWith("out.sdrec")))
      expect(named(c.from, c.to)).toBe(false);
  });

  it("names a selected ducker once, not twice", () => {
    // Both halves would offer out.ducker1 here: it is a bypass candidate AND the selection.
    expect(inspectorNodes(u44v, tapped(), nodeSel(DUCKER))).toEqual([DUCKER]);
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

  // An open `<select>` picker is the second kind of in-flight input a rebuild destroys,
  // and `replaceChildren` closes it instantly — so while any followed parameter on the
  // node moved (an external MIDI sweep, a device-side knob) the reflect ran at up to
  // 20 Hz and the Rec Point / Signal Type / INS FX dropdowns could not be opened at all.
  it("holds a rebuild while a select inside it has focus, and runs one when it ends", () => {
    let rebuilds = 0;
    const el = document.createElement("div");
    const sel = document.createElement("select");
    sel.append(document.createElement("option"));
    el.append(sel);
    document.body.replaceChildren(el);
    const gate = compositionGate(el, () => rebuilds++);

    expect(gate.held()).toBe(false); // nothing open yet
    sel.focus();
    expect(gate.held()).toBe(true);
    expect(gate.held()).toBe(true);
    expect(rebuilds).toBe(0);

    // A picker dismissal is a change, a blur, or both. This one is both, in the order a
    // dismissal WITHOUT a choice produces; the case below is the other one.
    sel.blur();
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    expect(rebuilds).toBe(1);
    expect(gate.held()).toBe(false);
  });

  // …and choosing something is the order that matters, because the select KEEPS focus.
  // The gate reads a picker's "open" off focus, so a flush that re-asks the question on
  // `change` is asking about the picker that just closed: it answers yes and the rebuild
  // waits for whatever the operator does next. Every select that changes which controls
  // the panel shows goes through here — Insert FX, COMP/EQ Type, Signal Type — so the
  // panel kept its old control set after each of them. For Insert FX that is the bypass
  // switch and the tuning-screen launcher, which between them are the whole way in: the
  // effect was chosen, the plan was written, and the panel showed neither.
  //
  // The case above cannot see it. It blurs BEFORE the change, which clears the picker
  // the check would have tripped on, so it passes either way.
  it("runs the held rebuild on a change that leaves the select focused", () => {
    let rebuilds = 0;
    const el = document.createElement("div");
    const sel = document.createElement("select");
    sel.append(document.createElement("option"));
    el.append(sel);
    document.body.replaceChildren(el);
    const gate = compositionGate(el, () => rebuilds++);

    sel.focus();
    expect(gate.held()).toBe(true); // the choice's own write asks for a rebuild
    expect(rebuilds).toBe(0);

    sel.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.activeElement).toBe(sel); // …still focused, as a real dismissal leaves it
    expect(rebuilds).toBe(1);
  });

  // A selection change is the refresh nothing in the panel may outrank: what the gate
  // would hold it for belongs to the node being LEFT. Held, the panel goes on describing
  // that node — which is what a press on another node did while a select in the panel
  // still had focus, since choosing in one leaves focus there.
  //
  // `reset` is what the caller uses to say so, and it clears the flags rather than leaving
  // them: the rebuild removes the composing field, an end event for a field that is gone
  // may never arrive, and a latched `composing` stops the panel updating for the rest of
  // the session (this file's header names that failure).
  it("drops what it was holding when the panel is told to show something else", () => {
    let rebuilds = 0;
    const el = document.createElement("div");
    const sel = document.createElement("select");
    sel.append(document.createElement("option"));
    const text = document.createElement("input");
    el.append(sel, text);
    document.body.replaceChildren(el);
    const gate = compositionGate(el, () => rebuilds++);

    // Both of the flag-held kinds are in flight, and the picker is open on top of them.
    text.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    sel.focus();
    expect(gate.held()).toBe(true);

    gate.reset();
    // Nothing is pending any more, so a later end event cannot fire a stale rebuild…
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    expect(rebuilds).toBe(0);
    // …and the composition flag is gone, so the next refresh is not held by a composition
    // whose field the caller's own rebuild removed.
    expect(gate.held()).toBe(true); // the select still has focus — that much is still true
    sel.blur();
    expect(gate.held()).toBe(false);
  });

  // The other half of that trade. `change` says THIS PICKER closed and nothing else, so
  // it may not speak for the third thing the gate holds for: a row held inert under a
  // still-pressed pointer, where a rebuild hands that pointer a live control. Taking the
  // change as a general release would do exactly that.
  it("still holds on a change while a row is held inert", () => {
    let rebuilds = 0;
    const el = document.createElement("div");
    const sel = document.createElement("select");
    sel.append(document.createElement("option"));
    const slider = document.createElement("input");
    slider.type = "range";
    el.append(sel, slider);
    document.body.replaceChildren(el);
    holdInertOnBlur(slider);
    const gate = compositionGate(el, () => rebuilds++);

    slider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
    window.dispatchEvent(new FocusEvent("blur"));
    expect(slider.disabled).toBe(true);
    expect(gate.held()).toBe(true);

    sel.dispatchEvent(new Event("change", { bubbles: true }));
    expect(rebuilds).toBe(0); // the pointer is still down on the slider
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    expect(rebuilds).toBe(1);
  });

  // …and a select somewhere ELSE on the page is not this panel's business.
  it("does not hold for a select outside the host", () => {
    let rebuilds = 0;
    const el = document.createElement("div");
    el.append(document.createElement("input"));
    const outside = document.createElement("select");
    outside.append(document.createElement("option"));
    document.body.replaceChildren(el, outside);
    const gate = compositionGate(el, () => rebuilds++);
    outside.focus();
    expect(gate.held()).toBe(false);
  });

  // The third thing the gate holds for is a slider row held inert while the window is
  // away, and it is the one with no end event of its own: the two above are released by
  // the composition's end, a change or a focusout, and a hold ends on a pointer release
  // the panel never hears about. Without this the panel keeps whatever it was showing when
  // the press began until some later update happens to find the gate free — a MIDI move
  // and a device-side knob both reach the plan and the unit while the panel says otherwise.
  it("runs the held rebuild when the last inert hold ends", () => {
    let rebuilds = 0;
    const el = host();
    const slider = document.createElement("input");
    slider.type = "range";
    el.append(slider);
    holdInertOnBlur(slider);
    const gate = compositionGate(el, () => rebuilds++);

    slider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
    window.dispatchEvent(new FocusEvent("blur"));
    expect(slider.disabled).toBe(true);
    expect(gate.held()).toBe(true); // a device- or MIDI-driven value arrived meanwhile
    expect(rebuilds).toBe(0);

    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    expect(slider.disabled).toBe(false);
    expect(rebuilds).toBe(1);
    expect(gate.held()).toBe(false);
  });

  // …and it releases only its own kind. The other two share a backstop that clears
  // `composing` on any end, since a composition can go away without one; a hold's release
  // is no evidence of that, and taking it as one lands the next rebuild inside a live
  // composition — the thing the gate was built for.
  it("does not read a hold's release as the end of a composition", () => {
    let rebuilds = 0;
    const el = host();
    const slider = document.createElement("input");
    slider.type = "range";
    el.append(slider);
    holdInertOnBlur(slider);
    const gate = compositionGate(el, () => rebuilds++);

    fire(el, "compositionstart");
    slider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
    window.dispatchEvent(new FocusEvent("blur"));
    expect(gate.held()).toBe(true);

    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    expect(rebuilds).toBe(0);
    expect(gate.held()).toBe(true);

    fire(el, "compositionend");
    expect(rebuilds).toBe(1);
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

/** The Insert FX section body's bypass toggle, if the panel offered one. It is the
 *  section's own on-state toggle now, so it carries no label to look it up by — the
 *  header is its name, as on GATE / COMP / EQ. */
const insertFxBypass = (): HTMLElement | null =>
  sectionByTitle(t().inspector.insertFx)?.querySelector<HTMLElement>(".sec-body .toggle") ?? null;

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
  // The gate subscribes to the app-wide hold bookkeeping, which is module state on a
  // window that outlives the file: without this, every gate an earlier case built is
  // still listening and runs its own rebuild when a later case releases a hold.
  resetPointerTracking();
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

// A raw outside a descriptor's window reaches the plan two ways and BOTH want the stored
// value on screen. A device read stores what the unit holds (readback.ts reads each slot
// verbatim), and the unit can hold a raw this window excludes because an earlier build of
// this app could write one — the unit's own encoder stops at the window, but the wire does
// not. A plan saved by that build carries the same thing. Showing the window's bound instead
// names a value the unit is not at, which is the reading the panel is being looked at for.
//
// What the NEXT WRITE would send is a different question, and one readout cannot answer
// both: the emit path bounds the value, which architecture.md's "Aborting on failure" keeps
// as a standing exception. These two cases hold the panel to the first question.
describe("renderInspector — a stored value outside its control's range", () => {
  const fxPlanWith = (params: Record<string, number>): Plan => {
    const plan = defaultPlan("URX44V");
    plan.nodeParams["bus.fx2"] = { fxEffect: { type: 1024, params } };
    return plan;
  };
  const rowValue = (label: string): string => {
    const row = [...panel.querySelectorAll<HTMLElement>(".param")].find((r) => r.dataset.paramLabel === label);
    return row?.querySelector(".param-val")?.textContent ?? "";
  };
  const lpf = fxParams(1024).find((d) => d.key === "delayLpf")!;

  it("sends the bound for a stored value the window no longer admits", () => {
    // raw 20 is below the window and IS a state a unit can be in: v1.11.0 shipped this
    // slider starting at 0, so its Live sync could put one there.
    const plan = fxPlanWith({ delayLpf: 20 });
    renderInspector(panel, getModel("URX44V"), plan, nodeSel("bus.fx2"), act);
    // The write path sends the BOUND, while the surface that draws the value shows what the
    // unit holds. Both are true; this half is the writer's, and the display half is asked of
    // the FX tuning screen, which is where the effect's parameters are drawn
    // (`fx-effect-screen.test.ts`).
    expect(planToCommands(getModel("URX44V"), plan).find((c) => c.paramId === 685 && c.y === 10)?.vdValue).toBe(
      lpf.rawMin,
    );
  });

  // The same rule one layer down, and the reason the bound is not applied in rangeSlider
  // either: a mono channel's A.Gain slider runs -8..+70 while gainToVd clamps to the union of
  // the analog and digital ranges (-24..+70), so there the slider is TIGHTER than the write
  // path and a stored -20 is sent as -20.
  it("does not clamp a row whose slider is tighter than the value it will send", () => {
    const plan = defaultPlan("URX44V");
    plan.nodeParams["ch1"] = { ...plan.nodeParams["ch1"], gain: -20 };
    renderInspector(panel, getModel("URX44V"), plan, nodeSel("ch1"), act);
    expect(rowValue(t().inspector.gainAnalog)).toContain("-20");
    expect(planToCommands(getModel("URX44V"), plan).some((c) => c.vdValue === -2000)).toBe(true);
  });
});

// The panel and the write path answer "what is this FX channel set to" DIFFERENTLY when the
// plan does not describe the channel, and that is recorded here rather than left to be
// noticed. The panel reads an absent fxEffect as `{}` and draws the effect's own defaults;
// the emit sends nothing, because the plan format's silence means "leave this channel as the
// unit has it" (a type write is not recoverable). That is retired: the plan is completed at
// the LOAD now (`fillFactoryParams`), so a document that reaches the app carries these values
// and the row and the command are one number.
//
// This case builds its plan with `emptyPlan` and never goes through that funnel, which is what
// keeps it a pin on the EMIT: aligning the emit to the panel instead is the destructive fix —
// it resets a unit's FX from a document that says nothing — and it was written, measured and
// reverted. What replaced it is the completion plus the write confirm naming the strips.
describe("renderInspector — an FX channel the plan does not describe", () => {
  it("sends nothing for a channel the plan does not describe", () => {
    const model = getModel("URX44V");
    const plan = emptyPlan("URX44V");
    expect(plan.nodeParams["bus.fx1"]?.fxEffect, "the premise: nothing describes it").toBeUndefined();
    renderInspector(panel, model, plan, nodeSel("bus.fx1"), act);
    // The section still draws — a selector, an ON toggle and the launcher, and no value rows
    // (a select carries no `.param-val`, which is why this asks for the launcher).
    expect(panel.querySelector("#btn-fx-screen")).not.toBeNull();

    // …and not one value reaches the unit. What the app SHOWS for such a channel is the
    // effect's own defaults, and that half is asked of the tuning screen that draws them
    // (`fx-effect-screen.test.ts`), which is where those rows now are.
    expect(planToCommands(model, plan).some((c) => c.paramId === 679 || c.paramId === 681)).toBe(false);
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

  // The unit's own name screen takes 8 characters. The panel does not re-render on a
  // rename (that is what keeps focus while typing), so cutting the value only on the
  // way out would leave the box showing text the plan does not hold — and a name past
  // the bound also draws a node label across its neighbours on the canvas.
  it("cuts a name to what the unit can hold, in the box as well as in the report", () => {
    renderInspector(panel, getModel("URX44V"), defaultPlan("URX44V"), nodeSel("ch1"), act);
    const field = panel.querySelector<HTMLInputElement>('input[type="text"]')!;
    field.value = "あ".repeat(60);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    expect(field.value).toBe("あ".repeat(8));
    expect(act.onRenameNode).toHaveBeenCalledWith("ch1", "あ".repeat(8));
  });

  // Assigning `value` moves the caret to the end of the field. Without putting it
  // back, an edit made in the middle of a name already at the bound sent the next
  // keystroke to the tail — worse than the `maxlength` this replaced, which refused
  // the insertion and left the caret alone.
  it("keeps the caret where the edit was when the cut comes off the tail", () => {
    renderInspector(panel, getModel("URX44V"), defaultPlan("URX44V"), nodeSel("ch1"), act);
    const field = panel.querySelector<HTMLInputElement>('input[type="text"]')!;
    // A name at the bound, with one character just typed at the head.
    field.value = `y${"x".repeat(8)}`;
    field.setSelectionRange(1, 1);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    expect(field.value).toBe(`y${"x".repeat(7)}`);
    expect(field.selectionStart).toBe(1);
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
    expect(field.value).toBe("あ".repeat(8));
    expect(act.onRenameNode).toHaveBeenLastCalledWith("ch1", "あ".repeat(8));
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

  // A plan can hold an insert-FX value the node's own control does not carry: a file, a
  // `?plan=` link and a device read all land one, and the loader gates none of them. The
  // emit path turns it into No Effect and writes no engine parameter, so a bypass switch
  // and an editor over it would change nothing that leaves the app.
  describe.each([
    ["a channel holding an OUTPUT-only effect", "ch1", "M.B.Comp", OUTPUT_INSERT_FX_OPTIONS],
    ["a bus holding a CHANNEL-only effect", "bus.mix1", "Pitch Fix", INSERT_FX_OPTIONS],
  ])("%s", (_name, id, label, options) => {
    const held = (): { model: DeviceModel; plan: Plan } => {
      const model = getModel("URX44V");
      const plan = emptyPlan("URX44V");
      plan.nodeParams[id] = { insertFx: options.find((o) => o.label === label)!.value, insertFxOn: true };
      return { model, plan };
    };

    it("offers neither a bypass switch nor an editor for it", () => {
      const { model, plan } = held();
      renderInspector(panel, model, plan, nodeSel(id), act);
      const labels = rowLabels();
      // The section and its selector stay: that select is the control that gets the
      // operator out of this state.
      expect(sectionByTitle(t().inspector.insertFx)).toBeDefined();
      expect(labels).toContain(t().inspector.insertFxType);
      expect(insertFxBypass()).toBeNull();
      expect(labels).not.toContain(t().inspector.insertFxEffect.params.threshold);
      expect(sectionByTitle(t().inspector.insertFxEffect.title)).toBeUndefined();
      expect(panel.querySelector("#btn-insfx-screen")).toBeNull();
    });

    it("shows No Effect on the selector rather than an empty field", () => {
      // A `<select>` handed a value none of its options carry lands at selectedIndex -1
      // and draws nothing at all, which reads as a control that failed to render. What it
      // shows instead is what the unit will be given.
      const { model, plan } = held();
      renderInspector(panel, model, plan, nodeSel(id), act);
      const sel = [...panel.querySelectorAll<HTMLElement>(".param")]
        .find((r) => r.dataset.paramLabel === t().inspector.insertFxType)!
        .querySelector("select")!;
      expect(sel.selectedIndex).toBeGreaterThanOrEqual(0);
      expect(sel.value).toBe(String(INSERT_FX_NONE));
      expect(sel.selectedOptions[0]?.textContent).toBe("No Effect");
      // …and the plan is not rewritten to say so. Nothing here edits, so the raw value is
      // still what the next render, a save and an undo all see.
      expect(plan.nodeParams[id]!.insertFx).not.toBe(INSERT_FX_NONE);
    });

    it("is what the device path does with it — nothing", () => {
      // The half that says the refusal above is not merely a taste: the surface and the
      // wire agree because both ask effectiveInsertFx.
      const { model, plan } = held();
      const cmds = planToCommands(model, plan);
      expect(cmds.filter((c) => c.name === "INSERT_FX_EFFECT")).toHaveLength(0);
      expect(cmds.filter((c) => c.name === "INSERT_FX_ON")).toHaveLength(0);
    });
  });

  it("keeps both for an effect the node's own control does carry", () => {
    // The control for the pair above. Without it a gate that refused everything would
    // pass them both.
    const model = getModel("URX44V");
    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.mix1"] = {
      insertFx: OUTPUT_INSERT_FX_OPTIONS.find((o) => o.label === "M.B.Comp")!.value,
      insertFxOn: true,
    };
    renderInspector(panel, model, plan, nodeSel("bus.mix1"), act);
    expect(insertFxBypass()).not.toBeNull();
    // The launcher, not an editor: every family the app edits at all is edited on the
    // tuning screen, so this panel has no second set of sliders for one of them.
    expect(panel.querySelector("#btn-insfx-screen")).not.toBeNull();
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

  // What the inspector offers per family, now that the tuning screen owns all but one of
  // them: a launcher, or the multi-band compressor's own editor. Driving every control is
  // still the point — an editor that throws on some family is what this catches — but the
  // shape is asserted too, since `not.toThrow()` passes over a surface that has gone empty.
  it("offers a launcher for the families the screen shows, and an editor for the one it does not", () => {
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
      const launcher = host.querySelector("#btn-insfx-screen");
      const editor = host.querySelector<HTMLElement>('.insp-section[data-key="insertFxEffect"]');
      if (option.value === INSERT_FX_NONE) {
        expect(launcher, option.label).toBeNull();
        expect(editor, option.label).toBeNull();
      } else {
        // One surface or the other, never both: two editors over one value is how a stale
        // slider gets written back.
        expect(Boolean(launcher) !== Boolean(editor), option.label).toBe(true);
      }
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

// The other card at the top of the panel, and the only other row a preference can take
// away. Two more claims ride on the same plan: the ducker card has a switch of its own and
// stands through this one, and what the rate card describes is a behaviour lock rather
// than a preference — the stereo channel's EQ section stays locked with the text off.
//
// The card the earlier describe switched off is asserted here in its ON state, which is
// also what holds the file-level settings-cache reset: the cache carries across cases, and
// without that reset this preference arrives here already false.

describe("renderInspector — the sample-rate warning card's preference", () => {
  const model = getModel("URX44V");

  /** CH 5/6 tapped to a USB out with its Ducker on, at 192 kHz: both cards up, and the
   *  selection is the stereo channel whose EQ the rate disables. */
  const bothCards = (): Plan => {
    const plan: Plan = { ...tapped(), sampleRate: 192_000 };
    plan.nodeParams[DUCKER] = { ...plan.nodeParams[DUCKER], duckerOn: true };
    return plan;
  };
  /** The EQ section's locked tooltip, which the disabled toggle's row carries. */
  const eqLock = (): string | undefined =>
    sectionByTitle(t().inspector.eqOn)?.querySelector<HTMLElement>(".sec-body .param")?.title;

  it("drops the card with the warning preference off", () => {
    // The positive control: a rate that has something to say, so the assertions below are
    // the preference and not a plan whose card was never going to be drawn.
    renderInspector(panel, model, bothCards(), nodeSel(HOST), act);
    expect(panel.textContent).toContain(t().warning.title);
    expect(panel.textContent).toContain(t().warning.stereoEq);
    expect(panel.textContent).toContain(t().warning.duckerTitle);
    expect(eqLock()).toBe(t().inspector.eqRateLocked);

    updateSettings({ warnRate: false });
    renderInspector(panel, model, bothCards(), nodeSel(HOST), act);
    expect(panel.textContent).not.toContain(t().warning.title);
    expect(panel.textContent).not.toContain(t().warning.stereoEq);
    expect(panel.textContent).toContain(t().warning.duckerTitle); // the other switch stands
    expect(eqLock()).toBe(t().inspector.eqRateLocked); // and so does the lock it named
  });
});
