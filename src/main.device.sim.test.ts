// @vitest-environment jsdom

// The SIM view and the unit state it shows: the LCD selection and HOME's [Sends] destination.
//
// The setup, the teardown and the helpers every desktop case shares are `main.device.test-util.ts`'s,
// which also states what the device table does and does not model.

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { $, bootApp, deviceCommands, statusText, unwrittenRead } from "./main.test-util";
import type { TauriShell } from "./main.test-util";
import { PARAMS } from "./core/control/params";
import { consoleLockAbort } from "./core/control/console-lock";
import { EDIT_MENU_EVENT, EDIT_REDO_ID, EDIT_UNDO_ID } from "./core/platform";
import { t } from "./i18n";
import { spoken } from "./ui/glyph";
import {
  simRefused,
  simMounted,
  SLOW,
  drainShell,
  bootDevice,
  invoked,
  live,
  notifyChannel,
  confirms,
  TRACK_COUNT_SEED,
  FOLLOW_USB_SEED,
  errors,
  connectAs,
} from "./main.device.test-util";

// The side a stereo channel shows is linked to the unit's LCD selection while live: the
// unit's selection of a stereo channel shows that channel's side, a switch made in the app
// moves the unit's selection, and the unit's answer to that write is not taken as a selection
// of its own.

describe("the displayed side and the unit's LCD selection", () => {
  const LCD = `${PARAMS.LCD_SELECTION.id}/0/0`;
  const strip = (name: string): HTMLElement | undefined =>
    [...$("console-host").querySelectorAll<HTMLElement>(".con-strip")].find(
      (s) => s.getAttribute("aria-label") === spoken(name),
    );
  const nameArea = (): HTMLElement => strip("CH 5/6")!.querySelector<HTMLElement>(".con-side")!;
  const showing = (): string => nameArea().getAttribute("aria-label") ?? "";
  const lcdWrites = (shell: TauriShell): number[] =>
    shell.invokes.flatMap((cmd, i) => {
      const a = shell.args[i];
      return cmd === "vd_set" && a?.paramId === PARAMS.LCD_SELECTION.id ? [a.value as number] : [];
    });
  const goLive = async (): Promise<void> => {
    $("btn-view-console").click();
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
  };
  const end = async (shell: TauriShell): Promise<void> => {
    $("btn-live").click();
    await invoked(shell, "vd_disconnect");
  };

  it("takes the selected channel's side at live start, and the unit's selections after it", SLOW, async () => {
    const shell = await bootDevice({}, true, { [LCD]: 0x0101 });
    await goLive();
    const { addrs } = shell.args[shell.invokes.indexOf("vd_params_subscribe")] as { addrs: number[][] };
    expect(addrs, "the session registers the LCD selection").toContainEqual([PARAMS.LCD_SELECTION.id, 0, 0]);
    expect(showing()).toBe("C H 5 slash 6, showing C H 6 (R)");
    notifyChannel(shell).onmessage([{ param_id: PARAMS.LCD_SELECTION.id, x: 0, y: 0, value: 0x0100 }]);
    await vi.waitFor(() => expect(showing()).toBe("C H 5 slash 6, showing C H 5 (L)"));
    // A selection of anything but a stereo channel names no side.
    notifyChannel(shell).onmessage([{ param_id: PARAMS.LCD_SELECTION.id, x: 0, y: 0, value: 0x0000 }]);
    notifyChannel(shell).onmessage([{ param_id: PARAMS.LCD_SELECTION.id, x: 0, y: 0, value: 0x0300 }]);
    expect(showing()).toBe("C H 5 slash 6, showing C H 5 (L)");
    expect(lcdWrites(shell), "a side the unit chose is not written back").toEqual([]);
    await end(shell);
  });

  // Two switches in a row, then the unit's late answer to the FIRST: it is the app's own
  // write, so the side stays where the second switch left it.
  it("writes a switch made in the app while live, and takes the unit's answer as no selection", SLOW, async () => {
    const shell = await bootDevice({}, true, { [LCD]: 0x0000 });
    await goLive();
    // The answer window runs on `Date.now()`, held still from the first switch to the last
    // answer, so every answer below lands inside it however long the steps between take.
    // Timers stay real: the shell's answers run on them.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      nameArea().click();
      expect(showing()).toBe("C H 5 slash 6, showing C H 6 (R)");
      nameArea().click();
      expect(showing()).toBe("C H 5 slash 6, showing C H 5 (L)");
      // Two switches, so two writes at most. Polled on a real timer rather than `vi.waitFor`,
      // which moves a faked clock forward by its interval on every poll.
      for (let i = 0; i < 1000 && lcdWrites(shell).length < 2; i++) await new Promise((r) => setTimeout(r, 10));
      expect(lcdWrites(shell)).toEqual([0x0101, 0x0100]);
      notifyChannel(shell).onmessage([{ param_id: PARAMS.LCD_SELECTION.id, x: 0, y: 0, value: 0x0101 }]);
      expect(showing(), "the late answer to the first write").toBe("C H 5 slash 6, showing C H 5 (L)");
      notifyChannel(shell).onmessage([{ param_id: PARAMS.LCD_SELECTION.id, x: 0, y: 0, value: 0x0100 }]);
      expect(showing()).toBe("C H 5 slash 6, showing C H 5 (L)");
      // The positive control: a selection made on the unit itself still shows.
      notifyChannel(shell).onmessage([{ param_id: PARAMS.LCD_SELECTION.id, x: 0, y: 0, value: 0x0101 }]);
      expect(showing()).toBe("C H 5 slash 6, showing C H 6 (R)");
    } finally {
      vi.useRealTimers();
    }
    await end(shell);
  });

  // Switches made while a write is on the wire go out as one write of the latest side, and
  // not at all when the latest is the side that write sent.
  it("writes the latest of the switches made while a write is on the wire", SLOW, async () => {
    const shell = await bootDevice({}, true, { [LCD]: 0x0000 });
    await goLive();
    nameArea().click();
    nameArea().click();
    nameArea().click();
    expect(showing()).toBe("C H 5 slash 6, showing C H 6 (R)");
    // Past the write's return, where a queued one would go out.
    await drainShell(shell, () => false);
    expect(lcdWrites(shell)).toEqual([0x0101]);
    nameArea().click();
    nameArea().click();
    nameArea().click();
    expect(showing()).toBe("C H 5 slash 6, showing C H 5 (L)");
    await drainShell(shell, () => false);
    expect(lcdWrites(shell)).toEqual([0x0101, 0x0100]);
    // The unit moving its own selection while a write is on the wire: the latest switch goes
    // out even when it is the value that write sent, since the unit no longer holds it.
    nameArea().click();
    notifyChannel(shell).onmessage([{ param_id: PARAMS.LCD_SELECTION.id, x: 0, y: 0, value: 0x0102 }]);
    nameArea().click();
    nameArea().click();
    expect(showing()).toBe("C H 5 slash 6, showing C H 6 (R)");
    await drainShell(shell, () => false);
    expect(lcdWrites(shell)).toEqual([0x0101, 0x0100, 0x0101, 0x0101]);
    await end(shell);
  });

  // A session that ends with an LCD write on the wire waits for its answer before it
  // disconnects, and that answer acts on nothing in a session started after it.
  it("waits for an LCD write on the wire before it disconnects", SLOW, async () => {
    const shell = await bootDevice({}, true, { [LCD]: 0x0000 });
    await goLive();
    let finish!: () => void;
    let settled = false;
    shell.answer("vd_set", (a: Record<string, unknown>) => {
      if (a.paramId !== PARAMS.LCD_SELECTION.id) return;
      return new Promise<void>((resolve) => {
        finish = () => {
          settled = true;
          resolve();
        };
      });
    });
    nameArea().click();
    expect(lcdWrites(shell)).toEqual([0x0101]);
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("false"));
    await drainShell(shell, () => false);
    expect(shell.count("vd_disconnect"), "no disconnect ahead of the write's answer").toBe(0);
    finish();
    await invoked(shell, "vd_disconnect");
    expect(settled).toBe(true);
  });

  it("lets a refused LCD write of an ended session leave the next session up", SLOW, async () => {
    const shell = await bootDevice({}, true, { [LCD]: 0x0000 });
    await goLive();
    let refuse!: (error: Error) => void;
    let held = true;
    shell.answer("vd_set", (a: Record<string, unknown>) => {
      if (a.paramId !== PARAMS.LCD_SELECTION.id || !held) return;
      held = false;
      return new Promise<void>((_resolve, reject) => (refuse = reject));
    });
    nameArea().click();
    expect(lcdWrites(shell)).toEqual([0x0101]);
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("false"));
    await drainShell(shell, () => false);
    // Whichever comes first, the disconnect or the answer, the refusal lands in the order the
    // app allows: a session started over a link released ahead of the answer is the one it
    // could end.
    const reconnect = async (): Promise<void> => {
      await vi.waitFor(() => expect(($("rate-picker") as HTMLSelectElement).disabled).toBe(false));
      await goLive();
    };
    if (shell.count("vd_disconnect") > 0) {
      await reconnect();
      refuse(new Error("old-session-refused"));
    } else {
      refuse(new Error("old-session-refused"));
      await invoked(shell, "vd_disconnect");
      await reconnect();
    }
    await drainShell(shell, () => false);
    expect(live().getAttribute("aria-checked"), "the next session is still up").toBe("true");
    expect(errors(shell).some((m) => m.includes("old-session-refused"))).toBe(false);
    // The positive control: a switch in the new session is written.
    nameArea().click();
    await vi.waitFor(() => expect(lcdWrites(shell).at(-1)).toBe(0x0100));
    await end(shell);
  });

  // A selection made on the unit while a write is on the wire takes the place of the switches
  // waiting behind that write; a switch made after it is written as usual, and the unit's
  // answer to the app's own write cancels nothing.
  it("drops the queued switches when the unit selects something itself", SLOW, async () => {
    const shell = await bootDevice({}, true, { [LCD]: 0x0000 });
    await goLive();
    let finish!: () => void;
    let held = true;
    shell.answer("vd_set", (a: Record<string, unknown>) => {
      if (a.paramId !== PARAMS.LCD_SELECTION.id || !held) return;
      held = false;
      return new Promise<void>((resolve) => (finish = resolve));
    });
    nameArea().click();
    nameArea().click();
    expect(showing()).toBe("C H 5 slash 6, showing C H 5 (L)");
    notifyChannel(shell).onmessage([{ param_id: PARAMS.LCD_SELECTION.id, x: 0, y: 0, value: 0x0103 }]);
    expect(strip("CH 7/8")!.querySelector(".con-side")!.getAttribute("aria-label")).toBe(
      "C H 7 slash 8, showing C H 8 (R)",
    );
    finish();
    await drainShell(shell, () => false);
    expect(lcdWrites(shell), "the queued switch is not sent").toEqual([0x0101]);
    // The app's own answer keeps the queue: a switch queued behind a write whose answer arrives
    // first is still sent.
    // `Date.now()`, which the answer window runs on, is held still from the write to its
    // answer, so the answer lands inside the window however long the two switches take.
    held = true;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      nameArea().click();
      nameArea().click();
      notifyChannel(shell).onmessage([{ param_id: PARAMS.LCD_SELECTION.id, x: 0, y: 0, value: 0x0101 }]);
    } finally {
      vi.useRealTimers();
    }
    finish();
    await drainShell(shell, () => false);
    expect(lcdWrites(shell)).toEqual([0x0101, 0x0101, 0x0100]);
    await end(shell);
  });

  it("writes no switch made off-line", async () => {
    const shell = await bootDevice({}, true, { [LCD]: 0x0101 });
    $("btn-view-console").click();
    nameArea().click();
    expect(showing()).toBe("C H 5 slash 6, showing C H 6 (R)");
    expect(lcdWrites(shell)).toEqual([]);
    expect(shell.count("vd_connect")).toBe(0);
  });

  it("ends the session on a refused write, and keeps the side", SLOW, async () => {
    const shell = await bootDevice(
      {
        vd_set: (a: Record<string, unknown>) => {
          if (a.paramId === PARAMS.LCD_SELECTION.id) throw new Error("write-refused");
        },
      },
      true,
      { [LCD]: 0x0000 },
    );
    await goLive();
    nameArea().click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("false"), { timeout: 25_000 });
    expect(errors(shell).some((m) => m.includes("write-refused"))).toBe(true);
    expect(showing()).toBe("C H 5 slash 6, showing C H 6 (R)");
  });
});

// The SIM view mounts urx-lcd-sim's LCD, which asks the page for a media query and a resize
// observer; jsdom carries neither, so each case here stands one in that answers nothing.

