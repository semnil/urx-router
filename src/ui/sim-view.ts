// The SIM view: the unit's LCD, drawn by urx-lcd-sim, as a third editing surface beside
// the GRAPH and the CONSOLE (an experimental launch only).
//
// The glass reads and writes the plan through the paths core/sim-map.ts answers, and
// hands every edit to the host's funnels, the ones the Inspector and the tuning screens
// use — so undo, Live sync and device follow take it as one of theirs. Every other
// change to the plan reaches the glass through `planChanged()`. The unit's own
// operations (a scene recall, the card, the recorder) are refused: the plan holds none
// of them. The meters read the session's meter stream while Live sync is on and the
// view is up, and read nothing otherwise.

import type { DeviceModel } from "../models/types";
import type { Plan } from "../core/plan";
import { isRefusal, readSim, simBindings, type SimBinding, type SimEdit, type SimValue } from "../core/sim-map";
import { simStripId } from "../core/sim-map-base";
import { MeterStore, sidechainTap, subscribeMeters, tapAddrs, tapFor, tapsFor, type MeterTap } from "../core/meters";
import type { SimScale } from "../app/view-state";
import type { SimLockSpec } from "../core/sim-locks";
import fontRegular from "urx-lcd-sim/fonts/IBMPlexSans-Regular.ttf?url";
import fontMedium from "urx-lcd-sim/fonts/IBMPlexSans-Medium.ttf?url";
import type { DeviceTransport, EmbeddedSim, Notify, ParamPath, ParamValue, UnitOp } from "urx-lcd-sim/embed";

export interface SimViewHooks {
  getModel: () => DeviceModel;
  getPlan: () => Plan;
  /** Hand an edit to the funnel that takes it. False when it was refused. */
  apply: (edit: SimEdit) => boolean;
  /** An operation of the unit's own the plan cannot carry out. */
  onRefusedAction: (op: UnitOp) => void;
  isLive: () => boolean;
  /** The controls the glass holds shut, each with its reason, among the paths the table binds. */
  locks: (paths: Iterable<string>) => SimLockSpec[];
  /** Take the session's one meter subscription from the CONSOLE, and give it back. */
  releaseMeters: () => void;
  regainMeters: () => void;
  onMeterError: (message: string) => void;
  /** The unit's [Sends] destination while a session holds it, or null with none. */
  unitSendsTarget: () => string | null;
  /** Hand a [Sends] destination chosen on the glass to the unit. False when it was refused. */
  setUnitSendsTarget: (target: string) => boolean;
  /** Every strip's [CUE] as the session holds it, by node id, or null with no session. */
  unitCues: () => ReadonlyMap<string, boolean> | null;
  /** Turn one strip's [CUE] on or off on the unit. False when it was refused. */
  setUnitCue: (node: string, on: boolean) => boolean;
  /** Turn every [CUE] off on the unit, as the status bar's Clear CUE does. False when it was refused. */
  clearUnitCues: () => boolean;
  /** The output strips the unit puts back once the last input cue is turned off, by node id, or
   *  null with no session. */
  unitCueMemory: () => readonly string[] | null;
  /** The values the unit holds outside the plan that the app knows — its SETUP > GENERAL settings,
   *  Follow USB, the operation mode — by the glass's path. */
  unitValues: () => ReadonlyMap<string, SimValue>;
  /** Whether an edit of `path` goes to the unit rather than to the plan. */
  isUnitPath: (path: string) => boolean;
  /** Hand an edit of one of the unit's values to the unit. Resolves with the value the glass shows
   *  for it once the edit is taken, and rejects when it is refused. */
  writeUnitValue: (path: string, value: SimValue) => Promise<SimValue>;
  /** Whether the Clip Safe of MIC/LINE jack `jack` (0 = the first) is holding its gain down, as the
   *  unit last announced it. */
  clipSafeEngaged: (jack: number) => boolean;
}

type CueHooks = Pick<SimViewHooks, "unitCues" | "setUnitCue" | "clearUnitCues" | "unitCueMemory">;

