// @vitest-environment jsdom

// The experimental diagnostics: Compare with device and the device self-test.
//
// The setup, the teardown and the helpers every desktop case shares are `main.device.test-util.ts`'s,
// which also states what the device table does and does not model.

import { describe, expect, it, vi } from "vitest";
import { $, bootApp, deviceCommands, statusText, unwrittenRead } from "./main.test-util";
import type { TauriShell } from "./main.test-util";
import { gainToVd } from "./core/control/vd";
import { PARAMS } from "./core/control/params";
import { channelControl } from "./core/control/translate";
import { getModel } from "./models";
import { defaultPlan } from "./models/initial-state";
import { setExclusiveConnection } from "./core/plan";
import { t } from "./i18n";
import {
  SLOW,
  bootDevice,
  invoked,
  row,
  selectNode,
  captureWarnings,
  dialogs,
  confirms,
  errors,
  connectAs,
} from "./main.device.test-util";

describe("Compare with device", () => {
  const bootExperimental = (over: Record<string, unknown> = {}): Promise<TauriShell> =>
    bootDevice({ experimental_enabled: true, ...over });

  const compare = async (): Promise<HTMLButtonElement> => {
    const btn = $<HTMLButtonElement>("btn-compare");
    await vi.waitFor(() => expect(btn.hidden).toBe(false), { timeout: 10_000 });
    return btn;
  };

  // Compare writes nothing — that is the whole point of it, and the reason it can be
  // pointed at a unit whose state matters.
  it("reads the unit, reports, and writes nothing", SLOW, async () => {
    const shell = await bootExperimental();
    (await compare()).click();
    await invoked(shell, "vd_disconnect");

    expect(shell.count("vd_get")).toBeGreaterThan(100);
    expect(shell.count("vd_set")).toBe(0);
    expect(shell.count("vd_set_str")).toBe(0);
    expect(statusText()).not.toBe(t().status.compareConnecting);
  });

  // The unit keeps the input stage of every jack and source, read by a channel or not, so
  // Compare asks about all of them — a write would send only the ones some channel reads.
  it("compares the input stage of a jack no channel reads", SLOW, async () => {
    const { serialize } = await import("./core/plan");
    const doc = defaultPlan("URX44V");
    for (const ch of ["ch3", "ch4"]) setExclusiveConnection(doc, "in.micline_1_2:out", `${ch}:in`, "source");
    doc.nodeParams["in.micline_3_4"] = { ...doc.nodeParams["in.micline_3_4"], gainL: 20 };
    const url = `/?plan=${encodeURIComponent(Buffer.from(serialize(doc), "utf8").toString("base64url"))}`;
    const shell = (await bootApp({
      url,
      tauri: deviceCommands(
        { "plugin:dialog|message": "Ok", experimental_enabled: true },
        { [`${PARAMS.HA_GAIN.id}/0/2`]: gainToVd(10) },
      ),
    }))!;
    (await compare()).click();
    await invoked(shell, "vd_disconnect");
    await vi.waitFor(() => expect($("load-report").hidden).toBe(false), { timeout: 10_000 });
    expect($("load-report").textContent).toContain(
      `HA_GAIN @ ${PARAMS.HA_GAIN.id}:0:2 — plan ${gainToVd(20)}, device ${gainToVd(10)}`,
    );
    expect(shell.count("vd_set")).toBe(0);
  });

  // The report is built while connected and shown after the disconnect, so an
  // indefinite modal cannot hold the broker connection open.
  //
  // The disconnect is held unanswered to measure the order: waiting for it to be
  // INVOKED and then finding the modal proves nothing, because a regression that
  // opened the modal first would satisfy both in that same order.
  it("shows its report only after the link is closed", SLOW, async () => {
    let release = (): void => {};
    const closing = new Promise<void>((r) => (release = () => r()));
    const shell = await bootExperimental({ vd_disconnect: () => closing });
    (await compare()).click();
    await invoked(shell, "vd_disconnect");

    // The link is still open — the shell has not answered — so nothing may be up yet.
    await new Promise((r) => setTimeout(r, 100));
    expect($("load-report").hidden).toBe(true);

    release();
    await vi.waitFor(() => expect($("load-report").hidden).toBe(false), { timeout: 10_000 });
  });

  // The sweep spans seconds, and the plan on screen can be replaced while it runs. Both
  // halves of the report describe the plan the compare started on.
  it("compares the names of the plan it started on when another replaces it mid-sweep", SLOW, async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let first = true;
    const shell = await bootExperimental({
      vd_get: async (a: Record<string, unknown>) => {
        if (first) {
          first = false;
          await held;
        }
        return unwrittenRead(a);
      },
    });
    selectNode("ch1");
    const field = row(t().inspector.name).querySelector<HTMLInputElement>('input[type="text"]')!;
    field.value = "Vocal";
    field.dispatchEvent(new Event("input", { bubbles: true }));

    (await compare()).click();
    await invoked(shell, "vd_get");
    $("btn-new").click();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.newPlan), { timeout: 10_000 });
    release();
    await vi.waitFor(() => expect($("load-report").hidden).toBe(false), { timeout: 15_000 });
    expect($("load-report").textContent).toContain("Vocal");
  });

  // The button doubles as its own cancel while a run is in flight, and the label says
  // which of the two it currently is.
  it("turns into its own cancel while it runs", SLOW, async () => {
    const shell = await bootExperimental();
    shell.answer("vd_get", () => new Promise((r) => setTimeout(() => r(0), 1)));
    const btn = await compare();
    expect(btn.textContent).toBe(t().toolbar.compare);

    btn.click();
    await vi.waitFor(() => expect(btn.textContent).toBe(t().toolbar.compareCancel), { timeout: 10_000 });
    btn.click(); // cancel
    await vi.waitFor(() => expect(btn.textContent).toBe(t().toolbar.compare), { timeout: 15_000 });
    expect(shell.count("vd_set")).toBe(0);
  });
});

