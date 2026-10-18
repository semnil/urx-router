// @vitest-environment jsdom

// Fetch from device and the device reads around it: what an edit, a file flow or a tuning screen
// meets while a read is in flight, and a read scoped to a few nodes.
//
// The setup, the teardown and the helpers every desktop case shares are `main.device.test-util.ts`'s,
// which also states what the device table does and does not model.

import { describe, expect, it, vi } from "vitest";
import { $, bootApp, deviceCommands, statusText, unwrittenRead } from "./main.test-util";
import type { TauriShell } from "./main.test-util";
import { attackToVd, eqFreqToVd, levelToVd } from "./core/control/vd";
import { formatHz } from "./core/control/fx-effect";
import { COMP_EQ_SSMCS, denormalizeInsertFx, INSERT_FX_NONE, PARAMS } from "./core/control/params";
import { SUPPORTED_SYSTEM_FIRMWARE } from "./core/control/firmware";
import { insertFxControl, planToCommands, sendControl } from "./core/control/translate";
import { getModel } from "./models";
import { defaultPlan } from "./models/initial-state";
import type { DeviceModel } from "./models/types";
import { ruleKind } from "./core/routing";
import type { Plan } from "./core/plan";
import { drag, portHit } from "./ui/graph.test-util";
import { EDIT_MENU_EVENT, EDIT_REDO_ID, EDIT_UNDO_ID } from "./core/platform";
import { t } from "./i18n";
import {
  SLOW,
  bootDevice,
  invoked,
  live,
  fetchEnded,
  row,
  selectNode,
  notifyChannel,
  clockReads,
  streamingOnMix1,
  stripsNamed,
  confirms,
  chooseRate,
  countFor,
  SAVES,
  paramRow,
  insertFxSection,
  pickInsertFx,
  pickSignalType,
  clipSafeButton,
  clipSafeOnFace,
  pickPanBal,
  oscFace,
  oscOn,
  turnOscOn,
  undoTo,
  insertFxOnFace,
  COMPANDER_H,
  STREAMING_ON_NONE,
  STREAMING_DELAY_AT_FLOOR,
  STREAMING_STEREO,
  streamingWrites,
  streamingDrawn,
  quiet,
} from "./main.device.test-util";

