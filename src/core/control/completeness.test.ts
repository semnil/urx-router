// Completeness of the device-write command set. planToCommands writes ABSOLUTE
// state: a wire-based selector (send / input source / routing / ducker key / OSC
// assign) absent from the plan is cleared (SEND_ON=0 / NONE / off), not omitted,
// so a write drives the device fully to the plan rather than only adding to it.
// STREAMING is the exception: its list has no None, so a new plan carries its STEREO,
// a plan without the wire sends nothing there (translate.test.ts pins that), and a read
// that finds it on NONE leaves the plan to be given STEREO, as Fetch and Live start do.
//
// The fixed point: once the device has been read into a plan, emitting that plan
// and reading the result back gives the same command set again — emit∘readback is
// idempotent, the software twin of the live idempotent double-write check. Both of
// its rounds start from an empty plan, so a key the read never sets is unset in both
// and the two rounds agree whatever the device held: a missing read is not something
// the fixed point can see. "readback covers what the emit writes" asks for that
// directly — every parameter a write sends is one the read asks the unit for, and a
// unit holding a distinctive value at every address a write sends reads back into a
// plan that sends exactly those values.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel, MODEL_IDS } from "../../models";
import { defaultPlan } from "../../models/initial-state";
import { emptyPlan, ensureFixedConnections, supplyRequiredSources, type Plan } from "../plan";
import { ref, type ModelId } from "../../models/types";

vi.mock("../platform", () => ({ vdGet: vi.fn() }));

import { vdGet } from "../platform";
import { applyDeviceState } from "./readback";
import { planToCommands } from "./translate";
import type { VdCommand } from "./translate";
import { buildModifiedPlan } from "./prepare";
import { PORT_REF_NONE } from "./vd";

const model = getModel("URX44V");

// param_ids whose value is a port-ref: an address never written reads back as the
// broker's "nothing selected" sentinel, so the default device value for them is
// NONE rather than 0 (matches the device and readback.ts decoding).
const PORT_REF_PARAMS = new Set([22, 259, 705, 706, 719, 720, 730, 731, 732, 733, 734, 735, 736]);

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

// Read the (mocked) device into a fresh plan, give it the source a receiver the unit never
// leaves without one was read without — what Fetch and Live start do with `unsourced` — and
// emit the plan's command set. `supplied` collects those receivers.
async function readThenEmit(table: Map<string, number>, supplied: string[] = []): Promise<VdCommand[]> {
  mockDevice(table);
  const plan = emptyPlan("URX44V");
  const read = await applyDeviceState(model, plan);
  supplied.push(...(read.unsourced ?? []));
  supplyRequiredSources(
    model,
    plan,
    (read.unsourced ?? []).map((id) => ref(id, "in")),
  );
  return planToCommands(model, plan);
}

beforeEach(() => vi.mocked(vdGet).mockReset());

describe("planToCommands absolute-state completeness", () => {
  it("clears every wire-based selector for an empty plan (OFF / NONE, never omitted) but STREAMING's", () => {
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

    // STREAMING holds the STEREO a new plan carries, so it is written as that source.
    expect(named("STREAM_SRC_L").map((c) => c.vdValue)).toEqual([(0x80000000 | 256) >>> 0]);
    expect(named("STREAM_SRC_R").map((c) => c.vdValue)).toEqual([(0x80000000 | 257) >>> 0]);

    // OSC → bus assign: every assignable bus emits its toggle(s), all off.
    for (const n of ["OSC_ASSIGN_STEREO", "OSC_ASSIGN_MIX", "OSC_ASSIGN_FX"]) {
      expect(named(n).length, n).toBeGreaterThan(0);
      expect(
        named(n).every((c) => c.vdValue === 0),
        n,
      ).toBe(true);
    }
  });

  it("emit∘readback is a fixed point from device defaults (every param round-trips)", async () => {
    // Those defaults hold NONE at STREAMING's source, a state its list does not offer. The read
    // names it, the plan is given STEREO, and the write that follows sends that; the unit's
    // state after it is then a fixed point like any other.
    const first: string[] = [];
    const c1 = await readThenEmit(new Map(), first);
    expect(first).toEqual(["bus.stream"]);
    expect(c1.filter((c) => c.paramId === 705 || c.paramId === 706).map((c) => c.vdValue)).toEqual([
      (0x80000000 | 256) >>> 0,
      (0x80000000 | 257) >>> 0,
    ]);
    const second: string[] = [];
    const c2 = await readThenEmit(tableFrom(c1), second);
    expect(second).toEqual([]);
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
    t.set("732:0:0", 2); // USB MAIN A = the mono pair CH 3/4: CH 3's slot on L…
    t.set("732:0:1", 3); // …and CH 4's on R

    const c1 = await readThenEmit(t);
    const c2 = await readThenEmit(tableFrom(c1));
    expect(addrVals(c2)).toEqual(addrVals(c1));

    // The ON state is actually carried through, not silently dropped.
    expect(c1.some((c) => c.name === "SEND_ON" && c.vdValue === 1)).toBe(true);
    expect(c1.some((c) => c.name === "INPUT_SOURCE" && c.vdValue === 0)).toBe(true);
    expect(c1.some((c) => c.name === "STREAM_SRC_L" && c.vdValue !== PORT_REF_NONE)).toBe(true);
    expect(c1.filter((c) => c.name === "USB_OUT_SRC_A").map((c) => [c.y, c.vdValue])).toEqual([
      [0, 2],
      [1, 3],
    ]);
  });
});

