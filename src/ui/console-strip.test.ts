// @vitest-environment jsdom

// The CONSOLE strip's own controls: the main fader, the head's rotary knobs, the INS
// FX chip, and what a BAL-linked pair does to all three. The SENDS rack and the two
// popovers are in console-sends.test.ts; the meter carry-over across a rebuild is in
// console.test.ts.
//
// The main fader differs from a rack column in one way that matters here: a press that
// lands OFF its cap is SEEDED — the value jumps to where the pointer landed, before any
// movement — so a case about that half must not reuse the rack's "nothing until the
// threshold" shape. A press on the cap is the other half, and writes nothing.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consoleHost, dragY, key, wheel, type ConsoleHost } from "./console.test-util";
import type { ConsoleMidiHooks } from "./console";
import { sendConnection } from "../core/plan";
import { PAN_BAL_BAL } from "../core/control/params";
import { INSERT_FX_OPTIONS, OUTPUT_INSERT_FX_OPTIONS, insertFxSelected } from "../core/control/params";
import { insertFxControl, planToCommands } from "../core/control/translate";
import { getModel } from "../models";
import { defaultPlan } from "../models/initial-state";
import { t } from "../i18n";

let h: ConsoleHost;

beforeEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
});

afterEach(() => {
  h?.restore();
});

/** A channel's main level = its fixed send into STEREO. */
const main = (id: string): number | undefined =>
  sendConnection(h.plan, id, "bus.stereo")?.params?.level as number | undefined;

const learnHooks = (armed: string[] = []): ConsoleMidiHooks => ({
  learnActive: () => true,
  armedId: () => null,
  isMapped: () => false,
  addrOf: () => null,
  arm: (id: string) => void armed.push(id),
});