describe("Fetch from device", () => {
  // The same rule for what a MIRROR wrote. While a pair is linked the insert FX travels
  // to the partner, bypass included — and if the partner's bypass already held the value
  // the mirror writes, that write moves nothing either. The partner then took the device's
  // OFF while the source kept ON, so one operator gesture left the pair disagreeing on a
  // key it had set once.
  it("keeps the partner's mirrored bypass while a read is in flight", SLOW, async () => {
    const shell = await bootDevice();
    selectNode("ch1");
    pickSignalType(1); // STEREO — the pair mirrors its insert FX in either PAN/BAL mode
    pickInsertFx(256);
    expect(insertFxOnFace()).toBe("ON");
    selectNode("ch2");
    expect(insertFxOnFace()).toBe("ON"); // the mirror carried it

    shell.answer("vd_get", () => new Promise((r) => setTimeout(() => r(0), 1)));
    $("btn-fetch").click();
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(5), { timeout: 10_000, interval: 5 });

    selectNode("ch1");
    pickInsertFx(COMPANDER_H);
    await invoked(shell, "vd_disconnect");

    selectNode("ch2");
    expect(insertFxSection()!.querySelector("select")!.value).toBe(String(COMPANDER_H));
    expect(insertFxOnFace()).toBe("ON");
  });

  // …and only what it wrote. In STEREO + PAN the BAL mirror does not run, so an insert-FX
  // selection carries three keys to the partner and asserts nothing else — registering the
  // partner's whole key set there would drop the device's answer for a key no mirror had
  // touched. The device holds this stub's default for CH 2's HPF (unwritten, so OFF) while
  // the plan says ON, which is the contest: the read's value has to win it.
  it("asserts only the keys the running mirror wrote", SLOW, async () => {
    const shell = await bootDevice();
    selectNode("ch1");
    pickSignalType(1); // STEREO — which lands the pair in BAL…
    pickPanBal(0); // …and PAN is where only the insert-FX mirror runs
    selectNode("ch2");
    paramRow("HPF").querySelector<HTMLButtonElement>("button.on")!.textContent === "ON" ||
      [...paramRow("HPF").querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "ON")!.click();
    expect(paramRow("HPF").querySelector("button.on")?.textContent).toBe("ON");

    selectNode("ch1");
    pickInsertFx(256);

    shell.answer("vd_get", () => new Promise((r) => setTimeout(() => r(0), 1)));
    $("btn-fetch").click();
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(5), { timeout: 10_000, interval: 5 });

    selectNode("ch1");
    pickInsertFx(COMPANDER_H);
    await invoked(shell, "vd_disconnect");

    selectNode("ch2");
    // The mirror's own three keys still stand…
    expect(insertFxOnFace()).toBe("ON");
    // …and the key it never touched took the device's value.
    expect(paramRow("HPF").querySelector("button.on")?.textContent).toBe("OFF");
  });

  // The head amp is the other direction of the same rule: each member reads a jack of its own,
  // a key another node holds, which the pair mirror LEAVES with the partner — so an edit to
  // one member's Clip Safe sends nothing for the other's jack, and naming it would take the
  // device's answer away for a value this gesture never wrote. The device holds this stub's
  // default for jack 2's Clip Safe (unwritten, so OFF) while the plan says ON, which is the
  // contest: the read's value has to win it.
  it("keeps the device's answer for a key the mirror leaves with the partner", SLOW, async () => {
    const shell = await bootDevice();
    selectNode("ch1");
    pickSignalType(1); // STEREO, which lands the pair in BAL — where the node mirror runs
    selectNode("ch2");
    clipSafeButton("ON").click();
    expect(clipSafeOnFace()).toBe("ON");

    selectNode("ch1");
    shell.answer("vd_get", () => new Promise((r) => setTimeout(() => r(0), 1)));
    $("btn-fetch").click();
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(5), { timeout: 10_000, interval: 5 });

    // The edit inside the read's window is on the SOURCE member's own head amp.
    clipSafeButton("ON").click();
    await invoked(shell, "vd_disconnect");

    selectNode("ch1");
    expect(clipSafeOnFace(), "the member edited keeps what the operator set").toBe("ON");
    selectNode("ch2");
    expect(clipSafeOnFace(), "the partner took the device's value").toBe("OFF");
  });

  // A pair transition is the case where NOTHING the gesture wrote has to move. Signal
  // Type clears the insert FX on both members — on a pair that carried none, that is
  // three deletions of keys already absent, so the plan reads identically before and
  // after and the read's own diff has nothing to tell it from a key nobody touched. The
  // device then re-selected an effect the operator had just told the unit to drop.
  it("keeps a Signal Type transition's insert-FX clear through a read in flight", SLOW, async () => {
    const shell = await bootDevice();
    selectNode("ch1");
    pickSignalType(1); // STEREO, with no effect selected on either member

    shell.answer(
      "vd_get",
      (a: Record<string, unknown>) =>
        new Promise((r) => setTimeout(() => r(a.paramId === PARAMS.INSERT_FX.id ? COMPANDER_H : 0), 1)),
    );
    $("btn-fetch").click();
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(5), { timeout: 10_000, interval: 5 });

    selectNode("ch1");
    pickSignalType(0); // MONO x2 — the transition clears the pair's insert FX
    await invoked(shell, "vd_disconnect");

    selectNode("ch1");
    expect(insertFxSection()!.querySelector("select")!.value).toBe("-1");
    selectNode("ch2");
    expect(insertFxSection()!.querySelector("select")!.value).toBe("-1");
  });

  // The same transition's other half, and the one that moves nothing by construction:
  // STEREO leaves the pair in BAL, whose pans are centred, and unlinking centres them —
  // so every send of both members is written the value it already holds, every time. The
  // plan is read through a save rather than the inspector because a channel's pan lives
  // on its send wire, and this asserts every send the pair carries rather than one row.
  it("keeps its pan centring too, on a transition that moved nothing", SLOW, async () => {
    const shell = await bootDevice(SAVES);
    selectNode("ch1");
    pickSignalType(1); // STEREO — lands in BAL, which centres both members' pans

    shell.answer(
      "vd_get",
      (a: Record<string, unknown>) =>
        new Promise((r) =>
          setTimeout(() => r(a.paramId === PARAMS.CH_PAN.id || a.paramId === PARAMS.SEND_PAN.id ? 63 : 0), 1),
        ),
    );
    $("btn-fetch").click();
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(5), { timeout: 10_000, interval: 5 });

    selectNode("ch1");
    pickSignalType(0); // MONO x2 — the transition centres the pair's pans (0 over 0)
    await invoked(shell, "vd_disconnect");

    const before = shell.count("write_text_file");
    $("btn-save").click();
    await vi.waitFor(() => expect(shell.count("write_text_file")).toBe(before + 1), { timeout: 10_000 });
    const saved = shell.args[shell.invokes.lastIndexOf("write_text_file")];
    const doc = JSON.parse(String((saved as { contents: string }).contents));
    const pans = (doc.connections as Array<Record<string, never>>)
      .filter((c) => String(c.from).startsWith("ch1:") && c.kind === "send")
      .map((c) => (c.params as { pan?: number } | undefined)?.pan ?? 0);
    expect(pans.length).toBeGreaterThan(0);
    expect(pans.every((p) => p === 0)).toBe(true);
  });

  // The write witness names what a funnel WROTE, not only what its write MOVED. Selecting
  // an insert effect over one that is already engaged writes `insertFxOn: true` again —
  // the value does not move, so the read's own diff cannot tell that key from one nobody
  // touched, and the device's value wins it. This stub answers the unwritten bypass with 0,
  // so the unit's bypass reads OFF: the operator's new effect used to land selected and
  // muted, which is the failure the emit order elsewhere exists to prevent.
  it("keeps a bypass the operator's patch asserted while a read was in flight", SLOW, async () => {
    const shell = await bootDevice();
    selectNode("ch1");
    pickInsertFx(256); // Clean — an engaged effect to select over
    expect(insertFxOnFace()).toBe("ON");

    // One millisecond per read, so there is a mid-read window at all (see the latch case).
    shell.answer("vd_get", () => new Promise((r) => setTimeout(() => r(0), 1)));
    $("btn-fetch").click();
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(5), { timeout: 10_000, interval: 5 });

    // …and the operator picks a different effect while it runs.
    selectNode("ch1");
    pickInsertFx(COMPANDER_H);
    await invoked(shell, "vd_disconnect");

    selectNode("ch1");
    expect(insertFxSection()!.querySelector("select")!.value).toBe(String(COMPANDER_H));
    expect(insertFxOnFace()).toBe("ON");
  });

  // A COMP 1-knob switched on writes attack, release, Auto Makeup and the level beside the switch.
  // After an ON and an OFF each of them already holds the value the next ON writes, so the plan's
  // diff cannot tell them from keys nobody touched — and a read in flight carrying the unit's
  // older values would take them back. The read here answers attack 10 ms, release 100 ms, Auto
  // Makeup on and level 50; the press made inside it has to keep the knob's values, on the
  // member pressed and, on a linked pair, on its partner too.
  it.each([
    ["a channel", false],
    ["a STEREO-linked pair", true],
  ])("keeps the values a COMP 1-knob switched on writes through a read in flight, on %s", SLOW, async (_l, linked) => {
    const shell = await bootDevice(SAVES);
    selectNode("ch1");
    if (linked) pickSignalType(1);
    $("btn-comp-screen").click();
    const knob = (text: string): HTMLButtonElement =>
      [
        ...[...$("dyn-screen-box").querySelectorAll<HTMLElement>(".prefs-section")]
          .find((sec) => sec.querySelector("h3")?.textContent === t().inspector.oneKnob)!
          .querySelectorAll<HTMLButtonElement>(".prefs-row button"),
      ].find((b) => b.textContent === text)!;
    knob(t().inspector.on).click();
    knob(t().inspector.off).click();

    const stale: Record<number, number> = {
      [PARAMS.COMP_ATTACK.id]: 10120,
      [PARAMS.COMP_RELEASE.id]: 1001,
      [PARAMS.COMP_AUTO_MAKEUP.id]: 1,
      [PARAMS.COMP_ONE_KNOB_LEVEL.id]: 50,
    };
    shell.answer(
      "vd_get",
      (a: Record<string, unknown>) =>
        new Promise((r) => setTimeout(() => r(stale[a.paramId as number] ?? unwrittenRead(a)), 1)),
    );
    $("btn-fetch").click();
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(5), { timeout: 10_000, interval: 5 });
    knob(t().inspector.on).click();
    await invoked(shell, "vd_disconnect");

    const before = shell.count("write_text_file");
    $("btn-save").click();
    await vi.waitFor(() => expect(shell.count("write_text_file")).toBe(before + 1), { timeout: 10_000 });
    const saved = shell.args[shell.invokes.lastIndexOf("write_text_file")];
    const doc = JSON.parse(String((saved as { contents: string }).contents));
    const held = { oneKnob: true, attack: 24.87, release: 295.5, autoMakeup: false, oneKnobLevel: 0 };
    expect(doc.nodeParams.ch1.comp, "CH 1").toMatchObject(held);
    if (linked) expect(doc.nodeParams.ch2.comp, "CH 2").toMatchObject(held);
  });

  it("connects, reads the whole unit, and drops the link when it is done", SLOW, async () => {
    const shell = await bootDevice();
    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");

    expect(statusText()).toContain("URX44V");
    expect(statusText()).not.toBe(t().status.fetchConnecting);
    expect(shell.count("vd_connect")).toBe(1);
    expect(shell.count("vd_get")).toBeGreaterThan(100);
    // The link is not kept: Fetch is a one-shot holder, and a session that never
    // let go would lock every other device action for the rest of the launch.
    expect(shell.count("vd_disconnect")).toBe(1);
  });

  // The read holds the plan by reference for seconds, so every file flow is refused
  // for its duration through one shared latch. Measured: a Fetch does NOT disable the
  // device buttons — that is the live session's doing, and only the live session's —
  // so the refusal is the observable here, and a case written against `disabled` would
  // be asserting the wrong guard entirely.
  //
  // A refusal must also consume nothing: the same attempt has to pass once the read
  // is done, which is the half that says the latch is a gate and not a discard.
  it("refuses a file flow while it holds the plan, and takes the same attempt afterwards", SLOW, async () => {
    const shell = await bootDevice();
    // The stub answers a read in a microtask, so the whole 676-read sweep completes
    // between two polls of `waitFor` and there is no mid-read window to test in — the
    // first version of this case clicked New against a read that had already
    // finished, and passed by asserting the wrong status. One millisecond per read
    // makes the window real. Remove this and the case stops testing the latch.
    shell.answer("vd_get", () => new Promise((r) => setTimeout(() => r(0), 1)));
    $("btn-fetch").click();
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(5), { timeout: 10_000, interval: 5 });

    $("btn-new").click();
    expect(statusText()).toBe(t().status.busyDeviceRead);

    await invoked(shell, "vd_disconnect");
    $("btn-new").click();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.newPlan), { timeout: 10_000 });
  });

  it("reports a link it cannot open, and holds nothing afterwards", SLOW, async () => {
    const shell = await bootDevice();
    shell.answer("vd_connect", () => {
      throw new Error("broker-unreachable");
    });
    $("btn-fetch").click();
    await vi.waitFor(() => expect(shell.count("plugin:dialog|message")).toBeGreaterThan(0), { timeout: 10_000 });
    expect(live().disabled).toBe(false); // the holder was released on the failure path
  });

  // A firmware the app has not been verified against is a confirm, not a refusal: the
  // operator may still want to read. Declining has to leave the unit untouched.
  it("asks before reading a unit on unverified firmware, and abandons when declined", SLOW, async () => {
    const shell = await bootDevice(
      { vd_connect: { model: "URX44V", label: "URX44V", firmware: "9.9.9.9", epoch: 1 } },
      false,
    );
    $("btn-fetch").click();
    await vi.waitFor(() => expect(shell.count("plugin:dialog|message")).toBeGreaterThan(0), { timeout: 10_000 });
    // Declined: no whole-device sweep followed the confirm.
    await new Promise((r) => setTimeout(r, 200));
    expect(shell.count("vd_get")).toBeLessThan(10);
  });

  // A read replaces values the document wrote, and from then on they are the unit's: a later
  // divergence in one is the unit having moved, not a setting the operator chose. Recorded off
  // the merge's own patch, which is what the read ACTUALLY adopted — a key it left alone
  // because the plan had moved under it is not in there.
  //
  // The document names EVERY key, so before the fetch nothing in the plan is unauthored and the
  // confirm carries no note. That is what makes the note's presence afterwards the answer.
  it("takes the values a fetch adopted as the unit's", SLOW, async () => {
    const { serialize } = await import("./core/plan");
    const { defaultPlan } = await import("./models/initial-state");
    const written = defaultPlan("URX44V");
    const shell = (await bootApp({
      url: `/?plan=${encodeURIComponent(Buffer.from(serialize(written), "utf8").toString("base64url"))}`,
      tauri: deviceCommands({ "plugin:dialog|message": "Ok", vd_get: clockReads(false, 48_000) }),
    }))!;

    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    const first = confirms(shell).filter((m) => m.includes(t().confirm.write(1).slice(-20)));
    expect(first, "the premise: the write asked").toHaveLength(1);
    expect(stripsNamed(first[0]), "the premise: the document authored everything").toEqual([]);

    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect", 2);
    expect(shell.count("vd_get"), "the premise: the fetch swept the device").toBeGreaterThan(400);

    $("btn-write").click();
    await invoked(shell, "vd_disconnect", 3);
    const asked = confirms(shell).filter((m) => m.includes(t().confirm.write(1).slice(-20)));
    expect(asked, "the positive control: the second write asked too").toHaveLength(2);
    // Named BY NAME, not by a count: the read also brings in keys the document never had, and
    // those are unrecorded and warned about with or without this. What only the record produces
    // is a strip whose every key the document DID write and the read then replaced — the stereo
    // channels here, which the first write above did not name.
    const { getModel } = await import("./models");
    const { fullLabel } = await import("./models/types");
    const stereo = getModel("URX44V")
      .nodes.filter((n) => /^ch_\d+_\d+$/.test(n.id))
      .map((n) => fullLabel(n));
    expect(stereo.length, "the premise: the model has stereo channels").toBeGreaterThan(0);
    for (const label of stereo) expect(stripsNamed(asked[1]), label).toContain(label);
  });

  // The same document without its STREAMING wire: the load gives it the factory STEREO, and
  // that wire is the one nobody chose — so the write that moves the unit (on MIX 1) onto it names
  // STREAMING and nothing else, where the case above shows the document naming STEREO itself
  // names nothing.
  it("names STREAMING when the write moves the unit onto the source the load supplied", SLOW, async () => {
    const { serialize } = await import("./core/plan");
    const { defaultPlan } = await import("./models/initial-state");
    const { getModel } = await import("./models");
    const { fullLabel } = await import("./models/types");
    const written = defaultPlan("URX44V");
    written.connections = written.connections.filter((c) => c.to !== "bus.stream:in");
    const shell = (await bootApp({
      url: `/?plan=${encodeURIComponent(Buffer.from(serialize(written), "utf8").toString("base64url"))}`,
      tauri: deviceCommands({ "plugin:dialog|message": "Ok", vd_get: streamingOnMix1(clockReads(false, 48_000)) }),
    }))!;
    const supplied = [t().status.streamingSourceSupplied, t().status.planLoaded].join(" — ");
    await vi.waitFor(() => expect(statusText(), "the premise: the load supplied the source").toBe(supplied), {
      timeout: 10_000,
    });

    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    const asked = confirms(shell).filter((m) => m.includes(t().confirm.write(1).slice(-20)));
    expect(asked, "the premise: the write asked").toHaveLength(1);
    const stream = getModel("URX44V").nodes.find((n) => n.id === "bus.stream")!;
    expect(stripsNamed(asked[0])).toEqual([fullLabel(stream)]);
  });

  // A send the document lists without a level loads at the unity the write sends, and that level
  // is the fill's: the write that moves the unit's send there names the strip, said on the load's
  // status line first. The control is the same document with the level written, on the same unit.
  it.each([
    ["names the strip whose send level the load supplied", false],
    ["names nothing when the document wrote that level", true],
  ])("%s", SLOW, async (_name, writesLevel) => {
    const { serialize } = await import("./core/plan");
    const { fullLabel } = await import("./models/types");
    const model = getModel("URX44V");
    const written = defaultPlan("URX44V");
    const send = written.connections.find((c) => c.from === "ch1:out" && c.to === "bus.mix1:in")!;
    send.params = writesLevel ? { ...send.params, level: 0 } : { pan: send.params?.pan ?? 0 };
    const levels = sendControl(model, "ch1", "bus.mix1")!.level;
    const read = clockReads(false, 48_000);
    const shell = (await bootApp({
      url: `/?plan=${encodeURIComponent(Buffer.from(serialize(written), "utf8").toString("base64url"))}`,
      tauri: deviceCommands({
        "plugin:dialog|message": "Ok",
        // The unit holds that send at -10 dB, which a write of unity moves.
        vd_get: (a: Record<string, unknown>) =>
          levels.includes(Number(a.paramId) + Number(a.x ?? 0)) ? levelToVd(-10) : read(a),
      }),
    }))!;
    await vi.waitFor(
      () =>
        expect(statusText()).toBe(
          writesLevel ? t().status.planLoaded : [t().status.sendLevelsSupplied(1), t().status.planLoaded].join(" — "),
        ),
      { timeout: 10_000 },
    );

    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    const asked = confirms(shell).filter((m) => m.includes(t().confirm.write(1).slice(-20)));
    expect(asked, "the premise: the write asked").toHaveLength(1);
    const ch1 = model.nodes.find((n) => n.id === "ch1")!;
    expect(stripsNamed(asked[0])).toEqual(writesLevel ? [] : [fullLabel(ch1)]);
  });

  // The unit fills an engine with the type's defaults only on the transition into it, so a write
  // of a selector it already holds moves nothing there. A selection made in the app puts those
  // defaults in the plan: the write over a unit already running that effect, tuned otherwise,
  // sends them, and its confirm names the strip, since they are the type's and not the operator's.
  it("sends a chosen effect's defaults over a unit already running it, and names the strip", SLOW, async () => {
    const { serialize } = await import("./core/plan");
    const { fullLabel } = await import("./models/types");
    const { ENGINE_COMPANDER_INPUT, insertFxDefaults } = await import("./core/control/insert-fx-effect");
    const model = getModel("URX44V");
    const ifx = insertFxControl(model, "ch1")!;
    const read = clockReads(false, 48_000);
    const held: Record<number, number> = { 6: -2000, 7: 800 };
    const shell = (await bootApp({
      url: `/?plan=${encodeURIComponent(Buffer.from(serialize(defaultPlan("URX44V")), "utf8").toString("base64url"))}`,
      tauri: deviceCommands({
        "plugin:dialog|message": "Ok",
        // CH 1 runs Compander-H with a threshold and a ratio of its own.
        vd_get: (a: Record<string, unknown>) =>
          a.paramId === ifx.param
            ? 1793
            : a.paramId === ENGINE_COMPANDER_INPUT && held[Number(a.y)] !== undefined
              ? held[Number(a.y)]
              : read(a),
      }),
    }))!;
    selectNode("ch1");
    const sel = [...document.querySelectorAll<HTMLElement>("#inspector .param")]
      .find((r) => r.dataset.paramLabel === t().inspector.insertFxType)!
      .querySelector("select")!;
    sel.value = "1793";
    sel.dispatchEvent(new Event("change", { bubbles: true }));

    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    const asked = confirms(shell).filter((m) => m.includes(t().confirm.write(1).slice(-20)));
    expect(asked, "the premise: the write asked").toHaveLength(1);
    expect(stripsNamed(asked[0])).toEqual([fullLabel(model.nodes.find((n) => n.id === "ch1")!)]);
    const sent = shell.invokes
      .map((cmd, i) => (cmd === "vd_set" ? shell.args[i] : undefined))
      .filter((a): a is Record<string, unknown> => !!a && a.paramId === ENGINE_COMPANDER_INPUT && a.y === 6);
    expect(sent.map((a) => a.value)).toContain(insertFxDefaults("compander", 1793)[6]);
  });

  // A document that leaves a name out loads with the model's factory name, which the write then
  // sends: that name is the fill's, so the write moving the unit onto it names the strip, while a
  // name the document wrote does not.
  it.each([
    ["names the strip whose name the load filled", false],
    ["names nothing when the document wrote that name", true],
  ])("%s", SLOW, async (_name, writesName) => {
    const { serialize } = await import("./core/plan");
    const { fullLabel } = await import("./models/types");
    const model = getModel("URX44V");
    const written = defaultPlan("URX44V");
    if (!writesName) delete written.nodeNames.ch1;
    const shell = (await bootApp({
      url: `/?plan=${encodeURIComponent(Buffer.from(serialize(written), "utf8").toString("base64url"))}`,
      tauri: deviceCommands({ "plugin:dialog|message": "Ok", vd_get: clockReads(false, 48_000) }),
    }))!;
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    const asked = confirms(shell).filter((m) => m.includes(t().confirm.write(1).slice(-20)));
    expect(asked, "the premise: the write asked").toHaveLength(1);
    const sentNames = shell.invokes.flatMap((cmd, i) => (cmd === "vd_set_str" ? [shell.args[i]!.value] : []));
    expect(sentNames, "the premise: the factory name goes out").toContain(defaultPlan("URX44V").nodeNames.ch1);
    expect(stripsNamed(asked[0])).toEqual(writesName ? [] : [fullLabel(model.nodes.find((n) => n.id === "ch1")!)]);
  });

  // A document that leaves a colour out loads with the model's factory colour, which the write
  // then sends — the fill's, so the write moving the unit onto it names the strip, while a colour
  // the document wrote does not. Off goes out as the unit's Off index.
  it.each([
    ["names the strip whose colour the load filled", false],
    ["names nothing when the document wrote that colour", true],
  ])("%s", SLOW, async (_name, writesColor) => {
    const { serialize } = await import("./core/plan");
    const { fullLabel } = await import("./models/types");
    const { COLOR_OFF, COLOR_OFF_INDEX, planColorIndex } = await import("./core/control/params");
    const model = getModel("URX44V");
    const written = defaultPlan("URX44V");
    // The unit answers 0 at an address nothing wrote, so STEREO's factory colour moves it.
    expect(planColorIndex(written.nodeColors["bus.stereo"]), "the premise").not.toBe(0);
    if (!writesColor) delete written.nodeColors["bus.stereo"];
    written.nodeColors.ch1 = COLOR_OFF;
    const shell = (await bootApp({
      url: `/?plan=${encodeURIComponent(Buffer.from(serialize(written), "utf8").toString("base64url"))}`,
      tauri: deviceCommands({ "plugin:dialog|message": "Ok", vd_get: clockReads(false, 48_000) }),
    }))!;
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    const asked = confirms(shell).filter((m) => m.includes(t().confirm.write(1).slice(-20)));
    expect(asked, "the premise: the write asked").toHaveLength(1);
    const stereo = fullLabel(model.nodes.find((n) => n.id === "bus.stereo")!);
    expect(stripsNamed(asked[0])).toEqual(writesColor ? [] : [stereo]);
    const offSent = shell.invokes.some(
      (cmd, i) =>
        cmd === "vd_set" && shell.args[i]?.paramId === PARAMS.CH_COLOR.id && shell.args[i]?.value === COLOR_OFF_INDEX,
    );
    expect(offSent, "Off goes out as the Off index").toBe(true);
  });

  // An empty name has no value to send, and the unit keeps its own. Said by the write rather than
  // counted as a match: on its own it is what the write reports instead of "already matches",
  // and beside other changes it is a line of the confirm.
  it("says which names are empty and not sent, instead of reporting a match", SLOW, async () => {
    const shell = await bootDevice();
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    $("btn-write").click();
    await invoked(shell, "vd_disconnect", 2);
    expect(statusText(), "the premise: the unit matches the plan").toContain(t().status.writeNoChanges);

    selectNode("ch1");
    const field = row(t().inspector.name).querySelector<HTMLInputElement>('input[type="text"]')!;
    field.value = "";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    const namesSent = (): number => shell.invokes.filter((cmd) => cmd === "vd_set_str").length;
    const before = namesSent();
    $("btn-write").click();
    await invoked(shell, "vd_disconnect", 3);
    const { fullLabel } = await import("./models/types");
    const label = fullLabel(getModel("URX44V").nodes.find((n) => n.id === "ch1")!);
    expect(statusText()).toBe(t().status.writeNamesNotSent(label, 1));
    expect(namesSent(), "nothing is sent for it").toBe(before);

    // Beside a change that does go out, the confirm says it.
    selectNode("ch2");
    const other = row(t().inspector.name).querySelector<HTMLInputElement>('input[type="text"]')!;
    other.value = "Kick";
    other.dispatchEvent(new Event("input", { bubbles: true }));
    $("btn-write").click();
    await invoked(shell, "vd_disconnect", 4);
    const asked = confirms(shell).filter((m) => m.includes(t().confirm.write(1).slice(-20)));
    expect(asked.at(-1)).toContain(t().confirm.namesNotSent(label, 1));
  });

  // The params of a wire a scene-scoped document carries over are the plan on screen's as the wire
  // is: the OSC assign into STEREO of a plan nothing vouches for stays unvouched-for after a scene
  // file is dropped over it, so the write moving the unit's assign names STEREO.
  it("keeps the record of a carried-over wire's params", SLOW, async () => {
    const { serialize } = await import("./core/plan");
    const { fullLabel } = await import("./models/types");
    const scene = serialize(defaultPlan("URX44V"), { sceneOnly: true });
    expect(JSON.parse(scene).connections.some((c: { from: string }) => c.from === "bus.osc:out")).toBe(false);
    const shell = (await bootApp({
      tauri: deviceCommands({
        "plugin:dialog|message": "Ok",
        vd_get: clockReads(false, 48_000),
        read_text_file: () => scene,
      }),
    }))!;
    expect(shell.emit("tauri://drag-drop", { paths: ["C:/urx/scene.json"] })).toBe(1);
    await vi.waitFor(() => expect(statusText()).toBe(t().status.openedFrom("scene.json")), { timeout: 10_000 });

    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    const asked = confirms(shell).filter((m) => m.includes(t().confirm.write(1).slice(-20)));
    expect(asked, "the premise: the write asked").toHaveLength(1);
    const stereo = getModel("URX44V").nodes.find((n) => n.id === "bus.stereo")!;
    expect(stripsNamed(asked[0])).toContain(fullLabel(stereo));
  });

  // A scene-scoped document leaves STREAMING's source to the plan on screen, and that wire keeps
  // the record it had there: the one the load supplied is still named by the next write.
  it("still names that source after a scene-scoped document carries it over", SLOW, async () => {
    const { serialize } = await import("./core/plan");
    const { defaultPlan } = await import("./models/initial-state");
    const { getModel } = await import("./models");
    const { fullLabel } = await import("./models/types");
    const written = defaultPlan("URX44V");
    written.connections = written.connections.filter((c) => c.to !== "bus.stream:in");
    const scene = serialize(defaultPlan("URX44V"), { sceneOnly: true });
    const shell = (await bootApp({
      url: `/?plan=${encodeURIComponent(Buffer.from(serialize(written), "utf8").toString("base64url"))}`,
      tauri: deviceCommands({
        "plugin:dialog|message": "Ok",
        vd_get: streamingOnMix1(clockReads(false, 48_000)),
        read_text_file: () => scene,
      }),
    }))!;
    const supplied = [t().status.streamingSourceSupplied, t().status.planLoaded].join(" — ");
    await vi.waitFor(() => expect(statusText(), "the premise: the load supplied the source").toBe(supplied), {
      timeout: 10_000,
    });
    expect(shell.emit("tauri://drag-drop", { paths: ["C:/urx/scene.json"] })).toBe(1);
    await vi.waitFor(() => expect(statusText()).toBe(t().status.openedFrom("scene.json")), { timeout: 10_000 });

    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    const asked = confirms(shell).filter((m) => m.includes(t().confirm.write(1).slice(-20)));
    expect(asked, "the premise: the write asked").toHaveLength(1);
    const stream = getModel("URX44V").nodes.find((n) => n.id === "bus.stream")!;
    expect(stripsNamed(asked[0])).toEqual([fullLabel(stream)]);
  });

  // STREAMING's list on the unit has no None. A unit that holds NONE there is read as such, and
  // the plan takes STEREO in its place: drawn on the board, said ahead of the fetch's own line,
  // and recorded as the fill's, so the write that then moves the unit onto it names STREAMING.
  it("gives the plan STEREO where the unit's STREAMING was on NONE, and names it on the next write", SLOW, async () => {
    const { fullLabel } = await import("./models/types");
    const stream = getModel("URX44V").nodes.find((n) => n.id === "bus.stream")!;
    const shell = await bootDevice({}, true, { ...STREAMING_ON_NONE, ...STREAMING_DELAY_AT_FLOOR });
    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");
    await vi.waitFor(() => expect(statusText().startsWith(`${t().status.streamingSourceUnlisted} — `)).toBe(true), {
      timeout: 10_000,
    });
    expect(streamingDrawn()).toEqual(["bus.stereo:out"]);

    $("btn-write").click();
    await invoked(shell, "vd_disconnect", 2);
    const asked = confirms(shell).filter((m) => m.includes(t().confirm.write(1).slice(-20)));
    expect(asked, "the premise: the write asked").toHaveLength(1);
    expect(stripsNamed(asked[0])).toContain(fullLabel(stream));
    expect(streamingWrites(shell).sort()).toEqual([
      `${PARAMS.STREAM_SRC_L.id}=${STREAMING_STEREO[0]}`,
      `${PARAMS.STREAM_SRC_R.id}=${STREAMING_STEREO[1]}`,
    ]);
  });

  // The control: a unit on a source its list offers says nothing about it, and the write that
  // follows does not name STREAMING.
  it("says nothing about STREAMING when the unit holds a source its list offers", SLOW, async () => {
    const { fullLabel } = await import("./models/types");
    const stream = getModel("URX44V").nodes.find((n) => n.id === "bus.stream")!;
    const shell = await bootDevice({}, true, STREAMING_DELAY_AT_FLOOR);
    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");
    // The whole line is the fetch's own, so no note leads it.
    await vi.waitFor(() => expect(countFor(statusText(), (n) => t().status.fetchedDevice("URX44V", n))).not.toBeNaN(), {
      timeout: 10_000,
    });
    expect(streamingDrawn()).toEqual(["bus.stereo:out"]);

    $("btn-write").click();
    await invoked(shell, "vd_disconnect", 2);
    const asked = confirms(shell).filter((m) => m.includes(t().confirm.write(1).slice(-20)));
    expect(asked, "the premise: the write asked, for the strips it does move").toHaveLength(1);
    expect(stripsNamed(asked[0]).length, "the premise: the note names strips").toBeGreaterThan(0);
    expect(stripsNamed(asked[0])).not.toContain(fullLabel(stream));
    expect(streamingWrites(shell)).toEqual([]);
  });

  it("reads a unit on the verified firmware without asking anything", SLOW, async () => {
    const shell = await bootDevice({}, false); // every confirm would DECLINE
    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");
    expect(shell.count("plugin:dialog|message")).toBe(0);
    expect(SUPPORTED_SYSTEM_FIRMWARE).toBeTruthy();
  });

  // A read that lands drops the undo history even where it changes no value: the unit here
  // holds everything the plan does, the edit made before the read included, and the undo that
  // follows has nothing to take back.
  for (const [flow, start, landed] of [
    [
      "fetch",
      () => $("btn-fetch").click(),
      async (shell: TauriShell) => {
        await invoked(shell, "vd_disconnect", 2);
        await fetchEnded();
      },
    ],
    [
      "live start",
      () => live().click(),
      () => vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 }),
    ],
  ] as const) {
    it(`drops the undo history on a ${flow} whose read changed no value`, SLOW, async () => {
      let unitOsc = 0;
      const shell = await bootDevice({
        vd_get: (a: Record<string, unknown>) => (a.paramId === PARAMS.OSC_ON.id ? unitOsc : unwrittenRead(a)),
      });
      $("btn-fetch").click();
      await invoked(shell, "vd_disconnect");
      await fetchEnded();
      turnOscOn();
      expect(oscFace(), "the premise: the edit landed").toBe("ON");
      await new Promise((r) => setTimeout(r, 0)); // the press's own entry closes
      unitOsc = 1;
      start();
      await landed(shell);
      // By way of another node, for the reason the draw-failure cases give.
      selectNode("ch1");
      expect(oscOn(), "the premise: the read left the edit standing").toBe("ON");
      expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
      expect(statusText()).toBe(t().status.nothingToUndo);
    });

    // …and the redo half: an entry undone before the read is one no redo may put back, so
    // no entry of any kind — a rate change included — outlives the read on either stack.
    it(`drops the redo history on a ${flow} whose read changed no value`, SLOW, async () => {
      const shell = await bootDevice();
      $("btn-fetch").click();
      await invoked(shell, "vd_disconnect");
      await fetchEnded();
      turnOscOn();
      expect(oscFace(), "the premise: the edit landed").toBe("ON");
      await new Promise((r) => setTimeout(r, 0)); // the press's own entry closes
      await undoTo(shell, "OFF"); // the ON now waits on the redo stack
      start();
      await landed(shell);
      selectNode("ch1");
      expect(shell.emit(EDIT_MENU_EVENT, EDIT_REDO_ID)).toBe(1);
      expect(statusText()).toBe(t().status.nothingToRedo);
    });
  }
});

