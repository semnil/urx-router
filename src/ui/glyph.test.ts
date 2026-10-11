// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { setSpokenText, setSymbolText, spoken } from "./glyph";
import { setLang } from "../i18n";
import { en } from "../i18n/en";
import { ja } from "../i18n/ja";

// The polarity mark is one symbol, Ф (U+0424), on every surface and in both languages, and
// every surface that prints it names its control by the word it stands for.
const PHASE = "Ф";
// The marks the polarity control has been written with: each draws differently from Ф in one
// of the fonts the UI resolves to, or is not a circle with a vertical bar at all.
const RETIRED = ["φ", "ϕ", "Φ", "Ø", "⌀"];

describe("setSymbolText", () => {
  it("keeps the symbol visible and names it by its word", () => {
    const el = document.createElement("div");
    el.textContent = "old";
    setSymbolText(el, PHASE, "Phase");
    expect(el.textContent).toBe(PHASE);
    const img = el.querySelector("[role='img']");
    expect(img?.getAttribute("aria-label")).toBe("Phase");
    expect(img?.textContent).toBe(PHASE);
    expect(el.childNodes).toHaveLength(1);
  });
});

// What a mark is read as, in each language: "CH" spelled, the slash of an a/b pair and the
// middle dot by their words, so neither becomes a country, a fraction, a date or a silence.
describe("spoken", () => {
  it.each([
    ["en", "Ducker CH 5/6 · Source", "Ducker C H 5 slash 6 dot Source"],
    ["ja", "Ducker CH 5/6 · Source", "Ducker C H 5 スラッシュ 6 てん Source"],
    ["ja", "ステレオ ch", "ステレオ C H"],
    ["en", "CH 5/6, showing CH 6 (R)", "C H 5 slash 6, showing C H 6 (R)"],
    ["en", "USB DAW 1/2", "USB DAW 1 slash 2"],
    ["en", "Output / Rec select", "Output slash Rec select"],
    ["ja", "MIC/LINE 1/2", "MIC スラッシュ LINE 1 スラッシュ 2"],
  ])("reads the marks of a name (%s): %s", (lang, text, read) => {
    setLang(lang as "en" | "ja");
    expect(spoken(text)).toBe(read);
    setLang("en");
  });

  it("leaves a word that only contains the letters, and a name with no mark, as it is", () => {
    expect(spoken("CHORUS · MACH 1")).toBe("CHORUS dot MACH 1");
    expect(spoken("STEREO (MAIN)")).toBe("STEREO (MAIN)");
  });

  it("reads a caption symbol by its word only where the sentence is captioned", () => {
    expect(spoken(`CH 1 · ${PHASE}`, true)).toBe("C H 1 dot Phase");
    expect(spoken(`CH 1 · ${PHASE}`)).toBe(`C H 1 dot ${PHASE}`);
  });
});

describe("setSpokenText", () => {
  it("keeps the text as printed and announces each mark and caption by its reading", () => {
    const el = document.createElement("p");
    setSpokenText(el, `Assigned CC 7 to CH 5/6 · ${PHASE}R, then CH 1 · ${PHASE}`, true);
    expect(el.textContent).toBe(`Assigned CC 7 to CH 5/6 · ${PHASE}R, then CH 1 · ${PHASE}`);
    const imgs = [...el.querySelectorAll("[role='img']")].map((i) => [i.textContent, i.getAttribute("aria-label")]);
    expect(imgs).toEqual([
      ["CH", "C H"],
      ["5/6", `5 ${en.speech.slash} 6`],
      ["·", en.speech.dot],
      [`${PHASE}R`, en.midi.paramSpoken.phaseR],
      ["CH", "C H"],
      ["·", en.speech.dot],
      [PHASE, en.midi.paramSpoken.phase],
    ]);
  });

  it("leaves a caption symbol as text where the sentence is not captioned", () => {
    const el = document.createElement("p");
    setSpokenText(el, `MIDI input error: ${PHASE} port`);
    expect(el.querySelector("[role='img']")).toBeNull();
  });

  it("writes a sentence with no mark as plain text", () => {
    const el = document.createElement("p");
    setSpokenText(el, "Assigned CC 7 to MUTE");
    expect(el.childNodes).toHaveLength(1);
    expect(el.firstChild?.nodeType).toBe(Node.TEXT_NODE);
  });
});

describe("the polarity mark", () => {
  for (const [lang, m] of [
    ["en", en],
    ["ja", ja],
  ] as const) {
    it(`is Ф on every caption, with a word for each (${lang})`, () => {
      expect(m.inspector.phase).toBe(PHASE);
      expect(m.midi.param.phase).toBe(PHASE);
      expect(m.midi.param.phaseL).toBe(`${PHASE}L`);
      expect(m.midi.param.phaseR).toBe(`${PHASE}R`);
      for (const word of [
        m.inspector.phaseName,
        m.midi.paramSpoken.phase,
        m.midi.paramSpoken.phaseL,
        m.midi.paramSpoken.phaseR,
      ]) {
        expect(word).toBeTruthy();
        expect(word).not.toContain(PHASE);
      }
    });
  }

  // Sources and documents, read as text: a retired mark written back into a label, a comment
  // or a document is red here. Test files are left out — they carry arbitrary Unicode as data.
  it("is written with no other mark in the sources and the documents", () => {
    // __dirname rather than import.meta.url: under jsdom the module URL is not a file URL.
    const root = resolve(__dirname, "../..");
    const files = ["src", "e2e", "docs/en", "docs/ja"].flatMap((dir) =>
      readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
        .filter((f) => /\.(ts|md)$/.test(f) && !/\.test(-util)?\.ts$/.test(f))
        .map((f) => join(root, dir, f)),
    );
    expect(files.length).toBeGreaterThan(50);
    const found = files.flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          RETIRED.filter((c) => line.includes(c)).map(
            (c) => `${relative(root, f)}:${i + 1} U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
          ),
        ),
    );
    expect(found).toEqual([]);
  });
});
