// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_COMMIT_MS, PlanHistory } from "./history";
import type { PatchTouch } from "../core/plan-history";
import { emptyPlan } from "../core/plan";
import type { Plan } from "../core/plan";

// One PlanHistory per test, over a bare plan. The hooks record what was asked of
// them so a test can assert the number of entries a gesture produced, which is the
// whole point of the boundary rules.
interface Harness {
  history: PlanHistory;
  plan: Plan;
  reflects: PatchTouch[];
  statuses: string[];
  blocked: string | null;
  rateLocked: boolean;
  /** How many times the depth was reported — one per real transition, not per edit. */
  depthReports: number;
  /** Simulate an edit funnel: mutate, then report it. */
  edit: (mutate: (p: Plan) => void) => void;
}

function harness(): Harness {
  const plan = emptyPlan("URX44V");
  const h: Partial<Harness> & Pick<Harness, "reflects" | "statuses" | "blocked" | "rateLocked" | "depthReports"> = {
    reflects: [],
    statuses: [],
    blocked: null,
    rateLocked: false,
    depthReports: 0,
  };
  const history = new PlanHistory({
    getPlan: () => plan,
    reflect: (touch) => h.reflects.push(touch),
    blocked: () => h.blocked,
    rateLocked: () => h.rateLocked,
    labelOf: (id) => id.toUpperCase(),
    onStatus: (msg) => h.statuses.push(msg),
    onDepthChange: () => (h.depthReports += 1),
  });
  history.install();
  const out = h as Harness;
  out.history = history;
  out.plan = plan;
  out.edit = (mutate) => {
    mutate(plan);
    history.note();
  };
  return out;
}

const press = (type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel"): void => {
  window.dispatchEvent(new Event(type, { bubbles: true }));
};

const keyUp = (key: string, target?: EventTarget): void => {
  const e = new KeyboardEvent("keyup", { key, bubbles: true });
  (target ?? window).dispatchEvent(e);
};

/** An input of the given type, appended so focus can land on it. */
const input = (type: string): HTMLInputElement => {
  const el = document.createElement("input");
  el.type = type;
  document.body.append(el);
  return el;
};

/** ...and focused, for the tests that turn on where focus is. */
const focused = (type: string): HTMLInputElement => {
  const el = input(type);
  el.focus();
  return el;
};

/** Run the queued setTimeout(…, 0) commits. */
const settle = (): void => {
  vi.advanceTimersByTime(1);
};

/** Let the idle backstop fire. */
const idle = (): void => {
  vi.advanceTimersByTime(IDLE_COMMIT_MS + 1);
};

