// @vitest-environment jsdom

// Files reaching the plan on the desktop: the settings-file import, drops, and the load report.
//
// The setup, the teardown and the helpers every desktop case shares are `main.device.test-util.ts`'s,
// which also states what the device table does and does not model.

import { describe, expect, it, vi } from "vitest";
import { $, bootApp, deviceCommands, statusText, unwrittenRead } from "./main.test-util";
import type { TauriShell } from "./main.test-util";
import { PARAMS } from "./core/control/params";
import { channelControl, sendControl } from "./core/control/translate";
import { getModel } from "./models";
import { defaultPlan } from "./models/initial-state";
import type { Plan } from "./core/plan";
import { CURRENT_FIELDS, buildUrxf, sampleUrxf } from "./core/control/urxf.test-util";
import type { Field } from "./core/control/urxf.test-util";
import { formatRate } from "./core/constraints";
import { t } from "./i18n";
import {
  SLOW,
  bootDevice,
  invoked,
  live,
  fetchEnded,
  dialogs,
  confirms,
  errors,
  byMessage,
  countedHead,
} from "./main.device.test-util";

// The experimental `.urxf` import: the unit's own microSD settings file read onto the plan
// already open, through the same device→plan inverse a fetch uses. Nothing is sent to
// hardware — the file is the source — so the whole flow is reachable with no device on the
// link, and the absence of writes is part of what each case says.
//
// Driven through the shell rather than through a module mock: the dialog and the file read
// are two Tauri commands, so answering them is the same seam every other case here uses.
// A `.urxf` dropped on the window while a device action holds the link. The menu entry greys
// for every holder; the drop has to be refused the same way, at its entry and again once its
// confirms are answered, since the window keeps running behind them.

describe("a settings file dropped while a device action holds the link", () => {
  const PATH = "C:/urx/backup.urxf";
  const boot = (over: Record<string, unknown> = {}): Promise<TauriShell> =>
    bootDevice({
      experimental_enabled: true,
      read_binary_file: () => sampleUrxf().buffer,
      "plugin:dialog|save": null,
      ...over,
    });

  it("refuses the drop while Live sync is still connecting", SLOW, async () => {
    let connect!: () => void;
    const connecting = new Promise<void>((r) => (connect = r));
    const table = deviceCommands({ "plugin:dialog|message": "Ok" });
    const vdConnect = table.vd_connect as (a: Record<string, unknown>) => unknown;
    const shell = await boot({
      vd_connect: async (a: Record<string, unknown>) => {
        await connecting;
        return vdConnect(a);
      },
      vd_disconnect: table.vd_disconnect,
    });
    await vi.waitFor(() => expect($("btn-open-settings").hidden).toBe(false), { timeout: 10_000 });
    $("btn-live").click();
    await invoked(shell, "vd_connect");
    expect(shell.emit("tauri://drag-drop", { paths: [PATH] })).toBe(1);
    await vi.waitFor(() => expect(statusText()).toBe(t().status.deviceLinkBusy), { timeout: 10_000 });
    expect(shell.count("read_binary_file")).toBe(0);
    expect(confirms(shell)).toEqual([]);
    connect();
  });

  // A Live-sync start or a Fetch refuses to read while the import's flow runs, but a write
  // does not consult it: one started behind the import's confirm holds the link when that
  // confirm is answered, and is converging the plan the import would overwrite.
  it("refuses the import when a write took the link behind its confirm", SLOW, async () => {
    let answer!: (v: string) => void;
    const importing = new Promise<string>((r) => (answer = r));
    const importHead = t().confirm.importSettings("\u0000", "URX44V").split("\u0000")[0]!;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let asked!: () => void;
    const reading = new Promise<void>((r) => (asked = r));
    const table = deviceCommands({});
    const vdGet = table.vd_get as (a: Record<string, unknown>) => unknown;
    let first = true;
    const shell = await boot({
      "plugin:dialog|message": (a: Record<string, unknown>) =>
        a.buttons === "OkCancel" && String(a.message ?? "").startsWith(importHead) ? importing : "Ok",
      vd_get: async (a: Record<string, unknown>) => {
        if (first) {
          first = false;
          asked();
          await held;
        }
        return vdGet(a);
      },
    });
    await vi.waitFor(() => expect($("btn-open-settings").hidden).toBe(false), { timeout: 10_000 });
    expect(shell.emit("tauri://drag-drop", { paths: [PATH] })).toBe(1);
    await vi.waitFor(() => expect(confirms(shell).length).toBe(1), { timeout: 10_000 });
    $("btn-write").click();
    await reading;
    const rate = $<HTMLSelectElement>("rate-picker").value;
    answer("Ok");
    await vi.waitFor(() => expect(statusText()).toBe(t().status.deviceLinkBusy), { timeout: 10_000 });
    expect($<HTMLSelectElement>("rate-picker").value).toBe(rate);
    release();
    await vi.waitFor(() => expect($("btn-write").textContent).toBe(t().toolbar.writeDevice), { timeout: 20_000 });
    expect(statusText()).not.toContain(countedHead(t().status.settingsPartial(0, 0, 0)));
  });
});

