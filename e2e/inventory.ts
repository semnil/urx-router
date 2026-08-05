// Display-item inventory: what a dialog or a window is supposed to PRINT, taken
// from the message catalog rather than from a hand-written list.
//
// The class of defect this exists for is an item that used to be on screen and
// silently stopped being there — a card dropped along with the panel it lived on,
// a row lost in a re-layout. Assertions written per item do not catch it, because
// the item nobody asserted is exactly the one nobody notices; and a hand-written
// expected list does not either, because the list is edited by the same change
// that drops the item.
//
// So the expected set is derived: every string the catalog holds under a
// surface's namespace must appear in that surface's rendered DOM. Adding a
// message makes some surface responsible for showing it, and the ledger in
// inventory.spec.ts refuses a key that no surface claims and no exception excuses.
//
// **It answers presence, not layout.** A collapsed, clipped or overlapped element
// whose text is still rendered passes here; measuring how something looks is
// `ui-capture`'s job, in either engine.
//
// A function leaf contributes its STATIC segments — the parts no argument can
// change — so an interpolated message is checked for the wording around the value.

import type { Page } from "@playwright/test";
import { en } from "../src/i18n/en";

/** One catalog entry: its dotted key, and the fragments its rendering must contain. */
export interface Item {
  key: string;
  texts: string[];
  /** A function leaf: its `texts` are fragments of one rendered run, never the
   *  whole of it, so it is matched by containment rather than by equality. */
  interpolated: boolean;
}

// Stands in for a message's arguments while its static wording is extracted. A
// private-use code point: it cannot occur in a translated string, so splitting on
// it cannot cut a message in half.
const ARG = "\uE000";

/** Segments of an interpolated message that no argument can change. Short ones
 *  ("…", " to ") are dropped — they match anything and would assert nothing.
 *
 *  A message that BRANCHES on its argument (a plural, "1 crate" vs "3 crates")
 *  yields the branch a non-numeric sentinel selects, i.e. the plural one — so the
 *  surface has to be driven into that branch for the check to mean anything. The
 *  singular wording of such a message is not covered here. */
function staticSegments(key: string, fn: (...args: string[]) => string): string[] {
  const filled = fn(...(Array(fn.length).fill(ARG) as string[]));
  const segments = filled
    .split(ARG)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
  // Nothing left to look for, and `[].every()` is true — the item would report
  // itself covered without a check ever running, which is this file's own thesis
  // reappearing inside the mechanism. Refuse it here so it has to be named.
  if (segments.length === 0) throw new Error(`inventory: "${key}" has no wording an argument cannot change`);
  return segments;
}

function collect(node: unknown, path: string[], out: Item[]): void {
  const key = path.join(".");
  if (typeof node === "string") out.push({ key, texts: [node], interpolated: false });
  else if (typeof node === "function")
    out.push({ key, texts: staticSegments(key, node as (...a: string[]) => string), interpolated: true });
  else if (Array.isArray(node)) node.forEach((v, i) => collect(v, [...path, String(i)], out));
  else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) collect(v, [...path, k], out);
}

function at(root: string): unknown {
  return root.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], en);
}

/** Every leaf under the given dotted roots, in catalog order. */
export function itemsUnder(...roots: string[]): Item[] {
  const out: Item[] = [];
  for (const root of roots) {
    const node = at(root);
    if (node === undefined) throw new Error(`inventory: no such message root "${root}"`);
    collect(node, [root], out);
  }
  return out;
}

/** Every leaf the catalog holds, whichever namespace it is under. */
export const allItems = (): Item[] => itemsUnder(...Object.keys(en));

/** The named leaves, for a surface that shows a few strings from another namespace. */
export function itemsFor(...keys: string[]): Item[] {
  return keys.map((key) => {
    const node = at(key);
    if (node === undefined) throw new Error(`inventory: no such message "${key}"`);
    const out: Item[] = [];
    collect(node, [key], out);
    if (out.length !== 1) throw new Error(`inventory: "${key}" is a group, not a leaf`);
    return out[0];
  });
}

// One space for every run of whitespace, so a label broken across source lines and
// the same label written inline compare equal. NBSP counts as whitespace here — the
// layout may use one where the catalog has a plain space.
const flatten = (s: string): string => s.replace(/\s+/gu, " ").trim();

/** What a surface is showing, split by the channel it shows it through. */
interface Shown {
  /** One entry per visible element's own text, and per option of a visible select. */
  text: string[];
  /** One entry per label-carrying attribute of a visible element. */
  attrs: string[];
}

