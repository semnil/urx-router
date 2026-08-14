// The host a channel tuning screen needs to run in, assembled for a unit test.
// Not a test file itself (vitest collects only *.test.ts), so suites import it
// rather than re-declaring the setup.
//
// `DynScreen` reaches for four things jsdom does not provide: the modal host that
// index.html carries, a 2D canvas context, a frame clock, and a measurable canvas
// box. All four are installed here as the thinnest thing that answers truthfully —
// the canvas is the recording context the plot suites already use, so what a screen
// draws stays inspectable as coordinates rather than pixels, and the frame clock is
// manual so a paint happens when a test says so instead of when a timer fires.

import { recorder } from "./dyn-plot.test-util";
import { recordWindowListeners } from "./listener-scope.test-util";
import type { Recorder } from "./dyn-plot.test-util";
import { getModel } from "../models";
import { defaultPlan } from "../models/initial-state";
import type { DeviceModel } from "../models/types";
import type { NodeParams, Plan } from "../core/plan";
import type { DynScreenHooks } from "./dyn-screen";

/** What a test drives the screen's environment through. */
export interface DynHost {
  scrim: HTMLElement;
  box: HTMLElement;
  hooks: DynScreenHooks;
  model: DeviceModel;
  plan: Plan;
  /** Every `onUpdateNodeParams` the screen made, in order. */
  patches: Array<{ id: string; patch: NodeParams }>;
  /** Live-sync state the screen reads through `isLive`. */
  setLive: (on: boolean) => void;
  /** Meter-slot and error hooks, counted. */
  released: () => number;
  regained: () => number;
  meterErrors: string[];
  closed: () => number;
  /** Run every frame callback queued so far — one paint pass. */
  frame: () => void;
  /** Frame callbacks still queued (the screen keeps one alive while metering). */
  pending: () => number;
  /** The recording context every canvas in this host draws into. */
  canvas: Recorder;
  /** Undo the globals this host installed. */
  restore: () => void;
}

export interface DynHostOptions {
  modelId?: "URX22" | "URX44" | "URX44V";
  plan?: Plan;
  live?: boolean;
  /** The plot box's measured size. 0 leaves the canvas unmeasurable, which is what
   *  a screen opened while its modal is still hidden actually sees. */
  plotSize?: { w: number; h: number };
  midi?: DynScreenHooks["midi"];
}

/**
 * Install the modal host, the canvas stubs and a manual frame clock, and return the
 * hooks a `DynScreen` is constructed with. Call `restore()` in an afterEach: the
 * canvas and frame stubs are global.
 */
/** The height every element measures, so a cap press at a given clientY is one value. */
export const LANE_H = 200;

