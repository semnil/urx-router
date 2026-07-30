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

// Dismissal wiring for a transient overlay: a press outside it or Escape closes.
// Capture phase, like the toolbar menus — console / graph handlers may stop
// propagation, but a dismissal gesture must still reach the overlay. `keep`
// names the press targets that must not dismiss (the overlay itself and its
// toggle button); `inert` pauses dismissal without detaching (MIDI learn). The
// Preferences update-check lock instead rides its requestClose choke point, not
// `inert`. Shared by the MIDI panel, the Preferences and Device setup
// modals and the licenses modal so the phase/lifecycle contract lives in one place; attach on open,
// detach on close.
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
export function wheelStep(slider: HTMLInputElement): void {
  onWheelStep(slider, (dir) => {
    const step = Number(slider.step) || 1;
    const lo = Number(slider.min);
    const hi = Number(slider.max);
    const next = Math.min(hi, Math.max(lo, scrubFloat(Number(slider.value) + dir * step)));
    if (next === Number(slider.value)) return;
    slider.value = String(next);
    slider.dispatchEvent(new Event("input"));
  });
}

// Vertical placement for a floating popover: `gap` px below the anchor rect,
// flipped above it when the viewport bottom is too close, clamped to a 6px
// viewport inset. Shared by the console popovers and the MIDI legend card so
// the flip/inset contract lives in one place (horizontal placement stays with
// each caller — they anchor differently).
export function popTop(anchor: DOMRect, height: number, gap: number): number {
  const below = anchor.bottom + gap;
  if (below + height <= window.innerHeight - 6) return below;
  return Math.max(6, anchor.top - height - gap);
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
