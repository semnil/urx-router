import "./style.css";

import { MODEL_IDS, getModel } from "./models";
import { defaultPlan } from "./models/initial-state";
import type { ModelId } from "./models/types";
import { parseRef } from "./models/types";
import { mirrorBalPair } from "./core/routing";
import { deserialize, emptyPlan, ensureFixedConnections, PlanError, serialize } from "./core/plan";
import type { ConnParams, NodeParams, Plan } from "./core/plan";
import { formatRate, rateConstraints, SAMPLE_RATES } from "./core/constraints";
import {
  baseName,
  loadRecent,
  openTextDocument,
  readTextByPath,
  rememberRecent,
  saveTextDocument,
} from "./core/storage";
import type { RecentEntry } from "./core/storage";
import { PAN_BAL_BAL, PAN_BAL_PAN, STEREO_PAN_DEFAULT } from "./core/control/params";
import { Graph } from "./ui/graph";
import type { LabelSource, Selection, ThemeName } from "./ui/graph";
import { renderInspector } from "./ui/inspector";
import { Console } from "./ui/console";
import { getLang, LANG_NAMES, onLangChange, setLang, t } from "./i18n";
import { DEMO } from "./core/env";
import {
  checkUpdate,
  confirmDialog,
  installUpdate,
  isTauri,
  restartApp,
  experimentalEnabled,
  selfTestRequested,
  vdConnect,
  vdDisconnect,
  type DeviceSummary,
} from "./core/platform";
import { applyDeviceState } from "./core/control/readback";
import { diffNames, diffPlan, sendConverging, sendNames } from "./core/control/client";
import { LiveSync } from "./core/control/live";
import { DeviceFollow } from "./core/control/follow";
import { formatSelfTestReport, runSelfTest, summarizeVerdicts } from "./core/control/selftest";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const picker = $<HTMLSelectElement>("model-picker");
const ratePicker = $<HTMLSelectElement>("rate-picker");
const graphHost = $<HTMLElement>("graph-host");
const inspectorHost = $<HTMLElement>("inspector");
const consoleHost = $<HTMLElement>("console-host");
const statusbar = $<HTMLElement>("statusbar");