describe("the main fader", () => {
  it("steps with the Arrow keys and paints the readout", () => {
    h = consoleHost();
    const r = h.strip("ch1");
    const before = main("ch1")!;
    key(r.fader!, "ArrowUp");
    expect(main("ch1")).toBeGreaterThan(before);
    expect(r.readDb!.textContent).toBe(main("ch1")! > 0 ? "+" + main("ch1")!.toFixed(1) : main("ch1")!.toFixed(1));
    expect(r.fader!.getAttribute("aria-valuenow")).toBe(String(Math.round(main("ch1")!)));
  });

  it("marks the readout off at −∞ and unmarks it on the way back", () => {
    h = consoleHost();
    const r = h.strip("ch1");
    key(r.fader!, "End");
    expect(r.readDb!.classList.contains("off")).toBe(true);
    expect(r.readDb!.textContent).toBe("-∞");
    key(r.fader!, "Home");
    expect(r.readDb!.classList.contains("off")).toBe(false);
  });

  /** Press the fader at a page y, then release without moving. */
  const press = (fader: HTMLElement, clientY: number): void => {
    fader.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientY, pointerId: 1 }));
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
  };

  // Seeded, unlike the rack columns: off the cap, the press alone jumps the value to
  // where the pointer landed. A threshold here would make the jump impossible.
  it("jumps to a press that lands off the cap, before any movement", () => {
    h = consoleHost();
    const r = h.strip("ch1");
    const before = main("ch1");
    const changesBefore = h.changes();
    const cap = r.cap!.getBoundingClientRect();
    press(r.fader!, cap.bottom + 40);
    expect(main("ch1")).not.toBe(before);
    expect(h.changes()).toBeGreaterThan(changesBefore);
  });

  // The other half, and the reason the seed became conditional: the cap is a couple of
  // detents tall at this travel, so a press anywhere but its exact centre used to move
  // the level — and reach the unit — before the operator had moved at all.
  it("grabs the cap without moving it", () => {
    h = consoleHost();
    const r = h.strip("ch1");
    const before = main("ch1");
    const changesBefore = h.changes();
    const cap = r.cap!.getBoundingClientRect();
    for (const y of [cap.top, cap.top + cap.height / 2, cap.bottom]) press(r.fader!, y);
    expect(main("ch1")).toBe(before);
    expect(h.changes()).toBe(changesBefore);
  });

  // …and the cap then stays under the pointer: the drag is measured against the cap's
  // own travel — the element's full height — not the groove's 6 px inset, which is what
  // made the two disagree everywhere but mid-travel. 30 px is exactly ten detents at
  // this travel, so the grid snap contributes nothing to the reading.
  it("moves the cap by the distance dragged", () => {
    h = consoleHost();
    const r = h.strip("ch1");
    const pos = (): number => parseFloat(r.cap!.style.getPropertyValue("--pos"));
    const before = pos();
    const height = r.fader!.getBoundingClientRect().height;
    const startY = r.cap!.getBoundingClientRect().top + 1;
    r.fader!.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientY: startY, pointerId: 1 }),
    );
    window.dispatchEvent(new PointerEvent("pointermove", { clientY: startY + 30, pointerId: 1 }));
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
    expect(pos() - before).toBeCloseTo((30 / height) * 100, 5);
  });

  it("tracks a drag and stops when its own element leaves the document", () => {
    h = consoleHost();
    const fader = h.strip("ch1").fader!;
    fader.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientY: 100, pointerId: 1 }),
    );
    window.dispatchEvent(new PointerEvent("pointermove", { clientY: 70, pointerId: 1 }));
    const moved = main("ch1");

    // A rebuild replaces every strip. The gesture has to end with the element it
    // started on — otherwise the plan keeps taking a drag whose fader is off screen.
    h.view.refresh();
    expect(fader.isConnected).toBe(false);
    window.dispatchEvent(new PointerEvent("pointermove", { clientY: 20, pointerId: 1 }));
    expect(main("ch1")).toBe(moved);
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
  });

  // The other end with no pointerup behind it. Measured 2026-08-14 on Chromium (over its
  // own DevTools socket) and on the shipping WKWebView (macOS 26.6.1, packaged 1.8.3): a
  // window that loses the foreground with the button down gets `blur`, no `pointercancel`,
  // and keeps the capture — so the drag went on writing levels to the plan and out to the
  // unit while another application was frontmost. No E2E tier can reproduce the cause
  // (Playwright emulates focus), and the readings here are a plan value and the element's
  // capture, so this is the tier that can hold it either way.
  it("ends a fader drag when the window loses focus, but not when a control inside it does", () => {
    h = consoleHost();
    const fader = h.strip("ch1").fader!;
    fader.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientY: 100, pointerId: 1 }),
    );
    window.dispatchEvent(new PointerEvent("pointermove", { clientY: 70, pointerId: 1 }));
    const moved = main("ch1");

    // An element's own blur reaches the window in the capture phase only, and the drag
    // must survive it: focus moves inside the strip while a press is down.
    fader.dispatchEvent(new FocusEvent("blur"));
    window.dispatchEvent(new PointerEvent("pointermove", { clientY: 50, pointerId: 1 }));
    const stillDragging = main("ch1");
    expect(stillDragging).not.toBe(moved);

    window.dispatchEvent(new FocusEvent("blur"));
    window.dispatchEvent(new PointerEvent("pointermove", { clientY: 20, pointerId: 1 }));
    expect(main("ch1")).toBe(stillDragging);

    // And it stays ended when the window comes back with the button still down. The
    // tuning screens' value rows needed a treatment for this (the engine owns their drag
    // and re-acquired it — measured on the unit); a drag the view runs itself cannot,
    // since only a fresh `pointerdown` registers the move handler again.
    window.dispatchEvent(new FocusEvent("focus"));
    window.dispatchEvent(new PointerEvent("pointermove", { clientY: 5, pointerId: 1 }));
    expect(main("ch1")).toBe(stillDragging);
    // And the capture goes with it: on this end no engine drops it, and one left behind
    // routes the next press for that pointer id to this fader instead of to the control
    // the operator pressed.
    expect(fader.hasPointerCapture(1)).toBe(false);
  });

  // The other half of the same registration, and the one nothing else would notice: a
  // drag that ends normally has to stop listening for blurs too. Left registered, every
  // completed drag keeps its closure alive on the window and each later focus loss
  // re-runs all of them — `onEnd` on a knob is `syncPartnerStrip`, i.e. a full re-render
  // per dead gesture, and the detached strip it closes over is never collected.
  // Counted rather than observed through a value: what a leaked listener does on the
  // next blur depends on which control was dragged, and the registration itself is the
  // thing this is about. `listener-scope.test-util` records additions so a suite can
  // take them back; it does not net them off against removals, which is the reading here.
  it("stops listening for a blur once the drag ends", () => {
    h = consoleHost();
    const fader = h.strip("ch1").fader!;
    const realAdd = window.addEventListener;
    const realRemove = window.removeEventListener;
    let armed = 0;
    window.addEventListener = function (this: Window, ...args: Parameters<typeof window.addEventListener>): void {
      if (args[0] === "blur") armed++;
      realAdd.apply(this, args);
    } as typeof window.addEventListener;
    window.removeEventListener = function (this: Window, ...args: Parameters<typeof window.removeEventListener>): void {
      if (args[0] === "blur") armed--;
      realRemove.apply(this, args);
    } as typeof window.removeEventListener;
    try {
      for (const y of [100, 60]) {
        const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientY: y, pointerId: 1 });
        fader.dispatchEvent(down);
        window.dispatchEvent(new PointerEvent("pointermove", { clientY: y - 30, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
      }
    } finally {
      window.addEventListener = realAdd;
      window.removeEventListener = realRemove;
    }
    expect(armed).toBe(0);
  });

  it("steps on a wheel notch and resets on a double-click", () => {
    h = consoleHost();
    const fader = h.strip("ch1").fader!;
    const factory = main("ch1")!;
    wheel(fader, 1);
    expect(main("ch1")).toBeGreaterThan(factory);
    fader.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(main("ch1")).toBe(factory);
  });

  it("arms for MIDI instead of moving while learn is on", () => {
    const armed: string[] = [];
    h = consoleHost({ midi: learnHooks(armed) });
    const fader = h.strip("ch1").fader!;
    const before = main("ch1");
    dragY(fader, 40);
    wheel(fader, 1);
    fader.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(main("ch1")).toBe(before);
    expect(armed.length).toBeGreaterThan(0);
  });

  // STREAMING is meter-only: no fader to wire, and nothing downstream may assume one.
  it("wires nothing on a meter-only strip", () => {
    h = consoleHost();
    const stream = h.strip("bus.stream");
    expect(stream.fader).toBeUndefined();
    expect(stream.root.classList.contains("meter-only")).toBe(true);
    expect(stream.readMtr).toBeTruthy();
  });
});

