// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { t } from "../i18n";
import { showConsent } from "./consent";

function installDom(): void {
  document.body.innerHTML = `
    <main id="app"></main>
    <div id="consent" hidden>
      <h1 id="consent-title"></h1>
      <div id="consent-body"></div>
      <p id="consent-accept"></p>
      <button id="consent-agree"></button>
      <button id="consent-quit"></button>
    </div>`;
}

beforeEach(installDom);

describe("showConsent", () => {
  it("locks the app, renders the disclaimer and resolves acceptance", async () => {
    const result = showConsent();
    const app = document.getElementById("app") as HTMLElement;
    const scrim = document.getElementById("consent") as HTMLElement;
    const agree = document.getElementById("consent-agree") as HTMLButtonElement;

    expect(app.inert).toBe(true);
    expect(scrim.hidden).toBe(false);
    expect(document.activeElement).toBe(agree);
    expect(document.querySelectorAll("#consent-body p")).toHaveLength(t().consent.body.length);
    expect(document.getElementById("consent-title")?.textContent).toBe(t().consent.title);

    agree.click();
    await expect(result).resolves.toBe(true);
    expect(app.inert).toBe(false);
    expect(scrim.hidden).toBe(true);
  });

  it("resolves refusal and unlocks the app", async () => {
    const result = showConsent();
    (document.getElementById("consent-quit") as HTMLButtonElement).click();
    await expect(result).resolves.toBe(false);
    expect((document.getElementById("app") as HTMLElement).inert).toBe(false);
    expect((document.getElementById("consent") as HTMLElement).hidden).toBe(true);
  });
});
