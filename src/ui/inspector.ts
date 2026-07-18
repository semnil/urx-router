// Renders the currently selected node or connection. Shows details, edits send
// parameters (level/pan/pre-post), removes a connection, and (no selection)
// lists recent plans for quick reopen.

import type { ConnectionKind, DeviceModel, NodeKind } from "../models/types";
import { fullLabel, parseRef } from "../models/types";
import type {
  ConnParams,
  EqBand,
  FxEffectParams,
  NodeParams,
  Plan,
  PlanConnection,
  SsmcsBand,
  SsmcsParams,
} from "../core/plan";
import { LEVEL_MIN_DB, SSMCS_INITIAL } from "../core/plan";
import { LEVEL_POS_MAX, levelToPos, posToLevel } from "../core/levels";
import { formatHz, FX_EFFECT_TYPE_DEFAULT, fxEffectTypes, fxFamilyOf, fxParams } from "../core/control/fx-effect";
import {
  insertFxFamilyOf,
  insertFxParams,
  MBC_BANDS,
  MBC_BAND_PARAM,
  MBC_GLOBAL,
  mbcXoverLabel,
  mbcOutGainLabel,
  MBC_XOVER_LM_RANGE,
  MBC_XOVER_MH_RANGE,
  MBC_RELEASE_MS,
  SEMITONE_NAMES,
  PITCH_NOTE_SLOTS,
  PITCH_SCALE_SLOT,
  PITCH_SCALE_CHROMATIC,
  PITCH_SCALE_MAJOR,
  PITCH_SCALE_CUSTOM,
  PITCH_MIDI_ENABLE_SLOT,
  PITCH_MIDI_REALTIME_SLOT,
  type InsertFxFamily,
  type InsertFxParamDesc,
  type MbcBandKey,
} from "../core/control/insert-fx-effect";
import {
  directOutTarget,
  duckerKeySource,
  isBalLinkedPair,
  isFixedConnection,
  mixSendLocks,
  pairPrimary,
  sendHasOn,
  sendHasTap,
  sendTapWritable,
} from "../core/routing";
import type { DynField, EqControl } from "../core/control/translate";
import {
  busBalance,
  busEqOn,
  busFader,
  busMasterOn,
  channelControl,
  channelDynamics,
  channelSections,
  colorControl,
  DUCKER_FIELDS,
  duckerControl,
  fxChannelIndex,
  inputEq,
  insertFxControl,
  isStereoChannel,
  oscAssign,
  outputEq,
} from "../core/control/translate";
import {
  COMP_EQ_COMP_FIRST,
  COMP_EQ_OPTIONS,
  COMP_KNEE_DEFAULT,
  COMP_KNEE_OPTIONS,
  EQ_TYPE_HIGH_OPTIONS,
  EQ_TYPE_LOW_OPTIONS,
  EQ_TYPE_PASS,
  EQ_TYPE_PEAKING,
  EQ_TYPE_SHELVING,
  INSERT_FX_NONE,
  OSC_MODE_BURST,
  OSC_MODE_OPTIONS,
  OSC_MODE_SINE,
  REC_POINT_DEFAULT,
  REC_POINT_OPTIONS,
  REC_POINT_PRE_EQ,
  BUS_TYPE_VARI,
  BUS_TYPE_OPTIONS,
  SD_REC_TRACK_COUNT_DEFAULT,
  SD_REC_TRACK_COUNT_OPTIONS,
  SIGNAL_TYPE_OPTIONS,
  PAN_BAL_PAN,
  PAN_BAL_OPTIONS,
  COMP_EQ_SSMCS,
  SWEET_SPOT_DATA_OPTIONS,
  COLOR_PALETTE,
  DELAY_FRAME_RATE_OPTIONS,
  DELAY_FRAME_RATE_DEFAULT,
  EQ_ONE_KNOB_TYPE_MONO_OPTIONS,
  EQ_ONE_KNOB_TYPE_WIDE_OPTIONS,
  EQ_ONE_KNOB_TYPE_DEFAULT,
  insertFxAvailable,
  insertFxEngaged,
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
  PAN_MIN,
  PAN_MAX,
  ssmcsCompDrive,
  ssmcsAttackMs,
  ssmcsReleaseMs,
  ssmcsRatio,
  ssmcsQ,
  ssmcsFreqHz,
  ssmcsGainDb,
  SSMCS_COMP_DRIVE_MIN,
  SSMCS_COMP_DRIVE_MAX,
  SSMCS_MORPHING_MIN,
  SSMCS_MORPHING_MAX,
  SSMCS_GAIN_MIN,
  SSMCS_GAIN_MAX,
  SSMCS_ATTACK_RAW_MIN,
  SSMCS_ATTACK_RAW_MAX,
  SSMCS_RELEASE_RAW_MIN,
  SSMCS_RELEASE_RAW_MAX,
  SSMCS_RATIO_RAW_MIN,
  SSMCS_RATIO_RAW_MAX,
  SSMCS_Q_RAW_MIN,
  SSMCS_Q_RAW_MAX,
  SSMCS_FREQ_RAW_MIN,
  SSMCS_FREQ_RAW_MAX,
  SSMCS_EQ_LOW_FREQ_RAW_MAX,
  SSMCS_EQ_HIGH_FREQ_RAW_MIN,
  DELAY_TIME_MIN_MS,
  DELAY_TIME_MAX_MS,
  PHONES_LEVEL_MIN,
  PHONES_LEVEL_MAX,
  PHONES_LEVEL_DEFAULT,
  GATE_RANGE_OFF_DB,
} from "../core/control/vd";
import { channelDuckerOn, channelEqUnavailable, duckerBypassWarnings, rateConstraints } from "../core/constraints";
import { loadJson, saveJson } from "../core/storage";
import type { RecentEntry } from "../core/storage";
import type { Selection } from "./graph";
import { setLevelText } from "./glyph";
import { onWheelStep } from "./dom";
import { t } from "../i18n";
import type { Messages } from "../i18n/en";

export interface InspectorActions {
  onDeleteConnection: (from: string, to: string) => void;
  onUpdateParams: (from: string, to: string, patch: ConnParams) => void;
  onUpdateNodeParams: (id: string, patch: NodeParams) => void;
  onRenameNode: (id: string, name: string) => void;
  onRecolorNode: (id: string, color: string | null) => void;
  onOpenRecent: (path: string) => void;
  onHideNode: (id: string) => void;
  onClose: () => void;
}

// Per-kind editable send parameters. Only summing sends carry LEVEL / PRE-POST /
// PAN per the block diagram (device-model.md §2); selectors and output patches
// are assignments without per-connection mix parameters. PRE-POST is further
// dropped for the fixed STEREO / FX-channel main paths (see sendHasTap). Ordered
// top-to-bottom as the device SEND TO screen reads it (ON — the wire itself — then
// PRE, Pan, Level); the fixed main path drops tap and so shows Pan then Level.
const PARAM_FIELDS: Record<ConnectionKind, ParamField[]> = {
  send: ["tap", "pan", "level"],
  sendSwitch: [],
  source: [],
  patch: [],
  key: [],
  record: [],
};
type ParamField = "level" | "pan" | "tap";

// Whether a channel's send pan should read as a BALANCE: a native stereo channel,
// or a STEREO-linked MONO IN pair switched to BAL mode (Signal Type, PAN/BAL).
function isBalanceChannel(model: DeviceModel, plan: Plan, id: string): boolean {
  return isStereoChannel(id) || fxChannelIndex(id) !== null || isBalLinkedPair(model, plan, id);
}

