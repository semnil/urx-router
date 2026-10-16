import { describe, expect, it, vi } from "vitest";
import { tapFor, tapsFor } from "../core/meters";
import { getModel } from "../models";
import { defaultPlan } from "../models/initial-state";
import { simBindings } from "../core/sim-map";
import { CueSet } from "../core/control/cue";
import { cueAddrs } from "../core/control/translate";
import { PlanTransport, SENDS_TARGET_PATH, type SimViewHooks } from "./sim-view";
import { simMeterTap } from "./sim-view";

describe("the SIM's meters", () => {
  it("read the tap of the same name on the strip the LCD names", () => {
    expect(simMeterTap("ch1@input", "URX44V")).toEqual(tapFor("ch1", "input", "URX44V"));
    expect(simMeterTap("ch1@preFader", "URX44V")).toEqual(tapFor("ch1", "prefader", "URX44V"));
    expect(simMeterTap("ch1@preComp", "URX44V")).toEqual(tapFor("ch1", "precomp", "URX44V"));
    expect(simMeterTap("bus.mix1@post", "URX44V")).toEqual(tapFor("bus.mix1", "post", "URX44V"));
  });

  it("read what a strip puts out for a bare strip id", () => {
    expect(simMeterTap("bus.stereo", "URX44V")).toEqual(tapFor("bus.stereo", "post", "URX44V"));
  });

  it("read an FX channel's effect before its fader, and a bus's sum before its EQ", () => {
    expect(simMeterTap("fx1@effect", "URX44V")).toEqual(tapFor("bus.fx1", "prefader", "URX44V"));
    expect(simMeterTap("bus.mix2@sum", "URX44V")).toEqual(tapFor("bus.mix2", "preeq", "URX44V"));
  });

  it("read a stereo channel's input for the PRE EQ point its chain does not have", () => {
    expect(tapsFor("ch_5_6", "URX44V").some((t) => t.key === "preeq")).toBe(false);
    expect(simMeterTap("ch_5_6@preEq", "URX44V")).toEqual(tapFor("ch_5_6", "input", "URX44V"));
  });

  it("read the monitor buses and the oscillator off their outputs", () => {
    expect(simMeterTap("monitor.2", "URX44V")).toEqual(tapFor("bus.mon2", "post", "URX44V"));
    expect(simMeterTap("osc", "URX44V")).toEqual(tapFor("bus.osc", "post", "URX44V"));
  });

  it("read nothing where the session meters nothing", () => {
    expect(simMeterTap("cue", "URX44V")).toBeNull();
    expect(simMeterTap("playback", "URX44V")).toBeNull();
    expect(simMeterTap("ch1@nowhere", "URX44V")).toBeNull();
  });
});

