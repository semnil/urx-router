// Dynamics tuning screen: one processor's parameters beside the meter taps that
// show what they are doing. GATE and COMP are the two built on it today; DUCKER
// and the insert-FX dynamics have gain-reduction meters of their own and fit the
// same shape (see docs/{en,ja}/dynamics-tuning.md).
//
// What varies between processors lives in a `DynProcessor` — its taps, its
// parameter fields, its transfer plot and the handles on it — and is selected per
// open() rather than per instance, because both screens share one modal host and
// two instances would fight over its DOM.
//
// Two display modes over one control set. LADDER is the three taps on a shared
// dB ruler — linear in dB over exactly the threshold's domain, so a cap's position
// and the threshold value stay proportional. CURVE swaps in the static transfer
// plot. They are alternatives, not layers: each owns the column.
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
// The broker has a single meter subscription slot process-wide (a subscribe
// replaces the previous one and the unsubscribe takes no address), so this screen
// takes the slot for its three addresses while open and hands it back on close.

import { el, settingsRow, settingsSection, wheelStep, wireDismiss } from "./dom";
import { fineTag, optInFine } from "./fine";
import { setLevelText } from "./glyph";
import { t } from "../i18n";
import type { Messages } from "../i18n/en";
import {
  decodeGrDb,
  grAddr,
  GR_FLOOR_DB,
  METER_GREEN_TOP_DB,
  METER_YELLOW_TOP_DB,
  MeterStore,
  subscribeMeters,
  tapFor,
} from "../core/meters";
import type { GrKind, MeterTap } from "../core/meters";
import { channelDynamics, dynValueText, formatDyn } from "../core/control/translate";
import type { ChannelDynamics, DynField } from "../core/control/translate";
import { COMP_EQ_COMP_FIRST } from "../core/control/params";
import type { DeviceModel } from "../models/types";
import type { NodeParams, Plan } from "../core/plan";
import { loadJson, saveJson } from "../core/storage";

/** Top of both axes: a channel meter cannot read above 0 dBFS. */
export const HI_DB = 0;

export const CURVE_PAD = { l: 44, r: 14, t: 14, b: 28 };

/** Plot coordinates for a processor's transfer curve. The input axis spans the
 *  threshold's own domain; the output axis is the processor's to choose, because
 *  what has to stay on scale differs (a gate's closed shelf runs far below the
 *  input floor, a compressor's makeup runs above it). */
export interface DynCurveGeo {
  w: number;
  h: number;
  px: (db: number) => number;
  py: (db: number) => number;
}

/** Read a parameter (falling back to the field table's own default) and clamp a
 *  candidate value to that field's range. Handed to the processor so a curve and
 *  its handles cannot disagree with the sliders about either. */
export interface DynValues {
  get: (key: string) => number;
  clamp: (key: string, v: number) => number;
}

/** A grip on the transfer curve. The device's own COMP screen is edited this way
 *  (T / R / G dragged on the graph), and the gate's threshold is the same gesture
 *  with one grip. Positions are in dB, so hit-testing happens in plot space. */
export interface DynHandle {
  id: string;
  label: string;
  /** Input-axis position. */
  x: number;
  /** Output-axis position. */
  y: number;
  /** Values for a drag to (inDb, outDb); null when this pointer position sets
   *  nothing (out of range for the grip). */
  drag: (inDb: number, outDb: number) => Record<string, number> | null;
}

export interface DynRowCtx {
  m: Messages;
  vals: Record<string, unknown>;
  set: (patch: Record<string, number | boolean>) => void;
}

/** Extra rows a processor renders beside its sliders, in the device's own read
 *  order: `lead` above them (the mode switches), `tail` below (the selectors). */
export interface DynRows {
  lead?: HTMLElement[];
  tail?: HTMLElement[];
}

export interface DynProcessor {
  /** `nodeParams` sub-object and per-processor display-mode key. */
  key: "gate" | "comp";
  grKind: GrKind;
  /** Input axis floor = the threshold's own minimum, and the ruler's tick step. */
  loDb: number;
  tickStep: number;
  /** Curve output axis. */
  outLoDb: number;
  outTicks: readonly number[];
  /** Level taps either side of the processor. */
  inTapKey: string;
  outTapKey: string;
  /** GR lane full scale in dB, when the reduction's own domain is far shallower
   *  than the level ladder. Undefined shares the ladder's dB per pixel. */
  grFullDb?: number;
  text: (m: Messages) => DynText;
  /** The processor's slider fields for a channel, or null when it has none there. */
  fields: (dyn: ChannelDynamics) => DynField[] | null;
  /** Keys the device is driving right now: rendered read-only, grips locked. */
  driven?: (vals: Record<string, unknown>) => ReadonlySet<string>;
  rows?: (ctx: DynRowCtx) => DynRows;
  handles?: (v: DynValues) => DynHandle[];
  /** The static transfer plot, minus the grips and the live dot. */
  drawCurve: (c: CanvasRenderingContext2D, geo: DynCurveGeo, v: DynValues, tok: Record<string, string>) => void;
}

