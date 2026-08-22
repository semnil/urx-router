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

import {
  el,
  holdAppInert,
  holdInertOnBlur,
  onInertHoldsEnd,
  settingsRow,
  settingsSection,
  sliderRow,
  wheelStep,
  wireDismiss,
} from "./dom";
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
   *  Every reduction on every screen is drawn this way: it reads better against the level
   *  it was taken off than as a column of its own. The DUCKER pairs its reduction with the
   *  KEY level rather than the output, because there the two are cause and effect — one
   *  column shows the key rising to the threshold cap while the reduction hangs from the
   *  top of the same ruler. The cost is that the shared ruler has to span the deeper of the
   *  two domains, since a merged lane cannot carry a scale of its own. */
  sameSlot?: true;
  /**
   * dB to take OFF this reduction before drawing it, which makes the BAR a different
   * quantity from the lane's own reading — a relative indication of the reduction rather
   * than the reduction. Declared, not incidental: the lane's readout goes on printing what
   * the meter reports, and the two are not meant to agree.
   *
   * It exists for a lane merged into a level column, where the two are drawn from opposite
   * ends of one ruler and a deep reduction runs into the level rising to meet it — and
   * where they overlap, neither is readable. The overlap is `in + gain` in dBFS and does
   * not depend on the reduction at all, so subtracting the processor's own gain leaves
   * `in`, at or below zero for any real signal: they never meet, with the input's own
   * headroom between them.
   *
   * A lane in a column of ITS OWN takes no offset. Nothing can run into it there, so it
   * draws the reduction itself and agrees with its readout.
   *
   * A NUMBER, not the two taps the same quantity could be measured from. The first version
   * drew `in - out`, and that is wrong to read frame by frame: the taps are separate meter
   * addresses whose frames arrive at separate instants, so the difference is of two
   * different moments — and each carries its own release, so a reduction coming OFF made
   * the bar LENGTHEN before it shortened. This one is a parameter, constant until a slider
   * moves.
   */
  grOffsetDb?: number;
  /** What the BAR is captioned, where that is not the lane's own name. A rack is one pair —
   *  into the processor and out of it — and the position is what a caption under a bar has to
   *  say; which tap it reads stays on the readout tile, which has the room for it. A lane that
   *  is neither end of the pair (the DUCKER's key, the SSMCS side chain) carries none and
   *  keeps its name. */
  caption?: string;
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
  /** The height a bank reserves for all of its faces, where the stylesheet's own number is
   *  not enough. Declared by the binding, like `readoutCols`, because it is a property of
   *  what the node HOLDS: a guitar amp's panel is eleven rows and overflows the shared
   *  reserve, and raising that reserve would grow every other bank's faces with it.
   *  Absent = the stylesheet's number. Every face of one bank must answer the same value,
   *  or the modal resizes between them, which is what the reserve exists to stop. */
  faceReserve?: number;
  /** Put the parameters on the left and the meters in a narrow column on the right,
   *  instead of the display column first. Declared by the binding rather than by the
   *  descriptor because it is a property of what this node HOLDS: the INS FX screen
   *  reverses for a guitar amp, whose panel is a grid of a dozen controls and whose
   *  display is a level rack and nothing else, and keeps the ordinary order for the
   *  companders, whose display is the point. */
  paramsFirst?: true;
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
  items: readonly DynBarItem[];
  /** Nothing is selected and nothing can be: the choice does not belong to the operator
   *  right now (the EQ's bands are the device's while 1-knob is on). The items keep their
   *  space — hiding them outright would shorten the heading they sit in. */
  inert?: boolean;
}

/** One segment. Pressing it selects `sel` on the current processor, or moves to `face` and
 *  selects `sel` there — which is what lets one bar stand in front of a whole bank instead
 *  of a bar per face plus a second bar to choose between them. */
export interface DynBarItem {
  label: string;
  id: string;
  face?: DynProcessor;
  /** The segment to arrive on. Stated rather than taken from the item's own index: two
   *  items can name one face, and then the index is the BAR's position rather than the
   *  face's. */
  sel: number;
}

/** What a plot offers a press. `count` is what the keyboard path needs — a canvas is one
 *  focus stop, so the arrow keys move within it, and a marker reachable only by pointer is
 *  a control half the operators cannot use. Zero = nothing is selectable right now (the
 *  EQ's bands while 1-knob drives them), which also takes the canvas back out of the tab
 *  order rather than leaving a focus stop that does nothing. */
export interface DynPlotPicks {
  count: number;
  hit: (c: CanvasRenderingContext2D, g: DynPlotGeo, at: { x: number; y: number }) => number | null;
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
  /** Rows placed immediately before the slider whose key names them, for a panel whose
   *  fields fall into groups the device reads in that order. The SSMCS COMP face is the
   *  one: its side-chain filter's three sliders follow the compressor's, and the Side
   *  Chain toggle that opens them is what tells the reader where one group ends. `lead`
   *  would put that toggle above rows it does not govern. */
  before?: Record<string, HTMLElement[]>;
}

