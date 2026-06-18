// Renders the currently selected node or connection. Shows details, edits send
// parameters (level/pan/pre-post), removes a connection, and (no selection)
// lists recent plans for quick reopen.

import type { ConnectionKind, DeviceModel, NodeKind } from "../models/types";
import { fullLabel, parseRef } from "../models/types";
import type { ConnParams, EqBand, NodeParams, Plan, PlanConnection } from "../core/plan";
import { LEVEL_MAX_DB, LEVEL_MIN_DB } from "../core/plan";
import { isFixedConnection, sendHasTap } from "../core/routing";
import type { EqControl } from "../core/control/translate";
import {
  busEqOn,
  busFader,
  channelControl,
  channelSections,
  inputEq,
  insertFxControl,
  isStereoChannel,
  outputEq,
} from "../core/control/translate";
import {
  COMP_EQ_COMP_FIRST,
  COMP_EQ_OPTIONS,
  EQ_TYPE_HIGH_OPTIONS,
  EQ_TYPE_LOW_OPTIONS,
  EQ_TYPE_PASS,
  EQ_TYPE_PEAKING,
  EQ_TYPE_SHELVING,
  INSERT_FX_NONE,
} from "../core/control/params";
import type { InsertFxSlot } from "../core/control/params";
import {
  EQ_FREQ_MAX_HZ,
  EQ_FREQ_MIN_HZ,
  EQ_GAIN_MAX_DB,
  EQ_GAIN_MIN_DB,
  EQ_Q_MAX,
  EQ_Q_MIN,
  HPF_FREQ_DEFAULT_HZ,
  HPF_FREQ_MAX_HZ,
  HPF_FREQ_MIN_HZ,
  HPF_FREQ_STEP_HZ,
  MONITOR_MAX_DB,
  MONITOR_MIN_DB,
  MONITOR_OFF_DB,
} from "../core/control/vd";
import { rateConstraints } from "../core/constraints";
import type { RateWarning } from "../core/constraints";
import type { RecentEntry } from "../core/storage";
import type { Selection } from "./graph";
import { t } from "../i18n";
import type { Messages } from "../i18n/en";

export interface InspectorActions {
  onDeleteConnection: (from: string, to: string) => void;
  onUpdateParams: (from: string, to: string, patch: ConnParams) => void;
  onUpdateNodeParams: (id: string, patch: NodeParams) => void;
  onOpenRecent: (path: string) => void;
  onHideNode: (id: string) => void;
}

// Per-kind editable send parameters. Only summing sends carry LEVEL / PRE-POST /
// PAN per the block diagram (device-model.md §2); selectors and output patches
// are assignments without per-connection mix parameters. PRE-POST is further
// dropped for the fixed STEREO / FX-return main paths (see sendHasTap).
const PARAM_FIELDS: Record<ConnectionKind, ParamField[]> = {
  send: ["level", "pan", "tap"],
  sendSwitch: [],
  source: [],
  patch: [],
  key: [],
};
type ParamField = "level" | "pan" | "tap";

const LEVEL_MIN = LEVEL_MIN_DB;
const LEVEL_MAX = LEVEL_MAX_DB;

// HA gain slider position shown for a channel whose gain has not been fetched or
// set yet; matches the device's default head-amp gain.
const HA_GAIN_DEFAULT_DB = -8;

