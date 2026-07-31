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

// Dispatched from whatever holds focus, the way a browser does it, so the harness's
// reported target is the element and not the window.
const key = (k: string, init?: KeyboardEventInit): KeyboardEvent => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
};

const handle = (): KeyProbe | undefined => (window as unknown as { __urxKeyProbe?: KeyProbe }).__urxKeyProbe;

beforeAll(() => {
  probe = installKeyProbe({ onReport: (m) => reports.push(m) });
});

beforeEach(() => {
  probe.setLog(false);
  // jsdom does not implement execCommand; the harness only needs its return value.
  exec = vi.fn(() => true);
  (document as unknown as { execCommand: unknown }).execCommand = exec;
  reports = [];
});

describe("key probe contract", () => {
  it("publishes the harness on window", () => {
    expect(handle()).toBe(probe);
    for (const member of ["blur", "field", "exec", "setLog"] as const) {
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
