// @vitest-environment jsdom

// The Live sync session: starting, following the unit, flushing, and ending.
//
// The setup, the teardown and the helpers every desktop case shares are `main.device.test-util.ts`'s,
// which also states what the device table does and does not model.

import { describe, expect, it, vi } from "vitest";
import { $, bootApp, deviceCommands, statusText, unwrittenRead } from "./main.test-util";
import type { TauriShell } from "./main.test-util";
import { levelToVd } from "./core/control/vd";
import { COMP_EQ_SSMCS, denormalizeInsertFx, INSERT_FX_NONE, PARAMS } from "./core/control/params";
import { nameControl } from "./core/control/translate";
import { getModel } from "./models";
import { EDIT_MENU_EVENT, EDIT_UNDO_ID } from "./core/platform";
import { t } from "./i18n";
import { spoken } from "./ui/glyph";
import {
  SLOW,
  bootDevice,
  invoked,
  live,
  row,
  selectNode,
  notifyChannel,
  confirms,
  chooseRate,
  errors,
  countFor,
  pressNode,
  paramRow,
  pickInsertFx,
  pickSignalType,
  COMPANDER_H,
  insertFxWrites,
  STREAMING_ON_NONE,
  STREAMING_STEREO,
  streamingWrites,
  streamingDrawn,
  quiet,
  turnOscOn,
} from "./main.device.test-util";

