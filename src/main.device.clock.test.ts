// @vitest-environment jsdom

// The unit's clock: the Follow USB badge and the sample rate across a write and a session.
//
// The setup, the teardown and the helpers every desktop case shares are `main.device.test-util.ts`'s,
// which also states what the device table does and does not model.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { $, bootApp, deviceCommands, statusText, unwrittenRead } from "./main.test-util";
import type { TauriShell } from "./main.test-util";
import { formatRate, trackCountDrop } from "./core/constraints";
import { denormalizeInsertFx, INSERT_FX_NONE, INSERT_FX_OPTIONS, PARAMS } from "./core/control/params";
import { SUPPORTED_SYSTEM_FIRMWARE } from "./core/control/firmware";
import { defaultPlan } from "./models/initial-state";
import { EDIT_MENU_EVENT, EDIT_UNDO_ID } from "./core/platform";
import { t } from "./i18n";
import {
  SLOW,
  bootDevice,
  invoked,
  live,
  selectNode,
  notifyChannel,
  clockReads,
  confirms,
  chooseRate,
  TRACK_COUNT_SEED,
  TRACK_COUNT_ADDR,
  PLAYBACK_SEED,
  PLAYBACK_ADDR,
  FOLLOW_USB_SEED,
  errors,
  followUsbWrites,
  countFor,
  SAVES,
  connectAs,
  insertFxSection,
  oscOn,
  turnOscOn,
  COMPANDER_H,
} from "./main.device.test-util";

