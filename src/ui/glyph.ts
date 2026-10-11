import { t } from "../i18n";
import { READ_AS_ELEMENT, SPOKEN_MARK } from "./spoken-mark";

// In the mono UI font the infinity glyph (U+221E) draws at x-height, so a bare
// "-∞" reads markedly smaller and fainter than the digits it stands in for. Write
// the text with each ∞ wrapped in a span (.glyph-inf scales it back up to the
// digits' height), so an off / out-of-range readout stays as legible as a value.
export function setLevelText(el: HTMLElement, text: string): void {
  if (!text.includes("∞")) {
    el.textContent = text;
    return;
  }
  el.replaceChildren();
  for (const part of text.split(/(∞)/)) {
    if (!part) continue;
    if (part === "∞") {
      const span = document.createElement("span");
      span.className = "glyph-inf";
      span.textContent = part;
      el.append(span);
    } else {
      el.append(document.createTextNode(part));
    }
  }
}

/** A caption symbol and the word it is announced as. */
export interface CaptionSymbol {
  symbol: string;
  name: string;
}

/** The control captions written as symbols, longest first so "ФL" is taken whole before "Ф". */
export function captionSymbols(): CaptionSymbol[] {
  const { param, paramSpoken } = t().midi;
  return (["phaseL", "phaseR", "phase"] as const).map((k) => ({ symbol: param[k], name: paramSpoken[k] }));
}

function markReading(mark: RegExpExecArray): string {
  const m = t();
  if (mark[1] !== undefined) return `${mark[1]} ${m.speech.slash} ${mark[2]}`;
  return mark[0] === "/" ? m.speech.slash : mark[0] === "\u00b7" ? m.speech.dot : "C H";
}

type Run = { text: string; name?: string };

// `text` cut into the runs it is printed as, each mark and (when `captioned`) each caption
// symbol carrying the word it is announced as.
function runsOf(text: string, captioned: boolean): Run[] {
  const runs: Run[] = [];
  const symbols = captioned ? captionSymbols() : [];
  let rest = text;
  while (rest) {
    let at = -1;
    let hit: Run | undefined;
    for (const s of symbols) {
      const i = rest.indexOf(s.symbol);
      if (i >= 0 && (at < 0 || i < at)) [at, hit] = [i, { text: s.symbol, name: s.name }];
    }
    SPOKEN_MARK.lastIndex = 0;
    const mark = SPOKEN_MARK.exec(rest);
    if (mark && (at < 0 || mark.index < at)) [at, hit] = [mark.index, { text: mark[0], name: markReading(mark) }];
    if (!hit) {
      runs.push({ text: rest });
      break;
    }
    if (at > 0) runs.push({ text: rest.slice(0, at) });
    runs.push(hit);
    rest = rest.slice(at + hit.text.length);
  }
  return runs;
}

/** The form `text` is announced in: each mark read by its reading, the words kept apart by
 *  single spaces and no space beside the punctuation around them. */
