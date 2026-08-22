// CONSOLE view: a mixer-style overview of every level-settable node, laid out as
// vertical channel strips. Each strip shows the set fader level (amber ladder),
// the live signal meter (green→red, only while Live sync streams), mute, gain, and
// EQ. A per-strip SENDS rack (between the head and the fader zone) gives every
// strip always-available columns for all of its MIX/FX sends — an enable chip, a
// PRE button and a vertical mini-fader per send — plus a SEND PAN popover.
// Edits go straight onto the plan and through the shared change funnel, so Live
// sync mirrors them to the device exactly like the graph/inspector do.

import type { DeviceModel } from "../models/types";
// Aliased: `ref` is a local in several builders here (a SendColRef), and the port-ref
// helper has to stay reachable inside them.
import { ref as portRef } from "../models/types";
import { defaultPlan } from "../models/initial-state";
import {
  LEVEL_MAX_DB,
  LEVEL_MIN_DB,
  LEVEL_OFF_DB,
  sendConnection,
  SSMCS_INITIAL,
  type NodeParams,
  type Plan,
  type PlanConnection,
  type SsmcsParams,
} from "../core/plan";
import { LEVEL_POS_MAX, levelToPos, posToLevel, stepLevel } from "../core/levels";
import {
  defaultTapKey,
  hasMeter,
  isStereoTap,
  METER_FLOOR_DB,
  METER_GREEN_TOP_DB,
  METER_YELLOW_TOP_DB,
  MeterStore,
  subscribeMeters,
  tapAddrs,
  tapFor,
  tapsFor,
  type MeterTap,
} from "../core/meters";
import { loadJson, saveJson } from "../core/storage";
import { COMP_EQ_COMP_FIRST } from "../core/control/params";
import { dynOpenLabel } from "./dyn-registry";
import type { DynKind } from "./dyn-registry";
import { markMidi } from "./midi-learn";
import type { MidiLearnHooks } from "./midi-learn";
import {
  channelEqUnavailable,
  formatRate,
  insertFxRateLock,
  insertFxCensus,
  insertFxFree,
  insertFxMenu,
  isMonitorBus,
  type InsertFxCensus,
} from "../core/constraints";
import { busBalance, channelControl, channelDynamics, hasEq, insertFxControl } from "../core/control/translate";
import { nodeParamContestPath } from "../core/plan-history";
import {
  INSERT_FX_PAIR_KEYS,
  isBalLinkedPair,
  isNodeInactive,
  mirrorBalPair,
  mirrorLinkedInsertFx,
  mixSendLocks,
  partnerChannel,
  sendTapWritable,
} from "../core/routing";
import { insertFxEngaged, insertFxSelected, type InsertFxOption } from "../core/control/params";
import {
  DELAY_TIME_MAX_MS,
  DELAY_TIME_MIN_MS,
  PAN_MAX,
  PAN_MIN,
  PHONES_LEVEL_DEFAULT,
  PHONES_LEVEL_MAX,
  PHONES_LEVEL_MIN,
} from "../core/control/vd";
// MAIN_BUS (the STEREO master, every channel's fixed main send) and the
// MIX/FX send targets are shared with the MIDI control catalog.
import { controlId, MAIN_BUS, SEND_TARGETS, SSMCS_SC_SCOPE, type SendTarget } from "../core/midi/controls";
import { setLevelText } from "./glyph";
import { el, focusables, onWheelStep, popLeft, popTop, preserveFocus, scrubFloat } from "./dom";
import { fineActive, fineTag } from "./fine";
import { t } from "../i18n";

// Full destination name (header readout + SEND PAN popover) and the short chip
// label (rack column). SEND_TARGETS fixes the column order: FX 1, FX 2, MIX 1, MIX 2.
const SEND_LABEL: Record<SendTarget, string> = {
  "bus.mix1": "MIX 1",
  "bus.mix2": "MIX 2",
  "bus.fx1": "FX 1",
  "bus.fx2": "FX 2",
};
const SEND_SHORT: Record<SendTarget, string> = {
  "bus.mix1": "M1",
  "bus.mix2": "M2",
  "bus.fx1": "F1",
  "bus.fx2": "F2",
};

// A fader scale: how a dB maps to/from travel (toFrac/fromFrac), how the keyboard
// steps it (step), and its ruler ticks. NORMAL_RANGE is the only instance (the
// level_gain grid); it is threaded through the level helpers so the scale is
// defined in one place.
interface LevelRange {
  min: number;
  max: number;
  off: number;
  toFrac: (db: number) => number;
  fromFrac: (frac: number) => number;
  step: (base: number, delta: number) => number;
  ticks: number[];
}

// The level_gain range: detents spaced evenly by grid index (not by dB), keyboard
// walks one detent per press, ticks are all real detents.
const NORMAL_RANGE: LevelRange = {
  min: LEVEL_MIN_DB,
  max: LEVEL_MAX_DB,
  off: LEVEL_OFF_DB,
  toFrac: (db) => levelToPos(db) / LEVEL_POS_MAX,
  fromFrac: (f) => posToLevel(Math.round(f * LEVEL_POS_MAX)),
  step: (base, delta) => stepLevel(base, delta),
  ticks: [10, 5, 0, -5, -10, -20, -40, -96],
};

function dbToFrac(db: number, r: LevelRange): number {
  return r.toFrac(db);
}
function fracToDb(frac: number, r: LevelRange): number {
  return r.fromFrac(Math.max(0, Math.min(1, frac)));
}
function meterFrac(dbfs: number, r: LevelRange): number {
  // The meter shares the strip's fader ruler: a dBFS reading lights to the same
  // travel as the matching dB tick. Normalised to the ladder's span — bottom at the
  // scale's lowest tick, top at the 0 dB mark — so the fill and the ticks line up.
  const floor = r.toFrac(r.ticks[r.ticks.length - 1]);
  const span = r.toFrac(0) - floor;
  return span <= 0 ? 0 : Math.max(0, Math.min(1, (r.toFrac(Math.min(dbfs, 0)) - floor) / span));
}
function fmtDb(db: number, r: LevelRange): { text: string; off: boolean } {
  // A non-finite level (corrupt plan that slipped past validation) reads as off
  // rather than throwing on .toFixed below.
  if (!Number.isFinite(db) || db < r.min) return { text: "-∞", off: true };
  return { text: (db > 0 ? "+" : "") + db.toFixed(1), off: false };
}

/**
 * Track a pointer drag that started on `control`, in the one place all three of this
 * view's drags share: the capture, the two `window` listeners, the teardown, and the
 * rule that ends the gesture when its control leaves the document.
 *
 * The listeners have to be on `window` — a capture on the control alone stops reporting
 * the moment the pointer leaves it — so a rebuild that replaces the strip (device
 * follow, MIDI, a scene recall, a language or theme switch) used to leave them running
 * against an element no longer on screen: the plan and the unit kept taking the drag
 * while the fader the operator can see showed what the rebuild painted, and the two
 * stayed apart for the rest of the session. The gesture now ends where its control did.
 *
 * Asked of the element rather than coordinated with the rebuild on purpose: the rebuild
 * sites do not have to know a gesture exists, and nothing is deferred (a banked repaint
 * replayed on pointerup is what swallowed a Close press on the tuning screens).
 *
 * `onMove` is also applied to the opening event when `seed` is set — the main fader
 * jumps to a press that landed off its cap. That runs before the listeners are
 * registered, so a seed can never be answered by a teardown that does not exist yet.
 */
function trackDrag(
  control: HTMLElement,
  e: PointerEvent,
  onMove: (ev: PointerEvent) => void,
  opts: { seed?: boolean; onEnd?: () => void } = {},
): void {
  control.setPointerCapture(e.pointerId);
  if (opts.seed) onMove(e);
  // Filtered by pointer id, and ended on `pointercancel` as well as `pointerup`.
  //
  // A cancelled drag fires no `pointerup` at all — touch-scroll takeover, a native
  // context menu, an alert (graph.ts documents the same set) — so teardown bound to
  // `pointerup` alone left the move listener installed. The control is still connected,
  // so every LATER pointer movement, including the operator's next unrelated gesture,
  // re-entered `onMove` with the stale `startY`/`startFrac`, wrote a level into the plan
  // and committed it to the live device; the SENDS header readout stayed latched too.
  // It ended only at the next `pointerup` anywhere.
  //
  // The id filter is the second half of the same defect: with none, a second pointer's
  // moves drove this control while the operator was dragging something else.
  const mine = (ev: PointerEvent): boolean => ev.pointerId === e.pointerId;
  const move = (ev: PointerEvent): void => {
    if (!mine(ev)) return;
    if (!control.isConnected) return end();
    onMove(ev);
  };
  const stop = (ev: PointerEvent): void => {
    if (mine(ev)) end();
  };
  // Losing the window is the third way a press ends, and the drag outlives it. Measured
  // 2026-08-14 in both engines: with the button down and the pointer captured, taking the
  // OS foreground away fires `blur`, fires no `pointercancel`, and KEEPS the capture — on
  // Chromium over its own DevTools socket, and on the shipping WKWebView (macOS 26.6.1,
  // packaged 1.8.3), where the fader went on following the pointer while another app was
  // frontmost, writing levels to the plan and out to the unit the whole time. Ending it
  // here was then confirmed in the same engine: the same gesture left the value where the
  // window was lost.
  //
  // No E2E tier caught it and none can reproduce it: Playwright emulates focus, so a page
  // under it reports itself focused whatever the foreground is. A spec could still
  // dispatch a synthetic blur — what puts the pins in the unit suite is what they read
  // (a plan value and the element's capture), not the event.
  //
  // On macOS the release itself still arrived (the button was let go
  // over another app and the drag ended there), so what this closes on that platform is
  // the writing done while the window is away rather than a drag standing forever — and
  // history.ts already ends its press at a blur, so those writes were also landing in a
  // NEW undo entry.
  const end = (): void => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
    window.removeEventListener("blur", end);
    // The capture goes with the gesture. On the two pointer ends the engine drops it
    // anyway; on the blur end nothing does, and an engine that also loses the release
    // would leave this control holding the capture for that pointer id — routing the
    // operator's next press to a fader they are not pressing. The tuning screens' plot
    // drag already ended this way; this is the same answer for the other two.
    if (control.hasPointerCapture(e.pointerId)) control.releasePointerCapture(e.pointerId);
    opts.onEnd?.();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
  // Not `capture: true`: blur does not bubble, so a capturing listener would also be
  // handed every field's own blur inside the strip and end the drag on the first one.
  window.addEventListener("blur", end);
}

// A three-bar meter glyph (rising heights), coloured by the host's currentColor
// so it tracks the badge's amber (dark) / brown (light). Marks the meter-point
// badge apart from the send-tap chip.
function meterGlyph(): SVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 8 8");
  svg.setAttribute("width", "8");
  svg.setAttribute("height", "8");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("mtr-ico");
  for (const [x, y, h] of [
    [0, 4, 4],
    [3.1, 2, 6],
    [6.2, 0, 8],
  ]) {
    const rect = document.createElementNS(ns, "rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", "1.7");
    rect.setAttribute("height", String(h));
    rect.setAttribute("fill", "currentColor");
    svg.append(rect);
  }
  return svg;
}

// A readout caption (FADER / METER): a terse label above a readout value so the
// set-level cell and the live-meter cell read apart at a glance, not by colour alone.
function readCap(text: string): HTMLElement {
  const cap = el("span", "cap2");
  cap.textContent = text;
  return cap;
}

// The live-meter readout cell (METER caption + dBFS value, reset to "—" until the
// stream feeds it). Shared by both strip builders; the value element is returned so
// the caller can store it as the strip's readMtr.
function meterReadCell(): { cell: HTMLElement; value: HTMLElement } {
  const cell = el("div", "rd mtr");
  const value = el("div", "rv");
  value.textContent = "—";
  cell.append(readCap(t().console.readMeter), value);
  return { cell, value };
}

interface StripModel {
  id: string;
  label: string;
  rail: string; // node kind → --rail-<kind>
  deviceName: string; // device CH SETTING name (plan.nodeNames), or ""
  isChannel: boolean;
  isMono: boolean;
  isBalance: boolean; // pan reads as a BALANCE (stereo / FX channel, or a BAL-linked pair)
  fadersOnly: boolean; // bus/mon/osc/master: always show their own level
  isOsc: boolean;
  isStream: boolean; // the STREAMING bus (meter-only, carries the DELAY chip + TIME knob)
  hasMute: boolean; // strips with a → STEREO send (CH / FX / MIX)
  hasEq: boolean; // channels + mix + stereo
  hasPhones: boolean; // monitor buses (PHONES 1 ↔ mon1, PHONES 2 ↔ mon2)
  meterOnly: boolean; // STREAMING: only a live meter, no fader / set-level readout
  inactive: boolean; // node master is off (dim the strip; shared isNodeInactive predicate)
  range: LevelRange;
}

// The scribble power LED's binding: the current on-state, a flip, and the MIDI id it
// arms. Null for STREAMING (no on/off param).
interface PowerSpec {
  on: boolean;
  /** Flips the flag and returns the node-parameter keys it wrote. */
  toggle: () => readonly string[];
  midiId: string;
}

// One metered channel within a strip's meter column. A mono strip has a single lane;
// a stereo strip (whose tap carries an R address) has two, L and R, sharing one ladder
// frame and one OVER frame but each with its own bar column and clip cell.
// v/pk: live level/peak ballistics; over: clip latch ballistic. lv/lpk/lov: last value
// written to the DOM (-1 = none yet) so paintMeters can skip unchanged writes. live =
// lane is animating (its `live` class promotes the shade/peak to compositor layers).
interface MeterLane {
  col: HTMLElement; // bar column (bar + shade + peak); `live` class gates its layers
  shade: HTMLElement;
  peak: HTMLElement;
  clip: HTMLElement; // this channel's OVER latch cell
  v: number;
  pk: number;
  over: number;
  lv: number;
  lpk: number;
  lov: number;
  live: boolean;
}

interface StripRef {
  m: StripModel;
  // The strip's root element, so a device-follow direct change can rebuild just this
  // strip in place (refreshStrip) instead of re-rendering the whole console.
  root: HTMLElement;
  lanes: MeterLane[]; // 1 (mono) or 2 (stereo L, R)
  // Fader controls — absent on a meter-only strip (STREAMING), which has no fader.
  cap?: HTMLElement;
  fader?: HTMLElement;
  readDb?: HTMLElement;
  readMtr: HTMLElement; // live meter value cell (the selected tap's dBFS, peak of L/R)
  tap: MeterTap | null; // the resolved tap this strip's meter shows (fixed per render)
  // lmtr = last meter readout written (deci-dB; 1 = sentinel "none written").
  sig: { lmtr: number };
  // SENDS rack: the per-send column faders — kept so a BAL-linked partner's rack
  // fader can be mirrored in place, like the main fader. The header readout and the
  // collapsed dots are reached via `root` when the global collapse toggles.
  sendCols?: SendColRef[];
}

// One send column's fader in a strip's SENDS rack, keyed by send target so a
// BAL-linked partner strip can mirror the matching column live (mirrorPartnerSend).
interface SendColRef {
  target: SendTarget;
  fader: HTMLElement;
  cap: HTMLElement;
}

