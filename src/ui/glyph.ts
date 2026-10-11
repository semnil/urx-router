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

// A label written as a symbol a screen reader would otherwise spell out by its character
// name (the polarity mark Ф is announced as a Cyrillic letter). The symbol stays the
// visible text, and whatever takes its name from the element's content — a button, or a
// control labelled by it — is announced by the word the symbol stands for.
export function setSymbolText(el: HTMLElement, symbol: string, name: string): void {
  el.replaceChildren(symbolSpan(symbol, name));
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

// A sentence that names controls by their captions (a MIDI assignment, an armed control):
// written as `text`, with every caption symbol in it announced by its word. Only for text
// whose symbols are all captions — a file or port name holding the same character is not one.
export function setCaptionedText(el: HTMLElement, text: string): void {
  const symbols = captionSymbols();
  el.replaceChildren();
  let rest = text;
  while (rest) {
    let at = -1;
    let hit: CaptionSymbol | undefined;
    for (const s of symbols) {
      const i = rest.indexOf(s.symbol);
      if (i >= 0 && (at < 0 || i < at)) [at, hit] = [i, s];
    }
    if (!hit) {
      el.append(document.createTextNode(rest));
      break;
    }
    if (at > 0) el.append(document.createTextNode(rest.slice(0, at)));
    el.append(symbolSpan(hit.symbol, hit.name));
    rest = rest.slice(at + hit.symbol.length);
  }
}

function symbolSpan(symbol: string, name: string): HTMLElement {
  const span = document.createElement("span");
  span.setAttribute("role", "img");
  span.setAttribute("aria-label", name);
  span.textContent = symbol;
  return span;
}
