// @vitest-environment jsdom

// The CONSOLE per-strip SENDS rack (design spec: docs/{en,ja}/console-sends.md) and
// the two popovers that hang off a strip — the meter-point selector and SEND PAN.
//
// The rack is a fixed column set: every strip carries a column for every MIX/FX send
// the model has, so the columns line up across strips, and a strip that lacks a slot
// leaves an empty one rather than closing the gap. Almost everything below is about
// that "fixed" — what a column does when the strip does not own it, when the bus
// locks the level, when the rate or a live session makes it read-only.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consoleHost, dragY, key, wheel, type ConsoleHost } from "./console.test-util";
import { sendConnection } from "../core/plan";
import type { ConsoleMidiHooks } from "./console";
import { BUS_TYPE_FIXED, PAN_BAL_BAL } from "../core/control/params";
import { t } from "../i18n";

let h: ConsoleHost;

beforeEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
});

afterEach(() => {
  h?.restore();
});

const rack = (id: string): HTMLElement => h.strip(id).root.querySelector<HTMLElement>(".con-sends")!;
const header = (id: string): HTMLElement => rack(id).querySelector<HTMLElement>(".con-sh")!;
const cols = (id: string): HTMLElement[] => [...rack(id).querySelectorAll<HTMLElement>(".con-scol")];
/** One column element, addressed by the short label its enable chip carries (F1 / M1 …). */
const colOf = (id: string, short: string): HTMLElement => {
  const hit = cols(id).find((c) => c.querySelector(".con-sl")?.textContent === short);
  if (!hit) throw new Error(`no "${short}" column on "${id}"`);
  return hit;
};
const level = (id: string, target: string): number | undefined =>
  sendConnection(h.plan, id, target)?.params?.level as number | undefined;

// Every send ships OFF (-96.5 dB, measured on the default URX44V plan), and the level
// grid is deliberately asymmetric at that end — a step down off the lowest real detent
// lands on −∞, so a round trip from OFF does not return to OFF. Tests about the ordinary
// stepping seed a real level first; the OFF end has a case of its own below.
const seedLevel = (id: string, target: string, db: number): void => {
  const c = sendConnection(h.plan, id, target)!;
  c.params = { ...c.params, level: db };
  h.view.refresh();
};

describe("the rack's column set", () => {
  // The alignment claim. A strip with no send to MIX 2 still spends that column's
  // width, or the racks below it would sit one column to the left of the racks above.
  // Measured on a URX44V: the slot set is FX 1 / FX 2 / MIX 1 / MIX 2 = four columns.
  it("gives every sending strip the same number of columns, filling the ones it lacks", () => {
    h = consoleHost();
    const counts = new Set<number>();
    for (const id of ["ch1", "ch2", "bus.fx1"]) counts.add(cols(id).length);
    expect([...counts]).toEqual([4]);
    // …and an unowned slot is present but empty, which is what holds the width. An FX
    // bus feeds the MIX buses only, so measured it spends BOTH FX columns as spacers —
    // not just the one for itself.
    expect(cols("bus.fx1").filter((c) => c.classList.contains("empty"))).toHaveLength(2);
    expect(cols("ch1").filter((c) => c.classList.contains("empty"))).toHaveLength(0);
  });

  // A send to yourself is not a send. Without this an FX bus strip would offer a
  // column that writes onto the connection feeding it.
  it("leaves no column for a strip's send to itself", () => {
    h = consoleHost();
    expect(() => h.sendCol("bus.fx1", "bus.fx1")).toThrow();
  });

  // A strip with no sends at all gets the header and nothing else — but the header
  // still drives the global collapse, so it cannot simply be omitted.
  it("renders a dimmed header and no columns for a strip with no sends", () => {
    h = consoleHost();
    const stereo = h.strip("bus.stereo").root.querySelector<HTMLElement>(".con-sends");
    expect(stereo).not.toBeNull();
    expect(stereo!.classList.contains("empty")).toBe(true);
    expect(stereo!.querySelector(".con-sh")!.classList.contains("dim")).toBe(true);
    expect(stereo!.querySelectorAll(".con-scol")).toHaveLength(0);
  });
});