describe("the main level's three homes", () => {
  // A channel's main level lives on its fixed STEREO send; a fader-only node keeps it
  // in nodeParams.level; the oscillator keeps it under nodeParams.osc. One fader, three
  // places — and the getter and setter have to agree about which.
  it("writes a fader-only node's level onto nodeParams", () => {
    h = consoleHost();
    expect(h.plan.nodeParams["bus.mon1"]?.level).toBe(0);
    key(h.strip("bus.mon1").fader!, "ArrowDown");
    expect(h.plan.nodeParams["bus.mon1"]?.level).toBeLessThan(0);
  });

  // The oscillator has no fader at all — its strip is meter-only and a LEVEL knob
  // stands in, with the ON/OFF on the scribble power LED. So its level is reached
  // through the knob, and a case written against `.fader` here would be asserting on
  // a control that does not exist.
  it("writes the oscillator's level under nodeParams.osc, through its LEVEL knob", () => {
    h = consoleHost();
    const r = h.strip("bus.osc");
    expect(r.fader).toBeUndefined();
    expect(r.root.classList.contains("meter-only")).toBe(true);
    expect(r.root.classList.contains("inactive")).toBe(true); // ships off

    const before = h.plan.nodeParams["bus.osc"]?.osc?.level ?? -14;
    key(r.root.querySelector<HTMLElement>(".con-gain .con-knob")!, "ArrowUp");
    expect(h.plan.nodeParams["bus.osc"]?.osc?.level).toBeGreaterThan(before);
    expect(h.plan.nodeParams["bus.osc"]?.level).toBeUndefined(); // not onto the plain level
  });

  it("writes a channel's level onto its fixed STEREO send", () => {
    h = consoleHost();
    key(h.strip("ch1").fader!, "ArrowDown");
    expect(main("ch1")).toBeLessThan(0);
    expect(h.plan.nodeParams["ch1"]?.level).toBeUndefined(); // NOT onto nodeParams
  });
});

describe("a head knob", () => {
  const knobOf = (id: string): HTMLElement => h.strip(id).root.querySelector<HTMLElement>(".con-gain .con-knob")!;

  it("steps with either arrow axis and shows the formatted value", () => {
    h = consoleHost();
    const knob = knobOf("ch1");
    const before = Number(knob.getAttribute("aria-valuenow"));
    key(knob, "ArrowRight");
    const up = Number(knob.getAttribute("aria-valuenow"));
    expect(up).toBeGreaterThan(before);
    key(knob, "ArrowLeft");
    expect(Number(knob.getAttribute("aria-valuenow"))).toBe(before);
    key(knob, "ArrowUp");
    expect(Number(knob.getAttribute("aria-valuenow"))).toBe(up);
    key(knob, "ArrowDown");
    expect(Number(knob.getAttribute("aria-valuenow"))).toBe(before);
  });

  it("leaves a key it does not handle to the browser", () => {
    h = consoleHost();
    const e = key(knobOf("ch1"), "Tab");
    expect(e.defaultPrevented).toBe(false);
  });

  it("rotates its indicator with the value", () => {
    h = consoleHost();
    const knob = knobOf("ch1");
    const before = knob.style.getPropertyValue("--rot");
    key(knob, "ArrowRight");
    expect(knob.style.getPropertyValue("--rot")).not.toBe(before);
    expect(knob.style.getPropertyValue("--rot")).toMatch(/deg$/);
  });

  it("clamps at both ends rather than running past them", () => {
    h = consoleHost();
    const knob = knobOf("ch1");
    for (let i = 0; i < 200; i++) key(knob, "ArrowUp");
    const top = Number(knob.getAttribute("aria-valuenow"));
    key(knob, "ArrowUp");
    expect(Number(knob.getAttribute("aria-valuenow"))).toBe(top);

    for (let i = 0; i < 400; i++) key(knob, "ArrowDown");
    const bottom = Number(knob.getAttribute("aria-valuenow"));
    key(knob, "ArrowDown");
    expect(Number(knob.getAttribute("aria-valuenow"))).toBe(bottom);
    expect(bottom).toBeLessThan(top);
  });

  it("steps on a wheel notch and resets on a double-click", () => {
    h = consoleHost();
    const knob = knobOf("ch1");
    const factory = Number(knob.getAttribute("aria-valuenow"));
    wheel(knob, 1);
    expect(Number(knob.getAttribute("aria-valuenow"))).toBeGreaterThan(factory);
    knob.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(Number(knob.getAttribute("aria-valuenow"))).toBe(factory);
  });

  it("moves on a drag, upward for upward", () => {
    h = consoleHost();
    const knob = knobOf("ch1");
    const before = Number(knob.getAttribute("aria-valuenow"));
    dragY(knob, 40);
    expect(Number(knob.getAttribute("aria-valuenow"))).toBeGreaterThan(before);
  });

  // Shift rebases both anchors, so entering fine mode mid-drag never jumps the value.
  // The observable is that the same pixels move it less, not the rebase itself.
  //
  // Only a knob that declares a `fine` step has a fine mode at all — measured, the
  // STREAMING delay knob is the one that does, and the channel gain is not. Run on a
  // knob without one, this case compares a value to itself and passes for nothing.
  it("moves a shorter distance in fine mode", () => {
    h = consoleHost();
    const knob = h.strip("bus.stream").root.querySelector<HTMLElement>(".con-gain.has-fine .con-knob")!;
    const start = Number(knob.getAttribute("aria-valuenow"));
    dragY(knob, 30);
    const coarse = Number(knob.getAttribute("aria-valuenow")) - start;
    knob.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(Number(knob.getAttribute("aria-valuenow"))).toBe(start);

    dragY(knob, 30, { shift: true });
    const fine = Number(knob.getAttribute("aria-valuenow")) - start;
    expect(fine).toBeGreaterThan(0);
    expect(fine).toBeLessThan(coarse);
  });

  // Flipping Shift mid-drag rebases both anchors, so the value does not jump — it
  // simply starts mapping at the other rate from where it stood. The rebase costs
  // that one move, which is the observable.
  it("does not jump when fine mode is entered mid-drag", () => {
    h = consoleHost();
    const knob = h.strip("bus.stream").root.querySelector<HTMLElement>(".con-gain.has-fine .con-knob")!;
    knob.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientY: 100, pointerId: 1 }),
    );
    window.dispatchEvent(new PointerEvent("pointermove", { clientY: 70, pointerId: 1 }));
    const coarse = Number(knob.getAttribute("aria-valuenow"));

    // The move that flips Shift only rebases: same pixel position, same value.
    window.dispatchEvent(new PointerEvent("pointermove", { clientY: 70, shiftKey: true, pointerId: 1 }));
    expect(Number(knob.getAttribute("aria-valuenow"))).toBe(coarse);

    window.dispatchEvent(new PointerEvent("pointermove", { clientY: 60, shiftKey: true, pointerId: 1 }));
    expect(Number(knob.getAttribute("aria-valuenow"))).toBeGreaterThan(coarse);
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
  });

  it("arms for MIDI instead of moving while learn is on", () => {
    const armed: string[] = [];
    h = consoleHost({ midi: learnHooks(armed) });
    const knob = knobOf("ch1");
    const before = knob.getAttribute("aria-valuenow");
    dragY(knob, 40);
    wheel(knob, 1);
    knob.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(knob.getAttribute("aria-valuenow")).toBe(before);
    expect(armed.length).toBeGreaterThan(0);
  });
});

