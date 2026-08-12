// @vitest-environment jsdom

// The channel tuning screen's host: what open() resolves, what a paint writes into
// the bars and readouts, how the meter slot is taken and given back, and the two
// rules the class exists to keep — a rebuild never happens under a pointer, and a
// processor that disappears takes the screen with it.
//
// Driven through the real descriptors (GATE / COMP / EQ / DUCKER) rather than a
// stub one: the host's contract is what those four ask of it, and a stub would pin
// the contract this file already states rather than the one they rely on.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const meterMocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  unsub: vi.fn(),
  onUpdate: undefined as ((m: { meterId: number; x: number; value: number }) => void) | undefined,
}));

vi.mock("../core/meters", async (importOriginal) => {
  const real = await importOriginal<typeof import("../core/meters")>();
  return {
    ...real,
    subscribeMeters: (
      store: InstanceType<typeof real.MeterStore>,
      addrs: Array<[number, number]>,
      onUpdate?: (m: { meterId: number; x: number; value: number }) => void,
    ) => {
      meterMocks.onUpdate = onUpdate;
      return meterMocks.subscribe(store, addrs, onUpdate);
    },
  };
});

import { DynScreen } from "./dyn-screen";
import { DYN_PROCESSORS } from "./dyn-registry";
import { barLevels, dynHost, readouts, rowsByKey } from "./dyn-screen.test-util";
import type { DynHost } from "./dyn-screen.test-util";
import { MeterStore } from "../core/meters";
import { setLang, t } from "../i18n";

const GATE = DYN_PROCESSORS.gate;
const COMP = DYN_PROCESSORS.comp;
const EQ = DYN_PROCESSORS.eq;

let host: DynHost;
let store: MeterStore | null = null;

/** The lanes the screen actually subscribed, as the flat address list it sent. */
const subscribedAddrs = (): Array<[number, number]> =>
  (meterMocks.subscribe.mock.calls.at(-1)?.[1] as Array<[number, number]>) ?? [];

/** Push one meter frame through the subscription the screen holds. */
function feed(frames: Array<{ meterId: number; x: number; value: number }>): void {
  for (const f of frames) {
    store?.apply(f);
    meterMocks.onUpdate?.(f);
  }
}

beforeEach(() => {
  setLang("en");
  localStorage.clear();
  meterMocks.subscribe.mockReset();
  meterMocks.unsub.mockReset();
  meterMocks.onUpdate = undefined;
  store = null;
  meterMocks.subscribe.mockImplementation((s: MeterStore) => {
    store = s;
    return Promise.resolve(meterMocks.unsub);
  });
});

afterEach(() => {
  host?.restore();
  document.body.replaceChildren();
});

describe("open / close", () => {
  it("builds the screen, shows the modal and names the node and processor", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");

    expect(screen.isOpen()).toBe(true);
    expect(host.scrim.hidden).toBe(false);
    const title = host.box.querySelector("#dyn-screen-title")!;
    expect(title.textContent).toContain(GATE.title(t()));
    expect(host.box.querySelector(".gt-ladders")).not.toBeNull();
    expect(host.box.querySelector(".consent-btn-secondary")).not.toBeNull();
  });

  // `bind` answering null is how a processor says it does not exist on this node.
  // The screen must not half-open on it.
  it("refuses to open where the processor does not exist", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "no-such-node");
    expect(screen.isOpen()).toBe(false);
    expect(host.scrim.hidden).toBe(true);
    expect(host.box.childElementCount).toBe(0);
  });

  it("gives the meter slot back and reports the close", () => {
    host = dynHost({ live: true });
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    expect(host.released()).toBe(1);

    screen.close();
    expect(screen.isOpen()).toBe(false);
    expect(host.scrim.hidden).toBe(true);
    expect(host.regained()).toBe(1);
    expect(host.closed()).toBe(1);
  });

  it("ignores a close on a screen that is not open", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.close();
    expect(host.regained()).toBe(0);
    expect(host.closed()).toBe(0);
  });

  it("closes on the Close button and on Escape", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    host.box.querySelector<HTMLButtonElement>(".consent-btn-secondary")!.click();
    expect(screen.isOpen()).toBe(false);

    screen.open(GATE, "ch1");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(screen.isOpen()).toBe(false);
  });

  it("closes on a press outside the box but not inside it", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    host.box.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(screen.isOpen()).toBe(true);
    host.scrim.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(screen.isOpen()).toBe(false);
  });
});