// A distinctive state: the factory plan with every writable scalar moved off its factory value
// by the audit-prep writer, so a value the read loses differs from what an unread key emits.
function distinctivePlan(id: ModelId): Plan {
  const installed = defaultPlan(id);
  ensureFixedConnections(getModel(id), installed);
  return buildModifiedPlan(installed);
}

// Every vdGet the read issues, answered from `table`.
function recordReads(table: Map<string, number>): Set<string> {
  const asked = new Set<string>();
  vi.mocked(vdGet).mockImplementation((id, x, y) => {
    const k = `${id}:${x}:${y}`;
    asked.add(k);
    if (table.has(k)) return Promise.resolve(table.get(k)!);
    return Promise.resolve(PORT_REF_PARAMS.has(id) ? PORT_REF_NONE : 0);
  });
  return asked;
}

describe("readback covers what the emit writes", () => {
  // The read names a stereo channel's source from its L half, which identifies the input pair
  // the R half follows; it never asks for the R half on its own.
  const SOURCED_FROM_L = ["STEREO_INPUT_SOURCE_R"];

  it.each(MODEL_IDS)("%s: every parameter a write sends is one the read asks the unit for", async (id) => {
    const m = getModel(id);
    const sent = planToCommands(m, distinctivePlan(id), "all", { includeDeviceDriven: true });
    const asked = recordReads(tableFrom(sent));
    await applyDeviceState(m, emptyPlan(id));
    const askedAt = (c: VdCommand) => asked.has(`${c.paramId}:${c.x}:${c.y}`);
    const unread = [...new Set(sent.map((c) => c.name))].filter((n) => !sent.some((c) => c.name === n && askedAt(c)));
    expect(unread).toEqual(SOURCED_FROM_L);
    // The population carries the presence-conditional COMP keys, whose read is the one the
    // fixed point above cannot see.
    for (const n of ["COMP_AUTO_MAKEUP", "COMP_KNEE", "COMP_ONE_KNOB", "COMP_ONE_KNOB_LEVEL"])
      expect(
        sent.some((c) => c.name === n),
        n,
      ).toBe(true);
  });

  it.each(MODEL_IDS)(
    "%s: a unit holding a distinctive value everywhere reads into a plan that sends it",
    async (id) => {
      const m = getModel(id);
      const sent = planToCommands(m, distinctivePlan(id));
      recordReads(tableFrom(sent));
      const plan = emptyPlan(id);
      await applyDeviceState(m, plan);
      expect(addrVals(planToCommands(m, plan))).toEqual(addrVals(sent));
    },
  );
});

// A new plan is what the factory fill completes a document with, so every address a write can
// send has to be one it carries a value for: a key the factory lacks is one the panel draws a
// default for while the write sends nothing, and a unit holding anything else keeps it. A full
// read of a unit holding the new plan's own values sets every key the read covers, so the two
// emits have to name the same addresses.
describe("a new plan", () => {
  it.each(MODEL_IDS)("%s writes every address a device read of it covers", async (id) => {
    const m = getModel(id);
    // Installed the way every plan is, which seeds the fixed wires the factory list leaves out.
    const installed = defaultPlan(id);
    ensureFixedConnections(m, installed);
    const fresh = planToCommands(m, installed);
    mockDevice(tableFrom(fresh));
    const plan = emptyPlan(id);
    await applyDeviceState(m, plan);
    const addrs = (cmds: VdCommand[]): string[] =>
      [...new Set(cmds.map((c) => `${c.name} ${c.paramId}:${c.x}:${c.y}`))].sort();
    const read = addrs(planToCommands(m, plan));
    expect(read.filter((a) => !addrs(fresh).includes(a))).toEqual([]);
  });
});
