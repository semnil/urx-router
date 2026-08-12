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
import { getModel } from "../models";
import { defaultPlan } from "../models/initial-state";
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
 *  nothing arms nothing, and the two mean opposite things. */
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
    const { marked, ids } = armEverything(ch.host, armed);
    expect(marked).toBeGreaterThan(0);
    expect(ids.length).toBeGreaterThan(0);
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
      const model = getModel("URX44V");
      const ctxAt = (nodeId: string): DynCtx => ({ model, plan: defaultPlan("URX44V"), nodeId, sel: 0, m: t() });
      const nodeId = model.nodes.map((n) => n.id).find((id) => proc.bind(ctxAt(id)) !== null);
      expect(nodeId, `${kind} binds no node of URX44V`).toBeTruthy();

      const screen = new DynScreen(dh.hooks);
      screen.open(proc, nodeId!);
      expect(screen.isOpen()).toBe(true);
      const { marked, ids } = armEverything(dh.box, armed);
      if (proc.controlId) {
        expect(marked).toBeGreaterThan(0);
        expect(ids.length).toBeGreaterThan(0);
        expect(ids.filter((id) => !bindControl(model, dh!.plan, id))).toEqual([]);
      } else {
        expect(marked).toBe(0);
        expect(ids).toEqual([]);
      }
      screen.close();
    },
  );
});