export function renderInspector(
  host: HTMLElement,
  model: DeviceModel,
  plan: Plan,
  selection: Selection,
  actions: InspectorActions,
  recent: RecentEntry[] = [],
): void {
  host.replaceChildren();
  const labelOf = (nodeId: string): string => {
    const node = model.nodes.find((n) => n.id === nodeId);
    return node ? fullLabel(node) : nodeId;
  };
  const endpointLabel = (r: string): string => labelOf(parseRef(r).nodeId);

  const m = t();
  const constraints = rateConstraints(model, plan.sampleRate);
  if (constraints.warnings.length) host.append(warningBlock(m, constraints.warnings));

  if (!selection) {
    host.append(heading(m.inspector.title), hint(m.inspector.hint));
    host.append(legendBlock(m));
    if (recent.length) {
      host.append(subheading(m.inspector.recentPlans));
      for (const entry of recent) host.append(recentRow(entry, actions.onOpenRecent));
    }
    return;
  }

  if (selection.type === "node") {
    const node = model.nodes.find((n) => n.id === selection.id);
    if (!node) return;
    host.append(heading(fullLabel(node)), field(m.inspector.type, nodeKindLabel(node.kind)));

    const outgoing = plan.connections.filter((c) => parseRef(c.from).nodeId === node.id);
    const incoming = plan.connections.filter((c) => parseRef(c.to).nodeId === node.id);
    host.append(subheading(m.inspector.inputsFrom(incoming.length)));
    for (const c of incoming) host.append(connRow(`${endpointLabel(c.from)} →`, c.kind));
    host.append(subheading(m.inspector.outputsTo(outgoing.length)));
    for (const c of outgoing) host.append(connRow(`→ ${endpointLabel(c.to)}`, c.kind));

    // Channel node device parameters: ON (mute) and HPF. Stored per node id, so
    // they edit plan.nodeParams rather than a wire. Defaults match the device
    // (channel on, HPF off) until a fetch or edit sets them explicitly.
    if (node.kind === "channel") {
      const np = plan.nodeParams[node.id] ?? {};
      const cc = channelControl(model, node.id);
      host.append(subheading(m.inspector.parameters));
      // Gain label / range come from the channel descriptor: mono = A.Gain
      // (-8..+70), stereo = D.Gain (-24..+24), matching the device's own labels.
      if (cc?.gain) {
        const gainLabel = cc.gain.analog ? m.inspector.gainAnalog : m.inspector.gainDigital;
        host.append(
          gainControl(gainLabel, cc.gain.minDb, cc.gain.maxDb, np.gain ?? HA_GAIN_DEFAULT_DB, (v) =>
            actions.onUpdateNodeParams(node.id, { gain: v }),
          ),
        );
      }
      host.append(
        boolToggle(m.inspector.channelOn, np.on ?? true, (v) =>
          actions.onUpdateNodeParams(node.id, { on: v }),
        ),
      );
      // The analog mic-strip toggles (+48V / Clip Safe) and HPF exist only on the
      // mono mic channels.
      if (cc?.hasMicStrip) {
        host.append(
          boolToggle(m.inspector.phantom, np.phantom ?? false, (v) =>
            actions.onUpdateNodeParams(node.id, { phantom: v }),
          ),
        );
        host.append(
          boolToggle(m.inspector.clipSafe, np.clipSafe ?? false, (v) =>
            actions.onUpdateNodeParams(node.id, { clipSafe: v }),
          ),
        );
      }
      // Polarity invert (Ø): one toggle on mono, two (L/R) on stereo channels.
      for (const ph of cc?.phases ?? []) {
        const label = ph.side ? `${m.inspector.phase} ${ph.side}` : m.inspector.phase;
        host.append(
          boolToggle(label, np[ph.key] ?? false, (v) =>
            actions.onUpdateNodeParams(node.id, { [ph.key]: v }),
          ),
        );
      }
      // Hi-Z (instrument input) exists only on specific channels (CH3/CH4).
      if (cc?.hasHiZ) {
        host.append(
          boolToggle(m.inspector.hiZ, np.hiZ ?? false, (v) =>
            actions.onUpdateNodeParams(node.id, { hiZ: v }),
          ),
        );
      }
      // Channel-strip section ON (GATE / COMP / EQ). Mono channels have all three;
      // stereo channels expose only EQ. The active COMP/EQ bank follows the type.
      // Default before a fetch: EQ on, dynamics (GATE/COMP) off.
      for (const sec of channelSections(model, node.id, np.compEqType ?? COMP_EQ_COMP_FIRST)) {
        host.append(
          boolToggle(m.inspector[sec.key], np[sec.key] ?? sec.key === "eqOn", (v) =>
            actions.onUpdateNodeParams(node.id, { [sec.key]: v }),
          ),
        );
      }
      // COMP/EQ type (COMP->EQ vs SSMCS) exists only on the MONO IN channels.
      if (cc?.hasMicStrip) {
        host.append(
          selectControl(
            m.inspector.compEqType,
            COMP_EQ_OPTIONS.map((o) => ({ value: String(o.value), label: o.label })),
            String(np.compEqType ?? COMP_EQ_COMP_FIRST),
            (v) => actions.onUpdateNodeParams(node.id, { compEqType: Number(v) }),
          ),
        );
      }
      if (cc?.hasHpf) {
        host.append(
          boolToggle(m.inspector.hpf, np.hpf ?? false, (v) =>
            actions.onUpdateNodeParams(node.id, { hpf: v }),
          ),
        );
        host.append(
          rangeSlider(
            m.inspector.hpfFreq,
            HPF_FREQ_MIN_HZ,
            HPF_FREQ_MAX_HZ,
            HPF_FREQ_STEP_HZ,
            np.hpfFreq ?? HPF_FREQ_DEFAULT_HZ,
            (v) => `${v} Hz`,
            (v) => actions.onUpdateNodeParams(node.id, { hpfFreq: v }),
          ),
        );
      }
      // Input 4-band PEQ (mono COMP->EQ mode / stereo channels; none in SSMCS).
      const ieq = inputEq(model, node.id, np.compEqType ?? COMP_EQ_COMP_FIRST);
      if (ieq) host.append(eqBandBlock(node.id, ieq, np, plan, actions, m));
    }

    // Bus output fader: STEREO master (581) and MIX 1/2 (674). Reuses
    // nodeParams.level. STEREO additionally has a master ON/OFF (STEREO_MASTER_ON).
    if (busFader(node.id)) {
      const np = plan.nodeParams[node.id] ?? {};
      host.append(subheading(m.inspector.parameters));
      host.append(
        faderControl(np.level ?? 0, (v) => actions.onUpdateNodeParams(node.id, { level: v })),
      );
      if (node.id === "bus.stereo") {
        host.append(
          boolToggle(m.inspector.master, np.on ?? true, (v) =>
            actions.onUpdateNodeParams(node.id, { on: v }),
          ),
        );
      }
      // EQ ON/OFF (STEREO 498 / MIX 591). Defaults on.
      if (busEqOn(node.id)) {
        host.append(
          boolToggle(m.inspector.eqOn, np.eqOn ?? true, (v) =>
            actions.onUpdateNodeParams(node.id, { eqOn: v }),
          ),
        );
      }
      // Output bus 4-band PEQ (STEREO 498-block single / MIX 591-block L/R-linked).
      const oeq = outputEq(node.id);
      if (oeq) host.append(eqBandBlock(node.id, oeq, np, plan, actions, m));
    }

    // Monitor bus level (MONITOR_LEVEL). Reuses nodeParams.level.
    if (node.id === "bus.mon1" || node.id === "bus.mon2") {
      const np = plan.nodeParams[node.id] ?? {};
      host.append(subheading(m.inspector.parameters));
      host.append(
        monitorLevelControl(np.level ?? 0, (v) => actions.onUpdateNodeParams(node.id, { level: v })),
      );
    }

    // Insert FX dropdown: MONO IN channels (input effects) and MIX/STEREO outputs
    // (output effects). An option is disabled when it exceeds the current sample
    // rate's ceiling, or when its device-wide 1-of slot is taken by another node.
    // The parent channel/bus block above has already added the "Parameters" head.
    const ifx = insertFxControl(model, node.id);
    if (ifx) {
      const taken = new Set<InsertFxSlot>();
      for (const n of model.nodes) {
        if (n.id === node.id) continue;
        const other = insertFxControl(model, n.id);
        const v = plan.nodeParams[n.id]?.insertFx;
        if (!other || v === undefined) continue;
        const slot = other.options.find((o) => o.value === v)?.slot;
        if (slot) taken.add(slot);
      }
      host.append(
        selectControl(
          m.inspector.insertFx,
          ifx.options.map((o) => ({
            value: String(o.value),
            label: o.label,
            disabled:
              (o.maxRate !== undefined && plan.sampleRate > o.maxRate) ||
              (o.slot !== undefined && taken.has(o.slot)),
          })),
          String(plan.nodeParams[node.id]?.insertFx ?? INSERT_FX_NONE),
          (v) => actions.onUpdateNodeParams(node.id, { insertFx: Number(v) }),
        ),
      );
    }

    // Shelving is offered for a node with no editable wires; fixed STEREO wires
    // are hidden along with the node, so they do not block it (see graph.ts). A
    // ducker may always be shelved — its key-source wire is hidden with it.
    const editable = (c: PlanConnection): boolean => !isFixedConnection(model, c.from, c.to);
    if (node.kind === "ducker" || (!incoming.some(editable) && !outgoing.some(editable))) {
      const hide = document.createElement("button");
      hide.type = "button";
      hide.className = "subtle";
      hide.textContent = m.inspector.hideNode;
      hide.addEventListener("click", () => actions.onHideNode(node.id));
      host.append(hide);
    }
    return;
  }

  // connection
  const { from, to } = selection;
  const conn = plan.connections.find((c) => c.from === from && c.to === to);
  host.append(
    heading(m.inspector.connection),
    field(m.inspector.from, endpointLabel(from)),
    field(m.inspector.to, endpointLabel(to)),
    field(m.inspector.type, connKindLabel(from, to, model)),
  );

  if (conn) {
    // PRE/POST is taken against the channel's STEREO main-fader level, so the
    // fixed STEREO / FX-return main paths show LEVEL / PAN but no PRE/POST.
    const fields = PARAM_FIELDS[conn.kind].filter((f) => f !== "tap" || sendHasTap(model, from, to));
    if (fields.length) {
      host.append(subheading(m.inspector.parameters));
      // A stereo channel's "pan" is a balance; label it BALANCE to match the device.
      const panLabel = isStereoChannel(parseRef(from).nodeId) ? m.inspector.balance : m.inspector.pan;
      for (const f of fields) host.append(paramControl(f, conn, actions.onUpdateParams, panLabel));
    } else {
      host.append(hint(m.inspector.selectionOnly));
    }
  }

  // A fixed wire (CH / FX return -> STEREO) cannot be removed; offer no delete
  // button, only a note that it is structural. Its level/pan above stay editable.
  if (isFixedConnection(model, from, to)) {
    host.append(hint(m.inspector.fixedConnection));
    return;
  }

  const del = document.createElement("button");
  del.type = "button";
  del.className = "danger";
  del.textContent = m.inspector.deleteConnection;
  del.addEventListener("click", () => actions.onDeleteConnection(from, to));
  host.append(del);
}

