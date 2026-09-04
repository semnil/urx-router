import "./style.css";

import { MODEL_IDS, getModel } from "./models";
import { defaultPlan } from "./models/initial-state";
import type { ModelId } from "./models/types";
import { parseRef } from "./models/types";
import {
  applyPairTransition,
  INSERT_FX_PAIR_KEYS,
  mirrorBalPair,
  mirrorLinkedInsertFx,
  mixSendLocks,
  partnerChannel,
} from "./core/routing";
import {
  decodePlanParam,
  deserializeDocument,
  emptyPlan,
  encodePlanParam,
  ensureFixedConnections,
  normalizeNodeName,
  PlanError,
  SDREC_NODE_ID,
  serialize,
  setPlanSampleRate,
  SSMCS_INITIAL,
} from "./core/plan";
import { applySceneExternal, captureSceneExternal } from "./core/scene-scope";
import { getSettings } from "./core/settings";
import type { ConnParams, NodeParams, Plan, SerializeOptions } from "./core/plan";
import {
  clonePlanState,
  diffPlans,
  nodeParamContestPath,
  PlanWriteWitness,
  type PatchTouch,
} from "./core/plan-history";
import { formatRate, rateConstraints, SAMPLE_RATES, trackCountDrop } from "./core/constraints";
import { applyParamRange, isRefusal, needsDecision, planProblems } from "./core/plan-validate";
import type { LoadProblem } from "./core/plan-validate";
import {
  baseName,
  downloadText,
  loadRecent,
  openBinaryDocument,
  openTextDocument,
  readTextByPath,
  rememberRecent,
  removeRecent,
  saveTextDocument,
} from "./core/storage";
import type { RecentEntry } from "./core/storage";
import {
  COMP_EQ_SSMCS,
  INSERT_FX_ANNOUNCED,
  PARAMS,
  REC_POINT_PRE_COMP,
  REC_POINT_PRE_EQ,
} from "./core/control/params";
import { Graph } from "./ui/graph";
import type { LabelSource, Selection, ThemeName } from "./ui/graph";
import { compositionGate, inspectorNodes, renderInspector } from "./ui/inspector";
import { copyText, focusables, preserveFocus } from "./ui/dom";
import { ownsNativeUndo } from "./ui/keys";
import { Console } from "./ui/console";
import { MidiControl } from "./ui/midi";
import { showConsent } from "./ui/consent";
import { initDropzone } from "./ui/dropzone";
import { initFineMode } from "./ui/fine";
import { installEditMenu } from "./ui/edit-menu";
import { PlanHistory } from "./ui/history";
import { installKeyProbe } from "./ui/keyprobe";
import { showLoadReport } from "./ui/load-report";
import { showLicenses } from "./ui/licenses";
import { PrefsPanel } from "./ui/prefs";
import { DynScreen } from "./ui/dyn-screen";
import type { MidiLearnHooks } from "./ui/midi-learn";
import { DYN_PROCESSORS } from "./ui/dyn-registry";
import type { DynKind } from "./ui/dyn-registry";
import type { ThemeMode, UpdateCheckOutcome } from "./ui/prefs";
import { FileFlowLatch, singleFlight } from "./app/flow-latch";
import { nodeParamEffects } from "./app/node-param-effects";
import {
  detectHideOffSends,
  detectLabelSource,
  detectModel,
  detectRate,
  detectThemeMode,
  detectView,
  loadHidden,
  rememberHideOffSends,
  rememberHidden,
  rememberLabelSource,
  rememberModel,
  rememberRate,
  rememberThemeMode,
  resetStorageFromUrl,
  rememberView,
  resolveTheme,
  seedEmptyRequested,
} from "./app/view-state";
import type { ViewName } from "./app/view-state";
import { errorCode, errorText, getLang, LANG_NAMES, onLangChange, t } from "./i18n";
import { DEMO, TRACE } from "./core/env";
import { installTraceProbe } from "./ui/trace-probe";
import type { WriteSource } from "./ui/trace-probe";
import {
  checkUpdate,
  confirmDialog,
  errorDialog,
  exitApp,
  installUpdate,
  isTauri,
  restartApp,
  experimentalEnabled,
  selfTestRequested,
  prepareModifiedRequested,
  resetStorageRequested,
  setKeepAwake,
  thirdPartyLicenses,
  vdConnect,
  vdDisconnect,
  vdWatchLink,
  type Connection,
  type DeviceSummary,
} from "./core/platform";
import {
  applyDeviceState,
  applyDirect,
  applyNodeState,
  applySourceState,
  formatReadbackReport,
  insertFxHoldKeys,
  readIntoPlan,
} from "./core/control/readback";
import type { MergedRead, ReadbackResult } from "./core/control/readback";
import type { PendingWrites } from "./core/control/settle";
import { parseUrxf, paramSourceOf, UrxfError } from "./core/control/urxf";
import {
  compareCounts,
  compareNames,
  comparePlan,
  diffNames,
  diffPlan,
  dryRun,
  formatCompareReport,
  formatWriteReport,
  FOLLOW_USB_ADDR,
  reachedAndFailed,
  rateAction,
  readClockState,
  readFollowUsb,
  readTrackCount,
  confirmedAddrs,
  sendConverging,
  sendNames,
  setFollowUsb,
  type CommandDiff,
} from "./core/control/client";
import { askRateChoice } from "./ui/rate-choice";
import { collisionOwners } from "./core/control/translate";
import { confirmedAdoptions } from "./app/adopt-writes";
import type { SharedOwners } from "./core/control/translate";
import { LiveSync } from "./core/control/live";
import { DeviceFollow } from "./core/control/follow";
import { version } from "../package.json";
import { LinkLedgerTracker } from "./core/control/link-stats";
import type { LinkSessionEnd } from "./core/control/link-stats";
import { LinkStatsView } from "./ui/link-stats";
import { firmwareMismatch, SUPPORTED_SYSTEM_FIRMWARE } from "./core/control/firmware";
import { formatSelfTestReport, runSelfTest, summarizeVerdicts } from "./core/control/selftest";
import { runPrepareModified } from "./core/control/prepare";
import { DeviceSetupPanel } from "./ui/device-setup";
import { readDeviceSetup, sendDeviceSetup } from "./core/control/device-setup";
import type { DeviceSetup } from "./core/control/device-setup";

// Clear persisted UI state (theme / model / meter points / consent gate / recent
// files / inspector sections / user preferences) when the browser dev app is opened with ?reset (or
// #reset) — done synchronously here, before anything below reads localStorage, and
// the flag is stripped so a later manual reload doesn't clear again. The desktop
// app uses the --reset-storage launch flag instead (handled async in boot()).
resetStorageFromUrl();

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const picker = $<HTMLSelectElement>("model-picker");
const ratePicker = $<HTMLSelectElement>("rate-picker");
const followUsbBadge = $<HTMLButtonElement>("follow-usb");
const graphHost = $<HTMLElement>("graph-host");
const inspectorHost = $<HTMLElement>("inspector");
const consoleHost = $<HTMLElement>("console-host");
const statusbar = $<HTMLElement>("statusbar");

// The device's SETUP > Follow USB state, as far as this session has seen it. Null
// until the app has actually read a device, and back to null when a read fails —
// an unknown state is drawn as no badge at all rather than as "off", since "off" is
// the state in which the rate picker is trusted to stick.
//
// Session-scoped on purpose: unlike the model and the rate, this is not a choice the
// operator makes in the app and carries between sessions. It is the device's own
// clock policy, so a remembered value would be a claim about hardware that may not
// even be attached.
let followUsbState: boolean | null = null;

// Paint the badge from the state above. Separate from the setter so the language
// switch can re-label it without pretending to change the state (applyStaticI18n).
//
// Three states, not two. Unknown is drawn as its own thing (dimmed, aria-pressed
// "mixed") rather than hidden: the badge exists to warn that the rate picker will
// not stick, and hiding it until a device action meant the warning only ever
// arrived after the operator had already committed to one. It must still never be
// drawn as "off", which is the state in which the picker IS trusted.
function renderFollowUsbBadge(): void {
  const m = t().toolbar;
  const state = followUsbState;
  followUsbBadge.dataset.state = state === null ? "unknown" : state ? "on" : "off";
  followUsbBadge.setAttribute("aria-pressed", state === null ? "mixed" : String(state));
  followUsbBadge.textContent = m.followUsb;
  followUsbBadge.title = state === null ? m.followUsbUnknownHint : state ? m.followUsbOnHint : m.followUsbOffHint;
}

function setFollowUsbBadge(state: boolean | null): void {
  followUsbState = state;
  renderFollowUsbBadge();
}

// Theme mode (ThemeMode, ui/prefs.ts): auto follows the OS color scheme. A
// fresh install defaults to auto; an explicit light/dark choice (including ones
// saved before auto existed) is honored.
// E2E pins an empty starting board (just the fixed wires) via this flag so
// routing/hide assertions are not perturbed by the factory-seed sends; the seed
// data itself is verified by initial-state.test.ts.
const seedEmpty = seedEmptyRequested();
// Shelved (hidden) nodes are persisted globally per model so the canvas/console
// layout survives an app restart, independent of any saved plan file. The id set
// is model-specific, so store a per-model map under one key. Best-effort: storage
// may be unavailable, in which case hidden state simply does not carry across.
// Fresh plans (startup / new / model switch) restore the last hidden layout for
// that model; a loaded file overrides it via loadPlan (which then re-records it).
const newPlan = (id: ModelId): Plan => {
  const p = seedEmpty ? emptyPlan(id) : defaultPlan(id);
  p.hidden = loadHidden(id);
  return p;
};

let modelId: ModelId = detectModel();
let plan: Plan = newPlanAtLastRate(modelId);
ensureFixedConnections(getModel(modelId), plan);
let dirty = false;
// Which plan keys an edit funnel wrote while a device read was in flight. Every read
// goes through readIntoPlan with it, and markChanged is the one site that reports: a
// funnel that authored a key and then put it back where the read found it is otherwise
// indistinguishable from an untouched key, and the read would write the device's
// mid-gesture sample over it. Armed only while a read is open, so an edit outside one
// costs a null check.
const planWrites = new PlanWriteWitness(() => plan);
let selection: Selection = null;
let recent: RecentEntry[] = loadRecent();
let themeMode: ThemeMode = detectThemeMode();
let theme: ThemeName = resolveTheme(themeMode);
document.documentElement.dataset.theme = theme;

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

// Live sync: mirror each edit to the connected device. The model
// and plan are read through getters because loadPlan reassigns `plan`. A write
// failure stops sync and drops the connection (deactivateLive). Declared before the
// graph because the graph's onChange callback schedules a live flush. Null in the
// demo build (DEMO folds the ternary to null), so the control layer tree-shakes
// out exactly as the other device features do.

// Tracks whether a live session's resources (held connection, follow, live UI)
// are up — independent of the LiveSync.active flag, which a flush clears the
// instant it errors. deactivateLive guards on this so an error-path teardown
// (where active is already false) still drops the connection and resets the UI.
let liveSessionUp = false;
// Generation of the connection the live session holds open, captured at connect.
// deactivateLive disconnects with exactly this epoch, so a teardown that lands
// late (the disconnect is fire-and-forget) cannot close a newer connection a
// later device action opened in the meantime — the Rust side no-ops the mismatch.
let liveEpoch = 0;
// Holds the running self-test's controller (experimental); null when idle. Module
// scope so applyStaticI18n keeps the button's "Cancel" label across a language
// switch mid-run, instead of reverting it to "Self-test" while a run is in flight.
let selfTestAbort: AbortController | null = null;
// Same for the fetch / write device actions: each holds its in-flight controller
// (a long read/write of the whole device can stall when the link drops), so a
// second menu click cancels and applyStaticI18n keeps the "Cancel" label.
let fetchAbort: AbortController | null = null;
let writeAbort: AbortController | null = null;
// The experimental read-only compare (device vs plan): same cancel-on-second-click
// pattern as fetch, so its serial diff sweep can be stopped when the link stalls.
let compareAbort: AbortController | null = null;
// Whether the --experimental gate resolved on (set in the !DEMO block below); the
// Preferences device-scope note names the diagnostics' coverage only when the
// diagnostics themselves are reachable.
let experimentalOn = false;
// Name the collapse the way the canvas names a node, and count the rest. Several
// surfaces print this (the live status line, the write confirm, the "no changes"
// status), so the label/count rule lives here once. The first group's first
// dropped owner is the one named — the complete list goes to the console warning
// the collapse already logs.
function sharedSettingText(owners: SharedOwners[]): string {
  const first = owners[0];
  const more = owners.reduce((n, o) => n + o.dropped.length, 0) - 1;
  return t().status.sharedSetting(graph.labelOf(first.dropped[0]), graph.labelOf(first.kept ?? ""), more);
}
// The link ledger — what a session asks of the Device Center broker, and what the
// broker fails to answer (core/control/link-stats.ts says why these values and not
// latency). COLLECTED AND LOGGED in every desktop build, deliberately: the symptom it
// exists for turns up after the app is gone, and a record that only exists when the
// operator happened to launch with a flag records nothing. Only the on-screen readout
// is gated behind --experimental.
const linkLedger = DEMO ? null : new LinkLedgerTracker(version);
let linkStatsView: LinkStatsView | null = null;

// A log line that could not be written is not a device failure and does not stop a
// session — but it is not swallowed either: it says so once per session (the tracker's
// own latch) and every time in the console (see architecture.md "Aborting on failure").
function warnLinkLog(message: string): void {
  console.warn("link ledger:", message);
  setStatus(t().status.linkLogFailed(message));
}

/** Start the ledger for a session. Called on the connect rather than once the session
 *  counts as up, so the elapsed time and the Rust-side command counts — which start at
 *  the connect — measure the same window. The tracker owns the interval and the opening
 *  line; this is only the two things the app knows, the device label and where a
 *  failure gets reported. */
function beginLinkLedger(device: string): void {
  if (!linkLedger) return;
  linkLedger.begin(device, warnLinkLog);
  linkStatsView?.setSession(true);
}

/** Close the ledger, then the connection, then hand the link holder back — in that
 *  order. A reading taken after the disconnect reports a session that did nothing and the
 *  counters go to zero with the link, and the holder is what keeps another action from
 *  connecting over a read this is still waiting out. THE one release: every exit from a
 *  live session goes through here, so the ordering is a property of the code rather than
 *  a rule each exit re-implements.
 *
 *  Chained rather than awaited so callers stay synchronous where they were: the
 *  disconnect was already fire-and-forget, and its epoch guard is what makes a late one
 *  safe. */
function releaseLive(epoch: number, reason: LinkSessionEnd): Promise<void> {
  linkStatsView?.setSession(false);
  const ledger = linkLedger?.active ? linkLedger.end(reason) : Promise.resolve();
  // A follow read already in flight goes on reading over this connection: a session that
  // merely ends lets its read finish rather than abandoning it (abandonFollowWork says
  // why), and the link it reads over is this session's. Disconnecting under it answers its
  // next round trip "not-connected", which stops it exactly where abandoning it would have
  // — the document left holding a mix of device and plan values with nothing marking which
  // is which — and reports nothing, since the session is already down and stopLiveOnError
  // returns on that. No caller can add to the set while it is waited on: the two that can
  // have reads in flight stop the follow layer first, and the start's own cancels are all
  // in front of it beginning. allSettled rather than all: a ledger that rejects still has
  // to release the link.
  const reads = Promise.all([...followReads].map((r) => r.done));
  return (
    Promise.allSettled([ledger, reads])
      .then(() => vdDisconnect(epoch))
      // The holder goes back HERE and not in deactivateLive, because it is what stops
      // another action from connecting: an install replaces the worker, and the read still
      // running above has no epoch of its own — its next round trip would go to whatever is
      // installed by then, and its epilogue would re-base and flush through the session
      // that replaced it. Ahead of the catch rather than behind it, so a disconnect that
      // failed cannot leave the app locked out of its own device actions: behind one that
      // absorbs the rejection, a `finally` and a `then` do the same thing and neither says
      // which was meant.
      .finally(() => releaseDeviceLink("live"))
      // …and a disconnect that could not be sent leaves the app unable to say whether the
      // unit is still attached to a worker, which is a dialog rather than a status line.
      // Not on a session ending in ERROR: stopLiveOnError has already raised one naming
      // the same drop, and the disconnect failing is how a dropped link answers.
      .catch((err) => {
        if (reason !== "error") showError(t().status.liveError(errorText(err)));
      })
  );
}

const live = DEMO
  ? null
  : new LiveSync({
      getModel: () => getModel(modelId),
      getPlan: () => plan,
      onError: (message) => stopLiveOnError(errorText(message)),
      // The adoption's own count rides on this line rather than writing one of its own: the
      // converge that produces it runs INSIDE the flush, so a line written there is overwritten
      // by this one a moment later — the status bar is last-writer-wins, and a converge always
      // implies something was sent, so this always follows.
      onSent: (n) => {
        const taken = liveAdopted;
        liveAdopted = 0;
        setStatus(t().status.liveSynced(n) + (taken ? ` — ${t().status.paramsBounded(taken)}` : ""));
      },
      onConfirmed: (confirmed, sent) => {
        liveAdopted += adoptConfirmedWrites(confirmed, sent);
      },
      onCollapsed: (owners) => setStatus(sharedSettingText(owners)),
      // One bidirectional scope for the session: the same filter shapes the
      // snapshot, the flush, and the follow notify registration.
      getScope: () => getSettings().deviceScope,
      // A "refetch" sideEffect went out (the EQ 1-knob): the device has just recomputed
      // values the plan only mirrors, so read the owner node back rather than pushing.
      // Scoped rather than the full reflect `reconcileNodes` takes: the nodes are known and
      // the change is node-local (the recomputed bands), and live.ts has already re-based
      // its own snapshot — a full reflect would re-translate the whole plan a second time
      // and rebuild the console on every flush of a 1-knob drag. The abort rule is the
      // shared one: a read that cannot complete leaves the plan claiming values the device
      // does not hold.
      //
      // `pending` is what the flush that triggered this refetch just put on the unit.
      // The read waits those writes out and answers their addresses from what the UNIT
      // announced (see readback / settle), and it does both INSIDE this merged read, so
      // an edit made while it waits is covered by the same clone and witness that cover
      // one made while it reads. Without it the read wrote the value the click had just
      // replaced back into the plan, this hook absorbed it into the undo baseline,
      // live.ts's re-base recorded it as device truth, and the unit's own notify for our
      // write then read as a device-side change. That also widens the window undo is
      // refused in, since the wait is inside followReads membership like the read it
      // belongs to. Left that way: the clone and the witness are open for the whole of
      // it, so committing an entry there would freeze this read's own writes into it —
      // and the refusal is a deferral, bounded by the settle's own window.
      refetchNodes: async (nodeIds, pending) => {
        // Named for the hook, not for a member of it: the EQ 1-knob was the only
        // sideEffect: "refetch" param when this was written, and SSMCS morphing now takes
        // the same path. A diagnostic that names one of them puts the wrong cause in the
        // log for the other.
        const merged = await followRead("side-effect refetch", (into, signal) =>
          // The one caller that skips the names, and it says so itself — the reconciles
          // below carry pending writes too, and reading names is what makes a rename
          // made on the unit arrive (readback.ts's name section).
          applyNodeState(getModel(modelId), into, nodeIds, signal, pending, true),
        );
        // The plan this read was issued for is gone (a file flow replaced it): its
        // values belong to a document nothing shows, and no snapshot can describe it.
        if (!merged) return null;
        traceProbe?.sample("refetch");
        noteMergeConflicts(merged);
        for (const id of nodeIds) followDirtyNodes.add(id);
        // The device recomputed values the plan only mirrors (the 1-knob bands), so they
        // are its authorship, not an edit: take exactly those keys into the history
        // baseline. A whole-plan re-base takes the drag's own moves with them and drops
        // the entry it has open, which is what made one 1-knob level drag undo as 0
        // entries or as 1 describing only its tail.
        planHistory?.absorb(merged.devicePatch);
        requestReflect();
        assertReadComplete(merged, "side-effect refetch issues:");
        return merged.deviceView;
      },
      // The flush's capture rebuilt the follow address set — re-register against it. Only a
      // STRUCTURAL edit moves that set (a mode change, a wire), so this is a no-op on the
      // ordinary flush and DeviceFollow.refresh is what decides. Fire-and-forget on purpose:
      // the flush has returned, and refresh routes its own failures to onError rather than
      // leaving a floating rejection.
      reregister: () => void follow?.refresh(),
    });

const graph = new Graph(graphHost, getModel(modelId), plan, {
  onSelect: (sel) => {
    selection = sel;
    // Ungated, and it clears the gate first. A selection change is the one refresh the
    // panel's in-flight input cannot outrank: the picker or composition it would be held
    // for belongs to the node being left. Held, the panel goes on describing that node —
    // which is what a press on another node did while a `<select>` in the panel still had
    // focus, since choosing in one leaves focus there.
    rebuildInspectorNow();
  },
  onStatus: (msg) => setStatus(msg),
  onChange: () => {
    markChanged();
    refreshInspector();
  },
  onHiddenChange: (hidden) => rememberHidden(modelId, hidden),
});

// External MIDI control (desktop only, assigned in the !DEMO block below).
// Declared before the console so its learn hooks can close over the variable.
let midi: MidiControl | null = null;

// MIDI-learn hooks, shared by every surface a control can be armed from: the
// CONSOLE strips and the channel tuning screens. One object, so the two cannot
// disagree about what is armed or what an assignment reads as. No-ops while midi
// is absent (browser / demo), which is what keeps those builds untouched.
const midiLearnHooks: MidiLearnHooks = {
  learnActive: () => midi?.learnActive() ?? false,
  armedId: () => midi?.armedId() ?? null,
  isMapped: (id) => midi?.isMapped(id) ?? false,
  addrOf: (id) => midi?.addrOf(id) ?? null,
  arm: (id) => midi?.arm(id),
};

// Device setup modal (the unit's SETUP > GENERAL). Desktop only, assigned in the
// !DEMO block below; the language listener re-renders it through this handle.
let deviceSetup: DeviceSetupPanel | null = null;