// The lowest real value shown is LEVEL_MIN_DB (-96.0); formatDb prints -∞ below it.
const LEVEL_MIN = LEVEL_MIN_DB;

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
  // While live-connected, params the device cannot accept from software (CH → FX
  // tap) are shown read-only. Off (the default) in the pure planner, where the
  // plan is intent and every param stays editable.
  liveActive = false,
): void {
  host.replaceChildren();
  const labelOf = (nodeId: string): string => {
    const node = model.nodes.find((n) => n.id === nodeId);
    return node ? fullLabel(node) : nodeId;
  };
  const endpointLabel = (r: string): string => labelOf(parseRef(r).nodeId);

  const m = t();
  // Mobile-only dismiss control (the bottom-sheet pull tab's close affordance);
  // hidden on the desktop side panel via CSS.
  host.append(closeButton(m.inspector.close, actions.onClose));
  const constraints = rateConstraints(model, plan.sampleRate);
  if (constraints.warnings.length)
    host.append(
      warningBox(
        m.warning.title,
        constraints.warnings.map((w) => m.warning[w]),
      ),
    );
  // A live signal-flow caution (not rate-dependent): a channel with its Ducker on
  // that is also tapped straight to a USB / SD direct out never carries the duck.
  const duckerBypass = duckerBypassWarnings(model, plan);
  if (duckerBypass.length)
    host.append(
      warningBox(
        m.warning.duckerTitle,
        duckerBypass.map((id) => m.warning.duckerBypass(labelOf(id))),
      ),
    );

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
    // The heading keeps the device identity (CH 1 …) so you always know which
    // physical strip you are patching; the Name field below holds the override.
    host.append(heading(fullLabel(node)), field(m.inspector.type, nodeKindLabel(node.kind)));

    // Channel / bus strips carry a user-editable name (the device's CH SETTING
    // name); empty falls back to the model's default label.
    if (node.kind === "channel" || node.kind === "bus") {
      host.append(
        textInput(m.inspector.name, plan.nodeNames[node.id] ?? "", fullLabel(node), (v) =>
          actions.onRenameNode(node.id, v),
        ),
      );
    }
    // Color swatches only for nodes the device actually colors (input channels +
    // STEREO / MIX / FX / STREAMING buses). Monitor and OSC buses have no device
    // color param, so they get no picker.
    if (colorControl(model, node.id)) {
      host.append(colorSwatches(m.inspector.color, plan.nodeColors[node.id], (c) => actions.onRecolorNode(node.id, c)));
    }

    // Rec Point (CH SETTING): the recording / direct-out tap stage. MONO IN
    // offers all five stages; ST IN only the two `stereo` options. Channels only.
    if (node.kind === "channel") {
      // MONO IN exposes all five tap stages; ST IN only the `stereo` ones. In
      // SSMCS mode the device drops PRE EQ (no discrete EQ stage to tap ahead of).
      const isMono = channelControl(model, node.id)?.hasMicStrip;
      const inSsmcs = isMono && plan.nodeParams[node.id]?.compEqType === COMP_EQ_SSMCS;
      const recOptions = REC_POINT_OPTIONS.filter(
        (o) => (isMono || o.stereo) && !(inSsmcs && o.value === REC_POINT_PRE_EQ),
      );
      host.append(
        enumSelect(m.inspector.recPoint, recOptions, plan.nodeParams[node.id]?.recPoint ?? REC_POINT_DEFAULT, (v) =>
          actions.onUpdateNodeParams(node.id, { recPoint: v }),
        ),
      );
    }

    // Signal Type (CH SETTING): a MONO IN pair (CH1/2, CH3/4) is STEREO-linked or
    // MONO x 2. Stored on the pair's primary (odd) channel, so either member edits
    // the same value. STEREO additionally exposes the PAN / BAL mode.
    const primary = pairPrimary(model, node.id);
    if (primary) {
      const pnp = plan.nodeParams[primary] ?? {};
      const linked = pnp.stereoLink ?? false;
      host.append(
        enumSelect(m.inspector.signalType, SIGNAL_TYPE_OPTIONS, linked ? 1 : 0, (v) =>
          actions.onUpdateNodeParams(primary, { stereoLink: v === 1 }),
        ),
      );
      if (linked) {
        host.append(
          enumSelect(m.inspector.panBal, PAN_BAL_OPTIONS, pnp.panBal ?? PAN_BAL_PAN, (v) =>
            actions.onUpdateNodeParams(primary, { panBal: v }),
          ),
        );
      }
    }

    // BUS Type / Pan Link (CH SETTING): MIX 1 / MIX 2 only. FIXED makes every
    // send into the bus a fixed level; Pan Link (VARI only) ties each send pan to
    // the source channel PAN. Both gate the per-send controls (connection panel).
    if (node.id === "bus.mix1" || node.id === "bus.mix2") {
      const bnp = plan.nodeParams[node.id] ?? {};
      const busType = bnp.busType ?? BUS_TYPE_VARI;
      host.append(
        enumSelect(m.inspector.busType, BUS_TYPE_OPTIONS, busType, (v) =>
          actions.onUpdateNodeParams(node.id, { busType: v }),
        ),
      );
      if (busType === BUS_TYPE_VARI) {
        host.append(
          boolToggle(m.inspector.panLink, bnp.panLink ?? false, (v) =>
            actions.onUpdateNodeParams(node.id, { panLink: v }),
          ),
        );
      }
    }

    // microSD Rec header (out.sdrec): the Track Count gates how many track-pair
    // slots show. Read-only on the device (front panel only), so it is editable in
    // the planner but disabled with a note while live-connected (mirrors the
    // CH → FX tap pattern); the per-track source assign is done by canvas wires.
    if (node.id === "out.sdrec") {
      const count = plan.nodeParams[node.id]?.sdRecTrackCount ?? SD_REC_TRACK_COUNT_DEFAULT;
      host.append(
        enumSelect(
          m.inspector.sdRecTrackCount,
          SD_REC_TRACK_COUNT_OPTIONS,
          count,
          (v) => actions.onUpdateNodeParams(node.id, { sdRecTrackCount: v }),
          liveActive,
        ),
      );
      if (liveActive) host.append(hint(m.inspector.sdRecTrackCountLive));
    }

    // After a device readback, a node in plan.unreadNodes still shows its plan
    // default (its body read failed); warn that its values are not the device's.
    // No provenance (a plan never fetched) shows nothing.
    if (plan.unreadNodes?.has(node.id)) {
      host.append(notReadBadge(m.inspector.notReadFromDevice));
    }

    const outgoing = plan.connections.filter((c) => parseRef(c.from).nodeId === node.id);
    const incoming = plan.connections.filter((c) => parseRef(c.to).nodeId === node.id);
    // Routing lists default collapsed — wiring is done on the canvas, so the
    // inspector keeps this folded away behind a count summary. A header node
    // (microSD Rec) takes no direct wire of its own, so it shows no routing list.
    if (!node.header) {
      const { el, body } = section(m.inspector.routing, { open: false, key: "routing" });
      body.append(subheading(m.inspector.inputsFrom(incoming.length)));
      for (const c of incoming) body.append(connRow(`${endpointLabel(c.from)} →`, c.kind));
      body.append(subheading(m.inspector.outputsTo(outgoing.length)));
      for (const c of outgoing) body.append(connRow(`→ ${endpointLabel(c.to)}`, c.kind));
      host.append(el);
    }

    // Insert FX and the trailing channel/bus controls group into this body when a
    // node provides one (the bus Parameters section); otherwise they stay loose.
    let tailBody: HTMLElement | null = null;

    // Channel node device parameters: ON (mute) and HPF. Stored per node id, so
    // they edit plan.nodeParams rather than a wire. Defaults match the device
    // (channel on, HPF off) until a fetch or edit sets them explicitly.
    if (node.kind === "channel") {
      const np = plan.nodeParams[node.id] ?? {};
      // Channel ON (mute) leads the parameters, matching the bus / FX / MONITOR
      // inspectors — every node now puts its on/off at the top of the group.
      host.append(
        boolToggle(m.inspector.channelOn, np.on ?? true, (v) => actions.onUpdateNodeParams(node.id, { on: v })),
      );
      const cc = channelControl(model, node.id);
      const compEqType = np.compEqType ?? COMP_EQ_COMP_FIRST;
      const inSec = section(m.inspector.inputSection, { key: "input" });
      // Flow the short INPUT toggles (+48V / Hi-Z / Clip Safe / Ø / HPF) into two
      // columns; sliders and the select span full width (style.css :has rule).
      inSec.el.dataset.cols = "2";
      const input = inSec.body;

      // INPUT screen order (device top-left → bottom-right): +48V, A.Gain, HI-Z,
      // Clip Safe, Ø, HPF, HPF Freq. The analog mic-strip controls (+48V / Clip
      // Safe / HPF) exist only on the mono mic channels; Hi-Z only on CH3/CH4.
      if (cc?.hasMicStrip) {
        input.append(
          boolToggle(m.inspector.phantom, np.phantom ?? false, (v) =>
            actions.onUpdateNodeParams(node.id, { phantom: v }),
          ),
        );
      }
      // Gain label / range come from the channel descriptor: mono = A.Gain
      // (-8..+70), stereo = D.Gain (-24..+24), matching the device's own labels.
      if (cc?.gain) {
        const gainLabel = cc.gain.analog ? m.inspector.gainAnalog : m.inspector.gainDigital;
        input.append(
          gainControl(gainLabel, cc.gain.minDb, cc.gain.maxDb, np.gain ?? HA_GAIN_DEFAULT_DB, (v) =>
            actions.onUpdateNodeParams(node.id, { gain: v }),
          ),
        );
      }
      if (cc?.hasHiZ) {
        input.append(
          boolToggle(m.inspector.hiZ, np.hiZ ?? false, (v) => actions.onUpdateNodeParams(node.id, { hiZ: v })),
        );
      }
      if (cc?.hasMicStrip) {
        input.append(
          boolToggle(m.inspector.clipSafe, np.clipSafe ?? false, (v) =>
            actions.onUpdateNodeParams(node.id, { clipSafe: v }),
          ),
        );
      }
      // Polarity invert (Ø): one toggle on mono, two (L/R) on stereo channels.
      for (const ph of cc?.phases ?? []) {
        const label = ph.side ? `${m.inspector.phase} ${ph.side}` : m.inspector.phase;
        input.append(
          boolToggle(label, np[ph.key] ?? false, (v) => actions.onUpdateNodeParams(node.id, { [ph.key]: v })),
        );
      }
      if (cc?.hasHpf) {
        input.append(
          boolToggle(m.inspector.hpf, np.hpf ?? false, (v) => actions.onUpdateNodeParams(node.id, { hpf: v })),
        );
        input.append(
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
      // COMP/EQ type (COMP->EQ vs SSMCS) — the CH SETTING bank selector that drives
      // which COMP/EQ controls appear below. MONO IN channels only. Each type's bank
      // is separate on the device and reloaded to factory on every switch; the app
      // wiring resets the destination bank (see resetCompEqBank in main.ts), so the
      // selector only declares the new type here.
      if (cc?.hasMicStrip) {
        input.append(
          selectControl(
            m.inspector.compEqType,
            COMP_EQ_OPTIONS.map((o) => ({ value: String(o.value), label: o.label })),
            String(compEqType),
            (v) => actions.onUpdateNodeParams(node.id, { compEqType: Number(v) }),
          ),
        );
      }
      host.append(inSec.el);

      // SSMCS Main section (MONO IN, SSMCS mode): the [SSMCS] on/off plus Sweet
      // Spot Data / Comp Drive / Morphing / Out Gain. Built here but inserted
      // between the GATE and COMP sections in the loop below.
      const ssmcs = cc?.hasMicStrip && compEqType === COMP_EQ_SSMCS;
      let ssmcsMasterEl: HTMLElement | null = null;
      if (ssmcs) {
        const son = np.ssmcs?.on ?? SSMCS_INITIAL.on;
        const { el, body } = section(m.inspector.ssmcs.title, { open: son, on: son, key: "ssmcsOn" });
        // Toggling the on flag drops any manual fold so the section reverts to
        // following the on-state, matching sectionToggle's contract.
        body.append(
          boolToggle(m.inspector.ssmcs.title, son, (v) => {
            clearSectionOverride("ssmcsOn");
            mergeSsmcs(actions, plan, node.id, { on: v });
          }),
        );
        body.append(ssmcsMasterBlock(node.id, np, plan, actions, m));
        ssmcsMasterEl = el;
      }

      // GATE / COMP / EQ sections in channel-strip order, each a collapsible
      // module matching the device's dedicated GATE / COMP / EQ screens. The
      // summary carries the section's ON led; an off section folds itself away.
      // Mono channels have all three; stereo channels expose only EQ. In SSMCS
      // mode the SSMCS Main section sits between GATE and COMP, and the COMP/EQ
      // sections render the morphing-strip controls. Default: EQ on, GATE/COMP off.
      const dyn = channelDynamics(model, node.id, compEqType);
      const ieq = inputEq(model, node.id, compEqType);
      // The stereo channels' EQ dies at 176.4 / 192 kHz (block diagram): lock the
      // section to OFF with a disabled toggle + tooltip, and drop the (now inert)
      // band editor. The plan's eqOn is left untouched so lowering the rate restores it.
      const eqLocked = channelEqUnavailable(node.id, plan.sampleRate);
      for (const sec of channelSections(model, node.id, compEqType)) {
        const locked = sec.key === "eqOn" && eqLocked;
        const on = locked ? false : (np[sec.key] ?? sec.key === "eqOn");
        const { el, body } = section(m.inspector[sec.key], { open: on, on, key: sec.key });
        body.append(sectionToggle(node.id, sec.key, on, actions, locked ? m.inspector.eqRateLocked : undefined));
        if (sec.key === "gateOn" && dyn) body.append(gateDetailBlock(node.id, dyn.gate, np, plan, actions, m));
        else if (sec.key === "compOn" && ssmcs) body.append(ssmcsCompBlock(node.id, np, plan, actions, m));
        else if (sec.key === "compOn" && dyn?.comp)
          body.append(compDetailBlock(node.id, dyn.comp, np, plan, actions, m));
        else if (sec.key === "eqOn" && ssmcs) body.append(ssmcsEqBlock(node.id, np, plan, actions, m));
        else if (sec.key === "eqOn" && ieq && !locked) {
          body.append(eqOneKnobBlock(node.id, !isStereoChannel(node.id), np, plan, actions, m));
          if (!np.eqOneKnob?.on) body.append(eqBandBlock(node.id, ieq, np, plan, actions, m));
        }
        host.append(el);
        // Insert the SSMCS Main section right after GATE (before COMP).
        if (sec.key === "gateOn" && ssmcsMasterEl) host.append(ssmcsMasterEl);
      }
    }

    // Ducker node: on/off + detail (threshold/range/attack/decay) for the
    // stereo-channel sidechain. Defaults off, so it is not dimmed like a muted
    // channel (which keys off `on`).
    if (node.kind === "ducker" && duckerControl(model, node.id)) {
      host.append(duckerBlock(node.id, plan.nodeParams[node.id] ?? {}, plan, actions, m));
    }

    // Bus output fader: STEREO master (581) and MIX 1/2 (674). Reuses
    // nodeParams.level. Both also carry an ON/OFF (STEREO_MASTER_ON 582 / MIX
    // OUT_MASTER_ON 675), edited here only — the CONSOLE shows it read-only. The
    // toggle leads the section as a "Channel" ON (like an FX channel).
    if (busFader(node.id)) {
      const np = plan.nodeParams[node.id] ?? {};
      const ps = section(m.inspector.parameters, { key: "params" });
      if (busMasterOn(node.id)) {
        ps.body.append(
          boolToggle(m.inspector.channelOn, np.on ?? true, (v) => actions.onUpdateNodeParams(node.id, { on: v })),
        );
      }
      ps.body.append(faderControl(np.level ?? 0, (v) => actions.onUpdateNodeParams(node.id, { level: v })));
      // Master balance (STEREO 583 / MIX 676): the bus output's L/R balance. The
      // device keeps the BALANCE label even under Pan Link (confirmed on URX44V),
      // so it is always "Balance".
      if (busBalance(node.id)) {
        ps.body.append(
          balanceControl(m.inspector.balance, np.pan ?? 0, (v) => actions.onUpdateNodeParams(node.id, { pan: v })),
        );
      }
      host.append(ps.el);
      // Insert FX (STEREO / MIX outputs) groups into the Parameters section.
      tailBody = ps.body;
      // Output bus 4-band PEQ (STEREO 498-block single / MIX 591-block L/R-linked)
      // as a collapsible EQ module — its ON led (STEREO 498 / MIX 591, default on)
      // drives the fold, matching the channel EQ section.
      const oeq = outputEq(node.id);
      if (oeq) {
        const on = np.eqOn ?? true;
        const hasEqToggle = busEqOn(node.id);
        const { el, body } = section(m.inspector.eqOn, hasEqToggle ? { open: on, on, key: "eqOn" } : { key: "eqOn" });
        if (hasEqToggle) body.append(sectionToggle(node.id, "eqOn", on, actions));
        body.append(eqOneKnobBlock(node.id, false, np, plan, actions, m));
        if (!np.eqOneKnob?.on) body.append(eqBandBlock(node.id, oeq, np, plan, actions, m));
        host.append(el);
      }
    }

    // FX bus (FX 1 / FX 2): the FX channel's own ON / mute (param 338, per FX),
    // distinct from the per-channel FX sends feeding it. (Post Fader Send for FX
    // is a DAW-Integration-only feature with no device control address, so it is
    // not modeled here.)
    const fxY = fxChannelIndex(node.id);
    if (fxY !== null) {
      const ps = section(m.inspector.parameters, { key: "params" });
      ps.body.append(
        boolToggle(m.inspector.channelOn, plan.nodeParams[node.id]?.on ?? true, (v) =>
          actions.onUpdateNodeParams(node.id, { on: v }),
        ),
      );
      host.append(ps.el);
      host.append(fxEffectSection(node.id, fxY, plan, actions, m));
    }

    // Monitor bus ON (MONITOR_ON) + level (MONITOR_LEVEL) plus the CUE-interrupt /
    // MONO toggles. ON precedes the fader to match the device MONITOR screen order.
    if (node.id === "bus.mon1" || node.id === "bus.mon2") {
      const np = plan.nodeParams[node.id] ?? {};
      const ps = section(m.inspector.parameters, { key: "params" });
      ps.body.append(
        boolToggle(m.inspector.monitorOn, np.on ?? true, (v) => actions.onUpdateNodeParams(node.id, { on: v })),
      );
      ps.body.append(faderControl(np.level ?? 0, (v) => actions.onUpdateNodeParams(node.id, { level: v })));
      // PHONES output level: a unit-less 0.0..10.0 scale, independent of the
      // monitor fader (PHONES 1 ↔ mon1, PHONES 2 ↔ mon2 — same signal, own level).
      ps.body.append(
        rangeSlider(
          m.inspector.phonesLevel,
          PHONES_LEVEL_MIN,
          PHONES_LEVEL_MAX,
          0.1,
          np.phonesLevel ?? PHONES_LEVEL_DEFAULT,
          (v) => v.toFixed(1),
          (v) => actions.onUpdateNodeParams(node.id, { phonesLevel: v }),
        ),
      );
      ps.body.append(
        boolToggle(m.inspector.cueInterrupt, np.cueInterrupt ?? true, (v) =>
          actions.onUpdateNodeParams(node.id, { cueInterrupt: v }),
        ),
      );
      ps.body.append(
        boolToggle(m.inspector.mono, np.mono ?? false, (v) => actions.onUpdateNodeParams(node.id, { mono: v })),
      );
      host.append(ps.el);
    }

    // Oscillator generator (bus.osc): on / level / mode / frequency. Frequency
    // shows only in Sine Wave mode; Width / Interval only in Burst Noise mode
    // (mode change relayouts, see main.ts).
    if (node.id === "bus.osc") {
      const osc = plan.nodeParams[node.id]?.osc ?? {};
      // Read the latest stored osc at edit time so a second field edit (the
      // inspector is not re-rendered between edits) does not clobber the first.
      const setOsc = (patch: Partial<typeof osc>): void =>
        actions.onUpdateNodeParams(node.id, { osc: { ...(plan.nodeParams[node.id]?.osc ?? {}), ...patch } });
      // OSCILLATOR menu order (device top-left → bottom-right): Mode, ON, then the
      // Frequency / Level row (Frequency shows only in Sine Wave mode).
      const ps = section(m.inspector.parameters, { key: "params" });
      ps.body.append(
        selectControl(
          m.inspector.oscMode,
          OSC_MODE_OPTIONS.map((o) => ({ value: String(o.value), label: o.label })),
          String(osc.mode ?? OSC_MODE_SINE),
          (v) => setOsc({ mode: Number(v) }),
        ),
      );
      ps.body.append(boolToggle(m.inspector.oscOn, osc.on ?? false, (v) => setOsc({ on: v })));
      const oscMode = osc.mode ?? OSC_MODE_SINE;
      if (oscMode === OSC_MODE_SINE) {
        ps.body.append(eqFreqControl(osc.freq ?? 1000, (hz) => setOsc({ freq: hz })));
      } else if (oscMode === OSC_MODE_BURST) {
        ps.body.append(
          rangeSlider(
            m.inspector.oscWidth,
            0.1,
            10,
            0.1,
            osc.width ?? 0.1,
            (v) => `${v.toFixed(1)} s`,
            (v) => setOsc({ width: v }),
          ),
        );
        ps.body.append(
          rangeSlider(
            m.inspector.oscInterval,
            1,
            30,
            1,
            osc.interval ?? 1,
            (v) => `${v} s`,
            (v) => setOsc({ interval: v }),
          ),
        );
      }
      ps.body.append(
        rangeSlider(m.inspector.oscLevel, -96, 0, 1, osc.level ?? -14, formatDb, (v) => setOsc({ level: v })),
      );
      host.append(ps.el);
    }

    // STREAMING DELAY (bus.stream): on / time / frame rate. DELAY screen order
    // (device top-left → bottom-right): Frame rate, ON, then the Delay Time knob.
    if (node.id === "bus.stream") {
      const delay = plan.nodeParams[node.id]?.delay ?? {};
      // Read the latest stored delay at edit time so a second field edit (the
      // inspector is not re-rendered between edits) does not clobber the first.
      const setDelay = (patch: Partial<typeof delay>): void =>
        actions.onUpdateNodeParams(node.id, { delay: { ...(plan.nodeParams[node.id]?.delay ?? {}), ...patch } });
      const ps = section(m.inspector.delayTitle, { key: "delay" });
      ps.body.append(
        enumSelect(
          m.inspector.delayFrameRate,
          DELAY_FRAME_RATE_OPTIONS,
          delay.frameRate ?? DELAY_FRAME_RATE_DEFAULT,
          (v) => setDelay({ frameRate: v }),
        ),
      );
      ps.body.append(boolToggle(m.inspector.delayOn, delay.on ?? false, (v) => setDelay({ on: v })));
      ps.body.append(
        rangeSlider(
          m.inspector.delayTime,
          DELAY_TIME_MIN_MS,
          DELAY_TIME_MAX_MS,
          0.01,
          delay.time ?? DELAY_TIME_MIN_MS,
          (v) => `${v.toFixed(2)} ms`,
          (v) => setDelay({ time: v }),
        ),
      );
      host.append(ps.el);
    }

    // Insert FX dropdown: MONO IN channels (input effects) and MIX/STEREO outputs
    // (output effects). An option is disabled when it exceeds the current sample
    // rate's ceiling, or when its device-wide 1-of slot is taken by another node.
    // Buses group it into their Parameters section (tailBody); channels show it
    // loose below the EQ module.
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
      const ifxSel = plan.nodeParams[node.id]?.insertFx;
      (tailBody ?? host).append(
        selectControl(
          m.inspector.insertFx,
          ifx.options.map((o) => ({
            value: String(o.value),
            label: o.label,
            disabled: !insertFxAvailable(o, plan.sampleRate) || (o.slot !== undefined && taken.has(o.slot)),
          })),
          String(ifxSel ?? INSERT_FX_NONE),
          // Selecting an effect auto-engages it on the device, so mirror that in
          // the plan; selecting No Effect leaves the dormant switch state alone.
          (v) => {
            const sel = Number(v);
            actions.onUpdateNodeParams(
              node.id,
              sel === INSERT_FX_NONE ? { insertFx: sel } : { insertFx: sel, insertFxOn: true },
            );
          },
        ),
      );
      // ON/OFF (bypass) switch below the selector — hidden under No Effect (the
      // device ignores the switch then, and re-engages it on every selection).
      if (ifxSel !== undefined && ifxSel !== INSERT_FX_NONE) {
        (tailBody ?? host).append(
          boolToggle(m.inspector.insertFxOn, insertFxEngaged(plan.nodeParams[node.id]), (v) =>
            actions.onUpdateNodeParams(node.id, { insertFxOn: v }),
          ),
        );
      }
      // Editable parameters for the selected effect (guitar amp / pitch fix /
      // compander / multi-band comp), below the selector.
      if (ifxSel !== undefined) {
        const fxSec = insertFxEffectSection(node.id, ifxSel, plan, actions, m);
        if (fxSec) (tailBody ?? host).append(fxSec);
      }
    }

    // Any node may be shelved; its wires are hidden along with it (see graph.ts).
    const hide = document.createElement("button");
    hide.type = "button";
    hide.className = "subtle";
    hide.textContent = m.inspector.hideNode;
    hide.addEventListener("click", () => actions.onHideNode(node.id));
    host.append(hide);
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

  // OSC → bus assign wire: independent L/R on/off for stereo buses; FX buses are
  // mono, so the wire's presence alone is the on state.
  const oscTarget = parseRef(from).nodeId === "bus.osc" ? oscAssign(parseRef(to).nodeId) : null;
  if (conn && oscTarget) {
    host.append(subheading(m.inspector.parameters));
    if (oscTarget.r !== null) {
      host.append(
        boolToggle(m.inspector.oscAssignL, conn.params?.oscL ?? true, (v) =>
          actions.onUpdateParams(from, to, { oscL: v }),
        ),
      );
      host.append(
        boolToggle(m.inspector.oscAssignR, conn.params?.oscR ?? true, (v) =>
          actions.onUpdateParams(from, to, { oscR: v }),
        ),
      );
    } else {
      host.append(hint(m.inspector.selectionOnly));
    }
  } else if (conn) {
    // A MIX 1 / MIX 2 destination governs the send controls: FIXED bus type drops
    // the LEVEL (fixed send level); Pan Link (VARI only) drops the PAN (it follows
    // the source channel PAN).
    const { busFixed, panLinked } = mixSendLocks(plan, parseRef(to).nodeId);
    // PRE/POST is taken against the channel's STEREO main-fader level, so the
    // fixed STEREO / FX-channel main paths show LEVEL / PAN but no PRE/POST.
    const fields = PARAM_FIELDS[conn.kind].filter(
      (f) =>
        (f !== "tap" || sendHasTap(model, from, to)) && (f !== "level" || !busFixed) && (f !== "pan" || !panLinked),
    );
    // Expose a per-send ON toggle where the route carries one (sendHasOn): the
    // CH/FX → MIX/FX sends and the fixed MIX → STEREO "TO ST". The STEREO main paths
    // do not. `isFixedToSt` only drives the toggle's label / default-off presentation.
    const isFixedToSt = isFixedConnection(model, from, to) && conn.kind === "sendSwitch";
    const hasSendOn = sendHasOn(model, from, to);
    if (fields.length || hasSendOn) {
      host.append(subheading(m.inspector.parameters));
      // ON first to match the device SEND TO screen order (ON, PRE, Pan, Level).
      // The CH/FX sends ship ON (default true); the TO ST switch ships off.
      if (hasSendOn) {
        const onLabel = isFixedToSt ? m.inspector.toSt : m.inspector.sendOn;
        host.append(
          boolToggle(onLabel, conn.params?.on ?? !isFixedToSt, (v) => actions.onUpdateParams(from, to, { on: v })),
        );
      }
      // A stereo channel's "pan" is a balance; so is a STEREO-linked MONO IN pair
      // in BAL mode. Label it BALANCE to match the device; PAN otherwise.
      const panLabel = isBalanceChannel(model, plan, parseRef(from).nodeId) ? m.inspector.balance : m.inspector.pan;
      // The tap is always editable in the planner (the plan records intent). It is
      // turned read-only only while live-connected and the device cannot accept the
      // write — CH → FX taps (the device rejects a software PRE write); shown
      // disabled with an explanatory tooltip so the value is visible but unchangeable.
      const tapEditable = !liveActive || sendTapWritable(model, from, to);
      for (const f of fields) host.append(paramControl(f, conn, actions.onUpdateParams, panLabel, tapEditable));
    } else {
      // A USB direct out is a live output where the missing fader / Ducker is a
      // surprise (route via a bus to include them); a microSD Rec tap records the
      // Rec Point stage on purpose, so it points at Rec Point instead. A channel
      // ducker key is the same pre-fader Rec Point tap, so the source channel's
      // fader / mute do not move the trigger (a bus key is post-fader — no note).
      // Anything else with no send params falls back to the generic note.
      const directOut = directOutTarget(model, from, to);
      const note =
        directOut === "usb"
          ? m.inspector.directOutTap
          : directOut === "sdRec"
            ? m.inspector.sdRecTap
            : duckerKeySource(model, from, to) === "channel"
              ? m.inspector.duckerKeyTap
              : m.inspector.selectionOnly;
      host.append(hint(note));
    }
    if (busFixed) host.append(hint(m.inspector.busFixedLevel));
    if (panLinked) host.append(hint(m.inspector.panLinked));
  }

  // A fixed wire (CH / FX channel -> STEREO) cannot be removed; offer no delete
  // button, only a note that it is structural. Its level/pan above stay editable.
  if (isFixedConnection(model, from, to)) {
    host.append(hint(m.inspector.fixedConnection));
    // A PRE (pre-fader) send from a channel whose Ducker is on taps ahead of the
    // Ducker (which sits post-fader), so the send is not ducked — flag it next to
    // the fixed-connection note rather than on the canvas.
    if (
      sendHasTap(model, from, to) &&
      conn?.params?.tap === "pre" &&
      channelDuckerOn(model, plan, parseRef(from).nodeId)
    )
      host.append(hint(m.inspector.duckerPreSend));
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

function closeButton(label: string, onClose: () => void): HTMLElement {
  const ns = "http://www.w3.org/2000/svg";
  const b = document.createElement("button");
  b.type = "button";
  b.className = "inspector-close";
  b.setAttribute("aria-label", label);
  b.title = label;
  // Decorative ✕ glyph; the accessible name comes from aria-label.
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 18 18");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M5 5l8 8M13 5l-8 8");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.6");
  path.setAttribute("stroke-linecap", "round");
  svg.append(path);
  b.append(svg);
  b.addEventListener("click", onClose);
  return b;
}

function subheading(text: string): HTMLElement {
  const h = document.createElement("h3");
  h.textContent = text;
  return h;
}

// Persisted section open/closed overrides, keyed by section kind (not per node)
// so a fold preference is consistent across nodes and survives both re-renders
// and reloads. A section with an ON-state default (gate / comp / eq / ducker)
// clears its override when the value is toggled, so it reverts to following the
// on-state (auto-collapse when off); a user fold of the disclosure persists.
const SECTION_STATE_KEY = "urx-inspector-sections";
type SectionState = Record<string, boolean>;
let sectionState: SectionState | null = null;

function sectionOverrides(): SectionState {
  if (sectionState === null) {
    const v = loadJson<unknown>(SECTION_STATE_KEY, null);
    sectionState = v && typeof v === "object" ? (v as SectionState) : {};
  }
  return sectionState;
}

function persistSectionState(): void {
  saveJson(SECTION_STATE_KEY, sectionOverrides());
}

function clearSectionOverride(key: string): void {
  const s = sectionOverrides();
  if (!(key in s)) return;
  delete s[key];
  persistSectionState();
}

// The bare ON/OFF control for an on-state section (GATE / COMP / EQ / Ducker):
// its name is the section header, so the label is empty. Toggling the value
// drops any manual fold so the section reverts to following the new on-state.
function sectionToggle(
  nodeId: string,
  key: string,
  on: boolean,
  actions: InspectorActions,
  lockedTitle?: string,
): HTMLElement {
  // A lockedTitle shows the value with both buttons disabled + a tooltip (e.g. the
  // stereo EQ above 96 kHz) — mirrors the read-only CH → FX tap control.
  return boolToggle(
    "",
    on,
    (v) => {
      clearSectionOverride(key);
      actions.onUpdateNodeParams(nodeId, { [key]: v });
    },
    lockedTitle,
  );
}

// A collapsible inspector section (rack-module style): a summary header in the
// h3 mono-uppercase idiom, optionally carrying an ON led that mirrors a section
// toggle (GATE / COMP / EQ), and a body the caller fills. Built on <details> so
// it gets native keyboard toggling and respects reduced motion. `open` is the
// default disclosure state; a persisted `key` override wins over it, so an off
// section (on === false) collapses on its own until the user folds it by hand.
function section(
  title: string,
  opts: { open?: boolean; on?: boolean; key?: string } = {},
): { el: HTMLDetailsElement; body: HTMLElement } {
  const el = document.createElement("details");
  el.className = "insp-section";
  const def = opts.open ?? true;
  const key = opts.key;
  const overrides = sectionOverrides();
  const initial = key !== undefined && key in overrides ? overrides[key] : def;
  el.open = initial;
  if (key !== undefined) {
    // The property set above can queue one echo toggle event; skip it by only
    // persisting when the disclosure actually leaves the value we last applied.
    let expected = initial;
    el.addEventListener("toggle", () => {
      if (el.open === expected) return;
      expected = el.open;
      overrides[key] = el.open;
      persistSectionState();
    });
  }
  const sum = document.createElement("summary");
  if (opts.on !== undefined) {
    const led = document.createElement("span");
    led.className = "sec-led" + (opts.on ? " on" : "");
    sum.append(led);
  }
  const label = document.createElement("span");
  label.className = "sec-title";
  label.textContent = title;
  sum.append(label);
  el.append(sum);
  const body = document.createElement("div");
  body.className = "sec-body";
  el.append(body);
  return { el, body };
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
  tapEditable = true,
): HTMLElement {
  if (field === "tap") return tapControl(conn, onUpdate, tapEditable);
  return field === "level"
    ? levelSlider(t().inspector.level, conn.params?.level ?? 0, (v) => onUpdate(conn.from, conn.to, { level: v }))
    : sliderControl(conn, onUpdate, "pan", panLabel, PAN_MIN, PAN_MAX, 1, 0, formatPan);
}

// Native <input type=range> ignores the scroll wheel, so wire it up via onWheelStep:
// a notch nudges the value one step and fires 'input' so the row's own listener updates
// the readout and reports the change. Shared by rangeSlider and snappedSlider.
function wheelStep(slider: HTMLInputElement): void {
  onWheelStep(slider, (dir) => {
    const step = Number(slider.step) || 1;
    const lo = Number(slider.min);
    const hi = Number(slider.max);
    const next = Math.min(hi, Math.max(lo, Number(slider.value) + dir * step));
    if (next === Number(slider.value)) return;
    slider.value = String(next);
    slider.dispatchEvent(new Event("input"));
  });
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
    setLevelText(value, fmt(v));
    onInput(v);
  });
  wheelStep(slider);
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
function gainControl(label: string, min: number, max: number, cur: number, onChange: (v: number) => void): HTMLElement {
  return rangeSlider(label, min, max, 1, cur, formatGainDb, onChange);
}

function formatGainDb(v: number): string {
  return `${v > 0 ? "+" : ""}${v} dB`;
}

// Per-band default frequencies (Hz) and Q shown before a fetch, matching the
// device defaults (LOW 125 / LOW-MID 1k / HIGH-MID 4k / HIGH 10k, Q 0.71).
const EQ_BAND_DEFAULT_FREQ = [125, 1000, 4000, 10000];
const EQ_Q_DEFAULT = 0.71;

// The EQ band tab last viewed per node, so a re-render (a band type / on change)
// keeps the same band open instead of snapping back to LOW. Ephemeral view state
// (like the selection), not persisted.
const eqActiveBand = new Map<string, number>();

// 4-band PEQ editor (input channel or output bus). The four bands are tabs; only
// the selected band's controls show, since stacking all four ran ~20 rows long.
// Each band shows ON / filter type (LOW & HIGH bands only) / freq / Q / gain; Q
// shows only for a peaking band and gain only when the band is not a pass filter
// — matching the device's filter-type behavior. Edits merge into nodeParams.eqBands.
// EQ 1-knob controls: the ON toggle plus (when on) the preset type and the
// 0..100 % effect-depth slider. When on, the caller hides the 4-band tabs — the
// device drives the bands from the 1-knob, so they are not editable. `mono` picks
// the type dropdown subset (mono input = Intensity/Vocal, else Intensity/Loudness).
function eqOneKnobBlock(
  nodeId: string,
  mono: boolean,
  np: NodeParams,
  plan: Plan,
  actions: InspectorActions,
  m: Messages,
): DocumentFragment {
  const frag = document.createDocumentFragment();
  const ok = np.eqOneKnob ?? {};
  const setOk = (patch: Partial<typeof ok>): void =>
    actions.onUpdateNodeParams(nodeId, { eqOneKnob: { ...(plan.nodeParams[nodeId]?.eqOneKnob ?? {}), ...patch } });
  frag.append(boolToggle(m.inspector.eqOneKnob, ok.on ?? false, (v) => setOk({ on: v })));
  if (ok.on) {
    const opts = mono ? EQ_ONE_KNOB_TYPE_MONO_OPTIONS : EQ_ONE_KNOB_TYPE_WIDE_OPTIONS;
    frag.append(
      enumSelect(m.inspector.eqOneKnobType, opts, ok.type ?? EQ_ONE_KNOB_TYPE_DEFAULT, (v) => setOk({ type: v })),
    );
    frag.append(
      rangeSlider(
        m.inspector.eqOneKnobLevel,
        0,
        100,
        1,
        ok.level ?? 0,
        (v) => `${v}%`,
        (v) => setOk({ level: v }),
      ),
    );
  }
  return frag;
}

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
  const tabs = document.createElement("div");
  tabs.className = "eq-tabs";
  const panels = document.createElement("div");

  const indexes = ctrl.bands.map((b) => b.index);
  let active = eqActiveBand.get(nodeId) ?? ctrl.bands[0].index;
  if (!indexes.includes(active)) active = ctrl.bands[0].index;

  const tabEls = new Map<number, HTMLElement>();
  const panelEls = new Map<number, HTMLElement>();
  // Switching tabs is pure DOM (no re-render), so a dragged slider keeps focus.
  const show = (i: number): void => {
    eqActiveBand.set(nodeId, i);
    for (const [j, p] of panelEls) p.hidden = j !== i;
    for (const [j, t] of tabEls) t.classList.toggle("active", j === i);
  };

  for (const band of ctrl.bands) {
    const bv = np.eqBands?.[band.index] ?? {};
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "eq-tab" + (band.index === active ? " active" : "") + ((bv.on ?? true) ? "" : " off");
    tab.textContent = m.inspector.eqBand[band.name];
    tab.addEventListener("click", () => show(band.index));
    tabs.append(tab);
    tabEls.set(band.index, tab);

    const panel = document.createElement("div");
    panel.className = "eq-panel";
    panel.hidden = band.index !== active;
    panel.append(boolToggle(m.inspector.bandOn, bv.on ?? true, (v) => setBand(band.index, { on: v })));
    let effType = EQ_TYPE_PEAKING;
    if (band.type !== null) {
      effType = bv.type ?? EQ_TYPE_SHELVING;
      const opts = band.name === "low" ? EQ_TYPE_LOW_OPTIONS : EQ_TYPE_HIGH_OPTIONS;
      panel.append(
        selectControl(
          m.inspector.filterType,
          opts.map((o) => ({ value: String(o.value), label: o.label })),
          String(effType),
          (v) => setBand(band.index, { type: Number(v) }),
        ),
      );
    }
    // Device EQ screen reads each band's values Q, Freq, Gain (left → right); Q is
    // shown only for a peaking band, gain only when the band is not a pass filter.
    if (effType === EQ_TYPE_PEAKING) {
      panel.append(
        rangeSlider(
          m.inspector.q,
          EQ_Q_MIN,
          EQ_Q_MAX,
          0.1,
          bv.q ?? EQ_Q_DEFAULT,
          (v) => v.toFixed(2),
          (v) => setBand(band.index, { q: v }),
        ),
      );
    }
    panel.append(eqFreqControl(bv.freq ?? EQ_BAND_DEFAULT_FREQ[band.index], (v) => setBand(band.index, { freq: v })));
    if (effType !== EQ_TYPE_PASS) {
      panel.append(
        rangeSlider(m.inspector.eqGain, EQ_GAIN_MIN_DB, EQ_GAIN_MAX_DB, 0.5, bv.gain ?? 0, formatGainDb, (v) =>
          setBand(band.index, { gain: v }),
        ),
      );
    }
    panels.append(panel);
    panelEls.set(band.index, panel);
  }
  frag.append(tabs, panels);
  return frag;
}

