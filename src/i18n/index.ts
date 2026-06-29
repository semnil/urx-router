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

// Short codes shown on the compact language button — also language-invariant, so
// they live here alongside the names rather than copied into each catalog.
export const LANG_CODES: Record<Lang, string> = { en: "EN", ja: "JA" };

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