// Mixer-style CONSOLE view: an alternate view of the same plan. Its edits go
// through the same change funnel (markChanged) so Live sync mirrors them. The
// live signal meters stream only while Live sync is on (consoleView.setLive).
const consoleView = new Console(consoleHost, {
  getModel: () => getModel(modelId),
  getPlan: () => plan,
  // A console edit changed the plan: flag dirty + schedule live sync. The console
  // re-renders the edited strip itself, so don't rebuild it here (that would
  // disrupt an in-progress fader drag).
  onChange: (written) => markChanged("ui", written),
  // The meter stream failed to register. Floor-stuck bars read as "no signal",
  // so end the session rather than let the operator trust a dead display.
  onMeterError: (message) => stopLiveOnError(errorText(message)),
  onOpenDynScreen: (kind, id) => dynScreen.open(DYN_PROCESSORS[kind], id),
  // MIDI learn: while learn mode is on, console controls arm for binding instead
  // of editing.
  midi: midiLearnHooks,
});

// Device follow: the reverse of live sync. While live, parameter
// changes made on the device itself (LCD / physical controls) are pulled back
// into the plan via a debounced readback that reuses applyDeviceState, then
// re-rendered. Echoes of our own writes are filtered by the live snapshot. Null
// in the demo / when live is absent, so it tree-shakes out with the rest of the
// control layer.
// Reflect a device-follow change back onto the plan's two views. A direct notify
// (fader / pan / on) touches one node's scalar and already patched its snapshot
// entry (noteDirect), so it only needs the touched nodes / strips repainted. A
// scoped / full read-back can change anything, so it re-derives both views and
// re-bases the whole snapshot. Selection/viewport are untouched (refresh, not
// rebuild). graphDirty defers the graph's work while it is the hidden view (console
// active); setView does it once on the way back, and inspectorDeferred is the same
// shape for the inspector, which the console view hides for as long as it is up.
let graphDirty = false;
let inspectorDeferred = false;
const followDirtyNodes = new Set<string>();
/**
 * The one ritual for "the device authored this into the plan", shared by the two
 * direct-follow hooks (a numeric scalar and a rename) and by the write-adoption, which is
 * not a follow at all — no notify arrives, the write path is writing back what a converge
 * confirmed — and passes its own `kind` for that reason. `place` performs the mutation and
 * answers whether it landed.
 *
 * The device authored these keys, so the history takes exactly them into its
 * baseline — the per-key rule the refetch path runs on, which is what the other sites that
 * write device values into the plan outside a readback run on too. A whole-plan `rebase()`
 * here dropped the entry an app gesture had open, which made an edit taken while the
 * unit was being touched silently un-undoable AND spent the entry beneath it on the
 * Ctrl+Z that should have taken it back.
 *
 * Diffed from a clone taken here because `place` reports only whether it placed the
 * value: where it lands is several places (a fader / pan / assign ON is a connection
 * param, a name is `nodeNames`, everything else a node param), and a scoped differ
 * that missed one would silently stop absorbing. A whole-plan clone + diff measures
 * 0.12 ms for the URX44V default plan against a stream of ~10 notifies/s.
 *
 * One definition rather than two: this rule is load-bearing and the comment above is
 * the record of what re-opening it costs, so a second copy kept in step by hand is
 * the shape that goes wrong quietly.
 */
function authorFromDevice(node: string, place: () => boolean, kind: WriteSource = "follow-direct"): boolean {
  const before = clonePlanState(plan);
  if (!place()) return false;
  // The trace kind is the caller's, because the callers are not one writer: a follow is a
  // notify landing, while the write-adoption is the device-action funnel writing back what a
  // write confirmed. Both are device-side writers, so no invariant's verdict turns on the
  // split — what it buys is a ledger a person can read without guessing which one wrote.
  traceProbe?.sample(kind);
  followDirtyNodes.add(node);
  planHistory?.absorb(diffPlans(before, plan));
  return true;
}
/** After a write the device confirmed, the plan takes the values that were actually sent.
 *
 *  Which values those are is `confirmedAdoptions` (`app/adopt-writes.ts`), which needs the plan
 *  the converge RAN AGAINST as well as the live one — the live flush clones before its await,
 *  and an address is a different key under a different effect type. Keyed on the ADDRESSES the
 *  device confirmed rather than on the write having succeeded: the two come apart exactly where
 *  this runs, since a session whose snapshot already agrees sends nothing, so a flush can
 *  succeed without the address in question being in it at all.
 *
 *  Authored FROM the device rather than pushed as an edit, through the seat a device-side
 *  recompute already takes: the value is the write path's rather than the operator's, and an
 *  undo that put the unwritable raw back would only have it normalised again on the next write.
 *  Returns how many the plan took, so a caller can say so beside its own outcome. */
function adoptConfirmedWrites(confirmed: ReadonlySet<number>, sent: Plan = plan): number {
  const mine = confirmedAdoptions(getModel(modelId), sent, plan, confirmed);
  if (!mine.length) return 0;
  let taken = 0;
  for (const node of new Set(mine.map((b) => b.node))) {
    const forNode = mine.filter((b) => b.node === node);
    if (authorFromDevice(node, () => (applyParamRange(plan, forNode), true), "device-action")) taken += forNode.length;
  }
  if (taken) requestReflect();
  return taken;
}
// What the live flush's converge took back, waiting for the line `onSent` writes.
let liveAdopted = 0;
let followFull = false;
// How many keys the follow reads behind the pending reflect actually authored. A COUNT
// rather than a flag because the reflect is coalesced at ~20 Hz, so several reads can
// land before one runs and a flag ASSIGNED per call would let the last one speak for
// all of them; it accumulates instead. Only its emptiness is read — the keys
// themselves are the reads' own business, and each already absorbed or re-based with
// them at its own site. Both reconcile hooks add; the reflect drains it.
let followAuthored = 0;
function reflectFollow(): void {
  const ids = [...followDirtyNodes];
  followDirtyNodes.clear();
  // Not planReadFromDevice: this funnel is coalesced across producers, so it cannot know
  // what the device authored and a whole-plan re-base here takes the operator's open
  // gesture with it. Each producer settles the history at its own site instead.
  planValuesChanged();
  if (followFull) {
    followFull = false;
    if (graphHost.hidden) graphDirty = true;
    else graph.refresh();
    syncRateUi(); // also refreshes the console (applyRateConstraints)
    dynScreen.refresh();
    // A readback of any breadth re-authored the plan's values from the device, so
    // no earlier entry describes a state it can return to. The snapshot is NOT
    // re-based here: only the private copy the read ran against says what the device
    // holds, and the reconcile hooks re-base from it the moment their read resolves.
    //
    // Conditional on the read having authored anything, because that premise is what
    // the reset rests on: a reconcile that agreed with the plan at every key
    // invalidates no earlier entry, and wiping up to 100 undo entries for it is loss
    // with nothing bought. Both producers of a no-op reconcile reach here — a late
    // announcement mistaken for a device edit, and a write the unit never announced
    // (follow.ts's idle net) — and neither is rare enough to pay for. Nothing is
    // absorbed in the other arm: PlanHistoryStack.absorb returns immediately on an
    // empty patch, so the fallback would be a no-op spelled as code.
    const authored = followAuthored;
    followAuthored = 0;
    if (authored) planHistory?.reset();
  } else {
    // Direct-only: repaint just the changed nodes / strips. The snapshot is already
    // current from noteDirect, so no full re-translate. Only one view is visible.
    if (graphHost.hidden) graphDirty = true;
    else graph.repaintDirtyNodes(ids);
    for (const id of ids) consoleView.refreshStrip(id);
    // The inspector renders ONE selection, but what it draws is read off more nodes than
    // that selection names: a device-side Pan Link ON removes the send PAN
    // (mixSendLocks), and an unrefreshed panel leaves the removed control on screen and
    // live, writing the very address the MIDI catalog is refusing at the same instant.
    // Scoped to the nodes the panel reads, so a device sweep of an unselected node does
    // not rebuild the panel at this branch's ~20 Hz.
    const shown = inspectorNodes(getModel(modelId), plan, selection);
    if (ids.some((id) => shown.includes(id))) refreshInspector();
    // The dynamics screen shows a snapshot of the same node params, so a
    // device-side edit under it would otherwise leave stale sliders on screen.
    dynScreen.refresh(ids);
  }
}
// A reconcile read that fails loses the device-side change it was called for —
// the notify already fired and nothing re-triggers the read — and the next
// converge would then write the plan's stale value back over the operator's own
// edit on the hardware. Throwing takes DeviceFollow's stop-following path, which
// its hook contract already declares. Shared by both reconcile hooks so the rule
// has one spelling.
function assertReadComplete(merged: MergedRead, label: string): void {
  // What the read HELD is reported first and unconditionally. The hold has already taken
  // effect inside the merge, so a report that ran only past this throw would leave the
  // plan keeping values the unit does not have with nothing saying so — and reporting it
  // here rather than at each call site is what stops a fourth caller getting that order
  // wrong.
  if (merged.held.length) console.warn("device read: the plan keeps what the unit cleared", merged.held);
  if (!merged.errors.length) return;
  console.warn(label, merged.errors);
  const cause = linkFailureIn(merged.errors) ?? t().error.followReadIncomplete(merged.errors.length);
  // The count travels with the teardown's own message: the status line this read would
  // have written is about to be replaced by `stopLiveOnError`, and the console does not
  // reach an installed build.
  throw new Error(merged.held.length ? t().error.followReadHeld(cause, merged.held.length) : cause);
}
// A merged device read could not place part of its result: a wire the operator removed
// while it was in flight, or an edit a device-side routing change left nowhere to land.
// What could be applied was; the rest is reported rather than dropped in silence — the
// same rule the history's own apply follows. Not a link failure, so it does not abort.
function noteMergeConflicts(merged: MergedRead): void {
  if (merged.unplaced.length) console.warn("device read: merge targets no longer in the plan", merged.unplaced);
}
// The send-back, which only a complete read may ask for: a partial read is about to
// drop the link, and a flush issued into that writes nothing and reports nothing. The
// snapshot has just re-based onto the unit's values, so plan and device disagree exactly
// where the read held, and the ordinary outgoing diff is what puts them back — for insert
// FX, the selector, then the stored engine values, then the bypass intent. Nothing else
// would schedule that flush: no plan key moved, so no edit funnel ran.
//
// A read holds only where it has rate evidence (insertFxHoldKeys) — its own, or one the
// unit announced while it ran. Both reconcile paths hand over the same hold for that
// reason: a scoped read establishes no rate of its own and is still the first thing to
// see a selector the unit has just cleared, so the pairing cannot be skipped at one of
// them.
function reapplyHeld(merged: MergedRead): void {
  if (!merged.held.length) {
    setStatus(t().status.liveFollowed(merged.applied));
    return;
  }
  // A follow read outlives a session that merely ended (`abandonFollowWork` is not called
  // from `deactivateLive`), and `schedule()` is a no-op once it has — worth telling apart
  // in the log from a flush that went out.
  if (live?.isActive()) {
    live.schedule();
    setStatus(t().status.liveHeld(merged.applied, merged.held.length));
    return;
  }
  // Nothing left to send them through: the values stay in the plan, and the status line
  // belongs to whatever ended the session. Writing "re-sent" over it would name an action
  // that did not happen and cannot.
  console.warn("device read: no session left to send the held values back through", merged.held);
}
// Single funnel for every device-follow reflect (direct notifies and the scoped /
// full read-backs alike): a knob sweep delivers notifies in ~30/s IPC batches, any
// of which would otherwise drive a full graph rebuild + snapshot re-base. Coalesce
// them onto one timer capped at ~20 Hz (the device streams at ~10 Hz). applyDirect
// and the read-backs have already written the latest values into the plan, so a
// deferred reflect still renders current truth — no trailing state is lost.
const REFLECT_MIN_MS = 50;
let reflectTimer = 0;
let lastReflect = 0;
function requestReflect(): void {
  if (reflectTimer) return;
  const wait = Math.max(0, REFLECT_MIN_MS - (performance.now() - lastReflect));
  reflectTimer = window.setTimeout(() => {
    reflectTimer = 0;
    lastReflect = performance.now();
    reflectFollow();
  }, wait);
}
// A follow-side device read (the two reconciles, the 1-knob refetch) hands the module
// `plan` to the readback by reference and comes back hundreds of round trips later.
// Nothing raises deviceReadInFlight for these — the Fetch button raises it for its own
// read — so File > New / Open / a drop / a model switch lands mid-read and the read goes
// on filling a document that is no longer open.
//
// Both halves below are needed. The abort stops round trips that are now for nothing;
// but the readback checks the signal at group boundaries, so a read can still resolve
// after it, and readIntoPlan's own identity guard is what keeps the merge — and the
// epilogue behind it — off the plan that replaced the one it read. The set doubles as
// the "a follow read is in flight" predicate the history refuses under: an undo taken
// inside one patches values the read is about to merge over, and unlike a file flow it
// is refused rather than lost. Membership rather than a separate count, so that
// abandonFollowWork's clear also ends the refusal — a read bound to a discarded plan
// provably cannot touch the open one, so it must not keep undo shut.
type FollowRead = { abort: () => void; done: Promise<void> };
const followReads = new Set<FollowRead>();
// Routes the UNIT announced an insert-FX change on, appended in notify order. A read is
// not a snapshot: its addresses are answered hundreds of milliseconds apart, so a change
// landing inside one is caught on the addresses read after it and missed on those read
// before, and comparing two of its values says nothing about what happened between them.
// The notify stream is what carries the order — and it tells the two clearings apart,
// where the read's values cannot: a Signal Type transition announces the insert-FX
// addresses it clears, the sample-rate excursion announces only the rate. Appended
// rather than cleared per read, because two follow reads can be in flight at once and a
// reset would take the evidence of one out from under the other; each takes the slice
// that arrived inside it, and the list is emptied when the last read ends.
const announcedInsertFx: string[] = [];
// Every sample rate the unit announced, from the same stream. Taken WHOLE rather than
// sliced to a read's own window, unlike the list above: the rate notify that escalates to
// the read arrives before it starts, and it is the one carrying the rate that cleared the
// effect. An excursion can also be over before the read asks for the rate at all — 48 →
// 96 → 48 leaves the read holding 48, where the effect runs and the clearing then reads
// as the operator's own.
//
// Each entry carries the sequence number it arrived at, and a read consumes the ones that
// were already there when it started — what arrived while it ran belongs to the reconcile
// it scheduled. By SEQUENCE rather than by array position, and independently of whatever
// else is in flight: a side-effect refetch overlapping the read establishes no rate of its
// own, so tying the consumption to an empty in-flight set left the announcement standing
// after the read it was for had finished with it, and the next clearing the operator made
// by hand on the unit was held against a rate the unit had left long before.
const announcedRates: Array<{ seq: number; hz: number }> = [];
let rateSeq = 0;

// Everything device-follow has in flight for a plan that is being replaced. Called at
// each wholesale reassignment of `plan`, and deliberately not from deactivateLive: with
// the document still on screen, a read stopped half way leaves it a mix of device and
// plan values with nothing marking which is which — the hazard a Fetch avoids by reading
// into a private copy, so cancelling one leaves the document on screen untouched — so a
// session that merely ends lets its read finish. A
// queued reflect goes too — it names nodes in the outgoing plan and its full path resets
// the history of whatever replaced it; loadPlan re-renders the new plan whole anyway.
function abandonFollowWork(): void {
  for (const r of followReads) r.abort();
  followReads.clear();
  // The reads that would have consumed these are gone, so nothing is left to own them.
  announcedInsertFx.length = 0;
  announcedRates.length = 0;
  if (reflectTimer) {
    clearTimeout(reflectTimer);
    reflectTimer = 0;
  }
  followDirtyNodes.clear();
  followFull = false;
  followAuthored = 0;
}

/** Run a follow-side device read as a merged read (readback.readIntoPlan), carrying the
 *  abort handle that makes it abandonable. Null means the plan it was issued for is no
 *  longer the open document — every caller returns without its epilogue, which is what
 *  keeps a status line, a provenance stamp and a history reset off a document the read
 *  never touched. The drop reaches the console only: the replacement that discarded the
 *  plan ended the session and printed its own line. */
async function followRead(
  label: string,
  read: (into: Plan, signal: AbortSignal) => Promise<ReadbackResult>,
): Promise<MergedRead | null> {
  const controller = new AbortController();
  // The `done` half is what the session's own release waits on (releaseLive).
  let finished = (): void => {};
  const entry: FollowRead = {
    abort: () => controller.abort(),
    done: new Promise<void>((resolve) => (finished = resolve)),
  };
  followReads.add(entry);
  const mark = announcedInsertFx.length;
  // Where this read's own share of the rate history ends. Everything after it arrived
  // WHILE the read ran, which means it belongs to the reconcile it scheduled rather than
  // to this one.
  const rateMark = rateSeq;
  let establishedRate = false;
  try {
    const merged = await readIntoPlan(
      () => plan,
      (into) => read(into, controller.signal),
      planWrites,
      (ctx) => {
        establishedRate = ctx.deviceSampleRate !== undefined;
        return insertFxHoldKeys(getModel(modelId), {
          ...ctx,
          announced: new Set(announcedInsertFx.slice(mark)),
          ratesSeen: announcedRates.map((r) => r.hz),
        });
      },
    );
    if (!merged) console.warn(`${label}: the plan was replaced during the read; its values are discarded with it`);
    return merged;
  } finally {
    followReads.delete(entry);
    finished();
    if (!followReads.size) announcedInsertFx.length = 0;
    // The rate history outlives a read that established no rate of its own, and a read
    // that did takes only what was already there when it started. Both halves are about
    // the same thing — the read that CONSUMES an announcement is not always the one that
    // was running when it arrived. A scoped read holds no rate at all, so emptying on
    // whichever read finished first took the evidence out from under the full read the
    // notify was for; and a full read already in flight has read the selector before the
    // unit cleared it, so it holds nothing itself and the announcement belongs to the
    // replay it scheduled. Measured: clearing the whole list there left that replay
    // adopting the clearing.
    if (establishedRate) {
      const keep = announcedRates.filter((r) => r.seq > rateMark);
      announcedRates.length = 0;
      announcedRates.push(...keep);
    }
  }
}

const follow =
  DEMO || !live
    ? null
    : new DeviceFollow({
        // The plan's follow set plus Follow USB, which the plan deliberately does
        // not carry (params.ts) but the badge has to keep in step with the device.
        addrs: () => [...(live?.followAddrs() ?? []), FOLLOW_USB_ADDR],
        intercept: (p) => {
          const [id, x, y] = FOLLOW_USB_ADDR;
          if (p.paramId !== id || p.x !== x || p.y !== y) return false;
          setFollowUsbBadge(p.value !== 0);
          return true;
        },
        // Dispatched on the value's type, because the two snapshots are separate maps:
        // the numeric one holds no entry for a name, so asking it would call the app's
        // own rename a device-side change and bounce it back round.
        isEcho: (p) =>
          (p.valueStr !== undefined
            ? live?.isEchoName(p.paramId, p.y, p.valueStr)
            : live?.isEcho(p.paramId, p.x, p.y, p.value)) ?? false,
        lookup: (paramId, x, y) => live?.lookup(paramId, x, y),
        // Read for one thing only: which routes the unit announced an insert-FX change
        // on while a read was running (see `announcedInsertFx`). A Signal Type notify
        // names the pair's primary, and the transition it reports clears BOTH members,
        // so the partner is recorded with it.
        onDeviceParam: (p) => {
          if (p.paramId === PARAMS.SAMPLE_RATE.id) announcedRates.push({ seq: ++rateSeq, hz: p.value });
          const addr = live?.lookup(p.paramId, p.x, p.y);
          if (!addr?.node || !INSERT_FX_ANNOUNCED.has(addr.name)) return;
          announcedInsertFx.push(addr.node);
          const partner = partnerChannel(getModel(modelId), addr.node);
          if (partner) announcedInsertFx.push(partner);
        },
        // A direct (node-local scalar) change: decode the notify value straight into
        // the plan, no read-back, and record the node so the coalesced reflect
        // repaints just it. The reflect is scheduled by flushDirect.
        applyDirect: (node, name, value) => authorFromDevice(node, () => applyDirect(plan, node, name, value)),
        // A rename made on the unit's own LCD. It arrives as a string notify on a
        // name address, which the numeric follow path cannot carry — the value is
        // text, the address has no catalog entry, and the live snapshot holds no
        // entry to compare against. Placed straight into the plan like any other
        // direct follow: one node repainted, no readback.
        applyName: (paramId, x, y, value) => {
          const node = live?.lookupName(paramId, x, y);
          if (node === undefined) return undefined;
          authorFromDevice(node, () => {
            // Normalized like every other way a name enters the plan. The unit's own
            // screen cannot produce one longer than the bound, so an arriving name is
            // normally within it — but the wire accepts and stores longer, and an
            // unbounded name in the plan draws a label across its neighbours.
            const trimmed = normalizeNodeName(value);
            if (trimmed) plan.nodeNames[node] = trimmed;
            else delete plan.nodeNames[node];
            // The snapshot takes the device's OWN value, not the normalized one: the two
            // agreeing is what stops a flush from writing the operator's board edit
            // back off the board, and where they disagree the next flush is what
            // settles the device on the bounded name.
            live?.noteDirectName(paramId, y, value);
            return true;
          });
          return node;
        },
        noteDirect: (paramId, x, y, value) => live?.noteDirect(paramId, x, y, value),
        flushDirect: () => requestReflect(),
        // A settled scoped change: re-read just the touched owner nodes and reflect.
        // A read-back can change more than the direct fast path handles, so mark the
        // reflect full (re-derive both views + re-base the snapshot).
        // A reconcile read that fails loses the device-side change it was called
        // for — the notify already fired and nothing re-triggers the read — and
        // the next converge would then write the plan's stale value back over the
        // operator's own edit on the hardware. Reject so DeviceFollow takes its
        // stop-following path, the same one a rejected reconcile already took.
        reconcileNodes: async (nodeIds) => {
          // Taken before the read is issued: a direct notify landing while it is in
          // flight is device truth the read's private copy predates, and the re-base
          // below rebuilds the whole snapshot from that copy.
          const since = live?.directMark();
          // The session's own recent writes travel with the read. This node's addresses
          // can include ones the flush wrote tens of ms ago, and a GET inside that
          // window answers the PRE-write value — which the merge then takes as device
          // truth while the unit's own notify for our write is consumed as an echo. The
          // operator's toggle flips back on screen, and plan and snapshot agree on a
          // value the device does not hold until the idle sweep re-reads past it.
          const pending = live?.recentPending(nodeIds);
          const merged = await followRead("device-follow scoped readback", (into, signal) =>
            applyNodeState(getModel(modelId), into, nodeIds, signal, pending),
          );
          if (!merged) return;
          traceProbe?.sample("follow-scoped");
          noteMergeConflicts(merged);
          // Re-based here rather than in the coalesced reflect: only the copy this read
          // ran against says what the device holds, it is not reachable from there, and
          // the reflect's delay is a window in which an undo would diff against a
          // snapshot that still describes the pre-read plan.
          live?.resync(merged.deviceView, since);
          // Before assertReadComplete, which throws: a partial read's authored keys
          // still invalidate the history, exactly as followFull / requestReflect
          // already survive that throw.
          followAuthored += merged.devicePatch.length;
          followFull = true;
          requestReflect();
          assertReadComplete(merged, "device-follow scoped readback issues:");
          reapplyHeld(merged);
        },
        // Escalation / idle safety net: pull the whole device into the plan.
        reconcileAll: async () => {
          const since = live?.directMark();
          // Unscoped: a whole-device read covers every address, so every recent write is
          // one it must settle before reading (the scoped case above says why).
          const pending = live?.recentPending();
          const merged = await followRead("device-follow readback", (into, signal) =>
            applyDeviceStateScoped(into, signal, pending),
          );
          if (!merged) return;
          traceProbe?.sample("follow-full");
          noteMergeConflicts(merged);
          plan.unreadNodes = merged.unreadNodes;
          live?.resync(merged.deviceView, since);
          followAuthored += merged.devicePatch.length;
          followFull = true;
          requestReflect();
          assertReadComplete(merged, "device-follow readback issues:");
          reapplyHeld(merged);
        },
        onFollow: () => setStatus(t().status.liveFollowing),
        onError: (message) => stopLiveOnError(errorText(message)),
      });