describe("a device-locked knob", () => {
  // A PAN-linked MIX bus locks its send pan. The knob still paints the value — hiding
  // it would read as "this send has no pan" — but takes no input at all, from any of
  // the four routes.
  it("paints its value and refuses every input route", () => {
    h = consoleHost();
    (h.plan.nodeParams["bus.mix1"] ??= {}).panLink = true;
    h.view.refresh();
    h.strip("ch1").root.querySelector<HTMLButtonElement>(".con-panbtn")!.click();

    const knob = h.host.querySelector<HTMLElement>(".con-spop .pcol .con-knob")!;
    expect(knob.classList.contains("readonly")).toBe(true);
    expect(knob.getAttribute("aria-disabled")).toBe("true");
    expect(knob.title).toBeTruthy();
    expect(knob.tabIndex).toBe(-1);
    expect(knob.getAttribute("aria-valuenow")).toBeTruthy(); // painted, not blank

    const before = knob.getAttribute("aria-valuenow");
    key(knob, "ArrowRight");
    wheel(knob, 1);
    dragY(knob, 30);
    knob.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(knob.getAttribute("aria-valuenow")).toBe(before);
  });
});

describe("the INS FX chip", () => {
  const chipOf = (id: string): HTMLElement => h.strip(id).root.querySelector<HTMLElement>(".con-ifxface")!;
  const openerOf = (id: string): HTMLElement => h.strip(id).root.querySelector<HTMLElement>(".con-ifxopen")!;
  /** The popover's rows, by the name each one carries. */
  const popRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".con-ifxpop .irow")];
  const popRow = (label: string): HTMLElement => popRows().find((r) => r.querySelector(".nm")?.textContent === label)!;
  /** Open the type popover from a strip's disclosure and pick one effect by name. */
  const pick = (id: string, label: string): void => {
    openerOf(id).click();
    popRow(label).click();
  };

  // The face is a bypass and only a bypass. Holding nothing there is nothing to bypass,
  // so pressing it opens the type list instead of choosing an effect on the operator's
  // behalf — a selector write refills the unit's engine array with that type's defaults
  // and cannot be undone, which is not a thing a press should do by itself.
  it("opens the type popover instead of selecting, on a strip holding nothing", () => {
    h = consoleHost();
    const np = (h.plan.nodeParams["ch1"] ??= {});
    expect(insertFxSelected(np)).toBe(false);
    chipOf("ch1").click();
    expect(insertFxSelected(h.plan.nodeParams["ch1"]!)).toBe(false);
    expect(document.querySelector<HTMLElement>(".con-ifxpop")!.hidden).toBe(false);
    // …and the disclosure beside it opens the same one.
    expect(openerOf("ch1").getAttribute("aria-haspopup")).toBe("menu");
  });

  // Both halves of the pair say which of the three states the strip is in, and they say
  // it without colour: a dashed face and a `+` for nothing held, a solid face and a `▸`
  // once something is.
  it("marks a vacant strip apart from one holding a bypassed effect", () => {
    h = consoleHost();
    expect(chipOf("ch1").classList.contains("vacant")).toBe(true);
    expect(openerOf("ch1").textContent).toBe("+");

    pick("ch1", "Clean");
    expect(chipOf("ch1").classList.contains("vacant")).toBe(false);
    expect(openerOf("ch1").textContent).toBe("▸");
    expect(chipOf("ch1").getAttribute("aria-pressed")).toBe("true");

    chipOf("ch1").click(); // bypass: still held, still solid, still ▸
    expect(chipOf("ch1").getAttribute("aria-pressed")).toBe("false");
    expect(chipOf("ch1").classList.contains("vacant")).toBe(false);
    expect(openerOf("ch1").textContent).toBe("▸");
  });

  // Selecting engages, the way the unit does on a selector write; the face then bypasses
  // and restores without touching the selection.
  it("keeps the selection across an off/on", () => {
    h = consoleHost();
    pick("ch1", "Clean");
    const chosen = h.plan.nodeParams["ch1"]!.insertFx;
    expect(insertFxSelected(h.plan.nodeParams["ch1"]!)).toBe(true);
    expect(h.plan.nodeParams["ch1"]!.insertFxOn).toBe(true);

    chipOf("ch1").click();
    expect(h.plan.nodeParams["ch1"]!.insertFxOn).toBe(false);
    expect(h.plan.nodeParams["ch1"]!.insertFx).toBe(chosen); // still selected, bypassed

    chipOf("ch1").click();
    expect(h.plan.nodeParams["ch1"]!.insertFxOn).toBe(true);
    expect(h.plan.nodeParams["ch1"]!.insertFx).toBe(chosen);
  });

  // No Effect is an entry like any other and is never disabled: it is how a strip gives
  // a slot back, and it has to work from the states where nothing else can be picked.
  it("releases the effect and the slot through No Effect", () => {
    h = consoleHost();
    pick("ch1", "Clean");
    expect(insertFxSelected(h.plan.nodeParams["ch1"]!)).toBe(true);

    pick("ch1", "No Effect");
    expect(insertFxSelected(h.plan.nodeParams["ch1"]!)).toBe(false);
    expect(h.plan.nodeParams["ch1"]!.insertFxOn).toBe(false);
    expect(chipOf("ch1").classList.contains("vacant")).toBe(true);
    expect(openerOf("ch1").textContent).toBe("+");
  });

  // The slot is device-wide, so what one strip takes another cannot — said on the entry
  // itself rather than by leaving it absent.
  it("greys an effect another strip is holding, and names why", () => {
    h = consoleHost();
    pick("ch1", "Clean");
    openerOf("ch2").click();
    const taken = popRow("Clean");
    expect(taken.classList.contains("off")).toBe(true);
    expect(taken.getAttribute("aria-disabled")).toBe("true");
    expect(taken.title).toBe(t().inspector.insFxSlotLocked);
    // …and No Effect beside it is still live.
    expect(popRow("No Effect").classList.contains("off")).toBe(false);
  });

  // The screen shows what is selected, so there is nothing for it to show until something
  // is — and a bypassed or rate-stopped effect is still an effect to tune.
  it("offers the tuning screen only once an effect is held", () => {
    h = consoleHost();
    openerOf("ch1").click();
    const launcher = (): HTMLElement => document.querySelector<HTMLElement>(".con-ifxpop .iopen")!;
    expect(launcher().classList.contains("off")).toBe(true);
    expect(launcher().getAttribute("aria-disabled")).toBe("true");

    popRow("Clean").click();
    openerOf("ch1").click();
    expect(launcher().classList.contains("off")).toBe(false);
    expect(launcher().getAttribute("aria-disabled")).toBeNull();
  });

  // A plan can hold an insert-FX value the node's own control does not carry: a file, a
  // `?plan=` link and a device read all land one, and the loader gates none of them. The
  // emit path turns it into No Effect and writes neither the engine array nor the bypass,
  // so a chip driven from the raw plan value reports a strip as bypassing an effect that
  // never reaches the unit — and pressing it writes a bypass nothing will ever send.
  describe.each([
    ["a channel holding an OUTPUT-only effect", "ch1", "M.B.Comp", OUTPUT_INSERT_FX_OPTIONS],
    ["a bus holding a CHANNEL-only effect", "bus.mix1", "Pitch Fix", INSERT_FX_OPTIONS],
  ])("%s", (_name, id, label, options) => {
    const load = (): void => {
      const plan = defaultPlan("URX44V");
      plan.sampleRate = 48000;
      plan.nodeParams[id] = {
        ...plan.nodeParams[id],
        insertFx: options.find((o) => o.label === label)!.value,
        insertFxOn: true,
      };
      h = consoleHost({ plan });
    };

    it("reads VACANT, the way No Effect does", () => {
      load();
      // Not merely unlit: the face says the strip holds nothing, which is what the emit
      // path will act on, and the disclosure offers a choice rather than a way in. It is
      // announced as a menu button and NOT as an unpressed switch — there is no insert
      // here to be in or out, and saying "not pressed" would describe one that is out.
      expect(chipOf(id).classList.contains("vacant")).toBe(true);
      expect(chipOf(id).getAttribute("aria-pressed")).toBeNull();
      expect(chipOf(id).getAttribute("aria-haspopup")).toBe("menu");
      expect(openerOf(id).textContent).toBe("+");
    });

    it("takes a real effect through the popover, instead of writing a bypass", () => {
      load();
      const stale = h.plan.nodeParams[id]!.insertFx;
      // Nothing is marked as held, because the value the emit path sees is No Effect.
      openerOf(id).click();
      expect(
        popRows()
          .filter((r) => r.classList.contains("active"))
          .map((r) => r.querySelector(".nm")!.textContent),
      ).toEqual(["No Effect"]);
      popRows()
        .find((r) => !r.classList.contains("off") && r.querySelector(".nm")!.textContent !== "No Effect")!
        .click();
      const now = h.plan.nodeParams[id]!;
      expect(now.insertFx).not.toBe(stale);
      // …from THIS node's own control, asked of the mapping the app itself goes through
      // rather than of the foreign list the stale value came from: the two overlap on the
      // companders, so "not in theirs" passes for a value that is in both and says nothing
      // about where it came from.
      const own = insertFxControl(getModel("URX44V"), id)!.options;
      expect(own.some((o) => o.value === now.insertFx)).toBe(true);
      expect(insertFxSelected(now)).toBe(true);
      expect(now.insertFxOn).toBe(true);
      // The half that says the press was not merely cosmetic: the selector the unit is
      // given now carries the chosen effect, where the stale value was sent as No Effect.
      // Asserted on the SELECTOR and not on the engine array — translate writes only the
      // slots the plan carries, and a freshly chosen effect carries none, so a count there
      // would be zero for the right reason and prove nothing.
      const sent = planToCommands(getModel("URX44V"), h.plan)
        .filter((c) => c.name === "INSERT_FX")
        .map((c) => c.planValue);
      expect(sent).toContain(now.insertFx);
      expect(sent).not.toContain(stale);
    });
  });

  // The positive control for the pair above: an effect the node's own control DOES carry
  // keeps the chip a bypass, so a gate that reported OFF for everything cannot pass.
  it("stays a bypass for an effect the node's own control carries", () => {
    const plan = defaultPlan("URX44V");
    plan.sampleRate = 48000;
    plan.nodeParams["bus.mix1"] = {
      ...plan.nodeParams["bus.mix1"],
      insertFx: OUTPUT_INSERT_FX_OPTIONS.find((o) => o.label === "M.B.Comp")!.value,
      insertFxOn: true,
    };
    h = consoleHost({ plan });
    const held = h.plan.nodeParams["bus.mix1"]!.insertFx;
    expect(chipOf("bus.mix1").getAttribute("aria-pressed")).toBe("true");
    chipOf("bus.mix1").click();
    expect(h.plan.nodeParams["bus.mix1"]!.insertFxOn).toBe(false);
    expect(h.plan.nodeParams["bus.mix1"]!.insertFx).toBe(held);
  });

  // A strip holding NOTHING is locked too above every ceiling, and the reason it gives has
  // to be the rate: no effect is free because none of them runs, not because another strip
  // took the slot. The per-effect reading has to keep answering that question for a strip
  // with no effect of its own to ask it about.
  it("names the rate, not the slots, on a strip holding nothing above every ceiling", () => {
    const plan = defaultPlan("URX44V");
    plan.sampleRate = 192000;
    h = consoleHost({ plan });
    expect(chipOf("ch1").title).toBe(t().inspector.insFxRateLocked);
    // …on a face that is INERT, with no disclosure beside it at all. The list behind them
    // is how a strip gives its slot back, but a strip holding nothing has none to give and
    // its one selectable row is the No Effect it already is. The face keeps the reason and
    // stays; the way IN to a list with nothing in it is dropped rather than drawn disabled.
    expect(chipOf("ch1").classList.contains("readonly")).toBe(true);
    expect(chipOf("ch1").getAttribute("aria-disabled")).toBe("true");
    expect(h.strip("ch1").root.querySelector(".con-ifxopen")).toBeNull();
    chipOf("ch1").click();
    expect(document.querySelector<HTMLElement>(".con-ifxpop")!.hidden).toBe(true);
  });

  it("keeps the disclosure live on a strip HOLDING an effect the rate forced off", () => {
    // The other half, and the reason the lock above is asked of the vacant case alone:
    // choosing No Effect here is how the device-wide slot this strip still claims is given
    // back, so an operator who cannot reach the list cannot free it without changing rate.
    const plan = defaultPlan("URX44V");
    plan.sampleRate = 192000;
    plan.nodeParams["ch1"] = { insertFx: INSERT_FX_OPTIONS.find((o) => o.label === "Clean")!.value };
    h = consoleHost({ plan });
    const open = h.strip("ch1").root.querySelector<HTMLElement>(".con-ifxopen")!;
    expect(open).not.toBeNull();
    expect(open.classList.contains("readonly")).toBe(false);
    open.click();
    expect(document.querySelector<HTMLElement>(".con-ifxpop")!.hidden).toBe(false);
    expect(popRow("No Effect").classList.contains("off")).toBe(false);
  });

  // The ceilings are per effect, so the rate that switches a strip off depends on what
  // that strip holds. 88.2 kHz is above Pitch Fix's 48 and below the amps' and companders'
  // 96: a menu-wide reading says every effect still runs and leaves the chip live, which
  // is a bypass toggle over DSP the unit has already dropped.
  it("locks off a strip holding an effect the rate rules out, while its neighbours run", () => {
    const plan = defaultPlan("URX44V");
    plan.sampleRate = 88200;
    plan.nodeParams["ch1"] = { insertFx: INSERT_FX_OPTIONS.find((o) => o.label === "Pitch Fix")!.value };
    plan.nodeParams["ch2"] = { insertFx: INSERT_FX_OPTIONS.find((o) => o.label === "Clean")!.value };
    h = consoleHost({ plan });

    expect(chipOf("ch1").getAttribute("aria-disabled")).toBe("true");
    expect(chipOf("ch1").getAttribute("aria-pressed")).toBe("false");
    expect(chipOf("ch1").title).toContain("Pitch Fix");
    expect(chipOf("ch1").title).toContain("48 kHz");

    expect(chipOf("ch2").getAttribute("aria-disabled")).toBeNull();
  });
});

