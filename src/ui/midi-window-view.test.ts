// @vitest-environment jsdom

// The MIDI window's view is the whole window: it holds no plan, no engine and no
// port, so "state in, DOM out, intent back" is the entire contract. These drive it
// directly — no relay, no Tauri — and check both halves of that contract.

import { beforeEach, describe, expect, it } from "vitest";
import { renderMidiWindow, legend, mappingRow } from "./midi-window-view";
import type { MidiUiIntent, MidiUiRow, MidiUiState } from "./midi-protocol";
import { setLang, t } from "../i18n";

const baseState = (over: Partial<MidiUiState> = {}): MidiUiState => ({
  inputs: [],
  outputs: [],
  input: null,
  output: null,
  rows: [],
  learnOn: false,
  armed: null,
  status: "",
  lang: "en",
  theme: "dark",
  ...over,
});

const row = (over: Partial<MidiUiRow> = {}): MidiUiRow => ({
  control: "ch1/level@bus.mix1",
  label: "CH 1 · Level",
  addr: "CC 7 ch 1",
  kind: "continuous",
  option: "mode",
  mode: "absolute",
  linked: false,
  ...over,
});

function fixture(state: MidiUiState): { host: HTMLElement; sent: MidiUiIntent[] } {
  const host = document.createElement("div");
  document.body.append(host);
  const sent: MidiUiIntent[] = [];
  renderMidiWindow(host, state, (i) => sent.push(i));
  return { host, sent };
}

const change = (node: Element, value: string): void => {
  (node as HTMLSelectElement).value = value;
  node.dispatchEvent(new Event("change"));
};

beforeEach(() => {
  setLang("en");
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-theme");
});

