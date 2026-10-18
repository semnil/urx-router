// @vitest-environment jsdom

// Write to device, the failure report it offers, and the plan it holds while it writes.
//
// The setup, the teardown and the helpers every desktop case shares are `main.device.test-util.ts`'s,
// which also states what the device table does and does not model.

import { describe, expect, it, vi } from "vitest";
import { $, bootApp, deviceCommands, statusText } from "./main.test-util";
import type { TauriShell } from "./main.test-util";
import { formatRate } from "./core/constraints";
import { PARAMS } from "./core/control/params";
import { SUPPORTED_SYSTEM_FIRMWARE } from "./core/control/firmware";
import { defaultPlan } from "./models/initial-state";
import { EDIT_MENU_EVENT, EDIT_UNDO_ID } from "./core/platform";
import { t } from "./i18n";
import {
  SLOW,
  bootDevice,
  invoked,
  row,
  selectNode,
  clockReads,
  stripsNamed,
  confirms,
  chooseRate,
  TRACK_COUNT_SEED,
  TRACK_COUNT_ADDR,
  PLAYBACK_SEED,
  PLAYBACK_ADDR,
  FOLLOW_USB_SEED,
  errors,
  byMessage,
  invariantOf,
  WRITE_ASK,
  RETRY_ASK,
  countFor,
  SAVES,
  connectAs,
  diffReadsFail,
  paramRow,
} from "./main.device.test-util";

