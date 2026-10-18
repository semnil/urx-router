// @vitest-environment jsdom

// External MIDI control against the device link.
//
// The setup, the teardown and the helpers every desktop case shares are `main.device.test-util.ts`'s,
// which also states what the device table does and does not model.

import { describe, expect, it, vi } from "vitest";
import { $, bootApp, deviceCommands, statusText, unwrittenRead } from "./main.test-util";
import type { TauriShell } from "./main.test-util";
import { PARAMS } from "./core/control/params";
import { channelControl } from "./core/control/translate";
import { getModel } from "./models";
import { press, wireHit } from "./ui/graph.test-util";
import { buildUrxf } from "./core/control/urxf.test-util";
import type { Field } from "./core/control/urxf.test-util";
import { t } from "./i18n";
import {
  SLOW,
  invoked,
  live,
  fetchEnded,
  row,
  selectNode,
  stripsNamed,
  confirms,
  errors,
  invariantOf,
  WRITE_ASK,
  connectAs,
} from "./main.device.test-util";

// The same delay time, turned from a MIDI controller, goes to the unit over the session too; and a
// MIDI CUE switches the strip's flag while the session is up, as on the glass.

describe("a MIDI control during Live sync", () => {
  const DELAY_CC = 27;
  const CUE_CC = 28;
  const seed = { [`${PARAMS.FX_EFFECT_TYPE.id}/0/0`]: 1024, "681/0/4": 1, "681/0/6": 5000 };
  const setsOf = (shell: TauriShell, paramId: number): [number, number][] =>
    shell.invokes.flatMap((cmd, i) => {
      const a = shell.args[i] as Record<string, number>;
      return cmd === "vd_set" && a.paramId === paramId ? [[a.y, a.value] as [number, number]] : [];
    });
  const bootMidi = async (): Promise<TauriShell> => {
    const shell = (await bootApp({
      seed: {
        "urx-midi": JSON.stringify({
          input: "Controller In",
          models: {
            URX44V: [
              {
                control: "bus.fx1/fx@fx.delay",
                addr: { type: "cc", channel: 0, controller: DELAY_CC },
                mode: "absolute",
              },
              {
                control: "ch1/cue",
                addr: { type: "cc", channel: 0, controller: CUE_CC },
                mode: "absolute",
                button: "edge",
              },
            ],
          },
        }),
      },
      tauri: deviceCommands(
        {
          "plugin:dialog|message": "Ok",
          midi_list_inputs: ["Controller In"],
          midi_open_input: null,
          midi_close_input: null,
        },
        seed,
      ),
    }))!;
    await invoked(shell, "midi_open_input");
    return shell;
  };
  const sendCc = (shell: TauriShell, cc: number, value: number): void =>
    (
      shell.args[shell.invokes.indexOf("midi_open_input")] as { channel: { onmessage: (d: unknown) => void } }
    ).channel.onmessage([{ bytes: [0xb0, cc, value] }]);

  it("writes a Sync-driven delay time and a CUE to the unit", SLOW, async () => {
    const shell = await bootMidi();
    live().click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });
    sendCc(shell, DELAY_CC, 32);
    await vi.waitFor(() => expect(setsOf(shell, 681).filter(([y]) => y === 6)).toHaveLength(1), { timeout: 10_000 });
    expect(
      setsOf(shell, 681).some(([y]) => y === 4),
      "Sync is left as it is",
    ).toBe(false);
    sendCc(shell, CUE_CC, 127);
    await vi.waitFor(() => expect(setsOf(shell, PARAMS.CUE_MONO.id)).toEqual([[0, 1]]), { timeout: 10_000 });
  });
});

// A MIDI edit is an app edit: it goes through the history like any other, so it is undoable
// and its keys are recorded as the operator's — which is what keeps the write confirm from
// naming the strip the operator moved as one carrying "settings you did not edit".