describe("the device self-test", () => {
  const bootExperimental = (over: Record<string, unknown> = {}, agree = true): Promise<TauriShell> =>
    bootDevice({ experimental_enabled: true, ...over }, agree);

  /** The menu entry, once the launch flag has revealed it (the gate resolves async). */
  const selfTestBtn = async (): Promise<HTMLButtonElement> => {
    const btn = $<HTMLButtonElement>("btn-selftest");
    await vi.waitFor(() => expect(btn.hidden).toBe(false), { timeout: 10_000 });
    return btn;
  };

  /**
   * Wait for a run to start and then finish, off the button's own label.
   *
   * Neither the status line nor the label alone can say this. The label already reads
   * "Self-test" before the click, so waiting for it is satisfied immediately; and the
   * status line before the run is the boot line, so "no longer running" is true then
   * too. Both edges, in order, is what makes the wait about a run that happened.
   */
  async function ranToCompletion(btn: HTMLButtonElement): Promise<void> {
    await vi.waitFor(() => expect(btn.textContent).toBe(t().toolbar.selfTestCancel), { timeout: 15_000 });
    await vi.waitFor(() => expect(btn.textContent).toBe(t().toolbar.selfTest), { timeout: 25_000 });
  }

  // The run perturbs every writable parameter and puts it back, so it confirms first.
  // Against a unit that answers reads with what was written to it the sweep converges and
  // the restore verifies, which is the PASS frame — and the count comes out of the frame
  // so the assertion pins the whole message rather than a substring.
  it("asks first, then sweeps the unit and puts it back", SLOW, async () => {
    const log = captureWarnings();
    try {
      const shell = await bootExperimental();
      const btn = await selfTestBtn();
      btn.click();
      await ranToCompletion(btn);

      const n = Number(/\d+/.exec(statusText())?.[0]);
      expect(n).toBeGreaterThan(10);
      expect(statusText()).toBe(t().status.selfTestPass(n));
      expect(log.lines.some((l) => l.startsWith("[self-test] PASS"))).toBe(true);
      // The count in the frame is what the run says it wrote; this is that the writes
      // reached the wire. A PASS reported over an empty sweep would satisfy the first.
      expect(shell.count("vd_set")).toBeGreaterThan(10);
      // The link is let go: a diagnostic that kept it would lock every other device
      // action for the rest of the launch.
      expect($<HTMLButtonElement>("btn-fetch").disabled).toBe(false);
    } finally {
      log.restore();
    }
  });

  it("writes nothing when the confirm is declined", SLOW, async () => {
    const shell = await bootExperimental({}, false);
    const btn = await selfTestBtn();
    btn.click();
    await vi.waitFor(() => expect(dialogs(shell).length).toBeGreaterThan(0), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 100));
    expect(shell.count("vd_set")).toBe(0);
    expect(btn.textContent).toBe(t().toolbar.selfTest); // the run never started
    // It ASKED. A run that threw on its way to the confirm would report an error dialog,
    // write nothing and leave the label alone — the two assertions above cannot separate
    // "declined" from "never got that far".
    expect(confirms(shell)).toHaveLength(1);
    expect(errors(shell)).toEqual([]);
  });

  // The menu entry doubles as its own cancel: the run is minutes of serial round-trips and
  // stalls entirely if the link drops, so a second click has to mean stop rather than
  // start another one. A cancel is reported as a cancel — never as a failed restore, which
  // would tell the operator their unit may be left perturbed.
  it("turns into its own cancel while it runs", SLOW, async () => {
    const log = captureWarnings();
    try {
      const shell = await bootExperimental();
      // One millisecond per write gives the run a middle. Without it the whole sweep
      // completes between two polls of waitFor and the second click lands on a run that
      // has already finished — which is how a cancel case passes while cancelling nothing.
      shell.answer("vd_set", () => new Promise((r) => setTimeout(() => r(undefined), 1)));
      const btn = await selfTestBtn();
      btn.click();
      await vi.waitFor(() => expect(btn.textContent).toBe(t().toolbar.selfTestCancel), { timeout: 15_000 });

      btn.click();
      await vi.waitFor(() => expect(statusText()).toBe(t().status.selfTestCancelled), { timeout: 25_000 });
      expect(btn.textContent).toBe(t().toolbar.selfTest);
      expect(log.lines.some((l) => l.startsWith("[self-test] CANCELLED"))).toBe(true);
    } finally {
      log.restore();
    }
  });

  // A cancel taken while the capture is still reading is a run that never wrote: the status
  // says the unit was not touched, rather than that it was left silent and needs a fetch.
  it("says a cancel taken before the first write left the unit untouched", SLOW, async () => {
    const shell = await bootExperimental();
    let ask = (): void => {};
    const asked = new Promise<void>((r) => (ask = r));
    let release = (): void => {};
    const released = new Promise<void>((r) => (release = r));
    shell.answer("vd_get", () => (ask(), released.then(() => 0)));
    const btn = await selfTestBtn();
    btn.click();
    await asked;
    expect(btn.textContent, "the premise: the run is under way").toBe(t().toolbar.selfTestCancel);

    btn.click();
    release();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.selfTestCancelledUntouched), { timeout: 25_000 });
    expect(shell.count("vd_set")).toBe(0);
    expect(btn.textContent).toBe(t().toolbar.selfTest);
  });

  // A unit of another model is a run that did not start: nothing read and nothing written. The
  // status names the mismatch, rather than reading the restore that never ran as a failed one.
  it("says a run on a unit of another model did not start", SLOW, async () => {
    const shell = await bootExperimental(connectAs("URX22"));
    const btn = await selfTestBtn();
    btn.click();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.selfTestModelMismatch("URX22", "URX44V")), {
      timeout: 25_000,
    });
    expect(shell.count("vd_set")).toBe(0);
    expect(shell.count("vd_get")).toBe(0);
  });

  // A capture that missed CH 1's strip missed the heads on it, and putting one of those back
  // after the restore would move what nothing then checks: the run does not start, and the
  // status says which refusal it was rather than the one about an address it could not read.
  it("says a run whose capture missed a setting that moves others did not start", SLOW, async () => {
    const table = deviceCommands({ "plugin:dialog|message": "Ok", experimental_enabled: true });
    const read = table.vd_get as (a: Record<string, unknown>) => number;
    const faderY = channelControl(getModel("URX44V"), "ch1")!.y;
    let failed = false;
    table.vd_get = (a: Record<string, unknown>) => {
      if (!failed && a.paramId === PARAMS.CH_FADER.id && a.y === faderY) {
        failed = true;
        throw new Error("timeout");
      }
      return read(a);
    };
    const shell = (await bootApp({ tauri: table }))!;
    const btn = await selfTestBtn();
    btn.click();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.selfTestRefusedHead), { timeout: 25_000 });
    expect(failed, "the premise: the capture's read of the fader failed").toBe(true);
    expect(shell.count("vd_set")).toBe(0);
  });

  // A run that cannot open its own link surfaces as a dialog and lets the latch go.
  it("reports a run that cannot open its own link, and holds nothing afterwards", SLOW, async () => {
    const log = captureWarnings();
    try {
      const shell = await bootExperimental({
        vd_connect: () => {
          throw new Error("no-device");
        },
      });
      const btn = await selfTestBtn();
      btn.click();
      // Read as an ERROR rather than counted. This run raises a confirm of its own first,
      // so a count here could only say "more than one arrived" and nothing about what the
      // second one told the operator. What it tells them is the DIAGNOSIS rather than a
      // self-test frame — `connectFailureStatus` recognises this failure and replaces the
      // wrapper with the message that says what to do about it.
      await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 15_000 });
      expect(errors(shell).at(-1)).toBe(t().error.shell.noDevice);
      expect(log.lines.some((l) => l.startsWith("[self-test] ERROR"))).toBe(true);
      expect(btn.textContent).toBe(t().toolbar.selfTest);
      expect($<HTMLButtonElement>("btn-fetch").disabled).toBe(false);
    } finally {
      log.restore();
    }
  });

  // More than one URX online with the selected model not singling one out: the shell
  // refuses the connect, and what reaches the operator is the diagnosis rather than a
  // self-test frame around it. The connect also has to have named the model the picker
  // holds, since that is what the shell chooses among several units by.
  it("asks the shell for the selected model and reports a connect it refuses as several units", SLOW, async () => {
    const log = captureWarnings();
    try {
      const asked: unknown[] = [];
      const shell = await bootExperimental({
        vd_connect: (args: Record<string, unknown>) => {
          asked.push(args?.model);
          throw new Error("multiple-devices: 2 online (URX44V, URX44V), 2 of them URX44V");
        },
      });
      const btn = await selfTestBtn();
      btn.click();
      await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 15_000 });
      expect(errors(shell).at(-1)).toBe(t().error.shell.multipleDevices);
      expect(asked).toEqual([$<HTMLSelectElement>("model-picker").value]);
      expect(btn.textContent).toBe(t().toolbar.selfTest);
    } finally {
      log.restore();
    }
  });

  // The --self-test launch has nobody to answer either dialog: it must not ask before
  // starting, and its report goes to the log rather than to a save dialog — in chunks,
  // since one console line carrying the whole thing risks the dev server's forwarding
  // limits.
  //
  // A report exists only when the run has something to say. URX44V carries no unconfirmed
  // mappings, so a clean run logs none; the unreadable string parameters below are what
  // gives it something, and they are read through a command of their own so the numeric
  // store — the thing that lets the sweep converge at all — is left intact.
  it("runs itself on the --self-test launch, asking nothing and logging the report", SLOW, async () => {
    const log = captureWarnings();
    try {
      const shell = await bootExperimental({
        self_test_requested: true,
        vd_get_str: () => {
          throw new Error("unreadable");
        },
      });
      await vi.waitFor(() => expect(log.lines.some((l) => l.startsWith("[self-test] report 1/"))).toBe(true), {
        timeout: 25_000,
      });
      expect(shell.count("plugin:dialog|message")).toBe(0);
    } finally {
      log.restore();
    }
  });

  // --prepare-modified spreads every writable scalar to a distinctive value and leaves it
  // there — deliberately no restore, so a scene SAVE/RECALL diff has something to show.
  // Its own status frame is untranslated on purpose (it is a diagnostic, not a surface),
  // which is why this asserts a shape rather than a catalog entry.
  it("runs the audit writer on the --prepare-modified launch and leaves the unit written", SLOW, async () => {
    const log = captureWarnings();
    try {
      const shell = await bootExperimental({ prepare_modified_requested: true });
      await vi.waitFor(() => expect(statusText()).toMatch(/^prepare-modified: wrote \d+, residual \d+$/), {
        timeout: 25_000,
      });
      expect(shell.count("vd_set")).toBeGreaterThan(10);
      expect(log.lines.some((l) => l.startsWith("[prepare-modified] DONE"))).toBe(true);
      expect($<HTMLButtonElement>("btn-fetch").disabled).toBe(false);
    } finally {
      log.restore();
    }
  });

  it("reports an audit run that cannot connect", SLOW, async () => {
    const log = captureWarnings();
    try {
      const shell = await bootExperimental({
        prepare_modified_requested: true,
        vd_connect: () => {
          throw new Error("no-device");
        },
      });
      // The log line says the run failed; this says the operator was told, and told what.
      // The two are separate surfaces on purpose — a headless launch reads the log — so a
      // regression that kept the log and dropped the dialog leaves nothing on screen.
      await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 15_000 });
      expect(errors(shell).at(-1)).toBe(t().error.shell.noDevice);
      expect(log.lines.some((l) => l.startsWith("[prepare-modified] ERROR"))).toBe(true);
      expect($<HTMLButtonElement>("btn-fetch").disabled).toBe(false);
    } finally {
      log.restore();
    }
  });
});