describe("Write to device", () => {
  // The store answers the unwritten clock with 0, so the device reads as being on a rate
  // the plan is not — and the RATE confirm is what comes up. Named for
  // it, because the write-count confirm is a different dialog on a later line and the
  // case below is the one that reaches it.
  it("asks before writing at a rate the device is not on, and writes nothing when declined", SLOW, async () => {
    const shell = await bootDevice({}, false); // decline every confirm
    $("btn-write").click();
    await vi.waitFor(() => expect(confirms(shell).length).toBeGreaterThan(0), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(confirms(shell).at(-1)).toBe(t().confirm.reclock(formatRate(0), formatRate(48_000)));
    expect(shell.count("vd_set")).toBe(0);
  });

  // The unit lowers its own Track Count to fit a rate it cannot carry and nothing the app
  // can write raises it again, so this is the one rate side effect that has to be in front
  // of the decision. 16 tracks at 96 kHz becomes 8.
  it("names what a rate change costs the recorder, before writing it", SLOW, async () => {
    const shell = await bootDevice({}, false, { [TRACK_COUNT_SEED]: 8 });
    chooseRate(96_000);
    $("btn-write").click();
    // The flow's own terminal command, not a sleep: a case that returns while the write is
    // still unwinding leaves an app running against a shell the next case replaces, and
    // its writes then land on that one's counter.
    await invoked(shell, "vd_disconnect");
    const asked = confirms(shell).at(-1) ?? "";
    // Both halves: the rate question it was already asking, and the cost it was not.
    expect(asked).toContain(t().confirm.reclock(formatRate(0), formatRate(96_000)));
    expect(asked).toContain(t().confirm.trackCountDrop(16, 8));
    expect(shell.count("vd_set")).toBe(0);
  });

  // The other half of the same rule, and the one that keeps the warning worth reading: a
  // count the new rate can already carry loses nothing, and saying so anyway puts an
  // irreversible-loss notice in front of someone losing nothing.
  it("says nothing about the recorder when the count already fits the new rate", SLOW, async () => {
    const shell = await bootDevice({}, false, { [TRACK_COUNT_SEED]: 4 }); // 8 tracks
    chooseRate(96_000);
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    const asked = confirms(shell).at(-1) ?? "";
    expect(asked).toContain(t().confirm.reclock(formatRate(0), formatRate(96_000)));
    expect(asked).not.toContain("Track Count");
    expect(shell.count("vd_set")).toBe(0);
  });

  // The count is read from the unit before the rate question is asked, and a read that
  // fails ends the write there, as every read on the link does: no question, nothing sent.
  // The two cases above, whose read answers, are what show this flow reaches it.
  it("writes nothing, and asks nothing, when the recorder's count cannot be read", SLOW, async () => {
    const shell = await bootDevice(
      {
        vd_get: (a: Record<string, unknown>) => {
          if (`${a.paramId}:${a.x}:${a.y}` === TRACK_COUNT_ADDR) throw new Error("timeout");
          return 0;
        },
      },
      false,
    );
    chooseRate(96_000);
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    await vi.waitFor(
      () => expect(errors(shell)).toEqual([t().status.writeError(t().error.trackCountUnread("timeout"))]),
      { timeout: 10_000 },
    );

    expect(confirms(shell)).toEqual([]);
    expect(shell.count("vd_set")).toBe(0);
  });

  // The unit keeps its own rate control out of reach while the recorder holds a file, and a
  // rate written over the link then ends the playback. Playing (1) and paused (2) both hold
  // one; the reclock confirm above, with nothing held, is what shows this flow reaches it.
  it.each([1, 2])(
    "writes nothing, and asks nothing, while the recorder holds a file (state %i)",
    SLOW,
    async (state) => {
      const shell = await bootDevice({}, true, { [PLAYBACK_SEED]: state });
      chooseRate(96_000);
      $("btn-write").click();
      await invoked(shell, "vd_disconnect");
      await vi.waitFor(
        () =>
          expect(errors(shell)).toEqual([
            t().status.writeError(t().error.rateDuringPlayback(formatRate(0), formatRate(96_000))),
          ]),
        { timeout: 10_000 },
      );
      expect(confirms(shell)).toEqual([]);
      expect(shell.count("vd_set")).toBe(0);
    },
  );

  // Recording (3), record standby (4) and a paused recording (5) hold the rate the same way, and say so.
  it.each([3, 4, 5])(
    "writes nothing, and asks nothing, while the recorder holds a recording (state %i)",
    SLOW,
    async (state) => {
      const shell = await bootDevice({}, true, { [PLAYBACK_SEED]: state });
      chooseRate(96_000);
      $("btn-write").click();
      await invoked(shell, "vd_disconnect");
      await vi.waitFor(
        () =>
          expect(errors(shell)).toEqual([
            t().status.writeError(t().error.rateDuringRecording(formatRate(0), formatRate(96_000))),
          ]),
        { timeout: 10_000 },
      );
      expect(confirms(shell)).toEqual([]);
      expect(shell.count("vd_set")).toBe(0);
    },
  );

  it("writes nothing when whether the recorder is playing cannot be read", SLOW, async () => {
    const shell = await bootDevice(
      {
        vd_get: (a: Record<string, unknown>) => {
          if (`${a.paramId}:${a.x}:${a.y}` === PLAYBACK_ADDR) throw new Error("timeout");
          return 0;
        },
      },
      true,
    );
    chooseRate(96_000);
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    await vi.waitFor(
      () => expect(errors(shell)).toEqual([t().status.writeError(t().error.playbackUnread("timeout"))]),
      { timeout: 10_000 },
    );
    expect(confirms(shell)).toEqual([]);
    expect(shell.count("vd_set")).toBe(0);
  });

  // With Follow USB on, the operator picks: adopting the device's rate writes no rate and
  // stays open while a file is held, releasing to the plan's would write one and stops.
  it.each([
    [1, (from: string, to: string) => t().error.rateDuringPlayback(from, to)],
    [4, (from: string, to: string) => t().error.rateDuringRecording(from, to)],
  ])(
    "lets a held recorder (state %i) adopt the device's rate but not release to the plan's",
    SLOW,
    async (state, refusal) => {
      const release = await bootDevice({}, true, { [PLAYBACK_SEED]: state, [FOLLOW_USB_SEED]: 1 });
      chooseRate(96_000);
      $("btn-write").click();
      await vi.waitFor(() => expect($("rate-choice").hidden).toBe(false), { timeout: 10_000 });
      $("rate-choice-release").click();
      await invoked(release, "vd_disconnect");
      await vi.waitFor(
        () => expect(errors(release)).toEqual([t().status.writeError(refusal(formatRate(0), formatRate(96_000)))]),
        { timeout: 10_000 },
      );
      expect(release.count("vd_set")).toBe(0);
    },
  );

  // The read is worth nothing until something redraws. The plan taking the unit's value
  // is not the same as the operator seeing it: the follow queue this tail used to call
  // drains a dirty-node set the tail never fills, so it repainted nothing and the panel
  // went on showing the count from before the write until some other selection rebuilt it.
  it("shows the recorder's re-read count without any further interaction", SLOW, async () => {
    // The unit holds the full 16 tracks (839 counts stereo pairs), which 96 kHz cannot
    // carry — so the write earns a re-read. The plan is put on 4, so what the read brings
    // back differs from what the panel is showing and the difference is visible.
    const shell = await bootDevice({}, true, { [TRACK_COUNT_SEED]: 8 });
    selectNode("out.sdrec");
    const menu = row(t().inspector.sdRecTrackCount).querySelector<HTMLSelectElement>("select")!;
    // Driven the way the operator does — through the app's own change handler — rather
    // than by assigning the plan, so the case measures the surface it is about.
    menu.value = "4";
    menu.dispatchEvent(new Event("change", { bubbles: true }));
    expect(menu.value).toBe("4");

    const beforeSlots = $("graph-host").querySelectorAll('g.node[data-id^="out.sdrec.t"]').length;
    chooseRate(96_000);
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");

    // The SAME element, re-read from the document: no reselection, no other gesture.
    const after = row(t().inspector.sdRecTrackCount).querySelector<HTMLSelectElement>("select")!;
    expect(after.value).toBe("16");
    // And the board followed too, which is why this needs a render rather than a node
    // repaint: the count decides how many recorder slots are drawn as active, so the
    // graph carries the slot nodes the new count reaches.
    const slots = $("graph-host").querySelectorAll('g.node[data-id^="out.sdrec.t"]');
    // The exact counts, not "more than none": the board draws two recorder slot nodes for
    // the count the panel was showing and four for the one the read brought back, and a
    // lower bound of zero passes on either — so it says nothing about the render this
    // needs, and the Inspector's own assertion above would carry the case alone.
    expect(beforeSlots).toBe(2);
    expect(slots.length).toBe(4);
  });

  // Cancelling BETWEEN two sends is not the same as cancelling before the first. The rate
  // goes out first, and `sendCommands` detects the abort at the top of the NEXT iteration
  // and throws — taking every outcome collected so far with it. A flag armed from the
  // returned outcomes is therefore never set, and the recorder the unit has just lowered
  // is never re-read.
  it("re-reads the recorder when the write is cancelled right after the rate lands", SLOW, async () => {
    const shell = await bootDevice({}, true, { [TRACK_COUNT_SEED]: 8 });
    chooseRate(96_000);
    // Cancel the moment the rate is acked: clicking the write button again aborts it.
    shell.answer("vd_set", (a: Record<string, unknown>) => {
      if (Number(a.paramId) === 766) queueMicrotask(() => $("btn-write").click());
      return null;
    });
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");

    expect(readAfterLastWrite(shell)).toBe(true);
  });

  /** Was the recorder's Track Count read AFTER something was written? The only reading that
   *  separates the epilogue from the write's own diff, which reads the same address before
   *  anything goes out — so counting reads of it passes whether or not the epilogue runs. */
  const readAfterLastWrite = (shell: TauriShell): boolean => {
    const lastSet = shell.invokes.lastIndexOf("vd_set");
    expect(lastSet).toBeGreaterThan(-1);
    return shell.invokes.some((cmd, i) => {
      if (i <= lastSet || cmd !== "vd_get") return false;
      const a = shell.args[i] ?? {};
      return `${a.paramId}:${a.x}:${a.y}` === TRACK_COUNT_ADDR;
    });
  };

  /** A rate write the device answers with `fail`, with the retry a STOPPED write offers
   *  declined — a stub that agrees to everything retries the same failure for ever.
   *  Declined by whether anything has been SENT rather than by counting: the reclock confirm
   *  and the write's own both come before the first command goes out, and the retry is the
   *  only one that can follow it. */
  const rateWriteAnswered = async (fail: string): Promise<TauriShell> => {
    let sent = false;
    const shell = await bootDevice(
      {
        "plugin:dialog|message": (a: Record<string, unknown>) => (a.buttons === "OkCancel" && sent ? "Cancel" : "Ok"),
      },
      true,
      { [TRACK_COUNT_SEED]: 8 },
    );
    chooseRate(96_000);
    shell.answer("vd_set", (a: Record<string, unknown>) => {
      sent = true;
      if (Number(a.paramId) === PARAMS.SAMPLE_RATE.id) throw new Error(`${fail}: ${a.paramId}:${a.x}:${a.y}`);
      return null;
    });
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    return shell;
  };

  // The shell SENDS before it waits (`vd.rs`, do_set), so an answer that never came leaves
  // the rate on the wire: it may have landed and taken the Track Count down with it. Armed
  // on an acknowledgement alone, the recorder went on showing a count the unit no longer has
  // and nothing on screen said so.
  it("re-reads the recorder when the rate write's answer never came", SLOW, async () => {
    const shell = await rateWriteAnswered("broker-timeout");
    expect(readAfterLastWrite(shell)).toBe(true);
  });

  // The control that keeps the case above honest: an answer that DECLINED the rate is the
  // one failure that says it did not land, so there is nothing for the recorder to have lost
  // and the epilogue's read would be a round trip nothing asked for.
  it("re-reads nothing when the rate write was refused", SLOW, async () => {
    const shell = await rateWriteAnswered("broker-rejected");
    expect(readAfterLastWrite(shell)).toBe(false);
  });

  // The unit does the lowering itself, so the plan is stale the moment the write lands.
  // Whether the unit ANNOUNCES it is not something this project has measured, so the read
  // is unconditional rather than left to a notify that may never arrive.
  it("re-reads the recorder's Track Count after a rate change that lowers it", SLOW, async () => {
    const shell = await bootDevice({}, true, { [TRACK_COUNT_SEED]: 8 });
    chooseRate(96_000);
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    expect(shell.count("vd_set")).toBeGreaterThan(10);
    expect(readAfterLastWrite(shell)).toBe(true);
  });

  /** A device table whose recorder re-read the case drives itself. The write's own
   *  pre-flight and diff read 839 too, both before anything is written, and Track Count is
   *  never emitted (translate.ts) so no converge round re-reads it — which is what makes
   *  "a read of 839 once something has been written" the epilogue's read and no other. */
  const epilogueRead = (over: (a: Record<string, unknown>, base: () => number) => unknown): Record<string, unknown> => {
    const table = deviceCommands({ "plugin:dialog|message": "Ok" }, { [TRACK_COUNT_SEED]: 8 });
    const baseGet = table.vd_get as (a: Record<string, unknown>) => number;
    const baseSet = table.vd_set as (a: Record<string, unknown>) => void;
    let written = false;
    table.vd_set = (a: Record<string, unknown>) => {
      written = true;
      return baseSet(a);
    };
    table.vd_get = (a: Record<string, unknown>) =>
      written && Number(a.paramId) === 839 ? over(a, () => baseGet(a)) : baseGet(a);
    return table;
  };

  // A read that failed is not a write that succeeded. Reported rather than thrown on: the
  // throw would leave withDevice saying the WRITE failed, and it did not — it is on the
  // unit, and the operator would go looking for it.
  it("reports a recorder re-read that failed, without calling the write failed", SLOW, async () => {
    const shell = (await bootApp({
      tauri: epilogueRead(() => {
        throw new Error("device-lost");
      }),
    }))!;
    chooseRate(96_000);
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");

    // The write itself went out — without this the case would pass over a build that
    // failed before sending anything, which is the state the message denies.
    expect(shell.count("vd_set")).toBeGreaterThan(10);
    expect(errors(shell)).toContain(t().error.trackCountReread(t().error.shell.deviceLost));
    // The write's own verdict survives the dialog. This is the OTHER outcome reaching the
    // same tail — restoring only the cancelled line passes every case but this one.
    expect(countFor(statusText(), t().status.written)).toBeGreaterThan(0);
  });

  // What the re-read does to the undo history. The tail spells it absorb(), not rebase():
  // rebase drops any entry still OPEN, so an edit the operator started while the read ran
  // would come back un-undoable. Held open by a press rather than by racing the idle
  // backstop — history.ts does not arm it while a pointer is down — so the entry is open
  // when the read lands however long the read takes.
  it("leaves an edit made while the recorder was being re-read undoable", SLOW, async () => {
    let issued = (): void => {};
    const reading = new Promise<void>((r) => (issued = r));
    let release = (): void => {};
    const held = new Promise<void>((r) => (release = r));
    const shell = (await bootApp({
      tauri: epilogueRead((_a, base) => {
        issued();
        return held.then(base);
      }),
    }))!;
    chooseRate(96_000);
    $("btn-write").click();
    await reading;

    // A node the epilogue read does not touch: it reads out.sdrec alone, so an edit
    // anywhere else is undone by the history or by nothing.
    window.dispatchEvent(new Event("pointerdown"));
    selectNode("bus.osc");
    const btns = [...paramRow(t().inspector.oscOn).querySelectorAll<HTMLButtonElement>("button")];
    (btns.find((b) => b.textContent === "ON") ?? btns[0]).click();
    expect(paramRow(t().inspector.oscOn).querySelector("button.on")?.textContent).toBe("ON");
    release();
    await invoked(shell, "vd_disconnect");

    // End the gesture, then undo it. The commit is deferred one macrotask (click is
    // dispatched after pointerup), so the undo has to come after that.
    window.dispatchEvent(new Event("pointerup"));
    await new Promise((r) => setTimeout(r, 0));
    expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
    await vi.waitFor(() => expect(paramRow(t().inspector.oscOn).querySelector("button.on")?.textContent).toBe("OFF"), {
      timeout: 10_000,
    });
    // …and the count the device authored stayed: it went into the baseline rather than
    // into the entry, so the undo does not take it back with the edit.
    selectNode("out.sdrec");
    expect(row(t().inspector.sdRecTrackCount).querySelector<HTMLSelectElement>("select")!.value).toBe("16");
  });

  // The confirm the case above never reaches: with the device already on the plan's rate
  // and its clock its own, the rate question does not arise and the change count is the
  // first thing asked. It is the last thing between one press and hundreds of parameters
  // landing on real hardware, and nothing in this repository drove it before — deleting
  // the confirm outright used to leave the whole suite green.
  it("asks how many changes it is about to write, and sends nothing when that is declined", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(false, 48_000) }, false);
    // A message whose LAST paragraph reconstructs to itself under `confirm.write` IS the write
    // confirm. Waiting on "some confirm appeared" is not enough: with the confirm gone the
    // write runs on, fails to converge and offers to save a failure report — which is an
    // OkCancel dialog too, so the wait would be satisfied by the very regression the case
    // exists to catch, and the failure would name a NaN instead of a missing dialog.
    // The last paragraph rather than the whole message, because the dialog carries what else
    // it has to say about this write ahead of the question — a shared-address owner, and the
    // strips whose values nobody chose, which a plan the app itself seeded has throughout.
    const question = (m: string): string => m.slice(m.lastIndexOf("\n\n") + 2);
    const written = (): string | undefined =>
      confirms(shell).find((m) => {
        const q = question(m);
        const n = Number(/\d+/.exec(q)?.[0]);
        return Number.isFinite(n) && q === t().confirm.write(n);
      });
    $("btn-write").click();
    await vi.waitFor(() => expect(written()).toBeDefined(), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 200));

    // The count is read out of the message and put back, so the whole frame is pinned
    // rather than a substring. What that cannot pin is the number itself — the expectation
    // is built from the same digits — so a `total` that dropped one of its two terms would
    // still render a well-formed frame.
    const n = Number(/\d+/.exec(question(written()!))?.[0]);
    expect(n).toBeGreaterThan(10);
    // And exactly one confirm: the decline has to end the flow rather than lead to another
    // question.
    expect(confirms(shell)).toHaveLength(1);
    expect(shell.count("vd_set")).toBe(0);
    expect(shell.count("vd_set_str")).toBe(0);
  });

  // The other half of the same pre-flight, one gate earlier. An unread firmware version is
  // a HARD stop, and not the same thing as a mismatched one: a mismatch is a confirm the
  // operator can wave through (and a preference can suppress), while an unread version
  // means the check deciding whether this build's parameter mappings apply at all could
  // not be made. Proceeding writes hundreds of values with that check switched off.
  it("refuses to write to a unit whose firmware version it could not read", SLOW, async () => {
    const shell = await bootDevice({
      vd_connect: { model: "URX44V", label: "URX44V", firmware: null, epoch: 1 },
    });
    $("btn-write").click();
    await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 10_000 });
    expect(errors(shell)).toEqual([t().error.firmwareUnread]);
    // Refused outright rather than asked: the mismatch arm one line below DOES ask, and a
    // regression that routed the null through it would leave a case counting dialogs green.
    expect(confirms(shell)).toEqual([]);
    expect(shell.count("vd_set")).toBe(0);
    await invoked(shell, "vd_disconnect");
  });

  // A device of another model is REFUSED rather than offered a switch: write acts on the
  // plan as it stands, so its channels would map onto the wrong hardware. (Fetch and Live
  // sync offer the switch instead — they replace the plan.) This guard is shared by write,
  // compare and both device-setup actions, and nothing exercised it before.
  it("refuses to write onto a device of another model, naming both", SLOW, async () => {
    const shell = await bootDevice({
      vd_connect: { model: "URX22", label: "URX22", firmware: SUPPORTED_SYSTEM_FIRMWARE, epoch: 1 },
    });
    $("btn-write").click();
    await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 10_000 });
    // The whole frame, not a substring of it: the guard is shared with compare and the two
    // device-setup actions, each wrapping the same mismatch text in its own message, so a
    // refusal that reported write's failure as compare's would pass a `toContain`.
    expect(errors(shell)).toEqual([t().status.writeError(t().error.modelMismatch("URX22", "URX44V"))]);
    // Refused before anything went out, and the link it opened is let go rather than held.
    expect(shell.count("vd_set")).toBe(0);
    expect(confirms(shell)).toEqual([]);
    await invoked(shell, "vd_disconnect");
  });

  // The same guard on an action that only READS: its refusal names the mismatch and the
  // remedy, and says nothing about writing, since the action never writes.
  it("refuses to read Device setup from a device of another model without naming a write", SLOW, async () => {
    const shell = await bootDevice(connectAs("URX22"));
    $("btn-device-setup").click();
    await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 10_000 });
    expect(errors(shell)).toEqual([t().error.deviceSetupRead(t().error.modelMismatch("URX22", "URX44V"))]);
    expect(errors(shell)[0]).not.toMatch(/writ/i);
    expect(shell.count("vd_set")).toBe(0);
    await invoked(shell, "vd_disconnect");
  });

  // "Wrote N" and "wrote, but N did not take" are both reached with writes on the
  // wire, so a case that counts `vd_set` cannot tell them apart — and against a stub
  // that answers every read 0 it is the SECOND one that runs, every time, since the
  // converge loop re-reads what it just sent and is told it did not land. The status
  // frame is what separates them, and the re-write below is what says the values are
  // on the unit rather than merely sent to it.
  it("writes the plan, converges, and leaves the unit matching it", SLOW, async () => {
    const shell = await bootDevice();
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    expect(shell.count("vd_set")).toBeGreaterThan(10);

    // The count comes out of the message so the assertion can pin the whole frame
    // rather than a substring. On the non-converging path (reads answering a flat 0) the
    // writes go out over every round the converge allows, the flow lands on
    // `writeResidual`, and its error report's save — which this stub has no dialog
    // command for — fails, so `showError` clears the line and the status reads "".
    const n = Number(/\d+/.exec(statusText())?.[0]);
    expect(n).toBeGreaterThan(10);
    expect(statusText()).toBe(t().status.written(n));

    // Written and readable: the app's own diff now finds nothing left to send.
    $("btn-write").click();
    await invoked(shell, "vd_disconnect", 2);
    expect(statusText()).toContain(t().status.writeNoChanges);
  });

  // The unit rebuilds the SSMCS strip from a Sweet Spot preset once the preset lands, and a Signal
  // Type change in the numeric phase puts a member's own preset back when it lands. So the preset
  // goes out after the numeric phase, and the node names after the preset.
  it("sends the Sweet Spot preset between the numeric phase and the node names", SLOW, async () => {
    const { emptyPlan, serialize } = await import("./core/plan");
    const plan = emptyPlan("URX44V");
    plan.nodeParams["ch2"] = { compEqType: 1, ssmcs: { sweetSpotData: 24, compDrive: 120 } };
    plan.nodeNames["ch1"] = "Vox";
    const shell = (await bootApp({
      url: `/?plan=${encodeURIComponent(Buffer.from(serialize(plan), "utf8").toString("base64url"))}`,
      tauri: deviceCommands({ "plugin:dialog|message": "Ok" }),
    }))!;
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");

    const at = (pred: (cmd: string, a: Record<string, unknown>) => boolean): number =>
      shell.invokes.findIndex((cmd, i) => pred(cmd, (shell.args[i] ?? {}) as Record<string, unknown>));
    const strip = at((cmd, a) => cmd === "vd_set" && a.paramId === 95 && a.y === 1);
    const preset = at((cmd, a) => cmd === "vd_set_str" && a.paramId === 91 && a.y === 1);
    const name = at((cmd, a) => cmd === "vd_set_str" && a.value === "Vox");
    expect(strip, "the strip value went out").toBeGreaterThanOrEqual(0);
    expect(preset, "the preset went out").toBeGreaterThan(strip);
    expect(name, "the name went out").toBeGreaterThan(preset);
  });

  // The plan format's silence, held where it meets the unit: what reaches it, and what the
  // operator is told before it does. The record of where each value came from is pinned on
  // its own, without the wiring, in src/app/param-source.test.ts. A document that says
  // nothing about the FX channels is completed from the model's factory values, so the write
  // DOES send the selector — and that write is not recoverable, since it refills the engine
  // array with the type's defaults. What stands in front of it is the confirm: it names the
  // strips whose values nobody chose, so writing them is a decision rather than a surprise.
  // The pair below is what makes that a real question — the same plan, described and not.
  it("names the strips a document never described, and stays quiet about the ones it did", SLOW, async () => {
    const { emptyPlan, serialize } = await import("./core/plan");
    const { getModel } = await import("./models");
    const { fullLabel } = await import("./models/types");
    const fxLabel = (id: string): string => fullLabel(getModel("URX44V").nodes.find((n) => n.id === id)!);

    // The unit is holding FX settings of its own, on both channels' selector and array.
    const FX = new Set([679, 681, 683, 685]);
    const custom = (a: Record<string, unknown>): number =>
      FX.has(a.paramId as number) ? 4242 : clockReads(false, 48_000)(a);
    // The legacy UNCOMPRESSED link shape, which the codec still decodes: jsdom here has no
    // Blob.stream for the compressed one, and the plan is what this case is about.
    const linkFor = (plan: ReturnType<typeof emptyPlan>): string =>
      encodeURIComponent(Buffer.from(serialize(plan), "utf8").toString("base64url"));
    const runWrite = async (plan: ReturnType<typeof emptyPlan>): Promise<TauriShell> => {
      const shell = (await bootApp({
        url: `/?plan=${linkFor(plan)}`,
        tauri: deviceCommands({ "plugin:dialog|message": "Ok", vd_get: custom }),
      }))!;
      $("btn-write").click();
      await invoked(shell, "vd_disconnect");
      return shell;
    };
    const fxWrites = (shell: TauriShell): Array<Record<string, unknown>> =>
      shell.invokes
        .map((cmd, i) => (cmd === "vd_set" ? shell.args[i] : undefined))
        .filter((a): a is Record<string, unknown> => !!a && FX.has(a.paramId as number));

    // A plan with something to write and NOTHING about either FX channel.
    const silent = emptyPlan("URX44V");
    silent.nodeParams["ch1"] = { level: -10 };
    expect(silent.nodeParams["bus.fx1"]?.fxEffect, "the premise").toBeUndefined();
    const quiet = await runWrite(silent);
    // The positive control: the write ran and sent something, so what is asserted about the
    // dialog is asserted about a write that reached the device.
    expect(quiet.count("vd_set")).toBeGreaterThan(0);
    // The contract this case exists for: the fill sends the factory effect, and the confirm
    // said so first, naming the strip the operator never described.
    expect(fxWrites(quiet).length).toBeGreaterThan(0);
    const warned = confirms(quiet).filter((m) => stripsNamed(m).includes(fxLabel("bus.fx1")));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(
      t()
        .confirm.write(1)
        .replace(/^[\s\S]*?\?\s*/, ""),
    );

    // The other half, which is what stops "always warn" from passing: the same two strips,
    // described by the document, are the operator's own values and are not warned about.
    const { defaultPlan } = await import("./models/initial-state");
    const factory = defaultPlan("URX44V");
    const described = emptyPlan("URX44V");
    described.nodeParams["ch1"] = { level: -10 };
    // The factory values, but WRITTEN IN the document: same numbers on the wire, different
    // provenance — which is the whole distinction the note is drawn from. The channels' sends
    // and names are theirs too, and the write carries them on the same strips.
    for (const id of ["bus.fx1", "bus.fx2"]) {
      described.nodeParams[id] = factory.nodeParams[id]!;
      described.nodeNames[id] = factory.nodeNames[id]!;
    }
    described.connections = factory.connections.filter((c) => c.from === "bus.fx1:out" || c.from === "bus.fx2:out");
    const told = await runWrite(described);
    expect(told.count("vd_set"), "the positive control").toBeGreaterThan(0);
    expect(confirms(told).filter((m) => stripsNamed(m).includes(fxLabel("bus.fx1")))).toEqual([]);
  });

  // The other half of the same mark: a write takes the plan's values AS the unit's only once
  // it has landed in full. Taken on a write that did not converge, it would relabel the keys
  // the DOCUMENT named — which are exempt from the warning because someone wrote them — as
  // the unit's, and the next attempt would then warn about values the operator chose.
  it("does not relabel a document's own values as the unit's when the write did not land", SLOW, async () => {
    const { emptyPlan, serialize } = await import("./core/plan");
    const { getModel } = await import("./models");
    const { fullLabel } = await import("./models/types");
    const { defaultPlan } = await import("./models/initial-state");
    const label = (id: string): string => fullLabel(getModel("URX44V").nodes.find((n) => n.id === id)!);

    const factory = defaultPlan("URX44V");
    const described = emptyPlan("URX44V");
    described.nodeParams["ch1"] = { level: -10 };
    // The FX channels are what the document names — their params, their sends and their names;
    // everything else is left to the fill.
    for (const id of ["bus.fx1", "bus.fx2"]) {
      described.nodeParams[id] = factory.nodeParams[id]!;
      described.nodeNames[id] = factory.nodeNames[id]!;
    }
    described.connections = factory.connections.filter((c) => c.from === "bus.fx1:out" || c.from === "bus.fx2:out");
    const link = encodeURIComponent(Buffer.from(serialize(described), "utf8").toString("base64url"));
    // Reads that never reflect a write: every address answers its clock value or 0, so the
    // converge runs out with a residual and the write is not a landing.
    const shell = (await bootApp({
      url: `/?plan=${link}`,
      tauri: deviceCommands({ "plugin:dialog|message": "Ok", vd_get: clockReads(false, 48_000) }),
    }))!;

    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    // The count is read out of the line and put back, so the premise pins the whole frame
    // rather than a substring of it.
    const stuck = Number(/\d+/.exec(statusText())?.[0]);
    expect(statusText(), "the premise: this write did not converge").toBe(t().status.writeResidual(stuck));

    $("btn-write").click();
    await invoked(shell, "vd_disconnect", 2);
    const asked = confirms(shell).filter((m) => m.includes(t().confirm.write(1).slice(-20)));
    expect(asked, "the positive control: both attempts asked").toHaveLength(2);
    // The note ran on both — reconstructed from its own message rather than from a label,
    // since `fullLabel("ch1")` is "CH 1" and three of this model's labels contain that string.
    const noteMark = t().confirm.unauthoredWrite("").replace(/\s*$/, "");
    expect(asked.every((m) => m.includes(noteMark))).toBe(true);
    // …and named neither FX channel either time, because the document named those.
    expect(asked.filter((m) => stripsNamed(m).includes(label("bus.fx1")))).toEqual([]);
  });

  // A parameter whose current value could not be read is one the write has no diff for,
  // so the sweep stops at the first rather than establishing values for a write that is
  // already canceled. `vd_set` at zero is the assertion: a read failure that let the write
  // proceed would send the plan over a device state nobody confirmed.
  it("cancels the write when the device's current values cannot be read", SLOW, async () => {
    const shell = await bootDevice({ ...SAVES, vd_get: diffReadsFail });
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");

    // Exactly one: the sweep is asked to stop at the first failure, so the count is the
    // pin on that rather than an incidental number.
    expect(statusText()).toBe(t().status.writeReadFailed(1));
    expect(shell.count("vd_set")).toBe(0);

    // …and the reason is offered as a file, since a packaged build has no console to read
    // the per-command failures in.
    await vi.waitFor(() => expect(shell.count("write_text_file")).toBe(1), { timeout: 10_000 });
    const saved = shell.args[shell.invokes.indexOf("write_text_file")];
    expect(String(saved?.contents ?? "")).toContain("read-refused");

    // The only thing it asked. Two regressions hide here otherwise: a read stop that
    // still asked for the change count, and — the one nothing else covers — a read stop
    // returning a sent/not-sent split instead of null, which would offer to run the write
    // again and go on offering it, since the retry re-runs the same failing read.
    expect(confirms(shell)).toEqual([t().confirm.deviceErrorExport]);
  });

  // The names are a second diff over a separate IPC, read AFTER the numeric sweep has
  // already succeeded — so this is the arm where everything the write needs is in hand but
  // the names, and it still must not send.
  //
  // Unlike the numeric sweep, `diffNames` takes no stop-on-first-error: it reads every
  // name and collects one failure per read. The status count is pinned against that read
  // count — an independent observable — and the floor is the other half, because the two
  // move together if the sweep ever gains a stop: 1 === 1 would stay green while the
  // operator's number fell from the whole name set to one. Measured here: 17 name reads.
  it("cancels the write when a channel name cannot be read", SLOW, async () => {
    const shell = await bootDevice({
      ...SAVES,
      vd_get: clockReads(false, 48_000),
      vd_get_str: () => {
        throw new Error("name-read-refused");
      },
    });
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");

    expect(shell.count("vd_get_str")).toBeGreaterThan(5); // the sweep did not stop at the first
    expect(statusText()).toBe(t().status.writeReadFailed(shell.count("vd_get_str")));
    expect(shell.count("vd_get")).toBeGreaterThan(100); // the numeric half did run
    expect(shell.count("vd_set")).toBe(0);
    expect(shell.count("vd_set_str")).toBe(0);
    // Same as the numeric stop above: the report, and nothing else — no change count, and
    // no offer to run again a write whose read would fail the same way.
    await vi.waitFor(() => expect(confirms(shell)).toEqual([t().confirm.deviceErrorExport]), { timeout: 10_000 });
  });

  // A stopped send leaves the unit holding part of what was confirmed, and the offer to
  // run it again is what turns that into something the operator can act on. The retry
  // re-diffs, so what already landed drops out by itself — which is exactly why it must
  // NOT ask for the change count a second time: that count would be a different number
  // about a different set, asked after the operator already agreed to the write.
  it("offers to run a stopped write again, and does not re-ask the change count", SLOW, async () => {
    const shell = await bootDevice(SAVES);
    shell.failOnce("vd_set", new Error("nak"));
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");

    expect(confirms(shell).filter((m) => m.includes(RETRY_ASK))).toHaveLength(1);
    expect(confirms(shell).filter((m) => m.includes(WRITE_ASK))).toHaveLength(1);
    expect(countFor(statusText(), (n) => t().status.written(n))).toBeGreaterThan(10);
    // The names went out on the successful attempt — they are held back while the numeric
    // phase is stopped, so this also says the retry reached the end.
    expect(shell.count("vd_set_str")).toBeGreaterThan(0);

    // And the report the FIRST attempt built is still offered, after a status line saying
    // the write succeeded: `report` is not cleared by the attempt that worked. Pinned as it
    // stands rather than left to be discovered — whether a retry that resolved the failure
    // should still report it is a product question, and this records the current answer.
    // Waited for, like its sibling below: the offer is raised after the disconnect this
    // returned on.
    await vi.waitFor(() => expect(confirms(shell)).toContain(t().confirm.deviceErrorExport), { timeout: 10_000 });
  });

  // Declining ends it where it stopped, and the status line is the whole report then, so
  // it has to carry both halves of the split. The offer itself is asserted too: every
  // other assertion here is set inside `attemptWrite` before it returns, so all of them
  // hold over a build with no retry loop at all.
  it("stops where it stopped when the retry is declined", SLOW, async () => {
    const shell = await bootDevice({ ...SAVES, "plugin:dialog|message": byMessage((m) => !m.includes(RETRY_ASK)) });
    shell.failOnce("vd_set", new Error("nak"));
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");

    const [sent, notSent] = (/: (\d+) sent, (\d+) not sent/.exec(statusText()) ?? []).slice(1).map(Number);
    expect(statusText()).toBe(t().status.writeStopped(sent, notSent));
    expect(sent).toBe(0);
    expect(notSent).toBeGreaterThan(0);
    // The whole prompt, not just its count-free tail: that tail is satisfied by a prompt
    // reporting the two counts the other way round. And exactly once — a decline has to
    // end the loop rather than lead to the same question again.
    expect(confirms(shell)).toContain(t().confirm.writeRetry(0, notSent));
    expect(confirms(shell).filter((m) => m.includes(RETRY_ASK))).toHaveLength(1);
    expect(shell.count("vd_set")).toBe(1); // stopped AT the failure, not after it
    expect(shell.count("vd_set_str")).toBe(0); // names are held back while it is stopped
  });

  // A plan whose CH1-3 sit on Sweet Spot presets, as a ?plan= link.
  const presetLink = async (): Promise<string> => {
    const { emptyPlan, serialize } = await import("./core/plan");
    const plan = emptyPlan("URX44V");
    for (const [id, preset] of [
      ["ch1", 5],
      ["ch2", 24],
      ["ch3", 7],
    ] as const)
      plan.nodeParams[id] = { compEqType: 1, ssmcs: { sweetSpotData: preset, compDrive: 120 } };
    return `/?plan=${encodeURIComponent(Buffer.from(serialize(plan), "utf8").toString("base64url"))}`;
  };
  const savedReport = async (shell: TauriShell): Promise<string> => {
    await vi.waitFor(() => expect(shell.count("write_text_file")).toBe(1), { timeout: 10_000 });
    return String((shell.args[shell.invokes.indexOf("write_text_file")] as { contents: string }).contents);
  };

  // Everything the converge reads comes after something it sent, so a read that fails there is
  // a read-back that could not confirm the write. Reported as written, which it was, would hide
  // that; reported as "nothing was written" would be false.
  it("reports a write whose read-back failed as unconfirmed, and offers to run it again", SLOW, async () => {
    const UNREAD_ASK = invariantOf(t().confirm.writeRetryUnread(1, 1));
    let shell: TauriShell | undefined;
    let armed = false;
    shell = (await bootApp({
      url: await presetLink(),
      tauri: deviceCommands({
        ...SAVES,
        "plugin:dialog|message": byMessage((m) => !m.includes(UNREAD_ASK)),
        // The first read after the first preset fails, once.
        vd_set_str: () => {
          if (!armed) {
            armed = true;
            shell!.failOnce("vd_get", new Error("read timeout"));
          }
          return null;
        },
      }),
    }))!;
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");

    const sent = countFor(statusText(), (n) => t().status.writeUnconfirmed(n, 1));
    expect(statusText()).toBe(t().status.writeUnconfirmed(sent, 1));
    expect(confirms(shell)).toContain(t().confirm.writeRetryUnread(sent, 1));
    const md = await savedReport(shell);
    expect(md).toContain("Written, then read failures: 1");
    expect(md).not.toContain("nothing was written");
  });

  // The presets are read again once the numeric values have gone out. A read that fails there
  // sends no preset, and it is a read-back of a write that went out, not the read a write stops on.
  it("reports the write as unconfirmed when the presets cannot be read after the numeric values", SLOW, async () => {
    const UNREAD_ASK = invariantOf(t().confirm.writeRetryUnread(1, 1));
    let armed = false;
    const tauri = deviceCommands({
      ...SAVES,
      "plugin:dialog|message": byMessage((m) => !m.includes(UNREAD_ASK)),
    });
    const set = tauri.vd_set as (a: Record<string, unknown>) => unknown;
    tauri.vd_set = (a: Record<string, unknown>) => {
      armed = true;
      return set(a);
    };
    const getStr = tauri.vd_get_str as (a: Record<string, unknown>) => unknown;
    tauri.vd_get_str = (a: Record<string, unknown>) => {
      if (armed) {
        armed = false;
        throw new Error("read timeout");
      }
      return getStr(a);
    };
    const shell = (await bootApp({ url: await presetLink(), tauri }))!;
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");

    // Premise: numeric values went out, and no preset did.
    expect(shell.count("vd_set")).toBeGreaterThan(0);
    expect(shell.count("vd_set_str")).toBe(0);
    const sent = countFor(statusText(), (n) => t().status.writeUnconfirmed(n, 1));
    expect(statusText()).toBe(t().status.writeUnconfirmed(sent, 1));
    expect(confirms(shell)).toContain(t().confirm.writeRetryUnread(sent, 1));
    const md = await savedReport(shell);
    expect(md).toContain("Written, then read failures: 1");
  });

  // The second write finds the numeric values already on the unit and only the presets differing
  // (this stub keeps no string), so the presets are all it sends — and they count as sent when the
  // read after them fails.
  it("counts presets it sent when the read after them fails, with nothing numeric to write", SLOW, async () => {
    let shell: TauriShell | undefined;
    let arm = false;
    shell = (await bootApp({
      url: await presetLink(),
      tauri: deviceCommands({
        ...SAVES,
        "plugin:dialog|message": byMessage((m) => !m.includes(invariantOf(t().confirm.writeRetryUnread(1, 1)))),
        vd_set_str: () => {
          if (arm) {
            arm = false;
            shell!.failOnce("vd_get", new Error("read timeout"));
          }
          return null;
        },
      }),
    }))!;
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    const setsAfterFirst = shell.count("vd_set");
    arm = true;
    $("btn-write").click();
    await invoked(shell, "vd_disconnect", 2);

    expect(shell.count("vd_set"), "the premise: nothing numeric was left to send").toBe(setsAfterFirst);
    const sent = countFor(statusText(), (n) => t().status.writeUnconfirmed(n, 1));
    expect(sent).toBeGreaterThan(0);
    const md = await savedReport(shell);
    expect(md).toContain("Written, then read failures: 1");
    expect(md).not.toContain("nothing was written");
  });

  // A retry that cannot even read the unit before writing still stands on what the earlier
  // attempt sent: the line and the report say so rather than "nothing was written".
  it("keeps what an earlier attempt sent when the retry's first read fails", SLOW, async () => {
    const UNREAD_ASK = invariantOf(t().confirm.writeRetryUnread(1, 1));
    let shell: TauriShell | undefined;
    let armed = false;
    shell = (await bootApp({
      url: await presetLink(),
      tauri: deviceCommands({
        ...SAVES,
        // Agreeing to the retry arms a failure for the retry's own first read.
        "plugin:dialog|message": (a: Record<string, unknown>) => {
          if (String(a.message ?? "").includes(UNREAD_ASK)) shell!.failOnce("vd_get", new Error("read timeout"));
          return "Ok";
        },
        vd_set_str: () => {
          if (!armed) {
            armed = true;
            shell!.failOnce("vd_get", new Error("read timeout"));
          }
          return null;
        },
      }),
    }))!;
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");

    expect(
      confirms(shell).filter((m) => m.includes(UNREAD_ASK)),
      "the premise: the retry was offered",
    ).toHaveLength(1);
    const sent = countFor(statusText(), (n) => t().status.writeUnconfirmed(n, 1));
    expect(sent).toBeGreaterThan(0);
    const md = await savedReport(shell);
    expect(md).not.toContain("nothing was written");
    expect(md).toContain("Written, then read failures: 1");
  });

  // A refused preset stops the write there, as any refused write does: the presets after it do
  // not go out, and the node whose preset was accepted is named, since its strip was rebuilt
  // and nothing read it back.
  it("stops at a refused preset and names the strip an accepted one left unconfirmed", SLOW, async () => {
    const shell = (await bootApp({
      url: await presetLink(),
      tauri: deviceCommands({
        ...SAVES,
        "plugin:dialog|message": byMessage((m) => !m.includes(RETRY_ASK)),
        vd_set_str: (a: Record<string, unknown>) => {
          if (a.paramId === 91 && a.y === 1) throw new Error("nak");
          return null;
        },
      }),
    }))!;
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");

    const presets = shell.invokes
      .map((cmd, i) => (cmd === "vd_set_str" ? (shell.args[i] as Record<string, unknown>) : undefined))
      .filter((a): a is Record<string, unknown> => a?.paramId === 91)
      .map((a) => a.y);
    expect(presets).toEqual([0, 1]);
    const [sent, notSent] = (/: (\d+) sent, (\d+) not sent/.exec(statusText()) ?? []).slice(1).map(Number);
    expect(statusText()).toBe(t().status.writeStopped(sent, notSent));
    expect(notSent).toBeGreaterThanOrEqual(1);
    expect(confirms(shell)).toContain(t().confirm.writeRetry(sent, notSent));
    const md = await savedReport(shell);
    expect(md).toContain("## Not confirmed");
    expect(md).toContain("- ch1");
  });

  // A cancel taken between two presets stops there: the next preset and the names do not go
  // out, and the report still names the node whose preset did.
  it("stops at a cancel between two presets and names the strip left unconfirmed", SLOW, async () => {
    const shell = (await bootApp({
      url: await presetLink(),
      tauri: deviceCommands({
        ...SAVES,
        "plugin:dialog|message": byMessage(() => true),
        vd_set_str: (a: Record<string, unknown>) => {
          // Clicking the write button again cancels the write in flight.
          if (a.paramId === 91 && a.y === 0) queueMicrotask(() => $("btn-write").click());
          return null;
        },
      }),
    }))!;
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");

    const strings = shell.invokes
      .map((cmd, i) => (cmd === "vd_set_str" ? (shell.args[i] as Record<string, unknown>) : undefined))
      .filter((a): a is Record<string, unknown> => a !== undefined)
      .map((a) => `${a.paramId}:${a.y}`);
    expect(strings).toEqual(["91:0"]);
    expect(statusText()).toBe(t().status.canceled);
    const md = await savedReport(shell);
    expect(md).toContain("## Not confirmed");
    expect(md).toContain("- ch1");
  });

  // Once the last preset has gone out, a cancel lands in the converge behind the presets. Every
  // accepted preset rebuilt a strip that converge did not finish reading back, so the report still
  // names them, and nothing more is sent.
  it.each([
    ["while the last preset is sent", "last-preset"],
    ["on the converge's first read behind the presets", "reconverge"],
  ] as const)("names every strip a preset rebuilt when cancelled %s", SLOW, async (_label, at) => {
    let presetsDone = false;
    let cancelled = false;
    // Clicking the write button again cancels the write in flight.
    const cancel = (): void => {
      if (cancelled) return;
      cancelled = true;
      queueMicrotask(() => $("btn-write").click());
    };
    const tauri = deviceCommands({
      ...SAVES,
      "plugin:dialog|message": byMessage(() => true),
    });
    const setStr = tauri.vd_set_str as (a: Record<string, unknown>) => unknown;
    tauri.vd_set_str = (a: Record<string, unknown>) => {
      const answer = setStr(a);
      if (a.paramId === 91 && a.y === 2) {
        presetsDone = true;
        if (at === "last-preset") cancel();
      }
      return answer;
    };
    const get = tauri.vd_get as (a: Record<string, unknown>) => unknown;
    tauri.vd_get = (a: Record<string, unknown>) => {
      const answer = get(a);
      if (at === "reconverge" && presetsDone) cancel();
      return answer;
    };
    const shell = (await bootApp({ url: await presetLink(), tauri }))!;
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");

    const strings = shell.invokes
      .map((cmd, i) => (cmd === "vd_set_str" ? (shell.args[i] as Record<string, unknown>) : undefined))
      .filter((a): a is Record<string, unknown> => a !== undefined)
      .map((a) => `${a.paramId}:${a.y}`);
    // Premise: the cancel came after the last preset, and nothing followed it — no name either.
    expect(cancelled).toBe(true);
    expect(strings).toEqual(["91:0", "91:1", "91:2"]);
    expect(shell.invokes.lastIndexOf("vd_set")).toBeLessThan(shell.invokes.lastIndexOf("vd_set_str"));
    expect(statusText()).toBe(t().status.canceled);
    const md = await savedReport(shell);
    expect(md).toContain("## Not confirmed");
    for (const node of ["ch1", "ch2", "ch3"]) expect(md).toContain(`- ${node}`);
  });
});