// A single-input receiver whose source the operator replaced on the board while a device
// read was in flight. The unit holds one source, the read is carrying it back, and the
// board has been given another onto the SAME receiver meanwhile. Such a receiver takes one
// choice (`isSingleInput`), so the two cannot both stand: a plan holding both is one the
// write emits the wrong wire from and the loader refuses.

describe("a source replaced on the board while a device read was in flight", () => {
  const STREAM_IN = "bus.stream:in";
  const MON_IN = "bus.mon1:in";
  const USB_B_IN = "out.usbmain_b:in";
  const model = (): DeviceModel => getModel("URX44V");

  /** A plan wired the way `wire` says, from the model's own defaults. */
  const planWired = (wire: (plan: Plan) => void): Plan => {
    const p = defaultPlan("URX44V");
    wire(p);
    return p;
  };

  /** Replace every wire into `to` with one from each of `froms`, at the kind the model's
   *  own rule names — so a case states the ROUTING and nothing about how it is stored. */
  const sourced =
    (to: string, ...froms: string[]) =>
    (plan: Plan): void => {
      plan.connections = plan.connections.filter((c) => c.to !== to);
      for (const from of froms) plan.connections.push({ from, to, kind: ruleKind(model(), from, to)! });
    };

  /** Every address `planToCommands` writes for a plan wired like `wire`, keyed the way the
   *  device table keys one. Taken from the emit rather than written out: the encoding is
   *  then the app's own, and a case says only which source the unit is on. */
  const unitHolding = (wire: (plan: Plan) => void): Record<string, number> => {
    const seed: Record<string, number> = {};
    const unit = planWired(wire);
    for (const c of planToCommands(model(), unit)) seed[`${c.paramId}/${c.x}/${c.y}`] = c.vdValue;
    seed[`${PARAMS.SAMPLE_RATE.id}/0/0`] = unit.sampleRate;
    return seed;
  };

  /** The addresses at which a unit wired like `wire` differs from the plan the app opens
   *  with — which is what a case has to move the unit to, and nothing else. */
  const unitMovedTo = (wire: (plan: Plan) => void): Record<string, number> => {
    const same = unitHolding(() => {});
    return Object.fromEntries(Object.entries(unitHolding(wire)).filter(([at, v]) => same[at] !== v));
  };

  interface Held {
    /** Resolves once the read is stopped at the address. */
    reached: Promise<void>;
    release: () => void;
    /** Arm the stop. The follow-read flow needs it: the session's own start read asks the
     *  same address first, and stopping THAT one holds a read the case is not about. */
    arm: () => void;
    /** Move the unit off what the plan holds, at the addresses given. A write to one of
     *  them takes it back, the way the table's own store does — without that a write can
     *  never converge, and a case asserting one reaches the non-convergence path. */
    moveTo: (at: Record<string, number>) => void;
    tauri: Record<string, unknown>;
  }

  /** A connected unit whose read stops at `paramId` — the first one after `arm()` — and
   *  goes on when `release()` is called. */
  const heldRead = (paramId: number, { late = false } = {}): Held => {
    let ask = (): void => {};
    const reached = new Promise<void>((r) => (ask = r));
    let go = (): void => {};
    const released = new Promise<void>((r) => (go = r));
    let armed = !late;
    let stopped = false;
    const moved: Record<string, number> = {};
    const tauri = deviceCommands(
      { "plugin:dialog|message": "Ok", ...SAVES },
      unitHolding(() => {}),
    );
    const get = tauri.vd_get as (a: Record<string, unknown>) => number;
    const set = tauri.vd_set as (a: Record<string, unknown>) => void;
    const at = (a: Record<string, unknown>): string => `${a.paramId}/${a.x}/${a.y}`;
    tauri.vd_get = (a: Record<string, unknown>) => {
      const read = (): number => (at(a) in moved ? moved[at(a)] : get(a));
      if (stopped || !armed || a.paramId !== paramId) return read();
      stopped = true;
      ask();
      return released.then(read);
    };
    tauri.vd_set = (a: Record<string, unknown>) => {
      delete moved[at(a)];
      return set(a);
    };
    return {
      reached,
      release: () => go(),
      arm: () => (armed = true),
      moveTo: (next) => void Object.assign(moved, next),
      tauri,
    };
  };

  /** Draw `from` onto `to`, the way a replacing drop reaches the board. `elementFromPoint`
   *  is what the release resolves the target with, and the app's own boot answers null. */
  const draw = (from: string, to: string): void => {
    const host = $("graph-host");
    const jack = host.querySelector(`[data-ref="${to}"]`);
    expect(jack, `the premise: the board draws ${to}`).not.toBeNull();
    const real = document.elementFromPoint;
    document.elementFromPoint = (() => jack) as typeof document.elementFromPoint;
    try {
      drag(portHit(host, from)!, { x: 400, y: 200 }, jack);
    } finally {
      document.elementFromPoint = real;
    }
  };

  /** The wires the saved document carries into `to`. */
  const savedSources = async (shell: TauriShell, to: string): Promise<{ from: string[]; problems: unknown[] }> => {
    const { deserialize } = await import("./core/plan");
    const { validatePlan } = await import("./core/routing");
    const before = shell.count("write_text_file");
    $("btn-save").click();
    await vi.waitFor(() => expect(shell.count("write_text_file")).toBe(before + 1), { timeout: 10_000 });
    const doc = deserialize(
      String((shell.args[shell.invokes.lastIndexOf("write_text_file")] as { contents: string }).contents),
    );
    return {
      from: doc.connections
        .filter((c) => c.to === to)
        .map((c) => c.from)
        .sort(),
      problems: validatePlan(model(), doc),
    };
  };

  /** What a write of a plan wired like `wire` sends to STREAMING's source, in
   *  `streamingWrites`' own spelling. */
  const streamingFor = (wire: (plan: Plan) => void): string[] =>
    planToCommands(model(), planWired(wire))
      .filter((c) => c.paramId === PARAMS.STREAM_SRC_L.id || c.paramId === PARAMS.STREAM_SRC_R.id)
      .map((c) => `${c.paramId}=${c.vdValue}`)
      .sort();

  const stopLive = async (): Promise<void> => {
    if (live().getAttribute("aria-checked") !== "true") return;
    live().click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("false"), { timeout: 25_000 });
  };
  const liveUp = (): Promise<void> =>
    vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });

  interface Flow {
    name: string;
    /** The address to stop the read at, and whether the stop has to be armed late. */
    at: number;
    late: boolean;
    /** Put the unit where the case needs it and start the read; returns once it is held. */
    begin: (shell: TauriShell, unit: Held, move: Record<string, number>) => Promise<void>;
    /** Returns once the flow has landed. */
    settle: (shell: TauriShell) => Promise<void>;
  }

  const FLOWS: Flow[] = [
    {
      name: "Fetch",
      at: PARAMS.FOLLOW_USB.id,
      late: false,
      begin: async (_shell, unit, move) => {
        unit.moveTo(move);
        $("btn-fetch").click();
        await unit.reached;
      },
      settle: async (shell) => {
        await invoked(shell, "vd_disconnect");
        await fetchEnded();
      },
    },
    {
      name: "Live-sync start",
      at: PARAMS.FOLLOW_USB.id,
      late: false,
      begin: async (_shell, unit, move) => {
        unit.moveTo(move);
        live().click();
        await unit.reached;
      },
      settle: async () => await liveUp(),
    },
    {
      name: "follow read",
      // STREAMING's own source address: a reconcile scoped to that node asks it, and the
      // session's start read asks it too — which is what the late arming is for.
      at: PARAMS.STREAM_SRC_L.id,
      late: true,
      begin: async (shell, unit, move) => {
        live().click();
        await liveUp();
        await quiet(shell);
        // The session started on a unit that agreed with the plan, so the move below is a
        // change made on the unit's own panel — announced on one address, which is what
        // sends the follow layer to re-read the node.
        unit.moveTo(move);
        unit.arm();
        notifyChannel(shell).onmessage([{ param_id: PARAMS.STREAM_DELAY_TIME.id, x: 0, y: 0, value: 200 }]);
        await unit.reached;
      },
      settle: async (shell) => await quiet(shell),
    },
  ];

  for (const flow of FLOWS) {
    it(`keeps only the source the board was given during a ${flow.name}`, SLOW, async () => {
      const unit = heldRead(flow.at, { late: flow.late });
      const shell = (await bootApp({ tauri: unit.tauri }))!;
      expect(streamingDrawn(), "the premise: the plan opens on STEREO").toEqual(["bus.stereo:out"]);
      await flow.begin(shell, unit, unitMovedTo(sourced(STREAM_IN, "bus.mix1:out")));
      try {
        draw("bus.mix2:out", STREAM_IN);
        expect(streamingDrawn(), "the premise: the drop replaced the source").toEqual(["bus.mix2:out"]);
      } finally {
        unit.release();
      }
      // A follow read says what it kept as it lands, and says which of the two holds kept
      // it: an effect a rate cannot run is the unit's own change undone, a source is the
      // operator's own gesture kept, and a count alone tells them apart for neither. Taken
      // here rather than after the settle, since the send-back's own read writes the line
      // again with nothing held.
      if (flow.name === "follow read") {
        await vi.waitFor(() => expect(countFor(statusText(), (n) => t().status.liveHeld(n, 0, 1))).not.toBeNaN(), {
          timeout: 25_000,
        });
        expect(countFor(statusText(), (n) => t().status.liveHeld(n, 1, 0))).toBeNaN();
      }
      await flow.settle(shell);

      // The board, and then the document, both hold ONE source, and it is the operator's.
      await vi.waitFor(() => expect(streamingDrawn()).toEqual(["bus.mix2:out"]), { timeout: 25_000 });
      await quiet(shell);
      expect(streamingDrawn()).toEqual(["bus.mix2:out"]);
      // Nothing the read is about to do can still be in flight: a live session goes on
      // reading, so the assertions below are taken after it has gone quiet.
      if (live().getAttribute("aria-checked") === "true") {
        // The session sends the operator's choice rather than the unit's, and never NONE.
        expect(streamingWrites(shell)).not.toHaveLength(0);
        expect([...new Set(streamingWrites(shell))].sort()).toEqual(streamingFor(sourced(STREAM_IN, "bus.mix2:out")));
      }
      // A follow read says what it kept, and says which of the two holds kept it: the
      // effects a rate cannot run are the unit's own change undone, a source is the
      // operator's own gesture kept, and the count alone tells them apart for neither.
      await stopLive();
      const doc = await savedSources(shell, STREAM_IN);
      expect(doc.problems).toEqual([]);
      expect(doc.from).toEqual(["bus.mix2:out"]);
    });
  }

  // A unit already holding what the plan opens with is the same window with nothing for the
  // read to carry back: the drop is still an edit with no session to flush it through, and
  // the snapshot the session takes is the read's copy, which does not have it. Until it is
  // sent, the unit holds the source the operator replaced — and the next thing the unit
  // announces sends a follow read that reads it back over their choice.
  it("sends the source drawn under a Live-sync start the unit agreed with", SLOW, async () => {
    const unit = heldRead(PARAMS.FOLLOW_USB.id);
    const shell = (await bootApp({ tauri: unit.tauri }))!;
    expect(streamingDrawn(), "the premise: the plan opens on the source the unit holds").toEqual(["bus.stereo:out"]);
    live().click();
    await unit.reached;
    try {
      draw("bus.mix2:out", STREAM_IN);
    } finally {
      unit.release();
    }
    await liveUp();
    await quiet(shell);
    expect([...new Set(streamingWrites(shell))].sort()).toEqual(streamingFor(sourced(STREAM_IN, "bus.mix2:out")));

    // The unit announces something of STREAMING's own, which sends a follow read over that
    // node: the source it reads back is the one the session just wrote.
    notifyChannel(shell).onmessage([{ param_id: PARAMS.STREAM_DELAY_TIME.id, x: 0, y: 0, value: 200 }]);
    await quiet(shell);
    expect(streamingDrawn()).toEqual(["bus.mix2:out"]);
    await stopLive();
  });

  // The write a Fetch leaves the plan ready for: it moves the unit onto the operator's own
  // source, and NONE — which STREAMING's list does not offer — is sent for nothing.
  it("writes the source the board was given, and never NONE", SLOW, async () => {
    const unit = heldRead(PARAMS.FOLLOW_USB.id);
    const shell = (await bootApp({ tauri: unit.tauri }))!;
    unit.moveTo(unitMovedTo(sourced(STREAM_IN, "bus.mix1:out")));
    $("btn-fetch").click();
    await unit.reached;
    try {
      draw("bus.mix2:out", STREAM_IN);
    } finally {
      unit.release();
    }
    await invoked(shell, "vd_disconnect");
    await fetchEnded();
    expect(streamingWrites(shell), "the premise: the fetch itself wrote nothing").toEqual([]);

    $("btn-write").click();
    await invoked(shell, "vd_disconnect", 2);
    await quiet(shell);
    expect([...new Set(streamingWrites(shell))].sort()).toEqual(streamingFor(sourced(STREAM_IN, "bus.mix2:out")));
  });

  // The undo entry the drop opened describes ONE source on either side of it, so the
  // replacing drop that follows the read can be taken back and put again.
  it("undoes and redoes a later drop back to that one source", SLOW, async () => {
    const unit = heldRead(PARAMS.FOLLOW_USB.id);
    const shell = (await bootApp({ tauri: unit.tauri }))!;
    unit.moveTo(unitMovedTo(sourced(STREAM_IN, "bus.mix1:out")));
    $("btn-fetch").click();
    await unit.reached;
    try {
      draw("bus.mix2:out", STREAM_IN);
    } finally {
      unit.release();
    }
    await invoked(shell, "vd_disconnect");
    await fetchEnded();

    draw("bus.stereo:out", STREAM_IN);
    expect(streamingDrawn(), "the premise: the later drop replaced it").toEqual(["bus.stereo:out"]);
    expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
    await vi.waitFor(() => expect(streamingDrawn()).toEqual(["bus.mix2:out"]), { timeout: 10_000 });
    expect(shell.emit(EDIT_MENU_EVENT, EDIT_REDO_ID)).toBe(1);
    await vi.waitFor(() => expect(streamingDrawn()).toEqual(["bus.stereo:out"]), { timeout: 10_000 });
  });

  // The control: with nothing drawn during the read, the unit's own source lands. Without
  // it every assertion above is satisfied by a read that took nothing at all.
  it("takes the unit's own source when the board was given none", SLOW, async () => {
    const unit = heldRead(PARAMS.FOLLOW_USB.id);
    const shell = (await bootApp({ tauri: unit.tauri }))!;
    unit.moveTo(unitMovedTo(sourced(STREAM_IN, "bus.mix1:out")));
    $("btn-fetch").click();
    await unit.reached;
    unit.release();
    await invoked(shell, "vd_disconnect");
    await fetchEnded();

    expect(streamingDrawn()).toEqual(["bus.mix1:out"]);
    const doc = await savedSources(shell, STREAM_IN);
    expect(doc.problems).toEqual([]);
    expect(doc.from).toEqual(["bus.mix1:out"]);
  });

  // The window is the READ's, not the receiver's: a second read with nothing drawn under it
  // takes the unit's source, the operator's choice having had a session to reach the unit.
  it("takes the unit's source on the next read, nothing being drawn under that one", SLOW, async () => {
    const unit = heldRead(PARAMS.FOLLOW_USB.id);
    const shell = (await bootApp({ tauri: unit.tauri }))!;
    unit.moveTo(unitMovedTo(sourced(STREAM_IN, "bus.mix1:out")));
    $("btn-fetch").click();
    await unit.reached;
    try {
      draw("bus.mix2:out", STREAM_IN);
    } finally {
      unit.release();
    }
    await invoked(shell, "vd_disconnect");
    await fetchEnded();
    expect(streamingDrawn(), "the premise: the first read kept the operator's source").toEqual(["bus.mix2:out"]);

    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect", 2);
    await fetchEnded();
    expect(streamingDrawn()).toEqual(["bus.mix1:out"]);
  });

  // The positive control for every receiver the operator did NOT touch: the unit's own
  // MONITOR source lands, and a USB output's MONO IN pair lands as the two wires it is —
  // the receiver's rule is what the arbitration reads, not how many wires it holds.
  it("lands the unit's values on every receiver the board was not given a source for", SLOW, async () => {
    const unit = heldRead(PARAMS.FOLLOW_USB.id);
    const shell = (await bootApp({ tauri: unit.tauri }))!;
    const moved = (p: Plan): void => {
      sourced(STREAM_IN, "bus.mix1:out")(p);
      sourced(MON_IN, "bus.mix1:out")(p);
      sourced(USB_B_IN, "ch1:out", "ch2:out")(p);
    };
    unit.moveTo(unitMovedTo(moved));
    $("btn-fetch").click();
    await unit.reached;
    try {
      draw("bus.mix2:out", STREAM_IN);
    } finally {
      unit.release();
    }
    await invoked(shell, "vd_disconnect");
    await fetchEnded();

    const stream = await savedSources(shell, STREAM_IN);
    expect(stream.problems).toEqual([]);
    expect(stream.from).toEqual(["bus.mix2:out"]);
    expect((await savedSources(shell, MON_IN)).from).toEqual(["bus.mix1:out"]);
    expect((await savedSources(shell, USB_B_IN)).from).toEqual(["ch1:out", "ch2:out"]);
  });
});

