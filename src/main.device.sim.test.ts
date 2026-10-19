// @vitest-environment jsdom

// The SIM view and the unit state it shows: the LCD selection and HOME's [Sends] destination.
//
// The setup, the teardown and the helpers every desktop case shares are `main.device.test-util.ts`'s,
// which also states what the device table does and does not model.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { $, bootApp, deviceCommands, statusText, unwrittenRead } from "./main.test-util";
import type { TauriShell } from "./main.test-util";
import { PARAMS } from "./core/control/params";
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
    // The positive control, which also times how long the read takes to follow the notify.
    const before = sendsReads(shell);
    const sent = Date.now();
    rateNotify(shell, 192000);
    await vi.waitFor(() => expect(sendsReads(shell)).toBe(before + 1), { timeout: 10_000 });
    const took = Date.now() - sent;
    await drainShell(shell, () => false);
    // A rate at 96 kHz, given three times as long as the read above took to arrive.
    const after = sendsReads(shell);
    rateNotify(shell, 96000);
    await new Promise((r) => setTimeout(r, took * 3));
    await drainShell(shell, () => false);
    expect(sendsReads(shell), "no read for a rate at 96 kHz").toBe(after);
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
