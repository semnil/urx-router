// Tiny DOM builder shared by the UI modules.
import { getSettings } from "../core/settings";
import { setLevelText } from "./glyph";
import { t } from "../i18n";

export function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

// Wire scroll-wheel stepping onto a control: a vertical notch steps by one detent
// (`dir` = +1 up / −1 down). A pure-horizontal scroll (deltaY 0) is left alone —
// except under Shift, where browsers remap the vertical wheel onto deltaX, so the
// fine-tuning modifier still steps. `preventDefault` (needs the non-passive
// listener) stops the page/panel scrolling while the pointer is over the control.
// `blocked` short-circuits before any work (e.g. while assigning MIDI). Shared by
// the console faders/knobs and the inspector sliders so the passive/preventDefault
// contract lives in one place.
export function onWheelStep(el: HTMLElement, step: (dir: 1 | -1) => void, blocked?: () => boolean | undefined): void {
  el.addEventListener(
    "wheel",
    (e) => {
      const d = e.deltaY !== 0 ? e.deltaY : e.shiftKey ? e.deltaX : 0;
      if (d === 0 || blocked?.()) return;
      e.preventDefault();
      // The wheel-step preference multiplies detents per notch; each detent goes
      // through `step` so every control keeps snapping to its own grid.
      const dir = d < 0 ? 1 : -1;
      for (let i = 0; i < getSettings().wheelSteps; i++) step(dir);
    },
    { passive: false },
  );
}

// Scrub binary float drift onto a ≤4-decimal grid, so stepped values stay clean
// ("2.7", not 2.7000000000000002) across the 0.5 / 0.1 dB and 1 / 0.02 ms grids.
// Shared by the inspector wheel stepping and the console knob snapping.
export function scrubFloat(v: number): number {
  return Number(v.toFixed(4));
}

// Hold everything behind a modal out of the tab order for as long as it is up.
// Every `aria-modal` surface claims this on open and releases on close; only the
// consent gate used to, so the other six let a Tab walk into the graph underneath
// while their scrim said the app was unreachable.
//
// "Everything behind" is not `#app` alone. The scrims are siblings of `#app`, not
// children of it, so inerting the app does nothing about a modal stacked under
// another modal — and they do stack: Preferences opens the licenses notice, and a
// load report arrives over whatever raised it. So a claim carries its own scrim,
// the one the page draws on top stays reachable, and every other claimed scrim is
// inert alongside the app. Measured before this: Tab from a load report's Close
// reached the Preferences rows behind it.
//
// A list rather than a counter, and release by identity rather than by popping,
// because a lower modal can close first (the shell closes Preferences out from
// under an update prompt). The release is idempotent for the same reason a
// counter needed it: a close path that runs twice — Escape landing together with
// the button click — must not drop a claim it no longer holds.
interface InertClaim {
  scrim: HTMLElement | null;
}
const inertClaims: InertClaim[] = [];

/** Document order, the tiebreak the painter uses at equal z-index: the later
 *  element is drawn over the earlier one. */
function isAfter(a: HTMLElement, b: HTMLElement): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/**
 * The claimed scrim the page actually draws on top — which the claim order does
 * NOT answer. The overlay ladder in style.css puts a decision gate (z-index 130)
 * over a tool modal (100), so a modal whose open is asynchronous — the licenses
 * notice waits on a resource read, Device setup on a device read — claims last and
 * is still drawn beneath a gate that arrived while it was loading. Claim order
 * then inerted the gate, in front, and handed focus to the modal behind it.
 *
 * Read from the computed style rather than mapped from the scrim's classes, so the
 * ladder stays written in the stylesheet alone: a rank table here would be a second
 * copy of it, free to drift while both read as deliberate.
 */
function topScrim(): HTMLElement | null {
  let top: HTMLElement | null = null;
  let topZ = 0;
  for (const { scrim } of inertClaims) {
    if (!scrim) continue;
    // `auto` — a scrim with no ladder entry, or a document with no stylesheet on it
    // — ranks as 0, which leaves document order deciding, as it does on the page.
    const z = Number.parseInt(getComputedStyle(scrim).zIndex, 10) || 0;
    if (top === null || z > topZ || (z === topZ && isAfter(top, scrim))) {
      top = scrim;
      topZ = z;
    }
  }
  return top;
}