function formatDyn(v: number, unit: DynField["unit"]): string {
  if (unit === "db") return `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
  if (unit === "ratio") return `${v.toFixed(1)}:1`;
  return v < 1 ? `${v.toFixed(3)} ms` : `${v.toFixed(1)} ms`;
}

// One GATE/COMP/ducker detail slider, labeled and formatted by its unit. The dyn
// labels cover all slider field keys (a subset of the DynField.key union, which
// also spans the comp toggle keys), so index them via a string view.
function dynFieldSlider(
  f: DynField,
  m: Messages,
  cur: number | undefined,
  onSet: (key: DynField["key"], v: number) => void,
): HTMLElement {
  const label = (m.inspector.dyn as Record<string, string>)[f.key];
  // GATE range has a -∞ notch (one step below its -72 dB floor = fully closed).
  const fmt =
    f.name === "GATE_RANGE"
      ? (v: number) => (v <= GATE_RANGE_OFF_DB ? "-∞ dB" : formatDyn(v, f.unit))
      : (v: number) => formatDyn(v, f.unit);
  return rangeSlider(label, f.min, f.max, f.step, cur ?? f.def, fmt, (v) => onSet(f.key, v));
}

// Merge a patch into a node's FX effect object / its raw params map, reading the
// latest stored value at edit time so concurrent sibling edits aren't lost.
function mergeFxEffect(actions: InspectorActions, plan: Plan, nodeId: string, patch: Partial<FxEffectParams>): void {
  actions.onUpdateNodeParams(nodeId, { fxEffect: { ...(plan.nodeParams[nodeId]?.fxEffect ?? {}), ...patch } });
}
function mergeFxParam(actions: InspectorActions, plan: Plan, nodeId: string, key: string, raw: number): void {
  const params = plan.nodeParams[nodeId]?.fxEffect?.params ?? {};
  mergeFxEffect(actions, plan, nodeId, { params: { ...params, [key]: raw } });
}

// FX-channel EFFECT section: the EFFECT TYPE selector, the effect ON / Mix, then
// the type-specific parameter controls (raw sliders with a display formatter,
// toggles, selects) from the fx-effect descriptors. fxIndex = 0 (FX1) / 1 (FX2).
function fxEffectSection(
  nodeId: string,
  fxIndex: number,
  plan: Plan,
  actions: InspectorActions,
  m: Messages,
): HTMLElement {
  const t = m.inspector.fxEffect;
  const fx = plan.nodeParams[nodeId]?.fxEffect ?? {};
  const type = fx.type ?? FX_EFFECT_TYPE_DEFAULT[fxIndex];
  const family = fxFamilyOf(type);
  const descs = fxParams(family);
  const { el, body } = section(t.title, { key: "fxEffect" });

  body.append(
    selectControl(
      t.effectType,
      fxEffectTypes(fxIndex).map((o) => ({ value: String(o.value), label: o.label })),
      String(type),
      (v) => mergeFxEffect(actions, plan, nodeId, { type: Number(v) }),
    ),
  );
  body.append(boolToggle(t.effectOn, fx.on ?? true, (v) => mergeFxEffect(actions, plan, nodeId, { on: v })));
  body.append(
    rangeSlider(
      t.level,
      0,
      100,
      1,
      fx.level ?? 100,
      (r) => String(r),
      (v) => mergeFxEffect(actions, plan, nodeId, { level: v }),
    ),
  );

  // Sibling raw values, so the REV-X Reverb Time readout can fold in Room Size.
  const ctx: Record<string, number> = {};
  for (const d of descs) ctx[d.key] = fx.params?.[d.key] ?? d.def;

  for (const d of descs) {
    const cur = fx.params?.[d.key] ?? d.def;
    const label = t.params[d.label as keyof typeof t.params] ?? d.label;
    if (d.control === "toggle") {
      body.append(boolToggle(label, cur !== 0, (v) => mergeFxParam(actions, plan, nodeId, d.key, v ? 1 : 0)));
    } else if (d.control === "select") {
      body.append(
        selectControl(
          label,
          (d.options ?? []).map((o) => ({ value: String(o.value), label: o.label })),
          String(cur),
          (v) => mergeFxParam(actions, plan, nodeId, d.key, Number(v)),
        ),
      );
    } else {
      body.append(
        rangeSlider(
          label,
          d.rawMin ?? 0,
          d.rawMax ?? 0,
          d.rawStep ?? 1,
          cur,
          (r) => (d.format ? d.format(r, ctx) : String(r)),
          (v) => mergeFxParam(actions, plan, nodeId, d.key, v),
        ),
      );
    }
  }
  return el;
}

// ---- Insert-FX effect editor (guitar amp / pitch fix / compander / MBC) ----

function insertFxVal(plan: Plan, nodeId: string, slot: number, def: number): number {
  return plan.nodeParams[nodeId]?.insertFxParams?.[String(slot)] ?? def;
}
function mergeInsertFxParams(
  actions: InspectorActions,
  plan: Plan,
  nodeId: string,
  patch: Record<number, number>,
): void {
  const params = plan.nodeParams[nodeId]?.insertFxParams ?? {};
  const next = { ...params };
  for (const [slot, raw] of Object.entries(patch)) next[slot] = raw;
  actions.onUpdateNodeParams(nodeId, { insertFxParams: next });
}

// Render one flat descriptor (compander / guitar / pitch scalar) into `body`.
function appendInsertFxDesc(
  body: HTMLElement,
  desc: InsertFxParamDesc,
  nodeId: string,
  plan: Plan,
  actions: InspectorActions,
  t: Messages["inspector"]["insertFxEffect"],
): void {
  const label = t.params[desc.label as keyof typeof t.params] ?? desc.label;
  const cur = insertFxVal(plan, nodeId, desc.slot, desc.def);
  const set = (raw: number) => {
    const patch: Record<number, number> = { [desc.slot]: raw };
    if (desc.mirror !== undefined) patch[desc.mirror] = raw;
    mergeInsertFxParams(actions, plan, nodeId, patch);
  };
  if (desc.control === "toggle") {
    body.append(boolToggle(label, cur !== 0, (v) => set(v ? 1 : 0)));
  } else if (desc.control === "select") {
    body.append(
      selectControl(
        label,
        (desc.options ?? []).map((o) => ({ value: String(o.value), label: o.label })),
        String(cur),
        (v) => set(Number(v)),
      ),
    );
  } else {
    body.append(
      rangeSlider(
        label,
        desc.rawMin ?? 0,
        desc.rawMax ?? 0,
        desc.rawStep ?? 1,
        cur,
        (r) => (desc.format ? desc.format(r) : String(r)),
        set,
      ),
    );
  }
}

// Standard C-major scale (semitone offsets on = major; the rest off). Used by the
// Pitch Fix scale preset buttons; calibration confirmed Major clears slots
// 23/25/28/30/32 (the non-major semitones).
const PITCH_MAJOR_ON = new Set([0, 2, 4, 5, 7, 9, 11]);

// INSERT-FX effect section, shown below the insert-FX selector when the chosen
// effect has editable parameters. Layout per family: compander/guitar = flat
// descriptors; MBC = 1-knob + three bands + global; pitch = scalars + scale
// keyboard + MIDI control.
function insertFxEffectSection(
  nodeId: string,
  selectorValue: number,
  plan: Plan,
  actions: InspectorActions,
  m: Messages,
): HTMLElement | null {
  const fam = insertFxFamilyOf(selectorValue);
  if (!fam) return null;
  const t = m.inspector.insertFxEffect;
  const { el, body } = section(t.title, { key: "insertFxEffect" });

  if (fam.family === "mbc") {
    renderMbc(body, nodeId, plan, actions, t);
  } else if (fam.family === "pitch") {
    for (const d of insertFxParams("pitch")) appendInsertFxDesc(body, d, nodeId, plan, actions, t);
    renderPitchScale(body, nodeId, plan, actions, t);
    renderPitchMidi(body, nodeId, plan, actions, t);
  } else {
    for (const d of insertFxParams(fam.family as InsertFxFamily)) appendInsertFxDesc(body, d, nodeId, plan, actions, t);
  }
  return el;
}

function renderMbc(
  body: HTMLElement,
  nodeId: string,
  plan: Plan,
  actions: InspectorActions,
  t: Messages["inspector"]["insertFxEffect"],
): void {
  const set = (slot: number, raw: number) => mergeInsertFxParams(actions, plan, nodeId, { [slot]: raw });
  // 1-knob
  body.append(
    boolToggle(t.params.oneKnobOn, insertFxVal(plan, nodeId, MBC_GLOBAL.oneKnobOn, 0) !== 0, (v) =>
      set(MBC_GLOBAL.oneKnobOn, v ? 1 : 0),
    ),
  );
  body.append(
    rangeSlider(
      t.params.oneKnobLevel,
      0,
      48,
      1,
      insertFxVal(plan, nodeId, MBC_GLOBAL.oneKnobLevel, 0),
      (r) => String(r),
      (v) => set(MBC_GLOBAL.oneKnobLevel, v),
    ),
  );
  // Per-band: Threshold / Ratio / Attack / Gain, each from MBC_BAND_PARAM.
  const bandLabel = { low: t.bandLow, mid: t.bandMid, high: t.bandHigh };
  // Display order, deliberately not the catalog's MBC_BAND_KEYS order.
  const bandKeys: MbcBandKey[] = ["threshold", "ratio", "attack", "gain"];
  for (const b of MBC_BANDS) {
    for (const k of bandKeys) {
      const p = MBC_BAND_PARAM[k];
      body.append(
        rangeSlider(
          `${bandLabel[b.band]} ${t.params[k]}`,
          p.rawMin,
          p.rawMax,
          1,
          insertFxVal(plan, nodeId, b[k], p.def),
          p.format,
          (v) => set(b[k], v),
        ),
      );
    }
  }
  // Global
  body.append(
    boolToggle(t.params.bypass, insertFxVal(plan, nodeId, MBC_GLOBAL.bypass, 0) !== 0, (v) =>
      set(MBC_GLOBAL.bypass, v ? 1 : 0),
    ),
  );
  body.append(
    rangeSlider(
      t.params.xoverLowMid,
      MBC_XOVER_LM_RANGE.min,
      MBC_XOVER_LM_RANGE.max,
      1,
      insertFxVal(plan, nodeId, MBC_GLOBAL.xoverLowMid, 37),
      mbcXoverLabel,
      (v) => set(MBC_GLOBAL.xoverLowMid, v),
    ),
  );
  body.append(
    rangeSlider(
      t.params.xoverMidHigh,
      MBC_XOVER_MH_RANGE.min,
      MBC_XOVER_MH_RANGE.max,
      1,
      insertFxVal(plan, nodeId, MBC_GLOBAL.xoverMidHigh, 94),
      mbcXoverLabel,
      (v) => set(MBC_GLOBAL.xoverMidHigh, v),
    ),
  );
  body.append(
    rangeSlider(
      t.params.release,
      0,
      MBC_RELEASE_MS.length - 1,
      1,
      insertFxVal(plan, nodeId, MBC_GLOBAL.release, 7),
      (r) => {
        const ms = MBC_RELEASE_MS[r] ?? 0;
        return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`;
      },
      (v) => set(MBC_GLOBAL.release, v),
    ),
  );
  body.append(
    rangeSlider(t.params.outGain, 52, 76, 1, insertFxVal(plan, nodeId, MBC_GLOBAL.outGain, 68), mbcOutGainLabel, (v) =>
      set(MBC_GLOBAL.outGain, v),
    ),
  );
}