describe("a column's fader", () => {
  it("steps one detent per Arrow key and reaches the ends with Home/End", () => {
    h = consoleHost();
    seedLevel("ch1", "bus.mix1", -10);
    const col = h.sendCol("ch1", "bus.mix1");

    key(col.fader, "ArrowUp");
    expect(level("ch1", "bus.mix1")).toBeGreaterThan(-10);
    key(col.fader, "ArrowDown");
    expect(level("ch1", "bus.mix1")).toBe(-10);

    key(col.fader, "PageUp");
    const six = level("ch1", "bus.mix1")!;
    key(col.fader, "PageDown");
    expect(level("ch1", "bus.mix1")).toBe(-10);
    expect(six).toBeGreaterThan(-10);

    key(col.fader, "Home");
    const top = level("ch1", "bus.mix1")!;
    key(col.fader, "PageUp");
    expect(level("ch1", "bus.mix1")).toBe(top); // already at the ceiling

    key(col.fader, "End");
    expect(col.fader.getAttribute("aria-valuetext")).toBe("off (-∞)");
  });

  // The OFF end is not symmetric, and that is the level grid's own rule rather than
  // this view's. Measured from the default (OFF = −96.5): a step up clamps the base to
  // the floor and then steps, landing on −80 — so it climbs out past the floor in one
  // press, and coming back down takes TWO (−80 → −96 → −∞). A test that assumed a
  // symmetric round trip would read the second press as a lost edit.
  it("climbs out of −∞ in one step and needs two to fall back into it", () => {
    h = consoleHost();
    const col = h.sendCol("ch1", "bus.mix1");
    expect(col.fader.getAttribute("aria-valuetext")).toBe("off (-∞)");

    key(col.fader, "ArrowUp");
    const climbed = level("ch1", "bus.mix1")!;
    expect(climbed).toBe(-80);

    key(col.fader, "ArrowDown");
    const floor = level("ch1", "bus.mix1")!;
    expect(floor).toBe(-96);
    expect(col.fader.getAttribute("aria-valuetext")).not.toBe("off (-∞)");

    key(col.fader, "ArrowDown");
    expect(col.fader.getAttribute("aria-valuetext")).toBe("off (-∞)");
  });

  it("ignores a key that does not step", () => {
    h = consoleHost();
    const col = h.sendCol("ch1", "bus.mix1");
    const before = level("ch1", "bus.mix1");
    const e = key(col.fader, "a");
    expect(e.defaultPrevented).toBe(false);
    expect(level("ch1", "bus.mix1")).toBe(before);
  });

  it("steps on a wheel notch, in the direction the notch points", () => {
    h = consoleHost();
    seedLevel("ch1", "bus.mix1", -10);
    const col = h.sendCol("ch1", "bus.mix1");
    wheel(col.fader, 1);
    expect(level("ch1", "bus.mix1")).toBeGreaterThan(-10);
    wheel(col.fader, -1);
    expect(level("ch1", "bus.mix1")).toBe(-10);
  });

  // The 3 px threshold: one pixel of a mini-fader is a whole detent, so a mis-grab
  // (or the first half of a double-click) must not write.
  it("writes nothing until the drag passes its threshold", () => {
    h = consoleHost();
    const col = h.sendCol("ch1", "bus.mix1");
    const before = level("ch1", "bus.mix1");
    dragY(col.fader, 2);
    expect(level("ch1", "bus.mix1")).toBe(before);
    expect(h.changes()).toBe(0);

    dragY(col.fader, 20);
    expect(level("ch1", "bus.mix1")).not.toBe(before);
    expect(h.changes()).toBeGreaterThan(0);
  });

  // Shift is a quarter of the travel per pixel. Measured as "less far", not as an
  // exact value: the detent grid decides where it lands.
  it("moves a shorter distance with Shift held", () => {
    h = consoleHost();
    const plain = h.sendCol("ch1", "bus.mix1");
    const start = level("ch1", "bus.mix1")!;
    dragY(plain.fader, 30);
    const coarse = level("ch1", "bus.mix1")!;

    // Back to the start, then the same pixels with Shift.
    sendConnection(h.plan, "ch1", "bus.mix1")!.params!.level = start;
    dragY(plain.fader, 30, { shift: true });
    const fine = level("ch1", "bus.mix1")!;
    expect(fine).toBeGreaterThan(start);
    expect(fine).toBeLessThan(coarse);
  });

  it("resets to the factory level on a double-click", () => {
    h = consoleHost();
    const col = h.sendCol("ch1", "bus.mix1");
    const factory = level("ch1", "bus.mix1")!;
    key(col.fader, "ArrowUp");
    expect(level("ch1", "bus.mix1")).not.toBe(factory);
    col.fader.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(level("ch1", "bus.mix1")).toBe(factory);
  });
});

