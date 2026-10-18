// @vitest-environment jsdom

// A raw the unit holds that this app cannot write, and what the plan may take from a write.
//
// The setup, the teardown and the helpers every desktop case shares are `main.device.test-util.ts`'s,
// which also states what the device table does and does not model.

import { describe, expect, it, vi } from "vitest";
import { $, bootApp, deviceCommands, statusText } from "./main.test-util";
import type { TauriShell } from "./main.test-util";
import { fxParams } from "./core/control/fx-effect";
import { denormalizeInsertFx, PARAMS } from "./core/control/params";
import {
  cmdAddr,
  insertFxControl,
  nodeLeafRules,
  planToCommandOrigins,
  planToCommands,
} from "./core/control/translate";
import { nodeParamContestPath } from "./core/plan-history";
import { getModel } from "./models";
import { defaultPlan } from "./models/initial-state";
import { EDIT_MENU_EVENT, EDIT_UNDO_ID } from "./core/platform";
import { t } from "./i18n";
import {
  SLOW,
  bootDevice,
  invoked,
  live,
  chooseRate,
  TRACK_COUNT_SEED,
  TRACK_COUNT_ADDR,
  errors,
  countFor,
  SAVES,
  pressNode,
  countedHead,
  paramRow,
  COMPANDER_H,
  pickFxType,
  undoEdit,
  quiet,
} from "./main.device.test-util";

// A raw the unit holds and this app cannot write. The load path repairs a document, so the way
// one reaches the plan is a DEVICE read: the unit's own encoder stops where the window does,
// but the wire does not, and an earlier build of this app could put one there.
//
// What the plan may take from a write is keyed on the ADDRESSES the device confirmed, not on
// the write having succeeded — the last case is why. A live session whose snapshot already
// agrees sends nothing, so an unrelated edit produces a successful flush that never carried
// this address, and an earlier version of this adopted on that flush.

/** A table seed holding the factory plan's value at every address a node-param leaf the write
 *  bounds is sent to, so a read of the unit finds each of those leaves inside its rule. */
function boundedLeavesAtFactory(): Record<string, number> {
  const model = getModel("URX44V");
  const factory = defaultPlan("URX44V");
  const leaves = new Set(
    model.nodes.flatMap((n) =>
      nodeLeafRules(model, n.id, factory.nodeParams[n.id]).map(([path]) => nodeParamContestPath(n.id, path)),
    ),
  );
  const origins = planToCommandOrigins(model, factory);
  const seed: Record<string, number> = {};
  for (const c of planToCommands(model, factory)) {
    const origin = origins.get(cmdAddr(c));
    if (typeof origin === "string" && leaves.has(origin)) seed[`${c.paramId}/${c.x}/${c.y}`] = c.vdValue;
  }
  return seed;
}

