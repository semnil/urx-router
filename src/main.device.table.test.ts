// @vitest-environment jsdom

// The device table every desktop case runs on, the count its quiet waits read, and the drain its
// teardown ends with, each stated as a contract of its own.
//
// The setup, the teardown and the helpers every desktop case shares are `main.device.test-util.ts`'s,
// which also states what the device table does and does not model.

import { describe, expect, it, vi } from "vitest";
import { deviceCommands } from "./main.test-util";
import { PARAMS } from "./core/control/params";
import { FEEDBACK_DEBOUNCE_MS } from "./ui/midi";
import { POLL_MS } from "./ui/param-watch";
import {
  SLOW,
  bootDevice,
  DRAIN_QUIET_READINGS,
  DRAIN_READING_MS,
  flowInvokes,
  live,
  quiet,
  turnOscOn,
} from "./main.device.test-util";

// The device table's own contract, which no other desktop case can state: it is the fixture all of
// them run on, so a loosening here is invisible from inside them and every one of them goes
// on passing. What it copies is the shell (`src-tauri/src/vd.rs`): every vd command but
// connect, disconnect and the link stats goes through `sender()`, which answers
// "not-connected" while no worker is installed, and `disconnect` closes only the generation
// whose epoch it is handed.

describe("the device table the desktop cases run on", () => {
  /** One command out of the table, called the way the shell calls it. */
  const call = (table: Record<string, unknown>, cmd: string, a: Record<string, unknown> = {}): unknown =>
    (table[cmd] as (x: Record<string, unknown>) => unknown)(a);
  const CH1 = { paramId: PARAMS.CH_FADER.id, x: 0, y: 0 };

  it("refuses device traffic until a connection is open, and again once it is released", () => {
    const table = deviceCommands();
    expect(() => call(table, "vd_get", CH1)).toThrow(/not-connected/);

    const { epoch } = call(table, "vd_connect") as { epoch: number };
    expect(call(table, "vd_get", CH1)).toBe(0);

    call(table, "vd_disconnect", { epoch });
    expect(() => call(table, "vd_get", CH1)).toThrow(/not-connected/);
  });

  // The subscriptions reach the shell through that same `sender()`. Answering them while
  // disconnected would let a session start over a link that is not there.
  it("refuses the subscriptions on the same rule as the reads", () => {
    const table = deviceCommands();
    const subs = ["vd_params_subscribe", "vd_meters_subscribe", "vd_watch_link"];
    for (const cmd of subs) expect(() => call(table, cmd)).toThrow(/not-connected/);
    call(table, "vd_connect");
    for (const cmd of subs) expect(call(table, cmd)).toBeNull();
  });

  // A stale epoch closes nothing: the app opens a connection inside a live session and
  // releases it again, and a teardown that ignored the epoch would end the session.
  it("closes only the generation the disconnect names", () => {
    const table = deviceCommands();
    const first = (call(table, "vd_connect") as { epoch: number }).epoch;
    const second = (call(table, "vd_connect") as { epoch: number }).epoch;
    expect(second).not.toBe(first);

    call(table, "vd_disconnect", { epoch: first });
    expect(call(table, "vd_get", CH1)).toBe(0);
    call(table, "vd_disconnect", { epoch: second });
    expect(() => call(table, "vd_get", CH1)).toThrow(/not-connected/);
  });

  // What a case overrides is what the unit REPORTS, and the bookkeeping is not part of
  // that. Written as a plain answer it used to replace the whole command: three cases then
  // drove a model switch whose every read was refused, by a table that was answering
  // correctly.
  it("keeps the connection when a case says what the unit reports", () => {
    const table = deviceCommands({ vd_connect: { model: "URX22", label: "URX22", firmware: "1.0.0.0", epoch: 0 } });
    const answer = call(table, "vd_connect") as { model: string; epoch: number };
    expect(answer.model).toBe("URX22");
    // The generation is the table's to assign, so the one written into the answer is
    // replaced rather than handed back. 0 is a value the counter never produces.
    expect(answer.epoch).not.toBe(0);
    expect(call(table, "vd_get", CH1)).toBe(0);
  });

  // Counted for the whole run rather than per table: a table restarting at 1 gives an app
  // a generation that a disconnect leaked from an EARLIER one matches, and that teardown
  // then closes a connection it never opened — every read after it refused, on a link the
  // case believes is up. The shell's own counter lives in the process (`vd.rs`), which a
  // page load does not restart either.
  it("does not restart the generation for a new table", () => {
    const first = (call(deviceCommands(), "vd_connect") as { epoch: number }).epoch;
    const second = (call(deviceCommands(), "vd_connect") as { epoch: number }).epoch;
    expect(second).toBeGreaterThan(first);
  });

  // A reader or writer a case supplies says what the unit HOLDS, and the connection rule is
  // still the table's: answered regardless, a read issued after the link was released
  // succeeds here and fails on every real unit.
  it("refuses a case's own reader and writer on the same rule", () => {
    const table = deviceCommands({ vd_get: () => 7, vd_set: () => undefined });
    const write = { ...CH1, value: 1 };
    expect(() => call(table, "vd_get", CH1)).toThrow(/not-connected/);
    expect(() => call(table, "vd_set", write)).toThrow(/not-connected/);

    const { epoch } = call(table, "vd_connect") as { epoch: number };
    expect(call(table, "vd_get", CH1)).toBe(7);
    expect(call(table, "vd_set", write)).toBeUndefined();

    call(table, "vd_disconnect", { epoch });
    expect(() => call(table, "vd_get", CH1)).toThrow(/not-connected/);
    expect(() => call(table, "vd_set", write)).toThrow(/not-connected/);
  });

  // …and the same for one a case installs on the shell once the app is up.
  it("refuses a reader a case answers on the booted shell", async () => {
    const shell = await bootDevice();
    shell.answer("vd_get", 7);
    const invoke = (
      window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: object) => Promise<unknown> } }
    ).__TAURI_INTERNALS__.invoke;
    await expect(invoke("vd_get", CH1)).rejects.toThrow(/not-connected/);
    const { epoch } = (await invoke("vd_connect")) as { epoch: number };
    await expect(invoke("vd_get", CH1)).resolves.toBe(7);
    await invoke("vd_disconnect", { epoch });
    await expect(invoke("vd_get", CH1)).rejects.toThrow(/not-connected/);
  });

  // …and a connect that FAILS installs nothing, which is what the cases stubbing a broken
  // link rest on.
  it("stays disconnected when the connect itself fails", () => {
    const table = deviceCommands({
      vd_connect: () => {
        throw new Error("no-device");
      },
    });
    expect(() => call(table, "vd_connect")).toThrow(/no-device/);
    expect(() => call(table, "vd_get", CH1)).toThrow(/not-connected/);
  });
});

