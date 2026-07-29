// GATE tuning screen: the five gate parameters beside the three meter taps that
// show what they are doing — PRE GATE (106) in, GATE GR (107), PRE COMP (108) out.
// A gate threshold in dB is directly comparable with the PRE GATE meter's dBFS
// (measured: CH1's -54 dBFS noise floor sat below a -52 dB threshold and the gate
// stayed shut), which is what earns the screen's one gesture: the threshold is a
// fader cap dragged on the input meter itself.
//
// Two display modes over one control set. LADDER is the three taps on a shared
// -72..0 dB ruler — linear in dB, so the cap's position and the threshold value
// stay proportional. CURVE swaps in the static in/out transfer plot, where the
// threshold is the knee. They are alternatives, not layers: each owns the column.
//
// What the meters can and cannot show (measured on a URX44V, 2026-07-29 — see
// reference/work/vd/vd-meters.md):
//   - the feed is exactly 100 ms and each frame is an instantaneous sample, not a
//     window extreme, so nothing is gained by painting faster;
//   - the level meters are peak detectors with a ~30 dB/s release, so they hold
//     transients themselves — adding an app-side release here would double it;
//   - the GR meter has no ballistics at all, so a gate action shorter than 100 ms
//     is missed outright. The peak hold below is the only thing that makes a
//     caught one readable, and it cannot recover one that was never sampled.
//
// The broker has a single meter subscription slot process-wide (a subscribe
// replaces the previous one and the unsubscribe takes no address), so this screen
// takes the slot for its three addresses while open and hands it back on close.

import { el, settingsRow, settingsSection, wheelStep, wireDismiss } from "./dom";
import { setLevelText } from "./glyph";
import { t } from "../i18n";
import type { Messages } from "../i18n/en";
import {
  decodeGrDb,
  gateGrAddr,
  GR_FLOOR_DB,
  METER_GREEN_TOP_DB,
  METER_YELLOW_TOP_DB,
  MeterStore,
  subscribeMeters,
  tapFor,
} from "../core/meters";
import type { MeterTap } from "../core/meters";
import { channelDynamics, dynValueText, formatDyn } from "../core/control/translate";
import { GATE_RANGE_OFF_DB } from "../core/control/vd";
import type { DynField } from "../core/control/translate";
import type { DeviceModel } from "../models/types";
import type { NodeParams, Plan } from "../core/plan";
import { loadJson, saveJson } from "../core/storage";

/** The screen's vertical ruler: the exact domain a GATE threshold can occupy, so
 *  a cap position maps to a threshold value linearly. */
const LO_DB = -72;
const HI_DB = 0;
const SPAN_DB = HI_DB - LO_DB;

// The curve's output axis, which is deliberately NOT the input axis. The closed
// shelf sits at threshold + range, and for most of the range domain that falls
// below the -72 dB the input spans — at the factory settings -50 + -56 = -106 dB.
// Sharing the input's floor pinned every range past -22 dB to the same line, so
// at the factory threshold 70% of the range domain drew an identical picture and
// range was invisible. Running the output axis to the GR floor puts the shelf on
// scale: moving range from -30 to -56 shifts it by 20% of the plot height, from
// 0% before. A log-compressed axis was measured too and is worse (8.5%) — dB is
// already a log unit, and compressing it again squeezes exactly the deep region
// range lives in.
const OUT_LO_DB = -128;
const OUT_SPAN_DB = HI_DB - OUT_LO_DB;
/** Output-axis gridlines. Coarser than the input's 12 dB step: the axis is 1.8×
 *  longer and the region below -72 dB is context, not something to read off. */
const OUT_TICKS = [0, -24, -48, -72, -96, -128];

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

/** Persisted display mode. Its own key, like `urx-sends-open` and
 *  `urx-metertap`: this is per-surface UI state, not a Preferences setting. */
const MODE_STORE = "urx-gate-display";

type Mode = "ladder" | "curve";