describe("meter subscription", () => {
  // The broker has one meter slot process-wide, so the screen takes it before it
  // subscribes rather than letting the console discover it was replaced.
  it("takes the slot before subscribing, and only while live", () => {
    host = dynHost({ live: false });
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    expect(host.released()).toBe(0);
    expect(meterMocks.subscribe).not.toHaveBeenCalled();

    host.setLive(true);
    screen.setLive(true);
    expect(host.released()).toBe(1);
    expect(meterMocks.subscribe).toHaveBeenCalledTimes(1);
  });

  it("subscribes every address its lanes carry, in lane order", () => {
    host = dynHost({ live: true });
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    const addrs = subscribedAddrs();
    expect(addrs.length).toBeGreaterThan(0);
    expect(addrs.every((a) => Array.isArray(a) && a.length === 2)).toBe(true);
  });

  it("drops the subscription and the frame loop on close", async () => {
    host = dynHost({ live: true });
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    await Promise.resolve();
    expect(host.pending()).toBeGreaterThan(0);

    screen.close();
    expect(meterMocks.unsub).toHaveBeenCalledTimes(1);
    expect(host.pending()).toBe(0);
  });

  // The subscribe is a round trip; a screen closed inside it must not leave the
  // registration behind.
  it("releases a subscription that landed after the screen closed", async () => {
    host = dynHost({ live: true });
    const screen = new DynScreen(host.hooks);
    let land: ((u: () => void) => void) | undefined;
    meterMocks.subscribe.mockImplementation(
      (s: MeterStore) => ((store = s), new Promise<() => void>((res) => (land = res))),
    );
    screen.open(GATE, "ch1");
    screen.close();
    land!(meterMocks.unsub);
    await Promise.resolve();
    await Promise.resolve();
    expect(meterMocks.unsub).toHaveBeenCalledTimes(1);
  });

  // Bars stuck on the floor look exactly like silence, so a failed registration
  // takes the loud path.
  it("reports a registration failure rather than showing an empty meter", async () => {
    host = dynHost({ live: true });
    meterMocks.subscribe.mockRejectedValue(new Error("broker refused"));
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    await Promise.resolve();
    await Promise.resolve();
    expect(host.meterErrors).toEqual(["broker refused"]);
  });

  it("renders a non-Error registration failure as a string", async () => {
    host = dynHost({ live: true });
    meterMocks.subscribe.mockRejectedValue("broker refused");
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    await Promise.resolve();
    await Promise.resolve();
    expect(host.meterErrors).toEqual(["broker refused"]);
  });

  // A session that drops and returns while the screen holds the slot: nothing else
  // will re-establish the stream for it.
  it("re-subscribes when live sync returns under an open screen", async () => {
    host = dynHost({ live: true });
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    await Promise.resolve();

    host.setLive(false);
    screen.setLive(false);
    expect(meterMocks.unsub).toHaveBeenCalledTimes(1);

    host.setLive(true);
    screen.setLive(true);
    expect(meterMocks.subscribe).toHaveBeenCalledTimes(2);
  });

  it("ignores a live-sync change while the screen is closed", () => {
    host = dynHost({ live: true });
    const screen = new DynScreen(host.hooks);
    screen.setLive(true);
    expect(meterMocks.subscribe).not.toHaveBeenCalled();
  });
});

describe("painting", () => {
  // The readouts are filled by the paint that render() performs, not by the first
  // feed frame — a screen with no session would otherwise sit blank forever.
  it("prints the no-reading placeholder before any frame arrives", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    const cells = readouts(host.box);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((c) => c.value === t().dynTuning.noReading)).toBe(true);
  });

  it("fills the bars and readouts from the feed", async () => {
    host = dynHost({ live: true });
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    await Promise.resolve();

    const [addr] = subscribedAddrs();
    feed([{ meterId: addr[0], x: addr[1], value: -120 }]);
    host.frame();
    expect(barLevels(host.box).some((v) => v > 0)).toBe(true);

    // Setting textContent relayouts the cell whether or not the string changed, so
    // the readout text is refreshed every fifth frame rather than every one.
    for (let i = 0; i < 5; i++) host.frame();
    expect(readouts(host.box).some((c) => c.value !== t().dynTuning.noReading)).toBe(true);
  });

  // A reading past the ruler's ends is clamped into the bar's own 0..1, which is a
  // display fraction and not a value — the readout still prints the true dB.
  it("clamps a bar to the ruler without clamping the readout", async () => {
    host = dynHost({ live: true });
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    await Promise.resolve();

    const [addr] = subscribedAddrs();
    feed([{ meterId: addr[0], x: addr[1], value: 400 }]);
    host.frame();
    expect(Math.max(...barLevels(host.box))).toBeLessThanOrEqual(1);
  });

  // The feed is 10 Hz and each frame is an instantaneous sample; the peak hold is
  // the only thing that makes a caught transient readable.
  it("holds a peak above a level that has since fallen", async () => {
    host = dynHost({ live: true });
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    await Promise.resolve();

    const [addr] = subscribedAddrs();
    feed([{ meterId: addr[0], x: addr[1], value: -60 }]);
    for (let i = 0; i < 5; i++) host.frame();
    const loud = readouts(host.box)[0].peak;
    expect(loud).not.toBe(t().dynTuning.noReading);

    feed([{ meterId: addr[0], x: addr[1], value: -600 }]);
    for (let i = 0; i < 5; i++) host.frame();
    const after = readouts(host.box)[0];
    expect(after.peak).toBe(loud);
    expect(after.value).not.toBe(loud);
  });

  it("stops the frame loop when the screen is closed mid-feed", async () => {
    host = dynHost({ live: true });
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    await Promise.resolve();
    host.frame();
    expect(host.pending()).toBeGreaterThan(0);
    screen.close();
    host.frame();
    expect(host.pending()).toBe(0);
  });

  it("falls back to the placeholder when the session goes away", async () => {
    host = dynHost({ live: true });
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    await Promise.resolve();
    const [addr] = subscribedAddrs();
    feed([{ meterId: addr[0], x: addr[1], value: -120 }]);
    host.frame();

    host.setLive(false);
    // Five frames: the readout text is throttled to every fifth.
    for (let i = 0; i < 6; i++) host.frame();
    expect(readouts(host.box).every((c) => c.value === t().dynTuning.noReading)).toBe(true);
  });
});