/** The glass's path for the outputs it puts back once the last input cue is turned off. */
const CUE_OUTPUT_MEMORY = "ui.cueOutputMemory";
type TransportHooks = Pick<
  SimViewHooks,
  "getPlan" | "apply" | "unitSendsTarget" | "setUnitSendsTarget" | "unitValues" | "isUnitPath" | "writeUnitValue"
> &
  CueHooks;

/** The glass's path for HOME's [Sends] destination, which the unit holds outside the plan. */
export const SENDS_TARGET_PATH = "ui.sendsTarget";

/** The simulator's own state, kept by the view rather than the plan: which channel a linked pair's
 *  compressors hear (written with the pair's link or COMP / EQ type), the recorder's playback (which
 *  a rate change stops), the output cues its CUE rule remembers to put back, and what a screen has
 *  open or picked — the output patch's and the Peripheral screen's tab, the scene list's row (until
 *  the unit's cursor moves: `unitTookOwn`) and bank (until it moves onto a row one bank alone lists),
 *  the microSD folder and file, the User Defined Knobs
 *  bank on show. */
const GLASS_OWN = new Set([
  "sd.playing",
  "sd.playingFile",
  "setup.outputPatch.tab",
  "scene.bank",
  "scene.selected",
  "sd.path",
  "sd.selectedFile",
  CUE_OUTPUT_MEMORY,
  "setup.udk.bank",
  "setup.peripheral.tab",
]);
const glassOwn = (path: string): boolean => GLASS_OWN.has(path) || /^pair\.[^.]+\.compSplit$/.test(path);

/** The urx-router meter tap a simulator meter id reads, by the simulator's tap name. */
const TAP_KEYS: Record<string, string> = {
  input: "input",
  preGate: "pregate",
  preComp: "precomp",
  preEq: "preeq",
  preIns: "preinsfx",
  preFader: "prefader",
  preDucker: "preducker",
  post: "post",
  sum: "preeq",
  effect: "prefader",
};

/** The plan's node id of a simulator strip id. */
const nodeOf = (strip: string): string => (strip === "fx1" || strip === "fx2" ? `bus.${strip}` : strip);

/** The glass's path for a strip's [CUE], which the unit holds outside the plan. */
const cuePath = (node: string): string => `ch.${simStripId(node)}.cue`;
const CUE_PATH = /^ch\.(.+)\.cue$/;

/**
 * Hand one press's [CUE] writes to the unit. The glass applies the unit's group rule itself and
 * writes every flag it moved, so one press arrives as several writes; the press is what is handed
 * on, and the unit and the session apply the rule to it. The glass is shown the outputs the unit
 * puts back (`unitCueMemory`), so turning the last input cue off arrives as that cue off with
 * exactly those outputs back on: it is handed on as the cue turned off, and the unit puts them
 * back. An output among them pressed alone is a press of that output. Any other flag turned on
 * is the press — the flags its rule turned off are already off once it
 * lands — and a press that only turns flags off is the glass's CLEAR CUE when it leaves nothing
 * cued.
 */
export function applyGlassCues(changes: readonly { node: string; on: boolean }[], hooks: CueHooks): boolean {
  if (!hooks.unitCues()) return false;
  const cued = (node: string): boolean | undefined => hooks.unitCues()?.get(node);
  const ons = changes.filter((c) => c.on && cued(c.node) === false);
  const offs = changes.filter((c) => !c.on && cued(c.node) === true);
  const memory = hooks.unitCueMemory() ?? [];
  const restores = ons.length === memory.length && ons.every((c) => memory.includes(c.node));
  if (ons.length && offs.length && restores) {
    for (const c of offs) if (cued(c.node) === true && !hooks.setUnitCue(c.node, false)) return false;
    return true;
  }
  for (const c of ons) if (cued(c.node) === false && !hooks.setUnitCue(c.node, true)) return false;
  if (!ons.length && offs.length) {
    const left = [...(hooks.unitCues() ?? [])].filter(([node, on]) => on && !offs.some((c) => c.node === node));
    if (!left.length) return hooks.clearUnitCues();
  }
  for (const c of offs) if (cued(c.node) === true && !hooks.setUnitCue(c.node, false)) return false;
  return true;
}

