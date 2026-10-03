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
  holdInertOnBlur,
  labelId,
  onWheelStep,
  preserveSettingsView,
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
  UDK_UNASSIGNED,
  USB_SUPPRESSION_LABELS,
  coerceDeviceSetupFields,
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

/** The ids of the knob columns' heads (Function / Parameter 1 / Parameter 2), which name
 *  each knob row's three selects together with the knob's own name. */
const UDK_COLUMN_IDS = ["device-setup-udk-fn", "device-setup-udk-p1", "device-setup-udk-p2"];

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
    scrim: () => this.scrim,
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

  /** Open on values just read from the device, as the unit reported them: a value the
   *  app's catalog does not have is shown as unknown rather than as the nearest entry.
   *  Both copies start equal, so the screen opens with nothing pending. */
  open(setup: DeviceSetup): void {
    this.baseline = structuredClone(setup);
    this.draft = structuredClone(setup);
    this.bank = 0;
    this.render();
    this.releaseInert ??= holdAppInert(this.scrim);
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

  /** Coerces the fields the patch carries and no others, so a value the unit holds off the
   *  catalog stays as read until the operator picks something for that row. */
  private edit(patch: Partial<DeviceSetup>): void {
    this.draft = { ...this.draft, ...coerceDeviceSetupFields(patch, this.baseline) };
    this.render();
  }

  private async runApply(): Promise<void> {
    const { writes, count } = this.pending();
    if (writes.length === 0 || this.busy) return;
    // The draft this diff was taken from. The rows stay editable while the apply is in
    // flight, and an edit made then is not in `writes`, so it stays pending afterwards.
    const sent = structuredClone(this.draft);
    this.busy = true;
    this.render();
    const ok = await this.hooks.apply(writes, count);
    this.busy = false;
    // Only a clean apply moves the baseline, and only to what it sent. After a failure
    // the draft still differs from what the device holds, which is exactly what a retry
    // needs.
    if (ok) this.baseline = sent;
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
    // Every edit and bank tab rebuilds the box; a rebuild of the open screen keeps the
    // focused control and the grid's scroll offset.
    const carry = this.isOpen() ? preserveSettingsView(this.box) : null;
    this.box.replaceChildren();

    const title = el("h2", "");
    title.id = "device-setup-title";
    title.textContent = m.title;

    const note = el("p", "dev-warm");
    note.textContent = m.standingNote;

    const left = el("div", "prefs-col");
    {
      const sec = this.section(m.languageSection);
      const sel = this.indexSelect(DEVICE_LANGUAGE_LABELS, "language", (v) => this.edit({ language: v }));
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
        this.withReading(AUTO_POWER_OFF_TIMES, this.baseline.autoPowerOffTime),
        s.autoPowerOffTime,
        (v) => (AUTO_POWER_OFF_TIMES.includes(v) ? m.minutes(v) : m.unknownValue(v)),
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
      const zone = this.indexSelect(TIME_ZONE_CITIES, "timeZone", (v) => this.edit({ timeZone: v }));
      zone.id = "device-setup-timezone";
      sec.append(
        this.row(m.timeZone, zone, "timeZone", locked),
        this.sub(m.displayFormat),
        this.row(
          m.date,
          this.indexSelect(DATE_FORMAT_LABELS, "dateFormat", (v) => this.edit({ dateFormat: v })),
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
    carry?.();
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
   *  has, because the device value IS the position in the catalog. A reading past the
   *  list is offered as unknown (`withReading`). */
  private indexSelect(
    labels: readonly string[],
    field: "language" | "timeZone" | "dateFormat",
    apply: (v: number) => void,
  ): HTMLSelectElement {
    return settingsSelect(
      this.withReading(
        labels.map((_, i) => i),
        this.baseline[field],
      ),
      this.draft[field],
      (v) => labels[v] ?? t().deviceSetup.unknownValue(v),
      apply,
    );
  }

  /** `choices`, with the device's reading in front of them when the catalog does not
   *  have it: the select then shows the unit's own value as unknown rather than naming a
   *  setting the unit is not on, and picking it back is the reading again. */
  private withReading<T extends string | number>(choices: readonly T[], reading: T): readonly T[] {
    return choices.includes(reading) ? choices : [reading, ...choices];
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
    // Stepped from the DRAFT, not from the element. `onWheelStep` calls back once per
    // configured wheel step, and the first `edit()` re-renders and replaces this input —
    // so calls 2..n read a detached element whose value never moved and compute the same
    // target. With Preferences > wheel steps at 3, brightness moved by one detent per
    // notch instead of three (and re-rendered three times doing it). Every other slider
    // here goes through the shared helper and honours the preference.
    // Stepping the draft is also why the shared `wheelStep` guard does not cover this row:
    // `wheel` is delivered to a disabled range in both engines, and macOS delivers scroll to
    // an unfocused window, so while `holdInertOnBlur` holds this row a notch over the
    // background app would write the value just declared out of reach — and `edit()` would
    // put a live row back under the still-held pointer.
    onWheelStep(
      input,
      (dir) => this.edit({ brightness: this.draft.brightness + dir }),
      () => input.disabled,
    );
    // This row is the app's only slider that commits on `change`, and an engine will not
    // synthesize that change when the control is disabled — Chromium fires it early, at
    // the disable, and WebKit fires none at all (measured 2026-08-14), which loses the
    // value the operator dragged to. So the commit is made here, from the element, before
    // anything is held.
    holdInertOnBlur(input, {
      beforeDisable: () => this.edit({ brightness: Number(input.value) }),
      live: () => this.box.querySelector<HTMLInputElement>("#device-setup-brightness"),
    });

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
    for (const [i, label] of [m.function, m.param1, m.param2].entries()) {
      const span = el("span", "");
      span.textContent = label;
      span.id = UDK_COLUMN_IDS[i];
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
    const read = this.baseline.knobs[y] ?? UDK_UNASSIGNED;
    const known = UDK_FUNCTIONS.map((f) => f.fn);
    const readEntry = UDK_FUNCTIONS.find((f) => f.fn === read.fn);
    // Where the function offers a choice of Parameter 1, the value the unit reported for it,
    // when the catalog does not have that value.
    const readP1Off = readEntry !== undefined && readEntry.p1.length > 1 && !readEntry.p1.includes(read.p1);
    const p1Choices = entry && a.fn === read.fn && readP1Off ? [read.p1, ...entry.p1] : (entry?.p1 ?? []);
    const set = (next: UdkAssignment): void => {
      const knobs = this.draft.knobs.slice();
      // A Function, or a Parameter 1, off the catalog, picked back, is the reading again.
      const back = next.fn === read.fn && (!readEntry || (readP1Off && next.p1 === read.p1));
      knobs[y] = back ? structuredClone(read) : normalizeUdk(next);
      this.edit({ knobs });
    };
    // Picking a function re-seeds the two parameter columns from the catalog: the
    // device stores whatever it is given, so an inconsistent triple would be shown
    // on the unit verbatim. Each select is named by its knob and its column's head.
    sel.append(
      settingsSelect(
        this.withReading(known, read.fn),
        a.fn,
        (fn) => (known.includes(fn) ? fn : m.unknownValue(fn)),
        (fn) => set({ fn, p1: "", p2: "" }),
      ),
      settingsSelect(
        p1Choices,
        a.p1,
        (v) => (entry?.p1.includes(v) ? v : m.unknownValue(v)),
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
    name.id = labelId("udk-knob");
    for (const [i, select] of [...sel.children].entries())
      select.setAttribute("aria-labelledby", `${name.id} ${UDK_COLUMN_IDS[i]}`);
    row.append(name, sel);
    return row;
  }
}