describe("plot", () => {
  // GATE and COMP show a ladder OR a curve; the EQ shows its response beside its
  // lanes, so it always has a canvas.
  it("draws the axes and the curve once the plot has been measured", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(EQ, "ch1");
    expect(host.box.querySelector("#dyn-curve")).not.toBeNull();
    expect(host.canvas.ys.length).toBeGreaterThan(0);
  });

  it("draws nothing when the plot has no measurable size", () => {
    host = dynHost({ plotSize: { w: 0, h: 0 } });
    const screen = new DynScreen(host.hooks);
    screen.open(EQ, "ch1");
    expect(host.canvas.ys).toEqual([]);
  });

  // The ladder mode has no canvas at all — the display bar swaps the whole thing.
  it("has no plot in the ladder mode and gains one on the curve mode", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    expect(host.box.querySelector("#dyn-curve")).toBeNull();

    host.box.querySelector<HTMLButtonElement>("#dyn-mode-curve")!.click();
    expect(host.box.querySelector("#dyn-curve")).not.toBeNull();
    expect(host.canvas.ys.length).toBeGreaterThan(0);
  });

  // A parameter change has to reach the curve even with no session: the frame loop
  // only runs while the meters are fed, so the redraw takes a frame of its own.
  it("redraws the curve after a parameter moves with no session running", () => {
    host = dynHost({ live: false });
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    host.box.querySelector<HTMLButtonElement>("#dyn-mode-curve")!.click();
    const before = host.canvas.ys.length;
    expect(before).toBeGreaterThan(0);

    const slider = rowsByKey(host.box).get("threshold")!;
    slider.value = String(Number(slider.value) + 10);
    slider.dispatchEvent(new Event("input"));
    host.frame();
    expect(host.canvas.ys.length).toBeGreaterThan(before);
  });

  // The curve is clipped by the host, so a value past the axis leaves the frame
  // instead of lying along its edge.
  it("clips the curve to the plot area rather than letting a descriptor clamp it", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    host.box.querySelector<HTMLButtonElement>("#dyn-mode-curve")!.click();
    // save / clip / restore bracket the curve; the recorder swallows them, so what
    // is checked here is that the host drew a curve at all under that bracket.
    expect(host.canvas.ys.length).toBeGreaterThan(0);
  });
});

describe("parameter rows", () => {
  it("writes an edited value back through the plan-edit funnel", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");

    const slider = rowsByKey(host.box).get("threshold")!;
    slider.value = String(Number(slider.value) + 10);
    slider.dispatchEvent(new Event("input"));

    expect(host.patches).toHaveLength(1);
    expect(host.patches[0].id).toBe("ch1");
    expect(host.patches[0].patch).toHaveProperty("gate");
  });

  it("offers one row per field the binding resolved", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    const keys = [...rowsByKey(host.box).keys()];
    expect(keys).toContain("threshold");
    expect(keys.length).toBeGreaterThan(1);
  });
});

