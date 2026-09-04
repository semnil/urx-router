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
  pinMidiWindow,
  isTauri,
  midiCloseOutput,
  midiListInputs,
  midiListOutputs,
  midiCloseInput,
  midiOpenInput,
  midiOpenOutput,
  midiOpenPorts,
  midiSend,
  midiUiAttachMain,
  midiUiToWindow,
  midiWindowOpen,
  openMidiWindow,
} from "../core/platform";
import { MidiEngine } from "../core/midi/engine";
import { bindControl, parseControlId, type BoundControl, type ControlKind } from "../core/midi/controls";
import {
  addrKey,
  addrLabel,
  addrShort,
  BUTTON_MODES,
  sanitizeMappings,
  TAKE_MODES,
  type MidiAddr,
  type MidiMapping,
} from "../core/midi/mapping";
import { midiProbe, startMidiTrace } from "./midi-probe";
import { mirrorBalPair, mirrorLinkedInsertFx } from "../core/routing";
import { insertFxControlLabel } from "./insert-fx-screen";
import { fxControlLabel } from "./fx-effect-screen";
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
// A port that has stopped taking messages fails every send, and the catch below drops
// the engine's sent cache — so the next pass finds every mapping changed and re-emits
// all of them. Without a ceiling the two feed each other for as long as the app runs.
// Counted in PASSES, not messages: one pass emits a message per bound address.
const FEEDBACK_FAIL_PASSES = 3;
// Re-try cadence for feedback deferred behind an in-progress incoming sweep.
const FEEDBACK_SETTLE_MS = 350;
// A lone CC learn candidate commits after this quiet gap (single-message buttons).
const LEARN_FLUSH_MS = 500;

/** Why a feedback pass is a full re-send. Carried to the one mark site in `runFeedback`,
 *  so each cause is attributable without a second mark in front of the burst. */
type ResyncCause = "port-open" | "model" | "readback" | "learn-off";

export class MidiControl {
  private engine: MidiEngine;
  // Dev diagnostic: set `localStorage["urx-midi-log"] = "1"` (reload to apply) to
  // trace every rx/tx byte string and the engine's per-message decision to the
  // console — the ground truth for "this press did not land" reports.
  private traceLog = traceEnabled() ? (msg: string) => console.debug("[midi]", msg) : undefined;
  // Dev-build measurement buffer (ui/midi-probe.ts). Null in a production build, so
  // every use below folds away with it.
  private probe = midiProbe;
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
  /** Which port choice, per direction, an in-flight open belongs to — bumped by every
   *  selection. `opensInFlight` / `opensDone` count opens for the reconcile's benefit
   *  and cannot answer this: they say whether one is happening, not whether the one
   *  that just finished is still the one the operator asked for. */
  private portGen = { in: 0, out: 0 };
  /** The tail of each direction's intent chain (see `queuePort`). */
  private portQueue = { in: Promise.resolve(), out: Promise.resolve() };
  // The plan object every entry in `bound` was bound against.
  private feedbackTimer = 0;
  /** Consecutive feedback passes that ended in a failed send, cleared by any send that
   *  lands. What keeps the re-send from being unbounded. */
  private txFailedPasses = 0;
  /** Whether the last thing said about the output was that it stalled. A FLAG, not a
   *  comparison against the message: `status` holds the string as it was rendered, so
   *  a language switch between the stall and the reconnect leaves it matching nothing
   *  the catalog now returns — and the stale sentence, in the old language, stays on
   *  screen saying feedback is stopped after it has restarted. */
  private outputStalled = false;
  /** Whether the plan is the unit's own state, established by a Live-sync readback
   *  that completed. The output side sends nothing while this is false. Held here
   *  rather than read from a hook: what it answers is not "is Live sync on now" but
   *  "did a complete read establish what this app is about to state", and the two
   *  differ for the whole length of a starting readback. */
  private deviceStateKnown = false;
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

  /** One line about what the MIDI layer just decided, to whichever diagnostics are
   *  there. Left undefined when neither is, so `hooks.trace?.()` never even builds the
   *  engine's strings in a production build. */
  private note = this.traceLog || this.probe ? (msg: string) => this.record(msg) : undefined;

  private record(msg: string): void {
    this.traceLog?.(msg);
    this.probe?.note(msg);
  }

