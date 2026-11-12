// The unit's [Console Lock] (System firmware V1.5): its panel locked until the password is
// entered. The unit goes on taking writes over the link while it is locked, so it is the app that
// holds its own writes back — the operator's decision — and the app reads the lock and never
// writes it (params.ts CONSOLE_LOCK).
//
// The app learns it two ways. A live session reads it with its starting read and follows its
// notify. Every write outside a session reads it right after connecting, refuses to start when the
// unit is locked, and registers for its notify for as long as the write runs (`watchConsoleLock`):
// a lock that arrives then stops the write at its next command.
//
// While the app knows the unit is locked, `holdDeviceWrites` makes every vdSet / vdSetStr reject
// before it reaches the link, so a writer the lock handling does not name still sends nothing.

import type { DeviceModel } from "../../models/types";
import type { Plan } from "../plan";
import { holdDeviceWrites, vdGet, vdParamsSubscribe, WRITES_HELD, type ParamUpdate } from "../platform";
import { PARAMS } from "./params";
import { cmdAddr, planToCommands, planToNameWrites, type WriteScope } from "./translate";

/**
 * Whether two states of a plan put the same values on the unit: the same writes under `scope`,
 * names included. An edit that leaves this true — a node moved on the board, a note, a colour, a
 * value the scope leaves out — writes nothing, so Console Lock has no reason to refuse it.
 */
export function sameDeviceWrites(model: DeviceModel, a: Plan, b: Plan, scope: WriteScope): boolean {
  const writes = (p: Plan): string =>
    [
      ...planToCommands(model, p, scope).map((c) => `${cmdAddr(c)}=${c.vdValue}`),
      ...planToNameWrites(model, p).map((w) => `${w.param}:${w.y}=${JSON.stringify(w.value)}`),
    ].join(",");
  return writes(a) === writes(b);
}

/** Where the unit keeps its [Console Lock], as [paramId, x, y]. */
export const CONSOLE_LOCK_ADDR: [number, number, number] = [PARAMS.CONSOLE_LOCK.id, 0, 0];

/** Whether a raw value of the unit's says it is locked. */
export const consoleLockedOf = (raw: number): boolean => raw !== 0;

/** Whether a notify is the unit's [Console Lock]. */
export const isConsoleLockAddr = (p: Pick<ParamUpdate, "paramId" | "x" | "y">): boolean =>
  p.paramId === CONSOLE_LOCK_ADDR[0] && p.x === CONSOLE_LOCK_ADDR[1] && p.y === CONSOLE_LOCK_ADDR[2];

/** Read whether the unit is locked. The caller must have connected first. */
export async function readConsoleLock(
  get: (paramId: number, x: number, y: number) => Promise<number> = vdGet,
): Promise<boolean> {
  return consoleLockedOf(await get(...CONSOLE_LOCK_ADDR));
}

/** The prefix of the reason a run is stopped with when the unit goes into Console Lock. */
export const CONSOLE_LOCKED = "console-locked";

/**
 * The reason to abort a run's controller with when the unit goes into Console Lock. Named
 * `AbortError`, so every path that stops on a cancel stops on it the same way and at the same
 * place — the next command — and `stoppedByConsoleLock` tells the two apart afterwards.
 */
export function consoleLockAbort(): Error {
  const err = new Error(`${CONSOLE_LOCKED}: the unit went into Console Lock`);
  err.name = "AbortError";
  return err;
}

/**
 * Whether a run stopped because of Console Lock: given an abort signal, whether it was aborted
 * with `consoleLockAbort`; given an error, whether it is that reason or a write `holdDeviceWrites`
 * refused.
 */
export function stoppedByConsoleLock(cause: unknown): boolean {
  if (cause instanceof AbortSignal) return cause.aborted && stoppedByConsoleLock(cause.reason);
  const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return message.startsWith(`${CONSOLE_LOCKED}:`) || message.startsWith(`${WRITES_HELD}:`);
}

/** A write outside a live session, watched for Console Lock (`watchConsoleLock`). */
export interface LockWatch {
  /** The unit was locked when the watch started: the write must not start. */
  readonly lockedAtStart: boolean;
  /** Whether the unit went into Console Lock while the watch ran. */
  tripped(): boolean;
  /** Stop watching, and let writes through again. */
  stop(): void;
}

/** What `watchConsoleLock` reaches the unit through. */
export interface LockWatchIo {
  subscribe: typeof vdParamsSubscribe;
  get: (paramId: number, x: number, y: number) => Promise<number>;
}

/**
 * Watch the unit's [Console Lock] for a write outside a live session. Registers for its notify
 * first and reads it second, so a lock made between the two is not missed. Locked at the start,
 * writes are held and `lockedAtStart` says so; a lock announced later holds writes and calls
 * `onLock` once, where the caller stops its run. `stop()` releases both. A failed registration or
 * read rejects, with nothing left registered or held: a write that cannot tell whether the unit
 * is locked does not start. The caller must have connected first.
 */
export async function watchConsoleLock(
  onLock: () => void,
  io: LockWatchIo = { subscribe: vdParamsSubscribe, get: vdGet },
): Promise<LockWatch> {
  let tripped = false;
  let stopped = false;
  const trip = (): void => {
    if (tripped || stopped) return;
    tripped = true;
    holdDeviceWrites(true);
    onLock();
  };
  const unsubscribe = await io.subscribe([CONSOLE_LOCK_ADDR], (p) => {
    if (isConsoleLockAddr(p) && consoleLockedOf(p.value)) trip();
  });
  const release = (): void => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    holdDeviceWrites(false);
  };
  let lockedAtStart: boolean;
  try {
    lockedAtStart = await readConsoleLock(io.get);
  } catch (err) {
    release();
    throw err;
  }
  // Locked already: the caller refuses, and writes are held until it lets go.
  if (lockedAtStart && !tripped) {
    tripped = true;
    holdDeviceWrites(true);
  }
  return { lockedAtStart, tripped: () => tripped, stop: release };
}

/** A run that holds its own connection, watched for Console Lock (`watchRun`). */
export interface RunWatch {
  /** The run's signal: aborted by the caller's, and by Console Lock with `consoleLockAbort`. */
  readonly signal: AbortSignal;
  /** The unit was locked when the watch started: the run must not write. */
  readonly lockedAtStart: boolean;
  /** Stop watching, let writes through again, and stop following the caller's signal. */
  stop(): void;
}

/**
 * Watch a run that connects on its own (the self-test, the audit-prep writer) for Console Lock:
 * the signal it hands back is the one the run passes to every phase, so a lock stops the run at its
 * next command the way the caller's cancel does. The caller must have connected first.
 */
export async function watchRun(outer?: AbortSignal, io?: LockWatchIo): Promise<RunWatch> {
  const ctl = new AbortController();
  const follow = (): void => ctl.abort(outer?.reason);
  if (outer?.aborted) follow();
  else outer?.addEventListener("abort", follow, { once: true });
  let watch: LockWatch;
  try {
    watch = await watchConsoleLock(() => ctl.abort(consoleLockAbort()), io);
  } catch (err) {
    outer?.removeEventListener("abort", follow);
    throw err;
  }
  return {
    signal: ctl.signal,
    lockedAtStart: watch.lockedAtStart,
    stop: () => {
      outer?.removeEventListener("abort", follow);
      watch.stop();
    },
  };
}