describe("a value the unit holds and the app cannot write", () => {
  const lpf = fxParams(1024).find((d) => d.key === "delayLpf")!;
  const BELOW = lpf.rawMin! - 1;
  // BOTH channels' slots are seeded, from the catalogue rather than by hand: a slot the
  // table has not been told about reads 0, and 0 is outside several of these windows too, so
  // a partial seed would move the count this case asserts for a reason it is not about. Every
  // node-param leaf the write bounds is seeded at the factory plan's value for the same reason —
  // a GATE attack, a stereo channel's Rec Point and the oscillator interval all read 0 otherwise,
  // and the write takes each of those back as well.
  const unitInRule = (): Record<string, number> => {
    const seed: Record<string, number> = { ...boundedLeavesAtFactory(), [`${PARAMS.SAMPLE_RATE.id}/0/0`]: 48_000 };
    for (const [typeId, arrId, type] of [
      [679, 681, 0],
      [683, 685, 1024],
    ] as const) {
      seed[`${typeId}/0/0`] = type;
      for (const d of fxParams(type)) seed[`${arrId}/0/${d.slot}`] = d.def;
    }
    return seed;
  };
  const unitHoldingLowLpf = (): Record<string, number> => ({ ...unitInRule(), [`685/0/${lpf.slot}`]: BELOW });
  // Read off the surface rather than out of module state: what the operator sees IS the
  // question. The effect's parameters are drawn by the FX EFFECT tuning screen, so the node is
  // selected, its launcher pressed, the readout taken and the screen closed again — reopened
  // per reading so each one is a fresh draw of the plan as it stands.
  const withFxScreen = <T>(nodeId: string, use: (box: HTMLElement) => T): T => {
    pressNode(nodeId);
    $<HTMLButtonElement>("btn-fx-screen").click();
    const box = $("dyn-screen-box");
    const out = use(box);
    box.querySelector<HTMLButtonElement>(".consent-actions button")!.click();
    return out;
  };
  const shownFx = (nodeId: string, planKey: string): string =>
    withFxScreen(nodeId, (box) => box.querySelector<HTMLElement>(`[data-dyn-val="fx:${planKey}"]`)?.textContent ?? "");
  const shownLpf = (): string => shownFx("bus.fx2", "delayLpf");
  /** The screen's Hi.Ratio slider, which is where an ordinary operator edit to an FX channel
   *  is made here — a row of the delay face that is NOT the LPF these cases are about. Read
   *  and written through the same open, since the controls draw a captured snapshot and a
   *  handle kept across a write would be answering for the plan as it was. */
  const fxEdit = (nodeId: string): HTMLInputElement =>
    withFxScreen(nodeId, (box) => box.querySelector<HTMLInputElement>('input[data-dyn="fx:delayHiRatio"]')!);

  // What the status assertions after a selection rest on: `pressNode` completes the press, so
  // the board's path-trace line does not land over the line a case is reading.
  it("completes the node press, so the path trace never writes over the line", SLOW, async () => {
    const shell = await bootDevice({}, true, unitHoldingLowLpf());
    const fx2 = (): SVGGElement => $("graph-host").querySelector<SVGGElement>('g.node[data-id="bus.fx2"]')!;

    // The control first, because it is what bounds the wait below. An OPEN press holds and
    // then writes the trace line, and the hold is TAKEN here rather than restated from the
    // board's own constant — a hold that grows carries this case with it instead of leaving
    // a copy behind to go stale.
    const armed = performance.now();
    fx2().dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, bubbles: true }));
    await vi.waitFor(() => expect(statusText()).toBe(t().status.pathNone("FX 2")), { timeout: 20_000 });
    const hold = performance.now() - armed;

    // …and the completed press does not, twice that hold later. The fetch supplies a line the
    // trace cannot be mistaken for, so an overwrite is visible rather than indistinguishable.
    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");
    const line = statusText();
    expect(line).not.toBe(t().status.pathNone("FX 2"));

    pressNode("bus.fx2");
    await new Promise((resolve) => setTimeout(resolve, hold * 2));
    expect(statusText()).toBe(line);
  });

  it("reads it verbatim, then takes the sent value once the device has confirmed it", SLOW, async () => {
    const shell = await bootDevice({}, true, unitHoldingLowLpf());
    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");
    // The read is verbatim: what the unit holds, not what the app could write.
    expect(shownLpf()).toBe(lpf.format!(BELOW, {}));

    $("btn-write").click();
    await invoked(shell, "vd_disconnect", 2);
    // The line the WRITE ended on.
    expect(statusText()).toContain(t().status.paramsBounded(1));
    // …and the write's own value is what the plan ends up holding, so the panel and the unit
    // name the same setting from here on.
    expect(shownLpf()).toBe(lpf.format!(lpf.rawMin!, {}));
  });

  // A node's own params take the same path: a read files an insert-FX engine's values under the
  // bare slot as the unit reported them, and the write sends the slot's own bound. Read back
  // through two saves, since the document is where the plan's value goes on living.
  it("takes an insert-FX raw the read stored verbatim back once the device confirmed it", SLOW, async () => {
    const { ENGINE_COMPANDER_INPUT, insertFxDefaults } = await import("./core/control/insert-fx-effect");
    const ifx = insertFxControl(getModel("URX44V"), "ch1")!;
    const seed = unitInRule();
    seed[`${ifx.param}/0/${ifx.instances[0]}`] = denormalizeInsertFx(COMPANDER_H);
    for (const [slot, v] of Object.entries(insertFxDefaults("compander", COMPANDER_H)))
      seed[`${ENGINE_COMPANDER_INPUT}/0/${slot}`] = v;
    const PAST = 99_999;
    seed[`${ENGINE_COMPANDER_INPUT}/0/7`] = PAST;
    const shell = await bootDevice(SAVES, true, seed);
    const saved = async (): Promise<unknown> => {
      const before = shell.count("write_text_file");
      $("btn-save").click();
      await vi.waitFor(() => expect(shell.count("write_text_file")).toBe(before + 1), { timeout: 10_000 });
      const doc = JSON.parse(
        String((shell.args[shell.invokes.lastIndexOf("write_text_file")] as { contents: string }).contents),
      );
      return doc.nodeParams.ch1.insertFxParams["7"];
    };

    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");
    expect(await saved(), "the read is verbatim").toBe(PAST);

    $("btn-write").click();
    await invoked(shell, "vd_disconnect", 2);
    const sent = shell.invokes
      .map((cmd, i) => (cmd === "vd_set" ? shell.args[i] : undefined))
      .filter((a): a is Record<string, unknown> => !!a && a.paramId === ENGINE_COMPANDER_INPUT && a.y === 7);
    expect(
      sent.map((a) => a.value),
      "the write sends the slot's bound",
    ).toEqual([2000]);
    expect(statusText()).toContain(t().status.paramsBounded(1));
    expect(await saved()).toBe(2000);
  });

  // The recorder tail runs in a FINALLY, after the write has written its outcome. A read that
  // fails there raises a dialog through `showError`, which clears the status — right for a
  // stale "Connecting…" behind a dialog, wrong for the line that says the plan changed. The
  // dialog names the recorder read; nothing else names the values the write took back.
  //
  // Both halves are driven, because "the line is there" passes on its own whenever the tail
  // does not run at all: the rate has to land (which arms the tail) AND the cancel has to fall
  // inside the converge's re-read (which is what leaves something to take back).
  // The numeric phase can finish and the cancel still land — between the converge returning
  // and the name writes. The adoption has already changed the plan by then, so leaving that
  // gate to throw hands `withDevice` a bare "Canceled" and the count goes unsaid, which is
  // the same silence this whole block exists to close.
  it("reports what a cancel between the numeric phase and the names took back", SLOW, async () => {
    const table = deviceCommands({ "plugin:dialog|message": "Ok" }, unitHoldingLowLpf());
    const baseGet = table.vd_get as (a: Record<string, unknown>) => number;
    const baseSet = table.vd_set as (a: Record<string, unknown>) => void;
    // The address the confirm diff reads LAST, taken from that diff rather than named here:
    // it is the emit's own last command, and a name would go stale the day the emit grows one.
    const readSoFar: string[] = [];
    let lastOfDiff = "";
    table.vd_set = (a: Record<string, unknown>) => {
      if (!lastOfDiff) lastOfDiff = readSoFar[readSoFar.length - 1] ?? "";
      return baseSet(a);
    };
    table.vd_get = (a: Record<string, unknown>) => {
      const key = `${a.paramId}:${a.x}:${a.y}`;
      if (!lastOfDiff) readSoFar.push(key);
      const value = baseGet(a);
      // Answered, so the converge's re-read leaves its loop with nothing residual — the store
      // keeps every write — and the next thing the flow reaches is the gate before the names.
      if (lastOfDiff && key === lastOfDiff) $("btn-write").click();
      return value;
    };
    const shell = (await bootApp({ tauri: table }))!;
    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");
    expect(shownLpf()).toBe(lpf.format!(BELOW, {}));

    $("btn-write").click();
    await invoked(shell, "vd_disconnect", 2);
    // The positive control: without a write there is no converge to finish, and the case would
    // be measuring a cancel taken before anything went out.
    expect(shell.count("vd_set")).toBeGreaterThan(10);
    await vi.waitFor(() => expect(statusText()).toBe(t().status.canceled + ` — ${t().status.paramsBounded(1)}`));
    expect(shownLpf()).toBe(lpf.format!(lpf.rawMin!, {}));
  });

  it("keeps the line that says the plan changed when the recorder re-read fails", SLOW, async () => {
    const withRecorderRead = async (failRead: boolean): Promise<TauriShell> => {
      const seed = unitHoldingLowLpf();
      seed[TRACK_COUNT_SEED] = 8;
      const table = deviceCommands({ "plugin:dialog|message": "Ok" }, seed);
      const baseGet = table.vd_get as (a: Record<string, unknown>) => number;
      const baseSet = table.vd_set as (a: Record<string, unknown>) => void;
      let written = false;
      table.vd_set = (a: Record<string, unknown>) => {
        written = true;
        return baseSet(a);
      };
      table.vd_get = (a: Record<string, unknown>) => {
        if (failRead && written && `${a.paramId}:${a.x}:${a.y}` === TRACK_COUNT_ADDR) throw new Error("device-lost");
        const value = baseGet(a);
        // Cancel during the converge's re-read, once this address has answered: the rate went
        // out earlier in the same round, so the recorder tail is armed by the time it lands.
        if (written && Number(a.paramId) === 685 && Number(a.y) === lpf.slot) $("btn-write").click();
        return value;
      };
      const shell = (await bootApp({ tauri: table }))!;
      $("btn-fetch").click();
      await invoked(shell, "vd_disconnect");
      const picker = $<HTMLSelectElement>("rate-picker");
      picker.value = "96000";
      picker.dispatchEvent(new Event("change"));
      $("btn-write").click();
      await invoked(shell, "vd_disconnect", 2);
      return shell;
    };
    const line = t().status.canceled + ` — ${t().status.paramsBounded(1)}`;

    // The control: with the re-read answering, the cancel line carries the count.
    await withRecorderRead(false);
    await vi.waitFor(() => expect(statusText()).toBe(line));
    expect(shownLpf()).toBe(lpf.format!(lpf.rawMin!, {}));

    // And with it failing, which is the half that lost the line.
    const shell = await withRecorderRead(true);
    await vi.waitFor(() => expect(statusText()).toBe(line));
    expect(shownLpf()).toBe(lpf.format!(lpf.rawMin!, {}));
    // The dialog is still raised — the read failure is news of its own, not something the
    // restored line stands in for.
    expect(errors(shell)).toContain(t().error.trackCountReread(t().error.shell.deviceLost));
  });

  it("takes what the device confirmed before a cancel, and says so", SLOW, async () => {
    // The cancel lands during the converge's re-read, after this address has answered with the
    // value the write sent. The loop throws and there is no result to read the confirmation
    // off — and this write was the plan's only chance at it, since the value that landed is
    // what stops the address differing: every later diff finds the unit already agreeing.
    const base = deviceCommands({ "plugin:dialog|message": "Ok" }, unitHoldingLowLpf());
    const get = base.vd_get as (a: Record<string, unknown>) => number;
    const set = base.vd_set as (a: Record<string, unknown>) => void;
    let writes = 0;
    const shell = (await bootApp({
      tauri: {
        ...base,
        vd_set: (a: Record<string, unknown>) => {
          writes++;
          return set(a);
        },
        vd_get: (a: Record<string, unknown>) => {
          const value = get(a);
          // A second press is what cancels an in-flight write. Only after a write has gone out,
          // so the diff that builds the confirm prompt runs to the end.
          if (writes > 0 && a.paramId === 685 && a.y === lpf.slot) $("btn-write").click();
          return value;
        },
      },
    }))!;
    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");
    expect(shownLpf()).toBe(lpf.format!(BELOW, {}));

    $("btn-write").click();
    await invoked(shell, "vd_disconnect", 2);
    // The positive control: the write reached the unit and the cancel reached the flow. Without
    // both, "the plan took the value" would be a statement about a write that never ran.
    expect(writes).toBeGreaterThan(0);
    // The line is written in the handler that catches the abort, which runs AFTER the
    // connection is released — so the disconnect this case waited on does not imply it yet.
    await vi.waitFor(() => expect(statusText()).toContain(t().status.canceled));
    expect(shownLpf()).toBe(lpf.format!(lpf.rawMin!, {}));
    expect(statusText()).toContain(t().status.paramsBounded(1));
  });

  /** The insert-FX selector accepts its write and does not keep it, so a second round goes
   *  out, and that one fails with `fail` — which stops the loop before it can re-read. */
  const writeStoppedBySelector = async (fail: string): Promise<void> => {
    //
    // SAVES because a write that fails offers its report — an unstubbed save dialog rejects,
    // and the flow then reports a device failure instead of the partial write it had. The
    // write's own confirm is answered and the retry a STOPPED write offers is declined, or a
    // stub that agrees to everything retries the same refusal for ever; counted from the click
    // rather than from the run, since the fetch below raises a confirm of its own.
    let writing = false;
    let confirms = 0;
    const base = deviceCommands(
      {
        ...SAVES,
        "plugin:dialog|message": (a: Record<string, unknown>) =>
          a.buttons === "OkCancel" && writing && ++confirms > 1 ? "Cancel" : "Ok",
      },
      unitHoldingLowLpf(),
    );
    const set = base.vd_set as (a: Record<string, unknown>) => void;
    // EVERY insert-FX selector, and counted per ADDRESS. Refusing one of the family would let
    // an earlier selector's acknowledgement clear the ledger, which is the other case and would
    // let this one pass without measuring its own; counting across the family instead refuses
    // the second selector of round 1, and the round the confirmations come from never happens.
    const writes = new Map<string, number>();
    let refusals = 0;
    const shell = (await bootApp({
      tauri: {
        ...base,
        vd_set: (a: Record<string, unknown>) => {
          if (a.paramId !== PARAMS.INSERT_FX.id) return set(a);
          const key = `${a.paramId}/${a.x}/${a.y}`;
          const n = (writes.get(key) ?? 0) + 1;
          writes.set(key, n);
          // Accepted and not kept the first time, so it is still differing when the re-read
          // comes round; answered the second, which is what stops the loop. The MESSAGE is the
          // point: `vd.rs` sends before it waits, so only its own refusal code says the write
          // did not land, and a bare failure would be the other case.
          if (n > 1) {
            refusals++;
            throw new Error(`${fail}: ${a.paramId}:${a.x}:${a.y}`);
          }
          return null;
        },
      },
    }))!;
    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");
    expect(shownLpf()).toBe(lpf.format!(BELOW, {}));

    writing = true;
    $("btn-write").click();
    await invoked(shell, "vd_disconnect", 2);
    // The positive control: without a second send there is no failing round, and the pair below
    // would be asserting the ordinary clean-write path under another name.
    expect(refusals).toBeGreaterThan(0);
    // …and the premise that makes this the side-effect case: what failed is a head, whose
    // acknowledgement — and whose unknown answer — empties the ledger.
    expect(PARAMS.INSERT_FX.sideEffect).toBe("converge");
  };

  // A cancel taken in a RETRY throws out of that attempt, and the line the neutral cancel
  // handler would write says nothing about what the attempt before it took back. The count is
  // carried across attempts for that: each attempt adopts different keys, since a key the plan
  // has already taken is no longer a problem the next one reports.
  /** What a retry offer says, whatever numbers it carries — the confirm has to be told apart
   *  from the write's own, and the stub sees only the message. */
  const RETRY_PHRASE = countedHead(t().confirm.writeRetry(0, 0));

  /**
   * A write whose FIRST attempt takes a value back and then stops, with the retry accepted —
   * the transition where a per-attempt count goes missing, since the plan has already taken
   * the key and the next attempt's diff no longer reports it.
   *
   * `insertFx(n)` decides what the nth write to an insert-FX selector does: dropping one and
   * refusing the next is what stops attempt 1 with commands behind it unsent. `onRead` sees
   * every read, with the attempt it belongs to, which is where a case puts its cancel.
   */
  const retryAfterStop = async (
    insertFx: (n: number, attempt: number) => "drop" | "refuse" | "keep",
    onRead?: (attempt: number, wroteThisAttempt: boolean) => void,
    retries = 1,
  ): Promise<TauriShell> => {
    let writing = false;
    let attempt = 1;
    let offers = 0;
    let wroteThisAttempt = false;
    const base = deviceCommands(
      {
        ...SAVES,
        "plugin:dialog|message": (a: Record<string, unknown>) => {
          const retry = a.buttons === "OkCancel" && writing && String(a.message ?? "").includes(RETRY_PHRASE);
          if (!retry) return "Ok";
          if (++offers > retries) return "Cancel";
          attempt++;
          wroteThisAttempt = false;
          return "Ok";
        },
      },
      unitHoldingLowLpf(),
    );
    const set = base.vd_set as (a: Record<string, unknown>) => void;
    const get = base.vd_get as (a: Record<string, unknown>) => number;
    const writes = new Map<string, number>();
    const shell = (await bootApp({
      tauri: {
        ...base,
        vd_get: (a: Record<string, unknown>) => {
          const value = get(a);
          onRead?.(attempt, wroteThisAttempt);
          return value;
        },
        vd_set: (a: Record<string, unknown>) => {
          wroteThisAttempt = true;
          if (a.paramId !== PARAMS.INSERT_FX.id) return set(a);
          const key = `${a.paramId}/${a.x}/${a.y}`;
          const n = (writes.get(key) ?? 0) + 1;
          writes.set(key, n);
          const what = insertFx(n, attempt);
          if (what === "refuse") throw new Error(`broker-rejected: ${a.paramId}:${a.x}:${a.y}`);
          return what === "keep" ? set(a) : null;
        },
      },
    }))!;
    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");
    expect(shownLpf()).toBe(lpf.format!(BELOW, {}));

    writing = true;
    $("btn-write").click();
    await invoked(shell, "vd_disconnect", 2);
    // The positive control every case shares: attempt 1 stopped, so a retry was offered and
    // taken. The other — that the plan took the value back — is asserted per case AFTER its
    // status assertion, since reading the panel selects a node and that writes the line.
    expect(offers).toBeGreaterThan(0);
    return shell;
  };

  const BOUNDED_ONE = ` — ${t().status.paramsBounded(1)}`;

  // The dialog is where an error message is routed, and it can fail to be raised at all — the
  // shell's own command can reject. The status line is then the only surface left, and it has
  // just been cleared for the dialog: the operator would be looking at a run that says nothing
  // failed. Driven at the site that also KEEPS a line, so both halves have to survive.
  it("puts the error on the line when the dialog cannot be raised", SLOW, async () => {
    const seed = unitHoldingLowLpf();
    seed[TRACK_COUNT_SEED] = 8;
    const table = deviceCommands(
      {
        // Confirms still answer; only the error modal fails, which is the shape a broken
        // dialog plugin takes — a stub that rejected both would stop the write at its confirm.
        "plugin:dialog|message": (a: Record<string, unknown>) => {
          if (a.kind === "error") throw new Error("no dialog");
          return "Ok";
        },
      },
      seed,
    );
    const baseGet = table.vd_get as (a: Record<string, unknown>) => number;
    const baseSet = table.vd_set as (a: Record<string, unknown>) => void;
    let written = false;
    table.vd_set = (a: Record<string, unknown>) => {
      written = true;
      return baseSet(a);
    };
    table.vd_get = (a: Record<string, unknown>) => {
      if (written && `${a.paramId}:${a.x}:${a.y}` === TRACK_COUNT_ADDR) throw new Error("device-lost");
      return baseGet(a);
    };
    const shell = (await bootApp({ tauri: table }))!;
    chooseRate(96_000);
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");

    // The positive control: the write went out, so the recorder tail ran and its read failed.
    expect(shell.count("vd_set")).toBeGreaterThan(10);
    const message = t().error.trackCountReread(t().error.shell.deviceLost);
    // The failure in a box of its own, and the line still saying what the write achieved.
    await vi.waitFor(() => expect($("error-box-modal").hidden).toBe(false));
    expect($("error-box-body").textContent).toBe(message);
    expect(countFor(statusText(), t().status.written)).toBeGreaterThan(0);
  });

  // …and it must not do that over a NEWER line. The dialog's rejection arrives whenever the
  // shell gets round to it, and by then the operator may have been told something else — the
  // failure it carries is already logged, while the line on screen is what they are reading.
  it("leaves a line written after the dialog failed alone", SLOW, async () => {
    const seed = unitHoldingLowLpf();
    seed[TRACK_COUNT_SEED] = 8;
    let refuseDialog = (): void => {};
    const table = deviceCommands(
      {
        // Held open, so the case decides WHEN the rejection lands rather than racing it.
        "plugin:dialog|message": (a: Record<string, unknown>) =>
          a.kind === "error" ? new Promise((_, reject) => (refuseDialog = () => reject(new Error("no dialog")))) : "Ok",
      },
      seed,
    );
    const baseGet = table.vd_get as (a: Record<string, unknown>) => number;
    const baseSet = table.vd_set as (a: Record<string, unknown>) => void;
    let written = false;
    table.vd_set = (a: Record<string, unknown>) => {
      written = true;
      return baseSet(a);
    };
    table.vd_get = (a: Record<string, unknown>) => {
      if (written && `${a.paramId}:${a.x}:${a.y}` === TRACK_COUNT_ADDR) throw new Error("device-lost");
      return baseGet(a);
    };
    const shell = (await bootApp({ tauri: table }))!;
    chooseRate(96_000);
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    expect(shell.count("vd_set")).toBeGreaterThan(10);

    // Something newer on the line — holding a node traces its signal path and reports it —
    // and only then does the dialog give up. Waited for by the line CHANGING rather than by
    // the hold's own duration, so the case does not restate a constant the view owns.
    const before = statusText();
    $("graph-host")
      .querySelector<SVGGElement>('g.node[data-id="bus.fx2"]')!
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    await vi.waitFor(() => expect(statusText()).not.toBe(before), { timeout: 10_000 });
    const newer = statusText();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      refuseDialog();
      await vi.waitFor(() => expect(logged).toHaveBeenCalled());
      // Both readable at once, which is the whole reason the failure does not go to the line:
      // the newer thing the operator was told stands, and the failure is in a box of its own.
      expect(statusText()).toBe(newer);
      expect($("error-box-modal").hidden).toBe(false);
      expect($("error-box-body").textContent).toContain(t().error.shell.deviceLost);
    } finally {
      logged.mockRestore();
    }
  });

  // Dropped once, refused once, kept after: attempt 1 stops, attempt 2 converges. This is the
  // transition a per-attempt count cannot survive — attempt 2 takes nothing back, because the
  // plan already holds what attempt 1 took.
  it("still reports what an earlier attempt took back once a retry succeeds", SLOW, async () => {
    await retryAfterStop((n, attempt) => (attempt > 1 ? "keep" : n === 1 ? "drop" : "refuse"));
    await vi.waitFor(() => expect(statusText().endsWith(BOUNDED_ONE)).toBe(true));
    expect(countFor(statusText().replace(BOUNDED_ONE, ""), t().status.written)).toBeGreaterThan(0);
    expect(shownLpf()).toBe(lpf.format!(lpf.rawMin!, {}));
  });

  // …and once it stops again. The second stop reports its own outcome; the count is the
  // operation's, not that attempt's.
  it("still reports it when the retry stops as well", SLOW, async () => {
    await retryAfterStop((n) => (n === 1 ? "drop" : "refuse"));
    await vi.waitFor(() => expect(statusText().endsWith(BOUNDED_ONE)).toBe(true));
    expect(statusText().startsWith(countedHead(t().status.writeStopped(0, 0)))).toBe(true);
    expect(shownLpf()).toBe(lpf.format!(lpf.rawMin!, {}));
  });

  // A cancel inside the retry's CONVERGE — after it has sent something, so the loop is past
  // its seed — which the converge answers with its own line rather than throwing.
  it("still reports it when the retry is cancelled inside its converge", SLOW, async () => {
    await retryAfterStop(
      (n, attempt) => (attempt > 1 ? "keep" : n === 1 ? "drop" : "refuse"),
      (attempt, wroteThisAttempt) => {
        if (attempt > 1 && wroteThisAttempt) $("btn-write").click();
      },
    );
    await vi.waitFor(() => expect(statusText()).toBe(t().status.canceled + BOUNDED_ONE));
    expect(shownLpf()).toBe(lpf.format!(lpf.rawMin!, {}));
  });

  // A cancel in a RETRY that throws out of the attempt — its diff, before anything is sent —
  // which the retry loop answers rather than leaving to the neutral handler.
  it("reports what an earlier attempt took back when a retry is cancelled", SLOW, async () => {
    await retryAfterStop(
      (n, attempt) => (attempt > 1 ? "keep" : n === 1 ? "drop" : "refuse"),
      (attempt, wroteThisAttempt) => {
        if (attempt > 1 && !wroteThisAttempt) $("btn-write").click();
      },
    );
    await vi.waitFor(() => expect(statusText()).toBe(t().status.canceled + BOUNDED_ONE));
    expect(shownLpf()).toBe(lpf.format!(lpf.rawMin!, {}));
  });

  it("takes what earlier rounds confirmed when a later round's send is REFUSED", SLOW, async () => {
    // `broker-rejected` is the shell's own message for an answer that DECLINED the write: it
    // reached the broker and was turned down, so nothing moved — not this address, which round
    // 1 sent and read back, and not the values a head of this kind resets. And there is no
    // later write that would offer it again.
    await writeStoppedBySelector("broker-rejected");
    expect(shownLpf()).toBe(lpf.format!(lpf.rawMin!, {}));
    expect(statusText()).toContain(t().status.paramsBounded(1));
  });

  it("takes nothing when the answer to a later round's send never came", SLOW, async () => {
    // The same arrangement, failing the way a lost link fails. `vd.rs` SENDS before it waits,
    // so the selector may have landed and reset this address on its way out; the plan may take
    // nothing from a write it cannot vouch for.
    await writeStoppedBySelector("device-lost");
    expect(shownLpf()).toBe(lpf.format!(BELOW, {}));
    // The line the write ended on, named before the negative below reads it: a `not` alone is
    // satisfied by any other line, this one included, and by no line at all.
    expect(statusText().startsWith(countedHead(t().status.writeStopped(0, 0)))).toBe(true);
    expect(statusText()).not.toContain(t().status.paramsBounded(1));
  });

  it("takes nothing from a write the device did not keep", SLOW, async () => {
    // The one address under test accepts the write and does not hold it. The converge cannot
    // close on it, the write reports a residual, and the unit's value for that address is then
    // not what was sent — which is the whole reason nothing may be taken from it.
    const shell = await bootDevice(SAVES, true, unitHoldingLowLpf(), (a) => a.paramId === 685 && a.y === lpf.slot);
    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");
    expect(shownLpf()).toBe(lpf.format!(BELOW, {}));

    const sets = shell.count("vd_set");
    $("btn-write").click();
    await invoked(shell, "vd_disconnect", 2);
    // The positive control. Without it the case passes on a write that never happened — with
    // `total === 0` forced, it goes green in a tenth of the time and asserts nothing.
    expect(shell.count("vd_set")).toBeGreaterThan(sets);
    expect(shownLpf()).toBe(lpf.format!(BELOW, {}));
    // The line the write ended on, named rather than denied: a `not` alone is satisfied by any
    // other line and by no line at all. One residual — the single address this case makes the
    // unit decline to keep — and naming the whole line is also what says no bounded note rode
    // along on it, so there is nothing left for a `not` to add.
    expect(statusText()).toBe(t().status.writeResidual(1));
  });

  // Two nodes and two keys on one of them. Every flow case above carries exactly one problem,
  // so neither the per-node loop nor the count is pinned by them: adopting one channel and
  // leaving the other stranded, or reporting 1 where 3 were taken, both pass.
  it("takes every confirmed value, across keys and across channels", SLOW, async () => {
    const hpf = fxParams(1024).find((d) => d.key === "delayHpf")!;
    const revxLpf = fxParams(0).find((d) => d.key === "revxLpf")!;
    const seed = unitHoldingLowLpf();
    seed[`685/0/${hpf.slot}`] = hpf.rawMin! - 1;
    seed[`681/0/${revxLpf.slot}`] = revxLpf.rawMin! - 1;
    const shell = await bootDevice({}, true, seed);
    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");
    expect(shownLpf()).toBe(lpf.format!(BELOW, {}));

    $("btn-write").click();
    await invoked(shell, "vd_disconnect", 2);
    expect(statusText()).toContain(t().status.paramsBounded(3));
    expect(shownLpf()).toBe(lpf.format!(lpf.rawMin!, {}));
    // …and the OTHER channel, which a loop over one node would have left where it was.
    expect(shownFx("bus.fx1", "revxLpf")).toBe(revxLpf.format!(revxLpf.rawMin!, {}));
  });

  // The adoption lands in the history BASELINE rather than as an entry, so an undo taken after
  // it spends the operator's own edit and leaves the adopted value standing. Nothing pinned
  // that: skipping the absorb entirely left all four cases above green.
  it("survives an undo, which spends the operator's edit instead", SLOW, async () => {
    const shell = await bootDevice({}, true, unitHoldingLowLpf());
    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");

    // An ordinary app edit first, so the undo has something of the operator's to spend.
    const before = fxEdit("bus.fx2").value;
    withFxScreen("bus.fx2", (box) => {
      const row = box.querySelector<HTMLInputElement>('input[data-dyn="fx:delayHiRatio"]')!;
      // To an END of its own range rather than by a fixed step, whatever the seed left it at:
      // a step from a value already AT an end is clamped back to where it was — an edit that
      // never happened, which the undo below then has nothing to spend.
      row.value = row.value === row.max ? row.min : row.max;
      row.dispatchEvent(new Event("input", { bubbles: true }));
      row.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(fxEdit("bus.fx2").value).not.toBe(before);

    $("btn-write").click();
    await invoked(shell, "vd_disconnect", 2);
    expect(shownLpf()).toBe(lpf.format!(lpf.rawMin!, {}));

    // The chord goes to the focused range input otherwise (ui/history.ts routes it there).
    (document.activeElement as HTMLElement | null)?.blur();
    shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID);
    await vi.waitFor(() => expect(fxEdit("bus.fx2").value).toBe(before), { timeout: 10_000 });
    // …and the adopted value is still there: the undo did not hand the unwritable raw back.
    expect(shownLpf()).toBe(lpf.format!(lpf.rawMin!, {}));
  });

  it("takes it from a live flush that carried the address", SLOW, async () => {
    const shell = await bootDevice({}, true, unitHoldingLowLpf());
    $("btn-live").click();
    await vi.waitFor(() => expect(shell.count("vd_params_subscribe")).toBe(1), { timeout: 20_000 });
    // A session on its own sends nothing, and NOT because the snapshot carries the unwritable
    // raw: `capture` fills it from `planToCommands`, so it holds the NORMALISED value while the
    // unit holds the raw. Nothing is sent because plan-normalised equals snapshot-normalised.
    // What sends the plan's own copy of this address is the undo of an edit to it: the LPF moved
    // to a value the app can write and sent, then the undo puts the raw it read back, and that
    // flush carries it.
    expect(shownLpf()).toBe(lpf.format!(BELOW, {}));
    withFxScreen("bus.fx2", (box) => {
      const row = box.querySelector<HTMLInputElement>('input[data-dyn="fx:delayLpf"]')!;
      row.value = row.max;
      row.dispatchEvent(new Event("input", { bubbles: true }));
      row.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(() => expect(shownLpf()).toBe(lpf.format!(lpf.rawMax!, {})), { timeout: 10_000 });
    await quiet(shell);
    undoEdit(shell);

    await vi.waitFor(() => expect(shownLpf()).toBe(lpf.format!(lpf.rawMin!, {})), { timeout: 20_000 });
    // …and the operator is told, on the line that reports the read which took the value back.
    expect(statusText()).toContain(t().status.paramsBounded(1));
  });

  // The reproduction the first version of this failed. An edit somewhere else flushes, the
  // flush succeeds, and this address is not in it — the snapshot holds the normalised value the
  // emit produces, so there is no diff to send. Keyed on the run's success rather than on the
  // addresses it carried, the plan took a value nothing had written.
  it("takes nothing from a live flush that did not carry the address", SLOW, async () => {
    const shell = await bootDevice({}, true, unitHoldingLowLpf());
    $("btn-live").click();
    await vi.waitFor(() => expect(shell.count("vd_params_subscribe")).toBe(1), { timeout: 20_000 });
    expect(shownLpf()).toBe(lpf.format!(BELOW, {}));

    // An unrelated control on an unrelated node, driven the way the operator drives it.
    const sets = shell.count("vd_set");
    pressNode("bus.stereo");
    const fader = paramRow(t().inspector.level).querySelector<HTMLInputElement>("input[type=range]")!;
    fader.value = String(Number(fader.value) - 3);
    fader.dispatchEvent(new Event("input", { bubbles: true }));
    fader.dispatchEvent(new Event("change", { bubbles: true }));

    // The flush happened — without this the case would pass on nothing having been sent at all.
    await vi.waitFor(() => expect(shell.count("vd_set")).toBeGreaterThan(sets), { timeout: 20_000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(shownLpf()).toBe(lpf.format!(BELOW, {}));
  });

  // A session that ENDS on a failed converge after that converge confirmed the address. The
  // count is held for the line the flush writes once it has sent, and that line never comes;
  // the next session's first flush must not print it as its own.
  it("leaves a failed session's taken-back count behind with that session", SLOW, async () => {
    // Once the undo is armed, the FX 2 type selector is accepted and not kept twice — by the
    // flush's head write and by the converge's first round — and refused on the third, which is
    // the converge's second round: the LPF is confirmed by the first round's re-read, then the
    // loop fails.
    let typeWrites = 0;
    let armed = false;
    const base = deviceCommands({ "plugin:dialog|message": "Ok" }, unitHoldingLowLpf());
    const set = base.vd_set as (a: Record<string, unknown>) => void;
    const shell = (await bootApp({
      tauri: {
        ...base,
        vd_set: (a: Record<string, unknown>) => {
          if (a.paramId !== 683 || !armed) return set(a);
          if (++typeWrites > 2) throw new Error(`broker-rejected: ${a.paramId}:${a.x}:${a.y}`);
          return null;
        },
      },
    }))!;
    $("btn-live").click();
    await vi.waitFor(() => expect(shell.count("vd_params_subscribe")).toBe(1), { timeout: 20_000 });
    expect(shownLpf()).toBe(lpf.format!(BELOW, {}));
    pickFxType("bus.fx2", 1025);
    await quiet(shell);
    armed = true;
    undoEdit(shell);
    // The session ended on the refusal, and the converge had taken the value back first.
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("false"), { timeout: 20_000 });
    expect(typeWrites).toBe(3);
    await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 20_000 });
    expect(shownLpf()).toBe(lpf.format!(lpf.rawMin!, {}));

    // The next session, and an unrelated edit in it.
    await vi.waitFor(() => expect($<HTMLSelectElement>("rate-picker").disabled).toBe(false), { timeout: 20_000 });
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 20_000 });
    const sets = shell.count("vd_set");
    pressNode("bus.stereo");
    const fader = paramRow(t().inspector.level).querySelector<HTMLInputElement>("input[type=range]")!;
    fader.value = String(Number(fader.value) - 3);
    fader.dispatchEvent(new Event("input", { bubbles: true }));
    fader.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(shell.count("vd_set")).toBeGreaterThan(sets), { timeout: 20_000 });
    // The line that flush wrote is its own count and nothing else.
    await vi.waitFor(() => expect(countFor(statusText(), t().status.liveSynced)).toBeGreaterThan(0), {
      timeout: 20_000,
    });
    expect(statusText()).not.toContain(t().status.paramsBounded(1));
  });

  // …and the same, with a flush whose converge DID confirm a set — just not this address. The
  // case above cannot separate "the set does not carry it" from "there is no set", because a
  // plain fader flush runs no converge and the set is empty. An effect-type change on the OTHER
  // channel converges its own slots and leaves this one alone.
  it("takes nothing from a flush whose confirmed addresses are another channel's", SLOW, async () => {
    const shell = await bootDevice({}, true, unitHoldingLowLpf());
    $("btn-live").click();
    await vi.waitFor(() => expect(shell.count("vd_params_subscribe")).toBe(1), { timeout: 20_000 });
    expect(shownLpf()).toBe(lpf.format!(BELOW, {}));

    const sets = shell.count("vd_set");
    pressNode("bus.fx1");
    const sel = paramRow(t().inspector.fxEffect.effectType).querySelector("select")!;
    sel.value = "1";
    sel.dispatchEvent(new Event("input", { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(shell.count("vd_set")).toBeGreaterThan(sets), { timeout: 20_000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(shownLpf()).toBe(lpf.format!(BELOW, {}));
  });
});
