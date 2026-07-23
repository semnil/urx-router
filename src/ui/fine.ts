// Fine-tuning mode (hold Shift), mirroring the device's push-and-turn fine steps.
// Only controls whose device parameter has a verified fine grid opt in: EQ band
// gain and COMP gain (0.1 dB), and the STREAMING DELAY time (0.02 ms). While fine
// mode is on the root element carries .fine-mode (CSS lights the FINE tag on the
// hovered / focused eligible control) and every input[data-fine-step] swaps its
// step attribute to the fine grid, so native range drag, arrow keys and the wheel
// all inherit it. Two entry styles (the fineLatch preference): hold — Shift down
// enters, keyup / window blur / tab hide leave, so a missed keyup can never leave
// fine mode latched; latch — each Shift press flips it, and only a preference
// change (resetFine) or a page hide clears it deliberately.

import { el } from "./dom";
import { t } from "../i18n";
import { getSettings } from "../core/settings";

let fine = false;

/** Whether fine mode is currently held (the console knob handlers poll this). */
export function fineActive(): boolean {
  return fine;
}

/** Build the FINE legend (shared by both views); printed / lit styling and
 *  placement live in style.css (.fine-tag). The hint names the active entry
 *  style (hold vs latch), read at build time — the views rebuild on change. */
export function fineTag(): HTMLElement {
  const tag = el("span", "fine-tag");
  tag.textContent = t().inspector.fineTag;
  tag.title = getSettings().fineLatch ? t().inspector.fineHintLatch : t().inspector.fineHint;
  return tag;
}

/** Leave fine mode (the fineLatch preference changed, so a held latch would
 *  otherwise linger under the other entry style's rules). */
export function resetFine(): void {
  setFine(false);
}

/** Opt a native range slider into fine mode. The tracker swaps the step attribute
 *  via these data attributes; a slider built while Shift is already down starts
 *  on the fine grid. */
export function optInFine(slider: HTMLInputElement, coarse: number, fine: number): void {
  slider.dataset.coarseStep = String(coarse);
  slider.dataset.fineStep = String(fine);
  if (fineActive()) slider.step = String(fine);
}

function setFine(on: boolean): void {
  if (fine === on) return;
  fine = on;
  document.documentElement.classList.toggle("fine-mode", on);
  for (const s of document.querySelectorAll<HTMLInputElement>("input[data-fine-step]")) {
    const step = on ? s.dataset.fineStep : s.dataset.coarseStep;
    if (step) s.step = step;
  }
}

/** Install the global Shift tracker (once, at startup). */
export function initFineMode(): void {
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Shift") return;
    // Latch: one flip per physical press (keydown auto-repeats while held).
    if (getSettings().fineLatch) {
      if (!e.repeat) setFine(!fine);
    } else {
      setFine(true);
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Shift" && !getSettings().fineLatch) setFine(false);
  });
  // Hold-mode safety: a missed keyup (window blur mid-hold) must not latch. A
  // deliberate latch survives blur; tab hide clears both (stale mode on return).
  window.addEventListener("blur", () => {
    if (!getSettings().fineLatch) setFine(false);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) setFine(false);
  });
}
