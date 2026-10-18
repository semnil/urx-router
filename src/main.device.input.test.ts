// @vitest-environment jsdom

// The input stage: Clip Safe, +48V and Hi-Z.
//
// The setup, the teardown and the helpers every desktop case shares are `main.device.test-util.ts`'s,
// which also states what the device table does and does not model.

import { afterEach, describe, expect, it, vi } from "vitest";
import { $, bootApp, deviceCommands, statusText } from "./main.test-util";
import type { TauriShell } from "./main.test-util";
import { gainToVd } from "./core/control/vd";
import { COMP_EQ_SSMCS, PARAMS } from "./core/control/params";
import { channelControl } from "./core/control/translate";
import { getModel } from "./models";
import { defaultPlan } from "./models/initial-state";
import { EDIT_MENU_EVENT, EDIT_REDO_ID, EDIT_UNDO_ID } from "./core/platform";
import { t } from "./i18n";
import { spoken } from "./ui/glyph";
import {
  SLOW,
  bootDevice,
  invoked,
  live,
  fetchEnded,
  selectNode,
  notifyChannel,
  pressNode,
  paramRow,
  quiet,
} from "./main.device.test-util";

// The unit announces when a jack's Clip Safe is holding the gain down, and lights its [Clip Safe]
// orange then. Every session follows it, and the CONSOLE's A.GAIN and the Inspector's Clip Safe ON
// show it while it lasts.

