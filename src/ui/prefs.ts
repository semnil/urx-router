// Preferences modal (the toolbar gear): every user preference in one place,
// applied immediately on change (no OK/cancel — matching how the toolbar
// toggles already behave) and persisted via core/settings. Language and theme
// are the exception: they keep their own stores (`urx-lang` in i18n, `urx-theme`
// in the shell), read before settings load so the first paint is already right.
// The content is rebuilt on every open and on refresh(), so it always reflects
// the current language, the live-sync lock, and the stored values. Rows that
// need the desktop shell (device scope, updates, firmware warning, recent
// plans) render disabled with a "Desktop app only" tag elsewhere, per build:
//   browser (E2E)  — device / update / firmware / recent rows locked
//   demo (Pages)   — those plus the export rows (the demo has no export)

import { version } from "../../package.json";
import { el, settingsChoice, settingsNote, settingsRow, settingsSection, settingsSelect, wireDismiss } from "./dom";
import { getLang, LANG_NAMES, LANGS, setLang, t } from "../i18n";
import {
  EXPORT_SCALE_CHOICES,
  getSettings,
  RECENT_MAX_CHOICES,
  updateSettings,
  WHEEL_STEP_CHOICES,
} from "../core/settings";
import type { AppSettings } from "../core/settings";
import { DEMO } from "../core/env";
import { isTauri } from "../core/platform";
import { resetFine } from "./fine";
import { trimRecent } from "../core/storage";
import type { RecentEntry } from "../core/storage";

/** Theme mode, mirroring the analyze tools: an explicit palette, or `auto` =
 *  follow the OS color scheme. The shell owns application and persistence
 *  (`localStorage("urx-theme")`); the modal only reads and picks the mode. */
export type ThemeMode = "light" | "dark" | "auto";

/** What a manual update check came to, for the inline note beside the version.
 *  "installing" is nominal only — an accepted update restarts the app. */
export type UpdateCheckOutcome =
  { kind: "upToDate" } | { kind: "failed" } | { kind: "declined"; version: string } | { kind: "installing" };

export interface PrefsHooks {
  /** Live sync is up: the device scope is part of the held session (snapshot +
   *  notify registration), so its control locks until the session ends. */
  isLive: () => boolean;
  /** The recent-plans store changed (trim / clear); the shell re-renders. */
  onRecentChanged: (list: RecentEntry[]) => void;
  /** A warning-visibility toggle changed; the shell re-renders the warning cards. */
  onWarningsChanged: () => void;
  /** The fine-tuning entry style changed; the shell rebuilds both views so the
   *  FINE tag hints name the new style. */
  onFineChanged: () => void;
  /** Manual update check. The modal stays open and the resolved outcome lands
   *  on the inline note; an accepted update closes the modal on the shell side
   *  before the download status takes over. */
  checkUpdates: () => Promise<UpdateCheckOutcome>;
  /** --experimental launch: the scope note also names the diagnostics' coverage. */
  isExperimental: () => boolean;
  /** Current theme mode, read on every render. */
  themeMode: () => ThemeMode;
  /** A theme mode was picked; the shell resolves, applies and persists it. */
  onThemeMode: (mode: ThemeMode) => void;
}

export class PrefsPanel {
  private readonly scrim: HTMLElement;
  private readonly box: HTMLElement;
  // While a manual update check is in flight, every dismissal path locks (the
  // Close button disables, outside press and Escape are ignored): the outcome
  // has nowhere to land once the modal is gone, and the same lock is what makes
  // a second press impossible. Bounded by the check's 10 s timeout.
  private checking = false;
  // Outside press / Escape dismissal (the MIDI panel's idiom — every setting
  // applies immediately, so leaving this way loses nothing). `keep`: only a
  // press that starts on the scrim itself dismisses, so a drag that starts
  // inside the box and ends on the scrim must not close.
  private readonly dismiss = wireDismiss({
    keep: (target) => target !== this.scrim,
    close: () => this.requestClose(),
  });

