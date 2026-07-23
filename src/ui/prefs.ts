// Preferences modal (the toolbar gear): every user preference in one place,
// applied immediately on change (no OK/cancel — matching how the toolbar
// toggles already behave) and persisted via core/settings. The content is
// rebuilt on every open and on refresh(), so it always reflects the current
// language, the live-sync lock, and the stored values. Rows that need the
// desktop shell (device scope, updates, firmware warning, recent plans) render
// disabled with a "Desktop app only" tag elsewhere, per build:
//   browser (E2E)  — device / update / firmware / recent rows locked
//   demo (Pages)   — those plus the export rows (the demo has no export)

import { version } from "../../package.json";
import { el } from "./dom";
import { t } from "../i18n";
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
  /** Manual update check. The shell closes the modal first so the outcome
   *  (status line or update dialog) is not hidden behind the scrim. */
  onCheckUpdates: () => void;
  /** --experimental launch: the scope note also names the diagnostics' coverage. */
  isExperimental: () => boolean;
}

export class PrefsPanel {
  private readonly scrim: HTMLElement;
  private readonly box: HTMLElement;

  constructor(private readonly hooks: PrefsHooks) {
    this.scrim = document.getElementById("prefs-modal") as HTMLElement;
    this.box = document.getElementById("prefs-box") as HTMLElement;
  }

  open(): void {
    this.render();
    this.scrim.hidden = false;
    // preventScroll: at a shrunken window height the box scrolls, and focusing
    // the (bottom) Close action would open the modal scrolled to its end.
    this.box.scrollTop = 0;
    this.box.querySelector<HTMLButtonElement>(".consent-btn-primary")?.focus({ preventScroll: true });
  }

  close(): void {
    this.scrim.hidden = true;
  }

  isOpen(): boolean {
    return !this.scrim.hidden;
  }

  /** Re-render in place (a setting or the live-sync lock changed while open). */
  refresh(): void {
    if (this.isOpen()) this.render();
  }

  private render(): void {
    const m = t().prefs;
    const s = getSettings();
    const desktop = isTauri();
    this.box.replaceChildren();

    const title = el("h2", "");
    title.id = "prefs-title";
    title.textContent = m.title;

    // Left column: the two scope settings and the version / update block.
    const left = el("div", "prefs-col");
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
      sec.append(this.row(m.saveScope, saveToggle), this.note(m.planNote));
      left.append(sec);
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
      verRow.append(ver);
      if (desktop) {
        const check = this.button(m.updateNow, () => this.hooks.onCheckUpdates());
        check.id = "prefs-update-now";
        verRow.append(check);
      }
      sec.append(verRow);
      left.append(sec);
    }

    // Right column: warnings, controls, files & export.
    const right = el("div", "prefs-col");
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
      right.append(sec);
    }
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

    const grid = el("div", "prefs-grid");
    grid.append(left, right);

    const actions = el("div", "consent-actions");
    const close = el("button", "consent-btn-primary") as HTMLButtonElement;
    close.type = "button";
    close.textContent = m.close;
    close.addEventListener("click", () => this.close());
    actions.append(close);

    this.box.append(title, grid, actions);
  }

  private apply(patch: Partial<AppSettings>): void {
    updateSettings(patch);
    this.refresh();
  }

  private section(titleText: string): HTMLElement {
    const sec = el("section", "prefs-section");
    const h = el("h3", "");
    h.textContent = titleText;
    sec.append(h);
    return sec;
  }

  // A label + control row. `locked` disables the control (not applicable in this
  // build / state); `tag` adds the dashed "Desktop app only" pill beside the
  // label and defaults to the lock, since a locked row is desktop-gated at every
  // site except the device scope (which also locks while live, without the tag).
  private row(labelText: string, control: HTMLElement, locked = false, tag = locked): HTMLElement {
    const row = el("div", "prefs-row");
    const lblc = el("span", "lblc");
    const lbl = el("span", "lbl");
    lbl.textContent = labelText;
    lblc.append(lbl);
    if (tag) {
      const pill = el("span", "prefs-lock");
      pill.textContent = t().prefs.desktopOnly;
      lblc.append(pill);
    }
    row.append(lblc, control);
    if (locked) {
      row.classList.add("locked");
      for (const c of row.querySelectorAll<HTMLButtonElement | HTMLSelectElement>("button, select")) c.disabled = true;
    }
    return row;
  }

  private note(text: string): HTMLElement {
    const p = el("p", "prefs-note");
    p.textContent = text;
    return p;
  }

  // Two-value toggle in the inspector's two-button idiom; the active face lights.
  private choice(aLabel: string, bLabel: string, aActive: boolean, pick: (a: boolean) => void): HTMLElement {
    const wrap = el("div", "prefs-toggle");
    const mk = (label: string, active: boolean, isA: boolean): HTMLButtonElement => {
      const b = el("button", active ? "on" : "") as HTMLButtonElement;
      b.type = "button";
      b.textContent = label;
      b.setAttribute("aria-pressed", String(active));
      b.addEventListener("click", () => {
        if (!active) pick(isA);
      });
      return b;
    };
    wrap.append(mk(aLabel, aActive, true), mk(bLabel, !aActive, false));
    return wrap;
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
    const sel = el("select", "prefs-select") as HTMLSelectElement;
    for (const v of choices) {
      const opt = document.createElement("option");
      opt.value = String(v);
      opt.textContent = label(v);
      sel.append(opt);
    }
    sel.value = String(current);
    sel.addEventListener("change", () => {
      const v = choices.find((c) => String(c) === sel.value);
      if (v !== undefined) apply(v);
    });
    return sel;
  }

  private button(labelText: string, onClick: () => void): HTMLButtonElement {
    const b = el("button", "prefs-btn") as HTMLButtonElement;
    b.type = "button";
    b.textContent = labelText;
    b.addEventListener("click", onClick);
    return b;
  }
}