describe("an edit made through MIDI", () => {
  const CC = 25;
  const bootMidi = async (): Promise<TauriShell> => {
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
      tauri: deviceCommands(
        {
          "plugin:dialog|message": "Ok",
          midi_list_inputs: ["Controller In"],
          midi_open_input: null,
          midi_close_input: null,
        },
        { [`${PARAMS.SAMPLE_RATE.id}/0/0`]: 48_000 },
      ),
    }))!;
    await invoked(shell, "midi_open_input");
    return shell;
  };
  const sendCc = (shell: TauriShell): void =>
    (
      shell.args[shell.invokes.indexOf("midi_open_input")] as { channel: { onmessage: (d: unknown) => void } }
    ).channel.onmessage([{ bytes: [0xb0, CC, 127] }]);
  const mainSendDash = (): string | null | undefined =>
    $("graph-host")
      .querySelector('g:has(> .wire-hit[data-from="ch1:out"][data-to="bus.stereo:in"]) path:not(.wire-hit)')
      ?.getAttribute("stroke-dasharray");
  /** A press and release on the window, the boundary a click anywhere is: it closes the open
   *  entry one macrotask later, and the timer below is queued behind that one. */
  const boundary = async (): Promise<void> => {
    window.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 9 }));
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 9 }));
    await new Promise((r) => setTimeout(r, 0));
  };

  it("is not named by the write confirm as a setting the operator did not edit", SLOW, async () => {
    const { fullLabel } = await import("./models/types");
    const shell = await bootMidi();
    // A first write puts the unit on the plan, so the second one carries the MIDI edit alone.
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    await vi.waitFor(() => expect($("btn-write").textContent).toBe(t().toolbar.writeDevice), { timeout: 20_000 });
    sendCc(shell);
    await vi.waitFor(() => expect(mainSendDash()).toBe("1.5 4"), { timeout: 10_000 });
    await boundary();

    $("btn-write").click();
    await invoked(shell, "vd_disconnect", 2);
    const asked = confirms(shell).filter((m) => m.includes(WRITE_ASK));
    expect(asked, "the premise: both writes asked").toHaveLength(2);
    expect(asked[1]).toContain(invariantOf(t().confirm.write(1)));
    const ch1 = getModel("URX44V").nodes.find((n) => n.id === "ch1")!;
    expect(stripsNamed(asked[0]), "the premise: the first write names the strip").toContain(fullLabel(ch1));
    expect(stripsNamed(asked[1])).not.toContain(fullLabel(ch1));
  });

  it("is undone by Ctrl+Z", SLOW, async () => {
    const shell = await bootMidi();
    expect(mainSendDash(), "the premise: the send is drawn live").toBeNull();
    sendCc(shell);
    await vi.waitFor(() => expect(mainSendDash()).toBe("1.5 4"), { timeout: 10_000 });
    await boundary();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(mainSendDash()).toBeNull(), { timeout: 10_000 });
  });
});

// What the app may state to a MIDI controller, and when. The values it would send are
// the PLAN's, and until a Live-sync readback settles, the plan is whatever was loaded —
// a new document's defaults, a file, a half-applied read. On a loopback or a shared bus
// those go out as an operator's gesture to every other listener: a second instance of
// this app took one for input and wrote it to the unit, putting CH 1's gain from +66 dB
// to its minimum with the channel unmuted.
//
// The rule is wired here rather than only inside MidiControl, and this is the seam that
// sees the wiring: the class cannot tell whether the session it was told about actually
// came up.