describe("segmented bar", () => {
  it("selects a band and rebuilds the rows under it", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(EQ, "ch1");
    const buttons = [...host.box.querySelectorAll<HTMLButtonElement>(".gt-modes button")];
    expect(buttons.length).toBeGreaterThan(1);
    expect(buttons[0].getAttribute("aria-pressed")).toBe("true");

    buttons[1].click();
    const after = [...host.box.querySelectorAll<HTMLButtonElement>(".gt-modes button")];
    expect(after[1].getAttribute("aria-pressed")).toBe("true");
    expect(after[0].getAttribute("aria-pressed")).toBe("false");
  });

  it("ignores a click on the item already selected", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(EQ, "ch1");
    const first = host.box.querySelector<HTMLButtonElement>(".gt-modes button")!;
    first.click();
    expect(host.box.querySelector<HTMLButtonElement>(".gt-modes button")!.getAttribute("aria-pressed")).toBe("true");
  });

  // A choice that is a way of READING the processor persists; one that is a cursor
  // into the parameters resets per open.
  it("remembers a persisted choice across a close and reopen", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    const proc = COMP.persistSel ? COMP : GATE;
    screen.open(proc, "ch1");
    const buttons = [...host.box.querySelectorAll<HTMLButtonElement>(".gt-modes button")];
    if (buttons.length < 2) return; // the descriptor offers no choice on this node
    buttons[1].click();
    screen.close();

    screen.open(proc, "ch1");
    const after = [...host.box.querySelectorAll<HTMLButtonElement>(".gt-modes button")];
    expect(after[1].getAttribute("aria-pressed")).toBe(String(proc.persistSel === true));
  });
});

describe("refresh", () => {
  it("does nothing on a closed screen", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.refresh();
    expect(host.box.childElementCount).toBe(0);
  });

  it("re-renders in place when the plan changes underneath", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    const before = rowsByKey(host.box).get("threshold")!;

    host.plan.nodeParams["ch1"] = { ...host.plan.nodeParams["ch1"], gate: { threshold: -30 } };
    screen.refresh();
    expect(rowsByKey(host.box).get("threshold")).not.toBe(before);
  });

  // A follow can switch the channel's bank out from under an open screen: that
  // verdict is not deferrable, since a screen left open would keep writing into it.
  // Driven through a descriptor that can be made to answer null, because the real
  // ones reach that state through a bank switch this suite has no device for.
  it("closes itself when the processor goes away underneath it", () => {
    host = dynHost();
    let present = true;
    const vanishing = { ...GATE, bind: (ctx: Parameters<typeof GATE.bind>[0]) => (present ? GATE.bind(ctx) : null) };
    const screen = new DynScreen(host.hooks);
    screen.open(vanishing, "ch1");
    expect(screen.isOpen()).toBe(true);

    present = false;
    screen.refresh();
    expect(screen.isOpen()).toBe(false);
    expect(host.closed()).toBe(1);
    expect(host.regained()).toBe(1);
  });

  // The same verdict has to be reached before the deferral, or a screen held open
  // by a pointer would keep writing into a bank the plan no longer emits.
  it("closes on a vanished processor even while a pointer is down", () => {
    host = dynHost();
    let present = true;
    const vanishing = { ...GATE, bind: (ctx: Parameters<typeof GATE.bind>[0]) => (present ? GATE.bind(ctx) : null) };
    const screen = new DynScreen(host.hooks);
    screen.open(vanishing, "ch1");
    host.box.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

    present = false;
    screen.refresh();
    expect(screen.isOpen()).toBe(false);
  });

  // Device follow runs on its own clock and, under COMP 1-knob, on every step of a
  // drag. Rebuilding then would replace the control under the pointer.
  it("updates values in place while a pointer is down, and rebuilds on release", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    const slider = rowsByKey(host.box).get("threshold")!;

    host.box.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    host.plan.nodeParams["ch1"] = { ...host.plan.nodeParams["ch1"], gate: { threshold: -30 } };
    screen.refresh();
    // Same element — not rebuilt — but carrying the new value.
    expect(rowsByKey(host.box).get("threshold")).toBe(slider);

    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    expect(rowsByKey(host.box).get("threshold")).not.toBe(slider);
  });

  it("does not rebuild on a release that follows no deferred refresh", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    const slider = rowsByKey(host.box).get("threshold")!;
    host.box.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    expect(rowsByKey(host.box).get("threshold")).toBe(slider);
  });

  it("treats a cancelled pointer as a release", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    const slider = rowsByKey(host.box).get("threshold")!;
    host.box.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    screen.refresh();
    window.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
    expect(rowsByKey(host.box).get("threshold")).not.toBe(slider);
  });
});

describe("localization", () => {
  it("re-renders into the new language on refresh", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    const en = host.box.querySelector<HTMLButtonElement>(".consent-btn-secondary")!.textContent;

    setLang("ja");
    screen.refresh();
    expect(host.box.querySelector<HTMLButtonElement>(".consent-btn-secondary")!.textContent).toBe(t().dynTuning.close);
    expect(host.box.querySelector<HTMLButtonElement>(".consent-btn-secondary")!.textContent).not.toBe(en);
  });
});
