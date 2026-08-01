// @vitest-environment jsdom
// The keyboard measurement harness is driven by hand, from the function keys, during a
// real desktop session — nothing at build time checks that F8 still makes a field or
// that F9 still runs an undo. An operator who has memorized the bindings is the
// interface, so the bindings and the window handle are pinned here: renaming one side
// has to be renaming the other.
//
// Installed once, as it is at startup: the harness registers a window listener it never
// removes, so re-installing per test would stack them and each key would act twice.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installKeyProbe } from "./keyprobe";
import type { KeyProbe } from "./keyprobe";

let reports: string[] = [];
let exec: ReturnType<typeof vi.fn>;
let probe: KeyProbe;
let host: HTMLElement;
let refreshed = 0;
let rebuilt = 0;

// Dispatched from whatever holds focus, the way a browser does it, so the harness's
// reported target is the element and not the window.
const key = (k: string, init?: KeyboardEventInit): KeyboardEvent => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
};

const handle = (): KeyProbe | undefined => (window as unknown as { __urxKeyProbe?: KeyProbe }).__urxKeyProbe;

beforeAll(() => {
  host = document.createElement("div");
  host.id = "inspector";
  document.body.append(host);
  probe = installKeyProbe({
    onReport: (m) => reports.push(m),
    refreshInspector: () => refreshed++,
    rebuildInspector: () => rebuilt++,
    inspectorHost: host,
    // The app passes its own reflect floor here; any value drives the same code.
    pulseMs: 50,
  });
});

beforeEach(() => {
  probe.setLog(false);
  probe.setPulse("off");
  probe.setImeRecord(false);
  refreshed = 0;
  rebuilt = 0;
  // jsdom does not implement execCommand; the harness only needs its return value.
  exec = vi.fn(() => true);
  (document as unknown as { execCommand: unknown }).execCommand = exec;
  reports = [];
});

describe("key probe contract", () => {
  it("publishes the harness on window", () => {
    expect(handle()).toBe(probe);
    for (const member of ["blur", "field", "exec", "setLog", "setImeRecord", "setPulse", "imeLog"] as const) {
      expect(typeof handle()![member]).toBe("function");
    }
  });

  it("F8 makes the probe field once and focuses it", () => {
    key("F8");
    const field = document.getElementById("keyprobe-field") as HTMLInputElement | null;
    expect(field).not.toBeNull();
    expect(field!.type).toBe("text");
    expect(document.activeElement).toBe(field);
    key("F8");
    expect(document.querySelectorAll("#keyprobe-field").length).toBe(1);
    expect(reports.at(-1)).toContain("probe field:");
  });

  it("F9 and F10 run the editing commands and report what they returned", () => {
    key("F6"); // report against a known focus, not whatever the previous test left
    key("F9");
    expect(exec).toHaveBeenCalledWith("undo");
    expect(reports.at(-1)).toBe("probe undo: returned=true active=BODY");
    key("F10");
    expect(exec).toHaveBeenCalledWith("redo");
    expect(reports.at(-1)).toContain("probe redo: returned=true");
  });

  it("reports the field's contents alongside the command, which is the reading", () => {
    key("F8");
    const field = document.getElementById("keyprobe-field") as HTMLInputElement;
    field.value = "typed";
    key("F9");
    expect(reports.at(-1)).toBe('probe undo: returned=true active=INPUT/text#keyprobe-field val="typed"');
  });

  it("F6 blurs, so a not-in-a-field state can be set up", () => {
    key("F8");
    expect(document.activeElement).not.toBe(document.body);
    key("F6");
    expect(document.activeElement).toBe(document.body);
    expect(reports.at(-1)).toBe("probe blur: active=BODY");
  });

  it("logs a chord only while F7 has it on, and reports whether the app claimed it", () => {
    key("z", { metaKey: true });
    expect(reports.length).toBe(0);

    key("F7");
    expect(reports.at(-1)).toBe("probe chord log: on");
    key("F6"); // a known target
    key("z", { metaKey: true, shiftKey: true });
    expect(reports.at(-1)).toBe("probe chord: meta+shift+z prevented=false target=BODY");

    // An earlier handler having claimed the chord is the signal that matters. Capture
    // phase, so it runs before the harness's own (bubble) listener — which is the order
    // the app's handler has at runtime.
    window.addEventListener("keydown", (e) => e.preventDefault(), { capture: true, once: true });
    key("y", { ctrlKey: true });
    expect(reports.at(-1)).toContain("prevented=true");

    key("F7");
    expect(reports.at(-1)).toBe("probe chord log: off");
    key("z", { metaKey: true });
    expect(reports.at(-1)).toBe("probe chord log: off");
  });

  it("ignores an unmodified key while logging", () => {
    key("F7");
    key("a");
    expect(reports.at(-1)).toBe("probe chord log: on");
  });
});