describe("the header readout", () => {
  // The label swaps to the touched column's value. It is one readout shared by the
  // rack's columns, so leaving one column must not clear it while another is focused.
  it("shows the touched column's value and reverts when nothing is touched", () => {
    h = consoleHost();
    const sh = header("ch1");
    const col = h.sendCol("ch1", "bus.mix1");

    col.fader.dispatchEvent(new PointerEvent("pointerenter"));
    expect(sh.classList.contains("readout")).toBe(true);
    expect(sh.querySelector(".rdout")!.textContent).toContain("MIX 1");

    col.fader.dispatchEvent(new PointerEvent("pointerleave"));
    expect(sh.classList.contains("readout")).toBe(false);
  });

  it("names the PRE tap in the readout while the column is pre-fader", () => {
    h = consoleHost();
    const col = h.sendCol("ch1", "bus.mix1");
    const conn = sendConnection(h.plan, "ch1", "bus.mix1")!;
    conn.params = { ...conn.params, tap: "pre" };
    col.fader.dispatchEvent(new PointerEvent("pointerenter"));
    expect(header("ch1").querySelector(".rdout")!.textContent).toContain(t().console.pre);
  });

  // aria-valuetext is the accessible half of the same fact, and it carries the tap.
  // Only above the floor: an OFF send reads "off (-∞)" and says nothing about its tap,
  // which is why this seeds a level first.
  it("puts the tap into the fader's accessible value", () => {
    h = consoleHost();
    seedLevel("ch1", "bus.mix1", -10);
    const col = h.sendCol("ch1", "bus.mix1");
    expect(col.fader.getAttribute("aria-valuetext")).not.toContain("PRE");
    // The PRE button of THIS column — every column has one, and the strip's first is
    // FX 1's, which would leave the MIX 1 fader untouched and the test green for nothing.
    colOf("ch1", "M1").querySelector<HTMLElement>(".con-slp")!.click();
    expect(col.fader.getAttribute("aria-valuetext")).toContain("PRE, ");
  });
});

describe("the global collapse", () => {
  // One state for every strip, so the columns stay aligned. Persisted, because a
  // reopened view that expanded them again would undo the operator's choice.
  it("toggles every strip at once and persists the choice", () => {
    h = consoleHost();
    expect(h.host.classList.contains("sends-collapsed")).toBe(false);

    header("ch1").click();
    expect(h.host.classList.contains("sends-collapsed")).toBe(true);
    for (const id of ["ch1", "ch2", "bus.mix1"]) {
      expect(header(id).getAttribute("aria-expanded")).toBe("false");
    }
    expect(localStorage.getItem("urx-sends-open")).toBe("false");

    h.restore();
    h = consoleHost();
    expect(h.host.classList.contains("sends-collapsed")).toBe(true);
  });

  it("toggles from the keyboard as well as the pointer", () => {
    h = consoleHost();
    const e = key(header("ch1"), " ");
    expect(e.defaultPrevented).toBe(true);
    expect(h.host.classList.contains("sends-collapsed")).toBe(true);
    key(header("ch1"), "Enter");
    expect(h.host.classList.contains("sends-collapsed")).toBe(false);
  });

  // Collapsed, the columns are gone: the dots are the only thing left saying which
  // sends are live, so they have to be refilled by the toggle itself.
  it("refills the collapsed dots, one per send that is on", () => {
    h = consoleHost();
    const dots = (): number => header("ch1").querySelectorAll(".dots i").length;
    const before = dots();
    expect(before).toBeGreaterThan(0);

    const chip = h.strip("ch1").root.querySelector<HTMLElement>(".con-scol .con-sl")!;
    chip.click(); // turn one send off
    header("ch1").click(); // collapse — this is what repaints the dots
    expect(dots()).toBe(before - 1);
  });

  it("highlights every header while one is hovered", () => {
    h = consoleHost();
    header("ch1").dispatchEvent(new PointerEvent("pointerenter"));
    expect(h.host.classList.contains("sends-hover")).toBe(true);
    header("ch1").dispatchEvent(new PointerEvent("pointerleave"));
    expect(h.host.classList.contains("sends-hover")).toBe(false);
  });
});