function applyInert(): void {
  const app = document.getElementById("app");
  if (app) app.inert = inertClaims.length > 0;
  const top = topScrim();
  for (const claim of inertClaims) if (claim.scrim) claim.scrim.inert = claim.scrim !== top;
}

/** Claim the hold for one modal, and return its release. Pass the modal's own
 *  scrim so the claim knows what must stay reachable while it is on top. */
export function holdAppInert(scrim?: HTMLElement | null): () => void {
  const claim: InertClaim = { scrim: scrim ?? null };
  inertClaims.push(claim);
  applyInert();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const at = inertClaims.indexOf(claim);
    if (at >= 0) inertClaims.splice(at, 1);
    // Cleared before the recompute: a scrim that no longer holds a claim is not
    // in the loop that would clear it.
    if (claim.scrim) claim.scrim.inert = false;
    applyInert();
  };
}

// Dismissal wiring for a transient overlay: a press outside it or Escape closes.
// Capture phase, like the toolbar menus — console / graph handlers may stop
// propagation, but a dismissal gesture must still reach the overlay. `keep`
// names the press targets that must not dismiss (the overlay itself and its
// toggle button); `inert` pauses dismissal without detaching (the Device setup
// modal, while an apply is in flight). The Preferences update-check lock instead
// rides its requestClose choke point, not `inert`. Shared by the Preferences and
// Device setup modals, the licenses modal and the channel tuning screen so the
// phase/lifecycle contract lives in one place; attach on open, detach on close.
export function wireDismiss(opts: { keep: (target: Node) => boolean; inert?: () => boolean; close: () => void }): {
  attach: () => void;
  detach: () => void;
} {
  const onPointer = (e: PointerEvent): void => {
    if (opts.inert?.() || opts.keep(e.target as Node)) return;
    opts.close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || opts.inert?.()) return;
    opts.close();
  };
  return {
    attach: () => {
      document.addEventListener("pointerdown", onPointer, true);
      document.addEventListener("keydown", onKey, true);
    },
    detach: () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    },
  };
}

// Native <input type=range> ignores the scroll wheel, so wire it up via onWheelStep:
// a notch nudges the value one step and fires 'input' so the row's own listener
// updates the readout and reports the change. Shared by the inspector's sliders,
// the Device setup brightness row and the gate screen's parameter rows — every
// range input in the app steps by the wheel-step preference, or none should.
// `blocked` short-circuits the notch (the tuning screens pass MIDI learn, where a
// stray scroll would move the value being assigned).
export function wheelStep(slider: HTMLInputElement, blocked?: () => boolean | undefined): void {
  onWheelStep(
    slider,
    (dir) => {
      const step = Number(slider.step) || 1;
      const lo = Number(slider.min);
      const hi = Number(slider.max);
      const next = Math.min(hi, Math.max(lo, scrubFloat(Number(slider.value) + dir * step)));
      if (next === Number(slider.value)) return;
      slider.value = String(next);
      slider.dispatchEvent(new Event("input"));
    },
    blocked,
  );
}

/** How close a floating popover may come to the window edge, on either axis. */
const POP_INSET = 6;

/** Clamp a popover's desired left edge into the viewport. How it aligns
 *  (right-anchored, centred) stays with the caller; this owns only the inset, which
 *  was written out per alignment in two files before there was a second surface. */
export function popLeft(desiredLeft: number, width: number): number {
  return Math.max(POP_INSET, Math.min(desiredLeft, window.innerWidth - width - POP_INSET));
}

