// @vitest-environment jsdom
import { afterEach, describe, it, expect } from "vitest";
import { Console } from "./console";
import { consoleHost, type ConsoleHost } from "./console.test-util";
import { getModel } from "../models";
import { defaultPlan } from "../models/initial-state";
import { COMP_EQ_COMP_FIRST, COMP_EQ_SSMCS } from "../core/control/params";
import type { Plan } from "../core/plan";

describe("Console UI", () => {
  it("threads modelId URX22 correctly to resolve meters (e.g. ch_3_4 input tap)", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);

    const model = getModel("URX22");
    const plan = defaultPlan("URX22");

    const hooks = {
      getModel: () => model,
      getPlan: () => plan,
      onChange: () => {},
    };

    const consoleInstance = new Console(host, hooks);
    consoleInstance.show();

    // Re-read the map each time: a render swaps in a fresh one.
    const refs = () => (consoleInstance as any).refs;
    const stripRef = refs().get("ch_3_4");

    expect(stripRef).toBeDefined();
    // Default tap for ch_3_4 is post (post-ducker) which maps to [120, 0] / [120, 1]
    expect(stripRef.tap).toBeDefined();
    expect(stripRef.tap.key).toBe("post");
    expect(stripRef.tap.l).toEqual([120, 0]);
    expect(stripRef.tap.r).toEqual([120, 1]);

    // Change the tap of ch_3_4 to input
    (consoleInstance as any).setTap("ch_3_4", "input");

    const updatedStripRef = refs().get("ch_3_4");
    expect(updatedStripRef.tap).toBeDefined();
    expect(updatedStripRef.tap.key).toBe("input");
    expect(updatedStripRef.tap.l).toEqual([101, 0]);
    expect(updatedStripRef.tap.r).toEqual([101, 1]);

    // Clean up
    consoleInstance.hide();
    document.body.removeChild(host);
  });

  // A re-render replaces every strip element. While Live sync streams, that must not
  // show: the meter's ballistics carry onto the fresh lanes and the rebuilt strips are
  // painted in the same task, so no frame draws them at the floor with a blank readout
  // (device follow re-renders on every device-side edit — this was the 10 s blink).
  it("carries the live meters across a re-render with no blank frame", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const model = getModel("URX44V");
    const plan = defaultPlan("URX44V");
    const consoleInstance = new Console(host, { getModel: () => model, getPlan: () => plan, onChange: () => {} });
    const priv = consoleInstance as any;
    consoleInstance.show();
    consoleInstance.setLive(true);

    // Nothing streamed yet: the readout holds "—" rather than claiming silence.
    expect(priv.refs.get("ch1").readMtr.textContent).toBe("—");

    priv.store.apply({ meterId: 115, x: 0, value: -100 }); // CH 1 POST = -10.0 dBFS
    priv.paintMeters(); // one animation-loop frame
    const lit = priv.refs.get("ch1").lanes[0].v;
    expect(lit).toBeGreaterThan(0);
    expect(priv.refs.get("ch1").readMtr.textContent).toBe("-10.0");

    consoleInstance.refresh(); // full re-render — new elements for every strip
    const fresh = priv.refs.get("ch1");
    expect(fresh.lanes[0].v).toBeCloseTo(lit, 5); // ballistics carried, no re-attack
    expect(fresh.readMtr.textContent).toBe("-10.0"); // redrawn before the browser drew

    // A device-side edit rebuilds a single strip, faster than the readout's throttle:
    // the same redraw has to happen there, or the value flickers against "—".
    consoleInstance.refreshStrip("ch1");
    expect(priv.refs.get("ch1").readMtr.textContent).toBe("-10.0");
    expect(priv.refs.get("ch1").lanes[0].v).toBeCloseTo(lit, 5);

    consoleInstance.setLive(false);
    consoleInstance.hide();
    document.body.removeChild(host);
  });

  // Same rebuild, same problem for the keyboard: a control being ridden with the arrow
  // keys must still be the focused one afterwards.
  it("hands keyboard focus back to the same control after a re-render", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const model = getModel("URX44V");
    const plan = defaultPlan("URX44V");
    const consoleInstance = new Console(host, { getModel: () => model, getPlan: () => plan, onChange: () => {} });
    consoleInstance.show();

    const faderOf = (): HTMLElement => host.querySelector<HTMLElement>('.con-strip [role="slider"]')!;
    const before = faderOf();
    before.focus();
    expect(document.activeElement).toBe(before);

    consoleInstance.refresh();
    const after = faderOf();
    expect(after).not.toBe(before); // the strip really was rebuilt
    expect(document.activeElement).toBe(after);

    consoleInstance.hide();
    document.body.removeChild(host);
  });

  // Above 96 kHz no insert effect can run, so the chip must not offer a toggle that
  // silently selects one the device would refuse. It gets the stereo EQ's treatment:
  // shown, forced off, inert.
  it("locks the INS FX chip off above 96 kHz and restores it below", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const model = getModel("URX44V");
    const plan = defaultPlan("URX44V");
    const consoleInstance = new Console(host, { getModel: () => model, getPlan: () => plan, onChange: () => {} });

    const insFxChip = (): HTMLElement | undefined =>
      [...host.querySelectorAll<HTMLElement>(".con-chip")].find((c) => c.textContent === "INS FX");

    plan.sampleRate = 192000;
    consoleInstance.show();
    const locked = insFxChip();
    expect(locked).toBeDefined();
    expect(locked!.getAttribute("aria-disabled")).toBe("true");
    expect(locked!.getAttribute("aria-pressed")).toBe("false");
    // A click on an inert chip must not select an effect the rate cannot run
    // (the plan ships with No Effect selected, so it has to stay there).
    const before = plan.nodeParams["ch1"]?.insertFx;
    locked!.click();
    expect(plan.nodeParams["ch1"]?.insertFx).toBe(before);
    expect(plan.nodeParams["ch1"]?.insertFxOn).toBeUndefined();

    plan.sampleRate = 96000;
    consoleInstance.refresh();
    const live = insFxChip();
    expect(live!.getAttribute("aria-disabled")).toBeNull();

    consoleInstance.hide();
    document.body.removeChild(host);
  });
});

