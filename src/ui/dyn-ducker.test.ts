// @vitest-environment jsdom

// The DUCKER descriptor. It is the one tuning screen that does not tune the node it
// opens on — its four lanes come from three places — and it is the only user of two
// host features (`foldSides`, `sameSlot`), so what it asks of the host is worth
// pinning separately from what the host does with it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const meterMocks = vi.hoisted(() => ({ subscribe: vi.fn(), unsub: vi.fn() }));

vi.mock("../core/meters", async (importOriginal) => {
  const real = await importOriginal<typeof import("../core/meters")>();
  return {
    ...real,
    subscribeMeters: (store: unknown, addrs: Array<[number, number]>, onUpdate?: unknown) =>
      meterMocks.subscribe(store, addrs, onUpdate),
  };
});

import { DynScreen } from "./dyn-screen";
import { DUCKER_DYN } from "./dyn-ducker";
import { dynHost, readouts } from "./dyn-screen.test-util";
import type { DynHost } from "./dyn-screen.test-util";
import { recorder, vals } from "./dyn-plot.test-util";
import { getModel } from "../models";
import { defaultPlan } from "../models/initial-state";
import { duckerKeyDb } from "../core/meters";
import { ref } from "../models/types";
import type { DynCtx } from "./dyn-screen";
import { setLang, t } from "../i18n";

const DUCKER = "out.ducker1";
const HOST_CH = "ch_5_6";

let host: DynHost;

const ctxFor = (nodeId: string, plan = defaultPlan("URX44V")): DynCtx => ({
  model: getModel("URX44V"),
  plan,
  nodeId,
  sel: 0,
  m: t(),
});

beforeEach(() => {
  setLang("en");
  localStorage.clear();
  meterMocks.subscribe.mockReset().mockResolvedValue(meterMocks.unsub);
  meterMocks.unsub.mockReset();
});

afterEach(() => {
  host?.restore();
  document.body.replaceChildren();
});