describe("importing a settings file", () => {
  const PATH = "C:/urx/backup.urxf";

  /** Boot with the import armed and `read_binary_file` answering `bytes`. */
  const bootImport = async (bytes: Uint8Array, agree = true): Promise<TauriShell> => {
    const shell = await bootDevice(
      {
        experimental_enabled: true,
        "plugin:dialog|open": PATH,
        // The bytes come back as the raw IPC response body, which platform.ts wraps in a
        // Uint8Array — so what this hands over is the buffer, not a number array.
        read_binary_file: () => bytes.buffer,
        // A partial import offers to save its report, and every confirm here says Ok. A
        // dismissed save dialog keeps that offer from becoming the outcome under test: left
        // unanswered the save rejects, and `showError` then blanks the very status line
        // these cases are reading.
        "plugin:dialog|save": null,
      },
      agree,
    );
    await vi.waitFor(() => expect($("btn-open-settings").hidden).toBe(false), { timeout: 10_000 });
    return shell;
  };

  // The sample carries six parameters where a unit's own file carries hundreds, so this is
  // the PARTIAL path — which is the one worth pinning: what did not come through has to be
  // counted rather than swallowed, and the nodes still showing their plan default have to be
  // flagged as such on the board. Same provenance rule as a device fetch.
  //
  // The frame is rebuilt from the numbers in it rather than matched as a substring, so the
  // message that renders them is pinned by KEY. Rebuilding cannot pin the numbers
  // themselves — the expectation is built from the same digits — so the count of them is
  // asserted separately: `settingsPartial` renders its third figure as an optional tail,
  // and a regression that dropped that tail while nodes were genuinely unread would
  // reconstruct to the shorter string and pass.
  it("reads what the file carries, counts what it does not, and writes nothing", SLOW, async () => {
    const shell = await bootImport(sampleUrxf());
    $("btn-open-settings").click();
    await vi.waitFor(() => expect(statusText()).not.toContain("URX44V"), { timeout: 15_000 });

    const counts = [...statusText().matchAll(/\d+/g)].map((m) => Number(m[0]));
    expect(counts).toHaveLength(3); // applied, failed, and the unread tail that is optional
    expect(statusText()).toBe(t().status.settingsPartial(counts[0], counts[1], counts[2]));
    expect(counts[0]).toBeGreaterThan(0); // something landed
    expect(counts[1]).toBeGreaterThan(0); // and the rest is reported

    // The "?" badge: a node whose body did not come through keeps its plan default and the
    // board says so, rather than presenting a default as if the file had confirmed it.
    const flagged = [...$("graph-host").querySelectorAll("g.node[data-id]")].filter((g) =>
      [...g.querySelectorAll("text")].some((el) => el.textContent === "?"),
    );
    expect(flagged.length).toBeGreaterThan(0);

    // Nothing was sent anywhere: the file is the source, and no link is opened at all.
    expect(shell.count("vd_set")).toBe(0);
    expect(shell.count("vd_set_str")).toBe(0);
    expect(shell.count("vd_connect")).toBe(0);
  });

  // A file holding +48V and HI-Z both on for CH 3 (jack y 2), a state the app never sets
  // itself. The import takes it as it is, where a document's load turns +48V off, and the
  // status line leads with the note that names the channel.
  //
  // The file answers every address the import reads, so the whole plan comes through and
  // the rest of the line is the full import's own message. The addresses are the ones a
  // read of the default plan asks when answered with the same values, so the file stays
  // complete as the read grows.
  it("takes +48V and HI-Z both on from the file as they are, and leads the line with the note", SLOW, async () => {
    const { applySourceState } = await import("./core/control/readback");
    const { defaultPlan } = await import("./models/initial-state");
    const value = (id: number, y: number): number =>
      id === PARAMS.SAMPLE_RATE.id
        ? 48_000
        : (id === PARAMS.PHANTOM.id || id === PARAMS.HI_Z.id) && y === 2
          ? 1
          : unwrittenRead({ paramId: id, x: 0, y });
    const asked = new Map<number, { str: boolean; len: number }>();
    const ask = (str: boolean, id: number, y: number): void => {
      asked.set(id, { str, len: Math.max(asked.get(id)?.len ?? 0, y + 1) });
    };
    const expected = await applySourceState(getModel("URX44V"), defaultPlan("URX44V"), {
      get: async (paramId, x, y) => (ask(false, paramId + x, y), value(paramId + x, y)),
      getStr: async (paramId, x, y) => (ask(true, paramId + x, y), ""),
    });
    expect(expected.errors, "the premise: every address the read asks is answered").toEqual([]);
    const fields = [...asked].map(([id, a]): Field =>
      a.str
        ? { id, typecode: 4, elemSize: 16, values: Array<string>(a.len).fill("") }
        : (() => {
            // A value past the signed range is a tagged port ref, which the unit's own files
            // hold as unsigned.
            const values = Array.from({ length: a.len }, (_, y) => value(id, y));
            return { id, typecode: values.some((v) => v > 0x7fffffff) ? 1 : 2, elemSize: 4, values };
          })(),
    );

    const shell = await bootImport(buildUrxf([{ chunk: "CURRENT", block: "CSF_BACKUP", label: "", fields }]));
    $("btn-open-settings").click();
    await vi.waitFor(
      () =>
        expect(statusText()).toBe(
          `${t().status.phantomHiZBothOn("CH 3")} — ${t().status.settingsImported("backup.urxf", expected.applied)}`,
        ),
      { timeout: 15_000 },
    );

    // The plan holds the file's values, read back through a save: both on for jack 3, which CH 3
    // reads, both off for jack 4, the other HI-Z jack.
    shell.answer("plugin:dialog|save", "/tmp/imported.json");
    shell.answer("write_text_file", null);
    $("btn-save").click();
    await vi.waitFor(() => expect(shell.count("write_text_file")).toBe(1), { timeout: 10_000 });
    const saved = shell.args[shell.invokes.indexOf("write_text_file")] as { contents: string };
    const { nodeParams } = JSON.parse(saved.contents);
    expect(nodeParams["in.micline_3_4"]).toMatchObject({ phantomL: true, hiZL: true, phantomR: false, hiZR: false });
    expect(shell.count("vd_set")).toBe(0);
  });

  // A file holding MIX 1's Pan Link on with CH 1's send into it at R40 and CH 1 at R20. The import
  // takes the send pan as the file holds it, where a document's load sets it to CH 1's R20, and
  // the status line carries the import's own message alone. Built the way the case above builds
  // its file.
  it("takes a linked MIX's send pan from the file as it is", SLOW, async () => {
    const { applySourceState } = await import("./core/control/readback");
    const sendPans = sendControl(getModel("URX44V"), "ch1", "bus.mix1")!.pan;
    const held: Record<number, number> = {
      [PARAMS.PAN_LINK.id]: 1,
      [channelControl(getModel("URX44V"), "ch1")!.pan]: 20,
      ...Object.fromEntries(sendPans.map((id) => [id, 40])),
    };
    const value = (id: number, y: number): number =>
      id === PARAMS.SAMPLE_RATE.id
        ? 48_000
        : y === 0 && id in held
          ? held[id]
          : unwrittenRead({ paramId: id, x: 0, y });
    const asked = new Map<number, { str: boolean; len: number }>();
    const ask = (str: boolean, id: number, y: number): void => {
      asked.set(id, { str, len: Math.max(asked.get(id)?.len ?? 0, y + 1) });
    };
    const expected = await applySourceState(getModel("URX44V"), defaultPlan("URX44V"), {
      get: async (paramId, x, y) => (ask(false, paramId + x, y), value(paramId + x, y)),
      getStr: async (paramId, x, y) => (ask(true, paramId + x, y), ""),
    });
    expect(expected.errors, "the premise: every address the read asks is answered").toEqual([]);
    const fields = [...asked].map(([id, a]): Field =>
      a.str
        ? { id, typecode: 4, elemSize: 16, values: Array<string>(a.len).fill("") }
        : (() => {
            const values = Array.from({ length: a.len }, (_, y) => value(id, y));
            return { id, typecode: values.some((v) => v > 0x7fffffff) ? 1 : 2, elemSize: 4, values };
          })(),
    );

    const shell = await bootImport(buildUrxf([{ chunk: "CURRENT", block: "CSF_BACKUP", label: "", fields }]));
    $("btn-open-settings").click();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.settingsImported("backup.urxf", expected.applied)), {
      timeout: 15_000,
    });

    shell.answer("plugin:dialog|save", "/tmp/imported.json");
    shell.answer("write_text_file", null);
    $("btn-save").click();
    await vi.waitFor(() => expect(shell.count("write_text_file")).toBe(1), { timeout: 10_000 });
    const { nodeParams, connections } = JSON.parse(
      (shell.args[shell.invokes.indexOf("write_text_file")] as { contents: string }).contents,
    ) as Plan;
    const pan = (to: string): number | undefined =>
      connections.find((c) => c.from === "ch1:out" && c.to === to)?.params?.pan;
    // The premise: the file put the plan in the state a load would have set.
    expect(nodeParams["bus.mix1"]?.panLink).toBe(true);
    expect(pan("bus.stereo:in")).toBe(20);
    expect(pan("bus.mix1:in")).toBe(40);
    expect(shell.count("vd_set")).toBe(0);
  });

  // The file names no model — its header reads "URX" for every variant — so the operator
  // vouches for the one on screen. Declining that confirm must leave the plan alone, and
  // the status has to say the import did not happen.
  it("makes the operator vouch for the model, and abandons the import when declined", SLOW, async () => {
    const shell = await bootImport(sampleUrxf(), false);
    $("btn-open-settings").click();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.canceled), { timeout: 15_000 });
    expect(shell.count("read_binary_file")).toBe(1); // read, then refused — not the reverse

    // WHICH question was asked. This message is the app's only statement that a settings
    // file names no unit and that the model on screen is the operator's to check, and
    // nothing else in the repository pins it — the inventory spec puts the shell's native
    // confirms out of scope, so a version that dropped the model from that sentence would
    // ask the operator to vouch for nothing.
    expect(confirms(shell)).toEqual([t().confirm.importSettings("backup.urxf", "URX44V")]);

    // And that nothing landed. The status line cannot say so — the decline branch writes it
    // itself — and the apply mutates the plan in place without touching the shell, so no
    // command count can see it either. The "?" badge is the witness: it is drawn only from
    // the unread set an import or a readback leaves behind, and the accept case above pins
    // its non-zero side on the same surface.
    const flagged = [...$("graph-host").querySelectorAll("g.node[data-id]")].filter((g) =>
      [...g.querySelectorAll("text")].some((el) => el.textContent === "?"),
    );
    expect(flagged).toHaveLength(0);
    expect(errors(shell)).toEqual([]); // abandoned, not failed
  });

  // A dismissed file dialog is not a failure and not a cancel of anything: nothing was
  // asked and nothing happened, so the status line must not move at all.
  it("does nothing when the file dialog is dismissed", SLOW, async () => {
    const shell = await bootImport(sampleUrxf());
    shell.answer("plugin:dialog|open", null);
    const before = statusText();
    $("btn-open-settings").click();
    await invoked(shell, "plugin:dialog|open");
    await new Promise((r) => setTimeout(r, 100));
    expect(statusText()).toBe(before);
    expect(shell.count("read_binary_file")).toBe(0);
  });

  // Reading and parsing share one failure surface, which is why neither entry point
  // carries its own catch. A file that is not a settings file at all is the parser's own
  // typed refusal, and it has to arrive as a localized reason rather than as a raw code.
  it("reports a file that is not a settings file", SLOW, async () => {
    const shell = await bootImport(new Uint8Array(128));
    $("btn-open-settings").click();
    await vi.waitFor(() => expect(dialogs(shell).length).toBeGreaterThan(0), { timeout: 15_000 });
    // Exactly one dialog, and it REPORTED rather than asked: the six `error.urxf` reasons
    // share one surface, so naming the reason is what keeps this case distinct from the
    // one below rather than both passing on "some dialog appeared".
    expect(dialogs(shell)).toHaveLength(1);
    expect(errors(shell)).toEqual([t().status.settingsError(t().error.urxf.notUrxf)]);
  });

  // A well-formed file carrying only stored scenes. CURRENT is the unit's live settings and
  // the only chunk with a place in a plan — a scene's values have nowhere to go — so this
  // is a distinct refusal from "not a settings file", reached through the same surface.
  it("reports a settings file with no CURRENT chunk", SLOW, async () => {
    const shell = await bootImport(buildUrxf([{ chunk: "SCENE", block: "SCENE", label: "My Data 1", fields: [] }]));
    $("btn-open-settings").click();
    await vi.waitFor(() => expect(dialogs(shell).length).toBeGreaterThan(0), { timeout: 15_000 });
    expect(statusText()).toBe(""); // showError cleared the line rather than leaving progress on it
    expect(shell.count("vd_connect")).toBe(0);
    // The reason, not just a refusal: collapsing the six `error.urxf` messages into one,
    // or mapping this file onto `notUrxf`, would leave both cases green.
    expect(errors(shell)).toEqual([t().status.settingsError(t().error.urxf.noCurrent)]);
  });

  // During a session the import is an edit: the menu entry stays open, and what the file
  // carries goes to the unit through the session's own flush.
  it("keeps the import open while a live session is up", SLOW, async () => {
    await bootImport(sampleUrxf());
    expect($<HTMLButtonElement>("btn-open-settings").disabled).toBe(false);

    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    expect($<HTMLButtonElement>("btn-open-settings").disabled).toBe(false);
  });

  // A file that changes how the unit is clocked is asked about before anything is imported, and
  // imports nothing when the operator declines or the microSD recorder holds a file.
  describe("during a live session, the file's rate and Follow USB", () => {
    const RATE = PARAMS.SAMPLE_RATE.id;
    const FOLLOW = PARAMS.FOLLOW_USB.id;
    const unit = (followUsb: boolean, rate = 48_000, playback = 0): Record<string, number> => ({
      [`${FOLLOW}/0/0`]: followUsb ? 1 : 0,
      [`${RATE}/0/0`]: rate,
      [`${PARAMS.SD_PLAYBACK.id}/0/0`]: playback,
    });
    const file = (followUsb: boolean, rate: number): Uint8Array =>
      buildUrxf([
        {
          chunk: "CURRENT",
          block: "CSF_BACKUP",
          label: "",
          fields: [
            ...CURRENT_FIELDS,
            { id: RATE, typecode: 2, elemSize: 4, values: [rate] },
            { id: FOLLOW, typecode: 1, elemSize: 1, values: [followUsb ? 1 : 0] },
          ],
        },
      ]);
    /** The unit `seed`, the import armed with `bytes`, a session up — under the Scene only device
     *  scope where `scene` — and every confirm answered by `answer`. */
    const liveImport = async (
      bytes: Uint8Array,
      seed: Record<string, number>,
      answer: (message: string) => string | Promise<string> = () => "Ok",
      scene = false,
    ): Promise<TauriShell> => {
      const shell = (await bootApp({
        ...(scene ? { seed: { "urx-settings": JSON.stringify({ deviceScope: "scene" }) } } : {}),
        tauri: deviceCommands(
          {
            experimental_enabled: true,
            "plugin:dialog|open": PATH,
            read_binary_file: () => bytes.buffer,
            "plugin:dialog|save": null,
            "plugin:dialog|message": (a: Record<string, unknown>) =>
              a.buttons === "OkCancel" ? answer(String(a.message ?? "")) : "Ok",
          },
          seed,
        ),
      }))!;
      await vi.waitFor(() => expect($("btn-open-settings").hidden).toBe(false), { timeout: 10_000 });
      $("btn-live").click();
      await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
      return shell;
    };
    /** The values written to `paramId` from invoke `from` on, in order. */
    const written = (shell: TauriShell, paramId: number, from: number): number[] =>
      shell.invokes.flatMap((cmd, i) => {
        const a = shell.args[i] as Record<string, number> | undefined;
        return i >= from && cmd === "vd_set" && a?.paramId === paramId ? [a.value] : [];
      });
    const importNow = async (shell: TauriShell): Promise<number> => {
      const from = shell.invokes.length;
      expect(shell.emit("tauri://drag-drop", { paths: [PATH] })).toBe(1);
      await vi.waitFor(() =>
        expect(confirms(shell)).toContain(t().confirm.importSettingsLive("backup.urxf", "URX44V")),
      );
      return from;
    };
    const imported = (): Promise<void> =>
      vi.waitFor(() => expect(statusText()).toContain(t().status.settingsPartial(0, 0, 0).split(" ")[0]), {
        timeout: 15_000,
      });
    const reclock = t().confirm.reclock(formatRate(48_000), formatRate(96_000));

    it.each([
      ["off on both", false, false],
      ["on on both", true, true],
    ])(
      "asks about another rate with Follow USB %s, and writes it once agreed",
      SLOW,
      async (_, unitFollow, fileFollow) => {
        const shell = await liveImport(file(fileFollow, 96_000), unit(unitFollow));
        const from = await importNow(shell);
        await imported();
        expect(
          confirms(shell).some((m) => m.startsWith(reclock)),
          "asked as a rate chosen in the app",
        ).toBe(true);
        await vi.waitFor(() => expect(written(shell, RATE, from)).toContain(96_000), { timeout: 15_000 });
        expect(written(shell, FOLLOW, from), "Follow USB is the file's already").toEqual([]);
      },
    );

    it("imports nothing when the operator declines the re-clock", SLOW, async () => {
      const shell = await liveImport(file(false, 96_000), unit(false), (m) =>
        m.startsWith(reclock) ? "Cancel" : "Ok",
      );
      const from = await importNow(shell);
      await vi.waitFor(() => expect(statusText()).toBe(t().status.canceled), { timeout: 15_000 });
      expect(
        shell.invokes.slice(from).filter((cmd) => cmd === "vd_set"),
        "nothing was written",
      ).toEqual([]);
      expect($<HTMLSelectElement>("rate-picker").value).toBe("48000");
    });

    it.each([
      ["another rate", false, 96_000],
      ["Follow USB turned on", true, 48_000],
    ])("imports nothing for %s while the microSD recorder is recording", SLOW, async (_, fileFollow, rate) => {
      const shell = await liveImport(file(fileFollow, rate), unit(false, 48_000, 3));
      const from = await importNow(shell);
      await vi.waitFor(() => expect(errors(shell)).toContain(t().error.settingsClockDuringRecording), {
        timeout: 15_000,
      });
      expect(
        shell.invokes.slice(from).filter((cmd) => cmd === "vd_set"),
        "nothing was written",
      ).toEqual([]);
    });

    it("turns Follow USB on as the toolbar does, before the rest is written", SLOW, async () => {
      const shell = await liveImport(file(true, 48_000), unit(false));
      const from = await importNow(shell);
      await imported();
      expect(
        confirms(shell).some((m) => m.startsWith(t().confirm.followUsbOn)),
        "asked as the toolbar asks",
      ).toBe(true);
      expect(written(shell, FOLLOW, from)).toEqual([1]);
      const sets = shell.invokes.map((cmd, i) => (i >= from && cmd === "vd_set" ? i : -1)).filter((i) => i >= 0);
      expect((shell.args[sets[0]] as Record<string, number>).paramId, "Follow USB goes first").toBe(FOLLOW);
    });

    // A Follow USB write that fails ends the session with the error, and the file is not imported.
    it("imports nothing when the Follow USB write fails, and ends the session with the error", SLOW, async () => {
      const shell = await liveImport(file(true, 48_000), unit(false));
      shell.failOnce("vd_set", new Error("write refused"));
      await importNow(shell);
      await vi.waitFor(() => expect(errors(shell)).toEqual([t().status.liveError("write refused")]), {
        timeout: 15_000,
      });
      expect(live().getAttribute("aria-checked")).toBe("false");
      // The "?" badge is drawn from the unread set an import leaves, and this file leaves one.
      const flagged = [...$("graph-host").querySelectorAll("g.node[data-id]")].filter((g) =>
        [...g.querySelectorAll("text")].some((el) => el.textContent === "?"),
      );
      expect(flagged).toHaveLength(0);
    });

    it.each([
      ["agrees", "Ok", [0]],
      ["declines", "Cancel", []],
    ])(
      "asks about turning Follow USB off at the same rate, and writes it where the operator %s",
      SLOW,
      async (_, reply, follow) => {
        const off = t().confirm.followUsbOffImport(formatRate(48_000));
        const shell = await liveImport(file(false, 48_000), unit(true), (m) => (m === off ? reply : "Ok"));
        const from = await importNow(shell);
        await vi.waitFor(() => expect(confirms(shell)).toContain(off), { timeout: 15_000 });
        if (reply === "Ok") await imported();
        else await vi.waitFor(() => expect(statusText()).toBe(t().status.canceled), { timeout: 15_000 });
        expect(written(shell, FOLLOW, from)).toEqual(follow);
      },
    );

    it("turns Follow USB off before writing the file's other rate", SLOW, async () => {
      const shell = await liveImport(file(false, 96_000), unit(true));
      const from = await importNow(shell);
      await imported();
      expect(
        confirms(shell).some((m) => m.startsWith(reclock)),
        "asked about the rate",
      ).toBe(true);
      await vi.waitFor(() => expect(written(shell, RATE, from)).toContain(96_000), { timeout: 15_000 });
      const first = (id: number): number =>
        shell.invokes.findIndex(
          (cmd, i) => i >= from && cmd === "vd_set" && (shell.args[i] as Record<string, number>).paramId === id,
        );
      expect(first(FOLLOW), "Follow USB is off first").toBeLessThan(first(RATE));
    });

    it("keeps the rate under the Scene only device scope, asking nothing about it", SLOW, async () => {
      const shell = await liveImport(file(false, 96_000), unit(false), () => "Ok", true);
      const from = await importNow(shell);
      await vi.waitFor(() => expect(statusText()).toContain(t().status.settingsRateKept(formatRate(48_000))), {
        timeout: 15_000,
      });
      expect(confirms(shell).some((m) => m.startsWith(reclock))).toBe(false);
      // A rate the session took would lead the flush that writes the rest.
      await vi.waitFor(() => expect(shell.invokes.slice(from), "the import's flush").toContain("vd_set"), {
        timeout: 15_000,
      });
      expect(written(shell, RATE, from)).toEqual([]);
    });
  });

  // The confirms ask about a session or about none, and the import goes ahead only in the state
  // they asked about: one asked to write to the unit does not change the plan alone once the
  // session has ended behind it.
  it("imports nothing when the session ended behind its confirm", SLOW, async () => {
    let ended = false;
    const shell = await bootImport(sampleUrxf(), false);
    // The confirm is answered once the session has ended and given the link back.
    shell.answer("plugin:dialog|message", async (a: Record<string, unknown>) => {
      if (a.message === t().confirm.importSettingsLive("backup.urxf", "URX44V") && !ended) {
        ended = true;
        $("btn-live").click();
        await invoked(shell, "vd_disconnect");
        await vi.waitFor(() => expect($<HTMLButtonElement>("btn-fetch").disabled, "the link is back").toBe(false));
      }
      return "Ok";
    });
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    const from = shell.invokes.length;
    expect(shell.emit("tauri://drag-drop", { paths: [PATH] })).toBe(1);
    await vi.waitFor(() => expect(statusText()).toBe(t().status.canceled), { timeout: 15_000 });
    expect(ended, "the session ended behind the confirm").toBe(true);
    expect(
      shell.invokes.slice(from).filter((cmd) => cmd === "vd_set"),
      "nothing was written",
    ).toEqual([]);
  });
});