/** The strings one processor's screen prints. */
export interface DynText {
  title: string;
  open: string;
  tapIn: string;
  tapGr: string;
  tapOut: string;
  curveHint: string;
}

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

/** Persisted display mode, per processor. Its own key, like `urx-sends-open` and
 *  `urx-metertap`: this is per-surface UI state, not a Preferences setting. */
const MODE_STORE = "urx-dyn-display";

/** Grab radius for a curve grip, in px. */
const GRIP_R = 13;

type Mode = "ladder" | "curve";

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
  /** The screen closed: the surfaces that print these values re-render. */
  onClosed: () => void;
}

type Lane = "in" | "gr" | "out";

interface LadderRefs {
  shade: HTMLElement;
  peak: HTMLElement;
}

/** One lane's held peak, in dB. Kept in the meter's own unit rather than as a
 *  fraction so the readout prints it directly; `db === null` is "nothing held
 *  yet", which is the same distinction the readouts draw between a value and "—". */
interface PeakHold {
  db: number | null;
  age: number;
}
const noPeak = (): PeakHold => ({ db: null, age: 0 });

const LANES: readonly Lane[] = ["in", "gr", "out"];

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export class DynScreen {
  private readonly scrim: HTMLElement;
  private readonly box: HTMLElement;
  private nodeId = "";
  private proc: DynProcessor | null = null;
  // Which display the operator last worked in, kept across opens and sessions the
  // way the SENDS collapse and the meter point are, and per processor: a gate and
  // a compressor are not read the same way. Not model-scoped like the meter point —
  // this picks a way of reading a processor, not a per-device mapping.
  private modes: Record<string, Mode> = loadJson<Record<string, Mode>>(MODE_STORE, {});

  private readonly store = new MeterStore();
  private paintN = 0; // frame counter gating the throttled readout text
  // Last value written per lane, quantized: an idle lane then writes nothing.
  private laneCache: Record<Lane, { v: number; p: number }> = {
    in: { v: -1, p: -1 },
    gr: { v: -1, p: -1 },
    out: { v: -1, p: -1 },
  };
  // The curve's live dot, and whether the static plot under it needs redrawing.
  private dotIn: number | null = null;
  private dotOut: number | null = null;
  private plotDirty = true;
  private plotSize = { w: 0, h: 0 };
  /** Theme tokens the curve draws with. Read once per render, not per frame:
   *  getComputedStyle after the frame's DOM writes is a forced style recalc. */
  private plotTokens: Record<string, string> = {};
  /** The static plot (grid, axes, transfer curve) kept off-screen so a frame that
   *  only moved the dot is one drawImage instead of a full repaint. */
  private plotLayer: HTMLCanvasElement | null = null;
  /** The processor's fields, resolved once in open() — `channelDynamics` runs a
   *  regex and allocates on every call, and this is constant for the session. */
  private fields: DynField[] = [];
  private unsub: (() => void) | null = null;
  private raf = 0;

  // Live values, written by the subscription callback and read by the paint loop.
  private inTap: MeterTap | null = null;
  private outTap: MeterTap | null = null;
  private gr: readonly [number, number] | undefined;
  private peaks: Record<Lane, PeakHold> = { in: noPeak(), gr: noPeak(), out: noPeak() };

  private ladders: Partial<Record<Lane, LadderRefs>> = {};
  private cap: HTMLElement | null = null;
  // The threshold row's controls, cached at build: syncThreshold runs at pointer
  // rate and was re-querying the subtree for both of them on every move.
  private thrSlider: HTMLInputElement | null = null;
  private thrVal: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private readouts: Partial<Record<Lane, { v: HTMLElement; p: HTMLElement; lastV: string; lastP: string }>> = {};

  private readonly dismiss = wireDismiss({
    keep: (target) => target !== this.scrim,
    close: () => this.close(),
  });

  constructor(private readonly hooks: DynScreenHooks) {
    this.scrim = document.getElementById("dyn-screen-modal") as HTMLElement;
    this.box = document.getElementById("dyn-screen-box") as HTMLElement;
  }

  isOpen(): boolean {
    return !this.scrim.hidden;
  }

  /** Which processor is on screen, or "" when nothing is. */
  openKey(): string {
    return this.isOpen() ? (this.proc?.key ?? "") : "";
  }

  private mode(): Mode {
    return this.modes[this.proc?.key ?? ""] === "curve" ? "curve" : "ladder";
  }

  /** Open one processor for one MONO IN channel. The screen is scoped to what it
   *  was opened from and stays there — no in-screen channel or processor switch,
   *  so the subscribed address set is fixed for the whole session. */
  open(proc: DynProcessor, nodeId: string): void {
    const model = this.hooks.getModel();
    const dyn = this.dynamicsOf(model, nodeId);
    const fields = dyn && proc.fields(dyn);
    if (!fields) return;
    this.proc = proc;
    this.nodeId = nodeId;
    // Fixed for the session, and needed by render() — which runs before any
    // subscription, so resolving them in startMeters() left the meter-id captions
    // blank for a whole off-line session.
    this.fields = fields;
    this.inTap = tapFor(nodeId, proc.inTapKey, model.id) ?? null;
    this.outTap = tapFor(nodeId, proc.outTapKey, model.id) ?? null;
    this.gr = grAddr(proc.grKind, nodeId, model.id);
    this.render();
    this.scrim.hidden = false;
    this.dismiss.attach();
    this.measure();
    this.startMeters();
    this.box.querySelector<HTMLButtonElement>(".consent-btn-primary")?.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.isOpen()) return;
    this.dismiss.detach();
    this.scrim.hidden = true;
    this.stopMeters();
    this.hooks.regainMeters();
    this.hooks.onClosed();
  }

  /** Re-render in place: a language switch, a theme switch (the plot's tokens are
   *  read here, not per frame), or the plan changing under the screen — a device
   *  follow can move these very parameters while it is open. */
  refresh(): void {
    if (!this.isOpen()) return;
    // A follow can also switch the channel's COMP/EQ bank out from under the
    // screen, which takes the processor away entirely.
    const dyn = this.dynamicsOf(this.hooks.getModel(), this.nodeId);
    const fields = dyn && this.proc?.fields(dyn);
    if (!fields) {
      this.close();
      return;
    }
    this.fields = fields;
    this.render();
    this.measure();
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

  private dynamicsOf(model: DeviceModel, nodeId: string): ChannelDynamics | null {
    const np = this.hooks.getPlan().nodeParams[nodeId];
    return channelDynamics(model, nodeId, np?.compEqType ?? COMP_EQ_COMP_FIRST);
  }

  // ---------------------------------------------------------------- meters

  /** The three addresses this screen streams, in signal order. Pure: the taps are
   *  resolved once in open(), since the channel is fixed for the session. */
  private addrs(): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (const a of [this.inTap?.l, this.gr, this.outTap?.l]) if (a) out.push([a[0], a[1]]);
    return out;
  }

  private startMeters(): void {
    if (!this.hooks.isLive()) return;
    // Take the slot before subscribing: the broker replaces the previous
    // registration silently, so the console must be told rather than discover it.
    this.hooks.releaseMeters();
    const addrs = this.addrs();
    const gr = this.gr;
    void subscribeMeters(this.store, addrs, (m) => {
      // The GR peak folds here, not off the store: the store is last-write-win, so
      // a batch carrying more than one frame for an address would drop all but the
      // last before any reader saw them.
      if (gr && m.meterId === gr[0] && m.x === gr[1]) {
        const db = decodeGrDb(m.value);
        const p = this.peaks.gr;
        if (p.db === null || db < p.db) {
          p.db = db;
          p.age = 0;
        }
      }
    })
      .then((unsub) => {
        if (this.isOpen()) this.unsub = unsub;
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
    this.unsub?.();
    this.unsub = null;
    this.store.clear();
    this.peaks = { in: noPeak(), gr: noPeak(), out: noPeak() };
    this.laneCache = { in: { v: -1, p: -1 }, gr: { v: -1, p: -1 }, out: { v: -1, p: -1 } };
  }

  // ---------------------------------------------------------------- scales

  /** Fraction of the ladder a level occupies (0 at the floor, 1 at 0 dBFS). */
  private frac(db: number): number {
    const lo = this.proc?.loDb ?? -72;
    return clamp01((db - lo) / (HI_DB - lo));
  }

  /** Fraction of a lane a reading fills. GR grows downward from 0, and reads
   *  either on the level ladder's own dB per pixel (a gate's reduction runs the
   *  whole ruler) or on a full scale of its own (a compressor's is a few dB, and
   *  would sit invisible on a 54 dB ruler — its lane is labelled separately). */
  private laneFrac(lane: Lane, db: number): number {
    if (lane !== "gr") return this.frac(db);
    const lo = this.proc?.loDb ?? -72;
    return clamp01(Math.abs(db) / (this.proc?.grFullDb ?? HI_DB - lo));
  }

  // ---------------------------------------------------------------- painting

  /** One frame. The feed is 10 Hz and no interpolation is applied, so most frames
   *  carry nothing new: every write below is behind a dirty check and the readout
   *  text is throttled further, matching the console's paintMeters — a text write
   *  relayouts its cell whether or not the string changed. */
  private paint(): void {
    const live = this.hooks.isLive();
    const now: Record<Lane, number | null> = {
      in: live ? (this.store.readingTap(this.inTap)?.l ?? null) : null,
      gr: live ? this.store.readGr(this.gr) : null,
      out: live ? (this.store.readingTap(this.outTap)?.l ?? null) : null,
    };

    const showText = this.paintN++ % READOUT_EVERY === 0;
    const m = t().dynTuning;
    for (const lane of LANES) {
      const db = now[lane];
      const p = this.peaks[lane];
      // Both rulers grow with the displayed magnitude, so "further along the lane"
      // is one comparison for all three — no level/reduction branch.
      if (
        db !== null &&
        (p.db === null || this.laneFrac(lane, db) > this.laneFrac(lane, p.db) || p.age > PEAK_HOLD_FRAMES)
      ) {
        p.db = db;
        p.age = 0;
      } else if (db !== null) p.age++;
      this.setLane(lane, db === null ? 0 : this.laneFrac(lane, db), p.db === null ? 0 : this.laneFrac(lane, p.db));
      if (showText) {
        this.setReadout(lane, db === null ? m.noReading : db.toFixed(1), p.db === null ? m.noReading : p.db.toFixed(1));
      }
    }
    if (this.mode() === "curve" && this.curveDirty(now.in, now.out)) this.drawCurve();
  }

  /** Has anything the curve draws moved since the last frame? The plot is static
   *  apart from the live dot, and the dot only moves when a reading does. */
  private curveDirty(inDb: number | null, outDb: number | null): boolean {
    if (this.dotIn === inDb && this.dotOut === outDb && !this.plotDirty) return false;
    this.dotIn = inDb;
    this.dotOut = outDb;
    return true;
  }

  private setLane(lane: Lane, value: number, peak: number): void {
    const refs = this.ladders[lane];
    if (!refs) return;
    const cache = this.laneCache[lane];
    // Quantize to the pixel the transform can actually resolve, so an idle lane
    // stops writing at all rather than churning the last decimals.
    const v = Math.round(value * 1000);
    const p = Math.round(peak * 1000);
    if (cache.v !== v) {
      cache.v = v;
      refs.shade.style.setProperty("--lvl", (v / 1000).toFixed(3));
    }
    if (cache.p !== p) {
      cache.p = p;
      refs.peak.style.setProperty("--pk", (p / 1000).toFixed(3));
      refs.peak.classList.toggle("off", p <= 0);
    }
  }

  private setReadout(lane: Lane, value: string, peak: string): void {
    const r = this.readouts[lane];
    if (!r) return;
    const peakText = `${t().dynTuning.peakPrefix} ${peak}`;
    if (r.lastV !== value) {
      r.lastV = value;
      setLevelText(r.v, value);
    }
    if (r.lastP !== peakText) {
      r.lastP = peakText;
      setLevelText(r.p, peakText);
    }
  }

  // ---------------------------------------------------------------- plan I/O

  private vals(): Record<string, unknown> {
    const key = this.proc?.key ?? "gate";
    return (this.hooks.getPlan().nodeParams[this.nodeId]?.[key] ?? {}) as Record<string, unknown>;
  }

  private setVals(patch: Record<string, number | boolean>): void {
    const key = this.proc?.key ?? "gate";
    const plan = this.hooks.getPlan();
    this.hooks.onUpdateNodeParams(this.nodeId, {
      [key]: { ...(plan.nodeParams[this.nodeId]?.[key] ?? {}), ...patch },
    });
  }

  /** The value of one parameter, falling back to the catalog's own default — so the
   *  screen and the field table cannot drift apart on what "unset" means. */
  private val(key: string): number {
    const v = this.vals()[key];
    return typeof v === "number" ? v : (this.fields.find((f) => f.key === key)?.def ?? 0);
  }

  private clampField(key: string, v: number): number {
    const f = this.fields.find((x) => x.key === key);
    if (!f) return v;
    return Math.min(f.max, Math.max(f.min, v));
  }

  private values(): DynValues {
    return { get: (k) => this.val(k), clamp: (k, v) => this.clampField(k, v) };
  }

  /** Keys the device is driving right now (COMP 1-knob / Auto Makeup). They stay
   *  visible and keep updating — the device announces every recomputation — but
   *  they are not editable here, matching the unit's own screen. */
  private driven(): ReadonlySet<string> {
    return this.proc?.driven?.(this.vals()) ?? new Set<string>();
  }

  private setThresholdFromFrac(f: number): void {
    if (this.driven().has("threshold")) return;
    const lo = this.proc?.loDb ?? -72;
    const db = Math.round(lo + clamp01(f) * (HI_DB - lo));
    if (db !== this.vals().threshold) this.setVals({ threshold: db });
    this.syncThreshold();
  }

  private syncThreshold(): void {
    const db = this.val("threshold");
    if (this.cap) {
      this.cap.style.setProperty("--pos", ((1 - this.frac(db)) * 100).toFixed(2) + "%");
      this.cap.setAttribute("aria-valuenow", String(db));
      this.cap.setAttribute("aria-valuetext", formatDyn(db, "db"));
    }
    if (this.thrSlider && Number(this.thrSlider.value) !== db) this.thrSlider.value = String(db);
    if (this.thrVal) setLevelText(this.thrVal, formatDyn(db, "db"));
    this.markPlotDirty();
  }

  /** The static half of the curve changed (a parameter, size or theme), so the next
   *  frame redraws it instead of only moving the dot. */
  private markPlotDirty(): void {
    this.plotDirty = true;
  }

  // ---------------------------------------------------------------- rendering

  private render(): void {
    const m = t();
    const proc = this.proc;
    if (!proc) return;
    const g = m.dynTuning;
    const px = proc.text(m);
    this.readTokens();
    this.box.replaceChildren();
    this.ladders = {};
    this.readouts = {};
    this.cap = null;
    this.canvas = null;
    this.thrSlider = null;
    this.thrVal = null;
    this.plotDirty = true;
    this.plotSize = { w: 0, h: 0 };
    // The readout cells are rebuilt empty, and the paint below is the only thing
    // that fills them — without resetting the throttle counter a re-render landing
    // on a skipped frame (every mode switch, since render() paints once) left them
    // blank until the next feed tick, or forever with no session.
    this.paintN = 0;

    const title = el("h2", "");
    title.id = "dyn-screen-title";
    const ch = el("span", "gt-ch");
    ch.textContent = channelLabel(this.hooks.getModel(), this.nodeId);
    const name = el("span", "");
    name.textContent = px.title;
    title.append(ch, name);

    const grid = el("div", "prefs-grid");
    grid.append(this.displayColumn(g, px), this.controlColumn(m, g));

    const actions = el("div", "consent-actions");
    const close = el("button", "consent-btn-primary");
    close.textContent = g.close;
    close.addEventListener("click", () => this.close());
    actions.append(close);

    this.box.append(title, grid, actions);
    this.syncThreshold();
    this.paint();
  }

  private displayColumn(g: Messages["dynTuning"], px: DynText): HTMLElement {
    const col = el("div", "prefs-col");
    const sec = settingsSection(g.display);
    const h = sec.firstElementChild as HTMLElement;
    const seg = el("span", "udk-banks gt-modes");
    const mk = (mode: Mode, label: string): HTMLElement => {
      const b = el("button", "");
      b.id = `dyn-mode-${mode}`;
      b.textContent = label;
      b.setAttribute("aria-pressed", String(this.mode() === mode));
      b.addEventListener("click", () => {
        if (this.mode() === mode || !this.proc) return;
        this.modes = { ...this.modes, [this.proc.key]: mode };
        saveJson(MODE_STORE, this.modes);
        this.render();
        this.measure();
      });
      return b;
    };
    seg.append(mk("ladder", g.modeLadder), mk("curve", g.modeCurve));
    h.append(seg);
    col.append(sec, this.mode() === "ladder" ? this.ladderBox(px) : this.curveBox(px));
    // The hint is CURVE's alone — a fader cap on a meter explains itself, dragging
    // a curve's grip does not — but its box is reserved in both modes. Adding it
    // only in CURVE made the modal grow by its height on every switch, which moves
    // the Close action and the parameter rows under the pointer. The reservation is
    // exactly one line; `gt-note`'s fixed height keeps a longer string from silently
    // reintroducing the jump (the E2E pins the two modes to equal height).
    const hint = el("p", "gt-note");
    if (this.mode() === "curve") hint.textContent = px.curveHint;
    else hint.setAttribute("aria-hidden", "true");
    col.append(hint);
    return col;
  }

  private ladderBox(px: DynText): HTMLElement {
    const proc = this.proc as DynProcessor;
    const box = el("div", "gt-ladderbox");
    const row = el("div", "gt-ladders");

    row.append(this.tickColumn(proc.loDb, proc.tickStep, (db) => this.frac(db)));
    row.append(this.levelColumn("in", px.tapIn, this.inTap));
    row.append(this.grColumn(px, proc));
    row.append(this.levelColumn("out", px.tapOut, this.outTap));
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
    const spacer = el("span", "gt-cap-label");
    spacer.setAttribute("aria-hidden", "true");
    spacer.append(document.createTextNode(" "), document.createElement("br"), document.createTextNode(" "));
    col.append(scale, spacer);
    return col;
  }

  private levelColumn(key: "in" | "out", label: string, tap: MeterTap | null): HTMLElement {
    const col = el("div", "gt-lcol");
    const slot = el("div", "gt-slot");
    const bar = el("div", "gt-bar");
    bar.style.setProperty("--zy", (this.frac(METER_GREEN_TOP_DB) * 100).toFixed(2) + "%");
    bar.style.setProperty("--zr", (this.frac(METER_YELLOW_TOP_DB) * 100).toFixed(2) + "%");
    const shade = el("div", "gt-shade");
    const peak = el("div", "gt-peak off");
    slot.append(bar, shade, peak);
    if (key === "in") slot.append(this.thresholdCap(slot));
    this.ladders[key] = { shade, peak };
    col.append(slot, capLabel(label, tap?.l[0]));
    return col;
  }

  private grColumn(px: DynText, proc: DynProcessor): HTMLElement {
    const wrap = el("div", proc.grFullDb === undefined ? "gt-grwrap" : "gt-grwrap own");
    const col = el("div", "gt-lcol");
    const slot = el("div", "gt-slot gt-slot-gr");
    const shade = el("div", "gt-shade gr");
    const peak = el("div", "gt-peak gr off");
    slot.append(shade, peak);
    this.ladders.gr = { shade, peak };
    col.append(slot, capLabel(px.tapGr, this.gr?.[0]));
    // A reduction that runs the whole ruler (a gate's) reads off the shared tick
    // column. One that occupies a few dB of it (a compressor's) would sit invisible
    // there, so it gets a scale of its own — printed beside the lane and set apart
    // from the level pair, never a second unlabelled scale under the shared ticks.
    const full = proc.grFullDb;
    if (full !== undefined) wrap.append(this.tickColumn(-full, full / 4, (db) => 1 - Math.abs(db) / full));
    wrap.append(col);
    return wrap;
  }

  /** The threshold, as a fader cap on the input meter. The one gesture the ladder
   *  exists for — it works because the threshold's dB and the meter's dBFS are the
   *  same coordinate. */
  private thresholdCap(slot: HTMLElement): HTMLElement {
    const cap = el("div", "gt-cap");
    cap.id = "dyn-threshold-cap";
    cap.tabIndex = 0;
    cap.setAttribute("role", "slider");
    cap.setAttribute("aria-label", t().inspector.dyn.threshold);
    cap.setAttribute("aria-valuemin", String(this.proc?.loDb ?? -72));
    cap.setAttribute("aria-valuemax", String(HI_DB));
    if (this.driven().has("threshold")) cap.classList.add("locked");
    this.cap = cap;

    const fromY = (clientY: number): void => {
      const r = slot.getBoundingClientRect();
      this.setThresholdFromFrac(1 - (clientY - r.top) / r.height);
    };
    let dragging = false;
    cap.addEventListener("pointerdown", (e) => {
      cap.setPointerCapture(e.pointerId);
      dragging = true;
      e.preventDefault();
    });
    cap.addEventListener("pointermove", (e) => {
      if (dragging) fromY(e.clientY);
    });
    const end = (): void => {
      dragging = false;
    };
    cap.addEventListener("pointerup", end);
    cap.addEventListener("pointercancel", end);
    // A press on the track jumps the cap, matching the console faders.
    slot.addEventListener("pointerdown", (e) => {
      if (e.target !== cap) fromY(e.clientY);
    });
    cap.addEventListener("keydown", (e) => {
      const step =
        e.key === "PageUp" ? 6 : e.key === "PageDown" ? -6 : e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
      if (!step || this.driven().has("threshold")) return;
      e.preventDefault();
      const lo = this.proc?.loDb ?? -72;
      const next = Math.min(HI_DB, Math.max(lo, this.val("threshold") + step));
      this.setVals({ threshold: next });
      this.syncThreshold();
    });
    return cap;
  }

  /** Measure the canvas once, after the modal is visible. Doing it in the frame
   *  loop is a forced layout read straight after that frame's DOM writes. */
  measure(): void {
    const cv = this.canvas;
    if (!cv) return;
    const w = Math.max(240, cv.clientWidth);
    const h = cv.clientHeight;
    if (w === this.plotSize.w && h === this.plotSize.h) return;
    this.plotSize = { w, h };
    this.plotDirty = true;
    this.drawCurve();
  }

  private curveBox(px: DynText): HTMLElement {
    const box = el("div", "gt-curvebox");
    const cv = document.createElement("canvas");
    cv.id = "dyn-curve";
    cv.setAttribute("aria-label", px.curveHint);
    this.canvas = cv;
    box.append(cv);

    // Grips are grabbed by proximity; a press anywhere else drags the threshold,
    // which is what the gate's whole curve did before there were several.
    let grip: DynHandle | null = null;
    const geo = (): DynCurveGeo | null => {
      const { w, h } = this.plotSize;
      return w && h ? this.geo(w, h) : null;
    };
    const pick = (e: PointerEvent): DynHandle | null => {
      const g = geo();
      const hs = this.handles();
      if (!g || !hs.length) return null;
      let best: DynHandle | null = null;
      let bestD = GRIP_R * GRIP_R;
      for (const h of hs) {
        const dx = g.px(h.x) - e.offsetX;
        const dy = g.py(h.y) - e.offsetY;
        const d = dx * dx + dy * dy;
        if (d <= bestD) {
          bestD = d;
          best = h;
        }
      }
      return best;
    };
    const apply = (e: PointerEvent): void => {
      const g = geo();
      if (!g) return;
      if (!grip) {
        this.setThresholdFromFrac((e.offsetX - CURVE_PAD.l) / (g.w - CURVE_PAD.l - CURVE_PAD.r));
        return;
      }
      // Re-resolve the grip each move: its own drag closure captured the values it
      // was built with, and the plot is rebuilt from the plan on every change.
      const live = this.handles().find((h) => h.id === grip?.id) ?? grip;
      const patch = live.drag(this.unPx(e.offsetX, g), this.unPy(e.offsetY, g));
      if (!patch) return;
      this.setVals(patch);
      if ("threshold" in patch) this.syncThreshold();
      else this.markPlotDirty();
    };
    cv.addEventListener("pointerdown", (e) => {
      cv.setPointerCapture(e.pointerId);
      grip = pick(e);
      apply(e);
    });
    cv.addEventListener("pointermove", (e) => {
      if (cv.hasPointerCapture(e.pointerId)) apply(e);
    });
    const end = (e: PointerEvent): void => {
      if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
      grip = null;
    };
    cv.addEventListener("pointerup", end);
    cv.addEventListener("pointercancel", end);
    return box;
  }

  private controlColumn(m: Messages, g: Messages["dynTuning"]): HTMLElement {
    const col = el("div", "prefs-col");
    const proc = this.proc as DynProcessor;

    const params = settingsSection(g.parameters);
    const labels = m.inspector.dyn as Record<string, string>;
    const vals = this.vals();
    // These rows decide which other rows exist and which are read-only (COMP's
    // 1-knob and Auto Makeup hand values over to the device), so each one rebuilds
    // the column. The sliders deliberately do not — a rebuild mid-drag would drop
    // the pointer capture.
    const extra = proc.rows?.({
      m,
      vals,
      set: (patch) => {
        this.setVals(patch);
        this.render();
        this.measure();
      },
    });
    const driven = this.driven();
    if (extra?.lead) params.append(...extra.lead);
    for (const f of this.fields) {
      params.append(this.paramRow(f, labels[f.key] ?? f.key, this.val(f.key), driven.has(f.key), g));
    }
    if (extra?.tail) params.append(...extra.tail);

    const ro = settingsSection(g.readouts);
    const cells = el("div", "gt-readouts");
    const px = proc.text(m);
    cells.append(
      this.readoutCell("in", px.tapIn),
      this.readoutCell("gr", px.tapGr),
      this.readoutCell("out", px.tapOut),
    );
    ro.append(cells);

    col.append(params, ro);
    return col;
  }

  private paramRow(f: DynField, label: string, value: number, driven: boolean, g: Messages["dynTuning"]): HTMLElement {
    const ctl = el("span", "ctl dev-slider");
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(f.min);
    input.max = String(f.max);
    input.step = String(f.step);
    input.value = String(value);
    input.dataset.dyn = f.key;
    input.setAttribute("aria-label", label);
    input.disabled = driven;
    const val = el("span", "param-val gt-val");
    val.dataset.dynVal = f.key;
    if (f.key === "threshold") {
      this.thrSlider = input;
      this.thrVal = val;
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
      const v = Number(input.value);
      show(v);
      this.setVals({ [f.key]: v });
      if (f.key === "threshold") this.syncThreshold();
      else this.markPlotDirty();
    });
    wheelStep(input);
    ctl.append(input, val);
    const row = settingsRow(label, ctl, driven ? { tag: g.driven, locked: true } : {});
    // The device's push-and-turn fine grid is confirmed for exactly one dynamics
    // value, the COMP makeup gain, so the field table says which (see
    // reference/work/vd/vd-params.md). The legend pins beside the static label,
    // never the readout — the readout's width changes with the value's digits.
    if (f.fineStep !== undefined && !driven) {
      optInFine(input, f.step, f.fineStep);
      row.querySelector(".lblc")?.append(fineTag());
    }
    return row;
  }

  private readoutCell(lane: Lane, label: string): HTMLElement {
    const cell = el("div", lane === "gr" ? "gt-ro gr" : "gt-ro");
    const k = el("span", "k");
    k.textContent = label;
    const v = el("span", "v");
    const p = el("span", "p");
    this.readouts[lane] = { v, p, lastV: "", lastP: "" };
    cell.append(k, v, p);
    return cell;
  }

  // ---------------------------------------------------------------- curve

  /** Resolve the plot's theme tokens. Called on render (which a theme switch and a
   *  language switch both trigger), never per frame. */
  private readTokens(): void {
    const cs = getComputedStyle(this.box);
    const out: Record<string, string> = {};
    for (const n of PLOT_TOKENS) out[n] = cs.getPropertyValue(n).trim();
    this.plotTokens = out;
    this.plotDirty = true;
  }

  private geo(w: number, h: number): DynCurveGeo {
    const proc = this.proc as DynProcessor;
    const lo = proc.loDb;
    const outLo = proc.outLoDb;
    const outHi = Math.max(HI_DB, ...proc.outTicks);
    return {
      w,
      h,
      px: (db) => CURVE_PAD.l + ((db - lo) / (HI_DB - lo)) * (w - CURVE_PAD.l - CURVE_PAD.r),
      py: (db) => h - CURVE_PAD.b - ((db - outLo) / (outHi - outLo)) * (h - CURVE_PAD.t - CURVE_PAD.b),
    };
  }

  private unPx(x: number, g: DynCurveGeo): number {
    const lo = (this.proc as DynProcessor).loDb;
    return lo + ((x - CURVE_PAD.l) / (g.w - CURVE_PAD.l - CURVE_PAD.r)) * (HI_DB - lo);
  }

  private unPy(y: number, g: DynCurveGeo): number {
    const proc = this.proc as DynProcessor;
    const outLo = proc.outLoDb;
    const outHi = Math.max(HI_DB, ...proc.outTicks);
    return outLo + ((g.h - CURVE_PAD.b - y) / (g.h - CURVE_PAD.t - CURVE_PAD.b)) * (outHi - outLo);
  }

  private handles(): DynHandle[] {
    const driven = this.driven();
    const all = this.proc?.handles?.(this.values()) ?? [];
    // A grip whose value the device owns is not draggable, and is drawn hollow.
    return all.filter((h) => !driven.has(h.id));
  }

  /** Split into a cached static layer and a live dot. Everything but the dot
   *  depends only on the parameters, size and theme, so at 30 fps against a 10 Hz
   *  feed redrawing it every frame was hundreds of stroked paths a second for at
   *  most 10 meaningful dot positions. */
  private drawCurve(): void {
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

    // The live point, if the feed is up.
    const inDb = this.dotIn;
    const outDb = this.dotOut;
    if (inDb === null || outDb === null) return;
    const proc = this.proc as DynProcessor;
    const g = this.geo(w, h);
    const tok = this.plotTokens;
    const x = g.px(Math.max(inDb, proc.loDb));
    const y = g.py(Math.max(outDb, proc.outLoDb));
    c.fillStyle =
      inDb >= METER_YELLOW_TOP_DB ? tok["--m-red"] : inDb >= METER_GREEN_TOP_DB ? tok["--m-yellow"] : tok["--m-green"];
    c.beginPath();
    c.arc(x, y, 5, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = tok["--plot-ink"];
    c.lineWidth = 1.5;
    c.stroke();
  }

  /** The static plot, rendered once per parameter / size / theme change: the frame
   *  and axes here, the processor's own transfer curve in between, the grips on
   *  top. */
  private drawPlotLayer(w: number, h: number, dpr: number): HTMLCanvasElement {
    const proc = this.proc as DynProcessor;
    const layer = this.plotLayer ?? document.createElement("canvas");
    layer.width = Math.round(w * dpr);
    layer.height = Math.round(h * dpr);
    const c = layer.getContext("2d") as CanvasRenderingContext2D;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);

    const tok = this.plotTokens;
    const g = this.geo(w, h);
    const line = tok["--plot-line"];
    const faint = tok["--plot-faint"];
    const dim = tok["--plot-dim"];

    c.font = PLOT_FONT;
    c.strokeStyle = line;
    c.lineWidth = 1;
    c.fillStyle = faint;
    c.textAlign = "center";
    const inStep = Math.round((HI_DB - proc.loDb) / 6);
    for (let db = proc.loDb; db <= HI_DB; db += inStep) {
      c.beginPath();
      c.moveTo(g.px(db) + 0.5, CURVE_PAD.t);
      c.lineTo(g.px(db) + 0.5, h - CURVE_PAD.b);
      c.stroke();
      c.fillText(String(db), g.px(db), h - CURVE_PAD.b + 13);
    }
    c.textAlign = "right";
    for (const db of proc.outTicks) {
      c.beginPath();
      c.moveTo(CURVE_PAD.l, g.py(db) + 0.5);
      c.lineTo(w - CURVE_PAD.r, g.py(db) + 0.5);
      c.stroke();
      c.fillText(String(db), CURVE_PAD.l - 6, g.py(db) + 3);
    }
    c.fillStyle = dim;
    c.textAlign = "left";
    c.fillText("IN dBFS", w - CURVE_PAD.r - 58, h - CURVE_PAD.b + 24);
    c.save();
    c.translate(13, h - CURVE_PAD.b - 2);
    c.rotate(-Math.PI / 2);
    c.fillText("OUT dBFS", 0, 0);
    c.restore();

    // Unity reference, so the curve's departure from it reads against something.
    c.strokeStyle = faint;
    c.setLineDash([2, 3]);
    c.beginPath();
    c.moveTo(g.px(proc.loDb), g.py(proc.loDb));
    c.lineTo(g.px(HI_DB), g.py(HI_DB));
    c.stroke();
    c.setLineDash([]);

    proc.drawCurve(c, g, this.values(), tok);

    for (const hnd of this.handles()) {
      const cx = Math.min(Math.max(g.px(hnd.x), CURVE_PAD.l + GRIP_R), w - CURVE_PAD.r - GRIP_R);
      const cy = Math.min(Math.max(g.py(hnd.y), CURVE_PAD.t + GRIP_R), h - CURVE_PAD.b - GRIP_R);
      c.beginPath();
      c.arc(cx, cy, GRIP_R - 2, 0, Math.PI * 2);
      c.fillStyle = tok["--plot-grip"];
      c.fill();
      c.lineWidth = 2;
      c.strokeStyle = hnd.id === "threshold" ? tok["--led"] : dim;
      c.stroke();
      c.fillStyle = hnd.id === "threshold" ? tok["--led"] : dim;
      c.font = PLOT_FONT_BOLD;
      c.textAlign = "center";
      c.fillText(hnd.label, cx, cy + 4);
      c.font = PLOT_FONT;
    }
    return layer;
  }
}

const PLOT_FONT = '9.5px "SF Mono", Menlo, Consolas, monospace';
const PLOT_FONT_BOLD = 'bold 11px "SF Mono", Menlo, Consolas, monospace';

const PLOT_TOKENS = [
  "--plot-line",
  "--plot-faint",
  "--plot-dim",
  "--plot-ink",
  "--plot-grip",
  "--led",
  "--gr",
  "--m-green",
  "--m-yellow",
  "--m-red",
] as const;

function channelLabel(model: DeviceModel, nodeId: string): string {
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

export { GR_FLOOR_DB };
