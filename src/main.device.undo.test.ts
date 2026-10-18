// @vitest-environment jsdom

// The undo history across a device read, and the macOS Edit menu that reaches it.
//
// The setup, the teardown and the helpers every desktop case shares are `main.device.test-util.ts`'s,
// which also states what the device table does and does not model.

import { describe, expect, it, vi } from "vitest";
import { $, statusText, unwrittenRead } from "./main.test-util";
import type { TauriShell } from "./main.test-util";
import { PARAMS } from "./core/control/params";
import { EDIT_MENU_EVENT, EDIT_REDO_ID, EDIT_UNDO_ID } from "./core/platform";
import { t } from "./i18n";
import {
  SLOW,
  bootDevice,
  live,
  fetchEnded,
  selectNode,
  confirms,
  errors,
  byMessage,
  connectAs,
  oscFace,
  oscOn,
  pressOscOn,
  undoTo,
} from "./main.device.test-util";

// A device read that did not land leaves the undo history as it was — an entry still open
// included. The press here is held across the flow, so the edit made inside it is an open
// entry for the whole of the flow and its release is what closes it; a flow that re-based
// the history on its way out takes that entry with it, and the undo then has nothing to do.

describe("the undo history across a device read that did not land", () => {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  /** Edit the plan inside a press held across `run`, then release it once `run` has seen
   *  the flow end. */
  const editHeldAcross = async (run: () => Promise<void>): Promise<void> => {
    selectNode("bus.osc");
    await tick();
    const at = $("statusbar");
    at.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, bubbles: true }));
    pressOscOn();
    await run();
    at.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
    await tick();
  };
  /** A live start's own finally has run: the link is handed back after it. */
  const liveEnded = (): Promise<void> =>
    vi.waitFor(() => expect($<HTMLSelectElement>("rate-picker").disabled).toBe(false), { timeout: 25_000 });
  const refuseFollowUsb = (a: Record<string, unknown>): number => {
    if (a.paramId === PARAMS.FOLLOW_USB.id) throw new Error("read-refused");
    return 0;
  };
  const declineSwitch = {
    ...connectAs("URX22"),
    "plugin:dialog|message": byMessage((m) => m !== t().confirm.switchModel("URX22", "URX44V")),
  };
  const undone = async (shell: TauriShell): Promise<void> => {
    expect(oscFace(), "the premise: the edit stands").toBe("ON");
    await undoTo(shell, "OFF");
  };

  it("through a fetch whose Follow USB read fails", SLOW, async () => {
    const shell = await bootDevice({ vd_get: refuseFollowUsb });
    await editHeldAcross(async () => {
      $("btn-fetch").click();
      await vi.waitFor(() => expect(errors(shell)).toEqual([t().status.fetchError("read-refused")]), {
        timeout: 10_000,
      });
      await fetchEnded();
    });
    await undone(shell);
  });

  it("through a fetch cancelled during its Follow USB read", SLOW, async () => {
    let asked = (): void => {};
    const reading = new Promise<void>((r) => (asked = r));
    let answer = (): void => {};
    const held = new Promise<void>((r) => (answer = r));
    const shell = await bootDevice({
      vd_get: (a: Record<string, unknown>) =>
        a.paramId === PARAMS.FOLLOW_USB.id ? (asked(), held.then(() => 1)) : unwrittenRead(a),
    });
    await editHeldAcross(async () => {
      $("btn-fetch").click();
      await reading;
      $("btn-fetch").click(); // a second click cancels
      answer();
      await vi.waitFor(() => expect(statusText()).toBe(t().status.canceled), { timeout: 10_000 });
      await fetchEnded();
    });
    expect(errors(shell)).toEqual([]);
    await undone(shell);
  });

  it("through a fetch whose model switch is declined", SLOW, async () => {
    const shell = await bootDevice(declineSwitch);
    await editHeldAcross(async () => {
      $("btn-fetch").click();
      await vi.waitFor(() => expect(statusText()).toBe(t().status.canceled), { timeout: 10_000 });
      await fetchEnded();
    });
    expect(confirms(shell)).toEqual([t().confirm.discard, t().confirm.switchModel("URX22", "URX44V")]);
    await undone(shell);
  });

  it("through a live start whose Follow USB read fails", SLOW, async () => {
    const shell = await bootDevice({ vd_get: refuseFollowUsb });
    await editHeldAcross(async () => {
      live().click();
      await vi.waitFor(() => expect(errors(shell)).toEqual([t().status.liveError("read-refused")]), {
        timeout: 10_000,
      });
      await liveEnded();
    });
    await undone(shell);
  });

  it("through a live start whose model switch is declined", SLOW, async () => {
    const shell = await bootDevice(declineSwitch);
    await editHeldAcross(async () => {
      live().click();
      await vi.waitFor(() => expect(statusText()).toBe(t().status.canceled), { timeout: 10_000 });
      await liveEnded();
    });
    expect(confirms(shell)).toEqual([t().confirm.discard, t().confirm.switchModel("URX22", "URX44V")]);
    await undone(shell);
  });

  const refuseChannelOn = (a: Record<string, unknown>): number => {
    if (a.paramId === PARAMS.CH_ON.id) throw new Error("read-refused");
    return 0;
  };

  it("through a live start whose read is incomplete", SLOW, async () => {
    const shell = await bootDevice({ vd_get: refuseChannelOn });
    await editHeldAcross(async () => {
      live().click();
      await vi.waitFor(() => expect(errors(shell)).toHaveLength(1), { timeout: 10_000 });
      await liveEnded();
    });
    await undone(shell);
  });

  it("through a switched fetch whose read is incomplete", SLOW, async () => {
    const shell = await bootDevice({
      ...connectAs("URX22"),
      vd_get: refuseChannelOn,
      "plugin:dialog|message": byMessage((m) => m !== t().confirm.deviceErrorExport),
    });
    await editHeldAcross(async () => {
      $("btn-fetch").click();
      await vi.waitFor(() => expect(confirms(shell)).toContain(t().confirm.deviceErrorExport), { timeout: 10_000 });
      await fetchEnded();
    });
    expect($<HTMLSelectElement>("model-picker").value).toBe("URX44V");
    await undone(shell);
  });
});

