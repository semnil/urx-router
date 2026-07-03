// External MIDI control orchestration (desktop only): owns the port
// connections, the per-model mapping persistence, the learn state the console
// arms into, and the feedback scheduling. The pure mapping logic lives in
// core/midi; incoming edits run the same funnel as console edits (BAL pair
// mirror + the shared change hook), so Live sync mirrors them to the device.

import type { DeviceModel } from "../models/types";
import type { Plan } from "../core/plan";
import { loadJson, saveJson } from "../core/storage";
import { isTauri, midiCloseOutput, midiListInputs, midiListOutputs, midiOpenInput, midiOpenOutput, midiSend } from "../core/platform";
import { MidiEngine } from "../core/midi/engine";
import { bindControl, parseControlId, type BoundControl, type ControlParam } from "../core/midi/controls";
import { addrKey, addrLabel, sanitizeMappings, type ButtonMode, type MidiAddr, type MidiMapping, type RelativeEncoding, type TakeMode } from "../core/midi/mapping";
import { mirrorBalPair } from "../core/routing";
import { t } from "../i18n";

export interface MidiHooks {
  getModel: () => DeviceModel;
  getPlan: () => Plan;
  /** An incoming MIDI message edited the plan through `control` (`mirrored` =
   *  the BAL-linked partner was updated too): dirty + live sync + repaint. */
  onApplied: (control: BoundControl, mirrored: boolean) => void;
  /** Learn mode / armed control / mappings changed: re-render the console. */
  onLearnChanged: () => void;
  onStatus: (msg: string) => void;
}

// One localStorage entry: the chosen ports (hardware-global) and the mapping
// list per model (control ids are model-specific).
interface MidiStore {
  input?: string;
  output?: string;
  models?: Record<string, unknown>;
}

const STORE_KEY = "urx-midi";

// Incoming edits already suppress their own echo (engine.lastSent); this pass
// batches feedback for edits from everywhere else (UI, device follow, plan load).
const FEEDBACK_DEBOUNCE_MS = 120;
// Re-try cadence for feedback deferred behind an in-progress incoming sweep.
const FEEDBACK_SETTLE_MS = 350;
// A lone CC learn candidate commits after this quiet gap (single-message buttons).
const LEARN_FLUSH_MS = 500;

const MODES: TakeMode[] = ["absolute", "pickup", "relative"];
const ENCODINGS: RelativeEncoding[] = ["twos", "offset64", "signbit"];
const BUTTON_MODES: ButtonMode[] = ["edge", "state"];

export class MidiControl {
  private engine: MidiEngine;
  private learnOn = false;
  private armed: string | null = null;
  private closeInput: (() => void) | null = null;
  private inputPort: string | null = null;
  private outputPort: string | null = null;
  private outputOpen = false;
  private feedbackTimer = 0;
  private settleTimer = 0;
  private learnFlushTimer = 0;
  private panel: HTMLElement | null = null;
  private titleEl!: HTMLElement;
  private inLabel!: HTMLElement;
  private outLabel!: HTMLElement;
  private inSel!: HTMLSelectElement;
  private outSel!: HTMLSelectElement;
  private learnBtn!: HTMLButtonElement;
  private hintEl!: HTMLElement;
  private listHead!: HTMLElement;
  private listEl!: HTMLElement;
  private infoEl!: HTMLElement;

  constructor(private hooks: MidiHooks) {
    this.engine = new MidiEngine({
      resolve: (id) => bindControl(hooks.getModel(), hooks.getPlan(), id),
      applied: (control) => {
        // Same funnel as a console edit: mirror onto a BAL-linked partner, then
        // let the app flag dirty / schedule live sync / repaint.
        const mirrored = mirrorBalPair(hooks.getModel(), hooks.getPlan(), control.node);
        hooks.onApplied(control, mirrored);
        this.scheduleFeedback();
      },
      send: (bytes) => {
        if (this.outputOpen) void midiSend(bytes).catch(() => {});
      },
      learned: (addr) => this.onLearned(addr),
      learnPending: () => this.bumpLearnFlush(),
      now: () => performance.now(),
    });
    this.engine.setMappings(this.loadMappings());
    void this.restorePorts();
  }