describe("the SIM view over a live session", () => {
  const restore: Array<() => void> = [];
  beforeEach(() => {
    const g = globalThis as Record<string, unknown>;
    const media = window.matchMedia;
    const resize = g.ResizeObserver;
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    g.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    restore.push(() => {
      window.matchMedia = media;
      g.ResizeObserver = resize;
    });
  });
  afterEach(() => {
    for (const r of restore.splice(0)) r();
  });
  const glass = (): ShadowRoot | null | undefined => document.querySelector("#sim-host .urx-lcd-sim")?.shadowRoot;
  const openSim = async (): Promise<void> => {
    $("btn-view-sim").click();
    await vi.waitFor(() => expect(glass()?.querySelector(".lcd")).toBeTruthy(), { timeout: 20_000 });
  };
  const goLive = async (): Promise<void> => {
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
  };
  const meterCalls = (shell: TauriShell): string[] => shell.invokes.filter((c) => c.startsWith("vd_meters"));

  it("takes the session's one meter subscription while it is shown, and the CONSOLE takes it back", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true });
    await openSim();
    await goLive();
    await vi.waitFor(() => expect(meterCalls(shell)).toEqual(["vd_meters_subscribe"]));
    $("btn-view-console").click();
    await vi.waitFor(() =>
      expect(meterCalls(shell)).toEqual(["vd_meters_subscribe", "vd_meters_unsubscribe", "vd_meters_subscribe"]),
    );
    $("btn-live").click();
    await invoked(shell, "vd_disconnect");
  });

  it("ends the session when its meter subscription is refused", SLOW, async () => {
    const shell = await bootDevice({
      experimental_enabled: true,
      vd_meters_subscribe: () => {
        throw new Error("meters refused");
      },
    });
    await openSim();
    $("btn-live").click();
    await invoked(shell, "vd_disconnect");
    expect(errors(shell).join(" "), "the refused subscription is what ended it").toContain("meters refused");
    expect(live().getAttribute("aria-checked")).toBe("false");
  });

  it("draws the glass again for the model a switch lands on", SLOW, async () => {
    await bootDevice({ experimental_enabled: true });
    await openSim();
    const before = glass()?.querySelector(".lcd");
    expect(before?.getAttribute("aria-label")).toBe("URX44V LCD");
    const picker = $<HTMLSelectElement>("model-picker");
    picker.value = "URX22";
    picker.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(glass()?.querySelector(".lcd")?.getAttribute("aria-label")).toBe("URX22 LCD"), {
      timeout: 20_000,
    });
    expect(before?.isConnected, "the glass the first model drew is gone").toBe(false);
  });

  // The values a case writes to the unit, in order.
  const setsOf = (shell: TauriShell, paramId: number): [number, number][] =>
    shell.invokes.flatMap((cmd, i) => {
      const a = shell.args[i] as Record<string, number>;
      return cmd === "vd_set" && a.paramId === paramId ? [[a.y, a.value] as [number, number]] : [];
    });
  const transport = () => {
    const params = simMounted.unit?.params;
    if (!params) throw new Error("the glass is not mounted");
    return params;
  };

  it("writes a delay time turned by hand under tempo Sync to the unit, which keeps Sync on", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true }, true, {
      [`${PARAMS.FX_EFFECT_TYPE.id}/0/0`]: 1024,
      [`681/0/4`]: 1,
      [`681/0/6`]: 5000,
    });
    await openSim();
    await goLive();
    expect((await transport().snapshot()).get("ch.fx1.effect.delay"), "the premise: the unit's delay time").toBe(500);
    await transport().write("ch.fx1.effect.delay", 250);
    await vi.waitFor(() => expect(setsOf(shell, 681)).toEqual([[6, 2500]]), { timeout: 10_000 });
    expect(
      setsOf(shell, 681).some(([y]) => y === 4),
      "Sync is left as it is",
    ).toBe(false);
  });

  // Undo and redo move the hand-turned delay time back and forth on the unit too, while an undo of
  // another row of the channel leaves the delay the unit derived alone.
  it.each([
    ["fx1", 679, 681],
    ["fx2", 683, 685],
  ])(
    "writes a %s delay time turned under tempo Sync back to the unit on undo and redo",
    SLOW,
    async (fx, typeParam, param) => {
      const shell = await bootDevice({ experimental_enabled: true }, true, {
        [`${typeParam}/0/0`]: 1024,
        [`${param}/0/4`]: 1,
        [`${param}/0/6`]: 5000,
      });
      await openSim();
      await goLive();
      await transport().write(`ch.${fx}.effect.delay`, 250);
      await vi.waitFor(() => expect(setsOf(shell, param)).toEqual([[6, 2500]]), { timeout: 10_000 });
      expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
      await vi.waitFor(
        () =>
          expect(setsOf(shell, param)).toEqual([
            [6, 2500],
            [6, 5000],
          ]),
        { timeout: 10_000 },
      );
      expect(shell.emit(EDIT_MENU_EVENT, EDIT_REDO_ID)).toBe(1);
      await vi.waitFor(
        () =>
          expect(setsOf(shell, param)).toEqual([
            [6, 2500],
            [6, 5000],
            [6, 2500],
          ]),
        {
          timeout: 10_000,
        },
      );
      // Another row of the same channel, made and undone: the delay is not written again.
      await transport().write(`ch.${fx}.effect.feedback`, 30);
      await vi.waitFor(() => expect(setsOf(shell, param).length).toBeGreaterThan(3), { timeout: 10_000 });
      const before = setsOf(shell, param).length;
      expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
      await vi.waitFor(() => expect(setsOf(shell, param).length).toBeGreaterThan(before), { timeout: 10_000 });
      expect(
        setsOf(shell, param).filter(([y]) => y === 6),
        "the delay is written only by its own edits",
      ).toEqual([
        [6, 2500],
        [6, 5000],
        [6, 2500],
      ]);
      expect(
        setsOf(shell, param).some(([y]) => y === 4),
        "Sync is left as it is",
      ).toBe(false);
    },
  );

  it("writes a SETUP setting changed on the glass to the unit while Live sync is up", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true }, true, { [`${PARAMS.BRIGHTNESS.id}/0/0`]: 6 });
    await openSim();
    await goLive();
    expect((await transport().snapshot()).get("setup.brightness"), "the session shows the unit's").toBe(6);
    expect(transport().writable?.("setup.peripheral.usbSuppression")).toBe(true);
    await expect(transport().write("setup.peripheral.usbSuppression", "2 Channels")).resolves.toBe("2 Channels");
    await vi.waitFor(() => expect(setsOf(shell, PARAMS.USB_SUPPRESSION.id)).toEqual([[0, 1]]), { timeout: 10_000 });
    await expect(transport().write("setup.language", "Klingon")).rejects.toThrow("refused");
  });

  // The unit's SETUP > GENERAL settings are written over the Live sync session alone: with no session
  // an edit on the glass is refused and no connection is opened for it.
  it("refuses a SETUP setting changed on the glass with no session, and opens no connection", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true });
    await openSim();
    await expect(transport().write("setup.brightness", 3)).rejects.toThrow("refused");
    await expect(transport().write("setup.udk.1.A", "Monitor 2 Level")).rejects.toThrow("refused");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setsOf(shell, PARAMS.BRIGHTNESS.id)).toEqual([]);
    expect(shell.count("vd_connect"), "no connection of its own").toBe(0);
  });

  // Two knobs assigned on the glass during Live sync go out each on its own knob.
  it("writes every knob assigned on the glass during Live sync", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true }, true);
    await openSim();
    await goLive();
    await transport().write("setup.udk.1.A", "Monitor 2 Level");
    await transport().write("setup.udk.1.B", "Monitor 2 Level");
    const knobs = await transport().snapshot();
    expect([knobs.get("setup.udk.1.A"), knobs.get("setup.udk.1.B")]).toEqual(["Monitor 2 Level", "Monitor 2 Level"]);
    const fnWrites = (): unknown[] =>
      shell.invokes.flatMap((cmd, i) =>
        cmd === "vd_set_str" && shell.args[i]!.paramId === PARAMS.UDK_FUNCTION.id ? [shell.args[i]!.y] : [],
      );
    await vi.waitFor(() => expect(fnWrites(), "knob A and knob B").toEqual([0, 1]), { timeout: 10_000 });
  });

  // The pointers are read before the session registers for the unit's announcements, so a move on
  // the unit in between announces itself to nobody: the session reads them again once it is up.
  it.each([
    [PARAMS.CURRENT_SCENE.id, "scene.current"],
    [PARAMS.SCENE_CURSOR.id, "scene.selected"],
  ])("takes a scene pointer (%i) the unit moved before the session registered for it", SLOW, async (id, path) => {
    const cmds = deviceCommands(
      { "plugin:dialog|message": "Ok", experimental_enabled: true },
      { [`${PARAMS.CURRENT_SCENE.id}/0/0`]: 8, [`${PARAMS.SCENE_CURSOR.id}/0/0`]: 8 },
    );
    const set = cmds.vd_set as (a: Record<string, unknown>) => unknown;
    const subscribe = cmds.vd_params_subscribe as (a: Record<string, unknown>) => unknown;
    let moved = false;
    cmds.vd_params_subscribe = (a: Record<string, unknown>) => {
      if (!moved) {
        moved = true;
        set({ paramId: id, x: 0, y: 0, value: 9 });
      }
      return subscribe(a);
    };
    const shell = (await bootApp({ tauri: cmds }))!;
    await openSim();
    await goLive();
    expect(moved).toBe(true);
    await vi.waitFor(async () =>
      expect((await transport().snapshot()).get(path), "the move the session missed").toBe(10),
    );
    notifyChannel(shell).onmessage([{ param_id: id, x: 0, y: 0, value: 10 }]);
    await vi.waitFor(async () => expect((await transport().snapshot()).get(path), "an announced move").toBe(11));
  });

  // A pointer the unit announces while the session's own read of it runs is newer than that read.
  // Every read of the pointer after the session's first is held (the dev build's parameter watch
  // reads both too), and released only after the announcement.
  it.each([
    [PARAMS.CURRENT_SCENE.id, PARAMS.SCENE_CURSOR.id, "scene.current"],
    [PARAMS.SCENE_CURSOR.id, PARAMS.CURRENT_SCENE.id, "scene.selected"],
  ])("keeps a scene pointer (%i) the unit announced while the session read it again", SLOW, async (id, other, path) => {
    const shell = await bootDevice({ experimental_enabled: true });
    let reads = 0;
    const held: ((v: number) => void)[] = [];
    shell.answer("vd_get", (a: Record<string, unknown>) => {
      if (a.paramId === other) return 8;
      if (a.paramId !== id) return unwrittenRead(a);
      return ++reads === 1 ? 8 : new Promise<number>((done) => held.push(done));
    });
    await openSim();
    await goLive();
    await vi.waitFor(() => expect(held.length, "a read again is under way").toBeGreaterThan(0));
    notifyChannel(shell).onmessage([{ param_id: id, x: 0, y: 0, value: 9 }]);
    await vi.waitFor(async () => expect((await transport().snapshot()).get(path)).toBe(10));
    for (const done of held.splice(0)) done(8);
    await new Promise((done) => setTimeout(done, 50));
    expect((await transport().snapshot()).get(path), "the announcement, not the older read").toBe(10);
  });

  // A session that ends while its read again is on the wire waits for that read before it
  // disconnects, and what the read answers is then no session's to show; the next session reads
  // its own.
  it("leaves the scene pointers a session read again after it ended to no session", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true });
    let session = 1;
    let reads = 0;
    const held: ((v: number) => void)[] = [];
    shell.answer("vd_get", (a: Record<string, unknown>) => {
      if (a.paramId === PARAMS.SCENE_CURSOR.id) return session === 1 ? 8 : 20;
      if (a.paramId !== PARAMS.CURRENT_SCENE.id) return unwrittenRead(a);
      if (session === 2) return 20;
      return ++reads === 1 ? 8 : new Promise<number>((done) => held.push(done));
    });
    await openSim();
    const offline = (await transport().snapshot()).get("scene.current");
    await goLive();
    await vi.waitFor(() => expect(held.length, "the first session's read again is under way").toBeGreaterThan(0));
    $("btn-live").click();
    for (const done of held.splice(0)) done(30);
    await invoked(shell, "vd_disconnect");
    await new Promise((done) => setTimeout(done, 50));
    expect((await transport().snapshot()).get("scene.current"), "not the ended session's read").toBe(offline);
    session = 2;
    await goLive();
    await vi.waitFor(async () =>
      expect((await transport().snapshot()).get("scene.current"), "the second session's read").toBe(21),
    );
  });

  // A user scene is on both tabs, so the unit's cursor moving onto one leaves the tab the glass shows;
  // 00 and a preset are each on one tab alone, which the glass opens.
  it.each([
    [0x8001, "Simple"],
    [0x8000, "Standard"],
  ])(
    "keeps the tab its cursor stood on (%i) when the unit's cursor moves onto a user scene",
    SLOW,
    async (from, tab) => {
      const shell = await bootDevice({ experimental_enabled: true }, true, {
        [`${PARAMS.CURRENT_SCENE.id}/0/0`]: 8,
        [`${PARAMS.SCENE_CURSOR.id}/0/0`]: from,
      });
      await openSim();
      await goLive();
      await vi.waitFor(async () => expect((await transport().snapshot()).get("scene.bank")).toBe(tab));
      notifyChannel(shell).onmessage([{ param_id: PARAMS.SCENE_CURSOR.id, x: 0, y: 0, value: 9 }]);
      await vi.waitFor(async () => expect((await transport().snapshot()).get("scene.selected")).toBe(10));
      expect((await transport().snapshot()).get("scene.bank"), "10 is on that tab too").toBe(tab);
    },
  );

  // The unit's scene pointers are read at the session's start and followed as the unit announces
  // them. The unit's cursor moving takes the glass's off a row it picked, and a session that ends
  // leaves both to the glass.
  it(
    "shows the unit's current scene and SCENE LIST's cursor, the unit's cursor taking the glass's off its row",
    SLOW,
    async () => {
      const shell = await bootDevice({ experimental_enabled: true }, true, {
        [`${PARAMS.CURRENT_SCENE.id}/0/0`]: 8,
        [`${PARAMS.SCENE_CURSOR.id}/0/0`]: 9,
      });
      await openSim();
      await goLive();
      const shown = async (path: string): Promise<unknown> => (await transport().snapshot()).get(path);
      await vi.waitFor(async () =>
        expect([await shown("scene.current"), await shown("scene.selected")], "09 current, the cursor on 10").toEqual([
          9, 10,
        ]),
      );
      const registered = (
        shell.args[shell.invokes.indexOf("vd_params_subscribe")] as { addrs: [number, number, number][] }
      ).addrs;
      for (const id of [PARAMS.CURRENT_SCENE.id, PARAMS.SCENE_CURSOR.id])
        expect(
          registered.some(([at, x, y]) => at === id && x === 0 && y === 0),
          `${id} is announced to the session`,
        ).toBe(true);
      await transport().write("scene.selected", 3);
      expect(await shown("scene.selected"), "a row picked on the glass").toBe(3);
      notifyChannel(shell).onmessage([{ param_id: PARAMS.SCENE_CURSOR.id, x: 0, y: 0, value: 0x8001 }]);
      await vi.waitFor(async () => expect(await shown("scene.selected"), "the unit's cursor on P01").toBe(101));
      expect(await shown("scene.bank"), "on the tab that lists P01").toBe("Simple");
      notifyChannel(shell).onmessage([{ param_id: PARAMS.CURRENT_SCENE.id, x: 0, y: 0, value: 0x8002 }]);
      await vi.waitFor(async () => expect(await shown("scene.current"), "P02 current").toBe(102));
      $("btn-live").click();
      await invoked(shell, "vd_disconnect");
      await vi.waitFor(async () =>
        expect(await shown("scene.current"), "the glass's own once the session ends").toBe(0),
      );
    },
  );

  // Whether a card is in the unit's microSD slot is read at the session's start and followed as the
  // unit announces it; a session that ends leaves it to the glass, whose own card is in.
  it(
    "shows the unit's microSD card on the glass while Live sync is up, and the glass's own once it ends",
    SLOW,
    async () => {
      const shell = await bootDevice({ experimental_enabled: true }, true, { [`${PARAMS.SD_CARD.id}/0/0`]: 0 });
      await openSim();
      const card = async (): Promise<unknown> => (await transport().snapshot()).get("sd.mounted");
      expect(await card(), "the glass's own with no session").toBe(true);
      await goLive();
      await vi.waitFor(async () => expect(await card(), "no card in the unit").toBe(false));
      const registered = (
        shell.args[shell.invokes.indexOf("vd_params_subscribe")] as { addrs: [number, number, number][] }
      ).addrs;
      expect(
        registered.some(([at, x, y]) => at === PARAMS.SD_CARD.id && x === 0 && y === 0),
        "the card is announced to the session",
      ).toBe(true);
      notifyChannel(shell).onmessage([{ param_id: PARAMS.SD_CARD.id, x: 0, y: 0, value: 1 }]);
      await vi.waitFor(async () => expect(await card(), "a card put in").toBe(true));
      notifyChannel(shell).onmessage([{ param_id: PARAMS.SD_CARD.id, x: 0, y: 0, value: 0 }]);
      await vi.waitFor(async () => expect(await card(), "and taken out").toBe(false));
      $("btn-live").click();
      await invoked(shell, "vd_disconnect");
      await vi.waitFor(async () => expect(await card(), "the glass's own once the session ends").toBe(true));
    },
  );

  // The card is read before the session registers for the unit's announcements, so a card taken out
  // in between announces itself to nobody: the session reads it again once it is up.
  it("takes a card taken out of the unit before the session registered for it", SLOW, async () => {
    const cmds = deviceCommands(
      { "plugin:dialog|message": "Ok", experimental_enabled: true },
      { [`${PARAMS.SD_CARD.id}/0/0`]: 1 },
    );
    const set = cmds.vd_set as (a: Record<string, unknown>) => unknown;
    const subscribe = cmds.vd_params_subscribe as (a: Record<string, unknown>) => unknown;
    let moved = false;
    cmds.vd_params_subscribe = (a: Record<string, unknown>) => {
      if (!moved) {
        moved = true;
        set({ paramId: PARAMS.SD_CARD.id, x: 0, y: 0, value: 0 });
      }
      return subscribe(a);
    };
    await bootApp({ tauri: cmds });
    await openSim();
    await goLive();
    expect(moved).toBe(true);
    await vi.waitFor(async () =>
      expect((await transport().snapshot()).get("sd.mounted"), "the removal the session missed").toBe(false),
    );
  });

  // An announcement that lands while the session's own read again runs is newer than that read.
  // Every read of the card after the session's first is held, and released only after it.
  it("keeps a card the unit announced while the session read it again", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true });
    let reads = 0;
    const held: ((v: number) => void)[] = [];
    shell.answer("vd_get", (a: Record<string, unknown>) => {
      if (a.paramId !== PARAMS.SD_CARD.id) return unwrittenRead(a);
      return ++reads === 1 ? 1 : new Promise<number>((done) => held.push(done));
    });
    await openSim();
    await goLive();
    await vi.waitFor(() => expect(held.length, "a read again is under way").toBeGreaterThan(0));
    notifyChannel(shell).onmessage([{ param_id: PARAMS.SD_CARD.id, x: 0, y: 0, value: 0 }]);
    await vi.waitFor(async () => expect((await transport().snapshot()).get("sd.mounted")).toBe(false));
    for (const done of held.splice(0)) done(1);
    await new Promise((done) => setTimeout(done, 50));
    expect((await transport().snapshot()).get("sd.mounted"), "the announcement, not the older read").toBe(false);
  });

  // The URX22 has no microSD slot, so a session on one neither reads the card nor registers for it.
  it("neither reads nor registers the microSD card on a unit with no slot", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true, ...connectAs("URX22") });
    await openSim();
    await goLive();
    expect($<HTMLSelectElement>("model-picker").value, "the session runs on a URX22").toBe("URX22");
    const reads = shell.invokes.filter(
      (cmd, i) => cmd === "vd_get" && (shell.args[i] as Record<string, number>).paramId === PARAMS.SD_CARD.id,
    );
    expect(reads, "no read of the card").toEqual([]);
    const registered = shell.invokes.flatMap((cmd, i) =>
      cmd === "vd_params_subscribe" ? (shell.args[i] as { addrs: [number, number, number][] }).addrs : [],
    );
    expect(
      registered.some(([at]) => at === PARAMS.SD_CARD.id),
      "no registration for the card",
    ).toBe(false);
    expect(
      registered.some(([at]) => at === PARAMS.OPERATION_MODE.id),
      "the premise: the unit states are registered",
    ).toBe(true);
  });

  // A session refused after its starting read leaves nothing of that read on the glass, and the
  // next session reads the unit again.
  it.each(["vd_params_subscribe", "vd_watch_link"])(
    "leaves the glass its own card, scene and operation mode when the session's %s is refused",
    SLOW,
    async (refused) => {
      const shell = await bootDevice({ experimental_enabled: true }, true, {
        [`${PARAMS.SD_CARD.id}/0/0`]: 0,
        [`${PARAMS.CURRENT_SCENE.id}/0/0`]: 8,
        [`${PARAMS.OPERATION_MODE.id}/0/0`]: 1,
      });
      await openSim();
      const shown = async (): Promise<unknown[]> => {
        const values = await transport().snapshot();
        return [values.get("sd.mounted"), values.get("scene.current"), values.get("setup.operationMode")];
      };
      const own = await shown();
      expect(own, "the glass's own with no session").toEqual([true, 0, "Standard"]);
      shell.failOnce(refused, new Error("registration refused"));
      $("btn-live").click();
      await invoked(shell, "vd_disconnect");
      expect(errors(shell).join(" "), "the refusal is what stopped it").toContain("registration refused");
      expect(live().getAttribute("aria-checked"), "no session").toBe("false");
      expect(
        shell.invokes.indexOf(refused),
        "the premise: the starting read took the card before the refusal",
      ).toBeGreaterThan(
        shell.invokes.findIndex(
          (cmd, i) => cmd === "vd_get" && (shell.args[i] as Record<string, number>).paramId === PARAMS.SD_CARD.id,
        ),
      );
      expect(await shown(), "the glass's own again").toEqual(own);
      await goLive();
      await vi.waitFor(async () =>
        expect(await shown(), "the next session reads the unit").toEqual([false, 9, "Simple"]),
      );
      $("btn-live").click();
      await invoked(shell, "vd_disconnect", 2);
    },
  );

  // A read that fails ends the session, as every other failed read on the device link does.
  it("ends the session when its read again of the microSD card fails", SLOW, async () => {
    let reads = 0;
    const shell = await bootDevice({
      experimental_enabled: true,
      vd_get: (a: Record<string, unknown>) => {
        if (a.paramId !== PARAMS.SD_CARD.id) return unwrittenRead(a);
        if (++reads > 1) throw new Error("card read lost");
        return 1;
      },
    });
    $("btn-live").click();
    await invoked(shell, "vd_disconnect");
    expect(reads, "the starting read, then the read again").toBe(2);
    expect(errors(shell).join(" "), "the failed read again is what ended it").toContain("card read lost");
    expect(live().getAttribute("aria-checked")).toBe("false");
  });

  it("shows the unit's operation mode, and an engaged Clip Safe while the unit announces one", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true }, true, { [`${PARAMS.OPERATION_MODE.id}/0/0`]: 1 });
    await openSim();
    await goLive();
    expect((await transport().snapshot()).get("setup.operationMode")).toBe("Simple");
    const levels = simMounted.unit?.levels;
    if (levels?.kind !== "device") throw new Error("the glass reads no unit levels");
    expect(levels.clipSafe(1)).toBe(false);
    notifyChannel(shell).onmessage([{ param_id: PARAMS.CLIP_SAFE_ENGAGED.id, x: 0, y: 0, value: 1 }]);
    expect(levels.clipSafe(1), "connector 1 is jack 0").toBe(true);
    expect(levels.clipSafe(2)).toBe(false);
    notifyChannel(shell).onmessage([{ param_id: PARAMS.CLIP_SAFE_ENGAGED.id, x: 0, y: 0, value: 0 }]);
    expect(levels.clipSafe(1)).toBe(false);
  });

  it(
    "shows Software Integration's sends and writes one chosen on the glass while a DAW holds the unit",
    SLOW,
    async () => {
      const shell = await bootDevice({ experimental_enabled: true }, true, {
        [`${PARAMS.DAW_INTEGRATION.id}/0/0`]: 2,
        [`${PARAMS.POST_FADER_SEND_FX1.id}/0/0`]: 290,
        [`${PARAMS.POST_FADER_SEND_FX2.id}/0/0`]: 288,
      });
      await openSim();
      await goLive();
      const shown = await transport().snapshot();
      expect([shown.get("setup.integration.fx1Send"), shown.get("setup.integration.fx2Send")]).toEqual([
        "MIX 2",
        "MIX 1",
      ]);
      expect(transport().writable?.("setup.integration.fx2Send")).toBe(true);
      await expect(transport().write("setup.integration.fx2Send", "MIX 2")).resolves.toBe("MIX 2");
      await vi.waitFor(() => expect(setsOf(shell, PARAMS.POST_FADER_SEND_FX2.id)).toEqual([[0, 290]]), {
        timeout: 10_000,
      });
      expect(setsOf(shell, PARAMS.POST_FADER_SEND_FX1.id), "the other send is left as it is").toEqual([]);
      await expect(transport().write("setup.integration.fx1Send", "MIX 3")).rejects.toThrow("refused");
    },
  );

  it("refuses a Software Integration send until the unit announces a DAW holding it", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true });
    await openSim();
    await goLive();
    await expect(transport().write("setup.integration.fx1Send", "MIX 2")).rejects.toThrow("refused");
    notifyChannel(shell).onmessage([{ param_id: PARAMS.DAW_INTEGRATION.id, x: 0, y: 0, value: 2 }]);
    notifyChannel(shell).onmessage([{ param_id: PARAMS.POST_FADER_SEND_FX2.id, x: 0, y: 0, value: 290 }]);
    await vi.waitFor(async () =>
      expect((await transport().snapshot()).get("setup.integration.fx2Send"), "the unit's announced send").toBe(
        "MIX 2",
      ),
    );
    await expect(transport().write("setup.integration.fx1Send", "MIX 2")).resolves.toBe("MIX 2");
    await vi.waitFor(() => expect(setsOf(shell, PARAMS.POST_FADER_SEND_FX1.id)).toEqual([[0, 290]]), {
      timeout: 10_000,
    });
    notifyChannel(shell).onmessage([{ param_id: PARAMS.DAW_INTEGRATION.id, x: 0, y: 0, value: 0 }]);
    await expect(transport().write("setup.integration.fx1Send", "MIX 1")).rejects.toThrow("refused");
    expect(setsOf(shell, PARAMS.POST_FADER_SEND_FX1.id), "nothing written once the DAW let go").toEqual([[0, 290]]);
  });

  it("tells the glass whether a DAW holds the unit while Live sync is up, and nothing once it ends", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true });
    await openSim();
    const daw = async (): Promise<unknown> => (await transport().snapshot()).get("setup.integration.daw");
    // The simulator's own copy, which decides how it draws Software Integration.
    const held = (): boolean => simMounted.glasses.at(-1)!.store.has("setup.integration.daw");
    expect(await daw(), "no session to read it from").toBeUndefined();
    expect(held(), "nor does the glass hold one").toBe(false);
    await goLive();
    await vi.waitFor(async () => expect(await daw(), "none holds it").toBe(false));
    await vi.waitFor(() => expect(held(), "the glass takes it").toBe(true));
    notifyChannel(shell).onmessage([{ param_id: PARAMS.DAW_INTEGRATION.id, x: 0, y: 0, value: 2 }]);
    await vi.waitFor(async () => expect(await daw(), "the unit's announcement").toBe(true));
    $("btn-live").click();
    await invoked(shell, "vd_disconnect");
    await vi.waitFor(async () => expect(await daw(), "the session that read it ended").toBeUndefined());
    await vi.waitFor(() => expect(held(), "and the glass lets it go").toBe(false));
  });

  // The reads a case's session made of one address.
  const readsOf = (shell: TauriShell, paramId: number): number =>
    shell.invokes.filter((cmd, i) => cmd === "vd_get" && (shell.args[i] as Record<string, number>).paramId === paramId)
      .length;

  it(
    "reads SETUP again when the unit announces a setting changed on its panel, and follows its operation mode",
    SLOW,
    async () => {
      const shell = await bootDevice({ experimental_enabled: true });
      await openSim();
      await goLive();
      const before = readsOf(shell, PARAMS.BRIGHTNESS.id);
      expect(before, "the premise: the session read SETUP once").toBeGreaterThan(0);
      notifyChannel(shell).onmessage([{ param_id: PARAMS.BRIGHTNESS.id, x: 0, y: 0, value: 4 }]);
      await vi.waitFor(() => expect(readsOf(shell, PARAMS.BRIGHTNESS.id)).toBeGreaterThan(before), { timeout: 10_000 });
      notifyChannel(shell).onmessage([{ param_id: PARAMS.OPERATION_MODE.id, x: 0, y: 0, value: 1 }]);
      await vi.waitFor(async () => expect((await transport().snapshot()).get("setup.operationMode")).toBe("Simple"));
      $("btn-live").click();
      await invoked(shell, "vd_disconnect");
    },
  );

  it("ends the session when the re-read after an announced SETUP change fails", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true });
    await openSim();
    await goLive();
    shell.failOnce("vd_get", new Error("setup read lost"));
    notifyChannel(shell).onmessage([{ param_id: PARAMS.BRIGHTNESS.id, x: 0, y: 0, value: 4 }]);
    await invoked(shell, "vd_disconnect");
    expect(errors(shell).join(" "), "the failed re-read is what ended it").toContain("setup read lost");
  });

  it("ends the session when a SETUP setting written from the glass during Live sync is refused", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true });
    await openSim();
    await goLive();
    shell.failOnce("vd_set", new Error("setup write refused"));
    await transport().write("setup.brightness", 2);
    await invoked(shell, "vd_disconnect");
    expect(errors(shell).join(" "), "the refused write is what ended it").toContain("setup write refused");
  });

  // A DAW that takes or lets go of the unit between the session's starting read and its notify
  // registration announces itself to nobody, so the session reads Software Integration again once
  // it is registered. The unit's table is moved at the registration itself.
  it.each([
    [0, 2, true],
    [2, 0, false],
  ])("takes 816 moving from %i to %i before the session registers its notifies", SLOW, async (from, to, active) => {
    const DAW = PARAMS.DAW_INTEGRATION.id;
    const FX2 = PARAMS.POST_FADER_SEND_FX2.id;
    const cmds = deviceCommands(
      { "plugin:dialog|message": "Ok", experimental_enabled: true },
      { [`${DAW}/0/0`]: from },
    );
    const set = cmds.vd_set as (a: Record<string, unknown>) => unknown;
    const subscribe = cmds.vd_params_subscribe as (a: Record<string, unknown>) => unknown;
    let moved = false;
    cmds.vd_params_subscribe = (a: Record<string, unknown>) => {
      if (!moved) {
        moved = true;
        set({ paramId: DAW, x: 0, y: 0, value: to });
        set({ paramId: FX2, x: 0, y: 0, value: 290 });
      }
      return subscribe(a);
    };
    await bootApp({ tauri: cmds });
    await openSim();
    await goLive();
    expect(moved, "the premise: the table moved at the registration").toBe(true);
    await vi.waitFor(
      async () => expect((await transport().snapshot()).get("setup.integration.fx2Send")).toBe("MIX 2"),
      { timeout: 10_000 },
    );
    const write = transport().write("setup.integration.fx1Send", "MIX 2");
    if (active) await expect(write).resolves.toBe("MIX 2");
    else await expect(write).rejects.toThrow("refused");
  });

  // The read the session takes after registering answers what the unit held when it was asked; a
  // DAW that takes the unit while that read is out announces itself, and the announcement stands.
  it("keeps a DAW announced while the session's second read of Software Integration is out", SLOW, async () => {
    const DAW = PARAMS.DAW_INTEGRATION.id;
    const cmds = deviceCommands({ "plugin:dialog|message": "Ok", experimental_enabled: true });
    const get = cmds.vd_get as (a: Record<string, unknown>) => unknown;
    let reads = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    cmds.vd_get = (a: Record<string, unknown>) => {
      if (a.paramId !== DAW) return get(a);
      reads++;
      const answer = get(a);
      return reads === 2 ? held.then(() => answer) : answer;
    };
    const shell = (await bootApp({ tauri: cmds }))!;
    await openSim();
    await goLive();
    await vi.waitFor(() => expect(reads, "the premise: the second read is out").toBe(2), { timeout: 10_000 });
    notifyChannel(shell).onmessage([{ param_id: DAW, x: 0, y: 0, value: 2 }]);
    release();
    // A SETUP write queues behind the read, so its arrival says the read has been taken or dropped.
    await transport().write("setup.brightness", 3);
    await vi.waitFor(() => expect(setsOf(shell, PARAMS.BRIGHTNESS.id)).toEqual([[0, 3]]), { timeout: 10_000 });
    await expect(transport().write("setup.integration.fx1Send", "MIX 2")).resolves.toBe("MIX 2");
  });

  // The second read answers all three values, and each is taken unless that one value changed while
  // the read was out: a change to one does not throw away what the read found for the others.
  const bootHeldReread = async (seed: Record<string, number>, atRegistration: Record<string, number>) => {
    const DAW = PARAMS.DAW_INTEGRATION.id;
    const cmds = deviceCommands({ "plugin:dialog|message": "Ok", experimental_enabled: true }, seed);
    const set = cmds.vd_set as (a: Record<string, unknown>) => unknown;
    const get = cmds.vd_get as (a: Record<string, unknown>) => unknown;
    const subscribe = cmds.vd_params_subscribe as (a: Record<string, unknown>) => unknown;
    let moved = false;
    cmds.vd_params_subscribe = (a: Record<string, unknown>) => {
      if (!moved) {
        moved = true;
        for (const [key, value] of Object.entries(atRegistration)) {
          const [paramId, x, y] = key.split("/").map(Number);
          set({ paramId, x, y, value });
        }
      }
      return subscribe(a);
    };
    let reads = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    cmds.vd_get = (a: Record<string, unknown>) => {
      if (a.paramId !== DAW) return get(a);
      reads++;
      const answer = get(a);
      return reads === 2 ? held.then(() => answer) : answer;
    };
    const shell = (await bootApp({ tauri: cmds }))!;
    await openSim();
    await goLive();
    await vi.waitFor(() => expect(reads, "the premise: the second read is out").toBe(2), { timeout: 10_000 });
    /** Let the read answer, and return once it has been taken: a SETUP write queues behind it. */
    const answer = async (): Promise<void> => {
      release();
      await transport().write("setup.brightness", 3);
      await vi.waitFor(() => expect(setsOf(shell, PARAMS.BRIGHTNESS.id)).toEqual([[0, 3]]), { timeout: 10_000 });
    };
    return { shell, answer };
  };
  const shownSends = async (): Promise<unknown[]> => {
    const shown = await transport().snapshot();
    return [shown.get("setup.integration.fx1Send"), shown.get("setup.integration.fx2Send")];
  };

  it("takes the second read's DAW and sends when another send is announced while it is out", SLOW, async () => {
    const FX1 = PARAMS.POST_FADER_SEND_FX1.id;
    const FX2 = PARAMS.POST_FADER_SEND_FX2.id;
    const { shell, answer } = await bootHeldReread(
      { [`${PARAMS.DAW_INTEGRATION.id}/0/0`]: 0 },
      { [`${PARAMS.DAW_INTEGRATION.id}/0/0`]: 2, [`${FX2}/0/0`]: 290 },
    );
    notifyChannel(shell).onmessage([{ param_id: FX1, x: 0, y: 0, value: 290 }]);
    await answer();
    expect(await shownSends(), "FX 1 as announced, FX 2 as read").toEqual(["MIX 2", "MIX 2"]);
    await expect(transport().write("setup.integration.fx2Send", "MIX 1"), "the DAW the read found").resolves.toBe(
      "MIX 1",
    );
  });

  it(
    "takes the second read's DAW and other send when a send is picked on the glass while it is out",
    SLOW,
    async () => {
      const FX1 = PARAMS.POST_FADER_SEND_FX1.id;
      const FX2 = PARAMS.POST_FADER_SEND_FX2.id;
      const { shell, answer } = await bootHeldReread(
        { [`${PARAMS.DAW_INTEGRATION.id}/0/0`]: 2 },
        { [`${PARAMS.DAW_INTEGRATION.id}/0/0`]: 0, [`${FX1}/0/0`]: 290 },
      );
      await expect(transport().write("setup.integration.fx2Send", "MIX 2")).resolves.toBe("MIX 2");
      await answer();
      expect((await shownSends())[0], "FX 1 as read").toBe("MIX 2");
      await expect(
        transport().write("setup.integration.fx1Send", "MIX 1"),
        "the DAW the read found gone",
      ).rejects.toThrow("refused");
      // The pick waited behind the read, and its turn came with no DAW on the unit.
      await vi.waitFor(async () => expect((await shownSends())[1]).toBe("MIX 1"), { timeout: 10_000 });
      expect(setsOf(shell, FX2), "nothing written to a unit no DAW holds").toEqual([]);
    },
  );

  // A send queued behind another is written only if a DAW still holds the unit when its turn comes.
  it("drops a Software Integration send queued before the DAW lets go of the unit", SLOW, async () => {
    const FX1 = PARAMS.POST_FADER_SEND_FX1.id;
    const FX2 = PARAMS.POST_FADER_SEND_FX2.id;
    const cmds = deviceCommands(
      { "plugin:dialog|message": "Ok", experimental_enabled: true },
      { [`${PARAMS.DAW_INTEGRATION.id}/0/0`]: 2 },
    );
    const set = cmds.vd_set as (a: Record<string, unknown>) => unknown;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    cmds.vd_set = (a: Record<string, unknown>) => (a.paramId === FX1 ? held.then(() => set(a)) : set(a));
    const shell = (await bootApp({ tauri: cmds }))!;
    await openSim();
    await goLive();
    await expect(transport().write("setup.integration.fx1Send", "MIX 2")).resolves.toBe("MIX 2");
    await vi.waitFor(() => expect(setsOf(shell, FX1)).toEqual([[0, 290]]), { timeout: 10_000 });
    await expect(transport().write("setup.integration.fx2Send", "MIX 2")).resolves.toBe("MIX 2");
    notifyChannel(shell).onmessage([{ param_id: PARAMS.DAW_INTEGRATION.id, x: 0, y: 0, value: 0 }]);
    release();
    // The queue has drained once the glass shows the send the unit still holds.
    await vi.waitFor(
      async () => expect((await transport().snapshot()).get("setup.integration.fx2Send")).toBe("MIX 1"),
      { timeout: 10_000 },
    );
    expect(setsOf(shell, FX2), "nothing written once the DAW let go").toEqual([]);
  });

  it("ends the session when a Software Integration send written from the glass is refused", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true }, true, { [`${PARAMS.DAW_INTEGRATION.id}/0/0`]: 2 });
    await openSim();
    await goLive();
    shell.failOnce("vd_set", new Error("send write refused"));
    await transport().write("setup.integration.fx1Send", "MIX 2");
    await invoked(shell, "vd_disconnect");
    expect(errors(shell).join(" "), "the refused write is what ended it").toContain("send write refused");
  });

  // A choice of the unit's own lands while one made on the glass is still to be written or answered.
  // The unit ends on whichever lands last — the glass's — so the glass keeps its choice, and the
  // read taken behind the write shows what the unit holds.
  const SENDS = PARAMS.SENDS_TARGET.id;
  const FX1 = 16;
  const FX2 = 17;
  const MIX1 = 32;
  const MIX2 = 34;
  const sendsUnit = () => {
    const cmds = deviceCommands(
      { "plugin:dialog|message": "Ok", experimental_enabled: true },
      {
        [`${SENDS}/0/0`]: MIX1,
      },
    );
    const set = cmds.vd_set as (a: Record<string, unknown>) => unknown;
    let shell: TauriShell | null = null;
    const announce = (value: number): void => notifyChannel(shell!).onmessage([{ param_id: SENDS, x: 0, y: 0, value }]);
    /** A choice on the unit's panel: held by the unit, and announced. */
    const press = (value: number): void => {
      set({ paramId: SENDS, x: 0, y: 0, value });
      announce(value);
    };
    const boot = async (): Promise<TauriShell> => {
      shell = (await bootApp({ tauri: cmds }))!;
      await openSim();
      await goLive();
      return shell;
    };
    return { cmds, set, announce, press, boot };
  };
  const sendsShown = async (): Promise<unknown> => (await transport().snapshot()).get("ui.sendsTarget");
  const writes = async (shell: TauriShell, n: number): Promise<void> => {
    for (let i = 0; i < 1000 && setsOf(shell, SENDS).length < n; i++) await new Promise((r) => setTimeout(r, 10));
  };

  it(
    "keeps the [Sends] destination written on the glass when the unit chooses another before its answer",
    SLOW,
    async () => {
      const unit = sendsUnit();
      const shell = await unit.boot();
      await vi.waitFor(async () => expect(await sendsShown(), "the premise: the unit's MIX 1").toBe("MIX1"));
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        await transport().write("ui.sendsTarget", "FX1");
        await writes(shell, 1);
        expect(setsOf(shell, SENDS)).toEqual([[0, FX1]]);
        // MIX 2 chosen on the unit before the write lands, then the write's own answer.
        unit.announce(MIX2);
        expect(await sendsShown(), "the glass keeps its choice").toBe("FX1");
        unit.announce(FX1);
      } finally {
        vi.useRealTimers();
      }
      // The read taken behind the write.
      await transport().write("setup.brightness", 3);
      await vi.waitFor(() => expect(setsOf(shell, PARAMS.BRIGHTNESS.id)).toEqual([[0, 3]]), { timeout: 10_000 });
      expect(await sendsShown(), "what the unit holds").toBe("FX1");
      expect(setsOf(shell, SENDS), "nothing written back").toEqual([[0, FX1]]);
    },
  );

  it(
    "shows the [Sends] destination the unit ends on when it chooses while choices of the glass wait",
    SLOW,
    async () => {
      const unit = sendsUnit();
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let holding = false;
      unit.cmds.vd_set = (a: Record<string, unknown>) => {
        unit.set(a);
        if (a.paramId === SENDS) queueMicrotask(() => unit.announce(a.value as number));
        if (a.paramId !== PARAMS.BRIGHTNESS.id || a.value !== 3) return undefined;
        holding = true;
        return held;
      };
      const shell = await unit.boot();
      // A SETUP write the unit has not answered holds every unit write queued behind it.
      await transport().write("setup.brightness", 3);
      await vi.waitFor(() => expect(holding, "the premise: the SETUP write is out").toBe(true));
      await transport().write("ui.sendsTarget", "FX1");
      await transport().write("ui.sendsTarget", "FX2");
      unit.press(MIX2);
      expect(await sendsShown(), "the glass keeps its latest choice").toBe("FX2");
      release();
      await transport().write("setup.brightness", 2);
      await vi.waitFor(
        () =>
          expect(setsOf(shell, PARAMS.BRIGHTNESS.id)).toEqual([
            [0, 3],
            [0, 2],
          ]),
        { timeout: 10_000 },
      );
      expect(setsOf(shell, SENDS)).toEqual([
        [0, FX1],
        [0, FX2],
      ]);
      expect(await sendsShown(), "what the unit holds after all of them").toBe("FX2");
    },
  );

  it("keeps a [Sends] destination chosen on the glass after the read a choice on the unit queued", SLOW, async () => {
    const unit = sendsUnit();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let holding = false;
    unit.cmds.vd_set = (a: Record<string, unknown>) => {
      unit.set(a);
      if (a.paramId === SENDS) queueMicrotask(() => unit.announce(a.value as number));
      if (a.paramId !== PARAMS.BRIGHTNESS.id || a.value !== 3) return undefined;
      holding = true;
      return held;
    };
    const shell = await unit.boot();
    await transport().write("setup.brightness", 3);
    await vi.waitFor(() => expect(holding, "the premise: the SETUP write is out").toBe(true));
    // FX 1 chosen, MIX 2 on the unit (a read is queued behind FX 1's write), then FX 2 behind that read.
    await transport().write("ui.sendsTarget", "FX1");
    unit.press(MIX2);
    await transport().write("ui.sendsTarget", "FX2");
    release();
    await transport().write("setup.brightness", 2);
    await vi.waitFor(
      () =>
        expect(setsOf(shell, PARAMS.BRIGHTNESS.id)).toEqual([
          [0, 3],
          [0, 2],
        ]),
      { timeout: 10_000 },
    );
    expect(setsOf(shell, SENDS)).toEqual([
      [0, FX1],
      [0, FX2],
    ]);
    expect(await sendsShown(), "the read found FX 1 while FX 2 was still to be written").toBe("FX2");
  });

  it("shows a [Sends] destination the unit chooses right after answering a write of the glass", SLOW, async () => {
    const unit = sendsUnit();
    const shell = await unit.boot();
    await vi.waitFor(async () => expect(await sendsShown(), "the premise: the unit's MIX 1").toBe("MIX1"));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await transport().write("ui.sendsTarget", "FX1");
      await writes(shell, 1);
      // The write's answer and MIX 2 chosen on the unit after it, in one burst: the unit ends on MIX 2.
      unit.set({ paramId: SENDS, x: 0, y: 0, value: MIX2 });
      notifyChannel(shell).onmessage([
        { param_id: SENDS, x: 0, y: 0, value: FX1 },
        { param_id: SENDS, x: 0, y: 0, value: MIX2 },
      ]);
    } finally {
      vi.useRealTimers();
    }
    await transport().write("setup.brightness", 3);
    await vi.waitFor(() => expect(setsOf(shell, PARAMS.BRIGHTNESS.id)).toEqual([[0, 3]]), { timeout: 10_000 });
    await vi.waitFor(async () => expect(await sendsShown(), "what the unit holds").toBe("MIX2"), { timeout: 10_000 });
    expect(setsOf(shell, SENDS), "nothing written back").toEqual([[0, FX1]]);
  });

  it("reads the [Sends] destination again only once the glass's own write is answered", SLOW, async () => {
    const unit = sendsUnit();
    const shell = await unit.boot();
    await vi.waitFor(async () => expect(await sendsShown(), "the premise: the unit's MIX 1").toBe("MIX1"));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await transport().write("ui.sendsTarget", "FX1");
      await writes(shell, 1);
      // MIX 2 chosen on the unit before the write lands; the unit then lands the write and answers it.
      unit.press(MIX2);
      await new Promise((r) => setTimeout(r, 100));
      unit.set({ paramId: SENDS, x: 0, y: 0, value: FX1 });
      unit.announce(FX1);
    } finally {
      vi.useRealTimers();
    }
    await transport().write("setup.brightness", 3);
    await vi.waitFor(() => expect(setsOf(shell, PARAMS.BRIGHTNESS.id)).toEqual([[0, 3]]), { timeout: 10_000 });
    expect(await sendsShown(), "what the unit holds after both").toBe("FX1");
  });

  it("leaves a [Sends] destination the unit chose while a read of it was out", SLOW, async () => {
    const unit = sendsUnit();
    const get = unit.cmds.vd_get as (a: Record<string, unknown>) => unknown;
    let reads = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    unit.cmds.vd_get = (a: Record<string, unknown>) => {
      const answer = get(a);
      // The read a session takes again once it is up answers with the value it found, late.
      if (a.paramId === SENDS && ++reads === 2) return held.then(() => answer);
      return answer;
    };
    const shell = await unit.boot();
    await vi.waitFor(() => expect(reads, "the premise: the second read is out").toBe(2), { timeout: 10_000 });
    unit.press(MIX2);
    await vi.waitFor(async () => expect(await sendsShown(), "the unit's choice").toBe("MIX2"));
    release();
    await transport().write("setup.brightness", 3);
    await vi.waitFor(() => expect(setsOf(shell, PARAMS.BRIGHTNESS.id)).toEqual([[0, 3]]), { timeout: 10_000 });
    expect(await sendsShown(), "not put back by the read's late answer").toBe("MIX2");
  });

  // RECALL SAFE (System firmware V1.5): a row's [Safe] and selections are the unit's while Live sync
  // is up, read, followed and written from the glass; the rest of the time, and Incoming Sends and
  // the Others tab always, they are the glass's own.
  const SAFE = PARAMS.RECALL_SAFE_MONO.id;
  const SELECT = PARAMS.RECALL_SAFE_MONO_SELECT.id;
  const shownSafe = async (...paths: string[]): Promise<unknown[]> => {
    const shown = await transport().snapshot();
    return paths.map((p) => shown.get(p));
  };

  it("shows the unit's RECALL SAFE during Live sync, and writes each row a press changes once", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true }, true, {
      [`${SAFE}/0/2`]: 1,
      // CH 3's Name, and a bit no column names.
      [`${SELECT}/0/2`]: 0x40100000,
    });
    await openSim();
    // Chosen on the glass with no session: the glass's own, which the unit's replaces.
    await expect(transport().write("safe.ch3.chOn", true)).resolves.toBe(true);
    await goLive();
    await vi.waitFor(async () =>
      expect(await shownSafe("safe.ch3.on", "safe.ch3.name", "safe.ch3.chOn")).toEqual([true, true, false]),
    );
    // One press that selects two columns of the row, as the row's [All] or a Source with its HA does.
    await Promise.all([transport().write("safe.ch3.chOn", true), transport().write("safe.ch3.chLevel", true)]);
    await vi.waitFor(() => expect(setsOf(shell, SELECT)).toEqual([[2, 0x40100003]]), { timeout: 10_000 });
    expect(await shownSafe("safe.ch3.chOn", "safe.ch3.chLevel")).toEqual([true, true]);
    // A row's [Safe] the unit takes from its own panel alone.
    await expect(transport().write("safe.ch3.on", false)).rejects.toThrow("refused");
    // No address of the link has been found for Incoming Sends and the Others tab.
    await expect(transport().write("safe.bus.mix1.incoming", true)).resolves.toBe(true);
    await expect(transport().write("safe.others.fx1", true)).resolves.toBe(true);
    await transport().write("setup.brightness", 3);
    await vi.waitFor(() => expect(setsOf(shell, PARAMS.BRIGHTNESS.id)).toEqual([[0, 3]]), { timeout: 10_000 });
    expect(setsOf(shell, SAFE), "no [Safe] written").toEqual([]);
    expect(setsOf(shell, SELECT), "and no other selection").toEqual([[2, 0x40100003]]);
  });

  it(
    "follows RECALL SAFE pressed on the unit, and takes its answers to this app's writes as no change",
    SLOW,
    async () => {
      const shell = await bootDevice({ experimental_enabled: true });
      await openSim();
      await goLive();
      notifyChannel(shell).onmessage([{ param_id: SAFE, x: 0, y: 0, value: 1 }]);
      notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 0, value: 0x2 }]);
      await vi.waitFor(async () =>
        expect(await shownSafe("safe.ch1.on", "safe.ch1.chOn", "safe.ch1.name")).toEqual([true, true, false]),
      );
      // The answer window runs on `Date.now()`, held still from the first write to the last answer,
      // so every answer below lands inside it however long the steps between take. Timers stay real:
      // the shell's answers run on them.
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        // Two writes to the row, and the unit's answer to the first landing after the second. Polled on
        // a real timer rather than `vi.waitFor`, which moves a faked clock forward by its interval on
        // every poll; the second press waits for the first write, which it would otherwise join.
        const writes = async (n: number): Promise<void> => {
          for (let i = 0; i < 1000 && setsOf(shell, SELECT).length < n; i++)
            await new Promise((r) => setTimeout(r, 10));
        };
        await transport().write("safe.ch1.name", true);
        await writes(1);
        await transport().write("safe.ch1.name", false);
        await writes(2);
        expect(setsOf(shell, SELECT)).toEqual([
          [0, 0x100002],
          [0, 0x2],
        ]);
        notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 0, value: 0x100002 }]);
        expect(await shownSafe("safe.ch1.name"), "the late answer to the first write").toEqual([false]);
        notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 0, value: 0x2 }]);
        expect(await shownSafe("safe.ch1.name")).toEqual([false]);
        // The positive control: the same value pressed on the unit's panel once no write is waiting.
        notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 0, value: 0x100002 }]);
        expect(await shownSafe("safe.ch1.name")).toEqual([true]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("takes the answer to a RECALL SAFE write that lands after a selection the unit made itself", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true });
    await openSim();
    await goLive();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const writes = async (n: number): Promise<void> => {
        for (let i = 0; i < 1000 && setsOf(shell, SELECT).length < n; i++) await new Promise((r) => setTimeout(r, 10));
      };
      await transport().write("safe.ch1.name", true);
      await writes(1);
      expect(setsOf(shell, SELECT)).toEqual([[0, 0x100000]]);
      // CH ON pressed on the unit before the write lands, then the write's own answer.
      notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 0, value: 0x2 }]);
      expect(await shownSafe("safe.ch1.name", "safe.ch1.chOn")).toEqual([false, true]);
      notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 0, value: 0x100000 }]);
      expect(await shownSafe("safe.ch1.name", "safe.ch1.chOn"), "what the unit holds after both").toEqual([
        true,
        false,
      ]);
      // The next press changes its own column alone.
      await transport().write("safe.ch1.chLevel", true);
      await writes(2);
      expect(setsOf(shell, SELECT)[1]).toEqual([0, 0x100001]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes the next write to a RECALL SAFE row from what the unit holds after the one before", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true });
    await openSim();
    await goLive();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await transport().write("safe.ch1.name", true);
      for (let i = 0; i < 1000 && setsOf(shell, SELECT).length < 1; i++) await new Promise((r) => setTimeout(r, 10));
      // A second press while the first write waits for its answer, and CH ON pressed on the unit.
      await transport().write("safe.ch1.chLevel", true);
      notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 0, value: 0x2 }]);
      await new Promise((r) => setTimeout(r, 50));
      expect(setsOf(shell, SELECT), "the second write waits for the first one's answer").toEqual([[0, 0x100000]]);
      // The first write's answer: the unit holds Name, over the CH ON it took before the write landed.
      notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 0, value: 0x100000 }]);
      for (let i = 0; i < 1000 && setsOf(shell, SELECT).length < 2; i++) await new Promise((r) => setTimeout(r, 10));
      expect(setsOf(shell, SELECT)).toEqual([
        [0, 0x100000],
        [0, 0x100001],
      ]);
      expect(await shownSafe("safe.ch1.name", "safe.ch1.chLevel")).toEqual([true, true]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts back a RECALL SAFE selection not yet written when the unit goes into Console Lock", SLOW, async () => {
    const unit = panelUnit();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let holding = false;
    unit.cmds.vd_set = (a: Record<string, unknown>) => {
      unit.set(a);
      if (a.paramId !== PARAMS.BRIGHTNESS.id || a.value !== 3) return undefined;
      holding = true;
      return held;
    };
    const shell = await unit.boot();
    await transport().write("setup.brightness", 3);
    await vi.waitFor(() => expect(holding, "the premise: the SETUP write is out").toBe(true));
    await transport().write("safe.ch1.name", true);
    expect(await shownSafe("safe.ch1.name")).toEqual([true]);
    unit.press(PARAMS.CONSOLE_LOCK.id, 1);
    await vi.waitFor(async () => expect(await shownSafe("safe.ch1.name"), "put back at the lock").toEqual([false]));
    unit.press(PARAMS.CONSOLE_LOCK.id, 0);
    release();
    await transport().write("setup.brightness", 2);
    await vi.waitFor(
      () =>
        expect(setsOf(shell, PARAMS.BRIGHTNESS.id)).toEqual([
          [0, 3],
          [0, 2],
        ]),
      { timeout: 10_000 },
    );
    expect(setsOf(shell, SELECT), "nothing sent once the lock is off").toEqual([]);
    // A press after the unlock is sent, alone.
    await transport().write("safe.ch1.chLevel", true);
    await vi.waitFor(() => expect(setsOf(shell, SELECT)).toEqual([[0, 0x1]]), { timeout: 10_000 });
  });

  // A unit that acks a write of CH 1's selection and announces nothing for it, and, when told to,
  // announces CH ON pressed on its panel just before the write lands.
  const silentSelectUnit = (opts: { take: boolean; pressFirst?: number }) => {
    const unit = panelUnit();
    let pressed = false;
    unit.cmds.vd_set = (a: Record<string, unknown>) => {
      if (a.paramId !== SELECT) return unit.set(a);
      if (opts.pressFirst !== undefined && !pressed) {
        pressed = true;
        unit.press(SELECT, opts.pressFirst);
      }
      if (opts.take) unit.set(a);
      return undefined;
    };
    return unit;
  };

  it("reads a RECALL SAFE row back when the unit announces nothing for a write it did not take", SLOW, async () => {
    const unit = silentSelectUnit({ take: false });
    const shell = await unit.boot();
    await transport().write("safe.ch1.name", true);
    await vi.waitFor(() => expect(setsOf(shell, SELECT)).toEqual([[0, 0x100000]]), { timeout: 10_000 });
    await vi.waitFor(
      async () => expect(await shownSafe("safe.ch1.name"), "what the unit holds, read back").toEqual([false]),
      { timeout: 10_000 },
    );
    // The next press is made from what the unit holds.
    await transport().write("safe.ch1.chLevel", true);
    await vi.waitFor(
      () =>
        expect(setsOf(shell, SELECT)).toEqual([
          [0, 0x100000],
          [0, 0x1],
        ]),
      { timeout: 10_000 },
    );
  });

  it(
    "reads a RECALL SAFE row back when the answer to a write never follows a selection the unit made",
    SLOW,
    async () => {
      // CH ON is announced from the unit's panel, then the write lands and its answer is lost.
      const unit = silentSelectUnit({ take: true, pressFirst: 0x2 });
      const shell = await unit.boot();
      await transport().write("safe.ch1.name", true);
      await vi.waitFor(
        async () =>
          expect(await shownSafe("safe.ch1.name", "safe.ch1.chOn"), "what the unit holds after both").toEqual([
            true,
            false,
          ]),
        { timeout: 10_000 },
      );
      await transport().write("safe.ch1.chLevel", true);
      await vi.waitFor(() => expect(setsOf(shell, SELECT)[1]).toEqual([0, 0x100001]), { timeout: 10_000 });
    },
  );

  it(
    "keeps the row a link copied when the unit announces nothing for a press written to it and reads the row as before",
    SLOW,
    async () => {
      const unit = silentSelectUnit({ take: false });
      const shell = await unit.boot();
      // CH 1's row: [Safe] and Name, pressed on the unit.
      unit.press(SAFE, 1);
      unit.press(SELECT, 0x100000);
      await vi.waitFor(async () => expect(await shownSafe("safe.ch1.on", "safe.ch1.name")).toEqual([true, true]));
      unit.set({ paramId: PARAMS.SIGNAL_TYPE.id, x: 0, y: 0, value: 1 });
      unit.set({ paramId: PARAMS.SIGNAL_TYPE.id, x: 0, y: 1, value: 1 });
      notifyChannel(shell).onmessage([{ param_id: PARAMS.SIGNAL_TYPE.id, x: 0, y: 0, value: 1 }]);
      await vi.waitFor(async () => expect(await shownSafe("safe.ch2.on", "safe.ch2.name")).toEqual([true, true]), {
        timeout: 10_000,
      });
      const rowReads = (): number =>
        shell.invokes.filter((c, i) => c === "vd_get" && shell.args[i]?.paramId === SELECT && shell.args[i]?.y === 1)
          .length;
      const before = rowReads();
      await transport().write("safe.ch2.chOn", true);
      await vi.waitFor(() => expect(setsOf(shell, SELECT)).toEqual([[1, 0x100002]]), { timeout: 10_000 });
      await vi.waitFor(() => expect(rowReads(), "the premise: the row read back").toBeGreaterThan(before), {
        timeout: 10_000,
      });
      await vi.waitFor(async () =>
        expect(await shownSafe("safe.ch2.name", "safe.ch2.chOn"), "the copy kept, the press not").toEqual([
          true,
          false,
        ]),
      );
    },
  );

  it("ends the session when the read of a RECALL SAFE row the unit announced nothing for fails", SLOW, async () => {
    const unit = silentSelectUnit({ take: false });
    let failRead = false;
    const get = unit.cmds.vd_get as (a: Record<string, unknown>) => unknown;
    unit.cmds.vd_get = (a: Record<string, unknown>) =>
      failRead && a.paramId === SELECT ? Promise.reject(new Error("selection read failed")) : get(a);
    const shell = await unit.boot();
    failRead = true;
    await transport().write("safe.ch1.name", true);
    await invoked(shell, "vd_disconnect");
    expect(errors(shell).join(" "), "the failed read is what ended it").toContain("selection read failed");
    expect(setsOf(shell, SELECT)).toEqual([[0, 0x100000]]);
  });

  it("keeps a RECALL SAFE selection the unit announces while the row is read back", SLOW, async () => {
    const unit = silentSelectUnit({ take: false });
    let holdRead = false;
    let reading = false;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const get = unit.cmds.vd_get as (a: Record<string, unknown>) => unknown;
    unit.cmds.vd_get = (a: Record<string, unknown>) => {
      if (!holdRead || a.paramId !== SELECT) return get(a);
      // The value is taken now and answered once released.
      const value = get(a);
      reading = true;
      return held.then(() => value);
    };
    const shell = await unit.boot();
    holdRead = true;
    await transport().write("safe.ch1.name", true);
    await vi.waitFor(() => expect(reading, "the premise: the read back is out").toBe(true), { timeout: 10_000 });
    unit.press(SELECT, 0x2);
    await vi.waitFor(async () => expect(await shownSafe("safe.ch1.chOn")).toEqual([true]));
    release();
    await new Promise((r) => setTimeout(r, 100));
    expect(await shownSafe("safe.ch1.name", "safe.ch1.chOn"), "the unit's announcement over the older read").toEqual([
      false,
      true,
    ]);
    expect(setsOf(shell, SELECT)).toEqual([[0, 0x100000]]);
  });

  it("keeps the answer to a RECALL SAFE write that lands while the row is read back", SLOW, async () => {
    // The unit takes nothing at first: its answer comes once the read back is out.
    const unit = silentSelectUnit({ take: false });
    let holdRead = false;
    let reading = false;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const get = unit.cmds.vd_get as (a: Record<string, unknown>) => unknown;
    unit.cmds.vd_get = (a: Record<string, unknown>) => {
      if (!holdRead || a.paramId !== SELECT) return get(a);
      const value = get(a);
      reading = true;
      return held.then(() => value);
    };
    const shell = await unit.boot();
    holdRead = true;
    // The answer window runs on `Date.now()`, held still so the late answer is still the write's;
    // timers stay real, so the write's wait ends at its bound and the read back goes out.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await transport().write("safe.ch1.name", true);
      for (let i = 0; i < 1000 && !reading; i++) await new Promise((r) => setTimeout(r, 10));
      expect(reading, "the premise: the read back is out").toBe(true);
      // The write lands and is answered; the read back then answers what it took before.
      unit.press(SELECT, 0x100000);
      release();
      await new Promise((r) => setTimeout(r, 100));
      expect(await shownSafe("safe.ch1.name"), "the answer over the older read").toEqual([true]);
      await transport().write("safe.ch1.chLevel", true);
      for (let i = 0; i < 1000 && setsOf(shell, SELECT).length < 2; i++) await new Promise((r) => setTimeout(r, 10));
      expect(setsOf(shell, SELECT)[1], "the next press changes its own column alone").toEqual([0, 0x100001]);
    } finally {
      vi.useRealTimers();
    }
  });

  // A SETUP write the unit holds unanswered, a RECALL SAFE selection queued behind it, and Console
  // Lock on and off while it waits; then another SETUP write and a selection of the same row.
  const lockedQueue = async (brightness2?: Error) => {
    const unit = panelUnit();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let holding = false;
    const order: string[] = [];
    unit.cmds.vd_set = (a: Record<string, unknown>) => {
      unit.set(a);
      if (a.paramId === SELECT || a.paramId === PARAMS.BRIGHTNESS.id)
        order.push(`${String(a.paramId)}=${String(a.value)}`);
      if (a.paramId !== PARAMS.BRIGHTNESS.id) return undefined;
      if (a.value === 2 && brightness2) return Promise.reject(brightness2);
      if (a.value !== 3) return undefined;
      holding = true;
      return held;
    };
    const shell = await unit.boot();
    await transport().write("setup.brightness", 3);
    await vi.waitFor(() => expect(holding, "the premise: the SETUP write is out").toBe(true));
    await transport().write("safe.ch1.name", true);
    unit.press(PARAMS.CONSOLE_LOCK.id, 1);
    await vi.waitFor(async () => expect(await shownSafe("safe.ch1.name"), "put back at the lock").toEqual([false]));
    unit.press(PARAMS.CONSOLE_LOCK.id, 0);
    await transport().write("setup.brightness", 2);
    await transport().write("safe.ch1.chLevel", true);
    release();
    return { shell, order };
  };

  it("writes a RECALL SAFE selection made after a Console Lock behind the writes queued before it", SLOW, async () => {
    const { shell, order } = await lockedQueue();
    await vi.waitFor(() => expect(setsOf(shell, SELECT)).toEqual([[0, 0x1]]), { timeout: 10_000 });
    const b = PARAMS.BRIGHTNESS.id;
    expect(order, "in the order the writes were taken").toEqual([`${b}=3`, `${b}=2`, `${SELECT}=1`]);
  });

  it(
    "sends no RECALL SAFE selection made after a Console Lock when a write queued ahead of it fails",
    SLOW,
    async () => {
      const { shell } = await lockedQueue(new Error("brightness write refused"));
      await invoked(shell, "vd_disconnect");
      expect(errors(shell).join(" ")).toContain("brightness write refused");
      expect(setsOf(shell, SELECT)).toEqual([]);
    },
  );

  it(
    "holds each row's [Safe] shut during Live sync, and leaves RECALL SAFE to the glass once it ends",
    SLOW,
    async () => {
      const shell = await bootDevice({ experimental_enabled: true }, true, { [`${SAFE}/0/2`]: 1 });
      await openSim();
      const sim = simMounted.glasses.at(-1)!;
      const locks = vi.spyOn(sim, "setLocks");
      const held = (): string[] =>
        (locks.mock.calls.at(-1)?.[0] ?? []).flatMap((l) =>
          l.target.kind === "path" && l.target.path.startsWith("safe.") ? [`${l.target.path} ${l.reason}`] : [],
        );
      await goLive();
      await vi.waitFor(() => expect(held()).toContain(`safe.ch3.on ${t().inspector.prePostLcdOnly}`));
      expect(held(), "a [Safe] for every row, and no selection").toHaveLength(14);
      $("btn-live").click();
      await invoked(shell, "vd_disconnect");
      await vi.waitFor(() => expect(held()).toEqual([]));
      await vi.waitFor(async () =>
        expect(await shownSafe("safe.ch3.on"), "the session that read it ended").toEqual([undefined]),
      );
      await expect(transport().write("safe.ch3.name", true), "the glass's own again").resolves.toBe(true);
      await expect(transport().write("safe.ch3.on", false)).resolves.toBe(false);
      expect(setsOf(shell, SELECT)).toEqual([]);
    },
  );

  it("refuses a RECALL SAFE selection while the unit is in Console Lock", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true });
    await openSim();
    await goLive();
    notifyChannel(shell).onmessage([{ param_id: PARAMS.CONSOLE_LOCK.id, x: 0, y: 0, value: 1 }]);
    await vi.waitFor(() => expect(statusText()).toBe(t().status.consoleLocked));
    await expect(transport().write("safe.ch1.name", true)).rejects.toThrow("refused");
    expect(statusText(), "the status line says it was not sent").toBe(t().status.consoleLockedNotSent);
    expect(setsOf(shell, SELECT)).toEqual([]);
  });

  it("keeps a RECALL SAFE row announced while the session's second read of it is out", SLOW, async () => {
    const cmds = deviceCommands(
      { "plugin:dialog|message": "Ok", experimental_enabled: true },
      {
        [`${SELECT}/0/1`]: 0x2,
      },
    );
    const get = cmds.vd_get as (a: Record<string, unknown>) => unknown;
    let reads = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    cmds.vd_get = (a: Record<string, unknown>) => {
      if (a.paramId !== SELECT || a.y !== 0) return get(a);
      reads++;
      const answer = get(a);
      return reads === 2 ? held.then(() => answer) : answer;
    };
    const shell = (await bootApp({ tauri: cmds }))!;
    await openSim();
    await goLive();
    await vi.waitFor(() => expect(reads, "the premise: the second read is out").toBe(2), { timeout: 10_000 });
    notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 0, value: 0x100000 }]);
    release();
    // A SETUP write queues behind the read, so its arrival says the read has been taken.
    await transport().write("setup.brightness", 3);
    await vi.waitFor(() => expect(setsOf(shell, PARAMS.BRIGHTNESS.id)).toEqual([[0, 3]]), { timeout: 10_000 });
    expect(await shownSafe("safe.ch1.name", "safe.ch2.chOn"), "CH 1 as announced, CH 2 as read").toEqual([true, true]);
  });

  // The unit puts a pair's first RECALL SAFE row on its second as the pair is linked over the link or
  // on its panel, and announces none of it; a pair a scene recall links keeps its rows as they were.
  const LINK = PARAMS.SIGNAL_TYPE.id;
  const unitSet = (paramId: number, y: number, value: number): Promise<unknown> =>
    (
      window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> } }
    ).__TAURI_INTERNALS__.invoke("vd_set", { paramId, x: 0, y, value });
  const shownLink = async (ch: string): Promise<unknown> => (await transport().snapshot()).get(`ch.${ch}.signalType`);

  it(
    "puts a pair's first RECALL SAFE row on its second when the unit's panel links the pair, and not when a recall does",
    SLOW,
    async () => {
      // CH 1's and CH 3's rows: [Safe] and Name. CH 2's and CH 4's: nothing.
      const shell = await bootDevice({ experimental_enabled: true }, true, {
        [`${SAFE}/0/0`]: 1,
        [`${SELECT}/0/0`]: 0x100000,
        [`${SAFE}/0/2`]: 1,
        [`${SELECT}/0/2`]: 0x100000,
      });
      await openSim();
      await goLive();
      const seconds = () => shownSafe("safe.ch2.on", "safe.ch2.name", "safe.ch4.on", "safe.ch4.name");
      await vi.waitFor(async () => expect(await seconds()).toEqual([false, false, false, false]));
      // CH 1/2 linked on the unit's panel: the link is announced at the primary, RECALL SAFE is not.
      await unitSet(LINK, 0, 1);
      await unitSet(LINK, 1, 1);
      notifyChannel(shell).onmessage([{ param_id: LINK, x: 0, y: 0, value: 1 }]);
      await vi.waitFor(async () => expect(await seconds()).toEqual([true, true, false, false]), { timeout: 10_000 });
      // CH 3/4 linked by a scene recall, which announces no link, only the bulk change.
      await unitSet(LINK, 2, 1);
      await unitSet(LINK, 3, 1);
      notifyChannel(shell).onmessage([{ param_id: 0, x: -1, y: -1, value: 0 }]);
      await vi.waitFor(async () => expect(await shownLink("ch3")).toBe("STEREO"), { timeout: 10_000 });
      expect(await seconds(), "CH 4's row as it was").toEqual([true, true, false, false]);
      // The link the read found is the unit's: CH Level pressed on CH 3's row reaches CH 4's.
      await unitSet(SELECT, 2, 0x100001);
      notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 2, value: 0x100001 }]);
      await vi.waitFor(async () =>
        expect(await shownSafe("safe.ch4.name", "safe.ch4.chLevel"), "CH 3's row on CH 4's").toEqual([true, true]),
      );
    },
  );

  // A unit whose read of CH 1's Signal Type a case holds: each read is answered, once the case lets it
  // go, with what the unit held when it was asked, or when it is let go for a read the unit took late.
  const heldLinkReads = (cmds: Record<string, unknown>) => {
    const get = cmds.vd_get as (a: Record<string, unknown>) => unknown;
    const waiting: Array<() => void> = [];
    let holding = false;
    let late = false;
    let asked = 0;
    cmds.vd_get = (a: Record<string, unknown>) => {
      const value = get(a);
      if (!holding || a.paramId !== LINK || a.y !== 0) return value;
      asked++;
      return new Promise((resolve) => waiting.push(() => resolve(late ? get(a) : value)));
    };
    return {
      hold: (opts: { late?: boolean } = {}) => {
        holding = true;
        late = opts.late === true;
      },
      asked: () => asked,
      releaseOne: () => waiting.shift()?.(),
      releaseLast: () => waiting.pop()?.(),
      releaseAll: () => {
        holding = false;
        for (const release of waiting.splice(0)) release();
      },
    };
  };
  const bootLinkUnit = async (seed: Record<string, number>) => {
    const cmds = deviceCommands({ "plugin:dialog|message": "Ok", experimental_enabled: true }, seed);
    const reads = heldLinkReads(cmds);
    const shell = (await bootApp({ tauri: cmds }))!;
    await openSim();
    await goLive();
    return { shell, reads };
  };

  it("tells each pair's link apart by the operation that made it while a read of the unit is out", SLOW, async () => {
    const { shell, reads } = await bootLinkUnit({
      [`${SAFE}/0/0`]: 1,
      [`${SELECT}/0/0`]: 0x100000,
      [`${SAFE}/0/2`]: 1,
      [`${SELECT}/0/2`]: 0x100000,
    });
    const seconds = () => shownSafe("safe.ch2.on", "safe.ch2.name", "safe.ch4.on", "safe.ch4.name");
    await vi.waitFor(async () => expect(await seconds()).toEqual([false, false, false, false]));
    onTestFinished(() => reads.releaseAll());
    // The scene the unit is on recalled again, and the read it starts held.
    reads.hold();
    notifyChannel(shell).onmessage([{ param_id: 0, x: -1, y: -1, value: 0 }]);
    await vi.waitFor(() => expect(reads.asked(), "the premise: the read is out").toBe(1), { timeout: 10_000 });
    // CH 1/2 linked on the unit's panel while the read is out: taken once that read is in.
    await unitSet(LINK, 0, 1);
    await unitSet(LINK, 1, 1);
    notifyChannel(shell).onmessage([{ param_id: LINK, x: 0, y: 0, value: 1 }]);
    await new Promise((r) => setTimeout(r, 300));
    expect(await seconds(), "nothing before the read is in").toEqual([false, false, false, false]);
    // CH 3/4 linked by a recall, which announces no link, only the bulk change.
    await unitSet(LINK, 2, 1);
    await unitSet(LINK, 3, 1);
    notifyChannel(shell).onmessage([{ param_id: 0, x: -1, y: -1, value: 0 }]);
    reads.releaseAll();
    await vi.waitFor(async () => expect(await shownLink("ch3")).toBe("STEREO"), { timeout: 10_000 });
    await vi.waitFor(async () =>
      expect(await seconds(), "CH 2 the panel link's, CH 4 the recall's").toEqual([true, true, false, false]),
    );
  });

  it(
    "takes a row pressed on the unit after a recall links its pair under that link, once the recall's read is in",
    SLOW,
    async () => {
      const { shell, reads } = await bootLinkUnit({ [`${SELECT}/0/0`]: 0x100000 });
      onTestFinished(() => reads.releaseAll());
      await vi.waitFor(async () => expect(await shownSafe("safe.ch1.name")).toEqual([true]));
      // A recall links CH 1/2, announcing only the bulk change; its read is held.
      await unitSet(LINK, 0, 1);
      await unitSet(LINK, 1, 1);
      reads.hold();
      notifyChannel(shell).onmessage([{ param_id: 0, x: -1, y: -1, value: 0 }]);
      await vi.waitFor(() => expect(reads.asked(), "the premise: the read is out").toBe(1), { timeout: 10_000 });
      // CH Level pressed on CH 2's row: the unit, linked, gives CH 1's row the same.
      await unitSet(SELECT, 1, 0x1);
      notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 1, value: 0x1 }]);
      reads.releaseAll();
      await vi.waitFor(async () => expect(await shownLink("ch1")).toBe("STEREO"), { timeout: 10_000 });
      await vi.waitFor(async () =>
        expect(
          await shownSafe("safe.ch1.name", "safe.ch1.chLevel", "safe.ch2.chLevel"),
          "CH 2's row on CH 1's",
        ).toEqual([false, true, true]),
      );
    },
  );

  it(
    "takes a row pressed on the unit after a recall unlinks its pair as that row alone, once the recall's read is in",
    SLOW,
    async () => {
      const { shell, reads } = await bootLinkUnit({ [`${LINK}/0/0`]: 1, [`${LINK}/0/1`]: 1 });
      onTestFinished(() => reads.releaseAll());
      await vi.waitFor(async () => expect(await shownLink("ch1")).toBe("STEREO"));
      await unitSet(LINK, 0, 0);
      await unitSet(LINK, 1, 0);
      reads.hold();
      notifyChannel(shell).onmessage([{ param_id: 0, x: -1, y: -1, value: 0 }]);
      await vi.waitFor(() => expect(reads.asked(), "the premise: the read is out").toBe(1), { timeout: 10_000 });
      await unitSet(SELECT, 1, 0x100000);
      notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 1, value: 0x100000 }]);
      reads.releaseAll();
      await vi.waitFor(async () => expect(await shownLink("ch1")).toBe("MONO x 2"), { timeout: 10_000 });
      await vi.waitFor(async () => expect(await shownSafe("safe.ch2.name")).toEqual([true]));
      expect(await shownSafe("safe.ch1.name"), "CH 1's row as it was").toEqual([false]);
    },
  );

  it(
    "writes a selection made on the glass after a recall once the recall's read is in, and puts the unit's answer on the other row",
    SLOW,
    async () => {
      const { shell, reads } = await bootLinkUnit({});
      onTestFinished(() => reads.releaseAll());
      await unitSet(LINK, 0, 1);
      await unitSet(LINK, 1, 1);
      reads.hold();
      notifyChannel(shell).onmessage([{ param_id: 0, x: -1, y: -1, value: 0 }]);
      await vi.waitFor(() => expect(reads.asked(), "the premise: the read is out").toBe(1), { timeout: 10_000 });
      // Name chosen on CH 2's row on the glass: written once the recall's read is in.
      const sets = setsOf(shell, SELECT).length;
      await transport().write("safe.ch2.name", true);
      await new Promise((r) => setTimeout(r, 300));
      expect(setsOf(shell, SELECT).length, "nothing written while the read is out").toBe(sets);
      reads.releaseAll();
      await vi.waitFor(async () => expect(await shownLink("ch1")).toBe("STEREO"), { timeout: 10_000 });
      await vi.waitFor(() => expect(setsOf(shell, SELECT).at(-1)).toEqual([1, 0x100000]), { timeout: 10_000 });
      // The unit answers CH 2's row and, linked, gives CH 1's the same.
      notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 1, value: 0x100000 }]);
      await vi.waitFor(async () => expect(await shownSafe("safe.ch1.name"), "CH 2's row on CH 1's").toEqual([true]));
    },
  );

  it(
    "takes a row pressed after a recall unlinks its pair and before the panel links it again as that row alone",
    SLOW,
    async () => {
      const { shell, reads } = await bootLinkUnit({
        [`${LINK}/0/0`]: 1,
        [`${LINK}/0/1`]: 1,
        [`${SELECT}/0/0`]: 0x100000,
        [`${SELECT}/0/1`]: 0x2,
      });
      onTestFinished(() => reads.releaseAll());
      await vi.waitFor(async () => expect(await shownLink("ch1")).toBe("STEREO"));
      // CH 1's row on Name, CH 2's on CH ON. A recall unlinks the pair unannounced; CH Level is pressed on
      // CH 2's row alone; then the panel links the pair again, putting CH 1's row on CH 2's. The recall's
      // read of the links is held, and the unit answers it after the panel link, linked.
      await unitSet(LINK, 0, 0);
      await unitSet(LINK, 1, 0);
      reads.hold({ late: true });
      notifyChannel(shell).onmessage([{ param_id: 0, x: -1, y: -1, value: 0 }]);
      await vi.waitFor(() => expect(reads.asked(), "the premise: the read is out").toBe(1), { timeout: 10_000 });
      await unitSet(SELECT, 1, 0x3);
      notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 1, value: 0x3 }]);
      await unitSet(LINK, 0, 1);
      await unitSet(LINK, 1, 1);
      notifyChannel(shell).onmessage([
        { param_id: LINK, x: 0, y: 0, value: 1 },
        { param_id: LINK, x: 0, y: 1, value: 1 },
      ]);
      reads.releaseAll();
      const rows = () =>
        shownSafe(
          "safe.ch1.name",
          "safe.ch1.chOn",
          "safe.ch1.chLevel",
          "safe.ch2.name",
          "safe.ch2.chOn",
          "safe.ch2.chLevel",
        );
      expect(await rows(), "the premise: the rows as they started").toEqual([true, false, false, false, true, false]);
      await vi.waitFor(async () =>
        expect(await rows(), "CH 1's row as it was, and on CH 2's").toEqual([true, false, false, true, false, false]),
      );
    },
  );

  it("keeps holding a recall's rows over a read that started before that recall", SLOW, async () => {
    const { shell, reads } = await bootLinkUnit({ [`${SELECT}/0/0`]: 0x100000 });
    onTestFinished(() => reads.releaseAll());
    await vi.waitFor(async () => expect(await shownSafe("safe.ch1.name")).toEqual([true]));
    // The scene the unit is on recalled again: its read is held.
    reads.hold();
    notifyChannel(shell).onmessage([{ param_id: 0, x: -1, y: -1, value: 0 }]);
    await vi.waitFor(() => expect(reads.asked(), "the premise: the first read is out").toBe(1), { timeout: 10_000 });
    // A second recall links CH 1/2 while that read is out; CH Level is pressed on CH 2's row.
    await unitSet(LINK, 0, 1);
    await unitSet(LINK, 1, 1);
    notifyChannel(shell).onmessage([{ param_id: 0, x: -1, y: -1, value: 0 }]);
    await unitSet(SELECT, 1, 0x1);
    notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 1, value: 0x1 }]);
    // The first read answers the pair unlinked, as the unit held it when asked: the press waits on.
    reads.releaseOne();
    await vi.waitFor(() => expect(reads.asked(), "the premise: the second recall's read is out").toBe(2), {
      timeout: 10_000,
    });
    expect(await shownSafe("safe.ch1.name", "safe.ch1.chLevel"), "nothing taken yet").toEqual([true, false]);
    reads.releaseAll();
    await vi.waitFor(async () =>
      expect(await shownSafe("safe.ch1.name", "safe.ch1.chLevel"), "CH 2's row on CH 1's").toEqual([false, true]),
    );
  });

  it(
    "makes a selection on the glass after a recall from the row with what the unit announced while the read was out",
    SLOW,
    async () => {
      const { shell, reads } = await bootLinkUnit({});
      onTestFinished(() => reads.releaseAll());
      reads.hold();
      notifyChannel(shell).onmessage([{ param_id: 0, x: -1, y: -1, value: 0 }]);
      await vi.waitFor(() => expect(reads.asked(), "the premise: the read is out").toBe(1), { timeout: 10_000 });
      // CH Level pressed on CH 2's row of the unlinked pair, then Name chosen on it on the glass.
      await unitSet(SELECT, 1, 0x1);
      notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 1, value: 0x1 }]);
      await transport().write("safe.ch2.name", true);
      reads.releaseAll();
      await vi.waitFor(() => expect(setsOf(shell, SELECT).at(-1), "CH Level kept").toEqual([1, 0x100001]), {
        timeout: 10_000,
      });
    },
  );

  it(
    "ends a pair on the link the latest recall left it with, over a link announced before that recall",
    SLOW,
    async () => {
      const { shell, reads } = await bootLinkUnit({});
      onTestFinished(() => reads.releaseAll());
      reads.hold();
      notifyChannel(shell).onmessage([{ param_id: 0, x: -1, y: -1, value: 0 }]);
      await vi.waitFor(() => expect(reads.asked(), "the premise: the read is out").toBe(1), { timeout: 10_000 });
      // CH 1/2 linked on the panel, then a second recall unlinks the pair unannounced.
      await unitSet(LINK, 0, 1);
      await unitSet(LINK, 1, 1);
      notifyChannel(shell).onmessage([{ param_id: LINK, x: 0, y: 0, value: 1 }]);
      await unitSet(LINK, 0, 0);
      await unitSet(LINK, 1, 0);
      notifyChannel(shell).onmessage([{ param_id: 0, x: -1, y: -1, value: 0 }]);
      reads.releaseAll();
      await vi.waitFor(async () => expect(await shownLink("ch1")).toBe("MONO x 2"), { timeout: 10_000 });
      await new Promise((r) => setTimeout(r, 500));
      // Name pressed on CH 2's row of the unlinked pair stays on it.
      await unitSet(SELECT, 1, 0x100000);
      notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 1, value: 0x100000 }]);
      await vi.waitFor(async () => expect(await shownSafe("safe.ch2.name")).toEqual([true]));
      expect(await shownSafe("safe.ch1.name"), "CH 1's row as it was").toEqual([false]);
    },
  );

  it("takes each row pressed between two recalls apart in time under the link its recall left", SLOW, async () => {
    const { shell, reads } = await bootLinkUnit({});
    onTestFinished(() => reads.releaseAll());
    reads.hold();
    // A recall links CH 1/2 and CH Level is pressed on CH 2's row; once that recall is taken, a second
    // recall unlinks the pair and Name is pressed on CH 2's row.
    await unitSet(LINK, 0, 1);
    await unitSet(LINK, 1, 1);
    notifyChannel(shell).onmessage([{ param_id: 0, x: -1, y: -1, value: 0 }]);
    await vi.waitFor(() => expect(reads.asked(), "the premise: the first recall's read is out").toBe(1));
    await unitSet(SELECT, 1, 0x1);
    notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 1, value: 0x1 }]);
    reads.releaseAll();
    await vi.waitFor(async () =>
      expect(await shownSafe("safe.ch1.chLevel"), "the first press on both rows").toEqual([true]),
    );
    await unitSet(LINK, 0, 0);
    await unitSet(LINK, 1, 0);
    notifyChannel(shell).onmessage([{ param_id: 0, x: -1, y: -1, value: 0 }]);
    await unitSet(SELECT, 1, 0x100001);
    notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 1, value: 0x100001 }]);
    await vi.waitFor(async () => expect(await shownSafe("safe.ch2.name")).toEqual([true]), { timeout: 10_000 });
    expect(await shownSafe("safe.ch1.name", "safe.ch1.chLevel"), "the second press on CH 2's alone").toEqual([
      false,
      true,
    ]);
  });

  it("puts no row on the other row for a recall a later recall may have overtaken", SLOW, async () => {
    const { shell, reads } = await bootLinkUnit({ [`${LINK}/0/0`]: 1, [`${LINK}/0/1`]: 1 });
    onTestFinished(() => reads.releaseAll());
    await vi.waitFor(async () => expect(await shownLink("ch1")).toBe("STEREO"));
    // A recall unlinks CH 1/2, and CH Level is pressed on CH 2's row alone. A second recall links the
    // pair again before the first recall's read reaches the unit, so that read answers linked; the
    // second recall's bulk notify comes after it.
    await unitSet(LINK, 0, 0);
    await unitSet(LINK, 1, 0);
    reads.hold({ late: true });
    notifyChannel(shell).onmessage([{ param_id: 0, x: -1, y: -1, value: 0 }]);
    await vi.waitFor(() => expect(reads.asked(), "the premise: the first recall's read is out").toBe(1));
    await unitSet(SELECT, 1, 0x1);
    notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 1, value: 0x1 }]);
    await unitSet(LINK, 0, 1);
    await unitSet(LINK, 1, 1);
    reads.releaseAll();
    await new Promise((r) => setTimeout(r, 50));
    notifyChannel(shell).onmessage([{ param_id: 0, x: -1, y: -1, value: 0 }]);
    await vi.waitFor(async () => expect(await shownSafe("safe.ch2.chLevel")).toEqual([true]), { timeout: 10_000 });
    expect(await shownSafe("safe.ch1.chLevel"), "not put on CH 1's row").toEqual([false]);
  });

  it("takes no link from a read of the unit that started before the latest recall", SLOW, async () => {
    const { shell, reads } = await bootLinkUnit({ [`${LINK}/0/0`]: 1, [`${LINK}/0/1`]: 1 });
    onTestFinished(() => reads.releaseAll());
    await vi.waitFor(async () => expect(await shownLink("ch1")).toBe("STEREO"));
    reads.hold();
    // The scene the unit is on recalled again: its read of the links, then the whole-unit read, held.
    notifyChannel(shell).onmessage([{ param_id: 0, x: -1, y: -1, value: 0 }]);
    await vi.waitFor(() => expect(reads.asked(), "the premise: both reads are out").toBe(2), { timeout: 10_000 });
    // A second recall unlinks the pair while they are out; its read of the links answers first.
    await unitSet(LINK, 0, 0);
    await unitSet(LINK, 1, 0);
    notifyChannel(shell).onmessage([{ param_id: 0, x: -1, y: -1, value: 0 }]);
    await vi.waitFor(() => expect(reads.asked(), "the premise: the second recall's read is out").toBe(3));
    reads.releaseOne();
    reads.releaseLast();
    // The whole-unit read answers the pair linked, as the unit held it when asked; the next one is held.
    reads.releaseOne();
    await vi.waitFor(() => expect(reads.asked(), "the premise: the next read is out").toBe(4), { timeout: 10_000 });
    // Name pressed on CH 2's row of the unlinked pair stays on it.
    await unitSet(SELECT, 1, 0x100000);
    notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 1, value: 0x100000 }]);
    await vi.waitFor(async () => expect(await shownSafe("safe.ch2.name")).toEqual([true]));
    expect(await shownSafe("safe.ch1.name"), "CH 1's row as it was").toEqual([false]);
    reads.releaseAll();
  });

  it(
    "takes a recall the unit announces while Live sync is starting, and writes from the glass after it",
    SLOW,
    async () => {
      const cmds = deviceCommands({ "plugin:dialog|message": "Ok", experimental_enabled: true }, {});
      const watch = cmds.vd_watch_link as (a: Record<string, unknown>) => unknown;
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let holding = false;
      cmds.vd_watch_link = (a: Record<string, unknown>) => {
        holding = true;
        return held.then(() => watch(a));
      };
      onTestFinished(() => release());
      const shell = (await bootApp({ tauri: cmds }))!;
      await openSim();
      // A recall on the unit while the session is starting: its bulk notify arrives once the follow is in.
      $("btn-live").click();
      await vi.waitFor(() => expect(holding, "the premise: the start is under way").toBe(true), { timeout: 25_000 });
      notifyChannel(shell).onmessage([{ param_id: 0, x: -1, y: -1, value: 0 }]);
      await new Promise((r) => setTimeout(r, 100));
      release();
      await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
      // The session's writes go out.
      await transport().write("safe.ch1.name", true);
      await vi.waitFor(() => expect(setsOf(shell, SELECT).at(-1)).toEqual([0, 0x100000]), { timeout: 10_000 });
      await transport().write("setup.brightness", 3);
      await vi.waitFor(() => expect(setsOf(shell, PARAMS.BRIGHTNESS.id).length).toBeGreaterThan(0), {
        timeout: 10_000,
      });
    },
  );

  it(
    "answers a recall's read of the links on the wire before disconnecting, and sends no more once the session has ended",
    SLOW,
    async () => {
      const { shell, reads } = await bootLinkUnit({});
      onTestFinished(() => reads.releaseAll());
      reads.hold();
      notifyChannel(shell).onmessage([{ param_id: 0, x: -1, y: -1, value: 0 }]);
      await vi.waitFor(() => expect(reads.asked(), "the premise: CH 1/2's read is out").toBe(1));
      const disconnects = shell.count("vd_disconnect");
      $("btn-live").click();
      await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("false"), { timeout: 10_000 });
      const pairReads = (): number =>
        shell.invokes.filter((c, i) => c === "vd_get" && shell.args[i]?.paramId === LINK && shell.args[i]?.y === 2)
          .length;
      const before = pairReads();
      // The link is held for the read on the wire, which is answered over it.
      await new Promise((r) => setTimeout(r, 300));
      expect(shell.count("vd_disconnect"), "not disconnected under the read").toBe(disconnects);
      reads.releaseAll();
      await vi.waitFor(() => expect(shell.count("vd_disconnect")).toBeGreaterThan(disconnects), { timeout: 10_000 });
      expect(pairReads(), "no read of CH 3/4's link after the session ended").toBe(before);
    },
  );

  it(
    "copies a first row as it was before this app's write when the unit links the pair ahead of the write's answer in a recall's stretch",
    SLOW,
    async () => {
      const { shell, reads } = await bootLinkUnit({});
      onTestFinished(() => reads.releaseAll());
      await transport().write("safe.ch1.name", true);
      await vi.waitFor(() => expect(setsOf(shell, SELECT).at(-1)).toEqual([0, 0x100000]), { timeout: 10_000 });
      // A recall, then the unit's panel links and unlinks the pair, then the write's answer: all held.
      reads.hold();
      notifyChannel(shell).onmessage([{ param_id: 0, x: -1, y: -1, value: 0 }]);
      await vi.waitFor(() => expect(reads.asked(), "the premise: the recall's read is out").toBe(1));
      notifyChannel(shell).onmessage([
        { param_id: LINK, x: 0, y: 0, value: 1 },
        { param_id: LINK, x: 0, y: 1, value: 1 },
      ]);
      notifyChannel(shell).onmessage([
        { param_id: LINK, x: 0, y: 0, value: 0 },
        { param_id: LINK, x: 0, y: 1, value: 0 },
      ]);
      notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 0, value: 0x100000 }]);
      await new Promise((r) => setTimeout(r, 1_500));
      reads.releaseAll();
      await vi.waitFor(async () => expect(await shownSafe("safe.ch1.name")).toEqual([true]), { timeout: 10_000 });
      expect(await shownSafe("safe.ch2.name"), "the copy made before the answer").toEqual([false]);
      await transport().write("safe.ch2.chOn", true);
      await vi.waitFor(() => expect(setsOf(shell, SELECT).at(-1)).toEqual([1, 0x2]), { timeout: 10_000 });
    },
  );

  it(
    "copies a first row as it was before this app's write when the write's answer lands in a recall's stretch while the row is read back",
    SLOW,
    async () => {
      const cmds = deviceCommands({ "plugin:dialog|message": "Ok", experimental_enabled: true }, {});
      const reads = heldLinkReads(cmds);
      const get = cmds.vd_get as (a: Record<string, unknown>) => unknown;
      let releaseRow!: () => void;
      const rowHeld = new Promise<void>((r) => (releaseRow = r));
      let holdRow = false;
      let rowAsked = false;
      cmds.vd_get = (a: Record<string, unknown>) => {
        if (!holdRow || a.paramId !== SELECT || a.y !== 0) return get(a);
        rowAsked = true;
        const value = get(a);
        return rowHeld.then(() => value);
      };
      onTestFinished(() => {
        releaseRow();
        reads.releaseAll();
      });
      const shell = (await bootApp({ tauri: cmds }))!;
      await openSim();
      await goLive();
      // Name chosen on CH 1's row; the unit takes the write unannounced, so the row is read back, held.
      holdRow = true;
      await transport().write("safe.ch1.name", true);
      await vi.waitFor(() => expect(rowAsked, "the premise: the row is read back").toBe(true), { timeout: 10_000 });
      // A recall, then the panel links and unlinks the pair, then the write's answer, while the read is out.
      reads.hold();
      notifyChannel(shell).onmessage([{ param_id: 0, x: -1, y: -1, value: 0 }]);
      await vi.waitFor(() => expect(reads.asked(), "the premise: the recall's read is out").toBe(1));
      notifyChannel(shell).onmessage([
        { param_id: LINK, x: 0, y: 0, value: 1 },
        { param_id: LINK, x: 0, y: 1, value: 1 },
      ]);
      notifyChannel(shell).onmessage([
        { param_id: LINK, x: 0, y: 0, value: 0 },
        { param_id: LINK, x: 0, y: 1, value: 0 },
      ]);
      notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 0, value: 0x100000 }]);
      releaseRow();
      await new Promise((r) => setTimeout(r, 100));
      reads.releaseAll();
      await vi.waitFor(async () => expect(await shownSafe("safe.ch1.name")).toEqual([true]), { timeout: 10_000 });
      expect(await shownSafe("safe.ch2.name"), "the copy made before the answer").toEqual([false]);
      await transport().write("safe.ch2.chOn", true);
      await vi.waitFor(() => expect(setsOf(shell, SELECT).at(-1)).toEqual([1, 0x2]), { timeout: 10_000 });
    },
  );

  it("keeps a pair's link the unit announced over a read the unit answered before it", SLOW, async () => {
    const { shell, reads } = await bootLinkUnit({ [`${SAFE}/0/0`]: 1, [`${SELECT}/0/0`]: 0x100000 });
    onTestFinished(() => reads.releaseAll());
    reads.hold();
    notifyChannel(shell).onmessage([{ param_id: 0, x: -1, y: -1, value: 0 }]);
    await vi.waitFor(() => expect(reads.asked(), "the premise: the read is out").toBe(1), { timeout: 10_000 });
    await unitSet(LINK, 0, 1);
    await unitSet(LINK, 1, 1);
    notifyChannel(shell).onmessage([{ param_id: LINK, x: 0, y: 0, value: 1 }]);
    // The read answers the pair unlinked, as the unit held it when asked; the link the unit announced
    // while it was out is taken once it is in, and the next read is held.
    reads.releaseOne();
    await vi.waitFor(async () => expect(await shownSafe("safe.ch2.on", "safe.ch2.name")).toEqual([true, true]), {
      timeout: 10_000,
    });
    await vi.waitFor(() => expect(reads.asked(), "the premise: the next read is out").toBe(2), { timeout: 10_000 });
    // CH Level pressed on CH 1's row: the unit, still linked, gives CH 2's row the same.
    await unitSet(SELECT, 0, 0x1);
    notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 0, value: 0x1 }]);
    await vi.waitFor(async () => expect(await shownSafe("safe.ch1.chLevel")).toEqual([true]));
    expect(await shownSafe("safe.ch2.chLevel", "safe.ch2.name"), "CH 1's row on CH 2's").toEqual([true, false]);
    reads.releaseAll();
  });

  it(
    "puts a selection this app wrote to a row of a linked pair on the other row once the unit takes it",
    SLOW,
    async () => {
      const shell = await bootDevice({ experimental_enabled: true }, true, { [`${LINK}/0/0`]: 1, [`${LINK}/0/1`]: 1 });
      await openSim();
      await goLive();
      await vi.waitFor(async () => expect(await shownLink("ch1")).toBe("STEREO"));
      await transport().write("safe.ch2.chLevel", true);
      await vi.waitFor(() => expect(setsOf(shell, SELECT)).toEqual([[1, 0x1]]), { timeout: 10_000 });
      // The unit answers CH 2's row alone and gives CH 1's the same.
      notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 1, value: 0x1 }]);
      await vi.waitFor(
        async () => expect(await shownSafe("safe.ch1.chLevel"), "CH 2's row on CH 1's").toEqual([true]),
        {
          timeout: 10_000,
        },
      );
    },
  );

  it("takes a row pressed on the unit right after its panel links the pair under that link", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true }, true, { [`${SELECT}/0/0`]: 0x1 });
    await openSim();
    await goLive();
    await vi.waitFor(async () => expect(await shownSafe("safe.ch1.chLevel")).toEqual([true]));
    // Linked on the panel, then Name pressed on CH 2's row, which then holds CH 1's CH Level: the unit
    // gives CH 1's row the same and announces CH 2's alone.
    await unitSet(LINK, 0, 1);
    await unitSet(LINK, 1, 1);
    await unitSet(SELECT, 1, 0x100001);
    notifyChannel(shell).onmessage([
      { param_id: LINK, x: 0, y: 0, value: 1 },
      { param_id: LINK, x: 0, y: 1, value: 1 },
      { param_id: SELECT, x: 0, y: 1, value: 0x100001 },
    ]);
    const rows = () => shownSafe("safe.ch1.name", "safe.ch1.chLevel", "safe.ch2.name", "safe.ch2.chLevel");
    await vi.waitFor(async () => expect(await rows()).toEqual([true, true, true, true]), { timeout: 10_000 });
    await vi.waitFor(async () => expect(await shownLink("ch1")).toBe("STEREO"), { timeout: 10_000 });
    expect(await rows(), "the same after the read").toEqual([true, true, true, true]);
  });

  it("takes a row pressed on the unit right after its panel unlinks the pair as that row alone", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true }, true, { [`${LINK}/0/0`]: 1, [`${LINK}/0/1`]: 1 });
    await openSim();
    await goLive();
    await vi.waitFor(async () => expect(await shownLink("ch1")).toBe("STEREO"));
    await unitSet(LINK, 0, 0);
    await unitSet(LINK, 1, 0);
    await unitSet(SELECT, 0, 0x100000);
    notifyChannel(shell).onmessage([
      { param_id: LINK, x: 0, y: 0, value: 0 },
      { param_id: LINK, x: 0, y: 1, value: 0 },
      { param_id: SELECT, x: 0, y: 0, value: 0x100000 },
    ]);
    await vi.waitFor(async () => expect(await shownSafe("safe.ch1.name")).toEqual([true]), { timeout: 10_000 });
    expect(await shownSafe("safe.ch2.name"), "CH 2's row as it was").toEqual([false]);
  });

  it(
    "puts a pair's first row on its second, and a row pressed on the unit on the other, as this app's link is answered",
    SLOW,
    async () => {
      const cmds = deviceCommands(
        { "plugin:dialog|message": "Ok", experimental_enabled: true },
        { [`${SAFE}/0/0`]: 1, [`${SELECT}/0/0`]: 0x1 },
      );
      const set = cmds.vd_set as (a: Record<string, unknown>) => unknown;
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let holding = false;
      cmds.vd_set = (a: Record<string, unknown>) => {
        set(a);
        if (a.paramId !== LINK || a.y !== 1) return undefined;
        holding = true;
        return held;
      };
      onTestFinished(() => release());
      const shell = (await bootApp({ tauri: cmds }))!;
      await openSim();
      await goLive();
      await transport().write("ch.ch1.signalType", "STEREO");
      await vi.waitFor(() => expect(holding, "the premise: the second write is out").toBe(true), { timeout: 10_000 });
      // The unit answers the first write.
      notifyChannel(shell).onmessage([{ param_id: LINK, x: 0, y: 0, value: 1 }]);
      // Name pressed on CH 2's row, which the link gave CH 1's [Safe] and CH Level: the unit gives CH 1's
      // row the same and announces CH 2's alone.
      await unitSet(SELECT, 1, 0x100001);
      notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 1, value: 0x100001 }]);
      const rows = () =>
        shownSafe("safe.ch1.name", "safe.ch1.chLevel", "safe.ch2.on", "safe.ch2.name", "safe.ch2.chLevel");
      await vi.waitFor(async () => expect(await rows()).toEqual([true, true, true, true, true]), { timeout: 10_000 });
      release();
      await vi.waitFor(
        () =>
          expect(setsOf(shell, LINK)).toEqual([
            [0, 1],
            [1, 1],
          ]),
        { timeout: 10_000 },
      );
      expect(await rows(), "the same once the write is done").toEqual([true, true, true, true, true]);
    },
  );

  it(
    "puts the unit's answer to this app's write on the other row before a press the unit announces after it",
    SLOW,
    async () => {
      const shell = await bootDevice({ experimental_enabled: true }, true, { [`${LINK}/0/0`]: 1, [`${LINK}/0/1`]: 1 });
      await openSim();
      await goLive();
      await vi.waitFor(async () => expect(await shownLink("ch1")).toBe("STEREO"));
      await transport().write("safe.ch1.name", true);
      await vi.waitFor(() => expect(setsOf(shell, SELECT)).toEqual([[0, 0x100000]]), { timeout: 10_000 });
      // The unit answers CH 1's row, giving CH 2's the same, then CH Level is pressed on CH 2's row,
      // which the unit gives CH 1's too: both announced in one burst.
      await unitSet(SELECT, 1, 0x100001);
      notifyChannel(shell).onmessage([
        { param_id: SELECT, x: 0, y: 0, value: 0x100000 },
        { param_id: SELECT, x: 0, y: 1, value: 0x100001 },
      ]);
      const rows = () => shownSafe("safe.ch1.name", "safe.ch1.chLevel", "safe.ch2.name", "safe.ch2.chLevel");
      await vi.waitFor(async () => expect(await rows()).toEqual([true, true, true, true]), { timeout: 10_000 });
      // The write has finished; the press is still on both rows, and in the next write.
      await new Promise((r) => setTimeout(r, 1_500));
      expect(await rows(), "the press kept once the write is done").toEqual([true, true, true, true]);
      // The next write from the glass carries the press (the case's own unit value is set through the
      // same command, so the write is the last one).
      await transport().write("safe.ch2.chOn", true);
      await vi.waitFor(() => expect(setsOf(shell, SELECT).at(-1)).toEqual([1, 0x100003]), { timeout: 10_000 });
    },
  );

  it(
    "copies a first row as the unit holds it when a link comes while this app's write to it is out, and keeps no write the lock refused",
    SLOW,
    async () => {
      const cmds = deviceCommands(
        { "plugin:dialog|message": "Ok", experimental_enabled: true },
        { [`${SELECT}/0/0`]: 0x1 },
      );
      const set = cmds.vd_set as (a: Record<string, unknown>) => unknown;
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let holding = false;
      cmds.vd_set = (a: Record<string, unknown>) => {
        if (a.paramId !== SELECT || a.y !== 0) return set(a);
        holding = true;
        return held.then(() => {
          throw consoleLockAbort();
        });
      };
      onTestFinished(() => release());
      const shell = (await bootApp({ tauri: cmds }))!;
      await openSim();
      await goLive();
      await vi.waitFor(async () => expect(await shownSafe("safe.ch1.chLevel")).toEqual([true]));
      await transport().write("safe.ch1.name", true);
      await vi.waitFor(() => expect(holding, "the premise: the write is out").toBe(true), { timeout: 10_000 });
      // CH 1/2 linked on the unit's panel while CH 1's write is out: the unit copies CH 1's row as it holds it.
      await unitSet(LINK, 0, 1);
      await unitSet(LINK, 1, 1);
      notifyChannel(shell).onmessage([{ param_id: LINK, x: 0, y: 0, value: 1 }]);
      await vi.waitFor(async () => expect(await shownSafe("safe.ch2.chLevel")).toEqual([true]), { timeout: 10_000 });
      expect(await shownSafe("safe.ch2.name"), "not the selection on its way").toEqual([false]);
      // The lock refuses the write: neither row keeps it.
      release();
      await vi.waitFor(() => expect(statusText()).toBe(t().status.consoleLockedNotSent), { timeout: 10_000 });
      await vi.waitFor(async () =>
        expect(await shownSafe("safe.ch1.name", "safe.ch1.chLevel", "safe.ch2.name", "safe.ch2.chLevel")).toEqual([
          false,
          true,
          false,
          true,
        ]),
      );
    },
  );

  it(
    "keeps the copy a link put on a row whose write is out when the unit leaves the write unannounced",
    SLOW,
    async () => {
      const cmds = deviceCommands(
        { "plugin:dialog|message": "Ok", experimental_enabled: true },
        { [`${SELECT}/0/0`]: 0x1, [`${SELECT}/0/1`]: 0x2 },
      );
      const set = cmds.vd_set as (a: Record<string, unknown>) => unknown;
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let holding = false;
      // CH 2's write is answered 200, not taken and not announced.
      cmds.vd_set = (a: Record<string, unknown>) => {
        if (a.paramId !== SELECT || a.y !== 1) return set(a);
        holding = true;
        return held.then(() => undefined);
      };
      onTestFinished(() => release());
      const shell = (await bootApp({ tauri: cmds }))!;
      await openSim();
      await goLive();
      await vi.waitFor(async () => expect(await shownSafe("safe.ch2.chOn")).toEqual([true]));
      await transport().write("safe.ch2.name", true);
      await vi.waitFor(() => expect(holding, "the premise: the write is out").toBe(true), { timeout: 10_000 });
      await unitSet(LINK, 0, 1);
      await unitSet(LINK, 1, 1);
      notifyChannel(shell).onmessage([{ param_id: LINK, x: 0, y: 0, value: 1 }]);
      await vi.waitFor(async () => expect(await shownSafe("safe.ch2.chLevel")).toEqual([true]), { timeout: 10_000 });
      const rowReads = (): number =>
        shell.invokes.filter((c, i) => c === "vd_get" && shell.args[i]?.paramId === SELECT && shell.args[i]?.y === 1)
          .length;
      const before = rowReads();
      release();
      await vi.waitFor(() => expect(rowReads(), "the premise: the row read back").toBeGreaterThan(before), {
        timeout: 10_000,
      });
      // The read answers the row before the copy; the copy is kept.
      await new Promise((r) => setTimeout(r, 300));
      expect(await shownSafe("safe.ch2.chLevel", "safe.ch2.chOn", "safe.ch2.name"), "CH 1's row on CH 2's").toEqual([
        true,
        false,
        false,
      ]);
    },
  );

  it(
    "puts a pair's first row on its second when the panel links again a pair a recall unlinked, before the read",
    SLOW,
    async () => {
      const { shell, reads } = await bootLinkUnit({
        [`${LINK}/0/0`]: 1,
        [`${LINK}/0/1`]: 1,
        [`${SAFE}/0/0`]: 1,
        [`${SELECT}/0/0`]: 0x100000,
      });
      onTestFinished(() => reads.releaseAll());
      await vi.waitFor(async () => expect(await shownLink("ch1")).toBe("STEREO"));
      expect(await shownSafe("safe.ch2.on", "safe.ch2.name")).toEqual([false, false]);
      // A recall unlinks the pair, announcing only the bulk change, and the read it starts is held.
      await unitSet(LINK, 0, 0);
      await unitSet(LINK, 1, 0);
      reads.hold();
      notifyChannel(shell).onmessage([{ param_id: 0, x: -1, y: -1, value: 0 }]);
      await vi.waitFor(() => expect(reads.asked(), "the premise: the read is out").toBe(1), { timeout: 10_000 });
      // The panel links the pair again before that read answers.
      await unitSet(LINK, 0, 1);
      await unitSet(LINK, 1, 1);
      notifyChannel(shell).onmessage([
        { param_id: LINK, x: 0, y: 0, value: 1 },
        { param_id: LINK, x: 0, y: 1, value: 1 },
      ]);
      // Taken once the read the recall started is in.
      reads.releaseAll();
      await vi.waitFor(async () => expect(await shownSafe("safe.ch2.on", "safe.ch2.name")).toEqual([true, true]), {
        timeout: 10_000,
      });
    },
  );

  it(
    "keeps the copy a second link puts on a row whose write the lock then refuses, not the row the write started from",
    SLOW,
    async () => {
      const cmds = deviceCommands(
        { "plugin:dialog|message": "Ok", experimental_enabled: true },
        { [`${SAFE}/0/0`]: 1, [`${SELECT}/0/0`]: 0x100000 },
      );
      const set = cmds.vd_set as (a: Record<string, unknown>) => unknown;
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let holding = false;
      cmds.vd_set = (a: Record<string, unknown>) => {
        if (a.paramId !== SELECT || a.y !== 1) return set(a);
        holding = true;
        return held.then(() => {
          throw consoleLockAbort();
        });
      };
      onTestFinished(() => release());
      const shell = (await bootApp({ tauri: cmds }))!;
      await openSim();
      await goLive();
      const link = async (on: number): Promise<void> => {
        await unitSet(LINK, 0, on);
        await unitSet(LINK, 1, on);
        notifyChannel(shell).onmessage([{ param_id: LINK, x: 0, y: 0, value: on }]);
      };
      // Linked and unlinked on the panel: CH 2's row holds CH 1's, [Safe] and Name.
      await link(1);
      await vi.waitFor(async () => expect(await shownSafe("safe.ch2.name")).toEqual([true]), { timeout: 10_000 });
      await link(0);
      // CH ON pressed on CH 1's row of the unlinked pair, then CH Level chosen on CH 2's on the glass.
      await unitSet(SELECT, 0, 0x100002);
      notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 0, value: 0x100002 }]);
      await vi.waitFor(async () => expect(await shownSafe("safe.ch1.chOn")).toEqual([true]));
      await transport().write("safe.ch2.chLevel", true);
      await vi.waitFor(() => expect(holding, "the premise: the write is out").toBe(true), { timeout: 10_000 });
      // Linked on the panel again while that write is out: CH 1's row, CH ON with it, goes on CH 2's.
      await link(1);
      await vi.waitFor(async () => expect(await shownSafe("safe.ch2.chOn")).toEqual([true]), { timeout: 10_000 });
      release();
      await vi.waitFor(() => expect(statusText()).toBe(t().status.consoleLockedNotSent), { timeout: 10_000 });
      await new Promise((r) => setTimeout(r, 300));
      expect(
        await shownSafe("safe.ch2.on", "safe.ch2.name", "safe.ch2.chOn", "safe.ch2.chLevel"),
        "the second link's copy",
      ).toEqual([true, true, true, false]);
    },
  );

  it(
    "copies a first row the unit changed while this app's write to it was out, and keeps it when the lock refuses the write",
    SLOW,
    async () => {
      const cmds = deviceCommands({ "plugin:dialog|message": "Ok", experimental_enabled: true }, {});
      const set = cmds.vd_set as (a: Record<string, unknown>) => unknown;
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let holding = false;
      cmds.vd_set = (a: Record<string, unknown>) => {
        if (a.paramId !== SELECT || a.y !== 0) return set(a);
        holding = true;
        return held.then(() => {
          throw consoleLockAbort();
        });
      };
      onTestFinished(() => release());
      const shell = (await bootApp({ tauri: cmds }))!;
      await openSim();
      await goLive();
      await transport().write("safe.ch1.name", true);
      await vi.waitFor(() => expect(holding, "the premise: the write is out").toBe(true), { timeout: 10_000 });
      // CH Level pressed on CH 1's row while the write is out, then CH 1/2 linked on the panel.
      set({ paramId: SELECT, x: 0, y: 0, value: 0x1 });
      notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 0, value: 0x1 }]);
      await unitSet(LINK, 0, 1);
      await unitSet(LINK, 1, 1);
      notifyChannel(shell).onmessage([{ param_id: LINK, x: 0, y: 0, value: 1 }]);
      await vi.waitFor(async () => expect(await shownSafe("safe.ch2.chLevel")).toEqual([true]), { timeout: 10_000 });
      release();
      await vi.waitFor(() => expect(statusText()).toBe(t().status.consoleLockedNotSent), { timeout: 10_000 });
      await new Promise((r) => setTimeout(r, 300));
      expect(await shownSafe("safe.ch1.chLevel", "safe.ch1.name", "safe.ch2.chLevel", "safe.ch2.name")).toEqual([
        true,
        false,
        true,
        false,
      ]);
    },
  );

  it(
    "takes the unit's answer to this app's write after a press the unit announced on the other row while the write was out",
    SLOW,
    async () => {
      const cmds = deviceCommands(
        { "plugin:dialog|message": "Ok", experimental_enabled: true },
        { [`${LINK}/0/0`]: 1, [`${LINK}/0/1`]: 1 },
      );
      const set = cmds.vd_set as (a: Record<string, unknown>) => unknown;
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let holding = false;
      cmds.vd_set = (a: Record<string, unknown>) => {
        if (a.paramId !== SELECT || a.y !== 0) return set(a);
        holding = true;
        return held.then(() => set(a));
      };
      onTestFinished(() => release());
      const shell = (await bootApp({ tauri: cmds }))!;
      await openSim();
      await goLive();
      await vi.waitFor(async () => expect(await shownLink("ch1")).toBe("STEREO"));
      await transport().write("safe.ch1.name", true);
      await vi.waitFor(() => expect(holding, "the premise: the write is out").toBe(true), { timeout: 10_000 });
      // CH Level pressed on CH 2's row: the unit gives CH 1's the same. Then the write lands, the unit
      // gives CH 2's row CH 1's, and announces CH 1's.
      await unitSet(SELECT, 1, 0x1);
      notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 1, value: 0x1 }]);
      release();
      await vi.waitFor(() => expect(setsOf(shell, SELECT).some(([y, v]) => y === 0 && v === 0x100000)).toBe(true), {
        timeout: 10_000,
      });
      notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 0, value: 0x100000 }]);
      const rows = () => shownSafe("safe.ch1.name", "safe.ch1.chLevel", "safe.ch2.name", "safe.ch2.chLevel");
      await vi.waitFor(async () => expect(await rows()).toEqual([true, false, true, false]), { timeout: 10_000 });
      await transport().write("safe.ch2.chOn", true);
      await vi.waitFor(() => expect(setsOf(shell, SELECT).at(-1)).toEqual([1, 0x100002]), { timeout: 10_000 });
    },
  );

  it("keeps the row a link copied when Console Lock refuses a press written to it", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true }, true, {
      [`${SAFE}/0/0`]: 1,
      [`${SELECT}/0/0`]: 0x100000,
    });
    await openSim();
    await goLive();
    await unitSet(LINK, 0, 1);
    await unitSet(LINK, 1, 1);
    notifyChannel(shell).onmessage([{ param_id: LINK, x: 0, y: 0, value: 1 }]);
    await vi.waitFor(async () => expect(await shownSafe("safe.ch2.on", "safe.ch2.name")).toEqual([true, true]), {
      timeout: 10_000,
    });
    const rowReads = (): number =>
      shell.invokes.filter((c, i) => c === "vd_get" && shell.args[i]?.paramId === SELECT && shell.args[i]?.y === 1)
        .length;
    const before = rowReads();
    shell.failOnce("vd_set", consoleLockAbort());
    await transport().write("safe.ch2.chOn", true);
    await vi.waitFor(() => expect(statusText()).toBe(t().status.consoleLockedNotSent), { timeout: 10_000 });
    await vi.waitFor(() => expect(rowReads(), "the premise: RECALL SAFE read again").toBeGreaterThan(before), {
      timeout: 10_000,
    });
    expect(await shownSafe("safe.ch2.name", "safe.ch2.chOn"), "the copy kept, the press not").toEqual([true, false]);
  });

  it(
    "keeps the row a link put on a pair's second row over a read of RECALL SAFE, which answers the row as it was",
    SLOW,
    async () => {
      const shell = await bootDevice({ experimental_enabled: true }, true, {
        [`${SAFE}/0/0`]: 1,
        [`${SELECT}/0/0`]: 0x100000,
      });
      await openSim();
      await goLive();
      await unitSet(LINK, 0, 1);
      await unitSet(LINK, 1, 1);
      notifyChannel(shell).onmessage([{ param_id: LINK, x: 0, y: 0, value: 1 }]);
      await vi.waitFor(async () => expect(await shownSafe("safe.ch2.on", "safe.ch2.name")).toEqual([true, true]), {
        timeout: 10_000,
      });
      // A selection Console Lock stops sends RECALL SAFE to be read again, and the unit's read of CH 2's
      // row still answers what the row held before the link.
      const rowReads = (): number =>
        shell.invokes.filter((c, i) => c === "vd_get" && shell.args[i]?.paramId === SAFE && shell.args[i]?.y === 1)
          .length;
      const before = rowReads();
      shell.failOnce("vd_set", consoleLockAbort());
      await transport().write("safe.ch3.chOn", true);
      await vi.waitFor(() => expect(rowReads(), "the premise: RECALL SAFE read again").toBeGreaterThan(before), {
        timeout: 10_000,
      });
      await vi.waitFor(() => expect(statusText()).toBe(t().status.consoleLockedNotSent));
      expect(await shownSafe("safe.ch2.on", "safe.ch2.name")).toEqual([true, true]);
    },
  );

  it("puts a pair's first RECALL SAFE row on its second when this app links the pair", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true }, true, {
      [`${SAFE}/0/0`]: 1,
      [`${SELECT}/0/0`]: 0x100000,
    });
    await openSim();
    await goLive();
    await vi.waitFor(async () => expect(await shownSafe("safe.ch2.on", "safe.ch2.name")).toEqual([false, false]));
    await transport().write("ch.ch1.signalType", "STEREO");
    await vi.waitFor(
      () =>
        expect(setsOf(shell, LINK)).toEqual([
          [0, 1],
          [1, 1],
        ]),
      { timeout: 10_000 },
    );
    // The unit answers the link at both channels.
    notifyChannel(shell).onmessage([
      { param_id: LINK, x: 0, y: 0, value: 1 },
      { param_id: LINK, x: 0, y: 1, value: 1 },
    ]);
    await vi.waitFor(async () => expect(await shownSafe("safe.ch2.on", "safe.ch2.name")).toEqual([true, true]), {
      timeout: 10_000,
    });
  });

  it(
    "puts a RECALL SAFE row pressed on the unit on the other row of a linked pair, which the unit leaves unannounced",
    SLOW,
    async () => {
      const shell = await bootDevice({ experimental_enabled: true }, true, { [`${LINK}/0/0`]: 1, [`${LINK}/0/1`]: 1 });
      await openSim();
      await goLive();
      await vi.waitFor(async () => expect(await shownLink("ch1")).toBe("STEREO"));
      // Name pressed on CH 2's row: the unit gives CH 1's row the same and announces CH 2's alone, its
      // read of CH 1's row still answering what that row held.
      await unitSet(SELECT, 1, 0x100000);
      notifyChannel(shell).onmessage([{ param_id: SELECT, x: 0, y: 1, value: 0x100000 }]);
      await vi.waitFor(async () => expect(await shownSafe("safe.ch1.name", "safe.ch2.name")).toEqual([true, true]));
      // A selection Console Lock stops sends RECALL SAFE to be read again, and CH 1's row is kept.
      const rowReads = (): number =>
        shell.invokes.filter((c, i) => c === "vd_get" && shell.args[i]?.paramId === SELECT && shell.args[i]?.y === 0)
          .length;
      const before = rowReads();
      shell.failOnce("vd_set", consoleLockAbort());
      await transport().write("safe.ch3.chOn", true);
      await vi.waitFor(() => expect(rowReads(), "the premise: RECALL SAFE read again").toBeGreaterThan(before), {
        timeout: 10_000,
      });
      await vi.waitFor(() => expect(statusText()).toBe(t().status.consoleLockedNotSent));
      expect(await shownSafe("safe.ch1.name")).toEqual([true]);
    },
  );

  // A unit whose RECALL SAFE a case moves as the unit's panel does: the value set and, unless told
  // otherwise, announced.
  const panelUnit = () => {
    const cmds = deviceCommands({ "plugin:dialog|message": "Ok", experimental_enabled: true });
    const set = cmds.vd_set as (a: Record<string, unknown>) => unknown;
    const get = cmds.vd_get as (a: Record<string, unknown>) => unknown;
    let shell: TauriShell | null = null;
    const press = (paramId: number, value: number, announce = true): void => {
      set({ paramId, x: 0, y: 0, value });
      if (announce && shell) notifyChannel(shell).onmessage([{ param_id: paramId, x: 0, y: 0, value }]);
    };
    const boot = async (): Promise<TauriShell> => {
      shell = (await bootApp({ tauri: cmds }))!;
      await openSim();
      await goLive();
      return shell;
    };
    return { cmds, set, get, press, boot };
  };

  it(
    "keeps a RECALL SAFE column pressed on the unit while a selection made on the glass waits for its turn",
    SLOW,
    async () => {
      const unit = panelUnit();
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let holding = false;
      unit.cmds.vd_set = (a: Record<string, unknown>) => {
        unit.set(a);
        if (a.paramId !== PARAMS.BRIGHTNESS.id) return undefined;
        holding = true;
        return held;
      };
      const shell = await unit.boot();
      // A SETUP write the unit has not answered holds every unit write queued behind it.
      await transport().write("setup.brightness", 3);
      await vi.waitFor(() => expect(holding, "the premise: the SETUP write is out").toBe(true));
      await transport().write("safe.ch1.name", true);
      unit.press(SELECT, 0x2);
      await vi.waitFor(async () =>
        expect(await shownSafe("safe.ch1.name", "safe.ch1.chOn"), "the glass's choice over the unit's").toEqual([
          true,
          true,
        ]),
      );
      expect(setsOf(shell, SELECT), "nothing written yet").toEqual([]);
      release();
      await vi.waitFor(() => expect(setsOf(shell, SELECT)).toEqual([[0, 0x100002]]), { timeout: 10_000 });
      expect(await shownSafe("safe.ch1.name", "safe.ch1.chOn")).toEqual([true, true]);
    },
  );

  it("shows a selection made on the glass before the session's second read of RECALL SAFE", SLOW, async () => {
    const unit = panelUnit();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let integrationReads = 0;
    let rowReads = 0;
    unit.cmds.vd_get = (a: Record<string, unknown>) => {
      const answer = unit.get(a);
      if (a.paramId === SELECT && a.y === 0) rowReads++;
      // The second read of Software Integration runs just before RECALL SAFE's.
      if (a.paramId === PARAMS.DAW_INTEGRATION.id && ++integrationReads === 2) return held.then(() => answer);
      return answer;
    };
    const shell = await unit.boot();
    await vi.waitFor(() => expect(integrationReads, "the premise: the reads behind it wait").toBe(2));
    expect(rowReads, "only the starting read of the row").toBe(1);
    await transport().write("safe.ch1.name", true);
    release();
    await vi.waitFor(() => expect(setsOf(shell, SELECT)).toEqual([[0, 0x100000]]), { timeout: 10_000 });
    expect(rowReads, "the second read ran before the write").toBe(2);
    expect(await shownSafe("safe.ch1.name")).toEqual([true]);
  });

  it("takes the second read's selection for a row whose [Safe] the unit announced while it was out", SLOW, async () => {
    const unit = panelUnit();
    // CH ON pressed on the unit between the starting read and the registration, announced to nobody.
    const subscribe = unit.cmds.vd_params_subscribe as (a: Record<string, unknown>) => unknown;
    let moved = false;
    unit.cmds.vd_params_subscribe = (a: Record<string, unknown>) => {
      if (!moved) {
        moved = true;
        unit.press(SELECT, 0x2, false);
      }
      return subscribe(a);
    };
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let reads = 0;
    unit.cmds.vd_get = (a: Record<string, unknown>) => {
      const answer = unit.get(a);
      if (a.paramId === SELECT && a.y === 0 && ++reads === 2) return held.then(() => answer);
      return answer;
    };
    const shell = await unit.boot();
    await vi.waitFor(() => expect(reads, "the premise: the second read is out").toBe(2), { timeout: 10_000 });
    unit.press(SAFE, 1);
    release();
    // A SETUP write queues behind the read, so its arrival says the read has been taken.
    await transport().write("setup.brightness", 3);
    await vi.waitFor(() => expect(setsOf(shell, PARAMS.BRIGHTNESS.id)).toEqual([[0, 3]]), { timeout: 10_000 });
    expect(await shownSafe("safe.ch1.on", "safe.ch1.chOn"), "[Safe] as announced, CH ON as read").toEqual([true, true]);
  });

  it("ends the session when a RECALL SAFE selection written from the glass is refused", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true });
    await openSim();
    await goLive();
    shell.failOnce("vd_set", new Error("selection write refused"));
    await transport().write("safe.ch1.name", true);
    await invoked(shell, "vd_disconnect");
    expect(errors(shell).join(" "), "the refused write is what ended it").toContain("selection write refused");
  });

  it("ends the session when a delay time turned under tempo Sync is refused", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true }, true, {
      [`${PARAMS.FX_EFFECT_TYPE.id}/0/0`]: 1024,
      [`681/0/4`]: 1,
      [`681/0/6`]: 5000,
    });
    await openSim();
    await goLive();
    shell.failOnce("vd_set", new Error("delay write refused"));
    await transport().write("ch.fx1.effect.delay", 250);
    await invoked(shell, "vd_disconnect");
    expect(errors(shell).join(" "), "the refused write is what ended it").toContain("delay write refused");
  });

  it("takes a Follow USB press on the glass as a press of the toolbar's FOLLOW USB", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true }, true, { [`${PARAMS.FOLLOW_USB.id}/0/0`]: 1 });
    await openSim();
    const badge = $("follow-usb");
    expect(badge.dataset.state).toBe("unknown");
    expect((await transport().snapshot()).get("setup.followUsb"), "off until the unit's is read").toBe(false);
    await transport().write("setup.followUsb", false);
    await vi.waitFor(() => expect(badge.dataset.state, "unknown: the press reads the unit").toBe("on"));
    expect(setsOf(shell, PARAMS.FOLLOW_USB.id)).toEqual([]);
    await vi.waitFor(async () => expect((await transport().snapshot()).get("setup.followUsb")).toBe(true));
    await transport().write("setup.followUsb", false);
    await vi.waitFor(() => expect(badge.dataset.state).toBe("off"));
    expect(setsOf(shell, PARAMS.FOLLOW_USB.id)).toEqual([[0, 0]]);
  });

  // The glass keeps the plan's rate until the operator answers, so the write itself is refused.
  it("asks before a rate chosen on the glass during Live sync, and writes it once agreed", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true }, true, {
      [`${PARAMS.SAMPLE_RATE.id}/0/0`]: 48_000,
      [FOLLOW_USB_SEED]: 0,
      [TRACK_COUNT_SEED]: 8,
    });
    await openSim();
    await goLive();
    await expect(transport().write("setup.samplingFrequency", 96_000)).rejects.toThrow("refused");
    await vi.waitFor(() => expect(setsOf(shell, PARAMS.SAMPLE_RATE.id)).toEqual([[0, 96_000]]), { timeout: 10_000 });
    expect(confirms(shell)).toHaveLength(1);
    expect($<HTMLSelectElement>("rate-picker").value).toBe("96000");
  });

  it("names a unit operation the glass refuses on the status line", SLOW, async () => {
    await bootDevice({ experimental_enabled: true });
    simRefused.hook = null;
    await openSim();
    expect(simRefused.hook, "the premise: the mount handed the simulator a refused-action hook").not.toBeNull();
    simRefused.hook!({ kind: "scene.recall" });
    expect(statusText()).toBe(t().status.simUnitAction);
  });

  it("ends the session when the unit refuses a [Sends] destination chosen on the LCD", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true }, true, { [`${PARAMS.SENDS_TARGET.id}/0/0`]: 0 });
    await openSim();
    await goLive();
    await drainShell(shell, () => false);
    shell.answer("vd_set", (a: Record<string, unknown>) => {
      if (a.paramId === PARAMS.SENDS_TARGET.id) throw new Error("refused");
    });
    glass()!.querySelector(".sends-target")!.closest("button")!.click();
    await vi.waitFor(() =>
      expect(glass()?.querySelector('.lcd[data-screen="sends-select"]:not([inert])')).toBeTruthy(),
    );
    const mix2 = [...glass()!.querySelectorAll<HTMLButtonElement>('.lcd[data-screen="sends-select"] button')].find(
      (b) => b.textContent?.trim() === "MIX 2",
    )!;
    mix2.click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("false"), { timeout: 10_000 });
    expect(errors(shell).join(" "), "the refused write is what ended it").toContain("refused");
    await invoked(shell, "vd_disconnect");
  });
});