function setView(next: ViewName): void {
  const isConsole = next === "console";
  rememberView(next);
  graphHost.hidden = isConsole;
  inspectorHost.hidden = isConsole;
  $("btn-view-graph").setAttribute("aria-pressed", String(!isConsole));
  $("btn-view-console").setAttribute("aria-pressed", String(isConsole));
  if (isConsole) {
    consoleView.show();
  } else {
    consoleView.hide();
    // Reflect any console edits back onto the graph. If a device-follow reflect or an
    // undo landed while the graph was hidden, do the deferred full refresh instead.
    if (graphDirty) {
      graphDirty = false;
      graph.refresh();
    } else {
      graph.repaintNodes();
      graph.repaintWires();
    }
    // After the graph, not before: refresh() drops a selection whose node is now
    // shelved, and that drop rebuilds the panel itself — which clears the flag, so this
    // is a no-op there and the gesture costs one rebuild rather than two.
    if (inspectorDeferred) rebuildInspector();
  }
}

// ---- the device link is held by exactly one thing at a time ----
//
// The shell has ONE connection slot: `VdState::install` stops the worker already
// installed before putting the new one in, and commands are addressed to whatever
// is installed rather than to the connection that opened them (`sender()` takes no
// epoch). So a second `vdConnect` does not add a link beside the first — it takes
// the first one's. The original owner's next command silently rides the new
// connection, and the moment that owner disconnects, the first one's next command
// fails as not-connected. `core/control/connection-race.test.ts` models exactly
// that contract.
//
// For a destructive round-trip run (the self-test, --prepare-modified) the cost is
// not a failed action: the run perturbs the unit and then verifies it address by
// address, so it is cut off mid-perturbation with the captured original living only
// in its own dead call stack.
//
// Every frontend path that opens a connection therefore takes this latch and
// refuses while it is held — the UI lock below is the affordance, this is what makes
// it true. A holder name rather than a flag, because the entry that holds it is also
// its own way out (its Cancel; for a session, its stop) and must stay usable.
type LinkHolder = "fetch" | "write" | "compare" | "device-setup" | "follow-usb" | "live" | "run";
let deviceLinkHolder: LinkHolder | null = null;

// Each device entry and the holder it belongs to. While the link is held, every
// entry greys except its holder's own. The `.urxf` import owns no holder because it
// opens no connection, so it greys for every one of them: it replaces the plan
// wholesale, which is what a read in flight cannot survive.
const DEVICE_ENTRIES: ReadonlyArray<[string, LinkHolder | null]> = [
  ["btn-fetch", "fetch"],
  ["btn-write", "write"],
  ["btn-compare", "compare"],
  ["btn-device-setup", "device-setup"],
  ["btn-live", "live"],
  ["btn-selftest", "run"],
  ["btn-open-settings", null],
];

/** Take the device link, or report that something else has it and refuse. */
function holdDeviceLink(holder: LinkHolder): boolean {
  if (deviceLinkHolder !== null) {
    // Reachable only past a disabled entry (a drop target, a keyboard path, a race
    // between the click and the lock), so it is the belt rather than the affordance —
    // but it says so, because an action that silently does nothing reads as a broken
    // one.
    setStatus(t().status.deviceLinkBusy);
    return false;
  }
  deviceLinkHolder = holder;
  syncDeviceActionUi();
  return true;
}

/** Give it back. A release that does not name the current holder is a no-op — the
 *  same rule the Rust side's epoch enforces, so a late teardown of one action cannot
 *  free the link out from under the next. */
function releaseDeviceLink(holder: LinkHolder): void {
  if (deviceLinkHolder !== holder) return;
  deviceLinkHolder = null;
  syncDeviceActionUi();
}

// Lock every action that would take the link away from whoever holds it. Driven by
// the holder rather than by whichever state last moved, so the lock cannot disagree
// with the latch that decides the refusal.
function syncDeviceActionUi(): void {
  for (const [id, owner] of DEVICE_ENTRIES) {
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (el) el.disabled = deviceLinkHolder !== null && deviceLinkHolder !== owner;
  }
  // Follow USB is the one entry a live SESSION lends its connection to — its handler
  // writes over the session's link instead of opening a second one, and measured on a
  // URX44V the session survives the re-clock. During a live START it must not: the
  // session is not up yet, so the same handler would take the connecting branch.
  followUsbBadge.disabled = deviceLinkHolder !== null && !liveSessionUp;
  // A rate change re-clocks the device and renegotiates the USB stream, which
  // interrupts audio mid-session and puts the held connection at risk. The rate is
  // settled at the write boundary instead (settleSampleRate), so while live the
  // picker only reports what the device is running at. Locked here, beside the
  // other device actions, so no early return can leave it stuck disabled.
  //
  // This is a guard rail, not an invariant: nothing below the UI enforces it, so a
  // future path that mutates plan.sampleRate while live would bypass it.
  ratePicker.disabled = deviceLinkHolder !== null;
  // The model picker locks for the live SESSION only, not for every holder: a switch
  // replaces the plan wholesale, which a session cannot survive (loadPlan ends it),
  // and while live the picker is the only surface naming the unit on the wire — the
  // tally prints the tag alone. A start is not covered because the model may still
  // legitimately change there (offerModelSwitch), and the switch is already refused
  // for the read's duration by the deviceReadInFlight latch in fileFlow.
  picker.disabled = liveSessionUp;
}

// Reflect the live-sync state across the toggle, the on-air tally, and the other
// device actions (which conflict with the held connection while sync is on).
// Only ever called in the desktop live-sync path, so re-enabling on `off` is safe.
function setLiveUi(on: boolean): void {
  const liveBtn = document.getElementById("btn-live");
  if (liveBtn) liveBtn.setAttribute("aria-pressed", String(on));
  const tally = document.getElementById("live-tally");
  if (tally) {
    tally.hidden = !on;
    if (on) tally.textContent = t().toolbar.liveTag;
  }
  // The lock itself is the link holder's (see syncDeviceActionUi); a session is one
  // holder among several, and this call is what repaints the group when it changes.
  syncDeviceActionUi();
  // The Preferences device-scope control locks while the session is up; re-render
  // the modal if it is open (a link loss can end the session behind the scrim).
  prefs.refresh();
  // The surfaces that stream meters. Ordering is load-bearing and lives here for
  // that reason: the console subscribes, then the gate screen (if open) takes the
  // one broker slot back off it. Every way in and out of a session already passes
  // through this function, so a new path cannot desync them by forgetting a call.
  consoleView.setLive(on);
  dynScreen.setLive(on);
  // The sleep hold lives and dies with the session, so every way in and out of one
  // — the toggle, a write failure, a link loss — passes through here.
  void syncSleepHold(on && getSettings().preventSleep).then((failed) => {
    if (failed) showError(failed);
  });
}

// Turn live sync off and release the connection. Used by the toggle, by a write
// failure, and whenever the plan is replaced wholesale (loadPlan).
function deactivateLive(status?: string, end: LinkSessionEnd = "off"): void {
  if (!liveSessionUp) return;
  liveSessionUp = false;
  midi?.probeMark("live:off");
  // Nothing keeps the plan and the unit together from here, so the output side closes
  // until the next session's readback settles.
  midi?.liveEnded();
  follow?.end();
  live?.end();
  void releaseLive(liveEpoch, end);
  setLiveUi(false);
  // A CH → FX tap shown read-only while live becomes editable again off-line.
  refreshInspector();
  if (status) setStatus(status);
}

// A live/follow runtime error: stop sync, drop the connection, and surface the
// cause as a dialog (a mirror that did not complete). Several errors can arrive in
// one teardown (live + follow); deactivateLive clears liveSessionUp synchronously,
// so the second and later calls return here before re-showing the dialog.
function stopLiveOnError(message: string): void {
  if (!liveSessionUp) return;
  deactivateLive(undefined, "error");
  // The badge asserts something about the device on the other end of a link that
  // just went away, so it goes back to unknown rather than keeping a claim about
  // hardware that may no longer be attached.
  setFollowUsbBadge(null);
  showError(t().status.liveError(message));
}

// Whether the computer's idle sleep is currently held off, and the queue that
// keeps the OS calls in order — an off/on across two session transitions must not
// land reversed. Only the difference is sent, so a repeated target costs nothing.
let sleepHeld = false;
let sleepHoldChain: Promise<string | null> = Promise.resolve(null);

/** Drive the idle-sleep hold to `want`. Resolves with null once the OS agreed, or
 *  the refusal text — the caller decides where that lands (a status dialog for a
 *  session transition, the Preferences note for a toggle). */
function syncSleepHold(want: boolean): Promise<string | null> {
  sleepHoldChain = sleepHoldChain.then(async () => {
    if (want === sleepHeld) return null;
    const failed = await applyPreventSleep(want);
    // A refusal leaves sleepHeld alone: the OS did not move, so neither does the
    // app's idea of what it is holding.
    if (!failed) sleepHeld = want;
    return failed;
  });
  return sleepHoldChain;
}

// The one call that takes or releases the hold. Resolves with null once the OS
// took it, or the refusal text.
async function applyPreventSleep(on: boolean): Promise<string | null> {
  try {
    await setKeepAwake(on);
    return null;
  } catch (err) {
    return t().prefs.sleepFailed(errorText(err));
  }
}

// Undo / redo over the plan. Assigned below (after the views it re-renders exist),
// so every funnel reaches it optionally — the same shape as live / midi.
let planHistory: PlanHistory | null = null;

// An edit changed the plan: flag it unsaved and (when live) mirror it to the
// device. Every edit funnel routes through here so neither concern is forgotten.
// MIDI feedback also hangs off this funnel, so a mapped controller (motor fader /
// LED) follows edits made anywhere in the UI. The undo history opens its entry
// here too, and closes it at the next gesture boundary — which is why the diff is
// taken then and not now: several funnels mutate the plan further after calling.
function markChanged(source: WriteSource = "ui", written?: Iterable<string>): void {
  dirty = true;
  // Attribute the write before the funnel's own side effects run: note() may commit an
  // entry, and the ledger has to say who authored the keys that entry carries.
  traceProbe?.sample(source);
  // Name the keys for any device read in flight, so a value the app moved and moved back
  // inside the read's window is not overwritten by what the device held in between —
  // and, for a funnel that carries a patch, the keys it asserted without moving them.
  planWrites.note(written);
  live?.schedule();
  midi?.scheduleFeedback();
  planHistory?.note();
}

// Values entered the plan from somewhere other than an edit funnel (a device read, a
// follow notify, an external controller): no dirty flag and no live mirroring, but a
// mapped MIDI controller must still follow what the plan now holds, and the ledger must
// attribute the keys. Every such path funnels through here so the next one cannot
// forget it.
function planValuesChanged(): void {
  traceProbe?.sample("device-action");
  midi?.scheduleFeedback();
}

// A device readback of any breadth settled the plan (fetch, Live-sync start, the .urxf
// import). The history re-takes its whole baseline: a device-authored value must not
// ride along in the next entry, or undoing an app edit would push it back over the
// operator's own move on the hardware. The follow-side writers do NOT come through here
// — each settles the history at its own site, where what the device authored is known:
// a notify's own keys (applyDirect → absorb), a refetch's patch (refetchNodes →
// absorb), a reconcile's reset (reflectFollow's full branch), and the write-adoption's
// confirmed keys (adoptConfirmedWrites → absorb).
/** Whether the model has the microSD recorder at all. URX22 does not, so nothing about
 *  Track Count — a menu entry, a ceiling, a warning — belongs on it. Spelled once so the
 *  three sites that ask cannot drift apart.
 *
 *  Takes what the UNIT reported, which is a string and may name a model this build does
 *  not know. An unknown one is answered from the plan's model rather than from a guess:
 *  reading it as "no recorder" would drop a warning about a loss that cannot be undone. */
function hasRecorder(reported: string): boolean {
  const known = MODEL_IDS.includes(reported as ModelId);
  return getModel(known ? (reported as ModelId) : modelId).nodes.some((n) => n.id === SDREC_NODE_ID);
}

function planReadFromDevice(): void {
  planValuesChanged();
  // No full re-send here. This funnel is reached by a cancelled fetch and a partly
  // applied read as well as by a settled one — all three deliberately, since each may
  // have applied device values the history has to re-baseline. What none of them
  // establishes is that the plan IS the unit's state, and only that licenses putting
  // every mapped value on the wire (MidiControl.liveReadSettled, called where the
  // session is known to be up).
  planHistory?.rebase();
}

// SSMCS and COMP->EQ are exclusive on a MONO IN channel and share the DSP: on the
// device, switching COMP_EQ_TYPE loads the destination chain's factory values (the
// previous chain's edits are not carried across, so re-entering a chain always
// starts from factory). Mirror that offline so the plan never holds stale bank
// values the device would have reset. Only the destination bank is reset; the
// source bank's now-dormant values are harmless (re-entering it resets them too).
// GATE is type-independent and untouched.
//
// Under Live sync the same reset converges on the WRITE side: COMP_EQ_TYPE is
// sideEffect: "converge", so the flush runs a converge round that re-reads the write
// scope and pushes the plan back. Not follow's scoped read-back — this runs inside the
// app's own edit funnel, so the unit's answer is an echo and follow returns on it before
// arming anything. That is why this mirror is not optional: without it the plan keeps the
// outgoing bank's values and the converge pushes them onto the unit the device just
// reset, which is the reverse of what the first paragraph describes.
function resetCompEqBank(id: string, newType: number): void {
  const np = plan.nodeParams[id];
  if (!np) return;
  const factory = defaultPlan(modelId).nodeParams[id] ?? {};
  if (newType === COMP_EQ_SSMCS) {
    // Entering SSMCS: load the factory morphing strip ("01 Basic", fully engaged).
    np.ssmcs = structuredClone(factory.ssmcs ?? SSMCS_INITIAL);
    np.compOn = true;
    np.eqOn = true;
    // SSMCS has no discrete EQ stage, so the device drops PRE EQ from the Rec
    // Point list and moves a selected PRE EQ tap to PRE COMP; mirror that.
    if (np.recPoint === REC_POINT_PRE_EQ) np.recPoint = REC_POINT_PRE_COMP;
  } else {
    // Entering COMP->EQ: restore the factory comp / 4-band EQ / EQ 1-knob bank and
    // its section ONs. A field absent at the factory is cleared, not left stale.
    assignOrDelete(np, "comp", factory.comp);
    assignOrDelete(np, "eqBands", factory.eqBands);
    assignOrDelete(np, "eqOneKnob", factory.eqOneKnob);
    np.compOn = factory.compOn ?? false;
    np.eqOn = factory.eqOn ?? true;
  }
}

// Set a node param from the factory value, deleting it when the factory has none,
// so a reset never leaves a stale field behind (clone to keep the factory pristine).
function assignOrDelete<K extends keyof NodeParams>(np: NodeParams, key: K, value: NodeParams[K]): void {
  if (value === undefined) delete np[key];
  else np[key] = structuredClone(value);
}