describe("a BAL-linked pair", () => {
  const linkPair = (): void => {
    Object.assign((h.plan.nodeParams["ch1"] ??= {}), { stereoLink: true, panBal: PAN_BAL_BAL });
    h.view.refresh();
  };

  // The partner's fader is repainted in place rather than rebuilt: a rebuild during a
  // drag would take the focus and the pointer capture with it.
  it("mirrors the main fader onto the partner in place", () => {
    h = consoleHost();
    linkPair();
    const partner = h.strip("ch2").fader!;
    const before = main("ch2");
    key(h.strip("ch1").fader!, "ArrowDown");
    expect(partner.isConnected).toBe(true);
    expect(h.strip("ch2").fader).toBe(partner);
    expect(main("ch2")).not.toBe(before);
    expect(main("ch2")).toBe(main("ch1"));
    // …and the partner's own cap moved with it. `aria-valuenow` is rounded, so one
    // detent off 0 dB leaves it reading "0" either way — the cap is what shows.
    expect(partner.parentElement!.querySelector<HTMLElement>(".cap")!.style.getPropertyValue("--pos")).toBeTruthy();
  });

  // A knob is different: the partner's whole head can change, so the view rebuilds
  // once after the gesture instead of patching one attribute.
  it("rebuilds after a knob edit so the partner's head catches up", () => {
    h = consoleHost();
    linkPair();
    const before = h.strip("ch2").root;
    key(h.strip("ch1").root.querySelector<HTMLElement>(".con-gain .con-knob")!, "ArrowRight");
    expect(h.strip("ch2").root).not.toBe(before);
  });

  it("leaves an unlinked pair alone", () => {
    h = consoleHost();
    const before = main("ch2");
    key(h.strip("ch1").fader!, "ArrowDown");
    expect(main("ch2")).toBe(before);
  });
});

