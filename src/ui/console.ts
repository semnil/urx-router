// CONSOLE view: a mixer-style overview of every level-settable node, laid out as
// vertical channel strips. Each strip shows the set fader level (amber ladder),
// the live signal meter (green→red, only while Live sync streams), mute, gain, and
// EQ. A send-on-fader mode flips the input/FX strips to a chosen MIX/FX send level.
// Edits go straight onto the plan and through the shared change funnel, so Live
// sync mirrors them to the device exactly like the graph/inspector do.

import type { DeviceModel } from "../models/types";
import { ref } from "../models/types";
import { defaultPlan } from "../models/initial-state";
import { LEVEL_MAX_DB, LEVEL_MIN_DB, LEVEL_OFF_DB, type NodeParams, type Plan, type PlanConnection } from "../core/plan";
import { LEVEL_POS_MAX, levelToPos, posToLevel, stepLevel } from "../core/levels";
import { defaultTapKey, hasMeter, isStereoTap, METER_FLOOR_DB, METER_GREEN_TOP_DB, METER_YELLOW_TOP_DB, MeterStore, subscribeMeters, tapAddrs, tapFor, tapsFor, type MeterTap } from "../core/meters";
import { loadJson, saveJson } from "../core/storage";
import { busBalance, channelControl, insertFxControl } from "../core/control/translate";
import { isBalLinkedPair, mirrorBalPair, mixSendLocks, partnerChannel, sendTapWritable } from "../core/routing";
import { INSERT_FX_NONE, type InsertFxOption } from "../core/control/params";
import { PAN_MAX, PAN_MIN, PHONES_LEVEL_DEFAULT, PHONES_LEVEL_MAX, PHONES_LEVEL_MIN } from "../core/control/vd";
import { setLevelText } from "./glyph";
import { t } from "../i18n";

type SendTarget = "bus.mix1" | "bus.mix2" | "bus.fx1" | "bus.fx2";
type Mode = "main" | SendTarget;

const SEND_TARGETS: SendTarget[] = ["bus.fx1", "bus.fx2", "bus.mix1", "bus.mix2"];
const SEND_LABEL: Record<SendTarget, string> = {
  "bus.mix1": "MIX 1",
  "bus.mix2": "MIX 2",
  "bus.fx1": "FX 1",
  "bus.fx2": "FX 2",
};

// The STEREO master / main-sum node: every channel's & FX channel's fixed main send.
const MAIN_BUS = "bus.stereo";

// A fader scale. Each range owns how a dB maps to/from travel (toFrac/fromFrac),
// how the keyboard steps it (step), and its ruler ticks — so the "which scale am
// I" branch lives once, here, instead of being re-tested at every call site.
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
  hasMute: boolean; // channels + master
  hasEq: boolean; // channels + mix + stereo
  hasPhones: boolean; // monitor buses (PHONES 1 ↔ mon1, PHONES 2 ↔ mon2)
  meterOnly: boolean; // STREAMING: only a live meter, no fader / set-level readout
  range: LevelRange;
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
}

interface KnobSpec {
  get: () => number;
  set: (v: number) => void;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  reset: number;
  /** Indicator angle (deg) for a value; default is a -135°..+135° sweep over the
   *  range. Override to place specific values (e.g. PHONES 2/8) at the horizontal. */
  angle?: (v: number) => number;
  /** When set, the knob shows its value but cannot be edited (a device-locked
   *  control, e.g. a Pan-Link send pan). The string is the disabled tooltip. */
  readonlyTitle?: string;
}

export interface ConsoleHooks {
  getModel: () => DeviceModel;
  getPlan: () => Plan;
  /** An edit changed the plan (mute / fader / EQ): flag dirty + schedule live sync. */
  onChange: () => void;
}

// The bars animate every frame; the numeric readout text is refreshed only every
// Nth frame (~6 Hz at 30 fps) so its text relayout/repaint isn't a per-frame cost.
const READOUT_EVERY = 5;

export class Console {
  private mode: Mode = "main";
  private paintN = 0; // frame counter gating the throttled numeric readout
  private refs = new Map<string, StripRef>();
  private lastInsFx = new Map<string, number>(); // last non-none INS FX per node
  private factory: { id: string; plan: Plan } | null = null; // cached factory plan
  private headH = { key: "", px: 0 }; // cached MAIN-tab head height (key: model + hidden)
  private store = new MeterStore();
  private unsub: (() => void) | null = null;
  private subSig = ""; // signature of the currently subscribed address set
  private raf = 0;
  private live = false;
  private visible = false;
  private meterTap = new Map<string, string>(); // node id → chosen tap key (override)
  private tapModel = ""; // model id the meterTap map was loaded for
  private tapOpenFor: string | null = null; // node whose tap popover is open
  private readonly TAP_STORE = "urx-metertap";
  private bar!: HTMLElement;
  private outLabel!: HTMLElement;
  private modePick!: HTMLElement;
  private tapPop!: HTMLElement;
  private stripsHost!: HTMLElement;

