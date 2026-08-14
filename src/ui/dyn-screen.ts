// Channel tuning screen: one processor's parameters beside the meter taps that show
// what they are doing. GATE, COMP and the 4-band EQ are built on it today; DUCKER and
// the insert-FX dynamics fit the same shape (see docs/{en,ja}/channel-tuning.md).
//
// Nothing in this file knows which processor it is showing. A `DynProcessor` resolves
// what a node actually has — its slider fields and its meter lanes — reads and writes
// its own corner of the plan, and composes its display column out of the parts offered
// here (the lane rack, the plot). That division is why a processor with no
// gain-reduction meter, on a node whose taps are stereo, whose values live in an array
// and whose segmented bar selects a band rather than a display mode, needed no special
// case here. Everything a processor might vary is asked of the descriptor; what is
// left is the modal, the meter feed and the canvas lifecycle.
//
// The descriptor is selected per open() rather than per instance, because all of them
// share one modal host and two instances would fight over its DOM.
//
// What the meters can and cannot show (measured on a URX44V, 2026-07-29 — see
// reference/work/vd/vd-meters.md):
//   - the feed is exactly 100 ms and each frame is an instantaneous sample, not a
//     window extreme, so nothing is gained by painting faster;
//   - the level meters are peak detectors with a ~30 dB/s release, so they hold
//     transients themselves — adding an app-side release here would double it;
//   - the GR meters have no ballistics at all, so an action shorter than 100 ms is
//     missed outright. The peak hold below is the only thing that makes a caught
//     one readable, and it cannot recover one that was never sampled;
//   - a GR meter reports the reduction alone. Sweeping the COMP makeup gain moved
//     the downstream level tap by the full amount and left the GR meter still.
//
// The broker has a single meter subscription slot process-wide (a subscribe replaces
// the previous one and the unsubscribe takes no address), so this screen takes the slot
// for its lanes' addresses while open and hands it back on close.

import { el, holdAppInert, settingsRow, settingsSection, sliderRow, wheelStep, wireDismiss } from "./dom";
import type { SettingsRowOptions } from "./dom";
import { fineTag, optInFine } from "./fine";
import { armOnActivate, markMidi } from "./midi-learn";
import type { MidiLearnHooks } from "./midi-learn";
import { setLevelText } from "./glyph";
import { t } from "../i18n";
import type { Messages } from "../i18n/en";
import { decodeGrDb, METER_GREEN_TOP_DB, METER_YELLOW_TOP_DB, MeterStore, subscribeMeters } from "../core/meters";
import type { MeterTap } from "../core/meters";
import { dynFromPos, dynToPos, dynValueText, formatDyn } from "../core/control/translate";
import type { DynField } from "../core/control/translate";
import type { DeviceModel } from "../models/types";
import type { NodeParams, Plan } from "../core/plan";
import { loadJson, saveJson } from "../core/storage";
import { migrateSel } from "./dyn-chan";

/** Top of every meter ruler: a channel meter cannot read above 0 dBFS. */
export const HI_DB = 0;

/** Plot coordinates. The domain of `px` is the plot's own — dBFS for the transfer
 *  curves, Hz for the EQ's response — so only the descriptor that drew it can read an
 *  x back, which is why a plot that maps presses declares which value it maps to. */
export interface DynPlotGeo {
  w: number;
  h: number;
  /** Plot-area inset, so a press on the canvas can be mapped back into the domain. */
  pad: { l: number; r: number; t: number; b: number };
  px: (v: number) => number;
  py: (v: number) => number;
}

/** Read a parameter, falling back to the field table's own default — so a plot and
 *  the sliders beside it cannot disagree about what "unset" means. */
export interface DynValues {
  get: (key: string) => number;
}

/**
 * One meter lane: a bar column and a readout cell. A level lane carries a tap, and
 * draws one bar per side the tap has (a stereo node's taps carry L and R). A reduction
 * lane carries a GR address instead, grows downward from 0 and reads as a magnitude.
 */
export interface DynLane {
  key: string;
  label: string;
  /** Stated rather than inferred from which address is set: a level lane whose tap
   *  failed to resolve still has to draw as a level lane (empty), not silently become
   *  something else. */
  kind: "level" | "gr";
  tap?: MeterTap | null;
  gr?: readonly [number, number];
  /** Full scale in dB for a reduction whose own domain is far shallower than the
   *  level ruler. Undefined shares the ruler's dB per pixel. */
  fullDb?: number;
  /** The value key this lane carries a fader cap for. Only a value in the ruler's own
   *  coordinate can be dragged on a meter (a GATE threshold in dB against the meter's
   *  dBFS); a lane with no such value leaves this unset. */
  cap?: string;
  /** Fold a two-sided tap into ONE bar, in place of drawing L and R. Absent = one bar
   *  per side, which is what a level lane wants when the point is to see the sides.
   *
   *  The ducker's KEY lane sets it because its two sides are not what the processor
   *  reacts to: the unit sums them and its detector reads RMS, so the lane draws that
   *  one number and the threshold cap rides it in the same coordinate. Folding here
   *  rather than offsetting the cap keeps the cap mechanism's invariant intact — the
   *  value it edits and the ruler it sits on stay the same units.
   *
   *  Named `foldSides` and not `fold` because this class already has a private `fold`,
   *  and the two are different layers: that one is a DISPLAY convention (which of two
   *  drawn bars a shared readout prints), this one is a DEVICE fact (how the hardware
   *  combines the sides before it reacts to them). */
  foldSides?: (l: number, r: number | null) => number;
  /** Draw this lane's bars inside the PREVIOUS lane's slot instead of a column of its
   *  own, and give it no caption. Everything else stays per-lane — its readings, its
   *  peak hold and its readout cell are untouched — so this is placement only.
   *
   *  The DUCKER pairs its reduction with the KEY level this way: the two are cause and
   *  effect, and one column shows the key rising to the threshold cap while the
   *  reduction hangs from the top of the same ruler. The cost is that a merged lane
   *  cannot carry `fullDb` — it is on the shared ruler by construction — so the ruler
   *  has to span the deeper of the two domains. */
  sameSlot?: true;
}

/** What a processor resolves for one node. Null from `bind` = the processor does not
 *  exist there, which is how the screen refuses to open and how it closes itself when
 *  a device follow takes the processor away underneath it. */
export interface DynBinding {
  fields: DynField[];
  lanes: DynLane[];
  /** How many columns the readout tiles take. Declared rather than derived from the
   *  lane count: the host has no way to know that four tiles want two columns and
   *  five might not, and a threshold on `lanes.length` is a guess dressed as a rule —
   *  the same guess `nodeLabel` and the optional `bar` exist to avoid. Absent = 3. */
  readoutCols?: number;
}

/** Everything a descriptor is asked its questions against. `sel` is whatever the
 *  segmented bar selects — a display mode for GATE/COMP, a band for the EQ. */
export interface DynCtx {
  model: DeviceModel;
  plan: Plan;
  nodeId: string;
  sel: number;
  m: Messages;
}

/** The pieces the host builds, for a descriptor to arrange. */
export interface DynParts {
  /** The meter lanes on their shared ruler. */
  lanes: () => HTMLElement;
  /** The plot the descriptor draws on. */
  plot: () => HTMLElement;
}

/** The segmented bar above the display and what it selects. */
export interface DynBar {
  /** The section heading the bar sits in ("Display", "Band"). */
  label: string;
  items: readonly { label: string; id: string }[];
  /** Nothing is selected and nothing can be: the choice does not belong to the operator
   *  right now (the EQ's bands are the device's while 1-knob is on). The items keep their
   *  space — hiding them outright would shorten the heading they sit in. */
  inert?: boolean;
}

export interface DynRowCtx extends DynCtx {
  /** Make a row the descriptor built armable for MIDI learn, by the value key it
   *  edits. The host resolves the key to a control id through `controlId` and marks
   *  the row's own control — the descriptor never has to know what a control id
   *  looks like, only which of its values a row carries. Returns the row, so it
   *  wraps the `settingsRow(...)` call it decorates. */
  midi: (row: HTMLElement, key: string) => HTMLElement;
  vals: Record<string, unknown>;
  /** What `rowStates` reported, resolved — so a row that is not a slider reads the same
   *  answer the sliders do instead of restating the rule. Absent for a key = editable. */
  states: ReadonlyMap<string, SettingsRowOptions>;
  /** Set a value that decides which other rows exist or are editable (COMP's
   *  1-knob and Auto Makeup): rebuilds the control column. */
  set: (patch: Record<string, number | boolean>) => void;
  /** Set a value that only changes itself. No rebuild — a control being dragged
   *  must survive its own edit, and rebuilding drops the pointer capture. */
  setValue: (patch: Record<string, number | boolean>) => void;
}

/** Extra rows a processor renders beside its sliders, in the device's own read
 *  order: `lead` above them (the mode switches), `tail` below (the selectors). */
export interface DynRows {
  lead?: HTMLElement[];
  tail?: HTMLElement[];
}