describe("the Follow USB badge", () => {
  const badge = (): HTMLButtonElement => $<HTMLButtonElement>("follow-usb");

  // Unknown is not a direction, so the first press READS rather than toggling —
  // guessing a direction would answer a question the operator has not asked yet.
  //
  // The absence of a write is the observable. A case that only checked the badge would
  // pass against a toggle that happened to land on "off", which is the one state the
  // badge must never claim without having read it: "off" is the state in which the rate
  // picker is trusted to stick.
  it("reads the unit on the first press instead of guessing a direction", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(false, 48_000) });
    expect(badge().dataset.state).toBe("unknown");

    badge().click();
    await invoked(shell, "vd_disconnect");
    expect(badge().dataset.state).toBe("off");
    expect(badge().getAttribute("aria-pressed")).toBe("false");
    expect(shell.count("vd_set")).toBe(0);
  });

  // A file that opens a plan of ANOTHER model switches the model as the picker does, and the
  // badge answers for the unit it was read from: back to unknown, so the next press reads.
  it("goes back to unknown when an opened plan switches the model", SLOW, async () => {
    const { serialize } = await import("./core/plan");
    const shell = await bootDevice({
      vd_get: clockReads(true, 48_000),
      read_text_file: () => serialize(defaultPlan("URX22")),
    });
    badge().click();
    await invoked(shell, "vd_disconnect");
    expect(badge().dataset.state).toBe("on");

    expect(shell.emit("tauri://drag-drop", { paths: ["C:/urx/urx22.json"] })).toBe(1);
    await vi.waitFor(() => expect(statusText()).toBe(t().status.openedFrom("urx22.json")), { timeout: 10_000 });
    expect($<HTMLSelectElement>("model-picker").value).toBe("URX22");
    expect(badge().dataset.state).toBe("unknown");

    // The next press reads rather than toggling from the other unit's state.
    badge().click();
    await invoked(shell, "vd_disconnect", 2);
    expect(followUsbWrites(shell)).toEqual([]);
  });

  // …and a first press whose read FAILS is reported as the read it was. Nothing was written,
  // so a dialog naming a failed write would tell the operator the clock policy may have moved.
  it("reports a failed first-press read as a read", SLOW, async () => {
    const shell = await bootDevice({
      vd_get: (a: Record<string, unknown>) => {
        if (a.paramId === PARAMS.FOLLOW_USB.id) throw new Error("broker-timeout: value at 848:0:0");
        return unwrittenRead(a);
      },
    });
    badge().click();
    await vi.waitFor(() => expect(errors(shell).length).toBe(1), { timeout: 10_000 });
    expect(errors(shell)[0]).toBe(t().error.followUsbRead(t().error.shell.brokerTimeout("value at 848:0:0")));
    expect(errors(shell)[0]).not.toContain(t().status.writeError("").trim());
    expect(badge().dataset.state).toBe("unknown");
    expect(shell.count("vd_set")).toBe(0);
  });

  // Turning it ON hands the clock back to the USB host, which re-clocks the hardware
  // then and there when the host runs another rate — so it confirms. Declining has to
  // leave the state as READ, not as asked for.
  // The pair that keeps the recorder sentence honest. It is asked of the model the UNIT
  // reports, and URX22 has no microSD recorder at all — warning it about an irreversible
  // Track Count loss describes hardware it does not have, and the documents say it is
  // silent throughout.
  it("says nothing about the recorder on a unit that has none", SLOW, async () => {
    const shell = await bootDevice(
      {
        vd_get: clockReads(false, 48_000),
        vd_connect: { model: "URX22", label: "URX22", firmware: SUPPORTED_SYSTEM_FIRMWARE, epoch: 1 },
      },
      false,
    );
    badge().click();
    await invoked(shell, "vd_disconnect");
    const asked = confirms(shell).length;
    badge().click();
    await vi.waitFor(() => expect(confirms(shell).length).toBe(asked + 1), { timeout: 10_000 });
    const askedText = confirms(shell).at(-1) ?? "";
    // The clock question is still asked — this is about the recorder clause alone.
    expect(askedText).toContain(t().confirm.followUsbOn);
    expect(askedText).not.toContain(t().confirm.trackCountMayDrop);
  });

  it("asks before handing the clock to the host, and writes nothing when declined", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(false, 48_000) }, false);
    badge().click();
    await invoked(shell, "vd_disconnect");
    expect(badge().dataset.state).toBe("off");

    // Counted from here: the first press is a read and raises no dialog, so an absolute
    // count would be asserting about the wrong press.
    const asked = confirms(shell).length;
    badge().click();
    await vi.waitFor(() => expect(confirms(shell).length).toBe(asked + 1), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 100));
    // Both the wait above and the assertions below go through `confirms()`, which reads
    // the dialog's ARGUMENTS. A count-based version of this case could not separate
    // "asked" from "threw on the way to asking": the second raises a dialog too, writes
    // nothing, and leaves the badge where it was.
    // Both sentences, not the composed literal: what the case is about is that the
    // operator is told BOTH what handing the clock over does and that it can cost the
    // recorder's Track Count irreversibly. Pinning the joined string would pass a rewrite
    // that dropped either one, as long as the other still read the same.
    const askedText = confirms(shell).at(-1) ?? "";
    expect(askedText).toContain(t().confirm.followUsbOn);
    expect(askedText).toContain(t().confirm.trackCountMayDrop);
    expect(errors(shell)).toEqual([]);
    expect(followUsbWrites(shell)).toEqual([]);
    expect(badge().dataset.state).toBe("off");
  });

  it("writes the policy when the confirm is accepted, and says which way it went", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(false, 48_000) });
    badge().click();
    await invoked(shell, "vd_disconnect");

    badge().click();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.followUsbOn), { timeout: 10_000 });
    expect(badge().dataset.state).toBe("on");
    expect(followUsbWrites(shell)).toEqual([1]);
  });

  // Why OFF is not worth a confirm is stated where the asymmetry is implemented (the
  // Follow USB toggle in main.ts); this pins that it holds. Driven from a unit that
  // answers ON, which is also the only way to reach that arm at all. Every confirm
  // DECLINES here, so a confirm that appeared would abort the write and fail the case
  // rather than let it pass.
  it("turns the policy off without asking", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(true, 48_000) }, false);
    badge().click();
    await invoked(shell, "vd_disconnect");
    expect(badge().dataset.state).toBe("on");

    badge().click();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.followUsbOff), { timeout: 10_000 });
    expect(shell.count("plugin:dialog|message")).toBe(0);
    expect(followUsbWrites(shell)).toEqual([0]);
    expect(badge().dataset.state).toBe("off");
  });

  // While a session is up the connection is already held for it, and opening a second
  // one would fight it — so this write goes out on the session's own link. The connect
  // COUNT is the whole observable: the write itself looks identical either way.
  it("writes over the live session's own link rather than opening a second one", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(true, 48_000) });
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    // The session start read the badge on its way up, so the press below is a toggle
    // rather than the read an unknown state would have taken.
    expect(badge().dataset.state).toBe("on");
    const connects = shell.count("vd_connect");

    badge().click();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.followUsbOff), { timeout: 10_000 });
    expect(shell.count("vd_connect")).toBe(connects);
    expect(live().getAttribute("aria-checked")).toBe("true");
  });

  // A write that fails on the session's link is a mirror that did not complete, so it
  // takes the session down with it; why the badge then goes back to unknown rather than
  // holding its last reading is stated where that reset is implemented.
  it("takes the session down when the write fails on its link", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(true, 48_000) });
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });

    const armedAt = shell.invokes.length;
    shell.failOnce("vd_set", new Error("link-gone"));
    badge().click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("false"), { timeout: 10_000 });
    expect(badge().dataset.state).toBe("unknown");
    // The failure that took the session down was THIS write. `failOnce` arms the next
    // `vd_set` from anyone and the session has writers of its own, so the count alone
    // would let the case pass on a session that fell over for an unrelated reason. The
    // ledger is ordered, so the first write after the arming point settles which one it
    // caught — no predicate on the latch needed.
    const refused = shell.invokes.indexOf("vd_set", armedAt);
    expect(refused).toBeGreaterThan(-1);
    expect(shell.args[refused]?.paramId).toBe(PARAMS.FOLLOW_USB.id);
    expect(followUsbWrites(shell)).toHaveLength(1);
  });

  // The confirm is window-modal, so the session can end behind it — here its link drops — and
  // the write the operator then confirms has no session to go out on. It fails, and the
  // failure is reported as that write's, since the session's own teardown said nothing of it.
  it("reports a confirmed write that failed because the session ended behind its confirm", SLOW, async () => {
    let answer!: (v: string) => void;
    const held = new Promise<string>((r) => (answer = r));
    const shell = await bootDevice({
      vd_get: clockReads(false, 48_000),
      "plugin:dialog|message": (a: Record<string, unknown>) =>
        a.buttons === "OkCancel" && String(a.message ?? "").startsWith(t().confirm.followUsbOn) ? held : "Ok",
    });
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    expect(badge().dataset.state).toBe("off");

    badge().click();
    await vi.waitFor(() => expect(confirms(shell).some((m) => m.startsWith(t().confirm.followUsbOn))).toBe(true), {
      timeout: 10_000,
    });
    // The link drops while the confirm is up.
    const watch = shell.args[shell.invokes.indexOf("vd_watch_link")] as {
      channel: { onmessage: (d: unknown) => void };
    };
    watch.channel.onmessage({ reason: "device-lost" });
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("false"), { timeout: 10_000 });
    await invoked(shell, "vd_disconnect");
    const before = errors(shell).length;

    answer("Ok");
    await vi.waitFor(() => expect(errors(shell).length).toBe(before + 1), { timeout: 10_000 });
    expect(errors(shell).at(-1)).toBe(
      t().status.writeError(t().error.followUsbWrite(t().error.shell.notConnected, true)),
    );
    expect(badge().dataset.state).not.toBe("on");
  });

  // A Fetch and a Live-sync start read Follow USB on their own connection, and that read
  // aborts its caller like every other device read on the link: nothing merged, the badge
  // left as it was. Each refusal case is paired with the same flow answering, which is what
  // shows the plan values it asserts on are ones the read really moves.

  /** A unit whose plan read moves the board: every channel's ON reads 0, so it takes its
   *  MUTE tag, and every insert-FX selector reads Compander-H, where the default plan has
   *  every channel on and no effect selected. Follow USB reads ON until `unit.refused` is
   *  set, and is refused from then on. */
  const unit = { refused: false };
  const unitReads = (a: Record<string, unknown>): number => {
    if (a.paramId === PARAMS.FOLLOW_USB.id) {
      if (unit.refused) throw new Error("read-refused");
      return 1;
    }
    if (a.paramId === PARAMS.SAMPLE_RATE.id) return 48_000;
    if (a.paramId === PARAMS.INSERT_FX.id) return COMPANDER_H;
    return unwrittenRead(a);
  };
  beforeEach(() => void (unit.refused = false));

  const muted = (id: string): boolean =>
    [...($("graph-host").querySelector(`g.node[data-id="${id}"]`)?.querySelectorAll("text") ?? [])].some(
      (el) => el.textContent === "MUTE",
    );
  /** Repaint the board from the plan, the way leaving the Console view does. A flow that
   *  throws before its own repaint leaves the board drawn from the plan it started with, so
   *  a MUTE tag read without this cannot see a merge such a flow made. */
  const repaint = (): void => {
    $("btn-view-console").click();
    $("btn-view-graph").click();
  };
  const insertFxOf = (id: string): string => {
    selectNode(id);
    return insertFxSection()!.querySelector("select")!.value;
  };
  /** The parameter ids of every `vd_get` from ledger position `from` on, in order. */
  const readsFrom = (shell: TauriShell, from: number): unknown[] =>
    shell.invokes.flatMap((cmd, i) => (i >= from && cmd === "vd_get" ? [shell.args[i]?.paramId] : []));
  /** The flow has ended one way or the other: a session came up, or the link was handed
   *  back. The rate picker locks for exactly as long as something holds the link. */
  const settled = async (): Promise<void> =>
    vi.waitFor(
      () => {
        const up = live().getAttribute("aria-checked") === "true";
        expect(up || !$<HTMLSelectElement>("rate-picker").disabled).toBe(true);
      },
      { timeout: 25_000 },
    );

  it("sets the badge from a fetch that answers, alongside the values it merged", SLOW, async () => {
    const shell = await bootDevice({ vd_get: unitReads });
    expect(badge().dataset.state).toBe("unknown");
    expect(muted("ch1"), "the premise: the plan has CH 1 on").toBe(false);
    expect(insertFxOf("ch1"), "the premise: the plan selects no effect").toBe("-1");

    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");
    await settled();

    expect(errors(shell)).toEqual([]);
    expect(badge().dataset.state).toBe("on");
    expect(muted("ch1")).toBe(true);
    expect(insertFxOf("ch1")).toBe(String(COMPANDER_H));
  });

  it("aborts a fetch whose Follow USB read fails, with nothing merged", SLOW, async () => {
    const shell = await bootDevice({ vd_get: unitReads });
    // A badge that already holds a reading, so "left as it was" is a state of its own rather
    // than the unknown a failed read could also land on.
    badge().click();
    await invoked(shell, "vd_disconnect");
    expect(badge().dataset.state).toBe("on");

    unit.refused = true;
    const from = shell.invokes.length;
    $("btn-fetch").click();
    expect($<HTMLSelectElement>("rate-picker").disabled, "the premise: the fetch took the link").toBe(true);
    expect($("rate-picker").parentElement!.title, "the field names the link").toBe(t().sim.lockRateLinked);
    await settled();
    await vi.waitFor(() => expect(errors(shell)).toEqual([t().status.fetchError("read-refused")]), {
      timeout: 10_000,
    });

    expect(countFor(statusText(), (n) => t().status.fetchedDevice("URX44V", n))).toBeNaN();
    expect(badge().dataset.state).toBe("on");
    repaint();
    expect(muted("ch1")).toBe(false);
    expect(insertFxOf("ch1")).toBe("-1");
    // The read that failed was Follow USB, and no plan read followed it.
    expect(readsFrom(shell, from)).toEqual([PARAMS.FOLLOW_USB.id]);
    expect(shell.count("vd_disconnect")).toBe(2);
  });

  // The live half's positive control on the badge is "writes over the live session's own
  // link rather than opening a second one" above; this one carries the plan values too.
  it("sets the badge from a live start that answers, alongside the values it merged", SLOW, async () => {
    const shell = await bootDevice({ vd_get: unitReads });
    expect(badge().dataset.state).toBe("unknown");

    live().click();
    await settled();

    expect(errors(shell)).toEqual([]);
    expect(live().getAttribute("aria-checked")).toBe("true");
    expect(badge().dataset.state).toBe("on");
    expect(muted("ch1")).toBe(true);
    expect(insertFxOf("ch1")).toBe(String(COMPANDER_H));
  });

  it("refuses to start a session whose Follow USB read fails, and tears the start down", SLOW, async () => {
    const shell = await bootDevice({ vd_get: unitReads });
    badge().click();
    await invoked(shell, "vd_disconnect");
    expect(badge().dataset.state).toBe("on");

    unit.refused = true;
    const from = shell.invokes.length;
    live().click();
    await settled();
    await vi.waitFor(() => expect(errors(shell)).toEqual([t().status.liveError("read-refused")]), {
      timeout: 10_000,
    });

    expect(live().getAttribute("aria-checked")).toBe("false");
    expect($("live-tally").hidden).toBe(true);
    expect(badge().dataset.state).toBe("on");
    expect(muted("ch1")).toBe(false);
    expect(insertFxOf("ch1")).toBe("-1");
    // Torn down: the connection the start opened was released — by its own epoch, the one
    // after the badge read's — nothing was registered on it, and the link holder was handed
    // back.
    const epochs = shell.invokes.flatMap((cmd, i) => (cmd === "vd_disconnect" ? [shell.args[i]?.epoch as number] : []));
    expect(epochs).toHaveLength(2);
    expect(epochs[1]).toBe(epochs[0] + 1);
    expect(shell.invokes.indexOf("vd_connect", from)).toBeLessThan(shell.invokes.lastIndexOf("vd_disconnect"));
    expect(shell.count("vd_params_subscribe")).toBe(0);
    expect($<HTMLButtonElement>("btn-fetch").disabled).toBe(false);
    expect(readsFrom(shell, from)).toEqual([PARAMS.FOLLOW_USB.id]);
  });

  for (const [flow, start] of [
    ["fetch", () => $("btn-fetch").click()],
    ["live start", () => live().click()],
  ] as const) {
    // The read's window is open while Follow USB is asked for: an edit made then is the
    // operator's, and the unit's value for the same key (the oscillator OFF, here) does
    // not replace it. A fetch then offers the list of device values it did not apply, in
    // the words for a read where nothing failed; every confirm declines, which is how that
    // offer is answered here (the case after this loop takes it). A live start offers
    // nothing.
    it(`keeps an edit made while a ${flow} reads Follow USB`, SLOW, async () => {
      let asked = (): void => {};
      const reading = new Promise<void>((r) => (asked = r));
      let answer = (): void => {};
      const held = new Promise<void>((r) => (answer = r));
      const shell = await bootDevice(
        {
          vd_get: (a: Record<string, unknown>) =>
            a.paramId === PARAMS.FOLLOW_USB.id ? (asked(), held.then(() => 1)) : unitReads(a),
        },
        false,
      );
      start();
      await reading;
      turnOscOn();
      expect(oscOn(), "the premise: the edit landed").toBe("ON");
      answer();
      await settled();

      expect(errors(shell)).toEqual([]);
      expect(badge().dataset.state).toBe("on");
      expect(oscOn()).toBe("ON");
      const offered = flow === "fetch" ? [t().confirm.deviceUnappliedExport] : [];
      await vi.waitFor(() => expect(confirms(shell)).toEqual(offered), { timeout: 10_000 });
    });

    // The read latch is up while Follow USB is asked for, so a file flow that would replace
    // the plan under the read is refused there as it is during the plan read.
    it(`refuses a file flow while a ${flow} reads Follow USB`, SLOW, async () => {
      let during = "";
      const shell = await bootDevice({
        vd_get: (a: Record<string, unknown>) => {
          if (a.paramId !== PARAMS.FOLLOW_USB.id) return unitReads(a);
          $("btn-new").click();
          during = statusText();
          return 1;
        },
      });
      start();
      await settled();

      expect(during).toBe(t().status.busyDeviceRead);
      expect(errors(shell)).toEqual([]);
      expect(badge().dataset.state).toBe("on");
    });
  }

  // The fetch above, with its offer taken: the report names the one device value the merge
  // left standing — the oscillator group the edit rebuilt — under the heading that says why,
  // and carries no failure section, since nothing failed.
  it("saves the device values a fetch left standing, under the prompt that says so", SLOW, async () => {
    let asked = (): void => {};
    const reading = new Promise<void>((r) => (asked = r));
    let answer = (): void => {};
    const held = new Promise<void>((r) => (answer = r));
    const shell = await bootDevice({
      ...SAVES,
      vd_get: (a: Record<string, unknown>) =>
        a.paramId === PARAMS.FOLLOW_USB.id ? (asked(), held.then(() => 1)) : unitReads(a),
    });
    $("btn-fetch").click();
    await reading;
    turnOscOn();
    answer();
    await settled();
    await vi.waitFor(() => expect(shell.count("write_text_file")).toBe(1), { timeout: 10_000 });

    expect(errors(shell)).toEqual([]);
    expect(confirms(shell)).toEqual([t().confirm.deviceUnappliedExport]);
    expect(JSON.stringify(shell.args[shell.invokes.indexOf("plugin:dialog|save")])).toContain("URX44V-fetch-report.md");
    const lines = String((shell.args[shell.invokes.indexOf("write_text_file")] as { contents: string }).contents).split(
      "\n",
    );
    expect(lines[0]).toBe("# URX readback report — URX44V");
    expect(lines.filter((l) => l.startsWith("## "))).toEqual(["## Device values not applied"]);
    expect(lines.filter((l) => l.startsWith("- ")).slice(1)).toEqual(["- nodeParams bus.osc.osc"]);
    expect(lines[2]).toMatch(/; read failures: 0; nodes unconfirmed: 0$/);
  });

  // A cancel lands on the read in flight: a Follow USB read that fails after it is reported
  // as the cancel, as a plan read that fails after one is.
  it("reports a fetch cancelled during its Follow USB read as cancelled when that read fails", SLOW, async () => {
    let asked = (): void => {};
    const reading = new Promise<void>((r) => (asked = r));
    let fail = (): void => {};
    const held = new Promise<number>((_r, reject) => (fail = () => reject(new Error("read-refused"))));
    const shell = await bootDevice({
      vd_get: (a: Record<string, unknown>) => (a.paramId === PARAMS.FOLLOW_USB.id ? (asked(), held) : unitReads(a)),
    });
    $("btn-fetch").click();
    await reading;
    $("btn-fetch").click(); // a second click cancels
    fail();
    await settled();

    await vi.waitFor(() => expect(statusText()).toBe(t().status.canceled), { timeout: 10_000 });
    expect(errors(shell)).toEqual([]);
    expect(badge().dataset.state).toBe("unknown");
    expect(insertFxOf("ch1")).toBe("-1");
  });

  // The badge moves only with a plan read that landed. Each case starts from a badge that
  // reads ON and has the flow's own Follow USB read answer OFF, so a badge set from that
  // read alone shows as "off".
  it("leaves the badge as it was when a fetch is cancelled during its plan read", SLOW, async () => {
    const link = { followUsb: 1, reads: 0, cancelAt: 0 };
    const shell = await bootDevice({
      vd_get: (a: Record<string, unknown>) => {
        if (a.paramId === PARAMS.FOLLOW_USB.id) return link.followUsb;
        if (++link.reads === link.cancelAt) $("btn-fetch").click();
        return unitReads(a);
      },
    });
    badge().click();
    await invoked(shell, "vd_disconnect");
    expect(badge().dataset.state).toBe("on");

    Object.assign(link, { followUsb: 0, reads: 0, cancelAt: 3 });
    $("btn-fetch").click();
    await settled();

    await vi.waitFor(() => expect(statusText()).toBe(t().status.canceled), { timeout: 10_000 });
    expect(link.reads, "the premise: the plan read had begun").toBeGreaterThanOrEqual(3);
    expect(errors(shell)).toEqual([]);
    expect(badge().dataset.state).toBe("on");
    expect(insertFxOf("ch1")).toBe("-1");
  });

  it("leaves the badge as it was when a live start's plan read is incomplete", SLOW, async () => {
    const link = { followUsb: 1, refuseFx: false };
    const shell = await bootDevice({
      vd_get: (a: Record<string, unknown>) => {
        if (a.paramId === PARAMS.FOLLOW_USB.id) return link.followUsb;
        if (link.refuseFx && a.paramId === PARAMS.INSERT_FX.id) throw new Error("read-refused");
        return unitReads(a);
      },
    });
    badge().click();
    await invoked(shell, "vd_disconnect");
    expect(badge().dataset.state).toBe("on");

    Object.assign(link, { followUsb: 0, refuseFx: true });
    live().click();
    await settled();

    await vi.waitFor(() => expect(errors(shell)).toHaveLength(1), { timeout: 10_000 });
    const incomplete = (n: number): string => t().status.liveError(t().error.liveReadIncomplete(n));
    expect(countFor(errors(shell)[0], incomplete)).toBeGreaterThan(0);
    expect(live().getAttribute("aria-checked")).toBe("false");
    expect(badge().dataset.state).toBe("on");
  });

  // What the badge said was read over a link. A fetch whose link drops part-way keeps the
  // values it did read, and its badge goes back to unknown, as a session's does when its
  // link drops.
  it("leaves the badge unknown after a fetch whose link dropped part-way", SLOW, async () => {
    const link = { followUsb: 0, reads: 0, dropAt: Infinity };
    // Every confirm declines, which is how the offer to save the read report is answered.
    const shell = await bootDevice(
      {
        vd_get: (a: Record<string, unknown>) => {
          if (a.paramId === PARAMS.FOLLOW_USB.id) return link.followUsb;
          if (++link.reads >= link.dropAt) throw new Error("device-lost");
          return unitReads(a);
        },
      },
      false,
    );
    badge().click();
    await invoked(shell, "vd_disconnect");
    expect(badge().dataset.state).toBe("off");

    Object.assign(link, { followUsb: 1, reads: 0, dropAt: 40 });
    $("btn-fetch").click();
    await settled();

    await vi.waitFor(() => expect(statusText()).toBe(t().error.shell.deviceLost), { timeout: 10_000 });
    expect(errors(shell)).toEqual([]);
    expect(badge().dataset.state).toBe("unknown");
  });

  // A model switch the operator took is applied only by a read that lands, so a fetch whose
  // Follow USB read fails switches nothing — the plan keeps its model, and the badge what
  // it read before.
  it("leaves the badge as it was after a fetch that switched models fails", SLOW, async () => {
    const shell = await bootDevice({ ...connectAs("URX22"), vd_get: unitReads });
    badge().click();
    await invoked(shell, "vd_disconnect");
    expect(badge().dataset.state).toBe("on");

    unit.refused = true;
    $("btn-fetch").click();
    await vi.waitFor(() => expect(errors(shell)).toEqual([t().status.fetchError("read-refused")]), {
      timeout: 10_000,
    });
    await settled();

    expect(confirms(shell), "the premise: the switch was offered and taken").toEqual([
      t().confirm.switchModel("URX22", "URX44V"),
    ]);
    expect($<HTMLSelectElement>("model-picker").value).toBe("URX44V");
    expect(badge().dataset.state).toBe("on");
  });
});