/**
 * Copy text to the clipboard, resolving with whether it landed. The capability check
 * matters: `navigator.clipboard` is absent in an insecure context, where reading it
 * blind throws instead of rejecting. Shared so the surfaces that offer a copy cannot
 * decide that differently — there are three of them.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// Vertical placement for a floating popover: `gap` px below the anchor rect,
// flipped above it when the viewport bottom is too close, clamped to the inset
// above. The console popovers' flip contract, kept here rather than inline so a
// second floating surface inherits it.
export function popTop(anchor: DOMRect, height: number, gap: number): number {
  const below = anchor.bottom + gap;
  if (below + height <= window.innerHeight - POP_INSET) return below;
  return Math.max(POP_INSET, anchor.top - height - gap);
}

/** Every focusable control inside a rebuilt subtree, in DOM order. The custom controls
 *  (fader / knob / chip / scribble) carry `tabindex="0"`; the rest are real form
 *  controls. One enumeration, because a capture and its restore that disagreed about
 *  what counts would hand focus to a different control than the one that had it. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('input, select, button, [tabindex="0"]')];
}

/** Carry keyboard focus across a rebuild of `host`'s contents. Called BEFORE the
 *  rebuild — it reads the focused element then — and returns the restore to run once
 *  the new DOM is in place, which answers the element it focused (null when there was
 *  nothing to carry, or the key names nothing in the rebuilt panel — dropping focus is
 *  the wanted outcome there, not handing it to whatever moved into the slot).
 *
 *  How a control is keyed is the caller's: the console keys by strip + index, the
 *  inspector by the row's label. What must not differ lives here — the containment
 *  check, and `focus({ preventScroll: true })`, which keeps the surface where the
 *  operator left it when the restored control sits off screen (measured honoured on
 *  both engines; scripts/meter-bench.mjs's scrollCheck holds it against WKWebView on
 *  every bench run, so a copy that dropped it would show up there).
 *
 *  `scrollTop` opts into restoring the host's scroll offset, and is a getter rather
 *  than a read here because the console deliberately does NOT restore it: reading the
 *  offset back at rebuild time forces a synchronous layout (~25 ms on WKWebView). */
export function preserveFocus<K>(
  host: HTMLElement,
  capture: (active: HTMLElement) => K | null,
  find: (key: K) => HTMLElement | null | undefined,
  scrollTop?: () => number,
): () => HTMLElement | null {
  const active = document.activeElement as HTMLElement | null;
  const key = active !== null && host.contains(active) ? capture(active) : null;
  return () => {
    if (scrollTop) {
      // Skipped at the top, the common case: the write itself needs layout, which is
      // the cost the caller's tracker exists to avoid. A rebuild too short for the
      // offset is clamped by the browser.
      const top = scrollTop();
      if (top !== 0) host.scrollTop = top;
    }
    if (key === null) return null;
    const target = find(key);
    if (!target) return null;
    target.focus({ preventScroll: true });
    return target;
  };
}

// ---- settings-row builders ---------------------------------------------------
// The label-left / control-right row idiom the Preferences and Device setup modals
// both render. They emit the same `prefs-*` DOM (the class prefix is historical —
// Preferences was the first screen to use it), so the recipe lives here rather than
// in whichever modal a third screen happens to copy. The inspector deliberately
// stays out: its controls wrap `paramBlock()`, a different row shape with its own
// wheel and fine-mode hooks.

/** A section heading, optionally carrying a dashed tag pill ("Desktop app only", a model
 *  name) that stays readable while the rows below it dim. `{ text, shown: false }` keeps the
 *  pill and hides it, which holds the heading's height — a pill makes it taller, so dropping
 *  one shortens the panel (the tuning screens reserve rows the same way). */
export function settingsSection(titleText: string, tag?: string | { text: string; shown: boolean }): HTMLElement {
  const sec = el("section", "prefs-section");
  const h = el("h3", "");
  h.textContent = titleText;
  if (tag) {
    const pill = settingsPill(typeof tag === "string" ? tag : tag.text);
    if (typeof tag !== "string" && !tag.shown) pill.classList.add("gt-reserved");
    h.append(pill);
  }
  sec.append(h);
  return sec;
}

export function settingsPill(text: string): HTMLElement {
  const pill = el("span", "prefs-lock");
  pill.textContent = text;
  return pill;
}

export interface SettingsRowOptions {
  /** Dashed tag beside the label (why the row does not apply here). */
  tag?: string;
  /** Not applicable in this build / on this model: dim the row and refuse input. */
  locked?: boolean;
  /** Extra classes, e.g. the Device setup screen's `sub` indent and `dirty` mark. */
  cls?: string;
  /** A legend printed on the label itself — what the *parameter* is (the FINE grid),
   *  as against `tag`, which says what state the row is in. Ordering it against the tag
   *  is this function's business: a caller that inserted it by querying for the tag
   *  pill would be reading a layout only this file decides. */
  legend?: HTMLElement;
}

/** A label + control row. A locked row keeps its tag at full opacity while the rest
 *  of it dims, and every control inside it is disabled — including `input`, which a
 *  row holding a slider needs. */
