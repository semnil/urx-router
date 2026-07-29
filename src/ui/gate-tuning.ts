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

import { el, wireDismiss } from "./dom";
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
import { channelDynamics } from "../core/control/translate";
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

interface LadderRefs {
  shade: HTMLElement;
  peak: HTMLElement;
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
  private unsub: (() => void) | null = null;
  private raf = 0;

  // Live values, written by the subscription callback and read by the paint loop.
  private inTap: MeterTap | null = null;
  private outTap: MeterTap | null = null;
  private grAddr: readonly [number, number] | undefined;
  private grPeakDb = 0;
  private grPeakAge = 0;
  private peaks = { in: 0, out: 0, inAge: 0, outAge: 0 };

  private ladders: { in?: LadderRefs; out?: LadderRefs; gr?: LadderRefs } = {};
  private cap: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private readouts: Record<string, { v: HTMLElement; p: HTMLElement }> = {};

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
    if (!channelDynamics(this.hooks.getModel(), nodeId, 0)) return;
    this.nodeId = nodeId;
    this.render();
    this.scrim.hidden = false;
    this.dismiss.attach();
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

  /** Re-render in place (language switch, or the plan changed under us). */
  refresh(): void {
    if (this.isOpen()) this.render();
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

  private addrs(): Array<[number, number]> {
    const modelId = this.hooks.getModel().id;
    this.inTap = tapFor(this.nodeId, "pregate", modelId) ?? null;
    this.outTap = tapFor(this.nodeId, "precomp", modelId) ?? null;
    this.grAddr = gateGrAddr(this.nodeId, modelId);
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
        if (db < this.grPeakDb) {
          this.grPeakDb = db;
          this.grPeakAge = 0;
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
    this.grPeakDb = 0;
    this.grPeakAge = 0;
    this.peaks = { in: 0, out: 0, inAge: 0, outAge: 0 };
  }

  // ---------------------------------------------------------------- painting

  /** Fraction of the ladder a level occupies (0 at -72 dB, 1 at 0 dB). */
  private static frac(db: number): number {
    return Math.min(1, Math.max(0, (db - LO_DB) / SPAN_DB));
  }

  /** GR shares the level ladders' dB per pixel, so the one tick column reads for
   *  all three: a GR bar down to the -56 tick is 56 dB of reduction. */
  private static grFrac(db: number): number {
    return Math.min(1, Math.abs(db) / SPAN_DB);
  }

  private paint(): void {
    const live = this.hooks.isLive();
    const inR = live ? this.store.readingTap(this.inTap) : null;
    const outR = live ? this.store.readingTap(this.outTap) : null;
    const grDb = live ? this.store.readGr(this.grAddr) : null;

    const hold = (cur: number, next: number, key: "in" | "out"): number => {
      const age = `${key}Age` as const;
      if (next > cur || this.peaks[age] > PEAK_HOLD_FRAMES) {
        this.peaks[age] = 0;
        return next;
      }
      this.peaks[age]++;
      return cur;
    };
    if (inR) this.peaks.in = hold(this.peaks.in, GateTuningModal.frac(inR.l), "in");
    if (outR) this.peaks.out = hold(this.peaks.out, GateTuningModal.frac(outR.l), "out");
    if (grDb !== null && this.grPeakAge++ > PEAK_HOLD_FRAMES) {
      this.grPeakDb = grDb;
      this.grPeakAge = 0;
    }

    this.setLane("in", inR ? GateTuningModal.frac(inR.l) : 0, this.peaks.in);
    this.setLane("out", outR ? GateTuningModal.frac(outR.l) : 0, this.peaks.out);
    this.setLane("gr", grDb === null ? 0 : GateTuningModal.grFrac(grDb), GateTuningModal.grFrac(this.grPeakDb));

    const m = t().gateTuning;
    const fmt = (db: number | null): string => (db === null ? m.noReading : db.toFixed(1));
    this.setReadout(
      "in",
      fmt(inR ? inR.l : null),
      this.peaks.in > 0 ? (LO_DB + this.peaks.in * SPAN_DB).toFixed(1) : null,
    );
    this.setReadout("gr", fmt(grDb), this.grPeakDb < 0 ? this.grPeakDb.toFixed(1) : null);
    this.setReadout(
      "out",
      fmt(outR ? outR.l : null),
      this.peaks.out > 0 ? (LO_DB + this.peaks.out * SPAN_DB).toFixed(1) : null,
    );
    if (this.mode === "curve") this.drawCurve();
  }

  private setLane(key: "in" | "out" | "gr", value: number, peak: number): void {
    const refs = this.ladders[key];
    if (!refs) return;
    if (key === "gr") {
      refs.shade.style.setProperty("--grf", value.toFixed(3));
      refs.peak.style.setProperty("--grpk", peak.toFixed(3));
    } else {
      refs.shade.style.setProperty("--lvl", (1 - value).toFixed(3));
      refs.peak.style.setProperty("--pk", peak.toFixed(3));
    }
    refs.peak.classList.toggle("off", peak <= 0);
  }

  private setReadout(key: string, value: string, peak: string | null): void {
    const r = this.readouts[key];
    if (!r) return;
    const m = t().gateTuning;
    r.v.textContent = value;
    r.p.textContent = `${m.peakPrefix} ${peak ?? m.noReading}`;
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

  private threshold(field: DynField): number {
    return this.gateVals().threshold ?? field.def;
  }

  private setThresholdFromFrac(f: number): void {
    const db = Math.round(LO_DB + Math.min(1, Math.max(0, f)) * SPAN_DB);
    if (db !== this.gateVals().threshold) this.setGate({ threshold: db });
    this.syncThreshold();
  }

  private syncThreshold(): void {
    const fields = this.fields();
    const thr = fields.find((f) => f.key === "threshold");
    if (!thr || !this.cap) return;
    const db = this.threshold(thr);
    this.cap.style.setProperty("--pos", ((1 - GateTuningModal.frac(db)) * 100).toFixed(2) + "%");
    this.cap.setAttribute("aria-valuenow", String(db));
    this.cap.setAttribute("aria-valuetext", formatDyn(db, "db"));
    const slider = this.box.querySelector<HTMLInputElement>('input[data-gate="threshold"]');
    if (slider && Number(slider.value) !== db) slider.value = String(db);
    const val = this.box.querySelector<HTMLElement>('[data-gate-val="threshold"]');
    if (val) val.textContent = formatDyn(db, "db");
    if (this.mode === "curve") this.drawCurve();
  }

  private fields(): DynField[] {
    return channelDynamics(this.hooks.getModel(), this.nodeId, 0)?.gate ?? [];
  }

  // ---------------------------------------------------------------- rendering

  private render(): void {
    const m = t();
    const g = m.gateTuning;
    this.box.replaceChildren();
    this.ladders = {};
    this.readouts = {};
    this.cap = null;
    this.canvas = null;

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
    const sec = el("section", "prefs-section");
    const h = el("h3", "");
    h.textContent = g.display;
    const seg = el("span", "gt-modes");
    seg.setAttribute("role", "tablist");
    const mk = (mode: Mode, label: string): HTMLElement => {
      const b = el("button", "");
      b.id = `gate-mode-${mode}`;
      b.textContent = label;
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(this.mode === mode));
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
    sec.append(h);
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
      tick.style.bottom = (GateTuningModal.frac(db) * 100).toFixed(2) + "%";
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
    bar.style.setProperty("--zy", (GateTuningModal.frac(METER_GREEN_TOP_DB) * 100).toFixed(2) + "%");
    bar.style.setProperty("--zr", (GateTuningModal.frac(METER_YELLOW_TOP_DB) * 100).toFixed(2) + "%");
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
    const bar = el("div", "gt-gr");
    const peak = el("div", "gt-grpeak off");
    slot.append(bar, peak);
    this.ladders.gr = { shade: bar, peak };
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
      const fields = this.fields();
      const thr = fields.find((f) => f.key === "threshold");
      if (!thr) return;
      const next = Math.min(HI_DB, Math.max(LO_DB, this.threshold(thr) + step));
      this.setGate({ threshold: next });
      this.syncThreshold();
    });
    return cap;
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
      const w = Math.max(240, cv.clientWidth);
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

    const params = el("section", "prefs-section");
    const ph = el("h3", "");
    ph.textContent = g.parameters;
    params.append(ph);
    const labels = m.inspector.dyn as Record<string, string>;
    const vals = this.gateVals();
    for (const f of this.fields()) {
      params.append(this.paramRow(f, labels[f.key] ?? f.key, vals[f.key] ?? f.def));
    }

    const ro = el("section", "prefs-section");
    const rh = el("h3", "");
    rh.textContent = g.readouts;
    ro.append(rh);
    const cells = el("div", "gt-readouts");
    cells.append(
      this.readoutCell("in", g.tapIn),
      this.readoutCell("gr", g.tapGr, true),
      this.readoutCell("out", g.tapOut),
    );
    ro.append(cells);

    col.append(params, ro);
    return col;
  }

  private paramRow(f: DynField, label: string, value: number): HTMLElement {
    const row = el("div", "prefs-row");
    const lblc = el("span", "lblc");
    const lbl = el("span", "lbl");
    lbl.textContent = label;
    lblc.append(lbl);

    const ctl = el("span", "ctl gt-ctl");
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(f.min);
    input.max = String(f.max);
    input.step = String(f.step);
    input.value = String(value);
    input.dataset.gate = f.key;
    input.setAttribute("aria-label", label);
    const val = el("span", "gt-val");
    val.dataset.gateVal = f.key;

    const show = (v: number): void => {
      // GATE range has a -∞ notch one step below its -72 dB floor: fully closed.
      val.textContent = f.key === "range" && v <= GATE_RANGE_OFF_DB ? "-∞ dB" : formatDyn(v, f.unit);
      input.setAttribute("aria-valuetext", val.textContent);
    };
    show(value);
    input.addEventListener("input", () => {
      const v = Number(input.value);
      show(v);
      this.setGate({ [f.key]: v });
      if (f.key === "threshold") this.syncThreshold();
      else if (f.key === "range" && this.mode === "curve") this.drawCurve();
    });
    ctl.append(input, val);
    row.append(lblc, ctl);
    return row;
  }

  private readoutCell(key: string, label: string, gr = false): HTMLElement {
    const cell = el("div", gr ? "gt-ro gr" : "gt-ro");
    const k = el("span", "k");
    k.textContent = label;
    const v = el("span", "v");
    const p = el("span", "p");
    this.readouts[key] = { v, p };
    cell.append(k, v, p);
    return cell;
  }

  // ---------------------------------------------------------------- curve

  private drawCurve(): void {
    const cv = this.canvas;
    if (!cv) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(240, cv.clientWidth);
    const h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const c = cv.getContext("2d");
    if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);

    const cs = getComputedStyle(cv);
    const tok = (n: string): string => cs.getPropertyValue(n).trim();
    const line = tok("--plot-line");
    const faint = tok("--plot-faint");
    const dim = tok("--plot-dim");
    const led = tok("--led");
    const gr = tok("--gr");

    const px = (db: number): number => CURVE_PAD.l + ((db - LO_DB) / SPAN_DB) * (w - CURVE_PAD.l - CURVE_PAD.r);
    const py = (db: number): number =>
      h - CURVE_PAD.b - ((db - OUT_LO_DB) / OUT_SPAN_DB) * (h - CURVE_PAD.t - CURVE_PAD.b);

    c.font = '9.5px "SF Mono", Menlo, Consolas, monospace';
    c.strokeStyle = line;
    c.lineWidth = 1;
    c.fillStyle = faint;
    c.textAlign = "center";
    for (let db = LO_DB; db <= HI_DB; db += 12) {
      c.beginPath();
      c.moveTo(px(db) + 0.5, CURVE_PAD.t);
      c.lineTo(px(db) + 0.5, h - CURVE_PAD.b);
      c.stroke();
      c.fillText(String(db), px(db), h - CURVE_PAD.b + 13);
    }
    c.textAlign = "right";
    for (const db of OUT_TICKS) {
      c.beginPath();
      c.moveTo(CURVE_PAD.l, py(db) + 0.5);
      c.lineTo(w - CURVE_PAD.r, py(db) + 0.5);
      c.stroke();
      c.fillText(String(db), CURVE_PAD.l - 6, py(db) + 3);
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
    c.moveTo(px(LO_DB), py(LO_DB));
    c.lineTo(px(HI_DB), py(HI_DB));
    c.stroke();
    c.setLineDash([]);

    const vals = this.gateVals();
    const fields = this.fields();
    const thrField = fields.find((f) => f.key === "threshold");
    const rangeField = fields.find((f) => f.key === "range");
    const thr = vals.threshold ?? thrField?.def ?? -50;
    const rangeDb = vals.range ?? rangeField?.def ?? -56;
    // range at its -∞ notch closes completely; the shelf then sits at the floor.
    const drop = rangeDb <= GATE_RANGE_OFF_DB ? GR_FLOOR_DB : rangeDb;
    const clampY = (db: number): number => py(Math.max(db, OUT_LO_DB));

    c.strokeStyle = led;
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(px(LO_DB), clampY(LO_DB + drop));
    c.lineTo(px(thr), clampY(thr + drop));
    c.stroke();
    c.beginPath();
    c.moveTo(px(thr), py(thr));
    c.lineTo(px(HI_DB), py(HI_DB));
    c.stroke();

    // The knee's drop, labelled with the range it represents. Only a -∞ range now
    // reaches the axis floor; every finite range lands on scale, which is the
    // point of running the output axis past the input's.
    c.strokeStyle = gr;
    c.setLineDash([3, 3]);
    c.beginPath();
    c.moveTo(px(thr), py(thr));
    c.lineTo(px(thr), clampY(thr + drop));
    c.stroke();
    c.setLineDash([]);
    c.fillStyle = gr;
    c.textAlign = px(thr) > w - CURVE_PAD.r - 80 ? "right" : "left";
    const shown = rangeDb <= GATE_RANGE_OFF_DB ? "-∞" : formatDyn(rangeDb, "db");
    const shelfY = clampY(thr + drop);
    c.fillText(shown, px(thr) + (c.textAlign === "right" ? -6 : 6), Math.min(shelfY - 6, h - CURVE_PAD.b - 4));

    c.strokeStyle = led;
    c.globalAlpha = 0.35;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(px(thr) + 0.5, CURVE_PAD.t);
    c.lineTo(px(thr) + 0.5, h - CURVE_PAD.b);
    c.stroke();
    c.globalAlpha = 1;
    c.fillStyle = led;
    c.textAlign = "left";
    c.fillText(formatDyn(thr, "db"), Math.min(px(thr) + 5, w - CURVE_PAD.r - 60), CURVE_PAD.t + 11);

    // The live point, if the feed is up.
    const inR = this.hooks.isLive() ? this.store.readingTap(this.inTap) : null;
    const outR = this.hooks.isLive() ? this.store.readingTap(this.outTap) : null;
    if (!inR || !outR) return;
    const x = px(Math.max(inR.l, LO_DB));
    const y = py(Math.max(outR.l, LO_DB));
    c.fillStyle =
      inR.l >= METER_YELLOW_TOP_DB
        ? tok("--m-red")
        : inR.l >= METER_GREEN_TOP_DB
          ? tok("--m-yellow")
          : tok("--m-green");
    c.beginPath();
    c.arc(x, y, 5, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = tok("--plot-ink");
    c.lineWidth = 1.5;
    c.stroke();
  }
}

const CURVE_PAD = { l: 44, r: 14, t: 14, b: 28 };

/** formatDyn from the inspector, kept identical so both surfaces print a gate
 *  value the same way. */
function formatDyn(v: number, unit: DynField["unit"]): string {
  if (unit === "db") return `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
  if (unit === "ratio") return `${v.toFixed(1)}:1`;
  return v < 1 ? `${v.toFixed(3)} ms` : `${v.toFixed(1)} ms`;
}

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
