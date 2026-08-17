import { test, expect, type Page } from "@playwright/test";
import {
  installFake,
  goLive,
  mark,
  pushNotify,
  pushMidi,
  midiSentOf,
  openMidiWindow,
  setMidiLearn,
  midiRow,
  traceOf,
  setLatency,
  blockAt,
  releaseBarrier,
  memOf,
  divergeAt,
  waitQuiet,
  settleAfter,
  ledgerOf,
  type InstallOptions,
} from "./fake-device";
import { analyze, report, timeline, markTime, setsOf, type LedgerEntry } from "./analyze";
import { CH1_FADER, CH2_FADER, faderOf, faderReadout, graphNode, settleValue, strip } from "./ui";

// T4b midi — the six T4 cases t4-midi.spec.ts did not reach
// (docs/{en,ja}/live-race-harness.md, catalog ids in the section headers below).
//
// The through-line of the tier is that an incoming MIDI message is the one plan
// writer with no gate at all. These six add the shapes that are not about the gate:
// one message driving SEVERAL plan keys (a gang), one message driving a key through
// a MIRROR onto a channel nobody mapped, a guard that decides genuineness by value
// alone, a decoder that keeps state across a port change, the second operator's
// CONFIGURATION racing a device reconcile, and a relative drag whose arithmetic
// predates the message it erases.
//
// Bindings are seeded through the persisted `urx-midi` store, as t4-midi does: learn
// needs the panel open and an arming click on the very control a case then wants to
// hold a barrier against, and sanitizeMappings validates a seeded mapping into
// exactly the object learn would have produced. The one case that is ABOUT learn
// (midi-learn-arm-during-rerender) drives the real learn flow instead.

const CH1_GATE_THRESHOLD = "29:0:0"; // GATE_THRESHOLD, centi-dB
const CH2_GATE_THRESHOLD = "29:0:1";
const CC7 = { type: "cc", channel: 0, controller: 7 } as const;
const CC14_7 = { type: "cc14", channel: 0, controller: 7 } as const; // MSB CC 7 / LSB CC 39
const CC39 = { type: "cc", channel: 0, controller: 39 } as const;
const PB = { type: "pitchbend", channel: 0 } as const;
const CC14_10 = { type: "cc14", channel: 0, controller: 10 } as const;
const NOTE60 = { type: "note", channel: 0, note: 60 } as const;

type Addr = typeof CC7 | typeof CC14_7 | typeof CC39 | typeof PB | typeof CC14_10 | typeof NOTE60;
type Mapping = { control: string; addr: Addr; mode: "absolute" | "pickup"; button?: "edge" | "state" };

/** Seed the persisted MIDI store: ports (reopened at boot by restorePorts, so the
 *  fake owns the channel before the first gesture) + this model's bindings, in
 *  first-learned order. */
function midiStore(
  mappings: Mapping[],
  ports: { input?: string; output?: string } = { input: "Fake In" },
): InstallOptions["storage"] {
  return { "urx-midi": JSON.stringify({ ...ports, models: { URX44V: mappings } }) };
}

const sendFader = (page: Page, name: string, send: string) =>
  strip(page, name).locator(`.con-vfad[aria-label="${send}"]`);
const muteChip = (page: Page, name: string) => strip(page, name).locator(".con-chip.mute");
const scribble = (page: Page, name: string) => strip(page, name).locator(".con-scribble");
const param = (page: Page, label: string) => page.locator("#inspector .param", { hasText: label });

/** A CC message. The level codec is posToLevel(round(v/127 × 40)) over the
 *  LEVEL_STEPS_DB grid, so the dB each raw value lands on is stated per use. */
const cc = (controller: number, value: number): number[] => [0xb0, controller, value];
const cc7 = (value: number): number[] => cc(7, value);

/** Boot with a seeded store, in the console, model confirmed. Every offline case
 *  starts here — no device link is involved in a message-level decision. */
async function boot(page: Page, mappings: Mapping[], ports?: { input?: string; output?: string }): Promise<void> {
  await installFake(page, { storage: midiStore(mappings, ports) });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-view-console");
  await expect(faderReadout(page, "CH 1")).toBeVisible();
}

/** A session's readback leaves CH 1 muted — the fake answers 0 for every param nothing
 *  wrote, and 0 on a send's ON is the send switched off. The echo cases need the guard
 *  armed by a pass carrying the ON value (an edge toggle ignores a release), so they
 *  un-mute first and let that pass land before stamping. */
async function unmuteCh1(page: Page): Promise<void> {
  if ((await muteChip(page, "CH 1").getAttribute("aria-pressed")) === "true") {
    await muteChip(page, "CH 1").click();
    await expect(muteChip(page, "CH 1")).toHaveAttribute("aria-pressed", "false");
    await page.waitForTimeout(200); // past the feedback debounce, so armIdx counts only the mute
  }
}

/** Every case prints its own evidence: the fake's ordered trace, the analyzer's
 *  verdict, and the MIDI bytes that crossed the bridge in each direction. */
async function dump(page: Page, title: string, from: string, spec: Parameters<typeof analyze>[1] = {}): Promise<void> {
  const trace = await traceOf(page);
  const at = markTime(trace, from);
  console.log(timeline(trace, { from: at === undefined ? 0 : at - 50 }));
  console.log(report(title, analyze(trace, spec)));
  console.log(`midi tx: ${(await midiSentOf(page)).map((b) => b.join(" ")).join(" | ") || "(none)"}`);
}

/** Ledger rows for one plan key, oldest first — "who wrote this" (invariant 13). */
const writersOf = (ledger: LedgerEntry[], field: string, key: string, sub: string): LedgerEntry[] =>
  ledger.filter((l) => l.field === field && l.key === key && (l.subKeys ?? []).includes(sub));

const WIRE = (from: string, to: string): string => `${from}\u0000${to}`; // plan-history wireKey