export interface DynProcessor {
  /** Identity: the segmented bar's persistence key, and the registry's own. */
  key: string;
  /** The screen's own name. Takes the context because one descriptor can stand for more
   *  than one thing: the INS FX screen shows whichever effect the node holds, and a title
   *  that could not read the plan would name the slot instead of what is in it. */
  title: (m: Messages, ctx: DynCtx) => string;
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
   *  bar with no buttons would name a choice that does not exist.
   *
   *  It may also answer nothing for a PARTICULAR node, which is what a descriptor
   *  standing for more than one thing needs: the INS FX screen shows a two-face bank on
   *  a guitar amp and a single face on a compander, and the reserve the host puts in a
   *  bar's place is the same either way. */
  bar?: (ctx: DynCtx) => DynBar | undefined;
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
  fieldLabel?: (f: DynField, m: Messages, ctx: DynCtx) => string | undefined;
  /** The display text for a field whose value is not readable from the number alone —
   *  a raw broker integer, which reaches a millisecond, a ratio or a hertz only through
   *  a device curve. Undefined falls back to the field's unit, which is what the one
   *  raw value that IS its own display (the morphing position) takes. */
  fieldText?: (f: DynField, v: number, ctx: DynCtx) => string | undefined;
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
  display: (parts: DynParts) => HTMLElement;
  /** The three below belong to the plot, and a display that does not call `parts.plot()`
   *  omits all three — the INS FX screen does: a guitar amp's frequency response and a
   *  pitch tracker are not derivable from the parameters, so a curve there would be an
   *  invention. Nothing is drawn without a canvas, so the omission is inert rather than a
   *  blank frame; `DynPlotProcessor` is what keeps the three together wherever one of them
   *  is supplied. */
  plotGeo?: (w: number, h: number, ctx: DynCtx) => DynPlotGeo;
  /** The plot's frame: grid, tick labels, axis names, any reference line. Drawn
   *  unclipped, because the tick labels belong in the gutters `geo.pad` reserves. */
  drawAxes?: (c: CanvasRenderingContext2D, geo: DynPlotGeo, tok: Record<string, string>, ctx: DynCtx) => void;
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
  drawCurve?: (
    c: CanvasRenderingContext2D,
    geo: DynPlotGeo,
    v: DynValues,
    tok: Record<string, string>,
    ctx: DynCtx,
  ) => void;
  /** The live overlay (a dot at the current level), redrawn per frame that moves it.
   *  `read` answers with a lane's folded reading, or null with no feed. */
  /** Whether `drawLive` draws anything on the segment showing. A descriptor whose plot IS
   *  the overlay's subject on every segment omits it; one whose bar offers a segment
   *  showing something else on the same canvas answers false there, and the paint loop
   *  then leaves the canvas alone rather than clearing and blitting it for no pixel
   *  change. Read once per render, not per frame. */
  liveOn?: (ctx: DynCtx) => boolean;
  drawLive?: (
    c: CanvasRenderingContext2D,
    geo: DynPlotGeo,
    read: (laneKey: string) => number | null,
    tok: Record<string, string>,
    ctx: DynCtx,
  ) => void;
  /** A press anywhere on the plot sets the value its lane carries a cap for, whose domain
   *  must therefore be the plot's x axis. Opt in only where the plot carries one editable
   *  value: with several, a press has to guess which one was meant, and one that missed a
   *  grip fell through to this drag (pressing COMP's gain grip moved the threshold). */
  plotDragsCap?: true;
  /** A press on the plot selects a segment — what the EQ screens' band markers are. The
   *  descriptor answers where the pickable things are, because only it knows what it drew.
   *
   *  It cannot coexist with `plotDragsCap`: one takes a press anywhere and the other takes
   *  it only on a target, so a miss would have to mean two things at once. */
  plotPicks?: (ctx: DynCtx) => DynPlotPicks;
  /**
   * This processor is one face of a bank: more than the screen can show at once, moved
   * between by the bar's own segments without closing, so the modal is not rebuilt and the
   * meter slot is not handed back and taken again for what is one continuous piece of work
   * on one channel. The host reserves one height for the whole bank off this.
   *
   * Absent for every processor that is a whole processor: GATE, COMP, the 4-band EQ and
   * DUCKER are separate things tuned at separate times, and closing one to open another
   * is what that is.
   *
   * Which faces there are is `bar`'s own item list — the one place they are named, since
   * that is what the operator selects them from.
   */
  banked?: true;
  /**
   * What this bank is a bank OF, where that can change under an open screen. The host
   * remembers it at `open` and compares it on every refresh; when it moves, the screen
   * goes back to the descriptor it was opened with and its first segment before it
   * re-binds.
   *
   * Only the INS FX screen has one. Its faces belong to the effect the node HOLDS, and a
   * device follow can replace that effect with one whose faces are different or with none
   * at all — and neither of the two things the host does on its own is right there. A
   * face whose `bind` answers null CLOSES the screen, which is correct for a bank taken
   * away and wrong for one replaced; and a `sel` nothing resets would carry a guitar
   * amp's CAB segment onto a compander that has no second face.
   */
  bankIdentity?: (ctx: DynCtx) => string;
}