describe("HOME's [Sends] destination", () => {
  const SENDS = `${PARAMS.SENDS_TARGET.id}/0/0`;
  const sendsReads = (shell: TauriShell): number =>
    shell.invokes.filter((cmd, i) => cmd === "vd_get" && shell.args[i]?.paramId === PARAMS.SENDS_TARGET.id).length;
  const goLive = async (): Promise<void> => {
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
  };
  const rateNotify = (shell: TauriShell, hz: number): void =>
    notifyChannel(shell).onmessage([{ param_id: PARAMS.SAMPLE_RATE.id, x: 0, y: 0, value: hz }]);

  // The SIM view shows it, so an experimental launch reads it and no other launch does.
  it("is neither read nor registered without an experimental launch", SLOW, async () => {
    const shell = await bootDevice({}, true, { [SENDS]: 17 });
    await goLive();
    const { addrs } = shell.args[shell.invokes.indexOf("vd_params_subscribe")] as { addrs: number[][] };
    expect(addrs).not.toContainEqual([PARAMS.SENDS_TARGET.id, 0, 0]);
    rateNotify(shell, 192000);
    await drainShell(shell, () => false);
    expect(sendsReads(shell)).toBe(0);
    $("btn-live").click();
    await invoked(shell, "vd_disconnect");
  });

  it("is read at live start and registered for its notify on an experimental launch", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true }, true, { [SENDS]: 17 });
    await goLive();
    const { addrs } = shell.args[shell.invokes.indexOf("vd_params_subscribe")] as { addrs: number[][] };
    expect(addrs, "the session registers the destination").toContainEqual([PARAMS.SENDS_TARGET.id, 0, 0]);
    expect(sendsReads(shell)).toBeGreaterThan(0);
    $("btn-live").click();
    await invoked(shell, "vd_disconnect");
  });

  // The unit moves FX 2 to FX 1 above 96 kHz and announces nothing, so an announced rate above
  // 96 kHz is followed by a read of the destination; one at or below it is not.
  it("is read again after the unit announces a rate above 96 kHz, and not after one at 96 kHz", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true }, true, { [SENDS]: 17 });
    await goLive();
    await drainShell(shell, () => false);
    // Advance the app's timers while keeping the positive control and the relative observation window.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const drain = async (): Promise<void> => {
        let done = false;
        let failure: unknown;
        const pending = drainShell(shell, () => false).then(
          () => {
            done = true;
          },
          (error: unknown) => {
            failure = error;
            done = true;
          },
        );
        for (let i = 0; i < 1000 && !done; i++) await vi.advanceTimersToNextTimerAsync();
        expect(done, "the shell reaches its quiet window").toBe(true);
        await pending;
        if (failure !== undefined) throw failure;
      };
      const before = sendsReads(shell);
      const sent = Date.now();
      rateNotify(shell, 192000);
      for (let i = 0; i < 1000 && sendsReads(shell) === before; i++) await vi.advanceTimersToNextTimerAsync();
      expect(sendsReads(shell), "a read follows the high-rate notify").toBe(before + 1);
      const took = Date.now() - sent;
      expect(took, "the positive control advances the clock").toBeGreaterThan(0);
      await drain();
      const after = sendsReads(shell);
      rateNotify(shell, 96000);
      await vi.advanceTimersByTimeAsync(took * 3);
      await drain();
      expect(sendsReads(shell), "no read for a rate at 96 kHz").toBe(after);
    } finally {
      vi.useRealTimers();
    }
    $("btn-live").click();
    await invoked(shell, "vd_disconnect");
  });

  // A read that fails ends the session, as every other failed read on the device link does.
  it("ends the session when the read after a rate above 96 kHz fails", SLOW, async () => {
    // Every other address answers what the unit holds, so the read of 763 is the one that fails.
    let refuse = false;
    const shell = await bootDevice({
      experimental_enabled: true,
      vd_get: (a: Record<string, unknown>) => {
        if (a.paramId !== PARAMS.SENDS_TARGET.id) return unwrittenRead(a);
        if (refuse) throw new Error("timeout");
        return 17;
      },
    });
    await goLive();
    await drainShell(shell, () => false);
    refuse = true;
    rateNotify(shell, 192000);
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("false"), { timeout: 10_000 });
    expect(errors(shell).join(" "), "the failed read is what ended it").toContain("timeout");
    await invoked(shell, "vd_disconnect");
  });
});