export interface GateTuningHooks {
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
  /** The screen closed: the surfaces that print gate values re-render. */
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

/** Fraction of the ladder a level occupies (0 at -72 dB, 1 at 0 dB). */
function frac(db: number): number {
  return Math.min(1, Math.max(0, (db - LO_DB) / SPAN_DB));
}

/** GR shares the level ladders' dB per pixel, so the one tick column reads for all
 *  three: a GR bar down to the -56 tick is 56 dB of reduction. It grows downward
 *  from 0, which is why it needs its own mapping and not its own scale. */
function laneFrac(lane: Lane, db: number): number {
  return lane === "gr" ? Math.min(1, Math.abs(db) / SPAN_DB) : frac(db);
}

export class GateTuningModal {
  private readonly scrim: HTMLElement;
  private readonly box: HTMLElement;
  private nodeId = "";
  // Which display the operator last worked in, kept across opens and sessions the
  // way the SENDS collapse and the meter point are. Not model-scoped like the
  // meter point: this picks a way of reading a gate, not a per-device mapping.
  private mode: Mode = loadJson<Mode>(MODE_STORE, "ladder") === "curve" ? "curve" : "ladder";

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
   *  only moved the dot is one drawImage instead of ~13 stroked paths and ~13
   *  fillText calls over the whole canvas. */
  private plotLayer: HTMLCanvasElement | null = null;
  /** The channel's GATE fields, resolved once in open() — `channelDynamics` runs a
   *  regex and allocates on every call, and this is constant for the session. */
  private gateFields: DynField[] = [];
  private unsub: (() => void) | null = null;
  private raf = 0;

  // Live values, written by the subscription callback and read by the paint loop.
  private inTap: MeterTap | null = null;
  private outTap: MeterTap | null = null;
  private grAddr: readonly [number, number] | undefined;
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

  constructor(private readonly hooks: GateTuningHooks) {
    this.scrim = document.getElementById("gate-tuning-modal") as HTMLElement;
    this.box = document.getElementById("gate-tuning-box") as HTMLElement;
  }

  isOpen(): boolean {
    return !this.scrim.hidden;
  }

  /** Open for one MONO IN channel. The screen is scoped to the channel it was
   *  opened from and stays there — no in-screen channel switch, so the subscribed
   *  address set is fixed for the whole session. */
  open(nodeId: string): void {
    const model = this.hooks.getModel();
    const dyn = channelDynamics(model, nodeId, 0);
    if (!dyn) return;
    this.nodeId = nodeId;
    // Fixed for the session, and needed by render() — which runs before any
    // subscription, so resolving them in startMeters() left the meter-id captions
    // blank for a whole off-line session.
    this.gateFields = dyn.gate;
    this.inTap = tapFor(nodeId, "pregate", model.id) ?? null;
    this.outTap = tapFor(nodeId, "precomp", model.id) ?? null;
    this.grAddr = gateGrAddr(nodeId, model.id);
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

  // ---------------------------------------------------------------- meters

  /** The three addresses this screen streams, in signal order. Pure: the taps are
   *  resolved once in open(), since the channel is fixed for the session. */
  private addrs(): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (const a of [this.inTap?.l, this.grAddr, this.outTap?.l]) if (a) out.push([a[0], a[1]]);
    return out;
  }

