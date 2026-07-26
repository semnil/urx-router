// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { Console } from "./console";
import { getModel } from "../models";
import { defaultPlan } from "../models/initial-state";

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