/** A processor whose display carries a plot: the three drawing hooks are required, so
 *  everything holding one of these reaches them without a null check. Every descriptor
 *  that calls `parts.plot()` is declared as one, which is what keeps the optionality on
 *  `DynProcessor` from spreading into every caller. */
export type DynPlotProcessor = DynProcessor & Required<Pick<DynProcessor, "plotGeo" | "drawAxes" | "drawCurve">>;

/** Peak hold, in notify frames (100 ms each). Nothing on the device sets this —
 *  the level meters hold in hardware and GR holds not at all — so it is a UI
 *  choice: long enough to read a value that arrived while looking elsewhere. */
const PEAK_HOLD_FRAMES = 12;

/** Repaint cap. The feed is 10 Hz; this only bounds how soon a new frame reaches
 *  the screen, since no interpolation is applied between frames. */
const FRAME_MS = 1000 / 30;

/** Readout text is refreshed every Nth frame (~6 Hz), the console's rate: setting
 *  textContent relayouts the cell even when the string is unchanged, and the feed
 *  cannot deliver more than 10 new values a second anyway. */
const READOUT_EVERY = 5;

/** Readout tile columns that are not the stylesheet's own default of three. The class is
 *  what carries the count, so a descriptor asking for a number nothing styles gets the
 *  default rather than a grid with no columns. */
/** Readout tiles per row, where a descriptor asks for nothing else. Three is what most
 *  racks carry; the stylesheet's own fallback is the same number, and both are stated once. */
const READOUT_COLS_DEFAULT = 3;

/** Persisted bar selection, per processor. Its own key, like `urx-sends-open` and
 *  `urx-metertap`: this is per-surface UI state, not a Preferences setting. */
const SEL_STORE = "urx-dyn-display2";

export interface DynScreenHooks {
  getModel: () => DeviceModel;
  getPlan: () => Plan;
  isLive: () => boolean;
  /** The shared plan-edit funnel (the inspector's own path): flags the plan dirty
   *  and mirrors to the device when live. */
  onUpdateNodeParams: (id: string, patch: NodeParams) => void;
  /** Hand this session's one meter subscription over / give it back. */
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
  /** Whether the segment on screen has a live overlay at all. Resolved on render rather
   *  than per frame: `sel` and the processor only move through a path that re-renders, so
   *  a cached answer cannot go stale, and the paint loop then costs no `ctx()`. */
  private liveOverlay = false;
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
  private readoutCols = READOUT_COLS_DEFAULT;
  private paramsFirst = false;
  private faceReserve: number | null = null;
  /** The descriptor `open` was called with, and what its bank was a bank of at the time.
   *  A bank whose identity moves goes back to both. */
  private entryProc: DynProcessor | null = null;
  private bankId = "";
  private unsub: (() => void) | null = null;
  private raf = 0;
  /** The address set the current registration covers, and a counter that supersedes
   *  one still in flight. `addrs()` is not constant for the session — the DUCKER's KEY
   *  lane reads the tap its source channel's Rec Point names, so a follow, an undo or
   *  a plan load can move it — and a registration that outlives the lanes streams an
   *  address nothing reads while the lane it belongs to sits at the floor. */
  private subSig = "";
  private subGen = 0;
  /** The registrations, one after another. A session holds one meter subscription and
   *  `vd_meters_subscribe` replaces it silently, so overlapping ones must not be in
   *  flight together. */
  private subChain: Promise<void> = Promise.resolve();
  private subBusy = false;

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
  /** How to end the drag currently in flight, for the ends that carry no pointer event
   *  of their own. Set by the gesture, cleared by whichever end runs first. */
  private endDrag: (() => void) | null = null;