describe("an engaged Clip Safe during Live sync", () => {
  const gainBox = (): HTMLElement =>
    [...$("console-host").querySelectorAll<HTMLElement>(".con-strip")]
      .find((st) => st.getAttribute("aria-label") === "C H 1")!
      .querySelector<HTMLElement>(".con-gain")!;
  const clipSafeOn = (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>("#inspector [data-clip-safe-jack] .toggle button");

  it("shows on the CONSOLE's A.GAIN and the Inspector's Clip Safe while the unit announces it", SLOW, async () => {
    const shell = await bootDevice();
    live().click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    pressNode("ch1");
    $("btn-view-console").click();
    expect(gainBox().classList.contains("clip-safe"), "the premise: nothing announced").toBe(false);
    expect(gainBox().querySelector(".lbl")?.textContent).toBe("A.GAIN");

    notifyChannel(shell).onmessage([{ param_id: PARAMS.CLIP_SAFE_ENGAGED.id, x: 0, y: 0, value: 1 }]);
    expect(gainBox().classList.contains("clip-safe")).toBe(true);
    expect(gainBox().querySelector(".lbl")?.textContent).toBe(t().console.clipSafeLabel);
    expect(clipSafeOn()?.classList.contains("clip-safe"), "the Inspector's Clip Safe ON").toBe(true);
    expect(clipSafeOn()?.getAttribute("aria-description")).toBe(t().inspector.clipSafeEngaged);

    notifyChannel(shell).onmessage([{ param_id: PARAMS.CLIP_SAFE_ENGAGED.id, x: 0, y: 0, value: 0 }]);
    expect(gainBox().classList.contains("clip-safe")).toBe(false);
    expect(gainBox().querySelector(".lbl")?.textContent).toBe("A.GAIN");
    expect(clipSafeOn()?.classList.contains("clip-safe")).toBe(false);
  });

  it("shows an engagement the unit announced while the session was still starting", SLOW, async () => {
    let announced = false;
    const shell: TauriShell = await bootDevice({
      // The last registration before the session counts as up: CH 1 is selected while it waits.
      vd_watch_link: () => {
        pressNode("ch1");
        expect(clipSafeOn(), "the premise: CH 1's Clip Safe row is shown").not.toBeNull();
        notifyChannel(shell).onmessage([{ param_id: PARAMS.CLIP_SAFE_ENGAGED.id, x: 0, y: 0, value: 1 }]);
        announced = true;
        return null;
      },
    });
    live().click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    expect(announced, "the premise: announced before the session was up").toBe(true);
    expect(clipSafeOn()?.classList.contains("clip-safe"), "the Inspector's Clip Safe ON").toBe(true);
    $("btn-view-console").click();
    expect(gainBox().classList.contains("clip-safe"), "the CONSOLE's A.GAIN").toBe(true);
  });

  it("drops the state when the session ends, and the next session starts without it", SLOW, async () => {
    const shell = await bootDevice();
    live().click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    pressNode("ch1");
    $("btn-view-console").click();
    notifyChannel(shell).onmessage([{ param_id: PARAMS.CLIP_SAFE_ENGAGED.id, x: 0, y: 0, value: 1 }]);
    expect(gainBox().classList.contains("clip-safe"), "the premise: shown during the session").toBe(true);
    live().click();
    await invoked(shell, "vd_disconnect");
    expect(gainBox().classList.contains("clip-safe")).toBe(false);
    expect(clipSafeOn()?.classList.contains("clip-safe")).toBe(false);
    await vi.waitFor(() => expect($<HTMLSelectElement>("rate-picker").disabled).toBe(false));
    live().click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    expect(gainBox().classList.contains("clip-safe"), "nothing carried into the next session").toBe(false);
    expect(clipSafeOn()?.classList.contains("clip-safe")).toBe(false);
  });

  it("shows on every channel reading the jack the unit names, and on no other", SLOW, async () => {
    const shell = await bootDevice({}, true, { [`${PARAMS.INPUT_SOURCE.id}/0/2`]: 0 });
    live().click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    const gain = (name: string): HTMLElement =>
      [...$("console-host").querySelectorAll<HTMLElement>(".con-strip")]
        .find((st) => st.getAttribute("aria-label") === spoken(name))!
        .querySelector<HTMLElement>(".con-gain[data-clip-safe-jack]")!;
    $("btn-view-console").click();
    expect(
      [gain("CH 1"), gain("CH 2"), gain("CH 3")].map((g) => g.dataset.clipSafeJack),
      "CH 3 reads jack 1",
    ).toEqual(["0", "1", "0"]);
    notifyChannel(shell).onmessage([{ param_id: PARAMS.CLIP_SAFE_ENGAGED.id, x: 0, y: 0, value: 1 }]);
    expect([gain("CH 1"), gain("CH 2"), gain("CH 3")].map((g) => g.classList.contains("clip-safe"))).toEqual([
      true,
      false,
      true,
    ]);
    $("btn-view-graph").click();
    pressNode("ch3");
    expect(clipSafeOn()?.classList.contains("clip-safe"), "CH 3's Clip Safe ON").toBe(true);
  });
});

// +48V and Hi-Z are never on together, and A.Gain stops at +40 dB while Hi-Z is on. The
// surfaces ask that rule per edit; these are the two paths that reach the plan without
// being one — applying a history entry, and writing the whole plan — plus the cap, which
// has to read the gain the plan holds rather than the one the row was built with.
//
// A device read that finds both on is taken as it is (docs/en/known-issues.md), so what
// the rule is asked about is the state the APP is about to create.

describe("+48V and Hi-Z on one channel", () => {
  const model = getModel("URX44V");
  const CH3_Y = channelControl(model, "ch3")!.y;
  const at = (paramId: number): string => `${paramId}/0/${CH3_Y}`;
  const RATE = `${PARAMS.SAMPLE_RATE.id}/0/0`;
  const bothOn = { [at(PARAMS.PHANTOM.id)]: 1, [at(PARAMS.HI_Z.id)]: 1, [RATE]: 48_000 };

  /** Every value written to `paramId` on CH 3, in order. Read off the ledger by ADDRESS: a
   *  plan write sends hundreds of commands, so a `vd_set` count cannot say whether this one
   *  went out, nor what it carried. */
  const writesAt = (shell: TauriShell, paramId: number): number[] =>
    shell.invokes.flatMap((cmd, i) => {
      const a = shell.args[i];
      return cmd === "vd_set" && a?.paramId === paramId && a?.y === CH3_Y ? [a.value as number] : [];
    });

  const litFace = (label: string): string | undefined =>
    paramRow(label)?.querySelector("button.on")?.textContent ?? undefined;
  const pressFace = (label: string, text: string): void =>
    [...paramRow(label).querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!.click();
  const switches = (): { phantom: string | undefined; hiZ: string | undefined } => ({
    phantom: litFace(t().inspector.phantom),
    hiZ: litFace(t().inspector.hiZ),
  });
  /** What the A.Gain row PRINTS, which is the plan's own value: the slider clamps its
   *  displayed position to its own max, so above the cap it reads there as the cap. */
  const gainShown = (): string => paramRow(t().inspector.gainAnalog).querySelector(".param-val")?.textContent ?? "";
  const slideGain = (db: number): void => {
    const slider = paramRow(t().inspector.gainAnalog).querySelector<HTMLInputElement>('input[type="range"]')!;
    slider.value = String(db);
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const liveUp = (): Promise<void> =>
    vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });

  it("sends the gain the plan holds when Hi-Z goes on, not the one the panel was drawn with", SLOW, async () => {
    const shell = await bootDevice({}, true, { [at(PARAMS.HA_GAIN.id)]: gainToVd(60), [RATE]: 48_000 });
    live().click();
    await liveUp();
    selectNode("ch3");
    expect(gainShown(), "the premise: the panel was drawn from the unit's own +60 dB").toBe("+60 dB");

    slideGain(20);
    pressFace(t().inspector.hiZ, t().inspector.on);
    // The gesture's own command, so the readings below are taken past the flush it caused.
    await vi.waitFor(() => expect(writesAt(shell, PARAMS.HI_Z.id)).toEqual([1]), SLOW);
    expect({ shown: gainShown(), gains: writesAt(shell, PARAMS.HA_GAIN.id) }).toEqual({
      shown: "+20 dB",
      gains: [gainToVd(20)],
    });
  });

  it("refuses an undo that would put +48V and Hi-Z back on together, and sends nothing for it", SLOW, async () => {
    const shell = await bootDevice({}, true, bothOn);
    live().click();
    await liveUp();
    selectNode("ch3");
    expect(switches(), "the premise: the read kept the unit's state").toEqual({ phantom: "ON", hiZ: "ON" });

    pressFace(t().inspector.phantom, t().inspector.off);
    await vi.waitFor(() => expect(writesAt(shell, PARAMS.PHANTOM.id)).toEqual([0]), SLOW);

    expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
    await vi.waitFor(
      () =>
        expect({
          status: statusText(),
          phantom: writesAt(shell, PARAMS.PHANTOM.id),
          face: litFace(t().inspector.phantom),
        }).toEqual({ status: t().status.undoPhantomHiZ("CH 3"), phantom: [0], face: "OFF" }),
      { timeout: 10_000 },
    );
  });

  it("writes nothing when the plan holds both on, and writes once the channel holds one", SLOW, async () => {
    const table = deviceCommands({ "plugin:dialog|message": "Ok" }, bothOn);
    const baseGet = table.vd_get as (a: Record<string, unknown>) => number;
    const baseSet = table.vd_set as (a: Record<string, unknown>) => void;
    // CH 3's own two switches, so the case can turn them off between the fetch and the
    // write the way the front panel does — which is what leaves the plan holding a state
    // the unit does not. A write to them lands here as well, or a converge re-sends what
    // this went on answering.
    const panel = new Map<unknown, number>([
      [PARAMS.PHANTOM.id, 1],
      [PARAMS.HI_Z.id, 1],
    ]);
    const isSwitch = (a: Record<string, unknown>): boolean => a.y === CH3_Y && panel.has(a.paramId);
    table.vd_get = (a: Record<string, unknown>) => {
      const held = baseGet(a); // first, so a read while disconnected is still refused
      return isSwitch(a) ? panel.get(a.paramId)! : held;
    };
    table.vd_set = (a: Record<string, unknown>) => {
      const out = baseSet(a); // …and a write while disconnected, which throws past the line below
      if (isSwitch(a)) panel.set(a.paramId, a.value as number);
      return out;
    };
    const shell = (await bootApp({ tauri: table }))!;

    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");
    selectNode("ch3");
    expect(switches(), "the premise: the read kept the unit's state").toEqual({ phantom: "ON", hiZ: "ON" });
    for (const id of panel.keys()) panel.set(id, 0);

    const sent = shell.count("vd_set");
    $("btn-write").click();
    await vi.waitFor(
      () =>
        expect({
          status: statusText(),
          phantom: writesAt(shell, PARAMS.PHANTOM.id),
          hiZ: writesAt(shell, PARAMS.HI_Z.id),
        }).toEqual({ status: t().status.writePhantomHiZ("CH 3"), phantom: [], hiZ: [] }),
      { timeout: 10_000 },
    );
    expect(shell.count("vd_set"), "nothing was sent at all").toBe(sent);

    // The positive control: a guard that refused every write passes everything above. With
    // +48V off the plan is writable again, and the Hi-Z the unit no longer holds goes out.
    pressFace(t().inspector.phantom, t().inspector.off);
    $("btn-write").click();
    await invoked(shell, "vd_disconnect", 2);
    expect({
      status: statusText(),
      phantom: writesAt(shell, PARAMS.PHANTOM.id),
      hiZ: writesAt(shell, PARAMS.HI_Z.id),
    }).not.toEqual({ status: t().status.writePhantomHiZ("CH 3"), phantom: [], hiZ: [] });
    expect(writesAt(shell, PARAMS.HI_Z.id), "the write reached the link").toEqual([1]);
  });

  // A read in flight is a window in which the plan has not heard what the unit holds, so a
  // surface takes an ON the rule would refuse had the plan known. The rule is asked again
  // where the read lands: that ON goes back to the unit's OFF, the status line says why, and
  // no ON for it reaches the unit. The unit's own switch is never written.
  describe("against a device read in flight", () => {
    // Every hold a case made is released here, ahead of the file's own teardown, which ends
    // the session and then waits for the device link a held read keeps. A release behind
    // `onTestFinished` would come too late: vitest runs it after every `afterEach`.
    const holds: Array<() => void> = [];
    afterEach(() => {
      for (const release of holds.splice(0)) release();
    });
    /** A unit whose reads of `paramId` on CH 3 wait until `release()`, each answering what
     *  the unit held when it was asked — a read that sampled the address before the press.
     *  `arm()` starts holding; `asked` counts the reads held so far. */
    const holdingUnit = (seed: Record<string, number>, paramId: number, armed = true) => {
      const table = deviceCommands({ "plugin:dialog|message": "Ok" }, seed);
      const baseGet = table.vd_get as (a: Record<string, unknown>) => number;
      const waiting: Array<() => void> = [];
      const hold = {
        armed,
        asked: 0,
        arm: (): void => void (hold.armed = true),
        release: (): void => {
          hold.armed = false;
          for (const go of waiting.splice(0)) go();
        },
        /** The unit's own panel moving `id` on CH 3, which writes nothing through the app. */
        panel: (id: number, value: number): void =>
          void (table.vd_set as (a: Record<string, unknown>) => void)({ paramId: id, x: 0, y: CH3_Y, value }),
      };
      table.vd_get = (a: Record<string, unknown>) => {
        const held = baseGet(a); // first, so a read while disconnected is still refused
        if (!hold.armed || a.paramId !== paramId || a.y !== CH3_Y) return held;
        hold.asked += 1;
        return new Promise((r) => waiting.push(() => r(held)));
      };
      // A case that ends — or fails — with a read still held lets it finish before the
      // teardown waits for the link.
      holds.push(hold.release);
      return { table, hold };
    };
    /** A plan link whose jack 3 — the one CH 3 reads — holds `jack`, named by field. */
    const planLink = async (jack: Record<string, unknown>): Promise<string> => {
      const { serialize } = await import("./core/plan");
      const doc = defaultPlan("URX44V");
      const onJack = Object.fromEntries(Object.entries(jack).map(([k, v]) => [`${k}L`, v]));
      doc.nodeParams["in.micline_3_4"] = { ...doc.nodeParams["in.micline_3_4"], ...onJack };
      return `/?plan=${encodeURIComponent(Buffer.from(serialize(doc), "utf8").toString("base64url"))}`;
    };
    const readHeld = (hold: { asked: number }): Promise<void> =>
      vi.waitFor(() => expect(hold.asked).toBeGreaterThan(0), { timeout: 10_000 });

    it("refuses a +48V ON pressed while a Live-sync start reads a unit holding Hi-Z on", SLOW, async () => {
      const { table, hold } = holdingUnit({ [at(PARAMS.HI_Z.id)]: 1, [RATE]: 48_000 }, PARAMS.PHANTOM.id);
      const shell = (await bootApp({ tauri: table }))!;
      selectNode("ch3");
      expect(switches(), "the premise: the plan starts with both off").toEqual({ phantom: "OFF", hiZ: "OFF" });

      live().click();
      await readHeld(hold);
      // The plan has not heard of the unit's Hi-Z, so the Inspector takes +48V ON — and an
      // unrelated edit beside it, which the rule has no business with.
      pressFace(t().inspector.phantom, t().inspector.on);
      pressFace(t().inspector.clipSafe, t().inspector.on);
      expect(switches(), "the premise: the press landed").toEqual({ phantom: "ON", hiZ: "OFF" });
      hold.release();
      await liveUp();

      selectNode("ch3");
      expect(switches(), "+48V is back off, and the unit's Hi-Z is shown").toEqual({ phantom: "OFF", hiZ: "ON" });
      expect(litFace(t().inspector.clipSafe), "the unrelated edit stands").toBe("ON");
      expect(statusText().startsWith(`${t().status.phantomRefusedByRead("CH 3")} — `), statusText()).toBe(true);
      // The edit the read made the session send is the positive control: it went out, and
      // no +48V ON went with it or after it.
      await vi.waitFor(() => expect(writesAt(shell, PARAMS.CLIP_SAFE.id)).toEqual([1]), { timeout: 10_000 });
      expect({ phantom: writesAt(shell, PARAMS.PHANTOM.id), hiZ: writesAt(shell, PARAMS.HI_Z.id) }).toEqual({
        phantom: [],
        hiZ: [],
      });
    });

    it(
      "refuses a Hi-Z ON pressed while a Live-sync start reads a unit holding +48V on, with the gain it carried",
      SLOW,
      async () => {
        // The unit holds +48V on and A.Gain at +55; the plan holds A.Gain at +60, above the cap
        // turning Hi-Z on lowers it to.
        const { table, hold } = holdingUnit(
          { [at(PARAMS.PHANTOM.id)]: 1, [at(PARAMS.HA_GAIN.id)]: gainToVd(55), [RATE]: 48_000 },
          PARAMS.HI_Z.id,
        );
        const shell = (await bootApp({ url: await planLink({ gain: 60, hiZ: false, phantom: false }), tauri: table }))!;
        selectNode("ch3");
        expect(gainShown(), "the premise: the plan's own gain").toBe("+60 dB");

        live().click();
        await readHeld(hold);
        // Pressed the way a pointer presses, so the history closes the press's entry at the
        // pointer's release — committed before the read lands, as a real press is.
        const on = [...paramRow(t().inspector.hiZ).querySelectorAll<HTMLButtonElement>("button")].find(
          (b) => b.textContent === t().inspector.on,
        )!;
        on.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, bubbles: true }));
        on.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
        on.click();
        await new Promise((r) => setTimeout(r, 0)); // the release's deferred commit runs first
        expect({ switches: switches(), gain: gainShown() }, "the premise: the press landed, gain and all").toEqual({
          switches: { phantom: "OFF", hiZ: "ON" },
          gain: "+40 dB",
        });
        hold.release();
        await liveUp();

        selectNode("ch3");
        // The press is refused whole: Hi-Z back off, and the gain it carried down back at what
        // the unit holds rather than at the cap or at the plan's old value.
        expect({ switches: switches(), gain: gainShown() }).toEqual({
          switches: { phantom: "ON", hiZ: "OFF" },
          gain: "+55 dB",
        });
        expect(statusText().startsWith(`${t().status.hiZRefusedByRead("CH 3")} — `), statusText()).toBe(true);

        // Nothing is left in the history to put the refused edit back: the press was the
        // plan's only edit. Nothing keeps focus, since a focused text field owns the command.
        (document.activeElement as HTMLElement | null)?.blur();
        expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
        expect(statusText()).toBe(t().status.nothingToUndo);
        expect(shell.emit(EDIT_MENU_EVENT, EDIT_REDO_ID)).toBe(1);
        expect(statusText()).toBe(t().status.nothingToRedo);
        expect({ switches: switches(), gain: gainShown() }).toEqual({
          switches: { phantom: "ON", hiZ: "OFF" },
          gain: "+55 dB",
        });

        pressFace(t().inspector.clipSafe, t().inspector.on);
        await vi.waitFor(() => expect(writesAt(shell, PARAMS.CLIP_SAFE.id)).toEqual([1]), { timeout: 10_000 });
        expect({ hiZ: writesAt(shell, PARAMS.HI_Z.id), gain: writesAt(shell, PARAMS.HA_GAIN.id) }).toEqual({
          hiZ: [],
          gain: [],
        });
      },
    );

    it(
      "refuses a +48V ON pressed while a follow read brings in the unit's own Hi-Z ON, and sends none",
      SLOW,
      async () => {
        const { table, hold } = holdingUnit({ [RATE]: 48_000 }, PARAMS.PHANTOM.id, false);
        const shell = (await bootApp({ tauri: table }))!;
        live().click();
        await liveUp();
        selectNode("ch3");
        expect(switches(), "the premise: the unit starts with both off").toEqual({ phantom: "OFF", hiZ: "OFF" });

        // Hi-Z goes on at the unit's own panel. Its notify makes the follow re-read CH 3, and
        // that read is held before it has asked the unit about Hi-Z.
        hold.panel(PARAMS.HI_Z.id, 1);
        hold.arm();
        notifyChannel(shell).onmessage([{ param_id: PARAMS.HI_Z.id, x: 0, y: CH3_Y, value: 1 }]);
        await readHeld(hold);

        selectNode("ch3");
        expect(litFace(t().inspector.hiZ), "the premise: the plan has not heard yet").toBe("OFF");
        pressFace(t().inspector.phantom, t().inspector.on);
        pressFace(t().inspector.clipSafe, t().inspector.on);
        // Clip Safe goes out behind +48V in one flush, so its write says the flush is past it.
        await vi.waitFor(() => expect(writesAt(shell, PARAMS.CLIP_SAFE.id)).toEqual([1]), { timeout: 10_000 });
        expect(writesAt(shell, PARAMS.PHANTOM.id), "no +48V ON while the unit holds Hi-Z on").toEqual([]);

        hold.release();
        await vi.waitFor(
          () => {
            selectNode("ch3");
            expect(switches()).toEqual({ phantom: "OFF", hiZ: "ON" });
          },
          { timeout: 25_000, interval: 50 },
        );
        expect(statusText().startsWith(`${t().status.phantomRefusedByRead("CH 3")} — `), statusText()).toBe(true);
        expect(writesAt(shell, PARAMS.PHANTOM.id)).toEqual([]);
        expect(writesAt(shell, PARAMS.HI_Z.id), "the unit's own Hi-Z is never written").toEqual([]);
      },
    );

    // A MIDI controller is told the plan's value, so the LED a refused press lit goes back off.
    it(
      "puts a MIDI controller mapped to the switch back to OFF once the follow read refuses the press",
      SLOW,
      async () => {
        const CC = 20;
        const { table, hold } = holdingUnit({ [RATE]: 48_000 }, PARAMS.PHANTOM.id, false);
        Object.assign(table, { midi_list_outputs: ["Controller Out"], midi_open_output: null, midi_send: null });
        const shell = (await bootApp({
          seed: {
            "urx-midi": JSON.stringify({
              output: "Controller Out",
              models: {
                URX44V: [
                  {
                    control: "ch3/phantom",
                    addr: { type: "cc", channel: 0, controller: CC },
                    mode: "absolute",
                    button: "state",
                  },
                ],
              },
            }),
          },
          tauri: table,
        }))!;
        /** Every value the controller was sent on the switch's CC, in order. */
        const told = (): number[] =>
          shell.invokes.flatMap((cmd, i) => {
            const bytes = (shell.args[i] as { bytes?: number[] } | undefined)?.bytes;
            return cmd === "midi_send" && bytes?.[1] === CC ? [bytes[2]] : [];
          });
        await invoked(shell, "midi_open_output");
        live().click();
        await liveUp();
        await vi.waitFor(() => expect(told().at(-1), "the premise: the settled read told it OFF").toBe(0), {
          timeout: 10_000,
        });

        hold.panel(PARAMS.HI_Z.id, 1);
        hold.arm();
        notifyChannel(shell).onmessage([{ param_id: PARAMS.HI_Z.id, x: 0, y: CH3_Y, value: 1 }]);
        await readHeld(hold);
        selectNode("ch3");
        pressFace(t().inspector.phantom, t().inspector.on);
        await vi.waitFor(() => expect(told().at(-1), "the premise: the press lit it").toBe(127), { timeout: 10_000 });

        hold.release();
        await vi.waitFor(
          () => {
            selectNode("ch3");
            expect(switches()).toEqual({ phantom: "OFF", hiZ: "ON" });
          },
          { timeout: 25_000, interval: 50 },
        );
        await vi.waitFor(() => expect(told().at(-1)).toBe(0), { timeout: 10_000 });
      },
    );

    // The unit's panel turns Hi-Z on and announces it, which sends the follow layer to re-read
    // the jack, and +48V is pressed while that read is out. A refetch reads its head's own node,
    // and no head sits on a jack, so this is the read in flight that a live session takes over
    // the input stage.
    it("refuses a +48V ON pressed while a follow read of the jack reads a unit holding Hi-Z on", SLOW, async () => {
      const { table, hold } = holdingUnit({ [RATE]: 48_000 }, PARAMS.PHANTOM.id, false);
      const shell = (await bootApp({ tauri: table }))!;
      live().click();
      await liveUp();
      await quiet(shell);

      hold.arm();
      hold.panel(PARAMS.HI_Z.id, 1);
      notifyChannel(shell).onmessage([{ param_id: PARAMS.HI_Z.id, x: 0, y: CH3_Y, value: 1 }]);
      await readHeld(hold);

      selectNode("ch3");
      expect(litFace(t().inspector.hiZ), "the premise: the plan has not heard").toBe("OFF");
      const on = [...paramRow(t().inspector.phantom).querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.textContent === t().inspector.on,
      )!;
      on.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, bubbles: true }));
      on.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
      on.click();
      await new Promise((r) => setTimeout(r, 0)); // the release's deferred commit runs first
      expect(litFace(t().inspector.phantom), "the premise: the press landed").toBe("ON");
      hold.release();
      await quiet(shell);

      selectNode("ch3");
      expect(switches()).toEqual({ phantom: "OFF", hiZ: "ON" });
      expect(statusText().startsWith(`${t().status.phantomRefusedByRead("CH 3")} — `), statusText()).toBe(true);
      expect(writesAt(shell, PARAMS.PHANTOM.id)).toEqual([]);
    });

    it("refuses a +48V ON pressed while a Fetch reads a unit holding Hi-Z on", SLOW, async () => {
      const { table, hold } = holdingUnit({ [at(PARAMS.HI_Z.id)]: 1, [RATE]: 48_000 }, PARAMS.PHANTOM.id);
      const shell = (await bootApp({ tauri: table }))!;
      $("btn-fetch").click();
      await readHeld(hold);
      selectNode("ch3");
      pressFace(t().inspector.phantom, t().inspector.on);
      hold.release();
      await invoked(shell, "vd_disconnect");
      await fetchEnded();

      selectNode("ch3");
      expect(switches()).toEqual({ phantom: "OFF", hiZ: "ON" });
      expect(statusText().startsWith(`${t().status.phantomRefusedByRead("CH 3")} — `), statusText()).toBe(true);
      expect(shell.count("vd_set")).toBe(0);
    });

    // What the rule leaves alone.
    it("keeps both on when the read finds the unit holding both, whatever was pressed meanwhile", SLOW, async () => {
      const { table, hold } = holdingUnit(bothOn, PARAMS.PHANTOM.id);
      const shell = (await bootApp({ tauri: table }))!;
      live().click();
      await readHeld(hold);
      selectNode("ch3");
      pressFace(t().inspector.phantom, t().inspector.on);
      hold.release();
      await liveUp();

      selectNode("ch3");
      expect(switches()).toEqual({ phantom: "ON", hiZ: "ON" });
      expect(statusText().startsWith(`${t().status.phantomHiZBothOn("CH 3")} — `), statusText()).toBe(true);
      await quiet(shell);
      expect({ phantom: writesAt(shell, PARAMS.PHANTOM.id), hiZ: writesAt(shell, PARAMS.HI_Z.id) }).toEqual({
        phantom: [],
        hiZ: [],
      });
    });

    it("keeps an OFF pressed while the read runs, and sends it", SLOW, async () => {
      const { table, hold } = holdingUnit(bothOn, PARAMS.HI_Z.id);
      const shell = (await bootApp({ url: await planLink({ phantom: true, hiZ: false }), tauri: table }))!;
      live().click();
      await readHeld(hold);
      selectNode("ch3");
      pressFace(t().inspector.phantom, t().inspector.off);
      hold.release();
      await liveUp();

      selectNode("ch3");
      expect(switches()).toEqual({ phantom: "OFF", hiZ: "ON" });
      expect(statusText().includes(t().status.phantomRefusedByRead("CH 3")), statusText()).toBe(false);
      await vi.waitFor(() => expect(writesAt(shell, PARAMS.PHANTOM.id)).toEqual([0]), { timeout: 10_000 });
      expect(writesAt(shell, PARAMS.HI_Z.id)).toEqual([]);
    });

    // The mirror of the case above, and the A.Gain the press lowers goes with it: a refused
    // press moves nothing on the unit.
    it(
      "refuses a Hi-Z ON pressed while a follow read brings in the unit's own +48V ON, and sends none of it",
      SLOW,
      async () => {
        const CH4_Y = channelControl(model, "ch4")!.y;
        const { table, hold } = holdingUnit(
          { [at(PARAMS.HA_GAIN.id)]: gainToVd(60), [RATE]: 48_000 },
          PARAMS.HI_Z.id,
          false,
        );
        const shell = (await bootApp({ tauri: table }))!;
        live().click();
        await liveUp();
        selectNode("ch3");
        expect({ switches: switches(), gain: gainShown() }, "the premise: the unit's own state").toEqual({
          switches: { phantom: "OFF", hiZ: "OFF" },
          gain: "+60 dB",
        });

        // +48V goes on at the unit's own panel, and the follow read of CH 3 that starts is held
        // before it has asked the unit about Hi-Z.
        hold.panel(PARAMS.PHANTOM.id, 1);
        hold.arm();
        notifyChannel(shell).onmessage([{ param_id: PARAMS.PHANTOM.id, x: 0, y: CH3_Y, value: 1 }]);
        await readHeld(hold);

        selectNode("ch3");
        pressFace(t().inspector.hiZ, t().inspector.on);
        expect({ switches: switches(), gain: gainShown() }, "the premise: the press landed, gain and all").toEqual({
          switches: { phantom: "OFF", hiZ: "ON" },
          gain: "+40 dB",
        });
        // CH 4 comes after CH 3 in a flush, so its write says the flush is past CH 3's A.Gain.
        selectNode("ch4");
        pressFace(t().inspector.clipSafe, t().inspector.on);
        await vi.waitFor(
          () =>
            expect(
              shell.invokes.flatMap((cmd, i) => {
                const a = shell.args[i];
                return cmd === "vd_set" && a?.paramId === PARAMS.CLIP_SAFE.id && a?.y === CH4_Y ? [a.value] : [];
              }),
            ).toEqual([1]),
          { timeout: 10_000 },
        );
        expect({ hiZ: writesAt(shell, PARAMS.HI_Z.id), gain: writesAt(shell, PARAMS.HA_GAIN.id) }).toEqual({
          hiZ: [],
          gain: [],
        });

        hold.release();
        await vi.waitFor(
          () => {
            selectNode("ch3");
            expect(switches()).toEqual({ phantom: "ON", hiZ: "OFF" });
          },
          { timeout: 25_000, interval: 50 },
        );
        expect(gainShown(), "the gain the press lowered is the unit's again").toBe("+60 dB");
        expect(statusText().startsWith(`${t().status.hiZRefusedByRead("CH 3")} — `), statusText()).toBe(true);
        await quiet(shell);
        expect({
          phantom: writesAt(shell, PARAMS.PHANTOM.id),
          hiZ: writesAt(shell, PARAMS.HI_Z.id),
          gain: writesAt(shell, PARAMS.HA_GAIN.id),
        }).toEqual({ phantom: [], hiZ: [], gain: [] });
      },
    );

    // The unit has turned +48V on and its announcement has not reached the session: the flush
    // asks the unit before the Hi-Z ON goes, so neither it nor the A.Gain it lowered is sent,
    // and the read the announcement starts refuses the press. The full read device follow runs
    // once the burst goes quiet changes nothing, and the status line goes on saying why.
    it("sends no Hi-Z ON ahead of the unit's +48V announcement, and the line keeps saying why", SLOW, async () => {
      const CH1_Y = channelControl(model, "ch1")!.y;
      const CH4_Y = channelControl(model, "ch4")!.y;
      const { table, hold } = holdingUnit(
        { [at(PARAMS.HA_GAIN.id)]: gainToVd(60), [RATE]: 48_000 },
        PARAMS.HI_Z.id,
        false,
      );
      const shell = (await bootApp({ tauri: table }))!;
      live().click();
      await liveUp();
      selectNode("ch3");
      expect({ switches: switches(), gain: gainShown() }, "the premise: the unit's own state").toEqual({
        switches: { phantom: "OFF", hiZ: "OFF" },
        gain: "+60 dB",
      });

      const pressed = shell.invokes.length;
      hold.panel(PARAMS.PHANTOM.id, 1);
      pressFace(t().inspector.hiZ, t().inspector.on);
      // CH 4 comes after CH 3 in a flush, so its write says the flush is past CH 3's A.Gain.
      selectNode("ch4");
      pressFace(t().inspector.clipSafe, t().inspector.on);
      await vi.waitFor(
        () =>
          expect(
            shell.invokes.flatMap((cmd, i) => {
              const a = shell.args[i];
              return cmd === "vd_set" && a?.paramId === PARAMS.CLIP_SAFE.id && a?.y === CH4_Y ? [a.value] : [];
            }),
          ).toEqual([1]),
        { timeout: 10_000 },
      );
      expect({ hiZ: writesAt(shell, PARAMS.HI_Z.id), gain: writesAt(shell, PARAMS.HA_GAIN.id) }).toEqual({
        hiZ: [],
        gain: [],
      });
      expect(
        shell.invokes.some(
          (cmd, i) =>
            i >= pressed &&
            cmd === "vd_get" &&
            shell.args[i]?.paramId === PARAMS.PHANTOM.id &&
            shell.args[i]?.y === CH3_Y,
        ),
        "the flush asked the unit",
      ).toBe(true);

      // Selected once rather than inside the waits below: two presses inside the double-click
      // window trace the node's signal path, and the line that reports it replaces the one this
      // case reads.
      selectNode("ch3");
      const announced = shell.invokes.length;
      notifyChannel(shell).onmessage([{ param_id: PARAMS.PHANTOM.id, x: 0, y: CH3_Y, value: 1 }]);
      await vi.waitFor(() => expect(switches()).toEqual({ phantom: "ON", hiZ: "OFF" }), {
        timeout: 25_000,
        interval: 50,
      });
      // The idle full read starts its delay again at every arm, and the settle's report of a
      // write the unit did not announce is one, so it is waited for by its own first read
      // rather than by a quiet window shorter than that delay.
      await vi.waitFor(
        () =>
          expect(
            shell.invokes.some(
              (cmd, i) =>
                i >= announced &&
                cmd === "vd_get" &&
                shell.args[i]?.paramId === PARAMS.PHANTOM.id &&
                shell.args[i]?.y === CH1_Y,
            ),
            "the premise: the full read ran behind the scoped one",
          ).toBe(true),
        { timeout: 25_000, interval: 50 },
      );
      await quiet(shell);
      expect(gainShown(), "the gain the press lowered is the unit's again").toBe("+60 dB");
      expect(statusText().startsWith(`${t().status.hiZRefusedByRead("CH 3")} — `), statusText()).toBe(true);
      expect({
        phantom: writesAt(shell, PARAMS.PHANTOM.id),
        hiZ: writesAt(shell, PARAMS.HI_Z.id),
        gain: writesAt(shell, PARAMS.HA_GAIN.id),
      }).toEqual({ phantom: [], hiZ: [], gain: [] });

      // A later change at the unit's panel is a burst of its own, and its line says only what it did.
      hold.panel(PARAMS.CLIP_SAFE.id, 1);
      notifyChannel(shell).onmessage([{ param_id: PARAMS.CLIP_SAFE.id, x: 0, y: CH3_Y, value: 1 }]);
      await vi.waitFor(() => expect(litFace(t().inspector.clipSafe)).toBe("ON"), { timeout: 25_000, interval: 50 });
      await quiet(shell);
      expect(statusText().includes(t().status.hiZRefusedByRead("CH 3")), statusText()).toBe(false);
    });

    // The same full read does not bring a refusal back onto a line the operator's own action
    // has replaced since.
    it("does not carry a refusal onto a line the operator's own action replaced", SLOW, async () => {
      const CH1_Y = channelControl(model, "ch1")!.y;
      const { table, hold } = holdingUnit({ [RATE]: 48_000 }, PARAMS.HI_Z.id, false);
      const shell = (await bootApp({ tauri: table }))!;
      live().click();
      await liveUp();

      hold.panel(PARAMS.HI_Z.id, 1);
      notifyChannel(shell).onmessage([{ param_id: PARAMS.HI_Z.id, x: 0, y: CH3_Y, value: 1 }]);
      selectNode("ch3");
      pressFace(t().inspector.phantom, t().inspector.on);
      await vi.waitFor(
        () => expect(statusText().startsWith(`${t().status.phantomRefusedByRead("CH 3")} — `), statusText()).toBe(true),
        { timeout: 25_000, interval: 20 },
      );
      const refused = shell.invokes.length;
      (document.activeElement as HTMLElement | null)?.blur();
      expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
      expect(statusText()).toBe(t().status.nothingToUndo);
      await quiet(shell);
      expect(
        shell.invokes.some(
          (cmd, i) =>
            i >= refused &&
            cmd === "vd_get" &&
            shell.args[i]?.paramId === PARAMS.PHANTOM.id &&
            shell.args[i]?.y === CH1_Y,
        ),
        "the premise: the full read ran after the undo",
      ).toBe(true);
      expect(statusText().includes(t().status.phantomRefusedByRead("CH 3")), statusText()).toBe(false);
    });

    // An ON the flush sent while the unit still held the other switch off is on the unit, even
    // where the read sampled the address before the write: when the unit's panel then turns the
    // other one on, the unit holds both, and a read takes that state as it is.
    it("keeps a +48V ON the flush sent during a follow read once the unit's panel turns Hi-Z on", SLOW, async () => {
      const { table, hold } = holdingUnit({ [RATE]: 48_000 }, PARAMS.CLIP_SAFE.id, false);
      const shell = (await bootApp({ tauri: table }))!;
      live().click();
      await liveUp();

      // A change at the unit's panel on CH 3 starts a follow read, held at Clip Safe.
      const from = shell.invokes.length;
      hold.panel(PARAMS.CLIP_SAFE.id, 1);
      hold.arm();
      notifyChannel(shell).onmessage([{ param_id: PARAMS.CLIP_SAFE.id, x: 0, y: CH3_Y, value: 1 }]);
      await readHeld(hold);
      expect(
        shell.invokes.some(
          (cmd, i) =>
            i >= from && cmd === "vd_get" && shell.args[i]?.paramId === PARAMS.PHANTOM.id && shell.args[i]?.y === CH3_Y,
        ),
        "the premise: the read has sampled +48V already",
      ).toBe(true);

      selectNode("ch3");
      pressFace(t().inspector.phantom, t().inspector.on);
      await vi.waitFor(() => expect(writesAt(shell, PARAMS.PHANTOM.id)).toEqual([1]), { timeout: 10_000 });
      // Behind the write, Hi-Z goes on at the unit's panel, and the unit takes both.
      hold.panel(PARAMS.HI_Z.id, 1);
      notifyChannel(shell).onmessage([{ param_id: PARAMS.HI_Z.id, x: 0, y: CH3_Y, value: 1 }]);
      // The read that announcement starts is held too, so what shows next is the first read's.
      hold.release();
      hold.arm();
      await vi.waitFor(
        () => {
          selectNode("ch3");
          expect(litFace(t().inspector.hiZ)).toBe("ON");
        },
        { timeout: 25_000, interval: 50 },
      );
      expect(switches(), "the plan holds what the unit holds").toEqual({ phantom: "ON", hiZ: "ON" });
      expect(statusText().startsWith(`${t().status.phantomHiZBothOn("CH 3")} — `), statusText()).toBe(true);
      expect({ phantom: writesAt(shell, PARAMS.PHANTOM.id), hiZ: writesAt(shell, PARAMS.HI_Z.id) }).toEqual({
        phantom: [1],
        hiZ: [],
      });
      // The announcement's own read is the one the hold above is for, and the case ends with
      // it still held, so the teardown is what lets it finish.
      await vi.waitFor(() => expect(hold.asked, "the announcement's read is held").toBe(2), { timeout: 10_000 });
    });

    // A converge re-sends what differs across the write scope. A Hi-Z the unit turned on at its
    // own panel differs from a plan the follow read has not reached yet, and is not written off.
    it(
      "does not write off a Hi-Z the unit's panel turned on when a converge runs ahead of the follow read",
      SLOW,
      async () => {
        const { table, hold } = holdingUnit({ [RATE]: 48_000 }, PARAMS.HI_Z.id, false);
        const shell = (await bootApp({ tauri: table }))!;
        live().click();
        await liveUp();

        hold.panel(PARAMS.HI_Z.id, 1);
        notifyChannel(shell).onmessage([{ param_id: PARAMS.HI_Z.id, x: 0, y: CH3_Y, value: 1 }]);
        selectNode("ch3");
        const type = paramRow(t().inspector.compEqType).querySelector<HTMLSelectElement>("select")!;
        type.value = String(COMP_EQ_SSMCS);
        type.dispatchEvent(new Event("change", { bubbles: true }));
        await vi.waitFor(() => expect(writesAt(shell, PARAMS.COMP_EQ_TYPE.id)).toEqual([COMP_EQ_SSMCS]), {
          timeout: 10_000,
        });
        const typeAt = shell.invokes.reduce(
          (last, cmd, i) => (cmd === "vd_set" && shell.args[i]?.paramId === PARAMS.COMP_EQ_TYPE.id ? i : last),
          -1,
        );
        await quiet(shell);
        expect(
          shell.invokes.some((cmd, i) => i > typeAt && cmd === "vd_get"),
          "the premise: the converge read the unit",
        ).toBe(true);
        expect(writesAt(shell, PARAMS.HI_Z.id), "the unit's own Hi-Z is never written").toEqual([]);
        selectNode("ch3");
        expect(litFace(t().inspector.hiZ), "the follow read brought it in").toBe("ON");
      },
    );

    // An ON pressed after the unit announced the other one on and before the follow read that
    // announcement schedules is issued: the flush holds it, and the read, which did not see it
    // made, writes the unit's OFF over it. That is the refusal, and the status line says so.
    it("says why a +48V ON pressed ahead of the follow read of the unit's own Hi-Z ON is off", SLOW, async () => {
      const { table, hold } = holdingUnit({ [RATE]: 48_000 }, PARAMS.HI_Z.id, false);
      const shell = (await bootApp({ tauri: table }))!;
      live().click();
      await liveUp();
      const seen: string[] = [];
      new MutationObserver(() => seen.push(statusText())).observe($("statusbar"), {
        childList: true,
        characterData: true,
        subtree: true,
      });

      const from = shell.invokes.length;
      hold.panel(PARAMS.HI_Z.id, 1);
      notifyChannel(shell).onmessage([{ param_id: PARAMS.HI_Z.id, x: 0, y: CH3_Y, value: 1 }]);
      selectNode("ch3");
      pressFace(t().inspector.phantom, t().inspector.on);
      expect(shell.invokes.slice(from).includes("vd_get"), "the premise: no read had been issued").toBe(false);
      await vi.waitFor(
        () => {
          selectNode("ch3");
          expect(switches()).toEqual({ phantom: "OFF", hiZ: "ON" });
        },
        { timeout: 25_000, interval: 50 },
      );
      await quiet(shell);
      expect(
        seen.some((line) => line.startsWith(`${t().status.phantomRefusedByRead("CH 3")} — `)),
        JSON.stringify(seen),
      ).toBe(true);
      expect({ phantom: writesAt(shell, PARAMS.PHANTOM.id), hiZ: writesAt(shell, PARAMS.HI_Z.id) }).toEqual({
        phantom: [],
        hiZ: [],
      });
      (document.activeElement as HTMLElement | null)?.blur();
      expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
      expect(statusText()).toBe(t().status.nothingToUndo);
    });

    // A session that ends lets its follow read finish, and what it sent still stands for that
    // read: the ON reached the unit before the session ended.
    it("keeps a +48V ON the flush sent when Live sync ends before the follow read lands", SLOW, async () => {
      const { table, hold } = holdingUnit({ [RATE]: 48_000 }, PARAMS.CLIP_SAFE.id, false);
      const shell = (await bootApp({ tauri: table }))!;
      live().click();
      await liveUp();
      const seen: string[] = [];
      new MutationObserver(() => seen.push(statusText())).observe($("statusbar"), {
        childList: true,
        characterData: true,
        subtree: true,
      });

      hold.panel(PARAMS.CLIP_SAFE.id, 1);
      hold.arm();
      notifyChannel(shell).onmessage([{ param_id: PARAMS.CLIP_SAFE.id, x: 0, y: CH3_Y, value: 1 }]);
      await readHeld(hold);
      selectNode("ch3");
      pressFace(t().inspector.phantom, t().inspector.on);
      await vi.waitFor(() => expect(writesAt(shell, PARAMS.PHANTOM.id)).toEqual([1]), { timeout: 10_000 });
      hold.panel(PARAMS.HI_Z.id, 1);
      notifyChannel(shell).onmessage([{ param_id: PARAMS.HI_Z.id, x: 0, y: CH3_Y, value: 1 }]);

      live().click();
      await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("false"), { timeout: 10_000 });
      hold.release();
      await invoked(shell, "vd_disconnect");
      selectNode("ch3");
      expect(switches(), "the plan holds what the unit holds").toEqual({ phantom: "ON", hiZ: "ON" });
      expect(
        seen.some((line) => line.includes(t().status.phantomRefusedByRead("CH 3"))),
        JSON.stringify(seen),
      ).toBe(false);
    });
  });
});