function renderPitchScale(
  body: HTMLElement,
  nodeId: string,
  plan: Plan,
  actions: InspectorActions,
  t: Messages["inspector"]["insertFxEffect"],
): void {
  const scale = insertFxVal(plan, nodeId, PITCH_SCALE_SLOT, PITCH_SCALE_CHROMATIC);
  body.append(
    selectControl(
      t.scale,
      [
        { value: String(PITCH_SCALE_CHROMATIC), label: t.scaleChromatic },
        { value: String(PITCH_SCALE_MAJOR), label: t.scaleMajor },
        { value: String(PITCH_SCALE_CUSTOM), label: t.scaleCustom, disabled: scale !== PITCH_SCALE_CUSTOM },
      ],
      String(scale === PITCH_SCALE_CHROMATIC || scale === PITCH_SCALE_MAJOR ? scale : PITCH_SCALE_CUSTOM),
      (v) => {
        const sel = Number(v);
        const patch: Record<number, number> = { [PITCH_SCALE_SLOT]: sel };
        if (sel === PITCH_SCALE_CHROMATIC) PITCH_NOTE_SLOTS.forEach((s) => (patch[s] = 1));
        else if (sel === PITCH_SCALE_MAJOR)
          PITCH_NOTE_SLOTS.forEach((s, i) => (patch[s] = PITCH_MAJOR_ON.has(i) ? 1 : 0));
        mergeInsertFxParams(actions, plan, nodeId, patch);
      },
    ),
  );
  // 12 note toggles (a semitone row from the Key root). Editing any sets Custom.
  for (let i = 0; i < PITCH_NOTE_SLOTS.length; i++) {
    const slot = PITCH_NOTE_SLOTS[i];
    body.append(
      boolToggle(SEMITONE_NAMES[i], insertFxVal(plan, nodeId, slot, 1) !== 0, (on) =>
        mergeInsertFxParams(actions, plan, nodeId, { [slot]: on ? 1 : 0, [PITCH_SCALE_SLOT]: PITCH_SCALE_CUSTOM }),
      ),
    );
  }
}

