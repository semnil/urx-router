// The host a `Graph` needs in jsdom, and the locators its suites share.
// Not a test file itself (vitest collects only *.test.ts).
//
// One global is genuinely missing: jsdom has no ResizeObserver, and buildScaffold
// constructs one unconditionally. Everything else about jsdom's shortfall is
// harmless and deliberate here — getBoundingClientRect answers an all-zero rect, so
// fitView takes its own 1000 x 700 fallbacks and the initial pan/zoom are the same
// on every run.

import { vi } from "vitest";
import { Graph } from "./graph";
import type { GraphCallbacks } from "./graph";
import { getModel } from "../models";
import { defaultPlan } from "../models/initial-state";
import type { ModelId } from "../models/types";
import type { Plan } from "../core/plan";

export interface GraphFixture {
  graph: Graph;
  host: HTMLElement;
  plan: Plan;
  cb: { [K in keyof GraphCallbacks]: ReturnType<typeof vi.fn> };
  /** The inner <svg> every pointer listener is attached to. */
  svg: SVGSVGElement;
  restore: () => void;
}

export interface GraphOptions {
  modelId?: ModelId;
  /** Mutate the plan before the board is built — the only way to reach the visual
   *  branches the default plan does not carry. */
  seed?: (plan: Plan) => void;
  /** Make content coordinates equal client coordinates, so a dispatched pointer
   *  event lands where the test says. Default on. */
  identityTransform?: boolean;
}

let realResizeObserver: typeof ResizeObserver | undefined;
let realElementFromPoint: typeof document.elementFromPoint | undefined;
let installs = 0;

/** What is under the pointer on the next connect release, for `drag` to set. */
let hitTarget: Element | null = null;

/** Install the two globals jsdom lacks. Idempotent; paired with `restore`.
 *  `elementFromPoint` is the second: onPointerUp calls it unguarded on the
 *  connecting-release path, so without it every connect drag throws. */
function installGlobals(): void {
  if (installs++ === 0) {
    realResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
    realElementFromPoint = document.elementFromPoint;
    document.elementFromPoint = (() => hitTarget) as typeof document.elementFromPoint;
  }
}

function restoreGlobals(): void {
  if (--installs === 0) {
    if (realResizeObserver) globalThis.ResizeObserver = realResizeObserver;
    else delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    if (realElementFromPoint) document.elementFromPoint = realElementFromPoint;
    else delete (document as { elementFromPoint?: unknown }).elementFromPoint;
    hitTarget = null;
  }
}

export function graphFixture(opts: GraphOptions = {}): GraphFixture {
  const { modelId = "URX44V", identityTransform = true } = opts;
  installGlobals();

  const host = document.createElement("div");
  document.body.append(host);
  const model = getModel(modelId);
  const plan = defaultPlan(modelId);
  opts.seed?.(plan);

  const cb = {
    onSelect: vi.fn(),
    onStatus: vi.fn(),
    onChange: vi.fn(),
    onHiddenChange: vi.fn(),
  };
  const graph = new Graph(host, model, plan, cb as unknown as GraphCallbacks);
  if (identityTransform) {
    // getBoundingClientRect is all zeros, so clientToContent is only the identity
    // once the view transform is neutral.
    (graph as unknown as { zoom: number }).zoom = 1;
    (graph as unknown as { pan: { x: number; y: number } }).pan = { x: 0, y: 0 };
  }

  return {
    graph,
    host,
    plan,
    cb,
    svg: host.querySelector("svg")!,
    restore: () => {
      host.remove();
      restoreGlobals();
    },
  };
}

// ---- locators ---------------------------------------------------------------

export const nodeEl = (host: HTMLElement, id: string): SVGGElement | null =>
  host.querySelector<SVGGElement>(`g.node[data-id="${id}"]`);

export const nodeIds = (host: HTMLElement): string[] =>
  [...host.querySelectorAll<SVGGElement>("g.node[data-id]")].map((g) => g.dataset.id ?? "");

/** A port's oversized transparent hit disc — what the pointer handlers look up. */
export const portHit = (host: HTMLElement, ref: string): SVGCircleElement | null =>
  host.querySelector<SVGCircleElement>(`[data-ref="${ref}"]`);

/** A channel's Rec Point tap jack, which carries its own `ch:out` ref in data-tap. */
export const tapHit = (host: HTMLElement, ref: string): SVGCircleElement | null =>
  host.querySelector<SVGCircleElement>(`[data-tap="${ref}"]`);

/** The faceplate rect: the group's own box also covers the tap standing above the
 *  top edge, so the first <rect> is the one a press must land on. */
export const faceplate = (host: HTMLElement, id: string): SVGRectElement | null =>
  nodeEl(host, id)?.querySelector<SVGRectElement>("rect") ?? null;

export const wireHit = (host: HTMLElement, from: string, to: string): SVGPathElement | null =>
  host.querySelector<SVGPathElement>(`.wire-hit[data-from="${from}"][data-to="${to}"]`);

export const shelfChips = (host: HTMLElement): string[] =>
  [...host.querySelectorAll<HTMLButtonElement>(".hidden-shelf .chip")].map((c) => c.textContent ?? "");

export const selBarCount = (host: HTMLElement): string =>
  host.querySelector<HTMLElement>(".selbar-count")?.textContent ?? "";

// ---- gestures ---------------------------------------------------------------

const pointer = (type: string, x: number, y: number, init: PointerEventInit = {}): PointerEvent =>
  new PointerEvent(type, { pointerId: 1, clientX: x, clientY: y, bubbles: true, cancelable: true, ...init });

/** Press, move past the drag threshold, and release over `endOn`. */
export function drag(
  from: Element,
  to: { x: number; y: number },
  endOn: Element | null = null,
  init: PointerEventInit = {},
): void {
  const start = { x: 100, y: 100 };
  const prev = hitTarget;
  hitTarget = endOn;
  try {
    from.dispatchEvent(pointer("pointerdown", start.x, start.y, init));
    from.dispatchEvent(pointer("pointermove", to.x, to.y, init));
    from.dispatchEvent(pointer("pointerup", to.x, to.y, init));
  } finally {
    hitTarget = prev;
  }
}

export function press(el: Element, init: PointerEventInit = {}): void {
  el.dispatchEvent(pointer("pointerdown", 0, 0, init));
  el.dispatchEvent(pointer("pointerup", 0, 0, init));
}
