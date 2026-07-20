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

    const refs = (consoleInstance as any).refs;
    const stripRef = refs.get("ch_3_4");

    expect(stripRef).toBeDefined();
    // Default tap for ch_3_4 is post (post-ducker) which maps to [120, 0] / [120, 1]
    expect(stripRef.tap).toBeDefined();
    expect(stripRef.tap.key).toBe("post");
    expect(stripRef.tap.l).toEqual([120, 0]);
    expect(stripRef.tap.r).toEqual([120, 1]);

    // Change the tap of ch_3_4 to input
    (consoleInstance as any).setTap("ch_3_4", "input");

    const updatedStripRef = refs.get("ch_3_4");
    expect(updatedStripRef.tap).toBeDefined();
    expect(updatedStripRef.tap.key).toBe("input");
    expect(updatedStripRef.tap.l).toEqual([101, 0]);
    expect(updatedStripRef.tap.r).toEqual([101, 1]);

    // Clean up
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
