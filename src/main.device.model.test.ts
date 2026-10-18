// @vitest-environment jsdom

// A unit on the link that is not the model on screen.
//
// The setup, the teardown and the helpers every desktop case shares are `main.device.test-util.ts`'s,
// which also states what the device table does and does not model.

import { describe, expect, it, vi } from "vitest";
import { $, bootApp, deviceCommands, statusText, unwrittenRead } from "./main.test-util";
import type { TauriShell } from "./main.test-util";
import { levelToVd, vdToLevel } from "./core/control/vd";
import { STEREO_FADER, PARAMS } from "./core/control/params";
import { getModel } from "./models";
import { defaultPlan } from "./models/initial-state";
import { loadHidden } from "./app/view-state";
import { faceplate, wireHit } from "./ui/graph.test-util";
import { EDIT_MENU_EVENT, EDIT_UNDO_ID } from "./core/platform";
import { t } from "./i18n";
import {
  SLOW,
  bootDevice,
  invoked,
  live,
  fetchEnded,
  row,
  selectNode,
  confirms,
  errors,
  byMessage,
  RETRY_ASK,
  countFor,
  SAVES,
  connectAs,
  paramRow,
  oscFace,
  oscOn,
  pressOscOn,
  turnOscOn,
  undoTo,
} from "./main.device.test-util";

/**
 * What the app does when the unit on the link is not the model on screen.
 *
 * Write and compare REFUSE (pinned in "Write to device" below) — they act on the plan as
 * it stands. Fetch and Live sync instead OFFER to switch the UI to a fresh plan of the
 * device's model, and that offer has three answers, none of which was driven before.
 */