// The IME arm cannot be exercised for real anywhere but a desktop session with an input
// method attached — jsdom has no composition of its own. What is pinned here is
// everything around it: the bindings, which repaint path each key drives, and that the
// record counts what the reading is read off.
describe("key probe IME arm", () => {
  it("F3 and F4 pulse the two different repaint paths, and toggle themselves off", () => {
    vi.useFakeTimers();
    try {
      key("F3");
      expect(reports.at(-1)).toBe("probe pulse: gated");
      vi.advanceTimersByTime(160);
      expect(refreshed).toBeGreaterThan(1);
      // The gated arm must not reach the ungated rebuild, or both keys measure one thing.
      expect(rebuilt).toBe(0);

      key("F3");
      expect(reports.at(-1)).toBe("probe pulse: off");
      const settled = refreshed;
      vi.advanceTimersByTime(160);
      expect(refreshed).toBe(settled);

      key("F4");
      expect(reports.at(-1)).toBe("probe pulse: forced");
      vi.advanceTimersByTime(160);
      expect(rebuilt).toBeGreaterThan(1);
      expect(refreshed).toBe(settled);
      key("F4");
      expect(reports.at(-1)).toBe("probe pulse: off");
    } finally {
      vi.useRealTimers();
    }
  });

  it("F2 records the composition events and the host's own replacement", async () => {
    const input = document.createElement("input");
    host.append(input);
    input.focus();

    key("F2");
    expect(reports.at(-1)).toBe("probe ime: recording");

    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    input.value = "にほん";
    input.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true }));
    // What a repaint does to the host, whoever asked for it: replaceChildren empties it.
    host.replaceChildren();
    // MutationObserver delivers on a microtask.
    await Promise.resolve();

    const log = probe.imeLog();
    expect(log.map((e) => e.kind)).toEqual(["compositionstart", "compositionupdate", "replaced"]);
    expect(log[1].value).toBe("にほん");

    key("F2");
    // Every count the reading is read off is on the line and none is inferred from
    // another: `end` and `focusout` are the two events the composition gate releases on,
    // and the first desktop reading had neither reach the host.
    expect(reports.at(-1)).toMatch(/^probe ime: repaints asked=0 landed=1 start=1 end=0 focusout=0 input=0 value=/);
    // Stopping keeps the timeline — the summary is the reading, the timeline is the appeal.
    expect(probe.imeLog()).toHaveLength(3);
  });

  it("stands the input method's conversion keys down while the record is on", () => {
    // F6 is this harness's blur and Kotoeri's ひらがな at the same time, and the key reaches
    // both: pressing it mid-composition committed the composition under measurement. The
    // stop keys must stay live through the same window, or a run cannot be ended.
    key("F8");
    const field = document.getElementById("keyprobe-field") as HTMLInputElement;
    expect(document.activeElement).toBe(field);

    key("F2");
    key("F6");
    expect(document.activeElement).toBe(field);
    key("F7");
    key("z", { metaKey: true });
    expect(reports.at(-1)).toBe("probe ime: recording"); // F7 never turned the chord log on

    key("F2");
    expect(reports.at(-1)).toContain("probe ime: repaints");
    key("F6");
    expect(document.activeElement).toBe(document.body);
  });

  it("counts a pulse's repaints against the replacements they actually landed", () => {
    vi.useFakeTimers();
    try {
      key("F2");
      key("F4");
      vi.advanceTimersByTime(160);
      key("F4");
      key("F2");
      // The stub hooks replace nothing, so "asked" moves and "landed" does not: the two
      // are counted from different sides on purpose, which is what makes a held repaint
      // (asked, never landed) distinguishable from one that ran.
      expect(reports.at(-1)).toMatch(/repaints asked=[1-9]\d* landed=0 /);
    } finally {
      vi.useRealTimers();
    }
  });
});
