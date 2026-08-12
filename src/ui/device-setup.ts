// Device setup modal (Device menu): the unit's SETUP > GENERAL settings, the ones
// no node on the graph and no strip on the console stands for.
//
// Unlike Preferences, which applies each change immediately to local storage, this
// screen is a batch: the shell reads the whole set from the device before opening,
// edits accumulate here, and "Apply to device" sends only the differences. Nothing
// reaches hardware until then, so a mis-click on a power-off timer or a menu
// language is undone by closing.
//
// Section and control names come from the unit's own menu and stay in English in
// both languages (the Japanese user guide keeps them in English too), so a row here
// reads as the row on the hardware. Rows for a page the selected model does not have
// render locked with a dashed model tag rather than disappearing — the same idiom
// Preferences uses for a desktop-only row.

import {
  el,
  holdAppInert,
  onOff,
  onWheelStep,
  settingsChoice,
  settingsNote,
  settingsRow,
  settingsSection,
  settingsSelect,
  wireDismiss,
} from "./dom";
import { t } from "../i18n";
import {
  AUTO_POWER_OFF_TIMES,
  BRIGHTNESS_MAX,
  BRIGHTNESS_MIN,
  DATE_FORMAT_LABELS,
  DEVICE_LANGUAGE_LABELS,
  HDMI_CHANNEL_LABELS,
  TIME_FORMAT_LABELS,
  UDK_BANKS,
  UDK_FUNCTIONS,
  UDK_KNOBS,
  USB_SUPPRESSION_LABELS,
  coerceDeviceSetup,
  defaultDeviceSetup,
  deviceSetupChanges,
  knobField,
  normalizeUdk,
  setupSupport,
  udkSlot,
} from "../core/control/device-setup";
import type { DeviceSetup, SetupField, SetupWrite, UdkAssignment } from "../core/control/device-setup";
import { TIME_ZONE_CITIES } from "../core/control/timezones";
import type { DeviceModel } from "../models/types";

/** What one diff pass answers: what to mark, what to count, what to send. */
interface SetupChanges {
  count: number;
  fields: ReadonlySet<SetupField>;
  writes: SetupWrite[];
}

export interface DeviceSetupHooks {
  /** The model the plan is on. Gates the HDMI and Date/Time rows. */
  model: () => DeviceModel;
  /** Send the differences. Resolves true when everything landed, false when the
   *  shell already reported a failure — the screen keeps the edits either way, so a
   *  failed apply can be retried against a fresh read. */
  apply: (writes: SetupWrite[], changed: number) => Promise<boolean>;
  /** Confirm discarding unapplied edits on close. */
  confirmDiscard: () => Promise<boolean>;
}

export class DeviceSetupPanel {
  private readonly scrim: HTMLElement;
  private readonly box: HTMLElement;
  /** What the device reported when the screen opened — the diff baseline. */
  private baseline: DeviceSetup = defaultDeviceSetup();
  /** What the screen currently shows. */
  private draft: DeviceSetup = defaultDeviceSetup();
  private bank = 0;
  /** Rows the pending diff says will be written; filled by each render pass. */
  private dirty: ReadonlySet<SetupField> = new Set();
  /** An apply or a discard confirm is in flight: every dismissal path waits. */
  private busy = false;
  private readonly dismiss = wireDismiss({
    keep: (target) => target !== this.scrim,
    inert: () => this.busy,
    close: () => void this.requestClose(),
  });
  /** Held while the modal is up; see holdAppInert. */
  private releaseInert: (() => void) | null = null;

  constructor(private readonly hooks: DeviceSetupHooks) {
    this.scrim = document.getElementById("device-setup-modal") as HTMLElement;
    this.box = document.getElementById("device-setup-box") as HTMLElement;
  }

  /** Open on values just read from the device. Both copies start equal, so the
   *  screen opens with nothing pending. */
  open(setup: DeviceSetup): void {
    this.baseline = coerceDeviceSetup(setup);
    this.draft = structuredClone(this.baseline);
    this.bank = 0;
    this.render();
    this.releaseInert ??= holdAppInert();
    this.scrim.hidden = false;
    this.dismiss.attach();
    this.box.querySelector<HTMLButtonElement>(".consent-btn-secondary")?.focus({ preventScroll: true });
  }