interface KnobSpec {
  get: () => number;
  set: (v: number) => void;
  min: number;
  max: number;
  step: number;
  /** Step while Shift is held (fine-tuning mode). Only params with a
   *  device-verified fine grid set it (the STREAMING TIME knob, 0.02 ms).
   *  The printed legend sits in the whitespace above the knob (style.css
   *  `.con-gain .fine-tag`) — a knob with content directly above (a stacked
   *  PAN/BAL row) would need a new anchor before opting in. */
  fine?: number;
  format: (v: number) => string;
  reset: number;
  /** Indicator angle (deg) for a value; default is a -135°..+135° sweep over the
   *  range. Override to place specific values (e.g. PHONES 2/8) at the horizontal. */
  angle?: (v: number) => number;
  /** When set, the knob shows its value but cannot be edited (a device-locked
   *  control, e.g. a Pan-Link send pan). The string is the disabled tooltip. */
  readonlyTitle?: string;
  /** The node-parameter keys `set` writes, for the change funnel's write witness.
   *  Absent for a knob that writes a wire's params instead. */
  keys?: readonly string[];
}

/** MIDI-learn integration. The contract is shared with the channel tuning screens
 *  (ui/midi-learn.ts): the MIDI window owns the mode / armed state and re-renders
 *  both surfaces when they change. */
export type ConsoleMidiHooks = MidiLearnHooks;

export interface ConsoleHooks {
  getModel: () => DeviceModel;
  getPlan: () => Plan;
  /** An edit changed the plan (mute / fader / EQ): flag dirty + schedule live sync.
   *  `written` names the contest keys the edit ASSERTED — its own and the ones a pair
   *  mirror carried — not only the ones whose value moved. A device read in flight
   *  arbitrates by authorship, so a write that lands on the value already there is
   *  invisible to it otherwise. */
  onChange: (written?: readonly string[]) => void;
  /** The meter stream could not be registered. Bars stuck on the floor are
   *  indistinguishable from silence, so the host surfaces this rather than
   *  leaving a live session that quietly shows nothing. */
  onMeterError?: (message: string) => void;
  /** Open the GATE tuning screen for a MONO IN channel. */
  onOpenDynScreen?: (kind: DynKind, id: string) => void;
  midi?: ConsoleMidiHooks;
}

// The bars animate every frame; the numeric readout text is refreshed only every
// Nth frame (~6 Hz at 30 fps) so its text relayout/repaint isn't a per-frame cost.
const READOUT_EVERY = 5;

export class Console {
  private paintN = 0; // frame counter gating the throttled numeric readout
  private refs = new Map<string, StripRef>();
  private lastInsFx = new Map<string, number>(); // last non-none INS FX per node
  private factory: { id: string; plan: Plan } | null = null; // cached factory plan
  private headH = { key: "", px: 0 }; // cached MAIN-tab head height (key: model + hidden)
  // The insert-FX slot census of the build pass in progress. It is a whole-model
  // sweep and every strip's INS FX chip asks the same question of it, so it is taken
  // once by whichever entry point starts the pass (render / refreshStrip — a render
  // also builds every strip a second time in mainHeadHeight) and handed to
  // insertFxMenu, rather than swept per strip. Null means no pass set one, and the
  // menu falls back to sweeping for itself.
  private ifxCensus: InsertFxCensus | null = null;
  private store = new MeterStore();
  private unsub: (() => void) | null = null;
  private subSig = ""; // signature of the currently subscribed address set
  // The one meter slot is lent to another screen. Every render() ends in
  // startMeters(), and renders happen for reasons that have nothing to do with
  // this view being looked at — a device-follow reconcile re-renders the console
  // behind a modal — so without this the borrower's stream is taken back out from
  // under it, silently, and its display just stops.
  private metersLent = false;
  private subPending = false; // a registration is in flight (see startMeters)
  private raf = 0;
  private live = false;
  private visible = false;
  private meterTap = new Map<string, string>(); // node id → chosen tap key (override)
  private idsCache = { key: "", ids: new Set<string>() }; // visibleIds memo (model + hidden)
  private tapModel = ""; // model id the meterTap map was loaded for
  private railInk = new Map<string, { color: string; shadow: string }>(); // rail token → ink, per render
  private tapOpenFor: string | null = null; // node whose tap popover is open
  private readonly TAP_STORE = "urx-metertap";
  private readonly SENDS_STORE = "urx-sends-open";
  // SENDS rack global collapse (one state for every strip so the columns stay
  // aligned), persisted across sessions; the SEND PAN popover and the strip it is
  // open for. Collapse toggles a host class — no re-render — so the state is read
  // once at build and kept here.
  private sendsOpen = loadJson<boolean>(this.SENDS_STORE, true);
  private sendPanPop!: HTMLElement;
  private sendPanOpenFor: string | null = null;
  private sendPanBtn: HTMLElement | null = null; // the PAN ▾ button the open popover anchors to
  private tapPop!: HTMLElement;
  private stripsHost!: HTMLElement;

  constructor(
    private host: HTMLElement,
    private hooks: ConsoleHooks,
  ) {
    this.build();
    // Dev-only handle for the meter bench (scripts/meter-bench.mjs): it drives this
    // view's own paint loop from a synthetic reading feed, so the meters' render cost
    // is measurable without a device and comparable across revisions. The branch is
    // statically dropped from a production build.
    if (import.meta.env.DEV) (window as unknown as { __urxConsole?: Console }).__urxConsole = this;
  }

  // ---- public API ----

  show(): void {
    this.visible = true;
    this.host.hidden = false;
    this.render(); // render() (re)starts the meter stream when live
  }

  hide(): void {
    this.visible = false;
    this.host.hidden = true;
    // Keep the broker meter subscription alive across a view switch: re-registering
    // every meter address on each toggle stalls the readings for ~1 s. Just stop the
    // paint loop and leave the stream warm — it is torn down only when Live sync ends
    // (setLive(false) / stopMeters), so re-showing resumes from fresh data at once.
    this.stopPaint();
  }

  /** Hand the broker's meter subscription to another screen. There is one slot
   *  process-wide — a subscribe replaces the previous registration and the
   *  unsubscribe takes no address — and the replacement is silent, so a screen
   *  that wants its own addresses has to say so rather than let this view keep
   *  believing it still has a stream. */
  releaseMeters(): void {
    this.metersLent = true;
    this.stopMeters();
  }

  /** Take the slot back. A no-op unless this view is live and on screen: opened
   *  from the GRAPH inspector, the console may be hidden, and its stream is then
   *  re-established by the render() that the next show() runs. */
  regainMeters(): void {
    this.metersLent = false;
    this.startMeters();
  }

  /** Live sync turned on/off: gate the signal meter lanes and their stream. */
  setLive(active: boolean): void {
    this.live = active;
    this.host.classList.toggle("live", active);
    // The stream is bound to Live sync, not visibility (a view toggle only pauses
    // painting — see hide()); fully tear it down when live ends, or when it turns on
    // while hidden (nothing to stream until the first show re-subscribes).
    if (!active || !this.visible) this.stopMeters();
    // Rebuild so the CH → FX send Pre/Post chip flips read-only with live state;
    // render() (re)starts/re-scopes the meter stream at its tail when live.
    if (this.visible) this.render();
  }

  /** Re-read set levels after an external edit (inspector / graph / readback). */
  refresh(): void {
    if (this.visible) this.render();
  }

  /** Rebuild just one strip in place after a device-follow direct change, instead
   *  of re-rendering the whole console. No-op when hidden or when the node has no
   *  strip in the current view (mode-filtered). The strip's live-meter ballistics and
   *  keyboard focus carry across, and the meter is redrawn in the same task, so
   *  neither the meter (nor its peak-hold bar or readout) blinks nor the operator's
   *  focused control is dropped; the meter subscription is untouched (same tap). */
  refreshStrip(id: string): void {
    if (!this.visible) return;
    // A hung node (a ducker) has no strip of its own — its chip lives on the
    // parent strip (attachTo). Retarget to the parent so an external edit of the
    // child (a MIDI DUCKER toggle / device follow) repaints that chip; without
    // this the refs lookup misses and the chip stays stale until a full re-render.
    const stripId = this.hooks.getModel().nodes.find((n) => n.id === id)?.attachTo ?? id;
    const old = this.refs.get(stripId);
    if (!old) return;
    // Mark focus while the strip being replaced is still the one in refs.
    const restoreFocus = this.captureFocus();
    this.ifxCensus = insertFxCensus(this.hooks.getModel(), this.hooks.getPlan());
    const fresh = this.buildStrip(this.toStripModel(stripId));
    // buildStrip re-registered refs.get(stripId) with fresh meter elements; carry the
    // ballistics onto them so the meter (and its peak-hold bar) doesn't jump.
    this.carryMeterState(old, this.refs.get(stripId));
    old.root.replaceWith(fresh);
    this.redrawMeters(stripId);
    // The SEND PAN popover floats free of its strip, so the rebuild above left an
    // open one anchored to the detached PAN button with stale knob values. Re-open
    // it against the fresh strip's button: openSendPan re-reads the plan for the
    // knobs, re-marks the live trigger (.open / aria-expanded) and re-anchors in
    // place (the fresh strip occupies the old one's slot).
    if (this.sendPanOpenFor === stripId) {
      const btn = fresh.querySelector<HTMLElement>(".con-panbtn");
      if (btn) this.openSendPan(stripId, btn);
      else this.closeSendPan();
    }
    restoreFocus();
  }

  // ---- build / render ----

  private build(): void {
    this.host.classList.add("con-root");
    this.host.classList.toggle("sends-collapsed", !this.sendsOpen);

    this.stripsHost = el("div", "con-strips");
    const wrap = el("div", "con-wrap");
    wrap.append(this.stripsHost);
    this.host.append(wrap);

    // Floating meter-point popover (positioned fixed so it escapes the strip
    // scroll container). One element reused for whichever strip opened it.
    this.tapPop = el("div", "con-tappop");
    this.tapPop.hidden = true;
    this.host.append(this.tapPop);
    // SEND PAN popover: one reused element, anchored below the strip's PAN ▾ button
    // (the .below/.above caret class is set per open by placePopover's flip result).
    this.sendPanPop = el("div", "con-spop");
    this.sendPanPop.hidden = true;
    this.host.append(this.sendPanPop);
    // Close either popover on any outside interaction (each trigger manages its own
    // toggle, so a click on the trigger is excluded).
    document.addEventListener("pointerdown", (e) => {
      const tgt = e.target as HTMLElement;
      if (this.tapOpenFor && !this.tapPop.contains(tgt) && !tgt.closest(".con-tap")) this.closeTapPop();
      if (this.sendPanOpenFor && !this.sendPanPop.contains(tgt) && !tgt.closest(".con-panbtn")) this.closeSendPan();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (this.sendPanOpenFor) this.closeSendPan();
      if (this.tapOpenFor) this.closeTapPop();
    });
  }

  // dB tick labels for a strip's fader range (per-channel scale between the fader
  // and meter). Top/bottom align with the fader travel, so it reads the level. Ticks
  // above `ceilingDb` are dropped — strips whose fader/meter top out at 0 dB (OSC,
  // the meter-only STREAMING strip) don't label the unreachable +5/+10 marks.
  private buildScale(range: LevelRange, ceilingDb = range.max): HTMLElement {
    const scale = el("div", "con-scale");
    for (const db of range.ticks) {
      if (db > ceilingDb) continue;
      const tick = el("div", "t");
      // The bottom tick reads -∞ (off), so it sits at the fader's off position —
      // the very bottom of the travel — not at the lowest detent one notch above.
      const isOff = db <= range.min;
      tick.style.bottom = dbToFrac(isOff ? range.off : db, range) * 100 + "%";
      // The number is centred; a minus sign hangs to its left so the digits of
      // e.g. "10" and "-10" line up vertically.
      const num = el("span", "num");
      if (db < 0) {
        const sign = el("span", "sign");
        sign.textContent = "−";
        num.append(sign);
      }
      if (isOff) {
        const inf = el("span", "glyph-inf");
        inf.textContent = "∞";
        num.append(inf);
      } else {
        num.append(document.createTextNode(String(Math.abs(db))));
      }
      tick.append(num);
      scale.append(tick);
    }
    return scale;
  }

  // The node ids on screen: every model node minus the ones shelved out of the
  // graph (a shelved node drops from the console too). Shared by the strip groups,
  // the rack send slots and the head-height probe so "visible" is defined once.
  // Memoized on model + hidden set, since a single render resolves it once per strip
  // (and once per rack) — all with the same answer.
  private visibleIds(): Set<string> {
    const hidden = this.hooks.getPlan().hidden;
    const key = this.hooks.getModel().id + "|" + hidden.join(",");
    if (this.idsCache.key !== key) {
      const h = new Set(hidden);
      this.idsCache = {
        key,
        ids: new Set(
          this.hooks
            .getModel()
            .nodes.map((n) => n.id)
            .filter((i) => !h.has(i)),
        ),
      };
    }
    return this.idsCache.ids;
  }

  private stripModels(): { groups: { label: string; ids: string[] }[]; master: string | null } {
    const model = this.hooks.getModel();
    const ids = this.visibleIds();
    const channels = model.nodes.filter((n) => n.kind === "channel" && ids.has(n.id)).map((n) => n.id);
    const busFx = ["bus.fx1", "bus.fx2", "bus.mix1", "bus.mix2", "bus.stream"].filter((i) => ids.has(i));
    const mon = ["bus.mon1", "bus.mon2", "bus.osc"].filter((i) => ids.has(i));
    const groups = [
      { label: t().console.groupInputs, ids: channels },
      { label: t().console.groupBus, ids: busFx },
      { label: t().console.groupMon, ids: mon },
    ].filter((g) => g.ids.length > 0);
    return { groups, master: ids.has("bus.stereo") ? "bus.stereo" : null };
  }

  private toStripModel(id: string): StripModel {
    const node = this.hooks.getModel().nodes.find((n) => n.id === id)!;
    const isChannel = node.kind === "channel";
    const isMaster = id === MAIN_BUS;
    const isOsc = id === "bus.osc";
    const isStream = id === "bus.stream";
    const isMix = this.isMixBus(id);
    const isMon = isMonitorBus(id);
    const isMono = /^ch\d+$/.test(id); // mono channels are ch1..ch4 (the only gain/gate/comp/φ-bearing strips)
    return {
      id,
      // The master reads "STEREO" here (the graph keeps the fuller "STEREO (MAIN)"):
      // the strip is narrow, and the LED + name must fit one line.
      label: isMaster ? "STEREO" : node.label,
      // Monitors carry no device CH SETTING name; their second row instead names
      // the linked PHONES output (PHONES 1 ↔ mon1, PHONES 2 ↔ mon2).
      deviceName: isMon ? `Phone ${id.slice(-1)}` : this.hooks.getPlan().nodeNames[id] || "",
      rail: `var(--rail-${node.kind})`,
      isChannel,
      isMono,
      // Mono channels read PAN unless STEREO-linked in BAL mode; native stereo / FX
      // channels always read BALANCE — matching the inspector (isBalanceChannel).
      isBalance: !isMono || isBalLinkedPair(this.hooks.getModel(), this.hooks.getPlan(), id),
      fadersOnly: !(isChannel || this.isFxChannel(id)),
      isOsc,
      isStream,
      // The MUTE chip exists only on strips that send to STEREO (CH / FX → STEREO
      // assign, MIX → STEREO "TO ST"): it toggles that send. STEREO / MONITOR have
      // no such send, so their master ON is the scribble power LED alone.
      hasMute: isChannel || this.isFxChannel(id) || isMix,
      hasEq: isChannel || isMix || isMaster,
      hasPhones: isMonitorBus(id),
      // Off-state dim, computed once here (the node is in hand) and read by both strip
      // builders — the same predicate the graph uses, so the two views dim alike.
      inactive: isNodeInactive(this.hooks.getPlan(), node),
      meterOnly: isStream || isOsc, // STREAMING + OSC: no fader (OSC uses a level knob)
      // OSC drives its level via the LEVEL knob, so its meter/scale use the shared
      // level_gain ruler like every other strip (and the meter-only STREAMING strip).
      range: NORMAL_RANGE,
    };
  }