function renderPitchMidi(
  body: HTMLElement,
  nodeId: string,
  plan: Plan,
  actions: InspectorActions,
  t: Messages["inspector"]["insertFxEffect"],
): void {
  const enable = insertFxVal(plan, nodeId, PITCH_MIDI_ENABLE_SLOT, 0);
  const realtime = insertFxVal(plan, nodeId, PITCH_MIDI_REALTIME_SLOT, 0);
  const cur = enable === 0 ? 0 : realtime === 0 ? 1 : 2;
  body.append(
    selectControl(
      t.params.midiControl,
      [
        { value: "0", label: "Off" },
        { value: "1", label: "Setting" },
        { value: "2", label: "Real Time" },
      ],
      String(cur),
      (v) => {
        const mode = Number(v);
        mergeInsertFxParams(actions, plan, nodeId, {
          [PITCH_MIDI_ENABLE_SLOT]: mode === 0 ? 0 : 1,
          [PITCH_MIDI_REALTIME_SLOT]: mode === 2 ? 1 : 0,
        });
      },
    ),
  );
}

// Merge a patch into a node's live dynamics sub-object (gate / comp / ducker),
// reading the latest stored value at edit time so concurrent sibling slider edits
// aren't lost.
function mergeSection(
  actions: InspectorActions,
  plan: Plan,
  nodeId: string,
  section: "gate" | "comp" | "ducker",
  patch: Record<string, number | boolean>,
): void {
  actions.onUpdateNodeParams(nodeId, { [section]: { ...(plan.nodeParams[nodeId]?.[section] ?? {}), ...patch } });
}