export interface DynProcessor {
  /** Identity: the segmented bar's persistence key, and the registry's own. */
  key: string;
  title: (m: Messages) => string;
  /** What the title names the screen as belonging to. Defaults to the node's own
   *  canvas label, which is right wherever the screen opens on the thing it tunes.
   *  The DUCKER opens on the ducker node, whose label is "Ducker" — beside a title
   *  that already says DUCKER it names nothing, so that descriptor answers with the
   *  host channel instead. */
  nodeLabel?: (ctx: DynCtx) => string | undefined;
  /** The lane ruler: its floor (the deepest level worth showing for this stage) and
   *  its tick step. */
  loDb: number;
  tickStep: number;
  /** node→data. Everything that depends on which node this is opened for — the
   *  fields, the taps, whether the processor exists at all — is resolved here, so the
   *  host carries no channel-kind knowledge. */
  bind: (ctx: DynCtx) => DynBinding | null;
  /** The segmented bar over the display, where there is something to pick. Absent
   *  where there is not: the DUCKER shows its envelope and its lanes at once, as the
   *  EQ does, so nothing chooses between them and a heading reading "Display" over a
   *  bar with no buttons would name a choice that does not exist. */
  bar?: (ctx: DynCtx) => DynBar;
  /** Keep the bar's choice across opens and sessions (it picks a way of reading the
   *  processor), rather than resetting per open (it is a cursor into the parameters). */
  persistSel?: true;
  /** One line under the display. Null reserves the space without printing (a plot
   *  needs saying what it shows; a fader cap on a meter explains itself). */
  hint?: (ctx: DynCtx) => string | null;
  /** The processor's values as one flat record. Where they live is the descriptor's
   *  business — GATE/COMP keep one sub-object, the EQ spreads across `eqBands[i]` and
   *  `eqOneKnob` — and every consumer here reads them by key. */
  read: (ctx: DynCtx) => Record<string, unknown>;
  /** Route a patch back into the plan's own shape, as a `nodeParams` patch. */
  patch: (ctx: DynCtx, patch: Record<string, number | boolean>) => NodeParams;
  /** How each row that is not plainly editable renders — the row options themselves, per
   *  key. Options rather than a flag because the reasons differ and say different things:
   *  the filter type does not read that value (locked, tagged), the rate has the whole
   *  processor inert (locked, tagged), or the device owns the whole group and the rows are
   *  reserved out of sight (`cls: "gt-reserved"`, which keeps their space and their place
   *  in the layout without showing them). No row is ever removed, so the panel keeps its
   *  height whatever is selected. */
  rowStates?: (ctx: DynCtx, vals: Record<string, unknown>) => ReadonlyMap<string, SettingsRowOptions> | null;
  rows?: (ctx: DynRowCtx) => DynRows;
  /** Sections above the parameters. GATE/COMP put their mode switches in `rows.lead`,
   *  inside Parameters, because they are that processor's own values; the EQ's 1-knob
   *  is a stage of its own with its own heading, as the unit prints it. */
  sections?: (ctx: DynRowCtx) => HTMLElement[];
  /** A label for a field whose key the shared `inspector.dyn` table does not name (or
   *  names differently — COMP's `gain` is a makeup gain, the EQ's is a band gain). */
  fieldLabel?: (f: DynField, m: Messages) => string | undefined;
  /** The MIDI control id one of this processor's value keys is addressable by, or
   *  null where there is none (the enum selectors are deliberately not mappable).
   *  Which processor and which band a key belongs to is the descriptor's business —
   *  the host only needs an id to arm and to mark. */
  controlId?: (ctx: DynCtx, key: string) => string | null;
  /** The tag pill on the Parameters heading (which band the rows below belong to), and
   *  whether it is shown — `settingsSection` keeps a hidden pill so the heading's height
   *  does not change, the same reservation the rows themselves get. */
  paramsTag?: (ctx: DynCtx) => { text: string; shown: boolean } | undefined;
  /** Arrange the parts into the display column. */
  display: (parts: DynParts, ctx: DynCtx) => HTMLElement;
  plotGeo: (w: number, h: number, ctx: DynCtx) => DynPlotGeo;
  /** The plot's frame: grid, tick labels, axis names, any reference line. Drawn
   *  unclipped, because the tick labels belong in the gutters `geo.pad` reserves. */
  drawAxes: (c: CanvasRenderingContext2D, geo: DynPlotGeo, tok: Record<string, string>, ctx: DynCtx) => void;
  /**
   * The response itself. **Clipped by the host to the plot area**, which is the contract
   * that keeps every plot honest: draw the true value and let it leave the frame, rather
   * than clamping it to the axis and drawing a horizontal bar along the edge — a response
   * the processor does not have. A high-pass passes the EQ's -18 dB floor within an octave
   * of its corner, and a gate's closed shelf can sit below its axis floor while its range
   * is still finite, which clamping made indistinguishable from -∞.
   *
   * An annotation of a value (a label, a leader line) may still be clamped so it stays
   * readable — it describes the value rather than being it. Do that deliberately.
   */
  drawCurve: (
    c: CanvasRenderingContext2D,
    geo: DynPlotGeo,
    v: DynValues,
    tok: Record<string, string>,
    ctx: DynCtx,
  ) => void;
  /** The live overlay (a dot at the current level), redrawn per frame that moves it.
   *  `read` answers with a lane's folded reading, or null with no feed. */
  drawLive?: (
    c: CanvasRenderingContext2D,
    geo: DynPlotGeo,
    read: (laneKey: string) => number | null,
    tok: Record<string, string>,
  ) => void;
  /** A press anywhere on the plot sets the value its lane carries a cap for, whose domain
   *  must therefore be the plot's x axis. Opt in only where the plot carries one editable
   *  value: with several, a press has to guess which one was meant, and one that missed a
   *  grip fell through to this drag (pressing COMP's gain grip moved the threshold). */
  plotDragsCap?: true;
}

/** Peak hold, in notify frames (100 ms each). Nothing on the device sets this —
 *  the level meters hold in hardware and GR holds not at all — so it is a UI
 *  choice: long enough to read a value that arrived while looking elsewhere. */
/** Which end a drag reached: the pointer said so, or the window went away. */
type DragEnd = "pointer" | "blur";

const PEAK_HOLD_FRAMES = 12;

/** Repaint cap. The feed is 10 Hz; this only bounds how soon a new frame reaches
 *  the screen, since no interpolation is applied between frames. */
const FRAME_MS = 1000 / 30;

/** Readout text is refreshed every Nth frame (~6 Hz), the console's rate: setting
 *  textContent relayouts the cell even when the string is unchanged, and the feed
 *  cannot deliver more than 10 new values a second anyway. */
const READOUT_EVERY = 5;

/** Persisted bar selection, per processor. Its own key, like `urx-sends-open` and
 *  `urx-metertap`: this is per-surface UI state, not a Preferences setting. */
const SEL_STORE = "urx-dyn-display";

export interface DynScreenHooks {
  getModel: () => DeviceModel;
  getPlan: () => Plan;
  isLive: () => boolean;
  /** The shared plan-edit funnel (the inspector's own path): flags the plan dirty
   *  and mirrors to the device when live. */
  onUpdateNodeParams: (id: string, patch: NodeParams) => void;
  /** Hand the broker's single meter slot over / give it back. */
  releaseMeters: () => void;
  regainMeters: () => void;
  /** A meter registration failed. Bars stuck on the floor look exactly like
   *  silence, so this takes the same loud path a live error does. */
  onMeterError: (message: string) => void;
  /** MIDI learn, when the desktop build has it: the same contract the CONSOLE
   *  strips arm through. Absent in a browser build, where there is no MIDI. */
  midi?: MidiLearnHooks;
  /** The screen closed: the surfaces that print these values re-render. */
  onClosed: () => void;
}

interface BarRefs {
  shade: HTMLElement;
  peak: HTMLElement;
}

/** One bar's held peak, in dB. Kept in the meter's own unit rather than as a
 *  fraction so the readout prints it directly; `db === null` is "nothing held
 *  yet", which is the same distinction the readouts draw between a value and "—". */
interface PeakHold {
  db: number | null;
  age: number;
}
const noPeak = (): PeakHold => ({ db: null, age: 0 });

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Shared empty map for a processor with every row plainly editable. */
const NO_STATES: ReadonlyMap<string, SettingsRowOptions> = new Map<string, SettingsRowOptions>();

/** The 1-knob level row, which COMP and the EQ each own one of. Shared because the two
 *  are the same control on the same scale — including the element id, which the E2E
 *  suite addresses and which works only because one screen is open at a time; spelling
 *  that twice let the range, the `%` format and that id drift per processor. `setValue`,
 *  not `set`: this slider changes only itself, and a rebuild on its own input event
 *  would take the element out from under the pointer. */
export function oneKnobLevelRow(opts: {
  label: string;
  value: unknown;
  onInput: (v: number) => void;
  row?: SettingsRowOptions;
}): HTMLElement {
  return sliderRow({
    label: opts.label,
    id: "dyn-oneknob-level",
    min: 0,
    max: 100,
    step: 1,
    value: typeof opts.value === "number" ? opts.value : 0,
    format: (v) => `${v} %`,
    onInput: opts.onInput,
    row: opts.row,
  });
}

