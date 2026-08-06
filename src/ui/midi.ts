// External MIDI control orchestration (desktop only): owns the port connections,
// the per-model mapping persistence, the learn state the arming surfaces arm into,
// and the feedback scheduling. The pure mapping logic lives in core/midi; incoming
// edits run the same funnel as console edits (BAL pair mirror + the shared change
// hook), so Live sync mirrors them to the device.
//
// The panel itself is a separate OS window (src/midi-window.ts). It is a view — this
// class holds every piece of state it renders and receives its intents back, because
// a MIDI input port delivers its bursts to the window that opened it, and only this
// window has a plan to apply them to.

import type { DeviceModel, DeviceNode } from "../models/types";
import type { Plan } from "../core/plan";
import { loadJson, saveJson } from "../core/storage";
import {
  closeMidiWindow,
  focusMidiWindow,
  isTauri,
  midiCloseOutput,
  midiListInputs,
  midiListOutputs,
  midiOpenInput,
  midiOpenOutput,
  midiOpenPorts,
  midiSend,
  midiUiAttachMain,
  midiUiToWindow,
  midiWindowGeometry,
  openMidiWindow,
} from "../core/platform";
import { MidiEngine } from "../core/midi/engine";
import {
  bindControl,
  parseControlId,
  type BoundControl,
  type ControlKind,
  type ControlParam,
} from "../core/midi/controls";
import { addrLabel, addrShort, sanitizeMappings, type MidiAddr, type MidiMapping } from "../core/midi/mapping";
import { mirrorBalPair } from "../core/routing";
import { parseRelay } from "./midi-protocol";
import type { MidiUiIntent, MidiUiState } from "./midi-protocol";
import { errorCode, errorText, getLang, t } from "../i18n";

export interface MidiHooks {
  getModel: () => DeviceModel;
  getPlan: () => Plan;
  /** An incoming MIDI message edited the plan through `control` (`mirrored` =
   *  the BAL-linked partner was updated too): dirty + live sync + repaint. */
  onApplied: (control: BoundControl, mirrored: boolean) => void;
  /** A localized refusal, or null when an incoming message may edit the plan
   *  (a device read mutating it across awaits, a file flow that can replace it). */
  blocked: () => string | null;
  /** Learn mode / armed control / mappings changed: re-render the arming
   *  surfaces (the CONSOLE strips and an open tuning screen). */
  onLearnChanged: () => void;
  onStatus: (msg: string) => void;
}

// One localStorage entry: the chosen ports (hardware-global) and the mapping
// list per model (control ids are model-specific).
interface MidiStore {
  input?: string;
  output?: string;
  models?: Record<string, unknown>;
  /** Where the operator last left the MIDI window. */
  window?: { x: number; y: number; width: number; height: number };
}

const STORE_KEY = "urx-midi";

/** Which behaviour control an assignment row offers. A toggle bound to a pitch bend
 *  or a 14-bit CC pair offers none: `toggleTarget` refuses both, so the binding is
 *  permanently inert and a button-behaviour select would suggest otherwise. */
