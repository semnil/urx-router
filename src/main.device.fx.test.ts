// @vitest-environment jsdom

// An FX channel's EFFECT TYPE and delay time while a session is live.
//
// The setup, the teardown and the helpers every desktop case shares are `main.device.test-util.ts`'s,
// which also states what the device table does and does not model.

import { describe, expect, it, vi } from "vitest";
import { $, bootApp, deviceCommands } from "./main.test-util";
import type { TauriShell } from "./main.test-util";
import { fxEffectTypes, fxParams } from "./core/control/fx-effect";
import { COMP_EQ_SSMCS, INSERT_FX_NONE, PARAMS } from "./core/control/params";
import { SETTLE_TIMEOUT_MS } from "./core/control/settle";
import { insertFxControl } from "./core/control/translate";
import { getModel } from "./models";
import { t } from "./i18n";
import {
  SLOW,
  bootDevice,
  live,
  pressNode,
  paramRow,
  insertFxSection,
  pickInsertFx,
  insertFxOnFace,
  pickFxType,
  undoEdit,
  quiet,
  flowInvokes,
} from "./main.device.test-util";

// The park in front of an EFFECT TYPE write.
//
// The FX effect arrays announce nothing when the unit's own panel moves them, so a value
// tuned there is one the plan has never seen — and the type write is the one command that
// replaces slots nobody named: the unit refills the array with the incoming type's factory
// values, and the writer puts the plan straight back over that. Without a read in front of
// it, what goes back is the app's stale copy, and nothing on screen knows.
//
// The read sits at the WRITE boundary (`live.ts`, in front of the head writes a flush is
// about to send), not at the control that moved the type — so these cases drive the two
// selectors, an undo of one, and the insert-FX selector, and all four are answered by it.
//
// Both halves are driven, because either alone passes for the wrong reason: "the read
// happened" is satisfied by the session's own opening readback, and "the unit ends at the
// tuned value" is satisfied by an app that wrote nothing to that address at all.