/** A plot beside its meters, in signal order left to right, in separate frames — a
 *  response curve and a level ruler share no axis, and overlaying them would invite
 *  reading a gain off the meter's. The EQ and the DUCKER both arrange their display
 *  this way; the CSS wraps the pair to two rows when the plot cannot keep its width. */
export function splitDisplay(parts: DynParts): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "gt-splitdisplay";
  wrap.append(parts.plot(), parts.lanes());
  return wrap;
}

/** How many bars a lane draws: a stereo tap's L and R, or one — and always one where
 *  the lane folds the two sides into the value its processor actually reacts to. */
const laneSideCount = (lane: DynLane): number => (lane.tap?.r && !lane.foldSides ? 2 : 1);

export class DynScreen {
  private readonly scrim: HTMLElement;
  private readonly box: HTMLElement;
  private nodeId = "";
  private proc: DynProcessor | null = null;
  /** What the segmented bar has selected. Persisted per processor where the choice is
   *  a way of reading it (a gate and a compressor are not read the same way), reset
   *  per open where it is a cursor into the parameters. */
  private sel = 0;
  private sels: Record<string, number> = loadSels();

  private readonly store = new MeterStore();
  private paintN = 0; // frame counter gating the throttled readout text
  /** Last value written per bar, quantized: an idle bar then writes nothing. */
  private barCache = new Map<string, { v: number; p: number }[]>();
  /** The live overlay's last state per lane, so a frame that moved nothing draws nothing. */
  private liveLast: (number | null)[] = [];
  /** Per-lane scratch for the readings of one frame, sized when the binding lands: the
   *  paint loop runs 30×/s and this is the one place it would otherwise allocate. */
  private scratch: (number | null)[][] = [];
  private plotDirty = true;
  /** A pending coalesced redraw, for when no meter loop is running. */
  private redrawRaf = 0;
  /** Watches the plot canvas for a size change while the screen is open.
   *
   *  Its CSS width is a percentage and the modal follows the viewport, so a window
   *  resize changes the canvas' box with no repaint path of its own — measure() ran at
   *  open / refresh / rebuild and nowhere else. The static layer then stayed at the old
   *  w×h and was stretched by CSS (blurred, wrong aspect), and worse: a press on the
   *  GATE curve maps `offsetX` — in the NEW width — through the geometry cached for the
   *  old one, so the threshold that gets written is not the one the operator clicked,
   *  and while live it goes to the unit. A ResizeObserver rather than a window `resize`
   *  listener: it also catches a DPR change and a layout shift that is not a resize. */
  private plotResize: ResizeObserver | null = null;
  private plotSize = { w: 0, h: 0 };
  private geoCache: DynPlotGeo | null = null;
  /** Theme tokens the plot draws with. Read once per render, not per frame:
   *  getComputedStyle after the frame's DOM writes is a forced style recalc. */
  private plotTokens: Record<string, string> = {};
  /** The static plot kept off-screen so a frame that only moved the overlay is one
   *  drawImage instead of a full repaint. */
  private plotLayer: HTMLCanvasElement | null = null;
  /** The binding, resolved on open and on every refresh: `bind` walks the model and
   *  the plan, and the paint loop must not. */
  private fields: DynField[] = [];
  private lanes: DynLane[] = [];
  /** What the binding declared about the readouts. Only the column count so far. */
  private readoutCols = 3;
  private unsub: (() => void) | null = null;
  private raf = 0;
  /** The address set the current registration covers, and a counter that supersedes
   *  one still in flight. `addrs()` is not constant for the session — the DUCKER's KEY
   *  lane reads the tap its source channel's Rec Point names, so a follow, an undo or
   *  a plan load can move it — and a registration that outlives the lanes streams an
   *  address nothing reads while the lane it belongs to sits at the floor. */
  private subSig = "";
  private subGen = 0;

  /** Live readings, folded per lane, written by paint() and read by the overlay. */
  private readings = new Map<string, number | null>();
  private peaks = new Map<string, PeakHold[]>();

  private bars = new Map<string, BarRefs[]>();
  private cap: HTMLElement | null = null;
  /** The value the cap edits, and the row that mirrors it. */
  private capKey = "";
  private capSlider: HTMLInputElement | null = null;
  private capVal: HTMLElement | null = null;
  /** Last cap value written to the DOM; NaN forces the next write (a rebuild). */
  private syncedCap = Number.NaN;
  private canvas: HTMLCanvasElement | null = null;
  private readouts = new Map<string, { v: HTMLElement; p: HTMLElement; lastV: string; lastP: string }>();

  private readonly dismiss = wireDismiss({
    keep: (target) => target !== this.scrim,
    close: () => this.close(),
  });
  /** Held while the modal is up; see holdAppInert. */
  private releaseInert: (() => void) | null = null;

  /** A pointer is down on this screen, so nothing may rebuild its DOM: the control
   *  under the pointer would be replaced and the drag would end there. */
  private grabbed = false;
  /** A refresh arrived while grabbed and still has to happen. */
  private refreshPending = false;
  /** How to end the drag currently in flight. Set by the gesture, cleared by whichever end
   *  runs first, and told which end that was — a value row treats the two differently. */
  private endDrag: ((reason: DragEnd) => void) | null = null;

  constructor(private readonly hooks: DynScreenHooks) {
    this.scrim = document.getElementById("dyn-screen-modal") as HTMLElement;
    this.box = document.getElementById("dyn-screen-box") as HTMLElement;
    // The box itself outlives every rebuild, so one listener covers whatever it
    // holds. Release is watched on the window because a drag routinely ends with
    // the pointer outside the control, and outside the modal.
    this.box.addEventListener("pointerdown", () => {
      this.grabbed = true;
    });
    // The ender is told WHICH end this is. Two of the three drags tear down the same way
    // either way, but a value row does not: on a blur it has to be held inert (see
    // paramRow), and doing that on an ordinary release would leave the row disabled after
    // every drag the operator finishes normally.
    const release = (reason: DragEnd) => (): void => {
      this.endDrag?.(reason);
      if (!this.grabbed) return;
      this.grabbed = false;
      if (!this.refreshPending) return;
      this.refreshPending = false;
      this.refresh();
    };
    window.addEventListener("pointerup", release("pointer"));
    window.addEventListener("pointercancel", release("pointer"));
    // A window blur is the third end. The two registered above carry a pointer event;
    // this one carries none, so it needs the ender the gesture left behind. Measured
    // 2026-08-14 on Chromium and on the shipping WKWebView: losing the foreground with
    // the button down fires `blur`, fires no `pointercancel` and keeps the capture — so
    // the cap and plot drags below stayed armed, with that surviving capture routing
    // every later move straight to them. console.ts's trackDrag carries the readings.
    // Not `capture: true`: that would also catch the cap's and the canvas's own element
    // blur, which happens whenever focus moves inside the screen.
    window.addEventListener("blur", release("blur"));
  }

  isOpen(): boolean {
    return !this.scrim.hidden;
  }

  /** The open processor. Every path below runs between open() and close(), where it
   *  is set; the alternative was a descriptor-specific fallback in ten places. */
  private p(): DynProcessor {
    return this.proc as DynProcessor;
  }

  private ctx(): DynCtx {
    return {
      model: this.hooks.getModel(),
      plan: this.hooks.getPlan(),
      nodeId: this.nodeId,
      sel: this.sel,
      m: t(),
    };
  }