  // ---- console hooks ----

  learnActive(): boolean {
    return this.learnOn;
  }

  armedId(): string | null {
    return this.armed;
  }

  isMapped(id: string): boolean {
    return this.engine.isMapped(id);
  }

  /** The console armed a control: the next MIDI input binds to it. */
  arm(id: string): void {
    this.armed = id;
    this.engine.startLearn();
    this.hooks.onLearnChanged();
    this.updateLearnUi();
  }

  // ---- app integration ----

  /** The plan (and possibly the model) was replaced: reload that model's
   *  mappings and resync the controller to the new plan values. */
  onModelChanged(): void {
    this.engine.setMappings(this.loadMappings());
    if (this.panel && !this.panel.hidden) this.renderList();
    this.runFeedback(true);
  }

  /** Batch a feedback pass after a plan edit (debounced; called from the shared
   *  change funnel, so UI / follow / MIDI edits all land here). */
  scheduleFeedback(): void {
    if (!this.outputOpen || this.feedbackTimer) return;
    this.feedbackTimer = window.setTimeout(() => {
      this.feedbackTimer = 0;
      this.runFeedback(false);
    }, FEEDBACK_DEBOUNCE_MS);
  }

  /** Re-apply localized texts (language switch) to the open panel. */
  relocalize(): void {
    if (!this.panel) return;
    this.applyPanelI18n();
    this.renderList();
    this.updateLearnUi();
  }

  togglePanel(): void {
    if (!this.panel) this.buildPanel();
    const p = this.panel!;
    if (p.hidden) {
      p.hidden = false;
      void this.refreshPorts();
      this.renderList();
      this.updateLearnUi();
    } else {
      this.closePanel();
    }
  }

  private closePanel(): void {
    if (!this.panel) return;
    this.panel.hidden = true;
    this.setLearn(false);
  }

  // ---- ports ----

  private async restorePorts(): Promise<void> {
    if (!isTauri()) return;
    const s = this.store();
    // Boot restore is best-effort: a saved port may be unplugged right now.
    if (s.input) await this.openInput(s.input, true);
    if (s.output) await this.openOutput(s.output, true);
  }

  private async openInput(port: string, silent = false): Promise<void> {
    try {
      // The Rust side replaces any prior input, so no explicit close first.
      this.closeInput = await midiOpenInput(port, (bytes) => this.engine.onMessage(bytes));
      this.inputPort = port;
    } catch (err) {
      this.closeInput = null;
      this.inputPort = null;
      if (!silent) this.hooks.onStatus(t().midi.inputError(err instanceof Error ? err.message : String(err)));
    }
  }

  private async openOutput(port: string, silent = false): Promise<void> {
    try {
      await midiOpenOutput(port);
      this.outputPort = port;
      this.outputOpen = true;
      this.runFeedback(true); // align motor faders / LEDs with the plan at once
    } catch (err) {
      this.outputOpen = false;
      this.outputPort = null;
      if (!silent) this.hooks.onStatus(t().midi.outputError(err instanceof Error ? err.message : String(err)));
    }
  }

  private async setInputPort(port: string | null): Promise<void> {
    if (port) {
      await this.openInput(port);
    } else {
      this.closeInput?.();
      this.closeInput = null;
      this.inputPort = null;
    }
    this.savePorts();
  }

  private async setOutputPort(port: string | null): Promise<void> {
    if (port) {
      await this.openOutput(port);
    } else {
      void midiCloseOutput();
      this.outputOpen = false;
      this.outputPort = null;
    }
    this.savePorts();
  }

  // ---- feedback ----