// The count the live cases wait on for the app to go quiet (`quiet`, and the waits the FX and live
// session cases write out themselves): they end on a run of readings in which it does not move. It leaves the dev build's parameter watch
// out, which reads its addresses once a second for as long as a session is up, whatever the app is
// doing.
describe("the count a desktop case waits on for the app to go quiet", () => {
  it("leaves out the parameter watch and counts what the app's own flows send", SLOW, async () => {
    const shell = await bootDevice();
    live().click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    await quiet(shell);

    const flows = flowInvokes(shell);
    const all = shell.invokes.length;
    await vi.waitFor(() => expect(shell.invokes.length, "the watch read again").toBeGreaterThan(all), {
      timeout: POLL_MS * 5,
    });
    expect(flowInvokes(shell), "the watch's reads left the count where it was").toBe(flows);

    // The other half: an edit's write is counted, so a count that never moves cannot pass.
    turnOscOn();
    await vi.waitFor(() => expect(flowInvokes(shell)).toBeGreaterThan(flows), { timeout: 10_000 });
  });
});

// The teardown drain ends on a run of readings with no new invoke, and the last thing the app
// still invokes after a case is the trace line of the MIDI feedback pass, which runs
// FEEDBACK_DEBOUNCE_MS after the last edit and which the drain's flush writes at its next
// reading. A run shorter than that pause ends the drain with the line still to come, and the
// line then lands in the next case's device stub, which nothing reports.
describe("the drain a desktop case's teardown ends with", () => {
  it("outlasts the MIDI feedback pass by five readings or more", () => {
    expect(DRAIN_QUIET_READINGS * DRAIN_READING_MS - FEEDBACK_DEBOUNCE_MS).toBeGreaterThanOrEqual(5 * DRAIN_READING_MS);
  });
});