  // The MIX/FX send targets that exist in this model and are not shelved out of the
  // graph — the fixed column set for every strip's SENDS rack (a shelved bus drops
  // its column on every strip). Order follows SEND_TARGETS: FX 1, FX 2, MIX 1, MIX 2.
  private sendSlots(): SendTarget[] {
    const ids = this.visibleIds();
    return SEND_TARGETS.filter((s) => ids.has(s));
  }

  // ---- meter point (per-strip tap selection) ----

  /** The tap key a strip's meter shows: the per-strip override or the default. */
  private tapKeyOf(id: string): string {
    return this.meterTap.get(id) ?? defaultTapKey(id, this.hooks.getModel().id);
  }

  // Persist the per-strip tap choices per model in localStorage (shape:
  // { [modelId]: { [nodeId]: tapKey } }), reusing the shared JSON storage helpers.
  private allTaps(): Record<string, Record<string, string>> {
    return loadJson<Record<string, Record<string, string>>>(this.TAP_STORE, {});
  }

  private loadTaps(): void {
    this.meterTap.clear();
    const m = this.allTaps()[this.hooks.getModel().id];
    if (m && typeof m === "object")
      for (const [k, v] of Object.entries(m)) if (typeof v === "string") this.meterTap.set(k, v);
  }

  private saveTaps(): void {
    const all = this.allTaps();
    all[this.hooks.getModel().id] = Object.fromEntries(this.meterTap);
    saveJson(this.TAP_STORE, all);
  }

  /** Apply a per-strip tap choice, persist it, and rebuild (re-scopes the stream). */
  private setTap(id: string, key: string): void {
    this.meterTap.set(id, key);
    this.saveTaps();
    this.closeTapPop();
    this.render();
  }