export function settingsRow(labelText: string, control: HTMLElement, opts: SettingsRowOptions = {}): HTMLElement {
  const row = el("div", opts.cls ? `prefs-row ${opts.cls}` : "prefs-row");
  const lblc = el("span", "lblc");
  const lbl = el("span", "lbl");
  lbl.textContent = labelText;
  lblc.append(lbl);
  if (opts.legend) lblc.append(opts.legend);
  if (opts.tag) lblc.append(settingsPill(opts.tag));
  row.append(lblc, control);
  if (opts.locked) {
    row.classList.add("locked");
    const controls = row.querySelectorAll<HTMLButtonElement | HTMLSelectElement | HTMLInputElement>(
      "button, select, input",
    );
    for (const c of controls) c.disabled = true;
  }
  return row;
}

/** The explanatory paragraph under a row or section. */
export function settingsNote(text: string): HTMLElement {
  const p = el("p", "prefs-note");
  p.textContent = text;
  return p;
}

/** Segmented control over an index into `labels`; the active face lights. Two
 *  labels is the common case (ON/OFF), but the shape is the same for three. */
export function settingsChoice(
  labels: readonly string[],
  current: number,
  pick: (index: number) => void,
  narrow = false,
): HTMLElement {
  const wrap = el("div", narrow ? "prefs-toggle narrow" : "prefs-toggle");
  for (const [i, label] of labels.entries()) {
    const active = i === current;
    const b = el("button", active ? "on" : "") as HTMLButtonElement;
    b.type = "button";
    b.textContent = label;
    b.setAttribute("aria-pressed", String(active));
    b.addEventListener("click", () => {
      if (!active) pick(i);
    });
    wrap.append(b);
  }
  return wrap;
}

/** The ON/OFF pair, in the order every settings surface prints it. Three screens
 *  wrote this expression out, each with its own note about borrowing the
 *  inspector's strings; the recipe belongs beside `settingsChoice` like the rest. */
export function onOff(on: boolean, apply: (on: boolean) => void): HTMLElement {
  return settingsChoice([t().inspector.on, t().inspector.off], on ? 0 : 1, (i) => apply(i === 0), true);
}

/** A labelled range slider row with a readout, the shape every parameter row on the
 *  dynamics screens takes. Carries the wheel-step contract `onWheelStep` documents,
 *  which a hand-built row silently drops. */
export function sliderRow(opts: {
  label: string;
  id?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (v: number) => string;
  onInput: (v: number) => void;
  row?: SettingsRowOptions;
}): HTMLElement {
  const ctl = el("span", "ctl dev-slider");
  const input = document.createElement("input");
  input.type = "range";
  if (opts.id) input.id = opts.id;
  input.min = String(opts.min);
  input.max = String(opts.max);
  input.step = String(opts.step);
  input.value = String(opts.value);
  input.setAttribute("aria-label", opts.label);
  const val = el("span", "param-val gt-val");
  const show = (v: number): void => {
    setLevelText(val, opts.format(v));
    input.setAttribute("aria-valuetext", opts.format(v));
  };
  show(opts.value);
  input.addEventListener("input", () => {
    const v = Number(input.value);
    show(v);
    opts.onInput(v);
  });
  wheelStep(input);
  ctl.append(input, val);
  return settingsRow(opts.label, ctl, opts.row);
}

/** Dropdown over a fixed choice list. With no choices the control does not apply to
 *  the current selection, so it shows `empty` and refuses input. */
export function settingsSelect<T extends string | number>(
  choices: readonly T[],
  current: T,
  label: (v: T) => string,
  apply: (v: T) => void,
  empty?: string,
): HTMLSelectElement {
  const sel = el("select", "prefs-select") as HTMLSelectElement;
  if (choices.length === 0) {
    const opt = document.createElement("option");
    opt.textContent = empty ?? "";
    sel.append(opt);
    sel.disabled = true;
    return sel;
  }
  for (const v of choices) {
    const opt = document.createElement("option");
    opt.value = String(v);
    opt.textContent = label(v);
    sel.append(opt);
  }
  sel.value = String(current);
  sel.addEventListener("change", () => {
    const v = choices.find((c) => String(c) === sel.value);
    if (v !== undefined) apply(v);
  });
  return sel;
}
