// CONSOLE view: a mixer-style overview of every level-settable node, laid out as
// vertical channel strips. Each strip shows the set fader level (amber ladder),
// the live signal meter (green→red, only while Live sync streams), mute, gain, and
// EQ. A per-strip SENDS rack (between the head and the fader zone) gives every
// strip always-available columns for all of its MIX/FX sends — an enable chip, a
// PRE button and a vertical mini-fader per send — plus a SEND PAN popover.
// Edits go straight onto the plan and through the shared change funnel, so Live
// sync mirrors them to the device exactly like the graph/inspector do.

import type { DeviceModel } from "../models/types";
import { defaultPlan } from "../models/initial-state";
import { LEVEL_MAX_DB, LEVEL_MIN_DB, LEVEL_OFF_DB, sendConnection, type NodeParams, type Plan, type PlanConnection } from "../core/plan";
import { LEVEL_POS_MAX, levelToPos, posToLevel, stepLevel } from "../core/levels";
import { defaultTapKey, hasMeter, isStereoTap, METER_FLOOR_DB, METER_GREEN_TOP_DB, METER_YELLOW_TOP_DB, MeterStore, subscribeMeters, tapAddrs, tapFor, tapsFor, type MeterTap } from "../core/meters";
import { loadJson, saveJson } from "../core/storage";
import { channelEqUnavailable } from "../core/constraints";
import { busBalance, channelControl, insertFxControl } from "../core/control/translate";
import { isBalLinkedPair, isNodeInactive, mirrorBalPair, mixSendLocks, partnerChannel, sendTapWritable } from "../core/routing";
import { INSERT_FX_NONE, type InsertFxOption } from "../core/control/params";
import { DELAY_TIME_MAX_MS, DELAY_TIME_MIN_MS, PAN_MAX, PAN_MIN, PHONES_LEVEL_DEFAULT, PHONES_LEVEL_MAX, PHONES_LEVEL_MIN } from "../core/control/vd";
// MAIN_BUS (the STEREO master, every channel's fixed main send) and the
// MIX/FX send targets are shared with the MIDI control catalog.
import { controlId, MAIN_BUS, SEND_TARGETS, type SendTarget } from "../core/midi/controls";
import { setLevelText } from "./glyph";
import { el, onWheelStep } from "./dom";
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
  for (const [x, y, h] of [[0, 4, 4], [3.1, 2, 6], [6.2, 0, 8]]) {
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
  toggle: () => void;
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
  format: (v: number) => string;
  reset: number;
  /** Indicator angle (deg) for a value; default is a -135°..+135° sweep over the
   *  range. Override to place specific values (e.g. PHONES 2/8) at the horizontal. */
  angle?: (v: number) => number;
  /** When set, the knob shows its value but cannot be edited (a device-locked
   *  control, e.g. a Pan-Link send pan). The string is the disabled tooltip. */
  readonlyTitle?: string;
}

/** MIDI-learn integration: while learn mode is active, activating an armable
 *  console control arms it for binding instead of editing it (the MIDI panel
 *  owns the mode / armed state and re-renders the console when they change). */
export interface ConsoleMidiHooks {
  learnActive: () => boolean;
  armedId: () => string | null;
  isMapped: (id: string) => boolean;
  arm: (id: string) => void;
}

