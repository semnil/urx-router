// Sample-rate-dependent feature limits. Transcribed from device-model.md
// ("Sample-rate-dependent constraints"): above 96 kHz the insert FX and the FX2
// bus are unavailable, and the stereo channels' EQ drops out at 176.4 / 192 kHz.
// Phase 2 surfaces these as warnings only; it does not forbid the connections
// themselves. Language-agnostic — the UI maps codes to messages.

import { parseRef, ref } from "../models/types";
import type { DeviceModel } from "../models/types";
import { insertFxControl, isStereoChannel } from "./control/translate";
import { INSERT_FX_NONE, insertFxAvailable } from "./control/params";
import type { InsertFxOption, InsertFxSlot } from "./control/params";
import type { Plan } from "./plan";
import { incomingConnection } from "./plan";
import { directOutTarget, isStereoLinkedPair, partnerChannel, possibleSources } from "./routing";

/** Selectable rates in Hz (44.1 kHz … 192 kHz). */
export const SAMPLE_RATES = [44100, 48000, 88200, 96000, 176400, 192000];

export const DEFAULT_SAMPLE_RATE = 48000;

export type RateWarning = "insFx" | "stereoEq" | "fx2";

export interface RateConstraints {
  warnings: RateWarning[];
  /** Node ids to badge as unavailable at the current rate. */
  disabledNodes: string[];
}

const FX2_NODE = "bus.fx2";

/** Rate above which the >96 kHz feature drops (INS FX, FX2, stereo EQ) kick in. */
const HI_RATE_HZ = 96000;

// The stereo channels' EQ is inert at 176.4 / 192 kHz — the block diagram flags the
// CH 5/6-11/12 EQ as "Disabled when sample rate is 176.4 kHz or 192 kHz". Mono
// channel and output-bus EQ are unaffected. Callers force the control OFF and lock
// it at those rates; the plan value is left intact so lowering the rate restores it.
export function channelEqUnavailable(nodeId: string, sampleRate: number): boolean {
  return isStereoChannel(nodeId) && sampleRate > HI_RATE_HZ;
}

/** True when the rate rules out every insert effect the model offers anywhere —
 *  the plan-independent half of insertFxAllRateLocked, over the whole catalog of
 *  controls instead of one node's menu. False for a model with no insert FX. */
function insertFxRateLocked(model: DeviceModel, sampleRate: number): boolean {
  let any = false;
  for (const node of model.nodes) {
    for (const option of insertFxControl(model, node.id)?.options ?? []) {
      if (option.value === INSERT_FX_NONE) continue;
      if (insertFxAvailable(option, sampleRate)) return false;
      any = true;
    }
  }
  return any;
}

export function rateConstraints(model: DeviceModel, sampleRate: number): RateConstraints {
  const warnings: RateWarning[] = [];
  const disabledNodes: string[] = [];
  const has = (id: string): boolean => model.nodes.some((n) => n.id === id);

  // Insert FX: read off the effects' own ceilings rather than a threshold of its
  // own, so this warning cannot contradict the per-node menu locks, which derive
  // the same fact from the same maxRate (an effect reaching higher than 96 kHz
  // would otherwise be warned about while its control stayed selectable).
  if (insertFxRateLocked(model, sampleRate)) warnings.push("insFx");
  // Above 96 kHz (i.e. 176.4 / 192 kHz) FX2 and the stereo-channel EQ drop out.
  if (sampleRate > HI_RATE_HZ) {
    // The stereo channels' EQ goes inert (see channelEqUnavailable). The strip still
    // passes audio — only its EQ dies — so this is a text warning, not a dimmed node.
    if (model.nodes.some((n) => n.kind === "channel" && isStereoChannel(n.id))) warnings.push("stereoEq");
    if (has(FX2_NODE)) {
      warnings.push("fx2");
      disabledNodes.push(FX2_NODE);
    }
  }
  return { warnings, disabledNodes };
}

/** Why an insert-FX option cannot be chosen: the rate is above its ceiling, or
 *  another node already holds the device-wide 1-of slot it needs. */
export type InsertFxLock = "rate" | "slot";

export interface InsertFxMenuEntry {
  option: InsertFxOption;
  /** Null when the option is selectable. */
  lock: InsertFxLock | null;
}

/** The device-wide slot a node's current insert-FX selection claims, if any.
 *  Shared with plan-validate.ts, whose slot-collision check censuses the same slots. */
export function insertFxSlotOf(model: DeviceModel, plan: Plan, nodeId: string): InsertFxSlot | undefined {
  const ifx = insertFxControl(model, nodeId);
  const value = plan.nodeParams[nodeId]?.insertFx;
  if (!ifx || value === undefined) return undefined;
  return ifx.options.find((o) => o.value === value)?.slot;
}

/** Every node whose selection claims each device-wide slot, in model order. */
export type InsertFxCensus = ReadonlyMap<InsertFxSlot, readonly string[]>;