function optionOf(kind: ControlKind, m: MidiMapping): "mode" | "button" | undefined {
  if (kind === "continuous") return "mode";
  return m.addr.type === "pitchbend" || m.addr.type === "cc14" ? undefined : "button";
}

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
  private traceLog = traceEnabled() ? (msg: string) => console.debug("[midi]", msg) : undefined;
  private learnOn = false;
  private armed: string | null = null;
  private closeInput: (() => void) | null = null;
  private inputPort: string | null = null;
  private outputPort: string | null = null;
  /** Opens that have been asked for but not answered — what `reconcileOpenPorts`
   *  stands down for, since the shell cannot describe a connection it is still making. */
  private opensInFlight = 0;
  /** Opens that have finished, counted so `reconcileOpenPorts` can tell whether one
   *  began and ended inside its own round trip — where the in-flight count is back to
   *  zero and the answer it is holding is already out of date. */
  private opensDone = 0;
  private bound = new Map<string, BoundControl>();
  // The plan object every entry in `bound` was bound against.
  private boundPlan: Plan | null = null;
  private feedbackTimer = 0;
  private settleTimer = 0;
  private learnFlushTimer = 0;
  /** True between the window's "ready" and its "closed": what makes a state push
   *  worth sending, and the only thing this side trusts about the window's life. */
  private windowOpen = false;
  private inputs: string[] = [];
  private outputs: string[] = [];
  /** The last thing worth saying, mirrored into the window (its own status line) as
   *  well as the app's — the window is where the operator is looking while binding. */
  private status = "";

  constructor(private hooks: MidiHooks) {
    this.engine = new MidiEngine({
      resolve: (id) => this.resolve(id),
      gate: () => hooks.blocked(),
      // Once per gated window — the engine decides that, so this is a plain status write.
      refused: (reason) => hooks.onStatus(reason),
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
        void midiSend(bytes).catch(() => {
          // The controller never got this value, so drop what the engine thinks
          // it has been told and schedule another pass. A dead port keeps
          // failing harmlessly; a one-off failure self-heals.
          this.traceLog?.("tx failed — re-sending feedback");
          this.engine.forgetFeedback();
          this.scheduleFeedback();
        });
      },
      learned: (addr) => this.onLearned(addr),
      learnPending: () => this.bumpLearnFlush(),
      now: () => performance.now(),
      trace: this.traceLog,
    });
    this.engine.setMappings(this.loadMappings());
    this.restorePorts();
    if (isTauri()) void this.attach();
  }

  /** Attach the relay for the app's lifetime — the MIDI window can open, close and
   *  reopen, and each time it announces itself with "ready".
   *
   *  The window can also OUTLIVE this side: reloading the main window (or a dev
   *  HMR reload) leaves it up with a fresh receiver on the other end and nothing to
   *  make it speak again, since "ready" is sent on its boot and not on ours. So the
   *  shell is asked whether the window is there — geometry answers only for a window
   *  that exists — and the state is pushed at it. Without this the window sat holding
   *  the previous session's list. */
  private async attach(): Promise<void> {
    try {
      await midiUiAttachMain((payload) => this.onIntent(payload));
      this.windowOpen = (await midiWindowGeometry()) !== null;
      if (this.windowOpen) {
        this.pushState();
        void this.refreshPorts();
      }
    } catch {
      // The relay is the window's lifeline, not the device's: with no window there
      // is nothing to report and nothing to salvage.
    }
  }

  /** Status goes to the app's own line and to the window's, since the window is
   *  what the operator is watching while assigning. */
  private say(message: string): void {
    this.status = message;
    this.hooks.onStatus(message);
    this.pushState();
  }

  /** Resolve a control id, memoized: an incoming sweep resolves per message and
   *  every fresh bind rebuilds the node's whole catalog. A bound control closes
   *  over the plan object it was bound against and reads it lazily, so in-place
   *  edits stay live — but a REPLACEMENT of that object leaves the whole cache
   *  reading and writing a plan nothing else references. Identity, not the model,
   *  is what makes it stale: a cancelled Fetch restores its pre-read clone
   *  outside loadPlan (main.ts), so onModelChanged never runs for it. Every other
   *  view resolves through getPlan() per use; this memo is the one holder. Only
   *  hits are cached, so a send wired up later still binds on demand. */
  private resolve(id: string): BoundControl | null {
    const plan = this.hooks.getPlan();
    if (plan !== this.boundPlan) {
      this.bound.clear();
      this.boundPlan = plan;
    }
    const hit = this.bound.get(id);
    if (hit) return hit;
    const control = bindControl(this.hooks.getModel(), plan, id);
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

  /** The address a control is bound to, at tooltip length — so a binding stays
   *  readable from the control itself when the MIDI window is behind the app. */
  addrOf(id: string): string | null {
    const bound = this.engine.getMappings().find((m) => m.control === id);
    return bound ? addrShort(bound.addr) : null;
  }

  /** An arming surface armed a control: the next MIDI input binds to it. An id the
   *  catalog cannot bind (a control missing from controls.ts) is refused, so drift
   *  fails visibly at arm time instead of persisting a mapping that would be dead
   *  on receive. */
  arm(id: string): void {
    if (!this.resolve(id)) return;
    this.armed = id;
    this.engine.startLearn();
    this.hooks.onLearnChanged();
    this.pushState();
  }

  // ---- app integration ----

  /** The plan (and possibly the model) was replaced: reload that model's
   *  mappings and resync the controller to the new plan values. */
  onModelChanged(): void {
    // An in-flight learn was armed against the old model; committing it now
    // would persist a mapping under the new model that may never bind.
    this.setLearn(false);
    // Eager: resolve() also drops the cache on a plan-identity change, but a model
    // switch changes what the ids themselves mean.
    this.bound.clear();
    this.boundPlan = null;
    this.engine.setMappings(this.loadMappings());
    this.pushState();
    this.runFeedback(true);
  }

  /** One of the latches behind `blocked` cleared: end the engine's reported
   *  refusal window, so the next one speaks up again (see MidiEngine.gateReleased). */
  gateReleased(): void {
    this.engine.gateReleased();
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

  // ---- ports ----

  private restorePorts(): void {
    if (!isTauri()) return;
    const s = this.store();
    // Boot restore is best-effort (a saved port may be unplugged right now); the
    // two opens are independent, so let them run concurrently. Not silent
    // though: a saved port that no longer exists otherwise leaves the window
    // showing a controller that was never actually opened, and the operator only
    // finds out when a fader does nothing. The failure goes to the status line,
    // not a dialog — nothing was interrupted, it just did not come back.
    if (s.input) void this.openInput(s.input);
    if (s.output) void this.openOutput(s.output);
  }

  private async openInput(port: string): Promise<void> {
    this.opensInFlight++;
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
      this.say(midiErrorStatus(err, t().midi.inputError));
    } finally {
      this.opensInFlight--;
      this.opensDone++;
    }
  }

  private async openOutput(port: string): Promise<void> {
    this.opensInFlight++;
    try {
      await midiOpenOutput(port);
      this.outputPort = port;
      this.runFeedback(true); // align motor faders / LEDs with the plan at once
    } catch (err) {
      this.outputPort = null;
      this.say(midiErrorStatus(err, t().midi.outputError));
    } finally {
      this.opensInFlight--;
      this.opensDone++;
    }
  }

  /**
   * Adopt the shell's answer about which ports are open. This side's `inputPort` /
   * `outputPort` is a claim the page cannot check: a connection closed natively —
   * the page-load teardown in lib.rs, which used to fire for the MIDI window's own
   * load — leaves it naming a port nothing is listening on, and the window goes on
   * offering that port as the chosen one. The select is no way back either, since
   * re-picking the same entry fires no `change`. Reading the truth on every refresh
   * turns that silence into a port that visibly falls back to "none".
   *
   * Stood down for anything that opens a port, because the answer describes a moment
   * rather than the present: the two commands are answered on separate threads, so one
   * that raced ahead of the open it was meant to describe would clear a port that is
   * being connected right now — the same symptom, caused here. In flight when it starts
   * is not enough on its own. An open that BEGINS and COMPLETES inside the round trip
   * leaves the counter back at zero, and the answer is stale by then; `opensDone` is
   * what makes that case visible, so the two are checked together.
   */
  private async reconcileOpenPorts(): Promise<void> {
    if (!isTauri() || this.opensInFlight > 0) return;
    const generation = this.opensDone;
    const [input, output] = await midiOpenPorts().catch(() => [this.inputPort, this.outputPort]);
    if (this.opensInFlight > 0 || this.opensDone !== generation) return; // an open landed under it
    if (input !== this.inputPort) {
      this.inputPort = input;
      this.closeInput = null; // whatever it would have closed is already gone
    }
    this.outputPort = output;
  }

  private async setInputPort(port: string | null): Promise<void> {
    if (port) await this.openInput(port);
    else {
      this.closeInput?.();
      this.closeInput = null;
      this.inputPort = null;
    }
    this.savePorts();
    // Push either way: a failed open (exclusive / unplugged port) left no input, and
    // the window's select has to fall back to "none" rather than keep showing a dead
    // choice. It renders from this state, so re-sending it is the correction.
    this.pushState();
  }

  private async setOutputPort(port: string | null): Promise<void> {
    if (port) await this.openOutput(port);
    else {
      void midiCloseOutput();
      this.outputPort = null;
    }
    this.savePorts();
    this.pushState();
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
    this.pushState();
    // Turning learn on is one of the two moments the window's contents are the
    // answer to what was just done, so bring it forward if it drifted behind.
    if (on) this.raiseWindow();
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
    this.say(t().midi.bound(this.labelOf(id), addrLabel(addr)));
    // Deliberately NOT raised here. Measured on macOS (2026-08-01): raising takes
    // focus off the main window, and a click on a window that is not active does
    // not reach the webview (`accept_first_mouse` defaults to false), so every
    // binding after the first would have cost two clicks — one to activate, one to
    // arm. Assigning a bank of controls is a run of gestures, and the confirmation
    // is already on the status line of the window the operator is clicking in.
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
    this.pushState();
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

  /** Human-readable control label: node label (model-fixed) + scope + the surface's
   *  own wording for the control ("CH 1 → MIX 1 · Level", "CH 1 · GATE · Threshold").
   *  The two scope kinds print differently because they mean different things — a
   *  send target is where the signal goes, a processor is a stage of this node. */
  private labelOf(id: string): string {
    const parsed = parseControlId(id);
    if (!parsed) return id;
    const m = t().midi;
    const nodes = this.hooks.getModel().nodes;
    const byId = (nid: string): DeviceNode | undefined => nodes.find((n) => n.id === nid);
    const self = byId(parsed.node);
    // A hung node (a ducker under its stereo channel) is labeled just "Ducker",
    // which does not say which channel it belongs to: show the parent's name
    // (attachTo) instead, so the assignment reads e.g. "CH 5/6 · DUCKER".
    const owner = self?.attachTo ? byId(self.attachTo) : self;
    const node = owner?.label ?? parsed.node;
    const target = parsed.scope ? byId(parsed.scope) : undefined;
    const processor = parsed.scope !== undefined && target === undefined;
    const scope = !parsed.scope ? "" : target ? ` → ${target.label}` : ` · ${m.scope[parsed.scope] ?? parsed.scope}`;
    // Inside a processor scope a param is read on a tuning screen, which prints
    // sentence-case labels; the console's own captions stay as they are.
    const param =
      (processor ? m.scopedParam[parsed.param] : undefined) ?? m.param[parsed.param as ControlParam] ?? parsed.param;
    return `${node}${scope} · ${param}`;
  }

  // ---- the MIDI window ----
  // The panel is a window of its own: it renders `MidiUiState` and reports intents
  // (ui/midi-protocol.ts). Everything that decides what it shows stays here, where
  // the engine, the ports and the plan are — the window never opens a port, because
  // a port delivers its bursts to the window that opened it.

  /** Device menu → MIDI control. Opens the window, or raises it when already up. */
  toggleWindow(): void {
    if (this.windowOpen) {
      void closeMidiWindow().catch(() => {});
      return;
    }
    void openMidiWindow(t().midi.title, this.store().window).catch((err: unknown) => {
      this.hooks.onStatus(midiErrorStatus(err, t().midi.windowError));
    });
    // `windowOpen` is set by the window's own "ready", not here: an open that failed
    // must not leave this side believing there is a window to push state at.
  }

  /** Re-send the state after a language or theme switch, so the window follows the
   *  app rather than staying on whatever it booted in. */
  relocalize(): void {
    this.pushState();
  }

  private onIntent(payload: string): void {
    const intent = parseRelay<MidiUiIntent>(payload);
    if (!intent) return;
    switch (intent.type) {
      case "ready":
        this.windowOpen = true;
        this.pushState();
        void this.refreshPorts();
        return;
      case "closed":
        this.windowOpen = false;
        // Learn is armed against a control in a window the operator can no longer
        // see; leaving it on would swallow the next click on the console.
        this.setLearn(false);
        this.rememberGeometry();
        return;
      case "learn":
        this.setLearn(intent.on);
        return;
      case "remove":
        this.applyMappings(this.engine.getMappings().filter((x) => x.control !== intent.control));
        this.hooks.onLearnChanged(); // drop the mapped dot on the arming surfaces
        return;
      case "mode":
        this.patchMapping(intent.control, { mode: intent.mode });
        return;
      case "button":
        this.patchMapping(intent.control, { button: intent.button });
        return;
      case "port":
        void (intent.dir === "in" ? this.setInputPort(intent.name) : this.setOutputPort(intent.name));
        return;
      case "refreshPorts":
        void this.refreshPorts();
        return;
    }
  }

  /** Push the whole state. Cheap enough to send in full on every change: the list is
   *  tens of rows and the window rebuilds from it, so there is no diff to get wrong. */
  private pushState(): void {
    if (!this.windowOpen) return;
    const state: MidiUiState = {
      inputs: this.inputs,
      outputs: this.outputs,
      input: this.inputPort,
      output: this.outputPort,
      rows: this.engine.getGangedMappings().map((m) => {
        const control = this.resolve(m.control);
        const linked = this.engine.isLinkedMember(m);
        return {
          control: m.control,
          label: this.labelOf(m.control),
          // A gang member shares the head's physical control, so it carries no
          // address of its own — the window prints its "Linked" marker instead.
          ...(linked ? {} : { addr: addrLabel(m.addr) }),
          // An unbindable id (a mapping saved for another model) still has to be
          // listed and removable, so it falls back to the toggle column.
          kind: control?.kind ?? "toggle",
          ...(optionOf(control?.kind ?? "toggle", m) ? { option: optionOf(control?.kind ?? "toggle", m) } : {}),
          mode: m.mode,
          ...(m.button ? { button: m.button } : {}),
          linked,
        };
      }),
      learnOn: this.learnOn,
      armed: this.armed ? this.labelOf(this.armed) : null,
      status: this.status,
      lang: getLang(),
      theme: document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark",
    };
    void midiUiToWindow(JSON.stringify(state)).catch(() => {});
  }

  /** Raise the window, so one that drifted behind the app comes back. Called when
   *  learn turns ON and nowhere else: that is the moment the operator is looking
   *  here rather than at the board, and it is before the run of arming clicks
   *  rather than in the middle of it (see `onLearned`). A window that is already
   *  frontmost is unaffected. */
  private raiseWindow(): void {
    if (!this.windowOpen) return;
    void focusMidiWindow().catch(() => {});
  }

  /** Remember where the operator put the window, so the next open lands there. */
  private rememberGeometry(): void {
    void midiWindowGeometry()
      .then((g) => {
        if (!g) return;
        const s = this.store();
        s.window = { x: g[0], y: g[1], width: g[2], height: g[3] };
        saveJson(STORE_KEY, s);
      })
      .catch(() => {});
  }

  // Re-enumerate the ports (midir has no hot-plug events, so every open re-lists),
  // check what this side believes it holds against what the shell actually has, and
  // push both with the rest of the state.
  private async refreshPorts(): Promise<void> {
    const [ins, outs] = await Promise.all([midiListInputs().catch(() => []), midiListOutputs().catch(() => [])]);
    this.inputs = ins;
    this.outputs = outs;
    await this.reconcileOpenPorts();
    this.pushState();
  }

  private patchMapping(control: string, patch: Partial<MidiMapping>): void {
    this.applyMappings(this.engine.getMappings().map((x) => (x.control === control ? { ...x, ...patch } : x)));
  }
}

// A MIDI bridge failure surfaces its stable code (midi.rs). A missing port names a
// state the user can act on, so it replaces the frame; everything else fills the
// given input/output error prefix — the parallel of connectFailureStatus for the vd
// worker codes.
function midiErrorStatus(err: unknown, wrap: (message: string) => string): string {
  if (errorCode(err) === "midi-port-not-found") return t().error.shell.midiPortNotFound;
  return wrap(errorText(err));
}

// Reading localStorage can throw where storage is blocked (private mode); the
// trace flag is a dev diagnostic, so a failure just means "off".
function traceEnabled(): boolean {
  try {
    return !!localStorage.getItem("urx-midi-log");
  } catch {
    return false;
  }
}
