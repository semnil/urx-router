// The host a CONSOLE view needs to run in, assembled for a unit test. Not a test
// file itself (vitest collects only *.test.ts), so suites import it rather than
// re-declaring the setup.
//
// `Console` reaches for four things jsdom does not provide: pointer capture, a
// measurable box for every control it drags against, `offsetWidth`/`offsetHeight`
// for the two popovers it positions, and a frame clock for the meter loop. All four
// are installed here as the thinnest thing that answers truthfully — the boxes are
// real numbers rather than zeros, because a fader whose travel measures zero divides
// by a negative and every drag lands on the same value, which passes as "the drag
// did nothing" for the wrong reason.
//
// The strips carry no id in the DOM (the view addresses them through its own `refs`
// map), so the locators here go through that map as well rather than inventing a
// second addressing scheme the view would not keep in step.

import { recordWindowListeners } from "./listener-scope.test-util";
import { Console } from "./console";
import type { ConsoleHooks, ConsoleMidiHooks } from "./console";
import { getModel } from "../models";
import { defaultPlan } from "../models/initial-state";
import type { DeviceModel } from "../models/types";
import type { Plan } from "../core/plan";

/** The private strip record the view keeps, narrowed to what a test addresses. */
export interface StripHandle {
  root: HTMLElement;
  fader?: HTMLElement;
  cap?: HTMLElement;
  readMtr: HTMLElement;
  readDb?: HTMLElement;
  /** The meter tap this strip's meter is showing, or null where the node has none. */
  tap: { key: string } | null;
  sendCols?: Array<{ target: string; fader: HTMLElement; cap: HTMLElement }>;
}

export interface ConsoleHost {
  view: Console;
  host: HTMLElement;
  model: DeviceModel;
  plan: Plan;
  /** How many times the view ran the shared change funnel. */
  changes: () => number;
  /** Meter-stream errors the view surfaced. */
  meterErrors: string[];
  /** Tuning screens the view asked the app to open. */
  opened: Array<{ kind: string; id: string }>;
  /** The strip record for a node id — the view's own `refs` entry. */
  strip: (id: string) => StripHandle;
  /** One send column of a strip, by send target ("bus.mix1", "fx1", …). */
  sendCol: (id: string, target: string) => { target: string; fader: HTMLElement; cap: HTMLElement };
  /** Run every frame callback queued so far — one paint pass. */
  frame: () => void;
  /** Undo the globals this host installed, and drop the view. */
  restore: () => void;
}

export interface ConsoleHostOptions {
  modelId?: "URX22" | "URX44" | "URX44V";
  plan?: Plan;
  live?: boolean;
  midi?: ConsoleMidiHooks;
  /** The box every control measures as, the fader caps excepted (see `capBox`). */
  box?: { width: number; height: number };
  /** The box a fader cap measures as. The one exception to the single box above, and
   *  it has to be one: the main fader asks whether a press landed on its cap, so a cap
   *  as tall as the fader would answer "on the cap" for every press on the strip and
   *  the jump-to-the-press path would never run. Positioned at the fader's top, which
   *  is where a cap sits at full level. */
  capBox?: { width: number; height: number };
  /** Skip `show()` — for a test about what an unshown view does. */
  hidden?: boolean;
}

/**
 * Install the pointer/layout/frame stubs and return a shown CONSOLE view. Call
 * `restore()` in an afterEach: three of the four stubs are global.
 */