  private runFeedback(resync: boolean): void {
    if (!this.outputOpen) return;
    const deferred = this.engine.feedback(resync);
    if (deferred && !this.settleTimer) {
      this.settleTimer = window.setTimeout(() => {
        this.settleTimer = 0;
        this.runFeedback(false);
      }, FEEDBACK_SETTLE_MS);
    }
  }

  // ---- learn ----

  private setLearn(on: boolean): void {
    if (this.learnOn === on) return;
    this.learnOn = on;
    if (!on) {
      this.armed = null;
      this.engine.cancelLearn();
      window.clearTimeout(this.learnFlushTimer);
      this.learnFlushTimer = 0;
    }
    this.hooks.onLearnChanged();
    this.updateLearnUi();
  }

  private bumpLearnFlush(): void {
    window.clearTimeout(this.learnFlushTimer);
    this.learnFlushTimer = window.setTimeout(() => this.engine.flushLearn(), LEARN_FLUSH_MS);
  }

  private onLearned(addr: MidiAddr): void {
    window.clearTimeout(this.learnFlushTimer);
    this.learnFlushTimer = 0;
    const id = this.armed;
    this.armed = null;
    if (!id) return;
    // One physical control per binding, one binding per control: replace both.
    const key = addrKey(addr);
    const next = this.engine.getMappings().filter((m) => m.control !== id && addrKey(m.addr) !== key);
    next.push({ control: id, addr, mode: "absolute" });
    this.applyMappings(next);
    this.hooks.onLearnChanged();
    this.updateLearnUi();
    this.hooks.onStatus(t().midi.bound(this.labelOf(id), addrLabel(addr)));
  }

  // ---- mappings ----

  private store(): MidiStore {
    const raw = loadJson<MidiStore>(STORE_KEY, {});
    return typeof raw === "object" && raw !== null ? raw : {};
  }

  private loadMappings(): MidiMapping[] {
    return sanitizeMappings(this.store().models?.[this.hooks.getModel().id]);
  }

  private applyMappings(next: MidiMapping[]): void {
    this.engine.setMappings(next);
    const s = this.store();
    s.models = { ...s.models, [this.hooks.getModel().id]: next };
    saveJson(STORE_KEY, s);
    if (this.panel && !this.panel.hidden) this.renderList();
    this.scheduleFeedback();
  }

  private savePorts(): void {
    const s = this.store();
    if (this.inputPort) s.input = this.inputPort;
    else delete s.input;
    if (this.outputPort) s.output = this.outputPort;
    else delete s.output;
    saveJson(STORE_KEY, s);
  }

  /** Human-readable control label: node label (model-fixed) + send target +
   *  the console's own wording for the control ("CH 1 → MIX 1 · Level"). */
  private labelOf(id: string): string {
    const parsed = parseControlId(id);
    if (!parsed) return id;
    const nodes = this.hooks.getModel().nodes;
    const node = nodes.find((n) => n.id === parsed.node)?.label ?? parsed.node;
    const send = parsed.send ? ` → ${nodes.find((n) => n.id === parsed.send)?.label ?? parsed.send}` : "";
    const param = t().midi.param[parsed.param as ControlParam] ?? parsed.param;
    return `${node}${send} · ${param}`;
  }

  // ---- panel ----