// Ducker node detail editor: the on/off plus threshold/range/attack/decay sliders.
// The ducker source is a key-source connection, edited on the canvas, not here.
function duckerBlock(nodeId: string, np: NodeParams, plan: Plan, actions: InspectorActions, m: Messages): HTMLElement {
  const on = np.duckerOn ?? false;
  const { el, body } = section(m.inspector.duckerOn, { open: on, on, key: "duckerOn" });
  body.append(sectionToggle(nodeId, "duckerOn", on, actions));
  const vals = (np.ducker ?? {}) as Record<string, number | undefined>;
  for (const f of DUCKER_FIELDS)
    body.append(
      dynFieldSlider(f, m, vals[f.key], (key, v) => mergeSection(actions, plan, nodeId, "ducker", { [key]: v })),
    );
  return el;
}

// GATE detail sliders (threshold/range/attack/hold/decay) for a MONO IN channel.
// The section's GATE ON toggle precedes this block (see renderInspector), so it
// reads like the device's GATE screen — the GATE button heads its parameters.
// Sliders mutate in place (no value drives a layout change), so none re-render.
function gateDetailBlock(
  nodeId: string,
  fields: DynField[],
  np: NodeParams,
  plan: Plan,
  actions: InspectorActions,
  m: Messages,
): DocumentFragment {
  const frag = document.createDocumentFragment();
  const gate = (np.gate ?? {}) as Record<string, number | undefined>;
  for (const f of fields)
    frag.append(
      dynFieldSlider(f, m, gate[f.key], (key, v) => mergeSection(actions, plan, nodeId, "gate", { [key]: v })),
    );
  return frag;
}