function connKindLabel(from: string, to: string, model: DeviceModel): string {
  const rule = model.rules.find((r) => r.from === from && r.to === to);
  return rule ? t().inspector.connKind[rule.kind] : t().inspector.none;
}

function nodeKindLabel(kind: NodeKind): string {
  return t().inspector.nodeKind[kind];
}

function heading(text: string): HTMLElement {
  const h = document.createElement("h2");
  h.textContent = text;
  return h;
}

function subheading(text: string): HTMLElement {
  const h = document.createElement("h3");
  h.textContent = text;
  return h;
}

function hint(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "hint";
  p.textContent = text;
  return p;
}

function field(label: string, value: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "field";
  const k = document.createElement("span");
  k.className = "field-key";
  k.textContent = label;
  const v = document.createElement("span");
  v.className = "field-val";
  v.textContent = value;
  row.append(k, v);
  return row;
}

type UpdateParams = (from: string, to: string, patch: ConnParams) => void;

function paramControl(
  field: ParamField,
  conn: PlanConnection,
  onUpdate: UpdateParams,
  panLabel: string,
): HTMLElement {
  if (field === "tap") return tapControl(conn, onUpdate);
  return field === "level"
    ? sliderControl(conn, onUpdate, "level", t().inspector.level, LEVEL_MIN, LEVEL_MAX, 0.5, 0, formatDb)
    : sliderControl(conn, onUpdate, "pan", panLabel, -100, 100, 1, 0, formatPan);
}