export interface ConsoleHooks {
  getModel: () => DeviceModel;
  getPlan: () => Plan;
  /** An edit changed the plan (mute / fader / EQ): flag dirty + schedule live sync. */
  onChange: () => void;
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
  private store = new MeterStore();
  private unsub: (() => void) | null = null;
  private subSig = ""; // signature of the currently subscribed address set
  private raf = 0;
  private live = false;
  private visible = false;
  private meterTap = new Map<string, string>(); // node id → chosen tap key (override)
  private idsCache = { key: "", ids: new Set<string>() }; // visibleIds memo (model + hidden)
  private tapModel = ""; // model id the meterTap map was loaded for
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
    // A hung node (a ducker) has no strip of its own — its chip lives on the
    // parent strip (attachTo). Retarget to the parent so an external edit of the
    // child (a MIDI DUCKER toggle / device follow) repaints that chip; without
    // this the refs lookup misses and the chip stays stale until a full re-render.
    const stripId = this.hooks.getModel().nodes.find((n) => n.id === id)?.attachTo ?? id;
    const old = this.refs.get(stripId);
    if (!old) return;
    const fresh = this.buildStrip(this.toStripModel(stripId));
    // buildStrip re-registered refs.get(stripId) with fresh meter elements. Carry the
    // per-lane ballistics (v/pk/over) so the level + peak-hold + clip latch don't reset,
    // but leave the last-written trackers (lv/lpk/lov/lmtr) at their fresh sentinels —
    // the new elements are undrawn, so paintMeters must repaint them, not skip as
    // unchanged. Lane count is stable across a refresh (same tap), so carry by index.
    this.refs.get(stripId)!.lanes.forEach((ln, i) => {
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
    // SEND PAN popover: one reused element, anchored below the strip's PAN ▾ button.
    this.sendPanPop = el("div", "con-spop below");
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
      if (e.key === "Escape" && this.sendPanOpenFor) this.closeSendPan();
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
      this.idsCache = { key, ids: new Set(this.hooks.getModel().nodes.map((n) => n.id).filter((i) => !h.has(i))) };
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
    const isMon = id === "bus.mon1" || id === "bus.mon2";
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
      hasPhones: id === "bus.mon1" || id === "bus.mon2",
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
  private buildSendCol(m: StripModel, target: SendTarget, swap: (text: string | null) => void): { el: HTMLElement; ref: SendColRef } {
    const range = m.range;
    // The column's connection object is stable for this build's lifetime — edits
    // mutate its `params` in place, and a plan swap re-renders — so capture it once
    // instead of re-scanning plan.connections for every read/write. `pre`/`level`/`on`
    // are read off `c.params` live (reassigned in place).
    const c = sendConnection(this.hooks.getPlan(), m.id, target);
    const isMix = target === "bus.mix1" || target === "bus.mix2";
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
    const chip = this.buildChip(m.id, SEND_SHORT[target], c?.params?.on !== false, () => {
      const next = c?.params?.on === false; // was off → turn on
      if (c) c.params = { ...c.params, on: next };
      return next;
    }, { cls: "con-sl", midiId: controlId(m.id, "mute", target), after: (next) => col.classList.toggle("off", !next) });

    // PRE button
    const tapReadonly = this.live && !sendTapWritable(this.hooks.getModel(), m.id, target);
    const preBtn = this.buildChip(m.id, t().console.pre, c?.params?.tap === "pre", () => {
      const next = c?.params?.tap !== "pre";
      if (c) c.params = { ...c.params, tap: next ? "pre" : "post" };
      this.updateColLevel(ref, range, c?.params?.level ?? LEVEL_OFF_DB, next); // refresh PRE prefix
      return next;
    }, tapReadonly
      ? { cls: "con-slp", readonlyTitle: t().inspector.prePostLcdOnly, title: t().console.preHint }
      : { cls: "con-slp", midiId: isMix ? controlId(m.id, "tap", target) : undefined, title: t().console.preHint });

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
      fader.setPointerCapture(e.pointerId);
      dragging = true;
      const startY = e.clientY;
      const startFrac = dbToFrac(level(), range);
      const travel = fader.getBoundingClientRect().height - 12;
      let moved = false;
      const move = (ev: PointerEvent): void => {
        const dy = startY - ev.clientY;
        if (!moved && Math.abs(dy) < 3) return; // threshold guards mis-grabs / dblclick
        moved = true;
        const frac = startFrac + (dy * (ev.shiftKey ? 0.25 : 1)) / travel;
        set(fracToDb(frac, range));
      };
      const up = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        dragging = false;
        swap(rackTouched() ? readoutText() : null); // keep it if still hovered/focused
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
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
    onWheelStep(fader, (dir) => set(this.faderWheelStep(range, level(), dir)), () => this.hooks.midi?.learnActive());
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
      if ((target !== "bus.mix1" && target !== "bus.mix2") || !this.hasSend(stripId, target)) continue;
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
      const { knob, val } = this.buildKnob(spec, SEND_LABEL[target], stripId, "rv", controlId(stripId, "pan", target), false);
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
    const phh = pop.offsetHeight;
    let left = align === "center" ? r.left + r.width / 2 - pw / 2 : r.right - pw;
    left = Math.max(6, Math.min(left, window.innerWidth - pw - 6));
    let top = r.bottom + gap;
    if (top + phh > window.innerHeight - 6) top = Math.max(6, r.top - phh - gap);
    pop.style.left = left + "px";
    pop.style.top = top + "px";
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

  /** Learn-mode affordances on an armable element: target ring, armed pulse,
   *  already-mapped dot. No-op outside learn mode (no visual noise). */
  private midiMark(el: HTMLElement, id: string | undefined): void {
    const midi = this.hooks.midi;
    if (!id || !midi?.learnActive()) return;
    el.classList.add("midi-target");
    if (midi.armedId() === id) el.classList.add("midi-armed");
    if (midi.isMapped(id)) el.classList.add("midi-mapped");
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

  // The scribble strip: the CH SETTING colour + a power LED, the node name and the
  // device CH SETTING name row ("—" when unset, so every strip is the same height).
  // Shared by both strip builders. When the strip has an on/off (every strip but
  // STREAMING) the whole scribble is the power button; the LED reflects its state.
  private scribble(m: StripModel): HTMLElement {
    const scrib = el("div", "con-scribble");
    this.paintScribble(scrib, m.id);
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
  // CH_ON / FX / MIX 675 (armed as "chOn", since "mute" already carries the CH/FX/MIX
  // → STEREO send) or a STEREO / MONITOR master (which has no such send, so the LED
  // reuses the send-less "mute" id) — or the oscillator on osc.on. STREAMING: none.
  private powerSpec(m: StripModel): PowerSpec | null {
    if (m.isStream) return null;
    if (m.isOsc) {
      return {
        on: this.hooks.getPlan().nodeParams[m.id]?.osc?.on === true,
        toggle: () => {
          const p = this.nodeParamsOf(m.id);
          p.osc = { ...p.osc, on: !(p.osc?.on === true) };
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
      spec.toggle();
      this.commit(m.id);
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
    opts?: { readonlyTitle?: string; midiId?: string; title?: string },
  ): void {
    parent.append(this.buildChip(id, label, on, toggle, { ...opts, mute }));
  }

  // The chip primitive, returning the element. `cls` picks the base class (con-chip
  // for the head chips, con-sl / con-slp for the rack's enable chip / PRE button);
  // opts.mute paints the MUTE colour, opts.after runs after the toggle (before commit),
  // opts.readonlyTitle renders it inert with a tooltip, opts.midiId arms MIDI learn.
  private buildChip(
    id: string,
    label: string,
    on: boolean,
    toggle: () => boolean,
    opts?: { cls?: string; mute?: boolean; readonlyTitle?: string; midiId?: string; title?: string; after?: (next: boolean) => void },
  ): HTMLElement {
    const { cls = "con-chip", mute, readonlyTitle, midiId, title, after } = opts ?? {};
    const chip = el("div", cls + (mute ? " mute" : "") + (on ? " on" : "") + (readonlyTitle ? " readonly" : ""));
    chip.textContent = label;
    chip.setAttribute("role", "button");
    chip.setAttribute("aria-pressed", String(on));
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
      if (this.commit(id)) this.render();
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
      this.addKnob(head, "LEVEL", {
        get: () => this.getMain(m),
        set: (v) => this.setMain(m, v),
        min: -96,
        max: 0,
        step: 1,
        format: (v) => v.toFixed(1),
        reset: factory,
        angle: (v) => (v <= -50 ? -135 + ((v + 96) / 46) * 45 : v >= -8 ? 90 + ((v + 8) / 8) * 45 : -90 + ((v + 50) / 42) * 180),
      }, m.id, controlId(m.id, "level"));
    }
    // STREAMING: a DELAY on/off chip and a TIME knob (the delay time, 1…1000 ms).
    // Gives the otherwise-bare head controls so the strip reads as purposeful, and
    // mirrors the OSCILLATOR's ON + LEVEL pairing. Finer time steps stay in the inspector.
    if (m.isStream) {
      const chips = el("div", "con-chips");
      const delayOn = (): boolean => this.hooks.getPlan().nodeParams[m.id]?.delay?.on ?? false;
      this.makeChip(m.id, chips, "DELAY", false, delayOn(), () => {
        const np = this.nodeParamsOf(m.id);
        const next = !delayOn();
        np.delay = { ...np.delay, on: next };
        return next;
      });
      chips.append(el("div", "con-chip spacer"));
      head.append(chips);
      const factory = this.factoryPlan().nodeParams[m.id]?.delay?.time ?? DELAY_TIME_MIN_MS;
      this.addKnob(head, "TIME", {
        get: () => this.hooks.getPlan().nodeParams[m.id]?.delay?.time ?? DELAY_TIME_MIN_MS,
        set: (v) => {
          const np = this.nodeParamsOf(m.id);
          np.delay = { ...np.delay, time: v };
        },
        min: DELAY_TIME_MIN_MS,
        max: DELAY_TIME_MAX_MS,
        step: 1, // whole-ms on the knob; the inspector keeps the 0.01 ms grid
        format: (v) => (v < 100 ? v.toFixed(1) : String(Math.round(v))),
        reset: factory,
      }, m.id);
    }
    strip.append(head);
    // A meter-only strip has no sends, so its rack is the dimmed SENDS header only —
    // but it reserves the same rack height as every other strip so the fader/meter
    // tops stay aligned (and the global collapse is reachable from its header too).
    strip.append(this.buildSendRack(m).el);

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
    mtrCell.append(readCap(t().console.readMeter), mtrEl);
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
    this.closeSendPan();
    this.host.classList.toggle("midi-learn", this.hooks.midi?.learnActive() ?? false);
    this.refs.clear();
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
    this.startMeters(); // rescope the meter subscription to the rebuilt strips
  }

  // The tallest head (a mono channel carries the most chips + two knobs) sets the
  // fixed head height for every strip. Measure it by laying out the strips off-screen
  // with auto-height heads, then cache by model + hidden set (the only inputs that
  // change which strips exist).
  private mainHeadHeight(): number {
    const key = this.hooks.getModel().id + "|" + [...this.hooks.getPlan().hidden].sort().join(",");
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
    type BoolKey = "gateOn" | "compOn" | "eqOn" | "phantom" | "phase" | "phaseL" | "phaseR" | "hpf" | "hiZ" | "cueInterrupt" | "mono";
    const planOf = (): NodeParams => this.hooks.getPlan().nodeParams[m.id] ?? {};
    const boolChip = (parent: HTMLElement, label: string, key: BoolKey, def: boolean, title?: string): void => {
      this.makeChip(m.id, parent, label, false, planOf()[key] ?? def, () => {
        const next = !(planOf()[key] ?? def);
        this.nodeParamsOf(m.id)[key] = next;
        return next;
      }, { midiId: controlId(m.id, key), title });
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
      this.makeChip(m.id, top, t().console.mute, true, !sendOn(), () => {
        const c = conn();
        const nextOn = !sendOn();
        if (c) c.params = { ...c.params, on: nextOn };
        return !nextOn; // chip "on" (highlighted) = muted
      }, { midiId: controlId(m.id, "mute") });
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
    if (m.isMono) boolChip(proc, "GATE", "gateOn", false);
    if (m.isMono) boolChip(proc, "COMP", "compOn", false);
    if (m.hasEq) {
      // Stereo-channel EQ is inert at 176.4 / 192 kHz: show the chip forced off and
      // read-only (matches the inspector's locked EQ toggle), else a live toggle.
      if (channelEqUnavailable(m.id, this.hooks.getPlan().sampleRate))
        this.makeChip(m.id, proc, t().console.eq, false, false, () => false, { readonlyTitle: t().inspector.eqRateLocked });
      else boolChip(proc, t().console.eq, "eqOn", true);
    }
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
      }, { midiId: controlId(duckerId, "duckerOn") });
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
      this.addKnob(head, m.isMono ? "A.GAIN" : "D.GAIN", {
        get: () => this.hooks.getPlan().nodeParams[m.id]?.gain ?? factory,
        set: (v) => void (this.nodeParamsOf(m.id).gain = v),
        min,
        max,
        step: 1,
        format: (v) => (v > 0 ? "+" : "") + v,
        reset: factory,
        angle: (v) => -90 + ((v - hl) / (hr - hl)) * 180,
      }, m.id, controlId(m.id, "gain"));
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
      }, m.id, controlId(m.id, "phonesLevel"));
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
    if (tapsFor(m.id).length > 1) tapHead.append(this.buildTapBadge(m.id));
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
    cap.style.setProperty("--pos", (1 - dbToFrac(level, m.range)) * 100 + "%");
    fader.append(track, zero, cap);

    // Meter column: the ladder shares the fader ruler, topping out at the 0 dB mark
    // with the OVER clip window above it. Stereo taps split into independent L/R bars.
    const tap = hasMeter(m.id) ? tapFor(m.id, tapKey) ?? null : null;
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
    const f = fmtDb(level, m.range);
    setLevelText(dbEl, f.text);
    if (f.off) dbEl.classList.add("off");
    faderCell.append(readCap(t().console.readFader), dbEl);
    readout.append(faderCell);
    const mtrEl = el("div", "rv");
    if (hasMeter(m.id)) {
      const mtrCell = el("div", "rd mtr");
      mtrEl.textContent = "—";
      mtrCell.append(readCap(t().console.readMeter), mtrEl);
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
      sendCols: rack.cols,
    };
    this.refs.set(m.id, refObj);
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
      this.setMain(r.m, db);
      this.updateStripLevel(r, db);
      this.commit(r.m.id);
      this.mirrorPartnerLevel(r.m.id); // a BAL-linked partner tracks the fader live
    };
    fader.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (this.midiArm(midiId)) return;
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
    onWheelStep(fader, (dir) => setLevel(this.faderWheelStep(range, this.getMain(r.m), dir)), () => this.hooks.midi?.learnActive());
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
  private panKnobSpec(get: () => number, set: (v: number) => void, reset: number, readonlyTitle?: string): KnobSpec {
    return { get, set, min: PAN_MIN, max: PAN_MAX, step: 1, format: (v) => (v === 0 ? "C" : v < 0 ? "L" + -v : "R" + v), reset, readonlyTitle };
  }

  /** Add a PAN/BALANCE knob bound to a send connection's `pan` (L63 – C – R63),
   *  resetting to the factory plan's value on double-click. */
  private addSendPanKnob(head: HTMLElement, id: string, target: string, label: string, readonlyTitle?: string): void {
    const conn = (): PlanConnection | undefined => sendConnection(this.hooks.getPlan(), id, target);
    const factory = sendConnection(this.factoryPlan(), id, target)?.params?.pan ?? 0;
    this.addKnob(head, label, this.panKnobSpec(
      () => conn()?.params?.pan ?? 0,
      (v) => { const c = conn(); if (c) c.params = { ...c.params, pan: v }; },
      factory,
      readonlyTitle,
    ), id, controlId(id, "pan", target === MAIN_BUS ? undefined : target));
  }

  /** Add a BALANCE/PAN knob bound to a bus node's own master balance (`pan`,
   *  STEREO 583 / MIX 676), resetting to the factory plan's value on double-click. */
  private addNodePanKnob(head: HTMLElement, id: string, label: string): void {
    const factory = this.factoryPlan().nodeParams[id]?.pan ?? 0;
    this.addKnob(head, label, this.panKnobSpec(
      () => this.hooks.getPlan().nodeParams[id]?.pan ?? 0,
      (v) => void (this.nodeParamsOf(id).pan = v),
      factory,
    ), id, controlId(id, "pan"));
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
    const conn = sendConnection(plan, m.id, MAIN_BUS);
    if (conn) conn.params = { ...conn.params, level: db };
  }

  // The factory send level (double-click reset); the live send level/pan/tap are read
  // off the column's captured connection object (see buildSendCol), not via a helper.
  private sendLevelOf(plan: Plan, id: string, target: SendTarget): number {
    return sendConnection(plan, id, target)?.params?.level ?? LEVEL_OFF_DB;
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
  // `midiId` makes the knob armable for MIDI learn.
  private addKnob(head: HTMLElement, label: string, k: KnobSpec, id: string, midiId?: string): void {
    const box = el("div", "con-gain");
    const info = el("div", "info");
    const lbl = el("span", "lbl");
    lbl.textContent = label;
    const { knob, val } = this.buildKnob(k, label, id, "val", midiId);
    info.append(lbl, val);
    box.append(info, knob);
    head.append(box);
  }

  // The knob primitive: the con-knob element + its value span (readonly / aria /
  // tabindex plumbing), wired via wireKnob. addKnob wraps it in the head's con-gain
  // box; the SEND PAN popover wraps it in a pcol (with a "rv" value class). A
  // device-locked knob shows its value but takes no input (wireKnob skips handlers).
  private buildKnob(k: KnobSpec, ariaLabel: string, id: string, valCls: string, midiId?: string, partnerSync = true): { knob: HTMLElement; val: HTMLElement } {
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
  private wireKnob(knob: HTMLElement, val: HTMLElement, k: KnobSpec, id: string, midiId?: string, partnerSync = true): void {
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
    this.midiMark(knob, midiId);
    knob.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (this.midiArm(midiId)) return;
      knob.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const start = k.get();
      const move = (ev: PointerEvent): void => apply(start + ((startY - ev.clientY) / 150) * (k.max - k.min));
      const up = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        if (partnerSync) this.syncPartnerStrip(id);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    knob.addEventListener("keydown", (e) => {
      if (this.midiLearnKey(e, midiId)) return;
      if (e.key === "ArrowUp" || e.key === "ArrowRight") apply(k.get() + k.step);
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft") apply(k.get() - k.step);
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
    onWheelStep(knob, (dir) => {
      apply(k.get() + dir * k.step);
      if (partnerSync) this.syncPartnerStrip(id);
    }, () => this.hooks.midi?.learnActive());
  }
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
