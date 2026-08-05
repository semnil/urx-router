// The link ledger's face: a row of counts at the right end of the status bar, and
// the full ledger on click. Experimental builds only — the counters are collected
// and logged in every desktop build, but reading them on screen is a diagnostic.
//
// Deliberately quiet. The status bar is one line shared with the message text, and
// the app already spends its accent on the LED amber, so nothing here introduces a
// colour: dim labels, `--text` figures, hairline dividers of the same `--line` the
// toolbar separators use. The one thing allowed to change colour is the no-answer
// cell, because a broker that stopped answering is the only state here that asks for
// something to be done about it.
//
// Every printed figure is a monotonic count, so nothing moves fast enough to make the
// row flicker; the poll is 1 Hz for that reason and not for cost.

import { onLangChange, t } from "../i18n";
import {
  BROKER_STALL_LIMIT,
  LINK_BAR_KEYS,
  LINK_LEDGER_KEYS,
  ledgerValue,
  type LinkBarKey,
  type LinkLedger,
  type LinkLedgerKey,
} from "../core/control/link-stats";
import { copyText, el, popLeft, popTop, wireDismiss } from "./dom";

/** How often the readout re-reads the ledger while a session is up. One second,
 *  because the uptime is a clock — and the reading is a mutex plus eight atomic loads,
 *  so the cost that was worth removing was the repaint, not the round trip. */
const POLL_MS = 1000;

/** Between the two halves of a breakdown. Punctuation, not wording — it is here
 *  rather than in the message catalog because nothing about it is translatable, and
 *  a catalog entry made entirely of its arguments is one nothing can check. */
const DOT = " · ";

export interface LinkStatsViewHooks {
  /** Take a fresh reading (the tracker's `read`). */
  read: () => Promise<LinkLedger>;
  /** Where the log was last written, or null before the first line landed. */
  logPath: () => string | null;
  /** Report a copy having landed, on the status line. */
  onCopied: (message: string) => void;
}

/** One cell of the bar, held rather than queried: the constructor made these spans and
 *  is the only thing that can. Querying them back by the class it just assigned is how
 *  a rename becomes a silent no-op instead of a compile error. */
interface BarCell {
  key: LinkBarKey;
  cell: HTMLElement;
  lbl: HTMLElement;
  num: HTMLElement;
}

/** One row of the panel, on the same footing. */
interface LedgerRow {
  key: LinkLedgerKey;
  k: HTMLElement;
  v: HTMLElement;
}

/** A row as it is printed, in both places it is printed: the panel builds spans from
 *  this and the clipboard joins strings from it. One derivation, because a row whose
 *  panel form and copied form could differ is a report that does not match the screen
 *  it was taken from. */
interface RowParts {
  label: string;
  figure: string;
  detail: string;
}

/**
 * The status bar's link readout. `setSession(true)` starts the poll and shows the
 * row; `setSession(false)` hides it and stops. Constructing it does neither, so a
 * build that never turns it on costs one hidden element.
 */