describe("renderMidiWindow — shell", () => {
  it("carries the theme onto the document and titles the window", () => {
    fixture(baseState({ theme: "light" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.title).toBe(t().midi.title);
  });

  it("replaces the previous paint rather than appending to it", () => {
    const host = document.createElement("div");
    const noop = (): void => {};
    renderMidiWindow(host, baseState({ status: "first" }), noop);
    renderMidiWindow(host, baseState({ status: "second" }), noop);
    expect(host.querySelectorAll(".mw-status")).toHaveLength(1);
    expect(host.querySelector(".mw-status")!.textContent).toBe("second");
  });

  it("announces the status line to assistive tech", () => {
    const { host } = fixture(baseState({ status: "Assigned CC 7 to CH 1 · Level" }));
    const status = host.querySelector(".mw-status")!;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toBe("Assigned CC 7 to CH 1 · Level");
  });
});

describe("renderMidiWindow — ports", () => {
  it("offers None plus every listed port, and selects the current one", () => {
    const { host } = fixture(baseState({ inputs: ["A In", "B In"], input: "B In" }));
    const sel = host.querySelector(".mw-in") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(["", "A In", "B In"]);
    expect(sel.value).toBe("B In");
    expect(sel.getAttribute("aria-label")).toBe(t().midi.input);
    expect(sel.options[0].textContent).toBe(t().midi.portNone);
  });

  // A chosen port that has been unplugged is no longer in the list; dropping it
  // would silently show a different device than the one in use.
  it("keeps an unplugged current port selectable", () => {
    const { host } = fixture(baseState({ outputs: ["A Out"], output: "Gone Out" }));
    const sel = host.querySelector(".mw-out") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(["", "A Out", "Gone Out"]);
    expect(sel.value).toBe("Gone Out");
  });

  it("shows an empty selection when no port is chosen", () => {
    const { host } = fixture(baseState({ inputs: ["A In"] }));
    expect((host.querySelector(".mw-in") as HTMLSelectElement).value).toBe("");
  });

  it("reports a picked port, and None as a null name", () => {
    const { host, sent } = fixture(baseState({ inputs: ["A In"], outputs: ["A Out"], output: "A Out" }));
    change(host.querySelector(".mw-in")!, "A In");
    change(host.querySelector(".mw-out")!, "");
    expect(sent).toEqual([
      { type: "port", dir: "in", name: "A In" },
      { type: "port", dir: "out", name: null },
    ]);
  });
});

describe("renderMidiWindow — learn", () => {
  it("is idle with learn off: no lit dot, aria-pressed false, idle hint", () => {
    const { host } = fixture(baseState());
    expect(host.querySelector(".mw-dot")!.className).toBe("mw-dot");
    const btn = host.querySelector(".mw-learnbtn") as HTMLButtonElement;
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector(".mw-hint")!.textContent).toBe(t().midi.hintIdle);
  });

  it("lights the dot and asks for a control when learn is on but nothing is armed", () => {
    const { host } = fixture(baseState({ learnOn: true }));
    expect(host.querySelector(".mw-dot")!.className).toBe("mw-dot on");
    expect((host.querySelector(".mw-learnbtn") as HTMLButtonElement).getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector(".mw-hint")!.textContent).toBe(t().midi.hintLearn);
  });

  it("names the armed control once one is armed", () => {
    const { host } = fixture(baseState({ learnOn: true, armed: "CH 2 · Level" }));
    expect(host.querySelector(".mw-hint")!.textContent).toBe(t().midi.hintArmed("CH 2 · Level"));
  });

  it("reports the flipped learn state, not the current one", () => {
    const off = fixture(baseState());
    (off.host.querySelector(".mw-learnbtn") as HTMLButtonElement).click();
    expect(off.sent).toEqual([{ type: "learn", on: true }]);

    const on = fixture(baseState({ learnOn: true }));
    (on.host.querySelector(".mw-learnbtn") as HTMLButtonElement).click();
    expect(on.sent).toEqual([{ type: "learn", on: false }]);
  });
});

describe("renderMidiWindow — assignment list", () => {
  it("says so when there is nothing assigned, and prints no table or legend", () => {
    const { host } = fixture(baseState());
    expect(host.querySelector(".mw-empty")!.textContent).toBe(t().midi.noMappings);
    expect(host.querySelector(".mw-list")).toBeNull();
    expect(host.querySelector(".mw-legend")).toBeNull();
  });

  it("heads the table with the three named columns plus the delete column", () => {
    const { host } = fixture(baseState({ rows: [row()] }));
    const m = t().midi;
    expect([...host.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual([
      m.colControl,
      m.colAddr,
      m.colOption,
      "",
    ]);
  });

  it("keys each row by its control id and prints the address", () => {
    const { host } = fixture(baseState({ rows: [row({ control: "ch2/pan@bus.mix1", addr: "CC 10 ch 1" })] }));
    const tr = host.querySelector("tbody tr") as HTMLElement;
    expect(tr.dataset.control).toBe("ch2/pan@bus.mix1");
    expect(tr.className).toBe("");
    expect(tr.querySelector(".mw-addr")!.textContent).toBe("CC 10 ch 1");
  });

  // A gang member has no address of its own: the cell says Linked and explains why.
  it("marks a gang member instead of printing an address", () => {
    const { host } = fixture(baseState({ rows: [row({ addr: undefined, linked: true })] }));
    const tr = host.querySelector("tbody tr") as HTMLElement;
    expect(tr.className).toBe("linked");
    const cell = tr.querySelector(".mw-linked") as HTMLElement;
    expect(cell.textContent).toBe(t().midi.linked);
    expect(cell.title).toBe(t().midi.linkedHint);
  });

  it("offers the take-in vocabulary on a continuous row and reports a pick", () => {
    const { host, sent } = fixture(baseState({ rows: [row({ mode: "pickup" })] }));
    const sel = host.querySelector(".mw-mode") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(["absolute", "pickup"]);
    expect([...sel.options].map((o) => o.textContent)).toEqual([t().midi.mode.absolute, t().midi.mode.pickup]);
    expect(sel.value).toBe("pickup");
    change(sel, "absolute");
    expect(sent).toEqual([{ type: "mode", control: "ch1/level@bus.mix1", mode: "absolute" }]);
  });

  it("offers the button vocabulary on a toggle row and reports a pick", () => {
    const rows = [row({ control: "ch1/mute", kind: "toggle", option: "button", button: "state" })];
    const { host, sent } = fixture(baseState({ rows }));
    const sel = host.querySelector(".mw-btn") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(["edge", "state"]);
    expect(sel.value).toBe("state");
    change(sel, "edge");
    expect(sent).toEqual([{ type: "button", control: "ch1/mute", button: "edge" }]);
  });

  // A stored mapping predating the button setting has no `button`: the select must
  // still show the default rather than an empty selection.
  it("falls back to the momentary default when a toggle row carries no button mode", () => {
    const rows = [row({ kind: "toggle", option: "button", button: undefined })];
    const { host } = fixture(baseState({ rows }));
    expect((host.querySelector(".mw-btn") as HTMLSelectElement).value).toBe("edge");
  });

  // An address that can never fire a toggle offers nothing — but the cell stays,
  // so the delete button keeps its column.
  it("leaves the option cell empty when the row offers no behavior control", () => {
    const { host } = fixture(baseState({ rows: [row({ option: undefined })] }));
    const cell = host.querySelector(".mw-opt") as HTMLElement;
    expect(cell).not.toBeNull();
    expect(cell.childElementCount).toBe(0);
    expect(host.querySelectorAll("tbody tr td")).toHaveLength(4);
  });

  it("names the assignment in every select's aria-label, not just the setting", () => {
    const { host } = fixture(baseState({ rows: [row({ label: "CH 3 · Level" })] }));
    const sel = host.querySelector(".mw-mode") as HTMLSelectElement;
    expect(sel.getAttribute("aria-label")).toBe(`${t().midi.modeTitle} — CH 3 · Level`);
    expect(sel.title).toBe(t().midi.modeTitle);
  });

  it("names the assignment on the delete button and reports its control id", () => {
    const { host, sent } = fixture(baseState({ rows: [row({ control: "ch4/mute", label: "CH 4 · MUTE" })] }));
    const btn = host.querySelector(".mw-del") as HTMLButtonElement;
    expect(btn.type).toBe("button");
    expect(btn.title).toBe(t().midi.remove);
    expect(btn.getAttribute("aria-label")).toBe(`${t().midi.remove} — CH 4 · MUTE`);
    btn.click();
    expect(sent).toEqual([{ type: "remove", control: "ch4/mute" }]);
  });

  it("renders one row per assignment, in the order given", () => {
    const rows = [row({ control: "a" }), row({ control: "b" }), row({ control: "c" })];
    const { host } = fixture(baseState({ rows }));
    expect([...host.querySelectorAll("tbody tr")].map((tr) => (tr as HTMLElement).dataset.control)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("legend", () => {
  const m = t().midi;

  it("is absent when no row offers a vocabulary — the empty list's case included", () => {
    expect(legend([], m)).toBeNull();
    expect(legend([row({ option: undefined })], m)).toBeNull();
  });

  // A list of continuous controls says nothing about button behavior, so the key
  // describes the selects on screen rather than every select the window can build.
  it("prints only the take-in vocabulary for a continuous-only list", () => {
    const box = legend([row()], m)!;
    expect([...box.querySelectorAll("h4")].map((h) => h.textContent)).toEqual([m.modeTitle]);
    expect([...box.querySelectorAll("dt")].map((d) => d.textContent)).toEqual([m.mode.absolute, m.mode.pickup]);
    expect([...box.querySelectorAll("dd")].map((d) => d.textContent)).toEqual([m.modeDesc.absolute, m.modeDesc.pickup]);
  });

  it("prints only the button vocabulary for a toggle-only list", () => {
    const box = legend([row({ option: "button" })], m)!;
    expect([...box.querySelectorAll("h4")].map((h) => h.textContent)).toEqual([m.buttonModeTitle]);
    expect([...box.querySelectorAll("dt")].map((d) => d.textContent)).toEqual([m.buttonMode.edge, m.buttonMode.state]);
  });

  it("prints both vocabularies, take-in first, when the list mixes them", () => {
    const box = legend([row({ option: "button" }), row()], m)!;
    expect([...box.querySelectorAll("h4")].map((h) => h.textContent)).toEqual([m.modeTitle, m.buttonModeTitle]);
    expect(box.querySelectorAll("dl")).toHaveLength(2);
    expect(box.querySelectorAll("dd")).toHaveLength(4);
  });

  it("is appended under the table it explains", () => {
    const { host } = fixture(baseState({ rows: [row()] }));
    const list = host.querySelector(".mw-list")!.parentElement!;
    expect(list.lastElementChild!.className).toBe("mw-legend");
  });
});

describe("localization", () => {
  it("paints the active language, and repaints into the new one after a switch", () => {
    const host = document.createElement("div");
    const noop = (): void => {};
    const state = baseState({ rows: [row()] });
    renderMidiWindow(host, state, noop);
    const enTitle = host.querySelector(".mw-title")!.textContent;
    const enHint = host.querySelector(".mw-hint")!.textContent;

    setLang("ja");
    renderMidiWindow(host, state, noop);
    expect(host.querySelector(".mw-title")!.textContent).toBe(t().midi.title);
    expect(host.querySelector(".mw-hint")!.textContent).toBe(t().midi.hintIdle);
    expect(host.querySelector(".mw-title")!.textContent).not.toBe(enTitle);
    expect(host.querySelector(".mw-hint")!.textContent).not.toBe(enHint);
    expect(document.title).toBe(t().midi.title);
  });

  // The take-in / button option labels stay English in both catalogs (a fixed-width
  // select cannot hold the katakana forms), and only their notes are translated.
  it("keeps the vocabulary labels identical across catalogs and translates the notes", () => {
    setLang("ja");
    const box = legend([row(), row({ option: "button" })], t().midi)!;
    expect([...box.querySelectorAll("dt")].map((d) => d.textContent)).toEqual([
      "Absolute",
      "Pickup",
      "Momentary",
      "Toggle",
    ]);
    expect(box.querySelector("dd")!.textContent).toBe(t().midi.modeDesc.absolute);
    expect(box.querySelector("dd")!.textContent).not.toBe("");
  });
});

describe("mappingRow", () => {
  it("builds a standalone row usable outside a full paint", () => {
    const sent: MidiUiIntent[] = [];
    const tr = mappingRow(row(), t().midi, (i) => sent.push(i));
    expect(tr.tagName).toBe("TR");
    expect(tr.querySelectorAll("td")).toHaveLength(4);
    (tr.querySelector(".mw-del") as HTMLButtonElement).click();
    expect(sent).toEqual([{ type: "remove", control: "ch1/level@bus.mix1" }]);
  });
});