describe("the live session", () => {
  // The dev build's parameter watch (ui/param-watch.ts) rides the session: registered as a
  // subscription of its own once the session is up, read once a second while it lasts, and
  // silent from the moment it ends. The live-sync set it sits beside is the plan's and
  // nothing else's.
  // A device-lost push is consumed by whichever command is reading when it lands, and the
  // shell latches on it without a link event. When that command is the watch's read, the
  // session ends there, as it does for a link event; a new session runs the watch again.
  it("ends the session when a parameter-watch read finds the link dead, and watches the next one", SLOW, async () => {
    const lost = { on: false };
    const shell = await bootDevice({
      vd_get: (a: Record<string, unknown>) => {
        if (lost.on && a.paramId === 838) throw new Error("device-lost: sync_status offline");
        return unwrittenRead(a);
      },
    });
    live().click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    await invoked(shell, "vd_probe_subscribe");
    expect(errors(shell), "the premise: the session started cleanly").toEqual([]);

    lost.on = true;
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("false"), { timeout: 10_000 });
    await invoked(shell, "vd_disconnect");
    expect(errors(shell)).toEqual([t().status.liveError(t().error.shell.deviceLost)]);
    const reads = shell.count("vd_get");
    await new Promise((r) => setTimeout(r, 2_000));
    expect(shell.count("vd_get"), "the watch stopped with the session").toBe(reads);

    lost.on = false;
    live().click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    await invoked(shell, "vd_probe_subscribe", 2);
  });

  it("runs the parameter watch for exactly as long as the session, beside the live-sync set", SLOW, async () => {
    const { WATCHED, POLL_MS } = await import("./ui/param-watch");
    const shell = await bootDevice({}, true, { "838/0/0": 1 });
    live().click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    await invoked(shell, "vd_probe_subscribe");
    const probe = shell.args[shell.invokes.indexOf("vd_probe_subscribe")] as { addrs: number[][] };
    expect(probe.addrs.slice(0, WATCHED.length)).toEqual(WATCHED);
    const watched = new Set(WATCHED.map((a) => a.join(":")));
    const liveSets = shell.invokes
      .map((c, i) => (c === "vd_params_subscribe" ? (shell.args[i] as { addrs: number[][] }).addrs : null))
      .filter((a) => a !== null);
    expect(liveSets.length).toBeGreaterThan(0);
    expect(liveSets.flat().filter((a) => watched.has(a.join(":")))).toEqual([]);

    const reads838 = (): number =>
      shell.invokes.filter((c, i) => c === "vd_get" && (shell.args[i] as { paramId: number }).paramId === 838).length;
    await vi.waitFor(() => expect(reads838()).toBeGreaterThanOrEqual(2), { timeout: POLL_MS * 5 });
    // The wall-clock file carries the session's first reading.
    (window as unknown as { __urxParamWatch?: { flush(): void } }).__urxParamWatch?.flush();
    await invoked(shell, "append_watch_log");
    const lines = shell.invokes.flatMap((c, i) =>
      c === "append_watch_log" ? (shell.args[i] as { lines: string[] }).lines : [],
    );
    expect(lines.map((l) => JSON.parse(l) as { k: string; values?: Record<string, unknown> })).toContainEqual(
      expect.objectContaining({ k: "start", values: expect.objectContaining({ "838:0:0": 1 }) }),
    );

    live().click();
    await invoked(shell, "vd_disconnect");
    const after = reads838();
    await new Promise((r) => setTimeout(r, POLL_MS * 2));
    expect(reads838()).toBe(after);
  });

  // A re-registration that fails while the session is still STARTING.
  //
  // `live.begin()` runs before `follow.begin()`, so a structural edit can flush inside the
  // window where the first registration is still on the wire; that flush captures and asks
  // the follow layer to re-register, and the ask can be refused. `stopLiveOnError` returns
  // without doing anything while `liveSessionUp` is false, so the report is dropped — and
  // the lines that follow would go on to say "Live sync on" over a DeviceFollow that has
  // already stopped, with `onNotify` discarding every notify for the rest of the session.
  it("refuses to start a session whose follow stopped on the way up", SLOW, async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let calls = 0;
    const shell = await bootDevice({
      vd_params_subscribe: async () => {
        calls++;
        // The session's own registration is held open, not failed: what is under test is a
        // LATER refusal landing inside the start-up window.
        if (calls === 1) {
          await held;
          return null;
        }
        throw new Error("subscribe rejected");
      },
      // The last await before the session is declared up, stretched so the window this
      // case is about is wide enough to land in: the flush's ask runs as soon as the
      // registration it queued behind lands, and its refusal has to arrive while
      // `liveSessionUp` is still false for `stopLiveOnError` to be the one that drops it.
      vd_watch_link: async () => new Promise((r) => setTimeout(r, 2_000)),
    });

    $("btn-live").click();
    // Parked inside `follow.begin()`, which is after `live.begin()` — so the flush below
    // belongs to a live session that has not been declared up yet.
    await vi.waitFor(() => expect(calls).toBe(1), { timeout: 25_000 });

    // A converge param: its flush captures, and a flush that captured asks.
    selectNode("ch1");
    const type = row(t().inspector.compEqType).querySelector<HTMLSelectElement>("select")!;
    type.value = String(COMP_EQ_SSMCS);
    type.dispatchEvent(new Event("change", { bubbles: true }));
    // The ask is made at the END of the flush, and this flush carries a converge — some
    // 700 reads through the stub. Released before it gets there, the refusal lands after
    // the session is already up, which is a window the existing machinery already covers.
    // So: wait for the converge to stop reading, THEN release.
    await vi.waitFor(() => expect(shell.count("vd_set")).toBeGreaterThan(0), { timeout: 25_000 });
    let quiet = 0;
    let last = -1;
    await vi.waitFor(
      () => {
        const now = shell.count("vd_get");
        quiet = now === last ? quiet + 1 : 0;
        last = now;
        if (quiet < 5) throw new Error(`still reading (${now})`);
      },
      { timeout: 25_000, interval: 40 },
    );
    release();
    await vi.waitFor(() => expect(calls).toBeGreaterThan(1), { timeout: 25_000 });

    // The session is not up, and it said WHY — the follow's own refusal rather than any
    // failure the read path can raise, which is what separates this from a failed readback.
    await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 25_000 });
    expect(errors(shell).some((e) => e.includes(t().error.liveFollowStopped))).toBe(true);
    expect(live().getAttribute("aria-checked")).not.toBe("true");
  });

  // A confirm that REJECTS rather than answering, on the way into a session that has already
  // connected. Its exit has to close the connection it opened, as every other exit does.
  it("closes the connection when a start's confirm rejects", SLOW, async () => {
    const shell = await bootDevice({
      "plugin:dialog|message": (a: Record<string, unknown>) => {
        if (a.buttons === "OkCancel") throw new Error("dialog unavailable");
        return "Ok";
      },
    });
    // A dirty plan, so the start asks the discard confirm.
    chooseRate(96_000);
    $("btn-live").click();
    await invoked(shell, "vd_disconnect");
    // Released by the epoch it was opened with: the stub closes only a matching one, so a
    // device command after it is refused.
    const invoke = (
      window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> } }
    ).__TAURI_INTERNALS__.invoke;
    await expect(invoke("vd_get", { paramId: 1, x: 0, y: 0 })).rejects.toThrow("not-connected");
    expect(confirms(shell)).toEqual([t().confirm.discard]);
    expect(live().getAttribute("aria-checked")).not.toBe("true");
    await vi.waitFor(() => expect($<HTMLSelectElement>("rate-picker").disabled).toBe(false), { timeout: 10_000 });
  });

  // A ledger line the shell cannot write is said on the status line, in the app's language:
  // the shell's code goes through the same translation every other framed cause does.
  it("names a ledger write failure in words rather than by its code", SLOW, async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const table = deviceCommands({
      "plugin:dialog|message": "Ok",
      append_link_log: () => {
        throw new Error("file-denied");
      },
    });
    const get = table.vd_get as (a: Record<string, unknown>) => number;
    let first = true;
    const shell = (await bootApp({
      tauri: {
        ...table,
        // The start's first read is held, so the line the ledger's failure wrote is still the
        // one on screen when it is read.
        vd_get: async (a: Record<string, unknown>) => {
          if (first) {
            first = false;
            await held;
          }
          return get(a);
        },
      },
    }))!;
    $("btn-live").click();
    await invoked(shell, "append_link_log");
    await vi.waitFor(() => expect(statusText()).toBe(t().status.linkLogFailed(t().error.shell.fileDenied)));
    expect(statusText()).not.toContain("file-denied");
    release();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 20_000 });
  });

  // Turning Live sync off while a flush has a write on the wire: the disconnect waits for the
  // flush to finish, so its last command is answered over the session's own connection.
  it("disconnects only once the flush in flight has finished", SLOW, async () => {
    let release!: () => void;
    let holding = false;
    const table = deviceCommands({ "plugin:dialog|message": "Ok" });
    const set = table.vd_set as (a: Record<string, unknown>) => unknown;
    const shell = (await bootApp({
      tauri: {
        ...table,
        vd_set: async (a: Record<string, unknown>) => {
          if (holding) {
            holding = false;
            await new Promise<void>((r) => (release = r));
          }
          return set(a);
        },
      },
    }))!;
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    const sets = shell.count("vd_set");
    holding = true;
    selectNode("bus.stereo");
    const fader = row(t().inspector.level).querySelector<HTMLInputElement>("input[type=range]")!;
    fader.value = String(Number(fader.value) - 3);
    fader.dispatchEvent(new Event("input", { bubbles: true }));
    await invoked(shell, "vd_set", sets + 1);

    const disconnects = shell.count("vd_disconnect");
    live().click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("false"), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 100));
    expect(shell.count("vd_disconnect"), "the write is still unanswered").toBe(disconnects);
    release();
    await invoked(shell, "vd_disconnect", disconnects + 1);
  });

  // The LIVE half of the same window. A flush the operator's edit started inside it fails, and
  // its report reaches `stopLiveOnError` while the session is not up yet: recorded there and
  // thrown by the start, rather than dropped with the session declared up over a sync that
  // has stopped.
  it("refuses to start a session whose first flush failed on the way up", SLOW, async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let calls = 0;
    let refuse = false;
    const table = deviceCommands({
      "plugin:dialog|message": "Ok",
      vd_params_subscribe: async () => {
        if (++calls === 1) await held;
        return null;
      },
    });
    const set = table.vd_set as (a: Record<string, unknown>) => unknown;
    const shell = (await bootApp({
      tauri: {
        ...table,
        vd_set: (a: Record<string, unknown>) => {
          if (refuse) throw new Error("write refused");
          return set(a);
        },
      },
    }))!;
    $("btn-live").click();
    await vi.waitFor(() => expect(calls).toBe(1), { timeout: 25_000 });

    refuse = true;
    const sets = shell.count("vd_set");
    selectNode("bus.stereo");
    const fader = row(t().inspector.level).querySelector<HTMLInputElement>("input[type=range]")!;
    fader.value = String(Number(fader.value) - 3);
    fader.dispatchEvent(new Event("input", { bubbles: true }));
    await invoked(shell, "vd_set", sets + 1);
    release();

    await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 25_000 });
    expect(errors(shell)).toContain(t().status.liveError("write refused"));
    expect(live().getAttribute("aria-checked")).not.toBe("true");
  });

  // A head write's park read that fails in the same window: the head it was in front of must
  // not go out, and the start reports the read's failure.
  it("sends no effect type behind a park read that failed on the way up", SLOW, async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let calls = 0;
    let refuse = false;
    const table = deviceCommands({
      "plugin:dialog|message": "Ok",
      vd_params_subscribe: async () => {
        if (++calls === 1) await held;
        return null;
      },
    });
    const get = table.vd_get as (a: Record<string, unknown>) => unknown;
    const shell = (await bootApp({
      tauri: {
        ...table,
        vd_get: (a: Record<string, unknown>) => {
          if (refuse) throw new Error("read refused");
          return get(a);
        },
      },
    }))!;
    $("btn-live").click();
    await vi.waitFor(() => expect(calls).toBe(1), { timeout: 25_000 });

    refuse = true;
    const at = shell.invokes.length;
    const reads = shell.count("vd_get");
    pressNode("bus.fx1");
    const sel = paramRow(t().inspector.fxEffect.effectType).querySelector("select")!;
    sel.value = String([...sel.options].map((o) => o.value).find((v) => v !== sel.value));
    sel.dispatchEvent(new Event("input", { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    // The park asked the unit, and was refused.
    await invoked(shell, "vd_get", reads + 1);
    await new Promise((r) => setTimeout(r, 300));
    release();

    await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 25_000 });
    expect(live().getAttribute("aria-checked")).not.toBe("true");
    const typeWrites = shell.invokes
      .slice(at)
      .filter((cmd, i) => cmd === "vd_set" && shell.args[at + i]?.paramId === PARAMS.FX_EFFECT_TYPE.id);
    expect(typeWrites).toEqual([]);
  });

  // The undo history survives a reconcile that authored nothing.
  //
  // Pinned HERE rather than only in the race tier because that tier uploads no
  // coverage and runs on the version-bump pull request alone — so the branch this
  // asserts was reachable by nothing that reports on an ordinary PR. The tier still
  // owns the timing shapes (a press DURING the read, a teardown mid-flight); this owns
  // the plain case, which is also the common one.
  it("keeps the undo history through a reconcile that authored nothing", SLOW, async () => {
    const shell = await bootDevice();
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });

    $("btn-view-console").click();
    const slider = (): HTMLElement => $("console-host").querySelector<HTMLElement>('.con-strip [role="slider"]')!;
    const before = slider().getAttribute("aria-valuenow");
    slider().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(slider().getAttribute("aria-valuenow")).not.toBe(before);
    await invoked(shell, "vd_set", 1); // the edit reached the unit

    // A scoped param's notify makes the settle re-read the owner node. The channel is
    // taken from the subscribe's own arguments rather than by position, so a second
    // channel opening beside it cannot silently redirect this.
    const at = shell.invokes.indexOf("vd_params_subscribe");
    const { channel } = shell.args[at] as { channel: { onmessage: (d: unknown) => void } };
    const readsBefore = shell.count("vd_get");
    channel.onmessage([{ param_id: 26, x: 0, y: 0, value: 40 }]); // CH1 HPF freq
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(readsBefore), { timeout: 20_000 });

    // Let the read and its coalesced reflect finish, or the chord below meets the
    // busy refusal and the case would be measuring the gate instead.
    let seen = -1;
    await vi.waitFor(
      () => {
        const now = shell.invokes.length;
        const quiet = now === seen;
        seen = now;
        if (!quiet) throw new Error("still working");
      },
      { timeout: 20_000, interval: 300 },
    );

    // The stub answers the re-read from what it holds, which the session start already
    // synced the plan to — so the read authored nothing and the entry must still be
    // there. Before the fix, the reflect reset both stacks and this chord did nothing.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(slider().getAttribute("aria-valuenow")).toBe(before), { timeout: 10_000 });
  });

  // A reconcile that read back a sample rate the unit moved, and nothing else, takes the rate
  // into the baseline and leaves every entry standing; one that read back another key as well
  // drops both stacks, as any reconcile that authored a key does. The unit moves on its own
  // panel: its table is written directly and the rate announced.
  it.each([
    ["keeps", "the sample rate alone", false],
    ["drops", "the sample rate and CH 1's fader", true],
  ])("%s the undo history through a reconcile that read back %s", SLOW, async (_, __, fader) => {
    const RATE = PARAMS.SAMPLE_RATE.id;
    const table = deviceCommands(
      { "plugin:dialog|message": "Ok" },
      { [`${RATE}/0/0`]: 48_000, [`${PARAMS.FOLLOW_USB.id}/0/0`]: 0 },
    );
    const shell = (await bootApp({ tauri: table }))!;
    const oscWrites = (from: number): number[] =>
      shell.invokes.flatMap((cmd, i) =>
        i >= from && cmd === "vd_set" && shell.args[i]?.paramId === PARAMS.OSC_ON.id
          ? [shell.args[i]!.value as number]
          : [],
      );
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    turnOscOn();
    selectNode("ch1"); // the press that ends the edit's entry
    await new Promise((r) => setTimeout(r, 0));
    await vi.waitFor(() => expect(oscWrites(0)).toEqual([1]), { timeout: 15_000 });
    await quiet(shell);

    const panel = table.vd_set as (a: Record<string, unknown>) => unknown;
    panel({ paramId: RATE, x: 0, y: 0, value: 96_000 });
    if (fader) panel({ paramId: PARAMS.CH_FADER.id, x: 0, y: 0, value: levelToVd(-10) });
    notifyChannel(shell).onmessage([{ param_id: RATE, x: 0, y: 0, value: 96_000 }]);
    await vi.waitFor(() => expect($<HTMLSelectElement>("rate-picker").value).toBe("96000"), { timeout: 20_000 });

    // A press refused while a follow read runs is left where it was, so the next one is the same press.
    let at = 0;
    await vi.waitFor(
      () => {
        at = shell.invokes.length;
        expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
        expect(statusText()).not.toBe(t().status.undoDeviceBusy);
      },
      { timeout: 15_000, interval: 50 },
    );
    if (fader) expect(statusText()).toBe(t().status.nothingToUndo);
    else
      await vi.waitFor(() => expect(oscWrites(at), "the edit made before the read").toEqual([0]), { timeout: 15_000 });
  });

  // A follow read is all or nothing, as the session's starting read is: one that comes back
  // incomplete merges none of what it got, so a value it did read never reaches the plan.
  it("merges nothing from a reconcile whose read comes back incomplete", SLOW, async () => {
    const shell = await bootDevice();
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    await quiet(shell);

    $("btn-view-console").click();
    // CH 1's fader readout.
    const level = (): string | null =>
      $("console-host").querySelector(".con-strip")!.querySelector(".con-readout .rv")!.textContent;
    const before = level();

    // The unit answers CH 1's fader at a value the plan does not hold and refuses a read of
    // CH 2, so a reconcile of the two reads CH 1 whole and still comes back incomplete.
    let faderAnswered = false;
    let refused = false;
    shell.answer("vd_get", (a: Record<string, unknown>) => {
      if (a.paramId === 142 && a.y === 1) {
        refused = true;
        throw new Error("read refused");
      }
      if (a.paramId === PARAMS.CH_FADER.id && a.y === 0) {
        faderAnswered = true;
        return levelToVd(-10);
      }
      return unwrittenRead(a);
    });
    const at = shell.invokes.indexOf("vd_params_subscribe");
    const { channel } = shell.args[at] as { channel: { onmessage: (d: unknown) => void } };
    channel.onmessage([
      { param_id: 26, x: 0, y: 0, value: 40 }, // CH1 HPF freq
      { param_id: 26, x: 0, y: 1, value: 40 }, // CH2 HPF freq
    ]);

    await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 25_000 });
    expect(faderAnswered, "the control: the read got CH 1's fader").toBe(true);
    expect(refused, "the premise: the read reached the refused address").toBe(true);
    // Drawn again from the plan: the session's teardown cancels the reflect a merge asks
    // for, so the strip on screen would show the old value whatever the plan now holds.
    $("btn-view-graph").click();
    $("btn-view-console").click();
    expect(level()).toBe(before);
  });

  // What a read that HELD values tells the operator, and what it does about them. The
  // race tier owns the re-send's addresses and their order; it uploads no coverage and
  // its trigger skips a documentation-only pull request, so both branches below were
  // reachable by nothing that reports on an ordinary one — and the status line is the
  // only place an installed build says any of this, the console not reaching it.
  //
  // Driven by putting the unit where the sample-rate excursion leaves it: a rate the
  // selected effect's ceiling forbids, and no effect selected, announced on the rate
  // address alone.
  const heldByExcursion = async (shell: TauriShell, link = false): Promise<void> => {
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    // Selected through the session, so the unit holds it too: the hold is about a value
    // the app and the device agreed on until the rate moved. `link` puts the pair in
    // STEREO first, so the mirror carries the effect and BOTH members hold one — and it
    // has to happen after the session is up, since the session's own read would
    // otherwise take the link straight back off the unit.
    selectNode("ch1");
    if (link) pickSignalType(1);
    pickInsertFx(COMPANDER_H);
    await vi.waitFor(() => expect(insertFxWrites(shell)).toContain(COMPANDER_H), { timeout: 25_000 });
    // Settled before the excursion, so what the shell is asked afterwards belongs to the
    // reconcile alone: the session's own flush is still writing when that first selector
    // write lands, and a later write of the same address would otherwise read as the
    // send-back whether or not one was scheduled.
    await quiet(shell);
  };

  /** End the session before the case does. A follow read outlives one that merely ended,
   *  so a case that walks away from a live session leaves its teardown to fire after the
   *  shell is gone — which surfaces as an unhandled "not running under Tauri" rejection
   *  attributed to whichever file is running then. */
  const endLive = async (): Promise<void> => {
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("false"), { timeout: 25_000 });
  };

  /** Holds the first read of one address made after `arm()` until `release()`. */
  const gate = (paramId: number, y: number) => {
    let armed = false;
    let held = false;
    let release!: () => void;
    const open = new Promise<void>((r) => (release = r));
    return {
      arm: () => void (armed = true),
      held: () => held,
      release: () => release(),
      take: (a: Record<string, unknown>): Promise<void> | null => {
        if (!armed || a.paramId !== paramId || a.y !== y) return null;
        armed = false;
        held = true;
        return open;
      },
    };
  };

  /** Every line the status bar shows from now on, so a line a later one replaces before a
   *  poll reads it is still seen. */
  const recordStatus = (): { lines: string[]; stop: () => void } => {
    const lines: string[] = [];
    const watch = new MutationObserver(() => lines.push(statusText()));
    watch.observe($("statusbar"), { childList: true, characterData: true, subtree: true });
    return { lines, stop: () => watch.disconnect() };
  };
  const followedLine = (l: string): boolean => !Number.isNaN(countFor(l, (n) => t().status.liveFollowed(n)));
  const heldLine = (l: string): boolean => !Number.isNaN(countFor(l, (n) => t().status.liveHeld(n, 2, 0)));

  // `delayMs` stretches each read, for the case that has to end the session inside one.
  // `hold` answers a read only once the promise it returns for that read settles.
  // `refuseY` refuses every read of one channel index, for the case that needs the read
  // to be partial as well as holding — CH 1 is y0, so a later index leaves the held
  // route's own addresses answering.
  // `linked` answers Signal Type STEREO throughout, which is what a read that was
  // answered on that address BEFORE a transition landed looks like — the stale half of
  // the race the announcement exists to settle.
  const notifyRate = (
    shell: TauriShell,
    {
      delayMs = 0,
      hold = (): Promise<void> | null => null,
      refuseY = -1,
      linked = false,
    }: {
      delayMs?: number;
      hold?: (a: Record<string, unknown>) => Promise<void> | null;
      refuseY?: number;
      linked?: boolean;
    } = {},
  ): void => {
    const answer = (a: Record<string, unknown>): number => {
      if (a.y === refuseY) throw new Error("read refused");
      if (linked && a.paramId === PARAMS.SIGNAL_TYPE.id) return 1;
      return a.paramId === PARAMS.SAMPLE_RATE.id
        ? 192_000
        : a.paramId === PARAMS.INSERT_FX.id
          ? denormalizeInsertFx(INSERT_FX_NONE)
          : unwrittenRead(a);
    };
    shell.answer("vd_get", (a: Record<string, unknown>) => {
      const held = hold(a);
      if (held) return held.then(() => answer(a));
      return delayMs ? new Promise((r) => setTimeout(() => r(answer(a)), delayMs)) : answer(a);
    });
    // Taken from the subscribe's own arguments rather than by position, so a second
    // channel opening beside it cannot silently redirect this.
    const at = shell.invokes.indexOf("vd_params_subscribe");
    const { channel } = shell.args[at] as { channel: { onmessage: (d: unknown) => void } };
    channel.onmessage([{ param_id: PARAMS.SAMPLE_RATE.id, x: 0, y: 0, value: 192_000 }]);
  };

  // STREAMING's list on the unit has no None. A session started on a unit left on NONE there
  // gives the plan STEREO and says so ahead of its own line, and sends nothing at the start: the
  // unit stays on NONE until an edit starts a flush, and that flush carries STREAMING too, since
  // the read's view held the unit's NONE and the snapshot has nothing there to match.
  it("gives the plan STEREO where the unit's STREAMING was on NONE, and sends it with an edit", SLOW, async () => {
    const shell = await bootDevice({}, true, STREAMING_ON_NONE);
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    expect(statusText().startsWith(`${t().status.streamingSourceUnlisted} — `)).toBe(true);
    expect(streamingDrawn()).toEqual(["bus.stereo:out"]);
    await quiet(shell);
    expect(streamingWrites(shell)).toEqual([]);

    selectNode("ch1");
    pickInsertFx(COMPANDER_H);
    await vi.waitFor(() => expect(insertFxWrites(shell)).toContain(COMPANDER_H), { timeout: 25_000 });
    await vi.waitFor(
      () =>
        expect(streamingWrites(shell).sort()).toEqual([
          `${PARAMS.STREAM_SRC_L.id}=${STREAMING_STEREO[0]}`,
          `${PARAMS.STREAM_SRC_R.id}=${STREAMING_STEREO[1]}`,
        ]),
      { timeout: 25_000 },
    );
    await endLive();
  });

  // A source STREAMING's list does not offer — a channel's slot — is not taken from the unit:
  // the read is incomplete, and the session does not start on it.
  it("does not start on a unit whose STREAMING source is not in its list", SLOW, async () => {
    const shell = await bootDevice({}, true, { "705/0/0": 0, "706/0/0": 0 });
    $("btn-live").click();
    await vi.waitFor(() => expect(errors(shell)).toHaveLength(1), { timeout: 25_000 });
    expect(errors(shell)[0]).toBe(t().status.liveError(t().error.liveReadIncomplete(1)));
    expect(live().getAttribute("aria-checked")).toBe("false");
    expect(streamingWrites(shell)).toEqual([]);
  });

  // A start that fails on an incomplete read merges nothing, so the unit's NONE never reaches
  // the plan: STREAMING is left on the source the plan already had, and nothing is sent.
  it("leaves STREAMING on the plan's own source when a start against a unit on NONE fails", SLOW, async () => {
    const shell = await bootDevice({
      vd_get: (a: Record<string, unknown>) => {
        if (a.paramId === PARAMS.STREAM_DELAY_TIME.id) throw new Error("read refused");
        return (STREAMING_ON_NONE as Record<string, number>)[`${a.paramId}/${a.x}/${a.y}`] ?? unwrittenRead(a);
      },
    });
    $("btn-live").click();
    await vi.waitFor(() => expect(errors(shell)).toHaveLength(1), { timeout: 25_000 });
    expect(errors(shell)[0]).toBe(t().status.liveError(t().error.liveReadIncomplete(1)));
    expect(live().getAttribute("aria-checked")).toBe("false");
    expect(streamingDrawn()).toEqual(["bus.stereo:out"]);
    expect(statusText()).not.toBe(t().status.streamingSourceUnlisted);
    expect(streamingWrites(shell)).toEqual([]);
  });

  it("says how many values a reconcile kept, and sends them back", SLOW, async () => {
    const shell = await bootDevice();
    await heldByExcursion(shell);

    const written = insertFxWrites(shell).length;
    notifyRate(shell);

    // Two keys held on CH 1 — the selector and its bypass. The third the hold names,
    // the stored engine values, is not in the plan for an effect selected and not yet
    // tuned, and a key the read's patch never carried is not one it can keep.
    await vi.waitFor(() => expect(countFor(statusText(), (n) => t().status.liveHeld(n, 2, 0))).not.toBeNaN(), {
      timeout: 25_000,
    });
    // …and the send-back really was scheduled, rather than only reported.
    await vi.waitFor(() => expect(insertFxWrites(shell).length).toBeGreaterThan(written), { timeout: 25_000 });
    expect(insertFxWrites(shell).at(-1)).toBe(COMPANDER_H);
    await endLive();
  });

  it("claims no send-back when the session ended under the read", SLOW, async () => {
    const shell = await bootDevice();
    await heldByExcursion(shell);

    // One millisecond per read, so the reconcile is long enough to end the session
    // inside it. A follow read outlives a session that merely ended, so it still
    // reaches the hold — with nothing left to flush through.
    const reads = shell.count("vd_get");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    notifyRate(shell, { delayMs: 1 });

    try {
      const written = insertFxWrites(shell).length;
      // Past the settle debounce and INTO the reconcile: the session start has already
      // read the whole unit, so a bare `count > 5` is satisfied before the notify's
      // read exists and the click below would cancel the settle instead of racing it.
      await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(reads + 5), {
        timeout: 25_000,
        interval: 5,
      });
      $("btn-live").click();
      await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("false"), { timeout: 25_000 });

      await vi.waitFor(
        () =>
          expect(
            warn.mock.calls.some((c) => String(c[0]).includes("no session left to send the held values back through")),
          ).toBe(true),
        { timeout: 25_000 },
      );
      // The positive control is the case above, which takes this same path with the
      // session up and DOES write: an absence here is the session and not the setup.
      expect(insertFxWrites(shell).length).toBe(written);
      expect(countFor(statusText(), (n) => t().status.liveHeld(n, 2, 0))).toBeNaN();
      // And the branch above is reachable at all because the LINK outlived the read: the
      // release waits for a follow read still doing round trips (releaseLive). Without the
      // wait the read dies at its next one, on a link taken out from under it — the same
      // half-filled document abandoning it would have left, reported nowhere, since the
      // session is already down and stopLiveOnError returns on that.
      expect(shell.invokes.lastIndexOf("vd_disconnect")).toBeGreaterThan(shell.invokes.lastIndexOf("vd_get"));
    } finally {
      warn.mockRestore();
    }
  });

  // A rate the unit announced in a session that ended before any read took it is that
  // session's evidence. The next session's own starting read establishes the rate, so a
  // clearing the operator then makes on the unit's panel is adopted, not held against the
  // rate the ended session heard.
  it("forgets a rate an ended session was told about once the next session has read the unit", SLOW, async () => {
    const shell = await bootDevice({}, true, { [`${PARAMS.SAMPLE_RATE.id}/0/0`]: 48_000 });
    await heldByExcursion(shell);
    const channelOf = (i: number) => (shell.args[i] as { channel: { onmessage: (d: unknown) => void } }).channel;
    // Announced, and the session ended inside the settle that would have read it.
    channelOf(shell.invokes.lastIndexOf("vd_params_subscribe")).onmessage([
      { param_id: PARAMS.SAMPLE_RATE.id, x: 0, y: 0, value: 192_000 },
    ]);
    await endLive();
    await vi.waitFor(() => expect($<HTMLSelectElement>("rate-picker").disabled).toBe(false), { timeout: 25_000 });

    // The next session reads the unit at 48 kHz with CH 1 still on the effect.
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    await quiet(shell);

    // The operator clears CH 1's effect at the unit's panel — the address the selection wrote.
    const selector = shell.invokes.reduce(
      (last, cmd, i) =>
        cmd === "vd_set" && shell.args[i]?.paramId === PARAMS.INSERT_FX.id && shell.args[i]?.value === COMPANDER_H
          ? i
          : last,
      -1,
    );
    const { x, y } = shell.args[selector] as { x: number; y: number };
    const none = denormalizeInsertFx(INSERT_FX_NONE);
    const invoke = (
      window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> } }
    ).__TAURI_INTERNALS__.invoke;
    await invoke("vd_set", { paramId: PARAMS.INSERT_FX.id, x, y, value: none });
    const written = insertFxWrites(shell).filter((v) => v === COMPANDER_H).length;
    channelOf(shell.invokes.lastIndexOf("vd_params_subscribe")).onmessage([
      { param_id: PARAMS.INSERT_FX.id, x, y, value: none },
    ]);

    await vi.waitFor(() => expect(countFor(statusText(), (n) => t().status.liveFollowed(n))).not.toBeNaN(), {
      timeout: 25_000,
    });
    expect(countFor(statusText(), (n) => t().status.liveHeld(n, 2, 0))).toBeNaN();
    await quiet(shell);
    expect(insertFxWrites(shell).filter((v) => v === COMPANDER_H).length).toBe(written);
    await endLive();
  });

  // The OTHER half of the same rule, and the one that made the split worth stating: a
  // session that merely ends lets its read finish, but a plan REPLACED under it does not —
  // the document is gone, so the read is filling something nothing shows. Nothing else in
  // the main.device files drives `abandonFollowWork` with a read actually in flight, and the abort is
  // invisible from the merge (readIntoPlan drops the result either way, whether the round
  // trips stopped or ran to the end).
  it("abandons a follow read when the plan it was filling is replaced", SLOW, async () => {
    const shell = await bootDevice();
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    // The session's own starting read, which is what a WHOLE-device sweep costs. The
    // control for the count below, taken from this run rather than written down.
    const sweep = shell.count("vd_get");

    // A rate notify escalates to a whole-device reconcile; a millisecond per read is what
    // makes the window to replace the plan inside it real.
    notifyRate(shell, { delayMs: 1 });
    const before = shell.count("vd_get");
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(before + 20), {
      timeout: 25_000,
      interval: 5,
    });

    $("btn-new").click();
    await quiet(shell);
    // Not zero: the readback checks the signal at group boundaries, so reads already on
    // the wire still land. Against the sweep, though, an abandoned read is a fraction of
    // one left running — which is what the count says and an exact figure could not.
    expect(shell.count("vd_get") - before).toBeLessThan(sweep / 2);
    expect(statusText()).toBe(t().status.newPlan);
  });

  // The link outliving the session is only safe while nothing else can take it. A read
  // still doing round trips has no epoch of its own — `vd::sender` hands it whatever worker
  // is installed when it asks — so an action connecting here would replace the worker under
  // it, and its epilogue would re-base and flush through the session that replaced it.
  it("lets nothing else connect while the ended session's read is still running", SLOW, async () => {
    const shell = await bootDevice();
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });

    notifyRate(shell, { delayMs: 1 });
    const before = shell.count("vd_get");
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(before + 20), {
      timeout: 25_000,
      interval: 5,
    });

    const connects = shell.count("vd_connect");
    const disconnects = shell.count("vd_disconnect");
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("false"), { timeout: 25_000 });

    // The toggle is off and the link is NOT: the read is still running over it.
    expect(shell.count("vd_disconnect")).toBe(disconnects);
    expect($<HTMLButtonElement>("btn-fetch").disabled).toBe(true);
    expect($<HTMLSelectElement>("rate-picker").disabled).toBe(true);
    // The toggle stays usable — it is the holder's own entry — so the restart is refused
    // by the latch rather than by the affordance. Read synchronously: `holdDeviceLink`
    // writes the line before the click handler's first await, and the read still running
    // writes its own over it.
    $("btn-live").click();
    expect(statusText()).toBe(t().status.deviceLinkBusy);
    expect(shell.count("vd_connect")).toBe(connects);

    // …and the disconnect is what lifts it, not the toggle going off.
    await invoked(shell, "vd_disconnect", disconnects + 1);
    await vi.waitFor(() => expect($<HTMLButtonElement>("btn-fetch").disabled).toBe(false), { timeout: 25_000 });
  });

  // …and the release has to give the link back even when it fails. The holder is what
  // every connect path takes, so a release that skipped it on the error path would leave
  // the device actions greyed with nothing but a relaunch to undo it.
  it("gives the link back and says so when the disconnect itself fails", SLOW, async () => {
    const shell = await bootDevice();
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });

    shell.failOnce("vd_disconnect", new Error("control-worker-gone"));
    $("btn-live").click();

    await vi.waitFor(() => expect($<HTMLButtonElement>("btn-fetch").disabled).toBe(false), { timeout: 25_000 });
    // Told, not only recovered: the app cannot say whether the unit is still attached to a
    // worker, and the console does not reach an installed build.
    expect(errors(shell)).toContain(t().status.liveError(t().error.shell.controlWorkerGone));
  });

  // The other cause of the same cleared values, told apart by the notify stream rather
  // than by the read's own values — which come from different moments and cannot answer
  // it. Here the unit announces the selector itself while the read runs, so the clearing
  // is the announcement's to explain and the plan adopts it.
  it("adopts a clearing the unit announced while the read was running", SLOW, async () => {
    const shell = await bootDevice();
    await heldByExcursion(shell);

    const written = insertFxWrites(shell).length;
    // INSIDE the read the rate notify escalated to, on CH 1's own selector: the read is held
    // at that selector while the unit announces it.
    const selector = gate(PARAMS.INSERT_FX.id, 0);
    selector.arm();
    notifyRate(shell, { hold: selector.take });
    const at = shell.invokes.indexOf("vd_params_subscribe");
    const { channel } = shell.args[at] as { channel: { onmessage: (d: unknown) => void } };
    await vi.waitFor(() => expect(selector.held(), "the read reached CH 1's selector").toBe(true), {
      timeout: 25_000,
    });
    const status = recordStatus();
    channel.onmessage([{ param_id: PARAMS.INSERT_FX.id, x: 0, y: 0, value: denormalizeInsertFx(INSERT_FX_NONE) }]);
    selector.release();

    // The ordinary followed line, not the held one — and nothing sent back.
    await vi.waitFor(() => expect(status.lines.some((l) => followedLine(l) || heldLine(l))).toBe(true), {
      timeout: 25_000,
    });
    status.stop();
    expect(status.lines.filter(heldLine)).toEqual([]);
    expect(insertFxWrites(shell).length).toBe(written);
    await endLive();
  });

  // The excursion can be over before the read asks for the rate: 48 → 96 → 48 leaves the
  // read holding a rate the effect runs at, and the cleared values then read exactly like
  // an operator's own No Effect. What says otherwise is the rate notify that escalated to
  // the read — which arrives BEFORE it starts, so the rate history is not sliced to the
  // read's own window the way the insert-FX announcements are.
  it("keeps an effect through a rate excursion that was over before the read asked", SLOW, async () => {
    const shell = await bootDevice();
    await heldByExcursion(shell);

    const written = insertFxWrites(shell).length;
    const at = shell.invokes.indexOf("vd_params_subscribe");
    const { channel } = shell.args[at] as { channel: { onmessage: (d: unknown) => void } };
    // The unit went up past the effect's ceiling and came straight back, so every address
    // the read asks for — the rate included — answers as if nothing had happened.
    shell.answer("vd_get", (a: Record<string, unknown>) =>
      a.paramId === PARAMS.SAMPLE_RATE.id
        ? 48_000
        : a.paramId === PARAMS.INSERT_FX.id
          ? denormalizeInsertFx(INSERT_FX_NONE)
          : unwrittenRead(a),
    );
    channel.onmessage([
      { param_id: PARAMS.SAMPLE_RATE.id, x: 0, y: 0, value: 192_000 },
      { param_id: PARAMS.SAMPLE_RATE.id, x: 0, y: 0, value: 48_000 },
    ]);

    await vi.waitFor(() => expect(countFor(statusText(), (n) => t().status.liveHeld(n, 2, 0))).not.toBeNaN(), {
      timeout: 25_000,
    });
    await vi.waitFor(() => expect(insertFxWrites(shell).length).toBeGreaterThan(written), { timeout: 25_000 });
    expect(insertFxWrites(shell).at(-1)).toBe(COMPANDER_H);
    await endLive();
  });

  // Reconciles run one at a time, so a scoped read for ANOTHER node can sit between the
  // rate notify and the full read it escalates to. Clearing the rate history on whichever
  // read finished first took the announcement out from under the read it was for, and the
  // full read then saw only the rate the unit had already come back to.
  it("keeps the rate history across a scoped read that established none", SLOW, async () => {
    const shell = await bootDevice();
    await heldByExcursion(shell);

    const written = insertFxWrites(shell).length;
    // Slow enough that the rate notify below lands INSIDE the scoped read.
    shell.answer("vd_get", (a: Record<string, unknown>) => {
      const v =
        a.paramId === PARAMS.SAMPLE_RATE.id
          ? 48_000
          : a.paramId === PARAMS.INSERT_FX.id
            ? denormalizeInsertFx(INSERT_FX_NONE)
            : unwrittenRead(a);
      return new Promise((r) => setTimeout(() => r(v), 5));
    });
    const at = shell.invokes.indexOf("vd_params_subscribe");
    const { channel } = shell.args[at] as { channel: { onmessage: (d: unknown) => void } };

    // A CH 3 parameter the unit moved: no owner-less address, so this settles into a
    // SCOPED read, which never asks for the rate.
    const reads = shell.count("vd_get");
    channel.onmessage([{ param_id: PARAMS.HPF_ON.id, x: 0, y: 2, value: 1 }]);
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(reads + 3), {
      timeout: 25_000,
      interval: 2,
    });
    // …and the excursion, announced while that read is still running.
    channel.onmessage([
      { param_id: PARAMS.SAMPLE_RATE.id, x: 0, y: 0, value: 192_000 },
      { param_id: PARAMS.SAMPLE_RATE.id, x: 0, y: 0, value: 48_000 },
    ]);

    await vi.waitFor(() => expect(countFor(statusText(), (n) => t().status.liveHeld(n, 2, 0))).not.toBeNaN(), {
      timeout: 25_000,
    });
    await vi.waitFor(() => expect(insertFxWrites(shell).length).toBeGreaterThan(written), { timeout: 25_000 });
    await endLive();
  });

  // The read that CONSUMES the rate history is not always the read that was running when
  // the announcement arrived. A full read already in flight reads the selector before the
  // unit clears it, so it holds nothing — and clearing the whole history on its way out
  // takes the announcement away from the replay it scheduled, which is the read that sees
  // the cleared selector.
  it("leaves the announcement for the replay a read in flight scheduled", SLOW, async () => {
    const shell = await bootDevice();
    await heldByExcursion(shell);

    const written = insertFxWrites(shell).length;
    // CH 1's selector answers as it stood for the FIRST read that asks, and cleared for
    // every one after — so the read already in flight sees it standing (and holds
    // nothing) while the replay behind it is the first to see it gone. Counted rather
    // than timed: which read of a 700-address sweep reaches CH 1 is not a clock.
    let asked = 0;
    shell.answer("vd_get", (a: Record<string, unknown>) => {
      const v =
        a.paramId === PARAMS.SAMPLE_RATE.id
          ? 48_000
          : a.paramId === PARAMS.INSERT_FX.id && a.y === 0
            ? asked++ === 0
              ? COMPANDER_H
              : denormalizeInsertFx(INSERT_FX_NONE)
            : unwrittenRead(a);
      return new Promise((r) => setTimeout(() => r(v), 2));
    });
    const at = shell.invokes.indexOf("vd_params_subscribe");
    const { channel } = shell.args[at] as { channel: { onmessage: (d: unknown) => void } };

    // An address in no index forces a FULL read, without touching the rate history.
    channel.onmessage([{ param_id: 9_999, x: 0, y: 0, value: 1 }]);
    // Past CH 1's own selector, which this read has now taken as standing.
    await vi.waitFor(() => expect(asked).toBeGreaterThan(0), { timeout: 25_000, interval: 2 });
    // The excursion lands inside it and schedules the replay.
    channel.onmessage([
      { param_id: PARAMS.SAMPLE_RATE.id, x: 0, y: 0, value: 192_000 },
      { param_id: PARAMS.SAMPLE_RATE.id, x: 0, y: 0, value: 48_000 },
    ]);

    // …and the replay behind it, which is the first read to see the cleared selector.
    await vi.waitFor(() => expect(countFor(statusText(), (n) => t().status.liveHeld(n, 2, 0))).not.toBeNaN(), {
      timeout: 25_000,
    });
    await vi.waitFor(() => expect(insertFxWrites(shell).length).toBeGreaterThan(written), { timeout: 25_000 });
    await endLive();
  });

  // …and the read it was for CONSUMES it, whatever else is reading when it ends. What the
  // announcement must not do is outlive that read: the next clearing is the operator's own,
  // made by hand on the unit at a rate that runs the effect, and holding it against a rate
  // the unit left long before overrides them. (Their clearing IS announced on the insert-FX
  // addresses, but that announcement arrives BEFORE the read it escalates to, so it falls
  // outside the window `announced` covers — the rate history is what decides it.) The read
  // here ends while a side-effect refetch is still open: a follow read that establishes no
  // rate of its own, so it consumes nothing either.
  it("adopts the operator's own clearing once the announcement has been consumed", SLOW, async () => {
    const shell = await bootDevice();
    await heldByExcursion(shell);

    // A CH 4 address the whole-device read reaches and a STEREO refetch does not, and a STEREO
    // address the refetch reads.
    const fullRead = gate(PARAMS.HPF_ON.id, 3);
    const refetch = gate(PARAMS.OSC_ASSIGN_STEREO.id, 0);
    let cleared = false;
    const value = (a: Record<string, unknown>): number =>
      a.paramId === PARAMS.SAMPLE_RATE.id
        ? 48_000
        : a.paramId === PARAMS.INSERT_FX.id && a.y === 0 && cleared
          ? denormalizeInsertFx(INSERT_FX_NONE)
          : a.paramId === PARAMS.INSERT_FX.id && a.y === 0
            ? COMPANDER_H
            : unwrittenRead(a);
    shell.answer("vd_get", (a: Record<string, unknown>) => {
      const wait = fullRead.take(a) ?? refetch.take(a);
      return wait ? wait.then(() => value(a)) : value(a);
    });
    const at = shell.invokes.indexOf("vd_params_subscribe");
    const { channel } = shell.args[at] as { channel: { onmessage: (d: unknown) => void } };

    // The excursion, held and re-sent by the full read it escalates to — parked part-way.
    cleared = true;
    fullRead.arm();
    channel.onmessage([
      { param_id: PARAMS.SAMPLE_RATE.id, x: 0, y: 0, value: 192_000 },
      { param_id: PARAMS.SAMPLE_RATE.id, x: 0, y: 0, value: 48_000 },
    ]);
    await vi.waitFor(() => expect(fullRead.held(), "the full read reached CH 4").toBe(true), { timeout: 25_000 });
    // A STEREO EQ 1-knob switched on beside it, whose flush refetches STEREO — parked too.
    refetch.arm();
    selectNode("bus.stereo");
    $("inspector").querySelector<HTMLButtonElement>("#btn-eq-screen")!.click();
    $("dyn-screen-box")
      .querySelector<HTMLElement>("#dyn-oneknob-level")!
      .closest(".prefs-section")!
      .querySelectorAll<HTMLButtonElement>(".prefs-toggle button")[0]
      .click(); // ON
    await vi.waitFor(() => expect(refetch.held(), "the refetch reached STEREO").toBe(true), { timeout: 25_000 });
    // The full read ends with the refetch still open.
    fullRead.release();
    await vi.waitFor(() => expect(countFor(statusText(), (n) => t().status.liveHeld(n, 2, 0))).not.toBeNaN(), {
      timeout: 25_000,
    });

    // Now the operator clears it by hand, at a rate that runs it, while the refetch is still
    // open — so the follow read this announcement asks for is the next read of CH 1, held off
    // until the flush carrying the refetch is done.
    const status = recordStatus();
    channel.onmessage([{ param_id: PARAMS.INSERT_FX.id, x: 0, y: 0, value: denormalizeInsertFx(INSERT_FX_NONE) }]);
    refetch.release();
    $("dyn-screen-box").querySelector<HTMLButtonElement>(".consent-actions .consent-btn-secondary")!.click();
    // Whichever the read that took the clearing says first.
    await vi.waitFor(() => expect(status.lines.some((l) => followedLine(l) || heldLine(l))).toBe(true), {
      timeout: 25_000,
    });
    status.stop();
    expect(status.lines.filter(heldLine)).toEqual([]);
    await endLive();
  });

  // The Signal Type transition is announced on the PAIR's primary and clears the effect
  // on both members (measured), so recording the announcement without its partner leaves
  // the other half of the pair held and re-sent — half a clearing undone.
  it("carries a pair-level announcement to the partner as well", SLOW, async () => {
    const shell = await bootDevice();
    await heldByExcursion(shell, true); // STEREO: the mirror gives both members the effect

    const written = insertFxWrites(shell).length;
    const from = shell.invokes.length;
    // The read keeps answering STEREO, so it is the stale half of the race: the pair's
    // Signal Type is read before the selector, and a transition in that gap leaves the
    // predicate comparing two equal values. Only the announcement says what happened. The
    // read is held at CH 1's selector, which is that gap.
    const selector = gate(PARAMS.INSERT_FX.id, 0);
    selector.arm();
    notifyRate(shell, { hold: selector.take, linked: true });
    const at = shell.invokes.indexOf("vd_params_subscribe");
    const { channel } = shell.args[at] as { channel: { onmessage: (d: unknown) => void } };
    await vi.waitFor(() => expect(selector.held(), "the read reached CH 1's selector").toBe(true), {
      timeout: 25_000,
    });
    expect(
      shell.args
        .slice(from)
        .some((a, i) => shell.invokes[from + i] === "vd_get" && a?.paramId === PARAMS.SIGNAL_TYPE.id),
      "the premise: the read asked for the Signal Type first",
    ).toBe(true);
    // The pair-level address, at the primary's index alone — which is the only index the
    // unit announces it on.
    const status = recordStatus();
    channel.onmessage([{ param_id: PARAMS.SIGNAL_TYPE.id, x: 0, y: 0, value: 0 }]);
    selector.release();

    await vi.waitFor(() => expect(status.lines.some((l) => followedLine(l) || heldLine(l))).toBe(true), {
      timeout: 25_000,
    });
    status.stop();
    // Neither member held: a partner left out would show as its own two kept keys.
    expect(status.lines.filter(heldLine)).toEqual([]);
    expect(insertFxWrites(shell).length).toBe(written);
    await endLive();
  });

  // And when the read is partial as well, it merges nothing — a follow read is all or
  // nothing, as the session's starting read is — so it holds nothing either, and the
  // teardown names the incomplete read alone.
  it("ends on the incomplete read alone when a read that would hold is partial", SLOW, async () => {
    const shell = await bootDevice();
    await heldByExcursion(shell);

    notifyRate(shell, { refuseY: 3 }); // CH 4's reads refused; CH 1, which holds, is y0

    await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 25_000 });
    // The whole line is the incomplete-read message: nothing kept is appended to it.
    expect(
      countFor(errors(shell).at(-1) ?? "", (n) => t().status.liveError(t().error.followReadIncomplete(n))),
    ).not.toBeNaN();
  });

  it("comes up, prints the tally, and goes down again", SLOW, async () => {
    const shell = await bootDevice();
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });

    expect($("live-tally").hidden).toBe(false);
    expect($("live-tally").textContent).toBe(t().toolbar.liveTag);
    expect(shell.count("vd_params_subscribe")).toBe(1);
    expect(shell.count("vd_watch_link")).toBe(1);

    const disconnects = shell.count("vd_disconnect");
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("false"), { timeout: 10_000 });
    expect($("live-tally").hidden).toBe(true);
    expect(shell.count("vd_params_unsubscribe")).toBe(1);
    // The disconnect is issued from an un-awaited teardown, so it lands after the
    // toggle has already flipped — asserted immediately it reads as never sent.
    await invoked(shell, "vd_disconnect", disconnects + 1, 10_000);
  });

  // The session is one holder among several, and the model picker is locked for its
  // whole duration — a switch replaces the plan wholesale, which a session cannot
  // survive. (The race harness pins the same rule from the other side.)
  it("locks the model picker and the other device actions for its duration", SLOW, async () => {
    const shell = await bootDevice();
    const picker = $<HTMLSelectElement>("model-picker");
    expect(picker.disabled).toBe(false);

    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    expect(picker.disabled).toBe(true);
    expect(($("btn-fetch") as HTMLButtonElement).disabled).toBe(true);

    const disconnects = shell.count("vd_disconnect");
    $("btn-live").click();
    // The model picker goes with the SESSION and the rest with the LINK, and the two no
    // longer end together: the release waits out a follow read still doing round trips, so
    // an action taken between them would connect over the read (the case below drives that
    // window). The picker is free at once because a plan replacement is what it costs, and
    // that is the session's business rather than the connection's.
    await vi.waitFor(() => expect(picker.disabled).toBe(false), { timeout: 10_000 });
    await invoked(shell, "vd_disconnect", disconnects + 1, 10_000);
    await vi.waitFor(() => expect(($("btn-fetch") as HTMLButtonElement).disabled).toBe(false), { timeout: 10_000 });
    expect($<HTMLSelectElement>("rate-picker").disabled).toBe(false);
  });

  // Two clicks inside the activation must admit one session: the flow is long and
  // async, and during it the toggle is neither on nor off.
  it("admits one session for two clicks in the same tick", SLOW, async () => {
    const shell = await bootDevice();
    live().click();
    live().click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    expect(shell.count("vd_connect")).toBe(1);
    expect(shell.count("vd_params_subscribe")).toBe(1);
  });

  // The failure that lands PAST the point of no return. `live.begin()` flips the sync on
  // before the two awaited registrations, so a throw from either leaves a session that is
  // half up: sync active, `liveSessionUp` still false. Tearing only the connection down
  // there leaves `live.isActive()` true, and every later click routes into
  // deactivateLive's early return — a toggle that does nothing for the rest of the launch.
  //
  // The second click is therefore the case, not a coda to it: the teardown is only
  // observable as the session that follows it. `failOnce` is what lets that second click
  // succeed, so a dead toggle fails here rather than timing out against a shell that
  // refuses everything.
  it("tears a half-started session down, and leaves the toggle live", SLOW, async () => {
    const shell = await bootDevice();
    shell.failOnce("vd_watch_link", new Error("watch-refused"));
    $("btn-live").click();

    // follow.begin() had already registered; failLive is what gives that back. That is the
    // FIRST of its four steps and the dialog is the last, so the disconnect between them
    // is what the assertions wait on rather than a dialog three steps past the wait.
    await vi.waitFor(() => expect(shell.count("vd_params_unsubscribe")).toBe(1), { timeout: 25_000 });
    await invoked(shell, "vd_disconnect");
    expect(errors(shell)).toEqual([t().status.liveError("watch-refused")]);
    expect(live().getAttribute("aria-checked")).toBe("false");
    expect($("live-tally").hidden).toBe(true);

    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    expect(shell.count("vd_params_subscribe")).toBe(2);
  });

  it("reports a session that cannot start, and leaves the toggle off", SLOW, async () => {
    const shell = await bootDevice();
    shell.answer("vd_connect", () => {
      throw new Error("no-device");
    });
    $("btn-live").click();
    await vi.waitFor(() => expect(shell.count("plugin:dialog|message")).toBeGreaterThan(0), { timeout: 10_000 });
    expect(live().getAttribute("aria-checked")).toBe("false");
    expect($("live-tally").hidden).toBe(true);
    expect($<HTMLSelectElement>("model-picker").disabled).toBe(false);
  });

  // A rename made on the unit itself arrives on the string path, and this is the only
  // place the app's own `applyName` runs: follow.test.ts stubs the hook, and the race
  // harness reads the canvas label, which is trimmed on the way out and reads the same
  // whatever the plan holds.
  //
  // It is normalized like a name typed into the app — cut to the bound, and THEN
  // stripped of trailing padding. The order is the half this pins: a name whose eighth
  // character is a space has nothing to trim before the cut, so trimming first leaves
  // one in the plan, and a plan name carrying a trailing space is re-sent on every sync
  // (the unit stores it, every read trims it off, and the two never match).
  //
  // The wire is what makes such a name reachable at all: the unit's own name screen
  // takes 8 characters, but a 20-character name is storable and reads back whole
  // (measured on a URX44V), so a longer one gets here from another client.
  //
  // Read off the inspector, which shows the plan's own string.
  it("normalizes a rename arriving from the unit, its padding as well as its length", SLOW, async () => {
    const shell = await bootDevice();
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });

    const nc = nameControl(getModel("URX44V"), "ch1")!;
    notifyChannel(shell).onmessage([{ param_id: nc.param, x: 0, y: 0, value: 0, value_str: "1234567  9" }]);

    // Asserted immediately, and deliberately not awaited: the notify is delivered and
    // applied synchronously, while the idle net a followed change arms fires a full
    // reconcile 900 ms later — and this stub never took the write, so that sweep reads
    // the name back as empty and clears it. A `waitFor` here would therefore report an
    // empty field for a name that had arrived correctly, and would let a wrong value be
    // polled away instead of failing.
    selectNode("ch1");
    expect($("inspector").querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe("1234567");
  });

  // The other route a rename made on the unit takes, and the one the app has to ASK
  // for: a device-side change reconciles the node it touched, and that read covers the
  // node's name. It is what carries a rename the app was never told about — a notify
  // that did not arrive, or a change made on the unit's own screen in a way that emits
  // none — and the whole-device idle sweep behind it carries the same thing.
  //
  // Pinned HERE, at the entry, because the skip that removed it is a decision about
  // WHICH CALLER is reading. readback.test.ts had a case for it and stayed green: it
  // stood in for the reconcile by calling with no pending writes, which is what the
  // reconcile used to do — and then the reconcile started carrying them, the skip was
  // inferred from exactly that, and names stopped being read by either reconcile with
  // nothing in this repository disagreeing. Only the race harness's group count saw it.
  //
  // The name has to appear AFTER the session's starting read, or the starting read
  // would be what put it in the plan and this would pass with the reconcile removed.
  // Eight characters, so what lands is the name rather than the clip — the bound is
  // the unit's own name screen, and a longer one comes back cut (pinned above).
  it("reads a name off the unit in the reconcile a device-side change triggers", SLOW, async () => {
    const nc = nameControl(getModel("URX44V"), "ch1")!;
    let renamedOnUnit = false;
    const shell = await bootDevice({
      vd_get_str: (a: Record<string, unknown>) =>
        renamedOnUnit && a.paramId === nc.param && a.y === 0 ? "UnitName" : "",
    });
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });

    renamedOnUnit = true;
    // A scoped (non-direct) parameter: its notify is not applied on its own, it makes
    // the follow re-read the node — which is the read under test.
    notifyChannel(shell).onmessage([{ param_id: PARAMS.HPF_FREQ.id, x: 0, y: 0, value: 40 }]);

    selectNode("ch1");
    await vi.waitFor(
      () => {
        selectNode("ch1"); // the reconcile re-renders; re-select so the field is current
        expect($("inspector").querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe("UnitName");
      },
      { timeout: 25_000, interval: 50 },
    );
  });
});