export class LinkStatsView {
  private readonly bar: BarCell[] = [];
  private readonly button: HTMLButtonElement;
  private pop: HTMLElement | null = null;
  private rows: LedgerRow[] = [];
  private readonly dismiss = wireDismiss({
    keep: (target) => this.pop?.contains(target) === true || this.button.contains(target),
    close: () => this.closePop(),
  });
  private timer: number | null = null;
  private ledger: LinkLedger | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly hooks: LinkStatsViewHooks,
  ) {
    this.button = el("button", "linkbar-open") as HTMLButtonElement;
    this.button.type = "button";
    this.button.setAttribute("aria-haspopup", "dialog");
    this.button.setAttribute("aria-expanded", "false");
    for (const key of LINK_BAR_KEYS) {
      const cell = el("span", "linkbar-cell");
      cell.dataset.linkCell = key;
      // Label before figure, as the panel's rows read: a bare `2:14:06` at the end of
      // the bar reads as a wall clock, and `0 no answer` reads as neither prose nor a
      // reading. Both cells are labelled, and with the panel's own word for the row.
      const lbl = el("span", "linkbar-lbl");
      lbl.dataset.linkLabel = key;
      const num = el("span", "linkbar-num");
      cell.append(lbl, num);
      this.bar.push({ key, cell, lbl, num });
      this.button.append(cell);
    }
    this.button.addEventListener("click", () => (this.pop ? this.closePop() : this.openPop()));
    this.host.append(this.button);
    this.host.hidden = true;
    this.applyLabels();
    // The panel outlives any one render, so it re-labels itself rather than being
    // rebuilt by whatever redraws the rest of the bar. Labels only — the figures are
    // the poll's business, and the two are separated so neither has to run for the
    // other's sake.
    onLangChange(() => this.applyLabels());
  }

  /** Bring the readout up or take it down with the session. */
  setSession(on: boolean): void {
    this.host.hidden = !on;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!on) {
      this.closePop();
      return;
    }
    void this.refresh();
    this.timer = window.setInterval(() => void this.refresh(), POLL_MS);
  }

  private async refresh(): Promise<void> {
    // Nothing to show while the window is hidden, and the counters are cumulative — the
    // next visible tick is as good a reading as every tick in between would have been.
    if (document.hidden) return;
    const l = await this.hooks.read();
    this.ledger = l;
    for (const c of this.bar) {
      setTextIfChanged(c.num, ledgerValue(c.key, l));
      // The only state on this row that asks for a decision.
      if (c.key === "noanswer") c.cell.classList.toggle("warn", l.deadlines > 0);
    }
    this.fillPop(l);
  }

  // The bar borrows the panel's row labels rather than keeping a shorter set of its
  // own. A second vocabulary is what made the old bar unreadable: it said `cmd` where
  // the panel said `Sent`, and nothing on either surface said they were one number.
  private applyLabels(): void {
    const s = t().linkStats;
    for (const c of this.bar) c.lbl.textContent = s.row[c.key];
    this.button.title = s.title;
    if (!this.pop) return;
    this.pop.setAttribute("aria-label", s.title);
    setTextIfChanged(this.pop.querySelector("h4"), s.title);
    setTextIfChanged(this.pop.querySelector(".linkbar-copy"), s.copy);
    for (const r of this.rows) r.k.textContent = s.row[r.key];
    if (this.ledger) this.fillPop(this.ledger);
  }

  private openPop(): void {
    if (this.pop) return;
    const pop = el("div", "linkbar-pop");
    pop.setAttribute("role", "dialog");
    const table = el("table", "");
    this.rows = LINK_LEDGER_KEYS.map((key) => {
      const row = el("tr", "");
      row.dataset.ledgerRow = key;
      const k = el("td", "k");
      const v = el("td", "v");
      row.append(k, v);
      table.append(row);
      return { key, k, v };
    });
    const copy = el("button", "prefs-btn linkbar-copy") as HTMLButtonElement;
    copy.type = "button";
    copy.dataset.ledgerCopy = "";
    copy.addEventListener("click", () => void this.copy());
    pop.append(el("h4", ""), table, copy);
    document.body.append(pop);
    this.pop = pop;
    this.applyLabels();
    const anchor = this.button.getBoundingClientRect();
    // The bar sits at the bottom of the window, so the flip always resolves upward; the
    // shared helpers are used anyway so the placement rules stay in one place.
    pop.style.top = `${popTop(anchor, pop.offsetHeight, 8)}px`;
    pop.style.left = `${popLeft(anchor.right - pop.offsetWidth, pop.offsetWidth)}px`;
    this.button.setAttribute("aria-expanded", "true");
    this.dismiss.attach();
  }

  private closePop(): void {
    if (!this.pop) return;
    this.dismiss.detach();
    this.pop.remove();
    this.pop = null;
    this.rows = [];
    this.button.setAttribute("aria-expanded", "false");
  }

  /** The panel's VALUE cells. Its labels belong to `applyLabels`, so a poll that runs
   *  once a second is not also rewriting words that change once a language switch. */
  private fillPop(l: LinkLedger): void {
    for (const r of this.rows) {
      const { figure, detail } = this.partsOf(r.key, l);
      r.v.textContent = "";
      if (figure) {
        const num = el("span", "linkbar-num");
        num.textContent = figure;
        r.v.append(num);
      }
      if (detail) {
        const sub = el("span", "linkbar-sub");
        sub.textContent = detail;
        r.v.append(sub);
      }
    }
  }

  // What a row prints. The figure comes from `core/`; the breakdown is built here
  // because every part of it is a word. No `default` arm, deliberately: a new
  // LinkLedgerKey has to be answered rather than silently printing no breakdown, the
  // same contract `ledgerValue` holds on the other half of the row.
  private partsOf(key: LinkLedgerKey, l: LinkLedger): RowParts {
    const s = t().linkStats;
    const parts = { label: s.row[key], figure: ledgerValue(key, l) };
    switch (key) {
      case "sent":
        return { ...parts, detail: `${l.sets} ${s.set}${DOT}${l.gets} ${s.get}` };
      case "subscriptions":
        return { ...parts, detail: `${l.paramSubscribes} ${s.params}${DOT}${l.meterSubscribes} ${s.meters}` };
      case "frames":
        return { ...parts, detail: `${l.registFrames} ${s.regist}${DOT}${l.unregistFrames} ${s.unregist}` };
      case "noanswer":
        return { ...parts, detail: s.stall(l.stalled, BROKER_STALL_LIMIT) };
      case "log":
        return { ...parts, detail: this.hooks.logPath() ?? s.noLog };
      case "up":
      case "reads":
        return { ...parts, detail: "" };
    }
  }

  /** The ledger as the panel shows it, for pasting into a report. */
  private async copy(): Promise<void> {
    const l = this.ledger;
    if (!l) return;
    const s = t().linkStats;
    const lines = LINK_LEDGER_KEYS.map((key) => {
      const { label, figure, detail } = this.partsOf(key, l);
      return `${label}: ${[figure, detail].filter(Boolean).join(" ")}`;
    });
    // Salvage rather than abort: a clipboard the OS refused is not a device failure,
    // and the text is on screen either way.
    this.hooks.onCopied((await copyText(lines.join("\n"))) ? s.copied : s.copyFailed);
  }
}

/** Assign only when the text actually differs, so a 1 Hz repaint of a figure that has
 *  not moved costs nothing. */
function setTextIfChanged(node: HTMLElement | null, text: string): void {
  if (node && node.textContent !== text) node.textContent = text;
}