// Initial theme follows a saved choice first, then the OS color scheme, falling
// back to the studio-rack dark default when the OS does not prefer light.
function detectTheme(): ThemeName {
  const saved = localStorage.getItem("urx-theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

// E2E pins an empty starting board (just the fixed wires) via this flag so
// routing/hide assertions are not perturbed by the factory-seed sends; the seed
// data itself is verified by initial-state.test.ts.
const seedEmpty = (() => {
  try {
    return localStorage.getItem("urx-seed") === "empty";
  } catch {
    return false;
  }
})();
const newPlan = (id: ModelId): Plan => (seedEmpty ? emptyPlan(id) : defaultPlan(id));

// Restore the last selected model on startup, falling back to URX44V (the
// top-of-range model with every feature) when there is no valid saved choice.
function detectModel(): ModelId {
  try {
    const saved = localStorage.getItem("urx-model");
    return MODEL_IDS.includes(saved as ModelId) ? (saved as ModelId) : "URX44V";
  } catch {
    return "URX44V";
  }
}

// Persisting the selection is best-effort: storage may be unavailable (private
// mode / blocked), in which case the model simply does not carry across reloads.
function rememberModel(id: ModelId): void {
  try {
    localStorage.setItem("urx-model", id);
  } catch {
    // ignore
  }
}

// Restore the last selected sample rate, falling back to the new plan's rate when
// there is no valid saved choice. Mirrors the model restore so both carry across
// reloads in the demo and desktop builds alike.
function detectRate(fallback: number): number {
  try {
    const saved = Number(localStorage.getItem("urx-rate"));
    return SAMPLE_RATES.includes(saved) ? saved : fallback;
  } catch {
    return fallback;
  }
}

function rememberRate(rate: number): void {
  try {
    localStorage.setItem("urx-rate", String(rate));
  } catch {
    // ignore
  }
}

let modelId: ModelId = detectModel();
let plan: Plan = newPlan(modelId);
plan.sampleRate = detectRate(plan.sampleRate);
ensureFixedConnections(getModel(modelId), plan);
let dirty = false;
let selection: Selection = null;
let recent: RecentEntry[] = loadRecent();
let theme: ThemeName = detectTheme();
document.documentElement.dataset.theme = theme;

// Canvas label source: the planner's fixed labels (default) or the device CH
// SETTING names. Best-effort persisted (guarded like the model / rate choices).
function detectLabelSource(): LabelSource {
  try {
    return localStorage.getItem("urx-labels") === "device" ? "device" : "model";
  } catch {
    return "model";
  }
}
let labelSource: LabelSource = detectLabelSource();

for (const id of MODEL_IDS) {
  const opt = document.createElement("option");
  opt.value = id;
  opt.textContent = id;
  picker.append(opt);
}
picker.value = modelId;

for (const rate of SAMPLE_RATES) {
  const opt = document.createElement("option");
  opt.value = String(rate);
  opt.textContent = formatRate(rate);
  ratePicker.append(opt);
}
ratePicker.value = String(plan.sampleRate);

// Live sync (experimental): mirror each edit to the connected device. The model
// and plan are read through getters because loadPlan reassigns `plan`. A write
// failure stops sync and drops the connection (deactivateLive). The device label
// shown on the on-air tally is captured when sync turns on. Declared before the
// graph because the graph's onChange callback schedules a live flush. Null in the
// demo build (DEMO folds the ternary to null), so the control layer tree-shakes
// out exactly as the other device features do.
let liveDeviceLabel = "";
const live = DEMO
  ? null
  : new LiveSync({
      getModel: () => getModel(modelId),
      getPlan: () => plan,
      onError: (message) => deactivateLive(t().status.liveError(message)),
      onSent: (n) => setStatus(t().status.liveSynced(n)),
    });

const graph = new Graph(graphHost, getModel(modelId), plan, {
  onSelect: (sel) => {
    selection = sel;
    refreshInspector();
  },
  onStatus: (msg) => setStatus(msg),
  onChange: () => {
    markChanged();
    refreshInspector();
  },
});

// Mixer-style CONSOLE view: an alternate view of the same plan. Its edits go
// through the same change funnel (markChanged) so Live sync mirrors them. The
// live signal meters stream only while Live sync is on (consoleView.setLive).
const consoleView = new Console(consoleHost, {
  getModel: () => getModel(modelId),
  getPlan: () => plan,
  // A console edit changed the plan: flag dirty + schedule live sync. The console
  // re-renders the edited strip itself, so don't rebuild it here (that would
  // disrupt an in-progress fader drag).
  onChange: () => markChanged(),
});

// Device follow (experimental): the reverse of live sync. While live, parameter
// changes made on the device itself (LCD / physical controls) are pulled back
// into the plan via a debounced readback that reuses applyDeviceState, then
// re-rendered. Echoes of our own writes are filtered by the live snapshot. Null
// in the demo / when live is absent, so it tree-shakes out with the rest of the
// control layer.
const follow =
  DEMO || !live
    ? null
    : new DeviceFollow({
        addrs: () => live?.writableAddrs() ?? [],
        isEcho: (p) => live?.isEcho(p.paramId, p.x, p.y, p.value) ?? false,
        // A settled device-side change: pull the whole device into the plan,
        // reflect it without disturbing selection/viewport, and re-base the live
        // snapshot so our own next diff (and the echoes of this read) measure from
        // the device truth.
        reconcile: async () => {
          const result = await applyDeviceState(getModel(modelId), plan);
          if (result.errors.length) console.warn("device-follow readback issues:", result.errors);
          plan.unreadNodes = result.unreadNodes;
          graph.refresh();
          consoleView.refresh();
          refreshInspector();
          live?.resync();
          setStatus(t().status.liveFollowed(result.applied));
        },
        onFollow: () => setStatus(t().status.liveFollowing),
        onError: (message) => deactivateLive(t().status.liveError(message)),
      });

type ViewName = "graph" | "console";

function setView(next: ViewName): void {
  const isConsole = next === "console";
  graphHost.hidden = isConsole;
  inspectorHost.hidden = isConsole;
  $("btn-view-graph").setAttribute("aria-pressed", String(!isConsole));
  $("btn-view-console").setAttribute("aria-pressed", String(isConsole));
  if (isConsole) {
    consoleView.show();
  } else {
    consoleView.hide();
    // Reflect any console edits back onto the graph.
    graph.repaintNodes();
    graph.repaintWires();
  }
}

// Reflect the live-sync state across the toggle, the on-air tally, and the other
// device actions (which conflict with the held connection while sync is on).
// Only ever called in the experimental build path, so re-enabling on `off` is safe.
function setLiveUi(on: boolean): void {
  const liveBtn = document.getElementById("btn-live");
  if (liveBtn) liveBtn.setAttribute("aria-pressed", String(on));
  for (const el of document.querySelectorAll<HTMLElement>("[data-live-only]")) el.hidden = !on;
  const tally = document.getElementById("live-tally");
  if (tally) {
    tally.hidden = !on;
    if (on) tally.textContent = `${t().toolbar.liveTag} · ${liveDeviceLabel}`;
  }
  for (const id of ["btn-fetch", "btn-write", "btn-selftest"]) {
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (el) el.disabled = on;
  }
}

// Turn live sync off and release the connection. Used by the toggle, by a write
// failure, and whenever the plan is replaced wholesale (loadPlan).
function deactivateLive(status?: string): void {
  if (!live?.isActive()) return;
  follow?.end();
  live.end();
  void vdDisconnect();
  setLiveUi(false);
  consoleView.setLive(false);
  // A CH → FX tap shown read-only while live becomes editable again off-line.
  refreshInspector();
  if (status) setStatus(status);
}

// An edit changed the plan: flag it unsaved and (when live) mirror it to the
// device. Every edit funnel routes through here so neither concern is forgotten.
function markChanged(): void {
  dirty = true;
  live?.schedule();
}

// Re-initialize every bus send's pan for a STEREO-linked pair (named by its
// primary id): PAN mode hard-pans the odd channel left and the even one right,
// BAL mode centres both. The pan-carrying sends are exactly the channel's
// `send` connections (STEREO / MIX / FX); the SD Rec assign is a `sendSwitch`.
// No-op when the pair is not linked.
function resetStereoSendPans(primary: string): void {
  const np = plan.nodeParams[primary];
  if (!np?.stereoLink) return;
  const pair = getModel(modelId).channelPairs.find(([a]) => a === primary);
  if (!pair) return;
  const bal = (np.panBal ?? PAN_BAL_PAN) === PAN_BAL_BAL;
  pair.forEach((ch, idx) => {
    const pan = bal ? 0 : idx === 0 ? -STEREO_PAN_DEFAULT : STEREO_PAN_DEFAULT;
    for (const c of plan.connections)
      if (c.from === `${ch}:out` && c.kind === "send") c.params = { ...c.params, pan };
  });
}

const inspectorActions = {
  onDeleteConnection: (from: string, to: string) => graph.deleteConnection(from, to),
  // Mutate params in place without re-rendering, so the slider keeps focus while dragging.
  onUpdateParams: (from: string, to: string, patch: ConnParams) => {
    const conn = plan.connections.find((c) => c.from === from && c.to === to);
    if (!conn) return;
    conn.params = { ...conn.params, ...patch };
    // A STEREO-linked pair in BAL mode moves as one: copy the same send change to
    // the partner channel (pan stays per-channel — see mirrorBalPair).
    const mirrored = mirrorBalPair(getModel(modelId), plan, parseRef(from).nodeId);
    markChanged();
    // A PRE/POST change flips the wire's pre-fader marker; a mirrored ON change
    // alters the partner wire's dimming. Repaint when either is in play. Level/pan
    // carry no on-canvas marker, so they keep mutating in place (slider keeps focus).
    if (patch.tap !== undefined || (mirrored && patch.on !== undefined)) graph.repaintWires();
    // Refresh the console so a mirrored partner keeps up (a no-op while hidden).
    if (mirrored) consoleView.refresh();
    // OSC assign L/R are toggle buttons (not focus-holding sliders); re-render so
    // the pressed state updates at once.
    if (patch.oscL !== undefined || patch.oscR !== undefined) refreshInspector();
  },
  onUpdateNodeParams: (id: string, patch: NodeParams) => {
    const prev = plan.nodeParams[id];
    plan.nodeParams[id] = { ...prev, ...patch };
    // A STEREO-linked pair in BAL mode moves as one: copy this channel's params to
    // the partner (the pair-level Signal Type / PAN-BAL fields stay on the primary).
    const mirrored = mirrorBalPair(getModel(modelId), plan, id);
    markChanged();
    // CH_ON drives the on-canvas mute dimming; the STEREO link draws a pair
    // connector — both show on the canvas, so repaint nodes at once. A mirrored ON
    // change repaints every node, so the partner's dimming follows for free.
    // Linking a pair snaps its partner next to the kept node so the tie isn't drawn
    // across a gap an earlier manual move may have opened.
    if (patch.stereoLink === true) graph.alignStereoPair(id);
    if (patch.on !== undefined || patch.stereoLink !== undefined) graph.repaintNodes();
    if (mirrored) consoleView.refresh();
    // Toggling PAN/BAL (or entering STEREO) re-initializes every bus send's pan
    // for the linked pair: PAN hard-pans odd/even L/R, BAL centres them.
    if (patch.panBal !== undefined || patch.stereoLink === true) resetStereoSendPans(id);
    // An EQ band's filter type / ON changes which controls show (Q, gain), so it
    // needs a re-render; a freq/Q/gain slick must NOT re-render (it keeps slider
    // focus). Detect a relayout by diffing the changed bands' type/on.
    const eqRelayout =
      patch.eqBands !== undefined &&
      patch.eqBands.some((b, i) => b?.type !== prev?.eqBands?.[i]?.type || b?.on !== prev?.eqBands?.[i]?.on);
    // COMP 1-knob / Auto Makeup toggles hide or show the individual comp controls,
    // so they need a re-render; the comp value sliders must not (they keep focus).
    const compRelayout =
      patch.comp !== undefined &&
      (patch.comp.oneKnob !== prev?.comp?.oneKnob || patch.comp.autoMakeup !== prev?.comp?.autoMakeup);
    // OSC on / mode toggles re-render (mode shows or hides the frequency control);
    // the level / frequency sliders must not (they keep focus while dragging).
    const oscRelayout =
      patch.osc !== undefined &&
      (patch.osc.on !== prev?.osc?.on || patch.osc.mode !== prev?.osc?.mode);
    // SSMCS on / side-chain on / EQ band on are two-button toggles whose active
    // state only refreshes on re-render; the morphing-strip value sliders must not
    // re-render (they keep focus). Selects (Sweet Spot Data / Knee) self-update.
    const ssmcsRelayout =
      patch.ssmcs !== undefined &&
      (patch.ssmcs.on !== prev?.ssmcs?.on ||
        patch.ssmcs.sc?.on !== prev?.ssmcs?.sc?.on ||
        patch.ssmcs.eq?.low?.on !== prev?.ssmcs?.eq?.low?.on ||
        patch.ssmcs.eq?.mid?.on !== prev?.ssmcs?.eq?.mid?.on ||
        patch.ssmcs.eq?.high?.on !== prev?.ssmcs?.eq?.high?.on);
    // EQ 1-knob ON toggles between the 1-knob controls and the band tabs, so it
    // re-renders; the type select self-updates and the level slider keeps focus.
    const eqOneKnobRelayout =
      patch.eqOneKnob !== undefined && patch.eqOneKnob.on !== prev?.eqOneKnob?.on;
    // Toggles re-render to update the active button; sliders (gain/level) mutate
    // in place so they keep focus while dragging.
    if (
      patch.on !== undefined ||
      patch.hpf !== undefined ||
      patch.phantom !== undefined ||
      patch.phase !== undefined ||
      patch.phaseL !== undefined ||
      patch.phaseR !== undefined ||
      patch.clipSafe !== undefined ||
      patch.hiZ !== undefined ||
      patch.insertFx !== undefined ||
      patch.compEqType !== undefined ||
      patch.eqOn !== undefined ||
      patch.gateOn !== undefined ||
      patch.compOn !== undefined ||
      patch.duckerOn !== undefined ||
      patch.cueInterrupt !== undefined ||
      patch.mono !== undefined ||
      patch.busType !== undefined ||
      patch.panLink !== undefined ||
      patch.stereoLink !== undefined ||
      patch.panBal !== undefined ||
      eqRelayout ||
      compRelayout ||
      oscRelayout ||
      ssmcsRelayout ||
      eqOneKnobRelayout
    )
      refreshInspector();
  },
  // Rename mutates in place and repaints the node label without re-rendering the
  // inspector, so the text input keeps focus while typing. Empty clears the override.
  onRenameNode: (id: string, name: string) => {
    if (name.trim()) plan.nodeNames[id] = name;
    else delete plan.nodeNames[id];
    markChanged();
    graph.repaintNodes();
  },
  // Recolor repaints the node cap and re-renders the inspector so the active
  // swatch ring updates. null clears the override.
  onRecolorNode: (id: string, color: string | null) => {
    if (color) plan.nodeColors[id] = color;
    else delete plan.nodeColors[id];
    markChanged();
    graph.repaintNodes();
    refreshInspector();
  },
  onOpenRecent: (path: string) => void openRecent(path),
  onHideNode: (id: string) => graph.hideNode(id),
  onClose: () => graph.clearSelection(),
};
graph.setTheme(theme);
graph.setLabelSource(labelSource);
try {
  if (localStorage.getItem("urx-hide-off") === "1") graph.setHideOffSends(true);
} catch {
  // ignore (storage may be unavailable)
}

const themeBtn = $("btn-theme");
const langBtn = $("btn-lang");
const labelsBtn = $("btn-labels");
const hideOffBtn = $("btn-hide-off");

function applyStaticI18n(): void {
  const m = t();
  $("lbl-model").textContent = m.toolbar.model;
  $("lbl-rate").textContent = m.toolbar.rate;
  $("btn-new").textContent = m.toolbar.new;
  $("lbl-file").textContent = m.toolbar.file;
  $("btn-open").textContent = m.toolbar.open;
  $("btn-save").textContent = m.toolbar.save;
  $("btn-export").textContent = m.toolbar.exportPng;
  $("btn-export-pdf").textContent = m.toolbar.exportPdf;
  const viewGraphBtn = $("btn-view-graph");
  viewGraphBtn.textContent = m.toolbar.viewGraph;
  viewGraphBtn.title = m.toolbar.viewGraphHint;
  const viewConsoleBtn = $("btn-view-console");
  viewConsoleBtn.textContent = m.toolbar.viewConsole;
  viewConsoleBtn.title = m.toolbar.viewConsoleHint;
  $("btn-auto").textContent = m.toolbar.arrange;
  $("btn-hide-unused").textContent = m.toolbar.hideUnused;
  $("lbl-device").textContent = m.toolbar.device;
  $("btn-fetch").textContent = m.toolbar.fetchDevice;
  $("btn-write").textContent = m.toolbar.writeDevice;
  $("btn-selftest").textContent = m.toolbar.selfTest;
  // Live-sync toggle keeps a static label; aria-pressed and the on-air tally
  // carry the on/off state. Refresh the tally text too (the device label is set
  // when sync turns on; only the "LIVE" tag is localized).
  const liveBtn = document.getElementById("btn-live");
  if (liveBtn) {
    liveBtn.textContent = m.toolbar.liveSync;
    liveBtn.title = m.toolbar.liveSyncHint;
  }
  const liveTally = document.getElementById("live-tally");
  if (liveTally && live?.isActive()) liveTally.textContent = `${m.toolbar.liveTag} · ${liveDeviceLabel}`;
  // Theme button shows the theme it switches to.
  themeBtn.textContent = theme === "dark" ? m.toolbar.light : m.toolbar.dark;
  themeBtn.title = m.toolbar.theme;
  // Language button shows the language it switches to.
  langBtn.textContent = getLang() === "en" ? LANG_NAMES.ja : LANG_NAMES.en;
  langBtn.title = m.toolbar.language;
  // Labels toggle shows the source the canvas is currently using.
  labelsBtn.textContent = labelSource === "device" ? m.toolbar.labelsDevice : m.toolbar.labelsModel;
  labelsBtn.title = m.toolbar.labelsHint;
  labelsBtn.setAttribute("aria-pressed", String(labelSource === "device"));
  // Off-sends toggle: the label names the action it will perform next.
  const hideOff = graph.isHideOffSends();
  hideOffBtn.textContent = hideOff ? m.toolbar.showOffSends : m.toolbar.hideOffSends;
  hideOffBtn.title = m.toolbar.hideOffSendsHint;
  hideOffBtn.setAttribute("aria-pressed", String(hideOff));
  // Demo-only desktop-app link (present in the DOM, shown only in the demo build).
  const desktopLbl = document.getElementById("lbl-desktop");
  const desktopLink = document.getElementById("btn-desktop");
  if (desktopLbl) desktopLbl.textContent = m.toolbar.desktopApp;
  if (desktopLink) desktopLink.title = m.toolbar.desktopAppHint;
}
applyStaticI18n();

// The GitHub Pages demo is a viewer only: hide file persistence and image export.
if (DEMO) {
  for (const el of document.querySelectorAll<HTMLElement>("[data-demo-hide]")) {
    el.style.display = "none";
  }
  // The demo is a viewer; surface a link to the desktop app (full file IO,
  // image export, and live device control) so visitors can find it.
  for (const el of document.querySelectorAll<HTMLElement>("[data-demo-only]")) {
    el.hidden = false;
  }
}

// Live hardware control needs the Tauri shell (the Rust vd commands); hide its
// controls in a plain browser and the demo, where they could only fail.
if (!isTauri()) {
  for (const el of document.querySelectorAll<HTMLElement>("[data-control-hide]")) {
    el.style.display = "none";
  }
}

function setStatus(msg: string): void {
  statusbar.textContent = msg;
}

function refreshInspector(): void {
  // On mobile the inspector is a bottom sheet that slides up only while something
  // is selected; this flag drives that state (no effect on the desktop panel).
  document.body.classList.toggle("has-selection", selection !== null);
  renderInspector(inspectorHost, getModel(modelId), plan, selection, inspectorActions, recent, live?.isActive() ?? false);
}

// Recompute the sample-rate constraints and reflect them in the graph badges and
// the inspector warnings.
function applyRateConstraints(): void {
  const c = rateConstraints(getModel(modelId), plan.sampleRate);
  graph.setDisabledNodes(c.disabledNodes);
  refreshInspector();
}

function loadPlan(next: Plan): void {
  // Replacing the whole plan invalidates the live snapshot; leave sync first.
  // (Live's own enable path calls loadPlan before begin(), so this is a no-op there.)
  deactivateLive();
  modelId = next.modelId;
  rememberModel(modelId);
  plan = next;
  rememberRate(plan.sampleRate);
  ensureFixedConnections(getModel(modelId), plan);
  picker.value = modelId;
  ratePicker.value = String(plan.sampleRate);
  selection = null;
  graph.setModel(getModel(modelId), plan);
  dirty = false;
  applyRateConstraints();
  consoleView.refresh();
}

// Parse text into a plan, load it, and (when it came from a real path) record it
// as a recent plan. Returns true on success; on failure sets the error status.
function loadFromText(text: string, path?: string): boolean {
  try {
    const next = deserialize(text);
    if (!MODEL_IDS.includes(next.modelId)) {
      setStatus(t().status.loadError(t().error.unknownModel(next.modelId)));
      return false;
    }
    loadPlan(next);
    if (path) {
      recent = rememberRecent({ path, name: baseName(path), modelId });
      refreshInspector();
      setStatus(t().status.openedFrom(baseName(path)));
    } else {
      setStatus(t().status.planLoaded);
    }
    return true;
  } catch (err) {
    const message = err instanceof PlanError ? t().error[err.code] : String(err);
    setStatus(t().status.loadError(message));
    return false;
  }
}

async function openRecent(path: string): Promise<void> {
  if (!(await confirmDiscard())) return;
  try {
    const text = await readTextByPath(path);
    loadFromText(text, path);
  } catch (err) {
    setStatus(t().status.loadError(String(err)));
  }
}

async function confirmDiscard(): Promise<boolean> {
  if (!dirty) return true;
  return confirmDialog(t().confirm.discard);
}

picker.addEventListener("change", async () => {
  const next = picker.value as ModelId;
  if (next === modelId) return;
  if (!(await confirmDiscard())) {
    picker.value = modelId;
    return;
  }
  loadPlan(newPlan(next));
  setStatus(t().status.switchedModel(next));
});

ratePicker.addEventListener("change", () => {
  plan.sampleRate = Number(ratePicker.value);
  rememberRate(plan.sampleRate);
  dirty = true;
  applyRateConstraints();
  setStatus(t().status.sampleRate(formatRate(plan.sampleRate)));
});

$("btn-new").addEventListener("click", async () => {
  if (!(await confirmDiscard())) return;
  loadPlan(newPlan(modelId));
  setStatus(t().status.newPlan);
});

$("btn-open").addEventListener("click", async () => {
  if (!(await confirmDiscard())) return;
  try {
    const doc = await openTextDocument({ ext: "json", label: t().filter.plan });
    if (!doc) return;
    loadFromText(doc.text, doc.path);
  } catch (err) {
    setStatus(t().status.loadError(String(err)));
  }
});

$("btn-save").addEventListener("click", async () => {
  const res = await saveTextDocument(`${modelId}-plan.json`, serialize(plan), {
    ext: "json",
    label: t().filter.plan,
  });
  if (!res.saved) {
    setStatus(t().status.canceled);
    return;
  }
  dirty = false;
  if (res.path) {
    recent = rememberRecent({ path: res.path, name: baseName(res.path), modelId });
    refreshInspector();
    setStatus(t().status.savedTo(baseName(res.path)));
  } else {
    setStatus(t().status.planSaved);
  }
});

$("btn-export").addEventListener("click", () => {
  graph.exportPng(`${modelId}-routing.png`);
});

$("btn-export-pdf").addEventListener("click", () => {
  graph.exportPdf(`${modelId}-routing.pdf`);
});

$("btn-auto").addEventListener("click", () => {
  graph.autoLayout();
});

$("btn-hide-unused").addEventListener("click", () => {
  graph.hideUnused();
});

// Turn a connect-time failure into a clear, localized status. The Rust vd worker
// (vd.rs) returns stable codes for the two states the user can act on — Device
// Center not running, or running with no URX attached — so they get a plain
// message instead of the raw error wrapped in "<action> failed: …". Anything else
// (an action failure mid-flow, an unexpected error) falls back to onError.
function connectFailureStatus(err: unknown, onError: (message: string) => string): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message === "broker-unreachable") return t().error.brokerUnreachable;
  if (message === "no-device") return t().error.noDevice;
  return onError(message);
}