// A labeled range slider that updates its value readout and reports the numeric
// value on every input. Mutates in place (no re-render) so it keeps focus while
// dragging. Shared by the connection (sliderControl) and node-level controls.
function rangeSlider(
  label: string,
  min: number,
  max: number,
  step: number,
  cur: number,
  fmt: (v: number) => string,
  onInput: (v: number) => void,
): HTMLElement {
  const { row, value } = paramBlock(label, fmt(cur));
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(cur);
  slider.addEventListener("input", () => {
    const v = Number(slider.value);
    value.textContent = fmt(v);
    onInput(v);
  });
  row.append(slider);
  return row;
}

function sliderControl(
  conn: PlanConnection,
  onUpdate: UpdateParams,
  key: "level" | "pan",
  label: string,
  min: number,
  max: number,
  step: number,
  fallback: number,
  fmt: (v: number) => string,
): HTMLElement {
  return rangeSlider(label, min, max, step, conn.params?.[key] ?? fallback, fmt, (v) =>
    onUpdate(conn.from, conn.to, { [key]: v }),
  );
}

// Node-level gain slider (HA / D.Gain): integer dB steps over the given range.
function gainControl(
  label: string,
  min: number,
  max: number,
  cur: number,
  onChange: (v: number) => void,
): HTMLElement {
  return rangeSlider(label, min, max, 1, cur, formatGainDb, onChange);
}