test.describe("T4b midi", () => {
  // ===========================================================================
  // midi-gang-fanout-and-head-reelection — the only many-to-one writer in the
  // app. One physical control drives a whole gang (mappings sharing an address),
  // and exactly one member — the first that RESOLVES — owns the address' feedback
  // and pickup state.
  // ===========================================================================

  test("one CC writes three plan keys, in first-learned order", async ({ page }) => {
    // The gang is deliberately heterogeneous: a send-backed control (a wire's
    // params) ahead of two node-backed main faders (a different wire each). Nothing
    // else in the app turns one input event into three plan writes.
    await boot(page, [
      { control: "ch3/level@bus.mix1", addr: CC7, mode: "absolute" },
      { control: "ch1/level", addr: CC7, mode: "absolute" },
      { control: "ch2/level", addr: CC7, mode: "absolute" },
    ]);
    await expect(sendFader(page, "CH 3", "MIX 1")).toBeVisible();
    expect(await faderReadout(page, "CH 1").textContent()).toBe("0.0");
    expect(await sendFader(page, "CH 3", "MIX 1").getAttribute("aria-valuetext")).toBe("off (-∞)");

    await mark(page, "cc");
    await pushMidi(page, [cc7(114)]); // 114/127 × 40 → pos 36 → +5.0 dB

    // All three land, from one message, on three different wires.
    await expect(faderReadout(page, "CH 1")).toHaveText("+5.0");
    await expect(faderReadout(page, "CH 2")).toHaveText("+5.0");
    await expect(sendFader(page, "CH 3", "MIX 1")).toHaveAttribute("aria-valuetext", "+5.0 dB");

    const ledger = await ledgerOf(page);
    const fanout = ledger.filter((l) => l.source === "midi");
    await dump(page, "gang fan-out", "cc", { ledger });
    console.log(`ledger (midi): ${fanout.map((l) => `${l.field}[${l.key?.replace("\u0000", " → ")}]`).join(" ; ")}`);

    // Three plan writes, attributed to the one writer, in the order the mappings
    // were learned — matches() preserves byKey order and apply() runs the list.
    expect(fanout).toHaveLength(3);
    expect(fanout.map((l) => l.key)).toEqual([
      WIRE("ch3:out", "bus.mix1:in"),
      WIRE("ch1:out", "bus.stereo:in"),
      WIRE("ch2:out", "bus.stereo:in"),
    ]);
    expect(fanout.every((l) => (l.subKeys ?? []).includes("level"))).toBe(true);
  });

  test("a device-locked head strands the whole gang's controller feedback", async ({ page }) => {
    // The catalog asks for the head's backing wire to be DELETED so the head
    // re-elects. That is unreachable: every channel → bus send is `fixed: true` in
    // the model (build.ts §2), so no plan edit removes one, and MidiControl.resolve
    // memoizes hits, so a control that bound once keeps binding. What IS reachable
    // is the same ownership failure by another door — a MIX bus switched to FIXED
    // makes the head's set() refuse, and a refused write returns before the head
    // records what the controller was told.
    await boot(
      page,
      [
        { control: "ch1/level@bus.mix1", addr: CC7, mode: "absolute" },
        { control: "ch1/level", addr: CC7, mode: "absolute" },
        { control: "ch2/level", addr: CC7, mode: "absolute" },
      ],
      { input: "Fake In", output: "Fake Out" },
    );
    // A session, because the output side stays shut until a live readback establishes
    // the plan — the port opening states nothing of its own. Its resync is what puts
    // the head's value out first.
    await goLive(page);
    await expect.poll(async () => (await midiSentOf(page)).length).toBeGreaterThan(0);
    // The head's value, and 95 is the readback's own: the fake answers 0 for every param
    // nothing wrote, which on a send LEVEL is 0.0 dB — the session replaced the factory
    // -∞ the offline plan carried.
    expect((await midiSentOf(page))[0]).toEqual([0xb0, 7, 95]);

    await mark(page, "cc-vari");
    await pushMidi(page, [cc7(114)]); // +5.0 dB on all three
    await expect(faderReadout(page, "CH 1")).toHaveText("+5.0");
    await expect(sendFader(page, "CH 1", "MIX 1")).toHaveAttribute("aria-valuetext", "+5.0 dB");

    // Switch MIX 1 to FIXED: the send LEVEL is device-locked from here on.
    await page.click("#btn-view-graph");
    await graphNode(page, "bus.mix1").click();
    await param(page, "BUS Type").locator("select").selectOption("1");
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    await page.waitForTimeout(600); // let any feedback the edit scheduled run + settle
    const sentBefore = (await midiSentOf(page)).length;

    await mark(page, "cc-fixed");
    await pushMidi(page, [cc7(76)]); // 76/127 × 40 → pos 24 → -5.0 dB
    await expect(faderReadout(page, "CH 1")).toHaveText("-5.0");
    await expect(faderReadout(page, "CH 2")).toHaveText("-5.0");
    // The head itself refused the write ("drop locked"), silently.
    await expect(sendFader(page, "CH 1", "MIX 1")).toHaveAttribute("aria-valuetext", "+5.0 dB");

    // …and feedback is computed from the HEAD alone, so nothing goes out: the
    // physical control keeps showing +5.0 dB while two mapped faders sit at -5.0.
    await page.waitForTimeout(800); // FEEDBACK_DEBOUNCE 120 + FEEDBACK_SETTLE 350, twice over
    expect((await midiSentOf(page)).length).toBe(sentBefore);
    // The decisive part is that the head's value is now unreachable: the console
    // renders that column display-only, and the message path refuses it, so no
    // writer is left that could ever move the value feedback reads.
    await expect(sendFader(page, "CH 1", "MIX 1")).toHaveClass(/readonly/);
    await expect(sendFader(page, "CH 1", "MIX 1")).toHaveAttribute("aria-disabled", "true");

    // The same fact stated from the other side: moving a MEMBER in the UI emits
    // nothing either, because the head's value is the only one feedback reads.
    await mark(page, "ui-member");
    await faderOf(page, "CH 1").focus();
    await page.keyboard.press("ArrowUp");
    await expect(faderReadout(page, "CH 1")).toHaveText("-4.0");
    await page.waitForTimeout(800);
    expect((await midiSentOf(page)).length).toBe(sentBefore);

    await dump(page, "gang head ownership under a FIXED bus", "cc-vari", { ledger: await ledgerOf(page) });
    console.log(`sends: boot..${sentBefore} then none across two 10 dB moves of two mapped controls`);
  });

  test("a pickup member behind an absolute head is swallowed forever", async ({ page }) => {
    // Pickup engagement is keyed by ADDRESS and created only by the head, so a
    // member in pickup mode behind an absolute head inherits a state that is never
    // written: it can never engage, whatever the physical control does.
    await boot(page, [
      { control: "ch1/level", addr: CC7, mode: "absolute" },
      { control: "ch2/level", addr: CC7, mode: "pickup" },
    ]);
    expect(await faderReadout(page, "CH 2").textContent()).toBe("0.0");

    await mark(page, "sweep");
    // A sweep that starts below the plan value, crosses it, and ends above it —
    // every engagement condition pickup has, in one pass.
    for (const v of [10, 40, 95, 96, 120, 127]) {
      await pushMidi(page, [cc7(v)]);
      await page.waitForTimeout(30);
    }
    await expect(faderReadout(page, "CH 1")).toHaveText("+10.0");

    await dump(page, "gang pickup inheritance", "sweep", { ledger: await ledgerOf(page) });
    const ch1 = await faderReadout(page, "CH 1").textContent();
    const ch2 = await faderReadout(page, "CH 2").textContent();
    console.log(`after a crossing sweep: CH 1 = ${ch1}, CH 2 = ${ch2}`);

    // Pinned defect: the sweep crossed the member's own value (95 → 96 straddles its
    // 0.75) and it still never took over. The gang is one physical control, so the
    // operator has no way to engage it — the mode is a per-mapping setting whose
    // state is not.
    expect(await faderReadout(page, "CH 2").textContent()).toBe("0.0");
    const level = writersOf(await ledgerOf(page), "connParams", WIRE("ch2:out", "bus.stereo:in"), "level");
    expect(level).toHaveLength(0); // not "written back to the same value" — never written
  });

  // ===========================================================================
  // midi-bal-mirror-clobbers-partner — the only collision mediated by a mirror.
  // mirrorBalPair structuredClones the WHOLE source node's params onto the linked
  // partner on every applied message, so a fader move on ch1 republishes every
  // other parameter of ch2 as well.
  // ===========================================================================

  /** STEREO-link ch1/ch2 (which lands in BAL) and let the converge round settle. */
  async function linkBalPair(page: Page): Promise<void> {
    await graphNode(page, "ch1").click();
    await param(page, "Signal Type").locator("select").selectOption("1");
    await expect(param(page, "PAN / BAL").locator("select")).toHaveValue("1"); // BAL
    await waitQuiet(page);
  }

  test("a MIDI fader move on ch1 republishes ch1's node params over what the device just reported for ch2", async ({
    page,
  }) => {
    await installFake(page, { storage: midiStore([{ control: "ch1/level", addr: CC7, mode: "absolute" }]) });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await goLive(page);
    await linkBalPair(page);
    await setLatency(page, { get: 8, set: 25 });

    // The unit reports a GATE threshold change on ch2 alone — a device-side edit on
    // the partner channel, applied by the scoped readback with no mirror (a
    // device-authored value is not an app edit).
    await divergeAt(page, CH2_GATE_THRESHOLD, -3000); // -30.00 dB
    await mark(page, "notify");
    await pushNotify(page, [[29, 0, 1, -3000]]);
    await page.waitForSelector('#statusbar:text-matches("← device \\\\(\\\\d+\\\\)")', { timeout: 20_000 });
    await waitQuiet(page);
    const afterFollow = setsOf(await traceOf(page)).filter((s) => s.addr === CH2_GATE_THRESHOLD);
    expect(afterFollow).toHaveLength(0); // the follow itself wrote nothing back

    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    await mark(page, "cc");
    await pushMidi(page, [cc7(114)]); // ch1/level → +5.0 dB
    await expect(faderReadout(page, "CH 1")).toHaveText("+5.0");
    await settleAfter(page, "cc");

    const trace = await traceOf(page);
    const ccAt = markTime(trace, "cc")!;
    const clobber = setsOf(trace).filter((s) => s.addr === CH2_GATE_THRESHOLD && s.start > ccAt);
    await dump(page, "BAL mirror vs a device-authored partner value", "notify", {
      edits: [{ label: "CC 7 = 114 on ch1/level", addr: CH1_FADER, at: ccAt, value: 500 }],
      ledger: await ledgerOf(page),
    });
    console.log(
      `after the CC: device ${CH2_GATE_THRESHOLD} = ${(await memOf(page))[CH2_GATE_THRESHOLD]}, ` +
        `writes carrying it = ${clobber.map((s) => s.value).join(",") || "(none)"}; ` +
        `CH 2 fader = ${await faderReadout(page, "CH 2").textContent()}`,
    );

    // Pinned defect. The operator moved one mapped fader; the app answered by
    // writing a channel-strip parameter of a DIFFERENT channel — back to the value
    // ch1 happened to hold — destroying what the unit had just reported.
    expect(clobber.length).toBeGreaterThan(0);
    expect(clobber[0].value).toBe(0); // ch1's threshold, not the device's -3000
    expect((await memOf(page))[CH2_GATE_THRESHOLD]).toBe(0);
    // The partner's fader moved too, which is the mirror working as designed — it
    // is the same copy, and the same copy carries everything else with it.
    await expect(faderReadout(page, "CH 2")).toHaveText("+5.0");
    expect((await memOf(page))[CH2_FADER]).toBe(500);
  });

  test("a UI edit to the partner survives the same message — the app funnel mirrors it first", async ({ page }) => {
    // The differential. The catalog's own wording has the destroyed value come from
    // the tuning screen, and it does not: every app-side funnel calls mirrorBalPair
    // itself, so a UI edit to ch2 is copied onto ch1 before the message arrives and
    // the message's mirror finds the two already equal. What the mirror destroys is
    // whatever did NOT go through a mirroring funnel — the run above.
    await installFake(page, { storage: midiStore([{ control: "ch1/level", addr: CC7, mode: "absolute" }]) });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await goLive(page);
    await linkBalPair(page);
    await setLatency(page, { get: 8, set: 25 });

    // The operator edits ch2's GATE threshold on the tuning screen.
    await graphNode(page, "ch2").click();
    const gate = page.locator("#inspector .insp-section", { has: page.locator("summary", { hasText: /^GATE$/ }) });
    if (!(await gate.evaluate((el) => (el as HTMLDetailsElement).open))) await gate.locator("summary").click();
    await gate.locator("#btn-gate-screen").click();
    await expect(page.locator("#dyn-screen-box")).toBeVisible();
    await mark(page, "ui-edit");
    await page.locator("#dyn-screen-box .prefs-row", { hasText: "Threshold" }).locator("input[type=range]").fill("-40");
    await page.keyboard.press("Escape");
    await expect(page.locator("#dyn-screen-box")).toBeHidden();
    await settleAfter(page, "ui-edit");

    const midTrace = await traceOf(page);
    const mirroredOut = setsOf(midTrace).filter((s) => s.addr === CH1_GATE_THRESHOLD);
    expect(mirroredOut.length).toBeGreaterThan(0); // the UI funnel mirrored ch2 → ch1
    expect(mirroredOut.at(-1)!.value).toBe(-4000);

    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    await mark(page, "cc");
    await pushMidi(page, [cc7(114)]);
    await expect(faderReadout(page, "CH 1")).toHaveText("+5.0");
    await settleAfter(page, "cc");

    const trace = await traceOf(page);
    const ccAt = markTime(trace, "cc")!;
    const after = setsOf(trace).filter((s) => s.addr === CH2_GATE_THRESHOLD && s.start > ccAt);
    await dump(page, "BAL mirror vs a UI-authored partner value", "ui-edit", { ledger: await ledgerOf(page) });
    console.log(`after the CC: writes to ${CH2_GATE_THRESHOLD} = ${after.map((s) => s.value).join(",") || "(none)"}`);

    // Nothing rewrote ch2's threshold, and the unit still holds the operator's value.
    expect(after).toHaveLength(0);
    expect((await memOf(page))[CH2_GATE_THRESHOLD]).toBe(-4000);
    expect((await memOf(page))[CH1_GATE_THRESHOLD]).toBe(-4000);
  });

  test("a linked pair deep-clones the source node once per applied message", async ({ page }) => {
    // The cost half of the case: the mirror is a structuredClone of the whole node
    // params, per message, and a controller sweep is dozens of messages a second.
    // Measured as a differential (unlinked sweep vs linked sweep, same message
    // sequence), so the probe's own clone per markChanged cancels out.
    await installFake(page, { storage: midiStore([{ control: "ch1/level", addr: CC7, mode: "absolute" }]) });
    await page.addInitScript(() => {
      const w = window as unknown as { __clones: number };
      w.__clones = 0;
      const orig = structuredClone;
      (window as unknown as { structuredClone: typeof structuredClone }).structuredClone = ((v: unknown) => {
        w.__clones++;
        return orig(v as never);
      }) as typeof structuredClone;
    });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();

    const sweep = Array.from({ length: 60 }, (_, i) => cc7(2 + 2 * i)); // 60 distinct raw values
    // "applied" is counted on the MAPPED key alone (the ch1 → STEREO send level):
    // the total row count is not comparable across the two runs, because in the
    // linked one every applied message also writes the partner — which is the other
    // half of what this measures.
    const runSweep = async (label: string): Promise<{ clones: number; applied: number; rows: number }> => {
      await mark(page, label);
      const before = await page.evaluate(() => (window as unknown as { __clones: number }).__clones);
      const beforeLedger = (await ledgerOf(page)).filter((l) => l.source === "midi");
      for (const msg of sweep) {
        await pushMidi(page, [msg]);
      }
      await page.waitForTimeout(200);
      const after = await page.evaluate(() => (window as unknown as { __clones: number }).__clones);
      const afterLedger = (await ledgerOf(page)).filter((l) => l.source === "midi");
      const mapped = (list: LedgerEntry[]): number =>
        list.filter((l) => l.key === WIRE("ch1:out", "bus.stereo:in")).length;
      return {
        clones: after - before,
        applied: mapped(afterLedger) - mapped(beforeLedger),
        rows: afterLedger.length - beforeLedger.length,
      };
    };

    const unlinked = await runSweep("sweep-unlinked");
    await page.click("#btn-view-graph");
    await linkBalPair(page);
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    const linked = await runSweep("sweep-linked");

    await dump(page, "BAL mirror sweep cost", "sweep-unlinked", { ledger: await ledgerOf(page) });
    console.log(
      `unlinked: ${unlinked.applied} applied messages, ${unlinked.rows} plan-key writes, ` +
        `${unlinked.clones} structuredClone calls; ` +
        `linked: ${linked.applied} applied, ${linked.rows} plan-key writes, ${linked.clones} clones`,
    );

    // The same message sequence changes the mapped value the same number of times
    // either way. Linked, each of those messages writes a second plan key nobody
    // mapped, and costs at least one extra whole-node deep copy — for a control
    // that touched one number on one wire.
    expect(unlinked.applied).toBeGreaterThan(30);
    expect(linked.applied).toBe(unlinked.applied);
    expect(unlinked.rows).toBe(unlinked.applied); // nothing but the mapped key
    expect(linked.rows).toBeGreaterThanOrEqual(2 * linked.applied - 1); // …and its mirror
    expect(linked.clones - unlinked.clones).toBeGreaterThanOrEqual(unlinked.applied);
    // …and the partner's fader followed every step of a sweep nobody mapped to it.
    await expect(faderReadout(page, "CH 2")).toHaveText((await faderReadout(page, "CH 1").textContent())!);
  });

  // ===========================================================================
  // midi-14bit-pair-and-cross-binding — message-level decoding rather than
  // value-level policy: pair state that outlives a port change, one physical
  // message firing two address semantics, and bindings that can never fire.
  // ===========================================================================

  test("an MSB-only value combines with the last LSB seen, and the pair state outlives a port reopen", async ({
    page,
  }) => {
    await boot(page, [{ control: "ch1/level", addr: CC14_7, mode: "absolute" }]);

    // Fresh pair state: MSB 100, LSB 0 → 12800/16383 → pos 31 → +0.4 dB.
    await mark(page, "msb-only");
    await pushMidi(page, [cc7(100)]);
    await expect(faderReadout(page, "CH 1")).toHaveText("+0.4");

    // The LSB half alone re-combines and moves the fader by itself: 12927 → pos 32.
    await pushMidi(page, [cc(39, 127)]);
    await expect(faderReadout(page, "CH 1")).toHaveText("+1.2");

    // A coarse MSB-only sweep now carries that sub-detent tail on every step.
    await pushMidi(page, [cc7(110)]); // (110<<7)|127 = 14207 → pos 35 → +4.0
    await expect(faderReadout(page, "CH 1")).toHaveText("+4.0");

    // Close and reopen the input port from the MIDI window — the operator unplugging
    // and replugging a controller.
    const win = await openMidiWindow(page);
    await win.locator(".mw-in").selectOption("");
    await expect.poll(() => page.evaluate(() => window.__urxFake.midi.inPort)).toBeNull();
    await win.locator(".mw-in").selectOption("Fake In");
    await expect.poll(() => page.evaluate(() => window.__urxFake.midi.inPort)).toBe("Fake In");
    await win.close();

    await mark(page, "after-reopen");
    await pushMidi(page, [cc7(100)]); // the SAME MSB as the very first message
    await dump(page, "cc14 pair assembly", "msb-only", { ledger: await ledgerOf(page) });
    console.log(`CH 1 after the reopened MSB-only 100: ${await faderReadout(page, "CH 1").textContent()}`);

    // Pinned behaviour: identical physical message, different plan value — the LSB
    // from before the port change is still attached, so the coarse sweep writes
    // values with sub-detent garbage in them and a reconnect does not clear it.
    await expect(faderReadout(page, "CH 1")).toHaveText("+1.2");
  });

  test("one CC 39 fires both a plain binding and a 14-bit binding, and the panel calls them unrelated", async ({
    page,
  }) => {
    await boot(page, [
      { control: "ch1/level", addr: CC14_7, mode: "absolute" }, // MSB 7 / LSB 39
      { control: "ch2/level", addr: CC39, mode: "absolute" }, // plain CC 39
    ]);
    expect(await faderReadout(page, "CH 1").textContent()).toBe("0.0");
    expect(await faderReadout(page, "CH 2").textContent()).toBe("0.0");

    await mark(page, "cc39");
    await pushMidi(page, [cc(39, 127)]);
    // One physical message, two address semantics: CH 2 reads it as a 7-bit CC at
    // full scale, CH 1 reads it as the LSB half of a 14-bit pair whose MSB is 0.
    await expect(faderReadout(page, "CH 2")).toHaveText("+10.0");
    await expect(faderReadout(page, "CH 1")).toHaveText("-∞");

    const win = await openMidiWindow(page);
    const rows = win.locator(".mw-list tbody tr");
    await expect(rows).toHaveCount(2);
    await dump(page, "cc14 cross-binding", "cc39", { ledger: await ledgerOf(page) });
    console.log(`assignment rows: ${(await rows.allTextContents()).join(" | ")}`);

    // Neither row is tagged as linked — the two mappings have different address
    // keys ("cc14:0:7" vs "cc:0:39"), so nothing in the list says that moving one
    // physical control drives both.
    await expect(win.locator(".mw-list tbody tr.linked")).toHaveCount(0);
    await expect(midiRow(win, "ch1/level").locator(".mw-addr")).toHaveText("CH 1 CC 7/39 (14bit)");
    await expect(midiRow(win, "ch2/level").locator(".mw-addr")).toHaveText("CH 1 CC 39");
  });

  test("a pitch bend and a 14-bit pair bound to toggles are accepted and permanently inert", async ({ page }) => {
    await boot(page, [
      { control: "ch1/chOn", addr: PB, mode: "absolute" },
      { control: "ch2/chOn", addr: CC14_10, mode: "absolute" },
    ]);
    await expect(scribble(page, "CH 1")).toHaveAttribute("aria-pressed", "true");
    await expect(scribble(page, "CH 2")).toHaveAttribute("aria-pressed", "true");

    await mark(page, "inert");
    await pushMidi(page, [
      [0xe0, 0x00, 0x7f], // pitch bend, full up
      [0xe0, 0x00, 0x00], // pitch bend, full down
      cc(10, 127), // cc14 MSB
      cc(42, 127), // cc14 LSB
    ]);
    await page.waitForTimeout(200);

    const win = await openMidiWindow(page);
    await dump(page, "inert toggle bindings", "inert", { ledger: await ledgerOf(page) });
    console.log(
      `assignment rows: ${(await win.locator(".mw-list tbody tr").allTextContents()).join(" | ")}; ` +
        `plan writes: ${(await ledgerOf(page)).filter((l) => l.source === "midi").length}`,
    );

    // Pinned behaviour: both bindings exist, both are listed, neither can ever fire
    // (toggleTarget refuses pitchbend and cc14), and no plan write was attempted.
    await expect(win.locator(".mw-list tbody tr")).toHaveCount(2);
    await expect(scribble(page, "CH 1")).toHaveAttribute("aria-pressed", "true");
    await expect(scribble(page, "CH 2")).toHaveAttribute("aria-pressed", "true");
    expect((await ledgerOf(page)).filter((l) => l.source === "midi")).toHaveLength(0);
    // The rows carry no behaviour control at all — the take-in select is for
    // continuous controls and the button-mode select is skipped for these two
    // address types — so the list shows nothing that would hint they are dead.
    await expect(win.locator(".mw-mode")).toHaveCount(0);
    await expect(win.locator(".mw-btn")).toHaveCount(0);
  });

  // ===========================================================================
  // midi-toggle-echo-window-ladder — a one-shot guard, armed per ADDRESS when a
  // toggle's feedback goes out, that decides genuineness by value and by a time
  // window. It cannot tell a loopback from a press.
  // ===========================================================================

  /** `ECHO_MS` in `src/core/midi/engine.ts`, restated because a spec cannot import the
   *  app's modules. The four cases that turn on the window — the toggle ladder, the
   *  mismatched-value differential, the one-shot pair and the fader ladder — place
   *  their rungs against this rather than against a literal, which is what they lacked
   *  when the constant moved: it went 300 -> 50 (sized
   *  from a measured 0.13-5 ms echo latency, where 300 ms was eating real presses) and
   *  three rungs that named 300 kept asserting the old window — the ladder's inner ones
   *  failed, while the two cases that only claim "inside the window" went on passing at
   *  a phase that is now outside it, one of them landing on the boundary itself
   *  (measured: first message eaten at an achieved 50 ms, the ladder's own 50 ms rung
   *  applied at 51). Neither was a failure; both had stopped testing what they say.
   *
   *  The comparison is `>=`, so a message AT the window is outside it. */
  const ECHO_WINDOW_MS = 50;
  /** How far a rung is placed from the window's edge. The bracket a phase is measured
   *  as spans 0-1 ms on this machine (achieved 50..51, 290..291), so 10 ms is the same
   *  absolute margin the 300 ms ladder ran at — and the phase assertion in each case,
   *  not its verdict, is what fails if a loaded renderer spends it. */
  const EDGE_MARGIN_MS = 10;

  /** Install a send-time stamp on the fake's outgoing byte log, so a phase can be
   *  measured from the emit itself rather than from when the driver noticed it —
   *  a polling error of a few ms would otherwise decide a rung near the edge. */
  const stampSends = (page: Page): Promise<void> =>
    page.evaluate(() => {
      const w = window as unknown as { __sendAt: number[] };
      w.__sendAt = [];
      const arr = window.__urxFake.midi.sent;
      const push = Array.prototype.push;
      arr.push = function (...args: number[][]): number {
        w.__sendAt.push(performance.now());
        return push.apply(this, args) as number;
      };
    });

  /** Wait for the first outgoing message past `since` sends, then deliver `value` on
   *  the same address exactly `d` ms after it left. Returns the achieved phase as a
   *  BRACKET, `[before, after]`, taken either side of the delivery.
   *
   *  Two numbers rather than one because the app does not read the clock where this
   *  does. `pushMidi` delivers synchronously, so the engine's own `now()` inside
   *  consumeEcho is sampled between these two: `before` is a lower bound on the phase
   *  the app applies and `after` an upper one, and the residue between them is the
   *  fake's trace push plus the decode. It is a fraction of a millisecond on an idle
   *  machine and grows with the renderer's load, which is enough to move a rung placed
   *  10 ms from the window's edge to the other side of it — so a rung inside the window
   *  is placed against `after` and one outside it against `before`. Measured for the
   *  emit side of the same question and found NOT to be the problem: the offset between
   *  the app arming its guard and the fake seeing the send is 0.0-0.9 ms at 1x and at
   *  12x CPU throttling alike.
   *
   *  `since` is passed IN rather than sampled here. The evaluate starts a couple of
   *  driver round trips after the gesture and the feedback emit it waits for lands
   *  ~120 ms later, so a baseline taken inside can already include it — and then the
   *  1 ms poll never terminates and the case hangs to the Playwright timeout with no
   *  diagnosis at all. The poll carries a deadline for the same reason: a gesture that
   *  emits nothing has to fail saying which wait it was in. */
  const loopbackAfter = (page: Page, d: number, value: number, since: number, cap = 5000): Promise<[number, number]> =>
    page.evaluate(
      async ([delay, v, n0, deadlineMs]) => {
        const w = window as unknown as { __sendAt: number[] };
        const f = window.__urxFake;
        const deadline = performance.now() + deadlineMs;
        await new Promise<void>((res, rej) => {
          const tick = (): void => {
            if (f.midi.sent.length > n0) return res();
            if (performance.now() > deadline) {
              return rej(new Error(`loopbackAfter: no MIDI feedback past send #${n0} within ${deadlineMs} ms`));
            }
            setTimeout(tick, 1);
          };
          tick();
        });
        const bytes = f.midi.sent[f.midi.sent.length - 1];
        const at = w.__sendAt[w.__sendAt.length - 1];
        await new Promise<void>((res) => setTimeout(res, Math.max(0, delay - (performance.now() - at))));
        const before = performance.now() - at;
        f.pushMidi([[bytes[0], bytes[1], v]]);
        return [before, performance.now() - at] as [number, number];
      },
      [d, value, since, cap] as [number, number, number, number],
    );

  /** Push a MIDI message from INSIDE the page and return its phase from the last
   *  outgoing feedback emit. A driver `pushMidi` is a round trip whose lateness is
   *  unbounded, so a case whose verdict turns on "inside the echo window"
   *  cannot measure the push from outside — under driver lag it would be measuring the
   *  window expiring rather than the thing it claims. */
  const pushAtPhase = (page: Page, bytes: number[]): Promise<number> =>
    page.evaluate((b) => {
      const w = window as unknown as { __sendAt: number[] };
      const at = w.__sendAt[w.__sendAt.length - 1];
      window.__urxFake.pushMidi([b]);
      return performance.now() - at;
    }, bytes);

  // The two rungs that BRACKET the window, one margin either side of the edge. It ran
  // five (10 / 25 / 40 | 60 / 400) while the window itself was being sized; what those
  // three extra samples add now is a second and third reading of a boundary the pair
  // already states, and each of them is a case that has to be re-driven whenever the
  // way feedback reaches the wire changes.
  for (const d of [ECHO_WINDOW_MS - EDGE_MARGIN_MS, ECHO_WINDOW_MS + EDGE_MARGIN_MS]) {
    const inWindow = d < ECHO_WINDOW_MS;
    const verb = inWindow ? "eaten" : "applied";
    test(`a matching message ${d} ms after the feedback emit is ${verb}`, async ({ page }) => {
      await boot(page, [{ control: "ch1/mute", addr: CC7, mode: "absolute" }], {
        input: "Fake In",
        output: "Fake Out",
      });
      // The output side opens with a live readback, not with the port, so the session
      // is what puts the un-muted state (0) out. Only a 127 can flip an edge toggle, so
      // the guard has to be armed by a feedback pass carrying one.
      await goLive(page);
      await expect.poll(async () => (await midiSentOf(page)).length).toBeGreaterThan(0);
      await unmuteCh1(page);
      await expect(muteChip(page, "CH 1")).toHaveAttribute("aria-pressed", "false");

      await stampSends(page);
      const armIdx = (await midiSentOf(page)).length;
      await mark(page, "ui-mute");
      await muteChip(page, "CH 1").click();
      await expect(muteChip(page, "CH 1")).toHaveAttribute("aria-pressed", "true");
      const [phaseLow, phaseHigh] = await loopbackAfter(page, d, 127, armIdx);
      await page.waitForTimeout(150);

      const state = await muteChip(page, "CH 1").getAttribute("aria-pressed");
      await dump(page, `toggle echo ladder D=${d}`, "ui-mute", { ledger: await ledgerOf(page) });
      console.log(
        `D intended=${d} achieved=${phaseLow.toFixed(0)}..${phaseHigh.toFixed(0)} ms` +
          ` (the app read its clock inside that bracket); MUTE aria-pressed=${state}`,
      );

      // The phase is only interpretable if the WHOLE bracket landed on the intended
      // side of the guard window — the app samples its own clock somewhere inside it,
      // so a bracket that straddles the edge decides nothing. Placed against the far
      // end for a rung inside the window and the near end for one outside, so the
      // assertion is against whichever bound can cross first. The two rungs a margin
      // from the edge are why: this is the assertion that has to fail, rather than the
      // verdict below, when a loaded renderer spends that margin between the samples.
      expect((inWindow ? phaseHigh : phaseLow) < ECHO_WINDOW_MS).toBe(inWindow);
      // …and if the emit the phase is measured from is the one that armed the guard.
      expect((await midiSentOf(page))[armIdx]).toEqual([0xb0, 7, 127]);

      if (inWindow) {
        // Pinned defect: the message is dropped on the strength of its value alone.
        // Nothing here distinguishes a loopback from an operator's press — this run
        // has no loopback at all, and the press was still eaten.
        expect(state).toBe("true");
      } else {
        // Past the window the same bytes flip the toggle straight back, which is
        // what a real echo does on a shared bus.
        expect(state).toBe("false");
      }
    });
  }

  test("a value the guard does not recognise defeats it at the same phase", async ({ page }) => {
    // The differential for the ladder's innermost rung: one variable changed, the raw
    // value. The guard compares against lastSent, so a controller that echoes at a
    // different resolution (or a plugin that re-sends its own state) flips the
    // toggle back inside the window the ladder shows as protected.
    //
    // The phase has to be the LADDER'S, and it stopped being so when the window moved:
    // this case kept pushing at 50 ms, which the ladder no longer shows as protected,
    // so it went on passing while comparing against nothing. Its rung is named from the
    // same ladder now.
    await boot(page, [{ control: "ch1/mute", addr: CC7, mode: "absolute" }], { input: "Fake In", output: "Fake Out" });
    // The output side opens with a live readback rather than with the port, and the
    // guard this case is about is armed by a feedback pass.
    await goLive(page);
    await expect.poll(async () => (await midiSentOf(page)).length).toBeGreaterThan(0);
    await unmuteCh1(page);

    await stampSends(page);
    const armIdx = (await midiSentOf(page)).length;
    await mark(page, "ui-mute");
    await muteChip(page, "CH 1").click();
    await expect(muteChip(page, "CH 1")).toHaveAttribute("aria-pressed", "true");
    const [, phaseHigh] = await loopbackAfter(page, 10, 64, armIdx); // ≥ 64 = an on-value, ≠ lastSent 127
    await page.waitForTimeout(150);

    const state = await muteChip(page, "CH 1").getAttribute("aria-pressed");
    await dump(page, "toggle echo, mismatched value", "ui-mute", { ledger: await ledgerOf(page) });
    console.log(`D achieved=${phaseHigh.toFixed(0)} ms (upper bound) with value 64; MUTE aria-pressed=${state}`);

    // The far end of the bracket: this rung claims the message was inside the window,
    // so the bound that can cross the edge first is the one to place it against.
    expect(phaseHigh).toBeLessThan(ECHO_WINDOW_MS);
    expect(state).toBe("false"); // flipped back — the guard did not fire
  });

  test("the guard is one-shot: the second matching message inside the window flips the toggle", async ({ page }) => {
    // The other half of the same defect. The guard is consumed by whichever
    // matching message arrives first, so an echo and a press inside one window are
    // treated as one echo and one press — in whichever order they happen to land.
    await boot(page, [{ control: "ch1/mute", addr: CC7, mode: "absolute" }], { input: "Fake In", output: "Fake Out" });
    // The output side opens with a live readback rather than with the port, and the
    // guard this case is about is armed by a feedback pass.
    await goLive(page);
    await expect.poll(async () => (await midiSentOf(page)).length).toBeGreaterThan(0);
    await unmuteCh1(page);

    await stampSends(page);
    const armIdx = (await midiSentOf(page)).length;
    await mark(page, "ui-mute");
    await muteChip(page, "CH 1").click();
    await expect(muteChip(page, "CH 1")).toHaveAttribute("aria-pressed", "true");
    // Both messages have to land inside ONE window, and the state read between them
    // costs a driver round trip — measured at ~5 ms (the second message landed at
    // 105 ms with the first at 50 and a 50 ms sleep between). That was free against a
    // 300 ms window and is a fraction of a 50 ms one, so the first rung goes near zero
    // and the sleep goes: the second then lands around 15 ms with 35 to spare, and if
    // a loaded renderer spends that, the phase assertion below is what fails.
    const [, achieved] = await loopbackAfter(page, 5, 127, armIdx); // the bracket's far end
    const afterFirst = await muteChip(page, "CH 1").getAttribute("aria-pressed");
    // Pushed in-page and stamped, like the first one: the claim is that the guard was
    // SPENT, and under driver lag an unmeasured push measures the window expiring
    // instead — which produces the same "flipped back" reading for the opposite reason.
    const secondPhase = await pushAtPhase(page, cc7(127));
    await page.waitForTimeout(150);
    const afterSecond = await muteChip(page, "CH 1").getAttribute("aria-pressed");

    await dump(page, "toggle echo, one-shot guard", "ui-mute", { ledger: await ledgerOf(page) });
    console.log(
      `D achieved=${achieved.toFixed(0)} ms, second at ${secondPhase.toFixed(0)} ms;` +
        ` MUTE after first=${afterFirst} after second=${afterSecond}`,
    );

    expect(achieved).toBeLessThan(ECHO_WINDOW_MS);
    expect(afterFirst).toBe("true"); // eaten
    // Both messages inside one window — the precondition the "one-shot" claim rests on.
    expect(secondPhase).toBeLessThan(ECHO_WINDOW_MS);
    expect(afterSecond).toBe("false"); // applied — the guard was spent on the first
  });

  // ===========================================================================
  // midi-continuous-echo-reaches-the-unit — the same guard, on the other kind of
  // control, where what it prevents is not a flip but a WRITE. A continuous echo is
  // applied as an operator gesture; if the decoded value lands anywhere other than
  // where it started, that is a plan edit, and under Live sync the flush carries it
  // to the hardware. The console fader bound to a NOTE is the deterministic member
  // of the family: `emit` puts on/off on a note address whatever position the sent
  // cache holds, so the echo of a fader anywhere in [0.5, 1) returns as note-on and
  // `continuousTarget` reads it as full scale — no fine grid needed to see it.
  //
  // The guard is armed by the port-open resync rather than by an edit, so the plan
  // and the unit are both already still when the loopback arrives: any write past
  // that mark belongs to the echo and to nothing else.
  // ===========================================================================

  for (const d of [ECHO_WINDOW_MS - EDGE_MARGIN_MS, 400]) {
    const inWindow = d < ECHO_WINDOW_MS;
    test(`a fader's loopback ${d} ms after the emit ${inWindow ? "leaves the unit alone" : "slams it to full scale"}`, async ({
      page,
    }) => {
      await installFake(page, {
        storage: midiStore([{ control: "ch1/level", addr: NOTE60, mode: "absolute" }], { input: "Fake In" }),
      });
      await page.goto("/");
      await expect(page.locator("#model-picker")).toHaveValue("URX44V");
      await goLive(page);
      await page.click("#btn-view-console");
      await expect(faderReadout(page, "CH 1")).toBeVisible();

      // Park the fader strictly inside [0.5, 1): at the ceiling the echo re-enters the
      // value it started from and the case would pass for the wrong reason.
      const fader = faderOf(page, "CH 1");
      const dbNow = async (): Promise<number> => Number((await faderReadout(page, "CH 1").textContent())!);
      // Two settled legs rather than one run of presses. The flush is a single 120 ms
      // window that a run of key presses fits inside, so parking in one go can land
      // back on the value the starting snapshot already holds and write nothing at all,
      // leaving the unit holding nothing for this address and the "it did not move"
      // assertion below comparing undefined with undefined. `settleAfter` rather than
      // `waitQuiet` because the link is silent when the leg starts, and waitQuiet
      // answers "quiet" before the flush window has even opened.
      await mark(page, "park-top");
      await fader.click();
      await fader.press("Home");
      expect(await dbNow()).toBe(10);
      await settleAfter(page, "park-top");
      await mark(page, "park-mid");
      for (let i = 0; i < 40 && (await dbNow()) !== 0; i++) await fader.press("ArrowDown");
      expect(await dbNow()).toBe(0); // pos 30 of 40 → 0.75 normalized → note-on
      await settleAfter(page, "park-mid");
      const memBefore = (await memOf(page))[CH1_FADER];
      expect(memBefore).toBeDefined(); // the premise the two assertions below rest on
      const setsBefore = setsOf(await traceOf(page)).filter((s) => s.addr === CH1_FADER).length;

      // Opening the output port forgets the sent cache and re-emits every binding —
      // one note-on, which arms the guard without touching the plan.
      await stampSends(page);
      await mark(page, "port-open");
      const win = await openMidiWindow(page);
      const loop = loopbackAfter(page, d, 127, (await midiSentOf(page)).length);
      await win.locator(".mw-out").selectOption("Fake Out");
      const [phaseLow, phaseHigh] = await loop;
      // A fixed wait, not settleAfter: the rung inside the window claims the link stays
      // silent, and settleAfter waits for it to wake. Long enough to cover the 120 ms
      // flush window and the write behind it — the rung outside the window is what
      // proves it is long enough, since that one's write does land inside it.
      await page.waitForTimeout(600);
      await waitQuiet(page);

      const db = await dbNow();
      const memAfter = (await memOf(page))[CH1_FADER];
      const sets = setsOf(await traceOf(page)).filter((s) => s.addr === CH1_FADER);
      await dump(page, `continuous echo D=${d}`, "port-open", { ledger: await ledgerOf(page) });
      console.log(
        `D intended=${d} achieved=${phaseLow.toFixed(0)}..${phaseHigh.toFixed(0)} ms; ` +
          `CH 1 = ${db} dB; unit ${memBefore} -> ${memAfter}; sets on the fader ${setsBefore} -> ${sets.length}`,
      );

      // Same phase discipline as the toggle ladder: a bracket straddling the window's
      // edge decides nothing, so each rung is placed against the bound that can cross
      // first. The emit the phase is measured from has to be the arming one.
      expect((inWindow ? phaseHigh : phaseLow) < ECHO_WINDOW_MS).toBe(inWindow);
      expect((await midiSentOf(page)).at(-1)).toEqual([0x90, 60, 127]);

      if (inWindow) {
        // The guard swallowed it: screen and unit both stand exactly where the port
        // open found them, and the link carried nothing.
        expect(db).toBe(0);
        expect(memAfter).toBe(memBefore);
        expect(sets).toHaveLength(setsBefore);
      } else {
        // Past the window the identical bytes are a gesture. This is the arm that
        // makes the case discriminate: without the guard the rung above reads this
        // way too, and the "leaves the unit alone" verdict would be vacuous.
        expect(db).toBe(10);
        expect(memAfter).not.toBe(memBefore);
        expect(sets.length).toBeGreaterThan(setsBefore);
      }
    });
  }

  test.skip("Toggle (state) mode: a same-state message consumes the guard", async () => {
    // Not falsifiable through any observable this harness has. In "state" mode the
    // incoming value IS the state, so a same-state message is a no-op whether the
    // echo guard ate it or the toggle target resolved to null — the plan, the chip,
    // the ledger and the outgoing bytes are identical in both branches. The only
    // difference is whether lastFedAt was consumed, which is engine-private, and
    // probing the NEXT message cannot separate it either: the second same-state
    // message is a no-op for the same two reasons.
  });

  // ===========================================================================
  // midi-learn-arm-during-rerender — the only case where the second operator's
  // CONFIGURATION races the device rather than its messages. Every learn-state
  // change re-renders the whole console, and so does a reconcile's reflect.
  // ===========================================================================

  test("arming a control while a reconcile rebuilds the console binds the intended control and writes nothing", async ({
    page,
  }) => {
    await installFake(page); // no seeded mappings: this case drives the real learn flow
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await goLive(page);
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    await setLatency(page, { get: 8, set: 25 });
    const ch1Before = (await faderReadout(page, "CH 1").textContent())!;
    const ch2Before = (await faderReadout(page, "CH 2").textContent())!;

    const win = await openMidiWindow(page);
    await win.locator(".mw-in").selectOption("Fake In");
    await expect.poll(() => page.evaluate(() => window.__urxFake.midi.inPort)).toBe("Fake In");

    // Entering learn mode re-renders the whole console: the element that was on
    // screen a moment ago is out of the document. Learn is turned on from the other
    // window, so the re-render is driven across the relay rather than in-page — the
    // point of the case is what the console does with it, which is unchanged.
    const preLearn = (await faderOf(page, "CH 1").elementHandle())!;
    await setMidiLearn(page, win, true);
    expect(await preLearn.evaluate((el) => el.isConnected)).toBe(false);

    // A device-side change to ch1 is reported; its scoped readback is held open so
    // the arming click lands inside the reconcile.
    await blockAt(page, "vd_get", 1);
    await mark(page, "notify");
    await pushNotify(page, [[26, 0, 0, 40]]); // HPF frequency: a scoped param on ch1
    await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 15_000 });

    await mark(page, "arm");
    await faderOf(page, "CH 1").click();
    await expect(faderOf(page, "CH 1")).toHaveClass(/midi-armed/);
    const armed = (await faderOf(page, "CH 1").elementHandle())!;

    await mark(page, "release");
    await releaseBarrier(page);
    await page.waitForSelector('#statusbar:text-matches("← device \\\\(\\\\d+\\\\)")', { timeout: 20_000 });
    // The reconcile's reflect rebuilt the strip the armed control lives on: the
    // element the operator armed is detached, while `armed` is engine state and is
    // not.
    const rebuilt = !(await armed.evaluate((el) => el.isConnected));

    await mark(page, "learn");
    await pushMidi(page, [cc7(100), cc7(101)]); // two of the same CC settle a plain binding
    await expect(midiRow(win, "ch1/level")).toBeVisible();

    // Learn is still on: the wheel and dblclick handlers stay inert behind it.
    await mark(page, "inert-gestures");
    const box = (await faderOf(page, "CH 2").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -100);
    await faderOf(page, "CH 2").dblclick();
    await page.waitForTimeout(200);

    const ledger = await ledgerOf(page);
    const stored = JSON.parse((await page.evaluate(() => localStorage.getItem("urx-midi")))!);
    await dump(page, "learn arming during a reconcile", "notify", { ledger });
    console.log(
      `armed element rebuilt by the reconcile = ${rebuilt}; stored = ${JSON.stringify(stored.models.URX44V)}; ` +
        `CH 1 ${ch1Before} → ${await faderReadout(page, "CH 1").textContent()}, ` +
        `CH 2 ${ch2Before} → ${await faderReadout(page, "CH 2").textContent()}`,
    );

    // The mapping is against the control that was armed, not the one the rebuild
    // put in its place.
    expect(stored.models.URX44V).toHaveLength(1);
    expect(stored.models.URX44V[0].control).toBe("ch1/level");
    expect(stored.models.URX44V[0].addr).toEqual({ type: "cc", channel: 0, controller: 7 });
    expect(rebuilt).toBe(true);
    // Nothing in this run was an operator edit: the arming click, the learned CC
    // and the two inert gestures all left the plan alone.
    expect(ledger.filter((l) => l.source === "ui" || l.source === "midi")).toHaveLength(0);
    expect(await faderReadout(page, "CH 1").textContent()).toBe(ch1Before);
    expect(await faderReadout(page, "CH 2").textContent()).toBe(ch2Before);
  });

  test.skip("arming an id the catalog cannot bind is refused silently", async () => {
    // Unreachable from the UI in this build, so there is nothing to assert. arm()
    // refuses an id bindControl returns null for, but every control the console
    // DRAWS is drawn from the same catalog: the one strip with no controls
    // (STREAMING) is built by the meter-only path and has no armable element, and
    // every other control's backing wire is `fixed: true` in the model, so no plan
    // edit can take one away. Reaching the branch would need a console control
    // missing from controls.ts — i.e. the drift the branch exists to catch.
  });

  // ===========================================================================
  // midi-vs-send-fader-relative-baseline — the differential against the main
  // fader (t4-midi). A SENDS mini-fader drag captures startFrac at pointerdown and
  // recomputes an absolute value from it on every move, so a MIDI write landing
  // mid-drag would not be overwritten by the next move — it would be erased by
  // arithmetic that predates it. Since the gesture ends with its element, the case
  // measures that difference as an absence: the erasing move is never made.
  // ===========================================================================

  test("a CC mid-drag survives: the mini-fader's frozen baseline never gets to erase it", async ({ page }) => {
    await installFake(page, { storage: midiStore([{ control: "ch1/level@bus.mix1", addr: CC7, mode: "absolute" }]) });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await goLive(page);
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    await setLatency(page, { get: 8, set: 25 });

    const fader = sendFader(page, "CH 1", "MIX 1");
    await expect(fader).toBeVisible();
    const handle = (await fader.elementHandle())!;
    const box = (await fader.boundingBox())!;
    console.log(`mini-fader box: h=${box.height} → travel=${box.height - 12} px for 41 detents`);
    const x = box.x + box.width / 2;
    const y0 = box.y + box.height / 2;
    const valueOf = (el: { evaluate: (fn: (e: Element) => string | null) => Promise<string | null> }) =>
      el.evaluate((e) => e.getAttribute("aria-valuenow"));

    // Downwards: the session's readback put the send at 0.0 dB, which is three
    // quarters of the way up the scale, so a downward drag has room for a long
    // gesture where an upward one saturates within ten pixels.
    let beforeBurst = 0;
    let afterBurstVisible = 0;
    let reflectMs = -1;
    let settledMs = -1;
    await page.mouse.move(x, y0);
    await mark(page, "drag-start");
    await page.mouse.down();
    await page.mouse.move(x, y0 + 5); // past the 3 px dead zone: the first write
    for (let i = 1; i <= 25; i++) {
      await page.mouse.move(x, y0 + 5 + i);
      await page.waitForTimeout(25);
      if (i !== 12) continue;
      beforeBurst = Number(await valueOf(handle));
      // The settle's baseline, read the way it will be polled — through the LOCATOR, so
      // a repaint that replaces the strip does not make the comparison meaningless.
      const burstFrom = await fader.getAttribute("aria-valuenow");
      await mark(page, "midi-burst");
      await pushMidi(page, [cc7(114)]); // → +5.0 dB, far above where the drag is
      // Was a bare `waitForTimeout(120)` — a guess at how long the coalesced reflect
      // (REFLECT_MIN_MS = 50) takes, never measured, and under load it read the drag's
      // value and failed naming the app. Waiting for STILLNESS instead measures the
      // arrival and keeps the assertion honest: polling until the value equals the 5 the
      // case is about to assert would pass whatever the app did.
      const settled = await settleValue(fader, burstFrom);
      afterBurstVisible = Number(settled.value);
      reflectMs = settled.changedAt;
      settledMs = settled.settledAt;
    }
    await mark(page, "drag-end");
    await page.mouse.up();
    await settleAfter(page, "drag-end");

    const connected = await handle.evaluate((el) => el.isConnected);
    const detachedFinal = Number(await valueOf(handle));
    const visibleFinal = Number(await valueOf(fader));
    const ledger = await ledgerOf(page);
    const level = writersOf(ledger, "connParams", WIRE("ch1:out", "bus.mix1:in"), "level");

    // The dragged control's own address (CH → MIX send level, L slot), not the main
    // fader's: declaring the edit anywhere else would report a lost edit for an
    // address this case never touches.
    await dump(page, "MIDI vs a relative send-fader drag", "drag-start", {
      edits: [
        {
          label: "CC 7 = 114 on the dragged send",
          addr: "146:0:0",
          at: markTime(await traceOf(page), "midi-burst")!,
          value: 500,
        },
      ],
      ledger,
    });
    console.log(
      `beforeBurst=${beforeBurst} afterBurstVisible=${afterBurstVisible} ` +
        `detachedFinal=${detachedFinal} visibleFinal=${visibleFinal} connected=${connected}`,
    );
    console.log(`ledger on the dragged send level: ${level.map((l) => l.source).join(" → ")}`);
    console.log(
      `reflect after the midi-burst mark: first change at ${reflectMs} ms, still at ${settledMs} ms ` +
        `(the fixed wait this replaced was 120 ms)`,
    );

    // The message landed and was applied ungated, mid-gesture, on the very control
    // under the pointer, and it moved the value far from where the drag had it.
    expect(afterBurstVisible).toBe(5);
    expect(beforeBurst).toBeLessThan(-10);

    // The frozen baseline is still there — the mini-fader recomputes an absolute value
    // from `startFrac` on every move, so a message landing mid-drag would be erased by
    // arithmetic that predates it rather than overwritten. What is gone is the drag that
    // would do the erasing: the reflect's rebuild takes the element the gesture holds out
    // of the document (invariant 10), and the handler on `window` ends there. The
    // remaining 13 px recompute nothing, so the detached control keeps the value it was
    // replaced holding instead of running on to the tail of the scale (below -50, which
    // is where this gesture used to end).
    expect(connected).toBe(false);
    expect(detachedFinal).toBeGreaterThan(-50);
    expect(detachedFinal).toBeLessThanOrEqual(beforeBurst);
    // The message survives, and screen, wire and unit are one value.
    expect(visibleFinal).toBe(5);
    // Both writers reached the one key, and the message is the last of them — the drag no
    // longer gets to be last by outliving its control. (Ordering, not authorship: it is
    // not a restatement of invariant 13, which the analyzer decides.)
    expect(level.map((l) => l.source)).toContain("midi");
    expect(level.map((l) => l.source)).toContain("ui");
    expect(level[level.length - 1].source).toBe("midi");
    const sent = setsOf(await traceOf(page)).filter((s) => s.addr === "146:0:0");
    expect(sent.at(-1)!.value).toBe(500);
    expect((await memOf(page))["146:0:0"]).toBe(500);
  });

  test.skip("the orphan variant: the drag keeps writing into a deleted connection", async () => {
    // Not reachable. The variant wants the dragged send's wire deleted mid-drag,
    // but every channel → bus send is `fixed: true` in the model (build.ts §2) and
    // Delete refuses it ("Fixed connection — cannot be removed"). The only surface
    // that deletes a wire is the GRAPH, which cannot be reached while a console
    // pointer capture is active without switching views mid-drag — and that switch
    // destroys the strip under test, conflating the orphan write with the rebuild
    // the case above already measures.
  });
});