// A tuning screen left open over a read that re-authors the plan in place. The screen draws a
// snapshot of the plan it was built from, so the read has to tell it to draw again — and to
// close when the read moved the channel onto a processor the screen does not edit.

describe("a tuning screen open across a fetch", () => {
  /** The unit's answer to every read, with Follow USB — the read's first — held until released,
   *  so the screen can be opened while the read is in flight. */
  const heldRead = (
    rest: (a: Record<string, unknown>) => number,
  ): { reading: Promise<void>; release: () => void; vd_get: (a: Record<string, unknown>) => unknown } => {
    let asked = (): void => {};
    const reading = new Promise<void>((r) => (asked = r));
    let release = (): void => {};
    const answered = new Promise<void>((r) => (release = r));
    return {
      reading,
      release: () => release(),
      vd_get: (a) => {
        if (a.paramId !== PARAMS.FOLLOW_USB.id) return rest(a);
        asked();
        return answered.then(() => 0);
      },
    };
  };
  const threshold = (): HTMLInputElement =>
    $("dyn-screen-box").querySelector<HTMLInputElement>('input[data-dyn="threshold"]')!;
  const ch1 = (paramId: number) => (a: Record<string, unknown>) => a.paramId === paramId && a.x === 0 && a.y === 0;

  it("draws the values the read brought in", SLOW, async () => {
    const isThreshold = ch1(PARAMS.COMP_THRESHOLD.id);
    const unit = heldRead((a) => (isThreshold(a) ? -1000 : unwrittenRead(a)));
    const shell = await bootDevice({ vd_get: unit.vd_get });
    $("btn-fetch").click();
    await unit.reading;
    selectNode("ch1");
    $("btn-comp-screen").click();
    const before = threshold().value;
    expect(before).not.toBe("-10");
    unit.release();
    await fetchEnded();
    expect(shell.count("vd_disconnect")).toBe(1);
    expect($("dyn-screen-modal").hidden).toBe(false);
    expect(threshold().value).toBe("-10");
  });

  it("closes the screen when the read moved the channel to SSMCS", SLOW, async () => {
    const isType = ch1(PARAMS.COMP_EQ_TYPE.id);
    const unit = heldRead((a) => (isType(a) ? COMP_EQ_SSMCS : unwrittenRead(a)));
    await bootDevice({ vd_get: unit.vd_get });
    $("btn-fetch").click();
    await unit.reading;
    selectNode("ch1");
    $("btn-comp-screen").click();
    expect($("dyn-screen-modal").hidden).toBe(false);
    unit.release();
    await fetchEnded();
    await vi.waitFor(() => expect($("dyn-screen-modal").hidden).toBe(true), { timeout: 10_000 });
  });
});