  private buildPanel(): void {
    const panel = el("div", "midi-panel");
    panel.id = "midi-panel";
    panel.hidden = true;

    const head = el("div", "mp-head");
    this.titleEl = el("span", "mp-title");
    const close = el("button", "mp-close") as HTMLButtonElement;
    close.type = "button";
    close.textContent = "✕";
    close.addEventListener("click", () => this.closePanel());
    head.append(this.titleEl, close);

    const ports = el("div", "mp-ports");
    const inRow = el("label", "mp-port");
    this.inLabel = el("span", "");
    this.inSel = document.createElement("select");
    this.inSel.className = "mp-in";
    this.inSel.addEventListener("change", () => void this.setInputPort(this.inSel.value || null));
    inRow.append(this.inLabel, this.inSel);
    const outRow = el("label", "mp-port");
    this.outLabel = el("span", "");
    this.outSel = document.createElement("select");
    this.outSel.className = "mp-out";
    this.outSel.addEventListener("change", () => void this.setOutputPort(this.outSel.value || null));
    outRow.append(this.outLabel, this.outSel);
    ports.append(inRow, outRow);

    const learnRow = el("div", "mp-learn");
    this.learnBtn = el("button", "mp-learn-btn") as HTMLButtonElement;
    this.learnBtn.type = "button";
    this.learnBtn.addEventListener("click", () => this.setLearn(!this.learnOn));
    this.hintEl = el("div", "mp-hint");
    learnRow.append(this.learnBtn, this.hintEl);

    this.listHead = el("div", "mp-listhead");
    this.listEl = el("div", "mp-list");
    // Option legend: while a take-in / encoding / button select is hovered or
    // focused, every option is listed here with a one-line behavior note (a
    // native dropdown cannot annotate its own options). Hidden when idle.
    this.infoEl = el("div", "mp-info");
    this.infoEl.hidden = true;

    panel.append(head, ports, learnRow, this.listHead, this.listEl, this.infoEl);
    document.body.append(panel);
    this.panel = panel;
    this.applyPanelI18n();
  }

  private applyPanelI18n(): void {
    const m = t().midi;
    this.titleEl.textContent = m.title;
    this.inLabel.textContent = m.input;
    this.outLabel.textContent = m.output;
    this.learnBtn.textContent = m.learn;
    this.listHead.textContent = m.mappings;
  }

  private updateLearnUi(): void {
    if (!this.panel) return;
    const m = t().midi;
    this.learnBtn.setAttribute("aria-pressed", String(this.learnOn));
    this.learnBtn.classList.toggle("on", this.learnOn);
    this.hintEl.textContent = !this.learnOn ? m.hintIdle : this.armed ? m.hintArmed(this.labelOf(this.armed)) : m.hintLearn;
  }

  // Re-enumerate the ports (midir has no hot-plug events, so every panel open
  // re-lists) and rebuild both selects around the current choice — which is kept
  // selectable even when its device is currently unplugged.
  private async refreshPorts(): Promise<void> {
    const [ins, outs] = await Promise.all([midiListInputs().catch(() => []), midiListOutputs().catch(() => [])]);
    fillPortSelect(this.inSel, ins, this.inputPort);
    fillPortSelect(this.outSel, outs, this.outputPort);
  }