// Drag & drop, the DESKTOP delivery: the shell intercepts the drop before the webview
// sees it, so it arrives as an event carrying a real path rather than as anything the DOM
// produces. Two suites already stand either side of what that reaches — `e2e/dropzone.spec.ts`
// drives the browser delivery end to end through DOM drag events, and `src/ui/dropzone.test.ts`
// drives the shell adapter against a mocked `listenEvent` — so what is left is the ENTRY's
// own wiring: which caption, which refusal, and what each of its two registrations does with
// a real path.
//
// The `.urxf` half of that wiring cannot be reached from a browser at all: it is registered
// behind `experimentalEnabled()`, which resolves false off Tauri, so a caption naming a
// settings file and a refusal naming one are unreachable there — which is why
// `e2e/inventory.spec.ts` records `dropzone.planOrSettings` under `neverShown`. The
// live-session refusal above pins that a dropped `.urxf` reaches the import flow at all; what
// the registration HANDS it is pinned by the last case here, because that flow refuses and
// returns before it calls the reader.

describe("dropping a file onto the window", () => {
  const PLAN_PATH = "C:/urx/dropped.json";

  /** What a dropped path reads back as. The sample rate is the witness because it is read
   *  straight off the file: an emptied `connections` moves the board too, but only by the
   *  difference `ensureFixedConnections` leaves after putting the model's fixed wires back
   *  (measured on URX44V: 77 wires on the default plan, 48 on this one), so reading it
   *  means predicting that restoration. */
  // STREAMING's source is written out, as every plan the app saves carries it: a document
  // without it loads with a note leading the status line, which is not what this is about.
  const droppedPlan = JSON.stringify({
    format: "urx-router-plan",
    version: 1,
    modelId: "URX44V",
    sampleRate: 96_000,
    connections: [{ from: "bus.stereo:out", to: "bus.stream:in", kind: "source" }],
  });

  const advert = (): HTMLElement => $("dropzone");
  const caption = (): string => $("dropzone-label").textContent ?? "";
  const rate = (): string => $<HTMLSelectElement>("rate-picker").value;

  /**
   * Let a drop that was going to act get as far as its first read.
   *
   * `take()` hands the file to its handler synchronously, but every read behind it sits past
   * an `await`, so in the emit's own tick an ACCEPTED drop has read nothing and moved
   * nothing either — measured: `read_text_file` is 0 and the rate picker still says 48000
   * immediately after the drop that goes on to load. Every "and nothing happened" assertion
   * here is taken after this, or it is satisfied by the very behaviour it exists to refuse.
   *
   * What the `await` buys is exact: a timer callback runs only once the microtask queue is
   * empty, and that path holds no timer of its own. What the 100 ms buys is a guess, against
   * a read that some day arrives on a timer — so the accepted case asserts the read HAS
   * landed by then. A refusal cannot make that assertion (an absence has no command to wait
   * on), which is why the window is pinned there rather than here.
   */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100));

  /** Wait for the experimental gate to arm the settings-file import — the registration that
   *  puts `.urxf` on the drop target. The reveal of the menu entry and that registration are
   *  two statements of one synchronous block (only the link-stats view sits between them),
   *  so the entry showing means the extension is taken. */
  const armed = (): Promise<void> =>
    vi.waitFor(() => expect($("btn-open-settings").hidden).toBe(false), { timeout: 10_000 });

  it("raises the advert on a drag, and takes it back down", SLOW, async () => {
    const shell = await bootDevice();
    expect(advert().hidden).toBe(true);

    // One handler, not zero: an event nobody listens for would leave every assertion
    // below describing an app that was never asked to do anything.
    expect(shell.emit("tauri://drag-enter")).toBe(1);
    expect(advert().hidden).toBe(false);

    expect(shell.emit("tauri://drag-leave")).toBe(1);
    expect(advert().hidden).toBe(true);
  });

  // The caption is re-read on every drag rather than composed once, which is what lets a
  // gate that settles after startup change it — so the gate is held open here and released
  // mid-case. Two boots could not say this: a build that composed the caption at its first
  // drag would print the right string in each of them, and be wrong only where the answer
  // changes under a page that is already up. `e2e/inventory.spec.ts` records
  // `dropzone.planOrSettings` as never shown on the DOM drag path, so this is also the one
  // place it is displayed.
  it("re-reads the caption, so arming the settings import changes what it offers", SLOW, async () => {
    let arm = (): void => {};
    const gate = new Promise<boolean>((resolve) => void (arm = () => resolve(true)));
    const shell = await bootDevice({ experimental_enabled: () => gate });

    expect(shell.emit("tauri://drag-enter")).toBe(1);
    expect(caption()).toBe(t().dropzone.plan);
    expect(shell.emit("tauri://drag-leave")).toBe(1);

    arm();
    await armed();
    expect(shell.emit("tauri://drag-enter")).toBe(1);
    expect(caption()).toBe(t().dropzone.planOrSettings);
  });

  // A refused drop is a routine "not that file": the status line says which file and what
  // this build would have taken, and nothing is read to find that out.
  it("refuses an extension nothing is registered for, by name and before reading", SLOW, async () => {
    const shell = await bootDevice();
    expect(shell.emit("tauri://drag-enter")).toBe(1);

    expect(shell.emit("tauri://drag-drop", { paths: ["C:/urx/notes.txt"] })).toBe(1);
    expect(statusText()).toBe(t().status.dropUnsupported("notes.txt"));
    // The advert comes down with the refusal — left up it would cover the app, and the
    // status line saying why would be behind it.
    expect(advert().hidden).toBe(true);

    // Matched to a handler before the file was opened, so an extension nothing takes cannot
    // arrive later as a parse error. Neither read command is in the stub's table, so a build
    // that read this file would be REFUSED by the shell and report it — which is what the
    // dialog assertion catches, and why these three are worth having together.
    await settle();
    expect(shell.count("read_text_file")).toBe(0);
    expect(shell.count("read_binary_file")).toBe(0);
    expect(dialogs(shell)).toEqual([]); // the status line, not a modal
  });

  // Same refusal with the settings import armed, and it has to name the second extension:
  // the message that does not is a build lying about what it accepts. It also says the
  // match is by extension rather than a fallback — `.txt` is refused with a handler present.
  it("names the settings file in that refusal too, once the import is armed", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true });
    await armed();

    expect(shell.emit("tauri://drag-drop", { paths: ["C:/urx/notes.txt"] })).toBe(1);
    expect(statusText()).toBe(t().status.dropUnsupportedSettings("notes.txt"));

    await settle();
    expect(shell.count("read_binary_file")).toBe(0);
    expect(dialogs(shell)).toEqual([]);
  });

  // The other refusal. Its message names no file — which one was meant to win is exactly
  // what the app will not guess — so what it can be held to is that neither was opened.
  it("refuses more than one file at a time, and reads none of them", SLOW, async () => {
    const shell = await bootDevice({ read_text_file: () => droppedPlan });

    expect(shell.emit("tauri://drag-drop", { paths: [PLAN_PATH, "C:/urx/second.json"] })).toBe(1);
    expect(statusText()).toBe(t().status.dropMultiple);

    await settle();
    expect(shell.count("read_text_file")).toBe(0);
    expect(rate()).toBe("48000"); // the plan on the board, untouched
  });

  // The accepted half, and the part a browser drop cannot have: the shell hands over a
  // real path, so the plan lands the way File > Open lands one — named on the status line
  // and remembered in the recent list. That last half is asserted nowhere else in the entry
  // suites — `main.boot.test.ts`'s Open case reaches `rememberRecent` and then reads only the
  // status line — and the path here is the only one that arrived from a read: the other file
  // flows mock `core/storage`, so the path they carry is the mock's own.
  it("opens a dropped plan and remembers where it came from", SLOW, async () => {
    const shell = await bootDevice({ read_text_file: () => droppedPlan });
    expect(rate()).toBe("48000"); // the plan the drop replaces

    expect(shell.emit("tauri://drag-drop", { paths: [PLAN_PATH] })).toBe(1);
    // The window the refusals above measure their absences in — asserted from the one side
    // that can: by the time a settle is over, the drop that WAS going to read has read.
    await settle();
    expect(shell.count("read_text_file")).toBe(1);

    await vi.waitFor(() => expect(statusText()).toBe(t().status.openedFrom("dropped.json")), { timeout: 10_000 });
    // The dropped document is what is on screen, not just what the status line names.
    expect(rate()).toBe("96000");

    const rows = [...$("inspector").querySelectorAll(".recent-row")].map((row) => row.textContent ?? "");
    expect(rows.some((text) => text.includes("dropped.json"))).toBe(true);
    expect(localStorage.getItem("urx-recent")).toContain(PLAN_PATH);
  });

  // A file dragged onto the MIDI control window is raised by the shell for THAT window, and
  // this window takes only the drag events raised for itself: no advert and no load follow
  // here. The same drop raised for this window is the positive control — without it a stub
  // that delivered nothing would satisfy every absence above it.
  it("ignores a file dropped on the MIDI control window", SLOW, async () => {
    const shell = await bootDevice({ read_text_file: () => droppedPlan });

    expect(shell.emit("tauri://drag-enter", undefined, "midi")).toBe(0);
    expect(advert().hidden).toBe(true);
    expect(shell.emit("tauri://drag-drop", { paths: [PLAN_PATH] }, "midi")).toBe(0);
    await settle();
    expect(shell.count("read_text_file")).toBe(0);
    expect(rate()).toBe("48000");

    expect(shell.emit("tauri://drag-drop", { paths: [PLAN_PATH] })).toBe(1);
    await vi.waitFor(() => expect(rate()).toBe("96000"), { timeout: 10_000 });
  });

  // A file is a load as a link is: a document naming no STREAMING source opens with the STEREO
  // a new plan carries, drawn on the board, and the note leads the line that names the file.
  it("gives a dropped plan naming no STREAMING source STEREO, and says so ahead of the file", SLOW, async () => {
    const bare = JSON.stringify({ ...JSON.parse(droppedPlan), connections: [] });
    const shell = await bootDevice({ read_text_file: () => bare });

    expect(shell.emit("tauri://drag-drop", { paths: [PLAN_PATH] })).toBe(1);
    await vi.waitFor(() => expect(rate()).toBe("96000"), { timeout: 10_000 });
    expect(statusText()).toBe([t().status.streamingSourceSupplied, t().status.openedFrom("dropped.json")].join(" — "));
    const drawn = $("graph-host").querySelectorAll('.wire-hit[data-to="bus.stream:in"]');
    expect([...drawn].map((w) => (w as SVGElement).dataset.from)).toEqual(["bus.stereo:out"]);
  });

  // The other side of that memory: the entry remembers a path only once the plan behind it
  // has actually loaded. A list that collected every path dropped at it would offer rows
  // that reproduce the same failure on every press.
  it("does not remember a dropped file that would not open", SLOW, async () => {
    const shell = await bootDevice({ read_text_file: () => "{" });

    expect(shell.emit("tauri://drag-drop", { paths: [PLAN_PATH] })).toBe(1);
    await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 10_000 });

    expect(localStorage.getItem("urx-recent") ?? "").not.toContain(PLAN_PATH);
    expect($("inspector").querySelector(".recent-row")).toBeNull();
  });

  // The `.urxf` registration's payload, which the live-session refusal above cannot reach:
  // that flow returns before it calls the reader at all. Declined at the confirm, because
  // reaching the confirm is already the whole claim — the bytes were read and parsed by
  // then — and the file name in that question comes from the drop's own payload, while the
  // menu entry composes it from the dialog's path instead.
  it("reads a dropped settings file, and names it where the operator vouches for the model", SLOW, async () => {
    const bytes = sampleUrxf();
    const shell = await bootDevice({ experimental_enabled: true, read_binary_file: () => bytes.buffer }, false);
    await armed();

    expect(shell.emit("tauri://drag-drop", { paths: ["C:/urx/backup.urxf"] })).toBe(1);
    await vi.waitFor(() => expect(statusText()).toBe(t().status.canceled), { timeout: 15_000 });

    expect(shell.count("read_binary_file")).toBe(1);
    expect(confirms(shell)).toEqual([t().confirm.importSettings("backup.urxf", "URX44V")]);
  });
});