// A file flow that is already running when a Fetch's connect lands holds the plan as it stood
// when the flow began. The read does not start under it; the flow finishes on the plan it began
// with. Each case holds the connect, starts the file flow, then lets the connect land — and holds
// the read's first round trip as well, so a read that did start is still in flight when the
// file flow finishes.

describe("a Fetch that connects while a file flow runs", () => {
  /** The connect and the first device read, each held until released. */
  const held = (
    over: Record<string, unknown>,
  ): {
    tauri: Record<string, unknown>;
    connect: () => void;
    read: () => void;
  } => {
    let connect!: () => void;
    const connected = new Promise<void>((r) => (connect = r));
    let read!: () => void;
    const readHeld = new Promise<void>((r) => (read = r));
    const table = deviceCommands({ "plugin:dialog|message": "Ok", ...over });
    const vdConnect = table.vd_connect as (a: Record<string, unknown>) => unknown;
    const vdGet = table.vd_get as (a: Record<string, unknown>) => unknown;
    let first = true;
    return {
      connect,
      read,
      tauri: {
        ...table,
        vd_connect: async (a: Record<string, unknown>) => {
          await connected;
          return vdConnect(a);
        },
        vd_get: async (a: Record<string, unknown>) => {
          if (first) {
            first = false;
            await readHeld;
          }
          return vdGet(a);
        },
      },
    };
  };
  /** The Fetch has reached its decision: it read, or it let the link go. */
  const fetchDecided = (shell: TauriShell): Promise<void> =>
    vi.waitFor(() => expect(shell.count("vd_get") + shell.count("vd_disconnect")).toBeGreaterThan(0), {
      timeout: 10_000,
    });

  it("does not read under a Save whose dialog is open", SLOW, async () => {
    let save!: (path: string) => void;
    const saving = new Promise<string>((r) => (save = r));
    const unit = held({ "plugin:dialog|save": () => saving, write_text_file: null });
    const shell = (await bootApp({ tauri: unit.tauri }))!;
    $("btn-fetch").click();
    await invoked(shell, "vd_connect");
    $("btn-save").click();
    await invoked(shell, "plugin:dialog|save");
    unit.connect();
    await fetchDecided(shell);
    unit.read();
    await invoked(shell, "vd_disconnect");
    expect(shell.count("vd_get")).toBe(0);
    expect(statusText()).toBe(t().status.busyFileFlow);
    save("C:/urx/saved.json");
    await vi.waitFor(() => expect(statusText()).toBe(t().status.savedTo("saved.json")), { timeout: 10_000 });
  });

  it("lets a model switch whose confirm is open finish on the model it named", SLOW, async () => {
    let answerA!: (v: string) => void;
    const confirmA = new Promise<string>((r) => (answerA = r));
    let discards = 0;
    const unit = held({
      "plugin:dialog|message": (a: Record<string, unknown>) =>
        a.message === t().confirm.discard && ++discards === 1 ? confirmA : "Ok",
    });
    const shell = (await bootApp({ tauri: unit.tauri }))!;
    chooseRate(96_000); // unsaved, so the switch asks the discard confirm
    $("btn-fetch").click();
    await invoked(shell, "vd_connect");
    const picker = $<HTMLSelectElement>("model-picker");
    picker.value = "URX22";
    picker.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(discards).toBe(1), { timeout: 10_000 });
    unit.connect();
    await fetchDecided(shell);
    answerA("Ok");
    await vi.waitFor(() => expect(statusText()).toBe(t().status.switchedModel("URX22")), { timeout: 10_000 });
    unit.read();
    await fetchEnded();
    expect(picker.value).toBe("URX22");
    // The board is the URX22's: the URX44V's CH 11/12 is not drawn.
    expect($("graph-host").querySelector('g.node[data-id="ch_11_12"]')).toBeNull();
    expect(shell.count("vd_get")).toBe(0);
  });

  it("keeps a recent entry whose file opens while the Fetch connects", SLOW, async () => {
    const { serialize } = await import("./core/plan");
    let readFile!: () => void;
    const reading = new Promise<void>((r) => (readFile = r));
    const unit = held({
      read_text_file: async () => {
        await reading;
        return serialize(defaultPlan("URX44V"));
      },
    });
    const entry = { path: "C:/urx/recent.json", name: "recent.json", modelId: "URX44V" };
    const shell = (await bootApp({ tauri: unit.tauri, seed: { "urx-recent": JSON.stringify([entry]) } }))!;
    $("btn-fetch").click();
    await invoked(shell, "vd_connect");
    $("inspector").querySelector<HTMLButtonElement>(".recent-row")!.click();
    await invoked(shell, "read_text_file");
    unit.connect();
    await fetchDecided(shell);
    readFile();
    await vi.waitFor(() => expect(statusText()).not.toBe(t().status.fetchConnecting), { timeout: 10_000 });
    unit.read();
    await fetchEnded();
    expect(localStorage.getItem("urx-recent")).toContain("recent.json");
    expect($("inspector").querySelector(".recent-row")).not.toBeNull();
  });
});

