// Text measurement for the node graph: how wide a string renders in monospace
// cells, how a note wraps to the panel's budget, and how far a label has to shrink
// to clear the header button.
//
// Split out of graph.ts because none of it needs an element and all of it is
// awkward to reach through one: the cases that matter — a fullwidth token wider
// than the whole budget, a codepoint above the BMP, a paragraph of blank lines, a
// clip whose last line is all wide glyphs — are hard to produce by typing into a
// textarea and trivial to state as arguments.

/** Note panel geometry. The panel lives inside the node frame, below the header. */
export const NOTE_LINE_H = 15;
export const NOTE_PAD_Y = 9;
export const NOTE_TOP_GAP = 4;
export const NOTE_BOT_GAP = 5;
export const NOTE_MAX_CHARS = 21;
export const NOTE_MAX_LINES = 6;

/** Monospace glyph advance as a fraction of the font size. */
export const MONO_ADVANCE = 0.6;
/** The floor a label is allowed to shrink to before it is simply narrower. */
export const LABEL_MIN_SCALE = 0.7;

// Full-width (CJK, kana, fullwidth forms, emoji) glyphs occupy two monospace
// cells; everything else one. Lets the wrap measure mixed JP/ASCII notes by
// rendered width instead of raw character count.
export function cellW(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  const wide =
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0x303e) ||
    (c >= 0x3041 && c <= 0x33ff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xa000 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1faff) ||
    (c >= 0x20000 && c <= 0x3fffd);
  return wide ? 2 : 1;
}

export function noteWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += cellW(ch);
  return w;
}

export function notePanelHeight(lines: string[]): number {
  return NOTE_TOP_GAP + NOTE_PAD_Y * 2 + lines.length * NOTE_LINE_H + NOTE_BOT_GAP;
}

// Wrap a note to a cell-width budget, hard-splitting tokens too wide to fit
// (the only break CJK allows) and preserving the line breaks the user typed.
export function wrapNote(text: string, maxUnits: number): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r/g, "").split("\n")) {
    if (para.trim() === "") {
      out.push("");
      continue;
    }
    let line = "";
    let lineW = 0;
    const flush = (): void => {
      out.push(line);
      line = "";
      lineW = 0;
    };
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (noteWidth(word) > maxUnits) {
        if (line) flush();
        for (const ch of word) {
          const cw = cellW(ch);
          if (lineW + cw > maxUnits) flush();
          line += ch;
          lineW += cw;
        }
        continue;
      }
      const sep = line ? 1 : 0;
      if (lineW + sep + noteWidth(word) > maxUnits) flush();
      line = line ? `${line} ${word}` : word;
      lineW += sep + noteWidth(word);
    }
    out.push(line);
  }
  return out;
}

/** The lines a note actually draws: wrapped to the panel's budget and clipped to
 *  its line count, with the last line trimmed by whole glyphs until the ellipsis
 *  fits beside it. Empty for a note that is blank or absent. */
export function clipNote(raw: string): string[] {
  const text = raw.trim();
  if (!text) return [];
  const all = wrapNote(text, NOTE_MAX_CHARS);
  if (all.length <= NOTE_MAX_LINES) return all;
  const lines = all.slice(0, NOTE_MAX_LINES);
  let last = lines[NOTE_MAX_LINES - 1].replace(/\s+$/, "");
  // Trim until the ellipsis fits the cell budget (one cell wide).
  while (last && noteWidth(last) + 1 > NOTE_MAX_CHARS) last = Array.from(last).slice(0, -1).join("");
  lines[NOTE_MAX_LINES - 1] = `${last}…`;
  return lines;
}

// Shrink factor that keeps a label clear of the header button. Monospace, so the
// rendered width is estimated from the cell count (CJK glyphs span two cells).
export function fitScale(text: string, fontSize: number, letterSpacing: number, maxW: number): number {
  const est = noteWidth(text) * (fontSize * MONO_ADVANCE + letterSpacing);
  return est > maxW ? Math.max(LABEL_MIN_SCALE, maxW / est) : 1;
}