// Offered after the disconnect rather than during it (why, in `offerErrorReport`'s own
// comment in main.ts). The write's read-failure case above covers the arm where the offer
// is taken and a file appears; these are the two that leave nothing behind.

describe("the failure report a device action offers", () => {
  /** A write that cancels on its first diff read, which is the cheapest way to a report. */
  const failingWrite = async (over: Record<string, unknown>): Promise<TauriShell> => {
    const shell = await bootDevice({ ...over, vd_get: diffReadsFail });
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    return shell;
  };

  it("writes no file when the offer is declined", SLOW, async () => {
    const shell = await failingWrite({
      ...SAVES,
      "plugin:dialog|message": byMessage((m) => m !== t().confirm.deviceErrorExport),
    });
    // Waited for rather than slept past: the offer is raised after the disconnect this
    // returned on, and once its confirm resolves the decline is decided synchronously.
    await vi.waitFor(() => expect(confirms(shell)).toContain(t().confirm.deviceErrorExport), { timeout: 10_000 });
    expect(shell.count("plugin:dialog|save")).toBe(0);
    expect(shell.count("write_text_file")).toBe(0);
    expect(statusText()).toBe(t().status.writeReadFailed(1)); // the write's own verdict stands
  });

  // A rejected save must surface like a failed plan save. Swallowed, it would read as a
  // saved report — the status line still shows the write's verdict and no file exists.
  it("surfaces a save that fails, rather than leaving it read as saved", SLOW, async () => {
    const shell = await failingWrite({
      "plugin:dialog|save": () => {
        throw new Error("disk-full");
      },
    });
    await vi.waitFor(() => expect(errors(shell)).toContain(t().status.saveError("disk-full")), { timeout: 10_000 });
    expect(shell.count("write_text_file")).toBe(0);
    // …and the write's own verdict stands behind that dialog, the way it does on the decline
    // path above. The offer runs after withDevice returned, so what showError would clear here
    // is an outcome rather than a progress message.
    expect(statusText()).toBe(t().status.writeReadFailed(1));
  });
});