describe("the sample rate a write happens at", () => {
  const modal = (): HTMLElement => $("rate-choice");

  /** Click Write and wait for the three-way to come up. */
  async function askedToChoose(shell: TauriShell): Promise<void> {
    $("btn-write").click();
    await vi.waitFor(() => expect(modal().hidden).toBe(false), { timeout: 15_000 });
    expect(shell.count("vd_set")).toBe(0); // nothing goes out before the rate is settled
  }

  // The rate is the one plan value the device can accept and then undo on its own: with
  // Follow USB on it re-clocks and is then dragged back to the host's rate. The interval
  // that was measured on hardware is in architecture.md "Sample rate and Follow USB" and
  // is deliberately not restated here. So the disagreement is a three-way rather than a
  // yes/no, and none of the three answers may be inferred.
  it("cancels the whole write when the three-way is dismissed", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(true, 96_000) });
    await askedToChoose(shell);

    $("rate-choice-cancel").click();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.canceled), { timeout: 10_000 });
    expect(modal().hidden).toBe(true);
    expect(shell.count("vd_set")).toBe(0);
    expect(followUsbWrites(shell)).toEqual([]);
  });

  // Adopting is an edit like any other — the operator chose it — so it goes through the
  // same funnel as the picker and is remembered as the last known rate. Being REMEMBERED
  // is the half a plan-only assertion misses.
  it("adopts the device's rate into the plan, the picker and the stored rate", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(true, 96_000) });
    await askedToChoose(shell);

    $("rate-choice-adopt").click();
    await vi.waitFor(() => expect($<HTMLSelectElement>("rate-picker").value).toBe("96000"), { timeout: 10_000 });
    expect(localStorage.getItem("urx-rate")).toBe("96000");
    // …and the write went ahead at the adopted rate rather than stopping at the choice.
    await invoked(shell, "vd_disconnect");
    expect(shell.count("vd_set")).toBeGreaterThan(10);
    expect(followUsbWrites(shell)).toEqual([]); // adopting does not touch the policy
  });

  // Adopting a device rate an insert the plan holds cannot run at takes that insert off the plan,
  // as the unit already has — said on the adopt arm's own line, and written as No Effect.
  it("names on the adopt arm the inserts the device's rate takes off the plan", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(true, 192_000) });
    $("btn-view-console").click();
    document.querySelector<HTMLElement>(".con-strip .con-ifxopen")!.click();
    [...document.querySelectorAll<HTMLElement>(".con-ifxpop .irow")]
      .find((r) => r.textContent?.includes("Pitch Fix"))!
      .click();
    expect(document.querySelector(".con-strip .con-ifxface")?.classList.contains("vacant"), "the premise").toBe(false);
    await askedToChoose(shell);
    const note = $("rate-choice-adopt-note");
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe(t().rateChoice.insertsOffAtRate(formatRate(192_000), "Pitch Fix (CH 1)"));
    // At 192 kHz the shared note carries the high-rate limits, and leaves out the insert line,
    // which says the plan keeps what the adopt arm here takes off.
    expect($("rate-choice-note").textContent, "the premise: the shared note is drawn").toContain(t().warning.fx2);
    expect($("rate-choice-note").textContent, "the shared note leaves the insert line out").not.toContain(
      t().warning.insFx,
    );
    $("rate-choice-adopt").click();
    await invoked(shell, "vd_disconnect");
    const insertWrites = shell.invokes.flatMap((cmd, i) =>
      cmd === "vd_set" && shell.args[i]?.paramId === PARAMS.INSERT_FX.id && shell.args[i]?.y === 0
        ? [shell.args[i]!.value as number]
        : [],
    );
    expect(insertWrites).not.toContain(
      denormalizeInsertFx(INSERT_FX_OPTIONS.find((o) => o.label === "Pitch Fix")!.value),
    );
    expect(document.querySelector(".con-strip .con-ifxface")?.classList.contains("vacant")).toBe(true);
  });

  // The other half: with nothing the device's rate rules out, the adopt arm has no line.
  it("draws no adopt-arm line when the plan holds no insert the device's rate rules out", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(true, 96_000) });
    await askedToChoose(shell);
    expect($("rate-choice-adopt-note").hidden).toBe(true);
    $("rate-choice-cancel").click();
  });

  // Releasing turns Follow USB off so the plan's rate can stick, and the badge follows at
  // once: the operator is being told the picker is authoritative again.
  it("releases the clock so the plan's rate can stick", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(true, 96_000) });
    await askedToChoose(shell);

    $("rate-choice-release").click();
    await vi.waitFor(() => expect(followUsbWrites(shell)).toEqual([0]), { timeout: 10_000 });
    expect($("follow-usb").dataset.state).toBe("off");
    expect($<HTMLSelectElement>("rate-picker").value).toBe("48000"); // the plan's rate, unchanged
    await invoked(shell, "vd_disconnect");
  });

  // A policy write that fails leaves the premise of the whole write unestablished, so it
  // aborts rather than writing at a rate it just failed to secure.
  it("abandons the write when the clock cannot be released", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(true, 96_000) });
    await askedToChoose(shell);

    shell.failOnce("vd_set", new Error("refused"));
    $("rate-choice-release").click();
    await invoked(shell, "vd_disconnect");
    await new Promise((r) => setTimeout(r, 100));
    expect(shell.count("vd_set")).toBe(1); // the refused policy write, and nothing after it
    // The write that was refused was the POLICY one, and the failure reached the operator.
    // Aborting in silence is the other way this ends, and it looks the same from the
    // counts: nothing on screen, nothing on the wire.
    expect(followUsbWrites(shell)).toEqual([0]);
    expect(errors(shell).at(-1)).toBe(t().status.writeError(t().error.followUsbWrite("refused")));
  });

  // Above 96 kHz whole features drop out, so adopting names them before the choice is
  // made. Both arms are pinned: the note is the only thing that makes `adopt` not a
  // surprise, and an empty one has to be hidden rather than left as a gap.
  it("names what a rate above 96 kHz would leave unwritten", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(true, 192_000) });
    await askedToChoose(shell);

    expect($("rate-choice-note").hidden).toBe(false);
    expect($("rate-choice-note").textContent).not.toBe("");
    $("rate-choice-cancel").click();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.canceled), { timeout: 10_000 });
  });

  it("shows no note when nothing would be left unwritten", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(true, 44_100) });
    await askedToChoose(shell);

    expect($("rate-choice-note").hidden).toBe(true);
    $("rate-choice-cancel").click();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.canceled), { timeout: 10_000 });
  });

  // Which rate the device will end up running at decides which parameters the write may
  // even contain, so a clock read that fails is fail-closed: proceeding would be writing
  // on a premise the link just failed to establish.
  it("writes nothing when the clock cannot be read", SLOW, async () => {
    const shell = await bootDevice({
      vd_get: (a: Record<string, unknown>) => {
        if (a.paramId === PARAMS.FOLLOW_USB.id) throw new Error("timeout");
        return 0;
      },
    });
    $("btn-write").click();
    await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 100));
    expect(modal().hidden).toBe(true); // fail-closed, not "ask the operator instead"
    expect(shell.count("vd_set")).toBe(0);
    // Reported as the clock read failing, rather than as whatever the flow hit next: the
    // three-way staying down and no writes going out are equally true of a flow that fell
    // over somewhere else entirely.
    expect(errors(shell).at(-1)).toBe(t().status.writeError(t().error.clockUnread("timeout")));
  });
});