// Every head is clamped to the tallest one, measured off-screen once and cached. What
// the cache is keyed by decides whether a head that grew a row gets the space: keyed by
// model and hidden set alone, switching a channel back to COMP->EQ added a chip row the
// remembered height had no room for, and the head stayed clipped until something rebuilt
// the view under a different key (a model switch, a hide/show, a reload).
//
// jsdom lays nothing out, so the height comes from `headHeight` (console.test-util.ts):
// a stand-in that counts the head's chips. Only its direction is faithful — a head with
// more chips measures taller — which is the whole of what the cache key has to track.
// It doubles as the re-measure counter, since a call to it IS the view laying the strips
// out again; that is the only observable for a key term that changes no height, which is
// what the sample rate was measured to be (console.ts, `mainHeadHeight`).
describe("the head-height cache", () => {
  const chips = (head: HTMLElement): number => head.querySelectorAll(".con-chip").length;
  const px = (head: HTMLElement): number => 40 + 12 * chips(head);
  const headH = (h: ConsoleHost): string => h.host.style.getPropertyValue("--head-h");
  /** The tallest head as the stand-in measures it now, whatever the cache says. */
  const tallest = (h: ConsoleHost): number =>
    Math.max(...[...h.host.querySelectorAll<HTMLElement>(".con-head")].map(px));

  let h: ConsoleHost;
  let measures = 0;
  /** Mount with the content-derived head height, counting each off-screen measure. */
  const mount = (plan: Plan): ConsoleHost => {
    measures = 0;
    return consoleHost({
      modelId: "URX44V",
      plan,
      headHeight: (head) => {
        measures++;
        return px(head);
      },
    });
  };
  /** Every mono channel's COMP/EQ type at once — one channel's would not move the
   *  tallest head, since the others keep the openers it lost. */
  const setCompEq = (plan: Plan, type: number): void => {
    for (const [id, np] of Object.entries(plan.nodeParams))
      if (np?.compEqType !== undefined) plan.nodeParams[id] = { ...np, compEqType: type };
  };

  afterEach(() => h?.restore());

  // The finding's own direction: an SSMCS channel carries no COMP or EQ opener, so a
  // plan seeded in SSMCS measures short, and switching back to COMP->EQ is what needs
  // the room the cached height did not have.
  it("re-measures when the COMP/EQ type changes, and the height moves", () => {
    const plan = defaultPlan("URX44V");
    setCompEq(plan, COMP_EQ_SSMCS);
    h = mount(plan);
    const short = headH(h);
    expect(short).toBe(`${tallest(h)}px`);

    setCompEq(plan, COMP_EQ_COMP_FIRST);
    h.view.refresh();

    expect(headH(h)).toBe(`${tallest(h)}px`);
    expect(Number.parseInt(headH(h))).toBeGreaterThan(Number.parseInt(short));
  });

  // The rate is the other key term, and it is in the key for a different reason: it
  // changes what a stereo head CARRIES (above 96 kHz the EQ opener goes) without changing
  // its height, because the parity spacer takes the freed slot. So what a rate change has
  // to produce is the re-measure — the height it lands on is the same one.
  it("re-measures when the sample rate changes, at the same height", () => {
    const plan = defaultPlan("URX44V");
    h = mount(plan);
    const at48 = headH(h);
    const measuredOnce = measures;
    expect(measuredOnce).toBeGreaterThan(0);

    plan.sampleRate = 192000;
    h.view.refresh();

    expect(measures).toBeGreaterThan(measuredOnce);
    expect(headH(h)).toBe(at48);
    expect(headH(h)).toBe(`${tallest(h)}px`);
  });

  // …and it is still a cache. A re-render that changes none of its inputs must not pay
  // for a second off-screen build of every strip — which is the cost the key exists to
  // avoid, and what a key of "everything" would give up.
  it("does not re-measure when nothing that shapes a head changed", () => {
    h = mount(defaultPlan("URX44V"));
    const measuredOnce = measures;
    expect(measuredOnce).toBeGreaterThan(0);

    h.view.refresh();

    expect(measures).toBe(measuredOnce);
  });
});
