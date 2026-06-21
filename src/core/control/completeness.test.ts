// Completeness of the device-write command set. planToCommands writes ABSOLUTE
// state: a wire-based selector (send / input source / routing / ducker key / OSC
// assign) absent from the plan is cleared (SEND_ON=0 / NONE / off), not omitted,
// so a write drives the device fully to the plan rather than only adding to it.
//
// The strong guarantee is a fixed point: once the device has been read into a
// plan, emitting that plan reproduces exactly the values that were read, and
// reading those back gives the same plan. So emit∘readback applied twice yields
// the identical command set — any parameter emit writes but readback cannot read
// (or vice versa) would break the round trip and is caught here. This is the
// software twin of the live idempotent double-write check.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../../models";
import { emptyPlan, ensureFixedConnections } from "../plan";

vi.mock("../platform", () => ({ vdGet: vi.fn() }));

import { vdGet } from "../platform";
import { applyDeviceState } from "./readback";
import { planToCommands } from "./translate";
import type { VdCommand } from "./translate";
import { PORT_REF_NONE } from "./vd";

const model = getModel("URX44V");

// param_ids whose value is a port-ref: an address never written reads back as the
// broker's "nothing selected" sentinel, so the default device value for them is
// NONE rather than 0 (matches the device and readback.ts decoding).
const PORT_REF_PARAMS = new Set([22, 259, 705, 706, 719, 720, 730, 731, 732, 733, 734, 735]);

function mockDevice(table: Map<string, number>): void {
  vi.mocked(vdGet).mockImplementation((id, x, y) => {
    const k = `${id}:${x}:${y}`;
    if (table.has(k)) return Promise.resolve(table.get(k)!);
    return Promise.resolve(PORT_REF_PARAMS.has(id) ? PORT_REF_NONE : 0);
  });
}

function tableFrom(cmds: VdCommand[]): Map<string, number> {
  const t = new Map<string, number>();
  for (const c of cmds) t.set(`${c.paramId}:${c.x}:${c.y}`, c.vdValue);
  return t;
}

// Address=value pairs, sorted — a set comparison independent of emit order.
function addrVals(cmds: VdCommand[]): string[] {
  return cmds.map((c) => `${c.paramId}:${c.x}:${c.y}=${c.vdValue}`).sort();
}

// Read the (mocked) device into a fresh plan, then emit the plan's command set.
async function readThenEmit(table: Map<string, number>): Promise<VdCommand[]> {
  mockDevice(table);
  const plan = emptyPlan("URX44V");
  await applyDeviceState(model, plan);
  return planToCommands(model, plan);
}

beforeEach(() => vi.mocked(vdGet).mockReset());

describe("planToCommands absolute-state completeness", () => {
  it("clears every wire-based selector for an empty plan (OFF / NONE, never omitted)", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    const cmds = planToCommands(model, plan);
    const named = (n: string) => cmds.filter((c) => c.name === n);

    // Sends: every send-capable pair emits SEND_ON, never omitted. Every send is
    // now fixed (always wired) and seeded ON at -∞ by ensureFixedConnections
    // (params.on absent = on), so they all read SEND_ON = 1.
    expect(named("SEND_ON").length).toBeGreaterThan(0);
    expect(named("SEND_ON").every((c) => c.vdValue === 1)).toBe(true);

    // Input source + routing-source + ducker key selectors: all the NONE sentinel.
    for (const n of [
      "INPUT_SOURCE",
      "STREAM_SRC_L",
      "STREAM_SRC_R",
      "MONITOR_SRC_L",
      "MONITOR_SRC_R",
      "OUT_PATCH_MAIN",
      "USB_OUT_SRC_A",
      "DUCKER_SRC",
    ]) {
      expect(named(n).length, n).toBeGreaterThan(0);
      expect(
        named(n).every((c) => c.vdValue === PORT_REF_NONE),
        n,
      ).toBe(true);
    }

    // OSC → bus assign: every assignable bus emits its toggle(s), all off.
    for (const n of ["OSC_ASSIGN_STEREO", "OSC_ASSIGN_MIX", "OSC_ASSIGN_FX"]) {
      expect(named(n).length, n).toBeGreaterThan(0);
      expect(named(n).every((c) => c.vdValue === 0), n).toBe(true);
    }
  });

  it("emit∘readback is a fixed point from device defaults (every param round-trips)", async () => {
    const c1 = await readThenEmit(new Map());
    const c2 = await readThenEmit(tableFrom(c1));
    expect(addrVals(c2)).toEqual(addrVals(c1));
  });

  it("emit∘readback is a fixed point with sends / input source / routing / OSC on", async () => {
    // Build a device state with representative wires turned on, then check the
    // round trip is still a fixed point and the ON state survives a write.
    const base = await readThenEmit(new Map());
    const t = tableFrom(base);
    for (const c of base) {
      const k = `${c.paramId}:${c.x}:${c.y}`;
      if (c.name === "SEND_ON") t.set(k, 1);
      if (c.name.startsWith("OSC_ASSIGN_")) t.set(k, 1);
    }
    t.set("22:0:0", 0); // ch1 input source = in.micline_1_2 L
    t.set("705:0:0", (0x80000000 | 288) >>> 0); // streaming source = MIX1 (tagged)
    t.set("706:0:0", (0x80000000 | 289) >>> 0);

    const c1 = await readThenEmit(t);
    const c2 = await readThenEmit(tableFrom(c1));
    expect(addrVals(c2)).toEqual(addrVals(c1));

    // The ON state is actually carried through, not silently dropped.
    expect(c1.some((c) => c.name === "SEND_ON" && c.vdValue === 1)).toBe(true);
    expect(c1.some((c) => c.name === "INPUT_SOURCE" && c.vdValue === 0)).toBe(true);
    expect(c1.some((c) => c.name === "STREAM_SRC_L" && c.vdValue !== PORT_REF_NONE)).toBe(true);
  });
});