describe("the plan as the glass's transport", () => {
  const model = getModel("URX44V");
  const plan = defaultPlan("URX44V");
  const transport = (
    hooks: Partial<
      Pick<
        SimViewHooks,
        | "apply"
        | "unitSendsTarget"
        | "setUnitSendsTarget"
        | "unitCues"
        | "setUnitCue"
        | "clearUnitCues"
      >
    > = {},
  ): PlanTransport =>
    new PlanTransport(simBindings(model), new Map([["ui.bank", "CH 1 - 4"]]), {
      getPlan: () => plan,
      apply: hooks.apply ?? (() => true),
      unitSendsTarget: hooks.unitSendsTarget ?? (() => null),
      setUnitSendsTarget: hooks.setUnitSendsTarget ?? (() => false),
      unitCues: hooks.unitCues ?? (() => null),
      setUnitCue: hooks.setUnitCue ?? (() => false),
      clearUnitCues: hooks.clearUnitCues ?? (() => false),
    });
  const flush = () => new Promise<void>((r) => queueMicrotask(r));

  it("keeps the simulator's own state itself, and shows it in the next snapshot", async () => {
    const t = transport();
    for (const path of [
      "pair.ch1.compSplit",
      "sd.playing",
      "sd.playingFile",
      "setup.outputPatch.tab",
      "scene.selected",
      "sd.selectedFile",
    ])
      expect(t.writable(path), path).toBe(true);
    expect(t.writable("setup.followUsb"), "a device setting the plan does not hold").toBe(false);
    await expect(t.write("pair.ch1.compSplit", true)).resolves.toBe(true);
    expect((await t.snapshot()).get("pair.ch1.compSplit")).toBe(true);
    expect((await t.snapshot()).get("ui.bank"), "the unit as it ships elsewhere").toBe("CH 1 - 4");
  });

  it("answers a write with the value the plan took, once it differs from the one written", async () => {
    // A funnel that takes the edit and leaves the plan as it is.
    const t = transport({ apply: () => true });
    const heard = vi.fn();
    t.onNotify(heard);
    const before = simBindings(model).get("ch.ch1.level")!.read(plan);
    expect(before).not.toBe(-12);
    await expect(t.write("ch.ch1.level", -12)).resolves.toBe(before);
    await flush();
    expect(heard).toHaveBeenCalledWith({ path: "ch.ch1.level", value: before, echo: true });
  });

  it("refuses a write the funnel refuses, and one of a path the plan does not hold", async () => {
    await expect(transport({ apply: () => false }).write("ch.ch1.level", -12)).rejects.toThrow("refused");
    await expect(transport().write("setup.followUsb", true)).rejects.toThrow("not the plan's");
  });

  it("hands HOME's [Sends] destination to the unit only while a session holds it", async () => {
    expect(transport().writable(SENDS_TARGET_PATH)).toBe(false);
    const set = vi.fn(() => true);
    const t = transport({ unitSendsTarget: () => "MIX1", setUnitSendsTarget: set });
    expect(t.writable(SENDS_TARGET_PATH)).toBe(true);
    expect((await t.snapshot()).get(SENDS_TARGET_PATH)).toBe("MIX1");
    await expect(t.write(SENDS_TARGET_PATH, "FX1")).resolves.toBe("FX1");
    expect(set).toHaveBeenCalledWith("FX1");
    await expect(transport({ unitSendsTarget: () => "MIX1" }).write(SENDS_TARGET_PATH, "FX2")).rejects.toThrow(
      "refused",
    );
  });

  // A session's [CUE] flags kept by the unit's own rules, recording what the glass hands it.
  const session = (cued: string[]) => {
    const set = new CueSet(model);
    set.replace(cued);
    const calls: (string | [string, boolean])[] = [];
    const hooks = {
      unitCues: () => new Map(cueAddrs(model).map((a) => [a.node, set.has(a.node)])),
      setUnitCue: (node: string, on: boolean) => {
        calls.push([node, on]);
        set.apply(node, on);
        return true;
      },
      clearUnitCues: () => {
        calls.push("clear");
        set.clear();
        return true;
      },
    };
    return { set, calls, hooks };
  };

  it("shows the session's [CUE] flags, and takes a press only while a session holds them", async () => {
    expect(transport().writable("ch.ch1.cue")).toBe(false);
    await expect(transport().write("ch.ch1.cue", true)).rejects.toThrow("not the plan's");
    const { set, calls, hooks } = session(["ch2", "bus.fx1"]);
    const t = transport(hooks);
    expect(t.writable("ch.ch1.cue")).toBe(true);
    expect(t.writable("ch.fx1.cue")).toBe(true);
    const shown = await t.snapshot();
    expect([shown.get("ch.ch1.cue"), shown.get("ch.ch2.cue"), shown.get("ch.fx1.cue")]).toEqual([false, true, true]);
    await expect(t.write("ch.ch1.cue", true)).resolves.toBe(true);
    expect(calls).toEqual([["ch1", true]]);
    expect(set.nodes()).toEqual(["ch1", "ch2", "bus.fx1"]);
  });

  it("hands on the press an input cue is, not the output cues its rule turned off", async () => {
    const { set, calls, hooks } = session(["bus.stereo"]);
    const t = transport(hooks);
    // As the glass sends one press: the output its rule took out, then the strip pressed.
    const writes = [t.write("ch.bus.stereo.cue", false), t.write("ch.ch1.cue", true)];
    await expect(Promise.all(writes)).resolves.toEqual([false, true]);
    expect(calls).toEqual([["ch1", true]]);
    expect(set.nodes()).toEqual(["ch1"]);
  });

  it("hands on the press an output cue is, not the input cues its rule turned off", async () => {
    const { set, calls, hooks } = session(["ch1", "ch2"]);
    const t = transport(hooks);
    await Promise.all([t.write("ch.ch1.cue", false), t.write("ch.ch2.cue", false), t.write("ch.bus.stereo.cue", true)]);
    expect(calls).toEqual([["bus.stereo", true]]);
    expect(set.nodes()).toEqual(["bus.stereo"]);
  });

  it("hands on the glass's CLEAR CUE as the session's, and a cue turned off alone as itself", async () => {
    const all = session(["ch1", "ch2"]);
    const t = transport(all.hooks);
    await Promise.all([t.write("ch.ch1.cue", false), t.write("ch.ch2.cue", false)]);
    expect(all.calls).toEqual(["clear"]);
    const one = session(["ch1", "ch2"]);
    await transport(one.hooks).write("ch.ch1.cue", false);
    expect(one.calls).toEqual([["ch1", false]]);
    expect(one.set.nodes()).toEqual(["ch2"]);
  });

  it("refuses a press the session refuses", async () => {
    const { hooks } = session([]);
    await expect(transport({ ...hooks, setUnitCue: () => false }).write("ch.ch1.cue", true)).rejects.toThrow("refused");
  });

  it("takes nothing and tells nothing once closed", async () => {
    const t = transport({ apply: () => true });
    const heard = vi.fn();
    t.onNotify(heard);
    const write = t.write("ch.ch1.level", -12);
    t.close();
    await write;
    await flush();
    expect(heard).not.toHaveBeenCalled();
    await expect(t.snapshot()).rejects.toThrow("closed");
    await expect(t.write("ch.ch1.level", -12)).rejects.toThrow("closed");
  });
});