// A device read that landed drops the undo history as it lands, an entry still open then
// included — and only then: an edit made after it, while a fetch is still releasing its link
// or a live start still registering its session, is an entry of its own that the undo takes
// back. The press is held across the rest of the flow, as in the cases above, so the entry is
// still open when the flow ends.

describe("the undo history across a device read that landed", () => {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const heldCommand = (): { asked: Promise<void>; release: () => void; answer: () => Promise<null> } => {
    let ask = (): void => {};
    const asked = new Promise<void>((r) => (ask = r));
    let release = (): void => {};
    const released = new Promise<void>((r) => (release = r));
    return { asked, release: () => release(), answer: () => (ask(), released.then(() => null)) };
  };
  /** Edit the plan inside a press that stays down until `lift`. */
  const editPressed = async (): Promise<void> => {
    selectNode("bus.osc");
    await tick();
    $("statusbar").dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, bubbles: true }));
    pressOscOn();
    expect(oscFace(), "the premise: the edit landed").toBe("ON");
  };
  const lift = async (): Promise<void> => {
    $("statusbar").dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
    await tick();
  };
  const liveUp = (): Promise<void> =>
    vi.waitFor(() => expect(live().getAttribute("aria-checked")).toBe("true"), { timeout: 25_000 });

  for (const [flow, cleanup, start, ended] of [
    ["fetch", "vd_disconnect", () => $("btn-fetch").click(), fetchEnded],
    ["live start", "vd_watch_link", () => live().click(), liveUp],
  ] as const) {
    it(`keeps an edit made while a ${flow} awaits ${cleanup} after its read landed`, SLOW, async () => {
      const held = heldCommand();
      const shell = await bootDevice({ [cleanup]: held.answer });
      start();
      await held.asked;
      try {
        await editPressed();
      } finally {
        held.release();
      }
      await ended();
      await lift();
      await undoTo(shell, "OFF");
    });

    it(`drops an entry opened before a ${flow}'s read as the read lands`, SLOW, async () => {
      let unitOsc = 0;
      const shell = await bootDevice({
        vd_get: (a: Record<string, unknown>) => (a.paramId === PARAMS.OSC_ON.id ? unitOsc : unwrittenRead(a)),
      });
      await editPressed();
      // The unit holds what the edit put there, so the read changes no value.
      unitOsc = 1;
      start();
      await ended();
      await lift();
      // By way of another node, for the reason the draw-failure cases give.
      selectNode("ch1");
      expect(oscOn(), "the premise: the read left the edit standing").toBe("ON");
      expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
      expect(statusText()).toBe(t().status.nothingToUndo);
    });
  }
});

