// @vitest-environment jsdom

// The unit's Console Lock (System 1.5, core/control/console-lock.ts). The unit goes on taking
// writes over the link while it is locked, so the app holds its own back: a live session follows
// the lock and refuses what would write, and a write outside a session asks first and stops when
// the lock arrives.
//
// The setup, the teardown and the helpers every desktop case shares are `main.device.test-util.ts`'s.

import { describe, expect, it, vi } from "vitest";
import { $, bootApp, deviceCommands, statusText, unwrittenRead } from "./main.test-util";
import type { TauriShell } from "./main.test-util";
import { FX_EFFECT_ARRAY_PARAM } from "./core/control/fx-effect";
import { DEBOUNCE_MS } from "./core/control/live";
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
  paramRow,
  pressNode,
  pressOscOn,
  quiet,
  turnOscOn,
  undoEdit,
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

  // The starting read takes the lock before the session registers for its notify, so a lock that
  // lands between the two announces itself to nobody: the session reads it again behind the
  // registration, and sends nothing until it has.
  it.each([
    { locked: 1, sent: [] },
    { locked: 0, sent: [1] },
  ])(
    "reads the lock again behind the notify registration (locked in between: $locked)",
    SLOW,
    async ({ locked, sent }) => {
      let lock = 0;
      let lockRead = false;
      let registered = false;
      const shell = await bootDevice({
        vd_get: (a: Record<string, unknown>) => {
          if (a.paramId === PARAMS.CONSOLE_LOCK.id) {
            lockRead = true;
            return lock;
          }
          // The unit is locked once the starting read has taken the lock and before the session
          // has registered for its notify.
          if (lockRead && !registered) lock = locked;
          return unwrittenRead(a);
        },
        vd_params_subscribe: () => {
          registered = true;
          return null;
        },
      });
      await up();
      expect(lock, "the premise: the unit was locked in between").toBe(locked);
      expect(strip().hidden).toBe(locked === 0);
      expect(oscOn()).toBe("OFF");
      pressOscOn();
      await quiet(shell);
      expect(writesTo(shell, PARAMS.OSC_ON.id)).toEqual(sent);
      expect(errors(shell)).toEqual([]);
    },
  );

  it(
    "sends nothing an edit made while the session registers asks for, until the lock is read again",
    SLOW,
    async () => {
      let registered = false;
      let answer: ((value: number) => void) | null = null;
      const shell = await bootDevice({
        vd_get: (a: Record<string, unknown>) =>
          a.paramId === PARAMS.CONSOLE_LOCK.id && registered
            ? new Promise<number>((r) => (answer = r))
            : unwrittenRead(a),
        vd_params_subscribe: () => {
          registered = true;
          return null;
        },
      });
      live().click();
      await vi.waitFor(() => expect(answer).not.toBeNull(), { timeout: 25_000 });
      try {
        // An edit while the read behind the registration is out, held there past the window a flush
        // waits for.
        expect(oscOn(), "the premise").toBe("OFF");
        pressOscOn();
        await new Promise((r) => setTimeout(r, DEBOUNCE_MS * 3));
        expect(writesTo(shell, PARAMS.OSC_ON.id), "nothing goes while the lock is being read").toEqual([]);
      } finally {
        answer!(1);
      }
      await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
      await vi.waitFor(() => expect(statusText()).toBe(t().status.consoleLockedPutBack), { timeout: 25_000 });
      await quiet(shell);
      expect(writesTo(shell, PARAMS.OSC_ON.id)).toEqual([]);
      expect(oscFace()).toBe("OFF");
      expect(errors(shell)).toEqual([]);
    },
  );

  // The edits a lock stopped are read back from the unit before the session sends anything again,
  // so a lock taken off before that read is done does not send them.
  it("sends nothing the lock stopped when the lock is taken off before its read-back", SLOW, async () => {
    const shell = await bootDevice();
    await up();
    expect(oscOn(), "the premise").toBe("OFF");
    pressOscOn();
    announceLock(shell, 1);
    announceLock(shell, 0);
    await vi.waitFor(() => expect(statusText()).toBe(t().status.consoleLockedPutBack), { timeout: 25_000 });
    await quiet(shell);
    expect(oscFace()).toBe("OFF");
    // The next edit sends what it moved and nothing the lock stopped.
    $("btn-auto").click();
    await Promise.resolve();
    await quiet(shell);
    expect(writesTo(shell, PARAMS.OSC_ON.id)).toEqual([]);
    expect(oscFace()).toBe("OFF");
    expect(errors(shell)).toEqual([]);
  });

  it(
    "stops a flush at its next command when the lock comes and goes while a command is on the wire",
    SLOW,
    async () => {
      const table = deviceCommands({ "plugin:dialog|message": "Ok" });
      const set = table.vd_set as (a: Record<string, unknown>) => unknown;
      let answer!: () => void;
      const answered = new Promise<void>((r) => (answer = r));
      let onWire!: () => void;
      const wire = new Promise<void>((r) => (onWire = r));
      const shell = (await bootApp({
        tauri: {
          ...table,
          // The oscillator's switch is held on the wire until the lock has come and gone.
          vd_set: async (a: Record<string, unknown>) => {
            const result = set(a);
            if (a.paramId === PARAMS.OSC_ON.id) {
              onWire();
              await answered;
            }
            return result;
          },
        },
      }))!;
      await up();
      await quiet(shell);
      oscOn();
      pressOscOn();
      const level = paramRow(t().inspector.oscLevel).querySelector<HTMLInputElement>('input[type="range"]')!;
      level.value = "-10";
      level.dispatchEvent(new Event("input", { bubbles: true }));
      level.dispatchEvent(new Event("change", { bubbles: true }));
      try {
        await wire;
        announceLock(shell, 1);
        await Promise.resolve();
        announceLock(shell, 0);
        await Promise.resolve();
      } finally {
        answer();
      }
      await quiet(shell);
      expect(writesTo(shell, PARAMS.OSC_ON.id), "the premise: the switch was on the wire").toEqual([1]);
      expect(writesTo(shell, PARAMS.OSC_LEVEL.id)).toEqual([]);
      $("btn-auto").click();
      await Promise.resolve();
      await quiet(shell);
      expect(writesTo(shell, PARAMS.OSC_LEVEL.id), "nor by the next flush").toEqual([]);
      expect(errors(shell)).toEqual([]);
    },
  );
});