  // Build a strip's meter-point badge (the popover trigger). Shown only when the
  // node has more than one tap; single-meter nodes get no selector.
  private buildTapBadge(id: string): HTMLElement {
    const tap = tapFor(id, this.tapKeyOf(id), this.hooks.getModel().id);
    const badge = el("div", "con-tap");
    badge.setAttribute("role", "button");
    badge.setAttribute("aria-haspopup", "menu");
    badge.tabIndex = 0;
    // A small meter-bars glyph marks this as the METER point selector — so it
    // reads apart from the send-tap PRE/POST chip (which shares the pre/post
    // vocabulary but controls the send, not the meter).
    const ico = meterGlyph();
    const name = document.createTextNode(tap?.label ?? "");
    const cv = el("span", "cv");
    cv.textContent = "▾";
    badge.append(ico, name, cv);
    const toggle = (): void => {
      if (this.tapOpenFor === id) this.closeTapPop();
      else this.openTapPop(id, badge);
    };
    badge.addEventListener("click", toggle);
    badge.addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        toggle();
      } else if (e.key === "Escape") {
        this.closeTapPop();
      }
    });
    return badge;
  }

  // Open the floating meter-point popover for a node, anchored to its badge. The
  // chain lists the node's taps in signal order with the active one highlighted.
  private openTapPop(id: string, anchor: HTMLElement): void {
    this.closeSendPan(); // single-popover invariant (symmetric with openSendPan)
    const cur = this.tapKeyOf(id);
    this.tapPop.replaceChildren();
    const ph = el("div", "ph");
    ph.textContent = t().console.meterPoint;
    const chain = el("div", "chain");
    for (const tp of tapsFor(id, this.hooks.getModel().id)) {
      const row = el("div", "crow" + (tp.key === cur ? " active" : ""));
      row.setAttribute("role", "menuitemradio");
      row.setAttribute("aria-checked", String(tp.key === cur));
      row.tabIndex = 0;
      const node = el("span", "node");
      const nm = el("span", "nm");
      nm.textContent = tp.label;
      row.append(node, nm);
      const pick = (): void => this.setTap(id, tp.key);
      row.addEventListener("click", pick);
      row.addEventListener("keydown", (e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          pick();
        }
      });
      chain.append(row);
    }
    const foot = el("div", "foot");
    foot.textContent = t().console.meterPointHint;
    this.tapPop.append(ph, chain, foot);
    this.tapPop.hidden = false;
    this.tapOpenFor = id;
    // Position fixed near the badge, clamped to the viewport (top-right aligned).
    this.placePopover(this.tapPop, anchor, "right", 2);
  }

  private closeTapPop(): void {
    if (!this.tapOpenFor) return;
    this.tapOpenFor = null;
    this.tapPop.hidden = true;
    this.tapPop.replaceChildren();
  }

  // ---- SENDS rack ----

  // Build the per-strip SENDS rack (between the head and the fader zone): a header
  // (SENDS label / value readout / global collapse arrow + collapsed active-send
  // dots) and, for a strip that has sends, one fixed column per model send slot
  // (enable chip → PRE button → vertical mini-fader) plus a full-width PAN ▾ button
  // opening the SEND PAN popover. A strip with no sends renders the dimmed header
  // only (its arrow still drives the global collapse); a slot the strip lacks leaves
  // an empty column so columns stay aligned across strips.
  private buildSendRack(m: StripModel): { el: HTMLElement; cols: SendColRef[] } {
    const slots = this.sendSlots();
    const owned = slots.map((s) => this.hasSend(m.id, s)); // hasSend excludes self-sends
    const hasAny = owned.some(Boolean);
    const rack = el("div", "con-sends" + (hasAny ? "" : " empty"));

    const sh = el("div", "con-sh" + (hasAny ? "" : " dim"));
    sh.setAttribute("role", "button");
    sh.setAttribute("aria-expanded", String(this.sendsOpen));
    sh.tabIndex = 0;
    const lb = el("span", "lb");
    lb.textContent = t().console.sends;
    const rdout = el("span", "rdout");
    const ar = el("span", "ar");
    const dots = el("span", "dots");
    sh.append(lb, rdout, dots, ar);
    const toggle = (): void => this.toggleSends();
    sh.addEventListener("click", toggle);
    sh.addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        toggle();
      }
    });
    // Hovering one header previews the global scope: highlight every header at once.
    sh.addEventListener("pointerenter", () => this.host.classList.add("sends-hover"));
    sh.addEventListener("pointerleave", () => this.host.classList.remove("sends-hover"));
    rack.append(sh);
    if (!hasAny) return { el: rack, cols: [] };

    // The header label swaps to a value readout while a column is touched.
    const swap = (text: string | null): void => {
      if (text === null) sh.classList.remove("readout");
      else {
        rdout.textContent = text;
        sh.classList.add("readout");
      }
    };

    const cols: SendColRef[] = [];
    const scols = el("div", "con-scols");
    slots.forEach((s, i) => {
      if (!owned[i]) {
        scols.append(el("div", "con-scol empty"));
        return;
      }
      const built = this.buildSendCol(m, s, swap);
      cols.push(built.ref);
      scols.append(built.el);
    });
    rack.append(scols);
    this.fillDots(dots, m.id, slots);

    // PAN ▾ button → SEND PAN popover (send-pan is a MIX-send subparameter with no
    // room on the narrow column, so it lives in a popover below this button).
    const panbtn = el("button", "con-panbtn") as HTMLButtonElement;
    panbtn.type = "button";
    panbtn.dataset.strip = m.id;
    panbtn.setAttribute("aria-haspopup", "true");
    panbtn.setAttribute("aria-expanded", "false");
    const cv = el("span", "cv");
    cv.textContent = "▾";
    panbtn.append(document.createTextNode("PAN"), cv);
    panbtn.addEventListener("click", () => {
      if (this.sendPanOpenFor === m.id) this.closeSendPan();
      else this.openSendPan(m.id, panbtn);
    });
    rack.append(panbtn);
    return { el: rack, cols };
  }

  // One send column: enable chip (params.on, amber = active) → PRE button (params.tap,
  // amber = pre; read-only for a CH → FX tap while live) → vertical mini-fader
  // (params.level, relative drag, snapped to the level_gain grid).
  private buildSendCol(
    m: StripModel,
    target: SendTarget,
    swap: (text: string | null) => void,
  ): { el: HTMLElement; ref: SendColRef } {
    const range = m.range;
    // The column's connection object is stable for this build's lifetime — edits
    // mutate its `params` in place, and a plan swap re-renders — so capture it once
    // instead of re-scanning plan.connections for every read/write. `pre`/`level`/`on`
    // are read off `c.params` live (reassigned in place).
    const c = sendConnection(this.hooks.getPlan(), m.id, target);
    const isMix = this.isMixBus(target);
    // FIXED BUS Type locks the MIX send level read-only (matching the graph inspector);
    // the PRE tap and enable chip stay editable.
    const busFixed = isMix && mixSendLocks(this.hooks.getPlan(), target).busFixed;

    const col = el("div", "con-scol" + (c?.params?.on !== false ? "" : " off"));
    // vertical mini-fader (built first so the PRE button can refresh its aria-valuetext)
    const fader = el("div", "con-vfad" + (busFixed ? " readonly" : ""));
    fader.setAttribute("role", "slider");
    fader.setAttribute("aria-label", SEND_LABEL[target]);
    if (busFixed) {
      fader.setAttribute("aria-disabled", "true");
      fader.title = t().inspector.busFixedLevel;
    } else {
      fader.tabIndex = 0;
    }
    const cap = el("div", "cap");
    const zero = el("div", "zero");
    zero.style.setProperty("--zero", (1 - dbToFrac(0, range)) * 100 + "%");
    fader.append(el("div", "track"), zero, cap);
    const ref: SendColRef = { target, fader, cap };
    const readoutText = (): string => {
      const pre = c?.params?.tap === "pre" ? " " + t().console.pre : "";
      return SEND_LABEL[target] + pre + " " + fmtDb(c?.params?.level ?? LEVEL_OFF_DB, range).text;
    };

    // enable chip
    const chip = this.buildChip(
      m.id,
      SEND_SHORT[target],
      c?.params?.on !== false,
      () => {
        const next = c?.params?.on === false; // was off → turn on
        if (c) c.params = { ...c.params, on: next };
        return next;
      },
      { cls: "con-sl", midiId: controlId(m.id, "mute", target), after: (next) => col.classList.toggle("off", !next) },
    );

    // PRE button
    // Port refs, not bare node ids: the routing rules are keyed by `node:port`, so a bare
    // id matches no rule and `sendTapWritable` answers false for every send — which while
    // live locked every PRE chip (and dropped its MIDI binding), including the CH → MIX
    // and FX-channel → MIX taps the device does accept.
    const tapReadonly =
      this.live && !sendTapWritable(this.hooks.getModel(), portRef(m.id, "out"), portRef(target, "in"));
    const preBtn = this.buildChip(
      m.id,
      t().console.pre,
      c?.params?.tap === "pre",
      () => {
        const next = c?.params?.tap !== "pre";
        if (c) c.params = { ...c.params, tap: next ? "pre" : "post" };
        this.updateColLevel(ref, range, c?.params?.level ?? LEVEL_OFF_DB, next); // refresh PRE prefix
        return next;
      },
      tapReadonly
        ? { cls: "con-slp", readonlyTitle: t().inspector.prePostLcdOnly }
        : { cls: "con-slp", midiId: isMix ? controlId(m.id, "tap", target) : undefined, title: t().console.preHint },
    );

    // A FIXED-bus send fader is display-only: paint its value but skip the wiring.
    if (!busFixed) this.wireColFader(m.id, target, c, ref, range, swap, readoutText);
    this.updateColLevel(ref, range, c?.params?.level ?? LEVEL_OFF_DB, c?.params?.tap === "pre");
    col.append(chip, preBtn, fader);
    return { el: col, ref };
  }

  // Wire a send column's vertical mini-fader: relative drag (no jump-to-click, since
  // one pixel is a whole detent), a 3 px threshold before the first write, Shift =
  // fine, and the keyboard grid steps of the main fader. The header readout mirrors
  // the value while the column is touched, then reverts to the SENDS label.
  private wireColFader(
    node: string,
    target: SendTarget,
    c: PlanConnection | undefined,
    ref: SendColRef,
    range: LevelRange,
    swap: (text: string | null) => void,
    readoutText: () => string,
  ): void {
    const { fader } = ref;
    const midiId = controlId(node, "level", target);
    this.midiMark(fader, midiId);
    const level = (): number => c?.params?.level ?? LEVEL_OFF_DB;
    // The header readout is shared by the rack's columns, so revert it only when no
    // column in this rack is still hovered or focused (else leaving column B would
    // clear column A's readout while A keeps focus). The rack ancestor is fixed for
    // the fader's lifetime, so resolve it once.
    const rack = fader.closest(".con-sends");
    const rackTouched = (): boolean => !!rack?.querySelector(".con-vfad:hover, .con-vfad:focus");
    const set = (db: number): void => {
      if (c) c.params = { ...c.params, level: db };
      this.updateColLevel(ref, range, db, c?.params?.tap === "pre");
      swap(readoutText());
      this.commit(node);
      this.mirrorPartnerSend(node, target);
    };
    let dragging = false;
    fader.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (this.midiArm(midiId)) return;
      dragging = true;
      const startY = e.clientY;
      const startFrac = dbToFrac(level(), range);
      const travel = fader.getBoundingClientRect().height - 12;
      let moved = false;
      trackDrag(
        fader,
        e,
        (ev) => {
          const dy = startY - ev.clientY;
          if (!moved && Math.abs(dy) < 3) return; // threshold guards mis-grabs / dblclick
          moved = true;
          const frac = startFrac + (dy * (ev.shiftKey ? 0.25 : 1)) / travel;
          set(fracToDb(frac, range));
        },
        {
          onEnd: () => {
            dragging = false;
            swap(rackTouched() ? readoutText() : null); // keep it if still hovered/focused
          },
        },
      );
    });
    fader.addEventListener("keydown", (e) => {
      if (this.midiLearnKey(e, midiId)) return;
      const next = this.faderKeyStep(e, range, level());
      if (next === null) return;
      e.preventDefault();
      set(next);
    });
    fader.addEventListener("pointerenter", () => swap(readoutText()));
    fader.addEventListener("pointerleave", () => {
      // Keep the readout up while dragging (pointer captured) or if any sibling column
      // in this rack is still hovered / keyboard-focused.
      if (!dragging && !rackTouched()) swap(null);
    });
    fader.addEventListener("focus", () => swap(readoutText()));
    fader.addEventListener("blur", () => {
      if (!rackTouched()) swap(null);
    });
    fader.addEventListener("dblclick", () => {
      if (this.hooks.midi?.learnActive()) return; // pointerdown already armed
      set(this.sendLevelOf(this.factoryPlan(), node, target));
    });
    // Hover + wheel steps one detent, matching the main fader. The pointer sits over
    // the column while scrolling, so pointerenter has already surfaced the readout;
    // set() keeps it in step.
    onWheelStep(
      fader,
      (dir) => set(this.faderWheelStep(range, level(), dir)),
      () => this.hooks.midi?.learnActive(),
    );
  }

  // The next fader level for a keydown (Arrow = 1 detent, PageUp/Down = 6, Home = max,
  // End = −∞), or null for a non-stepping key. Shared by the main fader and the rack
  // columns; a step down off the floor lands on −∞ via the range's own step().
  private faderKeyStep(e: KeyboardEvent, range: LevelRange, cur: number): number | null {
    const base = cur < range.min ? range.min : cur;
    if (e.key === "ArrowUp") return range.step(base, 1);
    if (e.key === "ArrowDown") return range.step(base, -1);
    if (e.key === "PageUp") return range.step(base, 6);
    if (e.key === "PageDown") return range.step(base, -6);
    if (e.key === "Home") return range.max;
    if (e.key === "End") return range.off;
    return null;
  }

  // One detent up/down from a wheel notch, mirroring the Arrow keys (a step down
  // off the floor lands on −∞ via the range's own step()). Shared by both faders.
  private faderWheelStep(range: LevelRange, cur: number, dir: 1 | -1): number {
    const base = cur < range.min ? range.min : cur;
    return range.step(base, dir);
  }

  // Paint a send column's fader cap position + accessible value from a dB level + tap.
  private updateColLevel(ref: SendColRef, range: LevelRange, db: number, pre: boolean): void {
    ref.cap.style.setProperty("--pos", (1 - dbToFrac(db, range)) * 100 + "%");
    const f = fmtDb(db, range);
    ref.fader.setAttribute("aria-valuenow", String(Math.round(db)));
    ref.fader.setAttribute("aria-valuetext", f.off ? "off (-∞)" : (pre ? "PRE, " : "") + f.text + " dB");
  }

  // Fill a collapsed-header dots row: one amber dot per active (ON) send.
  private fillDots(dots: HTMLElement, id: string, slots: SendTarget[]): void {
    dots.replaceChildren();
    for (const s of slots) {
      if (s === id) continue;
      const c = sendConnection(this.hooks.getPlan(), id, s);
      if (c && c.params?.on !== false) dots.append(el("i", ""));
    }
  }

  // Toggle the global SENDS collapse (one state for every strip so the columns stay
  // aligned): flip the host class, persist, and in one pass per strip reset the value
  // readout, sync aria-expanded, and refresh the collapsed dots (all reached via the
  // strip's `.con-sh` header, so no separate DOM sweep is needed).
  private toggleSends(): void {
    this.sendsOpen = !this.sendsOpen;
    saveJson(this.SENDS_STORE, this.sendsOpen);
    this.host.classList.toggle("sends-collapsed", !this.sendsOpen);
    this.closeSendPan();
    const slots = this.sendSlots();
    for (const ref of this.refs.values()) {
      const sh = ref.root.querySelector<HTMLElement>(".con-sh");
      if (!sh) continue;
      sh.classList.remove("readout");
      sh.setAttribute("aria-expanded", String(this.sendsOpen));
      const dots = sh.querySelector<HTMLElement>(".dots");
      if (dots) this.fillDots(dots, ref.m.id, slots);
    }
  }

  // Open the SEND PAN popover below a strip's PAN ▾ button: the strip's MIX sends'
  // pan as rotary knobs laid out in horizontal columns (destination label above,
  // value below), echoing the rack columns. FX sends are mono and carry no pan.
  private openSendPan(stripId: string, anchor: HTMLElement): void {
    this.closeTapPop();
    this.closeSendPan(); // clears any previously-open PAN trigger before opening the new one
    const plan = this.hooks.getPlan();
    this.sendPanPop.replaceChildren();
    // The popover floats free of its strip once open, so name the owning strip in
    // the header — position alone no longer ties it back.
    const ph = el("div", "ph");
    const cat = el("span", "cat");
    cat.textContent = t().console.sendPan;
    const who = el("span", "who");
    who.textContent = this.toStripModel(stripId).label;
    ph.append(cat, who);
    const grid = el("div", "pcols");
    for (const target of this.sendSlots()) {
      if (!this.isMixBus(target) || !this.hasSend(stripId, target)) continue;
      const pcol = el("div", "pcol");
      const capEl = el("span", "cap");
      capEl.textContent = SEND_LABEL[target];
      const conn = (): PlanConnection | undefined => sendConnection(this.hooks.getPlan(), stripId, target);
      const factory = sendConnection(this.factoryPlan(), stripId, target)?.params?.pan ?? 0;
      const { panLinked } = mixSendLocks(plan, target);
      const spec = this.panKnobSpec(
        () => conn()?.params?.pan ?? 0,
        (v) => {
          const c = conn();
          if (c) c.params = { ...c.params, pan: v };
        },
        factory,
        panLinked ? t().inspector.panLinked : undefined,
      );
      // partnerSync off: a BAL-linked mirror is handled by commit; a re-render would
      // tear down this popover, and no partner send-pan control is on screen.
      const { knob, val } = this.buildKnob(
        spec,
        SEND_LABEL[target],
        stripId,
        "rv",
        controlId(stripId, "pan", target),
        false,
      );
      pcol.append(capEl, knob, val);
      grid.append(pcol);
    }
    this.sendPanPop.append(ph, grid);
    this.sendPanPop.hidden = false;
    this.sendPanOpenFor = stripId;
    // Mark the trigger active so it reads as the open popover's owner; closeSendPan
    // clears it (the anchor outlives the open/close cycle — a render closes the
    // popover before rebuilding the strips).
    this.sendPanBtn = anchor;
    anchor.classList.add("open");
    anchor.setAttribute("aria-expanded", "true");
    // Anchor below the PAN ▾ button, centred on it (upward caret), clamped to the viewport.
    this.placePopover(this.sendPanPop, anchor, "center", 8);
  }

  private closeSendPan(): void {
    if (!this.sendPanOpenFor) return;
    this.sendPanOpenFor = null;
    this.sendPanPop.hidden = true;
    this.sendPanPop.replaceChildren();
    if (this.sendPanBtn) {
      this.sendPanBtn.classList.remove("open");
      this.sendPanBtn.setAttribute("aria-expanded", "false");
      this.sendPanBtn = null;
    }
  }

  // Position a fixed popover by its anchor, clamped to the viewport: opens `gap` px
  // below the anchor (flipping above on bottom overflow); `align` picks the horizontal
  // edge — "right" (the popover's right under the anchor's right, for the meter badge)
  // or "center" (centred on the anchor, for the SEND PAN button).
  private placePopover(pop: HTMLElement, anchor: HTMLElement, align: "right" | "center", gap: number): void {
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const left = popLeft(align === "center" ? r.left + r.width / 2 - pw / 2 : r.right - pw, pw);
    pop.style.left = left + "px";
    const top = popTop(r, pop.offsetHeight, gap);
    pop.style.top = top + "px";
    // Caret side follows the flip: `.below` when it opened below the anchor, `.above`
    // when bottom overflow flipped it above (the SEND PAN popover styles the caret).
    const below = top >= r.bottom;
    pop.classList.toggle("below", below);
    pop.classList.toggle("above", !below);
  }

  // ---- MIDI learn ----

  /** In learn mode an armable control arms itself on activation instead of
   *  editing. Returns true when the interaction was consumed by arming. */
  private midiArm(id: string | undefined): boolean {
    const midi = this.hooks.midi;
    if (!id || !midi?.learnActive()) return false;
    midi.arm(id);
    return true;
  }

  /** Learn-mode keyboard gate for the fader / knob handlers: Space/Enter arms;
   *  anything else (Tab, arrows) is left to the browser so keyboard navigation
   *  keeps working. True when learn mode owns the event (skip the edit keys). */
  private midiLearnKey(e: KeyboardEvent, midiId: string | undefined): boolean {
    if (!this.hooks.midi?.learnActive()) return false;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      this.midiArm(midiId);
    }
    return true;
  }

  /** Learn-mode affordances plus the bound address as a tooltip — the shared
   *  treatment, so a strip control and a tuning-screen control read the same. */
  private midiMark(el: HTMLElement, id: string | undefined): void {
    markMidi(el, id, this.hooks.midi);
  }

  // Paint a scribble with the node's device CH SETTING colour, or with the rail
  // fallback when unset — and pick the ink for whichever ground it ends up being.
  // The fallback used to return early, which left every rail-coloured scribble on
  // the stylesheet's fixed ink and no halo at all: measured, four of the five rails
  // are mid-tones where that ink loses by 30-40 Lc, and two of them reach neither
  // ink's floor, which is exactly where the halo does the work.
  private paintScribble(scrib: HTMLElement, m: StripModel): void {
    const color = this.hooks.getPlan().nodeColors?.[m.id];
    const ink = color ? inkOn(color) : this.inkForRail(m.rail);
    if (color) scrib.style.background = color;
    if (!ink) return;
    scrib.style.color = ink.color;
    scrib.style.setProperty("--scrib-shadow", ink.shadow);
  }

  // Resolve a rail token to its ink. `rail` is the token reference the strip writes
  // (`var(--rail-channel)`), so the colour itself lives in the stylesheet and only
  // the computed root can say what it is. That read is why this is cached and why
  // render() drops the cache: reading it per strip would put a computed-style read
  // inside the rebuild loop, which is the shape that costs 25 ms a layout in WebKit.
  private inkForRail(rail: string): { color: string; shadow: string } | null {
    const token = /^var\((--[a-z0-9-]+)\)$/.exec(rail)?.[1];
    if (!token) return null;
    const hit = this.railInk.get(token);
    if (hit) return hit;
    const hex = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    if (!hex) return null;
    const ink = inkOn(hex);
    this.railInk.set(token, ink);
    return ink;
  }

  // The scribble strip: the CH SETTING colour + a power LED, the node name and the
  // device CH SETTING name row ("—" when unset, so every strip is the same height).
  // Shared by both strip builders. When the strip has an on/off (every strip but
  // STREAMING) the whole scribble is the power button; the LED reflects its state.
  private scribble(m: StripModel): HTMLElement {
    const scrib = el("div", "con-scribble");
    this.paintScribble(scrib, m);
    const name = el("div", "name");
    const spec = this.powerSpec(m);
    let led: HTMLElement | undefined;
    if (spec) {
      led = el("span", "con-pled");
      led.append(el("i", "dot"));
      name.append(led);
    }
    const txt = el("span", "txt");
    txt.textContent = m.label;
    // The LED steals ~2 chars; shrink long names a step (or two for OSCILLATOR) so
    // they fit beside it. "CH 11/12" (8 chars) overflows 11px by ~1px in SF Mono, so
    // 8-char names drop to 9px; STREAMING has no LED (spec null), so its 9-char name
    // stays full-size.
    if (spec && m.label.length >= 8) txt.style.fontSize = m.label.length >= 10 ? "8px" : "9px";
    name.append(txt);
    const dev = el("div", "id");
    dev.textContent = m.deviceName || "—";
    if (!m.deviceName) dev.classList.add("empty");
    scrib.append(name, dev);
    if (spec && led) this.wirePower(scrib, led, m, spec);
    return scrib;
  }

  // The strip's power control (the scribble LED): the node master ON on np.on — a
  // CH_ON / FX / MIX 675, or a STEREO / MONITOR master — or the oscillator on
  // osc.on. STREAMING has no master, so it gets no LED. Every non-OSC strip arms
  // the same "chOn" id (see below); "mute" is the separate → STEREO send.
  private powerSpec(m: StripModel): PowerSpec | null {
    if (m.isStream) return null;
    if (m.isOsc) {
      return {
        on: this.hooks.getPlan().nodeParams[m.id]?.osc?.on === true,
        toggle: () => {
          const p = this.nodeParamsOf(m.id);
          p.osc = { ...p.osc, on: !(p.osc?.on === true) };
          return ["osc.on"];
        },
        midiId: controlId(m.id, "oscOn"),
      };
    }
    // Every non-OSC strip's power LED is "chOn" (np.on, ON polarity) — uniform, so
    // the on-screen LED and the controller LED never disagree on polarity. ("mute" on
    // CH / FX / MIX is the separate → STEREO send.)
    return {
      on: this.hooks.getPlan().nodeParams[m.id]?.on !== false,
      toggle: () => {
        const p = this.nodeParamsOf(m.id);
        p.on = p.on === false;
        return ["on"];
      },
      midiId: controlId(m.id, "chOn"),
    };
  }

  // Wire an element as an activatable button: keyboard (Space / Enter), MIDI-learn
  // mark + arming, and click. `run` performs the edit; in learn mode arming consumes
  // the activation instead. Shared by the toggle chips and the scribble power button.
  private wireActivate(el: HTMLElement, midiId: string | undefined, run: () => void): void {
    el.tabIndex = 0;
    this.midiMark(el, midiId);
    const activate = (): void => {
      if (this.midiArm(midiId)) return;
      run();
    };
    el.addEventListener("click", activate);
    el.addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        activate();
      }
    });
  }

  // Make the scribble a power button: the LED reflects the on-state, click / Enter /
  // Space toggle the node master (or oscillator) through the shared funnel. A full
  // re-render follows so the strip's inactive dim updates.
  private wirePower(scrib: HTMLElement, led: HTMLElement, m: StripModel, spec: PowerSpec): void {
    led.classList.toggle("on", spec.on);
    scrib.classList.add("power");
    scrib.setAttribute("role", "button");
    scrib.setAttribute("aria-pressed", String(spec.on));
    scrib.setAttribute("aria-label", `${m.label} ${t().console.power}`);
    this.wireActivate(scrib, spec.midiId, () => {
      this.commit(m.id, spec.toggle());
      this.render();
    });
  }

  // A toggle chip ("MUTE"/"EQ"/"ON"/…): role=button, aria-pressed, keyboard-activated;
  // `toggle` flips the underlying plan flag and returns the new state, then the chip
  // commits (and re-renders when commit asks). Appends to `parent`; see buildChip for
  // the returning variant (the SENDS rack builds columns before appending).
  private makeChip(
    id: string,
    parent: HTMLElement,
    label: string,
    mute: boolean,
    on: boolean,
    toggle: () => boolean,
    opts?: { readonlyTitle?: string; midiId?: string; title?: string; rerender?: boolean; keys?: readonly string[] },
  ): void {
    parent.append(this.buildChip(id, label, on, toggle, { ...opts, mute }));
  }

  /** The narrow chip beside GATE / COMP that opens that processor's tuning screen.
   *  Momentary, so it deliberately skips `buildChip`: that runs `commit()` after
   *  its toggle, and this button changes nothing to commit. `wireActivate` still
   *  gives it the keyboard activation and the MIDI-learn guard the chips have —
   *  with no `midiId`, since a screen is not a device parameter to map. */
  private dynOpenChip(kind: DynKind, id: string): HTMLElement {
    const chip = el("div", "con-chip con-chip-open");
    chip.textContent = "▸";
    chip.setAttribute("role", "button");
    const label = dynOpenLabel(kind, t());
    chip.title = label;
    chip.setAttribute("aria-label", label);
    this.wireActivate(chip, undefined, () => this.hooks.onOpenDynScreen?.(kind, id));
    return chip;
  }

  // The chip primitive, returning the element. `cls` picks the base class (con-chip
  // for the head chips, con-sl / con-slp for the rack's enable chip / PRE button);
  // opts.mute paints the MUTE colour, opts.after runs after the toggle (before commit),
  // opts.readonlyTitle renders it inert with a tooltip, opts.midiId arms MIDI learn,
  // opts.rerender rebuilds the whole view for a toggle whose effect reaches other strips.
  private buildChip(
    id: string,
    label: string,
    on: boolean,
    toggle: () => boolean,
    opts?: {
      cls?: string;
      mute?: boolean;
      readonlyTitle?: string;
      midiId?: string;
      title?: string;
      after?: (next: boolean) => void;
      rerender?: boolean;
      keys?: readonly string[];
    },
  ): HTMLElement {
    const { cls = "con-chip", mute, readonlyTitle, midiId, title, after, rerender, keys } = opts ?? {};
    // Normalised before it reaches the DOM. The device write is `np.<flag> ? 1 : 0`
    // and the load funnel passes a finite numeric leaf through unchecked, so a plan
    // authored elsewhere reaches here carrying 1 — `String(1)` is "1", which is not
    // an ARIA boolean, and a screen reader is told nothing rather than "pressed".
    const state = Boolean(on);
    const chip = el("div", cls + (mute ? " mute" : "") + (state ? " on" : "") + (readonlyTitle ? " readonly" : ""));
    chip.textContent = label;
    chip.setAttribute("role", "button");
    chip.setAttribute("aria-pressed", String(state));
    // A hover tooltip spelling out a terse label (e.g. C.INT → Cue Interrupt).
    if (title) chip.title = title;
    if (readonlyTitle) {
      chip.setAttribute("aria-disabled", "true");
      chip.title = readonlyTitle;
      return chip;
    }
    this.wireActivate(chip, midiId, () => {
      const next = toggle();
      chip.classList.toggle("on", next);
      chip.setAttribute("aria-pressed", String(next));
      after?.(next);
      const mirrored = this.commit(id, keys);
      if (mirrored || rerender) this.render();
    });
    return chip;
  }

  // Build one lane: its bar column (green→red LED bar + shade + peak marker) and its
  // OVER latch cell. `side` is "" for a mono strip's single lane, or "l"/"r" to place
  // it in a stereo pair (both lanes then sit in the shared ladder / OVER frames).
  private buildLane(side: string): MeterLane {
    const col = el("div", "mtrcol" + (side ? " " + side : ""));
    const bar = el("div", "bar");
    const shade = el("div", "shade");
    const peak = el("div", "peak");
    col.append(bar, shade, peak);
    const clip = el("div", "lit" + (side ? " " + side : ""));
    return { col, shade, peak, clip, v: 0, pk: 0, over: 0, lv: -1, lpk: -1, lov: -1, live: false };
  }

  // Build the meter column: one OVER frame + one ladder frame, each holding one lane
  // (mono) or two (stereo L/R side by side with a gap). `stereo` splits the bars and
  // the clip cells but keeps the framing undivided. Returns the lanes paintMeters drives.
  private buildMeterColumn(range: LevelRange, stereo: boolean): { meter: HTMLElement; lanes: MeterLane[] } {
    const meter = el("div", "con-meter" + (stereo ? " stereo" : ""));
    // The ladder spans from the scale's lowest tick (--mfloor) to the 0 dB mark
    // (--mzero); the OVER window sits above. Both share the strip's fader ruler.
    meter.style.setProperty("--mzero", dbToFrac(0, range) * 100 + "%");
    meter.style.setProperty("--mfloor", dbToFrac(range.ticks[range.ticks.length - 1], range) * 100 + "%");
    const over = el("div", "con-over");
    const ladder = el("div", "con-ladder sig");
    // Color-zone boundaries as a fraction of the ladder, at the same travel as the dB
    // ticks of the matching value — so green/yellow/red map to absolute dBFS, not to
    // the lit height. Set on the frame; the bars inherit them.
    ladder.style.setProperty("--zy", meterFrac(METER_GREEN_TOP_DB, range) * 100 + "%");
    ladder.style.setProperty("--zr", meterFrac(METER_YELLOW_TOP_DB, range) * 100 + "%");
    const lanes = stereo ? [this.buildLane("l"), this.buildLane("r")] : [this.buildLane("")];
    for (const ln of lanes) {
      over.append(ln.clip);
      ladder.append(ln.col);
    }
    meter.append(over, ladder);
    return { meter, lanes };
  }

  // STREAMING strip: a live meter only — no fader, no set-level readout, no chips
  // (the device offers no level/EQ here, just a source select + delay). One meter
  // point (pre/post-DELAY read the same level), so no tap selector either.
  private buildMeterOnlyStrip(m: StripModel): HTMLElement {
    // OSC rests off by default, so its strip is dimmed until switched on (via the
    // scribble power LED) — the same inactive dim as every other strip. STREAMING has
    // no on/off, so it never dims (m.inactive is false there).
    const strip = el("div", "con-strip meter-only" + (m.inactive ? " inactive" : ""));
    strip.style.setProperty("--rail", m.rail);

    const head = el("div", "con-head");
    head.append(this.scribble(m));
    // OSCILLATOR: a LEVEL knob replaces the fader (the ON/OFF is the scribble power
    // LED). Edits the plan and syncs live via commit().
    if (m.isOsc) {
      // LEVEL knob: full OSC range (-96…0 dB). The indicator's horizontal marks read
      // -50 (left) / -8 (right); the extremes (down-left / down-right) reach -96 / 0.
      const factory = this.factoryPlan().nodeParams[m.id]?.osc?.level ?? -14;
      this.addKnob(
        head,
        "LEVEL",
        {
          get: () => this.getMain(m),
          set: (v) => this.setMain(m, v),
          min: -96,
          max: 0,
          step: 1,
          format: (v) => v.toFixed(1),
          reset: factory,
          angle: (v) =>
            v <= -50 ? -135 + ((v + 96) / 46) * 45 : v >= -8 ? 90 + ((v + 8) / 8) * 45 : -90 + ((v + 50) / 42) * 180,
        },
        m.id,
        controlId(m.id, "level"),
      );
    }
    // STREAMING: a DELAY on/off chip and a TIME knob (the delay time, 1…1000 ms).
    // Gives the otherwise-bare head controls so the strip reads as purposeful, and
    // mirrors the OSCILLATOR's ON + LEVEL pairing. Finer time steps stay in the
    // inspector; holding Shift steps the device's 0.02 ms fine grid (push-and-turn).
    if (m.isStream) {
      const chips = el("div", "con-chips");
      const delayOn = (): boolean => this.hooks.getPlan().nodeParams[m.id]?.delay?.on ?? false;
      this.makeChip(
        m.id,
        chips,
        "DELAY",
        false,
        delayOn(),
        () => {
          const np = this.nodeParamsOf(m.id);
          const next = !delayOn();
          np.delay = { ...np.delay, on: next };
          return next;
        },
        { keys: ["delay.on"] },
      );
      chips.append(el("div", "con-chip spacer"));
      head.append(chips);
      const factory = this.factoryPlan().nodeParams[m.id]?.delay?.time ?? DELAY_TIME_MIN_MS;
      this.addKnob(
        head,
        "TIME",
        {
          get: () => this.hooks.getPlan().nodeParams[m.id]?.delay?.time ?? DELAY_TIME_MIN_MS,
          set: (v) => {
            const np = this.nodeParamsOf(m.id);
            np.delay = { ...np.delay, time: v };
          },
          keys: ["delay.time"],
          min: DELAY_TIME_MIN_MS,
          max: DELAY_TIME_MAX_MS,
          step: 1, // whole-ms on the knob; the inspector keeps the 0.01 ms grid
          fine: 0.02, // device-verified fine grid (fixed, rate-independent)
          // Digits by need: off-grid (fine / inspector-set) values get both
          // decimals; whole values keep the original compact display.
          format: (v) => v.toFixed(v % 1 ? 2 : v < 100 ? 1 : 0),
          reset: factory,
        },
        m.id,
      );
    }
    strip.append(head);
    // A meter-only strip has no sends, so its rack is the dimmed SENDS header only —
    // but it reserves the same rack height as every other strip so the fader/meter
    // tops stay aligned (and the global collapse is reachable from its header too).
    strip.append(this.buildSendRack(m).el);

    const zone = el("div", "con-faderzone");
    zone.append(el("div", "con-taphead")); // empty: keeps fader/meter tops aligned
    const zrow = el("div", "con-zrow");
    const tap = tapFor(m.id, this.tapKeyOf(m.id), this.hooks.getModel().id) ?? null;
    const { meter, lanes } = this.buildMeterColumn(m.range, isStereoTap(tap));
    // Meter tops out at 0 dBFS and there is no fader, so the scale stops at 0.
    zrow.append(this.buildScale(m.range, 0), meter);
    zone.append(zrow);
    strip.append(zone);

    // readout: live meter value only (no fader set-level cell).
    const readout = el("div", "con-readout");
    const { cell: mtrCell, value: mtrEl } = meterReadCell();
    readout.append(mtrCell);
    strip.append(readout);

    this.refs.set(m.id, {
      m,
      root: strip,
      lanes,
      readMtr: mtrEl,
      tap,
      sig: { lmtr: 1 },
    });
    return strip;
  }

  private render(): void {
    // The rail inks are resolved from the computed root, so they are theme-dependent
    // and a render is the only thing that re-derives them. A theme switch does not
    // trigger one (see applyResolvedTheme in main.ts for why that is currently safe
    // and what would end it).
    this.railInk.clear();
    const model = this.hooks.getModel();
    if (this.tapModel !== model.id) {
      this.loadTaps();
      this.tapModel = model.id;
    }
    this.closeTapPop();
    this.closeSendPan();
    this.host.classList.toggle("midi-learn", this.hooks.midi?.learnActive() ?? false);
    // A render replaces every strip element, so the transient state those elements
    // carried goes with them: the live meters' ballistics and keyboard focus. During
    // Live sync this path runs on every device-side edit that needs a read-back (and on
    // its idle safety net), so dropping that state reads as the console blinking under
    // the operator's hands. Carry it across the rebuild — the old refs stay in hand
    // until the new ones are built. The strip rack's scroll offset carries itself: the
    // clear and the refill are one task, so the empty rack is never laid out and the
    // offset is never clipped. Saving and rewriting it around the rebuild instead reads
    // and writes scrollLeft against a dirty tree, which forces a synchronous layout of
    // the whole rack — ~25 ms per render on WKWebView against ~6 ms without, on the path
    // Live sync takes for every device read-back reflect.
    const prev = this.refs;
    const restoreFocus = this.captureFocus();
    this.ifxCensus = insertFxCensus(model, this.hooks.getPlan());
    this.refs = new Map();
    const { groups, master } = this.stripModels();
    this.stripsHost.replaceChildren();
    for (const g of groups) {
      const group = el("div", "con-group");
      const lbl = el("div", "con-grouplabel");
      lbl.textContent = g.label;
      group.append(lbl, ...g.ids.map((id) => this.buildStrip(this.toStripModel(id))));
      this.stripsHost.append(group);
    }
    if (master) {
      const group = el("div", "con-group master");
      const lbl = el("div", "con-grouplabel");
      lbl.textContent = t().console.master;
      group.append(lbl, this.buildStrip(this.toStripModel(master)));
      this.stripsHost.append(group);
    }
    // Lock every head (name / chips / knobs) to the tallest strip, so the head area
    // is uniform across all channels; the fader/meter zone (flex: 1) takes the rest
    // of the window height (the SENDS rack between them has its own fixed height).
    this.host.style.setProperty("--head-h", this.mainHeadHeight() + "px");
    for (const [id, r] of this.refs) this.carryMeterState(prev.get(id), r);
    restoreFocus();
    this.startMeters(); // rescope the meter subscription to the rebuilt strips
    this.redrawMeters();
  }

  // Carry a strip's live meter ballistics over from the elements it is replacing, so
  // a rebuild doesn't drop the bars to the floor and re-attack. Only when the strip
  // still meters the same tap — the tap objects are the table's own singletons, so
  // identity means the same addresses and the same lane count. The last-written
  // trackers (lv/lpk/lov/lmtr) stay at their fresh sentinels: the new elements are
  // undrawn, so the next paint must write them, not skip them as unchanged.
  private carryMeterState(from: StripRef | undefined, to: StripRef | undefined): void {
    if (!from || !to || from.tap !== to.tap) return;
    to.lanes.forEach((ln, i) => {
      const o = from.lanes[i];
      if (!o) return;
      ln.v = o.v;
      ln.pk = o.pk;
      ln.over = o.over;
    });
  }

  // Where keyboard focus sits inside the strips, as (strip id, index among that
  // strip's focusable elements, class). A rebuild derives the same strips from the
  // same plan, so the index addresses the same control; the class is the check that
  // it really did — when the rebuild changed a strip's shape (a chip appeared, the
  // strip is gone), focus is dropped rather than handed to some other control. The
  // scroll offset is deliberately left out: the rack's is not restored (see
  // preserveFocus), only focus is.
  private captureFocus(): () => void {
    return preserveFocus(
      this.stripsHost,
      (active) => {
        for (const [id, r] of this.refs) {
          if (!r.root.contains(active)) continue;
          const idx = focusables(r.root).indexOf(active);
          return idx < 0 ? null : { id, idx, cls: active.className };
        }
        return null;
      },
      (mark) => {
        const root = this.refs.get(mark.id)?.root;
        const target = root ? focusables(root)[mark.idx] : undefined;
        return target?.className === mark.cls ? target : null;
      },
    );
  }

  // Draw the meters onto freshly built elements in the same task as the rebuild. They
  // start undrawn — bars at the floor, readout "—" — and the paint loop would not
  // write the numeric readout until its next throttled frame (~1/6 s), so the reset
  // state would be on screen until then. A device-side sweep rebuilds the strip faster
  // than that (the follow reflect runs at up to 20 Hz), which is exactly the readout
  // flickering between "—" and the value. A strip whose tap has not streamed yet is
  // skipped and keeps its "—". `only` narrows the pass to the one strip a single-strip
  // rebuild replaced.
  private redrawMeters(only?: string): void {
    if (!this.live || !this.visible) return;
    const strips = only === undefined ? this.refs.values() : [this.refs.get(only)];
    for (const r of strips) if (r) this.paintStrip(r, true, false);
  }

  // The tallest head (a mono channel carries the most chips + two knobs) sets the
  // fixed head height for every strip. Measure it by laying out the strips off-screen
  // with auto-height heads, then cache by everything that changes what a head CONTAINS.
  //
  // Model + hidden set alone was not that. The chips a head carries also depend on each
  // channel's COMP/EQ type — an SSMCS channel had no GATE/COMP/EQ openers, so a plan
  // seeded in SSMCS measured a shorter head, and switching it back to COMP->EQ added a
  // chip row the cached height had no space for: the head then stayed clipped until
  // something rebuilt the view under a different key (a model switch, a hide/show, a
  // reload). The two banks now carry the same NUMBER of chips — the morphing strip's own
  // master and its one opener stand where COMP's and EQ's two openers stand — so the term
  // sits where the sample rate's does: kept for what a head carries rather than for a
  // height seen to move, since what balances it is a coincidence of counts rather than a
  // rule.
  //
  // The sample rate is in the key too, and it earns its place differently. Measured
  // 2026-08-14 over URX44V / URX44 / URX22 at 48 / 96 / 176.4 / 192 kHz, on each one's
  // default plan (17 / 17 / 15 heads), the rate moved no head in that set — chip count,
  // grid row count and element count come back identical at every rate. It does change
  // what a stereo channel's head CARRIES: above 96 kHz the EQ opener goes and the chip
  // beside it turns read-only. What absorbs that is the parity spacer, appended so a
  // group's last chip never stretches to full width — it takes the freed slot, and a
  // two-column group of 7-plus-spacer is the same number of rows as one of 8. So the term
  // is here for the shape of that compensation rather than for a height seen to move: it
  // costs one re-measure per rate change, and either rule changing without it is the
  // clipped head above, in silence.
  private mainHeadHeight(): number {
    const plan = this.hooks.getPlan();
    const types = this.hooks
      .getModel()
      .nodes.map((n) => plan.nodeParams[n.id]?.compEqType)
      .join(",");
    const key = [this.hooks.getModel().id, [...plan.hidden].sort().join(","), plan.sampleRate, types].join("|");
    if (this.headH.key === key) return this.headH.px;
    const savedRefs = this.refs;
    this.refs = new Map(); // buildStrip registers refs/listeners; keep them off the live map
    const probe = el("div", "con-strips");
    probe.style.cssText = "position:absolute;visibility:hidden;height:auto;";
    const { groups, master } = this.stripModels();
    for (const g of groups) for (const id of g.ids) probe.append(this.buildStrip(this.toStripModel(id)));
    if (master) probe.append(this.buildStrip(this.toStripModel(master)));
    this.host.append(probe);
    // Free every head from the inherited --head-h clamp first, then read them all,
    // so the heights collapse to content in one reflow instead of one write→read
    // thrash per head.
    const heads = [...probe.querySelectorAll<HTMLElement>(".con-head")];
    for (const h of heads) h.style.height = "auto";
    let max = 0;
    for (const h of heads) max = Math.max(max, h.offsetHeight);
    probe.remove();
    this.refs = savedRefs;
    this.headH = { key, px: max };
    return max;
  }

  private buildStrip(m: StripModel): HTMLElement {
    if (m.meterOnly) return this.buildMeterOnlyStrip(m);
    const model = this.hooks.getModel();
    const level = this.getMain(m);

    // A node whose master is off (CH_ON / MIX 675 / STEREO 582 / MONITOR 723, all on
    // np.on) is silenced whole — dim the strip like the graph does (shared predicate),
    // with the scribble power LED, not a badge, marking why. The MUTE chip below is a
    // separate control: the → STEREO send's ON/OFF, unaffected by the master.
    const strip = el("div", "con-strip" + (m.inactive ? " inactive" : ""));
    strip.style.setProperty("--rail", m.rail);

    // head: scribble (with the power LED) + chips + gain (always the MAIN control set —
    // sends live in the SENDS rack below, so the head no longer swaps per send target).
    const head = el("div", "con-head");
    head.append(this.scribble(m));

    const cc = channelControl(model, m.id);

    // Toggle chips in two 2-column groups: channel + input (HA) toggles, then the
    // processing chain GATE → COMP → EQ → INS FX. Each chip flips a plan flag (the
    // device mirrors it via the shared change funnel). An odd group gets an unused
    // spacer chip so the last real chip never stretches to full width.
    type BoolKey =
      | "gateOn"
      | "compOn"
      | "eqOn"
      | "phantom"
      | "phase"
      | "phaseL"
      | "phaseR"
      | "hpf"
      | "hiZ"
      | "cueInterrupt"
      | "mono";
    const planOf = (): NodeParams => this.hooks.getPlan().nodeParams[m.id] ?? {};
    const boolChip = (parent: HTMLElement, label: string, key: BoolKey, def: boolean, title?: string): void => {
      this.makeChip(
        m.id,
        parent,
        label,
        false,
        planOf()[key] ?? def,
        () => {
          const next = !(planOf()[key] ?? def);
          this.nodeParamsOf(m.id)[key] = next;
          return next;
        },
        { midiId: controlId(m.id, key), title, keys: [key] },
      );
    };

    // channel + input (HA) group
    const top = el("div", "con-chips");
    if (m.hasMute) {
      // The MUTE drives the fixed → STEREO send's ON/OFF (never its wire): a CH / FX →
      // STEREO assign (ships ON), or a MIX → STEREO "TO ST" (ships off). The node
      // master lives on the scribble power LED, a separate control.
      const mix = this.isMixBus(m.id);
      const conn = (): PlanConnection | undefined => sendConnection(this.hooks.getPlan(), m.id, MAIN_BUS);
      const sendOn = (): boolean => conn()?.params?.on ?? !mix; // assign ships ON, TO ST off
      this.makeChip(
        m.id,
        top,
        t().console.mute,
        true,
        !sendOn(),
        () => {
          const c = conn();
          const nextOn = !sendOn();
          if (c) c.params = { ...c.params, on: nextOn };
          return !nextOn; // chip "on" (highlighted) = muted
        },
        { midiId: controlId(m.id, "mute") },
      );
    }
    // HA input toggles (+48 / polarity / HPF / Hi-Z).
    if (cc?.hasMicStrip) boolChip(top, "+48", "phantom", false);
    // Polarity: one φ on a mono channel, independent φL / φR on a stereo one. Keep
    // the stereo pair on a single row by padding to an even count before them.
    if ((cc?.phases.length ?? 0) === 2 && top.childElementCount % 2 === 1) {
      top.append(el("div", "con-chip spacer"));
    }
    for (const ph of cc?.phases ?? []) {
      boolChip(top, ph.key === "phase" ? "φ" : ph.key === "phaseL" ? "φL" : "φR", ph.key, false);
    }
    if (cc?.hasHpf) boolChip(top, "HPF", "hpf", false);
    if (cc?.hasHiZ) boolChip(top, "Hi-Z", "hiZ", false);
    // MONITOR strips carry the device [CUE] (cue interrupt) and [MONO] buttons.
    // Both are confirmed device params (MONITOR_CUE_INTERRUPT / MONITOR_MONO), so
    // they sync live like the channel toggles. CUE Interrupt ships ON, MONO OFF.
    if (m.hasPhones) {
      boolChip(top, t().console.cue, "cueInterrupt", true, t().console.cueFull);
      boolChip(top, t().console.mono, "mono", false);
    }

    // processing group (GATE / COMP / EQ / INS FX / DUCKER)
    const proc = el("div", "con-chips");
    if (m.isMono) {
      // GATE keeps its chip (the ON toggle) and gains a narrow neighbour that
      // opens the tuning screen. A separate chip rather than a gesture on the
      // existing one: `wireActivate` binds click and Space/Enter with no `detail`
      // guard, so a double-click would toggle the gate twice and write twice, and
      // double-click is already the factory-value reset for the faders and knobs
      // here. It costs a slot in the two-per-row grid, so the processing chips
      // take a third row.
      boolChip(proc, "GATE", "gateOn", false);
      proc.append(this.dynOpenChip("gate", m.id));
      // Which COMP/EQ bank the channel runs decides which screen the COMP and EQ chips
      // open, and whether the SSMCS chip is there at all. Asked of channelDynamics
      // rather than re-derived here, so an opener cannot appear for a screen that
      // would refuse to open.
      const plan = this.hooks.getPlan();
      const dyn = channelDynamics(this.hooks.getModel(), m.id, plan.nodeParams[m.id]?.compEqType ?? COMP_EQ_COMP_FIRST);
      // The morphing bank's two on/offs live one level down in the plan, which boolChip's
      // flat writer cannot reach. One writer for both, so they cannot disagree about the
      // shape they patch or about how the edit reaches the undo differ.
      const ssmcsChip = (
        label: string,
        read: () => boolean,
        set: (cur: SsmcsParams, next: boolean) => SsmcsParams,
        // The field `set` writes, one level inside the bank. Named rather than derived:
        // `set` rebuilds the whole object, and naming the bank would claim every sibling
        // it copied — taking the device's answer for all of them.
        field: string,
        opts: { midiId?: string; title?: string },
      ): void => {
        this.makeChip(
          m.id,
          proc,
          label,
          false,
          read(),
          () => {
            const next = !read();
            const np = this.nodeParamsOf(m.id);
            np.ssmcs = set(np.ssmcs ?? {}, next);
            return next;
          },
          { ...opts, keys: [`ssmcs.${field}`] },
        );
      };
      // The morphing strip's own master, between GATE and COMP as the inspector orders
      // them and as the unit chains them.
      if (dyn && !dyn.comp) {
        ssmcsChip(
          "SSMCS",
          () => planOf().ssmcs?.on ?? SSMCS_INITIAL.on,
          (cur, next) => ({ ...cur, on: next }),
          "on",
          { midiId: controlId(m.id, "ssmcsOn") },
        );
        proc.append(this.dynOpenChip("ssmcs", m.id));
      }
      boolChip(proc, "COMP", "compOn", false);
      // The shipped COMP screen only. A morphing strip's COMP face is reached from the
      // SSMCS opener above and the face segment inside the screen, so the bank carries one
      // opener rather than one per face — and the COMP and EQ chips read here exactly as
      // they do on a channel with no strip at all.
      if (dyn?.comp) proc.append(this.dynOpenChip("comp", m.id));
      // The side-chain filter's own switch, between the two processors it sits between.
      // Every other on/off in this bank is reachable from the strip — SSMCS's master, the
      // compressor's, the EQ's — and this one was only inside the COMP screen. It writes
      // the same plan value and carries the same MIDI id as the row there, so the two are
      // one control in two places rather than two controls that agree.
      if (dyn && !dyn.comp) {
        ssmcsChip(
          "SC",
          () => planOf().ssmcs?.sc?.on ?? SSMCS_INITIAL.sc.on,
          (cur, next) => ({ ...cur, sc: { ...cur.sc, on: next } }),
          "sc",
          { midiId: controlId(m.id, "sideChain", SSMCS_SC_SCOPE), title: t().inspector.ssmcs.sideChain },
        );
      }
    }
    const rate = this.hooks.getPlan().sampleRate;
    if (m.hasEq) {
      // Stereo-channel EQ is inert at 176.4 / 192 kHz: show the chip forced off and
      // read-only (matches the inspector's locked EQ toggle), else a live toggle.
      if (channelEqUnavailable(m.id, rate))
        this.makeChip(m.id, proc, t().console.eq, false, false, () => false, {
          readonlyTitle: t().inspector.eqRateLocked,
        });
      else {
        boolChip(proc, t().console.eq, "eqOn", true);
        // The tuning screen's opener, as GATE and COMP have. Not offered where the
        // rate has the EQ forced off (the toggle beside it is read-only there), nor in
        // SSMCS mode, where the EQ chip toggles the morphing strip's band section and the
        // face segment inside the SSMCS screen is what reaches its EQ face.
        const eqType = this.hooks.getPlan().nodeParams[m.id]?.compEqType ?? COMP_EQ_COMP_FIRST;
        if (hasEq(model, m.id, eqType)) proc.append(this.dynOpenChip("eq", m.id));
      }
    }
    if (insertFxControl(model, m.id)) {
      // The chip has two duties, and its lock composes them off the one menu
      // core/constraints.ts computes — the menu the inspector's selector renders,
      // so the chip cannot hand a strip what that selector greys out. Holding an
      // effect makes it a bypass, locked where the rate rules THAT effect out: forced
      // off and read-only, the treatment the stereo EQ gets. Holding none makes it take
      // a slot, locked when nothing is free — the tooltip naming which of the two
      // reasons applies, which is why the rate question is asked of a strip holding
      // nothing too: above every ceiling it is the rate and not the slots.
      const menu = insertFxMenu(model, this.hooks.getPlan(), m.id, this.ifxCensus ?? undefined);
      const free = insertFxFree(menu);
      const holds = insertFxSelected(planOf());
      // The lock the HELD effect carries, not the menu's: Pitch Fix stops at 48 kHz where
      // the amps and companders reach 96, so a strip holding it at 88.2 kHz is off while
      // the menu it came from still offers effects that run.
      const { locked: rateLocked, entry: selected } = insertFxRateLock(menu, planOf().insertFx);
      const locked = holds ? rateLocked : !free.length;
      if (locked)
        this.makeChip(m.id, proc, "INS FX", false, false, () => false, {
          readonlyTitle: !rateLocked
            ? t().inspector.insFxSlotLocked
            : selected?.option.maxRate !== undefined
              ? t().inspector.insFxRateLockedAt(selected.option.label, formatRate(selected.option.maxRate))
              : t().inspector.insFxRateLocked,
        });
      // Taking a slot removes it from every other strip's chip and menu, so that
      // branch rebuilds the whole view; a bypass changes this strip alone and keeps
      // the in-place chip update.
      else
        this.makeChip(m.id, proc, "INS FX", false, insertFxEngaged(planOf()), () => this.toggleInsFx(m.id, free), {
          rerender: !holds,
          // Both, because taking a slot writes the bypass ON over a bypass a No Effect
          // route can already be holding — the plan reads the same before and after,
          // and a read in flight then landed the new effect BYPASSED.
          keys: ["insertFx", "insertFxOn"],
        });
    }
    // DUCKER: the sidechain ducker hung under a stereo channel (its own node).
    // A shelved ducker drops its chip even while the parent strip stays.
    const hidden = this.hooks.getPlan().hidden;
    const duckerId = model.nodes.find((n) => n.kind === "ducker" && n.attachTo === m.id && !hidden.includes(n.id))?.id;
    if (duckerId) {
      const duckOn = (): boolean => this.hooks.getPlan().nodeParams[duckerId]?.duckerOn === true;
      this.makeChip(
        duckerId,
        proc,
        "DUCKER",
        false,
        duckOn(),
        () => {
          const next = !duckOn();
          this.nodeParamsOf(duckerId).duckerOn = next;
          return next;
        },
        { midiId: controlId(duckerId, "duckerOn"), keys: ["duckerOn"] },
      );
      // The tuning screen's opener, as GATE / COMP / EQ have. It carries the DUCKER
      // NODE's id, not the strip's: the chip lives here because a hung node has no
      // strip of its own, but the screen opens on the ducker.
      proc.append(this.dynOpenChip("ducker", duckerId));
    }

    for (const group of [top, proc]) {
      if (group.childElementCount % 2 === 1) group.append(el("div", "con-chip spacer"));
      if (group.childElementCount) head.append(group);
    }

    // A.GAIN / D.GAIN is the channel head-amp / digital gain.
    if (m.isChannel) {
      const min = cc?.gain?.minDb ?? (m.isMono ? -8 : -24);
      const max = cc?.gain?.maxDb ?? (m.isMono ? 70 : 24);
      const factory = this.factoryPlan().nodeParams[m.id]?.gain ?? (m.isMono ? -8 : 0);
      // Horizontal-marking values: A.Gain +8/+55, D.Gain -14/+15.
      const [hl, hr] = m.isMono ? [8, 55] : [-14, 15];
      this.addKnob(
        head,
        m.isMono ? "A.GAIN" : "D.GAIN",
        {
          get: () => this.hooks.getPlan().nodeParams[m.id]?.gain ?? factory,
          set: (v) => void (this.nodeParamsOf(m.id).gain = v),
          keys: ["gain"],
          min,
          max,
          step: 1,
          format: (v) => (v > 0 ? "+" : "") + v,
          reset: factory,
          angle: (v) => -90 + ((v - hl) / (hr - hl)) * 180,
        },
        m.id,
        controlId(m.id, "gain"),
      );
    }
    // PAN (mono) / BALANCE (stereo) = the source's → STEREO main-path pan,
    // L63 – C – R63. Per-send pan lives in the SENDS rack's SEND PAN popover.
    if (m.isChannel || this.isFxChannel(m.id)) {
      this.addSendPanKnob(head, m.id, MAIN_BUS, m.isBalance ? "BAL" : "PAN");
    }
    // Master balance (STEREO 583 / MIX 676) = the bus output's L/R balance, edited
    // on the node's own `pan`. `busBalance` is the single source of truth for which
    // buses have one (shared with the inspector / translate / readback). The device
    // keeps the BALANCE label even under Pan Link (confirmed on URX44V), so it is
    // always "BAL".
    if (busBalance(m.id)) {
      this.addNodePanKnob(head, m.id, "BAL");
    }
    if (m.hasPhones) {
      // PHONES output level: a 0.0..10.0 scale (not dB) on the monitor bus,
      // independent of the monitor fader (PHONES 1 ↔ mon1, PHONES 2 ↔ mon2).
      const factory = this.factoryPlan().nodeParams[m.id]?.phonesLevel ?? PHONES_LEVEL_DEFAULT;
      this.addKnob(
        head,
        "PHONES",
        {
          get: () => this.hooks.getPlan().nodeParams[m.id]?.phonesLevel ?? PHONES_LEVEL_DEFAULT,
          set: (v) => void (this.nodeParamsOf(m.id).phonesLevel = v),
          keys: ["phonesLevel"],
          min: PHONES_LEVEL_MIN,
          max: PHONES_LEVEL_MAX,
          step: 0.1,
          format: (v) => v.toFixed(1),
          reset: factory,
          // 2.0 at the left horizontal, 8.0 at the right (the device's markings).
          angle: (v) => -90 + ((v - 2) / (8 - 2)) * 180,
        },
        m.id,
        controlId(m.id, "phonesLevel"),
      );
    }
    strip.append(head);

    // SENDS rack: per-strip columns for every MIX/FX send (enable chip + PRE button +
    // vertical mini-fader), a header (label / value readout / global collapse), and a
    // SEND PAN popover trigger. Built between the head and the fader zone, at a fixed
    // height so the fader tops stay aligned across every strip (blank on sendless ones).
    const rack = this.buildSendRack(m);

    // fader zone: a meter-point header row, then the fader (thin slot + cap;
    // position = setting) beside the dB scale and the live level meter.
    const zone = el("div", "con-faderzone");
    const tapKey = this.tapKeyOf(m.id);
    const tapHead = el("div", "con-taphead");
    if (tapsFor(m.id, this.hooks.getModel().id).length > 1) tapHead.append(this.buildTapBadge(m.id));
    zone.append(tapHead);
    const zrow = el("div", "con-zrow");

    const fader = el("div", "con-fader");
    fader.setAttribute("role", "slider");
    fader.setAttribute("aria-label", m.label);
    fader.tabIndex = 0;
    const track = el("div", "track");
    // The 0 dB line rides the fader (not the inset track) so it shares the cap's
    // coordinate space and passes through the cap centre when the fader sits at 0 dB.
    const zero = el("div", "zero");
    zero.style.setProperty("--zero", (1 - dbToFrac(0, m.range)) * 100 + "%");
    const cap = el("div", "cap");
    fader.append(track, zero, cap);

    // Meter column: the ladder shares the fader ruler, topping out at the 0 dB mark
    // with the OVER clip window above it. Stereo taps split into independent L/R bars.
    const tap = tapFor(m.id, tapKey, this.hooks.getModel().id) ?? null;
    const { meter, lanes } = this.buildMeterColumn(m.range, isStereoTap(tap));

    zrow.append(fader, this.buildScale(m.range), meter);
    zone.append(zrow);
    strip.append(rack.el, zone);

    // readout: fader set-level dB (white, FADER) and, for metered strips, the live
    // meter value of the selected tap (amber, METER). The captions and colour tell
    // the static set level from the live meter apart.
    const readout = el("div", "con-readout");
    const faderCell = el("div", "rd");
    const dbEl = el("div", "rv");
    faderCell.append(readCap(t().console.readFader), dbEl);
    readout.append(faderCell);
    // Only metered strips build the meter readout cell; a fader-only strip keeps a
    // bare detached value element as its readMtr (never appended, never updated).
    let mtrEl: HTMLElement;
    if (hasMeter(m.id, this.hooks.getModel().id)) {
      const rc = meterReadCell();
      readout.append(rc.cell);
      mtrEl = rc.value;
    } else {
      mtrEl = el("div", "rv");
    }
    strip.append(readout);

    const refObj: StripRef = {
      m,
      root: strip,
      lanes,
      cap,
      fader,
      readDb: dbEl,
      readMtr: mtrEl,
      tap,
      sig: { lmtr: 1 },
      sendCols: rack.cols,
    };
    this.refs.set(m.id, refObj);
    // Paint the cap position, readout and aria-valuenow through the same helper
    // the edit path uses (as buildSendCol does via updateColLevel), so build and
    // edit cannot drift apart.
    this.updateStripLevel(refObj, level);
    this.wireFader(refObj);
    return strip;
  }

  private wireFader(r: StripRef): void {
    const fader = r.fader;
    if (!fader) return; // meter-only strips have no fader to wire
    const range = r.m.range;
    const midiId = controlId(r.m.id, "level");
    this.midiMark(fader, midiId);
    const setLevel = (db: number): void => {
      const written = this.setMain(r.m, db);
      this.updateStripLevel(r, db);
      this.commit(r.m.id, written);
      this.mirrorPartnerLevel(r.m.id); // a BAL-linked partner tracks the fader live
    };
    fader.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (this.midiArm(midiId)) return;
      const rect = fader.getBoundingClientRect();
      // The cap centre travels the element's whole height (`--pos` is a percentage of
      // it, under a -50% translate), so that is the scale a pointer maps through — not
      // the groove's 6 px inset, which used to be subtracted here and made the mapping
      // agree with the cap at mid-travel only, drifting to 1.3 detents by either end
      // (measured at the default window; 2.7 at the minimum one).
      const travel = rect.height;
      // A press that lands on the cap grabs it where it is and writes nothing: the cap
      // is 14 px on a travel worth a few pixels per detent, so jumping to the pointer
      // moved the level by up to 1.7 detents (3.6 at the minimum window) before the
      // operator had moved at all. A press on the bare track still jumps the cap under
      // the pointer, which is what an <input type="range"> does away from its thumb.
      // Either way the rest of the gesture is relative, so the cap tracks the pointer
      // 1:1 from wherever it started.
      const capBox = r.cap?.getBoundingClientRect();
      const onCap = !!capBox && e.clientY >= capBox.top && e.clientY <= capBox.bottom;
      const startFrac = onCap ? dbToFrac(this.getMain(r.m), range) : 1 - (e.clientY - rect.top) / travel;
      const startY = e.clientY;
      trackDrag(fader, e, (ev) => setLevel(fracToDb(startFrac + (startY - ev.clientY) / travel, range)), {
        seed: !onCap,
      });
    });
    fader.addEventListener("keydown", (e) => {
      if (this.midiLearnKey(e, midiId)) return;
      const next = this.faderKeyStep(e, range, this.getMain(r.m));
      if (next === null) return;
      e.preventDefault();
      setLevel(next);
    });
    // Double-click resets the fader to its factory value.
    fader.addEventListener("dblclick", () => {
      if (this.hooks.midi?.learnActive()) return; // pointerdown already armed
      setLevel(this.mainLevelOf(this.factoryPlan(), r.m));
    });
    // Hover + wheel steps one detent (mirrors the Arrow keys); skipped while
    // assigning MIDI so a stray scroll doesn't edit an armed control.
    onWheelStep(
      fader,
      (dir) => setLevel(this.faderWheelStep(range, this.getMain(r.m), dir)),
      () => this.hooks.midi?.learnActive(),
    );
  }

  private updateStripLevel(r: StripRef, db: number): void {
    if (!r.cap || !r.readDb || !r.fader) return; // meter-only strip has no fader
    const frac = dbToFrac(db, r.m.range);
    r.cap.style.setProperty("--pos", (1 - frac) * 100 + "%");
    const f = fmtDb(db, r.m.range);
    setLevelText(r.readDb, f.text);
    r.readDb.classList.toggle("off", f.off);
    r.fader.setAttribute("aria-valuenow", String(Math.round(db)));
  }

  // ---- meters ----

  // Subscribe to the meters of the strips currently on screen. Safe to call on
  // every render: it self-guards on live/visible and only re-subscribes when the
  // displayed address set actually changes (e.g. a model switch), so mode/lang
  // re-renders don't churn the broker registration.
  // The awaited half of startMeters. Its failure has to be loud: bars stuck on
  // the floor look exactly like silence, and an operator reading them chases gain
  // that was never the problem — so it goes to the same handler a live error takes.
  private async resubscribeMeters(addrs: Array<[number, number]>, sig: string): Promise<void> {
    this.subPending = true;
    let unsub: () => void;
    try {
      unsub = await subscribeMeters(this.store, addrs);
    } catch (e) {
      this.subSig = "";
      this.hooks.onMeterError?.(e instanceof Error ? e.message : String(e));
      return;
    } finally {
      this.subPending = false;
    }
    // A stop/re-scope raced the registration; drop this one rather than leaving a
    // stream nothing will unsubscribe.
    if (this.subSig !== sig || !this.live || !this.visible) unsub();
    else this.unsub = unsub;
  }

  private startMeters(): void {
    if (!this.live || !this.visible || this.metersLent) return;
    const taps: MeterTap[] = [];
    for (const r of this.refs.values()) if (r.tap) taps.push(r.tap);
    const addrs = tapAddrs(taps);
    const sig = addrs.map((a) => a.join(":")).join(",");
    // subPending closes the window the await opens: without it a render landing
    // mid-registration sees no unsub, and re-registers the same address set —
    // which on the device is unregister-then-register for every address, the
    // ~1 s stall hide() already documents.
    //
    // It closes that window by DISCARDING the re-scope rather than queuing it, and
    // that is a known defect rather than a subtlety: pick tap A, then pick tap B
    // inside A's registration (up to ~1 s), and this returns without recording that
    // B is what is wanted. A resolves, `resubscribeMeters` keeps it because the
    // signature still matches, and the console then shows B while the broker streams
    // A — B's lane at the floor and its readout at "—" until some unrelated edit
    // forces a render. Bars stuck at the floor are the reading `onMeterError` exists
    // to prevent, and nothing fires here. It is pinned as-is by the race harness
    // (`meter-rescope-inside-subpending-ladder`, docs/{en,ja}/live-race-harness.md),
    // whose expectation is the defect, so a fix has to rewrite that case as a set.
    // What closes it is one line — re-invoking `startMeters()` at the end of
    // `resubscribeMeters`, which self-guards and no-ops when the kept signature
    // already matches. Left out of the 2026-08-13 audit's fixes deliberately, as the
    // one finding of the 51 triaged out; nothing has decided against it since.
    if (!this.subPending && (!this.unsub || sig !== this.subSig)) {
      this.unsub?.();
      this.unsub = null;
      this.subSig = sig;
      void this.resubscribeMeters(addrs, sig);
    }
    if (!this.raf) {
      // Cap repaints to ~30 fps for smooth ballistics (the device streams at ~10 Hz;
      // the extra frames interpolate the attack/release). Per-frame cost is kept low
      // by driving the bars with compositor-only transforms (scaleY / translateY, no
      // layout/paint) and throttling the numeric readout to a fraction of the rate.
      const FRAME_MS = 1000 / 30;
      let last = 0;
      const tick = (now: number): void => {
        if (now - last >= FRAME_MS) {
          last = now;
          this.paintMeters();
        }
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }
  }

  // Stop the paint loop without touching the broker subscription. Used when hiding
  // the view across a graph/console toggle so the warm stream survives (see hide()).
  private stopPaint(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private stopMeters(): void {
    this.stopPaint();
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
    this.subSig = "";
    this.store.clear();
    this.resetMeters();
  }

  // Drop every signal meter to its floor so disconnecting doesn't leave the bars
  // frozen at their last live reading.
  private resetMeters(): void {
    for (const r of this.refs.values()) {
      const s = r.sig;
      for (const ln of r.lanes) {
        ln.v = ln.pk = ln.over = 0;
        if (ln.lv !== 0) {
          ln.shade.style.setProperty("--lvl", "0");
          ln.lv = 0;
        }
        if (ln.lpk !== 0) {
          ln.peak.style.setProperty("--pk", "0");
          ln.lpk = 0;
        }
        if (ln.lov !== 0) {
          ln.clip.style.setProperty("--clip", "0");
          ln.lov = 0;
        }
        if (ln.live) {
          ln.col.classList.remove("live"); // release the compositor layers on teardown
          ln.live = false;
        }
      }
      if (s.lmtr !== 1) {
        r.readMtr.textContent = "—";
        r.readMtr.classList.remove("off");
        s.lmtr = 1;
      }
    }
  }

  private paintMeters(): void {
    // Refresh the numeric readout on only every READOUT_EVERY-th frame: its text
    // change relayouts/repaints the cell, so doing it every frame on every strip is
    // a needless per-frame cost the animated bars don't share.
    const showReadout = this.paintN++ % READOUT_EVERY === 0;
    for (const r of this.refs.values()) this.paintStrip(r, showReadout, true);
  }

  // One strip's meter. `step` advances the ballistics (the animation loop); a redraw
  // onto freshly built elements passes false, so a rebuild writes the state the meter
  // already holds instead of aging it — the animation keeps its own clock.
  private paintStrip(r: StripRef, showReadout: boolean, step: boolean): void {
    if (!r.tap) return;
    const reading = this.store.readingTap(r.tap);
    if (!reading) return;
    const s = r.sig;
    // Numeric meter readout (selected tap, peak of L/R), -∞ below the floor.
    const peakDb = Math.max(reading.l, reading.r);
    const mtr = peakDb <= METER_FLOOR_DB ? -999 : Math.round(peakDb * 10);
    if (showReadout && mtr !== s.lmtr) {
      setLevelText(r.readMtr, mtr === -999 ? "-∞" : (mtr / 10).toFixed(1));
      r.readMtr.classList.toggle("off", mtr === -999);
      s.lmtr = mtr;
    }
    // Drive each lane from its own channel — lane 0 = L, lane 1 = R. A mono strip has
    // only lane 0, and readingTap mirrors R onto L there, so lane 0 meters its true
    // level either way (no peak-fold; the peak-of-L/R fold is only for the readout).
    for (let i = 0; i < r.lanes.length; i++) {
      const ln = r.lanes[i];
      const chDb = i === 0 ? reading.l : reading.r;
      const chOver = i === 0 ? reading.overL : reading.overR;
      const target = meterFrac(chDb, r.m.range);
      if (step) {
        // Fast attack, slow release for a meter-like response; peak hold decays slowly.
        ln.v = target > ln.v ? target : ln.v + (target - ln.v) * 0.3;
        ln.pk = Math.max(ln.pk * 0.985, ln.v);
        // OVER clip cap: latch full on a clip in this channel, then fade so a brief
        // over lingers.
        ln.over = chOver ? 1 : ln.over * 0.95;
      }
      // Write only the values that actually changed (idle meters rest, so most
      // frames skip every write) — at integer-percent resolution.
      const v = Math.round(ln.v * 100);
      const pk = Math.round(ln.pk * 100);
      const over = ln.over > 0.02 ? Math.round(ln.over * 100) : 0;
      // --lvl / --pk are fractions (0..1) driving compositor-only transforms
      // (scaleY / translateY) on the shade and peak — no layout/paint per frame.
      if (v !== ln.lv) {
        ln.shade.style.setProperty("--lvl", v / 100 + "");
        ln.lv = v;
      }
      if (pk !== ln.lpk) {
        ln.peak.style.setProperty("--pk", pk / 100 + "");
        ln.lpk = pk;
      }
      if (over !== ln.lov) {
        ln.clip.style.setProperty("--clip", over / 100 + "");
        ln.lov = over;
      }
      // Promote the shade/peak to compositor layers (via `.live`) only while the lane
      // is actually animating; an idle lane (at the floor, no clip) drops its layers,
      // so a mostly-quiet console isn't compositing a layer per silent meter.
      const active = v > 0 || pk > 0 || over > 0;
      if (active !== ln.live) {
        ln.col.classList.toggle("live", active);
        ln.live = active;
      }
    }
  }

  // ---- level get/set on the plan ----

  private isFxChannel(id: string): boolean {
    return id === "bus.fx1" || id === "bus.fx2";
  }
  private isMixBus(id: string): boolean {
    return id === "bus.mix1" || id === "bus.mix2";
  }

  /** Whether a strip has a send connection to a target bus (a rack column exists).
   *  A strip never sends to itself, so `id === target` is excluded here once. */
  private hasSend(id: string, target: SendTarget): boolean {
    return id !== target && sendConnection(this.hooks.getPlan(), id, target) !== undefined;
  }

  /** Shared PAN/BALANCE knob spec (±63, C / Ln / Rn display); get/set/reset bind
   *  the source — a connection's send pan or a node's master balance. */
  private panKnobSpec(
    get: () => number,
    set: (v: number) => void,
    reset: number,
    readonlyTitle?: string,
    keys?: readonly string[],
  ): KnobSpec {
    return {
      get,
      set,
      min: PAN_MIN,
      max: PAN_MAX,
      step: 1,
      format: (v) => (v === 0 ? "C" : v < 0 ? "L" + -v : "R" + v),
      reset,
      readonlyTitle,
      keys,
    };
  }

  /** Add a PAN/BALANCE knob bound to a send connection's `pan` (L63 – C – R63),
   *  resetting to the factory plan's value on double-click. */
  private addSendPanKnob(head: HTMLElement, id: string, target: string, label: string, readonlyTitle?: string): void {
    const conn = (): PlanConnection | undefined => sendConnection(this.hooks.getPlan(), id, target);
    const factory = sendConnection(this.factoryPlan(), id, target)?.params?.pan ?? 0;
    this.addKnob(
      head,
      label,
      this.panKnobSpec(
        () => conn()?.params?.pan ?? 0,
        (v) => {
          const c = conn();
          if (c) c.params = { ...c.params, pan: v };
        },
        factory,
        readonlyTitle,
      ),
      id,
      controlId(id, "pan", target === MAIN_BUS ? undefined : target),
    );
  }

  /** Add a BALANCE/PAN knob bound to a bus node's own master balance (`pan`,
   *  STEREO 583 / MIX 676), resetting to the factory plan's value on double-click. */
  private addNodePanKnob(head: HTMLElement, id: string, label: string): void {
    const factory = this.factoryPlan().nodeParams[id]?.pan ?? 0;
    this.addKnob(
      head,
      label,
      this.panKnobSpec(
        () => this.hooks.getPlan().nodeParams[id]?.pan ?? 0,
        (v) => void (this.nodeParamsOf(id).pan = v),
        factory,
        undefined,
        ["pan"],
      ),
      id,
      controlId(id, "pan"),
    );
  }

  private nodeParamsOf(id: string): NodeParams {
    const plan = this.hooks.getPlan();
    return (plan.nodeParams[id] ??= {});
  }

  /** Apply a console edit to `id`: mirror it onto the linked partner when the pair
   *  is in BAL mode — plus the insert FX, which the unit mirrors on Signal Type alone
   *  (PAN mode included) — then run the shared change funnel. Returns whether it
   *  mirrored (the caller rebuilds so the partner strip catches up). */
  private commit(id: string, written: readonly string[] = []): boolean {
    const model = this.hooks.getModel();
    const plan = this.hooks.getPlan();
    const mirrored = mirrorBalPair(model, plan, id);
    const insFxMirrored = mirrorLinkedInsertFx(model, plan, id);
    // Each mirror names only what IT wrote, the same rule the inspector's funnel
    // follows: the BAL mirror carries THIS edit's keys onto the partner, and the
    // insert-FX mirror the three-key pair state it copies whenever the pair is linked.
    // A key no mirror wrote stays the device's to answer for.
    const keys = written.map((k) => nodeParamContestPath(id, k));
    const partner = partnerChannel(model, id);
    if (partner) {
      if (mirrored) for (const k of written) keys.push(nodeParamContestPath(partner, k));
      if (insFxMirrored) for (const k of INSERT_FX_PAIR_KEYS) keys.push(nodeParamContestPath(partner, k));
    }
    this.hooks.onChange(keys);
    return mirrored || insFxMirrored;
  }

  /** Rebuild once after editing a BAL-linked strip so the mirrored partner strip
   *  catches up — a live drag/keypress updates only the dragged strip. Used by the
   *  chips / knobs, where the partner's whole head may change. */
  private syncPartnerStrip(id: string): void {
    if (isBalLinkedPair(this.hooks.getModel(), this.hooks.getPlan(), id)) this.render();
  }

  /** Push a BAL-linked strip's mirrored fader level onto the partner strip's level
   *  DOM in place, so a linked fader tracks live without a rebuild (keeps focus). */
  private mirrorPartnerLevel(id: string): void {
    if (!isBalLinkedPair(this.hooks.getModel(), this.hooks.getPlan(), id)) return;
    const partner = partnerChannel(this.hooks.getModel(), id);
    const pr = partner ? this.refs.get(partner) : undefined;
    if (!pr) return;
    this.updateStripLevel(pr, this.getMain(pr.m));
  }

  /** Mirror a BAL-linked strip's send-column fader onto the partner strip's matching
   *  column DOM in place, so a linked send fader tracks live without a rebuild. */
  private mirrorPartnerSend(id: string, target: SendTarget): void {
    if (!isBalLinkedPair(this.hooks.getModel(), this.hooks.getPlan(), id)) return;
    const partner = partnerChannel(this.hooks.getModel(), id);
    const pr = partner ? this.refs.get(partner) : undefined;
    const col = pr?.sendCols?.find((c) => c.target === target);
    if (!col) return;
    const pc = sendConnection(this.hooks.getPlan(), partner!, target);
    this.updateColLevel(col, pr!.m.range, pc?.params?.level ?? LEVEL_OFF_DB, pc?.params?.tap === "pre");
  }

  // The factory plan (cached): the source for double-click "reset to default".
  private factoryPlan(): Plan {
    const id = this.hooks.getModel().id;
    if (!this.factory || this.factory.id !== id) this.factory = { id, plan: defaultPlan(id) };
    return this.factory.plan;
  }

  private mainLevelOf(plan: Plan, m: StripModel): number {
    if (m.isOsc) return plan.nodeParams[m.id]?.osc?.level ?? -14;
    if (m.fadersOnly) return plan.nodeParams[m.id]?.level ?? 0;
    // channel / FX channel main path = the fixed send into STEREO
    return sendConnection(plan, m.id, MAIN_BUS)?.params?.level ?? 0;
  }

  private getMain(m: StripModel): number {
    return this.mainLevelOf(this.hooks.getPlan(), m);
  }

  /** Returns the node-parameter keys it wrote, for the change funnel's write witness.
   *  Empty where the main path is a wire's level rather than a node's own. */
  private setMain(m: StripModel, db: number): readonly string[] {
    const plan = this.hooks.getPlan();
    if (m.isOsc) {
      const np = this.nodeParamsOf(m.id);
      np.osc = { ...np.osc, level: db };
      return ["osc.level"];
    }
    if (m.fadersOnly) {
      this.nodeParamsOf(m.id).level = db;
      return ["level"];
    }
    const conn = sendConnection(plan, m.id, MAIN_BUS);
    if (conn) conn.params = { ...conn.params, level: db };
    return [];
  }

  // The factory send level (double-click reset); the live send level/pan/tap are read
  // off the column's captured connection object (see buildSendCol), not via a helper.
  private sendLevelOf(plan: Plan, id: string, target: SendTarget): number {
    return sendConnection(plan, id, target)?.params?.level ?? LEVEL_OFF_DB;
  }

  // The INS FX chip drives the device's insert ON/OFF (bypass) switch. With an
  // effect selected, toggling flips insertFxOn and keeps the selection (absent =
  // on, matching the device's auto-engage). With No Effect, toggling on restores
  // the last chosen effect (else the first real option) and engages it. Returns
  // the new on state. `options` is the non-empty free list off the shared menu (No
  // Effect dropped, and everything the rate or another node's 1-of slot rules out;
  // the caller locks the chip when nothing is left), so neither the first option nor
  // a remembered one can be an effect this node may not take.
  private toggleInsFx(id: string, options: InsertFxOption[]): boolean {
    const np = this.nodeParamsOf(id);
    if (insertFxSelected(np)) {
      this.lastInsFx.set(id, np.insertFx!);
      np.insertFxOn = np.insertFxOn === false;
      return np.insertFxOn;
    }
    const last = this.lastInsFx.get(id);
    np.insertFx = options.some((o) => o.value === last) ? last : options[0].value;
    np.insertFxOn = true;
    return true;
  }

  // Build a labelled rotary knob (label / value / knob) in the strip head and
  // wire it. Shared by the channel gain and the monitor PHONES level.
  // `midiId` makes the knob armable for MIDI learn.
  private addKnob(head: HTMLElement, label: string, k: KnobSpec, id: string, midiId?: string): void {
    const box = el("div", "con-gain");
    const info = el("div", "info");
    const lbl = el("span", "lbl");
    lbl.textContent = label;
    // Fine-eligible knob: printed FINE legend; placement + arming live in
    // style.css (.con-gain .fine-tag / .fine-mode).
    if (k.fine !== undefined) {
      box.classList.add("has-fine");
      box.append(fineTag());
    }
    const { knob, val } = this.buildKnob(k, label, id, "val", midiId);
    info.append(lbl, val);
    box.append(info, knob);
    head.append(box);
  }

  // The knob primitive: the con-knob element + its value span (readonly / aria /
  // tabindex plumbing), wired via wireKnob. addKnob wraps it in the head's con-gain
  // box; the SEND PAN popover wraps it in a pcol (with a "rv" value class). A
  // device-locked knob shows its value but takes no input (wireKnob skips handlers).
  private buildKnob(
    k: KnobSpec,
    ariaLabel: string,
    id: string,
    valCls: string,
    midiId?: string,
    partnerSync = true,
  ): { knob: HTMLElement; val: HTMLElement } {
    const knob = el("div", "con-knob" + (k.readonlyTitle ? " readonly" : ""));
    knob.setAttribute("role", "slider");
    knob.setAttribute("aria-label", ariaLabel);
    knob.append(el("i", "ind"));
    const val = el("span", valCls);
    if (k.readonlyTitle) {
      knob.setAttribute("aria-disabled", "true");
      knob.title = k.readonlyTitle;
    } else {
      knob.tabIndex = 0;
    }
    this.wireKnob(knob, val, k, id, midiId, partnerSync);
    return { knob, val };
  }

  // Rotary knob: vertical drag (≈ full range over 150px) and arrow keys edit the
  // value (snapped to `step`); the indicator rotates over a 270° sweep; a
  // double-click resets to `reset`. Reads/writes via the spec's get/set.
  // `partnerSync` (default on) re-renders after a BAL-linked edit so the partner
  // strip's head knob catches up; the SEND PAN popover knob turns it OFF, since a
  // render would tear the popover down and no partner send-pan control is on screen
  // (the plan mirror via `commit` is enough).
  private wireKnob(
    knob: HTMLElement,
    val: HTMLElement,
    k: KnobSpec,
    id: string,
    midiId?: string,
    partnerSync = true,
  ): void {
    const angle = k.angle ?? ((v: number): number => -135 + ((v - k.min) / (k.max - k.min)) * 270);
    // Step for an interaction: fine while Shift is held — the event's own modifier
    // state OR the global tracker (covers Shift pressed away from the control).
    const stepFor = (ev?: { shiftKey: boolean }): number =>
      k.fine !== undefined && (ev?.shiftKey === true || fineActive()) ? k.fine : k.step;
    const show = (v: number): void => {
      val.textContent = k.format(v);
      knob.style.setProperty("--rot", angle(v) + "deg");
      knob.setAttribute("aria-valuenow", String(v));
    };
    const apply = (raw: number, st = k.step): void => {
      const v = Math.max(k.min, Math.min(k.max, scrubFloat(Math.round(raw / st) * st)));
      k.set(v);
      show(v);
      this.commit(id, k.keys);
    };
    show(Math.max(k.min, Math.min(k.max, k.get()))); // initial display, not dirty
    if (k.readonlyTitle) return; // device-locked: value painted, no input handlers
    this.midiMark(knob, midiId);
    knob.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (this.midiArm(midiId)) return;
      // Absolute drag mapping, with both anchors rebased whenever the Shift state
      // flips, so entering or leaving fine mode mid-drag never jumps the value:
      // each segment maps at its own rate — coarse = full range over 150px, fine =
      // one fine step per pixel.
      let startY = e.clientY;
      let start = k.get();
      let wasSt = stepFor(e);
      trackDrag(
        knob,
        e,
        (ev) => {
          const st = stepFor(ev);
          if (st !== wasSt) {
            start = k.get();
            startY = ev.clientY;
            wasSt = st;
          }
          const rate = st === k.step ? (k.max - k.min) / 150 : st;
          apply(start + (startY - ev.clientY) * rate, st);
        },
        { onEnd: () => partnerSync && this.syncPartnerStrip(id) },
      );
    });
    knob.addEventListener("keydown", (e) => {
      if (this.midiLearnKey(e, midiId)) return;
      const st = stepFor(e);
      if (e.key === "ArrowUp" || e.key === "ArrowRight") apply(k.get() + st, st);
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft") apply(k.get() - st, st);
      else return;
      e.preventDefault();
      if (partnerSync) this.syncPartnerStrip(id);
    });
    knob.addEventListener("dblclick", () => {
      if (this.hooks.midi?.learnActive()) return; // pointerdown already armed
      apply(k.reset); // reset to factory value
      if (partnerSync) this.syncPartnerStrip(id);
    });
    // Hover + wheel nudges by one step (mirrors the Arrow keys). This sits below the
    // readonlyTitle early-return above, so device-locked knobs take no wheel input.
    onWheelStep(
      knob,
      (dir) => {
        const st = stepFor();
        apply(k.get() + dir * st, st);
        if (partnerSync) this.syncPartnerStrip(id);
      },
      () => this.hooks.midi?.learnActive(),
    );
  }
}