// COMP detail editor (MONO IN channels, COMP->EQ mode). Follows the COMP ON toggle
// like the device's COMP screen: Auto Makeup then 1-knob (left → right), then the
// threshold/ratio/gain/attack/release sliders and the knee dropdown. 1-knob drives
// every param from a single level, so the rest — Auto Makeup included — hide while
// it is on, and Auto Makeup auto-drives the gain, so its slider hides too.
// SSMCS raw-value display formatters: ms (3-tier to match the device's variable
// precision) and ratio (∞ at the top). Hz and dB reuse formatHz / formatDyn.
function fmtSsmcsMs(ms: number): string {
  return ms < 10 ? `${ms.toFixed(3)} ms` : ms < 100 ? `${ms.toFixed(2)} ms` : `${ms.toFixed(1)} ms`;
}
function fmtSsmcsRatio(r: number): string {
  return r === Infinity ? "∞:1" : `${r.toFixed(2)}:1`;
}
const fmtSsmcsHz = (raw: number): string => formatHz(ssmcsFreqHz(raw));
const fmtSsmcsGain = (raw: number): string => formatDyn(ssmcsGainDb(raw), "db");
const fmtSsmcsQ = (raw: number): string => ssmcsQ(raw).toFixed(2);

// Merge a patch into a node's SSMCS sub-object — at the top level, a named nested
// sub-section (comp / sc), or a named EQ band — reading the latest stored value
// so sibling slider edits aren't lost.
function mergeSsmcs(actions: InspectorActions, plan: Plan, nodeId: string, patch: Partial<SsmcsParams>): void {
  actions.onUpdateNodeParams(nodeId, { ssmcs: { ...(plan.nodeParams[nodeId]?.ssmcs ?? {}), ...patch } });
}
function mergeSsmcsSub(
  actions: InspectorActions,
  plan: Plan,
  nodeId: string,
  sub: "comp" | "sc",
  patch: Record<string, number | boolean>,
): void {
  mergeSsmcs(actions, plan, nodeId, { [sub]: { ...(plan.nodeParams[nodeId]?.ssmcs?.[sub] ?? {}), ...patch } });
}
function mergeSsmcsBand(
  actions: InspectorActions,
  plan: Plan,
  nodeId: string,
  band: "low" | "mid" | "high",
  patch: Partial<SsmcsBand>,
): void {
  const eq = plan.nodeParams[nodeId]?.ssmcs?.eq ?? {};
  mergeSsmcs(actions, plan, nodeId, { eq: { ...eq, [band]: { ...(eq[band] ?? {}), ...patch } } });
}

// SSMCS Main controls (Sweet Spot Data preset + Comp Drive / Morphing / Out Gain).
function ssmcsMasterBlock(
  nodeId: string,
  np: NodeParams,
  plan: Plan,
  actions: InspectorActions,
  m: Messages,
): DocumentFragment {
  const frag = document.createDocumentFragment();
  const s = np.ssmcs ?? SSMCS_INITIAL;
  frag.append(
    selectControl(
      m.inspector.ssmcs.sweetSpotData,
      SWEET_SPOT_DATA_OPTIONS.map((o) => ({ value: String(o.value), label: o.label })),
      String(s.sweetSpotData ?? SSMCS_INITIAL.sweetSpotData),
      (v) => mergeSsmcs(actions, plan, nodeId, { sweetSpotData: Number(v) }),
    ),
  );
  frag.append(
    rangeSlider(
      m.inspector.ssmcs.compDrive,
      SSMCS_COMP_DRIVE_MIN,
      SSMCS_COMP_DRIVE_MAX,
      1,
      s.compDrive ?? SSMCS_INITIAL.compDrive,
      (v) => ssmcsCompDrive(v).toFixed(2),
      (v) => mergeSsmcs(actions, plan, nodeId, { compDrive: v }),
    ),
  );
  frag.append(
    rangeSlider(
      m.inspector.ssmcs.morphing,
      SSMCS_MORPHING_MIN,
      SSMCS_MORPHING_MAX,
      1,
      s.morphing ?? SSMCS_INITIAL.morphing,
      String,
      (v) => mergeSsmcs(actions, plan, nodeId, { morphing: v }),
    ),
  );
  frag.append(
    rangeSlider(
      m.inspector.ssmcs.outGain,
      SSMCS_GAIN_MIN,
      SSMCS_GAIN_MAX,
      1,
      s.outGain ?? SSMCS_INITIAL.outGain,
      fmtSsmcsGain,
      (v) => mergeSsmcs(actions, plan, nodeId, { outGain: v }),
    ),
  );
  return frag;
}

// SSMCS COMP detail: Attack / Release / Ratio / Knee + the side-chain filter. The
// device-internal threshold/makeup (not shown on the LCD) are left untouched.
function ssmcsCompBlock(
  nodeId: string,
  np: NodeParams,
  plan: Plan,
  actions: InspectorActions,
  m: Messages,
): DocumentFragment {
  const frag = document.createDocumentFragment();
  const ci = SSMCS_INITIAL.comp;
  const c = np.ssmcs?.comp ?? ci;
  const setComp = (patch: Record<string, number>): void => mergeSsmcsSub(actions, plan, nodeId, "comp", patch);
  frag.append(
    rangeSlider(
      m.inspector.dyn.attack,
      SSMCS_ATTACK_RAW_MIN,
      SSMCS_ATTACK_RAW_MAX,
      1,
      c.attack ?? ci.attack,
      (v) => fmtSsmcsMs(ssmcsAttackMs(v)),
      (v) => setComp({ attack: v }),
    ),
  );
  frag.append(
    rangeSlider(
      m.inspector.dyn.release,
      SSMCS_RELEASE_RAW_MIN,
      SSMCS_RELEASE_RAW_MAX,
      1,
      c.release ?? ci.release,
      (v) => fmtSsmcsMs(ssmcsReleaseMs(v)),
      (v) => setComp({ release: v }),
    ),
  );
  frag.append(
    rangeSlider(
      m.inspector.dyn.ratio,
      SSMCS_RATIO_RAW_MIN,
      SSMCS_RATIO_RAW_MAX,
      1,
      c.ratio ?? ci.ratio,
      (v) => fmtSsmcsRatio(ssmcsRatio(v)),
      (v) => setComp({ ratio: v }),
    ),
  );
  frag.append(
    selectControl(
      m.inspector.dyn.knee,
      COMP_KNEE_OPTIONS.map((o) => ({ value: String(o.value), label: o.label })),
      String(c.knee ?? ci.knee),
      (v) => setComp({ knee: Number(v) }),
    ),
  );
  const si = SSMCS_INITIAL.sc;
  const sc = np.ssmcs?.sc ?? si;
  const setSc = (patch: Record<string, number | boolean>): void => mergeSsmcsSub(actions, plan, nodeId, "sc", patch);
  frag.append(boolToggle(m.inspector.ssmcs.sideChain, sc.on ?? si.on, (v) => setSc({ on: v })));
  frag.append(
    rangeSlider(m.inspector.q, SSMCS_Q_RAW_MIN, SSMCS_Q_RAW_MAX, 1, sc.q ?? si.q, fmtSsmcsQ, (v) => setSc({ q: v })),
  );
  frag.append(
    rangeSlider(m.inspector.frequency, SSMCS_FREQ_RAW_MIN, SSMCS_FREQ_RAW_MAX, 1, sc.freq ?? si.freq, fmtSsmcsHz, (v) =>
      setSc({ freq: v }),
    ),
  );
  frag.append(
    rangeSlider(m.inspector.eqGain, SSMCS_GAIN_MIN, SSMCS_GAIN_MAX, 1, sc.gain ?? si.gain, fmtSsmcsGain, (v) =>
      setSc({ gain: v }),
    ),
  );
  return frag;
}

// Per-band SSMCS EQ ranges: Low/High are shelving (freq capped/floored, no Q),
// Mid is peaking (full freq span + Q). Derived once so a band only needs its name.
const SSMCS_EQ_BANDS = [
  { key: "low", freqMin: SSMCS_FREQ_RAW_MIN, freqMax: SSMCS_EQ_LOW_FREQ_RAW_MAX, hasQ: false },
  { key: "mid", freqMin: SSMCS_FREQ_RAW_MIN, freqMax: SSMCS_FREQ_RAW_MAX, hasQ: true },
  { key: "high", freqMin: SSMCS_EQ_HIGH_FREQ_RAW_MIN, freqMax: SSMCS_FREQ_RAW_MAX, hasQ: false },
] as const;

// SSMCS 3-band EQ (Low shelf / Mid peak / High shelf). Band order Q → Freq → Gain
// matches the device EQ screen and the COMP->EQ inspector convention.
function ssmcsEqBlock(
  nodeId: string,
  np: NodeParams,
  plan: Plan,
  actions: InspectorActions,
  m: Messages,
): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const spec of SSMCS_EQ_BANDS) {
    const bi = SSMCS_INITIAL.eq[spec.key];
    const b: SsmcsBand = np.ssmcs?.eq?.[spec.key] ?? bi;
    const setBand = (patch: Partial<SsmcsBand>): void => mergeSsmcsBand(actions, plan, nodeId, spec.key, patch);
    frag.append(boolToggle(m.inspector.ssmcs.bands[spec.key], b.on ?? bi.on, (v) => setBand({ on: v })));
    if (spec.hasQ)
      frag.append(
        rangeSlider(m.inspector.q, SSMCS_Q_RAW_MIN, SSMCS_Q_RAW_MAX, 1, b.q ?? SSMCS_INITIAL.eq.mid.q, fmtSsmcsQ, (v) =>
          setBand({ q: v }),
        ),
      );
    frag.append(
      rangeSlider(m.inspector.frequency, spec.freqMin, spec.freqMax, 1, b.freq ?? bi.freq, fmtSsmcsHz, (v) =>
        setBand({ freq: v }),
      ),
    );
    frag.append(
      rangeSlider(m.inspector.eqGain, SSMCS_GAIN_MIN, SSMCS_GAIN_MAX, 1, b.gain ?? bi.gain, fmtSsmcsGain, (v) =>
        setBand({ gain: v }),
      ),
    );
  }
  return frag;
}