// While a MIX bus's Pan Link is on, the unit holds each send pan into it at its source's own PAN /
// BAL and the write sends none of them. A document loaded from a file sets them there, as a link
// does (main.flows.test.ts), whichever way the file arrives: the Open dialog, a drop, or a
// scene-scoped document opened over the plan on screen. A device read and the unit's own
// settings file bring the unit's values in, and those are kept as they arrive.

describe("a linked MIX's send pans on load", () => {
  /** CH 1 at R20 and CH 2 at L13 with both sends into MIX 1 at R40, MIX 1's Pan Link on. */
  const linkedPlan = (): Plan => {
    const plan = defaultPlan("URX44V");
    plan.nodeParams["bus.mix1"] = { ...plan.nodeParams["bus.mix1"], panLink: true };
    const pan = (from: string, to: string, value: number): void => {
      const c = plan.connections.find((w) => w.from === `${from}:out` && w.to === `${to}:in`)!;
      c.params = { ...c.params, pan: value };
    };
    pan("ch1", "bus.stereo", 20);
    pan("ch2", "bus.stereo", -13);
    pan("ch1", "bus.mix1", 40);
    pan("ch2", "bus.mix1", 40);
    return plan;
  };
  const document = async (sceneOnly = false): Promise<string> => {
    const { serialize } = await import("./core/plan");
    return serialize(linkedPlan(), sceneOnly ? { sceneOnly: true } : {});
  };
  /** The plan on screen, read back through a save. */
  const savedPlan = async (shell: TauriShell): Promise<Plan> => {
    shell.answer("plugin:dialog|save", "/tmp/linked-saved.json");
    shell.answer("write_text_file", null);
    const before = shell.count("write_text_file");
    $("btn-save").click();
    await vi.waitFor(() => expect(shell.count("write_text_file")).toBe(before + 1), { timeout: 10_000 });
    return JSON.parse((shell.args[shell.invokes.lastIndexOf("write_text_file")] as { contents: string }).contents);
  };
  /** The pan on each wire from CH 1 and CH 2 into `to`. */
  const pansInto = (plan: Plan, to = "bus.mix1:in"): Record<string, number | undefined> =>
    Object.fromEntries(
      plan.connections
        .filter((c) => (c.from === "ch1:out" || c.from === "ch2:out") && c.to === to)
        .map((c) => [c.from, c.params?.pan]),
    );
  const savedSendPans = async (shell: TauriShell): Promise<Record<string, number | undefined>> =>
    pansInto(await savedPlan(shell));
  const aligned = (file: string): string =>
    [t().status.linkedSendPansAligned(2), t().status.openedFrom(file)].join(" — ");

  it("sets them on a plan opened from the Open dialog", SLOW, async () => {
    const text = await document();
    const shell = await bootDevice({ "plugin:dialog|open": "C:/urx/linked.json", read_text_file: () => text });
    $("btn-open").click();
    await vi.waitFor(() => expect(statusText()).toBe(aligned("linked.json")), { timeout: 10_000 });
    expect(await savedSendPans(shell)).toEqual({ "ch1:out": 20, "ch2:out": -13 });
  });

  it("sets them on a dropped plan", SLOW, async () => {
    const text = await document();
    const shell = await bootDevice({ read_text_file: () => text });
    expect(shell.emit("tauri://drag-drop", { paths: ["C:/urx/linked.json"] })).toBe(1);
    await vi.waitFor(() => expect(statusText()).toBe(aligned("linked.json")), { timeout: 10_000 });
    expect(await savedSendPans(shell)).toEqual({ "ch1:out": 20, "ch2:out": -13 });
  });

  // MIX 1's Pan Link and every send are inside the scene, so they come from the document and not
  // from the plan on screen, and the load sets them the same way.
  it("sets them on a scene-scoped document opened over a plan", SLOW, async () => {
    const text = await document(true);
    const shell = await bootDevice({ read_text_file: () => text });
    expect(shell.emit("tauri://drag-drop", { paths: ["C:/urx/scene.json"] })).toBe(1);
    await vi.waitFor(() => expect(statusText()).toBe(aligned("scene.json")), { timeout: 10_000 });
    expect(await savedSendPans(shell)).toEqual({ "ch1:out": 20, "ch2:out": -13 });
  });

  it("keeps them as a dropped plan wrote them where MIX 1's Pan Link is off", SLOW, async () => {
    const { serialize } = await import("./core/plan");
    const plan = linkedPlan();
    plan.nodeParams["bus.mix1"] = { ...plan.nodeParams["bus.mix1"], panLink: false };
    const shell = await bootDevice({ read_text_file: () => serialize(plan) });
    expect(shell.emit("tauri://drag-drop", { paths: ["C:/urx/unlinked.json"] })).toBe(1);
    await vi.waitFor(() => expect(statusText()).toBe(t().status.openedFrom("unlinked.json")), { timeout: 10_000 });
    expect(await savedSendPans(shell)).toEqual({ "ch1:out": 40, "ch2:out": 40 });
  });

  // A unit whose MIX 1 Pan Link is on, reporting a CH 1 send pan other than CH 1's PAN. The read
  // takes what the unit reports rather than the load's value.
  it("keeps what a Fetch reads", SLOW, async () => {
    const shell = await bootDevice({}, true, { "589/0/0": 1, "141/0/0": 20, "147/0/0": 40, "153/0/0": 40 });
    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");
    await fetchEnded();
    expect(statusText()).not.toContain(t().status.linkedSendPansAligned(1));
    const plan = await savedPlan(shell);
    // The premise: the read took the state a load would have set, Pan Link on and CH 1 at R20.
    expect(plan.nodeParams["bus.mix1"]?.panLink).toBe(true);
    expect(pansInto(plan, "bus.stereo:in")["ch1:out"]).toBe(20);
    expect(pansInto(plan)["ch1:out"]).toBe(40);
  });
});