/** One sweep of the whole model for who claims which slot. Holders stay a LIST
 *  rather than collapsing to one owner: a plan carrying a collision is loadable
 *  (the loader warns and offers to open it), so a slot claimed by this node AND
 *  another must still read as taken for this node's menu.
 *  A STEREO-linked MONO IN pair claims once, under the member the model lists first:
 *  measured, its two members mirror the selector and point at one engine instance,
 *  so the pair holds one effect between them. The gate is Signal Type, not PAN/BAL —
 *  the mirror was measured in both modes. Counting the app's own mirror as a second
 *  holder would lock the pair's menu against its own selection and report a file the
 *  app itself saved as a collision.
 *  Shared with plan-validate.ts, whose slot-collision check reads the same census. */
export function insertFxCensus(model: DeviceModel, plan: Plan): InsertFxCensus {
  const holders = new Map<InsertFxSlot, string[]>();
  for (const node of model.nodes) {
    const slot = insertFxSlotOf(model, plan, node.id);
    if (!slot) continue;
    const held = holders.get(slot) ?? [];
    const partner = isStereoLinkedPair(model, plan, node.id) ? partnerChannel(model, node.id) : undefined;
    if (partner !== undefined && held.includes(partner)) continue;
    holders.set(slot, [...held, node.id]);
  }
  return holders;
}

// The insert-FX menu of one node: every option its own control offers, each with
// the reason it is locked. Both reasons are UI-only — the write set is never
// gated by either (see architecture.md), so this decides what the screens offer
// and nothing about what is emitted. Empty for a node with no insert FX. The
// slot census skips the node itself — and its STEREO-linked partner, which shares the
// node's one claim — so the value it already holds stays selectable; No Effect has
// neither a ceiling nor a slot and is never locked.
// A caller rendering many menus in one pass passes the census in so the sweep
// runs once instead of per node.
export function insertFxMenu(
  model: DeviceModel,
  plan: Plan,
  nodeId: string,
  census?: InsertFxCensus,
): InsertFxMenuEntry[] {
  const ifx = insertFxControl(model, nodeId);
  if (!ifx) return [];
  const partner = isStereoLinkedPair(model, plan, nodeId) ? partnerChannel(model, nodeId) : undefined;
  const taken = new Set<InsertFxSlot>();
  for (const [slot, holders] of census ?? insertFxCensus(model, plan)) {
    if (holders.some((h) => h !== nodeId && h !== partner)) taken.add(slot);
  }
  return ifx.options.map((option) => ({
    option,
    lock: !insertFxAvailable(option, plan.sampleRate)
      ? "rate"
      : option.slot !== undefined && taken.has(option.slot)
        ? "slot"
        : null,
  }));
}

/** The effects a node may take right now: the menu minus every locked entry and
 *  minus No Effect, which is the absence of an effect rather than a choice of one. */
export function insertFxFree(menu: InsertFxMenuEntry[]): InsertFxOption[] {
  return menu.filter((e) => e.lock === null && e.option.value !== INSERT_FX_NONE).map((e) => e.option);
}

/** True when the rate alone rules out every effect in the menu (above 96 kHz none
 *  of them runs) — the case where a bypass switch has nothing left to bypass. */
export function insertFxAllRateLocked(menu: InsertFxMenuEntry[]): boolean {
  return menu.length > 0 && menu.every((e) => e.option.value === INSERT_FX_NONE || e.lock === "rate");
}

/** The menu entry for what a node currently holds — null when it holds nothing, holds
 *  No Effect, or names a value its own control does not offer (a value a readback can
 *  carry, since the loader does not gate it).
 *
 *  Its `lock` is the question every surface showing one node has to ask, and it is not the
 *  one `insertFxAllRateLocked` answers: the ceilings are per effect, so a node holding
 *  Pitch Fix at 88.2 kHz is off while the menu it came from still offers effects that run. */
export function insertFxSelectedEntry(menu: InsertFxMenuEntry[], value: number | undefined): InsertFxMenuEntry | null {
  if (value === undefined || value === INSERT_FX_NONE) return null;
  return menu.find((e) => e.option.value === value) ?? null;
}

// True when `channelId` is a stereo channel whose Ducker is on. The Ducker sits
// post-fader on the main path, so a PRE (pre-fader) send taps ahead of it and is
// not ducked — the inspector notes this on such a send.
export function channelDuckerOn(model: DeviceModel, plan: Plan, channelId: string): boolean {
  return model.nodes.some(
    (n) => n.kind === "ducker" && n.attachTo === channelId && plan.nodeParams[n.id]?.duckerOn === true,
  );
}