  constructor(private readonly hooks: PrefsHooks) {
    this.scrim = document.getElementById("prefs-modal") as HTMLElement;
    this.box = document.getElementById("prefs-box") as HTMLElement;
  }

  open(): void {
    this.render();
    this.scrim.hidden = false;
    this.dismiss.attach();
    // preventScroll: the grid is the scrolling region (render() starts it at the
    // top); focusing the fixed Close action must not scroll anything into view.
    this.box.querySelector<HTMLButtonElement>(".consent-btn-primary")?.focus({ preventScroll: true });
  }

  /** The one user-facing close: every dismissal path (Close button, outside
   *  press, Escape) funnels here so the in-flight lock is a single check.
   *  `close` stays raw for the shell (an accepted update closes mid-check). */
  requestClose(): void {
    if (!this.checking) this.close();
  }

  close(): void {
    this.dismiss.detach();
    this.scrim.hidden = true;
  }

  isOpen(): boolean {
    return !this.scrim.hidden;
  }

  /** Re-render in place (a setting or the live-sync lock changed while open).
   *  Deferred while a check is in flight — a rebuild would lift the dismissal
   *  lock and detach the row the outcome lands on. */
  refresh(): void {
    if (this.isOpen() && !this.checking) this.render();
  }

  private render(): void {
    const m = t().prefs;
    const s = getSettings();
    const desktop = isTauri();
    this.box.replaceChildren();

    const title = el("h2", "");
    title.id = "prefs-title";
    title.textContent = m.title;

    // Left column: language & theme (moved off the toolbar), the two scope
    // settings, and the warnings.
    const left = el("div", "prefs-col");
    {
      const sec = this.section(m.uiSection);
      // Language: a dropdown over the registry (ready for more languages),
      // labelled with native names so the row is readable whichever language is
      // active. setLang() notifies the shell, whose listener re-renders this
      // modal in the new language.
      const langSel = this.select(LANGS, getLang(), (v) => LANG_NAMES[v], setLang);
      langSel.id = "prefs-lang";
      // Theme mode: same choice order as the export background below. No local
      // refresh — the select already shows the pick, and the modal is
      // CSS-variable themed, so the palette flip restyles it without DOM work.
      const themeSel = this.select(
        ["auto", "dark", "light"] as const,
        this.hooks.themeMode(),
        (v) => (v === "auto" ? m.themeAuto : v === "dark" ? m.themeDark : m.themeLight),
        (v) => this.hooks.onThemeMode(v),
      );
      themeSel.id = "prefs-theme";
      sec.append(this.row(m.language, langSel), this.row(m.theme, themeSel), this.note(m.uiNote));
      left.append(sec);
    }
    {
      const sec = this.section(m.deviceSection);
      const locked = !desktop || this.hooks.isLive();
      const scopeToggle = this.choice(m.scopeAll, m.scopeScene, s.deviceScope === "all", (all) =>
        this.apply({ deviceScope: all ? "all" : "scene" }),
      );
      scopeToggle.id = "prefs-device-scope";
      sec.append(
        this.row(m.scope, scopeToggle, locked, !desktop),
        this.note(m.deviceNote),
        this.note(this.hooks.isExperimental() ? `${m.sceneNote} ${m.diagNote}` : m.sceneNote),
      );
      left.append(sec);
    }
    {
      const sec = this.section(m.planSection);
      const saveToggle = this.choice(m.planFull, m.scopeScene, s.saveScope === "full", (full) =>
        this.apply({ saveScope: full ? "full" : "scene" }),
      );
      saveToggle.id = "prefs-save-scope";
      // The share URL exists only in the demo build; the desktop note sticks to
      // the file-save semantics.
      sec.append(this.row(m.saveScope, saveToggle), this.note(DEMO ? `${m.planNoteShare} ${m.planNote}` : m.planNote));
      left.append(sec);
    }
    {
      const sec = this.section(m.warnSection);
      sec.append(
        this.row(
          m.warnFirmware,
          this.onOff(s.warnFirmware, (on) => this.apply({ warnFirmware: on })),
          !desktop,
        ),
        this.row(
          m.warnRate,
          this.onOff(s.warnRate, (on) => {
            this.apply({ warnRate: on });
            this.hooks.onWarningsChanged();
          }),
        ),
        this.row(
          m.warnDucker,
          this.onOff(s.warnDucker, (on) => {
            this.apply({ warnDucker: on });
            this.hooks.onWarningsChanged();
          }),
        ),
        this.note(m.warnNote),
      );
      left.append(sec);
    }

    // Right column: controls, files & export, and — last, as the one section
    // that is information rather than a preference — the version block.
    const right = el("div", "prefs-col");
    {
      const sec = this.section(m.controlsSection);
      const fineToggle = this.choice(m.fineHold, m.fineLatch, !s.fineLatch, (hold) => {
        this.apply({ fineLatch: !hold });
        // Leaving either style mid-mode would strand it under the other style's
        // exit rules; start the new style from coarse.
        resetFine();
        this.hooks.onFineChanged();
      });
      fineToggle.id = "prefs-fine";
      const wheelSel = this.select(WHEEL_STEP_CHOICES, s.wheelSteps, m.wheelOption, (v) =>
        this.apply({ wheelSteps: v }),
      );
      wheelSel.id = "prefs-wheel";
      sec.append(this.row(m.wheel, wheelSel), this.row(m.fine, fineToggle), this.note(m.controlsNote));
      right.append(sec);
    }
    {
      const sec = this.section(m.filesSection);
      sec.append(
        this.row(
          m.exportScale,
          this.select(
            EXPORT_SCALE_CHOICES,
            s.exportScale,
            (v) => `${v}×`,
            (v) => this.apply({ exportScale: v }),
          ),
          DEMO,
        ),
        this.note(m.exportNote),
        this.row(
          m.exportBg,
          this.select(
            ["active", "dark", "light"] as const,
            s.exportTheme,
            (v) => (v === "active" ? m.exportBgActive : v === "dark" ? m.exportBgDark : m.exportBgLight),
            (v) => this.apply({ exportTheme: v }),
          ),
          DEMO,
        ),
      );
      const recentCtl = el("div", "ctl");
      recentCtl.append(
        this.select(
          RECENT_MAX_CHOICES,
          s.recentMax,
          (v) => String(v),
          (v) => {
            this.apply({ recentMax: v });
            this.hooks.onRecentChanged(trimRecent(v));
          },
        ),
        this.button(m.clearRecent, () => this.hooks.onRecentChanged(trimRecent(0))),
      );
      sec.append(this.row(m.recent, recentCtl, !desktop));
      right.append(sec);
    }
    {
      const sec = this.section(m.versionSection);
      sec.append(
        this.row(
          m.updateLaunch,
          this.onOff(s.updateCheck, (on) => this.apply({ updateCheck: on })),
          !desktop,
        ),
      );
      const ver = el("span", "prefs-ver");
      ver.id = "prefs-version";
      ver.textContent = `URX Router ${version}`;
      const verRow = el("div", "prefs-row");
      if (desktop) {
        const wrap = el("span", "lblc");
        const note = el("span", "prefs-update-note");
        note.id = "prefs-update-note";
        wrap.append(ver, note);
        const check = this.button(m.updateNow, () => void this.runUpdateCheck(check, note));
        check.id = "prefs-update-now";
        verRow.append(wrap, check);
      } else {
        verRow.append(ver);
      }
      sec.append(verRow);
      right.append(sec);
    }

    const grid = el("div", "prefs-grid");
    grid.append(left, right);

    const actions = el("div", "consent-actions");
    const close = el("button", "consent-btn-primary") as HTMLButtonElement;
    close.type = "button";
    close.textContent = m.close;
    close.addEventListener("click", () => this.requestClose());
    actions.append(close);

    this.box.append(title, grid, actions);
  }

