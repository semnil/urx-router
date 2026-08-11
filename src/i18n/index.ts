// Minimal, dependency-free i18n. English is the base language; Japanese is the
// first supported translation. The active language persists to localStorage and
// registered listeners re-render when it changes. Only browser-side modules
// import this; core/* stays language-agnostic by returning message codes.

import { en } from "./en";
import type { Messages } from "./en";
import { ja } from "./ja";

export type Lang = "en" | "ja";

export const LANGS: Lang[] = ["en", "ja"];

// Native names, identical in every catalog, so they live here rather than in the
// translated messages.
export const LANG_NAMES: Record<Lang, string> = { en: "English", ja: "日本語" };

const CATALOGS: Record<Lang, Messages> = { en, ja };

const STORAGE_KEY = "urx-lang";

function detectInitial(): Lang {
  // Guard storage access like every other localStorage reader in the app: a
  // throwing localStorage (private mode / disabled / sandboxed iframe) must not
  // throw out of module init, or every UI module that imports i18n fails to load.
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "ja") return saved;
  } catch {
    // storage unavailable — fall back to the browser language
  }
  return navigator.language.toLowerCase().startsWith("ja") ? "ja" : "en";
}

let current: Lang = detectInitial();
document.documentElement.lang = current;

const listeners = new Set<() => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // storage unavailable — the choice just won't persist across reloads
  }
  document.documentElement.lang = lang;
  for (const fn of listeners) fn();
}

export function onLangChange(fn: () => void): void {
  listeners.add(fn);
}

/** Current message catalog. Usage: t().status.planSaved or t().status.loaded(id). */
export function t(): Messages {
  return CATALOGS[current];
}

/**
 * The stable error codes raised outside the UI layer, mapped to their catalog
 * entry. The Rust shell (file IO, the vd broker link, the MIDI bridge) and core's
 * export path return these instead of prose, so a failure never reaches a
 * localized dialog in English. Keep in step with the code lists in
 * `src-tauri/src/{lib,vd,midi,keepawake}.rs` and `core/storage.ts`.
 */
export const SHELL_CODES: Record<string, keyof Messages["error"]["shell"]> = {
  "broker-unreachable": "brokerUnreachable",
  "no-device": "noDevice",
  "control-worker-gone": "controlWorkerGone",
  "device-lost": "deviceLost",
  "broker-closed": "brokerClosed",
  "broker-no-vdpport": "brokerNoVdpPort",
  "not-connected": "notConnected",
  "broker-timeout": "brokerTimeout",
  "broker-unresponsive": "brokerUnresponsive",
  "broker-rejected": "brokerRejected",
  "broker-bad-response": "brokerBadResponse",
  "broker-io": "brokerIo",
  "file-not-found": "fileNotFound",
  "file-denied": "fileDenied",
  "file-io": "fileIo",
  "file-bad-extension": "fileBadExtension",
  "png-encode": "pngEncode",
  "canvas-unavailable": "canvasUnavailable",
  "midi-port-not-found": "midiPortNotFound",
  "midi-output-not-open": "midiOutputNotOpen",
  "midi-init-failed": "midiInitFailed",
  "midi-open-failed": "midiOpenFailed",
  "midi-send-failed": "midiSendFailed",
  "keep-awake-failed": "keepAwakeFailed",
  "keep-awake-unsupported": "keepAwakeUnsupported",
};

/** Split an error into its stable code and technical detail. A message is either a
 *  bare code or `"<code>: <detail>"`; anything else yields no code, and the whole
 *  message is the caller's to pass through.
 *
 *  A rejection is not necessarily an Error, and `String()` on an object with no
 *  prototype — or one whose conversion throws for any other reason — throws rather
 *  than describing it. This runs on the path that REPORTS a failure, so a throw
 *  here loses the failure it was called to describe: the reporter's own rejection
 *  replaces it, with nothing left to catch either one. Nothing to say is answered
 *  as nothing, and the caller decides what an empty description is worth. */
function split(err: unknown): { message: string; code: string; detail: string } {
  let message: string;
  try {
    // All three hazards are inside the one try, because all three are reachable:
    // `instanceof` runs the target's [[GetPrototypeOf]], which a Proxy trap can
    // throw from; `.message` can be a getter that throws; and a message that is not
    // a string has no `.indexOf` for the split below. `String()` covers the last —
    // including a symbol, which it converts rather than refusing.
    message = String(err instanceof Error ? err.message : err);
  } catch {
    message = "";
  }
  const sep = message.indexOf(": ");
  if (sep === -1) return { message, code: message, detail: "" };
  return { message, code: message.slice(0, sep), detail: message.slice(sep + 2) };
}

/** The stable code an error carries, for a caller that branches on it rather than
 *  showing it (see connectFailureStatus / midiErrorStatus). Empty-ish for anything
 *  that is not a code, which matches no branch. */
export function errorCode(err: unknown): string {
  return split(err).code;
}

/**
 * Localized text for an error raised outside the UI layer. The detail is the
 * technical part only an English source can supply (an OS message, a parameter
 * address, a broker URI) — entries that take one show it in parentheses, the rest
 * drop it. Anything that is not a known code (a plain JS error, a DOMException)
 * falls through unchanged: the caller's frame is still localized, and an unexpected
 * failure is never swallowed.
 */
export function errorText(err: unknown): string {
  const { message, code, detail } = split(err);
  const key = SHELL_CODES[code];
  if (!key) return message;
  const entry = t().error.shell[key];
  if (typeof entry !== "function") return entry;
  // A code whose entry takes a detail is always raised with one, so a bare one here
  // is a malformed message: let it through like any unrecognized message rather
  // than render the entry around an empty detail.
  return detail ? entry(detail) : message;
}