describe("an EFFECT TYPE change while a session is live", () => {
  const HPF = fxParams(0).find((d) => d.key === "revxHpf")!;
  /** Inside the window, and not the factory value — so a write carrying it can only have
   *  come from the unit, and one carrying `HPF.def` can only have come from the plan. */
  const TUNED = 30;
  const FX1_TYPE = "679:0:0";
  const FX1_HPF = `681:0:${HPF.slot}`;
  const REVX_HALL = 0;
  const REVX_ROOM = 1;
  /** The cross-family step. Its parameter layout shares no key with Rev-X, so an array read
   *  against it files every value under a key the Rev-X emit does not read. */
  const MONO_DELAY = fxEffectTypes(0).find((o) => o.family === "delay")!.value;
  const at = (a: Record<string, unknown> | undefined): string => `${a?.paramId}:${a?.x}:${a?.y}`;

  /** FX1 on Rev-X Hall with its factory array, and a rate to read. Seeded from the
   *  catalogue rather than by hand: a slot the table has not been told about reads 0,
   *  and 0 is a legal Rev-X raw, so a partial seed would make the unit hold values nobody
   *  chose. */
  const unitOnRevxHall = (): Record<string, number> => {
    const seed: Record<string, number> = { [`${PARAMS.SAMPLE_RATE.id}/0/0`]: 48_000 };
    seed["679/0/0"] = 0;
    for (const d of fxParams(0)) seed[`681/0/${d.slot}`] = d.def;
    return seed;
  };

  /**
   * A stub whose FX1 HPF can be moved the way the unit's own panel moves it: the value
   * stands until the app WRITES that address, after which the table's own map answers
   * again. Modelled that way rather than as a constant, because a constant answer would
   * keep reading back as the tuned value however the app behaved — which is exactly the
   * question.
   *
   * `refillsOnType` adds the other half of what the unit does: a selector write refills
   * the whole engine array. Off by default, and the cases that leave it off say what they
   * therefore cannot measure — with it on, an address the app reads AFTER the type write
   * answers a value the operator never chose, which is what the head-node exclusion is for.
   */
  const stubWithPanel = (
    opts: { refillsOnType?: number } = {},
  ): {
    table: Record<string, unknown>;
    move: (raw: number) => void;
    refuse: (addrPrefix: string) => void;
  } => {
    const table = deviceCommands({ "plugin:dialog|message": "Ok" }, unitOnRevxHall());
    const baseGet = table.vd_get as (a: Record<string, unknown>) => number;
    const baseSet = table.vd_set as (a: Record<string, unknown>) => void;
    let panel: number | null = null;
    let refused: string | null = null;
    table.vd_get = (a: Record<string, unknown>) => {
      if (refused !== null && at(a).startsWith(refused)) throw new Error("device-lost");
      return panel !== null && at(a) === FX1_HPF ? panel : baseGet(a);
    };
    table.vd_set = (a: Record<string, unknown>) => {
      if (at(a) === FX1_HPF) panel = null;
      const out = baseSet(a);
      if (opts.refillsOnType !== undefined && at(a) === FX1_TYPE) {
        panel = null;
        for (const d of fxParams(0)) baseSet({ paramId: 681, x: 0, y: d.slot, value: opts.refillsOnType });
      }
      return out;
    };
    return { table, move: (raw) => (panel = raw), refuse: (addrPrefix) => (refused = addrPrefix) };
  };

  /** The EFFECT TYPE the selector is showing — the plan as the Inspector draws it. */
  const shownType = (): number => {
    pressNode("bus.fx1");
    return Number(paramRow(t().inspector.fxEffect.effectType).querySelector<HTMLSelectElement>("select")!.value);
  };

  const pickType = (value: number): void => pickFxType("bus.fx1", value);

  /** Choose each of `types` for FX 1 in turn, each left to land, so the undos that follow walk
   *  back through them to Rev-X Hall. An undo re-types the channel from the plan's own copy of
   *  its parameters, which no choice does: every surface puts the incoming type's factory
   *  values in. */
  const armUndos = async (shell: TauriShell, ...types: number[]): Promise<void> => {
    for (const type of types) {
      pickType(type);
      await vi.waitFor(() => expect(shownType()).toBe(type), { timeout: 25_000 });
      await settled(shell);
    }
  };

  /** The HPF as the FX EFFECT screen prints it — read off the surface, and reopened per
   *  reading so each one is a fresh draw of the plan as it stands. */
  const shownHpf = (): string => {
    pressNode("bus.fx1");
    $<HTMLButtonElement>("btn-fx-screen").click();
    const box = $("dyn-screen-box");
    const out = box.querySelector<HTMLElement>('[data-dyn-val="fx:revxHpf"]')?.textContent ?? "";
    box.querySelector<HTMLButtonElement>(".consent-actions button")!.click();
    return out;
  };

  // What this tier does NOT model is the unit refilling the array when the selector is
  // typed (`main.test-util.ts` keeps what is written and nothing else), so the value going
  // back OUT is not measurable here — that is `pushFxEffectCommands` emitting from the
  // plan, which the translate suites pin. What IS measurable, and is the whole of the park,
  // is that the outgoing array reaches the plan before the selector reaches the unit.
  it("reads the outgoing array into the plan before the selector goes out", SLOW, async () => {
    const { table, move } = stubWithPanel();
    const shell = (await bootApp({ tauri: table }))!;
    $("btn-live").click();
    await vi.waitFor(() => expect(shell.count("vd_params_subscribe")).toBe(1), { timeout: 20_000 });
    // The premise: the session read the factory array, and that is what the app is showing.
    expect(shownHpf()).toBe(HPF.format!(HPF.def, {}));

    // The hand on the unit, after that readback: the app has no way to hear this — the
    // effect arrays announce nothing when the front panel moves them.
    await armUndos(shell, REVX_ROOM);
    move(TUNED);
    const gesture = shell.invokes.length;
    undoEdit(shell);

    // Waited on the WRITE, not on the readout: the read lands a flush window ahead of the
    // selector, so a wait that ends at the plan returns with nothing having gone out yet.
    const typeSent = (): number =>
      shell.invokes.findIndex((cmd, i) => cmd === "vd_set" && at(shell.args[i]) === FX1_TYPE && i >= gesture);
    await vi.waitFor(() => expect(typeSent()).toBeGreaterThan(-1), { timeout: 20_000 });
    // The unit's own value is what the app is holding now, and it is what the emit draws
    // from — the plan is the writer's only source for this slot.
    expect(shownHpf()).toBe(HPF.format!(TUNED, {}));

    const typeAt = typeSent();
    // The positive control: the type really went out, so what is asserted about the order
    // is asserted about a write that happened.
    expect(typeAt, "the type write went out").toBeGreaterThan(-1);
    expect(shell.args[typeAt]?.value).toBe(REVX_HALL);
    // …and the read is IN FRONT of it, which is the claim: afterwards the unit's array
    // holds the incoming type's factory values and there is nothing left to read.
    const parkAt = shell.invokes.findIndex(
      (cmd, i) => cmd === "vd_get" && at(shell.args[i]) === FX1_HPF && i >= gesture,
    );
    expect(parkAt, "the park read the outgoing array").toBeGreaterThan(-1);
    expect(parkAt).toBeLessThan(typeAt);
  });

  // Two EFFECT TYPE selections inside one flush window, the second made while the first is
  // still on the link. Only the last one goes out — the window coalesces them — so the unit
  // is still holding the OUTGOING effect when the second park reads its array, while the
  // plan already holds the type nobody has sent. Read against that one, a Rev-X array
  // decodes as a delay: every value lands under a delay's key, the Rev-X keys go with it,
  // and the emit behind the second selection has the incoming type's factory values to send
  // in their place.
  // Picking the type a channel already holds is no change: the unit refills nothing for it, so a
  // tuned effect stays as it is — and the CONSOLE's list still opens the screen, which is what a
  // press there is for. A different type from the same list is the positive control.
  it("leaves a tuned effect alone when the CONSOLE's list picks the type the channel holds", SLOW, async () => {
    const shell = await bootDevice({}, true, { ...unitOnRevxHall(), [`681/0/${HPF.slot}`]: TUNED });
    $("btn-live").click();
    await vi.waitFor(() => expect(shell.count("vd_params_subscribe")).toBe(1), { timeout: 20_000 });
    expect(shownHpf(), "the premise: the unit's tuned HPF").toBe(HPF.format!(TUNED, {}));
    const fromConsole = (type: number): void => {
      $("btn-view-console").click();
      const face = [...$("console-host").querySelectorAll<HTMLElement>(".con-strip")].find((st) =>
        st.querySelector(".con-head")?.textContent?.includes("FX 1"),
      )!;
      face.querySelector<HTMLElement>(".con-fxopen")!.click();
      document.querySelector<HTMLElement>(`[data-ctl="fx:${type}"]`)!.click();
      expect($("dyn-screen-modal").hidden, "the screen opens on the pick").toBe(false);
      $("dyn-screen-box").querySelector<HTMLButtonElement>(".consent-actions button")!.click();
      $("btn-view-graph").click();
    };
    const arrayWrites = (from: number): number =>
      shell.invokes.filter(
        (cmd, i) => cmd === "vd_set" && i >= from && [679, 681].includes(Number(shell.args[i]?.paramId)),
      ).length;

    const gesture = shell.invokes.length;
    fromConsole(REVX_HALL);
    await settled(shell);
    expect(arrayWrites(gesture), "nothing sent for the type it already holds").toBe(0);
    expect(shownHpf()).toBe(HPF.format!(TUNED, {}));

    const other = shell.invokes.length;
    fromConsole(REVX_ROOM);
    await vi.waitFor(() => expect(arrayWrites(other)).toBeGreaterThan(0), { timeout: 20_000 });
    expect(shownType()).toBe(REVX_ROOM);
  });

  it("reads the array against the type the unit holds, not the one the plan is waiting to send", SLOW, async () => {
    const PING_PONG = fxEffectTypes(0).filter((o) => o.family === "delay")[1]!.value;
    const REFILLED = 55;
    expect(REFILLED, "distinguishable from both the plan's copy and the unit's").not.toBe(TUNED);
    const { table, move } = stubWithPanel({ refillsOnType: REFILLED });
    const baseGet = table.vd_get as (a: Record<string, unknown>) => number;
    let open: (() => void) | null = null;
    let gate: Promise<void> | null = null;
    // The first park held open on the link, so the second selection is made at a point this
    // case chooses rather than wherever the flush window happens to fall.
    table.vd_get = async (a: Record<string, unknown>) => {
      if (gate) await gate;
      return baseGet(a);
    };
    const shell = (await bootApp({ tauri: table }))!;
    $("btn-live").click();
    await vi.waitFor(() => expect(shell.count("vd_params_subscribe")).toBe(1), { timeout: 20_000 });
    expect(shownHpf()).toBe(HPF.format!(HPF.def, {}));

    // The hand on the unit, which announces nothing — then the first selection, held at its
    // own first read, and the second made while that read waits.
    move(TUNED);
    const gesture = shell.invokes.length;
    gate = new Promise<void>((r) => (open = r));
    pickType(MONO_DELAY);
    await vi.waitFor(
      () =>
        expect(shell.invokes.some((cmd, i) => cmd === "vd_get" && at(shell.args[i]) === FX1_TYPE && i >= gesture)).toBe(
          true,
        ),
      { timeout: 20_000 },
    );
    pickType(PING_PONG);
    gate = null;
    open!();
    await vi.waitFor(() => expect(shownType()).toBe(PING_PONG), { timeout: 25_000 });
    await settled(shell);

    const sentTo = (addr: string): unknown[] =>
      shell.invokes.flatMap((cmd, i) =>
        cmd === "vd_set" && at(shell.args[i]) === addr && i >= gesture ? [shell.args[i]?.value] : [],
      );
    // The premise, asserted rather than assumed: the window coalesced the two selections, so
    // every park read the Rev-X array the operator tuned, while the plan held a delay.
    expect(sentTo(FX1_TYPE), "only the last selection went out").toEqual([PING_PONG]);
    // Read against the unit's Rev-X, the panel's value went under the Rev-X HPF; read against
    // the plan's unsent delay it would have gone under a delay's key, leaving the plan's own
    // copy standing. Back on Rev-X Hall — the two selections are one entry, made with no
    // boundary between them — the plan shows which.
    undoEdit(shell);
    await vi.waitFor(() => expect(shownType()).toBe(REVX_HALL), { timeout: 25_000 });
    await settled(shell);
    expect(shownHpf()).toBe(HPF.format!(TUNED, {}));
  });

  // The Inspector's selector puts the incoming type's factory values in the plan, which is what
  // the unit holds once the type write refills the array — so the park in front of that write
  // reads the outgoing array and leaves those keys standing, and a value the panel moved for the
  // outgoing type does not go out with the incoming one.
  it("leaves the defaults an Inspector selection took standing over the outgoing array", SLOW, async () => {
    const roomHpf = fxParams(REVX_ROOM).find((d) => d.key === HPF.key)!.def;
    expect(roomHpf, "the premise: the panel's value is not the incoming default").not.toBe(TUNED);
    const { table, move } = stubWithPanel({ refillsOnType: roomHpf });
    const shell = (await bootApp({ tauri: table }))!;
    $("btn-live").click();
    await vi.waitFor(() => expect(shell.count("vd_params_subscribe")).toBe(1), { timeout: 20_000 });

    move(TUNED);
    const gesture = shell.invokes.length;
    pickType(REVX_ROOM);
    const after = (cmd: string, addr: string): number[] =>
      shell.invokes.flatMap((c, i) => (c === cmd && at(shell.args[i]) === addr && i >= gesture ? [i] : []));
    await vi.waitFor(() => expect(after("vd_set", FX1_TYPE).length).toBeGreaterThan(0), { timeout: 20_000 });
    await quiet(shell);

    // The positive control: the park did read the outgoing array, ahead of the type write.
    const parkAt = after("vd_get", FX1_HPF)[0];
    expect(parkAt, "the park read the outgoing array").toBeDefined();
    expect(parkAt).toBeLessThan(after("vd_set", FX1_TYPE)[0]);
    const sent = after("vd_set", FX1_HPF).map((i) => shell.args[i]?.value);
    expect(sent, "the panel's value for the outgoing type never went out").not.toContain(TUNED);
    expect(shownHpf()).toBe(HPF.format!(roomHpf, {}));
  });

  // Selections that coalesce back to the type the unit holds send no type write, so no refill
  // follows and nothing is left for the record to protect: a later park — here the converge's,
  // behind another channel's COMP/EQ Type — takes what the unit's panel moved.
  it("keeps no reseed past selections that come back to the unit's type", SLOW, async () => {
    const { table, move } = stubWithPanel();
    const shell = (await bootApp({ tauri: table }))!;
    $("btn-live").click();
    await vi.waitFor(() => expect(shell.count("vd_params_subscribe")).toBe(1), { timeout: 20_000 });
    expect(shownType()).toBe(REVX_HALL);

    pickType(REVX_ROOM);
    pickType(REVX_HALL);
    await quiet(shell);
    const typeWrites = shell.invokes.flatMap((c, i) => (c === "vd_set" && at(shell.args[i]) === FX1_TYPE ? [i] : []));
    expect(typeWrites, "the premise: the two selections sent no type").toEqual([]);

    move(TUNED);
    const gesture = shell.invokes.length;
    pressNode("ch1");
    const type = paramRow(t().inspector.compEqType).querySelector<HTMLSelectElement>("select")!;
    type.value = String(COMP_EQ_SSMCS);
    type.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(shell.count("vd_set")).toBeGreaterThan(0), { timeout: 25_000 });
    await settled(shell);

    expect(
      shell.invokes.some((c, i) => c === "vd_get" && at(shell.args[i]) === FX1_HPF && i >= gesture),
      "the positive control: a later park read the moved slot",
    ).toBe(true);
    const sent = shell.invokes.flatMap((c, i) =>
      c === "vd_set" && at(shell.args[i]) === FX1_HPF && i >= gesture ? [shell.args[i]?.value] : [],
    );
    expect(sent, "the plan's old default was not sent over the panel's value").not.toContain(HPF.def);
    expect(shownHpf()).toBe(HPF.format!(TUNED, {}));
  });

  /** Wait for the app's traffic on the link to stop (`flowInvokes`) — a converge is hundreds
   *  of reads through the stub, and every assertion below is about where it ended up rather
   *  than when. The quiet window is longer than `SETTLE_TIMEOUT_MS`: a converge round waits
   *  out that bound before its seed read, and a shorter window ends inside the wait. */
  const settled = async (shell: TauriShell): Promise<void> => {
    let quiet = 0;
    let last = -1;
    await vi.waitFor(
      () => {
        const now = flowInvokes(shell);
        quiet = now === last ? quiet + 1 : 0;
        last = now;
        if (quiet * 50 < SETTLE_TIMEOUT_MS * 3) throw new Error(`still talking (${now})`);
      },
      { timeout: 30_000, interval: 50 },
    );
  };

  // The general form of the same park: a converge re-sends whatever differs across the
  // WHOLE write scope, so a head on any node at all is what puts the plan's copy of the
  // silent families back on the unit. Nothing in this gesture names the FX channel.
  it("keeps a silently moved value through a converge another node fired", SLOW, async () => {
    const { table, move } = stubWithPanel();
    const shell = (await bootApp({ tauri: table }))!;
    $("btn-live").click();
    await vi.waitFor(() => expect(shell.count("vd_params_subscribe")).toBe(1), { timeout: 20_000 });
    expect(shownHpf()).toBe(HPF.format!(HPF.def, {}));

    // The hand on the unit, which announces nothing…
    move(TUNED);
    const gesture = shell.invokes.length;
    // …and then a converge head on CH 1. What it resets is that channel's own bank.
    pressNode("ch1");
    const type = paramRow(t().inspector.compEqType).querySelector<HTMLSelectElement>("select")!;
    type.value = String(COMP_EQ_SSMCS);
    type.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(shell.count("vd_set")).toBeGreaterThan(0), { timeout: 25_000 });
    await settled(shell);

    // The park read the array in front of the converge, so the plan holds what the operator
    // tuned rather than the copy it was carrying.
    expect(shownHpf()).toBe(HPF.format!(TUNED, {}));
    // The positive control: the converge really ran over this scope, so the write below is
    // one it would have made.
    expect(
      shell.invokes.some((cmd, i) => cmd === "vd_get" && at(shell.args[i]) === FX1_HPF && i >= gesture),
      "the converge's scope reached the FX array",
    ).toBe(true);
    expect(
      shell.invokes.some(
        (cmd, i) =>
          cmd === "vd_set" && at(shell.args[i]) === FX1_HPF && shell.args[i]?.value === HPF.def && i >= gesture,
      ),
      "no stale array value went back out",
    ).toBe(false);
  });

  // The other side of the exclusion. The type write makes the unit refill FX1's array, and
  // the converge behind it is what puts the plan's values back — so a park that read that
  // node would adopt the refill and the restore would never go out.
  it("leaves the head node's own refilled array to the converge", SLOW, async () => {
    const REFILLED = 55;
    expect(REFILLED, "distinguishable from both the plan's copy and the unit's").not.toBe(TUNED);
    const { table, move } = stubWithPanel({ refillsOnType: REFILLED });
    const shell = (await bootApp({ tauri: table }))!;
    $("btn-live").click();
    await vi.waitFor(() => expect(shell.count("vd_params_subscribe")).toBe(1), { timeout: 20_000 });

    await armUndos(shell, REVX_ROOM);
    move(TUNED);
    const gesture = shell.invokes.length;
    undoEdit(shell);
    await vi.waitFor(
      () =>
        expect(shell.invokes.some((cmd, i) => cmd === "vd_set" && at(shell.args[i]) === FX1_TYPE && i >= gesture)).toBe(
          true,
        ),
      { timeout: 25_000 },
    );

    // The converge puts the plan's value back on the unit, and that write is what says the
    // park left this node alone: had it read here, the plan would be holding the refill and
    // there would be nothing left to restore.
    await vi.waitFor(
      () =>
        expect(
          shell.invokes.some(
            (cmd, i) =>
              cmd === "vd_set" && at(shell.args[i]) === FX1_HPF && shell.args[i]?.value === TUNED && i >= gesture,
          ),
          "the converge restored the array",
        ).toBe(true),
      { timeout: 30_000 },
    );
    // …and what the app holds is the operator's value throughout: the park in front of the
    // type write took it, and the park in front of the converge left this node alone.
    expect(shownHpf()).toBe(HPF.format!(TUNED, {}));
  });

  // The same abort on the converge side, and the reason the completeness check runs in
  // front of the empty-patch exit: a node the read could not reach contributes no patch, so
  // an incomplete read otherwise looks exactly like one that found nothing to change.
  it("stops the session when the converge's park cannot read a node", SLOW, async () => {
    const { table, refuse } = stubWithPanel();
    const shell = (await bootApp({ tauri: table }))!;
    $("btn-live").click();
    await vi.waitFor(() => expect(shell.count("vd_params_subscribe")).toBe(1), { timeout: 20_000 });

    // FX2's array alone, so what ends the flush is the park's own completeness check rather
    // than a link that stopped answering anything.
    refuse("685:");
    const gesture = shell.invokes.length;
    pressNode("ch1");
    const type = paramRow(t().inspector.compEqType).querySelector<HTMLSelectElement>("select")!;
    type.value = String(COMP_EQ_SSMCS);
    type.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("false"), { timeout: 25_000 });
    // The positive control: the park ran and reached the nodes it could, so the refusal is
    // what stopped it rather than a flush that never got there.
    expect(
      shell.invokes.some((cmd, i) => cmd === "vd_get" && at(shell.args[i]).startsWith("681:") && i >= gesture),
      "the park read the node it could reach",
    ).toBe(true);
    // A.Gain is in the converge's write scope and in no park (readback.test.ts pins that),
    // so a read of it is the converge having started.
    expect(
      shell.invokes.some((cmd, i) => cmd === "vd_get" && shell.args[i]?.paramId === PARAMS.HA_GAIN.id && i >= gesture),
      "no converge round read the write scope",
    ).toBe(false);
  });

  // An edit the operator has already made and the flush has not carried yet. A converge's
  // park runs after that flush's own writes, so an edit made while they were in flight is
  // still only in the plan when the park reads its address — and reading it brings back the
  // value the edit was made against. What keeps it is the guard both parks read through:
  // where the unit still holds what this session last sent, the read answers with the plan's
  // own value, and this edit has not been sent. Asked of the insert-FX bypass, the one
  // address a park reads that no head lays out.
  it("keeps an edit the flush has not carried yet", SLOW, async () => {
    const { table } = stubWithPanel();
    const baseSet = table.vd_set as (a: Record<string, unknown>) => unknown;
    let during: (() => void) | null = null;
    table.vd_set = (a: Record<string, unknown>) => {
      const out = baseSet(a);
      if (during !== null && a.paramId === PARAMS.COMP_EQ_TYPE.id) {
        const gesture = during;
        during = null;
        gesture();
      }
      return out;
    };
    const shell = (await bootApp({ tauri: table }))!;
    $("btn-live").click();
    await vi.waitFor(() => expect(shell.count("vd_params_subscribe")).toBe(1), { timeout: 20_000 });

    // The premise: CH 3 holds an effect, engaged, and the unit holds it too.
    pressNode("ch3");
    const effect = [...insertFxSection()!.querySelector("select")!.options]
      .map((o) => Number(o.value))
      .find((v) => v !== INSERT_FX_NONE)!;
    pickInsertFx(effect);
    await settled(shell);
    pressNode("ch3");
    expect(insertFxOnFace(), "the premise: the effect is engaged").toBe("ON");

    // The bypass goes OFF while a COMP/EQ head's flush is writing — after that flush took its
    // commands, before its converge parks.
    const ifx = insertFxControl(getModel("URX44V"), "ch3")!;
    const bypassAt = `${ifx.onParam}:0:${ifx.instances[0]}`;
    let gestureAt = -1;
    during = () => {
      gestureAt = shell.invokes.length;
      pressNode("ch3");
      [...insertFxSection()!.querySelectorAll<HTMLButtonElement>(".toggle button")]
        .find((b) => b.textContent === "OFF")!
        .click();
    };
    pressNode("ch1");
    const compEq = paramRow(t().inspector.compEqType).querySelector<HTMLSelectElement>("select")!;
    compEq.value = String(COMP_EQ_SSMCS);
    compEq.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(during).toBeNull(), { timeout: 20_000 });
    await settled(shell);

    // The positive control: the park did read the bypass after the edit, so what is asserted
    // below is the guard's answer rather than a read that never happened.
    expect(
      shell.invokes.some((cmd, i) => cmd === "vd_get" && at(shell.args[i]) === bypassAt && i > gestureAt),
      "the park read the bypass",
    ).toBe(true);
    // Read back off the panel: what the park merged into the plan is what a rebuild draws…
    pressNode("ch3");
    expect(insertFxOnFace(), "the operator's own edit, not the value it was made against").toBe("OFF");
    // …and what the next flush sends.
    const writes = shell.invokes.flatMap((cmd, i) =>
      cmd === "vd_set" && at(shell.args[i]) === bypassAt && i > gestureAt ? [shell.args[i]!.value] : [],
    );
    expect(writes.at(-1), "the edit reached the unit").toBe(0);
  });

  // The gesture outlives the wait. A park held for a converge can have the session end under
  // it, and what is left is the case the browser build is always in: nothing to read, and
  // nothing the write can damage. Losing the selection there would make a disconnect at the
  // wrong moment look like a selector that does not work.
  it("keeps the selection when the session ends before the flush carries it", SLOW, async () => {
    const { table } = stubWithPanel();
    const shell = (await bootApp({ tauri: table }))!;
    $("btn-live").click();
    await vi.waitFor(() => expect(shell.count("vd_params_subscribe")).toBe(1), { timeout: 20_000 });
    expect(shownType(), "the premise: the factory type").toBe(REVX_HALL);

    // A converge on another node, so the FX park below waits for it rather than reading.
    pressNode("ch1");
    const compEq = paramRow(t().inspector.compEqType).querySelector<HTMLSelectElement>("select")!;
    compEq.value = String(COMP_EQ_SSMCS);
    compEq.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(shell.count("vd_set")).toBeGreaterThan(0), { timeout: 20_000 });

    const gesture = shell.invokes.length;
    pickType(REVX_ROOM);
    $("btn-live").click(); // the session goes, before the flush that would carry it
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).not.toBe("true"), { timeout: 20_000 });
    await settled(shell);

    // The selection is a plan edit, so it stands whatever the link does — losing it at a
    // disconnect would make the selector look like a control that does not work.
    expect(shownType(), "the operator's selection, kept").toBe(REVX_ROOM);
    // …and it never reached the unit, which is what the plan holding it now means: the next
    // session's own readback is what settles the two.
    expect(
      shell.invokes.some((cmd, i) => cmd === "vd_set" && at(shell.args[i]) === FX1_TYPE && i >= gesture),
      "and no type went out over a session that was ending",
    ).toBe(false);
  });

  // The abort rule (architecture.md, "Aborting on failure") at the one place where carrying
  // on is the destructive option: a park that could not read cannot promise the outgoing
  // values are in the plan, and the write behind it is what would replace them.
  it("does not write the type when the park cannot read", SLOW, async () => {
    const { table } = stubWithPanel();
    const shell = (await bootApp({ tauri: table }))!;
    $("btn-live").click();
    await vi.waitFor(() => expect(shell.count("vd_params_subscribe")).toBe(1), { timeout: 20_000 });

    const gesture = shell.invokes.length;
    shell.answer("vd_get", () => {
      throw new Error("device-lost");
    });
    pickType(REVX_ROOM);

    // The session goes down, which is the signal the read failed at all.
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("false"), { timeout: 20_000 });
    expect(
      shell.invokes.some((cmd, i) => cmd === "vd_set" && at(shell.args[i]) === FX1_TYPE && i >= gesture),
      "no type reached the unit",
    ).toBe(false);
    // The plan keeps what the operator chose: the read that failed is what stops the WRITE,
    // and the selection is theirs to see either way.
    expect(shownType(), "the selection is still on screen").toBe(REVX_ROOM);
  });

  // The write boundary is what every writer passes through, and an UNDO is the one that used
  // to have no read in front of it: it re-types the channel from the plan's own copy, which
  // was made before whatever the panel had done to the array since.
  it("reads the outgoing array again when an undo re-types the channel", SLOW, async () => {
    const REFILLED = 55;
    const { table, move } = stubWithPanel({ refillsOnType: REFILLED });
    const shell = (await bootApp({ tauri: table }))!;
    $("btn-live").click();
    await vi.waitFor(() => expect(shell.count("vd_params_subscribe")).toBe(1), { timeout: 20_000 });

    // A type change first, so there is something to undo.
    pickType(REVX_ROOM);
    await vi.waitFor(() => expect(shownType()).toBe(REVX_ROOM), { timeout: 25_000 });
    await settled(shell);

    // The hand on the unit again, and then the undo, which re-types the channel.
    const AGAIN = TUNED + 7;
    move(AGAIN);
    const gesture = shell.invokes.length;
    undoEdit(shell);
    await vi.waitFor(() => expect(shownType()).toBe(REVX_HALL), { timeout: 25_000 });
    await vi.waitFor(
      () =>
        expect(
          shell.invokes.some(
            (cmd, i) =>
              cmd === "vd_set" && at(shell.args[i]) === FX1_HPF && shell.args[i]?.value === AGAIN && i >= gesture,
          ),
          "the unit was given back what it was holding when the undo was pressed",
        ).toBe(true),
      { timeout: 30_000 },
    );
    expect(shownHpf(), "and the app holds it too").toBe(HPF.format!(AGAIN, {}));
  });

  // The other writer with the same shape. An insert-FX selector refills its engine array on
  // the unit exactly as an EFFECT TYPE does, and the app used to re-key its own copy and
  // write it back without reading the outgoing engine at all.
  it("reads the outgoing insert-FX engine before the selector goes out", SLOW, async () => {
    const { table } = stubWithPanel();
    const shell = (await bootApp({ tauri: table }))!;
    $("btn-live").click();
    await vi.waitFor(() => expect(shell.count("vd_params_subscribe")).toBe(1), { timeout: 20_000 });

    const pickInsertFx = (): number => {
      pressNode("ch1");
      const sel = paramRow(t().inspector.insertFxType).querySelector<HTMLSelectElement>("select")!;
      const options = [...sel.options].map((o) => Number(o.value)).filter((v) => v !== INSERT_FX_NONE);
      const next = options.find((v) => v !== Number(sel.value))!;
      sel.value = String(next);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return next;
    };
    // Onto an effect first: with the channel holding No Effect there is no engine to read.
    pickInsertFx();
    await settled(shell);

    const gesture = shell.invokes.length;
    pickInsertFx();
    const ifx = insertFxControl(getModel("URX44V"), "ch1")!;
    const selectorAt = (): number =>
      shell.invokes.findIndex(
        (cmd, i) => cmd === "vd_set" && at(shell.args[i]) === `${ifx.param}:0:${ifx.instances[0]}` && i >= gesture,
      );
    await vi.waitFor(() => expect(selectorAt()).toBeGreaterThan(-1), { timeout: 25_000 });

    const engines = new Set([689, 693, 697, 701]);
    const engineAt = shell.invokes.findIndex(
      (cmd, i) => cmd === "vd_get" && engines.has(Number(shell.args[i]?.paramId)) && i >= gesture,
    );
    expect(engineAt, "the outgoing engine array was read").toBeGreaterThan(-1);
    expect(engineAt, "before the selector reached the unit").toBeLessThan(selectorAt());
  });
});

