// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { setHeardText, setNamedText, setSaid, setSpokenText, setTip, spoken, tipOf } from "./glyph";
import { holdsMark } from "./spoken-mark";
import { setLang } from "../i18n";
import { en } from "../i18n/en";
import { ja } from "../i18n/ja";

// The polarity mark is one symbol, Ф (U+0424), on every surface and in both languages, and
// every surface that prints it names its control by the word it stands for.
const PHASE = "Ф";
// The marks the polarity control has been written with: each draws differently from Ф in one
// of the fonts the UI resolves to, or is not a circle with a vertical bar at all.
const RETIRED = ["φ", "ϕ", "Φ", "Ø", "⌀"];

// No mark is announced through a part with a role of its own: a screen reader names that role
// after each part (Windows' Narrator reads "グラフィック" after every image), so a name is an
// attribute of the element that carries it and a sentence is a run of text.
describe("setNamedText", () => {
  it("keeps the text as printed and names the element by its spoken form", () => {
    const el = document.createElement("button");
    setNamedText(el, "CH 5/6");
    expect(el.textContent).toBe("CH 5/6");
    expect(el.getAttribute("aria-label")).toBe("C H 5 slash 6");
    expect(el.children).toHaveLength(0);
  });

  it("names a symbol caption by its word, and leaves a name with no mark unnamed", () => {
    const chip = document.createElement("div");
    setNamedText(chip, PHASE, "Phase");
    expect([chip.textContent, chip.getAttribute("aria-label")]).toEqual([PHASE, "Phase"]);
    setNamedText(chip, "MUTE");
    expect(chip.hasAttribute("aria-label"), "a name read as printed carries no second one").toBe(false);
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
    ["ja", "CH 5/6、CH 6 (R) を表示中", "C H 5 スラッシュ 6、C H 6 (R) を表示中"],
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

describe("setSaid", () => {
  it("names a live region by the spoken form it holds, and by nothing while it holds none", () => {
    const region = document.createElement("span");
    setSaid(region, "Assigned CC 7 to C H 1 dot Level");
    expect([region.textContent, region.getAttribute("aria-label")]).toEqual([
      "Assigned CC 7 to C H 1 dot Level",
      "Assigned CC 7 to C H 1 dot Level",
    ]);
    setSaid(region, "");
    expect(region.textContent).toBe("");
    expect(region.hasAttribute("aria-label")).toBe(false);
  });
});

// The question the app and the E2E fixture both ask of a string: does it hold a mark that is
// announced by a reading of its own. Asked twice of one string, the answer does not change.
describe("holdsMark", () => {
  it("finds CH, an a/b pair, a slash and the middle dot, and nothing else", () => {
    for (const text of ["CH 1", "ch 5", "5/6", "on/off", "176.4 / 192 kHz", "KEY \u00b7 NONE"]) {
      expect(holdsMark(text), text).toBe(true);
      expect(holdsMark(text), `${text}, asked again`).toBe(true);
    }
    for (const text of ["MUTE", "ch1", "CHANNEL", "Pre-fader send"]) expect(holdsMark(text), text).toBe(false);
  });
});

describe("setHeardText", () => {
  it("puts the tooltip on the element itself where the two forms agree", () => {
    const td = document.createElement("td");
    setHeardText(td, "MAIN", "MAIN", true);
    expect(td.textContent).toBe("MAIN");
    expect(td.title).toBe("MAIN");
    expect(td.children).toHaveLength(0);
  });
});

describe("setSpokenText", () => {
  it("prints the text for the eye and its spoken form for assistive technology", () => {
    const el = document.createElement("p");
    setSpokenText(el, `Assigned CC 7 to CH 5/6 · ${PHASE}R`, true);
    const [shown, heard] = [...el.children] as HTMLElement[];
    expect(el.children).toHaveLength(2);
    expect(shown.getAttribute("aria-hidden")).toBe("true");
    expect(shown.textContent).toBe(`Assigned CC 7 to CH 5/6 · ${PHASE}R`);
    expect(heard.className).toBe("sr-only");
    expect(heard.textContent).toBe("Assigned CC 7 to C H 5 slash 6 dot Phase R");
    expect(el.querySelector("[role]"), "no part carries a role of its own").toBeNull();
  });

  it("leaves a caption symbol as printed where the sentence is not captioned", () => {
    const el = document.createElement("p");
    setSpokenText(el, `MIDI input error: ${PHASE} port`);
    expect(el.childNodes).toHaveLength(1);
    expect(el.textContent).toBe(`MIDI input error: ${PHASE} port`);
  });

  it("writes a sentence with no mark as plain text", () => {
    const el = document.createElement("p");
    setSpokenText(el, "Assigned CC 7 to MUTE");
    expect(el.childNodes).toHaveLength(1);
    expect(el.firstChild?.nodeType).toBe(Node.TEXT_NODE);
  });
});

// VoiceOver reads a control's own title as a hint in its printed form, and an aria-description
// beside it does not stop that: a tooltip whose spoken form differs sits on a hidden zone and the
// control is described by the spoken form.
describe("setTip", () => {
  it("moves a tooltip holding a mark off a control and describes the control by its spoken form", () => {
    const b = document.createElement("button");
    setTip(b, "Shared with CH 3\nCH 1 CC 21");
    const zone = b.querySelector<HTMLElement>(":scope > .tip-zone")!;
    expect(b.hasAttribute("title")).toBe(false);
    expect(zone.title).toBe("Shared with CH 3\nCH 1 CC 21");
    expect(zone.getAttribute("aria-hidden")).toBe("true");
    expect(b.getAttribute("aria-description")).toBe("Shared with C H 3 C H 1 CC 21");
    expect(tipOf(b)).toBe("Shared with CH 3\nCH 1 CC 21");
    setTip(b, "Restore CH 5/6");
    expect(b.querySelectorAll(".tip-zone"), "a second tooltip reuses the zone").toHaveLength(1);
    expect(tipOf(b)).toBe("Restore CH 5/6");
    expect(b.getAttribute("aria-description")).toBe("Restore C H 5 slash 6");
  });

  it("keeps a tooltip with no mark on the control itself", () => {
    const b = document.createElement("div");
    b.setAttribute("role", "slider");
    setTip(b, "CH 1 CC 21");
    setTip(b, "Pre-fader send");
    expect(b.title).toBe("Pre-fader send");
    expect(b.querySelector(".tip-zone")).toBeNull();
    expect(b.hasAttribute("aria-description")).toBe(false);
    setTip(b, "Not read from the device", true);
    expect(b.getAttribute("aria-description"), "a description asked for is kept").toBe("Not read from the device");
  });

  it("clears a tooltip it is handed no text for, and the description it wrote", () => {
    const b = document.createElement("button");
    setTip(b, "Pre-fader send");
    setTip(b, "");
    expect(b.hasAttribute("title")).toBe(false);
    setTip(b, "CH 1 CC 21");
    setTip(b, "");
    expect(b.querySelector(".tip-zone")).toBeNull();
    expect(b.hasAttribute("title")).toBe(false);
    expect(b.hasAttribute("aria-description")).toBe(false);
  });

  it("leaves a wrapper's tooltip where it is and describes the controls inside it", () => {
    const wrap = document.createElement("span");
    const input = document.createElement("input");
    wrap.append(input);
    setTip(wrap, "CH 1 CC 21");
    expect(wrap.title).toBe("CH 1 CC 21");
    expect(wrap.querySelector(".tip-zone")).toBeNull();
    expect(input.getAttribute("aria-description")).toBe("C H 1 CC 21");
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