describe("the model the device turns out to be", () => {
  // A model this build carries no parameter map for is the arm that never raises the
  // dialog at all: there is nothing to switch to, so the read never starts.
  it("refuses to fetch from a model this build does not know, and reads nothing", SLOW, async () => {
    const shell = await bootDevice(connectAs("URX88"));
    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");

    // As a refusal, not as a question: the same words raised as a confirm would satisfy a
    // case that only looked at the text.
    expect(errors(shell)).toEqual([t().status.fetchError(t().error.unknownModel("URX88"))]);
    expect(confirms(shell)).toEqual([]);
    expect(shell.count("vd_get")).toBe(0);
    expect($<HTMLSelectElement>("model-picker").value).toBe("URX44V");
  });

  // Declining. The prompt has to be named: every stop in this flow lands on the same
  // "Canceled", and this case boots declining EVERY confirm, so without naming it the
  // case would stay green over a decline that landed somewhere else entirely.
  it("leaves the plan on screen alone when the offered switch is declined", SLOW, async () => {
    const shell = await bootDevice(connectAs("URX22"), false);
    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");

    expect(confirms(shell)).toEqual([t().confirm.switchModel("URX22", "URX44V")]);
    expect(statusText()).toBe(t().status.canceled);
    // What the decline left behind: the plan on screen unreplaced, and a sweep that never
    // started.
    expect(shell.count("vd_get")).toBe(0);
    expect($<HTMLSelectElement>("model-picker").value).toBe("URX44V");
  });

  // A write the unit refuses at an address an unverified mapping names ends the session on a
  // line that says which: on URX44 a jack's A.Gain rests on the jack axis.
  it("names the guess a refused live write rests on", SLOW, async () => {
    const { serialize } = await import("./core/plan");
    const url = `/?plan=${encodeURIComponent(Buffer.from(serialize(defaultPlan("URX44")), "utf8").toString("base64url"))}`;
    const shell = (await bootApp({
      url,
      tauri: deviceCommands({
        ...connectAs("URX44"),
        "plugin:dialog|message": "Ok",
        vd_set: (a: Record<string, unknown>) => {
          if (a.paramId === PARAMS.HA_GAIN.id) throw new Error("device-busy");
        },
      }),
    }))!;
    live().click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    expect(errors(shell), "the premise: the session started").toEqual([]);
    selectNode("ch1");
    const slider = paramRow(t().inspector.gainAnalog).querySelector<HTMLInputElement>('input[type="range"]')!;
    slider.value = String(Number(slider.value) + 5);
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 25_000 });
    expect(errors(shell)[0]).toContain(t().status.unverifiedGuess("jack-axis"));
  });

  // …and the write's own report names it beside the refused command.
  it("names the guess a refused write rests on in the write report", SLOW, async () => {
    const { serialize } = await import("./core/plan");
    const url = `/?plan=${encodeURIComponent(Buffer.from(serialize(defaultPlan("URX44")), "utf8").toString("base64url"))}`;
    const shell = (await bootApp({
      url,
      tauri: deviceCommands({
        ...connectAs("URX44"),
        ...SAVES,
        "plugin:dialog|message": byMessage((m) => !m.includes(RETRY_ASK)),
        vd_set: (a: Record<string, unknown>) => {
          if (a.paramId === PARAMS.HA_GAIN.id) throw new Error("device-busy");
        },
      }),
    }))!;
    $("btn-write").click();
    await vi.waitFor(() => expect(shell.count("write_text_file")).toBe(1), { timeout: 25_000 });
    const saved = shell.args[shell.invokes.indexOf("write_text_file")] as { contents: string };
    expect(saved.contents).toContain("- HA_GAIN (unverified mapping jack-axis) — device-busy");
  });

  // Taken, the offer has to actually switch — otherwise the read that follows maps the
  // device's channels onto the wrong ones, which is the whole reason the offer exists.
  // This is the arm that makes the declined case above mean something.
  it("switches to the device's model when the offer is taken, then reads it", SLOW, async () => {
    const shell = await bootDevice(connectAs("URX22"));
    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");

    // OFFERED, not assumed: this case boots agreeing to everything, so without naming the
    // prompt it stays green over a build that drops the confirm and switches outright.
    expect(confirms(shell)).toEqual([t().confirm.switchModel("URX22", "URX44V")]);
    expect($<HTMLSelectElement>("model-picker").value).toBe("URX22");
    expect(shell.count("vd_get")).toBeGreaterThan(50);
    // The whole frame: `fetchPartial` and `fetchedUnread` also name the model, so a read
    // that landed on either must not pass as a clean one.
    await vi.waitFor(
      () => expect(countFor(statusText(), (n) => t().status.fetchedDevice("URX22", n))).toBeGreaterThan(50),
      { timeout: 10_000 },
    );
  });

  // The switch's plan starts from that model's shelf, as every fresh plan does: drawn
  // through loadPlan, the plan's hidden set is recorded as the model's, so a plan built with
  // none would erase what the operator shelved on that model the last time it was on screen.
  it("keeps the shelf of the model a Fetch switches to", SLOW, async () => {
    const shell = (await bootApp({
      tauri: deviceCommands({ ...connectAs("URX22"), "plugin:dialog|message": "Ok" }),
      seed: { "urx-hidden": JSON.stringify({ URX22: ["ch1"] }) },
    }))!;
    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");
    await vi.waitFor(() => expect($<HTMLSelectElement>("model-picker").value).toBe("URX22"), { timeout: 10_000 });
    expect(JSON.parse(localStorage.getItem("urx-hidden") ?? "{}").URX22).toEqual(["ch1"]);
  });

  // The same three answers on the Live-sync side, where they end differently: the unknown
  // model is a failure (a dialog) while the decline is user-neutral (the status line), and
  // both have to give the connection back.
  it("refuses a live session on a model this build does not know", SLOW, async () => {
    const shell = await bootDevice(connectAs("URX88"));
    $("btn-live").click();
    await invoked(shell, "vd_disconnect");

    expect(errors(shell)).toEqual([t().status.liveError(t().error.unknownModel("URX88"))]);
    expect(shell.count("vd_params_subscribe")).toBe(0);
    expect($("live-tally").hidden).toBe(true);
    // The link was handed back, not merely disconnected: the holder is what locks the
    // other device actions, and the disconnect above does not release it.
    expect($<HTMLButtonElement>("btn-fetch").disabled).toBe(false);
  });

  it("abandons a live session quietly when the offered switch is declined", SLOW, async () => {
    const shell = await bootDevice(connectAs("URX22"), false);
    $("btn-live").click();
    await invoked(shell, "vd_disconnect");

    expect(confirms(shell)).toEqual([t().confirm.switchModel("URX22", "URX44V")]);
    expect(errors(shell)).toEqual([]); // a decline is not a failure
    expect(statusText()).toBe(t().status.canceled);
    expect(shell.count("vd_params_subscribe")).toBe(0);
    // The link was handed back, not merely dropped: the next action can take it.
    expect($<HTMLButtonElement>("btn-fetch").disabled).toBe(false);
  });

  // Taken on the live path, which the fetch case is not a substitute for: here the
  // replacement plan is what `live.begin()` snapshots as device truth, so a switch that
  // half-happened would enshrine the wrong model for the session's whole duration.
  it("switches to the device's model when a live session offers it", SLOW, async () => {
    const shell = await bootDevice(connectAs("URX22"));
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });

    expect(confirms(shell)).toEqual([t().confirm.switchModel("URX22", "URX44V")]);
    expect($<HTMLSelectElement>("model-picker").value).toBe("URX22");
    expect(countFor(statusText(), (n) => t().status.liveOn("URX22", n))).toBeGreaterThan(50);
    // Registered against the switched plan, so the session follows the model the unit
    // actually is rather than the one that was on screen.
    expect(shell.count("vd_params_subscribe")).toBe(1);
  });

  /** The plan on screen, read back through the case's only save (SAVES). */
  const savedPlan = async (
    shell: TauriShell,
  ): Promise<{
    modelId: string;
    connections: Array<{ from: string; to: string; params?: { level?: number } }>;
    positions: Record<string, unknown>;
  }> => {
    $("btn-save").click();
    await vi.waitFor(() => expect(shell.count("write_text_file")).toBe(1), { timeout: 10_000 });
    return JSON.parse((shell.args[shell.invokes.indexOf("write_text_file")] as { contents: string }).contents);
  };

  // The read into the switch's plan lands the unit's values on the model's fixed
  // connections — every channel's main fader, mono and stereo, here — in the plan the
  // switch puts on screen.
  it("puts the device's values on the switched plan, its fixed connections' included", SLOW, async () => {
    const shell = await bootDevice({
      ...connectAs("URX22"),
      ...SAVES,
      vd_get: (a: Record<string, unknown>) =>
        a.paramId === PARAMS.CH_FADER.id || a.paramId === STEREO_FADER ? levelToVd(-10) : unwrittenRead(a),
    });
    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");
    await vi.waitFor(
      () => expect(countFor(statusText(), (n) => t().status.fetchedDevice("URX22", n))).toBeGreaterThan(50),
      { timeout: 10_000 },
    );

    const doc = await savedPlan(shell);
    expect(doc.modelId).toBe("URX22");
    const channels = new Set(
      getModel("URX22")
        .nodes.filter((n) => n.kind === "channel")
        .map((n) => n.id),
    );
    const mains = doc.connections.filter((c) => c.to === "bus.stereo:in" && channels.has(c.from.split(":")[0]!));
    expect(mains.length, "the premise: the model's channels feed STEREO").toBe(channels.size);
    for (const c of mains) expect(c.params?.level, c.from).toBe(vdToLevel(levelToVd(-10)));
  });

  /** A unit whose Follow USB read — the first inside a fetch or a live start — waits until
   *  `release` answers it, with a value or a refusal. Every other read answers `rest`, which
   *  defaults to what an unwritten address holds on the unit. */
  const holdFollowUsb = (
    rest: (a: Record<string, unknown>) => number = unwrittenRead,
  ): {
    reading: Promise<void>;
    release: (answer: number | Error) => void;
    vd_get: (a: Record<string, unknown>) => unknown;
  } => {
    let asked = (): void => {};
    const reading = new Promise<void>((r) => (asked = r));
    let release = (_answer: number | Error): void => {};
    const answered = new Promise<number | Error>((r) => (release = r));
    const vd_get = (a: Record<string, unknown>): unknown => {
      if (a.paramId !== PARAMS.FOLLOW_USB.id) return rest(a);
      asked();
      return answered.then((v) => {
        if (v instanceof Error) throw v;
        return v;
      });
    };
    return { reading, release: (v) => release(v), vd_get };
  };
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  /** CH 1's first send column on the CONSOLE, looked up afresh: a refused edit repaints the
   *  strips. */
  const firstSend = (): HTMLElement =>
    $("console-host").querySelector(".con-strip")!.querySelector<HTMLElement>(".con-vfad")!;
  /** The send's value as the slider states it. Its valuetext rather than its valuenow: a send
   *  ships at −∞ and one step up is the floor detent, and the rounded valuenow of both is -96. */
  const sendValue = (): string | null => firstSend().getAttribute("aria-valuetext");
  /** Step the send one detent up from the keyboard, the way the operator does. */
  const stepSendUp = (): void => {
    for (const type of ["keydown", "keyup"]) {
      firstSend().dispatchEvent(new KeyboardEvent(type, { key: "ArrowUp", bubbles: true, cancelable: true }));
    }
  };

  // While a switched read runs, the plan on screen is the one the switch discards, so an edit
  // to it is refused rather than kept and then lost: the control goes back to the value the
  // plan holds and the status line says why. The key is CH 1's send to MIX 1, a fixed wire
  // both models carry, so the switch's plan then takes the unit's value for it with nothing
  // contested and nothing left over to report.
  it("refuses an edit to the plan a switched fetch is reading to replace", SLOW, async () => {
    const unit = holdFollowUsb((a) => (a.paramId === PARAMS.SEND_LEVEL.id ? levelToVd(-10) : unwrittenRead(a)));
    const shell = await bootDevice({ ...connectAs("URX22"), ...SAVES, vd_get: unit.vd_get });
    $("btn-view-console").click();
    $("btn-fetch").click();
    await unit.reading;
    const before = sendValue();
    try {
      stepSendUp();
      expect(sendValue(), "the premise: the console took the key").not.toBe(before);
      await tick();
      expect(sendValue()).toBe(before);
      expect(statusText()).toBe(t().status.busySwitchRead);
    } finally {
      unit.release(0);
    }
    await invoked(shell, "vd_disconnect");
    await vi.waitFor(
      () => expect(countFor(statusText(), (n) => t().status.fetchedDevice("URX22", n))).toBeGreaterThan(50),
      { timeout: 10_000 },
    );
    expect(confirms(shell)).toEqual([t().confirm.switchModel("URX22", "URX44V")]);
    const doc = await savedPlan(shell);
    expect(doc.modelId).toBe("URX22");
    const mix1 = doc.connections.find((c) => c.from === "ch1:out" && c.to === "bus.mix1:in");
    expect(mix1?.params?.level).toBe(vdToLevel(levelToVd(-10)));
  });

  // The same refusal where the read then fails, so the plan it was made on stays on screen:
  // what shows the edit never reached the plan is that the send still holds its value and that
  // nothing was recorded for an undo to take back.
  for (const [flow, start, failure] of [
    ["fetch", () => $("btn-fetch").click(), (m: string) => t().status.fetchError(m)],
    ["live start", () => live().click(), (m: string) => t().status.liveError(m)],
  ] as const) {
    it(`keeps no trace of an edit refused while a switched ${flow} reads, when the read fails`, SLOW, async () => {
      const unit = holdFollowUsb();
      const shell = await bootDevice({ ...connectAs("URX22"), vd_get: unit.vd_get });
      $("btn-view-console").click();
      start();
      await unit.reading;
      const before = sendValue();
      try {
        stepSendUp();
        await tick();
        expect(statusText()).toBe(t().status.busySwitchRead);
      } finally {
        unit.release(new Error("read-refused"));
      }
      await vi.waitFor(() => expect(errors(shell)).toEqual([failure("read-refused")]), { timeout: 10_000 });
      await invoked(shell, "vd_disconnect");
      await vi.waitFor(() => expect($<HTMLSelectElement>("rate-picker").disabled).toBe(false), { timeout: 25_000 });

      expect($<HTMLSelectElement>("model-picker").value).toBe("URX44V");
      expect(sendValue()).toBe(before);
      expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
      expect(statusText()).toBe(t().status.nothingToUndo);
      // Nor did it mark the plan unsaved: New replaces it without asking.
      $("btn-new").click();
      await vi.waitFor(() => expect(statusText()).toBe(t().status.newPlan), { timeout: 10_000 });
      expect(confirms(shell)).toEqual([t().confirm.switchModel("URX22", "URX44V")]);
    });
  }

  // The same refusal from the other surfaces, each reaching the plan through its own funnel:
  // the inspector's toggle (a node-param edit) and the board's Hide unused (the shelved set,
  // which the board also keeps a copy of and the stored layout a third). The same action once
  // the read has failed is the positive control.
  const nodesOnBoard = (): number => $("graph-host").querySelectorAll("g.node[data-id]").length;
  for (const [surface, act, observe] of [
    ["the inspector's toggle", () => pressOscOn(), () => oscFace()],
    ["the board's Hide unused", () => $("btn-hide-unused").click(), () => nodesOnBoard()],
  ] as const) {
    it(`refuses an edit from ${surface} while a switched fetch reads`, SLOW, async () => {
      const unit = holdFollowUsb();
      const shell = await bootDevice({ ...connectAs("URX22"), vd_get: unit.vd_get });
      selectNode("bus.osc");
      const before = observe();
      const shelf = loadHidden("URX44V");
      $("btn-fetch").click();
      await unit.reading;
      try {
        act();
        await tick();
        expect(observe()).toBe(before);
        expect(statusText()).toBe(t().status.busySwitchRead);
      } finally {
        unit.release(new Error("read-refused"));
      }
      await vi.waitFor(() => expect(errors(shell)).toEqual([t().status.fetchError("read-refused")]), {
        timeout: 10_000,
      });
      await invoked(shell, "vd_disconnect");
      expect(observe()).toBe(before);
      expect(loadHidden("URX44V"), "the layout stored for the model").toEqual(shelf);
      // The oscillator selected again by way of another node, for the reason the
      // draw-failure cases below give.
      selectNode("ch1");
      selectNode("bus.osc");
      act();
      await tick();
      expect(observe(), "the positive control: the same action lands").not.toBe(before);
    });
  }

  // An undo there is refused too, and says the same thing — the ordinary device-read refusal
  // would name the device instead. The entry it would have taken is still there afterwards.
  it("refuses an undo while a switched fetch reads, and keeps the entry for after", SLOW, async () => {
    const unit = holdFollowUsb();
    const shell = await bootDevice({ ...connectAs("URX22"), vd_get: unit.vd_get });
    turnOscOn();
    expect(oscFace(), "the premise: the edit landed").toBe("ON");
    await tick();
    $("btn-fetch").click();
    await unit.reading;
    try {
      expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
      expect(statusText()).toBe(t().status.busySwitchRead);
      expect(oscFace()).toBe("ON");
    } finally {
      unit.release(new Error("read-refused"));
    }
    await vi.waitFor(() => expect(errors(shell)).toEqual([t().status.fetchError("read-refused")]), { timeout: 10_000 });
    await invoked(shell, "vd_disconnect");
    await undoTo(shell, "OFF");
  });

  // And an incoming MIDI change: the MIDI gate refuses it with the same line, and the same
  // message moves the control once the read is over — the half that makes the unchanged
  // wire the refusal's doing.
  it("refuses an incoming MIDI change while a switched fetch reads", SLOW, async () => {
    const CC = 23;
    const unit = holdFollowUsb();
    const shell = (await bootApp({
      seed: {
        "urx-midi": JSON.stringify({
          input: "Controller In",
          models: {
            URX44V: [
              {
                control: "ch1/mute",
                addr: { type: "cc", channel: 0, controller: CC },
                mode: "absolute",
                button: "edge",
              },
            ],
          },
        }),
      },
      tauri: deviceCommands({
        ...connectAs("URX22"),
        "plugin:dialog|message": "Ok",
        midi_list_inputs: ["Controller In"],
        midi_open_input: null,
        midi_close_input: null,
        vd_get: unit.vd_get,
      }),
    }))!;
    await invoked(shell, "midi_open_input");
    const opened = shell.args[shell.invokes.indexOf("midi_open_input")] as {
      channel: { onmessage: (d: unknown) => void };
    };
    // The CH 1 -> STEREO send, drawn dashed once the channel is muted.
    const dashed = (): string | null | undefined =>
      $("graph-host")
        .querySelector<SVGPathElement>(
          'g:has(> .wire-hit[data-from="ch1:out"][data-to="bus.stereo:in"]) path:not(.wire-hit)',
        )
        ?.getAttribute("stroke-dasharray");
    expect(dashed(), "the premise: the send is drawn undimmed").toBeNull();

    $("btn-fetch").click();
    await unit.reading;
    try {
      opened.channel.onmessage([{ bytes: [0xb0, CC, 127] }]);
      await vi.waitFor(() => expect(statusText()).toBe(t().status.busySwitchRead), { timeout: 10_000 });
      expect(dashed()).toBeNull();
    } finally {
      unit.release(new Error("read-refused"));
    }
    await vi.waitFor(() => expect(errors(shell)).toEqual([t().status.fetchError("read-refused")]), { timeout: 10_000 });
    await invoked(shell, "vd_disconnect");
    expect(dashed()).toBeNull();
    opened.channel.onmessage([{ bytes: [0xb0, CC, 127] }]);
    await vi.waitFor(() => expect(dashed()).toBe("1.5 4"), { timeout: 10_000 });
  });

  // The board writes a node's place as the pointer moves and reports the move once the drag
  // ends, so a drag is refused before the node moves and ends at that refusal: what the pointer
  // does after the switch writes nothing into the plan that replaced the one it was pressed on,
  // and leaves nothing for an undo. CH 3 is a mono channel on a URX44V and
  // half of the CH 3/4 pair on a URX22, so a place carried across is one for a node the
  // switched plan does not have.
  const boardSvg = (): SVGSVGElement => $("graph-host").querySelector("svg")!;
  const placeOf = (id: string): string | null | undefined =>
    $("graph-host").querySelector(`g.node[data-id="${id}"]`)?.getAttribute("transform");
  const pointerAt = (type: string, x: number, y: number): PointerEvent =>
    new PointerEvent(type, { pointerId: 1, clientX: x, clientY: y, bubbles: true, cancelable: true });
  /** Press a node's faceplate and move the pointer, without releasing it. */
  const grabAndMove = (id: string): void => {
    faceplate($("graph-host"), id)!.dispatchEvent(pointerAt("pointerdown", 0, 0));
    boardSvg().dispatchEvent(pointerAt("pointermove", 40, 30));
  };
  for (const [flow, start, ended] of [
    ["fetch", () => $("btn-fetch").click(), () => fetchEnded()],
    [
      "live start",
      () => live().click(),
      () => vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 }),
    ],
  ] as const) {
    it(`writes nothing into the switched plan from a drag held across a switched ${flow}`, SLOW, async () => {
      const unit = holdFollowUsb();
      const shell = await bootDevice({ ...connectAs("URX22"), ...SAVES, vd_get: unit.vd_get });
      start();
      await unit.reading;
      const before = placeOf("ch3");
      try {
        grabAndMove("ch3");
        expect(placeOf("ch3")).toBe(before);
        expect(statusText()).toBe(t().status.busySwitchRead);
      } finally {
        unit.release(0);
      }
      await vi.waitFor(() => expect($<HTMLSelectElement>("model-picker").value).toBe("URX22"), { timeout: 10_000 });
      boardSvg().dispatchEvent(pointerAt("pointermove", 70, 50));
      boardSvg().dispatchEvent(pointerAt("pointerup", 70, 50));
      await ended();

      const doc = await savedPlan(shell);
      expect(doc.modelId).toBe("URX22");
      expect(doc.positions).not.toHaveProperty("ch3");
      expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
      expect(statusText()).toBe(t().status.nothingToUndo);
    });
  }

  // A press on a jack writes nothing until it moves, so one made during the read and still
  // held when the switch applies has had nothing to refuse: it is the switch that ends it, and
  // moved and released afterwards over a jack it could reach, it draws nothing into the
  // switched plan. CH 2 is the partner of the CH 1 the unit's reads put on the USB output, so
  // the drop would add it there.
  it("draws nothing into the switched plan from a jack pressed across a switched fetch", SLOW, async () => {
    const unit = holdFollowUsb();
    const shell = await bootDevice({ ...connectAs("URX22"), ...SAVES, vd_get: unit.vd_get });
    const USB_SUB = "out.usbsub:in";
    $("btn-fetch").click();
    await unit.reading;
    try {
      $("graph-host")
        .querySelector('[data-tap="ch2:out"]')!
        .dispatchEvent(pointerAt("pointerdown", 0, 0));
    } finally {
      unit.release(0);
    }
    await vi.waitFor(() => expect($<HTMLSelectElement>("model-picker").value).toBe("URX22"), { timeout: 10_000 });
    const into = $("graph-host").querySelector(`[data-ref="${USB_SUB}"]`);
    expect(into, "the premise: the switched board has the jack").not.toBeNull();
    expect(wireHit($("graph-host"), "ch2:out", USB_SUB), "the premise: the jack does not hold CH 2").toBeNull();
    const real = document.elementFromPoint;
    document.elementFromPoint = (() => into) as typeof document.elementFromPoint;
    try {
      boardSvg().dispatchEvent(pointerAt("pointermove", 200, 100));
      boardSvg().dispatchEvent(pointerAt("pointerup", 200, 100));
    } finally {
      document.elementFromPoint = real;
    }
    await fetchEnded();

    const doc = await savedPlan(shell);
    expect(doc.connections.filter((c) => c.from === "ch2:out" && c.to === USB_SUB)).toEqual([]);
    expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
    expect(statusText()).toBe(t().status.nothingToUndo);
  });

  // A drag already moving when a switched read begins is ended there and reported as the edit
  // it is, rather than kept against the read: the moves after it write nothing, and once the
  // read has failed an undo takes the drag back.
  it("reports a drag already moving when a switched fetch begins, as an edit an undo takes back", SLOW, async () => {
    const unit = holdFollowUsb();
    const shell = await bootDevice({ ...connectAs("URX22"), vd_get: unit.vd_get });
    const before = placeOf("ch1");
    grabAndMove("ch1");
    const moved = placeOf("ch1");
    expect(moved, "the premise: the drag moved the node").not.toBe(before);
    $("btn-fetch").click();
    await unit.reading;
    try {
      boardSvg().dispatchEvent(pointerAt("pointermove", 90, 70));
      expect(placeOf("ch1")).toBe(moved);
      boardSvg().dispatchEvent(pointerAt("pointerup", 90, 70));
    } finally {
      unit.release(new Error("read-refused"));
    }
    await vi.waitFor(() => expect(errors(shell)).toEqual([t().status.fetchError("read-refused")]), { timeout: 10_000 });
    await fetchEnded();
    expect(placeOf("ch1")).toBe(moved);
    expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
    await vi.waitFor(() => expect(placeOf("ch1")).toBe(before), { timeout: 10_000 });
  });

  // The same for the inspector, whose rebuild a control can hold — a picker left open, a
  // composition in flight — while the switch replaces the plan the panel was built for. The
  // panel is rebuilt past that hold, and what the old control still delivers reaches nothing:
  // the switched plan is left with nothing to undo.
  for (const [control, hold, deliver] of [
    [
      "a picker",
      () => {
        const picker = row(t().inspector.recPoint).querySelector<HTMLSelectElement>("select")!;
        picker.focus();
        return picker;
      },
      (picker: HTMLElement) => {
        // Neither the value it showed nor the one the switched plan read (every read here
        // answers 0), so a choice that landed would move the switched plan.
        const sel = picker as HTMLSelectElement;
        sel.value = [...sel.options].find((o) => o.value !== sel.value && o.value !== "0")!.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      },
    ],
    [
      "a name being composed",
      () => {
        const field = row(t().inspector.name).querySelector<HTMLInputElement>("input")!;
        field.focus();
        field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        return field;
      },
      (field: HTMLElement) => {
        (field as HTMLInputElement).value = "Vox";
        field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      },
    ],
  ] as const) {
    it(`takes nothing into the switched plan from ${control} held across a switched fetch`, SLOW, async () => {
      const unit = holdFollowUsb();
      const shell = await bootDevice({ ...connectAs("URX22"), vd_get: unit.vd_get });
      selectNode("ch1");
      $("btn-fetch").click();
      await unit.reading;
      let held: HTMLElement;
      try {
        held = hold();
      } finally {
        unit.release(0);
      }
      await vi.waitFor(() => expect($<HTMLSelectElement>("model-picker").value).toBe("URX22"), { timeout: 10_000 });
      expect(held.isConnected, "the panel built for the replaced plan is gone").toBe(false);
      deliver(held);
      await fetchEnded();
      expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
      expect(statusText()).toBe(t().status.nothingToUndo);
    });
  }

  // A tuning screen holds its rebuild while a pointer is down on it, and binds to its node
  // again when the plan changes under it. A switch replaces the plan: the screen rebuilds past
  // the press, so the slider the pointer was on is gone with the plan it was built for, and
  // until that press ends nothing it drives writes — neither the slider it began on nor the
  // switched plan's own under the pointer.
  it("ends a tuning-screen press held across a switched fetch", SLOW, async () => {
    const unit = holdFollowUsb();
    const shell = await bootDevice({ ...connectAs("URX22"), vd_get: unit.vd_get });
    $("btn-view-console").click();
    $("btn-fetch").click();
    await unit.reading;
    const threshold = (): HTMLInputElement =>
      $("dyn-screen-box").querySelector<HTMLInputElement>('input[data-dyn="threshold"]')!;
    let held: HTMLInputElement;
    try {
      $("console-host").querySelector(".con-strip")!.querySelector<HTMLElement>(".con-chip-open")!.click(); // GATE
      held = threshold();
      held.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, bubbles: true }));
    } finally {
      unit.release(0);
    }
    await vi.waitFor(() => expect($<HTMLSelectElement>("model-picker").value).toBe("URX22"), { timeout: 10_000 });
    expect(held.isConnected, "the slider built for the replaced plan is gone").toBe(false);
    const shown = threshold().value;
    for (const slider of [held, threshold()]) {
      slider.value = String(Number(slider.value) - 5);
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    }
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
    expect(threshold().value, "the rows show what the switched plan holds once the press ends").toBe(shown);
    await fetchEnded();
    expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
    expect(statusText()).toBe(t().status.nothingToUndo);
    // The positive control: the switched plan's own slider takes a drag, as an edit an undo
    // takes back.
    const fresh = threshold();
    const was = fresh.value;
    fresh.value = String(Number(was) - 5);
    fresh.dispatchEvent(new Event("input", { bubbles: true }));
    fresh.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
    await vi.waitFor(() => expect(threshold().value).toBe(was), { timeout: 10_000 });
  });

  // The keyboard's counterpart. A key held down goes on repeating into whatever holds the
  // focus, and the CONSOLE hands the focus on across a rebuild of its strips. A key pressed on
  // CH 1's fader while a switched read runs is refused; once the switch applies, its repeats
  // reach no control of the switched plan, which is left with nothing to undo. A fresh press
  // on the switched plan's own fader is the positive control: it moves the fader, as an edit an
  // undo takes back.
  const mainFader = (): HTMLElement =>
    $("console-host").querySelector(".con-strip")!.querySelector<HTMLElement>(".con-fader")!;
  /** CH 1's fader readout, which names the level to the step the keys move it by. */
  const mainLevel = (): string | null =>
    $("console-host").querySelector(".con-strip")!.querySelector(".con-readout .rv")!.textContent;
  const arrowUp = (target: EventTarget, repeat: boolean): void => {
    for (const type of repeat ? ["keydown"] : ["keydown", "keyup"])
      target.dispatchEvent(new KeyboardEvent(type, { key: "ArrowUp", repeat, bubbles: true, cancelable: true }));
  };
  for (const [flow, start, ended] of [
    ["fetch", () => $("btn-fetch").click(), () => fetchEnded()],
    [
      "live start",
      () => live().click(),
      () => vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 }),
    ],
  ] as const) {
    it(`takes nothing into the switched plan from a key held across a switched ${flow}`, SLOW, async () => {
      const unit = holdFollowUsb();
      const shell = await bootDevice({ ...connectAs("URX22"), vd_get: unit.vd_get });
      $("btn-view-console").click();
      start();
      await unit.reading;
      try {
        mainFader().focus();
        mainFader().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
        await tick();
        expect(statusText(), "the premise: the press was refused").toBe(t().status.busySwitchRead);
      } finally {
        unit.release(0);
      }
      await vi.waitFor(() => expect($<HTMLSelectElement>("model-picker").value).toBe("URX22"), { timeout: 10_000 });
      const shown = mainLevel();
      const held = document.activeElement ?? document.body;
      for (let i = 0; i < 3; i++) arrowUp(held, true);
      held.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowUp", bubbles: true, cancelable: true }));
      await ended();

      expect(mainLevel()).toBe(shown);
      expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
      expect(statusText()).toBe(t().status.nothingToUndo);
      mainFader().focus();
      arrowUp(mainFader(), false);
      expect(mainLevel(), "the positive control: a fresh press moves it").not.toBe(shown);
      await tick();
      expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
      await vi.waitFor(() => expect(mainLevel()).toBe(shown), { timeout: 10_000 });
    });
  }

  // Once the read is over, whichever way it ended, the plan on screen takes a drag again and
  // an undo takes it back: the refusal is a property of the read, not of the press.
  const dragBackOnUndo = async (shell: TauriShell, id: string): Promise<void> => {
    const before = placeOf(id);
    grabAndMove(id);
    boardSvg().dispatchEvent(pointerAt("pointerup", 40, 30));
    expect(placeOf(id), "the drag moved the node").not.toBe(before);
    await tick(); // the drag's own entry closes
    expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
    await vi.waitFor(() => expect(placeOf(id)).toBe(before), { timeout: 10_000 });
  };
  for (const [flow, start, finish, model] of [
    [
      "fetch that switched",
      () => $("btn-fetch").click(),
      async (unit: ReturnType<typeof holdFollowUsb>) => {
        unit.release(0);
        await fetchEnded();
      },
      "URX22",
    ],
    [
      "fetch that failed",
      () => $("btn-fetch").click(),
      async (unit: ReturnType<typeof holdFollowUsb>) => {
        unit.release(new Error("read-refused"));
        await fetchEnded();
      },
      "URX44V",
    ],
    [
      "fetch that was cancelled",
      () => $("btn-fetch").click(),
      async (unit: ReturnType<typeof holdFollowUsb>) => {
        $("btn-fetch").click(); // a second click cancels
        unit.release(0);
        await vi.waitFor(() => expect(statusText()).toBe(t().status.canceled), { timeout: 10_000 });
        await fetchEnded();
      },
      "URX44V",
    ],
    [
      "live start that switched",
      () => live().click(),
      async (unit: ReturnType<typeof holdFollowUsb>) => {
        unit.release(0);
        await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
      },
      "URX22",
    ],
    [
      "live start that failed",
      () => live().click(),
      async (unit: ReturnType<typeof holdFollowUsb>) => {
        unit.release(new Error("read-refused"));
        await vi.waitFor(() => expect($<HTMLSelectElement>("rate-picker").disabled).toBe(false), { timeout: 25_000 });
      },
      "URX44V",
    ],
  ] as const) {
    it(`takes a drag and its undo again after a ${flow}`, SLOW, async () => {
      const unit = holdFollowUsb();
      const shell = await bootDevice({ ...connectAs("URX22"), vd_get: unit.vd_get });
      start();
      await unit.reading;
      try {
        grabAndMove("ch1");
        expect(statusText(), "the premise: the drag was refused").toBe(t().status.busySwitchRead);
        boardSvg().dispatchEvent(pointerAt("pointerup", 40, 30));
      } finally {
        await finish(unit);
      }
      expect($<HTMLSelectElement>("model-picker").value).toBe(model);
      await dragBackOnUndo(shell, "ch1");
    });
  }

  // The refusal lasts as long as the read and no longer. Past it the plan on screen is the one
  // that stays — kept by a fetch whose incomplete read switches nothing, or put there by a
  // live start whose read applied the switch — and an edit made while the flow is still
  // releasing its link or registering its session lands.
  const heldCommand = (): { asked: Promise<void>; release: () => void; answer: () => Promise<null> } => {
    let ask = (): void => {};
    const asked = new Promise<void>((r) => (ask = r));
    let release = (): void => {};
    const released = new Promise<void>((r) => (release = r));
    return { asked, release: () => release(), answer: () => (ask(), released.then(() => null)) };
  };

  it("takes edits again once a switched fetch's read is over, before its link is released", SLOW, async () => {
    const disconnect = heldCommand();
    const shell = await bootDevice({
      ...connectAs("URX22"),
      vd_get: (a: Record<string, unknown>) => {
        if (a.paramId === PARAMS.CH_ON.id) throw new Error("read-refused");
        return 0;
      },
      vd_disconnect: disconnect.answer,
      "plugin:dialog|message": byMessage((m) => m !== t().confirm.deviceErrorExport),
    });
    $("btn-view-console").click();
    $("btn-fetch").click();
    await disconnect.asked;
    const before = sendValue();
    try {
      expect($<HTMLSelectElement>("model-picker").value, "the premise: the incomplete read switched nothing").toBe(
        "URX44V",
      );
      stepSendUp();
      await tick();
      expect(sendValue()).not.toBe(before);
      expect(statusText()).not.toBe(t().status.busySwitchRead);
    } finally {
      disconnect.release();
    }
    await vi.waitFor(() => expect(confirms(shell)).toContain(t().confirm.deviceErrorExport), { timeout: 10_000 });
    expect(sendValue()).not.toBe(before);
  });

  it("takes edits again once a switched live start's read is over, while its session registers", SLOW, async () => {
    const subscribe = heldCommand();
    await bootDevice({ ...connectAs("URX22"), vd_params_subscribe: subscribe.answer });
    live().click();
    await subscribe.asked;
    try {
      expect($<HTMLSelectElement>("model-picker").value, "the premise: the read applied the switch").toBe("URX22");
      // The oscillator, which the unit here holds OFF.
      turnOscOn();
      await tick();
      expect(oscFace()).toBe("ON");
      expect(statusText()).not.toBe(t().status.busySwitchRead);
    } finally {
      subscribe.release();
    }
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    expect(oscFace()).toBe("ON");
  });

  // And once a switched read has failed: the plan on screen is then the one that stays, so an
  // edit made while the flow is still releasing its link lands.
  for (const [flow, start, failure] of [
    ["fetch", () => $("btn-fetch").click(), (m: string) => t().status.fetchError(m)],
    ["live start", () => live().click(), (m: string) => t().status.liveError(m)],
  ] as const) {
    it(`takes edits again once a switched ${flow}'s read has failed, before its link is released`, SLOW, async () => {
      const disconnect = heldCommand();
      const shell = await bootDevice({
        ...connectAs("URX22"),
        vd_get: (a: Record<string, unknown>) => {
          if (a.paramId === PARAMS.FOLLOW_USB.id) throw new Error("read-refused");
          return 0;
        },
        vd_disconnect: disconnect.answer,
      });
      $("btn-view-console").click();
      start();
      await disconnect.asked;
      const before = sendValue();
      try {
        expect($<HTMLSelectElement>("model-picker").value, "the premise: the failed read switched nothing").toBe(
          "URX44V",
        );
        stepSendUp();
        await tick();
        expect(sendValue()).not.toBe(before);
        expect(statusText()).not.toBe(t().status.busySwitchRead);
      } finally {
        disconnect.release();
      }
      await vi.waitFor(() => expect(errors(shell)).toEqual([failure("read-refused")]), { timeout: 10_000 });
      expect(sendValue()).not.toBe(before);
    });
  }

  // A refused edit's restore runs after the funnel that refused it, so an edit refused in the
  // step the read resolves in has its restore run once the switch has been applied. The plan on
  // screen is the switch's by then, and so is the status line, which the restore leaves
  // standing. The first fetch counts the reads a switched fetch of this unit takes, so the
  // second can edit at every step from its last read on until the switch is applied.
  it("leaves the switch's status line standing when a refused edit's restore runs after the switch", SLOW, async () => {
    let reads = 0;
    const count = (a: Record<string, unknown>): number => (reads++, unwrittenRead(a));
    const shell = await bootDevice({
      ...connectAs("URX22"),
      vd_get: (a: Record<string, unknown>) => (a.paramId === PARAMS.FOLLOW_USB.id ? 0 : count(a)),
    });
    const picker = $<HTMLSelectElement>("model-picker");
    $("btn-view-console").click();
    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");
    await vi.waitFor(() => expect(picker.value).toBe("URX22"), { timeout: 10_000 });
    const total = reads;
    // Back to the model the fetch switched from, so the next fetch offers the same switch.
    picker.value = "URX44V";
    picker.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(statusText()).toBe(t().status.switchedModel("URX44V")), { timeout: 10_000 });

    reads = 0;
    const unit = holdFollowUsb(count);
    shell.answer("vd_get", unit.vd_get);
    $("btn-fetch").click();
    await unit.reading;
    unit.release(0);
    let edits = 0;
    for (let hop = 0; hop < 100_000 && picker.value === "URX44V"; hop++) {
      await Promise.resolve();
      if (picker.value === "URX44V" && reads >= total) {
        stepSendUp();
        edits++;
      }
    }
    expect(picker.value, "the premise: the read applied the switch").toBe("URX22");
    expect(edits, "the premise: edits were made from the read's last step on").toBeGreaterThan(0);
    await invoked(shell, "vd_disconnect", 2);
    await tick();
    expect(statusText()).not.toBe(t().status.busySwitchRead);
    expect(countFor(statusText(), (n) => t().status.fetchedDevice("URX22", n))).toBeGreaterThan(50);
  });

  // A switch the operator took replaces the plan only once the read into the new plan has
  // landed. Each case below edits the plan first, so "as it was" is observable twice: the
  // edit still on the board, and still the entry an undo takes back — a replacement drops
  // both, whatever the picker then says.
  const editFirst = async (): Promise<void> => {
    turnOscOn();
    expect(oscFace(), "the premise: the edit landed").toBe("ON");
    await new Promise((r) => setTimeout(r, 0)); // the press's own entry closes
  };
  const unswitched = async (shell: TauriShell): Promise<void> => {
    expect($<HTMLSelectElement>("model-picker").value).toBe("URX44V");
    expect(oscFace()).toBe("ON");
    await undoTo(shell, "OFF");
  };
  const TAKEN = [t().confirm.discard, t().confirm.switchModel("URX22", "URX44V")];

  for (const [flow, start, failure] of [
    ["fetch", () => $("btn-fetch").click(), (m: string) => t().status.fetchError(m)],
    ["live start", () => live().click(), (m: string) => t().status.liveError(m)],
  ] as const) {
    it(`leaves the plan and its model as they were when a switched ${flow}'s Follow USB read fails`, SLOW, async () => {
      const shell = await bootDevice({
        ...connectAs("URX22"),
        vd_get: (a: Record<string, unknown>) => {
          if (a.paramId === PARAMS.FOLLOW_USB.id) throw new Error("read-refused");
          return 0;
        },
      });
      await editFirst();
      start();
      await vi.waitFor(() => expect(errors(shell)).toEqual([failure("read-refused")]), { timeout: 10_000 });
      await invoked(shell, "vd_disconnect");

      expect(confirms(shell), "the premise: the switch was offered and taken").toEqual(TAKEN);
      await unswitched(shell);
    });
  }

  it("leaves the plan and its model as they were when a switched fetch is cancelled", SLOW, async () => {
    let reads = 0;
    const shell = await bootDevice({
      ...connectAs("URX22"),
      vd_get: () => {
        // The first read is Follow USB's, so the third is inside the plan read: a second
        // click there cancels it.
        if (++reads === 3) $("btn-fetch").click();
        return 0;
      },
    });
    await editFirst();
    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");
    await vi.waitFor(() => expect(statusText()).toBe(t().status.canceled), { timeout: 10_000 });

    expect(reads, "the premise: the plan read had begun").toBeGreaterThanOrEqual(3);
    expect(errors(shell)).toEqual([]);
    expect(confirms(shell), "the premise: the switch was offered and taken").toEqual(TAKEN);
    await unswitched(shell);
  });

  // A live session starts only from a complete read, so an incomplete one is a read that
  // failed on this side, and the switch it carried is not applied either.
  it("leaves the plan and its model as they were when a switched live start reads incompletely", SLOW, async () => {
    const shell = await bootDevice({
      ...connectAs("URX22"),
      vd_get: (a: Record<string, unknown>) => {
        if (a.paramId === PARAMS.CH_ON.id) throw new Error("read-refused");
        return 0;
      },
    });
    await editFirst();
    live().click();
    await vi.waitFor(() => expect(errors(shell)).toHaveLength(1), { timeout: 10_000 });
    await invoked(shell, "vd_disconnect");

    const incomplete = (n: number): string => t().status.liveError(t().error.liveReadIncomplete(n));
    expect(countFor(errors(shell)[0], incomplete)).toBeGreaterThan(0);
    expect(live().getAttribute("aria-checked")).toBe("false");
    expect(confirms(shell), "the premise: the switch was offered and taken").toEqual(TAKEN);
    await unswitched(shell);
  });

  /** The nodes the board flags as not read from the device. */
  const flagged = (): string[] =>
    [...$("graph-host").querySelectorAll("g.node[data-id]")]
      .filter((g) => [...g.querySelectorAll("text")].some((el) => el.textContent === "?"))
      .map((g) => g.getAttribute("data-id")!);

  // A fetch into the switch's plan is applied only when it read everything, as a live start
  // is: one that read part of the unit — its link dropping on the way, or one parameter
  // refused — switches nothing and puts nothing it read on screen, and still says so on the
  // status line and offers the report on what it could not read.
  for (const [how, rest, status] of [
    [
      "its link drops",
      (): number => {
        throw new Error("device-lost");
      },
      (line: string) => expect(line).toBe(t().error.shell.deviceLost),
    ],
    [
      "one parameter is refused",
      (a: Record<string, unknown>): number => {
        if (a.paramId === PARAMS.CH_ON.id) throw new Error("read-refused");
        return 0;
      },
      (line: string) => {
        const failed = Number(/\d+/.exec(line)?.[0]);
        expect(line).toBe(t().status.fetchSwitchIncomplete(failed, "URX22", "URX44V"));
        expect(failed).toBeGreaterThan(0);
      },
    ],
  ] as const) {
    it(
      `leaves the plan and its model as they were when a switched fetch's read is cut short: ${how}`,
      SLOW,
      async () => {
        const shell = await bootDevice({
          ...connectAs("URX22"),
          vd_get: (a: Record<string, unknown>) => (a.paramId === PARAMS.FOLLOW_USB.id ? 0 : rest(a)),
          "plugin:dialog|message": byMessage((m) => m !== t().confirm.deviceErrorExport),
        });
        const badge = (): string | undefined => $("follow-usb").dataset.state;
        const badgeBefore = badge();
        await editFirst();
        $("btn-fetch").click();
        await vi.waitFor(() => expect(confirms(shell)).toContain(t().confirm.deviceErrorExport), { timeout: 10_000 });
        await invoked(shell, "vd_disconnect");

        expect(confirms(shell), "the switch was taken and the report offered").toEqual([
          ...TAKEN,
          t().confirm.deviceErrorExport,
        ]);
        expect(errors(shell)).toEqual([]);
        status(statusText());
        expect(flagged()).toEqual([]);
        expect(badge()).toBe(badgeBefore);
        await unswitched(shell);
      },
    );
  }

  // An incomplete read with no switch in it merges nothing either, as a live start: the plan
  // on screen keeps what it held — no node flagged as unread, the edit made before it still
  // standing and still the entry an undo takes back — and the session does not start.
  it("merges nothing from an incomplete live start on the plan's own model", SLOW, async () => {
    const shell = await bootDevice({
      vd_get: (a: Record<string, unknown>) => {
        if (a.paramId === PARAMS.CH_ON.id) throw new Error("read-refused");
        return 0;
      },
    });
    await editFirst();
    live().click();
    await vi.waitFor(() => expect(errors(shell)).toHaveLength(1), { timeout: 10_000 });
    await invoked(shell, "vd_disconnect");

    const incomplete = (n: number): string => t().status.liveError(t().error.liveReadIncomplete(n));
    expect(countFor(errors(shell)[0], incomplete)).toBeGreaterThan(0);
    expect(live().getAttribute("aria-checked")).toBe("false");
    expect(flagged()).toEqual([]);
    // Read back from the plan rather than off the panel the edit left drawn: the inspector is
    // rebuilt by way of another node, for the reason the draw-failure cases below give.
    selectNode("ch1");
    expect(oscOn()).toBe("ON");
    await undoTo(shell, "OFF");
  });

  // A fetch on the plan's own model is the one read that keeps a partial result: the values it
  // did read land (the oscillator the unit holds OFF, over the edit made before it), each node
  // whose read did not come through is flagged, and the history is re-taken from there.
  it("keeps what an incomplete fetch on the plan's own model did read", SLOW, async () => {
    const shell = await bootDevice({
      vd_get: (a: Record<string, unknown>) => {
        if (a.paramId === PARAMS.CH_ON.id) throw new Error("read-refused");
        return 0;
      },
      "plugin:dialog|message": byMessage((m) => m !== t().confirm.deviceErrorExport),
    });
    await editFirst();
    $("btn-fetch").click();
    await vi.waitFor(() => expect(confirms(shell)).toContain(t().confirm.deviceErrorExport), { timeout: 10_000 });
    await invoked(shell, "vd_disconnect");

    const [n, failed, unread] = [...statusText().matchAll(/\d+/g)].map((m) => Number(m[0]));
    expect(statusText()).toBe(t().status.fetchPartial(n, failed, unread));
    expect(n).toBeGreaterThan(0);
    expect(flagged()).toContain("ch1");
    // By way of another node, for the reason the draw-failure cases below give.
    selectNode("ch1");
    expect(oscOn()).toBe("OFF");
    expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
    expect(statusText()).toBe(t().status.nothingToUndo);
  });

  // A switch whose plan cannot be drawn is not applied: loadPlan puts the plan on screen back
  // and reports the failure itself, and the flow ends there with the link handed back and
  // nothing registered.
  for (const [flow, start] of [
    ["fetch", () => $("btn-fetch").click()],
    ["live start", () => live().click()],
  ] as const) {
    it(`leaves the plan and its model as they were when a switched ${flow}'s plan cannot be drawn`, SLOW, async () => {
      const shell = await bootDevice(connectAs("URX22"));
      // The class the booted app draws with: each boot imports the modules afresh.
      const { Graph } = await import("./ui/graph");
      const draw = Graph.prototype.setModel;
      let armed = true;
      const spy = vi.spyOn(Graph.prototype, "setModel").mockImplementation(function (
        this: InstanceType<typeof Graph>,
        ...args: Parameters<typeof draw>
      ) {
        if (armed && args[1].modelId === "URX22") {
          armed = false;
          throw new Error("draw-failed");
        }
        draw.apply(this, args);
      });
      try {
        await editFirst();
        start();
        await vi.waitFor(() => expect(errors(shell)).toEqual([t().status.loadError("draw-failed")]), {
          timeout: 10_000,
        });
        await invoked(shell, "vd_disconnect");

        expect(armed, "the premise: the switch's plan was the one drawn").toBe(false);
        expect(confirms(shell), "the premise: the switch was offered and taken").toEqual(TAKEN);
        expect(shell.count("vd_params_subscribe")).toBe(0);
        expect(live().getAttribute("aria-checked")).toBe("false");
        await vi.waitFor(() => expect($<HTMLButtonElement>("btn-fetch").disabled).toBe(false), { timeout: 10_000 });
        expect($("btn-fetch").textContent).toBe(t().toolbar.fetchDevice);
        expect($<HTMLSelectElement>("model-picker").value).toBe("URX44V");
        // A failed draw drops the selection (loadPlan). The oscillator is selected again by
        // way of another node: a second press on it inside the board's double-press window
        // opens its note editor instead.
        selectNode("ch1");
        expect(oscOn()).toBe("ON");
        await undoTo(shell, "OFF");
      } finally {
        spy.mockRestore();
      }
    });
  }
});
