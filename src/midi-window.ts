// The MIDI control window's entry point.
//
// This window is a view. It has no plan, no device model, no MIDI port and no
// engine: it renders the state the main window sends and reports what the operator
// did (ui/midi-protocol.ts). That is not a simplification for its own sake — a MIDI
// input port delivers its bursts to the window that opened it, so a window with no
// plan must never open one.
//
// It shares an origin with the main window, so the language and theme it starts in
// come straight out of the same localStorage keys; every state push then carries
// both, which is what makes a switch in the main window reach this one.

import "./style.css";
import { midiUiAttachWindow, midiUiToMain } from "./core/platform";
import { setLang, t } from "./i18n";
import type { Lang } from "./i18n";
import { el } from "./ui/dom";
import { parseRelay } from "./ui/midi-protocol";
import type { MidiUiIntent, MidiUiRow, MidiUiState } from "./ui/midi-protocol";
import { BUTTON_MODES, TAKE_MODES } from "./core/midi/mapping";

const send = (intent: MidiUiIntent): void => void midiUiToMain(JSON.stringify(intent)).catch(() => {});

let state: MidiUiState = {
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
};

const host = document.getElementById("midi-window") as HTMLElement;

// ---- shell -----------------------------------------------------------------

function sectionOf(title: string): HTMLElement {
  const sec = el("section", "mw-sec");
  const h = el("h3", "");
  h.textContent = title;
  sec.append(h);
  return sec;
}

function portRow(
  grid: HTMLElement,
  cls: string,
  label: string,
  ports: string[],
  current: string | null,
  pick: (name: string | null) => void,
): void {
  const name = el("span", "");
  name.textContent = label;
  const sel = document.createElement("select");
  sel.className = cls;
  const none = document.createElement("option");
  none.value = "";
  none.textContent = t().midi.portNone;
  sel.append(none);
  // A port that is currently chosen but unplugged stays selectable, so the window
  // does not silently show a different device than the one in use.
  for (const p of current && !ports.includes(current) ? [...ports, current] : ports) {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    sel.append(opt);
  }
  sel.value = current ?? "";
  sel.setAttribute("aria-label", label);
  sel.addEventListener("change", () => pick(sel.value || null));
  grid.append(name, sel);
}

/** A select over one of the mapping vocabularies, labelled from the i18n table.
 *  It announces the setting AND the assignment it sits on: the same select repeats
 *  down the column, so the setting name alone does not say which row was reached. */
function choice<T extends string>(
  cls: string,
  values: readonly T[],
  current: T,
  labels: Record<T, string>,
  title: string,
  who: string,
  onPick: (v: T) => void,
): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.className = cls;
  for (const v of values) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = labels[v];
    sel.append(opt);
  }
  sel.value = current;
  sel.setAttribute("aria-label", `${title} — ${who}`);
  sel.title = title;
  sel.addEventListener("change", () => onPick(sel.value as T));
  return sel;
}

/** The Behavior column's key: every option of every vocabulary the list actually
 *  offers, with its one-line note. A native dropdown cannot annotate its own
 *  options, so the notes are printed under the table they explain rather than
 *  revealed by a hover the operator has to discover first.
 *
 *  Only the vocabularies in use are printed — a list of continuous controls says
 *  nothing about button behavior — so the block describes the selects on screen
 *  rather than every select this window can build. Null when there is nothing to
 *  explain, which is also the empty list's case. */
function legend(rows: MidiUiRow[], m: ReturnType<typeof t>["midi"]): HTMLElement | null {
  const groups: Array<{ title: string; values: readonly string[]; text: Record<string, string> }> = [];
  if (rows.some((r) => r.option === "mode")) {
    groups.push({ title: m.modeTitle, values: TAKE_MODES, text: { ...m.mode } });
  }
  if (rows.some((r) => r.option === "button")) {
    groups.push({ title: m.buttonModeTitle, values: BUTTON_MODES, text: { ...m.buttonMode } });
  }
  if (groups.length === 0) return null;
  const notes: Record<string, string> = { ...m.modeDesc, ...m.buttonModeDesc };
  const box = el("div", "mw-legend");
  for (const g of groups) {
    const h = el("h4", "");
    h.textContent = g.title;
    const dl = document.createElement("dl");
    for (const v of g.values) {
      const dt = document.createElement("dt");
      dt.textContent = g.text[v];
      const dd = document.createElement("dd");
      dd.textContent = notes[v];
      dl.append(dt, dd);
    }
    box.append(h, dl);
  }
  return box;
}

