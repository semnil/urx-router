// Fine-tuning mode (hold Shift), mirroring the device's push-and-turn fine steps.
// Only controls whose device parameter has a verified fine grid opt in: EQ band
// gain and COMP gain (0.1 dB), and the STREAMING DELAY time (0.02 ms). While Shift
// is down the root element carries .fine-mode (CSS lights the FINE tag on the
// hovered / focused eligible control) and every input[data-fine-step] swaps its
// step attribute to the fine grid, so native range drag, arrow keys and the wheel
// all inherit it; releasing Shift restores data-coarse-step. Window blur and tab
// hide also reset, so a missed keyup can never leave fine mode latched.

import { el } from "./dom";
import { t } from "../i18n";

let fine = false;

/** Whether fine mode is currently held (the console knob handlers poll this). */
export function fineActive(): boolean {
  return fine;
}

/** Build the FINE tag that lights while the mode is armed (shared by both views). */
export function fineTag(): HTMLElement {
  const tag = el("span", "fine-tag");
  tag.textContent = t().inspector.fineTag;
  tag.title = t().inspector.fineHint;
  return tag;
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
    if (e.key === "Shift") setFine(true);
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Shift") setFine(false);
  });
  window.addEventListener("blur", () => setFine(false));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) setFine(false);
  });
}
