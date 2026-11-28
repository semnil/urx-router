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
import { formatRate } from "./core/constraints";
import { SUPPORTED_SYSTEM_FIRMWARE } from "./core/control/firmware";
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
  selectNode,
  turnOscOn,
  undoEdit,
  RETRY_ASK,
  SAVES,
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
    // The status line is set as the read-back ends; the board repaints on the reflect it requests.
    await vi.waitFor(() => expect(oscFace()).toBe("OFF"));
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
        await shell.delivered();
        announceLock(shell, 0);
        await shell.delivered();
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

  // A Clip Safe OFF waits for the unit to announce the A.Gain sent ahead of it. A lock that comes
  // and goes during that wait stops it there, as it stops the next command.
  it.each([
    { locked: true, sent: [] },
    { locked: false, sent: [0] },
  ])("stops a Clip Safe OFF waiting on its A.Gain (lock comes and goes: $locked)", SLOW, async ({ locked, sent }) => {
    const shell = await bootDevice({}, true, {
      [`${PARAMS.HA_GAIN.id}/0/0`]: -800,
      [`${PARAMS.CLIP_SAFE.id}/0/0`]: 1,
    });
    await up();
    await quiet(shell);
    pressNode("ch1");
    const gain = paramRow(t().inspector.gainAnalog).querySelector<HTMLInputElement>('input[type="range"]')!;
    gain.value = "-5";
    gain.dispatchEvent(new Event("input", { bubbles: true }));
    gain.dispatchEvent(new Event("change", { bubbles: true }));
    [...paramRow(t().inspector.clipSafe).querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "OFF")!
      .click();
    await vi.waitFor(() => expect(writesTo(shell, PARAMS.HA_GAIN.id)).toEqual([-500]), { timeout: 5_000, interval: 5 });
    expect(writesTo(shell, PARAMS.CLIP_SAFE.id), "the premise: the OFF waits").toEqual([]);
    if (locked) {
      announceLock(shell, 1);
      announceLock(shell, 0);
    }
    notifyChannel(shell).onmessage([{ param_id: PARAMS.HA_GAIN.id, x: 0, y: 0, value: -500 }]);
    await shell.delivered();
    await quiet(shell);
    expect(writesTo(shell, PARAMS.CLIP_SAFE.id)).toEqual(sent);
    expect(errors(shell)).toEqual([]);
  });

  // The read-back takes the unit's values for what the lock stopped, and leaves an edit made once
  // the lock is off as the operator left it — on the same node, and on a node only a read of the
  // whole unit covers.
  it("keeps an edit made once the lock is off on a node the read-back covers", SLOW, async () => {
    const shell = await bootDevice();
    await up();
    await quiet(shell);
    expect(oscOn(), "the premise").toBe("OFF");
    pressOscOn();
    announceLock(shell, 1);
    announceLock(shell, 0);
    // The edit below is made once the app has taken the unlock.
    await shell.delivered();
    const level = (): HTMLInputElement =>
      paramRow(t().inspector.oscLevel).querySelector<HTMLInputElement>('input[type="range"]')!;
    level().value = "-10";
    level().dispatchEvent(new Event("input", { bubbles: true }));
    level().dispatchEvent(new Event("change", { bubbles: true }));
    await quiet(shell);
    expect(writesTo(shell, PARAMS.OSC_ON.id), "what the lock stopped is not sent").toEqual([]);
    expect(oscFace()).toBe("OFF");
    expect(writesTo(shell, PARAMS.OSC_LEVEL.id)).toEqual([-1000]);
    expect(level().value).toBe("-10");
    expect(errors(shell)).toEqual([]);
  });

  it("keeps an edit made once the lock is off through a read of the whole unit", SLOW, async () => {
    const table = deviceCommands({ "plugin:dialog|message": "Ok" });
    const set = table.vd_set as (a: Record<string, unknown>) => unknown;
    let answer!: () => void;
    const answered = new Promise<void>((r) => (answer = r));
    let onWire!: () => void;
    const wire = new Promise<void>((r) => (onWire = r));
    const shell = (await bootApp({
      tauri: {
        ...table,
        // A head the unit resets values behind, held on the wire until the lock has come and gone:
        // the read-back is then a read of the whole unit.
        vd_set: async (a: Record<string, unknown>) => {
          const result = set(a);
          if (a.paramId === PARAMS.COMP_EQ_TYPE.id) {
            onWire();
            await answered;
          }
          return result;
        },
      },
    }))!;
    await up();
    await quiet(shell);
    pressNode("ch1");
    const type = paramRow(t().inspector.compEqType).querySelector<HTMLSelectElement>("select")!;
    type.value = "1";
    type.dispatchEvent(new Event("change", { bubbles: true }));
    try {
      await wire;
      announceLock(shell, 1);
      await shell.delivered();
      announceLock(shell, 0);
      await shell.delivered();
      oscOn();
      const level = paramRow(t().inspector.oscLevel).querySelector<HTMLInputElement>('input[type="range"]')!;
      level.value = "-20";
      level.dispatchEvent(new Event("input", { bubbles: true }));
      level.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    } finally {
      answer();
    }
    await vi.waitFor(() => expect(statusText()).toBe(t().status.consoleLockedPutBack), { timeout: 25_000 });
    await quiet(shell);
    expect(writesTo(shell, PARAMS.OSC_LEVEL.id)).toEqual([-2000]);
    expect(paramRow(t().inspector.oscLevel).querySelector<HTMLInputElement>('input[type="range"]')!.value).toBe("-20");
    expect(errors(shell)).toEqual([]);
  });

  // A cue pressed just before the lock arrived: it passed the refusal, and the write it queued met
  // the lock on its way out. That is the lock's stop rather than a failed write, so the session
  // goes on and the cues are read back to show what the unit holds. The write waits behind the
  // read-back of an earlier press, held on the wire until the lock has arrived: a notification
  // reaches the app on a later task, and a write queued behind nothing leaves before that.
  it("takes a cue the lock caught on its way out as not sent, and reads the cues back", SLOW, async () => {
    const table = deviceCommands();
    const get = table.vd_get as (a: Record<string, unknown>) => unknown;
    let hold: Promise<void> | null = null;
    let release!: () => void;
    let onWire!: () => void;
    const wire = new Promise<void>((r) => (onWire = r));
    const shell = (await bootApp({
      tauri: {
        ...table,
        vd_get: async (a: Record<string, unknown>) => {
          if (hold && a.paramId === PARAMS.CUE_MONO.id) {
            onWire();
            await hold;
          }
          return get(a);
        },
      },
    }))!;
    await up();
    await quiet(shell);
    selectNode("ch1");
    const cueReads = (): number =>
      shell.invokes.filter((cmd, i) => cmd === "vd_get" && shell.args[i]?.paramId === PARAMS.CUE_MONO.id).length;
    const press = (label: string): void =>
      [...paramRow(t().inspector.cue).querySelectorAll<HTMLButtonElement>("button")]
        .find((b) => b.textContent === label)!
        .click();
    hold = new Promise<void>((r) => (release = r));
    try {
      press(t().inspector.on);
      await wire;
      press(t().inspector.off);
      announceLock(shell, 1);
      await shell.delivered();
    } finally {
      hold = null;
      release();
    }
    const before = cueReads();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.consoleLockedNotSent), { timeout: 10_000 });
    await quiet(shell);
    expect(writesTo(shell, PARAMS.CUE_MONO.id), "the first press is sent, and the second is not").toEqual([1]);
    expect(cueReads(), "the cues are read back").toBeGreaterThan(before);
    expect(live().getAttribute("aria-checked")).toBe("true");
    expect(errors(shell)).toEqual([]);
  });

  it("ends the session when the read-back the lock asked for fails", SLOW, async () => {
    let refuse = false;
    const shell = await bootDevice({
      vd_get: (a: Record<string, unknown>) => {
        if (refuse && a.paramId === PARAMS.OSC_ON.id) throw new Error("read refused");
        return unwrittenRead(a);
      },
    });
    await up();
    await quiet(shell);
    expect(oscOn(), "the premise").toBe("OFF");
    pressOscOn();
    refuse = true;
    announceLock(shell, 1);
    await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 25_000 });
    expect(live().getAttribute("aria-checked")).not.toBe("true");
    expect(writesTo(shell, PARAMS.OSC_ON.id)).toEqual([]);
  });

  // Edits made in one task are checked as one, whichever of them names its keys: one that writes
  // to the unit takes the others back with it.
  it("puts back the edits made in one task under the lock together", SLOW, async () => {
    const shell = await bootDevice({}, true, { [LOCK]: 1 });
    await up();
    await quiet(shell);
    expect(oscOn(), "the premise").toBe("OFF");
    pressOscOn();
    $("btn-auto").click();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.consoleLockedEditPutBack), { timeout: 10_000 });
    expect(oscFace()).toBe("OFF");
    $("btn-auto").click();
    pressOscOn();
    await vi.waitFor(() => expect(oscFace()).toBe("OFF"), { timeout: 10_000 });
    expect(statusText()).toBe(t().status.consoleLockedEditPutBack);
    await quiet(shell);
    expect(writesTo(shell, PARAMS.OSC_ON.id)).toEqual([]);
    expect(errors(shell)).toEqual([]);
  });
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
  // What a write the notifications' loss stopped before it knew how much it was to send says.
  const LOST_BEFORE_COUNT = t().status.writeError(t().error.shell.notificationsLost);
  // Lets the tasks the page has queued run: a fetch the stub has just failed, and the stop it makes.
  const settleTasks = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  // Answers every dialog Ok, except the question `asks` names: the connection's notifications are
  // lost while it is open, and it is answered `answer` once the loss has landed.
  const loseWhileAsking =
    (box: { shell: TauriShell | null }, asks: (message: string) => boolean, answer: "Ok" | "Cancel") =>
    async (a: Record<string, unknown>): Promise<string> => {
      if (a.buttons !== "OkCancel" || !asks(String(a.message ?? ""))) return "Ok";
      box.shell!.loseNotifications();
      await settleTasks();
      return answer;
    };
  const FIRMWARE_ASK = t().confirm.firmwareMismatch("0.0.1", SUPPORTED_SYSTEM_FIRMWARE);
  const oldFirmware = (): Record<string, unknown> => ({
    vd_connect: { ...(deviceCommands({}).vd_connect as Record<string, unknown>), firmware: "0.0.1" },
  });

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
    expect(statusText()).toBe(t().status.writeLocked(3));
    expect(errors(shell)).toEqual([]);
  });

  // A lock the unit announces is no longer heard once the connection's notifications are lost, so
  // the write stops there as it stops on the lock: with what it sent, and no retry offered on the
  // connection that lost them.
  it("stops Write to device at the next command when the connection's notifications are lost", SLOW, async () => {
    const box: { shell: TauriShell | null } = { shell: null };
    let sent = 0;
    const shell = await bootDevice({
      vd_get: clockReads(false, 48_000),
      vd_set: () => {
        sent++;
        if (sent === 3) box.shell!.loseNotifications();
        return null;
      },
    });
    box.shell = shell;
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    expect(shell.count("vd_set"), "nothing after the write on the wire").toBe(3);
    expect(shell.count("vd_set_str")).toBe(0);
    expect(statusText()).toBe(t().status.writeLost(3));
    expect(confirms(shell), "no retry is offered").toHaveLength(1);
    expect(errors(shell)).toEqual([]);
  });

  // Lost while the write is still reading the unit: it stops there, saying why, with nothing sent.
  it("stops Write to device with the cause when the notifications are lost while it reads", SLOW, async () => {
    const box: { shell: TauriShell | null } = { shell: null };
    let reads = 0;
    const read = clockReads(false, 48_000);
    const shell = await bootDevice({
      vd_get: (a: Record<string, unknown>) => {
        reads++;
        if (reads === 20) box.shell!.loseNotifications();
        return read(a);
      },
    });
    box.shell = shell;
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    expect(statusText(), "nothing sent yet").toBe(t().status.writeLost(0));
    expect(shell.count("vd_set")).toBe(0);
    expect(errors(shell)).toEqual([]);
  });

  // A read that fails once the write has stopped does not take the stop's place on the line.
  it.each(["lock", "loss"] as const)(
    "says the stop, not the read failure, when a read fails after Write to device stopped (%s)",
    SLOW,
    async (stop) => {
      const box: { shell: TauriShell | null } = { shell: null };
      let reads = 0;
      const read = clockReads(false, 48_000);
      const shell = await bootDevice({
        vd_get: (a: Record<string, unknown>) => {
          if (++reads !== 20) return read(a);
          if (stop === "lock") announceLock(box.shell!, 1);
          else box.shell!.loseNotifications();
          return new Promise((_, reject) => setTimeout(() => reject(new Error("read-refused")), 100));
        },
      });
      box.shell = shell;
      $("btn-write").click();
      await invoked(shell, "vd_disconnect");
      expect(statusText()).toBe(stop === "lock" ? t().status.writeLocked(0) : t().status.writeLost(0));
      expect(shell.count("vd_set") + shell.count("vd_set_str")).toBe(0);
    },
  );

  // Lost while the write reads the names: it stops there, before it asks to write anything.
  it("asks nothing once the notifications are lost while Write to device reads the names", SLOW, async () => {
    const box: { shell: TauriShell | null } = { shell: null };
    let names = 0;
    const shell = await bootDevice({
      vd_get: clockReads(false, 48_000),
      vd_get_str: () => {
        if (++names === 3) box.shell!.loseNotifications();
        return "";
      },
    });
    box.shell = shell;
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    expect(names, "the premise: the names were being read").toBeGreaterThanOrEqual(3);
    expect(confirms(shell), "no write is offered").toEqual([]);
    expect(statusText()).toBe(t().status.writeLost(0));
    expect(shell.count("vd_set") + shell.count("vd_set_str")).toBe(0);
  });

  // The shell holds a write once the unit has announced Console Lock, before the page has taken
  // it; the refusal is passed on once the page has, so the write stops on the lock, with no retry.
  it("stops Write to device on the lock, with no retry, when the shell holds a write for it", SLOW, async () => {
    const box: { shell: TauriShell | null } = { shell: null };
    let sent = 0;
    const shell = await bootDevice({
      vd_get: clockReads(false, 48_000),
      vd_set: () => {
        sent++;
        if (sent !== 3) return null;
        announceLock(box.shell!, 1);
        throw new Error("writes-held: the unit announced Console Lock");
      },
    });
    box.shell = shell;
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    expect(statusText()).toBe(t().status.writeLocked(2));
    expect(confirms(shell), "no retry is offered").toHaveLength(1);
    expect(sent, "nothing after the held write").toBe(3);
    expect(errors(shell)).toEqual([]);
  });

  // Lost while the names go out: the write stops at the next name, saying how much went out and why.
  // The unit answers every name empty here, so each node's name goes out.
  it.each(["the first", "the second", "the last"] as const)(
    "stops Write to device on a loss at %s name, saying what went out",
    SLOW,
    async (which) => {
      const box: { shell: TauriShell | null; names: number; at: number } = { shell: null, names: 0, at: 0 };
      const shell = await bootDevice({
        "plugin:dialog|message": "Ok",
        vd_set_str: () => {
          if (++box.names === box.at) box.shell!.loseNotifications();
          return null;
        },
      });
      box.shell = shell;
      $("btn-write").click();
      await invoked(shell, "vd_disconnect");
      // The unit keeps no name here, so the next write sends as many as this one did.
      const names = box.names;
      expect(names, "the premise: more than two names go out").toBeGreaterThan(2);
      const at = which === "the first" ? 1 : which === "the second" ? 2 : names;
      for (const [node, name] of [
        ["ch2", "Kick"],
        ["ch3", "Snare"],
      ]) {
        selectNode(node);
        const field = paramRow(t().inspector.name).querySelector<HTMLInputElement>('input[type="text"]')!;
        field.value = name;
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }
      box.names = 0;
      box.at = at;
      const setsBefore = shell.count("vd_set");
      $("btn-write").click();
      await invoked(shell, "vd_disconnect", 2);
      expect(shell.count("vd_set"), "the premise: only the names differ").toBe(setsBefore);
      expect(box.names, "nothing after the loss").toBe(at);
      expect(statusText()).toBe(t().status.writeLost(at));
      expect(errors(shell)).toEqual([]);
    },
  );

  // A question a write asks once its stop has come is not asked, and one the stop came under is not
  // acted on: the write ends with the cause rather than with Canceled, a retry or a plan change.
  it("asks nothing when the notifications are lost while Write to device registers its watch", SLOW, async () => {
    const box: { shell: TauriShell | null } = { shell: null };
    const table = deviceCommands({ ...oldFirmware(), "plugin:dialog|message": "Ok" });
    const subscribe = table.vd_params_subscribe as (a: Record<string, unknown>) => unknown;
    const shell = (await bootApp({
      tauri: {
        ...table,
        vd_params_subscribe: (a: Record<string, unknown>) => {
          box.shell!.loseNotifications();
          return subscribe(a);
        },
      },
    }))!;
    box.shell = shell;
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    expect(confirms(shell), "not even the firmware question").toEqual([]);
    expect(statusText()).toBe(LOST_BEFORE_COUNT);
    expect(shell.count("vd_set") + shell.count("vd_set_str")).toBe(0);
    expect(errors(shell)).toEqual([]);
  });

  it.each(["firmware", "reclock", "write"] as const)(
    "says the stop, not Canceled, when the notifications are lost while Write to device asks the %s question",
    SLOW,
    async (question) => {
      const box: { shell: TauriShell | null } = { shell: null };
      let asks: (message: string) => boolean = (m) => m === FIRMWARE_ASK;
      const shell = await bootDevice({
        ...(question === "firmware" ? oldFirmware() : {}),
        vd_get: clockReads(false, question === "reclock" ? 96_000 : 48_000),
        "plugin:dialog|message": (a: Record<string, unknown>) => loseWhileAsking(box, (m) => asks(m), "Cancel")(a),
      });
      box.shell = shell;
      const planRate = formatRate(Number($<HTMLSelectElement>("rate-picker").value));
      if (question === "reclock") asks = (m) => m.startsWith(t().confirm.reclock(formatRate(96_000), planRate));
      if (question === "write") asks = (m) => m.includes(WRITE_ASK);
      $("btn-write").click();
      await invoked(shell, "vd_disconnect");
      expect(confirms(shell).filter(asks), "the premise: it was asked").toHaveLength(1);
      expect(confirms(shell), "nothing asked after it").toHaveLength(1);
      if (question === "write") {
        expect(statusText()).toBe(t().status.writeLost(0));
      } else expect(statusText()).toBe(LOST_BEFORE_COUNT);
      expect(shell.count("vd_set") + shell.count("vd_set_str")).toBe(0);
      expect(errors(shell)).toEqual([]);
    },
  );

  it("leaves the plan's rate when the notifications are lost while Write to device asks which rate", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(true, 96_000) });
    const rate = $<HTMLSelectElement>("rate-picker").value;
    expect(rate, "the premise: the plan and the unit disagree").not.toBe("96000");
    $("btn-write").click();
    await vi.waitFor(() => expect($("rate-choice").hidden).toBe(false), { timeout: 15_000 });
    shell.loseNotifications();
    await settleTasks();
    $("rate-choice-adopt").click();
    await invoked(shell, "vd_disconnect");
    expect($<HTMLSelectElement>("rate-picker").value, "the plan keeps its rate").toBe(rate);
    expect(statusText()).toBe(LOST_BEFORE_COUNT);
    expect(shell.count("vd_set") + shell.count("vd_set_str")).toBe(0);
    expect(errors(shell)).toEqual([]);
  });

  it("offers no retry once the notifications are lost while Write to device asks to run it again", SLOW, async () => {
    const box: { shell: TauriShell | null } = { shell: null };
    let sent = 0;
    const shell = await bootDevice({
      // The report of the stopped attempt is offered once the write ends, and saved.
      ...SAVES,
      vd_get: clockReads(false, 48_000),
      vd_set: () => {
        if (++sent === 3) throw new Error("broker-rejected: refused");
        return null;
      },
      "plugin:dialog|message": loseWhileAsking(box, (m) => m.includes(RETRY_ASK), "Cancel"),
    });
    box.shell = shell;
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    expect(
      confirms(shell).filter((m) => m.includes(RETRY_ASK)),
      "the premise: it was asked",
    ).toHaveLength(1);
    expect(sent, "nothing after the question").toBe(3);
    expect(statusText()).toBe(t().status.writeLost(2));
    expect(errors(shell)).toEqual([]);
  });

  // Numeric values, Sweet Spot presets and names alike: the line counts every write the unit took.
  it("counts the presets with the rest when the notifications are lost at the first name", SLOW, async () => {
    const { emptyPlan, serialize } = await import("./core/plan");
    const plan = emptyPlan("URX44V");
    for (const [id, preset] of [
      ["ch1", 5],
      ["ch2", 24],
      ["ch3", 7],
    ] as const)
      plan.nodeParams[id] = { compEqType: 1, ssmcs: { sweetSpotData: preset, compDrive: 120 } };
    plan.nodeNames["ch5"] = "Vox";
    plan.nodeNames["ch6"] = "Gtr";
    const box: { shell: TauriShell | null; renamed: boolean } = { shell: null, renamed: false };
    const shell = (await bootApp({
      url: `/?plan=${encodeURIComponent(Buffer.from(serialize(plan), "utf8").toString("base64url"))}`,
      tauri: deviceCommands({
        "plugin:dialog|message": "Ok",
        vd_set_str: (a: Record<string, unknown>) => {
          if (a.paramId !== PARAMS.SWEET_SPOT_DATA.id && !box.renamed) {
            box.renamed = true;
            box.shell!.loseNotifications();
          }
          return null;
        },
      }),
    }))!;
    box.shell = shell;
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    const presets = shell.invokes.filter(
      (cmd, i) => cmd === "vd_set_str" && shell.args[i]?.paramId === PARAMS.SWEET_SPOT_DATA.id,
    ).length;
    expect(presets, "the premise: the presets went out").toBe(3);
    expect(box.renamed, "the premise: a name went out").toBe(true);
    const took = shell.count("vd_set") + shell.count("vd_set_str");
    expect(statusText()).toBe(t().status.writeLost(took));
    expect(errors(shell)).toEqual([]);
  });

  it(
    "says the stop, not Canceled, when the notifications are lost while the Follow USB switch asks",
    SLOW,
    async () => {
      const box: { shell: TauriShell | null } = { shell: null };
      // Off on the unit: turning it on is what asks.
      const shell = await bootDevice({
        vd_get: clockReads(false, 48_000),
        "plugin:dialog|message": loseWhileAsking(box, () => true, "Cancel"),
      });
      box.shell = shell;
      // The badge is unknown until something reads it; the first press reads.
      $("follow-usb").click();
      await invoked(shell, "vd_disconnect");
      $("follow-usb").click();
      await invoked(shell, "vd_disconnect", 2);
      expect(confirms(shell), "the premise: it asked").toHaveLength(1);
      expect(statusText()).toBe(LOST_BEFORE_COUNT);
      expect(writesTo(shell, PARAMS.FOLLOW_USB.id)).toEqual([]);
      expect(errors(shell)).toEqual([]);
    },
  );

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