describe("MIDI feedback and the live session", () => {
  const MIDI_PORT = { midi_list_outputs: ["Controller Out"], midi_open_output: null, midi_send: null };
  const MIDI_SEED = {
    "urx-midi": JSON.stringify({
      output: "Controller Out",
      // ch1/gain rather than a send level: the inspector edits it directly, which is how
      // the live-off half below moves a MAPPED value and so has something a pass would
      // carry — without that, a pass finding nothing to send looks like a closed output.
      models: {
        URX44V: [{ control: "ch1/gain", addr: { type: "cc", channel: 0, controller: 7 }, mode: "absolute" }],
        URX88: [{ control: "ch1/gain", addr: { type: "cc", channel: 0, controller: 7 }, mode: "absolute" }],
      },
    }),
  };

  const bootWithController = async (over: Record<string, unknown> = {}): Promise<TauriShell> =>
    (await bootApp({
      seed: MIDI_SEED,
      tauri: deviceCommands({ "plugin:dialog|message": "Ok", ...MIDI_PORT, ...over }),
    }))!;

  it("sends nothing to the controller until a live readback settles, then sends", SLOW, async () => {
    const shell = await bootWithController(connectAs("URX44V"));
    // The port is open and the mapping resolves — so the silence below is this rule and
    // not a controller the harness never connected.
    await invoked(shell, "midi_open_output");
    expect(shell.count("midi_send")).toBe(0);

    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), SLOW);
    await vi.waitFor(() => expect(shell.count("midi_send")).toBeGreaterThan(0));

    // And closes again when the session ends. The edit below MOVES a mapped value, so a
    // pass that ran would carry it: the count staying put is the output side being shut
    // rather than a pass finding nothing.
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("false"));
    const sentWhileLive = shell.count("midi_send");

    selectNode("ch1");
    const gain = row(t().inspector.gainAnalog).querySelector<HTMLInputElement>("input")!;
    gain.value = String(Number(gain.value) === 20 ? 30 : 20);
    gain.dispatchEvent(new Event("input", { bubbles: true }));
    gain.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300)); // past the feedback debounce
    expect(shell.count("midi_send")).toBe(sentWhileLive);
  });

  // The shape the guard is actually placed against: device values ARE in the plan when
  // the flow reaches the same `finally` a settled read reaches, and the session is not
  // up. Only `liveSessionUp` separates the two, so this is the case that goes red if the
  // re-send is moved back beside planReadFromDevice — where it sits one line away.
  it("stays silent when a partial readback refuses the session", SLOW, async () => {
    let reads = 0;
    const shell = await bootWithController({
      ...connectAs("URX44V"),
      vd_get: (): number => {
        reads++;
        if (reads === 1) throw new Error("read refused"); // one bad read is a partial plan
        return 0;
      },
    });
    await invoked(shell, "midi_open_output");

    $("btn-live").click();
    await invoked(shell, "vd_disconnect");
    expect(live().getAttribute("aria-checked")).not.toBe("true");
    expect(shell.count("vd_params_subscribe")).toBe(0); // the session never registered
    expect(errors(shell).length).toBeGreaterThan(0); // and said so
    expect(shell.count("midi_send")).toBe(0);
  });

  // A device fetch and a settings-file import both move mapped values, and neither opens the
  // output side: a fetch's plan agreed with the unit at the instant of its read and nothing holds
  // it there afterwards, and a file holds what some unit held when it was saved. The live start
  // behind each is the positive control — the same port and mapping do send once a session's
  // read settles. Both flows set CH 1's fader to -6 dB, so a pass that ran would carry it.
  for (const flow of ["fetch", "settings-file import"] as const)
    it(`stays silent after a ${flow}, and sends once a session starts`, SLOW, async () => {
      const fader = channelControl(getModel("URX44V"), "ch1")!.fader;
      let file: Uint8Array | null = null;
      let applied = 0;
      if (flow === "settings-file import") {
        // A whole file, built the way the import cases build theirs.
        const { applySourceState } = await import("./core/control/readback");
        const { defaultPlan } = await import("./models/initial-state");
        const value = (id: number, y: number): number =>
          id === PARAMS.SAMPLE_RATE.id
            ? 48_000
            : id === fader && y === 0
              ? -600
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
        applied = expected.applied;
        const fields = [...asked].map(([id, a]): Field =>
          a.str
            ? { id, typecode: 4, elemSize: 16, values: Array<string>(a.len).fill("") }
            : (() => {
                const values = Array.from({ length: a.len }, (_, y) => value(id, y));
                return { id, typecode: values.some((v) => v > 0x7fffffff) ? 1 : 2, elemSize: 4, values };
              })(),
        );
        file = buildUrxf([{ chunk: "CURRENT", block: "CSF_BACKUP", label: "", fields }]);
      }
      const shell = (await bootApp({
        seed: {
          "urx-midi": JSON.stringify({
            output: "Controller Out",
            models: {
              URX44V: [{ control: "ch1/level", addr: { type: "cc", channel: 0, controller: 7 }, mode: "absolute" }],
            },
          }),
        },
        tauri: deviceCommands(
          {
            "plugin:dialog|message": "Ok",
            ...MIDI_PORT,
            ...connectAs("URX44V"),
            ...(file
              ? {
                  experimental_enabled: true,
                  "plugin:dialog|open": "C:/urx/backup.urxf",
                  read_binary_file: () => file!.buffer,
                  "plugin:dialog|save": null,
                }
              : {}),
          },
          file ? {} : { [`${fader}/0/0`]: -600 },
        ),
      }))!;
      await invoked(shell, "midi_open_output");
      // CH 1's main fader as the CONSOLE states it.
      $("btn-view-console").click();
      const ch1Level = (): string | null =>
        $("console-host").querySelector(".con-strip")!.querySelector(".con-fader")!.getAttribute("aria-valuenow");
      await vi.waitFor(() => expect(ch1Level()).not.toBeNull(), { timeout: 10_000 });
      expect(ch1Level(), "the premise: the flow moves the mapped fader").not.toBe("-6");

      if (file) {
        await vi.waitFor(() => expect($("btn-open-settings").hidden).toBe(false), { timeout: 10_000 });
        $("btn-open-settings").click();
        await vi.waitFor(() => expect(statusText()).toBe(t().status.settingsImported("backup.urxf", applied)), {
          timeout: 15_000,
        });
      } else {
        $("btn-fetch").click();
        await invoked(shell, "vd_disconnect");
        await fetchEnded();
      }
      await vi.waitFor(() => expect(ch1Level()).toBe("-6"), { timeout: 10_000 });
      await new Promise((r) => setTimeout(r, 300)); // past the feedback debounce
      expect(shell.count("midi_send")).toBe(0);

      $("btn-live").click();
      await vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), SLOW);
      await vi.waitFor(() => expect(shell.count("midi_send")).toBeGreaterThan(0));
    });

  it("stays silent when the live session fails on the way up", SLOW, async () => {
    // Unknown model: the read never runs, and the flow lands in the same `finally` a
    // settled one does. What separates them is the session, which is why the re-send
    // hangs off that rather than off reaching the block.
    const shell = await bootWithController(connectAs("URX88"));
    await invoked(shell, "midi_open_output");

    $("btn-live").click();
    await invoked(shell, "vd_disconnect");
    expect(errors(shell)).toEqual([t().status.liveError(t().error.unknownModel("URX88"))]);
    expect(shell.count("midi_send")).toBe(0);
  });
});