  // Manual update check, reported inline beside the version — the modal stays
  // open, so a "no update" answer is seen where it was asked for instead of on
  // a status line hidden behind the scrim. Only an accepted update leaves the
  // modal (the shell closes it before the download status takes over).
  private async runUpdateCheck(check: HTMLButtonElement, note: HTMLElement): Promise<void> {
    const m = t().prefs;
    // The Close button's disabled face makes the requestClose lock visible;
    // refresh() is deferred while checking, so the node cannot be swapped
    // out from under the flight.
    const closeBtn = this.box.querySelector<HTMLButtonElement>(".consent-btn-primary")!;
    this.checking = true;
    closeBtn.disabled = true;
    check.disabled = true;
    note.classList.remove("warn");
    note.textContent = m.checking;
    // The hook resolves with an outcome for every expected path; a rejection
    // (an unexpected throw) must still land on a defined state — never leave
    // the row stuck on "Checking…" with a dead button.
    let outcome: UpdateCheckOutcome;
    try {
      outcome = await this.hooks.checkUpdates();
    } catch {
      outcome = { kind: "failed" };
    } finally {
      this.checking = false;
      closeBtn.disabled = false;
    }
    // The accepted-update path closes the modal mid-flight (the shell calls
    // `close` before the download); a reopen there rebuilds the box and
    // detaches these elements, and the fresh render starts the row clean, so
    // a stale report has no home.
    if (!note.isConnected) return;
    check.disabled = false;
    if (outcome.kind === "upToDate") {
      note.textContent = m.upToDate;
    } else if (outcome.kind === "declined") {
      note.textContent = m.updateAvailable(outcome.version);
    } else if (outcome.kind === "failed") {
      note.classList.add("warn");
      note.textContent = m.updateCheckFailed;
    } else {
      note.textContent = "";
    }
  }