  /** Open one processor for one node. The screen is scoped to what it was opened from
   *  and stays there — no in-screen node or processor switch, so the subscribed
   *  address set is fixed for the whole session. */
  open(proc: DynProcessor, nodeId: string): void {
    const sel = proc.persistSel ? (this.sels[proc.key] ?? 0) : 0;
    const bound = proc.bind({ ...this.ctx(), nodeId, sel });
    if (!bound) return;
    this.proc = proc;
    this.nodeId = nodeId;
    this.sel = sel;
    this.fields = bound.fields;
    this.lanes = bound.lanes;
    this.readoutCols = bound.readoutCols ?? 3;
    this.scratch = bound.lanes.map((l) => new Array<number | null>(laneSideCount(l)).fill(null));
    this.peaks.clear();
    this.render();
    this.releaseInert ??= holdAppInert(this.scrim);
    this.scrim.hidden = false;
    this.dismiss.attach();
    this.measure();
    this.watchPlotSize();
    this.startMeters();
    this.box.querySelector<HTMLButtonElement>(".consent-btn-secondary")?.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.isOpen()) return;
    if (this.redrawRaf) cancelAnimationFrame(this.redrawRaf);
    this.redrawRaf = 0;
    this.dismiss.detach();
    this.releaseInert?.();
    this.releaseInert = null;
    this.scrim.hidden = true;
    this.plotResize?.disconnect();
    this.plotResize = null;
    this.stopMeters();
    this.hooks.regainMeters();
    this.hooks.onClosed();
  }

  /** Re-render in place: a language switch, a theme switch (the plot's tokens are
   *  read here, not per frame), or the plan changing under the screen — a device
   *  follow can move these very parameters while it is open. */
  refresh(): void {
    if (!this.isOpen()) return;
    // A follow can switch the channel's COMP/EQ bank out from under the screen,
    // which takes the processor away entirely. That verdict is not deferrable —
    // a screen left open on a bank the plan no longer emits would keep writing
    // into it — so it is decided before anything else.
    if (!this.rebind()) return;
    // A lane's tap can move without the screen closing: the DUCKER's KEY lane reads
    // the tap its source channel's Rec Point names, and a front-panel change, an undo
    // or a plan load all reach here. The registration is taken at `open`, so without
    // this the lane would ask the store for an address the broker was never told to
    // stream — a bar at the floor and a readout at "—", which is the one reading this
    // screen must never show for a signal that is present. Checked before the grabbed
    // early return, since the rebuild is what waits for a gesture, not the feed.
    if (this.hooks.isLive() && this.addrSig() !== this.subSig) {
      this.stopMeters();
      this.startMeters();
    }
    // Device follow runs on its own clock, and under COMP 1-knob it runs on every
    // step of a drag — the unit recomputes threshold / ratio / gain and announces
    // them, which comes back here. Rebuilding then would replace the control being
    // dragged, so the operator got two or three steps and no more. The values still
    // have to land, or the rows the screen advertises as device-driven would sit
    // frozen through the one gesture that drives them, so they go in place and only
    // the rebuild waits — the same split the CONSOLE draws between updating a strip
    // and re-creating it.
    if (this.grabbed) {
      this.refreshPending = true;
      this.syncValues();
      return;
    }
    this.render();
    this.measure();
    // render() replaced the canvas, so the size watch has to be re-attached to it.
    this.watchPlotSize();
  }

  /** Re-resolve what this node has. False (and closed) when the processor is gone — a
   *  follow can switch the channel's COMP/EQ bank out from under an open screen, and a
   *  loaded plan can take the node away entirely. */
  private rebind(): boolean {
    const bound = this.proc?.bind(this.ctx());
    if (!bound) {
      this.close();
      return false;
    }
    this.fields = bound.fields;
    this.lanes = bound.lanes;
    this.readoutCols = bound.readoutCols ?? 3;
    this.scratch = bound.lanes.map((l) => new Array<number | null>(laneSideCount(l)).fill(null));
    return true;
  }

  /** Write the current parameter values into the rows already on screen. Covers a
   *  device-side change arriving mid-gesture; anything structural (which rows exist,
   *  which are read-only) waits for the rebuild. */
  private syncValues(): void {
    for (const input of this.box.querySelectorAll<HTMLInputElement>("input[data-dyn]")) {
      const key = input.dataset.dyn;
      const f = key && this.fields.find((x) => x.key === key);
      if (!f) continue;
      const v = this.val(f.key);
      if (dynFromPos(f, Number(input.value)) !== v) input.value = String(dynToPos(f, v));
      const out = this.box.querySelector<HTMLElement>(`[data-dyn-val="${f.key}"]`);
      if (out) setLevelText(out, dynValueText(f, v));
    }
    this.syncCap();
  }

  /** Live sync turned on/off while this screen is open. It holds the meter slot
   *  for as long as it is open, so nothing else will re-establish the stream for
   *  it: without this a session that drops and returns leaves the screen dark
   *  until it is closed and reopened. The readouts already fall back to "—" on
   *  their own, since every paint reads the live state. */
  setLive(active: boolean): void {
    if (!this.isOpen()) return;
    if (active) this.startMeters();
    else this.stopMeters();
  }

  // ---------------------------------------------------------------- meters

  /** The addresses this screen streams, in lane order. Resolved from the lanes `bind`
   *  produced, which `rebind` re-resolves against the current plan — so this moves
   *  when a lane's tap does. */
  private addrs(): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (const lane of this.lanes) {
      for (const a of [lane.tap?.l, lane.tap?.r, lane.gr]) if (a) out.push([a[0], a[1]]);
    }
    return out;
  }

  /** The address set as one comparable string, in lane order. */
  private addrSig(): string {
    return this.addrs()
      .map((a) => `${a[0]}:${a[1]}`)
      .join(",");
  }

  private startMeters(): void {
    if (!this.hooks.isLive()) return;
    // Stamped synchronously, before the round trip: a re-scope that arrives while the
    // registration is still in flight is then visible to `refresh` as a difference
    // rather than being compared against the set this call is about to install.
    const gen = ++this.subGen;
    this.subSig = this.addrSig();
    // Take the slot before subscribing: the broker replaces the previous
    // registration silently, so the console must be told rather than discover it.
    this.hooks.releaseMeters();
    const grLanes = this.lanes.filter((l) => l.kind === "gr" && l.gr);
    void subscribeMeters(this.store, this.addrs(), (msg) => {
      // The GR peak folds here, not off the store: the store is last-write-win, so
      // a batch carrying more than one frame for an address would drop all but the
      // last before any reader saw them.
      for (const lane of grLanes) {
        const gr = lane.gr as readonly [number, number];
        if (msg.meterId !== gr[0] || msg.x !== gr[1]) continue;
        const db = decodeGrDb(msg.value);
        const p = this.peakFor(lane.key, 0);
        if (p.db === null || db < p.db) {
          p.db = db;
          p.age = 0;
        }
      }
    })
      .then((unsub) => {
        // Superseded while in flight (a re-scope, or a close) — drop the handle here
        // rather than installing it over the live one, which would leak the older
        // registration at the broker.
        if (this.isOpen() && gen === this.subGen) this.unsub = unsub;
        else unsub();
      })
      .catch((e: unknown) => this.hooks.onMeterError(e instanceof Error ? e.message : String(e)));

    if (!this.raf) {
      let last = 0;
      const tick = (now: number): void => {
        if (now - last >= FRAME_MS) {
          last = now;
          this.paint();
        }
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }
  }

  private stopMeters(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    // Supersede a registration still in flight, so its handle is dropped rather than
    // installed after this teardown.
    this.subGen++;
    this.subSig = "";
    this.unsub?.();
    this.unsub = null;
    this.store.clear();
    this.peaks.clear();
    this.barCache.clear();
  }

  private peakFor(laneKey: string, side: number): PeakHold {
    let list = this.peaks.get(laneKey);
    if (!list) this.peaks.set(laneKey, (list = []));
    return (list[side] ??= noPeak());
  }

  // ---------------------------------------------------------------- scales

  /** Fraction of the ruler a level occupies (0 at the floor, 1 at 0 dBFS). */
  private frac(db: number): number {
    const lo = this.p().loDb;
    return clamp01((db - lo) / (HI_DB - lo));
  }

  /** Fraction of a lane a reading fills. A reduction grows downward from 0, and reads
   *  either on the level ruler's own dB per pixel (a gate's runs the whole ruler) or
   *  on a full scale of its own (a compressor's is a few dB, and would sit invisible
   *  on a 54 dB ruler — its lane is labelled separately). */
  private laneFrac(lane: DynLane, db: number): number {
    if (lane.kind !== "gr") return this.frac(db);
    const p = this.p();
    return clamp01(Math.abs(db) / (lane.fullDb ?? HI_DB - p.loDb));
  }

  /** The reading a lane's readout prints when it has two bars: the louder side for a
   *  level (the console's own rule), the deeper for a reduction. */
  private fold(lane: DynLane, a: number, b: number): number {
    return lane.kind === "gr" ? Math.min(a, b) : Math.max(a, b);
  }

  // ---------------------------------------------------------------- painting

  /** One frame. The feed is 10 Hz and no interpolation is applied, so most frames
   *  carry nothing new: every write below is behind a dirty check and the readout
   *  text is throttled further, matching the console's paintMeters — a text write
   *  relayouts its cell whether or not the string changed. */
  private paint(): void {
    const live = this.hooks.isLive();
    const showText = this.paintN++ % READOUT_EVERY === 0;
    const m = t().dynTuning;

    for (const [index, lane] of this.lanes.entries()) {
      const sides = this.laneReadings(index, lane, live);
      let value: number | null = null;
      let peak: number | null = null;
      for (let i = 0; i < sides.length; i++) {
        const db = sides[i];
        const p = this.peakFor(lane.key, i);
        // Both rulers grow with the displayed magnitude, so "further along the lane"
        // is one comparison for every lane — no level/reduction branch.
        if (
          db !== null &&
          (p.db === null || this.laneFrac(lane, db) > this.laneFrac(lane, p.db) || p.age > PEAK_HOLD_FRAMES)
        ) {
          p.db = db;
          p.age = 0;
        } else if (db !== null) p.age++;
        this.setBar(lane, i, db === null ? 0 : this.laneFrac(lane, db), p.db === null ? 0 : this.laneFrac(lane, p.db));
        if (db !== null) value = value === null ? db : this.fold(lane, value, db);
        if (p.db !== null) peak = peak === null ? p.db : this.fold(lane, peak, p.db);
      }
      this.readings.set(lane.key, value);
      if (showText) {
        this.setReadout(
          lane.key,
          value === null ? m.noReading : value.toFixed(1),
          peak === null ? m.noReading : peak.toFixed(1),
        );
      }
    }
    // Only a descriptor with an overlay has anything to redraw when a reading moves; the
    // EQ's plot is static, and repainting it per feed frame was ~10 full-canvas blits a
    // second for no pixel change.
    if (this.canvas && (this.plotDirty || (this.p().drawLive && this.liveDirty()))) this.drawPlot();
  }

  /** A lane's current reading per bar, into that lane's scratch: [L] or [L, R] for a level
   *  tap, [reduction] for a GR lane, and nulls with no feed (so the bars reset). */
  private laneReadings(index: number, lane: DynLane, live: boolean): (number | null)[] {
    const out = this.scratch[index];
    if (lane.kind === "gr") {
      out[0] = live ? this.store.readGr(lane.gr) : null;
      return out;
    }
    const r = live ? this.store.readingTap(lane.tap ?? null) : null;
    if (lane.foldSides) {
      out[0] = r ? lane.foldSides(r.l, r.stereo ? r.r : null) : null;
      return out;
    }
    out[0] = r?.l ?? null;
    if (out.length === 2) out[1] = r?.r ?? null;
    return out;
  }

  /** Has anything the overlay draws moved since the last frame? The plot is static apart
   *  from it, and it only moves when a reading does. Compared in place: this runs 30×/s in
   *  a loop the rest of this file keeps allocation-free. */
  private liveDirty(): boolean {
    let moved = this.plotDirty;
    for (let i = 0; i < this.lanes.length; i++) {
      const now = this.readings.get(this.lanes[i].key) ?? null;
      if (this.liveLast[i] !== now) {
        this.liveLast[i] = now;
        moved = true;
      }
    }
    return moved;
  }

  private setBar(lane: DynLane, side: number, value: number, peak: number): void {
    const refs = this.bars.get(lane.key)?.[side];
    if (!refs) return;
    let cache = this.barCache.get(lane.key);
    if (!cache) this.barCache.set(lane.key, (cache = []));
    const c = (cache[side] ??= { v: -1, p: -1 });
    // Quantize to the pixel the transform can actually resolve, so an idle lane
    // stops writing at all rather than churning the last decimals.
    const v = Math.round(value * 1000);
    const p = Math.round(peak * 1000);
    if (c.v !== v) {
      c.v = v;
      refs.shade.style.setProperty("--lvl", (v / 1000).toFixed(3));
    }
    if (c.p !== p) {
      c.p = p;
      refs.peak.style.setProperty("--pk", (p / 1000).toFixed(3));
      refs.peak.classList.toggle("off", p <= 0);
    }
  }

  private setReadout(laneKey: string, value: string, peak: string): void {
    const r = this.readouts.get(laneKey);
    if (!r) return;
    // Both strings are compared before either is built: `t()` and the template together
    // cost more than the comparison, and an idle lane changes neither.
    if (r.lastP === peak && r.lastV === value) return;
    const peakText = `${t().dynTuning.peakPrefix} ${peak}`;
    if (r.lastV !== value) {
      r.lastV = value;
      setLevelText(r.v, value);
    }
    if (r.lastP !== peak) {
      r.lastP = peak;
      setLevelText(r.p, peakText);
    }
  }

  // ---------------------------------------------------------------- plan I/O

  private vals(): Record<string, unknown> {
    return this.p().read(this.ctx());
  }

  private setVals(patch: Record<string, number | boolean>): void {
    this.hooks.onUpdateNodeParams(this.nodeId, this.p().patch(this.ctx(), patch));
  }

  /** The value of one parameter, falling back to the catalog's own default — so the
   *  screen and the field table cannot drift apart on what "unset" means. */
  private val(key: string): number {
    const v = this.vals()[key];
    return typeof v === "number" ? v : (this.fields.find((f) => f.key === key)?.def ?? 0);
  }

  private values(): DynValues {
    return { get: (k) => this.val(k) };
  }

  /** How each non-editable row renders, resolved once per render: it can only change
   *  through a path that re-renders, and the pointer handlers below consult it on every
   *  move. */
  private states: ReadonlyMap<string, SettingsRowOptions> = NO_STATES;

  private capLocked(): boolean {
    return this.states.get(this.capKey)?.locked === true;
  }

  /** The field the cap edits. Its step and its label belong to the field table, not to
   *  this class — a cap on a 0.5 dB value must not be quantized to whole dB by its host. */
  private capField(): DynField | undefined {
    return this.fields.find((f) => f.key === this.capKey);
  }

  private setCapFromFrac(f: number): void {
    if (!this.capKey || this.capLocked()) return;
    const lo = this.p().loDb;
    const step = this.capField()?.step ?? 1;
    const db = Math.round((lo + clamp01(f) * (HI_DB - lo)) / step) * step;
    if (db !== this.vals()[this.capKey]) this.setVals({ [this.capKey]: db });
    this.syncCap();
  }

  private syncCap(): void {
    if (!this.capKey) return;
    const db = this.val(this.capKey);
    // The ruler spans 54-72 dB over the slot height, so most consecutive moves
    // resolve to the same rounded value. `--pos` drives `top` (unregistered, so it
    // dirties layout) and the readout writes textContent, which relayouts its cell
    // whether or not the string changed — the same reason paint() throttles its own.
    if (db === this.syncedCap) return;
    this.syncedCap = db;
    if (this.cap) {
      this.cap.style.setProperty("--pos", ((1 - this.frac(db)) * 100).toFixed(2) + "%");
      this.cap.setAttribute("aria-valuenow", String(db));
      this.cap.setAttribute("aria-valuetext", formatDyn(db, "db"));
    }
    if (this.capSlider && Number(this.capSlider.value) !== db) this.capSlider.value = String(db);
    if (this.capVal) setLevelText(this.capVal, formatDyn(db, "db"));
    this.markPlotDirty();
  }

  /** Bound once: `drawLive` takes it per redraw, and a fresh closure there would allocate
   *  in the paint loop. */
  private readonly readLane = (key: string): number | null => this.readings.get(key) ?? null;

  /** The static half of the plot changed (a parameter, size or theme), so the next frame
   *  redraws it instead of only moving the overlay — and if there is no frame loop, on a
   *  frame of its own. The loop only runs while the meters are fed, so without a live
   *  session (the browser build, or any offline edit) a slider moved the value and left the
   *  curve on the last parameters it was drawn with until something re-rendered the screen.
   *  Coalesced rather than drawn here: a drag fires `input` per pointermove, and the EQ's
   *  layer is a per-pixel response evaluation — drawing inline was 2-4× the redraws, inside
   *  the handler that is delaying the next event. */
  private markPlotDirty(): void {
    this.plotDirty = true;
    if (this.raf || this.redrawRaf) return;
    this.redrawRaf = requestAnimationFrame(() => {
      this.redrawRaf = 0;
      this.drawPlot();
    });
  }

  // ---------------------------------------------------------------- rendering

  private render(): void {
    const m = t();
    const proc = this.proc;
    if (!proc) return;
    const g = m.dynTuning;
    this.readTokens();
    this.box.replaceChildren();
    this.bars.clear();
    this.readouts.clear();
    // The elements the paint loop writes to are new, so the write caches have to go
    // with them: a cached value equal to the incoming one would skip the first write
    // and leave a freshly built bar empty until the level next changed.
    this.barCache.clear();
    this.cap = null;
    this.canvas = null;
    this.capKey = this.lanes.find((l) => l.cap)?.cap ?? "";
    this.capSlider = null;
    this.capVal = null;
    this.plotDirty = true;
    this.plotSize = { w: 0, h: 0 };
    this.geoCache = null;
    this.liveLast = [];
    // The readout cells are rebuilt empty, and the paint below is the only thing
    // that fills them — without resetting the throttle counter a re-render landing
    // on a skipped frame (every bar switch, since render() paints once) left them
    // blank until the next feed tick, or forever with no session.
    this.paintN = 0;
    this.syncedCap = Number.NaN;
    this.states = proc.rowStates?.(this.ctx(), this.vals()) ?? NO_STATES;

    const title = el("h2", "");
    title.id = "dyn-screen-title";
    const ch = el("span", "gt-ch");
    ch.textContent = proc.nodeLabel?.(this.ctx()) ?? channelLabel(this.hooks.getModel(), this.nodeId);
    const name = el("span", "");
    name.textContent = proc.title(m);
    title.append(ch, name);

    const grid = el("div", "prefs-grid");
    grid.append(this.displayColumn(proc), this.controlColumn(m));

    const actions = el("div", "consent-actions");
    const close = el("button", "consent-btn-secondary");
    close.textContent = g.close;
    close.addEventListener("click", () => this.close());
    actions.append(close);

    this.box.append(title, grid, actions);
    this.syncCap();
    this.paint();
  }

  private displayColumn(proc: DynProcessor): HTMLElement {
    const ctx = this.ctx();
    const bar = proc.bar?.(ctx);
    const col = el("div", "prefs-col");
    if (bar) col.append(this.displayBar(bar));
    col.append(proc.display({ lanes: () => this.laneRack(), plot: () => this.plotBox() }, ctx));
    col.append(this.hintLine(proc, ctx));
    return col;
  }

  /** The segmented bar over the display, in the heading of the section it sits in. */
  private displayBar(bar: DynBar): HTMLElement {
    const sec = settingsSection(bar.label);
    const h = sec.firstElementChild as HTMLElement;
    const seg = el("span", "udk-banks gt-modes");
    for (const [i, item] of bar.items.entries()) {
      const b = el("button", "") as HTMLButtonElement;
      b.id = item.id;
      b.textContent = item.label;
      b.setAttribute("aria-pressed", String(!bar.inert && this.sel === i));
      if (bar.inert) b.disabled = true;
      else b.addEventListener("click", () => this.select(i));
      seg.append(b);
    }
    if (bar.inert) seg.classList.add("inert");
    h.append(seg);
    return sec;
  }

  /** The line under the display. The hint is the plot's — a fader cap on a meter
   *  explains itself, a plot does not say what it is showing — but its box is reserved
   *  whatever the display shows. Adding it only in one mode made the modal grow by its
   *  height on every switch, which moves the Close action and the parameter rows under
   *  the pointer. `gt-note` reserves TWO lines at a fixed height, which is what keeps a
   *  longer string from silently reintroducing the jump — and from being cut, which one
   *  line did on any window narrower than a wide desktop (E2E pins both). */
  private hintLine(proc: DynProcessor, ctx: DynCtx): HTMLElement {
    const hint = el("p", "gt-note");
    const text = proc.hint?.(ctx);
    if (text) hint.textContent = text;
    else hint.setAttribute("aria-hidden", "true");
    return hint;
  }

  /** The segmented bar picked something else. It can change the binding (the EQ's
   *  fields differ per band — only LOW and HIGH carry a filter type), so it rebinds
   *  before rebuilding. */
  private select(i: number): void {
    if (i === this.sel || !this.proc) return;
    this.sel = i;
    if (this.proc.persistSel) {
      this.sels = { ...this.sels, [this.proc.key]: i };
      saveJson(SEL_STORE, this.sels);
    }
    this.rebuild();
  }

  private laneRack(): HTMLElement {
    const proc = this.p();
    const box = el("div", "gt-ladderbox");
    const row = el("div", "gt-ladders");
    row.append(this.tickColumn(proc.loDb, proc.tickStep, (db) => this.frac(db)));
    let host: HTMLElement | null = null;
    for (const lane of this.lanes) {
      if (lane.sameSlot && host) {
        this.laneBars(lane, host);
        continue;
      }
      const built = this.laneColumn(lane);
      row.append(built.el);
      host = built.slot;
    }
    box.append(row);
    return box;
  }

  /** A tick column sharing the slots' grid row, so a tick and a level sit in one
   *  coordinate space. `place` maps a value to its fraction up the column. */
  private tickColumn(loDb: number, step: number, place: (db: number) => number): HTMLElement {
    const col = el("div", "gt-lcol");
    const scale = el("div", "gt-scale");
    // Stop one step short of the floor: a label centred on the bottom edge would
    // hang into the caption row below it.
    for (let db = HI_DB; db > loDb; db -= step) {
      const tick = el("span", "t");
      tick.textContent = String(db);
      tick.style.bottom = (place(db) * 100).toFixed(2) + "%";
      scale.append(tick);
    }
    // An empty caption of the same two-line height as its neighbours, so the tick
    // column's grid row matches the slots' and a tick lines up with a level.
    //
    // The spaces are non-breaking on purpose. Ordinary ones collapse and a trailing
    // <br> generates no line box, so this measured 12.75px — one line, not two —
    // and `.gt-lcol`'s `1fr auto` handed the difference to the scale: it stood
    // 12.75px taller than the slot beside it, so the two shared a top edge and
    // drifted apart linearly down to the floor. A tick then pointed at a level it
    // was not level with.
    const spacer = el("span", "gt-cap-label");
    spacer.setAttribute("aria-hidden", "true");
    spacer.append(document.createTextNode("\u00a0"), document.createElement("br"), document.createTextNode("\u00a0"));
    col.append(scale, spacer);
    return col;
  }

  /** One lane's bars, into a slot. Separate from the column so a merged lane can put
   *  its own into the column before it. */
  private laneBars(lane: DynLane, slot: HTMLElement): void {
    const isGr = lane.kind === "gr";
    const sides = laneSideCount(lane);
    const refs: BarRefs[] = [];
    for (let i = 0; i < sides; i++) {
      const side = sides === 2 ? el("div", "gt-side") : slot;
      if (!isGr) {
        const bar = el("div", "gt-bar");
        bar.style.setProperty("--zy", (this.frac(METER_GREEN_TOP_DB) * 100).toFixed(2) + "%");
        bar.style.setProperty("--zr", (this.frac(METER_YELLOW_TOP_DB) * 100).toFixed(2) + "%");
        side.append(bar);
      }
      const shade = el("div", isGr ? "gt-shade gr" : "gt-shade");
      const peak = el("div", isGr ? "gt-peak gr off" : "gt-peak off");
      side.append(shade, peak);
      if (side !== slot) slot.append(side);
      refs.push({ shade, peak });
    }
    this.bars.set(lane.key, refs);
  }

  /** One lane: its bars, its caption, its cap if it carries one, and its own tick
   *  column if it declares its own scale. Returns the slot as well, so a lane that
   *  merges into this one can be given it. */
  private laneColumn(lane: DynLane): { el: HTMLElement; slot: HTMLElement } {
    const isGr = lane.kind === "gr";
    const sides = laneSideCount(lane);
    const col = el("div", "gt-lcol");
    const slot = el("div", `gt-slot${isGr ? " gt-slot-gr" : ""}${sides === 2 ? " stereo" : ""}`);
    this.laneBars(lane, slot);
    if (lane.cap) slot.append(this.capControl(slot));
    col.append(slot, capLabel(lane.label, (lane.tap?.l ?? lane.gr)?.[0]));
    // A reduction that runs the whole ruler (a gate's) reads off the shared tick
    // column. One that occupies a few dB of it (a compressor's) would sit invisible
    // there, so it gets a scale of its own — printed beside the lane and set apart
    // from the level pair, never a second unlabelled scale under the shared ticks.
    if (lane.fullDb === undefined) return { el: isGr ? wrap("gt-grwrap", col) : col, slot };
    const full = lane.fullDb;
    return {
      el: wrap(
        "gt-grwrap own",
        this.tickColumn(-full, full / 4, (db) => 1 - Math.abs(db) / full),
        col,
      ),
      slot,
    };
  }

  /** A value as a fader cap on its own meter. The one gesture the lane rack exists
   *  for — it works because the value's dB and the meter's dBFS are the same
   *  coordinate. */
  private capControl(slot: HTMLElement): HTMLElement {
    const cap = el("div", "gt-cap");
    cap.id = "dyn-threshold-cap";
    cap.tabIndex = 0;
    cap.setAttribute("role", "slider");
    const field = this.capField();
    const m = t();
    cap.setAttribute(
      "aria-label",
      (field && this.p().fieldLabel?.(field, m)) ?? (m.inspector.dyn as Record<string, string>)[this.capKey] ?? "",
    );
    cap.setAttribute("aria-valuemin", String(this.capField()?.min ?? this.p().loDb));
    cap.setAttribute("aria-valuemax", String(HI_DB));
    if (this.capLocked()) cap.classList.add("locked");
    this.cap = cap;

    // The slot's rect is read once per gesture: reading it per move is a forced
    // layout in the subtree the 30 fps meter loop is writing to, and the modal can
    // neither scroll nor resize while a pointer is down.
    let rect: DOMRect | null = null;
    const fromY = (clientY: number): void => {
      const r = (rect ??= slot.getBoundingClientRect());
      this.setCapFromFrac(1 - (clientY - r.top) / r.height);
    };
    let dragging = false;
    let pointer: number | null = null;
    cap.addEventListener("pointerdown", (e) => {
      cap.setPointerCapture(e.pointerId);
      rect = slot.getBoundingClientRect();
      dragging = true;
      pointer = e.pointerId;
      this.endDrag = end;
      e.preventDefault();
    });
    cap.addEventListener("pointermove", (e) => {
      if (dragging) fromY(e.clientY);
    });
    const end = (): void => {
      dragging = false;
      rect = null;
      if (this.endDrag === end) this.endDrag = null;
      // Dropped with the gesture, for the reason console.ts's trackDrag states: the blur
      // end is the one no engine follows with a release of its own.
      if (pointer !== null && cap.hasPointerCapture(pointer)) cap.releasePointerCapture(pointer);
      pointer = null;
    };
    cap.addEventListener("pointerup", end);
    cap.addEventListener("pointercancel", end);
    // A press on the track jumps the cap, matching the console faders.
    slot.addEventListener("pointerdown", (e) => {
      if (e.target === cap) return;
      rect = slot.getBoundingClientRect();
      fromY(e.clientY);
    });
    cap.addEventListener("keydown", (e) => {
      // One field step per arrow, six per page — the same relation the range inputs have.
      const unit = this.capField()?.step ?? 1;
      const steps =
        e.key === "PageUp" ? 6 : e.key === "PageDown" ? -6 : e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
      if (!steps || this.capLocked()) return;
      e.preventDefault();
      const lo = this.p().loDb;
      const next = Math.min(HI_DB, Math.max(lo, this.val(this.capKey) + steps * unit));
      this.setVals({ [this.capKey]: next });
      this.syncCap();
    });
    return cap;
  }

  /** Measure the canvas once, after the modal is visible. Doing it in the frame
   *  loop is a forced layout read straight after that frame's DOM writes. */
  /** Re-attach the size watch to whatever canvas the current render produced. Called on
   *  open and after every rebuild, since `render()` replaces the element. A no-op where
   *  ResizeObserver is absent (jsdom without a polyfill), which costs only the resize
   *  case those environments cannot produce anyway. */
  private watchPlotSize(): void {
    this.plotResize?.disconnect();
    this.plotResize = null;
    const cv = this.canvas;
    if (!cv || typeof ResizeObserver === "undefined") return;
    this.plotResize = new ResizeObserver(() => this.measure());
    this.plotResize.observe(cv);
  }

  measure(): void {
    const cv = this.canvas;
    if (!cv) return;
    const w = Math.max(240, cv.clientWidth);
    const h = cv.clientHeight;
    if (w === this.plotSize.w && h === this.plotSize.h) return;
    this.plotSize = { w, h };
    this.plotDirty = true;
    this.drawPlot();
  }

  private plotBox(): HTMLElement {
    const box = el("div", "gt-curvebox");
    const cv = document.createElement("canvas");
    cv.id = "dyn-curve";
    const hint = this.p().hint?.(this.ctx());
    if (hint) cv.setAttribute("aria-label", hint);
    this.canvas = cv;
    box.append(cv);

    // A press anywhere on the plot sets one value, for the processors that opt in.
    // Grips labelled T / R / G on the curve were tried and removed: they read as the
    // unit's own screen, and a press that missed one fell through to this same drag,
    // so pressing the gain grip moved the threshold instead.
    if (!this.p().plotDragsCap) return box;
    const apply = (e: PointerEvent): void => {
      const w = this.plotSize.w;
      const geo = this.geoCache;
      if (!w || !geo) return;
      this.setCapFromFrac((e.offsetX - geo.pad.l) / (w - geo.pad.l - geo.pad.r));
    };
    cv.addEventListener("pointerdown", (e) => {
      cv.setPointerCapture(e.pointerId);
      apply(e);
      // The move gate below is the capture itself, which a blur leaves standing, so
      // this drag ends by dropping it.
      const away = (): void => {
        end(e);
        if (this.endDrag === away) this.endDrag = null;
      };
      this.endDrag = away;
    });
    cv.addEventListener("pointermove", (e) => {
      if (cv.hasPointerCapture(e.pointerId)) apply(e);
    });
    const end = (e: PointerEvent): void => {
      if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
    };
    cv.addEventListener("pointerup", end);
    cv.addEventListener("pointercancel", end);
    return box;
  }

  private controlColumn(m: Messages): HTMLElement {
    const g = m.dynTuning;
    const col = el("div", "prefs-col");
    const proc = this.p();
    const ctx = this.ctx();

    const params = settingsSection(g.parameters, proc.paramsTag?.(ctx));
    const labels = m.inspector.dyn as Record<string, string>;
    const label = (f: DynField): string => proc.fieldLabel?.(f, m) ?? labels[f.key] ?? f.key;
    // One snapshot for the whole column: `read()` walks the plan and allocates, and this
    // used to run once per field on top of once for the rows and once for the states.
    const vals = this.vals();
    const value = (key: string): number => {
      const v = vals[key];
      return typeof v === "number" ? v : (this.fields.find((f) => f.key === key)?.def ?? 0);
    };
    // These rows decide which other rows exist and which are read-only (COMP's
    // 1-knob and Auto Makeup hand values over to the device), so each one rebuilds
    // the column. The sliders deliberately do not — a rebuild mid-drag would drop
    // the pointer capture.
    const rowCtx: DynRowCtx = {
      ...ctx,
      midi: (row, key) => this.armable(row, key, ctx),
      vals,
      states: this.states,
      set: (patch) => {
        this.setVals(patch);
        this.rebuild();
      },
      setValue: (patch) => this.setVals(patch),
    };
    const extra = proc.rows?.(rowCtx);
    if (extra?.lead) params.append(...extra.lead);
    for (const f of this.fields) params.append(this.paramRow(f, label(f), value(f.key), this.states.get(f.key)));
    if (extra?.tail) params.append(...extra.tail);

    const ro = settingsSection(g.readouts);
    const cells = el("div", `gt-readouts${this.readoutCols === 2 ? " two" : ""}`);
    for (const lane of this.lanes) cells.append(this.readoutCell(lane));
    ro.append(cells);

    col.append(...(proc.sections?.(rowCtx) ?? []), params, ro);
    return col;
  }

  /**
   * Mark a parameter row as armable for MIDI learn and wire the arming, by the value
   * key it edits. Takes the ROW rather than the control: the ring goes on the control
   * (what the operator clicks) but the mapped dot goes on the row, and a control that
   * has not been appended yet has no row to reach through `closest`. `key` is the
   * descriptor's own; the id comes from the descriptor, so a locked row or an
   * unmappable one (an enum selector, which answers null) is simply left alone — the
   * same treatment the console gives a read-only chip. Returns the row, so it wraps
   * the `settingsRow(...)` call it decorates.
   */
  private armable(row: HTMLElement, key: string, ctx: DynCtx): HTMLElement {
    const midi = this.hooks.midi;
    const control = row.querySelector<HTMLElement>(".ctl, .prefs-toggle");
    if (!control || !midi) return row;
    // A locked row's control is disabled; arming it would bind a mapping whose
    // writes the catalog refuses anyway.
    if (this.states.get(key)?.locked) return row;
    const id = this.p().controlId?.(ctx, key);
    if (!id) return row;
    markMidi(control, id, midi);
    armOnActivate(control, id, midi);
    // The mapped dot is the row's, not the control's. A console chip floats over the
    // strip with room around it; a screen row's control has none — measured, the dot
    // landed on the value's last character at the cell's right corner and on the
    // slider's own thumb at its left one (a control parked at its minimum: amber on
    // amber). The label gutter is empty at every value.
    if (midi.isMapped(id)) row.classList.add("midi-mapped-row");
    return row;
  }

  /** Re-resolve and rebuild after a row that changes the shape of the screen. The
   *  rebind matters for a processor whose fields depend on its own values (the EQ's
   *  bands are the device's while 1-knob is on). */
  private rebuild(): void {
    if (!this.rebind()) return;
    this.render();
    this.measure();
    // render() replaced the canvas, so the size watch has to be re-attached to it.
    this.watchPlotSize();
  }

  private paramRow(f: DynField, label: string, value: number, opts: SettingsRowOptions | undefined): HTMLElement {
    const ctl = el("span", "ctl dev-slider");
    const input = document.createElement("input");
    input.type = "range";
    // A logarithmic field carries slider positions, not its value: an EQ band
    // frequency spans three decades, and a linear slider resolves nothing at 20 Hz.
    input.min = String(f.logSteps === undefined ? f.min : 0);
    input.max = String(f.logSteps ?? f.max);
    input.step = String(f.logSteps === undefined ? f.step : 1);
    input.value = String(dynToPos(f, value));
    input.dataset.dyn = f.key;
    input.setAttribute("aria-label", label);
    const val = el("span", "param-val gt-val");
    val.dataset.dynVal = f.key;
    if (f.key === this.capKey) {
      this.capSlider = input;
      this.capVal = val;
    }

    const show = (v: number): void => {
      const text = dynValueText(f, v);
      // GATE range's -∞ notch: the mono font draws ∞ at x-height, so it goes
      // through the shared wrapper like every other dB readout in the app.
      setLevelText(val, text);
      input.setAttribute("aria-valuetext", text);
    };
    show(value);
    input.addEventListener("input", () => {
      const v = dynFromPos(f, Number(input.value));
      show(v);
      this.setVals({ [f.key]: v });
      if (f.key === this.capKey) this.syncCap();
      else this.markPlotDirty();
    });
    // A wheel notch over an armed control would move the value the operator is
    // about to bind, so the same gate the console's faders carry applies here.
    wheelStep(input, () => this.hooks.midi?.learnActive());
    // The row is a native range, so the ENGINE owns its drag and unhooking a listener
    // does not end it — measured 2026-08-14 on the packaged build: a row dragged with the
    // button held went on writing thresholds to the plan and out to the unit while
    // another application was frontmost, exactly like the cap did before this branch.
    //
    // Three treatments were measured against it. Taking the element out of the document
    // and putting it straight back ends the drag in both engines — but only until focus
    // returns: on the real WKWebView the row resumed under the still-held button, which is
    // the reading that decided this. `pointer-events: none` does not end it at all (the
    // row kept writing in both engines). `disabled` ends it AND cannot be re-acquired
    // while it lasts, so that is what this holds until the button comes up.
    //
    // It costs nothing on screen: this slider is authored (`appearance: none`, own track
    // and thumb), so the engines' disabled rendering has nothing to dim — the row shot
    // enabled and disabled is byte-identical in both. Focus is restored because disabling
    // drops it (Chromium focuses a range on press and reports the blur, WebKit does
    // neither, so there it restores nothing).
    input.addEventListener("pointerdown", () => {
      const ender = (reason: DragEnd): void => {
        if (this.endDrag === ender) this.endDrag = null;
        // An ordinary release ends the engine's drag by itself and needs nothing from
        // here; treating it like a blur left the row disabled after every finished drag,
        // and the listener armed below cannot see the very `pointerup` it was added
        // during, so the row stayed dead until some later event happened to re-arm it.
        if (reason !== "blur" || input.disabled) return;
        const focused = document.activeElement === input;
        input.disabled = true;
        // Held until the BUTTON comes up, not until the window comes back. Measured on
        // the shipping WKWebView (2026-08-14): ending the drag once is not enough — with
        // the button still down, returning to the app resumed the row, "not moving
        // smoothly and not held either". A disabled control cannot be re-acquired, so
        // the interrupted press stays dead and only a fresh press moves the value again.
        const back = (ev?: PointerEvent): void => {
          // A move that reports no button is the release this never saw: the press ended
          // somewhere the window did not hear about, and nothing else would re-arm.
          if (ev?.type === "pointermove" && ev.buttons !== 0) return;
          window.removeEventListener("pointerup", back);
          window.removeEventListener("pointercancel", back);
          window.removeEventListener("pointermove", back);
          // Undone only on the element this disabled. The row on screen may no longer be
          // that one: the same blur clears `grabbed`, so a refresh the press deferred runs
          // and rebuilds the column — and a rebuilt row carries its own disabled state,
          // which is not ours to clear. COMP's 1-knob coming on under the operator's hand
          // hands threshold / ratio / gain / knee to the device and locks those rows, so
          // re-enabling one would put a device-driven value back under the pointer.
          input.disabled = false;
          const live = this.box.querySelector<HTMLInputElement>(`input[data-dyn="${f.key}"]`) ?? input;
          if (focused && !live.disabled) live.focus();
        };
        window.addEventListener("pointerup", back);
        window.addEventListener("pointercancel", back);
        window.addEventListener("pointermove", back);
      };
      this.endDrag = ender;
    });
    ctl.append(input, val);
    // The device's push-and-turn fine grid is confirmed for a few values only (the
    // COMP makeup gain, the EQ band gains), so the field table says which (see
    // reference/work/vd/vd-params.md). The legend goes in as the row's `legend`, which
    // pins it beside the static label rather than the readout — the readout's width
    // changes with the value's digits — and orders it ahead of the row's own tag pill,
    // so a row the device takes over prints `Gain FINE Device-driven` and the legend
    // never comes and goes (which would move the label block it sits in).
    const fine = f.fineStep !== undefined;
    const row = this.armable(
      settingsRow(label, ctl, { ...opts, legend: fine ? fineTag() : undefined }),
      f.key,
      this.ctx(),
    );
    if (fine) {
      // `has-fine` stays unconditional so "legend printed" and "legend can light" are
      // one fact — the screens once printed the tag without it and the legend sat dim
      // through every gesture it describes. A locked row is excluded by the lighting
      // rules themselves (`.has-fine:not(.locked)` in style.css); only *arming* is
      // gated here, since a disabled slider must not carry the fine grid.
      row.classList.add("has-fine");
      if (!opts?.locked) optInFine(input, f.step, f.fineStep as number);
    }
    return row;
  }

  private readoutCell(lane: DynLane): HTMLElement {
    const cell = el("div", lane.kind === "gr" ? "gt-ro gr" : "gt-ro");
    const k = el("span", "k");
    k.textContent = lane.label;
    const v = el("span", "v");
    const p = el("span", "p");
    this.readouts.set(lane.key, { v, p, lastV: "", lastP: "" });
    cell.append(k, v, p);
    return cell;
  }

  // ---------------------------------------------------------------- plot

  /** Resolve the plot's theme tokens. Called on render (which a theme switch and a
   *  language switch both trigger), never per frame. */
  private readTokens(): void {
    const cs = getComputedStyle(this.box);
    const out: Record<string, string> = {};
    for (const n of PLOT_TOKENS) out[n] = cs.getPropertyValue(n).trim();
    this.plotTokens = out;
    this.plotDirty = true;
  }

  /** Plot coordinates for the current size. Cached: it depends only on the size and
   *  the descriptor, and the alternative was two fresh closures plus a spread on
   *  every frame of the loop this file otherwise keeps allocation-free. */
  private geo(w: number, h: number): DynPlotGeo {
    if (this.geoCache && this.geoCache.w === w && this.geoCache.h === h) return this.geoCache;
    return (this.geoCache = this.p().plotGeo(w, h, this.ctx()));
  }

  /** Split into a cached static layer and a live overlay. Everything but the overlay
   *  depends only on the parameters, size and theme, so at 30 fps against a 10 Hz
   *  feed redrawing it every frame was hundreds of stroked paths a second for at
   *  most 10 meaningful positions. */
  private drawPlot(): void {
    const cv = this.canvas;
    if (!cv) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // clientWidth/Height are forced layout reads, and paint() has just written
    // inline styles — so the size is measured on render and resize, not per frame.
    const { w, h } = this.plotSize;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      this.plotDirty = true;
    }
    const c = cv.getContext("2d");
    if (!c) return;

    if (this.plotDirty || !this.plotLayer) {
      this.plotLayer = this.drawPlotLayer(w, h, dpr);
      this.plotDirty = false;
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cv.width, cv.height);
    if (this.plotLayer) c.drawImage(this.plotLayer, 0, 0);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.p().drawLive?.(c, this.geo(w, h), this.readLane, this.plotTokens);
  }

  /** The static plot, rendered once per parameter / size / theme change. */
  private drawPlotLayer(w: number, h: number, dpr: number): HTMLCanvasElement {
    const layer = this.plotLayer ?? document.createElement("canvas");
    layer.width = Math.round(w * dpr);
    layer.height = Math.round(h * dpr);
    const c = layer.getContext("2d") as CanvasRenderingContext2D;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const proc = this.p();
    const geo = this.geo(w, h);
    const ctx = this.ctx();
    proc.drawAxes(c, geo, this.plotTokens, ctx);
    // The curve is clipped to the plot area, so a value past the axis leaves the frame
    // instead of lying along its edge. Structural rather than each descriptor's to
    // remember: a plot that clamps draws a response its processor does not have.
    c.save();
    c.beginPath();
    c.rect(geo.pad.l, geo.pad.t, w - geo.pad.l - geo.pad.r, h - geo.pad.t - geo.pad.b);
    c.clip();
    proc.drawCurve(c, geo, this.values(), this.plotTokens, ctx);
    c.restore();
    return layer;
  }
}