// An incoming MIDI edit repaints through the direct-follow reflect, which repaints only
// the nodes `inspectorNodes` names — and a Ducker's on/off is the one thing MIDI can move
// on a node that the selection need not mention at all. That branch needs a shell, so the
// panel's own suite cannot reach it: inspector.test.ts pins the footprint, and this is the
// wiring that consumes it. A device-side Ducker change takes the other branch (no ducker
// param follows directly) and refreshes the panel wholesale.

describe("a Ducker moved over MIDI repaints the inspector", () => {
  const DUCKER = "out.ducker1"; // hangs off CH 5/6 (models/build.ts)
  const CC = 20;

  const bootWithPad = async (): Promise<TauriShell> =>
    (await bootApp({
      seed: {
        "urx-midi": JSON.stringify({
          input: "Controller In",
          models: {
            URX44V: [
              {
                control: `${DUCKER}/duckerOn`,
                addr: { type: "cc", channel: 0, controller: CC },
                mode: "absolute",
                button: "edge",
              },
            ],
          },
        }),
      },
      tauri: { midi_list_inputs: ["Controller In"], midi_open_input: null, midi_close_input: null },
    }))!;

  const panelText = (): string => $("inspector").textContent ?? "";

  /** The section a title names, by its header rather than by position: the panel puts
   *  several on a node and only one of them is the Ducker's. */
  const section = (title: string): HTMLDetailsElement => {
    const found = [...$("inspector").querySelectorAll<HTMLDetailsElement>("details.insp-section")].find(
      (d) => d.querySelector(".sec-title")?.textContent === title,
    );
    expect(found, `the inspector shows a "${title}" section`).not.toBeUndefined();
    return found!;
  };

  it("drops the PRE-send note when a pad turns the Ducker off under a selected send", SLOW, async () => {
    const shell = await bootWithPad();
    await invoked(shell, "midi_open_input");

    // Reached through the app's own controls rather than a seeded plan: the Ducker's ON,
    // then the send's PRE tap, which is what makes the note apply.
    selectNode(DUCKER);
    [...section(t().inspector.duckerOn).querySelectorAll<HTMLButtonElement>(".sec-body .toggle button")]
      .find((b) => b.textContent === t().inspector.on)!
      .click();
    press(wireHit($("graph-host"), "ch_5_6:out", "bus.mix1:in")!);
    const pre = [...$("inspector").querySelectorAll<HTMLButtonElement>(".param .toggle button")].find(
      (b) => b.textContent === "PRE",
    );
    expect(pre, "the send offers a PRE / POST tap").not.toBeUndefined();
    pre!.click();
    expect(panelText()).toContain(t().inspector.duckerPreSend);

    // The pad, and nothing else: an edge toggle flips on any CC >= 64. The wire is still
    // what is selected — only the ducker node moved.
    const opened = shell.args[shell.invokes.indexOf("midi_open_input")] as {
      channel: { onmessage: (d: unknown) => void };
    };
    opened.channel.onmessage([{ bytes: [0xb0, CC, 127] }]);
    await vi.waitFor(() => {
      expect(panelText()).not.toContain(t().inspector.duckerPreSend);
    });
    // …and the send is still the selection, so the note went with the Ducker rather than
    // with the panel changing subject.
    expect(panelText()).toContain(t().inspector.prePost);
  });
});