describe("binding", () => {
  it("resolves four lanes on two readout columns", () => {
    const bound = DUCKER_DYN.bind(ctxFor(DUCKER))!;
    expect(bound).not.toBeNull();
    expect(bound.lanes.map((l) => l.key)).toEqual(["key", "in", "out", "gr"]);
    // Four tiles on three columns wrap to a ragged 3 + 1.
    expect(bound.readoutCols).toBe(2);
    expect(bound.fields.length).toBeGreaterThan(0);
  });

  it("refuses a node that is not a ducker", () => {
    expect(DUCKER_DYN.bind(ctxFor("ch1"))).toBeNull();
    expect(DUCKER_DYN.bind(ctxFor("bus.stereo"))).toBeNull();
  });

  // The screen opens on the ducker node, whose canvas label is "Ducker" — beside a
  // title reading DUCKER that names nothing.
  it("titles itself with the host channel rather than the ducker's own label", () => {
    const ctx = ctxFor(DUCKER);
    expect(DUCKER_DYN.nodeLabel!(ctx)).toBe(getModel("URX44V").nodes.find((n) => n.id === HOST_CH)!.label);
    expect(DUCKER_DYN.nodeLabel!(ctxFor("ch1"))).toBeUndefined();
  });

  // The unit sums a stereo key's sides before its detector, and the cap can only ride
  // a ruler in its own coordinate — so the lane is folded and the cap sits on it.
  it("folds the key lane to what the detector reads, and rides the threshold on it", () => {
    const key = DUCKER_DYN.bind(ctxFor(DUCKER))!.lanes[0];
    expect(key.cap).toBe("threshold");
    expect(key.foldSides).toBe(duckerKeyDb);
  });

  it("names the key lane after the node the key wire starts at", () => {
    const plan = defaultPlan("URX44V");
    const label = getModel("URX44V").nodes.find((n) => n.id === "ch1")!.label;
    expect(DUCKER_DYN.bind(ctxFor(DUCKER, plan))!.lanes[0].label).toBe(t().dynTuning.ducker.tapKey(label));
  });

  // The block diagram makes the `Rec Point` selector's output the thing it labels
  // `CH OUT`, and DUCKER 1-4 SOURCE takes `CH n OUT` — so the tap the key lane reads
  // MOVES with the source channel's Rec Point. It read PRE FADER for every channel
  // source until this was fixed.
  describe("key tap follows the source's Rec Point", () => {
    const keyTapOf = (recPoint?: number, from = "ch1"): string | undefined => {
      const plan = defaultPlan("URX44V");
      const conn = plan.connections.find((c) => c.kind === "key" && c.to === ref(DUCKER, "in"))!;
      conn.from = ref(from, "out");
      if (recPoint !== undefined) plan.nodeParams[from] = { ...plan.nodeParams[from], recPoint };
      return DUCKER_DYN.bind(ctxFor(DUCKER, plan))!.lanes[0].tap?.key;
    };

    it("reads a mono source at each of its five Rec Point stages", () => {
      expect(keyTapOf(0)).toBe("pregate");
      expect(keyTapOf(1)).toBe("precomp");
      expect(keyTapOf(2)).toBe("preeq");
      expect(keyTapOf(3)).toBe("preinsfx");
      expect(keyTapOf(4)).toBe("prefader");
    });

    // PRE FADER is the device default, so an unset Rec Point is that tap — which is
    // also what every source used to get regardless.
    it("falls back to PRE FADER when the source names no Rec Point", () => {
      expect(keyTapOf(undefined)).toBe("prefader");
    });

    // A stereo strip has no discrete PRE EQ tap — its EQ is the first thing in the
    // chain, so INPUT is that point. Resolving it through `tapFor` alone would take
    // that module's fallback to the most downstream tap, which here is POST: after
    // the source's own ducker, the one reading this lane must never show.
    it("reads a stereo source's PRE EQ at its INPUT meter, not at POST", () => {
      expect(keyTapOf(2, "ch_7_8")).toBe("input");
      expect(keyTapOf(2, "ch_7_8")).not.toBe("post");
      expect(keyTapOf(4, "ch_7_8")).toBe("prefader");
    });

    // A bus key is the bus's own OUT, after its output insert FX — a bus has no Rec
    // Point, and POST is that point.
    it("reads a bus key at its POST tap", () => {
      expect(keyTapOf(undefined, "bus.mix1")).toBe("post");
      expect(keyTapOf(0, "bus.mix1")).toBe("post");
    });
  });

  // Nothing wired is a state the unit has and reports as engaged-at-unity, so the
  // lane says so rather than drawing an empty bar that reads as silence.
  it("says so when no key is wired, and leaves the lane tapless", () => {
    const plan = defaultPlan("URX44V");
    plan.connections = plan.connections.filter((c) => !(c.kind === "key" && c.to === ref(DUCKER, "in")));
    const key = DUCKER_DYN.bind(ctxFor(DUCKER, plan))!.lanes[0];
    expect(key.label).toBe(t().dynTuning.ducker.noKey);
    expect(key.tap).toBeNull();
    expect(key.kind).toBe("level");
  });

  // The reduction is applied to the PRE DUCKER signal — the key only decides when —
  // so the level going in and the amount taken off it share one column and one ruler.
  it("merges the reduction into the pre-ducker lane's slot", () => {
    const lanes = DUCKER_DYN.bind(ctxFor(DUCKER))!.lanes;
    const gr = lanes.find((l) => l.key === "gr")!;
    expect(gr.kind).toBe("gr");
    expect(gr.sameSlot).toBe(true);
    // It shares the ruler by construction, so it must not declare a scale of its own.
    expect(gr.fullDb).toBeUndefined();
    expect(lanes[lanes.indexOf(gr) - 1].key).toBe("out");
  });

  it("reads and patches the ducker's own sub-object", () => {
    const plan = defaultPlan("URX44V");
    plan.nodeParams[DUCKER] = { ...plan.nodeParams[DUCKER], ducker: { threshold: -24 } };
    const ctx = ctxFor(DUCKER, plan);
    expect(DUCKER_DYN.read(ctx)).toMatchObject({ threshold: -24 });
    expect(DUCKER_DYN.patch(ctx, { attack: 5 })).toEqual({ ducker: { threshold: -24, attack: 5 } });
  });

  it("reads an empty record on a ducker with no stored values", () => {
    const plan = defaultPlan("URX44V");
    delete plan.nodeParams[DUCKER];
    expect(DUCKER_DYN.read(ctxFor(DUCKER, plan))).toEqual({});
  });

  // The MIDI catalog carries a ducker's `duckerOn` and nothing else, so returning ids
  // for these sliders would arm learn against controls that do not exist. The envelope
  // carries three editable values on a time axis, so a press on it has no unambiguous
  // reading either.
  it("offers no MIDI ids and no plot drag", () => {
    expect(DUCKER_DYN.controlId).toBeUndefined();
    expect(DUCKER_DYN.plotDragsCap).toBeUndefined();
    expect(DUCKER_DYN.bar).toBeUndefined();
  });
});

