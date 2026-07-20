import { t } from "../i18n";

/** What the operator chose when the plan's rate disagrees with a device that is
 *  slaved to its USB host. `adopt` takes the device's rate into the plan; `release`
 *  turns Follow USB off so the plan's rate can stick; `cancel` writes nothing. */
export type RateChoice = "adopt" | "release" | "cancel";

/**
 * Ask what to do about a sample-rate disagreement the device cannot simply take.
 *
 * With Follow USB on, the device slaves its clock to the USB host: a rate write is
 * accepted and re-clocks, then the host's rate reasserts itself about a second
 * later (measured on hardware). So writing the plan's rate would appear to work and
 * silently undo itself — the one outcome the operator must not be handed. Both real
 * answers are offered instead of guessing which was meant.
 *
 * `hiRateNote` names the plan settings a device rate above 96 kHz would leave
 * unwritten, so choosing `adopt` is not a surprise. The plan keeps them either way.
 */
export function askRateChoice(planRate: string, deviceRate: string, hiRateNote: string | null): Promise<RateChoice> {
  const scrim = document.getElementById("rate-choice") as HTMLElement;
  const title = document.getElementById("rate-choice-title") as HTMLElement;
  const intro = document.getElementById("rate-choice-intro") as HTMLElement;
  const note = document.getElementById("rate-choice-note") as HTMLElement;
  const adopt = document.getElementById("rate-choice-adopt") as HTMLButtonElement;
  const release = document.getElementById("rate-choice-release") as HTMLButtonElement;
  const cancel = document.getElementById("rate-choice-cancel") as HTMLButtonElement;

  const m = t().rateChoice;
  title.textContent = m.title;
  intro.textContent = m.intro(planRate, deviceRate);
  note.textContent = hiRateNote ?? "";
  note.hidden = hiRateNote === null;
  adopt.textContent = m.adopt(deviceRate);
  release.textContent = m.release(planRate);
  cancel.textContent = m.cancel;

  scrim.hidden = false;
  cancel.focus();

  // One AbortController unwires all three at once, so a fourth choice cannot be
  // added with its teardown forgotten (the codebase's idiom for one-shot listeners).
  return new Promise<RateChoice>((resolve) => {
    const ac = new AbortController();
    const finish = (choice: RateChoice) => (): void => {
      scrim.hidden = true;
      ac.abort();
      resolve(choice);
    };
    const opts = { signal: ac.signal };
    adopt.addEventListener("click", finish("adopt"), opts);
    release.addEventListener("click", finish("release"), opts);
    cancel.addEventListener("click", finish("cancel"), opts);
  });
}