// Channels whose Ducker is ON while the channel is also tapped straight to a USB
// direct out (USB MAIN / SUB). That tap is the channel Rec Point, which the block
// diagram places ahead of the fader and Ducker, so the ducked signal never reaches
// the USB output — a silent surprise on a live output worth flagging (route via a
// STEREO / MIX bus instead). microSD Rec is deliberately excluded: recording the
// dry (pre-Ducker) signal is a standard workflow, and the Rec Point control already
// makes that tap an explicit choice, so a standing warning there would be noise.
// Returns the affected host-channel ids (the UI resolves them to labels).
export function duckerBypassWarnings(model: DeviceModel, plan: Plan): string[] {
  const hosts: string[] = [];
  for (const node of model.nodes) {
    if (node.kind !== "ducker" || !node.attachTo) continue;
    if (plan.nodeParams[node.id]?.duckerOn !== true) continue;
    const host = node.attachTo;
    const tapped = plan.connections.some(
      (c) => parseRef(c.from).nodeId === host && directOutTarget(model, c.from, c.to) === "usb",
    );
    if (tapped) hosts.push(host);
  }
  return hosts;
}

// The analog outputs speakers are patched to. They are the only destinations
// where a missing MONO is a routing choice rather than a permanent fact: the
// device carries [MONO] on the MONITOR buses alone (device-model.md §4), and a
// MONITOR can be patched to MAIN / LINE — while a USB output cannot take a
// MONITOR source at all (§6), so a standing "no MONO here" note there would be a
// lock nothing can unlock. Scoping this the same way duckerBypassWarnings leaves
// microSD Rec alone: state the caveat only where acting on it is possible.
// The monitor buses — the only nodes carrying the device's [MONO] switch, and the
// single home for these two ids: the console, the inspector and the MIDI catalog
// each used to spell them out again. Private: `isMonitorBus` is the question every
// caller actually has, and an exported list would be a second way to ask it. It
// was exported for one caller (the inspector's repaint footprint, which had to
// name every bus that could feed the output it showed); that caller now reads the
// plan and names the one it is patched from, so nothing outside is left.
const MONITOR_BUS_IDS = ["bus.mon1", "bus.mon2"] as const;
const MONITOR_BUSES = new Set<string>(MONITOR_BUS_IDS);

export function isMonitorBus(nodeId: string): boolean {
  return MONITOR_BUSES.has(nodeId);
}

/** Whether this output's MONO lock is one a routing change can remove — which is
 *  the same question as "may a MONITOR bus be patched here", so it is read from
 *  the model's own rules rather than from a list of ids. MAIN / LINE OUT qualify;
 *  a USB output cannot take a MONITOR source at all, so a standing note there
 *  would be a lock nothing can unlock. A model that gains an output is covered by
 *  whatever rules gave it one, which a hardcoded list would not be. */
export function canPatchFromMonitor(model: DeviceModel, nodeId: string): boolean {
  for (const from of possibleSources(model, ref(nodeId, "in"))) if (isMonitorBus(parseRef(from).nodeId)) return true;
  return false;
}

/** How MONO reads on an analog output, decided by the source it is patched from.
 *  `monitor` — the patch passes through MONITOR n, which owns the [MONO] switch
 *  (`on` is that switch's state). `none` — patched from STEREO / MIX / STREAMING,
 *  or not patched at all: nothing on this path can be switched to mono. */
export type OutputMono = { via: "monitor"; monitorId: string; on: boolean } | { via: "none" };

// Deliberately NOT a warning. Every state it reports is legal and common — a
// STEREO patch on MAIN OUT is the factory arrangement — so a card would fire on
// nearly every plan, and no tighter predicate exists: wanting mono on the
// speakers never appears in the plan, and `mono` being on elsewhere does not
// imply it (PHONES 1 / 2 are wired to the MONITOR buses, so a headphone-only
// mono check is exactly that state, and an A/B rig deliberately keeps one output
// stereo). The inspector states it as a standing row instead.
export function outputMono(plan: Plan, outputId: string): OutputMono {
  // incomingConnection rather than a hand-rolled find: it is the shared lookup for
  // a single-input receiver, it matches on the port and the kind, and it is what
  // translate.ts resolves the same patch with.
  const wire = incomingConnection(plan, ref(outputId, "in"), "patch");
  const source = wire ? parseRef(wire.from).nodeId : null;
  if (!source || !isMonitorBus(source)) return { via: "none" };
  // Truthiness, not `=== true`, because that is how the value reaches the device:
  // translate.ts writes `np.mono ? 1 : 0`, and the load funnel passes a finite numeric
  // leaf through without a type check. A plan authored elsewhere carrying `mono: 1`
  // therefore makes the unit sum to mono, and a strict comparison here would have the
  // row report OFF about a device that is ON.
  return { via: "monitor", monitorId: source, on: !!plan.nodeParams[source]?.mono };
}

/** Human label for a rate, e.g. 44100 → "44.1 kHz". */
export function formatRate(sampleRate: number): string {
  return `${sampleRate / 1000} kHz`;
}
