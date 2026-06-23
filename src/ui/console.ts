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
import { hasMeter, METER_FLOOR_DB, METER_TOP_DB, metersForNodes, MeterStore, subscribeMeters } from "../core/meters";
import { channelControl, insertFxControl } from "../core/control/translate";
import { isBalLinkedPair, mirrorBalPair, partnerChannel, sendTapWritable } from "../core/routing";
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

// Fader-position curve: 0 dB sits high like a real fader (exponent < 1 lifts the
// top of the travel). Shared by the set ladder, the cap, and the dB ruler.
const CURVE = 0.78;

interface LevelRange {
  min: number;
  max: number;
  off: number;
}
const NORMAL_RANGE: LevelRange = { min: LEVEL_MIN_DB, max: LEVEL_MAX_DB, off: LEVEL_OFF_DB };
const OSC_RANGE: LevelRange = { min: -96, max: 0, off: -96 };

function dbToFrac(db: number, r: LevelRange): number {
  if (db <= r.min) return 0;
  const t01 = (Math.min(db, r.max) - r.min) / (r.max - r.min);
  return Math.pow(t01, CURVE);
}
function fracToDb(frac: number, r: LevelRange): number {
  const f = Math.max(0, Math.min(1, frac));
  if (f <= 0.005) return r.off;
  const db = r.min + Math.pow(f, 1 / CURVE) * (r.max - r.min);
  return Math.round(db * 2) / 2;
}
function meterFrac(dbfs: number): number {
  return Math.max(0, Math.min(1, (dbfs - METER_FLOOR_DB) / (METER_TOP_DB - METER_FLOOR_DB)));
}
function fmtDb(db: number, r: LevelRange): { text: string; off: boolean } {
  if (db < r.min) return { text: "-∞", off: true };
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
  range: LevelRange;
}

interface StripRef {
  m: StripModel;
  cap: HTMLElement;
  sigFill: HTMLElement;
  sigPeak: HTMLElement;
  sigClip: HTMLElement;
  fader: HTMLElement;
  readDb: HTMLElement;
  // v/pk/over: live ballistics; lv/lpk/lov: last value written to the DOM (-1 =
  // none yet) so paintMeters can skip unchanged writes.
  sig: { v: number; pk: number; over: number; lv: number; lpk: number; lov: number };
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
}

export interface ConsoleHooks {
  getModel: () => DeviceModel;
  getPlan: () => Plan;
  /** An edit changed the plan (mute / fader / EQ): flag dirty + schedule live sync. */
  onChange: () => void;
}