describe("the SEND PAN popover", () => {
  const panBtn = (id: string): HTMLButtonElement => h.strip(id).root.querySelector<HTMLButtonElement>(".con-panbtn")!;
  const pop = (): HTMLElement => h.host.querySelector<HTMLElement>(".con-spop")!;

  it("opens under the PAN button with one knob per MIX send, and closes on a second click", () => {
    h = consoleHost();
    const btn = panBtn("ch1");
    btn.click();
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(btn.classList.contains("open")).toBe(true);
    const knobs = pop().querySelectorAll(".pcol");
    // FX sends are mono and carry no pan, so only the MIX ones appear.
    expect(knobs.length).toBeGreaterThan(0);
    expect([...pop().querySelectorAll(".pcol .cap")].every((c) => c.textContent!.startsWith("MIX"))).toBe(true);

    btn.click();
    expect(pop().hidden).toBe(true);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  // The popover floats free of its strip, so it names the strip it belongs to —
  // position alone stopped saying it once it was detached.
  it("names the owning strip in its header", () => {
    h = consoleHost();
    panBtn("ch1").click();
    expect(pop().querySelector(".ph .who")!.textContent).toBeTruthy();
  });

  // Single-popover invariant: the two popovers share the screen and would overlap.
  it("closes the meter-point popover when it opens, and vice versa", () => {
    h = consoleHost();
    const badge = h.strip("ch1").root.querySelector<HTMLElement>(".con-tap")!;
    badge.click();
    const tapPop = h.host.querySelector<HTMLElement>(".con-tappop")!;
    expect(tapPop.hidden).toBe(false);

    panBtn("ch1").click();
    expect(tapPop.hidden).toBe(true);
    expect(pop().hidden).toBe(false);

    badge.click();
    expect(pop().hidden).toBe(true);
  });

  // Opening B while A is open has to clear A's trigger, or two buttons read as open.
  it("hands the open state from one strip's trigger to another's", () => {
    h = consoleHost();
    panBtn("ch1").click();
    panBtn("ch2").click();
    expect(panBtn("ch1").getAttribute("aria-expanded")).toBe("false");
    expect(panBtn("ch2").getAttribute("aria-expanded")).toBe("true");
  });

  it("writes the knob's value onto the send connection's pan", () => {
    h = consoleHost();
    panBtn("ch1").click();
    const knob = pop().querySelector<HTMLElement>(".pcol [role='slider']")!;
    const before = sendConnection(h.plan, "ch1", "bus.mix1")?.params?.pan ?? 0;
    key(knob, "ArrowRight");
    expect(sendConnection(h.plan, "ch1", "bus.mix1")?.params?.pan).not.toBe(before);
  });
});

describe("the meter-point popover", () => {
  const badge = (id: string): HTMLElement => h.strip(id).root.querySelector<HTMLElement>(".con-tap")!;

  it("lists the node's taps with the active one checked, and picking one re-scopes the meter", () => {
    h = consoleHost();
    badge("ch1").click();
    const rows = [...h.host.querySelectorAll<HTMLElement>(".con-tappop .crow")];
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(1);

    const other = rows.find((r) => r.getAttribute("aria-checked") === "false")!;
    const label = other.querySelector(".nm")!.textContent;
    other.click();
    expect(h.host.querySelector<HTMLElement>(".con-tappop")!.hidden).toBe(true);
    expect(badge("ch1").textContent).toContain(label);
  });

  it("opens and closes from the keyboard, and Escape closes it", () => {
    h = consoleHost();
    const pop = (): HTMLElement => h.host.querySelector<HTMLElement>(".con-tappop")!;
    key(badge("ch1"), "Enter");
    expect(pop().hidden).toBe(false);
    key(badge("ch1"), "Escape");
    expect(pop().hidden).toBe(true);

    key(badge("ch1"), " ");
    expect(pop().hidden).toBe(false);
    key(badge("ch1"), " ");
    expect(pop().hidden).toBe(true);
  });

  it("picks a tap from the keyboard", () => {
    h = consoleHost();
    badge("ch1").click();
    const rows = [...h.host.querySelectorAll<HTMLElement>(".con-tappop .crow")];
    const other = rows.find((r) => r.getAttribute("aria-checked") === "false")!;
    const label = other.querySelector(".nm")!.textContent;
    key(other, "Enter");
    expect(badge("ch1").textContent).toContain(label);
  });

  // Persisted per model, so a second model's choices cannot overwrite the first's.
  it("persists the choice per model", () => {
    h = consoleHost();
    badge("ch1").click();
    const other = [...h.host.querySelectorAll<HTMLElement>(".con-tappop .crow")].find(
      (r) => r.getAttribute("aria-checked") === "false",
    )!;
    other.click();
    const stored = JSON.parse(localStorage.getItem("urx-metertap")!) as Record<string, Record<string, string>>;
    expect(Object.keys(stored)).toEqual(["URX44V"]);
    expect(stored.URX44V.ch1).toBeTruthy();
  });
});

describe("MIDI learn over the rack", () => {
  const learnHooks = (armed: string[] = []): ConsoleMidiHooks => ({
    learnActive: () => true,
    armedId: () => null,
    isMapped: () => false,
    addrOf: () => null,
    arm: (id: string) => void armed.push(id),
  });

  // In learn mode a control arms instead of editing — otherwise assigning a fader
  // would move it, and the operator would have to undo every assignment.
  it("arms a column fader on pointerdown instead of dragging it", () => {
    const armed: string[] = [];
    h = consoleHost({ midi: learnHooks(armed) });
    const col = h.sendCol("ch1", "bus.mix1");
    const before = level("ch1", "bus.mix1");
    dragY(col.fader, 30);
    expect(armed).toHaveLength(1);
    expect(armed[0]).toContain("bus.mix1");
    expect(level("ch1", "bus.mix1")).toBe(before);
  });

  // Space/Enter arms; the arrows are left to the browser so keyboard navigation
  // keeps working while learn is on.
  it("arms on Space and leaves the stepping keys to the browser", () => {
    const armed: string[] = [];
    h = consoleHost({ midi: learnHooks(armed) });
    const col = h.sendCol("ch1", "bus.mix1");
    const before = level("ch1", "bus.mix1");

    const space = key(col.fader, " ");
    expect(space.defaultPrevented).toBe(true);
    expect(armed).toHaveLength(1);

    const up = key(col.fader, "ArrowUp");
    expect(up.defaultPrevented).toBe(false);
    expect(level("ch1", "bus.mix1")).toBe(before); // learn owns the event, no edit
  });

  it("does not reset a fader on a double-click while learn is on", () => {
    h = consoleHost({ midi: learnHooks() });
    const col = h.sendCol("ch1", "bus.mix1");
    const conn = sendConnection(h.plan, "ch1", "bus.mix1")!;
    conn.params = { ...conn.params, level: -20 };
    col.fader.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(level("ch1", "bus.mix1")).toBe(-20);
  });

  it("does not step a fader on a wheel notch while learn is on", () => {
    h = consoleHost({ midi: learnHooks() });
    const col = h.sendCol("ch1", "bus.mix1");
    const before = level("ch1", "bus.mix1");
    wheel(col.fader, 1);
    expect(level("ch1", "bus.mix1")).toBe(before);
  });
});

describe("read-only columns", () => {
  // A FIXED-type MIX bus locks its send levels (matching the graph inspector). The
  // column still paints the value — a hidden fader would read as "no send".
  it("paints a FIXED bus's send level but wires nothing to it", () => {
    h = consoleHost();
    (h.plan.nodeParams["bus.mix1"] ??= {}).busType = BUS_TYPE_FIXED;
    h.view.refresh();

    const col = h.sendCol("ch1", "bus.mix1");
    expect(col.fader.classList.contains("readonly")).toBe(true);
    expect(col.fader.getAttribute("aria-disabled")).toBe("true");
    expect(col.fader.tabIndex).toBe(-1);
    expect(col.fader.getAttribute("aria-valuetext")).toBeTruthy();

    const before = level("ch1", "bus.mix1");
    dragY(col.fader, 30);
    key(col.fader, "ArrowUp");
    wheel(col.fader, 1);
    expect(level("ch1", "bus.mix1")).toBe(before);
  });

  // While live, a CH → FX tap is LCD-only on the unit, so the PRE button explains
  // itself instead of writing. A CH → MIX tap is NOT: the broker takes that write
  // (max_value=1), and the graph inspector keeps it editable at the same moment.
  //
  // Both columns are asserted, because the lock is computed from the routing rules
  // and those are keyed by `node:port` — asking with a bare node id matches no rule
  // and answers "not writable" for EVERY send, which reads exactly like the FX column
  // being right. The FX assertion alone was green through that, for two years.
  it("locks the PRE button while live only where the unit refuses the write", () => {
    // Learn is on so the MIDI half is visible too: the read-only branch passes no
    // `midiId`, so a wrongly locked chip also silently stops being assignable.
    h = consoleHost({
      live: true,
      midi: { learnActive: () => true, armedId: () => null, isMapped: () => false, addrOf: () => null, arm: () => {} },
    });
    const preOf = (target: string): HTMLElement =>
      h.sendCol("ch1", target).fader.parentElement!.querySelector<HTMLElement>(".con-slp")!;

    const fx = preOf("bus.fx1");
    expect(fx.title).toBe(t().inspector.prePostLcdOnly);
    expect(fx.classList.contains("readonly")).toBe(true);
    expect(fx.classList.contains("midi-target")).toBe(false);

    const mix = preOf("bus.mix1");
    expect(mix.title).toBe(t().console.preHint);
    expect(mix.classList.contains("readonly")).toBe(false);
    expect(mix.classList.contains("midi-target")).toBe(true);
  });
});

describe("what a rebuild has to carry", () => {
  // A popover anchored to a button that a rebuild replaced would float over nothing.
  it("closes an open SEND PAN popover before re-rendering", () => {
    h = consoleHost();
    h.strip("ch1").root.querySelector<HTMLButtonElement>(".con-panbtn")!.click();
    expect(h.host.querySelector<HTMLElement>(".con-spop")!.hidden).toBe(false);
    h.view.refresh();
    expect(h.host.querySelector<HTMLElement>(".con-spop")!.hidden).toBe(true);
  });

  // The collapse is a host class rather than a re-render, so a rebuild has to paint
  // the fresh headers in the state the class already describes.
  it("builds fresh headers already collapsed", () => {
    h = consoleHost();
    header("ch1").click();
    h.view.refresh();
    expect(header("ch1").getAttribute("aria-expanded")).toBe("false");
  });
});

describe("a BAL-linked pair", () => {
  // A linked send fader has to track on the partner strip without a rebuild — a
  // rebuild mid-drag would take the focus and the pointer capture with it.
  it("mirrors a send fader onto the partner strip's column in place", () => {
    h = consoleHost();
    // A BAL-linked pair is Signal Type STEREO (`stereoLink`) plus PAN/BAL on BAL, both
    // held on the pair's PRIMARY channel — the pair is one stereo channel then, so its
    // mixer parameters mirror.
    Object.assign((h.plan.nodeParams["ch1"] ??= {}), { stereoLink: true, panBal: PAN_BAL_BAL });
    seedLevel("ch1", "bus.mix1", -10);
    seedLevel("ch2", "bus.mix1", -10);

    const mine = h.sendCol("ch1", "bus.mix1");
    const theirs = h.sendCol("ch2", "bus.mix1");
    const el = theirs.fader;
    const before = el.getAttribute("aria-valuenow");
    key(mine.fader, "ArrowUp");
    // In place: the partner's own element was repainted, not replaced by a rebuild —
    // a rebuild mid-drag takes the focus and the pointer capture with it.
    expect(el.isConnected).toBe(true);
    expect(h.sendCol("ch2", "bus.mix1").fader).toBe(el);
    expect(el.getAttribute("aria-valuenow")).not.toBe(before);
    expect(level("ch2", "bus.mix1")).toBe(level("ch1", "bus.mix1"));
  });
});

describe("the change funnel", () => {
  it("runs once per edit, and not at all for a build", () => {
    h = consoleHost();
    expect(h.changes()).toBe(0);
    key(h.sendCol("ch1", "bus.mix1").fader, "ArrowUp");
    expect(h.changes()).toBe(1);
  });

  it("turns a send on and off through its chip", () => {
    h = consoleHost();
    const col = h.strip("ch1").root.querySelector<HTMLElement>(".con-scol")!;
    const chip = col.querySelector<HTMLElement>(".con-sl")!;
    expect(col.classList.contains("off")).toBe(false);
    chip.click();
    expect(col.classList.contains("off")).toBe(true);
    chip.click();
    expect(col.classList.contains("off")).toBe(false);
  });
});

describe("storage that cannot be trusted", () => {
  // The tap store is operator-visible localStorage; a hand-edited or half-written
  // entry must not decide what a meter shows.
  it("ignores a tap store that is not the shape it wrote", () => {
    localStorage.setItem("urx-metertap", JSON.stringify({ URX44V: { ch1: 42, ch2: "input" } }));
    h = consoleHost();
    // ch1's non-string entry is dropped (the strip falls back to its default tap);
    // ch2's is taken.
    expect(h.strip("ch1").tap).toBeTruthy();
    expect(() => h.view.refresh()).not.toThrow();
  });

  it("ignores a tap store whose model entry is not an object", () => {
    localStorage.setItem("urx-metertap", JSON.stringify({ URX44V: "nonsense" }));
    expect(() => (h = consoleHost())).not.toThrow();
  });
});

describe("the slot set follows the model", () => {
  // The column set is derived from the buses this model actually shows, not hard-coded.
  // Measured: a URX22 carries the same four (F1 / F2 / M1 / M2) as a URX44V, so the
  // model is not what makes the set differ — SHELVING a bus out of the graph is.
  it("carries the same four slots on a URX22", () => {
    h = consoleHost({ modelId: "URX22" });
    expect([...rack("ch1").querySelectorAll<HTMLElement>(".con-scol .con-sl")].map((c) => c.textContent)).toEqual([
      "F1",
      "F2",
      "M1",
      "M2",
    ]);
  });

  it("drops a shelved bus's column from every strip", () => {
    h = consoleHost();
    h.plan.hidden = [...(h.plan.hidden ?? []), "bus.mix2"];
    h.view.refresh();
    expect([...rack("ch1").querySelectorAll<HTMLElement>(".con-scol .con-sl")].map((c) => c.textContent)).toEqual([
      "F1",
      "F2",
      "M1",
    ]);
    expect(cols("ch2")).toHaveLength(3); // and every strip loses it together
  });
});

// The app builds the view before the operator has switched to the CONSOLE tab, and
// hides it again on the way out. The hidden flag is the app's to set on the way in
// (index.html ships it hidden) — what the view owns is show/hide.
describe("show and hide", () => {
  it("shows on demand and hides again", () => {
    h = consoleHost({ hidden: true });
    h.view.show();
    expect(h.host.hidden).toBe(false);
    expect(h.strip("ch1")).toBeTruthy();
    h.view.hide();
    expect(h.host.hidden).toBe(true);
  });
});

// The meter loop is the one thing here that outlives a single call, so its teardown
// is asserted rather than assumed.
describe("the meter stream", () => {
  it("stops painting when the view hides", () => {
    h = consoleHost({ live: true });
    const spy = vi.spyOn(globalThis, "cancelAnimationFrame");
    h.view.hide();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// A drag that is CANCELLED fires no `pointerup` — touch-scroll takeover, a native
// context menu, an alert. Teardown bound to `pointerup` alone left the move listener
// installed on the window, and the control is still connected, so every later pointer
// movement (the operator's next, unrelated gesture) re-entered the handler with the
// stale press origin, wrote a level into the plan and committed it to the live device.
// The second half is the pointer id: with no filter, a second pointer's moves drove
// this control while something else was being dragged.
describe("a drag that does not end in a pointerup", () => {
  const press = (el: HTMLElement, pointerId: number): void => {
    const box = el.getBoundingClientRect();
    el.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        pointerId,
        clientY: box.top + box.height / 2,
        clientX: box.left + box.width / 2,
      }),
    );
  };

  it("stops writing when the browser cancels it", () => {
    h = consoleHost();
    const col = h.sendCol("ch1", "bus.mix1");
    press(col.fader, 1);
    window.dispatchEvent(new PointerEvent("pointermove", { clientY: 0, pointerId: 1 }));
    const during = level("ch1", "bus.mix1");
    window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 }));

    // Whatever moves next is somebody else's gesture.
    window.dispatchEvent(new PointerEvent("pointermove", { clientY: 400, pointerId: 1 }));
    expect(level("ch1", "bus.mix1")).toBe(during);
  });

  it("ignores a second pointer's moves while it is tracking the first", () => {
    h = consoleHost();
    const col = h.sendCol("ch1", "bus.mix1");
    press(col.fader, 1);
    window.dispatchEvent(new PointerEvent("pointermove", { clientY: 0, pointerId: 1 }));
    const during = level("ch1", "bus.mix1");

    window.dispatchEvent(new PointerEvent("pointermove", { clientY: 400, pointerId: 2 }));
    expect(level("ch1", "bus.mix1")).toBe(during);
    // …and the other pointer's release does not end this drag either.
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 2 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientY: 40, pointerId: 1 }));
    expect(level("ch1", "bus.mix1")).not.toBe(during);
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
  });
});