// A live session takes a rate chosen in the app while Follow USB is off, once the operator has
// agreed to what it costs — the questions a write's settle asks. With Follow USB on the unit takes
// the computer's rate back, so the rate stays locked.

describe("the sample rate during Live sync", () => {
  const rateWrites = (shell: TauriShell): number[] =>
    shell.invokes.flatMap((cmd, i) =>
      cmd === "vd_set" && shell.args[i]?.paramId === PARAMS.SAMPLE_RATE.id ? [shell.args[i]!.value as number] : [],
    );
  const picker = (): HTMLSelectElement => $<HTMLSelectElement>("rate-picker");
  const goLive = async (): Promise<void> => {
    live().click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
  };
  const SEED = { [`${PARAMS.SAMPLE_RATE.id}/0/0`]: 48_000, [FOLLOW_USB_SEED]: 0, [TRACK_COUNT_SEED]: 8 };

  it("writes a rate chosen while Follow USB is off once the operator agrees to what it costs", SLOW, async () => {
    const shell = await bootDevice({}, true, SEED);
    await goLive();
    expect(picker().disabled).toBe(false);
    chooseRate(96_000);
    await vi.waitFor(() => expect(rateWrites(shell)).toEqual([96_000]), { timeout: 10_000 });
    const drop = trackCountDrop(16, 96_000)!;
    expect(confirms(shell)).toEqual([
      `${t().confirm.reclock(formatRate(48_000), formatRate(96_000))} ${t().confirm.trackCountDrop(drop.from, drop.to)}`,
    ]);
    expect(picker().value).toBe("96000");
  });

  // A rate past an insert effect's own ceiling takes that insert off, on the unit and in the
  // plan, and lowering the rate does not put it back — so it is named in front of the decision,
  // and the write that follows puts the plan's channel on No Effect.
  it("names the inserts a rate chosen during Live sync takes off, before writing it", SLOW, async () => {
    const shell = await bootDevice({}, true, SEED);
    await goLive();
    const pitch = INSERT_FX_OPTIONS.find((o) => o.label === "Pitch Fix")!.value;
    const insertWrites = (): number[] =>
      shell.invokes.flatMap((cmd, i) =>
        cmd === "vd_set" && shell.args[i]?.paramId === PARAMS.INSERT_FX.id && shell.args[i]?.y === 0
          ? [shell.args[i]!.value as number]
          : [],
      );
    // CH 1 takes Pitch Fix from its INS FX list during the session, and the unit gets it.
    $("btn-view-console").click();
    document.querySelector<HTMLElement>(".con-strip .con-ifxopen")!.click();
    [...document.querySelectorAll<HTMLElement>(".con-ifxpop .irow")]
      .find((r) => r.textContent?.includes("Pitch Fix"))!
      .click();
    await vi.waitFor(() => expect(insertWrites()).toContain(denormalizeInsertFx(pitch)), { timeout: 10_000 });
    chooseRate(88_200);
    await vi.waitFor(() => expect(rateWrites(shell)).toEqual([88_200]), { timeout: 10_000 });
    expect(confirms(shell).at(-1) ?? "").toContain(t().confirm.insertsOffAtRate("Pitch Fix (CH 1)"));
    // …and the plan's CH 1 is on No Effect, which the session writes.
    await vi.waitFor(() => expect(insertWrites().at(-1)).toBe(denormalizeInsertFx(INSERT_FX_NONE)), {
      timeout: 10_000,
    });
    expect(document.querySelector(".con-strip .con-ifxface")?.classList.contains("vacant")).toBe(true);
  });

  it("writes nothing when the operator declines, and shows the rate the plan holds", SLOW, async () => {
    const shell = await bootDevice({}, false, SEED);
    await goLive();
    chooseRate(44_100);
    await vi.waitFor(() => expect(confirms(shell)).toHaveLength(1), { timeout: 10_000 });
    await vi.waitFor(() => expect(statusText()).toBe(t().status.canceled));
    expect(rateWrites(shell)).toEqual([]);
    expect(picker().value).toBe("48000");
  });

  it.each([
    [1, (from: string, to: string) => t().error.rateDuringPlaybackLive(from, to)],
    [3, (from: string, to: string) => t().error.rateDuringRecordingLive(from, to)],
  ])("refuses a rate while the microSD recorder holds a file (state %i)", SLOW, async (state, refusal) => {
    const shell = await bootDevice({}, true, { ...SEED, [PLAYBACK_SEED]: state });
    await goLive();
    chooseRate(44_100);
    await vi.waitFor(() => expect(errors(shell)).toHaveLength(1), { timeout: 10_000 });
    expect(errors(shell)[0]).toBe(refusal(formatRate(48_000), formatRate(44_100)));
    expect(confirms(shell), "nothing asked").toEqual([]);
    expect(rateWrites(shell)).toEqual([]);
    expect(picker().value).toBe("48000");
  });

  // Armed once the session is up, so the reads its start takes answer from the table.
  it.each([
    [PLAYBACK_ADDR, (e: string) => t().error.playbackUnread(e)],
    [TRACK_COUNT_ADDR, (e: string) => t().error.trackCountUnread(e)],
  ])("writes nothing, and asks nothing, when %s cannot be read", SLOW, async (failing, message) => {
    const armed = { on: false };
    const tauri = deviceCommands({ "plugin:dialog|message": "Ok" }, SEED);
    const read = tauri.vd_get as (a: Record<string, unknown>) => unknown;
    tauri.vd_get = (a: Record<string, unknown>) => {
      if (armed.on && `${a.paramId}:${a.x}:${a.y}` === failing) throw new Error("timeout");
      return read(a);
    };
    const shell = (await bootApp({ tauri }))!;
    await goLive();
    armed.on = true;
    chooseRate(44_100);
    await vi.waitFor(() => expect(errors(shell)).toEqual([message("timeout")]), { timeout: 10_000 });
    expect(confirms(shell), "nothing asked").toEqual([]);
    expect(rateWrites(shell)).toEqual([]);
    expect(picker().value).toBe("48000");
  });

  // A Scene-only session leaves the rate out of what it writes, so a rate chosen then would show in
  // the app and never reach the unit. The field says so, in the language on screen.
  it("keeps the rate locked for a session whose scope leaves the rate out, and names the scope", SLOW, async () => {
    const shell = (await bootApp({
      seed: { "urx-settings": JSON.stringify({ deviceScope: "scene" }) },
      tauri: deviceCommands({ "plugin:dialog|message": "Ok" }, SEED),
    }))!;
    await goLive();
    expect(picker().disabled).toBe(true);
    const field = picker().parentElement!;
    expect(field.title, "the field names the scope").toBe(t().sim.lockRateScope);
    const i18n = await import("./i18n");
    i18n.setLang("ja");
    expect(field.title, "in the language switched to").toBe(i18n.t().sim.lockRateScope);
    expect(field.title).not.toBe(t().sim.lockRateScope);
    i18n.setLang("en");
    chooseRate(96_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(confirms(shell), "nothing asked").toEqual([]);
    expect(rateWrites(shell)).toEqual([]);
    expect(picker().value).toBe("48000");
  });

  it(
    "keeps the rate locked while Follow USB is on, and opens it once the unit turns Follow USB off",
    SLOW,
    async () => {
      const shell = await bootDevice({}, true, { ...SEED, [FOLLOW_USB_SEED]: 1 });
      await goLive();
      expect(picker().disabled).toBe(true);
      notifyChannel(shell).onmessage([{ param_id: PARAMS.FOLLOW_USB.id, x: 0, y: 0, value: 0 }]);
      await vi.waitFor(() => expect(picker().disabled).toBe(false), { timeout: 10_000 });
      expect(picker().parentElement!.hasAttribute("title"), "and no reason once it opens").toBe(false);
    },
  );

  it("asks before an undo moves the rate, and writes it back once agreed", SLOW, async () => {
    const shell = await bootDevice({}, true, SEED);
    await goLive();
    chooseRate(44_100);
    await vi.waitFor(() => expect(rateWrites(shell)).toEqual([44_100]), { timeout: 10_000 });
    // A press and release closes the open entry one macrotask later.
    window.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 9 }));
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 9 }));
    await new Promise((r) => setTimeout(r, 0));
    expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
    await vi.waitFor(() => expect(rateWrites(shell)).toEqual([44_100, 48_000]), { timeout: 10_000 });
    expect(confirms(shell)).toHaveLength(2);
    expect(picker().value).toBe("48000");
  });
});