export function consoleHost(opts: ConsoleHostOptions = {}): ConsoleHost {
  const {
    modelId = "URX44V",
    live = false,
    box = { width: 34, height: 120 },
    capBox = { width: 24, height: 14 },
  } = opts;

  const host = document.createElement("div");
  document.body.append(host);

  const model = getModel(modelId);
  const plan = opts.plan ?? defaultPlan(modelId);
  const meterErrors: string[] = [];
  const opened: ConsoleHost["opened"] = [];
  let changes = 0;

  // jsdom has no pointer capture. The view calls it on every drag opener, and an
  // unimplemented method would end the gesture before its first move.
  const realCapture = Element.prototype.setPointerCapture;
  const realRelease = Element.prototype.releasePointerCapture;
  Element.prototype.setPointerCapture = function (): void {};
  Element.prototype.releasePointerCapture = function (): void {};

  // Every element measures as the same box, a fader cap excepted — the one control the
  // view measures *against another*. `getBoundingClientRect` drives the fader travel,
  // the cap hit test and both popovers' placement; `offsetWidth`/`offsetHeight` are
  // what `placePopover` reads off the popover itself.
  const realRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    const b = this.classList.contains("cap") ? capBox : box;
    const r = { x: 20, y: 40, left: 20, top: 40, width: b.width, height: b.height };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
  };
  const offsets = ["offsetWidth", "offsetHeight"] as const;
  const realOffsets = offsets.map((p) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, p));
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => box.width });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => box.height });

  // Manual frame clock — the meter loop re-queues itself every frame, so a real rAF
  // would spin.
  let nextId = 1;
  let queue = new Map<number, FrameRequestCallback>();
  let now = 0;
  const realRaf = globalThis.requestAnimationFrame;
  const realCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((fn: FrameRequestCallback): number => {
    const id = nextId++;
    queue.set(id, fn);
    return id;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number): void => void queue.delete(id)) as typeof cancelAnimationFrame;
  const frame = (): void => {
    const due = queue;
    queue = new Map();
    now += 1000; // past the view's own 30 fps cap, so a queued tick always paints
    for (const fn of due.values()) fn(now);
  };

  const hooks: ConsoleHooks = {
    getModel: () => model,
    getPlan: () => plan,
    onChange: () => void changes++,
    onMeterError: (message) => void meterErrors.push(message),
    onOpenDynScreen: (kind, id) => void opened.push({ kind, id }),
    midi: opts.midi,
  };

  // Installed after the stubs and before the view: the view registers window
  // listeners from its own constructor onwards, and this is the handle that takes
  // them back.
  const windowScope = recordWindowListeners();

  const view = new Console(host, hooks);
  if (!opts.hidden) view.show();
  if (live) view.setLive(true);

  const refs = (): Map<string, StripHandle> => (view as unknown as { refs: Map<string, StripHandle> }).refs;
  const strip = (id: string): StripHandle => {
    const r = refs().get(id);
    if (!r) throw new Error(`no strip for "${id}" (have: ${[...refs().keys()].join(", ")})`);
    return r;
  };

  return {
    view,
    host,
    model,
    plan,
    changes: () => changes,
    meterErrors,
    opened,
    strip,
    sendCol: (id, target) => {
      const col = strip(id).sendCols?.find((c) => c.target === target);
      if (!col) throw new Error(`no "${target}" send column on "${id}"`);
      return col;
    },
    frame,
    restore: () => {
      windowScope.stop();
      windowScope.release();
      view.hide();
      host.remove();
      Element.prototype.setPointerCapture = realCapture;
      Element.prototype.releasePointerCapture = realRelease;
      Element.prototype.getBoundingClientRect = realRect;
      for (const [i, p] of offsets.entries()) {
        if (realOffsets[i]) Object.defineProperty(HTMLElement.prototype, p, realOffsets[i]);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[p];
      }
      globalThis.requestAnimationFrame = realRaf;
      globalThis.cancelAnimationFrame = realCancel;
    },
  };
}

/** A vertical drag on a control: pointerdown, then `steps` moves of `dy` px each
 *  (positive = upward = louder, matching the view's `startY - clientY`), then up.
 *  The moves go to `window`, which is where `trackDrag` listens. */
export function dragY(el: HTMLElement, dy: number, opts: { steps?: number; shift?: boolean } = {}): void {
  const { steps = 1, shift = false } = opts;
  const startY = 100;
  // Shift goes on the OPENING event too, which is what holding it before the press
  // looks like. A knob rebases both of its anchors whenever the Shift state flips, so
  // a shift that first appears on the moves spends the first move on the rebase and
  // reports zero travel — a "fine mode does nothing" reading that is the driver's.
  el.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      clientY: startY,
      shiftKey: shift,
      pointerId: 1,
    }),
  );
  for (let i = 1; i <= steps; i++) {
    window.dispatchEvent(new PointerEvent("pointermove", { clientY: startY - dy * i, shiftKey: shift, pointerId: 1 }));
  }
  window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
}

/** One wheel notch. Up (`dir: 1`) is a negative deltaY, as a real wheel reports. */
export function wheel(el: HTMLElement, dir: 1 | -1): void {
  el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: dir === 1 ? -100 : 100 }));
}

/** One keydown on a control. */
export function key(el: HTMLElement, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}

/** Every chip in a strip, by its visible text. */
export function chips(root: HTMLElement): Map<string, HTMLElement> {
  const out = new Map<string, HTMLElement>();
  for (const c of root.querySelectorAll<HTMLElement>(".con-chip, .con-sl, .con-slp")) {
    const label = c.textContent ?? "";
    if (!out.has(label)) out.set(label, c);
  }
  return out;
}