// The delay time tempo Sync drives is left out of the plan's writer and written to the unit on its
// own when it is turned (main.device.fx.test.ts), so Console Lock asks about it as well.
describe("Console Lock and a value the unit drives", () => {
  const FX1 = FX_EFFECT_ARRAY_PARAM[0];
  const seed = { [`${PARAMS.FX_EFFECT_TYPE.id}/0/0`]: 1024, [`${FX1}/0/4`]: 1, [`${FX1}/0/6`]: 5000 };
  const delaysSent = (shell: TauriShell): number[] =>
    shell.invokes.flatMap((cmd, i) => {
      const a = shell.args[i] as Record<string, number>;
      return cmd === "vd_set" && a.paramId === FX1 && a.y === 6 ? [a.value] : [];
    });
  /** The FX 1 screen's delay time row, open on the screen. */
  const delayRow = (): HTMLInputElement => {
    pressNode("bus.fx1");
    $<HTMLButtonElement>("btn-fx-screen").click();
    const row = $("dyn-screen-box").querySelector<HTMLInputElement>('input[data-dyn="fx:delay"]');
    if (!row) throw new Error("the FX 1 screen draws no delay time");
    return row;
  };
  const close = (): void => $("dyn-screen-box").querySelector<HTMLButtonElement>(".consent-actions button")!.click();
  const turn = (row: HTMLInputElement, value: number): void => {
    row.value = String(value);
    row.dispatchEvent(new Event("input", { bubbles: true }));
    row.dispatchEvent(new Event("change", { bubbles: true }));
  };

  it.each([
    { locked: 1, sent: [], shown: "5000" },
    { locked: 0, sent: [4500], shown: "4500" },
  ])("puts a turned delay time back on a locked unit (locked: $locked)", SLOW, async ({ locked, sent, shown }) => {
    const shell = await bootDevice({}, true, { ...seed, [LOCK]: locked });
    await up();
    await quiet(shell);
    const row = delayRow();
    expect(row.value, "the premise").toBe("5000");
    turn(row, 4500);
    await quiet(shell);
    expect(delaysSent(shell)).toEqual(sent);
    expect(delayRow().value).toBe(shown);
    if (locked) expect(statusText()).toBe(t().status.consoleLockedEditPutBack);
    close();
    expect(errors(shell)).toEqual([]);
  });

  it("holds back an undo of a turned delay time while the unit is locked", SLOW, async () => {
    const shell = await bootDevice({}, true, seed);
    await up();
    await quiet(shell);
    turn(delayRow(), 4500);
    close();
    await vi.waitFor(() => expect(delaysSent(shell)).toEqual([4500]), { timeout: 10_000 });
    announceLock(shell, 1);
    await vi.waitFor(() => expect(strip().hidden).toBe(false));
    await quiet(shell);
    undoEdit(shell);
    expect(statusText()).toBe(t().status.consoleLockedUndo);
    await quiet(shell);
    expect(delayRow().value).toBe("4500");
    close();
    expect(delaysSent(shell)).toEqual([4500]);
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
