import "./style.css";

import { MODEL_IDS, getModel } from "./models";
import type { ModelId } from "./models/types";
import { deserialize, emptyPlan, ensureFixedConnections, PlanError, serialize } from "./core/plan";
import type { ConnParams, Plan } from "./core/plan";
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
import { checkUpdate, installUpdate, restartApp } from "./core/platform";

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
  $("btn-open").textContent = m.toolbar.open;
  $("btn-save").textContent = m.toolbar.save;
  $("btn-export").textContent = m.toolbar.exportPng;
  $("btn-export-pdf").textContent = m.toolbar.exportPdf;
  $("btn-auto").textContent = m.toolbar.arrange;
  $("btn-hide-unused").textContent = m.toolbar.hideUnused;
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
  if (!confirmDiscard()) return;
  try {
    const text = await readTextByPath(path);
    loadFromText(text, path);
  } catch (err) {
    setStatus(t().status.loadError(String(err)));
  }
}

function confirmDiscard(): boolean {
  if (!dirty) return true;
  return window.confirm(t().confirm.discard);
}

picker.addEventListener("change", () => {
  const next = picker.value as ModelId;
  if (next === modelId) return;
  if (!confirmDiscard()) {
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

$("btn-new").addEventListener("click", () => {
  if (!confirmDiscard()) return;
  loadPlan(emptyPlan(modelId));
  setStatus(t().status.newPlan);
});

$("btn-open").addEventListener("click", async () => {
  if (!confirmDiscard()) return;
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
    if (!window.confirm(t().confirm.update(update.version))) return;
    setStatus(t().status.updateDownloading);
    await installUpdate(update.rid);
    // The new bundle is installed; relaunch into it. Nothing runs past here.
    await restartApp();
  } catch {
    // Best-effort: stay silent when offline or no release is published yet.
  }
}
