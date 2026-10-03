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
import { BUS_TYPE_FIXED, PAN_BAL_BAL, PAN_BAL_PAN } from "../core/control/params";
import { t } from "../i18n";
import { defaultPlan } from "../models/initial-state";

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

// Every send ships OFF (-96.5 dB, measured on the default URX44V plan). Tests about the
// ordinary stepping seed a real level first; the OFF end has a case of its own below.
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

  // −∞ is the first of the grid's detents, as it is in the Inspector's level slider: one
  // step up from it lands on the floor detent (−96) and one step down goes back, PageUp
  // counts it as the first of its six, and a wheel notch is one Arrow. A level stored
  // BELOW the floor steps from −∞ too, so its first step up is the floor detent rather
  // than a press that writes −∞ again.
  it("steps out of −∞ onto the floor detent, and back into it, one detent per press", () => {
    h = consoleHost();
    const fader = (): HTMLElement => h.sendCol("ch1", "bus.mix1").fader;
    expect(fader().getAttribute("aria-valuetext")).toBe("off (-∞)");

    key(fader(), "ArrowUp");
    expect(level("ch1", "bus.mix1")).toBe(-96);
    expect(fader().getAttribute("aria-valuetext")).not.toBe("off (-∞)");
    key(fader(), "ArrowDown");
    expect(fader().getAttribute("aria-valuetext")).toBe("off (-∞)");

    key(fader(), "PageUp");
    expect(level("ch1", "bus.mix1")).toBe(-48);

    key(fader(), "End");
    wheel(fader(), 1);
    expect(level("ch1", "bus.mix1")).toBe(-96);

    seedLevel("ch1", "bus.mix1", -200);
    key(fader(), "ArrowUp");
    expect(level("ch1", "bus.mix1")).toBe(-96);
    seedLevel("ch1", "bus.mix1", -200);
    key(fader(), "PageUp");
    expect(level("ch1", "bus.mix1")).toBe(-48);
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

  // Flipping Shift mid-drag rebases both anchors, as the head knob's do: the move that
  // carries the flip lands where the level already is, and the drag then continues at the
  // other rate from there. Without the rebase the new rate is applied to the whole
  // distance already dragged, and a downward drag that presses Shift jumps the level UP.
  it("does not jump when Shift is pressed or released mid-drag", () => {
    h = consoleHost();
    seedLevel("ch1", "bus.mix1", -10);
    const fader = h.sendCol("ch1", "bus.mix1").fader;
    const move = (clientY: number, shiftKey: boolean): void =>
      void window.dispatchEvent(new PointerEvent("pointermove", { clientY, shiftKey, pointerId: 1 }));

    fader.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientY: 100, pointerId: 1 }),
    );
    move(130, false);
    const coarse = level("ch1", "bus.mix1")!;
    expect(coarse).toBeLessThan(-10);
    move(130, true);
    expect(level("ch1", "bus.mix1"), "pressing Shift where the pointer stands").toBe(coarse);
    move(140, true);
    const fine = level("ch1", "bus.mix1")!;
    expect(fine, "further down, at the fine rate").toBeLessThan(coarse);
    move(140, false);
    expect(level("ch1", "bus.mix1"), "releasing Shift where the pointer stands").toBe(fine);
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));

    // The fine rate itself: 10 px with Shift moves less than 10 px without.
    seedLevel("ch1", "bus.mix1", -10);
    const again = h.sendCol("ch1", "bus.mix1").fader;
    again.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientY: 100, pointerId: 1 }),
    );
    move(130, false);
    move(140, false);
    expect(level("ch1", "bus.mix1")).toBeLessThan(fine);
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
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

  // The tap is left out of the readout: the column's own PRE button already carries it,
  // and spelling it here as well made the longest reading wider than the header's share of
  // the strip, clipping the level off its right edge. So this is a set — the word goes, and
  // the two places that do carry the tap have to still carry it (the button here, whose
  // `aria-pressed` is its accessible form, and `aria-valuetext`'s PRE prefix below).
  it("leaves the tap out of the readout and lights the column's PRE button instead", () => {
    h = consoleHost();
    seedLevel("ch1", "bus.mix1", -3.2);
    const preBtn = colOf("ch1", "M1").querySelector<HTMLElement>(".con-slp")!;
    preBtn.click();
    expect(preBtn.classList.contains("on")).toBe(true);

    h.sendCol("ch1", "bus.mix1").fader.dispatchEvent(new PointerEvent("pointerenter"));
    const sh = header("ch1");
    // The state the swap is keyed on. This host loads no stylesheet, so nothing here is
    // laid out and whether the reading is drawn belongs to the E2E case's own measurement.
    expect(sh.classList.contains("readout")).toBe(true);
    const text = sh.querySelector(".rdout")!.textContent;
    expect(text).toBe("MIX 1 -3.2");
    expect(text).not.toContain(t().console.pre);
  });

  // The other half of the same claim. A marker added on the POST side reads exactly like
  // the tap word that came off, and nothing else would see it: the case above drives PRE
  // only, and the E2E width pin presses PRE before it measures. It is also the state a
  // send ships in, so this is the reading an operator meets first.
  it("reads the same in POST, so neither tap state puts a word in the readout", () => {
    h = consoleHost();
    seedLevel("ch1", "bus.mix1", -3.2);
    const preBtn = colOf("ch1", "M1").querySelector<HTMLElement>(".con-slp")!;
    expect(preBtn.classList.contains("on")).toBe(false);

    h.sendCol("ch1", "bus.mix1").fader.dispatchEvent(new PointerEvent("pointerenter"));
    expect(header("ch1").querySelector(".rdout")!.textContent).toBe("MIX 1 -3.2");
  });

  // aria-valuetext is the accessible half of the same fact. It marks one of the two taps:
  // a pre-fader send above the floor is prefixed "PRE, ", a post-fader one is the bare
  // level, and an OFF send reads "off (-∞)" whichever tap it holds — which is why this
  // seeds a level first, and why the post-fader half below is an absence.
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

  // A device-side Pan Link flip announces only the MIX bus, so the follow rebuilds that bus's
  // strip and not the strip whose popover is open. The popover's MIX 1 knob is read-only
  // under the link, and live without it — so it is re-read when the bus is rebuilt, in both
  // directions, and left alone (the same elements) when the rebuild changed no lock.
  it("re-reads a MIX bus's Pan Link when that bus's strip is rebuilt, and only when it moved", () => {
    h = consoleHost();
    const mix1 = (): HTMLElement => pop().querySelector<HTMLElement>('.pcol .con-knob[aria-label="MIX 1"]')!;
    const send = sendConnection(h.plan, "ch1", "bus.mix1")!;
    panBtn("ch1").click();
    expect(mix1().getAttribute("aria-disabled")).toBeNull();
    expect(mix1().tabIndex).toBe(0);

    const drawn = mix1();
    h.view.refreshStrip("bus.mix1");
    expect(mix1(), "no lock moved: the same knob").toBe(drawn);

    mix1().focus();
    (h.plan.nodeParams["bus.mix1"] ??= {}).panLink = true;
    send.params = { ...send.params, pan: -20 };
    h.view.refreshStrip("bus.mix1");
    expect(pop().hidden).toBe(false);
    expect(mix1().getAttribute("aria-disabled"), "locked under the link").toBe("true");
    expect(mix1().getAttribute("aria-valuenow"), "showing the pan the link put there").toBe("-20");
    expect(panBtn("ch1").getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement, "the focus the locked knob had goes to the trigger").toBe(panBtn("ch1"));

    h.plan.nodeParams["bus.mix1"]!.panLink = false;
    h.view.refreshStrip("bus.mix1");
    expect(mix1().getAttribute("aria-disabled"), "live again without it").toBeNull();
    expect(mix1().tabIndex).toBe(0);
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

  // The badge says whether its popover is open — across the one-strip rebuild a device
  // follow runs under an open popover too — and the rows it opens sit in a menu named for
  // what they choose.
  it("reports its open state on the badge and lists its rows inside a named menu", () => {
    h = consoleHost();
    const expanded = (): string | null => badge("ch1").getAttribute("aria-expanded");
    expect(expanded()).toBe("false");
    badge("ch1").click();
    expect(expanded()).toBe("true");
    const pop = h.host.querySelector<HTMLElement>(".con-tappop")!;
    const rows = [...pop.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) {
      const menu = r.closest<HTMLElement>('[role="menu"]');
      expect(menu !== null && pop.contains(menu)).toBe(true);
      expect(menu!.getAttribute("aria-label")).toBe(t().console.meterPoint);
    }

    const before = badge("ch1");
    h.view.refreshStrip("ch1");
    expect(badge("ch1"), "the premise: the badge was rebuilt").not.toBe(before);
    expect(expanded(), "the rebuilt badge reads open").toBe("true");
    key(document.body, "Escape");
    expect(expanded(), "and shut once the popover closes").toBe("false");

    badge("ch1").click();
    badge("ch1").click();
    expect(expanded()).toBe("false");
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

  // A FIXED bus takes every send after the fader and places it by the source's own PAN / BAL, so
  // the PRE tap and the send pan are as inert there as the level. Like the level fader
  // beside it, the PRE button keeps showing what the plan holds and goes read-only, and
  // neither control takes an edit. The same send into a VARI bus is editable first, so
  // a lock that stopped reading the bus cannot pass on a button that was never live.
  it("locks a FIXED bus's PRE button, still showing the stored tap, and its SEND PAN knob", () => {
    h = consoleHost();
    const conn = () => sendConnection(h.plan, "ch1", "bus.mix1")!;
    conn().params = { ...conn().params, tap: "pre", pan: -20, level: 0 };
    h.view.refresh();
    const preOf = (): HTMLElement => colOf("ch1", "M1").querySelector<HTMLElement>(".con-slp")!;
    expect(preOf().classList.contains("readonly")).toBe(false);
    expect(preOf().getAttribute("aria-pressed")).toBe("true");
    expect(h.sendCol("ch1", "bus.mix1").fader.getAttribute("aria-valuetext")).toMatch(/^PRE, /);

    (h.plan.nodeParams["bus.mix1"] ??= {}).busType = BUS_TYPE_FIXED;
    h.view.refresh();
    const pre = preOf();
    expect(pre.classList.contains("readonly")).toBe(true);
    expect(pre.title).toBe(t().inspector.busFixedSend);
    expect(pre.getAttribute("aria-pressed")).toBe("true");
    expect(h.sendCol("ch1", "bus.mix1").fader.getAttribute("aria-valuetext")).toMatch(/^PRE, /);
    pre.click();
    key(pre, "Enter");
    expect(conn().params?.tap).toBe("pre");

    h.strip("ch1").root.querySelector<HTMLButtonElement>(".con-panbtn")!.click();
    const pcol = [...h.host.querySelectorAll<HTMLElement>(".con-spop .pcol")].find(
      (c) => c.querySelector(".cap")?.textContent === "MIX 1",
    )!;
    const knob = pcol.querySelector<HTMLElement>("[role='slider']")!;
    expect(knob.title).toBe(t().inspector.busFixedSend);
    key(knob, "ArrowRight");
    expect(conn().params?.pan).toBe(-20);
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

describe("a STEREO-linked pair", () => {
  // A linked send fader has to track on the partner strip without a rebuild — a
  // rebuild mid-drag would take the focus and the pointer capture with it.
  const mirrorsInPlace = (mode: number): void => {
    h = consoleHost();
    // The link is Signal Type STEREO (`stereoLink`) plus a PAN/BAL mode, both held on
    // the pair's PRIMARY channel. The send LEVEL mirrors in either mode — the pair holds
    // one of it — so both modes are asked here; only the PAN is the mode's to decide.
    Object.assign((h.plan.nodeParams["ch1"] ??= {}), { stereoLink: true, panBal: mode });
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
  };

  it("mirrors a send fader onto the partner strip's column in place", () => {
    mirrorsInPlace(PAN_BAL_BAL);
  });

  it("mirrors it in PAN as well, where only the pan stays per member", () => {
    mirrorsInPlace(PAN_BAL_PAN);
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

  // The container itself, one shape per class JSON can hold that is not an object. A null
  // used to throw out of every render (an empty CONSOLE, and the module init with it when
  // CONSOLE was the remembered view); a primitive made every pick throw before it was
  // saved; an array dropped the pick on the way to storage.
  it.each(["null", '"x"', "7", "true", "[]"])("reads a tap store holding %s as no choices, and saves a pick", (raw) => {
    localStorage.setItem("urx-metertap", raw);
    h = consoleHost();
    expect(h.host.querySelectorAll(".con-strip").length).toBeGreaterThan(0);
    const badge = (): HTMLElement => h.strip("ch1").root.querySelector<HTMLElement>(".con-tap")!;
    badge().click();
    const other = [...h.host.querySelectorAll<HTMLElement>(".con-tappop .crow")].find(
      (r) => r.getAttribute("aria-checked") === "false",
    )!;
    const label = other.querySelector(".nm")!.textContent!;
    other.click();
    expect(h.host.querySelector<HTMLElement>(".con-tappop")!.hidden).toBe(true);
    expect(badge().textContent).toContain(label);
    const stored = JSON.parse(localStorage.getItem("urx-metertap")!) as Record<string, Record<string, string>>;
    expect(Object.keys(stored)).toEqual(["URX44V"]);
    expect(stored.URX44V.ch1).toBeTruthy();
  });

  // Only a stored false collapses the rack; anything else reads as the default, open, and
  // never reaches aria-expanded as itself.
  it.each(["1", "0", '"no"', "{}", "null"])("reads a SENDS state of %s as open", (raw) => {
    localStorage.setItem("urx-sends-open", raw);
    h = consoleHost();
    expect(header("ch1").getAttribute("aria-expanded")).toBe("true");
    expect(h.host.classList.contains("sends-collapsed")).toBe(false);
  });

  it("reads a stored false as collapsed", () => {
    localStorage.setItem("urx-sends-open", "false");
    h = consoleHost();
    expect(header("ch1").getAttribute("aria-expanded")).toBe("false");
    expect(h.host.classList.contains("sends-collapsed")).toBe(true);
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

// A popover destroys the row that had the focus when it closes, so a KEYBOARD dismissal has
// to hand the focus back to what opened it. Without that the operator lands on <body> and
// tabs in from the top of the document — which is the whole strip rack away from where they
// were. An outside PRESS is the other half and must NOT take the focus back: it belongs to
// whatever was pressed.
describe("where the focus goes when a popover closes", () => {
  const panBtn = (id: string): HTMLElement => h.strip(id).root.querySelector<HTMLElement>(".con-panbtn")!;
  const tapBadge = (id: string): HTMLElement => h.strip(id).root.querySelector<HTMLElement>(".con-tap")!;

  it("returns it to the SEND PAN button on Escape", () => {
    h = consoleHost();
    panBtn("ch1").click();
    expect(h.host.querySelector<HTMLElement>(".con-spop")!.hidden).toBe(false);
    // The focus is somewhere inside the popover, as it would be after tabbing into it.
    h.host.querySelector<HTMLElement>(".con-spop [tabindex], .con-spop button")?.focus();
    key(document.body, "Escape");
    expect(document.activeElement).toBe(panBtn("ch1"));
  });

  it("returns it to the meter-point badge on Escape", () => {
    h = consoleHost();
    tapBadge("ch1").click();
    expect(h.host.querySelector<HTMLElement>(".con-tappop")!.hidden).toBe(false);
    key(document.body, "Escape");
    expect(document.activeElement).toBe(tapBadge("ch1"));
  });

  // One transition further out, and the one the popovers' own placement hides: they live
  // outside the strip rack and are not rebuilt with it, so the focus INSIDE one survives a
  // repaint — while the trigger it would be handed back to does not. A device-follow does
  // this on its own, so without re-resolving, Escape after a repaint drops to <body>
  // exactly as it did before any of this.
  it("returns it to the REBUILT strip's badge when a repaint replaced the one it opened", () => {
    h = consoleHost();
    tapBadge("ch1").click();
    const opened = tapBadge("ch1");
    h.view.refreshStrip("ch1");
    expect(tapBadge("ch1"), "the repaint replaced the badge").not.toBe(opened);
    expect(h.host.querySelector<HTMLElement>(".con-tappop")!.hidden, "and left the popover open").toBe(false);
    key(document.body, "Escape");
    expect(document.activeElement).toBe(tapBadge("ch1"));
  });

  // A whole-rack repaint CLOSES all three, so the row that had the focus goes and the
  // trigger on the rebuilt strip is what is left. Live sync runs this on every device-side
  // edit that needs a read-back, so an operator standing in a popover was put on <body> by
  // the unit rather than by anything they did.
  for (const [name, open, trigger] of [
    ["the meter point", () => tapBadge("ch1").click(), () => tapBadge("ch1")],
    ["SEND PAN", () => panBtn("ch1").click(), () => panBtn("ch1")],
  ] as const) {
    it(`returns it to ${name}'s trigger when a whole-rack repaint closes the popover`, () => {
      h = consoleHost();
      open();
      const row = h.host.querySelector<HTMLElement>(".con-tappop .crow, .con-spop [tabindex], .con-spop button");
      row?.focus();
      expect(h.host.contains(document.activeElement), "standing inside the popover").toBe(true);
      h.view.refresh();
      expect(document.activeElement).toBe(trigger());
    });
  }

  // Choosing a tap from the KEYBOARD is the same transition arriving by another door: the
  // row the operator is standing on is what the selection removes, and the path used to
  // close the popover itself — before the repaint that decides where the focus goes.
  it("returns it to the badge when a tap is chosen from the keyboard", () => {
    h = consoleHost();
    tapBadge("ch1").click();
    const rows = [...h.host.querySelectorAll<HTMLElement>(".con-tappop .crow")];
    const other = rows.find((r) => !r.classList.contains("active"))!;
    other.focus();
    other.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(h.host.querySelector<HTMLElement>(".con-tappop")!.hidden, "the choice closed it").toBe(true);
    expect(document.activeElement).toBe(tapBadge("ch1"));
  });

  // The control: an open popover the operator has already left. The focus is on a strip
  // control, so the rack's own carry-over owns it and the popover rule must not reach in.
  it("leaves a focus that is already on a strip control alone", () => {
    h = consoleHost();
    tapBadge("ch1").click();
    const elsewhere = panBtn("ch2");
    elsewhere.focus();
    h.view.refresh();
    expect(document.activeElement, "the strip control, in the rebuilt strip").toBe(panBtn("ch2"));
  });

  it("leaves the focus where a press outside put it", () => {
    h = consoleHost();
    tapBadge("ch1").click();
    const elsewhere = panBtn("ch2");
    elsewhere.focus();
    // Dispatched ON the control that was pressed, which is what the handler reads: a press
    // is the operator aiming somewhere, and the popover's own exclusion is by ancestor.
    elsewhere.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(h.host.querySelector<HTMLElement>(".con-tappop")!.hidden).toBe(true);
    expect(document.activeElement, "the press owns the focus, not the popover that closed").toBe(elsewhere);
  });
});

// The popovers are appended after the whole strip rack, so from a trigger the next Tab walks
// the rest of the rack before it reaches the popover. Opened from the KEYBOARD a popover takes
// the focus — onto a list's checked row, onto SEND PAN's first knob — and once the focus
// leaves both the popover and its trigger the popover closes, so it does not stand open over
// the strips the focus moved on to. A pointer open, and the re-open a one-strip rebuild runs,
// leave the focus where it is.
describe("a popover the keyboard opens", () => {
  const tapBadge = (id: string): HTMLElement => h.strip(id).root.querySelector<HTMLElement>(".con-tap")!;
  const panBtn = (id: string): HTMLElement => h.strip(id).root.querySelector<HTMLElement>(".con-panbtn")!;
  const tapPop = (): HTMLElement => h.host.querySelector<HTMLElement>(".con-tappop")!;
  const spop = (): HTMLElement => h.host.querySelector<HTMLElement>(".con-spop")!;
  /** A click on a native button as the keyboard produces it (Enter / Space): no click count. */
  const keyClick = (el: HTMLElement): void =>
    void el.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
  const pointerClick = (el: HTMLElement): void =>
    void el.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  const focusout = (from: HTMLElement, to: HTMLElement | null): void =>
    void from.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: to }));

  afterEach(() => vi.restoreAllMocks());

  it("takes the focus onto the meter point's checked row", () => {
    h = consoleHost();
    tapBadge("ch1").focus();
    key(tapBadge("ch1"), "Enter");
    expect(tapPop().contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLElement).getAttribute("aria-checked")).toBe("true");
  });

  it("takes the focus onto SEND PAN's first knob", () => {
    h = consoleHost();
    panBtn("ch1").focus();
    keyClick(panBtn("ch1"));
    expect(document.activeElement).toBe(spop().querySelector(".con-knob"));
  });

  it.each([
    ["INS FX", (id: string) => h.strip(id).root.querySelector<HTMLElement>(".con-ifxopen")!, "ch1"],
    ["EFFECT TYPE", (id: string) => h.strip(id).root.querySelector<HTMLElement>(".con-fxopen")!, "bus.fx1"],
  ] as const)("takes the focus onto the %s list's checked row", (_name, opener, id) => {
    h = consoleHost();
    opener(id).focus();
    key(opener(id), "Enter");
    const pop = h.host.querySelector<HTMLElement>(".con-ifxpop")!;
    expect(pop.hidden).toBe(false);
    expect(pop.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLElement).getAttribute("aria-checked")).toBe("true");
  });

  it("leaves the focus where a pointer open found it", () => {
    h = consoleHost();
    panBtn("ch1").focus();
    pointerClick(panBtn("ch1"));
    expect(spop().hidden).toBe(false);
    expect(document.activeElement).toBe(panBtn("ch1"));

    tapBadge("ch2").focus();
    pointerClick(tapBadge("ch2"));
    expect(tapPop().hidden).toBe(false);
    expect(document.activeElement).toBe(tapBadge("ch2"));
  });

  it("leaves a focus elsewhere alone when a one-strip rebuild re-opens the popover", () => {
    h = consoleHost();
    pointerClick(panBtn("ch1"));
    const elsewhere = h.strip("ch2").fader!;
    elsewhere.focus();
    h.view.refreshStrip("ch1");
    expect(spop().hidden, "re-opened").toBe(false);
    expect(document.activeElement).toBe(elsewhere);
  });

  it("closes once the focus leaves both the popover and its trigger, and not before", () => {
    h = consoleHost();
    tapBadge("ch1").focus();
    key(tapBadge("ch1"), "Enter");
    const rows = [...tapPop().querySelectorAll<HTMLElement>(".crow")];
    rows[0].focus();
    expect(tapPop().hidden, "a row to another row").toBe(false);
    tapBadge("ch1").focus();
    expect(tapPop().hidden, "a row to the trigger").toBe(false);
    rows[0].focus();

    const outside = h.strip("ch2").fader!;
    outside.focus();
    expect(tapPop().hidden, "out of both").toBe(true);
    expect(tapBadge("ch1").getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement, "the focus stays where it went").toBe(outside);
  });

  // WKWebView blurs the focused element when the window loses the OS foreground, naming no new
  // target; Playwright's focus emulation keeps document.hasFocus() true, so this is the case
  // that pins it. The same event with the window still focused is the positive control.
  it("stays open when the window loses the foreground", () => {
    h = consoleHost();
    tapBadge("ch1").focus();
    key(tapBadge("ch1"), "Enter");
    const row = document.activeElement as HTMLElement;
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    focusout(row, null);
    expect(tapPop().hidden).toBe(false);
    hasFocus.mockReturnValue(true);
    focusout(row, null);
    expect(tapPop().hidden).toBe(true);
  });

  it("stays open when a press lands on a part of it that takes no focus", () => {
    h = consoleHost();
    tapBadge("ch1").focus();
    key(tapBadge("ch1"), "Enter");
    const row = document.activeElement as HTMLElement;
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    tapPop()
      .querySelector<HTMLElement>(".ph")!
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    focusout(row, null);
    expect(tapPop().hidden).toBe(false);
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    focusout(row, null);
    expect(tapPop().hidden, "the press is over").toBe(true);
  });
});

// Inside a popover's list the arrow keys walk the rows, the way the toolbar menus answer them:
// Down / Up to the next / previous row, wrapping at the ends, Home / End to the first / last. A
// row that cannot be picked takes no focus and is passed over. Tab still reaches the rows.
describe("the arrow keys inside a popover's list", () => {
  const tapBadge = (id: string): HTMLElement => h.strip(id).root.querySelector<HTMLElement>(".con-tap")!;
  const focused = (): HTMLElement => document.activeElement as HTMLElement;

  it("walk the meter point's rows, wrapping at the ends", () => {
    h = consoleHost();
    tapBadge("ch1").focus();
    key(tapBadge("ch1"), "Enter");
    const rows = [...h.host.querySelectorAll<HTMLElement>(".con-tappop .crow")];
    expect(rows.length, "the premise: a list to walk").toBeGreaterThan(2);
    const start = rows.indexOf(focused());
    expect(start, "the premise: the focus is on a row").toBeGreaterThanOrEqual(0);

    expect(key(focused(), "ArrowDown").defaultPrevented).toBe(true);
    expect(focused()).toBe(rows[(start + 1) % rows.length]);
    key(focused(), "ArrowUp");
    expect(focused()).toBe(rows[start]);
    key(focused(), "End");
    expect(focused()).toBe(rows[rows.length - 1]);
    key(focused(), "ArrowDown");
    expect(focused(), "down from the last row is the first").toBe(rows[0]);
    key(focused(), "ArrowUp");
    expect(focused(), "up from the first row is the last").toBe(rows[rows.length - 1]);
    key(focused(), "Home");
    expect(focused()).toBe(rows[0]);
  });

  it("leave a key held with a command modifier, and any other key, to the row", () => {
    h = consoleHost();
    tapBadge("ch1").focus();
    key(tapBadge("ch1"), "Enter");
    const row = focused();
    expect(key(row, "ArrowDown", { metaKey: true }).defaultPrevented).toBe(false);
    expect(key(row, "ArrowRight").defaultPrevented).toBe(false);
    expect(focused()).toBe(row);
  });

  // CH 1 holding the compander takes the one slot it has, so CH 2's INS FX list carries rows that
  // take no focus between the ones that do.
  it("pass over the INS FX rows that cannot be picked", () => {
    const plan = defaultPlan("URX44V");
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, insertFx: 1793 };
    h = consoleHost({ plan });
    const opener = h.strip("ch2").root.querySelector<HTMLElement>(".con-ifxopen")!;
    opener.focus();
    key(opener, "Enter");
    const list = h.host.querySelector<HTMLElement>(".con-ifxpop .ilist")!;
    const all = [...list.querySelectorAll<HTMLElement>(".irow")];
    const live = all.filter((r) => r.tabIndex === 0);
    expect(all.length - live.length, "the premise: rows that cannot be picked").toBeGreaterThan(0);
    expect(live.length, "the premise: more than one row to walk").toBeGreaterThan(1);
    expect(live).toContain(focused());

    const seen: HTMLElement[] = [];
    key(focused(), "Home");
    for (let i = 0; i < live.length; i++) {
      seen.push(focused());
      key(focused(), "ArrowDown");
    }
    expect(seen).toEqual(live);
    expect(focused(), "and round to the first again").toBe(live[0]);
  });

  it("walk the EFFECT TYPE rows of an FX channel", () => {
    h = consoleHost();
    const opener = h.strip("bus.fx1").root.querySelector<HTMLElement>(".con-fxopen")!;
    opener.focus();
    key(opener, "Enter");
    const rows = [...h.host.querySelectorAll<HTMLElement>(".con-ifxpop .ilist .irow")];
    const start = rows.indexOf(focused());
    expect(start).toBeGreaterThanOrEqual(0);
    key(focused(), "ArrowDown");
    expect(focused()).toBe(rows[(start + 1) % rows.length]);
  });
});