// A document that needs a decision opens a report whose "Load anyway" runs later, from the
// modal, after the flow that opened it has let the latch go. Two surfaces still reach the plan
// under the modal — a MIDI controller and a drop — so the proceed asks again what the opening
// flow asked, and a replaced plan takes the report down with it.

describe("a load report's Load anyway", () => {
  const CC = 24;
  /** A plan two mono channels claim one 1-of insert-FX slot in: it loads only on request. */
  const contended = async (): Promise<string> => {
    const { serialize } = await import("./core/plan");
    const plan = defaultPlan("URX44V");
    const params = plan.nodeParams as Record<string, Record<string, unknown>>;
    params.ch1 = { ...params.ch1, insertFx: 512 };
    params.ch3 = { ...params.ch3, insertFx: 512 };
    return serialize(plan);
  };
  const bootWith = async (files: Record<string, string>, agree: (m: string) => boolean): Promise<TauriShell> =>
    (await bootApp({
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
        "plugin:dialog|message": byMessage(agree),
        midi_list_inputs: ["Controller In"],
        midi_open_input: null,
        midi_close_input: null,
        read_text_file: (a: Record<string, unknown>) => files[String(a.path)],
      }),
    }))!;
  const proceed = (): HTMLButtonElement => $("load-report").querySelector<HTMLButtonElement>("#load-report-proceed")!;

  it("asks the discard confirm again for an edit made while the report was up", SLOW, async () => {
    const shell = await bootWith({ "C:/urx/contended.json": await contended() }, () => false);
    await invoked(shell, "midi_open_input");
    expect(shell.emit("tauri://drag-drop", { paths: ["C:/urx/contended.json"] })).toBe(1);
    await vi.waitFor(() => expect($("load-report").hidden).toBe(false), { timeout: 10_000 });

    const opened = shell.args[shell.invokes.indexOf("midi_open_input")] as {
      channel: { onmessage: (d: unknown) => void };
    };
    opened.channel.onmessage([{ bytes: [0xb0, CC, 127] }]);
    // The edit landed: CH 1 is muted, and its main send is drawn dashed.
    await vi.waitFor(
      () =>
        expect(
          $("graph-host")
            .querySelector('g:has(> .wire-hit[data-from="ch1:out"][data-to="bus.stereo:in"]) path:not(.wire-hit)')
            ?.getAttribute("stroke-dasharray"),
        ).toBe("1.5 4"),
      { timeout: 10_000 },
    );
    expect(confirms(shell)).toEqual([]);
    proceed().click();
    // Declined: the document does not load over the edit.
    await vi.waitFor(() => expect(confirms(shell)).toEqual([t().confirm.discard]), { timeout: 10_000 });
    expect(statusText()).not.toBe(t().status.openedFrom("contended.json"));
  });

  it("takes the report down when another plan replaces the one it was about", SLOW, async () => {
    const { serialize } = await import("./core/plan");
    const shell = await bootWith(
      { "C:/urx/contended.json": await contended(), "C:/urx/other.json": serialize(defaultPlan("URX44V")) },
      () => true,
    );
    expect(shell.emit("tauri://drag-drop", { paths: ["C:/urx/contended.json"] })).toBe(1);
    await vi.waitFor(() => expect($("load-report").hidden).toBe(false), { timeout: 10_000 });
    expect(shell.emit("tauri://drag-drop", { paths: ["C:/urx/other.json"] })).toBe(1);
    await vi.waitFor(() => expect(statusText()).toBe(t().status.openedFrom("other.json")), { timeout: 10_000 });
    expect($("load-report").hidden).toBe(true);
  });
});