/** The tap a simulator meter id reads on `modelId`, or null for one the session does not meter. */
export function simMeterTap(id: string, modelId: string): MeterTap | null {
  const monitor = /^monitor\.(\d)$/.exec(id);
  if (monitor) return tapFor(`bus.mon${monitor[1]}`, "post", modelId) ?? null;
  if (id === "osc") return tapFor("bus.osc", "post", modelId) ?? null;
  const [strip = "", tap = "post"] = id.split("@");
  const node = nodeOf(strip);
  if (tap === "sideChain") return sidechainTap(node, modelId) ?? null;
  const key = TAP_KEYS[tap];
  if (!key) return null;
  // A stereo channel's chain has no PRE EQ point of its own: it is its INPUT.
  const taps = tapsFor(node, modelId);
  return taps.find((t) => t.key === key) ?? (key === "preeq" ? (taps.find((t) => t.key === "input") ?? null) : null);
}

/** The plan as the glass's transport: values read off the plan, edits handed to the funnels. */
export class PlanTransport implements DeviceTransport {
  readonly kind = "bridge" as const;
  private readonly listeners = new Set<(n: Notify) => void>();
  private held = new Map<string, SimValue>();
  /** The simulator's own values (`glassOwn`), kept here rather than in the plan. */
  private own = new Map<string, SimValue>();
  private closed = false;

  constructor(
    private readonly bindings: ReadonlyMap<string, SimBinding>,
    private readonly shipped: ReadonlyMap<ParamPath, ParamValue>,
    private readonly hooks: TransportHooks,
  ) {}

  /** The [CUE] writes of the press being made, handed on together once it has made them all. */
  private cueBatch: { node: string; on: boolean; done: (taken: boolean | null) => void }[] = [];

  /** The paths the table binds. */
  paths(): Iterable<string> {
    return this.bindings.keys();
  }

  /** What the glass shows: the plan where the table answers, the [Sends] destination the session
   *  holds, and the unit as it ships elsewhere. */
  private current(): Map<string, SimValue> {
    const out = new Map<string, SimValue>(this.shipped);
    for (const [path, value] of readSim(this.bindings, this.hooks.getPlan())) out.set(path, value);
    const sends = this.hooks.unitSendsTarget();
    if (sends !== null) out.set(SENDS_TARGET_PATH, sends);
    for (const [node, on] of this.hooks.unitCues() ?? []) out.set(cuePath(node), on);
    for (const [path, value] of this.hooks.unitValues()) out.set(path, value);
    for (const [path, value] of this.own) out.set(path, value);
    const memory = this.hooks.unitCueMemory();
    if (memory) out.set(CUE_OUTPUT_MEMORY, memory.map(simStripId).join(","));
    return out;
  }

  snapshot(): Promise<Map<ParamPath, ParamValue>> {
    if (this.closed) return Promise.reject(new Error("closed"));
    this.held = this.current();
    return Promise.resolve(new Map(this.held));
  }

  writable(path: ParamPath): boolean {
    if (path === SENDS_TARGET_PATH) return this.hooks.unitSendsTarget() !== null;
    const cue = CUE_PATH.exec(path);
    if (cue) return this.hooks.unitCues()?.has(nodeOf(cue[1]!)) ?? false;
    if (this.hooks.isUnitPath(path)) return true;
    if (glassOwn(path)) return true;
    return this.bindings.get(path)?.write !== undefined;
  }

