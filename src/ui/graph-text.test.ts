// The board's text measurement. Every case here is reachable through the app only
// by typing into a note textarea, which makes the interesting ones — a fullwidth
// token wider than the whole budget, a codepoint above the BMP, a clip whose last
// line is all wide glyphs — impractical to reach and trivial to state here.

import { describe, expect, it } from "vitest";
import {
  LABEL_MIN_SCALE,
  MONO_ADVANCE,
  NOTE_BOT_GAP,
  NOTE_LINE_H,
  NOTE_MAX_CHARS,
  NOTE_MAX_LINES,
  NOTE_PAD_Y,
  NOTE_TOP_GAP,
  cellW,
  clipNote,
  fitScale,
  noteWidth,
  notePanelHeight,
  wrapNote,
} from "./graph-text";

describe("cellW", () => {
  it("gives an ASCII glyph one cell", () => {
    for (const ch of ["a", "Z", "0", " ", "!", "~"]) expect(cellW(ch)).toBe(1);
  });

  it("gives CJK, kana and fullwidth forms two", () => {
    for (const ch of ["日", "あ", "ア", "한", "Ａ", "，"]) expect(cellW(ch)).toBe(2);
  });

  // The emoji ranges sit above the BMP, so they are only measured correctly if the
  // codepoint is read rather than the UTF-16 unit.
  it("gives an emoji two cells, reading the codepoint rather than the unit", () => {
    expect(cellW("🎛")).toBe(2);
    expect(cellW("🔊")).toBe(2);
    expect("🎛".length).toBe(2); // two UTF-16 units, one glyph
  });

  it("gives an empty string one cell rather than NaN", () => {
    expect(cellW("")).toBe(1);
  });
});

describe("noteWidth", () => {
  it("sums cells, not characters", () => {
    expect(noteWidth("abc")).toBe(3);
    expect(noteWidth("日本語")).toBe(6);
    expect(noteWidth("CH1 入力")).toBe(4 + 4);
  });

  it("counts a surrogate pair once", () => {
    expect(noteWidth("🎛🎛")).toBe(4);
  });

  it("is zero for an empty string", () => {
    expect(noteWidth("")).toBe(0);
  });
});

describe("wrapNote", () => {
  it("keeps a short line whole", () => {
    expect(wrapNote("hello", 21)).toEqual(["hello"]);
  });

  it("breaks at spaces without splitting a word that fits", () => {
    expect(wrapNote("aaaa bbbb cccc", 9)).toEqual(["aaaa bbbb", "cccc"]);
  });

  // The line breaks the user typed are theirs; a blank paragraph stays a blank line.
  it("preserves typed line breaks and blank paragraphs", () => {
    expect(wrapNote("one\ntwo", 21)).toEqual(["one", "two"]);
    expect(wrapNote("one\n\ntwo", 21)).toEqual(["one", "", "two"]);
    expect(wrapNote("a\r\nb", 21)).toEqual(["a", "b"]);
  });

  // A hard split is the only break CJK allows, and it is measured in cells.
  it("hard-splits a token wider than the whole budget", () => {
    expect(wrapNote("日本語日本語日本語", 6)).toEqual(["日本語", "日本語", "日本語"]);
  });

  it("flushes the line in progress before hard-splitting", () => {
    expect(wrapNote("ab 日本語日本語", 6)).toEqual(["ab", "日本語", "日本語"]);
  });

  // A hard split walks codepoints, so a surrogate pair is never cut in half.
  it("never cuts a surrogate pair in half", () => {
    for (const line of wrapNote("🎛🎛🎛🎛", 4)) {
      expect([...line].every((ch) => cellW(ch) === 2)).toBe(true);
      expect(noteWidth(line)).toBeLessThanOrEqual(4);
    }
  });

  it("keeps every line inside the budget", () => {
    const text = "The quick brown fox jumps over the lazy dog 日本語のメモも混ざる";
    for (const line of wrapNote(text, 21)) expect(noteWidth(line)).toBeLessThanOrEqual(21);
  });

  it("returns one empty line for an empty note", () => {
    expect(wrapNote("", 21)).toEqual([""]);
    expect(wrapNote("   ", 21)).toEqual([""]);
  });
});

