import "./style.css";

import { MODEL_IDS, getModel } from "./models";
import type { ModelId } from "./models/types";
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
import { Graph } from "./ui/graph";
import type { Selection, ThemeName } from "./ui/graph";
import { renderInspector } from "./ui/inspector";
import { getLang, LANG_NAMES, onLangChange, setLang, t } from "./i18n";
import { DEMO } from "./core/env";
import {
  checkUpdate,
  confirmDialog,
  installUpdate,
  isTauri,
  restartApp,
  vdConnect,
  vdDisconnect,
} from "./core/platform";
import { applyDeviceState } from "./core/control/readback";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const picker = $<HTMLSelectElement>("model-picker");
const ratePicker = $<HTMLSelectElement>("rate-picker");
const graphHost = $<HTMLElement>("graph-host");
const inspectorHost = $<HTMLElement>("inspector");
const statusbar = $<HTMLElement>("statusbar");

// Initial theme follows a saved choice first, then the OS color scheme, falling
// back to the studio-rack dark default when the OS does not prefer light.
function detectTheme(): ThemeName {
  const saved = localStorage.getItem("urx-theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

let modelId: ModelId = "URX44V";
let plan: Plan = emptyPlan(modelId);
ensureFixedConnections(getModel(modelId), plan);
let dirty = false;
let selection: Selection = null;
let recent: RecentEntry[] = loadRecent();
let theme: ThemeName = detectTheme();
document.documentElement.dataset.theme = theme;

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

const graph = new Graph(graphHost, getModel(modelId), plan, {
  onSelect: (sel) => {
    selection = sel;
    refreshInspector();
  },
  onStatus: (msg) => setStatus(msg),
  onChange: () => {
    dirty = true;
    refreshInspector();
  },
});

const inspectorActions = {
  onDeleteConnection: (from: string, to: string) => graph.deleteConnection(from, to),
  // Mutate params in place without re-rendering, so the slider keeps focus while dragging.
  onUpdateParams: (from: string, to: string, patch: ConnParams) => {
    const conn = plan.connections.find((c) => c.from === from && c.to === to);
    if (!conn) return;
    conn.params = { ...conn.params, ...patch };
    dirty = true;
    // A PRE/POST change flips the wire's pre-fader marker; repaint so it shows on
    // the canvas at once. Level/pan carry no on-canvas marker, so they keep
    // mutating in place and the slider keeps focus.
    if (patch.tap !== undefined) graph.repaintWires();
    // OSC assign L/R are toggle buttons (not focus-holding sliders); re-render so
    // the pressed state updates at once.
    if (patch.oscL !== undefined || patch.oscR !== undefined) refreshInspector();
  },
  onUpdateNodeParams: (id: string, patch: NodeParams) => {
    const prev = plan.nodeParams[id];
    plan.nodeParams[id] = { ...prev, ...patch };
    dirty = true;
    // CH_ON drives the on-canvas mute dimming; repaint nodes so it shows at once.
    if (patch.on !== undefined) graph.repaintNodes();
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
      eqRelayout ||
      compRelayout ||
      oscRelayout
    )
      refreshInspector();
  },
  onOpenRecent: (path: string) => void openRecent(path),
  onHideNode: (id: string) => graph.hideNode(id),
};
graph.setTheme(theme);

const themeBtn = $("btn-theme");
const langBtn = $("btn-lang");

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
  $("btn-auto").textContent = m.toolbar.arrange;
  $("btn-hide-unused").textContent = m.toolbar.hideUnused;
  $("lbl-device").textContent = m.toolbar.device;
  $("btn-fetch").textContent = m.toolbar.fetchDevice;
  $("btn-write").textContent = m.toolbar.writeDevice;
  // Theme button shows the theme it switches to.
  themeBtn.textContent = theme === "dark" ? m.toolbar.light : m.toolbar.dark;
  themeBtn.title = m.toolbar.theme;
  // Language button shows the language it switches to.
  langBtn.textContent = getLang() === "en" ? LANG_NAMES.ja : LANG_NAMES.en;
  langBtn.title = m.toolbar.language;
}
applyStaticI18n();

// The GitHub Pages demo is a viewer only: hide file persistence and image export.
if (DEMO) {
  for (const el of document.querySelectorAll<HTMLElement>("[data-demo-hide]")) {
    el.style.display = "none";
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
  renderInspector(inspectorHost, getModel(modelId), plan, selection, inspectorActions, recent);
}

// Recompute the sample-rate constraints and reflect them in the graph badges and
// the inspector warnings.
function applyRateConstraints(): void {
  const c = rateConstraints(getModel(modelId), plan.sampleRate);
  graph.setDisabledNodes(c.disabledNodes);
  refreshInspector();
}

function loadPlan(next: Plan): void {
  modelId = next.modelId;
  plan = next;
  ensureFixedConnections(getModel(modelId), plan);
  picker.value = modelId;
  ratePicker.value = String(plan.sampleRate);
  selection = null;
  graph.setModel(getModel(modelId), plan);
  dirty = false;
  applyRateConstraints();
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
  loadPlan(emptyPlan(next));
  setStatus(t().status.switchedModel(next));
});

ratePicker.addEventListener("change", () => {
  plan.sampleRate = Number(ratePicker.value);
  dirty = true;
  applyRateConstraints();
  setStatus(t().status.sampleRate(formatRate(plan.sampleRate)));
});

$("btn-new").addEventListener("click", async () => {
  if (!(await confirmDiscard())) return;
  loadPlan(emptyPlan(modelId));
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

// Pull the connected device's current channel levels/pans into the plan. This
// overwrites the matching plan params, so it confirms before discarding edits.
// Desktop only: DEMO is statically true in the browser bundle, so this branch —
// and the control imports it alone references — drops from the demo build.
if (!DEMO) {
  $("btn-fetch").addEventListener("click", async () => {
    if (!(await confirmDiscard())) return;
    setStatus(t().status.fetchConnecting);
    try {
      const device = await vdConnect();
      try {
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
      } finally {
        await vdDisconnect();
      }
    } catch (err) {
      setStatus(t().status.fetchError(err instanceof Error ? err.message : String(err)));
    }
  });
}

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

// Wire the File dropdown: open/close, click-outside, and roving keyboard focus
// across its menu items. The panel is positioned fixed (toolbar clips overflow),
// so its coordinates are derived from the trigger each time it opens.
setupMenu($<HTMLButtonElement>("btn-file"), $<HTMLElement>("file-menu"));
// Device actions (desktop only; the whole menu is hidden in a plain browser).
// "Write to device" ships disabled until live writes land.
setupMenu($<HTMLButtonElement>("btn-device"), $<HTMLElement>("device-menu"));

function setupMenu(trigger: HTMLButtonElement, panel: HTMLElement): void {
  const items = (): HTMLButtonElement[] =>
    Array.from(panel.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])'));
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
  for (const item of items()) item.addEventListener("click", () => setOpen(false));
}

onLangChange(() => {
  applyStaticI18n();
  refreshInspector();
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