/** The font every plot's tick labels and annotations use. Beside the tokens because both
 *  are "what a plot draws with", and the canvas owner resolves both. */
export const PLOT_FONT = '9.5px "SF Mono", Menlo, Consolas, monospace';

const PLOT_TOKENS = [
  "--plot-line",
  "--plot-faint",
  "--plot-dim",
  "--plot-ink",
  "--led",
  // The pair a lit face is printed with, for the plots that fill one and then write on
  // it (the EQ's band markers). --led is the accent as a LINE here; a face that carries
  // text takes --led-face, and its ink is --on-accent-ink.
  "--led-face",
  "--on-accent-ink",
  "--gr",
  "--m-green",
  "--m-yellow",
  "--m-red",
] as const;

/** The persisted bar selection per processor, each value passed through its own bar's
 *  migration (the stored shape has changed once — see `migrateSel`). */
function loadSels(): Record<string, number> {
  const raw = loadJson<Record<string, unknown>>(SEL_STORE, {});
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    const n = migrateSel(v);
    if (n !== undefined) out[k] = n;
  }
  return out;
}

function wrap(cls: string, ...kids: HTMLElement[]): HTMLElement {
  const w = el("div", cls);
  w.append(...kids);
  return w;
}

export function channelLabel(model: DeviceModel, nodeId: string): string {
  return model.nodes.find((n: { id: string; label: string }) => n.id === nodeId)?.label ?? nodeId;
}

/** Two-line meter caption: the tap's own name over its broker meter id, matching
 *  the CONSOLE meter-point badges. */
function capLabel(label: string, meterId: number | undefined): HTMLElement {
  const cap = el("span", "gt-cap-label");
  cap.append(document.createTextNode(label), document.createElement("br"));
  const sub = el("span", "sub");
  sub.textContent = meterId === undefined ? "" : String(meterId);
  cap.append(sub);
  return cap;
}
