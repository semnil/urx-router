// @vitest-environment jsdom

// The unit's Console Lock (System 1.5, core/control/console-lock.ts). The unit goes on taking
// writes over the link while it is locked, so the app holds its own back: a live session follows
// the lock and refuses what would write, and a write outside a session asks first and stops when
// the lock arrives.
//
// The setup, the teardown and the helpers every desktop case shares are `main.device.test-util.ts`'s.

import { describe, expect, it, vi } from "vitest";
import { $, statusText } from "./main.test-util";
import type { TauriShell } from "./main.test-util";
import { PARAMS } from "./core/control/params";
import { t } from "./i18n";
import {
  SLOW,
  bootDevice,
  clockReads,
  confirms,
  errors,
  invoked,
  live,
  notifyChannel,
  oscFace,
  oscOn,
  pressOscOn,
  quiet,
  turnOscOn,
  WRITE_ASK,
} from "./main.device.test-util";

const LOCK = `${PARAMS.CONSOLE_LOCK.id}/0/0`;
const writesTo = (shell: TauriShell, paramId: number): number[] =>
  shell.invokes.flatMap((cmd, i) =>
    cmd === "vd_set" && shell.args[i]?.paramId === paramId ? [shell.args[i]!.value as number] : [],
  );
const announceLock = (shell: TauriShell, value: number): void =>
  notifyChannel(shell).onmessage([{ param_id: PARAMS.CONSOLE_LOCK.id, x: 0, y: 0, value }]);
const up = async (): Promise<void> => {
  live().click();
  await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
};
const strip = (): HTMLElement => $("lock-strip");

describe("Console Lock during a live session", () => {
  it(
    "shows the strip on a locked unit, puts an edit back unsent, and sends again once it is unlocked",
    SLOW,
    async () => {
      const shell = await bootDevice({}, true, { [LOCK]: 1 });
      expect(strip().hidden, "the premise: no session, no strip").toBe(true);
      await up();
      expect(strip().hidden).toBe(false);
      expect($("lock-strip-title").textContent).toBe(t().lock.title);
      expect($("lock-strip-text").textContent).toBe(t().lock.body);

      turnOscOn();
      await vi.waitFor(() => expect(statusText()).toBe(t().status.consoleLockedEditPutBack));
      expect(oscFace(), "the edit is put back").toBe("OFF");
      await quiet(shell);
      expect(writesTo(shell, PARAMS.OSC_ON.id)).toEqual([]);

      // An edit that writes nothing to the unit stands: Arrange moves every node and nothing else.
      $("btn-auto").click();
      await Promise.resolve();
      await quiet(shell);
      expect(statusText()).toBe(t().status.arranged);

      announceLock(shell, 0);
      await vi.waitFor(() => expect(strip().hidden).toBe(true));
      expect(statusText()).toBe(t().status.consoleUnlocked);
      await quiet(shell);
      expect(writesTo(shell, PARAMS.OSC_ON.id), "nothing put back goes out at the unlock").toEqual([]);

      pressOscOn();
      await vi.waitFor(() => expect(writesTo(shell, PARAMS.OSC_ON.id)).toEqual([1]), { timeout: 25_000 });
      expect(oscFace()).toBe("ON");
      expect(errors(shell)).toEqual([]);
    },
  );

  it("refuses an operation outside the plan while the lock lasts, and ends with the session", SLOW, async () => {
    const shell = await bootDevice();
    await up();
    expect(strip().hidden).toBe(true);
    announceLock(shell, 1);
    await vi.waitFor(() => expect(strip().hidden).toBe(false));
    expect(statusText()).toBe(t().status.consoleLocked);

    $("cue-mode-last").click();
    expect(statusText()).toBe(t().status.consoleLockedNotSent);
    expect($("cue-mode-last").getAttribute("aria-pressed"), "the mode stays as the unit holds it").toBe("false");
    await quiet(shell);
    expect(writesTo(shell, PARAMS.CUE_MODE.id)).toEqual([]);

    // The session ends: the strip goes with it, and a write outside a session asks again.
    live().click();
    await invoked(shell, "vd_disconnect");
    expect(strip().hidden).toBe(true);
    expect(errors(shell)).toEqual([]);
  });

  // An edit the session had not sent when the lock arrived: the flush waiting for it never runs,
  // and the node is read back from the unit so the plan shows what the unit holds.
  it("reads back an edit the lock caught unsent rather than sending it", SLOW, async () => {
    const shell = await bootDevice();
    await up();
    expect(oscOn(), "the premise").toBe("OFF");
    pressOscOn();
    announceLock(shell, 1);
    await vi.waitFor(() => expect(statusText()).toBe(t().status.consoleLockedPutBack), { timeout: 25_000 });
    expect(oscFace()).toBe("OFF");
    await quiet(shell);
    expect(writesTo(shell, PARAMS.OSC_ON.id)).toEqual([]);
    expect(errors(shell)).toEqual([]);
  });
});

describe("Console Lock and a write outside a session", () => {
  it("refuses Write to device on a locked unit, before it asks anything", SLOW, async () => {
    const shell = await bootDevice({}, true, { [LOCK]: 1 });
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    expect(errors(shell)).toEqual([t().error.consoleLocked]);
    expect(confirms(shell).filter((m) => m.includes(WRITE_ASK))).toEqual([]);
    expect(shell.count("vd_set") + shell.count("vd_set_str")).toBe(0);
    // The registration it made to watch for the lock is let go with the connection.
    expect(shell.count("vd_params_unsubscribe")).toBe(1);
  });

  it("stops Write to device at the next command when the unit is locked under it", SLOW, async () => {
    const box: { shell: TauriShell | null } = { shell: null };
    let sent = 0;
    const shell = await bootDevice({
      vd_get: clockReads(false, 48_000),
      // The lock is announced while the third write is on the wire.
      vd_set: () => {
        sent++;
        if (sent === 3) announceLock(box.shell!, 1);
        return null;
      },
    });
    box.shell = shell;
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    expect(shell.count("vd_set"), "nothing after the write on the wire").toBe(3);
    expect(shell.count("vd_set_str")).toBe(0);
    // The total is read out of the line and put back, so the assertion pins the whole frame.
    const total = Number(/(\d+) of (\d+) sent/.exec(statusText())?.[2] ?? NaN);
    expect(statusText()).toBe(t().status.writeLocked(3, total));
    expect(total).toBeGreaterThan(3);
    expect(errors(shell)).toEqual([]);
  });

  it("refuses the Follow USB switch on a locked unit", SLOW, async () => {
    const shell = await bootDevice({
      vd_get: (a: Record<string, unknown>) => (a.paramId === PARAMS.CONSOLE_LOCK.id ? 1 : clockReads(true, 48_000)(a)),
    });
    // The badge is unknown until something reads it; the first press reads.
    $("follow-usb").click();
    await invoked(shell, "vd_disconnect");
    $("follow-usb").click();
    await invoked(shell, "vd_disconnect", 2);
    expect(errors(shell)).toEqual([t().error.consoleLocked]);
    expect(writesTo(shell, PARAMS.FOLLOW_USB.id)).toEqual([]);
  });
});
