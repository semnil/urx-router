// @vitest-environment jsdom

// Every id an arming surface can hand to `arm()` is one the catalog binds.
//
// `MidiControl.arm` refuses an id `bindControl` cannot resolve, so drift fails at
// arm time rather than persisting a mapping that is dead on receive. That refusal
// is meant to be unreachable, and `e2e/race/t4b-midi.spec.ts` skips its case for
// exactly that reason — a reason that dates itself, since it holds only while the
// surfaces agree with the catalog.
//
// `src/core/midi/controls.test.ts` holds the catalog's own half: every id it LISTS,
// it binds. That is not this. The surfaces do not read `listControls` — console.ts
// composes ids from the strip it is drawing, and dyn-screen.ts asks the processor's
// `controlId` hook — so an id can reach `arm()` that the catalog never offered.
// This drives both surfaces and binds everything they produce.
//
// Enumeration goes through `.midi-target`, the class `markMidi` puts on a control
// while learn is on. That is the app's own answer to "is this armable", so a control
// added without one is invisible here — and also invisible to the operator, who
// cannot tell it is assignable.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/meters", async (importOriginal) => {
  const real = await importOriginal<typeof import("../core/meters")>();
  return { ...real, subscribeMeters: () => Promise.resolve(() => {}) };
});

import { consoleHost } from "./console.test-util";
import type { ConsoleHost } from "./console.test-util";
import { dynHost } from "./dyn-screen.test-util";
import type { DynHost } from "./dyn-screen.test-util";
import { DynScreen } from "./dyn-screen";
import { DYN_PROCESSORS } from "./dyn-registry";
import type { DynCtx } from "./dyn-screen";
import { bindControl } from "../core/midi/controls";
import { setLang, t } from "../i18n";

/** Learn is on, nothing is armed or mapped: every armable control marks itself. */
const learnHooks = (armed: string[]) => ({
  learnActive: () => true,
  armedId: () => null,
  isMapped: () => false,
  addrOf: () => null,
  arm: (id: string) => void armed.push(id),
});

/** Press every control the surface marked as armable. Returns how many it marked and
 *  the distinct ids they armed — the count separately, because a surface that marks
 *  nothing arms nothing, and the two mean opposite things.
 *
 *  Marking and arming are separate calls at every site (`markMidi` and `armOnActivate`
 *  or the view's own handler), so a control can carry the ring and reach nothing. The
 *  callers below compare the two counts, which is the only way that shows. */
function armEverything(root: HTMLElement, armed: string[]): { marked: number; ids: string[] } {
  const targets = root.querySelectorAll<HTMLElement>(".midi-target");
  for (const el of targets) {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientY: 100, pointerId: 1 }));
    // A chip arms from its click, a fader from its pointerdown; sending both costs
    // nothing here and keeps this blind to which path a given control uses.
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }
  window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
  return { marked: targets.length, ids: [...new Set(armed)] };
}

let ch: ConsoleHost | undefined;
let dh: DynHost | undefined;

beforeEach(() => {
  setLang("en");
  localStorage.clear();
});

afterEach(() => {
  ch?.restore();
  dh?.restore();
  ch = dh = undefined;
  document.body.replaceChildren();
});

describe("arming surfaces against the control catalog", () => {
  it.each(["URX22", "URX44", "URX44V"] as const)("CONSOLE arms only bindable ids on %s", (modelId) => {
    const armed: string[] = [];
    ch = consoleHost({ modelId, midi: learnHooks(armed) });
    let marked = 0;
    const first = armEverything(ch.host, armed);
    marked += first.marked;

    // The SEND PAN knobs exist only while their popover is open, and the view keeps one
    // open at a time — so each button is opened in turn and its own knobs pressed. They
    // are the case with two independent statements of the same rule (the popover asks
    // `isMixBus && hasSend`, the catalog lists mix1/mix2), which is exactly where a
    // drift shows up as a ring that arms nothing.
    const openers = [...ch.host.querySelectorAll<HTMLElement>(".con-panbtn")];
    expect(openers.length).toBeGreaterThan(0);
    const pop = (): HTMLElement => {
      const el = ch!.host.querySelector<HTMLElement>(".con-spop");
      if (!el) throw new Error(".con-spop is missing — the popover host is built with the view");
      return el;
    };
    for (const btn of openers) {
      // The click TOGGLES, so a popover already open would be closed by it and the pass
      // would contribute nothing while the totals still matched. Each button therefore
      // asserts its own contribution rather than trusting the run's total.
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      const opened = armEverything(pop(), armed);
      expect(opened.marked, "a SEND PAN popover opened with no armable control").toBeGreaterThan(0);
      marked += opened.marked;
    }

    const ids = [...new Set(armed)];
    expect(marked).toBeGreaterThan(0);
    expect(ids.length).toBeGreaterThan(0);
    // Every marked control armed something: marking and arming are separate calls, and
    // a ring on a control that arms nothing is the defect this file exists for.
    expect(ids.length).toBe(marked);
    expect(ids.filter((id) => !bindControl(ch!.model, ch!.plan, id))).toEqual([]);
  });

  // Every registered processor, on the first node it will bind to — so a processor
  // added to dyn-registry.ts is covered the day it is registered rather than when
  // someone remembers to list it here.
  //
  // A processor without a `controlId` hook is the other half of the same rule, and
  // DUCKER is one: the catalog carries a ducker's `duckerOn` and nothing else, so
  // its four sliders have no id to arm and the screen must mark none of them. Marked
  // and unarmable is the defect either way round — a control that says "assignable"
  // and then does nothing is worse than one that never offered.
  it.each(Object.keys(DYN_PROCESSORS) as Array<keyof typeof DYN_PROCESSORS>)(
    "the %s tuning screen marks exactly what it can arm",
    (kind) => {
      const armed: string[] = [];
      dh = dynHost({ midi: learnHooks(armed), plotSize: { w: 300, h: 120 } });
      const proc = DYN_PROCESSORS[kind];
      // The host's own model and plan, not a fresh pair: `bind` is asked of one document
      // and the assertion made against another otherwise, and they would drift silently
      // the day a case passes `opts.plan`. (It also stopped ~88 throwaway clones.)
      const { model, plan } = dh;
      const ctxAt = (nodeId: string): DynCtx => ({ model, plan, nodeId, sel: 0, m: t() });
      const nodeId = model.nodes.map((n) => n.id).find((id) => proc.bind(ctxAt(id)) !== null);
      expect(nodeId, `${kind} binds no node of URX44V`).toBeTruthy();

      const screen = new DynScreen(dh.hooks);
      screen.open(proc, nodeId!);
      expect(screen.isOpen()).toBe(true);
      const { marked, ids } = armEverything(dh.box, armed);
      if (proc.controlId) {
        expect(marked).toBeGreaterThan(0);
        expect(ids.length).toBeGreaterThan(0);
        // Same equality as the CONSOLE case: a screen that marks five rows and arms one
        // is the defect, and only the counts show it.
        expect(ids.length).toBe(marked);
        expect(ids.filter((id) => !bindControl(model, plan, id))).toEqual([]);
      } else {
        expect(marked).toBe(0);
        expect(ids).toEqual([]);
      }
      screen.close();
    },
  );
});
