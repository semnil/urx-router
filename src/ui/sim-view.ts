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
}

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
class PlanTransport implements DeviceTransport {
  readonly kind = "bridge" as const;
  private readonly listeners = new Set<(n: Notify) => void>();
  private held = new Map<string, SimValue>();
  private closed = false;

  constructor(
    private readonly bindings: ReadonlyMap<string, SimBinding>,
    private readonly shipped: ReadonlyMap<ParamPath, ParamValue>,
    private readonly hooks: Pick<SimViewHooks, "getPlan" | "apply">,
  ) {}

  /** The paths the table binds. */
  paths(): Iterable<string> {
    return this.bindings.keys();
  }

  /** What the glass shows: the plan where the table answers, the unit as it ships elsewhere. */
  private current(): Map<string, SimValue> {
    const out = new Map<string, SimValue>(this.shipped);
    for (const [path, value] of readSim(this.bindings, this.hooks.getPlan())) out.set(path, value);
    return out;
  }

  snapshot(): Promise<Map<ParamPath, ParamValue>> {
    if (this.closed) return Promise.reject(new Error("closed"));
    this.held = this.current();
    return Promise.resolve(new Map(this.held));
  }

  writable(path: ParamPath): boolean {
    return this.bindings.get(path)?.write !== undefined;
  }

  write(path: ParamPath, value: ParamValue, onSent?: () => void): Promise<ParamValue> {
    if (this.closed) return Promise.reject(new Error("closed"));
    onSent?.();
    const binding = this.bindings.get(path);
    if (!binding?.write) return Promise.reject(new Error(`${path} is not the plan's`));
    const edit = binding.write(this.hooks.getPlan(), value);
    if (isRefusal(edit)) return Promise.reject(new Error(edit.refused));
    if (!this.hooks.apply(edit)) return Promise.reject(new Error("refused"));
    const taken = binding.read(this.hooks.getPlan()) ?? value;
    this.held.set(path, taken);
    return Promise.resolve(taken);
  }

  onNotify(listener: (n: Notify) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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

  /** A new plan or another model: the glass starts again on it. */
  reload(): void {
    const was = this.sim !== null || this.mounting !== null;
    this.unmount();
    if (was && this.visible) this.mounting = this.mount();
  }

  /** Live sync started or stopped, or the device link was taken or let go. */
  setLive(): void {
    if (this.transport) this.sim?.setLocks(this.hooks.locks(this.transport.paths()));
    if (this.visible) this.startMeters();
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
          clipSafe: () => false,
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