// A write settles the sample rate once, at its start, and then converges the plan it re-reads
// every round — so a rate the plan takes after the settle goes out with no re-clock confirm and
// no Track Count warning. Undo is where that can come from, and it is refused for the rate while
// any device action holds the link, as the rate picker is.

describe("the sample rate during a write", () => {
  /** A press and release on the window: it closes the open undo entry one macrotask later. */
  const boundary = async (): Promise<void> => {
    window.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 9 }));
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 9 }));
    await new Promise((r) => setTimeout(r, 0));
  };
  const rateWrites = (shell: TauriShell): number[] =>
    shell.invokes.flatMap((cmd, i) =>
      cmd === "vd_set" && shell.args[i]?.paramId === PARAMS.SAMPLE_RATE.id ? [shell.args[i]!.value as number] : [],
    );

  it("refuses to undo a rate change while a write holds the link", SLOW, async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let asked!: () => void;
    const diffing = new Promise<void>((r) => (asked = r));
    const table = deviceCommands({ "plugin:dialog|message": "Ok" }, { [`${PARAMS.SAMPLE_RATE.id}/0/0`]: 48_000 });
    const vdGet = table.vd_get as (a: Record<string, unknown>) => unknown;
    let gets = 0;
    const shell = (await bootApp({
      tauri: {
        ...table,
        // The clock's two reads answer; the diff's first is held.
        vd_get: async (a: Record<string, unknown>) => {
          if (++gets === 3) {
            asked();
            await held;
          }
          return vdGet(a);
        },
      },
    }))!;
    chooseRate(96_000);
    await boundary();
    chooseRate(48_000);
    await boundary();

    $("btn-write").click();
    await diffing;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(statusText()).toBe(t().status.undoRateLocked);
    expect($<HTMLSelectElement>("rate-picker").value).toBe("48000");
    release();
    await vi.waitFor(() => expect($("btn-write").textContent).toBe(t().toolbar.writeDevice), { timeout: 20_000 });
    expect(rateWrites(shell)).not.toContain(96_000);
  });

  it("re-reads the recorder after a rate the write sends, a count that fits it included", SLOW, async () => {
    const shell = await bootDevice({}, true, {
      [`${PARAMS.SAMPLE_RATE.id}/0/0`]: 48_000,
      [TRACK_COUNT_SEED]: 2,
    });
    chooseRate(96_000);
    $("btn-write").click();
    await vi.waitFor(() => expect($("btn-write").textContent).toBe(t().toolbar.writeDevice), { timeout: 20_000 });
    await invoked(shell, "vd_disconnect");
    expect(rateWrites(shell)).toContain(96_000);
    const sentAt = shell.invokes.findIndex(
      (cmd, i) => cmd === "vd_set" && shell.args[i]?.paramId === PARAMS.SAMPLE_RATE.id,
    );
    const readAfter = shell.invokes.some(
      (cmd, i) =>
        i > sentAt &&
        cmd === "vd_get" &&
        `${shell.args[i]?.paramId}:${shell.args[i]?.x}:${shell.args[i]?.y}` === TRACK_COUNT_ADDR,
    );
    expect(readAfter).toBe(true);
  });
});