/** How many entries the history holds, read through the only public signal. */
function undoDepth(h: Harness): number {
  let n = 0;
  // canUndo counts an open entry too, so settle first at the call sites.
  while (h.history.canUndo()) {
    h.history.undo();
    if (h.statuses.at(-1) === "Nothing to undo") break;
    n++;
    settle();
  }
  return n;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("gesture boundaries", () => {
  it("collapses a whole drag into one entry", () => {
    const h = harness();
    press("pointerdown");
    for (let i = 0; i < 20; i++) h.edit((p) => (p.nodeParams.ch1 = { gain: i }));
    press("pointerup");
    settle();
    expect(undoDepth(h)).toBe(1);
    expect(h.plan.nodeParams.ch1).toBeUndefined();
  });

  it("does not split a drag that pauses mid-gesture", () => {
    const h = harness();
    press("pointerdown");
    h.edit((p) => (p.nodeParams.ch1 = { gain: 1 }));
    idle();
    idle();
    h.edit((p) => (p.nodeParams.ch1 = { gain: 2 }));
    press("pointerup");
    settle();
    expect(undoDepth(h)).toBe(1);
  });

  it("keeps an edit that arrives from the click after pointerup in the same entry", () => {
    const h = harness();
    press("pointerdown");
    press("pointerup");
    // click / dblclick are dispatched after pointerup; the commit is deferred a
    // macrotask so this lands inside the entry the gesture opened.
    h.edit((p) => (p.nodeParams.ch1 = { on: false }));
    settle();
    expect(undoDepth(h)).toBe(1);
  });

  it("records nothing for a gesture that moved no value", () => {
    const h = harness();
    press("pointerdown");
    h.edit(() => {});
    press("pointerup");
    settle();
    expect(h.history.canUndo()).toBe(false);
  });

  it("leaves the redo stack alone when a gesture moved no value", () => {
    const h = harness();
    h.edit((p) => (p.sampleRate = 96000));
    idle();
    h.history.undo();
    settle();
    expect(h.history.canRedo()).toBe(true);
    press("pointerdown");
    h.edit(() => {});
    press("pointerup");
    settle();
    expect(h.history.canRedo()).toBe(true);
  });

  it("keeps two deliberate clicks apart", () => {
    const h = harness();
    press("pointerdown");
    h.edit((p) => (p.nodeParams.ch1 = { on: false }));
    press("pointerup");
    settle();
    press("pointerdown");
    h.edit((p) => (p.nodeParams.ch2 = { on: false }));
    press("pointerup");
    settle();
    expect(undoDepth(h)).toBe(2);
  });

  it("closes a wheel burst on the idle backstop", () => {
    const h = harness();
    // No pointer gesture at all: a wheel notch dispatches only input events.
    for (let i = 0; i < 5; i++) {
      h.edit((p) => (p.nodeParams.ch1 = { gain: i }));
      vi.advanceTimersByTime(IDLE_COMMIT_MS - 50); // still arriving — must not split
    }
    expect(h.history.canRedo()).toBe(false);
    idle();
    expect(undoDepth(h)).toBe(1);
  });

  it("commits a keyup at once, so an autorepeat cannot outrun the macrotask", () => {
    const h = harness();
    // No timer is advanced between the presses: a deferred keyup commit would let
    // the second edit join the first entry whenever the page is busy enough for the
    // macrotask to run late.
    h.edit((p) => (p.nodeParams.ch1 = { gain: 1 }));
    keyUp("ArrowUp");
    h.edit((p) => (p.nodeParams.ch1 = { gain: 2 }));
    keyUp("ArrowUp");
    expect(undoDepth(h)).toBe(2);
  });

  it("lands the previous gesture's deferred commit when a new press starts", () => {
    const h = harness();
    press("pointerdown");
    press("pointerup");
    h.edit((p) => (p.nodeParams.ch1 = { on: false })); // the first click's edit
    // The macrotask has not run — a busy page can be this late. The next press must
    // not join the entry it left open, or two deliberate clicks become one.
    press("pointerdown");
    h.edit((p) => (p.nodeParams.ch2 = { on: false }));
    press("pointerup");
    settle();
    expect(undoDepth(h)).toBe(2);
  });

  it("closes one entry per key press for autorepeated stepping", () => {
    const h = harness();
    for (let i = 1; i <= 3; i++) {
      h.edit((p) => (p.nodeParams.ch1 = { gain: i }));
      keyUp("ArrowDown");
      settle();
    }
    expect(undoDepth(h)).toBe(3);
  });

  it("does not let the idle backstop split a slowly typed name", () => {
    const h = harness();
    const field = focused("text");
    // Three keystrokes with a long pause between each: the field's end of edit is
    // its focusout, so the backstop must not pre-empt it.
    for (const ch of ["A", "B", "C"]) {
      h.edit((p) => (p.nodeNames.ch1 = (p.nodeNames.ch1 ?? "") + ch));
      idle();
      idle();
    }
    field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    settle();
    expect(undoDepth(h)).toBe(1);
  });

  it("still arms the backstop when the focused control owns no undo stack", () => {
    const h = harness();
    focused("range");
    h.edit((p) => (p.nodeParams.ch1 = { gain: 1 }));
    idle();
    expect(h.history.canUndo()).toBe(true);
    // Committed by the backstop, not by a boundary: undoing needs no focusout.
    expect(undoDepth(h)).toBe(1);
  });

  it("does not treat a character keyup in a text field as a boundary", () => {
    const h = harness();
    const field = input("text");
    for (const ch of ["A", "B", "C"]) {
      h.edit((p) => (p.nodeNames.ch1 = (p.nodeNames.ch1 ?? "") + ch));
      keyUp(ch, field);
      settle();
    }
    // Still one open entry: the field's end of edit is the focusout below.
    expect(h.history.canUndo()).toBe(true);
    field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    settle();
    expect(undoDepth(h)).toBe(1);
  });

  it("closes an entry on focusout", () => {
    const h = harness();
    h.edit((p) => (p.notes.ch1 = "gate on"));
    window.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    settle();
    expect(undoDepth(h)).toBe(1);
  });

  it("closes an entry when a pointercancel ends the gesture", () => {
    const h = harness();
    press("pointerdown");
    h.edit((p) => (p.positions.ch1 = { x: 10, y: 20 }));
    press("pointercancel");
    settle();
    expect(undoDepth(h)).toBe(1);
  });
});

describe("device follow", () => {
  it("keeps a device-authored value out of the next entry", () => {
    const h = harness();
    h.edit((p) => (p.nodeParams.ch1 = { hpf: true }));
    idle();
    // The operator moved CH 3 on the unit: follow writes it and rebases.
    h.plan.nodeParams.ch3 = { gain: 30 };
    h.history.rebase();
    h.history.undo();
    settle();
    expect(h.plan.nodeParams.ch1).toBeUndefined();
    // Untouched by the inverse patch, so the live diff sends nothing for it.
    expect(h.plan.nodeParams.ch3).toEqual({ gain: 30 });
  });

  it("drops the entry still open when the device writes into the plan", () => {
    const h = harness();
    h.edit((p) => (p.nodeParams.ch1 = { hpf: true }));
    h.history.rebase();
    expect(h.history.canUndo()).toBe(false);
  });

  it("does not stop recording after a device write", () => {
    const h = harness();
    h.history.rebase();
    h.edit((p) => (p.nodeParams.ch1 = { hpf: true }));
    idle();
    expect(h.history.canUndo()).toBe(true);
  });
});

describe("apply", () => {
  it("suppresses recording while the reflect runs back through the funnel", () => {
    const plan = emptyPlan("URX44V");
    let reflected = 0;
    // A real reflect ends in markChanged(), which calls note() — the loop this
    // guards against, since the entry it would open covers the undo's own effect.
    const history: PlanHistory = new PlanHistory({
      getPlan: () => plan,
      reflect: () => {
        reflected++;
        history.note();
      },
      blocked: () => null,
      rateLocked: () => false,
      labelOf: (id) => id,
      onStatus: () => {},
    });
    plan.sampleRate = 96000;
    history.note();
    idle();
    history.undo();
    expect(reflected).toBe(1);
    expect(history.canRedo()).toBe(true);
    expect(history.canUndo()).toBe(false);
  });

  it("reports the node when a patch names exactly one", () => {
    const h = harness();
    h.edit((p) => (p.nodeParams.ch1 = { hpf: true }));
    idle();
    h.history.undo();
    expect(h.statuses.at(-1)).toBe("Undid the change to CH1");
  });

  it("reports without a node when a patch names none", () => {
    const h = harness();
    h.edit((p) => (p.sampleRate = 96000));
    idle();
    h.history.undo();
    expect(h.statuses.at(-1)).toBe("Undone");
  });

  it("says so when there is nothing to undo or redo", () => {
    const h = harness();
    h.history.undo();
    expect(h.statuses.at(-1)).toBe("Nothing to undo");
    h.history.redo();
    expect(h.statuses.at(-1)).toBe("Nothing to redo");
  });

  it("redoes what it undid", () => {
    const h = harness();
    h.edit((p) => (p.sampleRate = 96000));
    idle();
    h.history.undo();
    settle();
    expect(h.plan.sampleRate).not.toBe(96000);
    h.history.redo();
    settle();
    expect(h.plan.sampleRate).toBe(96000);
    expect(h.reflects.length).toBe(2);
  });

  it("commits an open entry before undoing, so the current gesture is what goes back", () => {
    const h = harness();
    h.edit((p) => (p.nodeParams.ch1 = { hpf: true }));
    // No boundary yet — the entry is still open.
    h.history.undo();
    expect(h.plan.nodeParams.ch1).toBeUndefined();
  });
});

describe("refusals", () => {
  it("refuses while a device read or a file flow holds the plan, without spending the entry", () => {
    const h = harness();
    h.edit((p) => (p.sampleRate = 96000));
    idle();
    h.blocked = "busy";
    h.history.undo();
    expect(h.statuses.at(-1)).toBe("busy");
    expect(h.plan.sampleRate).toBe(96000);
    h.blocked = null;
    h.history.undo();
    settle();
    expect(h.plan.sampleRate).not.toBe(96000);
  });

  it("refuses while a drag is in progress", () => {
    const h = harness();
    h.edit((p) => (p.nodeParams.ch1 = { hpf: true }));
    idle();
    press("pointerdown");
    press("pointermove");
    h.history.undo();
    expect(h.statuses.at(-1)).toBe("Finish the current drag before undoing");
    expect(h.plan.nodeParams.ch1).toEqual({ hpf: true });
  });

  it("allows an undo under a press that has not moved", () => {
    const h = harness();
    h.edit((p) => (p.nodeParams.ch1 = { hpf: true }));
    idle();
    // A wire is selected by a script-dispatched pointerdown with no matching
    // pointerup, so keying the refusal on the press alone would wedge it for good.
    press("pointerdown");
    h.history.undo();
    expect(h.plan.nodeParams.ch1).toBeUndefined();
  });

  it("ends the drag when the window loses focus mid-gesture", () => {
    const h = harness();
    h.edit((p) => (p.nodeParams.ch1 = { hpf: true }));
    idle();
    press("pointerdown");
    press("pointermove");
    window.dispatchEvent(new Event("blur"));
    h.history.undo();
    expect(h.plan.nodeParams.ch1).toBeUndefined();
  });

  it("ignores a pointermove with no press behind it", () => {
    const h = harness();
    h.edit((p) => (p.nodeParams.ch1 = { hpf: true }));
    idle();
    press("pointermove");
    h.history.undo();
    expect(h.plan.nodeParams.ch1).toBeUndefined();
  });

  it("refuses a rate change while a live session holds the rate", () => {
    const h = harness();
    h.edit((p) => (p.sampleRate = 96000));
    idle();
    h.rateLocked = true;
    h.history.undo();
    expect(h.statuses.at(-1)).toBe(
      "The sample rate follows the device while Live sync is on — it cannot be undone here",
    );
    expect(h.plan.sampleRate).toBe(96000);
    // Not consumed: turning the session off makes the same press work.
    h.rateLocked = false;
    h.history.undo();
    settle();
    expect(h.plan.sampleRate).not.toBe(96000);
  });

  it("allows an undo that does not touch the rate while live", () => {
    const h = harness();
    h.edit((p) => (p.nodeParams.ch1 = { hpf: true }));
    idle();
    h.rateLocked = true;
    h.history.undo();
    expect(h.plan.nodeParams.ch1).toBeUndefined();
  });
});

describe("reset", () => {
  it("drops both stacks", () => {
    const h = harness();
    h.edit((p) => (p.sampleRate = 96000));
    idle();
    h.history.undo();
    settle();
    expect(h.history.canRedo()).toBe(true);
    h.history.reset();
    expect(h.history.canUndo()).toBe(false);
    expect(h.history.canRedo()).toBe(false);
  });

  it("cancels a deferred commit so it cannot land after the reset", () => {
    const h = harness();
    press("pointerdown");
    h.edit((p) => (p.sampleRate = 96000));
    press("pointerup"); // schedules the commit a macrotask out
    h.history.reset();
    settle();
    expect(h.history.canUndo()).toBe(false);
  });
});

describe("the keyboard shortcut", () => {
  const key = (init: KeyboardEventInit, target?: EventTarget): KeyboardEvent => {
    const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    // handleKey is called by main's own listener, so drive it directly — but from a
    // real event so target and preventDefault behave.
    (target ?? window).dispatchEvent(e);
    return e;
  };

  it("takes Ctrl+Z and Cmd+Z as undo", () => {
    for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
      const h = harness();
      h.edit((p) => (p.sampleRate = 96000));
      idle();
      const e = key({ key: "z", ...mod });
      expect(h.history.handleKey(e)).toBe(true);
      expect(h.plan.sampleRate).not.toBe(96000);
    }
  });

  it("takes both Shift+Z and Y as redo", () => {
    for (const redo of [{ key: "z", shiftKey: true }, { key: "y" }]) {
      const h = harness();
      h.edit((p) => (p.sampleRate = 96000));
      idle();
      h.history.handleKey(key({ key: "z", metaKey: true }));
      settle();
      h.history.handleKey(key({ ...redo, metaKey: true }));
      settle();
      expect(h.plan.sampleRate).toBe(96000);
    }
  });

  it("accepts an uppercase key, as a shifted chord reports it", () => {
    const h = harness();
    h.edit((p) => (p.sampleRate = 96000));
    idle();
    expect(h.history.handleKey(key({ key: "Z", metaKey: true }))).toBe(true);
  });

  it("calls preventDefault when it acts, which is what suppresses the native undo", () => {
    const h = harness();
    const e = key({ key: "z", metaKey: true });
    h.history.handleKey(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it("ignores the chord with Alt held, and a bare Z", () => {
    const h = harness();
    expect(h.history.handleKey(key({ key: "z", metaKey: true, altKey: true }))).toBe(false);
    expect(h.history.handleKey(key({ key: "z" }))).toBe(false);
  });

  it("ignores a chord that is still composing in an IME", () => {
    const h = harness();
    expect(h.history.handleKey(key({ key: "z", metaKey: true, isComposing: true }))).toBe(false);
  });

  it("leaves the chord to a field that owns its own undo", () => {
    const h = harness();
    h.edit((p) => (p.sampleRate = 96000));
    idle();
    for (const el of [input("text"), document.body.appendChild(document.createElement("textarea"))]) {
      const e = key({ key: "z", metaKey: true }, el);
      expect(h.history.handleKey(e)).toBe(false);
      expect(e.defaultPrevented).toBe(false);
    }
    expect(h.plan.sampleRate).toBe(96000);
  });

  it("acts with focus on a control that owns no undo stack", () => {
    const h = harness();
    h.edit((p) => (p.sampleRate = 96000));
    idle();
    const range = input("range");
    expect(h.history.handleKey(key({ key: "z", metaKey: true }, range))).toBe(true);
    expect(h.plan.sampleRate).not.toBe(96000);
  });
});

describe("depth reporting", () => {
  it("reports once for a whole drag, not once per edit", () => {
    const h = harness();
    press("pointerdown");
    for (let i = 0; i < 20; i++) h.edit((p) => (p.nodeParams.ch1 = { gain: i }));
    press("pointermove");
    press("pointerup");
    settle();
    // Every report crosses the IPC boundary to a native menu item, so the count is
    // the point: false -> true at the first edit, and nothing after it.
    expect(h.depthReports).toBe(1);
  });

  it("reports the entry closing back to nothing when a gesture moved no value", () => {
    const h = harness();
    press("pointerdown");
    h.edit(() => {});
    expect(h.depthReports).toBe(1); // canUndo went true on the open entry
    press("pointerup");
    settle();
    expect(h.depthReports).toBe(2); // ...and false again when it recorded nothing
    expect(h.history.canUndo()).toBe(false);
  });

  it("reports redo becoming available and then unavailable", () => {
    const h = harness();
    h.edit((p) => (p.sampleRate = 96000));
    idle();
    const before = h.depthReports;
    h.history.undo();
    settle();
    expect(h.history.canRedo()).toBe(true);
    expect(h.depthReports).toBeGreaterThan(before);
    const afterUndo = h.depthReports;
    h.edit((p) => (p.nodeParams.ch1 = { hpf: true }));
    idle();
    expect(h.history.canRedo()).toBe(false);
    expect(h.depthReports).toBeGreaterThan(afterUndo);
  });

  it("does not report when a device rebase changes nothing observable", () => {
    const h = harness();
    h.history.rebase();
    h.history.rebase();
    expect(h.depthReports).toBe(0);
  });
});

describe("the application menu's entry points", () => {
  it("undoes the plan when no text surface holds focus", () => {
    const h = harness();
    h.edit((p) => (p.sampleRate = 96000));
    idle();
    h.history.menu("undo");
    settle();
    expect(h.plan.sampleRate).not.toBe(96000);
  });

  it("hands a focused text field its own undo instead of touching the plan", () => {
    const h = harness();
    h.edit((p) => (p.sampleRate = 96000));
    idle();
    const exec = vi.fn(() => true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    focused("text");
    h.history.menu("undo");
    expect(exec).toHaveBeenCalledWith("undo");
    // The plan is untouched: the same chord in that field would not have moved it
    // either, so the menu agrees with the keyboard.
    expect(h.plan.sampleRate).toBe(96000);
  });

  it("hands the field its redo too", () => {
    const h = harness();
    const exec = vi.fn(() => true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    focused("text");
    h.history.menu("redo");
    expect(exec).toHaveBeenCalledWith("redo");
  });

  it("treats a field with nothing to undo as the field's answer, not the plan's", () => {
    const h = harness();
    h.edit((p) => (p.sampleRate = 96000));
    idle();
    const exec = vi.fn(() => false); // the field had nothing to undo
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    focused("text");
    h.history.menu("undo");
    expect(h.plan.sampleRate).toBe(96000);
  });

  it("redoes the plan when no text surface holds focus", () => {
    const h = harness();
    h.edit((p) => (p.sampleRate = 96000));
    idle();
    h.history.menu("undo");
    settle();
    h.history.menu("redo");
    settle();
    expect(h.plan.sampleRate).toBe(96000);
  });
});