// Two funnels write the plan, and both have to name what they asserted. These drive the
// CONSOLE half and the BAL mirror's half against a read in flight.

describe("an edit funnel against a device read", () => {
  const face = (label: string): string | undefined =>
    paramRow(label)?.querySelector("button.on")?.textContent ?? undefined;

  // The CONSOLE's INS FX selection is the one console write that is not a flip: taking a
  // slot writes the bypass ON, which a No Effect route can already be holding (the
  // inspector leaves it engaged when the operator picks No Effect). The plan then reads
  // the same before and after, so the read's own diff cannot tell that key from one
  // nobody touched — and the operator's new effect landed selected and BYPASSED.
  //
  // The gesture is the strip's disclosure and then a row of the type popover it opens.
  // The face beside it cannot stand in: it is a bypass and writes one key, so driven
  // through it this case would assert nothing about the pair.
  it("keeps a bypass the CONSOLE asserted while a read was in flight", SLOW, async () => {
    const shell = await bootDevice();
    selectNode("ch1");
    pickInsertFx(COMPANDER_H);
    pickInsertFx(INSERT_FX_NONE); // selector alone: the bypass stays engaged

    shell.answer(
      "vd_get",
      (a: Record<string, unknown>) =>
        new Promise((r) =>
          setTimeout(() => r(a.paramId === PARAMS.INSERT_FX.id ? denormalizeInsertFx(INSERT_FX_NONE) : 0), 1),
        ),
    );
    $("btn-fetch").click();
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(5), { timeout: 10_000, interval: 5 });

    $("btn-view-console").click();
    const strip = $("console-host").querySelectorAll<HTMLElement>(".con-strip")[0];
    strip.querySelector<HTMLElement>(".con-ifxopen")!.click();
    [...$("console-host").querySelectorAll<HTMLElement>(".con-ifxpop .irow")]
      .find((r) => !r.classList.contains("off") && r.querySelector(".nm")!.textContent !== "No Effect")!
      .click();
    await invoked(shell, "vd_disconnect");

    $("btn-view-graph").click();
    selectNode("ch1");
    expect(insertFxSection()!.querySelector("select")!.value).not.toBe(String(INSERT_FX_NONE));
    expect(insertFxOnFace()).toBe("ON");
  });

  // A nested group is edited by REBUILDING it — one field set, the rest copied — so the
  // patch key names the whole group, and the merge drops a named group whole. Naming it
  // therefore takes the device's answer for every sibling the rebuild never touched:
  // measured, an OSC frequency the unit moved during an OSC ON toggle was thrown away
  // with the toggle's own key.
  it("keeps a device change to a sibling of the group field the operator edited", SLOW, async () => {
    const shell = await bootDevice();
    // The unit answers a different oscillator frequency than the plan's default.
    shell.answer(
      "vd_get",
      (a: Record<string, unknown>) =>
        new Promise((r) => setTimeout(() => r(a.paramId === PARAMS.OSC_FREQ.id ? eqFreqToVd(2000) : 0), 1)),
    );
    $("btn-fetch").click();
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(5), { timeout: 10_000, interval: 5 });

    // Mid-read, the operator toggles the oscillator ON — one field of the same group.
    selectNode("bus.osc");
    const btns = [...paramRow(t().inspector.oscOn).querySelectorAll<HTMLButtonElement>("button")];
    (btns.find((b) => b.textContent === "ON") ?? btns[0]).click();
    await invoked(shell, "vd_disconnect");

    selectNode("bus.osc");
    expect(paramRow(t().inspector.oscOn).querySelector("button.on")?.textContent).toBe("ON");
    // …and the sibling the operator never touched took the unit's value.
    expect(paramRow(t().inspector.frequency).querySelector(".param-val")?.textContent).toBe(formatHz(2000));
  });

  // The same rule, for a funnel that names nothing: a tuning screen rebuilds its whole
  // group through one shared writer (`subObjectIo`), so the patch key it produces is the
  // GROUP. Naming that is what the funnel must not do by default — the screens carry no
  // field that can be written without moving, so a group falls through to the plan's own
  // diff rather than being claimed whole.
  it("keeps a device change to a tuning screen's other field", SLOW, async () => {
    const shell = await bootDevice(SAVES);
    $("btn-view-console").click();
    const strip = $("console-host").querySelectorAll<HTMLElement>(".con-strip")[0];
    strip.querySelector<HTMLElement>(".con-chip-open")!.click(); // the GATE opener

    // The unit moved GATE ATTACK to 4 ms while the screen was open.
    shell.answer(
      "vd_get",
      (a: Record<string, unknown>) =>
        new Promise((r) => setTimeout(() => r(a.paramId === PARAMS.GATE_ATTACK.id ? attackToVd(4) : 0), 1)),
    );
    $("btn-fetch").click();
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(5), { timeout: 10_000, interval: 5 });

    // …and the operator drags THRESHOLD in the same group, mid-read.
    const thr = $("dyn-screen-box").querySelector<HTMLInputElement>('input[data-dyn="threshold"]')!;
    const moved = Number(thr.value) - 5;
    thr.value = String(moved);
    thr.dispatchEvent(new Event("input", { bubbles: true }));
    thr.dispatchEvent(new Event("change", { bubbles: true }));
    await invoked(shell, "vd_disconnect");

    // Read the plan back through a save: the saved document is the plan itself, so it answers
    // for the merge rather than for the screen's render of it.
    const before = shell.count("write_text_file");
    $("btn-save").click();
    await vi.waitFor(() => expect(shell.count("write_text_file")).toBe(before + 1), { timeout: 10_000 });
    const saved = shell.args[shell.invokes.lastIndexOf("write_text_file")];
    const gate = JSON.parse(String((saved as { contents: string }).contents)).nodeParams.ch1.gate;

    expect(gate.threshold).toBe(moved); // the field the operator moved is theirs…
    expect(gate.attack).toBe(4); // …and the sibling they never touched took the unit's
  });

  // …and the BAL mirror names THIS EDIT's keys on the partner, not the whole record it
  // copies. The other keys were already equal on both sides, so copying them writes
  // nothing — while claiming them takes the device's answer away from the partner alone
  // and splits a pair that moves as one.
  it("lets both members of a BAL pair take a device change the edit never touched", SLOW, async () => {
    const shell = await bootDevice();
    selectNode("ch1");
    pickSignalType(1); // STEREO, which lands the pair in BAL

    // The unit holds HPF ON on every channel; the plan holds the default OFF.
    shell.answer(
      "vd_get",
      (a: Record<string, unknown>) =>
        new Promise((r) => setTimeout(() => r(a.paramId === PARAMS.HPF_ON.id ? 1 : 0), 1)),
    );
    $("btn-fetch").click();
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(5), { timeout: 10_000, interval: 5 });

    // An edit that carries Phase alone, mid-read.
    selectNode("ch1");
    const btns = [...paramRow(t().inspector.phase).querySelectorAll<HTMLButtonElement>("button")];
    (btns.find((b) => b.textContent === "ON") ?? btns[0]).click();
    await invoked(shell, "vd_disconnect");

    selectNode("ch1");
    expect(face(t().inspector.hpf)).toBe("ON");
    selectNode("ch2");
    expect(face(t().inspector.hpf)).toBe("ON");
  });
});