  private renderList(): void {
    if (!this.panel) return;
    const m = t().midi;
    // Rebuilding detaches the selects, so a legend they were showing would
    // never receive its blur/leave — clear it with them.
    this.infoEl.hidden = true;
    this.infoEl.replaceChildren();
    this.listEl.replaceChildren();
    const mappings = this.engine.getMappings();
    if (mappings.length === 0) {
      const empty = el("div", "mp-empty");
      empty.textContent = m.noMappings;
      this.listEl.append(empty);
      return;
    }
    for (const mapping of mappings) {
      const row = el("div", "mp-row");
      row.dataset.control = mapping.control;
      const name = el("div", "mp-ctl");
      name.textContent = this.labelOf(mapping.control);
      const addr = el("div", "mp-addr");
      addr.textContent = addrLabel(mapping.addr);
      row.append(name, addr);
      // The take-in mode applies to continuous controls only (toggles just fire).
      const control = bindControl(this.hooks.getModel(), this.hooks.getPlan(), mapping.control);
      if (control?.kind === "continuous") {
        const mode = document.createElement("select");
        mode.className = "mp-mode";
        for (const value of MODES) {
          const opt = document.createElement("option");
          opt.value = value;
          opt.textContent = m.mode[value];
          mode.append(opt);
        }
        mode.value = mapping.mode;
        mode.addEventListener("change", () => {
          this.patchMapping(mapping, { mode: mode.value as TakeMode });
        });
        this.wireLegend(mode, () => MODES.map((v) => ({ value: v, label: t().midi.mode[v], desc: t().midi.modeDesc[v] })));
        row.append(mode);
        if (mapping.mode === "relative") {
          const enc = document.createElement("select");
          enc.className = "mp-enc";
          for (const value of ENCODINGS) {
            const opt = document.createElement("option");
            opt.value = value;
            opt.textContent = m.encoding[value];
            enc.append(opt);
          }
          enc.value = mapping.encoding ?? "twos";
          enc.addEventListener("change", () => {
            this.patchMapping(mapping, { encoding: enc.value as RelativeEncoding });
          });
          this.wireLegend(enc, () => ENCODINGS.map((v) => ({ value: v, label: t().midi.encoding[v], desc: t().midi.encodingDesc[v] })));
          row.append(enc);
        }
      } else if (control?.kind === "toggle" && mapping.addr.type !== "pitchbend") {
        // Toggle behavior: flip per press (momentary buttons, the default) or
        // follow the value (alternating senders, e.g. Stream Deck toggles).
        const btn = document.createElement("select");
        btn.className = "mp-btn";
        for (const value of BUTTON_MODES) {
          const opt = document.createElement("option");
          opt.value = value;
          opt.textContent = m.buttonMode[value];
          btn.append(opt);
        }
        btn.value = mapping.button ?? "edge";
        btn.addEventListener("change", () => {
          this.patchMapping(mapping, { button: btn.value as ButtonMode });
        });
        this.wireLegend(btn, () => BUTTON_MODES.map((v) => ({ value: v, label: t().midi.buttonMode[v], desc: t().midi.buttonModeDesc[v] })));
        row.append(btn);
      }
      const del = el("button", "mp-del") as HTMLButtonElement;
      del.type = "button";
      del.textContent = "✕";
      del.title = m.remove;
      del.addEventListener("click", () => {
        this.applyMappings(this.engine.getMappings().filter((x) => x !== mapping));
        this.hooks.onLearnChanged(); // drop the mapped badge on the console
      });
      row.append(del);
      this.listEl.append(row);
    }
  }

  private patchMapping(mapping: MidiMapping, patch: Partial<MidiMapping>): void {
    this.applyMappings(this.engine.getMappings().map((x) => (x === mapping ? { ...x, ...patch } : x)));
  }

  // ---- option legend ----

  /** Show the legend for one select: every option with its behavior note, the
   *  selected one highlighted. `options` is a thunk so a language switch
   *  between interactions re-reads the active catalog. */
  private wireLegend(sel: HTMLSelectElement, options: () => Array<{ value: string; label: string; desc: string }>): void {
    const show = (): void => {
      this.infoEl.replaceChildren();
      for (const o of options()) {
        const ln = el("div", "ln" + (o.value === sel.value ? " cur" : ""));
        const nm = el("span", "nm");
        nm.textContent = o.label;
        ln.append(nm, document.createTextNode(" — " + o.desc));
        this.infoEl.append(ln);
      }
      this.infoEl.hidden = false;
    };
    const hide = (): void => {
      this.infoEl.hidden = true;
      this.infoEl.replaceChildren();
    };
    // No "change" handler: a change patches the mapping, which rebuilds the
    // list (renderList) — the legend is cleared there, since blur/leave never
    // fire on the detached select.
    sel.addEventListener("focus", show);
    sel.addEventListener("pointerenter", show);
    sel.addEventListener("blur", hide);
    sel.addEventListener("pointerleave", () => {
      if (document.activeElement !== sel) hide();
    });
  }
}

function fillPortSelect(sel: HTMLSelectElement, ports: string[], current: string | null): void {
  sel.replaceChildren();
  const none = document.createElement("option");
  none.value = "";
  none.textContent = t().midi.portNone;
  sel.append(none);
  const names = current && !ports.includes(current) ? [...ports, current] : ports;
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    sel.append(opt);
  }
  sel.value = current ?? "";
}

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