  isOpen(): boolean {
    return !this.scrim.hidden;
  }

  /** The one user-facing close. Unapplied edits are worth a confirm — they cost a
   *  device read to get back, and the screen is the only place they exist. */
  async requestClose(): Promise<void> {
    if (this.busy) return;
    if (this.pending().count > 0) {
      this.busy = true;
      const ok = await this.hooks.confirmDiscard();
      this.busy = false;
      if (!ok) return;
    }
    this.close();
  }

  close(): void {
    this.dismiss.detach();
    this.releaseInert?.();
    this.releaseInert = null;
    this.scrim.hidden = true;
    this.box.replaceChildren();
  }

  /** Re-render in place (the language changed while the screen is open). */
  refresh(): void {
    if (this.isOpen() && !this.busy) this.render();
  }

  /** The pending diff. One call answers all three questions the screen asks of it:
   *  which rows to mark, how many settings changed, and what to send. */
  private pending(): SetupChanges {
    const changes = deviceSetupChanges(this.hooks.model(), this.baseline, this.draft);
    return {
      count: changes.length,
      fields: new Set(changes.map((c) => c.field)),
      writes: changes.flatMap((c) => c.writes),
    };
  }

  private edit(patch: Partial<DeviceSetup>): void {
    this.draft = coerceDeviceSetup({ ...this.draft, ...patch });
    this.render();
  }

  private async runApply(): Promise<void> {
    const { writes, count } = this.pending();
    if (writes.length === 0 || this.busy) return;
    this.busy = true;
    this.render();
    const ok = await this.hooks.apply(writes, count);
    this.busy = false;
    // Only a clean apply moves the baseline. After a failure the draft still
    // differs from what the device holds, which is exactly what a retry needs.
    if (ok) this.baseline = structuredClone(this.draft);
    this.render();
  }

