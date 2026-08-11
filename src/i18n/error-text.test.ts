// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { errorCode, errorText, SHELL_CODES, setLang } from "./index";
import { en } from "./en";
import { ja } from "./ja";

// The whole point of the code scheme is that a failure raised outside the UI layer
// (the Rust shell, core's export path) never reaches a localized dialog in English.
describe("errorText", () => {
  beforeEach(() => setLang("en"));

  it("localizes a bare code", () => {
    setLang("ja");
    expect(errorText(new Error("file-not-found"))).toBe(ja.error.shell.fileNotFound);
    expect(errorText("not-connected")).toBe(ja.error.shell.notConnected);
  });

  it("passes the detail after the first ': ' to an entry that takes one", () => {
    setLang("ja");
    expect(errorText(new Error("broker-timeout: value at 766:0:0"))).toBe(
      ja.error.shell.brokerTimeout("value at 766:0:0"),
    );
    // The detail itself can hold ": " — only the first separator splits.
    expect(errorText(new Error("file-io: oops: os error 28"))).toBe(ja.error.shell.fileIo("oops: os error 28"));
  });

  it("drops the detail for an entry that does not take one", () => {
    setLang("ja");
    expect(errorText(new Error("device-lost: sync_status offline"))).toBe(ja.error.shell.deviceLost);
  });

  it("follows the active language", () => {
    expect(errorText(new Error("file-denied"))).toBe(en.error.shell.fileDenied);
    setLang("ja");
    expect(errorText(new Error("file-denied"))).toBe(ja.error.shell.fileDenied);
  });

  it("passes an unknown message through unchanged, so nothing is swallowed", () => {
    setLang("ja");
    expect(errorText(new Error("TypeError: x is not a function"))).toBe("TypeError: x is not a function");
    expect(errorText("something odd")).toBe("something odd");
  });

  // A detail-taking entry rendered around an empty detail would read as "… ()", so
  // a code raised without the detail it always carries falls through instead.
  it("passes a detail-taking code through when the detail is missing", () => {
    setLang("ja");
    expect(errorText(new Error("file-io"))).toBe("file-io");
    expect(errorText(new Error("file-io: "))).toBe("file-io: ");
  });

  // A rejection is not necessarily an Error. The click-handler backstop
  // (app/flow-latch.ts) routes whatever an action rejected with through here into a
  // dialog, so every shape has to come out the other side — this is a REPORTING
  // path, and a throw here would replace the failure it was called to describe.
  describe("a rejection that is not an Error", () => {
    it.each([
      ["a string", "something odd", "something odd"],
      ["a number", 42, "42"],
      ["null", null, "null"],
      ["undefined", undefined, "undefined"],
      ["an array", [1, 2], "1,2"],
      ["a plain object", {}, "[object Object]"],
    ])("describes %s", (_name, err, expected) => {
      expect(errorText(err)).toBe(expected);
    });

    // A DOMException is what a cancel arrives as. Asserted as a property rather than
    // a literal, because THIS ONE DIFFERS BY ENVIRONMENT: jsdom builds it in another
    // realm, so `instanceof Error` is false there (Error is still in its prototype
    // chain) and the description falls to `String(err)` — "AbortError: aborted". In
    // the shipping webview, and in bare V8, `instanceof` holds and the description is
    // the message alone — "aborted". Both were measured. Pinning either literal would
    // pin the environment instead of the app, so pin what holds in both.
    //
    // The app's own cancel handling does not come through here: it tests
    // `err instanceof DOMException && err.name === "AbortError"` directly, within one
    // realm.
    it("describes a DOMException without throwing, whichever realm built it", () => {
      const aborted = new DOMException("aborted", "AbortError");
      expect(() => errorText(aborted)).not.toThrow();
      expect(errorText(aborted)).toContain("aborted");
    });

    // The one shape String() refuses. Answered as empty rather than thrown: a
    // reporter that throws loses the failure AND itself.
    it("answers empty for a value that cannot be converted, rather than throwing", () => {
      const unconvertible = Object.create(null) as object;
      expect(() => errorText(unconvertible)).not.toThrow();
      expect(errorText(unconvertible)).toBe("");
      expect(() => errorCode(unconvertible)).not.toThrow();
    });

    // Empty in, empty out. Nothing here invents text for it — the caller decides
    // what an empty description is worth, which is why the write-report paths
    // substitute their own generic reason.
    it("passes an empty message through as empty", () => {
      expect(errorText(new Error(""))).toBe("");
      expect(errorText("")).toBe("");
    });
  });

  // Being an Error is no guarantee its message can be read, or that it is a string.
  // Three separate hazards, all on the reporting path, all measured to throw before
  // the guard covered them: the prototype walk `instanceof` performs, the message
  // read, and the string conversion.
  describe("an Error that refuses to describe itself", () => {
    it("answers empty for a message getter that throws", () => {
      const err = new Error("x");
      Object.defineProperty(err, "message", {
        get() {
          throw new Error("getter exploded");
        },
      });
      expect(() => errorText(err)).not.toThrow();
      expect(errorText(err)).toBe("");
      expect(() => errorCode(err)).not.toThrow();
    });

    // A non-string message has no `.indexOf`, which is what splits code from detail.
    it.each([
      ["a symbol", Symbol("s"), "Symbol(s)"],
      ["a number", 42, "42"],
    ])("converts %s message rather than splitting it as a string", (_name, value, expected) => {
      const err = new Error("x");
      Object.defineProperty(err, "message", { value, writable: true });
      expect(() => errorText(err)).not.toThrow();
      expect(errorText(err)).toBe(expected);
    });

    // `instanceof` walks the target's prototype chain, so a Proxy trap throws
    // before the message is ever reached.
    it("answers empty when the instanceof check itself throws", () => {
      const hostile = new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error("proto exploded");
          },
        },
      );
      expect(() => errorText(hostile)).not.toThrow();
      expect(errorText(hostile)).toBe("");
      expect(() => errorCode(hostile)).not.toThrow();
    });
  });

  // Every code the shell can raise must resolve, or that failure path shows the raw
  // code instead of a message. Codes that carry a detail are listed with one, since
  // that is the only shape they are raised in.
  it("resolves every code the Rust shell and core emit", () => {
    const messages = [
      "broker-unreachable",
      "no-device",
      "control-worker-gone",
      "device-lost: sync_status offline",
      "broker-closed",
      "broker-no-vdpport: the device list carried no port",
      "not-connected",
      "broker-timeout: value at 766:0:0",
      // Latched by the worker after a run of deadlines, so it is raised bare — the
      // detail belongs to the one command that timed out, not to the stall.
      "broker-unresponsive",
      "broker-rejected: 140:0:0 (response_code 500)",
      "broker-bad-response: no sync_status",
      "broker-io: connection reset",
      "file-not-found",
      "file-denied",
      "file-io: No space left on device (os error 28)",
      "file-bad-extension: json, md",
      "png-encode",
      "canvas-unavailable",
      "midi-port-not-found",
      "midi-output-not-open",
      "midi-init-failed: MIDI support not compiled in",
      "midi-open-failed: port disconnected",
      "midi-send-failed: port disconnected",
      "keep-awake-failed: IOPMAssertionCreateWithName 1",
      "keep-awake-unsupported",
    ];
    for (const lang of ["en", "ja"] as const) {
      setLang(lang);
      for (const message of messages) expect(errorText(new Error(message)), `${lang} ${message}`).not.toBe(message);
    }
    // The list above is the inventory: a code added to the table but left out of it
    // would go untested, and an entry no code reaches is text nobody can ever see.
    expect(messages.map((m) => m.split(": ")[0]).sort()).toEqual(Object.keys(SHELL_CODES).sort());
    expect(Object.values(SHELL_CODES).sort()).toEqual(Object.keys(en.error.shell).sort());
  });
});
