// Which per-send controls a wire shows, in what order, and what a wire with none of
// them says instead. The order is the device's own SEND TO screen order, and the
// visibility is decided by the destination bus's locks — both of which a rendered
// panel can only be checked against one wire at a time.

import { describe, expect, it } from "vitest";
import { PARAM_FIELDS, isBalanceChannel, sendFields, sendlessNote } from "./send-fields";
import { getModel } from "../models";
import { defaultPlan } from "../models/initial-state";
import { BUS_TYPE_FIXED, BUS_TYPE_VARI } from "../core/control/params";

const model = getModel("URX44V");
const plan = () => defaultPlan("URX44V");

describe("PARAM_FIELDS", () => {
  // Only summing sends carry LEVEL / PRE-POST / PAN per the block diagram;
  // selectors and output patches are assignments with no per-connection mix.
  it("gives per-send parameters to summing sends alone", () => {
    expect(PARAM_FIELDS.send).toEqual(["tap", "pan", "level"]);
    for (const kind of ["sendSwitch", "source", "patch", "key", "record"] as const) {
      expect(PARAM_FIELDS[kind]).toEqual([]);
    }
  });
});

describe("sendFields", () => {
  const toMix1 = (p = plan()): ReturnType<typeof sendFields> => sendFields(model, p, "send", "ch1:out", "bus.mix1:in");

  it("shows PRE, Pan and Level on an ordinary VARI mix send", () => {
    const p = plan();
    p.nodeParams["bus.mix1"] = { ...p.nodeParams["bus.mix1"], busType: BUS_TYPE_VARI, panLink: false };
    const { fields, busFixed, panLinked } = toMix1(p);
    expect(fields).toEqual(["tap", "pan", "level"]);
    expect(busFixed).toBe(false);
    expect(panLinked).toBe(false);
  });

  // A FIXED bus type drops the LEVEL: the send level is fixed on the device.
  it("drops the level on a FIXED bus", () => {
    const p = plan();
    p.nodeParams["bus.mix1"] = { ...p.nodeParams["bus.mix1"], busType: BUS_TYPE_FIXED };
    const { fields, busFixed } = toMix1(p);
    expect(busFixed).toBe(true);
    expect(fields).not.toContain("level");
    expect(fields).toContain("pan");
  });

  // Pan Link (VARI only) drops the PAN: it follows the source channel's own PAN.
  it("drops the pan when the destination links it", () => {
    const p = plan();
    p.nodeParams["bus.mix1"] = { ...p.nodeParams["bus.mix1"], busType: BUS_TYPE_VARI, panLink: true };
    const { fields, panLinked } = toMix1(p);
    expect(panLinked).toBe(true);
    expect(fields).not.toContain("pan");
    expect(fields).toContain("level");
  });

  // PRE/POST is taken against the channel's STEREO main-fader level, so the fixed
  // STEREO main path shows LEVEL / PAN but no PRE/POST.
  it("drops the tap on the fixed STEREO main path", () => {
    const { fields } = sendFields(model, plan(), "send", "ch1:out", "bus.stereo:in");
    expect(fields).not.toContain("tap");
  });

  it("shows nothing for a kind that carries no per-send parameters", () => {
    expect(sendFields(model, plan(), "patch", "bus.stereo:out", "out.usbmain_a:in").fields).toEqual([]);
    expect(sendFields(model, plan(), "key", "ch1:out", "out.ducker1:in").fields).toEqual([]);
  });

  // The order is the device SEND TO screen's, read top to bottom.
  it("keeps the device's own row order whatever is dropped", () => {
    const p = plan();
    p.nodeParams["bus.mix1"] = { ...p.nodeParams["bus.mix1"], busType: BUS_TYPE_VARI, panLink: true };
    expect(toMix1(p).fields).toEqual(["tap", "level"]);
  });
});

describe("isBalanceChannel", () => {
  it("reads a native stereo channel's pan as a balance", () => {
    expect(isBalanceChannel(model, plan(), "ch_5_6")).toBe(true);
  });

  it("reads an FX return's pan as a balance", () => {
    const fx = model.nodes.find((n) => n.id.startsWith("fx"))?.id;
    if (fx) expect(isBalanceChannel(model, plan(), fx)).toBe(true);
  });

  it("reads a plain MONO IN channel's pan as a pan", () => {
    expect(isBalanceChannel(model, plan(), "ch1")).toBe(false);
  });

  // A STEREO-linked MONO IN pair switched to BAL mode is a balance too.
  it("reads a STEREO-linked pair in BAL mode as a balance", () => {
    const p = plan();
    p.nodeParams["ch1"] = { ...p.nodeParams["ch1"], stereoLink: true, panBal: 1 };
    p.nodeParams["ch2"] = { ...p.nodeParams["ch2"], stereoLink: true, panBal: 1 };
    expect(isBalanceChannel(model, p, "ch1")).toBe(isBalanceChannel(model, p, "ch2"));
  });
});

describe("sendlessNote", () => {
  // A USB direct out is a live output where the missing fader / Ducker is a surprise;
  // a microSD Rec tap records the Rec Point stage on purpose.
  it("names the USB direct out's missing fader", () => {
    expect(sendlessNote(model, "ch1:out", "out.usbmain_a:in")).toBe("directOutTap");
  });

  it("points a microSD Rec tap at the Rec Point stage it records", () => {
    const slot = model.nodes.find((n) => n.id.startsWith("out.sdrec."));
    if (!slot) throw new Error("the URX44V has SD Rec slots; this fixture depends on one");
    expect(sendlessNote(model, "ch1:out", `${slot.id}:in`)).toBe("sdRecTap");
  });

  // A channel ducker key is the same pre-fader Rec Point tap, so the source
  // channel's fader / mute do not move the trigger; a bus key is post-fader.
  it("names a channel ducker key's tap and leaves a bus key unannotated", () => {
    expect(sendlessNote(model, "ch1:out", "out.ducker1:in")).toBe("duckerKeyTap");
    expect(sendlessNote(model, "bus.stereo:out", "out.ducker1:in")).toBe("selectionOnly");
  });

  it("falls back to the generic note for anything else", () => {
    expect(sendlessNote(model, "ch1:out", "bus.mix1:in")).toBe("selectionOnly");
  });

  // It answers with a catalog key, not a string: the module stays language-
  // independent like core/*.
  it("answers with a message key rather than prose", () => {
    const key = sendlessNote(model, "ch1:out", "out.ducker1:in");
    expect(["directOutTap", "sdRecTap", "duckerKeyTap", "selectionOnly"]).toContain(key);
  });
});