export function dynHost(opts: DynHostOptions = {}): DynHost {
  const { modelId = "URX44V", live = false, plotSize = { w: 600, h: 320 } } = opts;

  const scrim = document.createElement("div");
  scrim.id = "dyn-screen-modal";
  scrim.hidden = true;
  const box = document.createElement("div");
  box.id = "dyn-screen-box";
  scrim.append(box);
  document.body.append(scrim);

  const model = getModel(modelId);
  const plan = opts.plan ?? defaultPlan(modelId);
  const patches: DynHost["patches"] = [];
  const meterErrors: string[] = [];
  let isLive = live;
  let released = 0;
  let regained = 0;
  let closed = 0;

  // One recorder for the whole host: the screen draws its static layer onto an
  // offscreen canvas and blits it onto the visible one, and a test that wants to
  // know what was drawn wants both in one place.
  const rec = recorder();
  const realGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string) {
    return kind === "2d" ? rec.ctx : null;
  } as typeof HTMLCanvasElement.prototype.getContext;

  // A canvas has no layout in jsdom, and the screen refuses to draw an unmeasured
  // plot — so clientWidth/Height answer the size this host was asked for.
  const sizeProps = ["clientWidth", "clientHeight"] as const;
  const realSize = sizeProps.map((p) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, p));
  Object.defineProperty(HTMLCanvasElement.prototype, "clientWidth", { configurable: true, get: () => plotSize.w });
  Object.defineProperty(HTMLCanvasElement.prototype, "clientHeight", { configurable: true, get: () => plotSize.h });

  // jsdom implements none of the three pointer-capture methods, and the screen's two
  // drags need all of them: the cap takes a capture on press, and the plot GATES ITS
  // OWN MOVE HANDLER on `hasPointerCapture` — so an absent method throws on press and
  // a stub answering a constant false ends the gesture before its first move, both of
  // which look like "the drag did nothing" rather than like a missing fixture. Tracked
  // per element and per pointer id, so releasing really stops that drag and nothing
  // else, which is what lets a case tell an ended gesture from a live one.
  const captured = new WeakMap<Element, Set<number>>();
  const idsOf = (el: Element): Set<number> => {
    const ids = captured.get(el) ?? new Set<number>();
    captured.set(el, ids);
    return ids;
  };
  const pointerProps = ["setPointerCapture", "hasPointerCapture", "releasePointerCapture"] as const;
  const realPointer = pointerProps.map((p) => Object.getOwnPropertyDescriptor(Element.prototype, p));
  Element.prototype.setPointerCapture = function (this: Element, id: number): void {
    idsOf(this).add(id);
  };
  Element.prototype.hasPointerCapture = function (this: Element, id: number): boolean {
    return idsOf(this).has(id);
  };
  Element.prototype.releasePointerCapture = function (this: Element, id: number): void {
    idsOf(this).delete(id);
  };

  // One box for every element: the modal has layout in a browser and none in jsdom, and
  // the cap's own gesture divides by its lane's height — an unmeasured lane puts every
  // press at the same clamped end of the scale, so a case about a value that moved
  // cannot be written at all. The number is arbitrary; what matters is that it is
  // stable, so a press at a given clientY always lands on the same value.
  const realRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    const r = { x: 0, y: 0, left: 0, top: 0, width: plotSize.w, height: LANE_H };
    return { ...r, right: r.width, bottom: r.height, toJSON: () => r } as DOMRect;
  };

  // Manual frame clock. The screen's meter loop re-queues itself every frame, so a
  // real rAF would either spin or never run; this hands a test one pass at a time.
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
    // Well past the screen's own 30 fps cap, so a queued tick always paints.
    now += 1000;
    for (const fn of due.values()) fn(now);
  };

  const hooks: DynScreenHooks = {
    getModel: () => model,
    getPlan: () => plan,
    isLive: () => isLive,
    onUpdateNodeParams: (id, patch) => {
      patches.push({ id, patch });
      plan.nodeParams[id] = { ...plan.nodeParams[id], ...patch };
    },
    releaseMeters: () => void released++,
    regainMeters: () => void regained++,
    onMeterError: (message) => void meterErrors.push(message),
    midi: opts.midi,
    onClosed: () => void closed++,
  };

  // A DynScreen registers its pointer-release handler on `window`, which outlives
  // the test. A stale one only ever re-renders into its own detached box, so it
  // hides nothing today — but it is the same leak that made a MIDI window
  // assertion insensitive, and closing it keeps a later global-channel assertion
  // here from inheriting the problem.
  //
  // Installed HERE rather than at the top: `restore` is the only way to take it
  // back, so a throw before this line would leave the patch and its recordings
  // behind with nobody holding the handle. Nothing above registers a window
  // listener — the screens that do are built by the caller, after this returns.
  const windowScope = recordWindowListeners();

  return {
    scrim,
    box,
    hooks,
    model,
    plan,
    patches,
    setLive: (on) => void (isLive = on),
    released: () => released,
    regained: () => regained,
    meterErrors,
    closed: () => closed,
    frame,
    pending: () => queue.size,
    canvas: rec,
    restore: () => {
      windowScope.stop();
      windowScope.release();
      Element.prototype.getBoundingClientRect = realRect;
      // Deleted rather than assigned back when the property was absent to begin with:
      // assigning `undefined` leaves an own property, so `"setPointerCapture" in el`
      // answers true for the rest of the process and anything feature-detecting takes
      // a different branch in a later file.
      for (const [i, p] of pointerProps.entries()) {
        if (realPointer[i]) Object.defineProperty(Element.prototype, p, realPointer[i]);
        else delete (Element.prototype as unknown as Record<string, unknown>)[p];
      }
      HTMLCanvasElement.prototype.getContext = realGetContext;
      globalThis.requestAnimationFrame = realRaf;
      globalThis.cancelAnimationFrame = realCancel;
      for (const [i, p] of sizeProps.entries()) {
        if (realSize[i]) Object.defineProperty(HTMLCanvasElement.prototype, p, realSize[i]);
        else delete (HTMLCanvasElement.prototype as unknown as Record<string, unknown>)[p];
      }
      scrim.remove();
    },
  };
}

/** Every value row the screen put on screen, by the field key it edits. */
export function rowsByKey(box: HTMLElement): Map<string, HTMLInputElement> {
  const out = new Map<string, HTMLInputElement>();
  for (const input of box.querySelectorAll<HTMLInputElement>("input[data-dyn]")) {
    if (input.dataset.dyn) out.set(input.dataset.dyn, input);
  }
  return out;
}

/** The readout tiles in lane order: the caption, the value cell's text and the peak
 *  cell's. Keyed by the caption rather than the lane key — the cell carries the
 *  label the operator reads, and the key never reaches the DOM. */
export function readouts(box: HTMLElement): Array<{ label: string; value: string; peak: string; gr: boolean }> {
  return [...box.querySelectorAll<HTMLElement>(".gt-ro")].map((cell) => ({
    label: cell.querySelector<HTMLElement>(".k")?.textContent ?? "",
    value: cell.querySelector<HTMLElement>(".v")?.textContent ?? "",
    peak: cell.querySelector<HTMLElement>(".p")?.textContent ?? "",
    gr: cell.classList.contains("gr"),
  }));
}

/** Every meter bar's shade fraction, in the order they were built. `--lvl` is what
 *  the paint loop writes and the stylesheet scales the bar by. */
export function barLevels(box: HTMLElement): number[] {
  return [...box.querySelectorAll<HTMLElement>(".gt-shade")].map((b) => Number(b.style.getPropertyValue("--lvl")));
}
