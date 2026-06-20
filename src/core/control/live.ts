// Live sync: while active, every plan edit is mirrored to the connected device
// as it happens. Rather than build a per-edit command for each control, this
// keeps a snapshot of what the device last received (captured from a full
// readback when sync turns on) and, on each debounced flush, re-translates the
// whole plan and sends only the addresses whose value changed. The whole-plan
// translate is pure (no IO), so the diff is cheap; the IO is just the deltas.
// Connection lifecycle (connect/disconnect) is owned by the caller, which holds
// the connection open for the duration of the session.

import type { DeviceModel } from "../../models/types";
import type { Plan } from "../plan";
import { vdSet, vdSetStr } from "../platform";
import { PARAMS } from "./params";
import type { ParamSpec } from "./params";
import { planToCommands, planToNameWrites } from "./translate";
import type { VdCommand, NameWrite } from "./translate";
import { sendConverging } from "./client";

// Coalesce rapid edits (a slider drag fires per pixel) into one flush so the
// single-threaded device worker is not flooded; the snapshot diff means only the
// final value of each address is sent.
const DEBOUNCE_MS = 120;

// Params whose write makes the device reset dependents (the catalog flags these
// with sideEffect). After sending one, the snapshot no longer reflects the
// device, so a flush that touched one reconciles via a converge round.
const SIDE_EFFECT = new Set(
  Object.entries(PARAMS as Record<string, ParamSpec>)
    .filter(([, spec]) => spec.sideEffect)
    .map(([name]) => name),
);

const cmdKey = (c: VdCommand): string => `${c.paramId}:${c.x}:${c.y}`;
const nameKey = (w: NameWrite): string => `${w.param}:${w.y}`;

export interface LiveSyncHooks {
  getModel: () => DeviceModel;
  getPlan: () => Plan;
  /** A write failed; sync is already stopped — the caller drops the connection. */
  onError: (message: string) => void;
  /** A flush sent `count` writes — for an optional, quiet "→ device" status. */
  onSent: (count: number) => void;
}

export class LiveSync {
  private active = false;
  private readonly snapshot = new Map<string, number>();
  private readonly nameSnapshot = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private pending = false;

  constructor(private readonly hooks: LiveSyncHooks) {}

  isActive(): boolean {
    return this.active;
  }

  /** Start syncing. Call right after a full readback, so the snapshot equals the device. */
  begin(): void {
    this.captureSnapshot();
    this.active = true;
  }

  /** Stop syncing and cancel any pending flush. Does not touch the connection. */
  end(): void {
    this.active = false;
    this.pending = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Note a plan change; a flush runs after the debounce settles. No-op when inactive. */
  schedule(): void {
    if (!this.active) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, DEBOUNCE_MS);
  }

  // Rebuild the snapshot to the plan's current implied state — the device truth
  // right after a readback, or after a converge round has matched the device.
  private captureSnapshot(): void {
    this.snapshot.clear();
    this.nameSnapshot.clear();
    const model = this.hooks.getModel();
    const plan = this.hooks.getPlan();
    for (const c of planToCommands(model, plan)) this.snapshot.set(cmdKey(c), c.vdValue);
    for (const w of planToNameWrites(model, plan)) this.nameSnapshot.set(nameKey(w), w.value);
  }

  private async flush(): Promise<void> {
    if (!this.active) return;
    if (this.flushing) {
      this.pending = true;
      return;
    }
    this.flushing = true;
    try {
      const model = this.hooks.getModel();
      const plan = this.hooks.getPlan();
      let sent = 0;
      let sideEffect = false;
      for (const c of planToCommands(model, plan)) {
        const k = cmdKey(c);
        if (this.snapshot.get(k) === c.vdValue) continue;
        await vdSet(c.paramId, c.x, c.y, c.vdValue);
        this.snapshot.set(k, c.vdValue);
        sent++;
        if (SIDE_EFFECT.has(c.name)) sideEffect = true;
      }
      for (const w of planToNameWrites(model, plan)) {
        const k = nameKey(w);
        if (this.nameSnapshot.get(k) === w.value) continue;
        await vdSetStr(w.param, 0, w.y, w.value);
        this.nameSnapshot.set(k, w.value);
        sent++;
      }
      if (sideEffect) {
        // The device reset dependents; converge against its post-reset state and
        // rebuild the snapshot so the next diff measures from the device truth.
        await sendConverging(model, plan);
        this.captureSnapshot();
      }
      if (sent) this.hooks.onSent(sent);
    } catch (e) {
      this.active = false;
      this.hooks.onError(e instanceof Error ? e.message : String(e));
      return;
    } finally {
      this.flushing = false;
    }
    if (this.pending) {
      this.pending = false;
      void this.flush();
    }
  }
}