const inspectorActions = {
  onDeleteConnection: (from: string, to: string) => graph.deleteConnection(from, to),
  // Mutate params in place without re-rendering, so the slider keeps focus while dragging.
  onUpdateParams: (from: string, to: string, patch: ConnParams) => {
    const conn = plan.connections.find((c) => c.from === from && c.to === to);
    if (!conn) return;
    // The destination bus's locks are what decide these controls exist at all
    // (mixSendLocks: the inspector drops the gated one, the console renders it
    // read-only, core/midi/controls.ts swallows the message). A device-side flip lands
    // in the plan a reflect before the panel is rebuilt, so a control the lock already
    // removed can still be on screen and live. Refuse its write rather than let a
    // phantom control author a value the next flush puts on the wire — name the lock
    // that refused it, and rebuild the panel so the control goes away now.
    const { busFixed, panLinked } = mixSendLocks(plan, parseRef(to).nodeId);
    const refusal =
      busFixed && patch.level !== undefined
        ? t().inspector.busFixedLevel
        : panLinked && patch.pan !== undefined
          ? t().inspector.panLinked
          : null;
    if (refusal) {
      setStatus(refusal);
      refreshInspector();
      return;
    }
    conn.params = { ...conn.params, ...patch };
    // A STEREO-linked pair in BAL mode moves as one: copy the same send change to
    // the partner channel, pan included — in BAL mode the pan is the pair's one
    // shared balance (see mirrorBalPair).
    const mirrored = mirrorBalPair(getModel(modelId), plan, parseRef(from).nodeId);
    markChanged();
    // A PRE/POST change flips the wire's pre-fader marker; a send ON/OFF or an OSC
    // L/R assign change flips the wire's (and its jacks') off-state dimming. Repaint
    // when any is in play. Level/pan carry no on-canvas marker, so they keep mutating
    // in place (slider keeps focus).
    if (patch.tap !== undefined || patch.on !== undefined || patch.oscL !== undefined || patch.oscR !== undefined)
      graph.repaintWires();
    // Refresh the console so a mirrored partner keeps up (a no-op while hidden).
    if (mirrored) consoleView.refresh();
    // OSC assign L/R are toggle buttons (not focus-holding sliders); re-render so
    // the pressed state updates at once. A PRE/POST change likewise re-renders so the
    // ducked-channel PRE-send note appears/clears with the tap.
    if (patch.oscL !== undefined || patch.oscR !== undefined || patch.tap !== undefined) refreshInspector();
  },
  onUpdateNodeParams: (id: string, patch: NodeParams, written?: readonly string[]) => {
    const prev = plan.nodeParams[id];
    const partner = partnerChannel(getModel(modelId), id);
    plan.nodeParams[id] = { ...prev, ...patch };
    // Signal Type / PAN-BAL move the pair's pans — and PAN-BAL itself on a link —
    // the way the unit does. Applied before the BAL mirror below, so the mirror
    // copies the settled values onto the partner. It names its own writes: every one
    // of them can land on the value already there, so nothing downstream can recover
    // them from the plan's diff.
    const transitionKeys =
      patch.stereoLink !== undefined || patch.panBal !== undefined
        ? applyPairTransition(getModel(modelId), plan, id, patch)
        : [];
    // A STEREO-linked pair in BAL mode moves as one: copy this channel's params to
    // the partner (the pair-level Signal Type / PAN-BAL fields stay on the primary).
    const mirrored = mirrorBalPair(getModel(modelId), plan, id);
    // The insert FX mirrors on Signal Type alone, PAN mode included (measured), so it
    // takes a pass of its own beside the BAL-gated mirror above. In BAL both run and
    // write the same values.
    const insFxMirrored = mirrorLinkedInsertFx(getModel(modelId), plan, id);
    // The patch's own keys, not only the ones whose value moved: this funnel asserts
    // every member it carries, and a device read in flight must not take back one that
    // happened to already hold the asserted value.
    //
    // A NESTED GROUP is the exception, and it is the default rather than a caller's
    // responsibility: every funnel edits one by REBUILDING it — one field set, the rest
    // copied — and the merge drops a named group WHOLE, so naming it hands the device's
    // answer for every untouched sibling away with it (measured: an OSC frequency the
    // unit moved during an OSC ON toggle was thrown out with the toggle's own key). A
    // group therefore falls through to the plan's own diff, which names the fields that
    // moved. A caller with a field that can be written WITHOUT moving names it itself, as
    // a dotted path — that is what `written` carries, and it replaces this derivation.
    const names = written ?? Object.keys(patch).filter((key) => typeof patch[key as keyof NodeParams] !== "object");
    const keys = [...names.map((name) => nodeParamContestPath(id, name)), ...transitionKeys];
    // A mirror asserts the PARTNER's keys the same way, and it can assert one that already
    // holds the value it writes — the insert-FX mirror re-writes a bypass that was already
    // on. Each names only what IT wrote, and for the BAL mirror that is THIS EDIT's keys,
    // not the whole record it copies: the other keys it carries over were already equal on
    // both sides, so copying them writes nothing, while claiming them takes the device's
    // answer away from the partner alone. Measured before the narrowing: a read that moved
    // both members' HPF, with an unrelated Phase edit inside it, left CH 1 on the device's
    // ON and CH 2 on the plan's OFF — one gesture splitting a pair that moves as one.
    const mirroredKeys = new Set<string>();
    if (mirrored) for (const name of names) mirroredKeys.add(name);
    if (insFxMirrored) for (const key of INSERT_FX_PAIR_KEYS) mirroredKeys.add(key);
    if (partner) for (const name of mirroredKeys) keys.push(nodeParamContestPath(partner, name));
    markChanged("ui", keys);
    // Two of the side effects below write the plan AFTER markChanged took the ledger
    // sample, so their keys would land in whatever samples next — under live follow a
    // device notify, which invariant 13 then reads as the device authoring a key the
    // operator moved. Re-sampled as this edit once the last of them has run.
    let lateWrite = false;
    const fx = nodeParamEffects(patch, prev);
    // Linking a pair snaps its partner next to the kept node so the tie isn't drawn
    // across a gap an earlier manual move may have opened.
    if (fx.alignStereoPair) {
      graph.alignStereoPair(id);
      lateWrite = true;
    }
    if (fx.repaintNodes) graph.repaintNodes();
    if (fx.repaintWires) graph.repaintWires();
    if (fx.rerender) graph.render();
    if (mirrored || insFxMirrored) consoleView.refresh();
    if (fx.resetCompEqBank) {
      resetCompEqBank(id, patch.compEqType as number);
      lateWrite = true;
    }
    if (lateWrite) traceProbe?.sample("ui");
    if (fx.refreshInspector) refreshInspector();
  },
  // Rename mutates in place and repaints the node label without re-rendering the
  // inspector, so the text input keeps focus while typing. Empty clears the override.
  onRenameNode: (id: string, name: string) => {
    // Normalized here as well as in the field itself: this is reachable from callers
    // other than that box, and a name goes to the unit. The field's own clip is length
    // only — it runs per keystroke, so it cannot drop trailing padding without eating
    // the space in `A B` as it is typed. This is where a committed one goes.
    const stored = normalizeNodeName(name);
    if (stored) plan.nodeNames[id] = stored;
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
  // Declared here but bound below: the dynamics screen's hooks reach back into
  // these actions, so it cannot be constructed until they exist.
  onOpenDynScreen: (kind: DynKind, id: string) => dynScreen.open(DYN_PROCESSORS[kind], id),
  onClose: () => graph.clearSelection(),
};
graph.setTheme(theme);
graph.setLabelSource(labelSource);
if (detectHideOffSends()) graph.setHideOffSends(true);

const labelsBtn = $("btn-labels");
const hideOffBtn = $("btn-hide-off");

function applyStaticI18n(): void {
  const m = t();
  $("lbl-model").textContent = m.toolbar.model;
  $("lbl-rate").textContent = m.toolbar.rate;
  // The badge's hint differs by state, so it cannot be relabelled from the
  // language alone — re-paint it from the state the session already holds.
  renderFollowUsbBadge();
  $("btn-new").textContent = m.toolbar.new;
  $("lbl-file").textContent = m.toolbar.file;
  $("btn-open").textContent = m.toolbar.open;
  $("btn-open-settings").textContent = m.toolbar.openSettings;
  $("btn-save").textContent = m.toolbar.save;
  $("btn-export").textContent = m.toolbar.exportPng;
  $("btn-export-pdf").textContent = m.toolbar.exportPdf;
  $("btn-licenses").textContent = m.licenses.title;
  const viewGraphBtn = $("btn-view-graph");
  viewGraphBtn.textContent = m.toolbar.viewGraph;
  viewGraphBtn.title = m.toolbar.viewGraphHint;
  const viewConsoleBtn = $("btn-view-console");
  viewConsoleBtn.textContent = m.toolbar.viewConsole;
  viewConsoleBtn.title = m.toolbar.viewConsoleHint;
  $("btn-auto").textContent = m.toolbar.arrange;
  $("btn-hide-unused").textContent = m.toolbar.hideUnused;
  $("lbl-device").textContent = m.toolbar.device;
  $("btn-fetch").textContent = fetchAbort ? m.toolbar.fetchCancel : m.toolbar.fetchDevice;
  $("btn-write").textContent = writeAbort ? m.toolbar.writeCancel : m.toolbar.writeDevice;
  $("btn-midi").textContent = m.midi.menuItem;
  $("btn-device-setup").textContent = m.deviceSetup.menuItem;
  $("btn-compare").textContent = compareAbort ? m.toolbar.compareCancel : m.toolbar.compare;
  $("btn-selftest").textContent = selfTestAbort ? m.toolbar.selfTestCancel : m.toolbar.selfTest;
  // Live-sync toggle keeps a static label; aria-pressed and the on-air tally
  // carry the on/off state. The tally is relabelled too — the tag is its whole
  // text, and a language may translate it.
  const liveBtn = document.getElementById("btn-live");
  if (liveBtn) {
    liveBtn.textContent = m.toolbar.liveSync;
    liveBtn.title = m.toolbar.liveSyncHint;
  }
  const liveTally = document.getElementById("live-tally");
  if (liveTally && live?.isActive()) liveTally.textContent = m.toolbar.liveTag;
  // View menu trigger.
  $("lbl-view").textContent = m.toolbar.view;
  $("btn-view").title = m.toolbar.viewHint;
  // Preferences gear (icon button; the glyph is an inline SVG).
  const prefsBtn = $("btn-prefs");
  prefsBtn.title = m.prefs.title;
  prefsBtn.setAttribute("aria-label", m.prefs.title);
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
  // Demo-only share / download buttons (same reveal mechanism as the link above).
  const shareBtn = $("btn-share");
  shareBtn.textContent = m.toolbar.shareUrl;
  shareBtn.title = m.toolbar.shareUrlHint;
  const downloadBtn = $("btn-download");
  downloadBtn.textContent = m.toolbar.downloadJson;
  downloadBtn.title = m.toolbar.downloadJsonHint;
}
applyStaticI18n();

// Both build-time hides below set the `hidden` attribute rather than an inline
// display, because that attribute is what the rest of the app reads to mean
// "not here": the menus' roving focus list filters on `[hidden]`, so an entry
// hidden any other way stays in the list, and End — or either arrow's wrap —
// hands focus to a control that is not on screen, which a real engine refuses
// to take: focus stays where it was. The browser build's File menu ends in the
// desktop-only Licenses entry, so that was all three of its gestures.
// `[hidden] { display: none !important }` in style.css is what makes the
// attribute win over an author `display`.

// The GitHub Pages demo is a viewer only: hide file persistence and image export.
if (DEMO) {
  for (const el of document.querySelectorAll<HTMLElement>("[data-demo-hide]")) {
    el.hidden = true;
  }
  // The demo is a viewer; surface a link to the desktop app (full file IO,
  // image export, and live device control) so visitors can find it.
  for (const el of document.querySelectorAll<HTMLElement>("[data-demo-only]")) {
    el.hidden = false;
  }
}

// Live hardware control and the bundled license notice need the Tauri shell
// (Rust commands / resources); hide their controls in a plain browser and the
// demo, where they could only fail.
if (!isTauri()) {
  for (const el of document.querySelectorAll<HTMLElement>("[data-control-hide]")) {
    el.hidden = true;
  }
}

function setStatus(msg: string): void {
  statusbar.textContent = msg;
}

// Surface an operation that did not complete as a modal, so it is not missed the
// way a transient status line can be. Clears the status line first so a stale
// progress message (e.g. "Connecting…") does not linger behind the dialog.
function showError(message: string): void {
  setStatus("");
  void errorDialog(message);
}

// A one-shot click handler, with the failure surface every one of them reports
// through. singleFlight fires its promise without awaiting it, so a rejection that
// names no sink reaches nothing — the handlers that have something specific to say
// still catch inside their own action, and this is the backstop under them.
const guarded = (run: () => Promise<void>): (() => void) =>
  singleFlight(run, (err: unknown) => showError(errorText(err)));

/** A focused inspector control, keyed by what NAMES it on screen rather than by
 *  position. The panel's sliders are bare `input[type=range]` with no class, so an
 *  index key would hand focus to whatever control moved into the slot when a lock
 *  removed the focused one — the case this restore exists for. The parameter row's
 *  label is the discriminator (Pan vs Level), taken from the `data-param-label`
 *  paramBlock stamps while building the row rather than searched for again here: this
 *  runs once per candidate control on a path that repeats at ~20 Hz during device
 *  follow. No match on the rebuilt panel = focus is dropped, which is the wanted
 *  outcome. */
function inspectorFocusKey(el: HTMLElement): string {
  const label = el.closest<HTMLElement>(".param")?.dataset.paramLabel ?? "";
  const type = el instanceof HTMLInputElement ? el.type : "";
  return [label, el.tagName, type, el.className, el.textContent?.slice(0, 24) ?? ""].join("|");
}

/**
 * Those keys made unique, by appending each control's ordinal among the ones sharing
 * its key.
 *
 * The label is not a discriminator on its own, because rows legitimately repeat one:
 * every section's ON/OFF row carries the EMPTY label, since its name is in the section
 * heading above it, so a channel's GATE / COMP / EQ toggles are one key between them.
 * `find` returns the FIRST match, so the restore did not drop focus — which is the
 * documented fallback and would have been fine — it handed focus to a different
 * section's control, and the operator's next keypress operated that one and wrote it to
 * the device.
 *
 * Built for the whole host in ONE pass, and used from both ends of the rebuild: keying
 * each element by scanning its siblings would be quadratic on a path that repeats at
 * ~20 Hz during device follow, which is what the key's own note is about.
 */
function inspectorFocusKeys(): Map<HTMLElement, string> {
  const els = focusables(inspectorHost);
  const seen = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const el of els) {
    const k = inspectorFocusKey(el);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const out = new Map<HTMLElement, string>();
  for (const el of els) {
    const k = inspectorFocusKey(el);
    if ((counts.get(k) ?? 0) < 2) {
      out.set(el, k);
      continue;
    }
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    out.set(el, `${k}|#${n}`);
  }
  return out;
}

// The scroll offset a rebuild has to carry over. Tracked from the element's own scroll
// event instead of read back at rebuild time: the reflect that rebuilds this panel has
// just dirtied layout (repaintDirtyNodes / refreshStrip), so a read there flushes it
// synchronously, and that path repeats at ~20 Hz while device follow is running — a
// forced layout costs several times more in WebKit than in Chromium. Passive, so it
// never holds up the scroll it is observing.
let inspectorScrollTop = 0;
inspectorHost.addEventListener(
  "scroll",
  () => {
    inspectorScrollTop = inspectorHost.scrollTop;
  },
  { passive: true },
);

// A rebuild made while an IME composition is in flight (a node name being typed in
// kana) would commit its interim characters as literal text and restart it — once per
// device-driven reflect, ~20 Hz through a knob sweep. Held until the composition ends,
// then run once.
// The deferred run takes the UNGATED rebuild: the gate has already cleared `composing` by
// the time it fires, so routing it back through refreshInspector would only re-ask a
// question it just answered.
const inspectorComposition = compositionGate(inspectorHost, () => rebuildInspector());

function refreshInspector(): void {
  if (inspectorComposition.held()) return;
  rebuildInspector();
}

/**
 * The same rebuild, past whatever the gate was holding, for a change the OPERATOR made.
 *
 * The gate exists for the refresh nobody asked for: a device follow or a MIDI sweep
 * arriving at up to 20 Hz while a name is being typed or a dropdown is open. A selection
 * change and an undo are the other kind. Held, the panel goes on showing the node the
 * operator has left, or the value the undo has just replaced — and the control it is held
 * FOR is the one displaying that stale value, because choosing in a select leaves focus
 * on it. The gate is reset rather than merely bypassed: the rebuild removes the composing
 * field, an end event for a field that is gone may never arrive, and a latched flag stops
 * the panel updating for the rest of the session.
 */
function rebuildInspectorNow(): void {
  inspectorComposition.reset();
  rebuildInspector();
}

// The rebuild itself, with no gate in front of it. Split out for the gate's own deferred
// run above, and for the dev keyboard harness, which drives the gated and ungated arms of
// the IME measurement side by side (ui/keyprobe.ts).
function rebuildInspector(): void {
  // The console view hides this panel for as long as it is up, and a device follow
  // rebuilds it at up to 20 Hz regardless. Deferred rather than dropped: setView does
  // the one rebuild on the way back, the same shape graphDirty gives the graph.
  if (inspectorHost.hidden) {
    inspectorDeferred = true;
    return;
  }
  // Cleared here rather than only at the drain: the panel becomes visible before the
  // drain runs, so anything that rebuilds it in between — a selection dropped by the
  // graph's own refresh — has already paid what the flag was owed.
  inspectorDeferred = false;
  // On mobile the inspector is a bottom sheet that slides up only while something
  // is selected; this flag drives that state (no effect on the desktop panel).
  document.body.classList.toggle("has-selection", selection !== null);
  // A device-follow reflect rebuilds this panel while the operator may be inside it,
  // and replaceChildren drops both the scroll offset and keyboard focus. Carry them
  // over (preserveFocus, the shared capture/restore the console rebuild uses too); a
  // text surface also carries its caret, since the plan already holds every keystroke
  // and the rebuilt field would otherwise jump to the end. Held on an object rather
  // than in a plain local so the value the capture writes survives to the restore.
  const carried: { caret: readonly [number | null, number | null] | null } = { caret: null };
  const restoreFocus = preserveFocus(
    inspectorHost,
    (active) => {
      if (ownsNativeUndo(active) && active instanceof HTMLInputElement)
        carried.caret = [active.selectionStart, active.selectionEnd];
      return inspectorFocusKeys().get(active);
    },
    (key) => {
      const keys = inspectorFocusKeys();
      return focusables(inspectorHost).find((el) => keys.get(el) === key);
    },
    () => inspectorScrollTop,
  );
  renderInspector(
    inspectorHost,
    getModel(modelId),
    plan,
    selection,
    inspectorActions,
    recent,
    live?.isActive() ?? false,
  );
  const focused = restoreFocus();
  if (carried.caret && focused instanceof HTMLInputElement)
    focused.setSelectionRange(carried.caret[0], carried.caret[1]);
}

// Recompute the sample-rate constraints and apply them to the graph badges, the
// inspector warnings and the console (the stereo EQ chip locks at 176.4 / 192 kHz).
// Each of the three decides for itself whether the new state needs drawing now: the
// board is deferred while the console view is up, the panel while the graph view is.
function applyRateConstraints(): void {
  const c = rateConstraints(getModel(modelId), plan.sampleRate);
  // Asked before the store, so the answer is about the board on screen. A set that
  // moved while the console view is up owes the graph a repaint it must not do here:
  // graphDirty is the same deferral the follow reflect uses two lines from its own.
  if (graphHost.hidden && !graph.hasDisabledNodes(c.disabledNodes)) graphDirty = true;
  graph.setDisabledNodes(c.disabledNodes);
  refreshInspector();
  consoleView.refresh();
}

// After a device readback, mirror the device's sample rate into the picker and
// re-apply the rate-dependent constraints (which also refreshes the inspector).
function syncRateUi(): void {
  ratePicker.value = String(plan.sampleRate);
  // A rate that arrived from the device counts as the last known rate, exactly like
  // one picked by hand. The same person operates both the app and the hardware, so
  // a rate set on the device's own front panel is no less their choice — and a new
  // plan started afterwards should open at the rate their rig is actually running.
  rememberRate(plan.sampleRate);
  applyRateConstraints();
}

// Re-render the plan in place, without loadPlan's ownership side effects (it
// clears dirty, leaves live sync, and re-seeds the persisted model/rate/hidden).
// Used wherever the plan's contents changed under the same document: a Fetch, a live
// session's readback, and a `.urxf` settings import — the three callers below.
function rerenderPlan(): void {
  graph.setModel(getModel(modelId), plan);
  selection = null;
  syncRateUi(); // also re-renders the CONSOLE strips (applyRateConstraints)
  // Every value here was re-authored — by the device or by the settings file — so the
  // entries recorded against the old contents describe states this plan cannot return
  // to.
  planHistory?.reset();
}

// Reflect an undo / redo whose patch is already applied to the plan. Modelled on
// reflectFollow's fine-grained path rather than rerenderPlan, whose setModel refits
// the viewport — an undo must not reframe the canvas. The plan object is never
// replaced, so nothing needs re-pointing; what needs doing is re-deriving the view
// state held outside the plan and repainting.
function reflectHistory(touch: PatchTouch): void {
  // The patch is already applied by the time the reflect runs, so the ledger is taken
  // here — an undo is a writer like any other, and attributing its keys to "ui" would
  // make a restored value indistinguishable from a fresh edit.
  traceProbe?.sample("undo");
  // Before the repaints: commitHidden writes the graph's own set back to the plan,
  // so the persisted mirror has to move first or a later commit would undo the undo.
  if (touch.fields.has("hidden")) rememberHidden(modelId, plan.hidden);
  if (graphHost.hidden) graphDirty = true;
  else graph.refresh();
  dynScreen.refresh();
  // syncRateUi already repaints both through applyRateConstraints, so the two are
  // exclusive — stacking them cost a second full strip rebuild (~9 ms on WebKit).
  // Past the gate: an undo re-authors the plan, and what it replaced is exactly what the
  // control holding the gate is displaying — a select keeps focus after a choice is made
  // in it, so the panel would go on showing the value that was just undone.
  inspectorComposition.reset();
  if (touch.fields.has("sampleRate")) {
    syncRateUi();
  } else {
    rebuildInspector();
    consoleView.refresh();
  }
  // Last, so the live diff measures the settled plan. This is also what carries the
  // change to the device: live.ts diffs its snapshot, so only the undone keys go
  // out. resync() must NOT be called — it would re-base the snapshot to the plan
  // and suppress the very write the undo needs.
  markChanged();
}

// Read the whole device into the plan, honoring the Preferences device scope:
// the read itself stays full (reads are side-effect free on the device), but
// under the "scene" scope the plan keeps its scene-external values. Shared by
// fetch, the Live-sync starting read, and device-follow's full reconcile. On a
// throw (abort / link loss) nothing is restored — the callers discard or keep
// the plan wholesale. The plan is a parameter rather than the module one because the
// read spans seconds: re-reading it after the await would apply the outgoing document's
// scene-external values to whatever replaced it.
async function applyDeviceStateScoped(
  target: Plan,
  signal?: AbortSignal,
  pending?: PendingWrites,
): Promise<ReadbackResult> {
  // Counted at the operation, not at its callers: the broker only ever sees the ~800
  // commands this decomposes into, so `reads` is the one ledger row nothing downstream
  // can reconstruct — and a count derived at each call site is only right for as long
  // as every future caller remembers a second, unrelated line. A no-op outside a
  // session (the tracker guards it), so the Fetch button costs nothing here.
  linkLedger?.noteFullRead();
  const keep = getSettings().deviceScope === "scene" ? captureSceneExternal(target) : null;
  const result = await applyDeviceState(getModel(modelId), target, signal, undefined, pending);
  if (keep) applySceneExternal(target, keep);
  return result;
}

// A fresh plan, opened at the rate this session last worked at. The model picker
// already keeps the last model across New; the rate belongs to the same rig and
// does not change because a new plan was started. newPlan itself stays at the
// module default — it is a pure core function, and the persisted choice is the
// shell's business (the startup plan takes the same detectRate path).
function newPlanAtLastRate(id: ModelId): Plan {
  const next = newPlan(id);
  setPlanSampleRate(next, detectRate(next.sampleRate));
  return next;
}

/** Replace the open document. Returns false when the replacement did not happen — a
 *  device read holds the plan, or the new one could not be drawn — and the caller must
 *  not then report the load as having happened. Both refusals report themselves, so no
 *  caller needs a failure surface of its own. */
function loadPlan(next: Plan): boolean {
  // A device read (fetch / Live-sync start) is merging into the module `plan`;
  // replacing it now would strand the merge (see deviceReadInFlight). Every external
  // entry point is already blocked at fileFlow / the model picker, so this is the
  // backstop — and it says so, because its one reachable caller went on to announce a
  // load that never happened.
  if (flow.deviceReadInFlight) {
    setStatus(t().status.busyDeviceRead);
    return false;
  }
  // Replacing the whole plan invalidates the live snapshot; leave sync first.
  // (Live's own enable path calls loadPlan before begin(), so this is a no-op there.)
  deactivateLive();
  // deactivateLive drops the subscription and the timers, but a reconcile / refetch
  // already awaiting the device is not reachable from there — the read itself is what
  // still points at the plan being replaced.
  abandonFollowWork();
  // Everything that puts the module state on screen. One definition, called twice: the
  // document is committed before anything draws it — every view reads the module `plan`,
  // so a staged apply would mean threading the document through all of them — and a plan
  // that parses and then cannot be rendered used to leave `plan` and `modelId` moved
  // while the history, the MIDI bindings and the rate UI still described the document
  // that is gone (an undo then applied entries diffed against a plan nothing holds). Two
  // hand-kept lists would put the next view added here into only one of them, which is
  // the failure the rollback exists to prevent.
  const draw = (): void => {
    rememberModel(modelId);
    // Keep the persisted hidden layout in step with the plan now on screen, whether
    // it came from a file (its hidden wins) or a fresh new/switch plan (already
    // seeded from the same store, so this is a no-op).
    rememberHidden(modelId, plan.hidden);
    picker.value = modelId;
    graph.setModel(getModel(modelId), plan);
    syncRateUi(); // picker + persisted rate + constraints (also refreshes the console)
    // A channel tuning screen can be open over this: it reads the plan through a closure,
    // so its values are already the new ones — but nothing had told it to redraw, and it
    // sat showing the plan that was just replaced. Refresh re-resolves the binding too, so
    // a screen whose node or processor the new plan does not have closes itself.
    dynScreen.refresh();
  };
  const prevModelId = modelId;
  const prevPlan = plan;
  const prevDirty = dirty;
  modelId = next.modelId;
  plan = next;
  traceProbe?.sample("load");
  ensureFixedConnections(getModel(modelId), plan);
  selection = null;
  try {
    draw();
    dirty = false;
  } catch (err) {
    // Put the previous document back on screen and report, rather than throwing: three
    // of the four callers pass an app-generated plan and do not catch, so a throw would
    // reach an async fileFlow callback as an unhandled rejection — no status line, no
    // dialog, a canvas that stopped. The restore re-renders a plan that has already
    // rendered once, so it cannot fail in turn. Not restored, none of it recoverable
    // here: the live session (its snapshot was captured for a plan this call set out to
    // replace, and leaving sync is the same answer either way), the selection, and the
    // fixed connections `ensureFixedConnections` added to `next`.
    modelId = prevModelId;
    plan = prevPlan;
    dirty = prevDirty;
    draw();
    showLoadError(err);
    return false;
  }
  // A new document: the model can differ (so an entry's node ids may not exist
  // here), `plan` is a different object, and the operator already confirmed the
  // discard. Reset rather than rebase.
  planHistory?.reset();
  // Reload the (per-model) MIDI mappings and resync the controller to the new plan.
  midi?.onModelChanged();
  return true;
}

// Build a copyable, language-stable report of a plan's violations, so it can be
// pasted back to the tool that generated the plan. One line per problem, keyed by
// its code: a wire prints "[reason] from -> to" (the routing ConnectError codes
// and the plan's "nodeId:portId" refs), an insert-FX slot collision the contended
// slot and every node claiming it — it has no endpoints to name.
//
// The first line carries which of the two classes this is, because the report is
// read away from the modal that framed it: pasted into the tool that generated
// the plan, or into a message. A slot collision offers "load anyway" and the plan
// does load, so a report of one that opened with "validation failed" told the
// generating tool to fix a document the app had already accepted.
function buildPlanReport(model: string, problems: LoadProblem[], refused: boolean): string {
  return [
    refused ? "URX Router plan validation failed" : "URX Router plan validation warnings",
    `model: ${model}`,
    `problems: ${problems.length}`,
    "",
    ...problems.map((p) => {
      if (p.reason === "insertFxSlot") return `[${p.reason}] ${p.slot}: ${p.nodes.join(", ")}`;
      if (p.reason === "paramRange") {
        // JSON rather than String(): a stored value is a number in the ordinary case but can be
        // a boolean or an object, and `[object Object]` names neither what was there nor why.
        const was = JSON.stringify(p.stored);
        return `[${p.reason}] ${p.node}.${p.key}: ${was} -> ${p.action === "drop" ? "(dropped)" : p.bound}`;
      }
      return `[${p.reason}] ${p.from} -> ${p.to}`;
    }),
  ].join("\n");
}

// Parse text into a plan, load it, and (when it came from a real path) record it
// as a recent plan. Returns true on success and false on failure (which sets the
// error status); null when the plan carries a problem the operator has been asked
// about — nothing has loaded and nothing has failed, and the load runs from the
// report modal if they proceed.
function loadFromText(text: string, path?: string): boolean | null {
  try {
    const doc = deserializeDocument(text);
    const next = doc.plan;
    if (!MODEL_IDS.includes(next.modelId)) {
      showError(t().status.loadError(t().error.unknownModel(next.modelId)));
      return false;
    }
    // A scene-scoped file (Preferences > Plan files) omits the device-wide
    // settings; keep the current plan's values for them — the same semantic as a
    // scene recall on the unit. Only within the same model: another model's
    // monitor / patch wiring would not validate on this one.
    if (doc.sceneScoped && next.modelId === plan.modelId) applySceneExternal(next, captureSceneExternal(plan));
    // Surface every violation as a copyable report. A device readback runs neither
    // check — the unit is the authority for what it is actually running — which is
    // what splits the two classes: illegal routing is a plan this app cannot
    // represent and stays a refusal, while two nodes on one device-wide insert-FX
    // slot is a plan the app itself writes after a readback, so refusing it made
    // Fetch → Save → reopen impossible for its own document. That one warns and
    // offers to open anyway.
    const problems = planProblems(getModel(next.modelId), next);
    const refused = problems.filter(isRefusal);
    if (refused.length > 0) {
      showLoadReport(buildPlanReport(next.modelId, refused, true));
      return false;
    }
    // Repaired before the document opens, so what the panel shows and what the write sends
    // are the same number from here on. The count goes on the status line rather than into
    // a modal: nothing failed and nothing is being asked, which is where architecture.md
    // puts a partial success. It is applied even when a decision below holds the load,
    // because the plan the operator is deciding about is this one.
    const ranged = problems.filter((p) => p.reason === "paramRange");
    applyParamRange(next, ranged);
    const finishLoad = (): boolean => {
      // Refused (a device read holds the plan): loadPlan said so, and the caller must
      // not go on to remember a recent path and announce a document that never opened.
      if (!loadPlan(next)) return false;
      // LEADS the line rather than trailing it. The status bar is one ellipsized line and a
      // file name has no length limit, so a notice placed after the name is off screen for a
      // long one. This is the only thing said about a document the loader changed, and a
      // repair that reports nothing is the defect the report exists to prevent.
      // Two counts, not one: a bound moves a value to the nearest one this app can send, while
      // a drop removes what it could not read at all and leaves the effect on its own default.
      // Said with the bounded sentence alone, a document whose values were discarded is told
      // they were adjusted.
      const boundCount = ranged.filter((p) => p.action === "bound").length;
      const dropCount = ranged.length - boundCount;
      const notes = [
        ...(boundCount > 0 ? [t().status.paramsBounded(boundCount)] : []),
        ...(dropCount > 0 ? [t().status.paramsDropped(dropCount)] : []),
      ];
      const line = (what: string): string => [...notes, what].join(" — ");
      if (path) {
        recent = rememberRecent({ path, name: baseName(path), modelId }, getSettings().recentMax);
        refreshInspector();
        setStatus(line(t().status.openedFrom(baseName(path))));
      } else {
        setStatus(line(t().status.planLoaded));
      }
      return true;
    };
    const decisions = problems.filter(needsDecision);
    if (decisions.length > 0) {
      const m = t().loadReport;
      showLoadReport(buildPlanReport(next.modelId, problems, false), {
        title: m.slotTitle,
        intro: m.slotIntro,
        // This one runs from the modal's click handler, outside the try below — which
        // has already returned by then. Safe because the only step it takes that can
        // fail is `loadPlan`, and that reports and returns false rather than throwing.
        proceed: { label: m.loadAnyway, run: () => void finishLoad() },
      });
      // Neither loaded nor failed: the decision is on screen. Null rather than false,
      // so a recent entry pointing at a file that opens perfectly well is not dropped
      // as unloadable while its report is still up.
      return null;
    }
    return finishLoad();
  } catch (err) {
    showLoadError(err);
    return false;
  }
}

/** The one load-failure surface: every path that fails to open a document reports here,
 *  including `loadPlan`'s own render failure, which is reached from callers that have no
 *  try of their own. */
function showLoadError(err: unknown): void {
  const message = err instanceof PlanError ? t().error[err.code] : errorText(err);
  showError(t().status.loadError(message));
}

// Open a plan from wherever its document comes from — the Open dialog, a recent
// path, a dropped file — with the one discard prompt and the one failure surface
// all three share. `read` resolves null when its dialog was canceled; `path` is
// what the plan is remembered by, so it is absent for a browser pick or drop.
// Resolves true on success, false when the load was attempted and failed, and
// null when nothing was attempted (canceled, another file flow in flight, or the
// plan's problem is on screen for the operator to decide on).
async function openPlanFrom(read: () => Promise<{ text: string; path?: string } | null>): Promise<boolean | null> {
  return fileFlow(async () => {
    if (!(await confirmDiscard())) return null;
    try {
      const doc = await read();
      if (!doc) return null;
      return loadFromText(doc.text, doc.path);
    } catch (err) {
      showLoadError(err);
      return false;
    }
  });
}

async function openRecent(path: string): Promise<void> {
  const outcome = await openPlanFrom(async () => ({ text: await readTextByPath(path), path }));
  // An entry whose file no longer loads (moved / deleted / corrupted) is
  // dropped automatically — keeping it would only reproduce the same error —
  // and the status line says so, since the mutation happened without a prompt.
  if (outcome === false) {
    recent = removeRecent(path);
    refreshInspector();
    setStatus(t().status.recentRemoved(baseName(path)));
  }
}

async function confirmDiscard(): Promise<boolean> {
  if (!dirty) return true;
  return confirmDialog(t().confirm.discard);
}

// One plan/settings file flow at a time across every entry point (File > New /
// Open / Save, a recent row, a window drop, the .urxf import): each latch above
// is private to its handler, so this shared one is what keeps rapid repeat
// across any two of them from stacking discard confirms and file dialogs.
//
// Its `deviceReadInFlight` half covers a different hazard: a device read (fetch /
// Live-sync start) passes the module `plan` by reference into applyDeviceState,
// which mutates it across many awaited round-trips, and its epilogue re-reads the
// module `plan`. Nothing disables the file / model entry points during that
// seconds-long window, so a New / Open / drop / recent / .urxf or a model switch
// mid-read would swap `plan` out from under the read — corrupting it, or (on Live
// start) snapshotting the swapped-in plan as device truth. The two reads raise it
// and clear it in their finally; every wholesale plan replacement checks it. The
// internal model-switch loadPlan runs before the latch is raised.
//
// The third latch is `deviceLinkHolder` (declared with the lock it drives, above):
// whoever holds the device link, including the destructive runs, which are the reason
// the MIDI gate reads it. Minutes long, unlike the two here.
const flow = new FileFlowLatch({
  // Refused, and said so: the flow the operator picked simply does not happen, and the
  // status line is showing the read's own progress rather than an answer to that click.
  onDeviceReadBusy: () => setStatus(t().status.busyDeviceRead),
  // The MIDI gate's reported window ends with the latch (see MidiEngine.gateReleased).
  onReleased: () => midi?.gateReleased(),
});
const fileFlow = <T>(run: () => Promise<T>): Promise<T | null> => flow.run(run);

// Warn before touching a unit whose System firmware differs from the version this
// build was validated against — the parameter mappings may not match. Returns true
// to proceed (matching firmware, or the user chose to continue), false to abort.
async function confirmFirmware(device: DeviceSummary): Promise<boolean> {
  // An unread version is not a missing one: proceeding would silently disable the
  // very check that decides whether this build's parameter mappings apply.
  if (device.firmware === null) {
    showError(t().error.firmwareUnread);
    return false;
  }
  if (!firmwareMismatch(device.firmware)) return true;
  // Preference-suppressible (Preferences > Warnings): the mismatch becomes a
  // silent proceed, but an unreadable version above stays a hard stop.
  if (!getSettings().warnFirmware) return true;
  return confirmDialog(t().confirm.firmwareMismatch(device.firmware, SUPPORTED_SYSTEM_FIRMWARE));
}

// The connected device may be a different model than the one selected. Fetch and
// Live sync offer to switch the UI to a fresh plan of the device's model so the
// device values map onto the right channels; write and compare refuse instead (they
// act on the current plan — see refuseModelMismatch). Returns "ready" to proceed
// (same model, or switched), "unknown" for a model this build does not know, and
// "canceled" when the switch was declined; the caller formats its own message for
// the two stops. The loadPlan here runs before any device-read latch is raised.
async function offerModelSwitch(device: DeviceSummary): Promise<"ready" | "unknown" | "canceled"> {
  if (device.model === modelId) return "ready";
  if (!MODEL_IDS.includes(device.model as ModelId)) return "unknown";
  if (!(await confirmDialog(t().confirm.switchModel(device.model, modelId)))) return "canceled";
  loadPlan(emptyPlan(device.model as ModelId));
  return "ready";
}

// Refuse to act on a device whose model differs from the plan's — the plan's
// channels would map onto the wrong hardware. Shared by write and compare, which
// (unlike fetch / Live sync) cannot offer to switch: they act on the plan as it is.
// `wrap` builds the action-specific error message from the mismatch text. Returns
// true to proceed, false when it refused (having surfaced the error).
function refuseModelMismatch(device: DeviceSummary, wrap: (message: string) => string): boolean {
  if (device.model === modelId) return true;
  showError(wrap(t().error.modelMismatch(device.model, modelId)));
  return false;
}

picker.addEventListener("change", async () => {
  const next = picker.value as ModelId;
  if (next === modelId) return;
  // The same shared latch File > New / Open / drop / recent use: the switch runs the
  // one discard confirm + a wholesale plan replacement, so it must not stack with
  // another file flow, and it is refused while a device read holds the plan.
  const switched = await fileFlow(async () => {
    if (!(await confirmDiscard())) return false;
    loadPlan(newPlanAtLastRate(next));
    // A different model is plausibly a different unit, so what was read from the last
    // one is no longer a claim we can make.
    setFollowUsbBadge(null);
    setStatus(t().status.switchedModel(next));
    return true;
  });
  // Declined discard, another file flow held the latch (null), or a device read
  // refused it: restore the picker to the model still on screen.
  if (!switched) picker.value = modelId;
});

ratePicker.addEventListener("change", () => {
  // The recorder's Track Count goes with the rate, one way: see setPlanSampleRate.
  setPlanSampleRate(plan, Number(ratePicker.value));
  // Same change funnel as every other edit: dirty + (in Live sync) push the new
  // rate to the device. Re-clocking glitches audio, but that is inherent to a
  // deliberate rate change and keeps Live sync from deferring it onto a later edit.
  markChanged();
  syncRateUi(); // the picker assignment is a no-op here — it is the source
  setStatus(t().status.sampleRate(formatRate(plan.sampleRate)));
});

$("btn-new").addEventListener(
  "click",
  () =>
    void fileFlow(async () => {
      if (!(await confirmDiscard())) return;
      loadPlan(newPlanAtLastRate(modelId));
      setStatus(t().status.newPlan);
    }),
);

$("btn-open").addEventListener(
  "click",
  () => void openPlanFrom(() => openTextDocument({ ext: "json", label: t().filter.plan })),
);

// Fine-tuning mode: holding Shift tightens the step of the controls whose device
// parameter has a verified fine grid (see ui/fine.ts).
initFineMode();

// Drag & drop, the second way into File > Open. A dropped plan lands exactly as it
// would from the dialog — same validation, same recent-list entry when the drop
// carried a real path. The experimental settings-file import registers "urxf" here
// once its gate resolves (see the !DEMO block below); until then nothing takes it,
// and the caption and the refusal both name whatever is registered at that moment.
const dropzone = initDropzone({
  caption: (accepted) => (accepted.includes("urxf") ? t().dropzone.planOrSettings : t().dropzone.plan),
  // A refused drop is a routine "not that file" — the status line, not a modal.
  onReject: (rejection, name, accepted) => {
    setStatus(
      rejection === "multiple"
        ? t().status.dropMultiple
        : accepted.includes("urxf")
          ? t().status.dropUnsupportedSettings(name)
          : t().status.dropUnsupported(name),
    );
  },
});
dropzone.register("json", (file) => void openPlanFrom(async () => ({ text: await file.text(), path: file.path })));

$("btn-save").addEventListener(
  "click",
  () =>
    void fileFlow(async () => {
      // A failed write must keep the plan dirty and surface as a modal, like the
      // load paths do — a silent rejection would read as a successful save.
      try {
        const res = await saveTextDocument(`${modelId}-plan.json`, serialize(plan, sceneSaveOpts()), {
          ext: "json",
          label: t().filter.plan,
        });
        if (!res.saved) {
          setStatus(t().status.canceled);
          return;
        }
        dirty = false;
        if (res.path) {
          recent = rememberRecent({ path: res.path, name: baseName(res.path), modelId }, getSettings().recentMax);
          refreshInspector();
          setStatus(t().status.savedTo(baseName(res.path)));
        } else {
          setStatus(t().status.planSaved);
        }
      } catch (err) {
        showError(t().status.saveError(errorText(err)));
      }
    }),
);

// Demo-only sharing (the buttons stay hidden outside the demo build, but are
// wired unconditionally so the dev-server E2E can drive them): the demo has no
// file IO, so the plan travels as a ?plan= deep link — the same encoding
// loadPlanFromUrl reads — or as a JSON download the desktop app opens.
$("btn-share").addEventListener(
  "click",
  guarded(async () => {
    const url = new URL(location.href);
    url.search = "";
    url.hash = "";
    // Encoding compresses via the platform CompressionStream; surface a failure
    // as a modal rather than silently copying nothing. A missing deflate-raw
    // codec arrives as the typed browser-floor PlanError, same as the decode path.
    try {
      url.searchParams.set("plan", await encodePlanParam(plan, sceneSaveOpts()));
    } catch (err) {
      showError(err instanceof PlanError ? t().error[err.code] : t().status.shareUrlError(errorText(err)));
      return;
    }
    const link = url.toString();
    // Put the link in the address bar first, so it stays copyable by hand when
    // the clipboard is unavailable (insecure context) or rejects the write.
    try {
      history.replaceState(null, "", link);
    } catch {
      // ignore (history unavailable)
    }
    void copyText(link).then((ok) => setStatus(ok ? t().status.shareUrlCopied : t().status.shareUrlInBar));
  }),
);

$("btn-download").addEventListener("click", () => {
  // The demo's stand-in for Save: the downloaded JSON matches a desktop save,
  // so File → Open on the desktop app loads it as-is.
  downloadText(`${modelId}-plan.json`, serialize(plan, sceneSaveOpts()));
  dirty = false;
  setStatus(t().status.planDownloaded);
});

$("btn-export").addEventListener(
  "click",
  guarded(() =>
    graph
      .exportPng(`${modelId}-routing.png`)
      .catch((err: unknown) => showError(t().status.exportError(errorText(err)))),
  ),
);

$("btn-export-pdf").addEventListener(
  "click",
  guarded(() =>
    graph
      .exportPdf(`${modelId}-routing.pdf`)
      .catch((err: unknown) => showError(t().status.exportError(errorText(err)))),
  ),
);

// Third-party license notice (desktop only): the cargo-about page bundled as a
// Tauri resource, parsed and rendered as app DOM (ui/licenses.ts).
$("btn-licenses").addEventListener(
  "click",
  // .catch (not a rejection handler on .then): a notice that reads fine but
  // fails to parse in showLicenses must land in the same error dialog.
  guarded(() =>
    thirdPartyLicenses()
      .then(showLicenses)
      .catch((e: unknown) => showError(t().licenses.error(errorText(e)))),
  ),
);

// The plan-file save scope (Preferences > Plan files), shared by every
// serialize call site: file save, demo JSON download, and the share URL.
function sceneSaveOpts(): SerializeOptions {
  return { sceneOnly: getSettings().saveScope === "scene" };
}

// Preferences modal (the toolbar gear): available in every build; rows that need
// the desktop shell render locked with a tag instead (see ui/prefs.ts).
const prefs = new PrefsPanel({
  isLive: () => liveSessionUp,
  onRecentChanged: (list) => {
    recent = list;
    refreshInspector();
  },
  onWarningsChanged: () => refreshInspector(),
  // The FINE tag hint names the entry style at build time; rebuild both views so
  // the hint follows a style change.
  onFineChanged: () => {
    refreshInspector();
    consoleView.refresh();
  },
  checkUpdates: () => {
    // DEMO folds statically, so the demo bundle keeps dropping the updater path
    // (the button is desktop-only anyway; this branch is unreachable).
    if (DEMO) return Promise.resolve<UpdateCheckOutcome>({ kind: "failed" });
    return checkForUpdates();
  },
  // Off-line there is nothing to take: the preference is stored on its own and
  // the hold is taken when a session starts. While live it applies at once, so a
  // refusal reaches the row that asked for it.
  setPreventSleep: (on) => (liveSessionUp ? syncSleepHold(on) : Promise.resolve(null)),
  isExperimental: () => experimentalOn,
  themeMode: () => themeMode,
  onThemeMode: (mode) => setThemeMode(mode),
});
$("btn-prefs").addEventListener("click", () => prefs.open());

// Dynamics tuning screens (GATE / COMP). Opened per MONO IN channel from the
// inspector's matching section and from the CONSOLE strip; one host serves both,
// so opening either replaces whatever was on it. It owns the broker's one meter
// slot while open, which is why the console is told to release and regain it
// rather than discovering the swap from frozen bars.
const dynScreen = new DynScreen({
  getModel: () => getModel(modelId),
  getPlan: () => plan,
  isLive: () => liveSessionUp,
  onUpdateNodeParams: (id, patch, written) => inspectorActions.onUpdateNodeParams(id, patch, written),
  releaseMeters: () => consoleView.releaseMeters(),
  regainMeters: () => consoleView.regainMeters(),
  onMeterError: (message) => stopLiveOnError(errorText(message)),
  midi: midiLearnHooks,
  // Both surfaces print these values, and the inspector's sliders are built from a
  // snapshot taken at render time, so they would keep writing back stale values
  // after the screen moved them.
  onClosed: () => {
    refreshInspector();
    consoleView.refresh();
  },
});

// The macOS Edit menu, built first so the history's depth hook can push into it. Its
// own hooks read `planHistory` lazily, which is still null at this point.
const editMenu = installEditMenu({
  canUndo: () => planHistory?.canUndo() ?? false,
  canRedo: () => planHistory?.canRedo() ?? false,
  run: (kind) => planHistory?.menu(kind),
});

// Undo / redo. Built after the views it repaints, and after the two busy latches it
// reads, so every hook body closes over something already initialized.
planHistory = new PlanHistory({
  getPlan: () => plan,
  reflect: (touch) => reflectHistory(touch),
  labelOf: (id) => graph.labelOf(id),
  onStatus: (msg) => setStatus(msg),
  // A device read merges into `plan` across many awaits and re-bases the live snapshot
  // from its own copy, and a file flow can replace the plan outright: patching under
  // either acts on a premise that is still moving. Every read that RE-AUTHORS the plan
  // counts — the operator's fetch and Live-sync start, and equally device follow's two
  // reconciles and Live sync's 1-knob refetch. A converge round is not one of them: it
  // reads the whole write scope but writes nothing back into the plan, so an undo
  // during it is answerable. The press itself is never consumed (run() refuses before
  // it commits the open entry, so a retry is exact), but the two reconciles reset the
  // history in their reflect a moment later, so for those a refused press is an entry
  // the operator loses — visibly, rather than an edit that may or may not have reached
  // the unit. A modal is refused because none of them edits the plan — except the
  // channel tuning screen, which is exactly what its sliders do, so an undo taken with
  // it open belongs to the plan behind it.
  blocked: () =>
    flow.busy || followReads.size > 0
      ? t().status.undoDeviceBusy
      : modalOpen() && !dynScreen.isOpen()
        ? t().status.undoModal
        : null,
  rateLocked: () => liveSessionUp,
  // The macOS application menu's Undo / Redo render this state (a no-op elsewhere).
  onDepthChange: () => editMenu.pushState(),
});
planHistory.install();

// Trace build only: the read-only probe over the plan-key write ledger and the live
// snapshot (src/ui/trace-probe.ts). TRACE folds to a constant, so a plain build
// evaluates this to null and the module is dropped entirely — the same way DEMO drops
// the control layer. Declared after planHistory because it reads the settled depth.
const traceProbe = TRACE
  ? installTraceProbe({
      getPlan: () => plan,
      // Gated on the session rather than on `live` existing: outside a DEMO build it is
      // always constructed, and end() leaves the finished session's map in place — a
      // flush still awaiting a vdSet when the session ends writes into it afterwards, so
      // clearing there would not answer null either. isActive() is what "no session" is.
      liveSnapshot: () => (live?.isActive() ? live.snapshotEntries() : null),
      depth: () => planHistory?.depth() ?? { undo: 0, redo: 0 },
      rates: () => announcedRates.map((r) => r.hz),
    })
  : null;

$("btn-auto").addEventListener("click", () => {
  graph.autoLayout();
});

$("btn-hide-unused").addEventListener("click", () => {
  graph.hideUnused();
});

// The codes the shell LATCHES: past one of these every later command fails on the latch
// rather than on its own merits, so a single occurrence names the whole operation's cause.
// `broker-unresponsive` is the one that made this necessary — a broker that stops answering
// turns a whole-device read into hundreds of identical failures, and a count then tells the
// operator how much failed while saying nothing about why or what to do.
const LATCHED_LINK_CODES = ["broker-unresponsive", "device-lost", "broker-closed", "control-worker-gone"];

/** The localized cause when a multi-parameter read failed because the LINK died, or null
 *  when its failures are its own — a param the unit refused, a group that did not decode —
 *  which is what the failure count is the honest answer to. A read reports per group rather
 *  than stopping at the first, so the code sits behind the group's own prefix and is matched
 *  inside the entry rather than at its head.
 *
 *  This re-derives at the top of the stack what the shell knew at the bottom. The deeper
 *  fix is for the readback's per-group catch to RETHROW a latched code instead of
 *  collecting it — every caller already has a rejection path (applyDeviceState rejects on
 *  abort), so all three read consumers would get the cause for free and this helper would
 *  delete. It is left for its own change because it alters what a partially-read plan keeps
 *  on the device link, which is a behaviour question rather than a wording one. */
function linkFailureIn(errors: string[]): string | null {
  for (const e of errors) {
    const code = LATCHED_LINK_CODES.find((c) => e.includes(c));
    if (code) return errorText(code);
  }
  return null;
}

// Turn a connect-time failure into a clear, localized status. Three of the Rust vd
// worker's codes (vd.rs) name a state the user can act on directly — Device Center
// not running, running with no URX attached, or the control worker dying / going
// unresponsive — so they replace the "<action> failed: …" frame instead of filling
// it. Anything else (a broker-side action failure, an unexpected error) goes into
// onError, localized by errorText like every other embedded cause.
function connectFailureStatus(err: unknown, onError: (message: string) => string): string {
  const code = errorCode(err);
  const standalone = code === "broker-unreachable" || code === "no-device" || code === "control-worker-gone";
  return standalone ? errorText(err) : onError(errorText(err));
}

// Connect, run an action with the connected device, then always disconnect. The
// connect doubles as a pre-check: callers that would discard work put their
// confirm inside `action`, so a no-device state surfaces a clear message without
// first prompting. Connection and action errors surface through connectFailureStatus
// (clear text for the actionable connect states, else the given formatter).
async function withDevice(
  holder: LinkHolder,
  connecting: string,
  onError: (message: string) => string,
  action: (device: DeviceSummary) => Promise<void>,
): Promise<void> {
  // Ahead of the status line: an action that never starts must not leave its own
  // "connecting…" on screen over the holder's progress.
  if (!holdDeviceLink(holder)) return;
  setStatus(connecting);
  try {
    const device = await vdConnect();
    try {
      await action(device);
    } finally {
      // Release exactly the connection this action opened, by its epoch.
      await vdDisconnect(device.epoch);
    }
  } catch (err) {
    // A cancel (throwIfAborted) surfaces as an AbortError DOMException; show the
    // neutral "canceled" status rather than wrapping it as an action failure.
    if (err instanceof DOMException && err.name === "AbortError") setStatus(t().status.canceled);
    else showError(connectFailureStatus(err, onError));
  } finally {
    releaseDeviceLink(holder);
  }
}

// The pre-flight every device action that acts on the *current plan* runs: connect,
// confirm an untested firmware, and refuse a device that is not the model on screen.
// Fetch and Live sync deliberately stay out — they offer to switch the model instead
// of refusing. Wraps withDevice so the three cannot drift apart across the four call
// sites (write, compare, device setup read, device setup apply).
async function withCheckedDevice(
  holder: LinkHolder,
  connecting: string,
  onError: (message: string) => string,
  action: (device: DeviceSummary) => Promise<void>,
): Promise<void> {
  await withDevice(holder, connecting, onError, async (device) => {
    if (!(await confirmFirmware(device))) {
      setStatus(t().status.canceled);
      return;
    }
    if (!refuseModelMismatch(device, onError)) return;
    await action(device);
  });
}

// A failure report a device action produced (built while connected) but offers to
// save after the connection is released — so the user's confirm + native save
// dialog do not hold the broker connection open. Null when nothing failed.
type ErrorReport = { filename: string; markdown: string } | null;

// Offer to save a device action's failure report. Called after withDevice has
// disconnected, so the per-command reasons are visible without the dev console
// and the connection is not held across the (indefinite) dialogs. The self-test
// passes its own prompt and file-type label; everything else takes the defaults.
async function offerErrorReport(report: ErrorReport, prompt?: string, label?: string): Promise<void> {
  if (report && (await confirmDialog(prompt ?? t().confirm.deviceErrorExport))) {
    // A failed report write must surface like a failed plan save — a silent
    // rejection would read as a saved report.
    try {
      await saveTextDocument(report.filename, report.markdown, { ext: "md", label: label ?? t().filter.errorReport });
    } catch (err) {
      showError(t().status.saveError(errorText(err)));
    }
  }
}

// Pull the connected device's current channel levels/pans into the plan. This
// overwrites the matching plan params, so it confirms before discarding edits —
// but only after connecting, so a no-device state is reported without first
// prompting to discard. Desktop only: DEMO is statically true in the browser
// bundle, so this branch — and the control imports it alone references — drops
// from the demo build.
if (!DEMO) {
  // Pick up the device's Follow USB state from a round-trip already being made, so
  // the badge reflects the unit currently on the link. A failed read leaves the
  // state unknown (no badge) rather than asserting "off" — nothing else depends on
  // it, so this is the one device read that does not abort its caller.
  async function refreshFollowUsbBadge(): Promise<void> {
    try {
      setFollowUsbBadge(await readFollowUsb());
    } catch (err) {
      console.warn("Follow USB state unread:", err);
      setFollowUsbBadge(null);
    }
  }

  // Toggle the device's clock policy from the badge. Turning it ON hands the clock
  // back to the USB host: if the host is on a different rate the device re-clocks to
  // it there and then, so the confirm names that possibility — but when the rates
  // already agree nothing happens at all, which is why it is a confirm rather than a
  // refusal. Turning it OFF changes nothing immediately; it only makes the rate
  // picker authoritative again.
  followUsbBadge.addEventListener(
    "click",
    guarded(async () => {
      // Unknown: the click reads the device rather than toggling it. Toggling from
      // unknown would have to guess which way, and the operator's first question here
      // is "what is it?", not "change it".
      if (followUsbState === null) {
        // Not refreshFollowUsbBadge: that one swallows a read failure back to unknown
        // because nothing depends on it. Here the read IS the requested action, so let
        // it throw and be reported.
        await withDevice("follow-usb", t().status.writeConnecting, t().status.writeError, async () => {
          setFollowUsbBadge(await readFollowUsb());
        });
        return;
      }
      const next = !followUsbState;
      // Asked of the model the UNIT reports, not the one the plan names: a plan may be open
      // against a device it was not written for, and a recorder warning is either missing or
      // invented on the model that is actually on the wire. While live the session already
      // verified the two agree, so the plan's model IS the unit's there.
      const ask = async (deviceModel: string): Promise<boolean> => {
        if (!next) return true;
        // It names no numbers: the device will clock from whatever the computer is running,
        // which this app cannot read. So on a model that HAS a recorder the choice is
        // between saying it may cost the Track Count and saying nothing, and the cost is
        // irreversible. URX22 has no recorder and is asked nothing about one.
        const cost = hasRecorder(deviceModel) ? ` ${t().confirm.trackCountMayDrop}` : "";
        return confirmDialog(`${t().confirm.followUsbOn}${cost}`);
      };
      const apply = async (): Promise<void> => {
        await setFollowUsb(next);
        setFollowUsbBadge(next);
        setStatus(next ? t().status.followUsbOn : t().status.followUsbOff);
      };
      // While live the connection is already held for the session; opening a second
      // one would fight it. Otherwise connect just for this write.
      if (liveSessionUp) {
        if (!(await ask(modelId))) return;
        try {
          await apply();
        } catch (err) {
          stopLiveOnError(errorText(err));
        }
        return;
      }
      // Inside the holder, so the question is asked of a unit that answered: declining
      // leaves the link released by withDevice's own teardown and writes nothing.
      await withDevice("follow-usb", t().status.writeConnecting, t().status.writeError, async (device) => {
        if (!(await ask(device.model))) {
          setStatus(t().status.canceled);
          return;
        }
        await apply();
      });
    }),
  );

  const fetchBtn = $<HTMLButtonElement>("btn-fetch");
  // A click cancels an in-flight fetch; otherwise it starts one. The whole-device
  // read is serial and stalls when the link drops, so it threads the controller's
  // signal into applyDeviceState (which checks throwIfAborted between reads).
  fetchBtn.addEventListener("click", async () => {
    if (fetchAbort) {
      fetchAbort.abort();
      return;
    }
    const controller = new AbortController();
    fetchAbort = controller;
    fetchBtn.textContent = t().toolbar.fetchCancel;
    let report: ErrorReport = null;
    let reportPrompt: string | undefined;
    try {
      await withDevice("fetch", t().status.fetchConnecting, t().status.fetchError, async (device) => {
        if (!(await confirmFirmware(device))) {
          setStatus(t().status.canceled);
          return;
        }
        if (!(await confirmDiscard())) {
          setStatus(t().status.canceled);
          return;
        }
        // The connected device may be a different model than the one selected.
        // Offer to switch the UI to the device's model (a fresh plan) so the
        // fetched values map onto the right channels; otherwise abort.
        const sw = await offerModelSwitch(device);
        if (sw === "unknown") {
          showError(t().status.fetchError(t().error.unknownModel(device.model)));
          return;
        }
        if (sw === "canceled") {
          setStatus(t().status.canceled);
          return;
        }
        // Hold off every wholesale plan replacement for the duration of the read and
        // its epilogue (cleared in the finally below); the read mutates `plan` in
        // place, so a New/Open/switch mid-read would corrupt it.
        flow.deviceReadInFlight = true;
        // The read runs against a private copy, so a cancel throws out of it with the
        // plan on screen untouched — "cancel means nothing happened" needs no restore,
        // and the module plan object is never replaced (which is what used to leave
        // every MIDI binding attached to a discarded Plan).
        const merged = await readIntoPlan(
          () => plan,
          (into) => applyDeviceStateScoped(into, controller.signal),
          planWrites,
        );
        // Unreachable while this handler holds deviceReadInFlight (loadPlan refuses
        // under it), but the contract is stated rather than assumed.
        if (!merged) {
          setStatus(t().status.canceled);
          return;
        }
        if (merged.errors.length) console.warn("device readback issues:", merged.errors);
        noteMergeConflicts(merged);
        // Follow USB is outside the plan (see params.ts), so the readback does not
        // carry it — read it on the same connection so the badge matches the values
        // that just landed.
        await refreshFollowUsbBadge();
        // Per-node provenance: nodes whose body read failed still show their plan
        // default, so the graph/inspector flag them as not read from the device.
        plan.unreadNodes = merged.unreadNodes;
        rerenderPlan();
        dirty = true;
        // Nodes the readback tried but could not confirm (left at their plan default).
        const unread = merged.unreadNodes.size;
        setStatus(
          merged.errors.length
            ? // A link that died mid-read is named rather than counted, for the reason
              // linkFailureIn gives; the per-group reasons stay in the report below.
              (linkFailureIn(merged.errors) ?? t().status.fetchPartial(merged.applied, merged.errors.length, unread))
            : unread
              ? t().status.fetchedUnread(device.model, merged.applied, unread)
              : t().status.fetchedDevice(device.model, merged.applied),
        );
        // Read failures AND values the merge did not apply are otherwise console-only,
        // and a packaged build has no inspector to read a console in: capture a report
        // to offer after disconnect (below). The two travel together because both are
        // "what this fetch did not do", and neither is visible from the status line —
        // which says a plain success when only the second happened.
        if (merged.errors.length || merged.unplaced.length) {
          report = { filename: `${modelId}-fetch-report.md`, markdown: formatReadbackReport(device.model, merged) };
          // Which of the two it is decides the prompt. With no read failure nothing
          // failed — the read worked and the merge left the operator's own edits
          // standing — so the default wording would report correct behaviour as a
          // fault, and do it right after the status line said the fetch succeeded.
          //
          // NOT PINNED. Reaching this arm needs an edit to land inside the read AND on
          // a key the read authored, and three attempts at it from src/main.device
          // produced an empty `unplaced` every time (the edit registered, the fetch
          // reported a clean 139 settings). What would settle it is an ordinary-tier
          // E2E case, which drives the real console and the real write witness rather
          // than reasoning about which of them the jsdom seam misses.
          reportPrompt = merged.errors.length ? undefined : t().confirm.deviceUnappliedExport;
        }
      });
    } finally {
      flow.deviceReadInFlight = false;
      // The MIDI gate's reported window ends with the latch (see MidiEngine.gateReleased).
      midi?.gateReleased();
      fetchAbort = null;
      fetchBtn.textContent = t().toolbar.fetchDevice;
      // In the finally: even a canceled read may have applied part of the device state.
      planReadFromDevice();
    }
    await offerErrorReport(report, reportPrompt);
  });

  // What a move to `nextRate` costs the microSD recorder, as the sentence to put in front
  // of the operator — or "" when it costs nothing.
  //
  // Empty for a model with no recorder (URX22 has none), and for a count that already fits
  // the new rate: an irreversible-loss warning shown to someone losing nothing is how a
  // warning stops being read.
  //
  // The count comes from the DEVICE, not the plan. An offline plan's count is whatever was
  // last authored, which would both miss real drops and invent false ones. A read that
  // fails falls back to the sentence that names no numbers rather than to silence — the
  // numbers are what the read buys, and what it cannot buy is the right to say nothing
  // about a loss the app cannot undo.
  // What the settle decided a rate change would cost the recorder, held until the write
  // either sends the rate or does not. NOT a flag set at the confirm: the operator can
  // approve the re-clock and then decline the change count, and the write then sends
  // nothing at all — re-reading there would apply the unit's UNCHANGED count over a plan
  // whose rate had already moved, leaving a count the rate cannot carry and an Inspector
  // whose menu does not contain its own value.
  let pendingTrackCost: { from: number; to: number } | "unknown" | null = null;
  // Set once the rate has actually gone out, and consumed after the write: the unit does
  // the lowering itself, and whether it announces one is not something this app has
  // measured, so the plan is re-read rather than left to a notify that may never come.
  let trackCountMayHaveDropped = false;

  async function trackCountCost(nextRate: number): Promise<{ from: number; to: number } | "unknown" | null> {
    if (!hasRecorder(modelId)) return null;
    let count: number;
    try {
      count = await readTrackCount();
    } catch {
      return "unknown";
    }
    return trackCountDrop(count, nextRate);
  }

  // Settle what sample rate this write is going to happen at, before anything is
  // sent. Returns true to go ahead, false to abort the write.
  //
  // The rate is the one plan value the device can accept and then undo on its own:
  // with SETUP > Follow USB on it slaves its clock to the USB host, so a rate write
  // re-clocks the hardware and is dragged back to the host's rate about a second
  // later. Writing straight through would report success for a change that did not
  // last. The check is here, at the write boundary, rather than wherever the rate
  // was chosen: the picker and plan loading both happen with no device attached, so
  // there is nothing to compare against until now.
  //
  // A read failure aborts. Which rate the device will end up running at decides
  // which parameters the rest of the write may even contain, so proceeding without
  // it would be writing on a premise the link just failed to establish.
  async function settleSampleRate(): Promise<boolean> {
    let clock;
    try {
      clock = await readClockState();
    } catch (err) {
      showError(t().status.writeError(t().error.clockUnread(errorText(err))));
      return false;
    }
    // The read just told us what the badge is for; show it whether or not there is
    // anything to settle.
    setFollowUsbBadge(clock.followUsb);
    const action = rateAction(plan.sampleRate, clock);
    if (action === "proceed") return true;
    const planRate = formatRate(plan.sampleRate);
    const deviceRate = formatRate(clock.sampleRate);
    // What the plan's rate would cost the recorder. The unit lowers its own Track Count to
    // fit a rate it cannot carry and nothing this app can write raises it again, so unlike
    // every other rate constraint this one is destroyed rather than merely left out — it
    // has to be in front of the decision, not in the release notes. Read from the DEVICE
    // rather than taken from the plan: an offline plan's count is whatever was last
    // authored, and warning from that would both miss real drops and invent false ones.
    // A read that fails leaves `null`, and the caller then warns without naming numbers
    // rather than staying silent.
    const trackCost = await trackCountCost(plan.sampleRate);
    if (action === "confirmReclock") {
      // The device will take the rate and hold it. Re-clocking interrupts audio and
      // renegotiates the USB stream, so it is worth stating outright — but it is a
      // plain yes/no: the plan's rate is the one that sticks.
      const cost =
        trackCost === "unknown"
          ? t().confirm.trackCountMayDrop
          : trackCost
            ? t().confirm.trackCountDrop(trackCost.from, trackCost.to)
            : "";
      const ask = [t().confirm.reclock(deviceRate, planRate), cost].filter(Boolean).join(" ");
      if (await confirmDialog(ask)) {
        pendingTrackCost = trackCost;
        return true;
      }
      setStatus(t().status.canceled);
      return false;
    }
    // Above 96 kHz whole features drop out, so adopting a high device rate means
    // part of the plan will not be written. Name it before the choice is made.
    const limits = rateConstraints(getModel(modelId), clock.sampleRate)
      .warnings.map((w) => t().warning[w])
      .join(" ");
    // The note belongs to the whole dialog, so it may only say what is true of every arm.
    // `limits` is: adopting the device's high rate and releasing to the plan's each leave
    // those features out. The Track Count warning is NOT — it is what RELEASING costs, and
    // adopting costs nothing — so it goes on that button rather than into the note.
    const note = limits ? t().rateChoice.hiRateNote(limits) : null;
    // Its own wording, not the confirm's: this arm is one of three answers and the sentence
    // has to say which one it is about. `trackWarning` decides WHETHER, the message decides
    // how it reads here.
    const releaseNote =
      trackCost === "unknown"
        ? t().confirm.trackCountMayDrop
        : trackCost
          ? t().rateChoice.trackCountDrop(trackCost.from, trackCost.to)
          : "";
    const choice = await askRateChoice(planRate, deviceRate, note, releaseNote);
    if (choice === "cancel") {
      setStatus(t().status.canceled);
      return false;
    }
    if (choice === "adopt") {
      // The device's rate becomes the plan's, so the rate write is a no-op and the
      // gating downstream matches what the hardware can actually hold. This is an
      // edit like any other — the operator chose it — so it goes through the same
      // funnel and is remembered as the last known rate.
      setPlanSampleRate(plan, clock.sampleRate);
      markChanged();
      syncRateUi(); // persists the adopted rate as the last known one
      return true;
    }
    try {
      await setFollowUsb(false);
    } catch (err) {
      showError(t().status.writeError(t().error.followUsbWrite(errorText(err))));
      return false;
    }
    setFollowUsbBadge(false);
    // Only this arm writes the plan's rate. `adopt` takes the DEVICE's, which the recorder
    // is already living with, so it costs the Track Count nothing.
    pendingTrackCost = trackCost;
    return true;
  }

  // Write the plan to the connected device: diff the plan against the device's
  // current values, confirm the change count, then send only what differs.
  // Writing to a device of a different model is refused (the plan's channels
  // would map onto the wrong hardware). Write and live sync are available on any
  // desktop build (the self-test below stays behind --experimental).
  {
    const writeBtn = $<HTMLButtonElement>("btn-write");
    writeBtn.disabled = false;
    // Like fetch: a click cancels an in-flight write, else starts one. The diff +
    // converging send is serial and stalls on a dropped link, so the controller's
    // signal threads into diffPlan and sendConverging (both check throwIfAborted
    // between round-trips); the string name diff/send are bracketed by explicit
    // abort checks since they take no signal.
    writeBtn.addEventListener("click", async () => {
      if (writeAbort) {
        writeAbort.abort();
        return;
      }
      const controller = new AbortController();
      const { signal } = controller;
      writeAbort = controller;
      writeBtn.textContent = t().toolbar.writeCancel;
      let report: ErrorReport = null;
      try {
        await withCheckedDevice("write", t().status.writeConnecting, t().status.writeError, async (device) => {
          // Scene scope drops SAMPLE_RATE from the write set, so there is no
          // rate to settle — the device keeps running at its own.
          const scope = getSettings().deviceScope;
          pendingTrackCost = null;
          if (scope !== "scene" && !(await settleSampleRate())) return;
          // One attempt of the whole diff → confirm → send sequence. Returns the
          // sent/not-sent split when the send stopped part-way (so the caller can
          // offer a retry), or null when there is nothing left to do.
          const saveReport = (
            failed: Array<{ name: string; error?: string }>,
            residual: CommandDiff[],
            reads: string[],
          ): void => {
            report = {
              filename: `${modelId}-write-errors.md`,
              markdown: formatWriteReport(device.model, failed, residual, reads),
            };
          };
          const attemptWrite = async (confirmFirst: boolean): Promise<{ sent: number; notSent: number } | null> => {
            // A read failure leaves those parameters' device values unknown, so the
            // write stops on the first one — the rest of the sweep would only be
            // establishing values for a write that is already canceled.
            const { diffs, errors } = await diffPlan(getModel(modelId), plan, { signal, stopOnError: true, scope });
            if (errors.length) {
              setStatus(t().status.writeReadFailed(errors.length));
              saveReport([], [], errors);
              return null;
            }
            // CH SETTING names are string params outside the numeric diff; diff them
            // separately so a name-only change still counts and writes.
            signal.throwIfAborted();
            const { writes: nameWrites, errors: nameErrors } = await diffNames(getModel(modelId), plan);
            if (nameErrors.length) {
              setStatus(t().status.writeReadFailed(nameErrors.length));
              saveReport([], [], nameErrors);
              return null;
            }
            const total = diffs.length + nameWrites.length;
            // From the EMITTED list, not from `diffs`: a survivor that already
            // matches the device is not a diff, and the owner it displaced would
            // then go unmentioned — including when the only pending change is that
            // owner's, which reports "no changes to write".
            const owners = collisionOwners(dryRun(getModel(modelId), plan));
            const sharedNote = owners.length ? sharedSettingText(owners) : "";
            if (total === 0) {
              setStatus(sharedNote ? `${t().status.writeNoChanges} ${sharedNote}` : t().status.writeNoChanges);
              return null;
            }
            if (
              confirmFirst &&
              !(await confirmDialog(
                sharedNote ? `${sharedNote}\n\n${t().confirm.write(total)}` : t().confirm.write(total),
              ))
            ) {
              setStatus(t().status.canceled);
              return null;
            }
            const convergeResult = await sendConverging(getModel(modelId), plan, {
              initialDiffs: diffs,
              signal,
              scope,
              // Armed the moment the rate LANDS, not from the returned outcomes: an abort
              // between two sends throws out of the send loop and takes those outcomes
              // with it, so a rate that reached the unit would go unrecorded and the
              // recorder would never be re-read.
              onSent: (o) => {
                if (pendingTrackCost !== null && o.ok && o.command.name === "SAMPLE_RATE") {
                  trackCountMayHaveDropped = true;
                }
              },
            });
            const { outcomes, residual, readErrors: convergeErrors } = convergeResult;
            // Here, with nothing awaited between the converge and this line: the adoption joins
            // the confirmed ADDRESSES to plan KEYS, and one address is a different key under a
            // different effect type, so a front-panel type change announced during the awaits
            // below would join one moment's addresses to another moment's plan. `sendNames` is
            // one such await, on the clean path.
            const takenBack = adoptConfirmedWrites(confirmedAddrs(convergeResult));
            const skipped = outcomes.filter((o) => o.skipped).length;
            const failed: Array<{ name: string; error?: string }> = outcomes
              .filter(reachedAndFailed)
              .map((o) => ({ name: o.command.name, error: o.error }));
            // Names only go out once the numeric phase reached the device intact —
            // a stopped or unreadable numeric phase means the link already failed.
            if (!failed.length && !skipped && !convergeErrors.length) {
              signal.throwIfAborted();
              const nameOutcomes = await sendNames(nameWrites);
              // Normalize the two outcome shapes (numeric command vs string name write)
              // to {name, error} so the count and the saved report share one list.
              failed.push(
                ...nameOutcomes
                  .filter((o) => !o.ok)
                  .map((o) => ({ name: `name ${o.write.param}:${o.write.y}`, error: o.error })),
              );
            }
            if (failed.length) console.warn("device write failures:", failed);
            if (residual.length) console.warn("device write did not converge:", residual);
            // Failures/non-convergence are otherwise console-only: capture a report to
            // offer after disconnect (below), so the reasons are visible without the console.
            if (failed.length || residual.length || convergeErrors.length) {
              saveReport(failed, residual, convergeErrors);
            }
            if (!skipped) {
              const note = takenBack ? ` — ${t().status.paramsBounded(takenBack)}` : "";
              setStatus(
                (failed.length
                  ? t().status.writePartial(total - failed.length, failed.length)
                  : residual.length
                    ? t().status.writeResidual(residual.length)
                    : t().status.written(total)) + note,
              );
              return null;
            }
            // Counted from the outcomes rather than against `total`: a converge round
            // re-sends what the device reset, so `total` (the round-1 count) is not the
            // denominator. A stopped numeric phase never sent the names, so they are
            // all not-sent too.
            const sent = outcomes.filter((o) => o.ok).length;
            const notSent = skipped + nameWrites.length;
            setStatus(t().status.writeStopped(sent, notSent));
            return { sent, notSent };
          };

          // A stopped write leaves the device holding part of what was confirmed.
          // Offer to run it again rather than reporting a breakdown the user cannot
          // act on: the retry re-diffs, so what already landed drops out by itself.
          try {
            let stop = await attemptWrite(true);
            while (stop && (await confirmDialog(t().confirm.writeRetry(stop.sent, stop.notSent)))) {
              stop = await attemptWrite(false);
            }
          } finally {
            // INSIDE the action, because withDevice awaits its own vdDisconnect on the way
            // out: a read placed after it is issued with no connection installed and the
            // shell answers "not-connected" for every address. It is in a FINALLY because
            // the rate goes out first — a write that failed or was cancelled after it still
            // moved the unit, and the recorder still needs re-reading.
            if (trackCountMayHaveDropped) {
              trackCountMayHaveDropped = false;
              const merged = await followRead("track count after a rate change", (into, signal) =>
                applyNodeState(getModel(modelId), into, new Set([SDREC_NODE_ID]), signal, undefined, true),
              );
              if (merged) {
                noteMergeConflicts(merged);
                // absorb, not rebase: this writer KNOWS which keys the device authored, and
                // rebase drops any open entry — an edit the operator started while the read
                // ran would become un-undoable (ui/history.ts states the split).
                planHistory?.absorb(merged.devicePatch);
                // The same repaint a Track Count EDIT earns, not the follow queue:
                // `requestReflect` drains followDirtyNodes / followFull, which this tail
                // sets neither of, so it repaints nothing at all. The count changes how
                // many recorder slots exist (`app/node-param-effects.ts` classes it as a
                // rerender rather than a local repaint), and the panel has to be rebuilt
                // or it goes on showing the value the plan held before the read.
                graph.render();
                refreshInspector();
                planValuesChanged();
                // And a read that FAILED is not a write that succeeded: without this the
                // whole flow reports success while the recorder's value is whatever the
                // plan happened to hold. Caught rather than thrown on, because the throw
                // would leave withDevice reporting that the WRITE failed — it did not, and
                // the operator would go looking for a write that is already on the unit.
                try {
                  assertReadComplete(merged, "track count read issues:");
                } catch (err) {
                  showError(t().error.trackCountReread(errorText(err)));
                }
              }
            }
          }
        });
      } finally {
        writeAbort = null;
        writeBtn.textContent = t().toolbar.writeDevice;
      }
      await offerErrorReport(report);
    });

    // Live sync: connect, read the whole device once (overwriting
    // edits, hence the discard confirm), then mirror each later edit as it
    // happens. The connection is held open for the session and released when the
    // toggle, a write failure, or a plan replacement turns sync off.
    async function activateLive(): Promise<void> {
      if (!live) return;
      // The link is taken for the whole activation, not just for the connect: the
      // starting readback runs for seconds with liveSessionUp still false, and it was
      // exactly that window in which another action could take the connection away
      // (or be started under one). A session that comes up keeps the holder until
      // deactivateLive gives it back; every other exit gives it back here.
      if (!holdDeviceLink("live")) return;
      try {
        await startLiveSession();
      } finally {
        if (!liveSessionUp) releaseDeviceLink("live");
      }
    }

    async function startLiveSession(): Promise<void> {
      if (!live) return;
      // Connect first (the pre-check): a no-device state is reported plainly,
      // without discarding the user's edits. Only on a live device do we confirm
      // the discard, since live sync overwrites the plan with the device state.
      setStatus(t().status.liveConnecting);
      let device: Connection;
      try {
        device = await vdConnect();
      } catch (err) {
        showError(connectFailureStatus(err, t().status.liveError));
        return;
      }
      // Past the connect: any exit must release the held connection first. A
      // user-neutral exit (canceled) goes to the status line; a failure (failLive)
      // surfaces as a dialog — both drop the connection first, by its epoch.
      // Opened on the connect, so the elapsed time and the Rust-side command counts —
      // which start there too — measure the same window. Every exit below closes it.
      beginLinkLedger(device.model);
      const abort = async (status: string): Promise<void> => {
        await releaseLive(device.epoch, "off");
        setStatus(status);
      };
      const failLive = async (message: string): Promise<void> => {
        // live.begin() flips LiveSync.active before the awaited follow.begin() /
        // vdWatchLink; if one of those throws we land here with a half-started
        // session, so tear those down too. Otherwise live.isActive() stays true
        // while liveSessionUp stays false, and every later toggle click routes into
        // deactivateLive's early return — a dead toggle. Safe before begin() too:
        // both end()s no-op when nothing was started.
        follow?.end();
        live?.end();
        await releaseLive(device.epoch, "error");
        showError(message);
      };
      if (!(await confirmFirmware(device))) return await abort(t().status.canceled);
      if (!(await confirmDiscard())) return await abort(t().status.canceled);
      try {
        // A device of a different model maps onto the wrong channels; offer to
        // switch the UI to a fresh plan of the device's model (mirrors fetch).
        const sw = await offerModelSwitch(device);
        if (sw === "unknown") return await failLive(t().status.liveError(t().error.unknownModel(device.model)));
        if (sw === "canceled") return await abort(t().status.canceled);
        // Hold off every wholesale plan replacement until the session is established
        // (cleared in the finally below). The read mutates `plan` in place and
        // live.begin() snapshots it as device truth, so a New/Open/switch landing in
        // between would either corrupt the read or enshrine the swapped-in plan.
        flow.deviceReadInFlight = true;
        midi?.probeMark("live:read:start");
        // live.begin() then snapshots through the same scope filter, so a kept
        // scene-external value is neither written back nor tracked.
        const merged = await readIntoPlan(
          () => plan,
          (into) => applyDeviceStateScoped(into),
          planWrites,
        );
        midi?.probeMark("live:read:end");
        if (!merged) return await abort(t().status.canceled);
        noteMergeConflicts(merged);
        plan.unreadNodes = merged.unreadNodes;
        rerenderPlan();
        // A partial read leaves the plan holding defaults where the device was not
        // heard from, and the live snapshot would enshrine those as device truth —
        // the first sideEffect edit then converges the whole plan and writes them
        // over the real values. Live sync needs a complete read to start from.
        if (merged.errors.length) {
          console.warn("live readback issues:", merged.errors);
          return await failLive(
            t().status.liveError(linkFailureIn(merged.errors) ?? t().error.liveReadIncomplete(merged.errors.length)),
          );
        }
        dirty = false;
        // Read before the session is up, so the badge is already right when the rate
        // picker locks — the badge is the only Follow USB control while live.
        await refreshFollowUsbBadge();
        // The copy the starting read ran against: without it an edit made during the
        // multi-second read is snapshotted as a value the device was already given.
        live.begin(merged.deviceView);
        // Both registrations are awaited before the session counts as up. Without
        // the notify stream the app is blind to device-side edits and the next
        // converge writes the plan back over them; without the link watch an idle
        // drop freezes the session instead of ending it. Either failure throws to
        // failLive rather than starting a session that cannot do its job.
        await follow?.begin();
        await vdWatchLink(() => stopLiveOnError(t().error.shell.deviceLost));
        // …and follow is still following. A structural edit can flush between `live.begin`
        // above and this line; that flush asks the follow layer to re-register, and a
        // refusal there stops follow and reports through `stopLiveOnError`, which returns
        // without doing anything while `liveSessionUp` is false. The lines below are what
        // would declare the session up, so the check belongs in front of them: otherwise
        // the app says "Live sync on" over a follow that discards every notify, and
        // nothing restarts it.
        if (follow && !follow.isActive()) throw new Error(t().error.liveFollowStopped);
        // Remember which generation the session holds, so deactivateLive releases
        // exactly this one even when its disconnect lands after a later connect.
        liveEpoch = device.epoch;
        liveSessionUp = true;
        setLiveUi(true);
        setStatus(t().status.liveOn(device.model, merged.applied));
      } catch (err) {
        await failLive(t().status.liveError(errorText(err)));
      } finally {
        flow.deviceReadInFlight = false;
        // The MIDI gate's reported window ends with the latch (see MidiEngine.gateReleased).
        midi?.gateReleased();
        // In the finally: a partially failed readback still applied device values.
        planReadFromDevice();
        // Gated on the session, not on reaching here: this block is also where a read
        // that threw or was cancelled lands, and that leaves the plan part device and
        // part default — the state whose values must not reach the controller or the
        // bus it shares. With the session up, the plan is the unit's own.
        if (liveSessionUp) midi?.liveReadSettled();
      }
    }

    const liveBtn = $<HTMLButtonElement>("btn-live");
    liveBtn.hidden = false;
    // Rapid repeat: an activation is a long async flow (connect / confirms /
    // full read) during which the toggle is neither on nor off — a second click
    // there must not start a second concurrent session. Deactivation is
    // synchronous and stays outside the latch, so an active session always
    // turns off immediately.
    const startLive = guarded(() => activateLive());
    liveBtn.addEventListener("click", () => {
      if (live?.isActive()) deactivateLive(t().status.liveOff);
      else startLive();
    });
  }

  // External MIDI control: map controller messages onto console controls (with
  // MIDI learn) and feed edits back to the controller. Incoming edits repaint
  // through the coalesced follow reflect (a controller sweep arrives at wire
  // rate) and run markChanged via onApplied, so Live sync mirrors them too.
  midi = new MidiControl({
    getModel: () => getModel(modelId),
    getPlan: () => plan,
    onApplied: (control, mirrored) => {
      markChanged("midi");
      followDirtyNodes.add(control.node);
      const partner = mirrored ? partnerChannel(getModel(modelId), control.node) : undefined;
      if (partner) followDirtyNodes.add(partner);
      requestReflect();
      // Kept exactly where the coalesced reflect used to make it, so moving that call
      // out changes one behaviour and not two: a MIDI message inside the idle window
      // drops the operator's open entry (pinned by T4's midi-rebase ladder). That is a
      // defect of its own — a MIDI apply is an app edit through markChanged, not a
      // device read — and removing it is a separate decision with its own cells.
      planHistory?.rebase();
      // No wire repaint here: the reflect requested above redraws them. Its direct
      // branch ends in graph.repaintDirtyNodes, whose own tail is redrawWires, and both
      // sites carry the same `!graphHost.hidden` guard — so a toggle's wire dimming
      // lands either way, at most one reflect window (REFLECT_MIN_MS) later.
    },
    // The operator-started latches, a strict subset of what the history refuses under:
    // a Fetch or a Live-sync start holds the plan for seconds and the latter then
    // snapshots it as device truth, a file flow can replace the plan outright, and a
    // destructive run holds the device link while it verifies the unit against what it
    // wrote. That last one is the only latch here whose reason is the DEVICE rather
    // than the plan: with Live sync off a refused message would have edited the plan
    // and gone no further, but a controller is a physical surface an operator keeps
    // moving, and a run is the one window where the app must not let what that moves
    // become a device write. Read off the link holder rather than a flag of its own,
    // so what refuses a message and what refuses a second connection cannot diverge.
    // The follow-side reads (followReads) are deliberately NOT here, unlike in
    // PlanHistory.blocked: they recur once per flush window of a 1-knob drag, so
    // refusing in them would make an external desk stutter continuously — and an edit
    // made inside one now survives it (readback.readIntoPlan merges rather than
    // assigns), which is what makes leaving them open safe. A modal is not here either:
    // a MIDI desk is a second physical surface, and the panel that configures it is
    // itself counted by modalOpen().
    blocked: () => (flow.busy || deviceLinkHolder === "run" ? t().status.midiBusy : null),
    // Both arming surfaces repaint: learn mode, the armed control and the mapping
    // set all decide what they draw, and a tuning screen open over the console is
    // the one the operator is looking at.
    onLearnChanged: () => {
      consoleView.refresh();
      dynScreen.refresh();
    },
    onStatus: setStatus,
  });
  $("btn-midi").addEventListener("click", () => midi?.toggleWindow());

  // Device setup: the unit's SETUP > GENERAL settings — brightness, auto power off,
  // the date/time formats and time zone, the HDMI and USB Main pages, the menu
  // language, and the user-defined knob assignments. None of them is represented by
  // a node on the graph or a strip on the console, and none belongs to the plan: a
  // plan travels between units as a file and a link, and writing one absolutely
  // would push this operator's screen brightness and knob assignments onto someone
  // else's hardware.
  //
  // Batch, not live: the screen opens on values just read, edits accumulate in the
  // modal, and Apply sends only the differences. The read happens here rather than
  // inside the panel because a failed read must leave the screen unopened — showing
  // a half-established baseline invites applying a diff against values that were
  // never read, which is what the standing device-link rule forbids.
  //
  // No faceplate readout of the unit's clock: the URX exposes no writable clock and
  // does not take the time from a USB host either, so displaying a clock nobody can
  // correct earns nothing. If a way to set it turns up, that readout is also what
  // would make the Time Zone and Display Format rows tangible.
  deviceSetup = new DeviceSetupPanel({
    model: () => getModel(modelId),
    confirmDiscard: () => confirmDialog(t().confirm.deviceSetupDiscard),
    apply: async (writes, changed) => {
      let applied = false;
      await withCheckedDevice(
        "device-setup",
        t().status.deviceSetupApplying,
        (message) => t().error.deviceSetupWrite(message),
        async () => {
          await sendDeviceSetup(writes);
          applied = true;
          setStatus(t().status.deviceSetupApplied(changed));
        },
      );
      return applied;
    },
  });

  $("btn-device-setup").addEventListener("click", async () => {
    // A live session holds the one connection, and these settings are outside the
    // plan that session mirrors — so the menu entry is disabled while live
    // (syncDeviceActionUi), and this is the belt for any path that reaches here
    // anyway. Kept beside withCheckedDevice's own link check because it says
    // something the generic one cannot: these settings are not part of what a
    // session mirrors, so the answer is not "wait" but "not while live".
    if (liveSessionUp) {
      showError(t().error.notWhileLive);
      return;
    }
    let setup: DeviceSetup | null = null;
    await withCheckedDevice(
      "device-setup",
      t().status.deviceSetupReading,
      (message) => t().error.deviceSetupRead(message),
      async () => {
        setup = await readDeviceSetup(getModel(modelId));
      },
    );
    if (setup) {
      setStatus(t().status.deviceSetupRead);
      deviceSetup?.open(setup);
    }
  });

  // Experimental-only menu group (its separator + the self-test): the self-test
  // is a diagnostic that briefly overwrites every parameter, so it stays behind
  // the flag — MIDI control, write, and live sync do not.
  // Import a URX settings file (.urxf) — what the unit itself writes to microSD
  // from SETUP > SAVE — onto the plan already open, through the same device→plan
  // inverse a fetch uses. Nothing is sent to hardware: the file is the source.
  //
  // Two things the file cannot supply, both surfaced in the confirm: it names no
  // model (its header reads "URX" for every variant, so the operator vouches for
  // the selected one), and it holds no editing state, so layout / hidden / notes
  // stay as they are rather than being reset.
  // `load` fetches the bytes when the import is actually going ahead (a dialog
  // that returns null was canceled). Reading and parsing share one failure
  // surface, so neither entry point below carries its own catch.
  async function importSettings(load: () => Promise<{ bytes: Uint8Array; name: string } | null>): Promise<void> {
    // Same latch as the plan-open flows: the import shares their dialog chain
    // (confirms + a file dialog), so rapid repeat across entry points is ignored.
    await fileFlow(() => importSettingsFlow(load));
  }

  async function importSettingsFlow(load: () => Promise<{ bytes: Uint8Array; name: string } | null>): Promise<void> {
    // Replacing every value at once is what Live sync cannot follow, so the import
    // is refused while a session is up — the same rule fetch and write follow, which
    // setLiveUi enforces on the menu entry. The drop target needs it stated here.
    if (liveSessionUp) {
      showError(t().error.notWhileLive);
      return;
    }
    let name = "";
    let current;
    try {
      const doc = await load();
      if (!doc) return;
      name = doc.name;
      // CURRENT is the unit's live settings. Stored scenes are separate chunks with
      // no place in a plan — their names exist only in the file's scaffolding.
      current = parseUrxf(doc.bytes).chunks.find((chunk) => chunk.name === "CURRENT");
      if (!current) throw new UrxfError("noCurrent");
    } catch (err) {
      showError(t().status.settingsError(err instanceof UrxfError ? t().error.urxf[err.code] : errorText(err)));
      return;
    }
    if (!(await confirmDiscard())) return;
    if (!(await confirmDialog(t().confirm.importSettings(name, modelId)))) {
      setStatus(t().status.canceled);
      return;
    }
    // Re-checked HERE, not only at the flow's entry. This is the one wholesale plan
    // replacement that does not go through `loadPlan` — it mutates the module plan in
    // place — so it has no share of that backstop, and the entry check is separated
    // from the mutation by two confirm dialogs. The UI stays clickable during those
    // (the confirm's own comment says so), so an operator can start a Fetch or Live
    // sync in between: the read raises the latch and spends seconds merging into the
    // same plan object this is about to overwrite key by key. Neither side reports
    // anything, the import does not pass `markChanged` so the write witness has no
    // entry for it, and what is left is a mixture with a history and a live snapshot
    // that describe neither half.
    if (flow.deviceReadInFlight) {
      setStatus(t().status.busyDeviceRead);
      return;
    }
    let result: ReadbackResult;
    try {
      result = await applySourceState(getModel(modelId), plan, paramSourceOf(current));
    } catch (err) {
      showError(t().status.settingsError(errorText(err)));
      return;
    }
    if (result.errors.length) console.warn("settings import issues:", result.errors);
    // Same provenance as a device fetch: nodes whose values did not come through
    // still show their plan default, and the graph flags them as such.
    plan.unreadNodes = result.unreadNodes;
    rerenderPlan();
    dirty = true;
    planReadFromDevice();
    const unread = result.unreadNodes.size;
    setStatus(
      result.errors.length
        ? t().status.settingsPartial(result.applied, result.errors.length, unread)
        : t().status.settingsImported(name, result.applied),
    );
    await offerErrorReport(
      result.errors.length
        ? { filename: `${modelId}-import-errors.md`, markdown: formatReadbackReport(modelId, result) }
        : null,
    );
  }

  experimentalEnabled().then((enabled) => {
    if (!enabled) return;
    experimentalOn = true;
    prefs.refresh();
    for (const el of document.querySelectorAll<HTMLElement>("[data-experimental-only]")) el.hidden = false;

    // The link ledger's readout. The counters and the log run in every desktop build;
    // this is the only part that is a diagnostic, so it is the only part gated. Built
    // here rather than at startup so a build that never shows it never makes it — and
    // it picks up a session already running, since the gate resolves asynchronously.
    if (linkLedger) {
      linkStatsView = new LinkStatsView($("link-stats"), {
        read: () => linkLedger.read(),
        logPath: () => linkLedger.path,
        onCopied: setStatus,
      });
      linkStatsView.setSession(linkLedger.active);
    }

    // Arm the settings-file import: the File menu entry (revealed just above) and
    // the drop target, which only accepts .urxf from this registration on.
    dropzone.register("urxf", (file) => importSettings(async () => ({ bytes: await file.bytes(), name: file.name })));
    $("btn-open-settings").addEventListener("click", () =>
      importSettings(async () => {
        const doc = await openBinaryDocument({ ext: "urxf", label: t().filter.settings });
        return doc && { bytes: doc.bytes, name: baseName(doc.path) };
      }),
    );

    // Compare with device (experimental): a read-only pass that reads every
    // parameter the plan implies, records the device's value beside the plan's,
    // and writes nothing. It is the automated counterpart to eyeballing an
    // imported settings file — connect the unit the .urxf came from and compare,
    // and a faithful import shows no differences. Same shape as fetch: connect,
    // confirm firmware, require the model to match, then read; a second click
    // cancels the (serial, link-stalling) sweep. Unlike fetch it does not stop on
    // a read failure — the audit wants every parameter it can still read.
    //
    // The result is always shown, even on a full match, as a full per-parameter
    // log with a compared count and the elapsed time: an instant "matches" is
    // otherwise indistinguishable from a comparison that read nothing, so the
    // report has to make the reads visible rather than asking the operator to
    // trust the verdict.
    const compareBtn = $<HTMLButtonElement>("btn-compare");
    compareBtn.addEventListener("click", async () => {
      if (compareAbort) {
        compareAbort.abort();
        return;
      }
      const controller = new AbortController();
      const { signal } = controller;
      compareAbort = controller;
      compareBtn.textContent = t().toolbar.compareCancel;
      // Built while connected, shown after disconnect — like the fetch/write error
      // reports, so an indefinite modal does not hold the broker connection open.
      let report: string | null = null;
      try {
        await withCheckedDevice("compare", t().status.compareConnecting, t().status.compareError, async (device) => {
          const model = getModel(modelId);
          const startedAt = performance.now();
          const { entries, errors } = await comparePlan(model, plan, signal);
          signal.throwIfAborted();
          const { entries: nameEntries, errors: nameErrors } = await compareNames(model, plan);
          const elapsedMs = Math.round(performance.now() - startedAt);
          const reads = [...errors, ...nameErrors];
          const { compared, differ } = compareCounts(entries, nameEntries);
          report = formatCompareReport(device.model, entries, nameEntries, reads);
          setStatus(
            reads.length
              ? t().status.comparePartial(differ, compared, reads.length, elapsedMs)
              : differ
                ? t().status.compareDiff(differ, compared, elapsedMs)
                : t().status.compareMatch(compared, elapsedMs),
          );
        });
      } finally {
        compareAbort = null;
        compareBtn.textContent = t().toolbar.compare;
      }
      // Always shown (match or not): the full log is the point — it lets an
      // instant "all match" be verified as N reads that agreed.
      const m = t().compareReport;
      if (report) showLoadReport(report, { title: m.title, intro: m.intro });
    });

    // Device self-test (experimental): read the device, write a perturbed copy,
    // verify it matches, then restore. It owns its own connection, so it does not
    // go through withDevice. Reports are console.warn'd (not log) so they reach
    // the dev-server log for a headless read.
    const selfTestBtn = $<HTMLButtonElement>("btn-selftest");
    // selfTestAbort (module scope) holds the in-flight run's controller, so a second
    // menu click cancels instead of starting another run (the run can take minutes
    // of serial round-trips, and stalls entirely if the device link drops mid-test).

    // The --self-test launch has nobody to answer a save dialog, so its report goes to
    // the log. In chunks: the whole thing in one console line risks the dev server's
    // forwarding limits, and one line per row would be thousands of frames.
    function logReport(markdown: string): void {
      const CHUNK = 50;
      const rows = markdown.split("\n");
      const total = Math.ceil(rows.length / CHUNK);
      for (let n = 0; n < total; n++) {
        console.warn(`[self-test] report ${n + 1}/${total}\n${rows.slice(n * CHUNK, (n + 1) * CHUNK).join("\n")}`);
      }
    }

    // `headless` = the --self-test launch (see logReport).
    async function runDeviceSelfTest(headless = false): Promise<void> {
      // Taken before the first await, so nothing can slip through between the click
      // and the connect — neither a MIDI message nor a second device action.
      if (!holdDeviceLink("run")) return;
      const controller = new AbortController();
      selfTestAbort = controller;
      selfTestBtn.textContent = t().toolbar.selfTestCancel;
      setStatus(t().status.selfTestRunning);
      try {
        // The settle window is settle.ts's one constant; this site takes the default.
        const report = await runSelfTest(getModel(modelId), undefined, controller.signal);
        // Traces go out as a count, not as their contents: one carries every command of
        // a failing pass's first round, which is a terminal-flooding console line. The
        // report below is where they are read.
        console.warn(
          `[self-test] ${report.aborted ? "CANCELLED" : report.ok ? "PASS" : "FAIL"}`,
          JSON.stringify({ ...report, traces: report.traces.length }),
        );
        if (report.errors.length) console.warn("[self-test] issues:", JSON.stringify(report.errors));
        if (report.residual.length) console.warn("[self-test] mismatches:", JSON.stringify(report.residual));
        const verdicts = summarizeVerdicts(report.unverified);
        const divergence = report.residual.filter((r) => !r.stoppedOn).length;
        const neverCompared = report.residual.length - divergence;
        setStatus(
          report.aborted
            ? t().status.selfTestCancelled
            : // Before the restore verdict: a refusal wrote nothing, so `restored` is
              // false only because there was nothing to restore — reading it as a failed
              // restore tells the operator their unit may be left perturbed when it was
              // never touched.
              report.phase === "refused"
              ? t().status.selfTestRefused
              : !report.restored
                ? t().status.selfTestRestoreFail
                : report.unverified.length
                  ? t().status.selfTestUnverified(verdicts.confirmed, verdicts.refuted, verdicts.untestable)
                  : report.ok
                    ? t().status.selfTestPass(report.written)
                    : // `residual` holds two things once a pass can stop partway: what the
                      // device answered differently, and what the run never got to ask
                      // about. Only the first is a mismatch, and if there is any of the
                      // second the headline is that the run did not finish.
                      neverCompared > 0
                      ? t().status.selfTestIncomplete(neverCompared)
                      : t().status.selfTestFail(divergence),
        );
        // Two reasons to keep the report, kept apart: the model's unconfirmed mappings
        // (a property of the model, so the run always has those verdicts to send back)
        // and anything the run found wrong. The second is the one that used to have no
        // way out of the console — a failure whose per-param detail is unreadable is a
        // diagnostic that diagnoses nothing.
        const guesses = report.unverified.length > 0;
        const problems = report.residual.length > 0 || report.errors.length > 0 || !report.restored;
        if (headless) {
          if (guesses || problems) logReport(formatSelfTestReport(report));
          return;
        }
        if (!report.aborted && (guesses || problems)) {
          await offerErrorReport(
            { filename: `${modelId}-self-test.md`, markdown: formatSelfTestReport(report) },
            guesses ? t().confirm.selfTestExport : t().confirm.selfTestFailExport,
            t().filter.report,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[self-test] ERROR", message);
        showError(connectFailureStatus(err, t().status.selfTestError));
      } finally {
        selfTestAbort = null;
        releaseDeviceLink("run");
        // The MIDI gate's reported window ends with the latch (see MidiEngine.gateReleased),
        // so the next run speaks up again instead of refusing silently.
        midi?.gateReleased();
        selfTestBtn.textContent = t().toolbar.selfTest;
      }
    }

    // A click cancels an in-flight run; otherwise it confirms first (the run is
    // destructive-then-restored) and starts one.
    selfTestBtn.addEventListener("click", async () => {
      if (selfTestAbort) {
        selfTestAbort.abort();
        return;
      }
      if (await confirmDialog(t().confirm.selfTest)) await runDeviceSelfTest();
    });
    // Headless trigger: when launched with --self-test, run it once on startup
    // (no dialog), so it can be driven from the command line without the UI.
    void selfTestRequested().then((auto) => {
      if (auto) void runDeviceSelfTest(true);
    });

    // Headless trigger (audit): --prepare-modified writes a distinctive silent
    // state to the device and leaves it (no restore), so a scene SAVE/RECALL audit
    // can save and diff it. Reports go to the dev-server log like the self-test.
    void prepareModifiedRequested().then(async (auto) => {
      if (!auto) return;
      if (!holdDeviceLink("run")) return;
      setStatus(t().status.selfTestRunning);
      try {
        const report = await runPrepareModified(getModel(modelId));
        console.warn(`[prepare-modified] ${report.aborted ? "CANCELLED" : "DONE"}`, JSON.stringify(report));
        if (report.errors.length) console.warn("[prepare-modified] issues:", JSON.stringify(report.errors));
        setStatus(`prepare-modified: wrote ${report.written}, residual ${report.residual}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[prepare-modified] ERROR", message);
        showError(connectFailureStatus(err, t().status.selfTestError));
      } finally {
        releaseDeviceLink("run");
        midi?.gateReleased();
      }
    });
  });
}

$("btn-view-graph").addEventListener("click", () => setView("graph"));
$("btn-view-console").addEventListener("click", () => setView("console"));
// Restore the last selected view now that the console is wired up.
setView(detectView());

// Re-resolve the active theme from the current mode and repaint what reads it:
// the SVG graph, the console's scribble ink, and an open tuning screen's plot.
function applyResolvedTheme(): void {
  theme = resolveTheme(themeMode);
  document.documentElement.dataset.theme = theme;
  graph.setTheme(theme);
  // The funnel for surfaces CSS variables cannot repaint on their own. The graph is SVG
  // built from a palette; a tuning screen's plot is a canvas whose theme tokens are read
  // once per render — and auto mode can flip underneath an open one with no press at all.
  // The console is deliberately NOT in this set, and that is a live assumption rather
  // than an oversight: its scribble ink stopped being a stylesheet value when inkOn()
  // began picking black or white from the ground, which for a rail-coloured strip is a
  // theme token — so the ink survives a theme switch computed against the ground that
  // just left. Measured 2026-08-07: harmless, because all five rails resolve to white
  // in BOTH themes, so the stale answer is the right one. Move a rail to a ground where
  // the two themes disagree and this becomes a strip inked for the theme that left;
  // adding consoleView.refresh() here is the fix, and it costs one strip rebuild.
  dynScreen.refresh();
}

function setThemeMode(mode: ThemeMode): void {
  themeMode = mode;
  rememberThemeMode(mode);
  applyResolvedTheme();
  const m = t().status;
  setStatus(mode === "auto" ? m.themeAuto : theme === "dark" ? m.themeDark : m.themeLight);
}

// Follow the OS color scheme live while in auto mode.
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (themeMode === "auto") applyResolvedTheme();
});

labelsBtn.addEventListener("click", () => {
  labelSource = labelSource === "device" ? "model" : "device";
  rememberLabelSource(labelSource);
  graph.setLabelSource(labelSource);
  applyStaticI18n();
  setStatus(labelSource === "device" ? t().toolbar.labelsDevice : t().toolbar.labelsModel);
});

hideOffBtn.addEventListener("click", () => {
  const next = !graph.isHideOffSends();
  graph.setHideOffSends(next);
  rememberHideOffSends(next);
  applyStaticI18n();
  setStatus(next ? t().toolbar.hideOffSends : t().toolbar.showOffSends);
});

// Wire the File dropdown: open/close, click-outside, and roving keyboard focus
// across its menu items. The panel is positioned fixed (toolbar clips overflow),
// so its coordinates are derived from the trigger each time it opens.
setupMenu($<HTMLButtonElement>("btn-file"), $<HTMLElement>("file-menu"));
// Device actions (desktop only; the whole menu is hidden in a plain browser).
setupMenu($<HTMLButtonElement>("btn-device"), $<HTMLElement>("device-menu"));
// View menu: layout (Arrange) and display toggles (Hide unused / off-sends / labels).
setupMenu($<HTMLButtonElement>("btn-view"), $<HTMLElement>("view-menu"));

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
  // self-test, disabled at this point) is covered too. An item's async action
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
  graph.relocalizeChrome();
  midi?.relocalize();
  // The language row lives in the Preferences modal, so the switch happens with
  // the modal open — rebuild it in the new language. Device setup can be open at
  // the same time (its notes are translated even though its labels are not).
  prefs.refresh();
  deviceSetup?.refresh();
  dynScreen.refresh();
  setStatus(t().status.language(LANG_NAMES[getLang()]));
});

// True while any modal overlay is up: the consent-scrim dialogs (consent, load
// report, rate choice, licenses, Preferences, Device setup, and the drag overlay)
// share the class and toggle [hidden]. MIDI control is not among them — it is a
// window of its own, so it covers nothing here and holds nothing back: an undo
// taken with it open belongs to the plan in this window.
function modalOpen(): boolean {
  return !!document.querySelector(".consent-scrim:not([hidden])");
}

/**
 * Whether a modal was open when the Escape now being handled STARTED.
 *
 * Asking `modalOpen()` in the bubble-phase handler answers about the wrong moment: a
 * modal dismisses in the capture phase without stopping propagation, so by the time the
 * window handler runs the modal has already gone and the test says "no modal" — and the
 * graph's selection, and the inspector's contents with it, were cleared for an Escape
 * addressed to Preferences, the licences notice or Device setup. This listener is
 * registered in the capture phase on `window`, which is the first thing the event
 * reaches, so it records the state the operator's key was actually aimed at.
 */
let escapeConsumed = false;
window.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Escape") escapeConsumed = modalOpen();
  },
  true,
);

window.addEventListener("keydown", (e) => {
  // Undo / redo first, and with its own target test: `typing` below is too broad
  // for it (a focused range slider or the model picker owns no undo stack of its
  // own, so bailing there would make Ctrl+Z quietly do nothing right after a slider
  // drag). Its modal and busy refusals live in the hooks, not here. Registered in
  // the bubble phase like the rest of this handler, which is what lets the note
  // editor's stopPropagation shield an in-progress note from the shortcut.
  if (planHistory?.handleKey(e)) return;
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes((e.target as Element)?.tagName);
  if (typing) return;
  if (e.key === "Delete" || e.key === "Backspace") {
    // Deletion acts on the graph's selection, so it must not fire from the CONSOLE
    // view (graph hidden, and the console renders no deletable kinds) or reach past
    // an open modal overlay to the graph behind it.
    if (graphHost.hidden || modalOpen()) return;
    e.preventDefault();
    graph.deleteSelection();
  } else if (e.key === "Escape") {
    // Gated like the Delete branch above, and for the same reason. A modal closes on
    // Escape in the capture phase without stopping propagation, so this bubble-phase
    // handler then ran too and cleared the graph's selection — and the inspector's
    // contents with it — for an Escape addressed to Preferences, the licences notice or
    // Device setup. The same key closing a console popover cleared the hidden graph's
    // selection behind the console view.
    if (graphHost.hidden || modalOpen() || escapeConsumed) return;
    graph.clearSelection();
  }
});

applyRateConstraints();
setStatus(t().status.loaded(modelId));

// Keyboard measurement harness (ui/keyprobe.ts), dev builds only. Installed here,
// after the keydown handler above, so its chord log can report whether the app had
// already claimed the chord. The branch is statically dropped from a production build.
if (import.meta.env.DEV)
  installKeyProbe({
    onReport: setStatus,
    // The two arms of the IME measurement: the panel repaint as the app runs it (the
    // composition gate decides), and the same repaint with no gate in front of it — the
    // behaviour the gate replaced. The host supplies both because neither is reachable
    // from a module the harness can import, and `pulseMs` so the harness fires at the
    // rate a real device sweep produces rather than at a number of its own.
    refreshInspector,
    rebuildInspector,
    inspectorHost,
    pulseMs: REFLECT_MIN_MS,
  });

// Deep-link entry: a `?plan=<base64url-json>` parameter loads a plan straight
// into the viewer (a generator emits a shareable URL). A decode failure or a
// routing violation surfaces the copyable report instead of loading, leaving the
// default plan on screen. Runs after the initial render so a failure is visible.
async function loadPlanFromUrl(): Promise<void> {
  let encoded: string | null;
  try {
    encoded = new URL(location.href).searchParams.get("plan");
  } catch {
    return; // URL / searchParams unavailable
  }
  if (!encoded) return;
  let text: string;
  try {
    text = await decodePlanParam(encoded);
  } catch (err) {
    // A z link failing on a webview without the deflate-raw codec is a browser
    // limitation, not a broken link — the codec reports it as a typed PlanError.
    showLoadReport(err instanceof PlanError ? t().error[err.code] : t().error.badPlanUrl);
    return;
  }
  loadFromText(text);
}
void loadPlanFromUrl();

// Desktop boot: gate on first-run consent, then check for updates. DEMO is
// statically false in the desktop build, so the browser demo bundle drops the
// update branch (and the updater imports) entirely; the consent gate is skipped
// at runtime there since it has no device control. The call is at the end of the
// module so CONSENT_KEY (a const requireConsent reads) is already initialized.
async function boot(): Promise<void> {
  await resetStorageIfRequested();
  await requireConsent();
  if (!DEMO) {
    if (getSettings().updateCheck) await checkForUpdates();
  }
}

// Desktop --reset-storage: the flag arrives async (after the synchronous init above
// already read localStorage), so clear it and reload once to re-init clean. A
// sessionStorage guard stops the still-present flag from looping the reload.
async function resetStorageIfRequested(): Promise<void> {
  let requested = false;
  try {
    requested = await resetStorageRequested();
  } catch {
    return; // flag query failed (e.g. command unavailable) — nothing to reset
  }
  if (!requested) return;
  try {
    if (sessionStorage.getItem(RESET_DONE_KEY) === "1") return; // already cleared this launch
    localStorage.clear();
    sessionStorage.setItem(RESET_DONE_KEY, "1");
  } catch {
    return; // storage unavailable — skip the reload to avoid a loop
  }
  location.reload();
  await new Promise(() => {}); // hold boot() until the reload takes over
}

const RESET_DONE_KEY = "urx-reset-done";

const CONSENT_KEY = "urx-disclaimer-accepted";

// First-run consent: the Windows installer shows the same notice, but the macOS
// drag-install and auto-updates bypass it, so gate the desktop app once. Stored
// acceptance survives updates, so an updated user is not asked again.
async function requireConsent(): Promise<void> {
  if (!isTauri()) return;
  let accepted = false;
  try {
    accepted = localStorage.getItem(CONSENT_KEY) === "1";
  } catch {
    // Storage unavailable: treat as not yet accepted and ask again, rather than
    // letting a throw reject boot() and leave the app running un-gated.
  }
  if (accepted) return;
  if (await showConsent()) {
    try {
      localStorage.setItem(CONSENT_KEY, "1");
    } catch {
      // ignore (storage may be unavailable; consent will be asked again next launch)
    }
    return;
  }
  // Declined: the app must not start without consent.
  await exitApp();
}

async function checkForUpdates(): Promise<UpdateCheckOutcome> {
  let accepted = false;
  try {
    const update = await checkUpdate();
    if (!update) return { kind: "upToDate" };
    if (!(await confirmDialog(t().confirm.update(update.version)))) {
      return { kind: "declined", version: update.version };
    }
    accepted = true;
    // An accepted update is the one outcome that leaves the Preferences modal:
    // the scrim would hide the download status. No-op at the launch check.
    prefs.close();
    setStatus(t().status.updateDownloading);
    await installUpdate(update.rid);
    // The new bundle is installed; relaunch into it. Nothing runs past here.
    await restartApp();
    return { kind: "installing" };
  } catch {
    // Before the accept this is best-effort — offline, or no release published yet:
    // the launch check stays silent and a manual check reports it through the
    // Preferences inline note. But once accepted, "Downloading update…" is on screen
    // with the modal closed, so a download/install failure has to clear that stuck
    // status and surface — otherwise it reads as a download that never ends.
    if (accepted) showError(t().prefs.updateCheckFailed);
    return { kind: "failed" };
  }
}

void boot();