  /** Drop a lifecycle mark on the measurement buffer (dev builds only), so a burst can
   *  be placed against the window in which incoming MIDI is refused. Called for the
   *  session's own moments — this class marks its own from where they happen. */
  probeMark(label: string): void {
    this.probe?.mark(label);
  }

  constructor(private hooks: MidiHooks) {
    this.engine = new MidiEngine({
      resolve: (id) => this.resolve(id),
      gate: () => hooks.blocked(),
      // Once per gated window — the engine decides that, so this is a plain status write.
      refused: (reason) => hooks.onStatus(reason),
      applied: (control) => {
        // Same funnel as a console edit, and BOTH of its mirrors. The BAL one is a no-op in
        // PAN mode, while an insert effect is shared by a linked pair in EITHER mode — one
        // effect, one device slot — so a write mirrored only the first way splits the pair:
        // the plan holds two answers and the next flush emits both, one per instance.
        const model = hooks.getModel();
        const plan = hooks.getPlan();
        const balMirrored = mirrorBalPair(model, plan, control.node);
        // The insert-FX half runs for every control, not only the new bypass: the effect's
        // own parameter mappings write the same shared values and were splitting the pair
        // the same way.
        const insFxMirrored = mirrorLinkedInsertFx(model, plan, control.node);
        hooks.onApplied(control, balMirrored || insFxMirrored);
        this.scheduleFeedback();
      },
      send: (bytes) => {
        if (!this.outputPort) {
          // Recorded rather than returned silently: this branch is indistinguishable
          // from "the engine emitted nothing" in every log the app keeps, and telling
          // the two apart is the whole point of the probe.
          this.probe?.txDropped(bytes, "no output port");
          return;
        }
        this.traceLog?.(`tx [${bytes.join(" ")}]`);
        this.probe?.tx(bytes);
        void midiSend(bytes).then(
          () => {
            // A send that lands says the port is alive. The streak below is about a
            // port that has stopped taking messages, not about one message.
            this.txFailedPasses = 0;
          },
          () => {
            // A rejection that arrives after the port was given up has nothing left
            // to re-send, and must not count a second time.
            if (!this.outputPort) return;
            // The controller never got this value, so drop what the engine thinks it
            // has been told and schedule another pass: a one-off failure self-heals.
            this.record("tx failed — re-sending feedback");
            this.engine.forgetFeedback();
            // The debounce timer is the pass boundary. Only the FIRST rejection of a
            // pass finds it unset — that one arms it — so counting here counts passes
            // rather than messages. A per-message limit would trip inside the first
            // pass as soon as three addresses are bound, killing feedback on exactly
            // the transient hiccup this path exists to heal from.
            if (this.feedbackTimer) return;
            if (++this.txFailedPasses >= FEEDBACK_FAIL_PASSES) {
              this.abandonOutput();
              return;
            }
            this.scheduleFeedback();
          },
        );
      },
      learned: (addr) => this.onLearned(addr),
      learnPending: () => this.bumpLearnFlush(),
      now: () => performance.now(),
      trace: this.note,
    });
    // The bridge is the only thing that feeds the probe, so starting the trace file here
    // is what makes its first record the page's own — and keeps the probe module free of
    // an import-time side effect (see midi-probe's `start`).
    startMidiTrace?.();
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
   *  shell is asked whether the window is there, and the state is pushed at it.
   *  Without this the window sat holding the previous session's list. */
  private async attach(): Promise<void> {
    try {
      await midiUiAttachMain((payload) => this.onIntent(payload));
      this.windowOpen = await midiWindowOpen();
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
    // Anything said after the stall replaces it on screen, so the flag stops being
    // true of what the operator can see. Set by abandonOutput immediately after its
    // own say(), which is why this clears rather than guards.
    this.outputStalled = false;
    this.status = message;
    this.hooks.onStatus(message);
    this.pushState();
  }

  /**
   * Resolve a control id against the plan as it is NOW.
   *
   * Not memoized. A bound control closes over the family, the processor and the send it
   * was built for, and a plan is edited IN PLACE — so a cache keyed on the plan object
   * hands back a control for an insert effect the node no longer holds, or a COMP row on a
   * strip that has switched to SSMCS. `set()` then writes a slot nothing sends, which
   * reappears the moment the operator switches back, and `get()` feeds the same stale value
   * to feedback. The catalogue is the only thing that knows what exists, so asking it is the
   * check: an id that has stopped existing resolves to null, which is what every caller
   * already handles.
   *
   * The memo it replaces was written for a plan REPLACEMENT that no longer happens (the
   * read runs against a private copy, and loadPlan announces), so it was guarding the one
   * case that cannot occur while missing every case that can. What a resolve costs is one
   * node's catalogue, which is small enough that a MIDI sweep resolving per message spends
   * a negligible share of a core on it.
   */
  private resolve(id: string): BoundControl | null {
    return bindControl(this.hooks.getModel(), this.hooks.getPlan(), id);
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

  /** The plan (and possibly the model) was replaced: reload that model's mappings and
   *  re-take the feedback pass against the new plan values. That pass reaches the
   *  controller only if the output side is open, which a replacement has just closed —
   *  what it always does is re-state which bindings no longer match their physical
   *  control. */
  onModelChanged(): void {
    // The plan was replaced, so whatever a read established is about a document that
    // is no longer loaded. Live sync is dropped before every wholesale replacement
    // (loadPlan calls deactivateLive), which clears this too — stated here as well
    // because the rule belongs to the replacement, not to the order of two callers.
    this.deviceStateKnown = false;
    // An in-flight learn was armed against the old model; committing it now
    // would persist a mapping under the new model that may never bind.
    this.setLearn(false);
    this.engine.setMappings(this.loadMappings());
    this.pushState();
    this.runFeedback("model");
  }

  /** One of the latches behind `blocked` cleared: end the engine's reported
   *  refusal window, so the next one speaks up again (see MidiEngine.gateReleased). */
  gateReleased(): void {
    // The instant incoming MIDI stops being refused. A reply the resync above provoked
    // that lands after this is applied as an ordinary edit, so the distance between
    // the two is the measurement the probe exists to take.
    this.probe?.mark("midi:gate-open");
    this.engine.gateReleased();
  }

  /** A Live-sync session came up and its readback completed: the plan is now the
   *  unit's own state. This is the one thing that opens the output side — every pass
   *  before it is skipped (see `runFeedback`) — and it re-sends every mapped value
   *  once, forgetting what the controller was last told, because the debounced pass
   *  only carries what CHANGED and a value the device confirmed unchanged is exactly
   *  the one a controller that drifted (replugged, power-cycled, moved to another
   *  bank) is still showing wrong.
   *
   *  Called only where the session is known to be up, never from a `finally` that a
   *  cancelled or failed read also reaches: such a read leaves the plan part device
   *  and part default, which is the state that must not go onto the wire. */
  liveReadSettled(): void {
    this.deviceStateKnown = true;
    this.runFeedback("readback");
  }

  /** Live sync ended, for any reason. The plan may still agree with the unit at this
   *  instant, but nothing keeps the two together from here, so it stops being
   *  something this app may state to a controller — or to whatever else shares the
   *  bus. The next session's readback opens it again. */
  liveEnded(): void {
    this.deviceStateKnown = false;
  }

  /** Batch a feedback pass after a plan edit (debounced; called from the shared
   *  change funnel, so UI / follow / MIDI edits all land here). */
  scheduleFeedback(): void {
    if (!this.outputPort || this.feedbackTimer) return;
    this.feedbackTimer = window.setTimeout(() => {
      this.feedbackTimer = 0;
      this.runFeedback(null);
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
    //
    // Through the same per-direction queue an operator's choice goes through, and for
    // the same reason: the MIDI window is usable while this is still in flight, and a
    // saved port that opens slowly is exactly the wedged one. Left outside the queue it
    // completed after the operator had picked B or "None" and installed itself over
    // their choice — in the shell's slot, in this state, and back into the store.
    //
    // Queued rather than routed through `setInputPort`: a restore must not SAVE. That
    // path writes the result back, so a saved port merely unplugged right now would be
    // erased from the store by its own failed restore and never tried again.
    if (s.input) void this.queuePort("in", (port) => (port ? this.openInput(port) : Promise.resolve()), s.input);
    if (s.output) void this.queuePort("out", (port) => (port ? this.openOutput(port) : Promise.resolve()), s.output);
  }

  private async openInput(port: string): Promise<void> {
    this.opensInFlight++;
    try {
      // The Rust side replaces any prior input, so no explicit close first.
      const close = await midiOpenInput(port, (bytes) => {
        this.traceLog?.(`rx [${bytes.join(" ")}]`);
        // Stamped before the engine runs, so the arrival time is the message's own and
        // not the time its decision finished being taken.
        this.probe?.rx(bytes);
        this.engine.onMessage(bytes);
      });
      this.closeInput = close;
      this.inputPort = port;
      // The two opens run on independent queues, so this is what says whether the input
      // was listening yet when the output's own resync burst went out.
      this.probeMark("midi:port-open:in");
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
      // Re-picking a port is the operator's retry: a streak carried over from the
      // previous connection would let one later failure trip the limit on a good one.
      this.txFailedPasses = 0;
      // The stall was a claim about a port that is open again, and feedback restarts
      // on the next line — left standing it goes on telling the operator, in the
      // window and on the app's status line, that the thing they just fixed is still
      // broken. Only OUR claim is cleared, so an unrelated status (a learn hint,
      // another error) said since is not wiped by opening a port.
      if (this.outputStalled) this.say("");
      this.runFeedback("port-open"); // align motor faders / LEDs with the plan at once
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

  /**
   * Run one port intent per direction, in the order the operator chose them, skipping
   * any that a later choice has already superseded.
   *
   * Serialized rather than raced-and-guarded, because the shell's side is not
   * addressable: `midi_open_input` REPLACES whatever is held and `midi_close_input`
   * closes whatever is held, neither taking a port. So two opens in flight leave the
   * slot holding whichever finished last — not whichever was chosen last — and a stale
   * continuation "cleaning up after itself" closes the port that superseded it. There
   * is no token to compare; the only fix is not to have two in flight.
   *
   * The skip is what makes A -> B -> None end at None with one close, instead of
   * replaying every intermediate choice against the hardware.
   */
  private queuePort(
    dir: "in" | "out",
    run: (port: string | null) => Promise<void>,
    port: string | null,
  ): Promise<void> {
    const gen = ++this.portGen[dir];
    const next = this.portQueue[dir].then(async () => {
      if (gen !== this.portGen[dir]) return;
      await run(port);
    });
    this.portQueue[dir] = next.catch(() => {});
    return next;
  }

  private setInputPort(port: string | null): Promise<void> {
    return this.queuePort("in", (port) => this.applyInputPort(port), port);
  }

  private async applyInputPort(port: string | null): Promise<void> {
    if (port) await this.openInput(port);
    else {
      // Always closes natively. The closer is the fast path, not the condition: after a
      // reconcile adopts a port the shell already held there IS no closer, and asking
      // for one here left "None" closing nothing — the select read None while the shell
      // went on delivering into the engine, until some later open replaced the slot.
      if (this.closeInput) this.closeInput();
      else midiCloseInput();
      this.closeInput = null;
      this.inputPort = null;
    }
    this.savePorts();
    // Push either way: a failed open (exclusive / unplugged port) left no input, and
    // the window's select has to fall back to "none" rather than keep showing a dead
    // choice. It renders from this state, so re-sending it is the correction.
    this.pushState();
  }

  private setOutputPort(port: string | null): Promise<void> {
    return this.queuePort("out", (port) => this.applyOutputPort(port), port);
  }

  private async applyOutputPort(port: string | null): Promise<void> {
    if (port) await this.openOutput(port);
    else this.closeOutput();
    this.savePorts();
    this.pushState();
  }

  /** Drop the output port on both sides and stop the feedback that was aimed at it.
   *
   *  Closing in the SHELL as well as here is what makes the two agree: the held slot is
   *  what `open_ports` answers from (midi.rs), so leaving it open lets the next
   *  `reconcileOpenPorts` hand the name straight back. Killing both timers belongs here
   *  too — a pass armed against a port that is gone either sends into nothing or, worse,
   *  into whatever the shell hands back next.
   *
   *  Says nothing and saves nothing: WHY the port went is the caller's to report, and
   *  whether the operator's saved choice goes with it is the caller's to decide. */
  private closeOutput(): void {
    this.txFailedPasses = 0;
    window.clearTimeout(this.feedbackTimer);
    this.feedbackTimer = 0;
    window.clearTimeout(this.settleTimer);
    this.settleTimer = 0;
    this.outputPort = null;
    void midiCloseOutput().catch(() => {});
  }

  // ---- feedback ----

  /** Give up on an output port that will not take a message. Closed in the SHELL as
   *  well as here, because `open_ports` answers from the held slot: leaving it open
   *  lets the next `reconcileOpenPorts` hand the dead name straight back and restart
   *  the re-send. The SAVED port is deliberately left alone — an unplug should not
   *  forget the operator's choice at the next boot, and that restore reports its own
   *  failure. */
  private abandonOutput(): void {
    this.closeOutput();
    // The SAVED port is deliberately left alone — an unplug should not forget the
    // operator's choice at the next boot, and that restore reports its own failure.
    // That is the one thing separating this from the operator choosing "None".
    this.say(t().midi.outputStalled);
    // AFTER the say, which clears the flag for anything else that speaks.
    this.outputStalled = true;
  }

  /** Run a feedback pass. `cause` names the full re-send's reason, or null for the
   *  ordinary debounced diff — a resync is exactly a pass with a cause. */
  private runFeedback(cause: ResyncCause | null): void {
    const resync = cause !== null;
    // Marked from here rather than from the callers, so every entry to a full re-send
    // lands in the log the same way and the four are comparable against each other. The
    // cause travels to this one site rather than each caller marking its own: a mark of
    // its own would sit immediately before this one with an empty tx window between them,
    // and `report()` attributes every send to the most recent mark.
    if (cause) this.probe?.mark(`midi:resync (${cause})`);
    // Nothing goes ON THE WIRE until a Live-sync readback has completed and the plan
    // IS the unit's state. Before that the plan is whatever was loaded — a new
    // document's defaults, a file, a partly applied read — and a pass would put those
    // values out as though the unit held them. That is not only wrong for the
    // controller: on a loopback or shared bus another listener takes them for an
    // operator's gesture, and a second instance of this app applies them to its own
    // plan and writes them to the device. `liveEnded()` closes it again, so an offline
    // stretch is one of the periods nothing is sent in.
    //
    // The pass still RUNS — `feedback(resync, deliver)` skips the wire and the two
    // caches that describe it, and keeps what it owes the receive side (a plan value
    // that moved un-engages a pickup binding whether or not the controller heard).
    // Returning here instead left an engaged pickup binding engaged for the whole
    // offline stretch, so the next twitch of a physical fader tracked from wherever it
    // stood and pulled the plan value with it.
    //
    // Through `note` rather than `probe`: `probe` is a dev build's, and a release
    // build's own diagnostic (`urx-midi-log`) would otherwise show incoming messages
    // with no outgoing ones and no line saying why — the same shape `send()`'s
    // txDropped exists to avoid.
    if (!this.deviceStateKnown) this.note?.(`feedback held — device state not established (resync=${resync})`);
    // Nothing goes out while a learn is armed. On a reflecting transport (the shared
    // IAC bus, or a controller that re-sends its state when feedback moves it — both
    // device classes the echo guard exists for) our own feedback comes straight back,
    // and the learn branch in `onMessage` runs BEFORE the receive-side echo guard: the
    // engine would take that echo as the operator's gesture and bind the armed control
    // to whatever address the feedback happened to use. A plan edit from anywhere —
    // device follow, undo, the graph inspector — is enough to start it, and if the fed
    // address is a note the bind is instant, with no quiet gap to notice it in.
    //
    // Suspending the SEND rather than teaching the learn path about echoes: the guard
    // protects `apply()` and is keyed per mapping address, so it can only ever answer
    // for addresses that are already bound — which is not the question learn is asking.
    // Nothing is lost by waiting: `setLearn(false)` resyncs, so the controller is
    // brought back into agreement the moment the arming ends.
    if (this.engine.isLearning()) {
      this.probe?.note(`feedback suspended — learn armed (resync=${resync})`);
      return;
    }
    if (!this.outputPort) {
      this.probe?.note(`feedback skipped — no output port (resync=${resync})`);
      return;
    }
    const deferred = this.engine.feedback(resync, this.deviceStateKnown);
    if (deferred) this.probe?.note("feedback deferred behind an in-progress sweep");
    if (deferred && !this.settleTimer) {
      this.settleTimer = window.setTimeout(() => {
        this.settleTimer = 0;
        this.runFeedback(null);
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
      // Feedback was suspended for the whole arming (see runFeedback), so the
      // controller may be showing values the plan has moved past. A resync rather than
      // an ordinary pass: the sent cache is still whatever it was before the arming,
      // and only a forced re-send brings every LED and motor fader back into line.
      this.runFeedback("learn-off");
    }
    this.hooks.onLearnChanged();
    this.pushState();
    // Turning learn on is one of the two moments the window's contents are the
    // answer to what was just done, so bring it forward if it drifted behind.
    if (on) this.raiseWindow();
    // And KEEP it in front for as long as the arming lasts: the next thing the
    // operator does is click the control being armed, in the main window, which on
    // macOS put the panel behind it and left the hint unreadable at the one moment
    // it is the instruction. On Windows the owner already prevents that (measured
    // 2026-08-13 with a real click; architecture.md, "Window geometry"), so there the
    // pin is what holds the panel above OTHER applications for the same seconds.
    if (this.windowOpen) void pinMidiWindow(on).catch(() => {});
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
    // The insert effect names itself from its own scope: the family and the slot are in
    // there because the node can change what it holds, and the catalogue is what turns
    // that pair back into words. Printed raw it read "CH 1 · insfx.compander.6 · insfx".
    if (parsed.param === "insfx") {
      const insfx = insertFxControlLabel(parsed.scope, t());
      if (insfx) return `${node} · ${insfx}`;
    }
    // The FX channel's effect names itself the same way and for the same reason — its scope
    // carries the plan key because the channel can change what it holds.
    if (parsed.param === "fx") {
      const fx = fxControlLabel(parsed.scope, t());
      if (fx) return `${node} · ${fx}`;
    }
    const target = parsed.scope ? byId(parsed.scope) : undefined;
    const processor = parsed.scope !== undefined && target === undefined;
    const scope = !parsed.scope ? "" : target ? ` → ${target.label}` : ` · ${m.scope[parsed.scope] ?? parsed.scope}`;
    // Inside a processor scope a param is read on a tuning screen, which prints
    // sentence-case labels; the console's own captions stay as they are.
    const param =
      (processor ? m.scopedParam[parsed.param] : undefined) ??
      // The insert effect is the one param with no caption of its own: it names itself
      // above, and reaches here only when its scope points at a family or slot this build
      // no longer carries, where its own token is all there is to print.
      m.param[parsed.param as keyof typeof m.param] ??
      parsed.param;
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
    void openMidiWindow(t().midi.title).catch((err: unknown) => {
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
        return;
      case "learn":
        this.setLearn(intent.on);
        return;
      case "remove":
        this.applyMappings(this.engine.getMappings().filter((x) => x.control !== intent.control));
        this.hooks.onLearnChanged(); // drop the mapped dot on the arming surfaces
        return;
      // The two intents whose payload is a VOCABULARY rather than a shape. `parseRelay`
      // checks the envelope, and the relay's own header says it can deliver a previous
      // session's messages — a version-skewed window (dev / HMR, or one that outlived a
      // main reload) can send a mode value this build does not have. The engine treats
      // any non-"pickup" mode as absolute, so the session looks fine; the next boot's
      // `sanitizeMappings` then fails `oneOf(TAKE_MODES, …)` and drops the whole
      // binding with nothing said. Refused here instead, where the value is still
      // attributable to the message that carried it.
      case "mode":
        if (TAKE_MODES.includes(intent.mode)) this.patchMapping(intent.control, { mode: intent.mode });
        return;
      case "button":
        if (BUTTON_MODES.includes(intent.button)) this.patchMapping(intent.control, { button: intent.button });
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
    const all = this.engine.getMappings();
    // A take-in mode is a property of the physical control, not of one binding. The
    // engine owns pickup state per ADDRESS and only the head ever creates it, so a
    // member set to Pickup behind an Absolute head reads `engaged = false` for ever and
    // never moves at all — no indication, nothing to retry. (A toggle head is the same
    // shape: `isHead` is hard-false for toggles.) The window offers the select on every
    // row including linked ones, so the fix is to make the choice mean what the engine
    // assumes it means: one mode for everything on that address.
    //
    // `button` is deliberately NOT ganged: it decides how one binding reads an incoming
    // press, and two controls behind one button may legitimately want edge and state.
    const at = patch.mode !== undefined ? all.find((x) => x.control === control) : undefined;
    const gangKey = at ? addrKey(at.addr) : null;
    const hit = (x: MidiMapping): boolean => x.control === control || (gangKey !== null && addrKey(x.addr) === gangKey);
    this.applyMappings(all.map((x) => (hit(x) ? { ...x, ...patch } : x)));
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