function formatGainDb(v: number): string {
  return `${v > 0 ? "+" : ""}${v} dB`;
}

// Per-band default frequencies (Hz) and Q shown before a fetch, matching the
// device defaults (LOW 125 / LOW-MID 1k / HIGH-MID 4k / HIGH 10k, Q 0.71).
const EQ_BAND_DEFAULT_FREQ = [125, 1000, 4000, 10000];
const EQ_Q_DEFAULT = 0.71;

// 4-band PEQ editor (input channel or output bus). Each band shows ON / filter
// type (LOW & HIGH bands only) / freq / Q / gain; Q shows only for a peaking band
// and gain only when the band is not a pass filter — matching the device's
// filter-type behavior. Edits merge into nodeParams.eqBands via the update action.
function eqBandBlock(
  nodeId: string,
  ctrl: EqControl,
  np: NodeParams,
  plan: Plan,
  actions: InspectorActions,
  m: Messages,
): DocumentFragment {
  const frag = document.createDocumentFragment();
  const setBand = (i: number, patch: EqBand): void => {
    const next = (plan.nodeParams[nodeId]?.eqBands ?? []).slice();
    next[i] = { ...next[i], ...patch };
    actions.onUpdateNodeParams(nodeId, { eqBands: next });
  };
  for (const band of ctrl.bands) {
    const bv = np.eqBands?.[band.index] ?? {};
    frag.append(subheading(`EQ ${m.inspector.eqBand[band.name]}`));
    frag.append(boolToggle(m.inspector.bandOn, bv.on ?? true, (v) => setBand(band.index, { on: v })));
    let effType = EQ_TYPE_PEAKING;
    if (band.type !== null) {
      effType = bv.type ?? EQ_TYPE_SHELVING;
      const opts = band.name === "low" ? EQ_TYPE_LOW_OPTIONS : EQ_TYPE_HIGH_OPTIONS;
      frag.append(
        selectControl(
          m.inspector.filterType,
          opts.map((o) => ({ value: String(o.value), label: o.label })),
          String(effType),
          (v) => setBand(band.index, { type: Number(v) }),
        ),
      );
    }
    frag.append(eqFreqControl(bv.freq ?? EQ_BAND_DEFAULT_FREQ[band.index], (v) => setBand(band.index, { freq: v })));
    if (effType === EQ_TYPE_PEAKING) {
      frag.append(
        rangeSlider(m.inspector.q, EQ_Q_MIN, EQ_Q_MAX, 0.1, bv.q ?? EQ_Q_DEFAULT, (v) => v.toFixed(2), (v) =>
          setBand(band.index, { q: v }),
        ),
      );
    }
    if (effType !== EQ_TYPE_PASS) {
      frag.append(
        rangeSlider(m.inspector.eqGain, EQ_GAIN_MIN_DB, EQ_GAIN_MAX_DB, 0.5, bv.gain ?? 0, formatGainDb, (v) =>
          setBand(band.index, { gain: v }),
        ),
      );
    }
  }
  return frag;
}

