import { t } from "../i18n";

// Show the bundled third-party license notice (cargo-about HTML) in a sandboxed
// frame. Texts are applied at show time, like the other modals. Closing releases
// the srcdoc so the rendered license document (thousands of nodes) is not
// retained by a rarely-opened modal.
export function showLicenses(html: string): void {
  const scrim = document.getElementById("licenses-modal") as HTMLElement;
  const frame = document.getElementById("licenses-frame") as HTMLIFrameElement;
  const title = document.getElementById("licenses-title") as HTMLElement;
  const close = document.getElementById("licenses-close") as HTMLButtonElement;

  const m = t().licenses;
  title.textContent = m.title;
  frame.title = m.title;
  close.textContent = m.close;
  frame.srcdoc = html;

  scrim.hidden = false;
  close.focus();

  const onClose = (): void => {
    scrim.hidden = true;
    frame.removeAttribute("srcdoc");
    close.removeEventListener("click", onClose);
  };
  close.addEventListener("click", onClose);
}