function mappingRow(row: MidiUiRow, m: ReturnType<typeof t>["midi"]): HTMLElement {
  const tr = el("tr", row.linked ? "linked" : "");
  tr.dataset.control = row.control;
  const name = el("td", "mw-ctl");
  name.textContent = row.label;
  name.title = row.label;
  const addr = el("td", row.addr ? "mw-addr" : "mw-linked");
  addr.textContent = row.addr ?? m.linked;
  if (!row.addr) addr.title = m.linkedHint;
  const opt = el("td", "mw-opt");
  // Which control the row offers is the main window's verdict (see MidiUiRow.option):
  // an address that can never fire a toggle offers none, and the cell stays empty so
  // the delete button keeps its column.
  if (row.option === "mode") {
    opt.append(
      choice("mw-mode", TAKE_MODES, row.mode, m.mode, m.modeTitle, row.label, (mode) =>
        send({ type: "mode", control: row.control, mode }),
      ),
    );
  } else if (row.option === "button") {
    opt.append(
      choice("mw-btn", BUTTON_MODES, row.button ?? "edge", m.buttonMode, m.buttonModeTitle, row.label, (button) =>
        send({ type: "button", control: row.control, button }),
      ),
    );
  }
  const del = el("td", "");
  const btn = el("button", "mw-del") as HTMLButtonElement;
  btn.type = "button";
  btn.textContent = "✕";
  btn.title = m.remove;
  btn.setAttribute("aria-label", `${m.remove} — ${row.label}`);
  btn.addEventListener("click", () => send({ type: "remove", control: row.control }));
  del.append(btn);
  tr.append(name, addr, opt, del);
  return tr;
}

function render(): void {
  const m = t().midi;
  document.documentElement.setAttribute("data-theme", state.theme);
  document.title = m.title;
  host.replaceChildren();

  const head = el("div", "mw-head");
  const dot = el("span", state.learnOn ? "mw-dot on" : "mw-dot");
  const title = el("span", "mw-title");
  title.textContent = m.title;
  head.append(dot, title);

  const body = el("div", "mw-body");

  const ports = sectionOf(m.ports);
  const grid = el("div", "mw-ports");
  portRow(grid, "mw-in", m.input, state.inputs, state.input, (name) => send({ type: "port", dir: "in", name }));
  portRow(grid, "mw-out", m.output, state.outputs, state.output, (name) => send({ type: "port", dir: "out", name }));
  ports.append(grid);

  const learn = sectionOf(m.learn);
  const row = el("div", "mw-learn");
  const btn = el("button", state.learnOn ? "mw-learnbtn on" : "mw-learnbtn") as HTMLButtonElement;
  btn.type = "button";
  btn.textContent = m.learn;
  btn.setAttribute("aria-pressed", String(state.learnOn));
  btn.addEventListener("click", () => send({ type: "learn", on: !state.learnOn }));
  const hint = el("div", "mw-hint");
  hint.textContent = !state.learnOn ? m.hintIdle : state.armed ? m.hintArmed(state.armed) : m.hintLearn;
  row.append(btn, hint);
  learn.append(row);

  const list = sectionOf(m.mappings);
  if (state.rows.length === 0) {
    const empty = el("p", "mw-empty");
    empty.textContent = m.noMappings;
    list.append(empty);
  } else {
    const table = el("table", "mw-list");
    const thead = el("thead", "");
    const hr = el("tr", "");
    for (const text of [m.colControl, m.colAddr, m.colOption, ""]) {
      const th = el("th", "");
      th.textContent = text;
      hr.append(th);
    }
    thead.append(hr);
    const tbody = el("tbody", "");
    for (const r of state.rows) tbody.append(mappingRow(r, m));
    table.append(thead, tbody);
    list.append(table);
    const key = legend(state.rows, m);
    if (key) list.append(key);
  }

  body.append(ports, learn, list);

  const status = el("div", "mw-status");
  status.setAttribute("role", "status");
  status.textContent = state.status;

  host.append(head, body, status);
}

// ---- relay -----------------------------------------------------------------

void midiUiAttachWindow((payload) => {
  const next = parseRelay<MidiUiState>(payload);
  if (!next) return;
  state = next;
  setLang(state.lang as Lang);
  render();
});

// The main window holds the state; this one asks for it on boot and after any
// reload, so a reloaded window is never left rendering an empty list.
send({ type: "ready" });

// Closing the window has to reach the main window even when the OS tears it down
// without a Rust-side Destroyed (a reload, a crashed webview): learn mode is armed
// against a control the operator can no longer see.
window.addEventListener("pagehide", () => send({ type: "closed" }));

render();