// EQ band frequency slider on a log scale (20 Hz … 20 kHz) so each octave gets
// equal width; reports the snapped Hz value and formats as Hz / kHz.
function eqFreqControl(cur: number, onChange: (hz: number) => void): HTMLElement {
  const steps = 1000;
  const ratio = Math.log(EQ_FREQ_MAX_HZ / EQ_FREQ_MIN_HZ);
  const toPos = (hz: number): number => Math.round((steps * Math.log(hz / EQ_FREQ_MIN_HZ)) / ratio);
  const toHz = (pos: number): number => Math.round(EQ_FREQ_MIN_HZ * Math.exp((ratio * pos) / steps));
  const { row, value } = paramBlock(t().inspector.frequency, formatHz(cur));
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = String(steps);
  slider.step = "1";
  slider.value = String(toPos(cur));
  slider.addEventListener("input", () => {
    const hz = toHz(Number(slider.value));
    value.textContent = formatHz(hz);
    onChange(hz);
  });
  row.append(slider);
  return row;
}

function formatHz(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${Math.round(hz)} Hz`;
}

// Node-level bus output fader (STEREO master / MIX): -∞ then -60.0 … +10.0 dB,
// the same level scale as a send.
function faderControl(cur: number, onChange: (v: number) => void): HTMLElement {
  return rangeSlider(t().inspector.level, LEVEL_MIN, LEVEL_MAX, 0.5, cur, formatDb, onChange);
}

// Monitor level slider: -∞ then -96.0 … +10.0 dB. The bottom notch
// (MONITOR_OFF_DB, just under -96) is the off position.
function monitorLevelControl(cur: number, onChange: (v: number) => void): HTMLElement {
  return rangeSlider(t().inspector.level, MONITOR_OFF_DB, MONITOR_MAX_DB, 0.5, cur, formatMonitorDb, onChange);
}

function formatMonitorDb(v: number): string {
  return v < MONITOR_MIN_DB ? "-∞ dB" : `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
}

// A two-button ON/OFF toggle for a node-level boolean (channel on, HPF), styled
// like the PRE/POST control. Highlights the active state and reports the chosen
// value on click.
function boolToggle(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const { row } = paramBlock(label, "");
  const group = document.createElement("div");
  group.className = "toggle";
  const make = (on: boolean, text: string): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.classList.toggle("on", value === on);
    b.addEventListener("click", () => onChange(on));
    return b;
  };
  group.append(make(true, t().inspector.on), make(false, t().inspector.off));
  row.append(group);
  return row;
}

// A labeled dropdown for an enum node parameter (e.g. insert FX). Reports the
// chosen option's value string on change.
function selectControl(
  label: string,
  options: { value: string; label: string; disabled?: boolean }[],
  current: string,
  onChange: (v: string) => void,
): HTMLElement {
  const { row } = paramBlock(label, "");
  const sel = document.createElement("select");
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.disabled) opt.disabled = true;
    sel.append(opt);
  }
  sel.value = current;
  sel.addEventListener("change", () => onChange(sel.value));
  row.append(sel);
  return row;
}

function tapControl(conn: PlanConnection, onUpdate: UpdateParams): HTMLElement {
  const cur = conn.params?.tap ?? "post";
  const { row } = paramBlock(t().inspector.prePost, "");
  const group = document.createElement("div");
  group.className = "toggle";
  const make = (tap: "pre" | "post", text: string): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.classList.toggle("on", cur === tap);
    b.addEventListener("click", () => {
      group.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      onUpdate(conn.from, conn.to, { tap });
    });
    return b;
  };
  group.append(make("pre", "PRE"), make("post", "POST"));
  row.append(group);
  return row;
}

function paramBlock(labelText: string, valueText: string): { row: HTMLElement; value: HTMLElement } {
  const row = document.createElement("div");
  row.className = "param";
  const head = document.createElement("div");
  head.className = "param-label";
  const label = document.createElement("span");
  label.textContent = labelText;
  const value = document.createElement("span");
  value.className = "param-val";
  value.textContent = valueText;
  head.append(label, value);
  row.append(head);
  return { row, value };
}