// The delay time tempo Sync drives is the unit's to compute, and the plan's writer leaves it out.
// While a session is up it is turned by hand as the unit's own panel turns it — the unit takes it
// and keeps Sync on — so the FX screen opens the row and the value is written to the unit directly.

describe("the delay time tempo Sync drives, during Live sync", () => {
  const seed = { [`${PARAMS.FX_EFFECT_TYPE.id}/0/0`]: 1024, "681/0/4": 1, "681/0/6": 5000 };
  const setsOf = (shell: TauriShell, paramId: number): [number, number][] =>
    shell.invokes.flatMap((cmd, i) => {
      const a = shell.args[i] as Record<string, number>;
      return cmd === "vd_set" && a.paramId === paramId ? [[a.y, a.value] as [number, number]] : [];
    });
  /** The FX 1 screen's delay time row, open on the screen. */
  const delayRow = (): HTMLInputElement | null => {
    pressNode("bus.fx1");
    $<HTMLButtonElement>("btn-fx-screen").click();
    return $("dyn-screen-box").querySelector<HTMLInputElement>('input[data-dyn="fx:delay"]');
  };
  const close = (): void => $("dyn-screen-box").querySelector<HTMLButtonElement>(".consent-actions button")!.click();

  it("opens the row while a session is up and writes a turned value to the unit, keeping Sync on", SLOW, async () => {
    const shell = await bootDevice({}, true, seed);
    live().click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    const row = delayRow();
    if (!row) throw new Error("the FX 1 screen draws no delay time");
    expect(row.disabled, "a session takes it").toBe(false);
    row.value = String(Number(row.value) - 500);
    row.dispatchEvent(new Event("input", { bubbles: true }));
    row.dispatchEvent(new Event("change", { bubbles: true }));
    close();
    await vi.waitFor(() => expect(setsOf(shell, 681).filter(([y]) => y === 6)).toHaveLength(1), { timeout: 10_000 });
    expect(
      setsOf(shell, 681).some(([y]) => y === 4),
      "Sync is left as it is",
    ).toBe(false);
  });
});