// A write converges the plan it was confirmed for, re-reading it after every await, so a plan
// replaced during the write is the one it would put on the unit. Every wholesale replacement is
// refused while a write holds the link — at its entry, and at loadPlan for a flow that entered
// before the write did. Each case holds the write's first device read.

describe("replacing the plan while a write holds the link", () => {
  const heldWrite = (
    over: Record<string, unknown> = {},
  ): { tauri: Record<string, unknown>; release: () => void; reading: Promise<void> } => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let asked!: () => void;
    const reading = new Promise<void>((r) => (asked = r));
    const table = deviceCommands({ "plugin:dialog|message": "Ok", ...over });
    const vdGet = table.vd_get as (a: Record<string, unknown>) => unknown;
    let first = true;
    return {
      release,
      reading,
      tauri: {
        ...table,
        vd_get: async (a: Record<string, unknown>) => {
          if (first) {
            first = false;
            asked();
            await held;
          }
          return vdGet(a);
        },
      },
    };
  };
  const writeEnded = (): Promise<void> =>
    vi.waitFor(() => expect($("btn-write").textContent).toBe(t().toolbar.writeDevice), { timeout: 20_000 });

  it("refuses New during a write and takes it once the write is done", SLOW, async () => {
    const unit = heldWrite();
    const shell = (await bootApp({ tauri: unit.tauri }))!;
    $("btn-write").click();
    await unit.reading;
    $("btn-new").click();
    expect(statusText()).toBe(t().status.deviceLinkBusy);
    unit.release();
    await writeEnded();
    await invoked(shell, "vd_disconnect");
    $("btn-new").click();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.newPlan), { timeout: 10_000 });
  });

  it("refuses a dropped plan during a write without reading it", SLOW, async () => {
    const { serialize } = await import("./core/plan");
    const unit = heldWrite({ read_text_file: () => serialize(defaultPlan("URX44V")) });
    const shell = (await bootApp({ tauri: unit.tauri }))!;
    $("btn-write").click();
    await unit.reading;
    expect(shell.emit("tauri://drag-drop", { paths: ["C:/urx/dropped.json"] })).toBe(1);
    expect(statusText()).toBe(t().status.deviceLinkBusy);
    unit.release();
    await writeEnded();
    expect(shell.count("read_text_file")).toBe(0);
  });

  it("refuses a model switch whose confirm was answered once the write had begun", SLOW, async () => {
    let answer!: (v: string) => void;
    const discard = new Promise<string>((r) => (answer = r));
    const unit = heldWrite({
      "plugin:dialog|message": (a: Record<string, unknown>) => (a.message === t().confirm.discard ? discard : "Ok"),
    });
    await bootApp({ tauri: unit.tauri });
    chooseRate(96_000); // unsaved, so the switch asks the discard confirm
    const picker = $<HTMLSelectElement>("model-picker");
    picker.value = "URX22";
    picker.dispatchEvent(new Event("change"));
    $("btn-write").click();
    await unit.reading;
    answer("Ok");
    await vi.waitFor(() => expect(statusText()).toBe(t().status.deviceLinkBusy), { timeout: 10_000 });
    // The picker names the model still on screen.
    expect(picker.value).toBe("URX44V");
    expect($("graph-host").querySelector('g.node[data-id="ch_11_12"]')).not.toBeNull();
    unit.release();
    await writeEnded();
  });
});