function formatDb(v: number): string {
  if (v <= LEVEL_MIN) return "-∞ dB";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
}

function formatPan(v: number): string {
  if (v === 0) return "C";
  return v < 0 ? `L ${-v}` : `R ${v}`;
}

function warningBlock(m: Messages, warnings: RateWarning[]): HTMLElement {
  const box = document.createElement("div");
  box.className = "warning";
  const head = document.createElement("div");
  head.className = "warning-title";
  head.textContent = m.warning.title;
  box.append(head);
  for (const w of warnings) {
    const line = document.createElement("div");
    line.className = "warning-line";
    line.textContent = m.warning[w];
    box.append(line);
  }
  return box;
}

function recentRow(entry: RecentEntry, onOpen: (path: string) => void): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "recent-row";
  btn.title = entry.path;
  const name = document.createElement("span");
  name.className = "recent-name";
  name.textContent = entry.name;
  const model = document.createElement("span");
  model.className = "recent-model";
  model.textContent = entry.modelId;
  btn.append(name, model);
  btn.addEventListener("click", () => onOpen(entry.path));
  return btn;
}

// Color legend for the empty inspector: wire colors by connection kind and rail
// colors by node kind. Swatch colors come from theme-aware CSS variables so
// they track the active palette (style.css :root / [data-theme="light"]).
function legendBlock(m: Messages): DocumentFragment {
  const frag = document.createDocumentFragment();
  frag.append(subheading(m.inspector.legend.signals));
  frag.append(legendRow("var(--w-source)", m.inspector.legend.source));
  frag.append(legendRow("var(--w-send)", m.inspector.legend.send));
  frag.append(legendPreRow(m.inspector.legend.pre));
  frag.append(legendRow("var(--w-sendswitch)", m.inspector.legend.sendSwitch));
  frag.append(legendRow("var(--w-patch)", m.inspector.legend.patch));
  frag.append(subheading(m.inspector.legend.nodes));
  frag.append(legendRow("var(--rail-input)", m.inspector.nodeKind.input, true));
  frag.append(legendRow("var(--rail-channel)", m.inspector.nodeKind.channel, true));
  frag.append(legendRow("var(--rail-bus)", m.inspector.nodeKind.bus, true));
  frag.append(legendRow("var(--rail-output)", m.inspector.nodeKind.output, true));
  frag.append(legendRow("var(--rail-ducker)", m.inspector.nodeKind.ducker, true));
  return frag;
}

// A PRE legend row whose swatch mirrors the on-canvas marker: a dashed send wire
// with an amber tap glyph. Theme colors come from CSS variables via inline style.
function legendPreRow(label: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "conn-row";
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "12");
  svg.setAttribute("viewBox", "0 0 20 12");
  svg.style.flexShrink = "0";
  const line = document.createElementNS(ns, "line");
  line.setAttribute("x1", "0");
  line.setAttribute("y1", "8");
  line.setAttribute("x2", "20");
  line.setAttribute("y2", "8");
  line.setAttribute("stroke-width", "2");
  line.setAttribute("stroke-dasharray", "5 3");
  line.setAttribute("stroke-linecap", "round");
  line.style.stroke = "var(--w-send)";
  const tri = document.createElementNS(ns, "path");
  tri.setAttribute("d", "M 6 3 L 12 6 L 6 9 Z");
  tri.style.fill = "var(--led)";
  svg.append(line, tri);
  const text = document.createElement("span");
  text.textContent = label;
  row.append(svg, text);
  return row;
}

function legendRow(color: string, label: string, square = false): HTMLElement {
  const row = document.createElement("div");
  row.className = "conn-row";
  const dot = document.createElement("span");
  dot.className = square ? "dot dot-square" : "dot";
  dot.style.background = color;
  const text = document.createElement("span");
  text.textContent = label;
  row.append(dot, text);
  return row;
}

function connRow(text: string, kind: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "conn-row";
  const dot = document.createElement("span");
  dot.className = `dot dot-${kind}`;
  const t = document.createElement("span");
  t.textContent = text;
  row.append(dot, t);
  return row;
}