// The macOS Edit menu lives outside the document, so a click on it arrives as a webview
// event rather than as a DOM one. `edit-menu.test.ts` pins the module against mocked
// hooks; what is only true HERE is that those hooks reach the plan's history at all —
// they are built before `planHistory` exists and read it lazily, so a wiring that resolved
// it eagerly would capture null and the menu would silently do nothing.

describe("the macOS Edit menu", () => {
  it("routes a menu click into the plan's history, both ways", SLOW, async () => {
    const shell = await bootDevice();
    $("btn-view-console").click();
    const slider = (): HTMLElement => $("console-host").querySelector<HTMLElement>('.con-strip [role="slider"]')!;
    /** Wait until the NEWEST push to the native menu says exactly this. */
    const menuState = async (state: { canUndo: boolean; canRedo: boolean }): Promise<void> => {
      await vi.waitFor(() => expect(shell.args[shell.invokes.lastIndexOf("set_edit_menu_state")]).toEqual(state), {
        timeout: 10_000,
      });
    };
    const before = slider().getAttribute("aria-valuenow");

    // UP, not down: the first control on the strip is the analog gain knob, and the default
    // plan has it at the bottom of its range, so a step down writes the value it already
    // holds and the case would fail on its own premise. Both values are asserted rather
    // than described, so the reason survives a factory default that moves or a strip head
    // that is reordered.
    expect(before, "the first strip control is no longer the gain knob at its floor").toBe("-8");
    // Keyup as well as keydown: an arrow key is an entry boundary, so this commits the edit
    // at once instead of leaving the case waiting on the idle backstop.
    for (const type of ["keydown", "keyup"]) {
      slider().dispatchEvent(new KeyboardEvent(type, { key: "ArrowUp", bubbles: true, cancelable: true }));
    }
    expect(slider().getAttribute("aria-valuenow")).toBe("-7");

    // The depth reached the native menu — the other half of the wiring, and the half that
    // decides whether the item is clickable at all.
    await menuState({ canUndo: true, canRedo: false });

    // One handler, not zero: an event nobody listens for would leave every assertion below
    // describing an app that was never asked to do anything.
    expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
    await vi.waitFor(() => expect(slider().getAttribute("aria-valuenow")).toBe("-8"), { timeout: 10_000 });
    // The menu updates ITSELF, which is the whole reason this wiring exists: the menu is
    // outside the document, so nothing repaints it. Without this the Redo item stays
    // greyed out after an undo taken from the menu — usable once per launch — and only
    // the edit-driven push above would be covered.
    await menuState({ canUndo: false, canRedo: true });
    expect(shell.emit(EDIT_MENU_EVENT, EDIT_REDO_ID)).toBe(1);
    await vi.waitFor(() => expect(slider().getAttribute("aria-valuenow")).toBe("-7"), { timeout: 10_000 });
  });
});