  private startMeters(): void {
    if (!this.hooks.isLive()) return;
    // Take the slot before subscribing: the broker replaces the previous
    // registration silently, so the console must be told rather than discover it.
    this.hooks.releaseMeters();
    const addrs = this.addrs();
    const gr = this.grAddr;
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

  // ---------------------------------------------------------------- painting

  /** One frame. The feed is 10 Hz and no interpolation is applied, so most frames
   *  carry nothing new: every write below is behind a dirty check and the readout
   *  text is throttled further, matching the console's paintMeters — a text write
   *  relayouts its cell whether or not the string changed. */
  private paint(): void {
    const live = this.hooks.isLive();
    const now: Record<Lane, number | null> = {
      in: live ? (this.store.readingTap(this.inTap)?.l ?? null) : null,
      gr: live ? this.store.readGr(this.grAddr) : null,
      out: live ? (this.store.readingTap(this.outTap)?.l ?? null) : null,
    };

    const showText = this.paintN++ % READOUT_EVERY === 0;
    const m = t().gateTuning;
    for (const lane of LANES) {
      const db = now[lane];
      const p = this.peaks[lane];
      // Both rulers grow with the displayed magnitude, so "further along the lane"
      // is one comparison for all three — no level/reduction branch.
      if (db !== null && (p.db === null || laneFrac(lane, db) > laneFrac(lane, p.db) || p.age > PEAK_HOLD_FRAMES)) {
        p.db = db;
        p.age = 0;
      } else if (db !== null) p.age++;
      this.setLane(lane, db === null ? 0 : laneFrac(lane, db), p.db === null ? 0 : laneFrac(lane, p.db));
      if (showText) {
        this.setReadout(lane, db === null ? m.noReading : db.toFixed(1), p.db === null ? m.noReading : p.db.toFixed(1));
      }
    }
    if (this.mode === "curve" && this.curveDirty(now.in, now.out)) this.drawCurve();
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
    const peakText = `${t().gateTuning.peakPrefix} ${peak}`;
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

  private gateVals(): Record<string, number | undefined> {
    return (this.hooks.getPlan().nodeParams[this.nodeId]?.gate ?? {}) as Record<string, number | undefined>;
  }

  private setGate(patch: Record<string, number>): void {
    const plan = this.hooks.getPlan();
    this.hooks.onUpdateNodeParams(this.nodeId, {
      gate: { ...(plan.nodeParams[this.nodeId]?.gate ?? {}), ...patch },
    });
  }

  private setThresholdFromFrac(f: number): void {
    const db = Math.round(LO_DB + Math.min(1, Math.max(0, f)) * SPAN_DB);
    if (db !== this.gateVals().threshold) this.setGate({ threshold: db });
    this.syncThreshold();
  }

  private syncThreshold(): void {
    if (!this.cap) return;
    const db = this.gateVal("threshold");
    this.cap.style.setProperty("--pos", ((1 - frac(db)) * 100).toFixed(2) + "%");
    this.cap.setAttribute("aria-valuenow", String(db));
    this.cap.setAttribute("aria-valuetext", formatDyn(db, "db"));
    if (this.thrSlider && Number(this.thrSlider.value) !== db) this.thrSlider.value = String(db);
    if (this.thrVal) setLevelText(this.thrVal, formatDyn(db, "db"));
    this.markPlotDirty();
  }

  /** The static half of the curve changed (threshold, range, size or theme), so the
   *  next frame redraws it instead of only moving the dot. */
  private markPlotDirty(): void {
    this.plotDirty = true;
  }

  /** The value of one gate parameter, falling back to the catalog's own default —
   *  so the screen and the field table cannot drift apart on what "unset" means. */
  private gateVal(key: string): number {
    return this.gateVals()[key] ?? this.gateFields.find((f) => f.key === key)?.def ?? 0;
  }

  // ---------------------------------------------------------------- rendering

  private render(): void {
    const m = t();
    const g = m.gateTuning;
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

    const title = el("h2", "");
    title.id = "gate-tuning-title";
    const ch = el("span", "gt-ch");
    ch.textContent = channelLabel(this.hooks.getModel(), this.nodeId);
    const name = el("span", "");
    name.textContent = g.title;
    title.append(ch, name);

    const grid = el("div", "prefs-grid");
    grid.append(this.displayColumn(g), this.controlColumn(m));

    const actions = el("div", "consent-actions");
    const close = el("button", "consent-btn-primary");
    close.textContent = g.close;
    close.addEventListener("click", () => this.close());
    actions.append(close);

    this.box.append(title, grid, actions);
    this.syncThreshold();
    this.paint();
  }

  private displayColumn(g: Messages["gateTuning"]): HTMLElement {
    const col = el("div", "prefs-col");
    const sec = settingsSection(g.display);
    const h = sec.firstElementChild as HTMLElement;
    const seg = el("span", "udk-banks gt-modes");
    const mk = (mode: Mode, label: string): HTMLElement => {
      const b = el("button", "");
      b.id = `gate-mode-${mode}`;
      b.textContent = label;
      b.setAttribute("aria-pressed", String(this.mode === mode));
      b.addEventListener("click", () => {
        if (this.mode === mode) return;
        this.mode = mode;
        saveJson(MODE_STORE, mode);
        this.render();
      });
      return b;
    };
    seg.append(mk("ladder", g.modeLadder), mk("curve", g.modeCurve));
    h.append(seg);
    col.append(sec, this.mode === "ladder" ? this.ladderBox(g) : this.curveBox(g));
    // The hint is CURVE's alone — a fader cap on a meter explains itself, dragging
    // a curve's knee does not — but its box is reserved in both modes. Adding it
    // only in CURVE made the modal grow by its height on every switch, which moves
    // the Close action and the parameter rows under the pointer. The reservation is
    // exactly one line; `gt-note`'s fixed height keeps a longer string from silently
    // reintroducing the jump (the E2E pins the two modes to equal height).
    const hint = el("p", "gt-note");
    if (this.mode === "curve") hint.textContent = g.curveHint;
    else hint.setAttribute("aria-hidden", "true");
    col.append(hint);
    return col;
  }

  private ladderBox(g: Messages["gateTuning"]): HTMLElement {
    const box = el("div", "gt-ladderbox");
    const row = el("div", "gt-ladders");

    const scaleCol = el("div", "gt-lcol");
    const scale = el("div", "gt-scale");
    for (let db = HI_DB; db >= LO_DB; db -= 5) {
      const tick = el("span", "t");
      tick.textContent = String(db);
      tick.style.bottom = (frac(db) * 100).toFixed(2) + "%";
      scale.append(tick);
    }
    // An empty caption of the same two-line height as its neighbours, so the tick
    // column's grid row matches the slots' and a tick lines up with a level.
    const spacer = el("span", "gt-cap-label");
    spacer.setAttribute("aria-hidden", "true");
    spacer.append(document.createTextNode(" "), document.createElement("br"), document.createTextNode(" "));
    scaleCol.append(scale, spacer);
    row.append(scaleCol);

    row.append(this.levelColumn("in", g.tapIn, this.inTap));
    row.append(this.grColumn(g));
    row.append(this.levelColumn("out", g.tapOut, this.outTap));
    box.append(row);
    return box;
  }

  private levelColumn(key: "in" | "out", label: string, tap: MeterTap | null): HTMLElement {
    const col = el("div", "gt-lcol");
    const slot = el("div", "gt-slot");
    const bar = el("div", "gt-bar");
    bar.style.setProperty("--zy", (frac(METER_GREEN_TOP_DB) * 100).toFixed(2) + "%");
    bar.style.setProperty("--zr", (frac(METER_YELLOW_TOP_DB) * 100).toFixed(2) + "%");
    const shade = el("div", "gt-shade");
    const peak = el("div", "gt-peak off");
    slot.append(bar, shade, peak);
    if (key === "in") slot.append(this.thresholdCap(slot));
    this.ladders[key] = { shade, peak };
    col.append(slot, capLabel(label, tap?.l[0]));
    return col;
  }

  private grColumn(g: Messages["gateTuning"]): HTMLElement {
    const col = el("div", "gt-lcol");
    const slot = el("div", "gt-slot gt-slot-gr");
    const shade = el("div", "gt-shade gr");
    const peak = el("div", "gt-peak gr off");
    slot.append(shade, peak);
    this.ladders.gr = { shade, peak };
    col.append(slot, capLabel(g.tapGr, this.grAddr?.[0]));
    return col;
  }

  /** The threshold, as a fader cap on the input meter. The one gesture the screen
   *  exists for — it works because the threshold's dB and the meter's dBFS are the
   *  same coordinate. */
  private thresholdCap(slot: HTMLElement): HTMLElement {
    const cap = el("div", "gt-cap");
    cap.id = "gate-threshold-cap";
    cap.tabIndex = 0;
    cap.setAttribute("role", "slider");
    cap.setAttribute("aria-label", t().inspector.dyn.threshold);
    cap.setAttribute("aria-valuemin", String(LO_DB));
    cap.setAttribute("aria-valuemax", String(HI_DB));
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
      if (!step) return;
      e.preventDefault();
      const next = Math.min(HI_DB, Math.max(LO_DB, this.gateVal("threshold") + step));
      this.setGate({ threshold: next });
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

  private curveBox(g: Messages["gateTuning"]): HTMLElement {
    const box = el("div", "gt-curvebox");
    const cv = document.createElement("canvas");
    cv.id = "gate-curve";
    cv.setAttribute("aria-label", g.modeCurve);
    this.canvas = cv;
    box.append(cv);

    let dragging = false;
    const apply = (e: PointerEvent): void => {
      const w = this.plotSize.w || Math.max(240, cv.clientWidth);
      this.setThresholdFromFrac((e.offsetX - CURVE_PAD.l) / (w - CURVE_PAD.l - CURVE_PAD.r));
    };
    cv.addEventListener("pointerdown", (e) => {
      cv.setPointerCapture(e.pointerId);
      dragging = true;
      apply(e);
    });
    cv.addEventListener("pointermove", (e) => {
      if (dragging) apply(e);
    });
    const end = (): void => {
      dragging = false;
    };
    cv.addEventListener("pointerup", end);
    cv.addEventListener("pointercancel", end);
    return box;
  }

  private controlColumn(m: Messages): HTMLElement {
    const g = m.gateTuning;
    const col = el("div", "prefs-col");

    const params = settingsSection(g.parameters);
    const labels = m.inspector.dyn as Record<string, string>;
    const vals = this.gateVals();
    for (const f of this.gateFields) {
      params.append(this.paramRow(f, labels[f.key] ?? f.key, vals[f.key] ?? f.def));
    }

    const ro = settingsSection(g.readouts);
    const cells = el("div", "gt-readouts");
    cells.append(this.readoutCell("in", g.tapIn), this.readoutCell("gr", g.tapGr), this.readoutCell("out", g.tapOut));
    ro.append(cells);

    col.append(params, ro);
    return col;
  }

  private paramRow(f: DynField, label: string, value: number): HTMLElement {
    const ctl = el("span", "ctl dev-slider");
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(f.min);
    input.max = String(f.max);
    input.step = String(f.step);
    input.value = String(value);
    input.dataset.gate = f.key;
    input.setAttribute("aria-label", label);
    const val = el("span", "param-val gt-val");
    val.dataset.gateVal = f.key;
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
      this.setGate({ [f.key]: v });
      if (f.key === "threshold") this.syncThreshold();
      else if (f.key === "range") this.markPlotDirty();
    });
    wheelStep(input);
    ctl.append(input, val);
    return settingsRow(label, ctl);
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

  /** Split into a cached static layer and a live dot. Everything but the dot
   *  depends only on threshold, range, size and theme, so at 30 fps against a
   *  10 Hz feed redrawing it every frame was ~570 stroked paths and ~510 fillText
   *  calls a second for at most 10 meaningful dot positions. */
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
    const tok = this.plotTokens;
    const x = px(Math.max(inDb, LO_DB), w);
    const y = py(Math.max(outDb, OUT_LO_DB), h);
    c.fillStyle =
      inDb >= METER_YELLOW_TOP_DB ? tok["--m-red"] : inDb >= METER_GREEN_TOP_DB ? tok["--m-yellow"] : tok["--m-green"];
    c.beginPath();
    c.arc(x, y, 5, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = tok["--plot-ink"];
    c.lineWidth = 1.5;
    c.stroke();
  }

  /** The static plot, rendered once per threshold / range / size / theme change. */
  private drawPlotLayer(w: number, h: number, dpr: number): HTMLCanvasElement {
    const layer = this.plotLayer ?? document.createElement("canvas");
    layer.width = Math.round(w * dpr);
    layer.height = Math.round(h * dpr);
    const c = layer.getContext("2d") as CanvasRenderingContext2D;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);

    const tok = this.plotTokens;
    const line = tok["--plot-line"];
    const faint = tok["--plot-faint"];
    const dim = tok["--plot-dim"];
    const led = tok["--led"];
    const gr = tok["--gr"];

    c.font = '9.5px "SF Mono", Menlo, Consolas, monospace';
    c.strokeStyle = line;
    c.lineWidth = 1;
    c.fillStyle = faint;
    c.textAlign = "center";
    for (let db = LO_DB; db <= HI_DB; db += 12) {
      c.beginPath();
      c.moveTo(px(db, w) + 0.5, CURVE_PAD.t);
      c.lineTo(px(db, w) + 0.5, h - CURVE_PAD.b);
      c.stroke();
      c.fillText(String(db), px(db, w), h - CURVE_PAD.b + 13);
    }
    c.textAlign = "right";
    for (const db of OUT_TICKS) {
      c.beginPath();
      c.moveTo(CURVE_PAD.l, py(db, h) + 0.5);
      c.lineTo(w - CURVE_PAD.r, py(db, h) + 0.5);
      c.stroke();
      c.fillText(String(db), CURVE_PAD.l - 6, py(db, h) + 3);
    }
    c.fillStyle = dim;
    c.textAlign = "left";
    c.fillText("IN dBFS", w - CURVE_PAD.r - 58, h - CURVE_PAD.b + 24);
    c.save();
    c.translate(13, h - CURVE_PAD.b - 2);
    c.rotate(-Math.PI / 2);
    c.fillText("OUT dBFS", 0, 0);
    c.restore();

    // Unity reference, so the shelf's drop reads against something.
    c.strokeStyle = faint;
    c.setLineDash([2, 3]);
    c.beginPath();
    c.moveTo(px(LO_DB, w), py(LO_DB, h));
    c.lineTo(px(HI_DB, w), py(HI_DB, h));
    c.stroke();
    c.setLineDash([]);

    const thr = this.gateVal("threshold");
    const rangeDb = this.gateVal("range");
    // range at its -∞ notch closes completely; the shelf then sits at the floor.
    const drop = rangeDb <= GATE_RANGE_OFF_DB ? GR_FLOOR_DB : rangeDb;
    const clampY = (db: number): number => py(Math.max(db, OUT_LO_DB), h);

    c.strokeStyle = led;
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(px(LO_DB, w), clampY(LO_DB + drop));
    c.lineTo(px(thr, w), clampY(thr + drop));
    c.stroke();
    c.beginPath();
    c.moveTo(px(thr, w), py(thr, h));
    c.lineTo(px(HI_DB, w), py(HI_DB, h));
    c.stroke();

    // The knee's drop, labelled with the range it represents. Only a -∞ range
    // reaches the axis floor; every finite range lands on scale, which is the
    // point of running the output axis past the input's.
    c.strokeStyle = gr;
    c.setLineDash([3, 3]);
    c.beginPath();
    c.moveTo(px(thr, w), py(thr, h));
    c.lineTo(px(thr, w), clampY(thr + drop));
    c.stroke();
    c.setLineDash([]);
    c.fillStyle = gr;
    const right = px(thr, w) > w - CURVE_PAD.r - 80;
    c.textAlign = right ? "right" : "left";
    const shown = rangeDb <= GATE_RANGE_OFF_DB ? "-∞" : formatDyn(rangeDb, "db");
    c.fillText(shown, px(thr, w) + (right ? -6 : 6), Math.min(clampY(thr + drop) - 6, h - CURVE_PAD.b - 4));

    c.strokeStyle = led;
    c.globalAlpha = 0.35;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(px(thr, w) + 0.5, CURVE_PAD.t);
    c.lineTo(px(thr, w) + 0.5, h - CURVE_PAD.b);
    c.stroke();
    c.globalAlpha = 1;
    c.fillStyle = led;
    c.textAlign = "left";
    c.fillText(formatDyn(thr, "db"), Math.min(px(thr, w) + 5, w - CURVE_PAD.r - 60), CURVE_PAD.t + 11);
    return layer;
  }
}

const CURVE_PAD = { l: 44, r: 14, t: 14, b: 28 };
/** Plot coordinates. The input axis spans the threshold's domain; the output axis
 *  runs past it to the GR floor (see OUT_LO_DB). */
const px = (db: number, w: number): number => CURVE_PAD.l + ((db - LO_DB) / SPAN_DB) * (w - CURVE_PAD.l - CURVE_PAD.r);
const py = (db: number, h: number): number =>
  h - CURVE_PAD.b - ((db - OUT_LO_DB) / OUT_SPAN_DB) * (h - CURVE_PAD.t - CURVE_PAD.b);

const PLOT_TOKENS = [
  "--plot-line",
  "--plot-faint",
  "--plot-dim",
  "--plot-ink",
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