// APCA 0.98G-4g lightness contrast (Lc) between a text colour and a background,
// both #rrggbb as numbers. Unlike a WCAG ratio — which is two relative luminances
// divided — this carries polarity and the non-linearity of vision at the dark end,
// and that is exactly where the two disagree: on saturated mid-tones a ratio
// systematically picks the wrong ink. Measured across the device's ten CH SETTING
// colours plus the five node rails, the two verdicts differ on 12 of 21 grounds.
// Only the magnitude is used here, since which ink wins is the whole question.
function apcaLc(text: number, bg: number): number {
  const y = (n: number): number => {
    const ch = (c: number): number => Math.pow(c / 255, 2.4);
    return 0.2126729 * ch((n >> 16) & 255) + 0.7151522 * ch((n >> 8) & 255) + 0.072175 * ch(n & 255);
  };
  const soft = (v: number): number => (v > 0.022 ? v : v + Math.pow(0.022 - v, 1.414));
  const ty = soft(y(text));
  const by = soft(y(bg));
  if (Math.abs(by - ty) < 0.0005) return 0;
  // Normal polarity is dark text on a light ground; reverse polarity gets its own
  // exponents rather than a sign flip, which is the part a ratio cannot express.
  const raw =
    by > ty ? (Math.pow(by, 0.56) - Math.pow(ty, 0.57)) * 1.14 : (Math.pow(by, 0.65) - Math.pow(ty, 0.62)) * 1.14;
  const clamped = by > ty ? (raw < 0.1 ? 0 : raw - 0.027) : raw > -0.1 ? 0 : raw + 0.027;
  return Math.abs(clamped) * 100;
}

const INK_WHITE = { color: "#fff", shadow: "0 1px 1px rgba(0, 0, 0, 0.55)" };
const INK_DARK = { color: "#0e0c08", shadow: "0 1px 1px rgba(255, 255, 255, 0.5)" };

// Scribble label ink for a scribble ground: pick black or white by which reads
// better, and pair it with a faint opposite-tone halo so the small device name
// stays crisp even over a mid-tone colour neither ink clears cleanly. The halo is
// not decoration — four of the grounds this runs on reach Lc 60 with neither ink,
// and there the halo is the only thing holding the glyph edges.
function inkOn(hex: string): { color: string; shadow: string } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const bg = m ? parseInt(m[1], 16) : 0; // unparseable → black bg → white ink
  return apcaLc(0xffffff, bg) >= apcaLc(0x0e0c08, bg) ? INK_WHITE : INK_DARK;
}
