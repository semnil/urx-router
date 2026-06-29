import { afterEach, describe, expect, it, vi } from "vitest";
import { vdConnect, vdDisconnect, vdSet } from "../platform";

// End-to-end (JS boundary) reproduction of the connection-lifecycle race that
// produced a full URX44V write report of "not connected" / "unreadable": a live
// session is torn down (its disconnect is fire-and-forget), a later write
// connects, and the stale teardown lands after the new connect. These drive the
// REAL platform.ts wrappers against a faithful in-memory model of the Rust
// VdState, so they verify the wire contract (vdConnect returns an epoch,
// vdDisconnect sends it back) and that the epoch closes the race. The Rust unit
// tests in vd.rs cover the same interleaving on the actual server-side state.

// A model of VdState.install/sender/disconnect. `guardEpoch` mirrors the fix
// (disconnect only closes its own generation); flipping it off reproduces the
// pre-fix blind disconnect that nulled a newer connection.
function makeBroker(opts: { guardEpoch: boolean }) {
  const state = { tx: null as { id: number } | null, epoch: 0 };
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const invoke = async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "vd_connect": {
        // install: replace any prior worker, bump the generation, return it.
        state.epoch += 1;
        state.tx = { id: state.epoch };
        return { model: "URX44V", label: "URX44V", epoch: state.epoch };
      }
      case "vd_disconnect": {
        const epoch = args?.epoch as number;
        if (!opts.guardEpoch || state.epoch === epoch) state.tx = null;
        return undefined;
      }
      case "vd_set": {
        if (!state.tx) throw "not connected"; // sender() == None on the Rust side
        return undefined;
      }
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  };
  return { invoke, calls };
}

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
function installBroker(broker: { invoke: InvokeFn }): void {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke: broker.invoke } });
}

afterEach(() => vi.unstubAllGlobals());

describe("connection lifecycle race", () => {
  // The reported scenario: live connects, its fire-and-forget teardown is issued,
  // a write connects (new generation) before the teardown takes effect, then the
  // stale teardown lands. With the epoch guard the write's connection survives.
  it("a stale live-teardown disconnect does not break a later write", async () => {
    const broker = makeBroker({ guardEpoch: true });
    installBroker(broker);

    // activateLive captured this epoch (main.ts: liveEpoch = device.epoch).
    const live = await vdConnect();

    // The write's withDevice connects, replacing the worker with a new generation.
    const write = await vdConnect();
    expect(write.epoch).not.toBe(live.epoch);

    // The live teardown's disconnect lands now (deactivateLive fired it without
    // awaiting). It targets the OLD generation, so it must be a no-op.
    await vdDisconnect(live.epoch);

    // The write streams its parameters: none may see "not connected".
    await expect(vdSet(140, 0, 0, 1)).resolves.toBeUndefined();

    // withDevice releases exactly its own connection afterwards.
    await vdDisconnect(write.epoch);
    expect(broker.calls).toContainEqual({ cmd: "vd_disconnect", args: { epoch: write.epoch } });
  });

  // Same interleaving against a broker that ignores the epoch (the pre-fix blind
  // disconnect): the stale teardown nulls the write's connection and every set
  // fails with the exact "not connected" of the field report — proving the test
  // discriminates and that the epoch is what closes the race.
  it("without the epoch guard the same sequence reproduces the failure", async () => {
    const broker = makeBroker({ guardEpoch: false });
    installBroker(broker);

    const live = await vdConnect();
    await vdConnect(); // the write installs a newer generation
    await vdDisconnect(live.epoch); // blindly nulls the write's connection

    await expect(vdSet(140, 0, 0, 1)).rejects.toBe("not connected");
  });

  // The wire contract the Rust guard depends on: vdDisconnect must send the epoch
  // back as the command argument.
  it("vdDisconnect sends the connection's epoch to the command", async () => {
    const broker = makeBroker({ guardEpoch: true });
    installBroker(broker);

    const conn = await vdConnect();
    await vdDisconnect(conn.epoch);

    expect(broker.calls.at(-1)).toEqual({ cmd: "vd_disconnect", args: { epoch: conn.epoch } });
  });
});