  private render(): void {
    const m = t().deviceSetup;
    const support = setupSupport(this.hooks.model());
    const s = this.draft;
    // One diff per render. It names the rows to mark, counts the settings for the
    // footer, and is what Apply sends — so the marks, the count and the write set
    // cannot disagree.
    const pending = this.pending();
    this.dirty = pending.fields;
    this.box.replaceChildren();

    const title = el("h2", "");
    title.id = "device-setup-title";
    title.textContent = m.title;

    const note = el("p", "dev-warm");
    note.textContent = m.standingNote;

    const left = el("div", "prefs-col");
    {
      const sec = this.section(m.languageSection);
      const sel = this.indexSelect(DEVICE_LANGUAGE_LABELS, s.language, (v) => this.edit({ language: v }));
      sel.id = "device-setup-language";
      sec.append(this.row(m.displayLanguage, sel, "language"), this.note(m.languageNote));
      left.append(sec);
    }
    {
      const sec = this.section(m.brightnessSection);
      sec.append(this.row(m.screen, this.brightness(s.brightness), "brightness"));
      left.append(sec);
    }
    {
      const sec = this.section(m.powerSection);
      const time = settingsSelect(
        AUTO_POWER_OFF_TIMES,
        s.autoPowerOffTime,
        (v) => m.minutes(v),
        (v) => this.edit({ autoPowerOffTime: v }),
      );
      time.id = "device-setup-apo-time";
      sec.append(
        this.sub(m.autoPowerOff),
        this.row(
          m.enable,
          onOff(s.autoPowerOff, (on) => this.edit({ autoPowerOff: on })),
          "autoPowerOff",
        ),
        this.row(m.time, time, "autoPowerOffTime"),
      );
      left.append(sec);
    }
    {
      const locked = !support.dateTime;
      const sec = this.section(m.dateTimeSection, locked ? m.onlyOn("URX44V / URX44") : undefined);
      const zone = this.indexSelect(TIME_ZONE_CITIES, s.timeZone, (v) => this.edit({ timeZone: v }));
      zone.id = "device-setup-timezone";
      sec.append(
        this.row(m.timeZone, zone, "timeZone", locked),
        this.sub(m.displayFormat),
        this.row(
          m.date,
          this.indexSelect(DATE_FORMAT_LABELS, s.dateFormat, (v) => this.edit({ dateFormat: v })),
          "dateFormat",
          locked,
        ),
        this.row(
          m.time,
          settingsChoice(TIME_FORMAT_LABELS, s.timeFormat, (v) => this.edit({ timeFormat: v }), true),
          "timeFormat",
          locked,
        ),
        this.note(support.dateTime ? `${m.clockNote} ${m.timeZoneNote}` : m.noDateTime),
      );
      left.append(sec);
    }

    const right = el("div", "prefs-col");
    {
      const locked = !support.hdmi;
      const sec = this.section(m.peripheralSection);
      sec.append(
        this.sub(m.usbMain),
        this.row(
          m.usbSuppression,
          settingsChoice(USB_SUPPRESSION_LABELS, s.usbSuppression, (v) => this.edit({ usbSuppression: v })),
          "usbSuppression",
        ),
        this.note(m.usbNote),
        this.sub(m.hdmi, locked ? m.onlyOn("URX44V") : undefined),
        this.row(
          m.hdcp,
          onOff(s.hdcp, (on) => this.edit({ hdcp: on })),
          "hdcp",
          locked,
        ),
        this.row(
          m.hdmiChannels,
          settingsChoice(HDMI_CHANNEL_LABELS, s.hdmiChannels, (v) => this.edit({ hdmiChannels: v })),
          "hdmiChannels",
          locked,
        ),
        this.note(support.hdmi ? m.hdmiNote : m.hdmiOnly),
      );
      right.append(sec);
    }
    {
      const sec = this.section(m.knobsSection);
      sec.append(this.bankTabs(), this.knobHead());
      for (const [k, knob] of UDK_KNOBS.entries()) sec.append(this.knobRow(k, knob));
      sec.append(this.note(m.knobsNote));
      right.append(sec);
    }

    const grid = el("div", "prefs-grid");
    grid.append(left, right);

    const actions = el("div", "consent-actions");
    const count = el("span", "prefs-ver dev-pending");
    count.id = "device-setup-pending";
    count.textContent = pending.count > 0 ? m.pending(pending.count) : "";
    const close = el("button", "consent-btn-secondary") as HTMLButtonElement;
    close.type = "button";
    close.textContent = m.close;
    close.disabled = this.busy;
    close.addEventListener("click", () => void this.requestClose());
    const apply = el("button", "consent-btn-primary") as HTMLButtonElement;
    apply.id = "device-setup-apply";
    apply.type = "button";
    apply.textContent = m.apply;
    apply.disabled = this.busy || pending.writes.length === 0;
    apply.addEventListener("click", () => void this.runApply());
    actions.append(count, close, apply);

    this.box.append(title, note, grid, actions);
  }

  // ---- builders ---------------------------------------------------------------
  // Row shapes come from dom.ts (shared with Preferences); what stays here is what
  // this screen adds on top: the dirty mark, and the brightness slider.

  private section(titleText: string, tag?: string): HTMLElement {
    return settingsSection(titleText, tag);
  }

  /** A sub-page name inside a section (the unit splits these onto tabs). */
  private sub(text: string, tag?: string): HTMLElement {
    const p = el("p", "dev-sub");
    p.textContent = text;
    if (tag) {
      const pill = el("span", "prefs-lock");
      pill.textContent = tag;
      p.append(pill);
    }
    return p;
  }

  /** A label + control row. `field` names the setting so the row can be marked from
   *  the pending diff rather than by comparing values a second way; `locked` is a
   *  model that does not have the page. */
  private row(labelText: string, control: HTMLElement, field: SetupField, locked = false): HTMLElement {
    return settingsRow(labelText, control, {
      locked,
      cls: !locked && this.dirty.has(field) ? "dirty" : undefined,
    });
  }

