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
import { COMP_EQ_SSMCS } from "../core/control/params";
import { barLevels, dynHost, pickBand, readouts, rowsByKey, segments } from "./dyn-screen.test-util";
import type { DynHost } from "./dyn-screen.test-util";
import { MeterStore } from "../core/meters";
import { setLang, t } from "../i18n";

const GATE = DYN_PROCESSORS.gate;
const COMP = DYN_PROCESSORS.comp;
const EQ = DYN_PROCESSORS.eq;
const SSMCS_COMP = DYN_PROCESSORS.ssmcsComp;

let host: DynHost;
let store: MeterStore | null = null;

/** The lanes the screen actually subscribed, as the flat address list it sent. */
const subscribedAddrs = (): Array<[number, number]> =>
  (meterMocks.subscribe.mock.calls.at(-1)?.[1] as Array<[number, number]>) ?? [];

/** Let the registration queue drain. Registrations are serialized — one is chained
 *  behind the previous one's SETTLEMENT — so a second one is several microtask turns
 *  away rather than synchronous, and a fixed number of `await Promise.resolve()` lands
 *  in the middle of the chain instead of past it. A macrotask drains all of them. */
const settleSubs = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

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
    expect(title.textContent).toContain(
      GATE.title(t(), { model: host.model, plan: host.plan, nodeId: "ch1", sel: 0, m: t() }),
    );
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

  // …but only the registration that is still the current one. `onMeterError` ends the
  // Live session, so a refusal belonging to a scope the screen has already left would
  // take down the session that the scope now on screen is being served by. The screen
  // closes here, which is the cheapest supersession to arrange; a face move or a tap
  // that moved under the screen supersedes the same counter the same way.
  it("swallows a registration failure that belongs to a superseded scope", async () => {
    host = dynHost({ live: true });
    let refuse: ((e: Error) => void) | undefined;
    meterMocks.subscribe.mockImplementation(() => new Promise<() => void>((_res, rej) => (refuse = rej)));
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    screen.close();
    refuse!(new Error("broker refused"));
    await settleSubs();
    expect(host.meterErrors).toEqual([]);
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
    await settleSubs();

    host.setLive(false);
    screen.setLive(false);
    expect(meterMocks.unsub).toHaveBeenCalledTimes(1);

    host.setLive(true);
    screen.setLive(true);
    expect(meterMocks.subscribe).toHaveBeenCalledTimes(2);
  });

  // The screen took its registration at `open` on the premise that a node's address
  // set is fixed for the session. The DUCKER's KEY lane broke that: it reads the tap
  // its SOURCE channel's Rec Point names, and a front-panel change, an undo or a plan
  // load all arrive as a refresh. Without re-subscribing, the lane asks the store for
  // an address the broker was never told to stream — a bar at the floor and a readout
  // at "—" for a signal that is present, until the screen is closed and reopened.
  it("re-subscribes when a lane's tap moves under the open screen", async () => {
    host = dynHost({ live: true });
    const screen = new DynScreen(host.hooks);
    screen.open(DYN_PROCESSORS.ducker, "out.ducker1");
    await settleSubs();
    expect(meterMocks.subscribe).toHaveBeenCalledTimes(1);
    // CH 1 is ducker 1's key source in the factory plan; 113 is its PRE FADER tap.
    expect(subscribedAddrs()[0]).toEqual([113, 0]);

    // The unit's own Rec Point moves to PRE GATE, which the follow puts in the plan.
    host.plan.nodeParams["ch1"] = { ...host.plan.nodeParams["ch1"], recPoint: 0 };
    screen.refresh();
    await settleSubs();
    expect(meterMocks.unsub).toHaveBeenCalledTimes(1);
    expect(meterMocks.subscribe).toHaveBeenCalledTimes(2);
    expect(subscribedAddrs()[0]).toEqual([106, 0]);
  });

  // A refresh that leaves every tap where it was must not re-register: a follow can
  // deliver these at ~20 Hz, and the broker replaces the registration each time.
  it("leaves the registration alone when a refresh moves no tap", async () => {
    host = dynHost({ live: true });
    const screen = new DynScreen(host.hooks);
    screen.open(DYN_PROCESSORS.ducker, "out.ducker1");
    await Promise.resolve();
    screen.refresh();
    screen.refresh();
    await Promise.resolve();
    expect(meterMocks.subscribe).toHaveBeenCalledTimes(1);
    expect(meterMocks.unsub).not.toHaveBeenCalled();
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

  /**
   * A merged reduction's BAR is a different quantity from its readout, and that is the
   * whole reason the arrangement works.
   *
   * Two bars growing from opposite ends of one ruler are unreadable where they overlap, and
   * the overlap in dBFS is `input + gain` — independent of the reduction — so subtracting
   * the processor's own gain leaves `input`, which is at or below 0 for a real signal. The
   * bar is therefore an INDICATION, shortened by the makeup; the readout goes on printing
   * what the meter reported.
   *
   * Read as a ratio between two feeds rather than as an absolute fraction: what the case is
   * about is the OFFSET, and a fraction would also be asserting the ruler's own ends.
   */
  it("shortens a merged reduction's bar by the processor's gain, and not its readout", async () => {
    host = dynHost({ live: true });
    // Makeup at its own factory value, so the offset is whatever the descriptor derives
    // rather than a number this file chose.
    const screen = new DynScreen(host.hooks);
    screen.open(COMP, "ch1");
    await Promise.resolve();

    const gr = subscribedAddrs().find(([id]) => id === 110)!;
    const barFor = (db: number): number => {
      feed([{ meterId: gr[0], x: gr[1], value: db * 10 }]);
      // The readouts are written every Nth frame, so a single one leaves them at "—".
      for (let i = 0; i < 5; i++) host.frame();
      // The GR lane is the last one built, and its shade is the second in its slot.
      return barLevels(host.box).at(-1)!;
    };
    const readoutFor = (db: number): string => {
      barFor(db);
      return readouts(host.box).find((r) => r.gr)!.value;
    };

    // The readout is the meter's own reading, unshortened.
    expect(readoutFor(-12)).toBe("-12.0");
    expect(readoutFor(-24)).toBe("-24.0");

    // The bar is not: 12 dB more reduction moves it by 12 dB of the ruler, but both are
    // offset by the same makeup — so the DIFFERENCE is the reduction and the ORIGIN is not.
    const deep = barFor(-24);
    const shallow = barFor(-12);
    expect(deep).toBeGreaterThan(shallow);
    // A reduction shallower than the makeup is clamped to nothing at all, which is what
    // "an indication" means here — and what an unoffset bar would draw as a visible one.
    expect(barFor(-1)).toBe(0);
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

  // The plot and the lane rack are both on screen from the moment the screen opens —
  // nothing chooses between them any more, so there is no state in which one is absent.
  it("shows the plot and the lane rack together, with the curve already drawn", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    expect(host.box.querySelector(".gt-splitdisplay")).not.toBeNull();
    expect(host.box.querySelector("#dyn-curve")).not.toBeNull();
    expect(host.box.querySelector(".gt-ladderbox")).not.toBeNull();
    expect(host.canvas.ys.length).toBeGreaterThan(0);
  });

  // A parameter change has to reach the curve even with no session: the frame loop
  // only runs while the meters are fed, so the redraw takes a frame of its own.
  it("redraws the curve after a parameter moves with no session running", () => {
    host = dynHost({ live: false });
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
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

describe("selecting within a screen", () => {
  /** Put ch1 into the morphing bank, which is the one processor here that still carries a
   *  segmented bar — the shipped screens select nothing, and the EQs' bands moved onto the
   *  plot. Both mechanisms are the host's, so both are exercised here. */
  const bank = (): typeof SSMCS_COMP => {
    host.plan.nodeParams["ch1"] = { ...host.plan.nodeParams["ch1"], compEqType: COMP_EQ_SSMCS };
    return SSMCS_COMP;
  };
  const modes = (): HTMLButtonElement[] => segments(host.box);

  it("selects a segment from the bar and rebuilds the rows under it", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(bank(), "ch1");
    const before = modes();
    expect(before.length).toBe(4);
    expect(before[1].getAttribute("aria-pressed")).toBe("true"); // COMP, this face's first

    before[2].click(); // Side Chain, the same face's other segment
    const after = modes();
    expect(after[2].getAttribute("aria-pressed")).toBe("true");
    expect(after[1].getAttribute("aria-pressed")).toBe("false");
    // The rows under it are the filter's, not the compressor's.
    expect([...rowsByKey(host.box).keys()]).toContain("scFreq");
  });

  it("ignores a click on the segment already selected", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(bank(), "ch1");
    const rows = rowsByKey(host.box).get("attack")!;
    modes()[1].click();
    expect(modes()[1].getAttribute("aria-pressed")).toBe("true");
    // Nothing was rebuilt, which is what "ignores" means here — a rebuild replaces the row.
    expect(rowsByKey(host.box).get("attack")).toBe(rows);
  });

  // A choice that is a way of READING the processor persists; one that is a cursor
  // into the parameters resets per open.
  it("remembers a persisted choice across a close and reopen", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    const proc = bank();
    expect(proc.persistSel).toBe(true);
    screen.open(proc, "ch1");
    modes()[2].click();
    screen.close();

    screen.open(proc, "ch1");
    expect(modes()[2].getAttribute("aria-pressed")).toBe("true");
  });

  it("resets a cursor-like choice per open, and moves it from the plot's own markers", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(EQ, "ch1");
    // No bar: the EQ's bands are picked on the plot, which is one focus stop.
    expect(modes().filter((b) => !b.disabled)).toEqual([]);
    const first = rowsByKey(host.box).get("freq")!;
    pickBand(host.box, 3);
    expect(rowsByKey(host.box).get("freq")).not.toBe(first);

    screen.close();
    screen.open(EQ, "ch1");
    // Back on the first band: EQ does not set `persistSel`.
    expect(rowsByKey(host.box).get("freq")!.value).toBe(first.value);
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

  // A blur ends the GESTURES this view runs, but it is not a release: the press is still
  // in flight, and rebuilding under it would hand the still-held pointer a live control —
  // which for a native row is the state `holdInertOnBlur` exists to prevent. So the
  // deferral lasts as long as the press does, and the repaint lands at the release.
  it("keeps a deferred repaint waiting through a blur, and lands it at the release", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    const slider = rowsByKey(host.box).get("threshold")!;
    host.box.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
    screen.refresh();

    window.dispatchEvent(new FocusEvent("blur"));
    expect(rowsByKey(host.box).get("threshold")).toBe(slider);

    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    expect(rowsByKey(host.box).get("threshold")).not.toBe(slider);
  });

  // And the cap, whose gate is that surviving capture rather than a flag the release
  // above clears: without an ender of its own it kept writing thresholds to the plan
  // and the live unit for every later move.
  it("stops the threshold cap at a window blur, but not at a blur inside the screen", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    const cap = host.box.querySelector<HTMLElement>("#dyn-threshold-cap")!;
    const thr = (): number => (host.plan.nodeParams["ch1"]?.gate as { threshold: number }).threshold;
    const at = (type: string, clientY: number): PointerEvent =>
      new PointerEvent(type, { bubbles: true, clientY, pointerId: 1 });

    const start = thr();
    cap.dispatchEvent(at("pointerdown", 40));
    cap.dispatchEvent(at("pointermove", 80));
    const moved = thr();
    expect(moved).not.toBe(start);

    // The cap carries a tabIndex and every row beside it is focusable, so focus moves
    // inside the modal while a press is down. The release is registered without
    // `capture: true` for exactly this: a capturing window listener is handed those
    // blurs too, and would end the drag — and clear `grabbed`, letting a queued
    // refresh replace the control under the pointer.
    cap.dispatchEvent(new FocusEvent("blur"));
    cap.dispatchEvent(at("pointermove", 120));
    const stillDragging = thr();
    expect(stillDragging).not.toBe(moved);

    window.dispatchEvent(new FocusEvent("blur"));
    cap.dispatchEvent(at("pointermove", 150));
    expect(thr()).toBe(stillDragging);
    expect(cap.hasPointerCapture(1)).toBe(false);
  });

  // The value rows are native ranges, so the ENGINE owns their drag and this tier cannot
  // hold that half at all — jsdom has no such drag to end, and a case written here passes
  // whether or not the row leaves an ender behind (measured: deleting the registration
  // left this file green). It lives in `e2e/dyntuning.spec.ts` instead, where the drag is
  // real and only the blur is dispatched.
  //
  // The MIDI question: a message applied while the window is away still reaches the plan
  // and the unit; what waits is the repaint, for as long as the press does. The operator
  // is looking at another application for that interval by definition — it begins when
  // this window lost the foreground — and it ends when they let go, which they can do
  // without coming back (a release reaches a background window; measured on the unit).
  it("lands a device- or MIDI-driven value on the screen when the press ends", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    const before = rowsByKey(host.box).get("threshold")!;

    // A press defers the repaint: the control under the pointer must not be replaced.
    host.box.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
    host.plan.nodeParams["ch1"] = { ...host.plan.nodeParams["ch1"], gate: { threshold: -21 } };
    screen.refresh();
    expect(rowsByKey(host.box).get("threshold")).toBe(before);

    window.dispatchEvent(new FocusEvent("blur"));
    expect(rowsByKey(host.box).get("threshold")).toBe(before);

    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    const after = rowsByKey(host.box).get("threshold")!;
    expect(after).not.toBe(before);
    expect(host.box.querySelector('[data-dyn-val="threshold"]')?.textContent).toContain("-21");
  });

  // The row's treatment is for the blur end alone. Run on an ordinary release it left the
  // row disabled after every finished drag — and the listener that would re-arm it is
  // added DURING that pointerup's own dispatch, so it does not see it: the row stayed dead
  // until some later event happened to fire, and a press meanwhile landed on nothing.
  it("leaves a value row usable after an ordinary release", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    const row = rowsByKey(host.box).get("threshold")!;

    row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
    row.focus();
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));

    expect(row.disabled).toBe(false);
    expect(document.activeElement).toBe(row);
  });

  // Which release lands a deferred refresh is the FIRST one to arrive, not the last: the
  // same `release` is registered on `pointerup`, on `pointercancel` and on the end of the
  // app-wide holds, and whichever runs first clears `grabbed` while the others find it
  // already cleared. The blur is not one of them — it ends this view's own gestures and
  // leaves `grabbed` set — so the deferral outlives it, and a window that comes back with
  // the button still down lands the refresh there, before any pointerup.
  it("lands a deferred refresh on the first release to arrive, not the last", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    const row = rowsByKey(host.box).get("threshold")!;

    row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
    host.plan.nodeParams["ch1"] = { ...host.plan.nodeParams["ch1"], gate: { threshold: -21 } };
    screen.refresh(); // deferred while the pointer is down
    window.dispatchEvent(new FocusEvent("blur"));
    expect(rowsByKey(host.box).get("threshold")).toBe(row);

    // Still held, so this is the hold's release running before any pointer event does.
    window.dispatchEvent(new FocusEvent("focus"));
    expect(rowsByKey(host.box).get("threshold")).not.toBe(row);
    expect(row.isConnected).toBe(false);
  });

  // The other order, and the one an ordinary gesture takes: the press ends while the app is
  // still in the background, and the refresh lands at that release. What must not happen is
  // a row left disabled by the treatment, or focus parked on the node that was replaced.
  // Focus is not moved to the new row: no rebuild in this app restores focus (the CONSOLE
  // and the inspector do not either), and doing it on this path alone would make this the
  // one repaint that behaves differently.
  it("leaves no disabled row and no focus on a detached node when a release lands a deferred refresh", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    const row = rowsByKey(host.box).get("threshold")!;

    row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
    row.focus();
    host.plan.nodeParams["ch1"] = { ...host.plan.nodeParams["ch1"], gate: { threshold: -21 } };
    screen.refresh(); // deferred while the pointer is down
    window.dispatchEvent(new FocusEvent("blur"));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));

    const now = rowsByKey(host.box).get("threshold")!;
    expect(now).not.toBe(row);
    expect(now.disabled).toBe(false);
    expect(row.isConnected).toBe(false);
    expect(document.activeElement).not.toBe(row);
  });

  // The wiring itself, on the path with no rebuild racing it: the row this screen builds
  // has to be the one `holdInertOnBlur` holds, and give its focus back at the release.
  // Without this the whole file passes with the call deleted — jsdom has no native drag to
  // end, so every other case here is blind to the site.
  it("holds a value row inert while the window is away, focus and all", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    const row = rowsByKey(host.box).get("threshold")!;

    row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
    row.focus();
    window.dispatchEvent(new FocusEvent("blur"));
    expect(row.disabled).toBe(true);

    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    expect(row.disabled).toBe(false);
    expect(document.activeElement).toBe(row);
  });

  // A rebuilt row carries its own disabled state, and the restore must not talk it out of
  // it: turning COMP's 1-knob on hands threshold / ratio / gain / knee to the device, and
  // a locked row disables its controls. Re-enabling one here would put a device-driven
  // value back under the operator's pointer.
  it("leaves a row the rebuild locked disabled, and does not focus it", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(COMP, "ch1");
    const row = rowsByKey(host.box).get("threshold")!;

    row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
    row.focus();
    // What device follow does when the unit's 1-knob comes on under the operator's hand.
    const comp = host.plan.nodeParams["ch1"]?.comp as Record<string, unknown>;
    host.plan.nodeParams["ch1"] = { ...host.plan.nodeParams["ch1"], comp: { ...comp, oneKnob: true } };
    screen.refresh(); // deferred while the pointer is down
    window.dispatchEvent(new FocusEvent("blur"));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));

    const now = rowsByKey(host.box).get("threshold")!;
    expect(now).not.toBe(row);
    expect(now.disabled).toBe(true);
    expect(document.activeElement).not.toBe(now);
  });

  // The third drag on this screen, and the one with no flag to clear: its move handler
  // asks the engine whether it still holds the capture, and a blur leaves that answer
  // true — so the ender drops the capture instead.
  it("stops the plot drag at a window blur", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(GATE, "ch1");
    host.frame();
    const cv = host.box.querySelector<HTMLCanvasElement>("#dyn-curve")!;
    const thr = (): number => (host.plan.nodeParams["ch1"]?.gate as { threshold: number }).threshold;
    // offsetX is what the plot reads and the constructor does not take it.
    const at = (type: string, offsetX: number): PointerEvent => {
      const ev = new PointerEvent(type, { bubbles: true, pointerId: 1 });
      Object.defineProperty(ev, "offsetX", { value: offsetX });
      return ev;
    };

    const start = thr();
    cv.dispatchEvent(at("pointerdown", 200));
    cv.dispatchEvent(at("pointermove", 300));
    const moved = thr();
    expect(moved).not.toBe(start);

    window.dispatchEvent(new FocusEvent("blur"));
    cv.dispatchEvent(at("pointermove", 500));
    expect(thr()).toBe(moved);
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
