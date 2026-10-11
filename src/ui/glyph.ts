import { t } from "../i18n";

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

// The marks a screen reader reads as something other than what they are: "CH" as a word
// (Japanese voices read it as a country), an a/b pair as a fraction or a date, a slash on its
// own as nothing, and the middle dot as its character name or as nothing. Each is announced
// by a reading of its own — "CH" spelled letter by letter, a pair as its two halves with the
// slash's word between them, the slash and the dot by their words. A pair is one mark, so its
// reading stays one run of words wherever it is announced.
const SPOKEN_MARK = /(?<![A-Za-z0-9])ch(?![A-Za-z0-9])|([A-Za-z0-9.]+)\/([A-Za-z0-9.]+)|\/|\u00b7/gi;

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

// An element a screen reader names — a button, a heading, a table cell — written as `text`
// and named by `said` where that differs from it: by default the text's spoken form, or the
// word a symbol caption stands for (Ф is announced as a Cyrillic letter otherwise).
export function setNamedText(el: HTMLElement, text: string, said = spoken(text)): void {
  el.textContent = text;
  if (said !== text) el.setAttribute("aria-label", said);
  else el.removeAttribute("aria-label");
}

// Text a screen reader reads as it stands — a line no role can name — written as `text` for
// the eye and as its spoken form for assistive technology: the printed run is hidden from the
// one and the spoken run from the other. `captioned` reads every caption symbol by its word
// too, and is only for a sentence whose symbols are all captions (a MIDI assignment, an armed
// control): a file or port name holding the same character is not one.
export function setSpokenText(el: HTMLElement, text: string, captioned = false): void {
  const said = spoken(text, captioned);
  if (said === text) {
    el.textContent = text;
    return;
  }
  const shown = document.createElement("span");
  shown.setAttribute("aria-hidden", "true");
  shown.textContent = text;
  const heard = document.createElement("span");
  heard.className = "sr-only";
  heard.textContent = said;
  el.replaceChildren(shown, heard);
}