describe("notePanelHeight", () => {
  it("grows by one line height per line", () => {
    const one = notePanelHeight(["a"]);
    expect(notePanelHeight(["a", "b"]) - one).toBe(NOTE_LINE_H);
  });

  it("reserves the gaps and padding around the well", () => {
    expect(notePanelHeight([])).toBe(NOTE_TOP_GAP + NOTE_PAD_Y * 2 + NOTE_BOT_GAP);
  });
});

describe("clipNote", () => {
  it("has nothing to draw for a blank or absent note", () => {
    expect(clipNote("")).toEqual([]);
    expect(clipNote("   \n  ")).toEqual([]);
  });

  it("draws every line of a note that fits", () => {
    expect(clipNote("one\ntwo")).toEqual(["one", "two"]);
  });

  it("clips to the panel's line count and marks the cut with an ellipsis", () => {
    const lines = clipNote(Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"));
    expect(lines).toHaveLength(NOTE_MAX_LINES);
    expect(lines.at(-1)!.endsWith("…")).toBe(true);
  });

  // The ellipsis takes a cell of its own, so the last line is trimmed by whole
  // glyphs until the pair fits — which for wide glyphs means dropping two cells at
  // a time rather than one.
  it("trims the last line by whole glyphs until the ellipsis fits", () => {
    const wide = "日".repeat(NOTE_MAX_CHARS);
    const lines = clipNote(Array.from({ length: 8 }, () => wide).join("\n"));
    expect(lines).toHaveLength(NOTE_MAX_LINES);
    const last = lines.at(-1)!;
    expect(last.endsWith("…")).toBe(true);
    expect(noteWidth(last)).toBeLessThanOrEqual(NOTE_MAX_CHARS);
  });

  it("keeps every clipped line inside the panel's budget", () => {
    const lines = clipNote("日本語のとても長いメモ ".repeat(30));
    for (const line of lines) expect(noteWidth(line)).toBeLessThanOrEqual(NOTE_MAX_CHARS);
  });

  it("does not put an ellipsis on a note that was not cut", () => {
    expect(clipNote("short").at(-1)!.endsWith("…")).toBe(false);
  });
});

describe("fitScale", () => {
  const FS = 12;
  const LS = 1;

  it("leaves a label that already fits at full size", () => {
    expect(fitScale("CH 1", FS, LS, 122)).toBe(1);
  });

  // Shrunk only as far as it has to be, so the estimate lands exactly on the budget
  // — as long as that lands above the floor.
  it("shrinks a wide label to exactly the budget", () => {
    const text = "A".repeat(18); // 147.6 units at this size: over 122, under 122/0.7
    const scale = fitScale(text, FS, LS, 122);
    expect(scale).toBeGreaterThan(LABEL_MIN_SCALE);
    expect(scale).toBeLessThan(1);
    expect(noteWidth(text) * (FS * MONO_ADVANCE + LS) * scale).toBeCloseTo(122, 5);
  });

  // Past the floor the label is simply narrower than the button; shrinking further
  // would make it unreadable.
  it("stops shrinking at the floor", () => {
    expect(fitScale("あ".repeat(200), FS, LS, 122)).toBe(LABEL_MIN_SCALE);
  });

  it("measures a CJK label at two cells per glyph", () => {
    expect(fitScale("日本語", FS, LS, 122)).toBe(fitScale("aaaaaa", FS, LS, 122));
  });

  it("scales with the budget it is given", () => {
    const text = "A".repeat(30);
    expect(fitScale(text, FS, LS, 400)).toBeGreaterThan(fitScale(text, FS, LS, 122));
  });
});