describe("the inspector while the CONSOLE hides it", () => {
  /** A strip's A.GAIN knob on the CONSOLE, which IS on screen while the panel is not —
   *  so it says the follow reflect ran, and a stale panel cannot be read as a notify
   *  that never arrived. */
  const consoleGain = (strip: string): string | null =>
    [...$("console-host").querySelectorAll<HTMLElement>(".con-strip")]
      .find((s) => s.getAttribute("aria-label") === spoken(strip))
      ?.querySelector<HTMLElement>('[aria-label="A.GAIN"]')
      ?.getAttribute("aria-valuenow") ?? null;

  // The panel is display:none for as long as the CONSOLE view is up, and a device
  // follow that touches the selected node would otherwise rebuild it there at the
  // reflect's own rate — focus and caret capture included, on a subtree nothing can
  // focus. The rebuild is deferred, not dropped, so the value has to be on screen after
  // the view switch WITHOUT the operator re-selecting the node: every other case in
  // the main.device files re-selects on the way back, which rebuilds a visible panel and would pass
  // with the drain deleted.
  it("holds the rebuild while the CONSOLE hides it, and pays it on the way back", SLOW, async () => {
    // The unit has CH 3 on jack 1 as well, so the one gain shows on both strips.
    const shell = await bootDevice({}, true, { [`${PARAMS.INPUT_SOURCE.id}/0/2`]: 0 });
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    selectNode("ch1");
    const before = paramRow(t().inspector.gainAnalog);

    $("btn-view-console").click();
    // A direct follow on the selected node: applied into the plan with no read back.
    // Whole dB, since the gain decode rounds and a smaller step would leave the plan
    // where it was — the panel would then agree for the wrong reason.
    notifyChannel(shell).onmessage([{ param_id: PARAMS.HA_GAIN.id, x: 0, y: 0, value: 2000 }]);
    // The reflect is coalesced onto a timer, so wait for it where it IS visible.
    await vi.waitFor(() => expect(consoleGain("CH 1")).toBe("20"), { timeout: 25_000 });
    expect(consoleGain("CH 3"), "CH 3 reads jack 1 too").toBe("20");

    // It ran, and it rebuilt no panel: the row is the same element.
    expect(paramRow(t().inspector.gainAnalog)).toBe(before);

    $("btn-view-graph").click();
    expect(paramRow(t().inspector.gainAnalog)).not.toBe(before);
    expect(paramRow(t().inspector.gainAnalog).textContent).toContain("20");

    // End the session rather than leaving it running: its idle net would fire into the
    // next case, which boots its own shell.
    $("btn-live").click();
    await invoked(shell, "vd_disconnect");
  });
});

// A node's CUE row in the inspector: read-only with no session, and once one is up a press on
// it writes the strip's flag, the way the CONSOLE chip does.

describe("the inspector's CUE row", () => {
  const cueWrites = (shell: TauriShell): number[] =>
    shell.invokes.flatMap((cmd, i) => {
      const a = shell.args[i];
      return cmd === "vd_set" && a?.paramId === PARAMS.CUE_MONO.id && a?.y === 0 ? [a.value as number] : [];
    });
  const button = (text: string): HTMLButtonElement =>
    [...paramRow(t().inspector.cue).querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;

  it("writes the strip's flag once a session is up", SLOW, async () => {
    const shell = await bootDevice();
    selectNode("ch1");
    expect(button(t().inspector.on).disabled, "the premise: read-only with no session").toBe(true);
    live().click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    // The session's starting read hands the board a plan, which clears the selection.
    selectNode("ch1");
    expect(button(t().inspector.on).disabled).toBe(false);
    button(t().inspector.on).click();
    await vi.waitFor(() => expect(cueWrites(shell)).toEqual([1]), { timeout: 25_000 });
    expect(button(t().inspector.on).getAttribute("aria-pressed")).toBe("true");
    expect(errors(shell)).toEqual([]);
  });
});
