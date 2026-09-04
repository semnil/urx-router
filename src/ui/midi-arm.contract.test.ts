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
import { COMP_EQ_SSMCS, INSERT_FX_OPTIONS } from "../core/control/params";
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
    // One mono channel into the morphing bank BEFORE the view is built, so its own chip
    // is among the marked ones. Without it the strip carries no SSMCS chip and this case
    // cannot see whether that chip's id binds — the catalog offers it under the same
    // condition the chip appears under, and the two agreeing has nothing else checking it.
    const plan = defaultPlan(modelId);
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, compEqType: COMP_EQ_SSMCS };
    ch = consoleHost({ modelId, plan, midi: learnHooks(armed) });
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

  // The case above compares two counts, and both of them count only controls that MARKED
  // themselves — so a chip carrying no id at all is absent from each side and the totals
  // still agree. That is the shape the FX strip's EFFECT face had: a toggle the CONSOLE
  // draws, in the row where every other face arms, offering nothing. It has to be named to
  // be seen, which is what this does.
  // The same shape on the other face in that row, and the same reason it has to be named: a
  // chip carrying no id is absent from both sides of the marked-versus-armed comparison, so
  // the counts agree and nothing is red. This one needs a plan HOLDING an effect — with none
  // the strip draws an opener where the face would be, and there is no bypass to switch.
  it("marks and binds the INS FX face by name, and only while an effect is held", () => {
    const armed: string[] = [];
    const plan = defaultPlan("URX44V");
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, insertFx: INSERT_FX_OPTIONS[1].value };
    ch = consoleHost({ modelId: "URX44V", plan, midi: learnHooks(armed) });
    const face = ch.strip("ch1").root.querySelector<HTMLElement>(".con-ifxface");
    if (!face) throw new Error(".con-ifxface is missing — the strip draws no INS FX chip");
    expect(face.classList.contains("midi-target"), "the INS FX face offers itself").toBe(true);
    face.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(armed, "and arms exactly one id").toEqual(["ch1/insertFxOn"]);
    expect(bindControl(ch.model, ch.plan, armed[0]), "which the catalog binds").toBeTruthy();

    // The other half: a strip holding NOTHING draws the vacant chip, which opens the popover
    // rather than switching anything, and offers no id at all. Marked here would be a ring on
    // a control that reaches nothing — the defect this file exists for, the other way round.
    ch.restore();
    const empty: string[] = [];
    ch = consoleHost({ modelId: "URX44V", midi: learnHooks(empty) });
    const vacant = ch.strip("ch1").root.querySelector<HTMLElement>(".con-ifxface");
    expect(vacant?.classList.contains("vacant"), "the factory strip holds none").toBe(true);
    expect(vacant?.classList.contains("midi-target"), "so it offers nothing").toBe(false);
    expect(bindControl(ch.model, ch.plan, "ch1/insertFxOn"), "and the catalog has no such id").toBeNull();
  });

  it("marks and binds the FX strip's EFFECT face by name", () => {
    const armed: string[] = [];
    ch = consoleHost({ modelId: "URX44V", midi: learnHooks(armed) });
    const face = ch.strip("bus.fx1").root.querySelector<HTMLElement>(".con-fxface");
    if (!face) throw new Error(".con-fxface is missing — the FX strip draws no EFFECT chip");
    expect(face.classList.contains("midi-target"), "the EFFECT face offers itself").toBe(true);
    face.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(armed, "and arms exactly one id").toEqual(["bus.fx1/fx@fx.on"]);
    expect(bindControl(ch.model, ch.plan, armed[0]), "which the catalog binds").toBeTruthy();
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
      // ONE mono channel into the morphing bank, so both banks have somewhere to bind:
      // a default plan carries no SSMCS channel at all, and putting every mono channel
      // into it would leave COMP and the 4-band EQ with nothing.
      plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, compEqType: COMP_EQ_SSMCS };
      // The INS FX screen is one registry entry standing for several effect families, and
      // a default plan holds none of them — `bind` answers null everywhere until something
      // is selected, and one open would exercise only whichever family was seeded first.
      // Three different slots, so all three can be held at once.
      if (kind === "insfx") {
        for (const [nodeId, label] of [
          ["ch1", "Clean"],
          ["ch2", "Pitch Fix"],
          ["ch3", "Compander-H"],
        ] as const) {
          plan.nodeParams[nodeId] = {
            ...plan.nodeParams[nodeId],
            insertFx: INSERT_FX_OPTIONS.find((o) => o.label === label)!.value,
          };
        }
      }
      const ctxAt = (nodeId: string): DynCtx => ({ model, plan, nodeId, sel: 0, m: t() });
      const binding = model.nodes.map((n) => n.id).filter((id) => proc.bind(ctxAt(id)) !== null);
      expect(binding.length, `${kind} binds no node of URX44V`).toBeGreaterThan(0);
      // Every node it binds for the two kinds that show a different thing on each; the
      // first for the rest, whose faces do not vary by node.
      //
      // `fx` is the second: its two channels hold different effects out of the factory —
      // FX1 a Rev-X and FX2 a Mono Delay — so opening both is what puts a face carrying a
      // toggle and a select (the delay's Sync and Note) in front of this, beside one that
      // is knobs alone. Opening only the first covered no non-slider row at all. The third
      // family, Rev.R3, is not reachable without seeding a type and adds no control KIND
      // that Rev-X does not already put here: every row of both reverbs is a slider.
      const nodeIds = kind === "insfx" || kind === "fx" ? binding : binding.slice(0, 1);

      /** One face's own verdict. Per face rather than per screen: the counts have to
       *  match on each, and totals let a face that marks nothing hide behind one that
       *  marks twice. */
      const host = dh;
      const checkFace = (where: string): void => {
        armed.length = 0;
        const { marked, ids } = armEverything(host.box, armed);
        if (proc.controlId) {
          expect(marked, where).toBeGreaterThan(0);
          expect(ids.length, where).toBeGreaterThan(0);
          // Same equality as the CONSOLE case: a screen that marks five rows and arms one
          // is the defect, and only the counts show it.
          expect(ids.length, where).toBe(marked);
          expect(
            ids.filter((id) => !bindControl(model, plan, id)),
            where,
          ).toEqual([]);
        } else {
          expect(marked, where).toBe(0);
          expect(ids, where).toEqual([]);
        }
      };

      for (const nodeId of nodeIds) {
        const screen = new DynScreen(host.hooks);
        screen.open(proc, nodeId);
        expect(screen.isOpen()).toBe(true);
        checkFace(nodeId);
        // …and every OTHER face its bar offers. A face is a different set of slots — the
        // multi-band compressor's three band faces carry twelve the first one does not —
        // and opening at the default `sel` alone leaves those unchecked, which is the same
        // silence this file exists to break.
        for (const item of proc.bar?.(ctxAt(nodeId))?.items ?? []) {
          host.box.querySelector<HTMLElement>(`#${item.id}`)?.click();
          checkFace(`${nodeId} / ${item.label}`);
        }
        screen.close();
      }
    },
  );
});