// Under the Scene only device scope a whole-device read puts the plan's scene-external values
// back afterwards. A read scoped to a few nodes — a follow reconcile, or the refetch a
// `sideEffect: "refetch"` write takes — reads those nodes' oscillator assigns as well, so it
// takes the same keep and restore, or the two reads disagree about one value under one
// setting and the unit's assign replaces the plan's.

describe("a scoped read under the Scene only device scope", () => {
  const model = (): DeviceModel => getModel("URX44V");
  /** The oscillator's assigns the board draws, by the bus they go into. */
  const oscDrawn = (): string[] =>
    [...$("graph-host").querySelectorAll('.wire-hit[data-from="bus.osc:out"]')]
      .map((w) => (w as SVGElement).dataset.to ?? "")
      .sort();
  const readsOf = (shell: TauriShell, paramId: number): number =>
    shell.invokes.filter((cmd, i) => cmd === "vd_get" && shell.args[i]?.paramId === paramId).length;
  const liveUp = (): Promise<void> =>
    vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });

  /** A unit whose oscillator goes into FX 1 and not into STEREO — the plan's own assign is the
   *  other way round — with the session up under the scene scope. */
  const sceneSession = async (): Promise<TauriShell> => {
    const shell = (await bootApp({
      seed: { "urx-settings": JSON.stringify({ deviceScope: "scene" }) },
      tauri: deviceCommands({ "plugin:dialog|message": "Ok" }, { [`${PARAMS.OSC_ASSIGN_FX.id}/0/0`]: 1 }),
    }))!;
    expect(oscDrawn(), "the premise: the plan's oscillator goes into STEREO").toEqual(["bus.stereo:in"]);
    live().click();
    await liveUp();
    await quiet(shell);
    expect(oscDrawn(), "the premise: the session's start read kept it").toEqual(["bus.stereo:in"]);
    return shell;
  };

  // A session is built for one scope. Changing the scope while it is up starts it again, and
  // the start reads the unit for the new scope: the oscillator's assign the scene scope left
  // as the plan's is now read from the unit.
  it("starts the session again for a device scope changed while it is up", SLOW, async () => {
    const shell = await sceneSession();
    const connects = shell.count("vd_connect");
    $("btn-prefs").click();
    document.querySelectorAll<HTMLButtonElement>("#prefs-device-scope button")[0].click();
    await vi.waitFor(() => expect(shell.count("vd_connect"), "a new session connected").toBeGreaterThan(connects), {
      timeout: 15_000,
    });
    await liveUp();
    await vi.waitFor(() => expect(oscDrawn(), "the unit's assign, read for the whole scope").toEqual(["bus.fx1:in"]), {
      timeout: 15_000,
    });
    $("prefs-modal").querySelector<HTMLButtonElement>(".consent-btn-secondary")!.click();
    live().click();
    await invoked(shell, "vd_disconnect");
  });

  /** The scene-scope unit of `sceneSession`, whose first read of a send level waits once `arm`
   *  is called — `held()` from then — until `release` answers it or `refuse` refuses it. */
  const heldReadUnit = (): {
    commands: Record<string, unknown>;
    arm: () => void;
    held: () => boolean;
    release: () => void;
    refuse: () => void;
  } => {
    const commands = deviceCommands({ "plugin:dialog|message": "Ok" }, { [`${PARAMS.OSC_ASSIGN_FX.id}/0/0`]: 1 });
    const get = commands.vd_get as (a: Record<string, unknown>) => unknown;
    let armed = false;
    let waiting = false;
    let answer = (_refused: boolean): void => {};
    const answered = new Promise<boolean>((done) => (answer = done));
    commands.vd_get = async (a: Record<string, unknown>) => {
      if (armed && a.paramId === PARAMS.SEND_LEVEL.id) {
        armed = false;
        waiting = true;
        if (await answered) throw new Error("refused");
      }
      return get(a);
    };
    return {
      commands,
      arm: () => (armed = true),
      held: () => waiting,
      release: () => answer(false),
      refuse: () => answer(true),
    };
  };
  const scopeButtons = (): HTMLButtonElement[] => [
    ...document.querySelectorAll<HTMLButtonElement>("#prefs-device-scope button"),
  ];

  // The device scope holds still while a session starts: its read takes the scope it finds,
  // and its snapshot and registration the scope they find once the read is done.
  it("holds the device scope still while a session starts", SLOW, async () => {
    const unit = heldReadUnit();
    const shell = (await bootApp({
      seed: { "urx-settings": JSON.stringify({ deviceScope: "scene" }) },
      tauri: unit.commands,
    }))!;
    unit.arm();
    live().click();
    await vi.waitFor(() => expect(unit.held(), "the starting read is under way").toBe(true), { timeout: 15_000 });
    $("btn-prefs").click();
    expect(scopeButtons().map((b) => b.disabled)).toEqual([true, true]);
    unit.release();
    await liveUp();
    await quiet(shell);
    expect(
      scopeButtons().map((b) => b.disabled),
      "open once the session is up",
    ).toEqual([false, false]);
    expect(oscDrawn(), "the scene scope kept the plan's assign").toEqual(["bus.stereo:in"]);
    live().click();
    await invoked(shell, "vd_disconnect");
    await vi.waitFor(() =>
      expect(
        scopeButtons().map((b) => b.disabled),
        "open once the session has ended",
      ).toEqual([false, false]),
    );
    $("prefs-modal").querySelector<HTMLButtonElement>(".consent-btn-secondary")!.click();
  });

  // A session that fails to start lets the device scope go with the link.
  it("lets the device scope go when a session fails to start", SLOW, async () => {
    const unit = heldReadUnit();
    const shell = (await bootApp({
      seed: { "urx-settings": JSON.stringify({ deviceScope: "scene" }) },
      tauri: unit.commands,
    }))!;
    unit.arm();
    live().click();
    await vi.waitFor(() => expect(unit.held(), "the starting read is under way").toBe(true), { timeout: 15_000 });
    $("btn-prefs").click();
    expect(scopeButtons().map((b) => b.disabled)).toEqual([true, true]);
    unit.refuse();
    await invoked(shell, "vd_disconnect");
    await vi.waitFor(() =>
      expect(
        scopeButtons().map((b) => b.disabled),
        "open once the start has failed",
      ).toEqual([false, false]),
    );
    expect(live().getAttribute("aria-checked"), "no session came up").not.toBe("true");
    $("prefs-modal").querySelector<HTMLButtonElement>(".consent-btn-secondary")!.click();
  });

  // …and so does one whose connect is refused, which never reaches a session to end.
  it("lets the device scope go when a session's connect is refused", SLOW, async () => {
    const unit = heldReadUnit();
    let refuse = (): void => {};
    const refused = new Promise<void>((done) => (refuse = done));
    let connecting = false;
    unit.commands.vd_connect = async () => {
      connecting = true;
      await refused;
      throw new Error("no broker");
    };
    const shell = (await bootApp({
      seed: { "urx-settings": JSON.stringify({ deviceScope: "scene" }) },
      tauri: unit.commands,
    }))!;
    live().click();
    await vi.waitFor(() => expect(connecting, "the connect is under way").toBe(true), { timeout: 15_000 });
    $("btn-prefs").click();
    expect(scopeButtons().map((b) => b.disabled)).toEqual([true, true]);
    refuse();
    await vi.waitFor(() =>
      expect(
        scopeButtons().map((b) => b.disabled),
        "open once the connect is refused",
      ).toEqual([false, false]),
    );
    expect(shell.count("vd_disconnect"), "there was no session to end").toBe(0);
    $("prefs-modal").querySelector<HTMLButtonElement>(".consent-btn-secondary")!.click();
  });

  // …and while a scope change starts it again, from the change until the new session is up.
  it("holds the device scope still while a changed scope starts the session again", SLOW, async () => {
    const unit = heldReadUnit();
    const shell = (await bootApp({
      seed: { "urx-settings": JSON.stringify({ deviceScope: "scene" }) },
      tauri: unit.commands,
    }))!;
    live().click();
    await liveUp();
    await quiet(shell);
    unit.arm();
    $("btn-prefs").click();
    scopeButtons()[0].click();
    expect(
      scopeButtons().map((b) => b.disabled),
      "held from the change",
    ).toEqual([true, true]);
    await vi.waitFor(() => expect(unit.held(), "the new session's read is under way").toBe(true), { timeout: 15_000 });
    expect(
      scopeButtons().map((b) => b.disabled),
      "held while it reads",
    ).toEqual([true, true]);
    unit.release();
    await liveUp();
    await quiet(shell);
    await vi.waitFor(() =>
      expect(
        scopeButtons().map((b) => b.disabled),
        "open once it is up",
      ).toEqual([false, false]),
    );
    expect(oscDrawn(), "the whole scope read the unit's assign").toEqual(["bus.fx1:in"]);
    $("prefs-modal").querySelector<HTMLButtonElement>(".consent-btn-secondary")!.click();
    live().click();
    await invoked(shell, "vd_disconnect");
  });

  it("keeps the plan's assigns through a follow read of an FX channel", SLOW, async () => {
    const shell = await sceneSession();
    const send = planToCommands(model(), defaultPlan("URX44V")).find(
      (c) => c.node === "bus.fx1" && c.name === "SEND_LEVEL",
    )!;
    const before = readsOf(shell, PARAMS.OSC_ASSIGN_FX.id);
    // A send level moved on the unit's own panel, which the follow layer answers with a read of
    // FX 1.
    notifyChannel(shell).onmessage([{ param_id: send.paramId, x: send.x, y: send.y, value: -1000 }]);
    await vi.waitFor(
      () => expect(readsOf(shell, PARAMS.OSC_ASSIGN_FX.id), "the premise: FX 1 was read").toBeGreaterThan(before),
      { timeout: 10_000 },
    );
    await quiet(shell);
    expect(oscDrawn()).toEqual(["bus.stereo:in"]);
  });

  it("keeps the plan's assigns through the refetch a STEREO EQ 1-knob takes", SLOW, async () => {
    const shell = await sceneSession();
    const before = readsOf(shell, PARAMS.OSC_ASSIGN_STEREO.id);
    selectNode("bus.stereo");
    $("inspector").querySelector<HTMLButtonElement>("#btn-eq-screen")!.click();
    $("dyn-screen-box")
      .querySelector<HTMLElement>("#dyn-oneknob-level")!
      .closest(".prefs-section")!
      .querySelectorAll<HTMLButtonElement>(".prefs-toggle button")[0]
      .click(); // ON
    await vi.waitFor(
      () =>
        expect(readsOf(shell, PARAMS.OSC_ASSIGN_STEREO.id), "the premise: STEREO was read back").toBeGreaterThan(
          before,
        ),
      { timeout: 10_000 },
    );
    $("dyn-screen-box").querySelector<HTMLButtonElement>(".consent-actions .consent-btn-secondary")!.click();
    await quiet(shell);
    expect(oscDrawn()).toEqual(["bus.stereo:in"]);
  });
});
