// External MIDI control orchestration (desktop only): owns the port
// connections, the per-model mapping persistence, the learn state the console
// arms into, and the feedback scheduling. The pure mapping logic lives in
// core/midi; incoming edits run the same funnel as console edits (BAL pair
// mirror + the shared change hook), so Live sync mirrors them to the device.

import type { DeviceModel, DeviceNode } from "../models/types";
import type { Plan } from "../core/plan";
import { loadJson, saveJson } from "../core/storage";
import {
  isTauri,
  midiCloseOutput,
  midiListInputs,
  midiListOutputs,
  midiOpenInput,
  midiOpenOutput,
  midiSend,
} from "../core/platform";
import { MidiEngine } from "../core/midi/engine";
import { bindControl, parseControlId, type BoundControl, type ControlParam } from "../core/midi/controls";
import {
  addrLabel,
  BUTTON_MODES,
  sanitizeMappings,
  TAKE_MODES,
  type MidiAddr,
  type MidiMapping,
} from "../core/midi/mapping";
import { mirrorBalPair } from "../core/routing";
import { el, popTop } from "./dom";
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

export class MidiControl {
  private engine: MidiEngine;
  // Dev diagnostic: set `localStorage["urx-midi-log"] = "1"` (reload to apply) to
  // trace every rx/tx byte string and the engine's per-message decision to the
  // console — the ground truth for "this press did not land" reports.
  private traceLog = localStorage.getItem("urx-midi-log") ? (msg: string) => console.debug("[midi]", msg) : undefined;
  private learnOn = false;
  private armed: string | null = null;
  private closeInput: (() => void) | null = null;
  private inputPort: string | null = null;
  private outputPort: string | null = null;
  private bound = new Map<string, BoundControl>();
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
      resolve: (id) => this.resolve(id),
      applied: (control) => {
        // Same funnel as a console edit: mirror onto a BAL-linked partner, then
        // let the app flag dirty / schedule live sync / repaint.
        const mirrored = mirrorBalPair(hooks.getModel(), hooks.getPlan(), control.node);
        hooks.onApplied(control, mirrored);
        this.scheduleFeedback();
      },
      send: (bytes) => {
        if (!this.outputPort) return;
        this.traceLog?.(`tx [${bytes.join(" ")}]`);
        void midiSend(bytes).catch(() => {});
      },
      learned: (addr) => this.onLearned(addr),
      learnPending: () => this.bumpLearnFlush(),
      now: () => performance.now(),
      trace: this.traceLog,
    });
    this.engine.setMappings(this.loadMappings());
    this.restorePorts();
  }

  /** Resolve a control id, memoized: an incoming sweep resolves per message and
   *  every fresh bind rebuilds the node's whole catalog. A bound control reads
   *  the plan lazily, so in-place edits stay live; the cache only goes stale
   *  when the plan object itself is replaced — onModelChanged clears it. Only
   *  hits are cached, so a send wired up later still binds on demand. */
  private resolve(id: string): BoundControl | null {
    const hit = this.bound.get(id);
    if (hit) return hit;
    const control = bindControl(this.hooks.getModel(), this.hooks.getPlan(), id);
    if (control) this.bound.set(id, control);
    return control;
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

  /** The console armed a control: the next MIDI input binds to it. An id the
   *  catalog cannot bind (a console control missing from controls.ts) is
   *  refused, so drift fails visibly at arm time instead of persisting a
   *  mapping that would be dead on receive. */
  arm(id: string): void {
    if (!this.resolve(id)) return;
    this.armed = id;
    this.engine.startLearn();
    this.hooks.onLearnChanged();
    this.updateLearnUi();
  }

  // ---- app integration ----

  /** The plan (and possibly the model) was replaced: reload that model's
   *  mappings and resync the controller to the new plan values. */
  onModelChanged(): void {
    // An in-flight learn was armed against the old model; committing it now
    // would persist a mapping under the new model that may never bind.
    this.setLearn(false);
    this.bound.clear(); // bound controls captured the old plan object
    this.engine.setMappings(this.loadMappings());
    if (this.panel && !this.panel.hidden) this.renderList();
    this.runFeedback(true);
  }

  /** Batch a feedback pass after a plan edit (debounced; called from the shared
   *  change funnel, so UI / follow / MIDI edits all land here). */
  scheduleFeedback(): void {
    if (!this.outputPort || this.feedbackTimer) return;
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
      // Capture phase, like the toolbar menus: console / graph handlers may
      // stop propagation, but an outside press must still dismiss the panel.
      document.addEventListener("pointerdown", this.onOutside, true);
    } else {
      this.closePanel();
    }
  }

  /** A press outside the panel dismisses it — except while learn is on
   *  (arming clicks land on console controls outside the panel) and on the
   *  menu entry itself (its click handler toggles; closing here would make
   *  that toggle reopen the panel). */
  private onOutside = (e: PointerEvent): void => {
    const target = e.target as Node;
    if (this.panel!.contains(target) || (target as Element).closest?.("#btn-midi")) return;
    if (this.learnOn) return;
    this.closePanel();
  };

  private closePanel(): void {
    if (!this.panel) return;
    document.removeEventListener("pointerdown", this.onOutside, true);
    this.panel.hidden = true;
    this.setLearn(false);
  }

  // ---- ports ----

  private restorePorts(): void {
    if (!isTauri()) return;
    const s = this.store();
    // Boot restore is best-effort (a saved port may be unplugged right now);
    // the two opens are independent, so let them run concurrently.
    if (s.input) void this.openInput(s.input, true);
    if (s.output) void this.openOutput(s.output, true);
  }

  private async openInput(port: string, silent = false): Promise<void> {
    try {
      // The Rust side replaces any prior input, so no explicit close first.
      this.closeInput = await midiOpenInput(port, (bytes) => {
        this.traceLog?.(`rx [${bytes.join(" ")}]`);
        this.engine.onMessage(bytes);
      });
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
      this.runFeedback(true); // align motor faders / LEDs with the plan at once
    } catch (err) {
      this.outputPort = null;
      if (!silent) this.hooks.onStatus(t().midi.outputError(err instanceof Error ? err.message : String(err)));
    }
  }

  private async setInputPort(port: string | null): Promise<void> {
    if (port) {
      await this.openInput(port);
      // A failed open (exclusive / unplugged port) left no input: put the
      // select back on "none" so it does not keep showing a dead choice.
      if (!this.inputPort) this.inSel.value = "";
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
      if (!this.outputPort) this.outSel.value = "";
    } else {
      void midiCloseOutput();
      this.outputPort = null;
    }
    this.savePorts();
  }

  // ---- feedback ----

  private runFeedback(resync: boolean): void {
    if (!this.outputPort) return;
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
    // One binding per console control (replace the control's old binding). An
    // address may be shared: learning several controls to one physical control
    // gangs them, and the first-learned (list head) owns that address' feedback.
    const next = this.engine.getMappings().filter((m) => m.control !== id);
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
    const byId = (nid: string): DeviceNode | undefined => nodes.find((n) => n.id === nid);
    const self = byId(parsed.node);
    // A hung node (a ducker under its stereo channel) is labeled just "Ducker",
    // which does not say which channel it belongs to: show the parent's name
    // (attachTo) instead, so the assignment reads e.g. "CH 5/6 · DUCKER".
    const owner = self?.attachTo ? byId(self.attachTo) : self;
    const node = owner?.label ?? parsed.node;
    const send = parsed.send ? ` → ${byId(parsed.send)?.label ?? parsed.send}` : "";
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
    // Option legend card: while a take-in / button select is hovered or
    // focused, every option is listed here with a one-line behavior note (a
    // native dropdown cannot annotate its own options). Floats anchored to the
    // owning row (placeInfo); hidden when idle.
    this.infoEl = el("div", "mp-info");
    this.infoEl.hidden = true;
    // Scrolling moves the rows out from under a shown card; hide it rather
    // than track (the next hover re-anchors it).
    this.listEl.addEventListener("scroll", () => this.hideInfo(), { passive: true });

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
    this.hintEl.textContent = !this.learnOn
      ? m.hintIdle
      : this.armed
        ? m.hintArmed(this.labelOf(this.armed))
        : m.hintLearn;
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
    this.hideInfo();
    this.listEl.replaceChildren();
    // Gangs render contiguously (head then its members), so a member can drop
    // the repeated address and just mark itself as linked to the row above.
    const mappings = this.engine.getGangedMappings();
    if (mappings.length === 0) {
      const empty = el("div", "mp-empty");
      empty.textContent = m.noMappings;
      this.listEl.append(empty);
      return;
    }
    for (const mapping of mappings) {
      const linked = this.engine.isLinkedMember(mapping);
      const row = el("div", linked ? "mp-row linked" : "mp-row");
      row.dataset.control = mapping.control;
      const label = this.labelOf(mapping.control);
      const name = el("div", "mp-ctl");
      name.textContent = label;
      name.title = label; // the cell ellipsizes long names; hover shows the full one
      // A gang member shares the head's physical control, so it carries no
      // address of its own: the address slot shows a "Linked" marker instead of
      // repeating it, which keeps the select column aligned across every row.
      const addr = el("div", "mp-addr");
      if (linked) {
        addr.textContent = m.linked;
        addr.title = `${m.linkedHint}\n${addrLabel(mapping.addr)}`;
      } else {
        addr.textContent = addrLabel(mapping.addr);
      }
      row.append(name, addr);
      // The take-in mode applies to continuous controls only (toggles just fire).
      const control = this.resolve(mapping.control);
      if (control?.kind === "continuous") {
        this.addChoice(
          row,
          "mp-mode",
          TAKE_MODES,
          mapping.mode,
          () => ({ title: t().midi.modeTitle, who: label, label: t().midi.mode, desc: t().midi.modeDesc }),
          (mode) => this.patchMapping(mapping, { mode }),
        );
      } else if (control?.kind === "toggle" && mapping.addr.type !== "pitchbend") {
        // Button behavior, named after the sender's button type: Momentary
        // (edge, the default — flip per press) or Toggle (state — the value is
        // the state, for alternating senders like Stream Deck toggle buttons).
        this.addChoice(
          row,
          "mp-btn",
          BUTTON_MODES,
          mapping.button ?? "edge",
          () => ({
            title: t().midi.buttonModeTitle,
            who: label,
            label: t().midi.buttonMode,
            desc: t().midi.buttonModeDesc,
          }),
          (button) => this.patchMapping(mapping, { button }),
        );
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

  /** One mapping-option select: options from `values`, named/explained by the
   *  `content` thunk (the i18n tables plus the setting name and the owning
   *  assignment; a thunk, so a language switch between interactions
   *  re-reads), the legend wired, a change handed to `onPick`. */
  private addChoice<T extends string>(
    row: HTMLElement,
    cls: string,
    values: readonly T[],
    current: T,
    content: () => { title: string; who: string; label: Record<T, string>; desc: Record<T, string> },
    onPick: (v: T) => void,
  ): void {
    const sel = document.createElement("select");
    sel.className = cls;
    const c = content();
    for (const value of values) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = c.label[value];
      sel.append(opt);
    }
    sel.value = current;
    sel.setAttribute("aria-label", `${c.title} — ${c.who}`);
    sel.addEventListener("change", () => onPick(sel.value as T));
    this.wireLegend(sel, row, values, content);
    row.append(sel);
  }

  // ---- option legend ----

  /** Show the legend card for one select: a header naming the setting and the
   *  owning assignment, then every option with its behavior note, the
   *  selected one highlighted. `content` is a thunk so a language switch
   *  between interactions re-reads the active catalog. */
  private wireLegend<T extends string>(
    sel: HTMLSelectElement,
    row: HTMLElement,
    values: readonly T[],
    content: () => { title: string; who: string; label: Record<T, string>; desc: Record<T, string> },
  ): void {
    const show = (): void => {
      const c = content();
      this.infoEl.replaceChildren();
      const ph = el("div", "ph");
      const cat = el("span", "cat");
      cat.textContent = c.title;
      const who = el("span", "who");
      who.textContent = c.who;
      ph.append(cat, who);
      this.infoEl.append(ph);
      for (const v of values) {
        const ln = el("div", "ln" + (v === sel.value ? " cur" : ""));
        const nm = el("span", "nm");
        nm.textContent = c.label[v];
        ln.append(nm, document.createTextNode(" — " + c.desc[v]));
        this.infoEl.append(ln);
      }
      this.infoEl.hidden = false;
      this.placeInfo(row);
    };
    const hide = (): void => this.hideInfo();
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

  /** Anchor the legend card to the owning row: preferred directly below it,
   *  flipped directly above when the viewport bottom is close (popTop) —
   *  either way the row and its hovered select stay visible beside the card.
   *  The width write precedes the height read: the card's wrap depends on it. */
  private placeInfo(row: HTMLElement): void {
    if (!this.panel) return;
    const panelBox = this.panel.getBoundingClientRect();
    const s = this.infoEl.style;
    s.left = `${panelBox.left + 6}px`;
    s.width = `${panelBox.width - 12}px`;
    s.top = `${popTop(row.getBoundingClientRect(), this.infoEl.offsetHeight, 6)}px`;
  }

  private hideInfo(): void {
    this.infoEl.hidden = true;
    this.infoEl.replaceChildren();
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