function compDetailBlock(
  nodeId: string,
  fields: DynField[],
  np: NodeParams,
  plan: Plan,
  actions: InspectorActions,
  m: Messages,
): DocumentFragment {
  const frag = document.createDocumentFragment();
  const setComp = (patch: Record<string, number | boolean>): void => mergeSection(actions, plan, nodeId, "comp", patch);
  const comp = np.comp ?? {};
  const compVals = comp as Record<string, number | undefined>;
  if (!comp.oneKnob) {
    frag.append(boolToggle(m.inspector.autoMakeup, comp.autoMakeup ?? false, (v) => setComp({ autoMakeup: v })));
  }
  frag.append(boolToggle(m.inspector.oneKnob, comp.oneKnob ?? false, (v) => setComp({ oneKnob: v })));
  if (comp.oneKnob) {
    frag.append(
      rangeSlider(
        m.inspector.oneKnobLevel,
        0,
        100,
        1,
        comp.oneKnobLevel ?? 0,
        (v) => `${v}%`,
        (v) => setComp({ oneKnobLevel: v }),
      ),
    );
    // The device drives ratio/gain from the 1-knob level and shows them read-only;
    // mirror that (values come from readback, so they refresh on the next fetch).
    const dyn = m.inspector.dyn as Record<string, string>;
    for (const key of ["ratio", "gain"] as const) {
      const f = fields.find((x) => x.key === key);
      if (!f) continue;
      const { row } = paramBlock(dyn[key], formatDyn(compVals[key] ?? f.def, f.unit));
      row.classList.add("readonly");
      row.title = m.inspector.oneKnobDriven;
      frag.append(row);
    }
    return frag;
  }
  for (const f of fields) {
    if (f.key === "gain" && comp.autoMakeup) continue;
    frag.append(dynFieldSlider(f, m, compVals[f.key], (key, v) => setComp({ [key]: v })));
  }
  frag.append(
    selectControl(
      m.inspector.dyn.knee,
      COMP_KNEE_OPTIONS.map((o) => ({ value: String(o.value), label: o.label })),
      String(comp.knee ?? COMP_KNEE_DEFAULT),
      (v) => setComp({ knee: Number(v) }),
    ),
  );
  return frag;
}

// A range slider over discrete integer positions: the slider walks [0, posMax] by
// 1, and toPos/fromPos map a domain value (dB, Hz, …) to and from a position. Used
// where the domain is non-linear or a fixed grid, so every stop is a real value.
function snappedSlider(
  label: string,
  cur: number,
  posMax: number,
  toPos: (v: number) => number,
  fromPos: (pos: number) => number,
  fmt: (v: number) => string,
  onChange: (v: number) => void,
): HTMLElement {
  const { row, value } = paramBlock(label, fmt(cur));
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = String(posMax);
  slider.step = "1";
  slider.value = String(toPos(cur));
  slider.addEventListener("input", () => {
    const v = fromPos(Number(slider.value));
    setLevelText(value, fmt(v));
    onChange(v);
  });
  wheelStep(slider);
  row.append(slider);
  return row;
}

// EQ band frequency slider on a log scale (20 Hz … 20 kHz) so each octave gets
// equal width; reports the snapped Hz value and formats as Hz / kHz.
function eqFreqControl(cur: number, onChange: (hz: number) => void): HTMLElement {
  const steps = 1000;
  const ratio = Math.log(EQ_FREQ_MAX_HZ / EQ_FREQ_MIN_HZ);
  const toPos = (hz: number): number => Math.round((steps * Math.log(hz / EQ_FREQ_MIN_HZ)) / ratio);
  const toHz = (pos: number): number => Math.round(EQ_FREQ_MIN_HZ * Math.exp((ratio * pos) / steps));
  return snappedSlider(t().inspector.frequency, cur, steps, toPos, toHz, formatHz, onChange);
}

// A level / send / fader slider that snaps to the device's discrete level_gain
// grid (LEVEL_STEPS_DB) instead of a uniform dB step — the hardware only stores
// those detents, so a 0.5 dB step would offer unsettable values (e.g. -15.0).
// The slider index maps to a grid position: 0 = -∞ (off), 1..N = LEVEL_STEPS_DB.
function levelSlider(label: string, cur: number, onChange: (v: number) => void): HTMLElement {
  return snappedSlider(label, cur, LEVEL_POS_MAX, levelToPos, posToLevel, formatDb, onChange);
}

// Node-level bus output fader (STEREO master / MIX / MONITOR): the level_gain
// scale, -∞ then -96.0 … +10.0 dB — the same as a send. The bottom notch
// is the -∞ / off position.
function faderControl(cur: number, onChange: (v: number) => void): HTMLElement {
  return levelSlider(t().inspector.level, cur, onChange);
}

// Node-level bus master balance (STEREO 583 / MIX 676): signed ±63, center 0.
function balanceControl(label: string, cur: number, onChange: (v: number) => void): HTMLElement {
  return rangeSlider(label, PAN_MIN, PAN_MAX, 1, cur, formatPan, onChange);
}

// A two-button ON/OFF toggle for a node-level boolean (channel on, HPF), styled
// like the PRE/POST control. Highlights the active state and reports the chosen
// value on click.
// Mark `button` as the pressed one in a two-button toggle group (clears the
// others). Lets a toggle reflect a click at once: callers that mutate in place
// (e.g. a plain send ON/OFF) do not re-render the inspector, so without this the
// button would stay visually stale until the next selection.
function selectToggle(group: HTMLElement, button: HTMLButtonElement): void {
  group.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
  button.classList.add("on");
}

// `lockedTitle`, when set, renders the pair read-only: both buttons disabled (no
// click handler) and the reason shown as a row tooltip — the value is still visible.
function boolToggle(label: string, value: boolean, onChange: (v: boolean) => void, lockedTitle?: string): HTMLElement {
  const { row } = paramBlock(label, "");
  if (lockedTitle !== undefined) row.title = lockedTitle;
  const group = document.createElement("div");
  group.className = "toggle";
  const make = (on: boolean, text: string): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.classList.toggle("on", value === on);
    if (lockedTitle === undefined)
      b.addEventListener("click", () => {
        selectToggle(group, b);
        onChange(on);
      });
    else b.disabled = true;
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
  disabled = false,
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
  sel.disabled = disabled;
  sel.addEventListener("change", () => onChange(sel.value));
  row.append(sel);
  return row;
}

// selectControl over a numeric-value option list (the {value:number,label} enum
// shape used across params.ts), handling the string<->number coercion so call
// sites stay free of String()/Number() boilerplate.
function enumSelect(
  label: string,
  options: { value: number; label: string }[],
  current: number,
  onChange: (v: number) => void,
  disabled = false,
): HTMLElement {
  return selectControl(
    label,
    options.map((o) => ({ value: String(o.value), label: o.label })),
    String(current),
    (v) => onChange(Number(v)),
    disabled,
  );
}

// Channel/bus color palette for the top-accent cap — the device CH SETTING
// palette so a chosen color maps 1:1 to the on-device color (and reads back to
// the same swatch). Order follows the device step list (COLOR_PALETTE); the
// "none" swatch is the device "Off" state (no cap).
export const NODE_COLORS = COLOR_PALETTE.map((c) => c.hex);

// A row of color swatches plus a "none" clear option. The active color (or none)
// is ringed. Selecting toggles: clicking the active color clears it.
function colorSwatches(
  label: string,
  current: string | undefined,
  onPick: (color: string | null) => void,
): HTMLElement {
  const { row } = paramBlock(label, "");
  const strip = document.createElement("div");
  strip.className = "swatches";
  const none = document.createElement("button");
  none.type = "button";
  none.className = "swatch swatch-none" + (current ? "" : " sel");
  none.title = label;
  none.addEventListener("click", () => onPick(null));
  strip.append(none);
  for (const c of NODE_COLORS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch" + (current === c ? " sel" : "");
    b.style.background = c;
    b.addEventListener("click", () => onPick(current === c ? null : c));
    strip.append(b);
  }
  row.append(strip);
  return row;
}

// A labeled single-line text field. Reports every keystroke (trimmed by the
// caller) without re-rendering, so it keeps focus while typing.
function textInput(label: string, value: string, placeholder: string, onInput: (v: string) => void): HTMLElement {
  const { row } = paramBlock(label, "");
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  input.placeholder = placeholder;
  input.addEventListener("input", () => onInput(input.value));
  row.append(input);
  return row;
}

function tapControl(conn: PlanConnection, onUpdate: UpdateParams, editable = true): HTMLElement {
  const cur = conn.params?.tap ?? "post";
  const { row } = paramBlock(t().inspector.prePost, "");
  const group = document.createElement("div");
  group.className = "toggle";
  // CH → FX taps are read-only: the device rejects software writes, so the device
  // (LCD) value is shown but the buttons are disabled, with an explanatory tooltip.
  if (!editable) row.title = t().inspector.prePostLcdOnly;
  const make = (tap: "pre" | "post", text: string): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.classList.toggle("on", cur === tap);
    b.disabled = !editable;
    if (editable)
      b.addEventListener("click", () => {
        selectToggle(group, b);
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
  const value = document.createElement("span");
  value.className = "param-val";
  setLevelText(value, valueText);
  // An empty label + value (a bare section ON/OFF toggle whose name is in the
  // section header) skips the label row so the toggle sits flush.
  if (labelText !== "" || valueText !== "") {
    const head = document.createElement("div");
    head.className = "param-label";
    const label = document.createElement("span");
    label.textContent = labelText;
    head.append(label, value);
    row.append(head);
  }
  return { row, value };
}

function formatDb(v: number): string {
  if (v < LEVEL_MIN) return "-∞ dB";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
}

function formatPan(v: number): string {
  if (v === 0) return "C";
  return v < 0 ? `L ${-v}` : `R ${v}`;
}

// Inline warning that the selected node's values were not read from the device
// (shown after a partial readback). Reuses the warning box styling (--warn).
function notReadBadge(text: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "warning";
  const line = document.createElement("div");
  line.className = "warning-line";
  line.textContent = text;
  box.append(line);
  return box;
}

function warningBox(title: string, lines: string[]): HTMLElement {
  const box = document.createElement("div");
  box.className = "warning";
  const head = document.createElement("div");
  head.className = "warning-title";
  head.textContent = title;
  box.append(head);
  for (const l of lines) {
    const line = document.createElement("div");
    line.className = "warning-line";
    line.textContent = l;
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
