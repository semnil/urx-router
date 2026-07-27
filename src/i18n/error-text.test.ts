// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { errorText, SHELL_CODES, setLang } from "./index";
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
      "not-connected",
      "broker-timeout: value at 766:0:0",
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