describe("the meter stream", () => {
  it("paints a reading onto the strip's lanes and readout", () => {
    h = consoleHost({ live: true });
    const r = h.strip("ch1");
    expect(r.readMtr.textContent).toBe("—"); // nothing streamed yet, not "silent"

    (h.view as unknown as { store: { apply: (m: unknown) => void } }).store.apply({ meterId: 115, x: 0, value: -100 });
    h.frame();
    expect(r.readMtr.textContent).toBe("-10.0");
  });

  // Leaving live has to clear the readings: a stale number under a dead stream reads
  // as a live signal.
  it("clears the readout when the session ends", () => {
    h = consoleHost({ live: true });
    (h.view as unknown as { store: { apply: (m: unknown) => void } }).store.apply({ meterId: 115, x: 0, value: -100 });
    h.frame();
    h.view.setLive(false);
    expect(h.strip("ch1").readMtr.textContent).toBe("—");
  });
});

// The INS FX popover's own half of the focus rule, plus the case the other two do not
// have: choosing an effect REBUILDS the strip, so the element the focus should return to
// is not the one that was pressed — and at a rate that empties the menu, the disclosure is
// dropped altogether, which is where the focus fell to <body>.
describe("where the focus goes after the INS FX popover closes", () => {
  const chipOf = (id: string): HTMLElement => h.strip(id).root.querySelector<HTMLElement>(".con-ifxface")!;
  const openerOf = (id: string): HTMLElement | null => h.strip(id).root.querySelector<HTMLElement>(".con-ifxopen");
  const popRow = (label: string): HTMLElement =>
    [...document.querySelectorAll<HTMLElement>(".con-ifxpop .irow")].find(
      (r) => r.querySelector(".nm")?.textContent === label,
    )!;

  it("returns it to the disclosure on Escape", () => {
    h = consoleHost();
    openerOf("ch1")!.click();
    expect(document.querySelector<HTMLElement>(".con-ifxpop")!.hidden).toBe(false);
    key(document.body, "Escape");
    expect(document.activeElement).toBe(openerOf("ch1"));
  });

  // Releasing rather than choosing: picking an effect opens its tuning screen, which is
  // where the focus goes and is the app's own hook rather than this view's business. No
  // Effect opens nothing, so the strip it rebuilt is what the operator is left on.
  it("lands on the rebuilt strip's own disclosure after releasing an effect", () => {
    h = consoleHost();
    openerOf("ch1")!.click();
    popRow("Clean").click();
    const before = openerOf("ch1");
    openerOf("ch1")!.click();
    popRow("No Effect").click();
    // A different element: the selection re-rendered the strip.
    expect(openerOf("ch1")).not.toBe(before);
    expect(document.activeElement).toBe(openerOf("ch1"));
  });

  // At 192 kHz nothing in the menu runs, so the disclosure is dropped — there is nothing
  // behind it to open. The FACE stays, read-only with its reason, and it is the anchor.
  const releaseAt192 = (): void => {
    openerOf("ch1")!.click();
    popRow("Clean").click();
    h.plan.sampleRate = 192000;
    h.view.refresh();
    openerOf("ch1")?.click();
    if (!document.querySelector<HTMLElement>(".con-ifxpop")!.hidden) popRow("No Effect").click();
  };

  it("falls back to the face where the rate has dropped the disclosure", () => {
    h = consoleHost();
    releaseAt192();
    expect(openerOf("ch1"), "the ceiling empties the menu, so the disclosure goes").toBeNull();
    expect(document.activeElement, "and the face is what the operator is left on").toBe(chipOf("ch1"));
  });

  // …and it survives the NEXT rebuild. The face is `tabindex="-1"` — present, not tabbable
  // — so the index the rebuild's focus carry-over keys by comes back empty and the focus
  // goes to <body>. A device-follow repaint of the same channel is enough to trigger it, so
  // without this the place the view just handed the operator does not outlive the next
  // thing the unit says. Both repaint paths, because they are different entry points.
  for (const [what, repaint] of [
    ["one strip", (): void => h.view.refreshStrip("ch1")],
    ["the whole rack", (): void => h.view.refresh()],
  ] as const) {
    it(`keeps the operator on that face across a repaint of ${what}`, () => {
      h = consoleHost();
      releaseAt192();
      expect(document.activeElement).toBe(chipOf("ch1"));
      repaint();
      expect(document.activeElement, "the face in the REBUILT strip").toBe(chipOf("ch1"));
    });
  }

  // The INS FX popover's own half of the whole-rack rule, and the case the other two do not
  // have: `refreshStrip` RE-OPENS this one against the fresh strip, so the row is still
  // there and the focus goes back to it rather than out to the trigger. One rule decides
  // both by asking what the rebuild actually did.
  it("returns it to the trigger when a whole-rack repaint closes the list", () => {
    h = consoleHost();
    openerOf("ch1")!.click();
    const row = document.querySelector<HTMLElement>(".con-ifxpop .irow");
    row?.focus();
    expect(document.querySelector<HTMLElement>(".con-ifxpop")!.contains(document.activeElement)).toBe(true);
    h.view.refresh();
    expect(document.querySelector<HTMLElement>(".con-ifxpop")!.hidden, "the repaint closed it").toBe(true);
    expect(document.activeElement).toBe(openerOf("ch1"));
  });

  it("keeps it on the same row when a one-strip repaint re-opens the list", () => {
    h = consoleHost();
    openerOf("ch1")!.click();
    const rows = () => [...document.querySelectorAll<HTMLElement>(".con-ifxpop .irow")];
    const idx = 1;
    rows()[idx].focus();
    h.view.refreshStrip("ch1");
    expect(document.querySelector<HTMLElement>(".con-ifxpop")!.hidden, "still open").toBe(false);
    expect(document.activeElement, "the same row of the rebuilt list").toBe(rows()[idx]);
  });

  // The SAME two rules asked of the other selector the one popover now serves. An FX strip
  // carries `.con-fxopen` / `.con-fxface` and neither INS FX class, so a focus table naming
  // only the INS FX pair finds nothing on it and the browser parks focus on <body>.
  const fxOpenerOf = (id: string): HTMLElement | null => h.strip(id).root.querySelector<HTMLElement>(".con-fxopen");

  it("returns it to the FX disclosure when a whole-rack repaint closes the type list", () => {
    h = consoleHost();
    fxOpenerOf("bus.fx1")!.click();
    const row = document.querySelector<HTMLElement>(".con-ifxpop .irow");
    row?.focus();
    expect(document.querySelector<HTMLElement>(".con-ifxpop")!.contains(document.activeElement)).toBe(true);
    h.view.refresh();
    expect(document.querySelector<HTMLElement>(".con-ifxpop")!.hidden, "the repaint closed it").toBe(true);
    expect(document.activeElement, "not the document body").toBe(fxOpenerOf("bus.fx1"));
  });

  it("keeps it on the same row when a one-strip repaint re-opens the FX type list", () => {
    h = consoleHost();
    fxOpenerOf("bus.fx1")!.click();
    const rows = () => [...document.querySelectorAll<HTMLElement>(".con-ifxpop .irow")];
    const idx = 1;
    rows()[idx].focus();
    h.view.refreshStrip("bus.fx1");
    expect(document.querySelector<HTMLElement>(".con-ifxpop")!.hidden, "still open").toBe(false);
    expect(document.activeElement, "the same row of the rebuilt list").toBe(rows()[idx]);
  });

  // The floor under both, keyed the same way: a strip carrying neither control still keeps
  // the operator's place rather than sending them to the top of the document.
  it("keeps the operator on the strip root across a repaint", () => {
    h = consoleHost();
    const root = h.strip("ch1").root;
    root.focus();
    expect(document.activeElement).toBe(root);
    h.view.refreshStrip("ch1");
    expect(document.activeElement).toBe(h.strip("ch1").root);
  });
});
