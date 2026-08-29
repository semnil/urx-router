// Choosing an option in a `<select>`, the way the operator's own dropdown does it.
//
// Playwright's `selectOption` BLURS the select. A native dropdown does not: dismissing it
// with a choice leaves focus exactly where it was, on the select. That difference is not
// cosmetic, because the Inspector holds its rebuild while a select inside it has focus —
// a rebuild closes an open picker — and releases on the `change` that the dismissal
// produces. Driven with a blur in front of it, the release happens for a reason the
// operator never supplies, and a panel that fails to update on the change alone looks
// exactly like one that updates.
//
// Every select in this suite goes through here so that no case can be written against the
// blurring gesture by accident. It lives in its own module, importing only a TYPE, so the
// race tier can use it without pulling in the ordinary tier's coverage fixture.
import type { Locator } from "@playwright/test";

/** How to name the wanted option — the same four shapes `selectOption` accepts, minus
 *  the multi-select forms this app has no use for. A bare string is a VALUE. */
export type OptionChoice = string | { label: string } | { value: string } | { index: number };

/**
 * Pick `choice` in `select` and leave focus on it.
 *
 * Fires `input` then `change`, and does so even when the value did not move: that is what
 * `selectOption` does, and a case that re-picks the value already there is asking whether
 * the app handles the event rather than whether the browser emits one.
 *
 * A choice that names no option throws with the options that ARE there — the failure is
 * otherwise a silent no-op followed by an assertion about something unrelated.
 */
export async function chooseOption(select: Locator, choice: OptionChoice): Promise<void> {
  await select.evaluate((el, wanted) => {
    if (!(el instanceof HTMLSelectElement)) throw new Error(`chooseOption: not a <select> but <${el.tagName}>`);
    if (el.disabled) throw new Error("chooseOption: the select is disabled");
    const opts = [...el.options];
    const want =
      typeof wanted === "string"
        ? opts.find((o) => o.value === wanted)
        : "label" in wanted
          ? opts.find((o) => o.text === wanted.label)
          : "value" in wanted
            ? opts.find((o) => o.value === wanted.value)
            : opts[wanted.index];
    if (!want)
      throw new Error(
        `chooseOption: no option ${JSON.stringify(wanted)}; the select offers ` +
          opts.map((o) => `${JSON.stringify(o.text)}=${JSON.stringify(o.value)}`).join(", "),
      );
    if (want.disabled) throw new Error(`chooseOption: the option ${JSON.stringify(want.text)} is disabled`);
    // Focus first, so the events are dispatched in the state a dismissal leaves behind
    // rather than in whatever state the previous step happened to end in.
    el.focus();
    el.value = want.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, choice);
}