  write(path: ParamPath, value: ParamValue, onSent?: () => void): Promise<ParamValue> {
    if (this.closed) return Promise.reject(new Error("closed"));
    onSent?.();
    if (path === SENDS_TARGET_PATH) {
      if (!this.hooks.setUnitSendsTarget(String(value))) return Promise.reject(new Error("refused"));
      this.held.set(path, value);
      return Promise.resolve(value);
    }
    const cue = CUE_PATH.exec(path);
    if (cue && this.hooks.unitCues()?.has(nodeOf(cue[1]!))) return this.writeCue(path, nodeOf(cue[1]!), value === true);
    if (this.hooks.isUnitPath(path))
      return this.hooks.writeUnitValue(path, value).then((taken) => {
        if (!this.closed) this.held.set(path, taken);
        return taken;
      });
    if (glassOwn(path)) {
      this.own.set(path, value);
      this.held.set(path, value);
      return Promise.resolve(value);
    }
    const binding = this.bindings.get(path);
    if (!binding?.write) return Promise.reject(new Error(`${path} is not the plan's`));
    const edit = binding.write(this.hooks.getPlan(), value);
    if (isRefusal(edit)) return Promise.reject(new Error(edit.refused));
    if (!this.hooks.apply(edit)) return Promise.reject(new Error("refused"));
    const taken = binding.read(this.hooks.getPlan()) ?? value;
    this.held.set(path, taken);
    // A value the plan took differently — kept as it was, or brought to its step — goes back
    // to the glass as the answer to this write, once the write has gone out.
    if (taken !== value)
      queueMicrotask(() => {
        if (this.closed) return;
        for (const listener of this.listeners) listener({ path, value: taken, echo: true });
      });
    return Promise.resolve(taken);
  }

  /** One [CUE] write, held until the press has made all of its writes. */
  private writeCue(path: string, node: string, on: boolean): Promise<ParamValue> {
    return new Promise<ParamValue>((resolve, reject) => {
      if (!this.cueBatch.length)
        queueMicrotask(() => {
          const batch = this.cueBatch;
          this.cueBatch = [];
          const ok = !this.closed && applyGlassCues(batch, this.hooks);
          for (const w of batch) w.done(ok ? (this.hooks.unitCues()?.get(w.node) ?? null) : null);
        });
      this.cueBatch.push({
        node,
        on,
        done: (taken) => {
          if (taken === null) {
            reject(new Error("refused"));
            return;
          }
          this.held.set(path, taken);
          resolve(taken);
        },
      });
    });
  }

  onNotify(listener: (n: Notify) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Let go of the glass's own values at `paths`, so the unit's show again. */
  yieldOwn(paths: Iterable<string>): void {
    for (const path of paths) this.own.delete(path);
  }

  /** Tell the glass every value the plan now holds differently. */
  push(): void {
    if (this.closed) return;
    const now = this.current();
    for (const [path, value] of now) {
      if (this.held.get(path) === value) continue;
      for (const listener of this.listeners) listener({ path, value, echo: false });
    }
    this.held = now;
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }
}

export class SimView {
  private sim: EmbeddedSim | null = null;
  private transport: PlanTransport | null = null;
  private mounting: Promise<void> | null = null;
  /** Which mount is the current one: a reload while one is in flight leaves it to let itself go. */
  private mountGen = 0;
  private visible = false;
  private scale: SimScale;
  private pushQueued = false;
  private readonly meters = new MeterStore();
  private unsubMeters: (() => void) | null = null;
  private meterGen = 0;
  /** Whether the CONSOLE's meter subscription is lent to this view. */
  private lent = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly hooks: SimViewHooks,
    scale: SimScale,
  ) {
    this.scale = scale;
  }

  show(): void {
    this.visible = true;
    this.host.hidden = false;
    if (!this.sim && !this.mounting) this.mounting = this.mount();
    this.startMeters();
  }

  hide(): void {
    this.visible = false;
    this.host.hidden = true;
    this.stopMeters();
  }

  setScale(scale: SimScale): void {
    this.scale = scale;
    this.sim?.setZoom(scale);
  }