  constructor(
    private host: HTMLElement,
    private hooks: ConsoleHooks,
  ) {
    this.build();
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
   *  strip in the current view (mode-filtered). The strip's live-meter ballistics
   *  carry across so the meter (and its peak-hold bar) doesn't jump, and the meter
   *  subscription is untouched (same tap address). */
  refreshStrip(id: string): void {
    if (!this.visible) return;
    const old = this.refs.get(id);
    if (!old) return;
    const fresh = this.buildStrip(this.toStripModel(id), id === MAIN_BUS);
    // buildStrip re-registered refs.get(id) with fresh meter elements. Carry the
    // per-lane ballistics (v/pk/over) so the level + peak-hold + clip latch don't reset,
    // but leave the last-written trackers (lv/lpk/lov/lmtr) at their fresh sentinels —
    // the new elements are undrawn, so paintMeters must repaint them, not skip as
    // unchanged. Lane count is stable across a refresh (same tap), so carry by index.
    this.refs.get(id)!.lanes.forEach((ln, i) => {
      const o = old.lanes[i];
      if (o) {
        ln.v = o.v;
        ln.pk = o.pk;
        ln.over = o.over;
      }
    });
    old.root.replaceWith(fresh);
  }

  // ---- build / render ----

  private build(): void {
    this.host.classList.add("con-root");
    this.bar = el("div", "con-bar");
    this.outLabel = el("span", "con-modelabel");
    this.outLabel.textContent = t().console.outputLabel;
    this.modePick = el("div", "con-modepick");
    this.modePick.setAttribute("role", "group");
    this.bar.append(this.outLabel, this.modePick);

    this.stripsHost = el("div", "con-strips");
    const wrap = el("div", "con-wrap");
    wrap.append(this.bar, this.stripsHost);
    this.host.append(wrap);

    // Floating meter-point popover (positioned fixed so it escapes the strip
    // scroll container). One element reused for whichever strip opened it.
    this.tapPop = el("div", "con-tappop");
    this.tapPop.hidden = true;
    this.host.append(this.tapPop);
    // Close on any outside interaction (a tap badge manages its own toggle).
    document.addEventListener("pointerdown", (e) => {
      if (!this.tapOpenFor) return;
      const tgt = e.target as HTMLElement;
      if (this.tapPop.contains(tgt) || tgt.closest(".con-tap")) return;
      this.closeTapPop();
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
      tick.style.bottom = dbToFrac(db, range) * 100 + "%";
      // The number is centred; a minus sign hangs to its left so the digits of
      // e.g. "10" and "-10" line up vertically.
      const num = el("span", "num");
      if (db < 0) {
        const sign = el("span", "sign");
        sign.textContent = "−";
        num.append(sign);
      }
      if (db === -96) {
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
  // the send-mode tabs and the head-height probe so "visible" is defined once.
  private visibleIds(): Set<string> {
    const hidden = new Set(this.hooks.getPlan().hidden);
    return new Set(this.hooks.getModel().nodes.map((n) => n.id).filter((i) => !hidden.has(i)));
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
    const isMix = this.isMixBus(id);
    const isMon = id === "bus.mon1" || id === "bus.mon2";
    const isMono = /^ch\d+$/.test(id); // mono channels are ch1..ch4 (the only gain/gate/comp/φ-bearing strips)
    return {
      id,
      label: node.label,
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
      // MIX strips carry a MUTE (the MIX → STEREO "TO ST" switch; the MIX master ON
      // 675 shows read-only — see masterMuted in buildStrip), and the MONITOR strips
      // carry a MUTE (np.on → MONITOR_ON, the device [ON] button).
      hasMute: isChannel || isMaster || this.isFxChannel(id) || isMix || isMon,
      hasEq: isChannel || isMix || isMaster,
      hasPhones: id === "bus.mon1" || id === "bus.mon2",
      meterOnly: id === "bus.stream" || isOsc, // STREAMING + OSC: no fader (OSC uses a level knob)
      // OSC drives its level via the LEVEL knob, so its meter/scale use the shared
      // level_gain ruler like every other strip (and the meter-only STREAMING strip).
      range: NORMAL_RANGE,
    };
  }

  // Rebuild the send-mode tabs from the visible buses (a FX/MIX node shelved out
  // of the graph drops its tab too). If the active tab's bus is now hidden, fall
  // back to MAIN so the strips never render against a gone bus.
  private renderModes(): void {
    const ids = this.visibleIds();
    const modes: Mode[] = ["main", ...SEND_TARGETS.filter((m) => ids.has(m))];
    if (!modes.includes(this.mode)) this.mode = "main";
    this.modePick.replaceChildren();
    for (const m of modes) {
      const b = el("button", "") as HTMLButtonElement;
      b.type = "button";
      b.textContent = m === "main" ? "MAIN" : SEND_LABEL[m as SendTarget];
      b.setAttribute("aria-pressed", String(m === this.mode));
      b.addEventListener("click", () => {
        this.mode = m;
        this.render();
      });
      this.modePick.append(b);
    }
  }

  // ---- meter point (per-strip tap selection) ----

  /** The tap key a strip's meter shows: the per-strip override or the default. */
  private tapKeyOf(id: string): string {
    return this.meterTap.get(id) ?? defaultTapKey(id);
  }

  // Persist the per-strip tap choices per model in localStorage (shape:
  // { [modelId]: { [nodeId]: tapKey } }), reusing the shared JSON storage helpers.
  private allTaps(): Record<string, Record<string, string>> {
    return loadJson<Record<string, Record<string, string>>>(this.TAP_STORE, {});
  }

  private loadTaps(): void {
    this.meterTap.clear();
    const m = this.allTaps()[this.hooks.getModel().id];
    if (m && typeof m === "object") for (const [k, v] of Object.entries(m)) if (typeof v === "string") this.meterTap.set(k, v);
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
    const tap = tapFor(id, this.tapKeyOf(id));
    const badge = el("div", "con-tap");
    badge.setAttribute("role", "button");
    badge.setAttribute("aria-haspopup", "menu");
    badge.tabIndex = 0;
    const dot = el("span", "pt");
    const name = document.createTextNode(tap?.label ?? "");
    const cv = el("span", "cv");
    cv.textContent = "▾";
    badge.append(dot, name, cv);
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
    const cur = this.tapKeyOf(id);
    this.tapPop.replaceChildren();
    const ph = el("div", "ph");
    ph.textContent = t().console.meterPoint;
    const chain = el("div", "chain");
    for (const tp of tapsFor(id)) {
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
    const r = anchor.getBoundingClientRect();
    const pw = this.tapPop.offsetWidth;
    const phh = this.tapPop.offsetHeight;
    let left = Math.min(r.right - pw, window.innerWidth - pw - 6);
    left = Math.max(6, left);
    let top = r.bottom + 2;
    if (top + phh > window.innerHeight - 6) top = Math.max(6, r.top - phh - 2);
    this.tapPop.style.left = left + "px";
    this.tapPop.style.top = top + "px";
  }

  private closeTapPop(): void {
    if (!this.tapOpenFor) return;
    this.tapOpenFor = null;
    this.tapPop.hidden = true;
    this.tapPop.replaceChildren();
  }

  // Paint a scribble with the node's device CH SETTING colour (contrast-picked ink),
  // or leave the rail fallback when unset. Shared by both strip builders.
  private paintScribble(scrib: HTMLElement, id: string): void {
    const color = this.hooks.getPlan().nodeColors?.[id];
    if (!color) return;
    scrib.style.background = color;
    const ink = inkOn(color);
    scrib.style.color = ink.color;
    scrib.style.setProperty("--scrib-shadow", ink.shadow);
  }

  // The scribble strip: the CH SETTING colour + the node name and the device CH
  // SETTING name row ("—" when unset, so every strip is the same height). Shared by
  // both strip builders; the master-only CH MUTE badge is appended by the caller.
  private scribble(m: StripModel): HTMLElement {
    const scrib = el("div", "con-scribble");
    this.paintScribble(scrib, m.id);
    const name = el("div", "name");
    name.textContent = m.label;
    const dev = el("div", "id");
    dev.textContent = m.deviceName || "—";
    if (!m.deviceName) dev.classList.add("empty");
    scrib.append(name, dev);
    return scrib;
  }

  // A toggle chip ("MUTE"/"EQ"/"ON"/…): role=button, aria-pressed, keyboard-activated;
  // `toggle` flips the underlying plan flag and returns the new state, then the chip
  // commits (and re-renders when commit asks). A readonlyTitle renders it inert with a
  // tooltip. Shared across both strip builders (channel chips + the OSC ON button).
  private makeChip(id: string, parent: HTMLElement, label: string, mute: boolean, on: boolean, toggle: () => boolean, readonlyTitle?: string): void {
    const chip = el("div", "con-chip" + (mute ? " mute" : "") + (on ? " on" : "") + (readonlyTitle ? " readonly" : ""));
    chip.textContent = label;
    chip.setAttribute("role", "button");
    chip.setAttribute("aria-pressed", String(on));
    if (readonlyTitle) {
      chip.setAttribute("aria-disabled", "true");
      chip.title = readonlyTitle;
      parent.append(chip);
      return;
    }
    chip.tabIndex = 0;
    const run = (): void => {
      const next = toggle();
      chip.classList.toggle("on", next);
      chip.setAttribute("aria-pressed", String(next));
      if (this.commit(id)) this.render();
    };
    chip.addEventListener("click", run);
    chip.addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        run();
      }
    });
    parent.append(chip);
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
    const strip = el("div", "con-strip meter-only");
    strip.style.setProperty("--rail", m.rail);

    const head = el("div", "con-head");
    head.append(this.scribble(m));
    // OSCILLATOR: an ON button (off by default; highlighted = generating) and a LEVEL
    // knob that replaces the fader. Both edit the plan and sync live via commit().
    if (m.isOsc) {
      const chips = el("div", "con-chips");
      const oscOn = (): boolean => this.hooks.getPlan().nodeParams[m.id]?.osc?.on ?? false;
      this.makeChip(m.id, chips, t().console.on, false, oscOn(), () => {
        const np = this.nodeParamsOf(m.id);
        const next = !oscOn();
        np.osc = { ...np.osc, on: next };
        return next;
      });
      chips.append(el("div", "con-chip spacer"));
      head.append(chips);
      // LEVEL knob: full OSC range (-96…0 dB). The indicator's horizontal marks read
      // -50 (left) / -8 (right); the extremes (down-left / down-right) reach -96 / 0.
      const factory = this.factoryPlan().nodeParams[m.id]?.osc?.level ?? -14;
      this.addKnob(head, "LEVEL", {
        get: () => this.getMain(m),
        set: (v) => this.setMain(m, v),
        min: -96,
        max: 0,
        step: 1,
        format: (v) => v.toFixed(1),
        reset: factory,
        angle: (v) => (v <= -50 ? -135 + ((v + 96) / 46) * 45 : v >= -8 ? 90 + ((v + 8) / 8) * 45 : -90 + ((v + 50) / 42) * 180),
      }, m.id);
    }
    strip.append(head);

    const zone = el("div", "con-faderzone");
    zone.append(el("div", "con-taphead")); // empty: keeps fader/meter tops aligned
    const zrow = el("div", "con-zrow");
    const tap = tapFor(m.id, this.tapKeyOf(m.id)) ?? null;
    const { meter, lanes } = this.buildMeterColumn(m.range, isStereoTap(tap));
    // Meter tops out at 0 dBFS and there is no fader, so the scale stops at 0.
    zrow.append(this.buildScale(m.range, 0), meter);
    zone.append(zrow);
    strip.append(zone);

    // readout: live meter value only (no fader set-level cell).
    const readout = el("div", "con-readout");
    const mtrCell = el("div", "rd mtr");
    const mtrEl = el("div", "rv");
    mtrEl.textContent = "—";
    mtrCell.append(mtrEl);
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
    const model = this.hooks.getModel();
    if (this.tapModel !== model.id) {
      this.loadTaps();
      this.tapModel = model.id;
    }
    this.closeTapPop();
    this.outLabel.textContent = t().console.outputLabel;
    this.renderModes();
    this.refs.clear();
    const send = this.mode !== "main";
    const { groups, master } = this.stripModels();
    this.stripsHost.replaceChildren();
    for (const g of groups) {
      const strips: HTMLElement[] = [];
      for (const id of g.ids) {
        const m = this.toStripModel(id);
        // The console adjusts levels only; routing stays in the graph. A send mode
        // shows only the sources that send to the selected bus (so non-send nodes —
        // monitors, master, the buses themselves — drop out), and never offers a
        // wire-less strip to connect (setSend never drops a wire either).
        if (send && !(this.usesSend(m) && this.hasSend(id, this.mode as SendTarget))) continue;
        strips.push(this.buildStrip(m, false));
      }
      if (strips.length === 0) continue;
      const group = el("div", "con-group");
      const lbl = el("div", "con-grouplabel");
      lbl.textContent = g.label;
      group.append(lbl, ...strips);
      this.stripsHost.append(group);
    }
    // The STEREO (MAIN) master is not a send source, so it only appears in MAIN.
    if (master && !send) {
      const group = el("div", "con-group master");
      const lbl = el("div", "con-grouplabel");
      lbl.textContent = t().console.master;
      group.append(lbl, this.buildStrip(this.toStripModel(master), true));
      this.stripsHost.append(group);
    }
    // Lock every head (name / chips / knobs) to the MAIN tab's tallest strip, so the
    // head area is uniform across all channels and all tabs; the fader/meter zone
    // (flex: 1) takes the rest of the window height.
    this.host.style.setProperty("--head-h", this.mainHeadHeight() + "px");
    this.startMeters(); // rescope the meter subscription to the rebuilt strips
  }

  // The MAIN tab's tallest head (a mono channel carries the most chips + two knobs)
  // sets the fixed head height for every tab. Measure it by laying out the MAIN
  // strips off-screen with auto-height heads, then cache by model + hidden set
  // (the only inputs that change which strips exist). A send tab thus reserves the
  // same head area even though it shows fewer controls.
  private mainHeadHeight(): number {
    const key = this.hooks.getModel().id + "|" + [...this.hooks.getPlan().hidden].sort().join(",");
    if (this.headH.key === key) return this.headH.px;
    const savedRefs = this.refs;
    const savedMode = this.mode;
    this.refs = new Map(); // buildStrip registers refs/listeners; keep them off the live map
    this.mode = "main";
    const probe = el("div", "con-strips");
    probe.style.cssText = "position:absolute;visibility:hidden;height:auto;";
    const { groups, master } = this.stripModels();
    for (const g of groups) for (const id of g.ids) probe.append(this.buildStrip(this.toStripModel(id), false));
    if (master) probe.append(this.buildStrip(this.toStripModel(master), true));
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
    this.mode = savedMode;
    this.headH = { key, px: max };
    return max;
  }

  private buildStrip(m: StripModel, isMaster: boolean): HTMLElement {
    if (m.meterOnly) return this.buildMeterOnlyStrip(m);
    const plan = this.hooks.getPlan();
    const model = this.hooks.getModel();
    const usesSend = this.usesSend(m);
    const level = usesSend ? this.getSend(m.id, this.mode as SendTarget) : this.getMain(m);
    const np = plan.nodeParams[m.id] ?? {};

    // In a MIX send tab, mirror the destination bus's hidden-mode locks: FIXED BUS
    // Type locks the send fader and Pan Link locks the send pan knob read-only (the
    // graph inspector drops those controls instead — same rule, different view).
    const { busFixed, panLinked } = usesSend ? mixSendLocks(plan, this.mode) : { busFixed: false, panLinked: false };

    // For an input/FX channel the MUTE chip always controls a → bus send's ON/OFF,
    // never the channel master: in MAIN it is the → STEREO assign ON (firmware V1.3),
    // in a send tab the → MIX/FX send. When the channel master (CH_ON) is muted the
    // whole channel — and thus every send — is silenced regardless, so surface that
    // override at the strip level (dim + a CH MUTE badge) while the per-send chip
    // stays operable. A MIX strip reuses the same indicator: its MUTE chip is the
    // MIX → STEREO "TO ST" send, so the MIX master ON (675, edited in the graph
    // inspector only) shows read-only as the dim + CH MUTE badge here too.
    const usesConnMute = m.isChannel || this.isFxChannel(m.id) || this.isMixBus(m.id);
    const masterMuted = usesConnMute && np.on === false;

    const strip = el("div", "con-strip" + (isMaster ? " master" : "") + (masterMuted ? " master-muted" : ""));
    strip.style.setProperty("--rail", m.rail);

    // head: scribble + chips + gain
    const head = el("div", "con-head");
    const scrib = this.scribble(m);
    if (masterMuted) {
      const badge = el("div", "ch-mute");
      badge.textContent = t().console.chMute;
      scrib.append(badge);
    }
    head.append(scrib);

    // Channel-domain controls (HA toggles, gain knob) are hidden in a send tab, so
    // their capability lookup is skipped there too.
    const cc = usesSend ? undefined : channelControl(model, m.id);

    // Toggle chips in two 2-column groups: channel + input (HA) toggles, then the
    // processing chain GATE → COMP → EQ → INS FX. Each chip flips a plan flag (the
    // device mirrors it via the shared change funnel). An odd group gets an unused
    // spacer chip so the last real chip never stretches to full width.
    type BoolKey = "gateOn" | "compOn" | "eqOn" | "phantom" | "phase" | "phaseL" | "phaseR" | "hpf" | "hiZ" | "cueInterrupt" | "mono";
    const planOf = (): NodeParams => this.hooks.getPlan().nodeParams[m.id] ?? {};
    const boolChip = (parent: HTMLElement, label: string, key: BoolKey, def: boolean): void => {
      this.makeChip(m.id, parent, label, false, planOf()[key] ?? def, () => {
        const next = !(planOf()[key] ?? def);
        this.nodeParamsOf(m.id)[key] = next;
        return next;
      });
    };

    // channel + input (HA) group
    const top = el("div", "con-chips");
    if (m.hasMute) {
      if (usesConnMute) {
        // The MUTE drives a connection's ON/OFF (never its wire presence): a CH/FX →
        // MIX/FX send or → STEREO assign (ships ON), or — on a MIX strip — the MIX →
        // STEREO "TO ST" (ships off). The fixed wire is never added/removed, only
        // params.on flips. sendStripConn picks the → STEREO conn in MAIN, the → MIX/FX
        // conn in a send tab.
        const mix = this.isMixBus(m.id);
        const conn = mix
          ? () => this.sendConn(this.hooks.getPlan(), m.id, MAIN_BUS)
          : this.sendStripConn(m.id, usesSend);
        const sendOn = (): boolean => conn()?.params?.on ?? !mix; // sends default ON, TO ST off
        this.makeChip(m.id, top, t().console.mute, true, !sendOn(), () => {
          const c = conn();
          const nextOn = !sendOn();
          if (c) c.params = { ...c.params, on: nextOn };
          return !nextOn; // chip "on" (highlighted) = muted
        });
      } else {
        // Master ON/OFF on the node's own `on` flag: the STEREO master
        // (STEREO_MASTER_ON) writes to the device; a MONITOR bus is plan-only
        // (no confirmed monitor-ON param), so its mute lives in the plan alone.
        this.makeChip(m.id, top, t().console.mute, true, np.on === false, () => {
          const muted = planOf().on === false;
          this.nodeParamsOf(m.id).on = muted; // toggle: was muted → on, was on → muted
          return !muted;
        });
      }
    }
    // HA input toggles (+48 / polarity / HPF / Hi-Z) are channel-domain, not send
    // controls, so a send tab (which edits the → MIX/FX send) hides them.
    if (!usesSend) {
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
    }
    // MONITOR strips carry the device [CUE] (cue interrupt) and [MONO] buttons.
    // Both are confirmed device params (MONITOR_CUE_INTERRUPT / MONITOR_MONO), so
    // they sync live like the channel toggles. CUE Interrupt ships ON, MONO OFF.
    if (m.hasPhones) {
      boolChip(top, t().console.cue, "cueInterrupt", true);
      boolChip(top, t().console.mono, "mono", false);
    }

    // processing group (GATE / COMP / EQ / INS FX / DUCKER) — channel-domain
    // processing, not send controls, so a send tab hides the whole group.
    const proc = el("div", "con-chips");
    if (!usesSend) {
      if (m.isMono) boolChip(proc, "GATE", "gateOn", false);
      if (m.isMono) boolChip(proc, "COMP", "compOn", false);
      if (m.hasEq) boolChip(proc, t().console.eq, "eqOn", true);
      const ifx = insertFxControl(model, m.id);
      if (ifx) {
        const insOn = (): boolean => {
          const v = planOf().insertFx;
          return v != null && v !== INSERT_FX_NONE;
        };
        this.makeChip(m.id, proc, "INS FX", false, insOn(), () => this.toggleInsFx(m.id, ifx.options));
      }
      // DUCKER: the sidechain ducker hung under a stereo channel (its own node).
      // A shelved ducker drops its chip even while the parent strip stays.
      const hidden = this.hooks.getPlan().hidden;
      const duckerId = model.nodes.find((n) => n.kind === "ducker" && n.attachTo === m.id && !hidden.includes(n.id))?.id;
      if (duckerId) {
        const duckOn = (): boolean => this.hooks.getPlan().nodeParams[duckerId]?.duckerOn === true;
        this.makeChip(duckerId, proc, "DUCKER", false, duckOn(), () => {
          const next = !duckOn();
          this.nodeParamsOf(duckerId).duckerOn = next;
          return next;
        });
      }
    }

    for (const group of [top, proc]) {
      if (group.childElementCount % 2 === 1) group.append(el("div", "con-chip spacer"));
      if (group.childElementCount) head.append(group);
    }

    // Send PRE/POST tap: a chip mirroring the send connection's `tap` (the device
    // SEND TO screen's PRE button). Every CH/FX → MIX/FX send carries a settable
    // tap, so it shows in any send mode (the STEREO main path has none — see
    // device-model.md §3); on = PRE, off = POST.
    if (usesSend) {
      const conn = this.sendStripConn(m.id, usesSend);
      const preGroup = el("div", "con-chips");
      const isPre = (): boolean => conn()?.params?.tap === "pre";
      // The tap stays freely editable in the planner, but a CH → FX send tap
      // (FX 1 / 2 tabs) cannot be written to the device, so it is shown read-only
      // while live-connected — matching the graph CH node's PRE/POST. MIX taps
      // stay editable. See sendTapWritable / inspector.
      const tapReadonly = this.live && !sendTapWritable(model, m.id, this.mode as SendTarget);
      this.makeChip(m.id, preGroup, t().console.pre, false, isPre(), () => {
        const next = !isPre();
        const c = conn();
        if (c) c.params = { ...c.params, tap: next ? "pre" : "post" };
        return next;
      }, tapReadonly ? t().inspector.prePostLcdOnly : undefined);
      preGroup.append(el("div", "con-chip spacer"));
      head.append(preGroup);
    }

    // A.GAIN / D.GAIN is the channel head-amp / digital gain, not a send control,
    // so it is hidden in a send tab.
    if (m.isChannel && !usesSend) {
      const min = cc?.gain?.minDb ?? (m.isMono ? -8 : -24);
      const max = cc?.gain?.maxDb ?? (m.isMono ? 70 : 24);
      const factory = this.factoryPlan().nodeParams[m.id]?.gain ?? (m.isMono ? -8 : 0);
      // Horizontal-marking values: A.Gain +8/+55, D.Gain -14/+15.
      const [hl, hr] = m.isMono ? [8, 55] : [-14, 15];
      this.addKnob(head, m.isMono ? "A.GAIN" : "D.GAIN", {
        get: () => this.hooks.getPlan().nodeParams[m.id]?.gain ?? factory,
        set: (v) => void (this.nodeParamsOf(m.id).gain = v),
        min,
        max,
        step: 1,
        format: (v) => (v > 0 ? "+" : "") + v,
        reset: factory,
        angle: (v) => -90 + ((v - hl) / (hr - hl)) * 180,
      }, m.id);
    }
    // PAN (mono) / BALANCE (stereo) = the source's send pan, L63 – C – R63. Both
    // channels and FX channels follow the tab: MAIN edits the → STEREO main path, a
    // send mode edits that send (same connection as the fader). The FX-bus sends are
    // mono and carry no pan on the device, so the knob is dropped in an FX mode.
    if (m.isChannel || this.isFxChannel(m.id)) {
      const target = usesSend ? (this.mode as SendTarget) : MAIN_BUS;
      if (target !== "bus.fx1" && target !== "bus.fx2") {
        this.addSendPanKnob(head, m.id, target, m.isBalance ? "BAL" : "PAN", panLinked ? t().inspector.panLinked : undefined);
      }
    }
    // Master balance (STEREO 583 / MIX 676) = the bus output's L/R balance, edited
    // on the node's own `pan`. `busBalance` is the single source of truth for which
    // buses have one (shared with the inspector / translate / readback). The device
    // keeps the BALANCE label even under Pan Link (confirmed on URX44V), so it is
    // always "BAL". Only shown in MAIN (these strips are not send sources).
    if (!usesSend && busBalance(m.id)) {
      this.addNodePanKnob(head, m.id, "BAL");
    }
    if (m.hasPhones) {
      // PHONES output level: a 0.0..10.0 scale (not dB) on the monitor bus,
      // independent of the monitor fader (PHONES 1 ↔ mon1, PHONES 2 ↔ mon2).
      const factory = this.factoryPlan().nodeParams[m.id]?.phonesLevel ?? PHONES_LEVEL_DEFAULT;
      this.addKnob(head, "PHONES", {
        get: () => this.hooks.getPlan().nodeParams[m.id]?.phonesLevel ?? PHONES_LEVEL_DEFAULT,
        set: (v) => void (this.nodeParamsOf(m.id).phonesLevel = v),
        min: PHONES_LEVEL_MIN,
        max: PHONES_LEVEL_MAX,
        step: 0.1,
        format: (v) => v.toFixed(1),
        reset: factory,
        // 2.0 at the left horizontal, 8.0 at the right (the device's markings).
        angle: (v) => -90 + ((v - 2) / (8 - 2)) * 180,
      }, m.id);
    }
    strip.append(head);

    // fader zone: a meter-point header row, then the fader (thin slot + cap;
    // position = setting) beside the dB scale and the live level meter.
    const zone = el("div", "con-faderzone");
    const tapKey = this.tapKeyOf(m.id);
    const tapHead = el("div", "con-taphead");
    if (tapsFor(m.id).length > 1) tapHead.append(this.buildTapBadge(m.id));
    zone.append(tapHead);
    const zrow = el("div", "con-zrow");

    const fader = el("div", "con-fader" + (busFixed ? " readonly" : ""));
    fader.setAttribute("role", "slider");
    fader.setAttribute("aria-label", m.label);
    if (busFixed) {
      fader.setAttribute("aria-disabled", "true");
      fader.title = t().inspector.busFixedLevel;
    } else {
      fader.tabIndex = 0;
    }
    const track = el("div", "track");
    // The 0 dB line rides the fader (not the inset track) so it shares the cap's
    // coordinate space and passes through the cap centre when the fader sits at 0 dB.
    const zero = el("div", "zero");
    zero.style.setProperty("--zero", (1 - dbToFrac(0, m.range)) * 100 + "%");
    const cap = el("div", "cap");
    cap.style.setProperty("--pos", (1 - dbToFrac(level, m.range)) * 100 + "%");
    fader.append(track, zero, cap);

    // Meter column: the ladder shares the fader ruler, topping out at the 0 dB mark
    // with the OVER clip window above it. Stereo taps split into independent L/R bars.
    const tap = hasMeter(m.id) ? tapFor(m.id, tapKey) ?? null : null;
    const { meter, lanes } = this.buildMeterColumn(m.range, isStereoTap(tap));

    zrow.append(fader, this.buildScale(m.range), meter);
    zone.append(zrow);
    strip.append(zone);

    // readout: fader set-level dB (white) and, for metered strips, the live meter
    // value of the selected tap (amber). No captions — the meter cell updates live
    // while the fader cell is static, and the colour distinguishes them.
    const readout = el("div", "con-readout");
    const faderCell = el("div", "rd");
    const dbEl = el("div", "rv");
    const f = fmtDb(level, m.range);
    setLevelText(dbEl, f.text);
    if (f.off) dbEl.classList.add("off");
    faderCell.append(dbEl);
    readout.append(faderCell);
    const mtrEl = el("div", "rv");
    if (hasMeter(m.id)) {
      const mtrCell = el("div", "rd mtr");
      mtrEl.textContent = "—";
      mtrCell.append(mtrEl);
      readout.append(mtrCell);
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
    };
    this.refs.set(m.id, refObj);
    // A FIXED-bus send fader is display-only: keep it out of the input wiring.
    if (!busFixed) this.wireFader(refObj, usesSend);
    return strip;
  }

  private wireFader(r: StripRef, usesSend: boolean): void {
    const fader = r.fader;
    if (!fader) return; // meter-only strips have no fader to wire
    const range = r.m.range;
    const setLevel = (db: number): void => {
      if (usesSend) this.setSend(r.m.id, this.mode as SendTarget, db);
      else this.setMain(r.m, db);
      this.updateStripLevel(r, db);
      this.commit(r.m.id);
      this.mirrorPartnerLevel(r.m.id); // a BAL-linked partner tracks the fader live
    };
    fader.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      fader.setPointerCapture(e.pointerId);
      const rect = fader.getBoundingClientRect();
      const move = (ev: PointerEvent): void => {
        const frac = 1 - (ev.clientY - rect.top - 6) / (rect.height - 12);
        setLevel(fracToDb(frac, range));
      };
      move(e);
      const up = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    fader.addEventListener("keydown", (e) => {
      const cur = usesSend ? this.getSend(r.m.id, this.mode as SendTarget) : this.getMain(r.m);
      // Each range defines its own detent step (OSC: whole dB; level_gain: one grid
      // detent, a step down off the floor landing on -∞).
      const base = cur < range.min ? range.min : cur;
      let next: number | null = null;
      if (e.key === "ArrowUp") next = range.step(base, 1);
      else if (e.key === "ArrowDown") next = range.step(base, -1);
      else if (e.key === "PageUp") next = range.step(base, 6);
      else if (e.key === "PageDown") next = range.step(base, -6);
      else if (e.key === "Home") next = range.max;
      else if (e.key === "End") next = range.off;
      if (next === null) return;
      e.preventDefault();
      setLevel(next);
    });
    // Double-click resets the fader to its factory value.
    fader.addEventListener("dblclick", () => {
      const fp = this.factoryPlan();
      setLevel(usesSend ? this.sendLevelOf(fp, r.m.id, this.mode as SendTarget) : this.mainLevelOf(fp, r.m));
    });
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
  private startMeters(): void {
    if (!this.live || !this.visible) return;
    const taps: MeterTap[] = [];
    for (const r of this.refs.values()) if (r.tap) taps.push(r.tap);
    const addrs = tapAddrs(taps);
    const sig = addrs.map((a) => a.join(":")).join(",");
    if (!this.unsub || sig !== this.subSig) {
      this.unsub?.();
      this.unsub = subscribeMeters(this.store, addrs);
      this.subSig = sig;
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
    for (const r of this.refs.values()) {
      if (!r.tap) continue;
      const reading = this.store.readingTap(r.tap);
      if (!reading) continue;
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
        // Fast attack, slow release for a meter-like response; peak hold decays slowly.
        ln.v = target > ln.v ? target : ln.v + (target - ln.v) * 0.3;
        ln.pk = Math.max(ln.pk * 0.985, ln.v);
        // OVER clip cap: latch full on a clip in this channel, then fade so a brief
        // over lingers.
        ln.over = chOver ? 1 : ln.over * 0.95;
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
  }

  // ---- level get/set on the plan ----

  private isFxChannel(id: string): boolean {
    return id === "bus.fx1" || id === "bus.fx2";
  }
  private isMixMode(): boolean {
    return this.mode === "bus.mix1" || this.mode === "bus.mix2";
  }
  private isMixBus(id: string): boolean {
    return id === "bus.mix1" || id === "bus.mix2";
  }

  // Channels and FX channels follow send-on-fader in a send mode; FX channels only
  // to MIX buses. Everything else always shows its own main level.
  private usesSend(m: StripModel): boolean {
    return this.mode !== "main" && (m.isChannel || (this.isFxChannel(m.id) && this.isMixMode()));
  }

  /** The wire from `fromId`'s out to `toId`'s in, if any. */
  private sendConn(plan: Plan, fromId: string, toId: string): PlanConnection | undefined {
    return plan.connections.find((c) => c.from === ref(fromId, "out") && c.to === ref(toId, "in"));
  }

  private hasSend(id: string, target: SendTarget): boolean {
    return this.sendConn(this.hooks.getPlan(), id, target) !== undefined;
  }

  /** Live getter for the connection a tab-scoped strip control (MUTE / PRE) edits:
   *  the → MIX/FX send in a send mode, or the → STEREO main path in MAIN. Used by
   *  both input-channel and FX-channel strips. */
  private sendStripConn(id: string, usesSend: boolean): () => PlanConnection | undefined {
    const target = usesSend ? (this.mode as SendTarget) : MAIN_BUS;
    return () => this.sendConn(this.hooks.getPlan(), id, target);
  }

  /** Shared PAN/BALANCE knob spec (±63, C / Ln / Rn display); get/set/reset bind
   *  the source — a connection's send pan or a node's master balance. */
  private panKnobSpec(get: () => number, set: (v: number) => void, reset: number, readonlyTitle?: string): KnobSpec {
    return { get, set, min: PAN_MIN, max: PAN_MAX, step: 1, format: (v) => (v === 0 ? "C" : v < 0 ? "L" + -v : "R" + v), reset, readonlyTitle };
  }

  /** Add a PAN/BALANCE knob bound to a send connection's `pan` (L63 – C – R63),
   *  resetting to the factory plan's value on double-click. */
  private addSendPanKnob(head: HTMLElement, id: string, target: string, label: string, readonlyTitle?: string): void {
    const conn = (): PlanConnection | undefined => this.sendConn(this.hooks.getPlan(), id, target);
    const factory = this.sendConn(this.factoryPlan(), id, target)?.params?.pan ?? 0;
    this.addKnob(head, label, this.panKnobSpec(
      () => conn()?.params?.pan ?? 0,
      (v) => { const c = conn(); if (c) c.params = { ...c.params, pan: v }; },
      factory,
      readonlyTitle,
    ), id);
  }

  /** Add a BALANCE/PAN knob bound to a bus node's own master balance (`pan`,
   *  STEREO 583 / MIX 676), resetting to the factory plan's value on double-click. */
  private addNodePanKnob(head: HTMLElement, id: string, label: string): void {
    const factory = this.factoryPlan().nodeParams[id]?.pan ?? 0;
    this.addKnob(head, label, this.panKnobSpec(
      () => this.hooks.getPlan().nodeParams[id]?.pan ?? 0,
      (v) => void (this.nodeParamsOf(id).pan = v),
      factory,
    ), id);
  }

  private nodeParamsOf(id: string): NodeParams {
    const plan = this.hooks.getPlan();
    return (plan.nodeParams[id] ??= {});
  }

  /** Apply a console edit to `id`: mirror it onto the linked partner when the pair
   *  is in BAL mode, then run the shared change funnel. Returns whether it mirrored
   *  (the caller rebuilds so the partner strip catches up). */
  private commit(id: string): boolean {
    const mirrored = mirrorBalPair(this.hooks.getModel(), this.hooks.getPlan(), id);
    this.hooks.onChange();
    return mirrored;
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
    const db = this.usesSend(pr.m) ? this.getSend(partner!, this.mode as SendTarget) : this.getMain(pr.m);
    this.updateStripLevel(pr, db);
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
    return this.sendConn(plan, m.id, MAIN_BUS)?.params?.level ?? 0;
  }

  private getMain(m: StripModel): number {
    return this.mainLevelOf(this.hooks.getPlan(), m);
  }

  private setMain(m: StripModel, db: number): void {
    const plan = this.hooks.getPlan();
    if (m.isOsc) {
      const np = this.nodeParamsOf(m.id);
      np.osc = { ...np.osc, level: db };
      return;
    }
    if (m.fadersOnly) {
      this.nodeParamsOf(m.id).level = db;
      return;
    }
    const conn = this.sendConn(plan, m.id, MAIN_BUS);
    if (conn) conn.params = { ...conn.params, level: db };
  }

  private sendLevelOf(plan: Plan, id: string, target: SendTarget): number {
    return this.sendConn(plan, id, target)?.params?.level ?? LEVEL_OFF_DB;
  }

  private getSend(id: string, target: SendTarget): number {
    return this.sendLevelOf(this.hooks.getPlan(), id, target);
  }

  private setSend(id: string, target: SendTarget, db: number): void {
    const conn = this.sendConn(this.hooks.getPlan(), id, target);
    // The console adjusts an existing send's level only; it never adds or removes
    // routing (that stays in the graph). Unconnected send strips are hidden, so a
    // conn is present here in practice — bail defensively if not.
    if (!conn) return;
    conn.params = { ...conn.params, level: db };
  }

  // INS FX has no separate on/off flag — "off" is the No Effect value. Toggling
  // off remembers the chosen effect so toggling back on restores it (else the
  // first real option). Returns the new on state.
  private toggleInsFx(id: string, options: InsertFxOption[]): boolean {
    const np = this.nodeParamsOf(id);
    const cur = np.insertFx;
    if (cur != null && cur !== INSERT_FX_NONE) {
      this.lastInsFx.set(id, cur);
      np.insertFx = INSERT_FX_NONE;
      return false;
    }
    np.insertFx = this.lastInsFx.get(id) ?? options.find((o) => o.value !== INSERT_FX_NONE)?.value ?? INSERT_FX_NONE;
    return np.insertFx !== INSERT_FX_NONE;
  }

  // Build a labelled rotary knob (label / value / knob) in the strip head and
  // wire it. Shared by the channel gain and the monitor PHONES level.
  private addKnob(head: HTMLElement, label: string, k: KnobSpec, id: string): void {
    const box = el("div", "con-gain");
    const info = el("div", "info");
    const lbl = el("span", "lbl");
    lbl.textContent = label;
    const val = el("span", "val");
    info.append(lbl, val);
    const knob = el("div", "con-knob" + (k.readonlyTitle ? " readonly" : ""));
    knob.setAttribute("role", "slider");
    knob.setAttribute("aria-label", label);
    knob.append(el("i", "ind"));
    box.append(info, knob);
    head.append(box);
    // A device-locked knob shows its value but takes no input; wireKnob paints the
    // value in both cases and only skips the drag / key handlers when locked.
    if (k.readonlyTitle) {
      knob.setAttribute("aria-disabled", "true");
      knob.title = k.readonlyTitle;
    } else {
      knob.tabIndex = 0;
    }
    this.wireKnob(knob, val, k, id);
  }

  // Rotary knob: vertical drag (≈ full range over 150px) and arrow keys edit the
  // value (snapped to `step`); the indicator rotates over a 270° sweep; a
  // double-click resets to `reset`. Reads/writes via the spec's get/set.
  private wireKnob(knob: HTMLElement, val: HTMLElement, k: KnobSpec, id: string): void {
    const angle = k.angle ?? ((v: number): number => -135 + ((v - k.min) / (k.max - k.min)) * 270);
    const show = (v: number): void => {
      val.textContent = k.format(v);
      knob.style.setProperty("--rot", angle(v) + "deg");
      knob.setAttribute("aria-valuenow", String(v));
    };
    const apply = (raw: number): void => {
      const snapped = Number((Math.round(raw / k.step) * k.step).toFixed(4));
      const v = Math.max(k.min, Math.min(k.max, snapped));
      k.set(v);
      show(v);
      this.commit(id);
    };
    show(Math.max(k.min, Math.min(k.max, k.get()))); // initial display, not dirty
    if (k.readonlyTitle) return; // device-locked: value painted, no input handlers
    knob.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      knob.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const start = k.get();
      const move = (ev: PointerEvent): void => apply(start + ((startY - ev.clientY) / 150) * (k.max - k.min));
      const up = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        this.syncPartnerStrip(id);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    knob.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp" || e.key === "ArrowRight") apply(k.get() + k.step);
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft") apply(k.get() - k.step);
      else return;
      e.preventDefault();
      this.syncPartnerStrip(id);
    });
    knob.addEventListener("dblclick", () => {
      apply(k.reset); // reset to factory value
      this.syncPartnerStrip(id);
    });
  }
}

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

// WCAG relative luminance of a #rrggbb colour (0..1).
function relLum(n: number): number {
  const ch = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}
function contrast(a: number, b: number): number {
  const la = relLum(a) + 0.05;
  const lb = relLum(b) + 0.05;
  return la > lb ? la / lb : lb / la;
}

// Scribble label ink for a device CH SETTING colour: pick black or white by which
// gives the higher contrast (a brightness threshold mis-picks on mid-tone reds/
// purples), and pair it with a faint opposite-tone halo so the small device name
// stays crisp even over a mid-tone colour neither ink clears cleanly.
function inkOn(hex: string): { color: string; shadow: string } {
  const light = { color: "#fff", shadow: "0 1px 1px rgba(0, 0, 0, 0.55)" };
  const dark = { color: "#0e0c08", shadow: "0 1px 1px rgba(255, 255, 255, 0.5)" };
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const bg = m ? parseInt(m[1], 16) : 0; // unparseable → black bg → white ink
  return contrast(0xffffff, bg) >= contrast(0x0e0c08, bg) ? light : dark;
}