// Connect, run an action with the connected device, then always disconnect. The
// connect doubles as a pre-check: callers that would discard work put their
// confirm inside `action`, so a no-device state surfaces a clear message without
// first prompting. Connection and action errors surface through connectFailureStatus
// (clear text for the actionable connect states, else the given formatter).
async function withDevice(
  connecting: string,
  onError: (message: string) => string,
  action: (device: DeviceSummary) => Promise<void>,
): Promise<void> {
  setStatus(connecting);
  try {
    const device = await vdConnect();
    try {
      await action(device);
    } finally {
      await vdDisconnect();
    }
  } catch (err) {
    setStatus(connectFailureStatus(err, onError));
  }
}

// Pull the connected device's current channel levels/pans into the plan. This
// overwrites the matching plan params, so it confirms before discarding edits —
// but only after connecting, so a no-device state is reported without first
// prompting to discard. Desktop only: DEMO is statically true in the browser
// bundle, so this branch — and the control imports it alone references — drops
// from the demo build.
if (!DEMO) {
  $("btn-fetch").addEventListener("click", () =>
    withDevice(t().status.fetchConnecting, t().status.fetchError, async (device) => {
      if (!(await confirmDiscard())) {
        setStatus(t().status.canceled);
        return;
      }
      // The connected device may be a different model than the one selected.
      // Offer to switch the UI to the device's model (a fresh plan) so the
      // fetched values map onto the right channels; otherwise abort.
      if (device.model !== modelId) {
        if (!MODEL_IDS.includes(device.model as ModelId)) {
          setStatus(t().status.fetchError(t().error.unknownModel(device.model)));
          return;
        }
        if (!(await confirmDialog(t().confirm.switchModel(device.model, modelId)))) {
          setStatus(t().status.canceled);
          return;
        }
        loadPlan(emptyPlan(device.model as ModelId));
      }
      const result = await applyDeviceState(getModel(modelId), plan);
      if (result.errors.length) console.warn("device readback issues:", result.errors);
      // Per-node provenance: nodes whose body read failed still show their plan
      // default, so the graph/inspector flag them as not read from the device.
      plan.unreadNodes = result.unreadNodes;
      graph.setModel(getModel(modelId), plan);
      selection = null;
      refreshInspector();
      dirty = true;
      // Nodes the readback tried but could not confirm (left at their plan default).
      const unread = result.unreadNodes.size;
      setStatus(
        result.errors.length
          ? t().status.fetchPartial(result.applied, result.errors.length, unread)
          : unread
            ? t().status.fetchedUnread(device.model, result.applied, unread)
            : t().status.fetchedDevice(device.model, result.applied),
      );
    }),
  );

  // Write the plan to the connected device: diff the plan against the device's
  // current values, confirm the change count, then send only what differs.
  // Writing to a device of a different model is refused (the plan's channels
  // would map onto the wrong hardware). Live write is experimental: the menu
  // item stays disabled (index.html) unless the app was launched with
  // --experimental, so it is only enabled and wired on that explicit opt-in.
  experimentalEnabled().then((enabled) => {
    if (!enabled) return;
    const writeBtn = $<HTMLButtonElement>("btn-write");
    writeBtn.disabled = false;
    writeBtn.addEventListener("click", () =>
      withDevice(t().status.writeConnecting, t().status.writeError, async (device) => {
        if (device.model !== modelId) {
          setStatus(t().status.writeError(t().error.modelMismatch(device.model, modelId)));
          return;
        }
        const { diffs, errors } = await diffPlan(getModel(modelId), plan);
        if (errors.length) console.warn("device diff issues:", errors);
        // CH SETTING names are string params outside the numeric diff; diff them
        // separately so a name-only change still counts and writes.
        const { writes: nameWrites, errors: nameErrors } = await diffNames(getModel(modelId), plan);
        if (nameErrors.length) console.warn("device name diff issues:", nameErrors);
        const total = diffs.length + nameWrites.length;
        if (total === 0) {
          setStatus(t().status.writeNoChanges);
          return;
        }
        if (!(await confirmDialog(t().confirm.write(total)))) {
          setStatus(t().status.canceled);
          return;
        }
        const { outcomes, residual } = await sendConverging(getModel(modelId), plan, diffs);
        const nameOutcomes = await sendNames(nameWrites);
        const failed = [...outcomes, ...nameOutcomes].filter((o) => !o.ok);
        if (failed.length) console.warn("device write failures:", failed);
        if (residual.length) console.warn("device write did not converge:", residual);
        setStatus(
          failed.length
            ? t().status.writePartial(total - failed.length, failed.length)
            : residual.length
              ? t().status.writeResidual(residual.length)
              : t().status.written(total),
        );
      }),
    );

    // Device self-test (experimental): read the device, write a perturbed copy,
    // verify it matches, then restore. It owns its own connection, so it does not
    // go through withDevice. Reports are console.warn'd (not log) so they reach
    // the dev-server log for a headless read.
    async function runDeviceSelfTest(): Promise<void> {
      setStatus(t().status.selfTestRunning);
      try {
        const report = await runSelfTest(getModel(modelId));
        console.warn(`[self-test] ${report.ok ? "PASS" : "FAIL"}`, JSON.stringify(report));
        if (report.errors.length) console.warn("[self-test] issues:", JSON.stringify(report.errors));
        if (report.residual.length) console.warn("[self-test] mismatches:", JSON.stringify(report.residual));
        const verdicts = summarizeVerdicts(report.unverified);
        setStatus(
          !report.restored
            ? t().status.selfTestRestoreFail
            : report.unverified.length
              ? t().status.selfTestUnverified(verdicts.confirmed, verdicts.refuted, verdicts.untestable)
              : report.ok
                ? t().status.selfTestPass(report.written)
                : t().status.selfTestFail(report.residual.length),
        );
        // Confirmation workflow: when the model has unverified guesses (URX22/44),
        // offer to save the human-readable report so the owner can send it back.
        if (report.unverified.length && (await confirmDialog(t().confirm.selfTestExport))) {
          await saveTextDocument(`${modelId}-self-test.md`, formatSelfTestReport(report), {
            ext: "md",
            label: t().filter.report,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[self-test] ERROR", message);
        setStatus(connectFailureStatus(err, t().status.selfTestError));
      }
    }

    const selfTestBtn = $<HTMLButtonElement>("btn-selftest");
    selfTestBtn.hidden = false;
    // Destructive-then-restored, so the menu action confirms first.
    selfTestBtn.addEventListener("click", async () => {
      if (await confirmDialog(t().confirm.selfTest)) await runDeviceSelfTest();
    });
    // Headless trigger: when launched with --self-test, run it once on startup
    // (no dialog), so it can be driven from the command line without the UI.
    void selfTestRequested().then((auto) => {
      if (auto) void runDeviceSelfTest();
    });

    // Live sync (experimental): connect, read the whole device once (overwriting
    // edits, hence the discard confirm), then mirror each later edit as it
    // happens. The connection is held open for the session and released when the
    // toggle, a write failure, or a plan replacement turns sync off.
    async function activateLive(): Promise<void> {
      if (!live) return;
      // Connect first (the pre-check): a no-device state is reported plainly,
      // without discarding the user's edits. Only on a live device do we confirm
      // the discard, since live sync overwrites the plan with the device state.
      setStatus(t().status.liveConnecting);
      let device: DeviceSummary;
      try {
        device = await vdConnect();
      } catch (err) {
        setStatus(connectFailureStatus(err, t().status.liveError));
        return;
      }
      // Past the connect: any exit must release the held connection first.
      const abort = async (status: string): Promise<void> => {
        await vdDisconnect();
        setStatus(status);
      };
      if (!(await confirmDiscard())) return await abort(t().status.canceled);
      try {
        // A device of a different model maps onto the wrong channels; offer to
        // switch the UI to a fresh plan of the device's model (mirrors fetch).
        if (device.model !== modelId) {
          if (!MODEL_IDS.includes(device.model as ModelId)) {
            return await abort(t().status.liveError(t().error.unknownModel(device.model)));
          }
          if (!(await confirmDialog(t().confirm.switchModel(device.model, modelId)))) {
            return await abort(t().status.canceled);
          }
          loadPlan(emptyPlan(device.model as ModelId));
        }
        const result = await applyDeviceState(getModel(modelId), plan);
        if (result.errors.length) console.warn("live readback issues:", result.errors);
        plan.unreadNodes = result.unreadNodes;
        graph.setModel(getModel(modelId), plan);
        selection = null;
        refreshInspector();
        dirty = false;
        liveDeviceLabel = device.model;
        live.begin();
        follow?.begin();
        setLiveUi(true);
        consoleView.setLive(true);
        setStatus(t().status.liveOn(device.model, result.applied));
      } catch (err) {
        await abort(t().status.liveError(err instanceof Error ? err.message : String(err)));
      }
    }

    const liveBtn = $<HTMLButtonElement>("btn-live");
    liveBtn.hidden = false;
    liveBtn.addEventListener("click", () => {
      if (live?.isActive()) deactivateLive(t().status.liveOff);
      else void activateLive();
    });
  });
}

$("btn-view-graph").addEventListener("click", () => setView("graph"));
$("btn-view-console").addEventListener("click", () => setView("console"));

themeBtn.addEventListener("click", () => {
  theme = theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("urx-theme", theme);
  graph.setTheme(theme);
  applyStaticI18n();
  setStatus(theme === "dark" ? t().status.themeDark : t().status.themeLight);
});

langBtn.addEventListener("click", () => {
  setLang(getLang() === "en" ? "ja" : "en");
});

labelsBtn.addEventListener("click", () => {
  labelSource = labelSource === "device" ? "model" : "device";
  try {
    localStorage.setItem("urx-labels", labelSource);
  } catch {
    // ignore (storage may be unavailable)
  }
  graph.setLabelSource(labelSource);
  applyStaticI18n();
  setStatus(labelSource === "device" ? t().toolbar.labelsDevice : t().toolbar.labelsModel);
});

hideOffBtn.addEventListener("click", () => {
  const next = !graph.isHideOffSends();
  graph.setHideOffSends(next);
  try {
    localStorage.setItem("urx-hide-off", next ? "1" : "0");
  } catch {
    // ignore (storage may be unavailable)
  }
  applyStaticI18n();
  setStatus(next ? t().toolbar.hideOffSends : t().toolbar.showOffSends);
});

// Wire the File dropdown: open/close, click-outside, and roving keyboard focus
// across its menu items. The panel is positioned fixed (toolbar clips overflow),
// so its coordinates are derived from the trigger each time it opens.
setupMenu($<HTMLButtonElement>("btn-file"), $<HTMLElement>("file-menu"));
// Device actions (desktop only; the whole menu is hidden in a plain browser).
setupMenu($<HTMLButtonElement>("btn-device"), $<HTMLElement>("device-menu"));

function setupMenu(trigger: HTMLButtonElement, panel: HTMLElement): void {
  const items = (): HTMLButtonElement[] =>
    Array.from(panel.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled]):not([hidden])'));
  let open = false;

  function setOpen(next: boolean, focusFirst = false): void {
    if (next === open) {
      if (next && focusFirst) items()[0]?.focus();
      return;
    }
    open = next;
    trigger.setAttribute("aria-expanded", String(next));
    panel.hidden = !next;
    if (next) {
      const r = trigger.getBoundingClientRect();
      panel.style.top = `${Math.round(r.bottom + 8)}px`;
      panel.style.right = `${Math.round(window.innerWidth - r.right)}px`;
      if (focusFirst) items()[0]?.focus();
      document.addEventListener("pointerdown", onOutside, true);
      document.addEventListener("keydown", onKey, true);
    } else {
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("keydown", onKey, true);
    }
  }

  function onOutside(e: PointerEvent): void {
    const target = e.target as Node;
    if (!panel.contains(target) && !trigger.contains(target)) setOpen(false);
  }

  function onKey(e: KeyboardEvent): void {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      setOpen(false);
      trigger.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      list[list.length - 1]?.focus();
    }
  }

  trigger.addEventListener("click", () => setOpen(!open, true));
  trigger.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true, true);
    }
  });
  // Each item runs its own action listener; close the menu once one is chosen.
  // Delegated to the panel so items enabled after setup (the experimental device
  // actions, disabled at this point) are covered too. An item's async action
  // yields at its first await, so this runs and hides the menu before any
  // confirm dialog renders.
  panel.addEventListener("click", (e) => {
    if ((e.target as Element).closest('[role="menuitem"]')) setOpen(false);
  });
}

onLangChange(() => {
  applyStaticI18n();
  refreshInspector();
  consoleView.refresh();
  setStatus(t().status.language(LANG_NAMES[getLang()]));
});

window.addEventListener("keydown", (e) => {
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes((e.target as Element)?.tagName);
  if (typing) return;
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    graph.deleteSelection();
  } else if (e.key === "Escape") {
    graph.clearSelection();
  }
});

applyRateConstraints();
setStatus(t().status.loaded(modelId));

// Desktop only: quietly check for a newer release at startup and offer to install
// it. DEMO is statically false in the desktop build, so the browser demo bundle
// drops this branch (and the updater imports) entirely.
if (!DEMO) {
  void checkForUpdates();
}

async function checkForUpdates(): Promise<void> {
  try {
    const update = await checkUpdate();
    if (!update) return;
    if (!(await confirmDialog(t().confirm.update(update.version)))) return;
    setStatus(t().status.updateDownloading);
    await installUpdate(update.rid);
    // The new bundle is installed; relaunch into it. Nothing runs past here.
    await restartApp();
  } catch {
    // Best-effort: stay silent when offline or no release is published yet.
  }
}