  constructor(private readonly hooks: DynScreenHooks) {
    this.scrim = document.getElementById("dyn-screen-modal") as HTMLElement;
    this.box = document.getElementById("dyn-screen-box") as HTMLElement;
    // The box itself outlives every rebuild, so one listener covers whatever it
    // holds. Release is watched on the window because a drag routinely ends with
    // the pointer outside the control, and outside the modal.
    this.box.addEventListener("pointerdown", () => {
      this.grabbed = true;
    });
    const release = (): void => {
      this.endDrag?.();
      if (!this.grabbed) return;
      this.grabbed = false;
      if (!this.refreshPending) return;
      this.refreshPending = false;
      this.refresh();
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    // The third registration of the SAME release, so a repaint the press deferred is also
    // due when the app-wide holds end — which is a signal this screen has no pointer event
    // for, since a hold is released by the window coming back as well as by a pointer.
    // Whichever of the three arrives first does the work; the others find `grabbed` already
    // cleared and return.
    onInertHoldsEnd(release);
    // A window blur is the third end. The two registered above carry a pointer event;
    // this one carries none, so it needs the ender the gesture left behind. Measured
    // 2026-08-14 on Chromium and on the shipping WKWebView: losing the foreground with
    // the button down fires `blur`, fires no `pointercancel` and keeps the capture — so
    // the cap and plot drags below stayed armed, with that surviving capture routing
    // every later move straight to them. console.ts's trackDrag carries the readings.
    // Not `capture: true`: that would also catch the cap's and the canvas's own element
    // blur, which happens whenever focus moves inside the screen.
    //
    // The blur ends the GESTURES this view runs (the cap, the plot) but does not clear
    // `grabbed`: the press is still in flight, and a rebuild under it would hand the
    // still-held pointer a live control — which is the state `holdInertOnBlur` exists to
    // prevent for the value rows. The deferral therefore lasts as long as the press, which
    // is what it meant before the blur was added as an end at all.
    window.addEventListener("blur", () => this.endDrag?.());
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

  /** Open one processor for one node. The NODE is what the screen is scoped to and stays
   *  on: there is no in-screen channel switch, because a channel's controls are what a
   *  screen is opened from. The processor can move between the faces of one bank
   *  (`faces`), and a lane's tap can move under an open screen (the DUCKER's KEY), so
   *  the subscribed address set is compared and re-taken in `refresh` rather than being
   *  fixed for the session. */
  open(proc: DynProcessor, nodeId: string): void {
    const sel = proc.persistSel ? (this.sels[proc.key] ?? 0) : 0;
    const bound = proc.bind({ ...this.ctx(), nodeId, sel });
    if (!bound) return;
    this.proc = proc;
    this.nodeId = nodeId;
    this.sel = sel;
    this.entryProc = proc;
    this.bankId = proc.bankIdentity?.({ ...this.ctx(), nodeId, sel }) ?? "";
    this.fields = bound.fields;
    this.lanes = bound.lanes;
    this.readoutCols = bound.readoutCols ?? READOUT_COLS_DEFAULT;
    this.paramsFirst = bound.paramsFirst === true;
    this.faceReserve = bound.faceReserve ?? null;
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
    // What the bank is a bank OF can change under an open screen — the INS FX screen's
    // faces belong to the effect the node holds. Decided before `rebind`, because the
    // face on screen may not exist on the new one and `rebind` would read that as the
    // processor being gone and close a screen that should have re-bound.
    this.syncBank();
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
    this.resubscribeIfMoved();
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

  /** Go back to the descriptor the screen was opened with, and its first segment, when the
   *  bank stopped being a bank of the same thing. The peak holds go with it: a lane key
   *  means a different tap under another effect, and a hold carried across would print one
   *  tap's peak under another's caption. */
  private syncBank(): void {
    if (!this.proc?.bankIdentity || !this.entryProc) return;
    const id = this.proc.bankIdentity(this.ctx());
    if (id === this.bankId) return;
    this.bankId = id;
    this.proc = this.entryProc;
    this.sel = 0;
    this.peaks.clear();
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
    this.readoutCols = bound.readoutCols ?? READOUT_COLS_DEFAULT;
    this.paramsFirst = bound.paramsFirst === true;
    this.faceReserve = bound.faceReserve ?? null;
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
      if (out) setLevelText(out, this.valueText(f, v));
    }
    this.syncCap();
  }

  /** What a field's value reads as. The descriptor gets first refusal, because a raw
   *  broker integer becomes a millisecond or a hertz only through a device curve; what
   *  it declines falls through to the field's own unit. */
  private valueText(f: DynField, v: number): string {
    return this.p().fieldText?.(f, v, this.ctx()) ?? dynValueText(f, v);
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
    // Take the subscription before making it: a subscribe replaces the session's
    // previous one silently, so the console must be told rather than discover it.
    this.hooks.releaseMeters();
    const grLanes = this.lanes.filter((l) => l.kind === "gr" && l.gr);
    const addrs = this.addrs();
    const register = (): Promise<void> => {
      // Superseded before this one's turn came — another face, another band, or a close.
      // Not registered at all, rather than registered and immediately taken down.
      if (gen !== this.subGen) return Promise.resolve();
      return subscribeMeters(this.store, addrs, (msg) => {
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
        .catch((e: unknown) => {
          // A superseded registration's failure belongs to nothing on screen, and
          // `onMeterError` ends the Live session — so a face left behind must not be able
          // to close the session that the face now open is being served by.
          if (gen === this.subGen) this.hooks.onMeterError(e instanceof Error ? e.message : String(e));
        });
    };
    // One registration in flight at a time. A session holds ONE meter subscription — the
    // control worker unregisters its whole address set and registers the new one on every
    // subscribe — so two overlapping ones land in whatever order the transport delivers
    // them rather than the order the faces were pressed: the set left registered is the
    // face that was left, and this screen's handle then unsubscribes addresses the later
    // call had already replaced. The meters stop with nothing reporting a failure. Chained
    // on settlement, not on success, so one refusal does not strand it.
    // With nothing in flight it runs here rather than a microtask later: the slot is free,
    // and the queue exists to order overlapping registrations, not to delay the first.
    const run = (): Promise<void> => {
      this.subBusy = true;
      return register().finally(() => {
        this.subBusy = false;
      });
    };
    this.subChain = this.subBusy ? this.subChain.then(run, run) : run();

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
    return clamp01(Math.abs(db) / (HI_DB - p.loDb));
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
      // dB off what the BAR is drawn from, where that is not the reading itself. The peak
      // is shortened too, or it would hold at a depth the bar never reaches; the readout
      // below still prints the reduction the meter reported.
      const off = lane.grOffsetDb ?? 0;
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
        const bar = db === null || !off ? db : Math.min(0, db + off);
        const pk = p.db === null || !off ? p.db : Math.min(0, p.db + off);
        this.setBar(lane, i, bar === null ? 0 : this.laneFrac(lane, bar), pk === null ? 0 : this.laneFrac(lane, pk));
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
    // Only a SEGMENT with an overlay has anything to redraw when a reading moves; the
    // EQ's plot is static and the side-chain segment's is frequency, and repainting either
    // per feed frame was ~10 full-canvas blits a second for no pixel change.
    if (this.canvas && (this.plotDirty || (this.liveOverlay && this.liveDirty()))) this.drawPlot();
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
    this.liveOverlay = !!proc.drawLive && (proc.liveOn?.(this.ctx()) ?? true);
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
    name.textContent = proc.title(m, this.ctx());
    title.append(ch, name);

    const grid = el("div", "prefs-grid");
    // A bank of faces reserves one height for all of them. Its faces carry different row
    // counts and different displays, so without the reserve the modal resizes under the
    // pointer on every press of the segment that moves between them. What the reserve
    // costs is blank space below the shorter faces; `.gt-faced`'s `min-height` in
    // style.css is where the measurement lives, along with what it yields to.
    if (proc.banked) grid.classList.add("gt-faced");
    if (this.faceReserve !== null) grid.style.setProperty("--gt-face-min", `${this.faceReserve}px`);
    // A reversed panel is one class plus the DOM order, not a second layout: the two
    // columns are what they always were, and only which of them is the flexible one moves.
    const display = this.displayColumn(proc);
    const controls = this.controlColumn(m);
    if (this.paramsFirst) grid.classList.add("gt-paramsleft");
    grid.append(...(this.paramsFirst ? [controls, display] : [display, controls]));

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
    // Every display starts at the same height, whether its processor carries a bar or not.
    // Across screens that is what keeps the plot and the lane rack in one place as the
    // operator moves between GATE, COMP, DUCKER and the bank. Reserved through the same
    // builder rather than with a margin, so the space is whatever a bar that does get
    // drawn actually occupies — a constant would be measured once and then track nothing.
    col.append(bar ? this.displayBar(bar) : this.reservedBar(proc, ctx));
    col.append(proc.display({ lanes: () => this.laneRack(), plot: () => this.plotBox() }));
    col.append(this.hintLine(proc, ctx));
    return col;
  }

  /** The display bar's space, with nothing in it. `visibility: hidden` rather than a
   *  height: it keeps the box and takes the heading and the button out of the tab order
   *  and the accessibility tree, which is what an empty reserve has to do. */
  private reservedBar(proc: DynProcessor, ctx: DynCtx): HTMLElement {
    const title = proc.title(ctx.m, ctx);
    const sec = this.displayBar({
      label: title,
      items: [{ label: title, id: "", sel: 0 }],
      inert: true,
    });
    sec.classList.add("gt-reserved");
    return sec;
  }

  /**
   * Move to a sibling face. The screen stays open on the same node, so the modal, the
   * app-wide inert hold and the meter registration all survive; what changes is which
   * descriptor answers, and with it the fields, the lanes and the address set.
   *
   * `refresh` does the rest — it re-binds, re-subscribes when the addresses moved, and
   * rebuilds — so the address comparison is not written a second time here, and neither
   * is the verdict on a face that will not bind: `rebind` CLOSES the screen there, which
   * is the position it already takes when a follow switches the bank away underneath one.
   * Answering here instead would leave a pressed segment doing nothing at all. The peak
   * holds go, because a lane key means a different tap on the next face and a hold carried
   * across would print one tap's peak under another's caption.
   *
   * `sel` is the segment to arrive on, where the bar names one — two of its items reach the
   * same face and differ only in this. Without one the face takes what it always took: the
   * remembered selection, or the first.
   */
  private showFace(next: DynProcessor, sel?: number): void {
    if (!this.proc || next === this.proc) return;
    this.proc = next;
    this.sel = sel ?? (next.persistSel ? (this.sels[next.key] ?? 0) : 0);
    this.peaks.clear();
    this.refresh();
  }

  /**
   * Press a segmented bar's button. Both bars rebuild the DOM they are part of, so the
   * button that was pressed is replaced and `document.activeElement` falls back to the
   * body — a keyboard user selecting a face or a band lands nowhere and has to tab in
   * from the top of the dialog again. Focus goes back onto the NEW button carrying the
   * same id, and only when the press came from a focused button, so a mouse press is
   * left as it was.
   */
  private pressSegment(id: string, act: () => void): void {
    const refocus = document.activeElement instanceof HTMLElement && document.activeElement.id === id;
    act();
    if (refocus) document.getElementById(id)?.focus({ preventScroll: true });
  }

  /**
   * Which segment reads as pressed. A bar whose items stand in front of a whole bank is
   * asking about the face AND the selection within it, and the host is the only place that
   * knows both. The fallback to the face alone is what a face whose selection is something
   * else entirely needs — the EQ face's `sel` is a band, so no item's `sel` ever equals it.
   */
  private currentSegment(bar: DynBar): number {
    if (!bar.items.some((it) => it.face)) return this.sel;
    const exact = bar.items.findIndex((it) => it.face === this.proc && it.sel === this.sel);
    return exact >= 0 ? exact : bar.items.findIndex((it) => it.face === this.proc);
  }

  /** The segmented bar over the display, in the heading of the section it sits in. */
  private displayBar(bar: DynBar): HTMLElement {
    const sec = settingsSection(bar.label);
    const h = sec.firstElementChild as HTMLElement;
    const seg = el("span", "udk-banks gt-modes");
    const current = this.currentSegment(bar);
    for (const [i, item] of bar.items.entries()) {
      const b = el("button", "") as HTMLButtonElement;
      b.id = item.id;
      b.textContent = item.label;
      b.setAttribute("aria-pressed", String(!bar.inert && current === i));
      if (bar.inert) b.disabled = true;
      else b.addEventListener("click", () => this.pressSegment(item.id, () => this.pickSegment(item)));
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
   *  the pointer. `gt-note` reserves a fixed height, which is what keeps a longer string
   *  from silently reintroducing the jump — and from being cut, which one line did on any
   *  window narrower than a wide desktop (E2E pins both). Two lines by default; a bank of
   *  faces takes three, since its line has three controls to name and the reserve above
   *  the grid already leaves that face the room (`style.css`, `.gt-faced .gt-note`). */
  private hintLine(proc: DynProcessor, ctx: DynCtx): HTMLElement {
    const hint = el("p", "gt-note");
    const text = proc.hint?.(ctx);
    if (text) hint.textContent = text;
    else hint.setAttribute("aria-hidden", "true");
    return hint;
  }

  /** A segment was pressed. An item naming a face moves to it and arrives on the segment
   *  the item names; one that does not is a selection within the face on screen. Pressing
   *  the face already on screen falls through to the selection, which is what makes COMP
   *  and Side Chain switch between each other rather than do nothing. */
  private pickSegment(item: DynBarItem): void {
    if (item.face && item.face !== this.proc) this.showFace(item.face, item.sel);
    else this.select(item.sel);
  }

  /**
   * The segmented bar picked something else. It can change the binding (the EQ's fields
   * differ per band — only LOW and HIGH carry a filter type), so it rebinds before
   * rebuilding.
   *
   * A segment can also change the LANES, and then the addresses: the SSMCS bank's COMP face
   * carries the side-chain tap on its filter segment and not on its curve. So the same
   * registration check `refresh` makes is made here — without it the lane a segment just
   * put on screen asks the store for an address the broker was never told to stream, and
   * shows a floor bar and a "—" for a signal that is present.
   */
  private select(i: number): void {
    if (i === this.sel || !this.proc) return;
    this.sel = i;
    if (this.proc.persistSel) {
      this.sels = { ...this.sels, [this.proc.key]: i };
      saveJson(SEL_STORE, this.sels);
    }
    this.rebuild();
  }

  /** Re-register the meters when the lane set's addresses no longer match what the broker
   *  was asked for. `open()` does not go through it — it registers unconditionally right
   *  after its first bind — so every OTHER path that can move the addresses does. */
  private resubscribeIfMoved(): void {
    if (!this.hooks.isLive() || this.addrSig() === this.subSig) return;
    this.stopMeters();
    this.startMeters();
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
    // An empty caption of the same height as its neighbours, so the tick column's grid
    // row matches the slots' and a tick lines up with a level.
    //
    // The space is non-breaking on purpose: an ordinary one collapses to nothing, the
    // element then generates no line box, and `.gt-lcol`'s `1fr auto` hands the difference
    // to the scale — it stands taller than the slot beside it, the two share a top edge and
    // drift apart linearly down to the floor, and a tick points at a level it is not level
    // with. Measured at 12.75px of drift back when the caption was two lines.
    const spacer = el("span", "gt-cap-label");
    spacer.setAttribute("aria-hidden", "true");
    spacer.textContent = "\u00a0";
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

  /** One lane: its bars, its caption and its cap if it carries one. Returns the slot as
   *  well, so a lane that
   *  merges into this one can be given it. */
  private laneColumn(lane: DynLane): { el: HTMLElement; slot: HTMLElement } {
    // Never a reduction: every GR lane sets `sameSlot`, so `laneRack` draws it into the
    // column before it and this builder is only ever asked for a level.
    const sides = laneSideCount(lane);
    const col = el("div", "gt-lcol");
    const slot = el("div", `gt-slot${sides === 2 ? " stereo" : ""}`);
    this.laneBars(lane, slot);
    // The cap goes BESIDE the slot, not in it. The slot clips — its level bar and its shade
    // have to stay inside the rounded frame — and the cap's focus ring reaches past the cap
    // on every side, so inside the slot the ring is drawn and never shown. The wrapper
    // carries the slot's own box, so the cap's percentage position is unchanged.
    const head = lane.cap ? el("div", "gt-capwrap") : slot;
    if (head !== slot) head.append(slot, this.capControl(head));
    col.append(head, capLabel(lane.caption ?? lane.label));
    return { el: col, slot };
  }

  /** A value as a fader cap on its own meter. The one gesture the lane rack exists
   *  for — it works because the value's dB and the meter's dBFS are the same
   *  coordinate. */
  private capControl(track: HTMLElement): HTMLElement {
    const cap = el("div", "gt-cap");
    cap.id = "dyn-threshold-cap";
    cap.tabIndex = 0;
    cap.setAttribute("role", "slider");
    const field = this.capField();
    const m = t();
    cap.setAttribute(
      "aria-label",
      (field && this.p().fieldLabel?.(field, m, this.ctx())) ??
        (m.inspector.dyn as Record<string, string>)[this.capKey] ??
        "",
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
      const r = (rect ??= track.getBoundingClientRect());
      this.setCapFromFrac(1 - (clientY - r.top) / r.height);
    };
    let dragging = false;
    let pointer: number | null = null;
    cap.addEventListener("pointerdown", (e) => {
      cap.setPointerCapture(e.pointerId);
      rect = track.getBoundingClientRect();
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
    // A press on the track jumps the cap, matching the console faders. On the wrapper rather
    // than on the meter, so the strip either side of the cap answers a press the same way the
    // meter does — the cap is the wrapper's child and the slot's sibling.
    track.addEventListener("pointerdown", (e) => {
      if (e.target === cap) return;
      rect = track.getBoundingClientRect();
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

    const picks = this.p().plotPicks?.(this.ctx());
    if (picks) this.wirePlotPicks(cv, picks);

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

  /**
   * Make the plot's own targets selectable, by pointer and by keyboard.
   *
   * The keyboard half is not a nicety: these targets replaced a segmented bar, and a
   * segmented bar is operable from the keyboard. A canvas is a single focus stop, so the
   * arrow keys step within it and Home / End go to the ends — the same keys the bar's own
   * buttons answer. With nothing selectable the canvas leaves the tab order rather than
   * standing in it as a stop that does nothing.
   */
  private wirePlotPicks(cv: HTMLCanvasElement, picks: DynPlotPicks): void {
    if (picks.count <= 0) return;
    cv.tabIndex = 0;
    cv.classList.add("gt-pickplot");
    // Through `pressSegment` for the same reason the bar's buttons are: selecting rebuilds
    // the column, so the canvas the key was pressed on is replaced and focus falls to the
    // body — a keyboard user would land nowhere after one arrow press.
    const go = (i: number): void => {
      const next = Math.min(picks.count - 1, Math.max(0, i));
      if (next !== this.sel) this.pressSegment(cv.id, () => this.select(next));
    };
    cv.addEventListener("click", (e) => {
      const g = this.geoCache;
      const c = cv.getContext("2d");
      if (!g || !c) return;
      const i = picks.hit(c, g, { x: e.offsetX, y: e.offsetY });
      if (i !== null) go(i);
    });
    cv.addEventListener("keydown", (e) => {
      const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (step !== undefined) go(this.sel + step);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(picks.count - 1);
      else return;
      e.preventDefault();
    });
  }

  private controlColumn(m: Messages): HTMLElement {
    const g = m.dynTuning;
    const col = el("div", "prefs-col");
    const proc = this.p();
    const ctx = this.ctx();

    const params = settingsSection(g.parameters, proc.paramsTag?.(ctx));
    const labels = m.inspector.dyn as Record<string, string>;
    const label = (f: DynField): string => proc.fieldLabel?.(f, m, ctx) ?? labels[f.key] ?? f.key;
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
    // A `before` entry names the field it goes in front of, and a binding does not always
    // carry that field — reordering or renaming one is enough. Dropping the rows silently
    // would take a processor's only knee selector off the panel with nothing to see, so
    // what no field claimed is appended instead.
    const unclaimed = new Set(Object.keys(extra?.before ?? {}));
    for (const f of this.fields) {
      const before = extra?.before?.[f.key];
      if (before) {
        unclaimed.delete(f.key);
        params.append(...before);
      }
      params.append(this.paramRow(f, label(f), value(f.key), this.states.get(f.key)));
    }
    for (const key of unclaimed) params.append(...(extra?.before?.[key] ?? []));
    if (extra?.tail) params.append(...extra.tail);

    const ro = settingsSection(g.readouts);
    const cells = el("div", "gt-readouts");
    // The count reaches the stylesheet as a VALUE rather than as a class per count, so a
    // descriptor can ask for any number and nothing silently answers with three.
    if (this.readoutCols !== READOUT_COLS_DEFAULT) {
      cells.style.setProperty("--gt-ro-cols", String(this.readoutCols));
    }
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
    // A rebind can move the lane set, and then the addresses: the SSMCS bank's COMP face
    // carries the side-chain tap on its filter segment and not on its curve. Without this
    // the lane a rebuild just put on screen asks the store for an address the broker was
    // never told to stream, and shows a floor bar and a "—" for a signal that is present.
    this.resubscribeIfMoved();
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
      const text = this.valueText(f, v);
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
    // Every native range in the app ends its drag at a window blur and stays inert until
    // the press is over or the window comes back; `holdInertOnBlur` carries the treatment
    // and the measurements. This screen's own half is the row named below: the blur leaves
    // `grabbed` set, since the press is still in flight, so the refresh it deferred waits
    // for the first release to arrive — a pointer one, or the end of the app-wide holds,
    // which the window coming back also produces. By then a rebuild may have replaced this
    // element, so `live` is what the hold disables and what it gives focus back to, and
    // both reach the row that is on screen rather than the one the gesture started on.
    holdInertOnBlur(input, { live: () => this.box.querySelector<HTMLInputElement>(`input[data-dyn="${f.key}"]`) });
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
  private geo(w: number, h: number): DynPlotGeo | null {
    if (this.geoCache && this.geoCache.w === w && this.geoCache.h === h) return this.geoCache;
    const geo = this.p().plotGeo?.(w, h, this.ctx());
    return geo ? (this.geoCache = geo) : null;
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
    const geo = this.geo(w, h);
    if (geo) this.p().drawLive?.(c, geo, this.readLane, this.plotTokens, this.ctx());
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
    if (!geo) return layer;
    proc.drawAxes?.(c, geo, this.plotTokens, ctx);
    // The curve is clipped to the plot area, so a value past the axis leaves the frame
    // instead of lying along its edge. Structural rather than each descriptor's to
    // remember: a plot that clamps draws a response its processor does not have.
    c.save();
    c.beginPath();
    c.rect(geo.pad.l, geo.pad.t, w - geo.pad.l - geo.pad.r, h - geo.pad.t - geo.pad.b);
    c.clip();
    proc.drawCurve?.(c, geo, this.values(), this.plotTokens, ctx);
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

/** The persisted bar selection per processor. A stored value is a segment INDEX, so it
 *  means whatever that bar's item at that position means: renumbering a bar's segments
 *  takes a new store key, since an old index and a new one are indistinguishable. */
function loadSels(): Record<string, number> {
  const raw = loadJson<Record<string, unknown>>(SEL_STORE, {});
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "number") out[k] = v;
  }
  return out;
}

export function channelLabel(model: DeviceModel, nodeId: string): string {
  return model.nodes.find((n: { id: string; label: string }) => n.id === nodeId)?.label ?? nodeId;
}

/** A lane's caption: the tap's own name. The broker meter id used to be printed under it
 *  in a second line, and is not any more — it is an address, of no use to an operator, and
 *  the tick column's spacer has to match this element's height. */
function capLabel(label: string): HTMLElement {
  const cap = el("span", "gt-cap-label");
  cap.textContent = label;
  return cap;
}
