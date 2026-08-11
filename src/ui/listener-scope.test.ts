// @vitest-environment jsdom

// The recorder's own contract, and the jsdom facts it rests on. Both are pinned
// here because the helper's whole job is to leave the environment as it found it —
// a claim nothing else in the suite would notice being false, and one a reader has
// to take on trust otherwise.

import { describe, expect, it } from "vitest";
import { recordWindowListeners } from "./listener-scope.test-util";

const ownDescriptor = (): PropertyDescriptor | undefined => Object.getOwnPropertyDescriptor(window, "addEventListener");

describe("what jsdom gives us to restore", () => {
  // The premise the restore strategy rests on. `addEventListener` is ALREADY an own
  // property of jsdom's window — the recorder does not make it one — and it is an
  // accessor, so an assignment runs its setter and the accessor survives. Restoring
  // by assignment is therefore exact, and `delete` would be wrong: it would take
  // jsdom's own property away and leave the window inheriting from the prototype,
  // which is not the state anything here started in.
  it("is an own accessor on window before anything patches it", () => {
    const d = ownDescriptor();
    expect(d).toBeDefined();
    expect(typeof d!.get).toBe("function");
    expect(typeof d!.set).toBe("function");
    expect(d!.value).toBeUndefined();
    expect(d!.configurable).toBe(true);
  });

  // Measured, and the reason a prototype-level spy is not an alternative to this
  // helper: window's own property shadows EventTarget.prototype whether or not the
  // recorder has ever run, so a spy there observes none of window's registrations.
  it("shadows EventTarget.prototype with no help from the recorder", () => {
    const real = EventTarget.prototype.addEventListener;
    let seen = 0;
    EventTarget.prototype.addEventListener = function (this: EventTarget, ...args: Parameters<typeof real>) {
      seen++;
      return real.apply(this, args);
    };
    try {
      const fn = (): void => {};
      window.addEventListener("pagehide", fn);
      window.removeEventListener("pagehide", fn);
    } finally {
      EventTarget.prototype.addEventListener = real;
    }
    expect(seen).toBe(0);
  });
});

describe("recordWindowListeners", () => {
  it("restores the property exactly, descriptor and all", () => {
    const before = ownDescriptor()!;
    const original = window.addEventListener;

    const rec = recordWindowListeners();
    expect(window.addEventListener).not.toBe(original);

    rec.stop();
    rec.release();

    const after = ownDescriptor()!;
    expect(window.addEventListener).toBe(original);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(after.get).toBe(before.get);
    expect(after.set).toBe(before.set);
    expect(after.enumerable).toBe(before.enumerable);
    expect(after.configurable).toBe(before.configurable);
  });

  it("removes what was registered while it recorded, and nothing else", () => {
    const outside = (): void => void hits.push("outside");
    const hits: string[] = [];
    window.addEventListener("pagehide", outside);

    const rec = recordWindowListeners();
    window.addEventListener("pagehide", () => hits.push("inside"));
    rec.stop();

    window.dispatchEvent(new Event("pagehide"));
    expect(hits).toEqual(["outside", "inside"]);

    rec.release();
    hits.length = 0;
    window.dispatchEvent(new Event("pagehide"));
    expect(hits).toEqual(["outside"]);

    window.removeEventListener("pagehide", outside);
  });

  it("records nothing after it has stopped", () => {
    const rec = recordWindowListeners();
    rec.stop();
    let hits = 0;
    const fn = (): void => void hits++;
    window.addEventListener("pagehide", fn);
    rec.release();
    window.dispatchEvent(new Event("pagehide"));
    expect(hits).toBe(1);
    window.removeEventListener("pagehide", fn);
  });

  // removeEventListener matches on the capture flag, so a listener registered with
  // one has to be released with the same options object it went in with.
  it("releases a capturing listener", () => {
    const rec = recordWindowListeners();
    let hits = 0;
    window.addEventListener("pagehide", () => hits++, { capture: true });
    rec.stop();

    window.dispatchEvent(new Event("pagehide"));
    expect(hits).toBe(1);

    rec.release();
    window.dispatchEvent(new Event("pagehide"));
    expect(hits).toBe(1);
  });

  it("releases a boolean-capture listener", () => {
    const rec = recordWindowListeners();
    let hits = 0;
    window.addEventListener("pagehide", () => hits++, true);
    rec.stop();
    rec.release();
    window.dispatchEvent(new Event("pagehide"));
    expect(hits).toBe(0);
  });

  // A `once` listener that never fired is still registered, so it is still the
  // recorder's to take back.
  it("releases a once listener that never fired", () => {
    const rec = recordWindowListeners();
    let hits = 0;
    window.addEventListener("pagehide", () => hits++, { once: true });
    rec.stop();
    rec.release();
    window.dispatchEvent(new Event("pagehide"));
    expect(hits).toBe(0);
  });

  // The forwarded tuple's callback is nullable, so the recorder guards on it. Only
  // untyped code reaches this — the cast is what stands in for that caller.
  it("ignores a null callback rather than recording one to remove", () => {
    const rec = recordWindowListeners();
    const addNull = window.addEventListener as unknown as (type: string, fn: null) => void;
    expect(() => addNull("pagehide", null)).not.toThrow();
    rec.stop();
    expect(() => rec.release()).not.toThrow();
  });

  describe("nesting", () => {
    it("gives each scope back only its own listeners", () => {
      const hits: string[] = [];
      const outer = recordWindowListeners();
      window.addEventListener("pagehide", () => hits.push("outer"));
      const inner = recordWindowListeners();
      window.addEventListener("pagehide", () => hits.push("inner"));
      inner.stop();
      outer.stop();

      inner.release();
      window.dispatchEvent(new Event("pagehide"));
      expect(hits).toEqual(["outer"]);

      hits.length = 0;
      outer.release();
      window.dispatchEvent(new Event("pagehide"));
      expect(hits).toEqual([]);
    });

    // A scope that has stopped is inert. An out-of-order stop leaves its patch
    // installed — there is nothing safe to restore it to — but a patch that kept
    // recording would hand a finished scope listeners it never asked for, and
    // `release()` would then take away somebody else's.
    it("keeps a patch left by an out-of-order stop from recording", () => {
      const outer = recordWindowListeners();
      const inner = recordWindowListeners();
      outer.stop(); // out of order — the active patch is the inner one
      inner.stop();

      const hits: string[] = [];
      window.addEventListener("pagehide", () => hits.push("after"));
      outer.release();
      inner.release();
      window.dispatchEvent(new Event("pagehide"));
      // Registered after both stopped, so neither scope may claim it.
      expect(hits).toEqual(["after"]);
    });
  });
});