  /** The plan changed under the glass, by any writer. */
  planChanged(): void {
    if (this.pushQueued || !this.transport) return;
    this.pushQueued = true;
    queueMicrotask(() => {
      this.pushQueued = false;
      this.transport?.push();
      if (this.transport) this.sim?.setLocks(this.hooks.locks(this.transport.paths()));
    });
  }

  /** The unit's [Sends] destination changed, or the session that held it started or ended. */
  unitStateChanged(): void {
    this.planChanged();
  }

  /** A value the unit holds moved at `paths`, which the glass keeps as its own once chosen there:
   *  the unit's shows again. */
  unitTookOwn(paths: Iterable<string>): void {
    this.transport?.yieldOwn(paths);
    this.planChanged();
  }

  /** A new plan or another model: the glass starts again on it. */
  reload(): void {
    const was = this.sim !== null || this.mounting !== null;
    this.unmount();
    if (was && this.visible) this.mounting = this.mount();
  }

  /** Live sync started or stopped. */
  setLive(): void {
    this.relock();
    if (this.visible) this.startMeters();
  }

  /** Something the app's locks read moved: Live sync, or the device link taken or let go. */
  relock(): void {
    if (this.transport) this.sim?.setLocks(this.hooks.locks(this.transport.paths()));
  }

  private async mount(): Promise<void> {
    const gen = ++this.mountGen;
    const embed = await import("urx-lcd-sim/embed");
    const model = this.hooks.getModel();
    const bindings = simBindings(model);
    const transport = new PlanTransport(bindings, embed.shippedValues(model.id), this.hooks);
    const sim = await embed.mountSim(this.host, {
      model: model.id,
      unit: {
        params: transport,
        levels: {
          kind: "device",
          read: (id, channels) => this.readLevels(id, channels),
          clipSafe: (connector) => this.hooks.clipSafeEngaged(connector - 1),
        },
        clock: embed.computerClock,
        actions: embed.refusedActions(this.hooks.onRefusedAction),
      },
      fonts: { "IBMPlexSans-Regular.ttf": fontRegular, "IBMPlexSans-Medium.ttf": fontMedium },
      zoom: this.scale,
      locks: this.hooks.locks(bindings.keys()),
      // The plan keeps an insert's values across effects, so a choice on the glass takes them from it.
      insertValuesFromPage: true,
    });
    if (gen !== this.mountGen) {
      sim.dispose();
      return;
    }
    this.sim = sim;
    this.transport = transport;
    this.mounting = null;
  }

  private unmount(): void {
    this.mountGen++;
    this.mounting = null;
    this.sim?.dispose();
    this.sim = null;
    this.transport = null;
  }

  private readLevels(id: string, channels: number): number[] {
    const reading = this.meters.readingTap(simMeterTap(id, this.hooks.getModel().id));
    if (!reading) return Array.from({ length: channels }, () => Number.NaN);
    return channels === 1 ? [Math.max(reading.l, reading.r)] : [reading.l, reading.r];
  }

  private startMeters(): void {
    if (!this.visible || !this.hooks.isLive()) {
      this.stopMeters();
      return;
    }
    // Started already, or on its way.
    if (this.lent) return;
    const gen = ++this.meterGen;
    this.hooks.releaseMeters();
    this.lent = true;
    const modelId = this.hooks.getModel().id;
    const taps = this.hooks.getModel().nodes.flatMap((n) => tapsFor(n.id, modelId));
    subscribeMeters(this.meters, tapAddrs(taps))
      .then((unsub) => {
        if (gen === this.meterGen && this.visible) this.unsubMeters = unsub;
        else unsub();
      })
      .catch((e: unknown) => {
        if (gen === this.meterGen) this.hooks.onMeterError(e instanceof Error ? e.message : String(e));
      });
  }

  private stopMeters(): void {
    this.meterGen++;
    this.unsubMeters?.();
    this.unsubMeters = null;
    this.meters.clear();
    if (this.lent) {
      this.lent = false;
      this.hooks.regainMeters();
    }
  }
}