/**
 * What a container currently shows, as separate runs rather than one blob.
 *
 * Separate runs are what make a short label checkable: against a container's whole
 * text, "ON" is satisfied by four letters of "MIDI CONTROL" and "Copy" by a
 * sentence that happens to say "Copy the report below", so the item can no longer
 * fail. Against runs, a label has to BE somebody's label.
 *
 * Visibility is the point — an item still in the DOM behind `hidden`, inside a
 * closed `<details>` or under `display: none` is not being displayed, and the
 * bug this guards against leaves exactly that behind.
 */
async function shownParts(page: Page, selector: string): Promise<Shown> {
  return page.evaluate((sel) => {
    const ATTRS = ["title", "aria-label", "aria-description", "placeholder"];
    const text: string[] = [];
    const attrs: string[] = [];
    const visible = (e: Element): boolean => {
      if (e instanceof HTMLElement && e.hidden) return false;
      // checkVisibility covers the cases a computed-style read alone misses — a
      // collapsed <details>, a content-visibility subtree.
      return e.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
    };
    const walk = (parent: Element): void => {
      // An element's OWN text is one run: a label composed of several elements is
      // several runs, which is what keeps one element's wording from standing in
      // for another's.
      const own = Array.from(parent.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.nodeValue ?? "")
        .join("");
      if (own.trim()) text.push(own);
      for (const child of parent.children) {
        if (!visible(child)) continue;
        for (const a of ATTRS) {
          const v = child.getAttribute(a);
          if (v) attrs.push(v);
        }
        // A select's options carry text that is never laid out, so they have no
        // visibility of their own — the select's is what decides.
        if (child instanceof HTMLSelectElement) {
          for (const o of child.options) text.push(o.textContent ?? "");
          continue;
        }
        walk(child);
      }
    };
    for (const root of document.querySelectorAll(sel)) {
      if (!visible(root)) continue;
      for (const a of ATTRS) {
        const v = root.getAttribute(a);
        if (v) attrs.push(v);
      }
      walk(root);
    }
    return { text, attrs };
  }, selector);
}

export interface InventoryOptions {
  /**
   * Messages the app deliberately shows only through a label attribute.
   *
   * Everything else has to be in the rendered TEXT, because a hover-revealed
   * explanation is not a display — that is the decision the restored MIDI legend
   * was built on ("a hover-revealed card is an affordance nobody finds"), and
   * without the split this guard would pass a legend replaced by a tooltip.
   */
  viaAttribute?: readonly string[];
  /**
   * Messages rendered INSIDE a larger run — two notes joined into one paragraph,
   * a prefix in front of a value, a vocabulary composed into a label. They are
   * matched by containment; every other plain message must be a run of its own.
   */
  composed?: readonly string[];
}

/** Both lists name either a leaf or a whole group, so a vocabulary composed the
 *  same way everywhere is one entry rather than forty. */
const covers = (list: ReadonlySet<string>, key: string): boolean => {
  for (const entry of list) if (key === entry || key.startsWith(`${entry}.`)) return true;
  return false;
};

/**
 * The union of what a surface showed across the states it was driven through.
 * A surface is rarely one screenshot: a toggle prints one of two labels, a
 * model-gated row appears on one model only, an in-flight action renames its own
 * button. Each `take` adds what was on screen at that moment.
 */
export class Inventory {
  private readonly seen: Shown = { text: [], attrs: [] };
  private readonly viaAttribute: ReadonlySet<string>;
  private readonly composed: ReadonlySet<string>;

  constructor(
    private readonly expected: Item[],
    opts: InventoryOptions = {},
  ) {
    this.viaAttribute = new Set(opts.viaAttribute ?? []);
    this.composed = new Set(opts.composed ?? []);
  }

  /** Record everything the given container is showing right now. */
  async take(page: Page, selector: string): Promise<void> {
    const parts = await shownParts(page, selector);
    this.seen.text.push(...parts.text.map(flatten));
    this.seen.attrs.push(...parts.attrs.map(flatten));
  }

  private shows(item: Item): boolean {
    const runs = covers(this.viaAttribute, item.key) ? [...this.seen.text, ...this.seen.attrs] : this.seen.text;
    if (item.interpolated || covers(this.composed, item.key))
      return item.texts.every((t) => runs.some((run) => run.includes(flatten(t))));
    return runs.some((run) => run === flatten(item.texts[0]));
  }

  /** Expected items no `take` ever saw, as `key :: text` lines. */
  missing(): string[] {
    return this.expected
      .filter((item) => !this.shows(item))
      .map((i) => `${i.key} :: ${i.texts.join(" / ").slice(0, 80)}`);
  }

  /** Items claimed to be unshowable that the surface showed anyway — an excuse
   *  that has stopped being true, which no ledger over the catalog alone can see. */
  wronglyShown(excused: Item[]): string[] {
    return excused.filter((item) => this.shows(item)).map((i) => i.key);
  }
}