// A self-test (an --experimental launch) the lock stops once it has written keeps what its restore
// needs, and Restore after self-test in the Device menu puts the unit back.
describe("Console Lock and the self-test", () => {
  it("keeps a run the lock stopped for Restore after self-test until a restore puts the unit back", SLOW, async () => {
    const table = deviceCommands({
      "plugin:dialog|message": "Ok",
      "plugin:dialog|save": null,
      experimental_enabled: true,
    });
    const set = table.vd_set as (a: Record<string, unknown>) => unknown;
    const connect = table.vd_connect as (a: Record<string, unknown>) => unknown;
    const box = { shell: null as TauriShell | null, sent: 0, lockAt: 5, refuse: false, unreachable: false };
    const shell = (await bootApp({
      tauri: {
        ...table,
        vd_set: (a: Record<string, unknown>) => {
          if (box.refuse) throw new Error("broker-rejected: refused");
          const result = set(a);
          if (++box.sent === box.lockAt) announceLock(box.shell!, 1);
          return result;
        },
        vd_connect: (a: Record<string, unknown>) => {
          if (box.unreachable) throw new Error("no device");
          return connect(a);
        },
      },
    }))!;
    box.shell = shell;
    const run = $<HTMLButtonElement>("btn-selftest");
    const restore = $<HTMLButtonElement>("btn-selftest-restore");
    await vi.waitFor(() => expect(run.hidden).toBe(false), { timeout: 10_000 });
    expect(restore.hidden, "the premise: nothing to restore yet").toBe(true);

    run.click();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.selfTestLocked), { timeout: 25_000 });
    await vi.waitFor(() => expect(restore.hidden).toBe(false), { timeout: 10_000 });
    // A new run would capture the state the stopped one left as the one to restore.
    const sets = shell.count("vd_set");
    run.click();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.selfTestRestorePending), { timeout: 10_000 });
    expect(shell.count("vd_set")).toBe(sets);

    // A restore that cannot connect, and one whose writes are refused, keep it.
    box.lockAt = -1;
    box.unreachable = true;
    restore.click();
    await vi.waitFor(() => expect(errors(shell).length).toBe(1), { timeout: 25_000 });
    expect(restore.hidden).toBe(false);
    box.unreachable = false;
    box.refuse = true;
    restore.click();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.selfTestRestoreFail), { timeout: 25_000 });
    expect(confirms(shell)).toContain(t().confirm.selfTestFailExport);
    await vi.waitFor(() => expect(restore.hidden).toBe(false), { timeout: 10_000 });

    box.refuse = false;
    restore.click();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.selfTestRestored), { timeout: 25_000 });
    await vi.waitFor(() => expect(restore.hidden).toBe(true), { timeout: 10_000 });
  });
});