export class Console {
  private mode: Mode = "main";
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
  private bar!: HTMLElement;
  private outLabel!: HTMLElement;
  private modePick!: HTMLElement;
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
    this.stopMeters();
  }

  /** Live sync turned on/off: gate the signal meter lanes and their stream. */
  setLive(active: boolean): void {
    this.live = active;
    this.host.classList.toggle("live", active);
    // Meters stream only while live AND visible; tear them down otherwise.
    if (!active || !this.visible) this.stopMeters();
    // Rebuild so the CH → FX send Pre/Post chip flips read-only with live state;
    // render() (re)starts/re-scopes the meter stream at its tail when live.
    if (this.visible) this.render();
  }

  /** Re-read set levels after an external edit (inspector / graph / readback). */
  refresh(): void {
    if (this.visible) this.render();
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
  }

  // dB tick labels for a strip's fader range (per-channel scale between the fader
  // and meter). Top/bottom align with the fader travel, so it reads the level.
  private buildScale(range: LevelRange): HTMLElement {
    const scale = el("div", "con-scale");
    const dbs = range === OSC_RANGE ? [0, -10, -20, -40, -60, -80, -96] : [10, 0, -10, -20, -40, -60, -80, -96];
    for (const db of dbs) {
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
    const busFx = ["bus.fx1", "bus.fx2", "bus.mix1", "bus.mix2"].filter((i) => ids.has(i));
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
      range: isOsc ? OSC_RANGE : NORMAL_RANGE,
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

  private render(): void {
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
    const plan = this.hooks.getPlan();
    const model = this.hooks.getModel();
    const usesSend = this.usesSend(m);
    const level = usesSend ? this.getSend(m.id, this.mode as SendTarget) : this.getMain(m);
    const np = plan.nodeParams[m.id] ?? {};

    // In a send mode the strip's MUTE chip controls that send's ON/OFF, not the
    // channel master ON; when the master is muted the whole channel (and thus every
    // send) is silenced regardless. Surface that override at the strip level (dim +
    // a CH MUTE badge) so the per-send controls stay operable while the user still
    // sees the channel is muted. Applies to input channels and FX channels alike;
    // the MAIN tab shows the master directly via the MUTE chip instead. A MIX strip
    // reuses the same indicator: its MUTE chip is the MIX → STEREO "TO ST" send, so
    // the MIX master ON (675, edited in the graph inspector only) shows read-only as
    // the dim + CH MUTE badge here too.
    const masterMuted = (usesSend || this.isMixBus(m.id)) && np.on === false;

    const strip = el("div", "con-strip" + (isMaster ? " master" : "") + (masterMuted ? " master-muted" : ""));
    strip.style.setProperty("--rail", m.rail);

    // head: scribble + chips + gain
    const head = el("div", "con-head");
    const scrib = el("div", "con-scribble");
    // Scribble colour = the channel's CH SETTING colour (device parameter), not
    // the node-kind rail. Pick black/white text from the colour's brightness.
    // Falls back to the rail colour (via CSS) when no colour is assigned.
    const color = plan.nodeColors?.[m.id];
    if (color) {
      scrib.style.background = color;
      const ink = inkOn(color);
      scrib.style.color = ink.color;
      scrib.style.setProperty("--scrib-shadow", ink.shadow);
    }
    const name = el("div", "name");
    name.textContent = m.label; // node name
    const dev = el("div", "id");
    dev.textContent = m.deviceName || "—"; // device CH SETTING name (— when unset)
    if (!m.deviceName) dev.classList.add("empty");
    scrib.append(name, dev);
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
    const makeChip = (
      id: string,
      parent: HTMLElement,
      label: string,
      mute: boolean,
      on: boolean,
      toggle: () => boolean,
      // Read-only when set: shows the value but rejects edits (the device cannot
      // accept the write while live). The string is the explanatory tooltip; a
      // read-only chip drops its listeners and keyboard focus.
      readonlyTitle?: string,
    ): void => {
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
    };
    const boolChip = (parent: HTMLElement, label: string, key: BoolKey, def: boolean): void => {
      makeChip(m.id, parent, label, false, planOf()[key] ?? def, () => {
        const next = !(planOf()[key] ?? def);
        this.nodeParamsOf(m.id)[key] = next;
        return next;
      });
    };

    // channel + input (HA) group
    const top = el("div", "con-chips");
    if (m.hasMute) {
      if (this.isMixBus(m.id) || usesSend) {
        // The MUTE drives a connection's ON/OFF (never its wire presence): a CH/FX →
        // MIX/FX send (ships ON), or — on a MIX strip in MAIN — the MIX → STEREO "TO
        // ST" (ships off). The fixed wire is never added/removed, only params.on flips.
        const mix = this.isMixBus(m.id);
        const conn = mix
          ? () => this.sendConn(this.hooks.getPlan(), m.id, MAIN_BUS)
          : this.sendStripConn(m.id, usesSend);
        const sendOn = (): boolean => conn()?.params?.on ?? !mix; // sends default ON, TO ST off
        makeChip(m.id, top, t().console.mute, true, !sendOn(), () => {
          const c = conn();
          const nextOn = !sendOn();
          if (c) c.params = { ...c.params, on: nextOn };
          return !nextOn; // chip "on" (highlighted) = muted
        });
      } else {
        // Master ON/OFF on the node's own `on` flag: a channel (CH_ON) / the STEREO
        // master (STEREO_MASTER_ON) write to the device; a MONITOR bus is plan-only
        // (no confirmed monitor-ON param), so its mute lives in the plan alone.
        makeChip(m.id, top, t().console.mute, true, np.on === false, () => {
          const muted = planOf().on === false;
          this.nodeParamsOf(m.id).on = muted; // toggle: was muted → on, was on → muted
          return !muted;
        });
      }
    }
    // OSCILLATOR is a test-tone generator that is normally OFF, so it gets an ON
    // button (the inverse of the MUTE chips: highlighted = generating) bound to
    // osc.on rather than a MUTE that would read as pressed by default.
    if (m.isOsc) {
      const oscOn = (): boolean => planOf().osc?.on ?? false;
      makeChip(m.id, top, t().console.on, false, oscOn(), () => {
        const next = !oscOn();
        const op = this.nodeParamsOf(m.id);
        op.osc = { ...op.osc, on: next };
        return next;
      });
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
        makeChip(m.id, proc, "INS FX", false, insOn(), () => this.toggleInsFx(m.id, ifx.options));
      }
      // DUCKER: the sidechain ducker hung under a stereo channel (its own node).
      // A shelved ducker drops its chip even while the parent strip stays.
      const hidden = this.hooks.getPlan().hidden;
      const duckerId = model.nodes.find((n) => n.kind === "ducker" && n.attachTo === m.id && !hidden.includes(n.id))?.id;
      if (duckerId) {
        const duckOn = (): boolean => this.hooks.getPlan().nodeParams[duckerId]?.duckerOn === true;
        makeChip(duckerId, proc, "DUCKER", false, duckOn(), () => {
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
      makeChip(m.id, preGroup, t().console.pre, false, isPre(), () => {
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
        this.addSendPanKnob(head, m.id, target, m.isBalance ? "BAL" : "PAN");
      }
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

    // fader zone: the fader (thin slot + cap; position = setting) + level meter
    const zone = el("div", "con-faderzone");

    const fader = el("div", "con-fader");
    fader.tabIndex = 0;
    fader.setAttribute("role", "slider");
    fader.setAttribute("aria-label", m.label);
    const track = el("div", "track");
    const zero = el("div", "zero");
    zero.style.setProperty("--zero", (1 - dbToFrac(0, m.range)) * 100 + "%");
    track.append(zero);
    const cap = el("div", "cap");
    cap.style.setProperty("--pos", (1 - dbToFrac(level, m.range)) * 100 + "%");
    fader.append(track, cap);

    // Meter column: a separate OVER box on top (clip ≠ the level ceiling, and ≠
    // the dB scale), then the signal ladder below it.
    const meter = el("div", "con-meter");
    const over = el("div", "con-over");
    const sigClip = el("div", "lit");
    over.append(sigClip);
    const sigLadder = el("div", "con-ladder sig");
    const sigFill = el("div", "fill");
    const sigPeak = el("div", "peak");
    sigLadder.append(sigFill, sigPeak);
    meter.append(over, sigLadder);

    zone.append(fader, this.buildScale(m.range), meter);
    strip.append(zone);

    // readout (set-level dB only; the send destination is shown by the active tab)
    const readout = el("div", "con-readout");
    const dbEl = el("div", "db");
    const f = fmtDb(level, m.range);
    setLevelText(dbEl, f.text);
    if (f.off) dbEl.classList.add("off");
    readout.append(dbEl);
    strip.append(readout);

    const refObj: StripRef = {
      m,
      cap,
      sigFill,
      sigPeak,
      sigClip,
      fader,
      readDb: dbEl,
      sig: { v: 0, pk: 0, over: 0, lv: -1, lpk: -1, lov: -1 },
    };
    this.refs.set(m.id, refObj);
    this.wireFader(refObj, usesSend);
    return strip;
  }

  private wireFader(r: StripRef, usesSend: boolean): void {
    const range = r.m.range;
    const setLevel = (db: number): void => {
      if (usesSend) this.setSend(r.m.id, this.mode as SendTarget, db);
      else this.setMain(r.m, db);
      this.updateStripLevel(r, db);
      this.commit(r.m.id);
      this.mirrorPartnerLevel(r.m.id); // a BAL-linked partner tracks the fader live
    };
    r.fader.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      r.fader.setPointerCapture(e.pointerId);
      const rect = r.fader.getBoundingClientRect();
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
    r.fader.addEventListener("keydown", (e) => {
      const cur = usesSend ? this.getSend(r.m.id, this.mode as SendTarget) : this.getMain(r.m);
      const base = cur < range.min ? range.min : cur;
      let next: number | null = null;
      if (e.key === "ArrowUp") next = Math.min(range.max, base + 1);
      else if (e.key === "ArrowDown") next = base - 1 < range.min ? range.off : base - 1;
      else if (e.key === "PageUp") next = Math.min(range.max, base + 6);
      else if (e.key === "PageDown") next = Math.max(range.min, base - 6);
      else if (e.key === "Home") next = range.max;
      else if (e.key === "End") next = range.off;
      if (next === null) return;
      e.preventDefault();
      setLevel(next);
    });
    // Double-click resets the fader to its factory value.
    r.fader.addEventListener("dblclick", () => {
      const fp = this.factoryPlan();
      setLevel(usesSend ? this.sendLevelOf(fp, r.m.id, this.mode as SendTarget) : this.mainLevelOf(fp, r.m));
    });
  }

  private updateStripLevel(r: StripRef, db: number): void {
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
    const addrs = metersForNodes([...this.refs.keys()].filter((id) => hasMeter(id)));
    const sig = addrs.map((a) => a.join(":")).join(",");
    if (!this.unsub || sig !== this.subSig) {
      this.unsub?.();
      this.unsub = subscribeMeters(this.store, addrs);
      this.subSig = sig;
    }
    if (!this.raf) {
      const tick = (): void => {
        this.paintMeters();
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }
  }

  private stopMeters(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
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
      s.v = s.pk = s.over = 0;
      if (s.lv !== 0) {
        r.sigFill.style.setProperty("--lvl", "0%");
        s.lv = 0;
      }
      if (s.lpk !== 0) {
        r.sigPeak.style.setProperty("--pk", "0%");
        s.lpk = 0;
      }
      if (s.lov !== 0) {
        r.sigClip.style.setProperty("--clip", "0");
        s.lov = 0;
      }
    }
  }

  private paintMeters(): void {
    for (const r of this.refs.values()) {
      if (!hasMeter(r.m.id)) continue;
      const reading = this.store.reading(r.m.id);
      if (!reading) continue;
      const s = r.sig;
      const target = meterFrac(Math.max(reading.l, reading.r));
      // Fast attack, slow release for a meter-like response; peak hold decays slowly.
      s.v = target > s.v ? target : s.v + (target - s.v) * 0.3;
      s.pk = Math.max(s.pk * 0.985, s.v);
      // OVER clip cap: latch full on a clip, then fade so a brief over lingers.
      s.over = reading.overL || reading.overR ? 1 : s.over * 0.95;
      // Write only the values that actually changed (idle meters rest, so most
      // frames skip every write) — at integer-percent resolution.
      const v = Math.round(s.v * 100);
      const pk = Math.round(s.pk * 100);
      const over = s.over > 0.02 ? Math.round(s.over * 100) : 0;
      if (v !== s.lv) {
        r.sigFill.style.setProperty("--lvl", v + "%");
        s.lv = v;
      }
      if (pk !== s.lpk) {
        r.sigPeak.style.setProperty("--pk", pk + "%");
        s.lpk = pk;
      }
      if (over !== s.lov) {
        r.sigClip.style.setProperty("--clip", over / 100 + "");
        s.lov = over;
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

  /** Add a PAN/BALANCE knob bound to a send connection's `pan` (L63 – C – R63),
   *  resetting to the factory plan's value on double-click. */
  private addSendPanKnob(head: HTMLElement, id: string, target: string, label: string): void {
    const conn = (): PlanConnection | undefined => this.sendConn(this.hooks.getPlan(), id, target);
    const factory = this.sendConn(this.factoryPlan(), id, target)?.params?.pan ?? 0;
    this.addKnob(head, label, {
      get: () => conn()?.params?.pan ?? 0,
      set: (v) => {
        const c = conn();
        if (c) c.params = { ...c.params, pan: v };
      },
      min: PAN_MIN,
      max: PAN_MAX,
      step: 1,
      format: (v) => (v === 0 ? "C" : v < 0 ? "L" + -v : "R" + v),
      reset: factory,
    }, id);
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
    const knob = el("div", "con-knob");
    knob.tabIndex = 0;
    knob.setAttribute("role", "slider");
    knob.setAttribute("aria-label", label);
    knob.append(el("i", "ind"));
    box.append(info, knob);
    head.append(box);
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