  private apply(patch: Partial<AppSettings>): void {
    updateSettings(patch);
    this.refresh();
  }

  private section(titleText: string): HTMLElement {
    return settingsSection(titleText);
  }

  // `locked` disables the control (not applicable in this build / state); `tag` adds
  // the dashed "Desktop app only" pill and defaults to the lock, since a locked row
  // is desktop-gated at every site except the device scope (which also locks while
  // live, without the tag).
  private row(labelText: string, control: HTMLElement, locked = false, tag = locked): HTMLElement {
    return settingsRow(labelText, control, { locked, tag: tag ? t().prefs.desktopOnly : undefined });
  }

  private note(text: string): HTMLElement {
    return settingsNote(text);
  }

  // Two-value toggle in the inspector's two-button idiom; the active face lights.
  private choice(aLabel: string, bLabel: string, aActive: boolean, pick: (a: boolean) => void): HTMLElement {
    return settingsChoice([aLabel, bLabel], aActive ? 0 : 1, (i) => pick(i === 0));
  }

  private onOff(on: boolean, apply: (on: boolean) => void): HTMLElement {
    // ON/OFF faces reuse the inspector's strings (cross-namespace reads are the
    // established pattern — console.ts and fine.ts read t().inspector.* too).
    const wrap = this.choice(t().inspector.on, t().inspector.off, on, apply);
    wrap.classList.add("narrow");
    return wrap;
  }

  private select<T extends string | number>(
    choices: readonly T[],
    current: T,
    label: (v: T) => string,
    apply: (v: T) => void,
  ): HTMLSelectElement {
    return settingsSelect(choices, current, label, apply);
  }

  private button(labelText: string, onClick: () => void): HTMLButtonElement {
    const b = el("button", "prefs-btn") as HTMLButtonElement;
    b.type = "button";
    b.textContent = labelText;
    b.addEventListener("click", onClick);
    return b;
  }
}
