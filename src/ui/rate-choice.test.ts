// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { t } from "../i18n";
import { askRateChoice, type RateChoice } from "./rate-choice";

function installDom(): void {
  document.body.innerHTML = `
    <div id="rate-choice" hidden>
      <h1 id="rate-choice-title"></h1>
      <p id="rate-choice-intro"></p>
      <p id="rate-choice-note"></p>
      <button id="rate-choice-adopt"></button>
      <button id="rate-choice-release"></button>
      <button id="rate-choice-cancel"></button>
    </div>`;
}

beforeEach(installDom);

describe("askRateChoice", () => {
  it.each([
    ["adopt", "rate-choice-adopt"],
    ["release", "rate-choice-release"],
    ["cancel", "rate-choice-cancel"],
  ] as const)("resolves %s and removes all one-shot listeners", async (choice: RateChoice, buttonId: string) => {
    const result = askRateChoice("48 kHz", "96 kHz", "High-rate settings remain in the plan.");
    const cancel = document.getElementById("rate-choice-cancel") as HTMLButtonElement;
    expect(document.activeElement).toBe(cancel);
    expect((document.getElementById("rate-choice") as HTMLElement).hidden).toBe(false);
    expect(document.getElementById("rate-choice-note")?.textContent).toContain("High-rate");

    (document.getElementById(buttonId) as HTMLButtonElement).click();
    await expect(result).resolves.toBe(choice);
    expect((document.getElementById("rate-choice") as HTMLElement).hidden).toBe(true);
  });

  it("hides an absent high-rate warning and formats both rates", () => {
    void askRateChoice("44.1 kHz", "48 kHz", null);
    const note = document.getElementById("rate-choice-note") as HTMLElement;
    expect(note.hidden).toBe(true);
    expect(note.textContent).toBe("");
    expect(document.getElementById("rate-choice-intro")?.textContent).toBe(t().rateChoice.intro("44.1 kHz", "48 kHz"));
    expect(document.getElementById("rate-choice-adopt")?.textContent).toBe(t().rateChoice.adopt("48 kHz"));
    expect(document.getElementById("rate-choice-release")?.textContent).toBe(t().rateChoice.release("44.1 kHz"));
  });
});