export function spoken(text: string, captioned = false): string {
  return runsOf(text, captioned)
    .map((r) => (r.name === undefined ? r.text : ` ${r.name} `))
    .join("")
    .replace(/ {2,}/g, " ")
    .replace(/ ([,.:;!?、。)\]…])/g, "$1")
    .replace(/([(\[、。]) /g, "$1")
    .trim();
}

// An element a screen reader names — a button, a heading — written as `text`
// and named by `said` where that differs from it: by default the text's spoken form, or the
// word a symbol caption stands for (Ф is announced as a Cyrillic letter otherwise).
export function setNamedText(el: HTMLElement, text: string, said = spoken(text)): void {
  el.textContent = text;
  if (said !== text) el.setAttribute("aria-label", said);
  else el.removeAttribute("aria-label");
}

// A status line's live region: it holds the message's spoken form and is named by the same
// text, and carries no name while it holds none.
export function setSaid(region: HTMLElement, said: string): void {
  region.textContent = said;
  if (said) region.setAttribute("aria-label", said);
  else region.removeAttribute("aria-label");
}

// Text a screen reader reads as it stands — a line no role can name, a table cell, whose
// `aria-label` VoiceOver does not use — written as `text` for the eye and as its spoken form
// for assistive technology: the printed run is hidden from the one and the spoken run from the
// other. `captioned` reads every caption symbol by its word too, and is only for a sentence
// whose symbols are all captions (a MIDI assignment, an armed control): a file or port name
// holding the same character is not one.
export function setSpokenText(el: HTMLElement, text: string, captioned = false): void {
  setHeardText(el, text, spoken(text, captioned));
}

// The same pair with the spoken form given: `said` where that differs from `text`. `tooltip`
// shows `text` on hover from the printed part, where a screen reader does not reach it — on
// the element itself VoiceOver reads the title too, in its printed form.
export function setHeardText(el: HTMLElement, text: string, said: string, tooltip = false): void {
  if (said === text) {
    el.textContent = text;
    if (tooltip) el.title = text;
    return;
  }
  const shown = document.createElement("span");
  shown.setAttribute("aria-hidden", "true");
  shown.textContent = text;
  if (tooltip) shown.title = text;
  const heard = document.createElement("span");
  heard.className = "sr-only";
  heard.textContent = said;
  el.replaceChildren(shown, heard);
}

// The elements `setTip` described, so a later tooltip with nothing to say clears only the
// description it wrote and never one set for another reason.
const tipDescribed = new WeakSet<HTMLElement>();

// Roles that hold controls rather than being one, and controls whose content cannot hold the
// hover zone. A zone laid over a group of buttons takes every press meant for them.
const HOLDS_CONTROLS = '[role="group"], [role="radiogroup"], [role="toolbar"]';
const NO_CONTENT = "input, select, textarea";

/** The tooltip `el` carries, wherever `setTip` put it: on `el` itself, on its zone, or —
 *  for a wrapper or a group — on the zone of the first control inside it. */
export function tipOf(el: HTMLElement): string {
  return (
    el.querySelector<HTMLElement>(":scope > .tip-zone")?.title ??
    (el.title || el.querySelector<HTMLElement>(".tip-zone")?.title || "")
  );
}

function describeBy(el: HTMLElement, said: string, on: boolean): void {
  if (on) {
    el.setAttribute("aria-description", said);
    tipDescribed.add(el);
  } else if (tipDescribed.has(el)) {
    el.removeAttribute("aria-description");
    tipDescribed.delete(el);
  }
}

// A tooltip on `el`, shown on hover as `text` and announced in its spoken form. VoiceOver
// reads an element's own title as a hint in its printed form, and an aria-description beside
// it does not stop that, so where the two forms differ the title moves to a hidden zone
// covering the control and the control is described by the spoken form instead. A wrapper or
// a group hands the tooltip to each control inside it, so no zone ever covers more than the
// one control it belongs to; it keeps the title itself, which is not read, only for a control
// that cannot hold a zone (an input). `describe` describes by the text even where the two
// forms agree.
export function setTip(el: HTMLElement, text: string, describe = false): void {
  if (el.matches(READ_AS_ELEMENT) && !el.matches(HOLDS_CONTROLS)) {
    tipOnControl(el, text, describe);
    return;
  }
  const controls = [...el.querySelectorAll<HTMLElement>(READ_AS_ELEMENT)].filter((c) => !c.matches(HOLDS_CONTROLS));
  const said = spoken(text).replace(/\s*\n\s*/g, " ");
  const describes = Boolean(text) && (describe || spoken(text) !== text);
  let wrapperKeeps = controls.length === 0;
  for (const c of controls) {
    if (c.matches(NO_CONTENT)) {
      describeBy(c, said, describes);
      wrapperKeeps = true;
    } else tipOnControl(c, text, describe);
  }
  if (text && wrapperKeeps) el.title = text;
  else el.removeAttribute("title");
}

function tipOnControl(el: HTMLElement, text: string, describe: boolean): void {
  const same = spoken(text) === text;
  let zone = el.querySelector<HTMLElement>(":scope > .tip-zone");
  if (same || el.matches(NO_CONTENT)) {
    zone?.remove();
    el.classList.remove("tip-host");
    if (text) el.title = text;
    else el.removeAttribute("title");
  } else {
    el.removeAttribute("title");
    if (!zone) {
      zone = document.createElement("span");
      zone.className = "tip-zone";
      zone.setAttribute("aria-hidden", "true");
      el.append(zone);
    }
    zone.title = text;
    el.classList.add("tip-host");
  }
  describeBy(el, spoken(text).replace(/\s*\n\s*/g, " "), Boolean(text) && (describe || !same));
}