describe("envelope plot", () => {
  const W = 600;
  const H = 320;
  const geo = DUCKER_DYN.plotGeo(W, H, ctxFor(DUCKER));
  const TOK: Record<string, string> = {};

  // The floor is the range control's deepest setting and nothing beyond it. The
  // ducker shares the broker's `range` table with the GATE, whose floor is -72, and
  // reading the axis off that shared table drew 2 dB the control cannot reach — so
  // -72 landing PAST the floor is half of what this pins.
  it("puts unity at the top of the gain axis and the deepest range at its floor", () => {
    expect(geo.py(0)).toBeCloseTo(geo.pad.t, 5);
    expect(geo.py(-70)).toBeCloseTo(H - geo.pad.b, 5);
    expect(geo.py(-72)).toBeGreaterThan(H - geo.pad.b);
    expect(geo.py(-36)).toBeGreaterThan(geo.py(0));
  });

  // Attack starts at 0.092 ms and decay reaches 5 s: they do not share a decade, so
  // the time axis is logarithmic and spans both controls at once.
  it("spans both time controls on a log axis", () => {
    const [a, b, c] = [geo.px(0.1), geo.px(1), geo.px(10)];
    expect(b - a).toBeCloseTo(c - b, 0);
    expect(geo.px(0.01)).toBeCloseTo(geo.pad.l, 5);
  });

  it("draws a tick per decade and a gain rule per label", () => {
    const r = recorder();
    DUCKER_DYN.drawAxes(r.ctx, geo, TOK, ctxFor(DUCKER));
    // Six time ticks + five gain rules, each a stroked path plus its label.
    expect(r.texts.length).toBeGreaterThanOrEqual(12);
  });

  it("draws attack down to the range floor and decay back to unity", () => {
    const r = recorder();
    DUCKER_DYN.drawCurve(r.ctx, geo, vals({ range: -30, attack: 10, decay: 500 }), TOK, ctxFor(DUCKER));
    expect(r.ys[0]).toBeCloseTo(geo.py(0), 5);
    expect(Math.max(...r.ys)).toBeCloseTo(geo.py(-30), 5);
    expect(r.ys.at(-1)).toBeCloseTo(geo.py(0), 5);
  });

  // The release ramp is clamped to the axis end; the values it stands for are still
  // printed, so a decay past the axis is readable rather than invisible.
  it("keeps the release ramp on the axis when the decay runs past it", () => {
    const r = recorder();
    DUCKER_DYN.drawCurve(r.ctx, geo, vals({ range: -20, attack: 60, decay: 9000 }), TOK, ctxFor(DUCKER));
    expect(Math.max(...r.ys)).toBeCloseTo(geo.py(-20), 5);
    expect(r.texts).toHaveLength(3);
  });

  // The envelope is what the three settings DO; the meter beside it is what is
  // happening. Two live displays of one quantity, and the plot's was the weaker.
  it("has no live overlay", () => {
    expect(DUCKER_DYN.drawLive).toBeUndefined();
  });
});

describe("on screen", () => {
  it("opens on a ducker node and draws its lanes beside its envelope", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(DUCKER_DYN, DUCKER);
    expect(screen.isOpen()).toBe(true);
    expect(host.box.querySelector(".gt-splitdisplay")).not.toBeNull();
    expect(host.box.querySelector("#dyn-curve")).not.toBeNull();
    expect(readouts(host.box)).toHaveLength(4);
    expect(host.canvas.ys.length).toBeGreaterThan(0);
  });

  it("shows the threshold as a fader cap on the key lane", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(DUCKER_DYN, DUCKER);
    const cap = host.box.querySelector<HTMLElement>("#dyn-threshold-cap")!;
    expect(cap).not.toBeNull();
    expect(cap.getAttribute("role")).toBe("slider");
    expect(cap.getAttribute("aria-valuemax")).toBe("0");
  });

  it("moves the threshold from the cap's arrow keys, one field step at a time", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(DUCKER_DYN, DUCKER);
    const cap = host.box.querySelector<HTMLElement>("#dyn-threshold-cap")!;
    const before = Number(cap.getAttribute("aria-valuenow"));

    cap.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(host.patches).toHaveLength(1);
    expect(Number(cap.getAttribute("aria-valuenow"))).toBeGreaterThan(before);

    cap.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(Number(cap.getAttribute("aria-valuenow"))).toBe(before);
  });

  it("takes six steps for a page key and none for any other", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(DUCKER_DYN, DUCKER);
    const cap = host.box.querySelector<HTMLElement>("#dyn-threshold-cap")!;
    const before = Number(cap.getAttribute("aria-valuenow"));

    cap.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    const oneStep = Number(cap.getAttribute("aria-valuenow")) - before;
    cap.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

    cap.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    expect(Number(cap.getAttribute("aria-valuenow")) - before).toBeCloseTo(oneStep * 6, 5);

    const held = cap.getAttribute("aria-valuenow");
    cap.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(cap.getAttribute("aria-valuenow")).toBe(held);
  });

  it("clamps the cap to the ruler at both ends", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(DUCKER_DYN, DUCKER);
    const cap = host.box.querySelector<HTMLElement>("#dyn-threshold-cap")!;
    for (let i = 0; i < 60; i++) cap.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    expect(Number(cap.getAttribute("aria-valuenow"))).toBe(0);
    for (let i = 0; i < 60; i++) cap.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
    expect(Number(cap.getAttribute("aria-valuenow"))).toBe(DUCKER_DYN.loDb);
  });

  it("prints the hint the picture cannot say", () => {
    host = dynHost();
    const screen = new DynScreen(host.hooks);
    screen.open(DUCKER_DYN, DUCKER);
    expect(host.box.querySelector(".gt-note")!.textContent).toBe(t().dynTuning.ducker.hint);
  });

  it("subscribes the key, the level pair and the reduction", () => {
    host = dynHost({ live: true });
    const screen = new DynScreen(host.hooks);
    screen.open(DUCKER_DYN, DUCKER);
    const addrs = meterMocks.subscribe.mock.calls.at(-1)![1] as Array<[number, number]>;
    // Key (one folded pair = L + R addresses), pre and post level pairs, and the GR.
    expect(addrs.length).toBeGreaterThanOrEqual(4);
  });
});