// The canvas half of the same route, and the reason onApplied needs no repaint of its
// own: the reflect it requests redraws the wires. graph.repaintDirtyNodes ends in
// redrawWires, so a toggle's dimming lands one reflect window later without a second
// call beside the apply — which used to be there, justified by a comment saying the
// reflect "repaints nodes only".

describe("a MIDI toggle dims its wire through the reflect alone", () => {
  const CC = 22;

  it("dashes the main send it muted, with no repaint beside the apply", SLOW, async () => {
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
      tauri: { midi_list_inputs: ["Controller In"], midi_open_input: null, midi_close_input: null },
    }))!;
    await invoked(shell, "midi_open_input");

    // The painted path beside the transparent hit band, the way e2e/ducker.spec.ts
    // addresses one.
    const wire = (): SVGPathElement | null =>
      $("graph-host").querySelector<SVGPathElement>(
        'g:has(> .wire-hit[data-from="ch1:out"][data-to="bus.stereo:in"]) path:not(.wire-hit)',
      );
    // The STEREO main path, which ships at unity — the MIX sends ship at the level floor
    // and are already drawn off, so a dimming there would assert nothing.
    expect(wire(), "the CH 1 -> STEREO send is drawn").not.toBeNull();
    expect(wire()!.getAttribute("stroke-dasharray")).toBeNull();

    const opened = shell.args[shell.invokes.indexOf("midi_open_input")] as {
      channel: { onmessage: (d: unknown) => void };
    };
    opened.channel.onmessage([{ bytes: [0xb0, CC, 127] }]);
    await vi.waitFor(() => expect(wire()!.getAttribute("stroke-dasharray")).toBe("1.5 4"));
  });
});
