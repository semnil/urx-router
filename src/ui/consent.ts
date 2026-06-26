import { t } from "../i18n";

/**
 * Show the first-run consent gate and resolve true (agreed) or false (declined).
 * The disclaimer mirrors the installer license notice; the caller persists the
 * acceptance and quits the app when declined.
 */
export function showConsent(): Promise<boolean> {
  const scrim = document.getElementById("consent") as HTMLElement;
  const title = document.getElementById("consent-title") as HTMLElement;
  const body = document.getElementById("consent-body") as HTMLElement;
  const accept = document.getElementById("consent-accept") as HTMLElement;
  const agree = document.getElementById("consent-agree") as HTMLButtonElement;
  const quit = document.getElementById("consent-quit") as HTMLButtonElement;

  const m = t().consent;
  title.textContent = m.title;
  body.replaceChildren(
    ...m.body.map((para) => {
      const p = document.createElement("p");
      p.textContent = para;
      return p;
    }),
  );
  accept.textContent = m.accept;
  agree.textContent = m.agree;
  quit.textContent = m.quit;

  // Disable the app behind the scrim so it cannot be reached by keyboard/Tab.
  const app = document.getElementById("app") as HTMLElement;
  app.inert = true;
  scrim.hidden = false;
  agree.focus();

  return new Promise<boolean>((resolve) => {
    const close = (agreed: boolean): void => {
      app.inert = false;
      scrim.hidden = true;
      resolve(agreed);
    };
    agree.addEventListener("click", () => close(true), { once: true });
    quit.addEventListener("click", () => close(false), { once: true });
  });
}