  private note(text: string): HTMLElement {
    return settingsNote(text);
  }

  /** A select over an index into a label list — the shape every enum on this screen
   *  has, because the device value IS the position in the catalog. */
  private indexSelect(labels: readonly string[], current: number, apply: (v: number) => void): HTMLSelectElement {
    return settingsSelect(
      labels.map((_, i) => i),
      current,
      (v) => labels[v] ?? String(v),
      apply,
    );
  }

  /** Brightness: a level, so a slider with its value beside it, on the same wheel
   *  contract as every other slider in the app. */
  private brightness(value: number): HTMLElement {
    const wrap = el("div", "ctl dev-slider");
    const input = el("input", "") as HTMLInputElement;
    input.type = "range";
    input.id = "device-setup-brightness";
    input.min = String(BRIGHTNESS_MIN);
    input.max = String(BRIGHTNESS_MAX);
    input.step = "1";
    input.value = String(value);
    const val = el("span", "param-val");
    val.textContent = String(value);
    // Repaint the readout while dragging, but only commit (and re-render) on
    // release: a render per pointer move would swap the element mid-drag.
    input.addEventListener("input", () => {
      val.textContent = input.value;
    });
    input.addEventListener("change", () => this.edit({ brightness: Number(input.value) }));
    onWheelStep(input, (dir) => this.edit({ brightness: Number(input.value) + dir }));
    wrap.append(input, val);
    return wrap;
  }

  // ---- User Defined Knobs ----------------------------------------------------

  private bankTabs(): HTMLElement {
    const wrap = el("div", "udk-banks");
    wrap.id = "device-setup-banks";
    for (const [i, bank] of UDK_BANKS.entries()) {
      const active = i === this.bank;
      const b = el("button", "") as HTMLButtonElement;
      b.type = "button";
      b.textContent = i === 0 ? t().deviceSetup.bank(bank) : String(bank);
      b.setAttribute("aria-pressed", String(active));
      b.addEventListener("click", () => {
        this.bank = i;
        this.render();
      });
      wrap.append(b);
    }
    return wrap;
  }

  private knobHead(): HTMLElement {
    const m = t().deviceSetup;
    const head = el("div", "udk-head");
    const cols = el("div", "cols");
    for (const label of [m.function, m.param1, m.param2]) {
      const span = el("span", "");
      span.textContent = label;
      cols.append(span);
    }
    head.append(el("span", ""), cols);
    return head;
  }

  private knobRow(knobIndex: number, knob: string): HTMLElement {
    const m = t().deviceSetup;
    const y = udkSlot(this.bank, knobIndex);
    const a = this.draft.knobs[y] ?? { fn: "", p1: "", p2: "" };
    const row = el("div", this.dirty.has(knobField(y)) ? "udk-row dirty" : "udk-row");
    const name = el("span", "knob");
    name.textContent = knob;
    const sel = el("div", "udk-sel");

    const entry = UDK_FUNCTIONS.find((f) => f.fn === a.fn);
    const set = (next: UdkAssignment): void => {
      const knobs = this.draft.knobs.slice();
      knobs[y] = normalizeUdk(next);
      this.edit({ knobs });
    };
    // Picking a function re-seeds the two parameter columns from the catalog: the
    // device stores whatever it is given, so an inconsistent triple would be shown
    // on the unit verbatim.
    sel.append(
      settingsSelect(
        UDK_FUNCTIONS.map((f) => f.fn),
        a.fn,
        (fn) => fn,
        (fn) => set({ fn, p1: "", p2: "" }),
      ),
      settingsSelect(
        entry?.p1 ?? [],
        a.p1,
        (v) => v,
        (p1) => set({ ...a, p1 }),
        m.unset,
      ),
      settingsSelect(
        entry?.p2 ?? [],
        a.p2,
        (v) => v,
        (p2) => set({ ...a, p2 }),
        m.unset,
      ),
    );
    row.append(name, sel);
    return row;
  }
}
