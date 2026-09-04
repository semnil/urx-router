import { t } from "../i18n";
import { el, holdAppInert, wireDismiss } from "./dom";

// Where an error goes when the dialog it was routed to could not be raised — the shell's own
// dialog command can reject, and `void`-ing that left the failure on no surface at all.
//
// A box rather than the status line, which is one transient slot: the line carries what the
// run achieved and whatever the app reports next, and a failure written there is gone at the
// next thing to say. Both have to be readable at once, so they are two surfaces.
//
// Messages QUEUE. A shell that cannot raise one dialog is unlikely to raise the next, so a box
// that replaced its contents would lose every failure but the last.

const pending: string[] = [];
let open = false;

export function showErrorBox(message: string): void {
  pending.push(message);
  const scrim = document.getElementById("error-box-modal") as HTMLElement | null;
  const body = document.getElementById("error-box-body") as HTMLElement | null;
  const title = document.getElementById("error-box-title") as HTMLElement | null;
  const close = document.getElementById("error-box-close") as HTMLButtonElement | null;
  // The markup is the app's own, so its absence is a build that shipped without it; the queue
  // still holds the message and the console line beside this call is what remains.
  if (!scrim || !body || !title || !close) return;

  const m = t().errorBox;
  title.textContent = m.title;
  close.textContent = m.close;
  body.replaceChildren(
    ...pending.map((text) => {
      const p = el("p", "consent-line");
      p.textContent = text;
      return p;
    }),
  );
  if (open) return;

  open = true;
  const release = holdAppInert(scrim);
  scrim.hidden = false;
  close.focus();

  const onClose = (): void => {
    open = false;
    pending.length = 0;
    release();
    dismiss.detach();
    scrim.hidden = true;
    body.replaceChildren();
    close.removeEventListener("click", onClose);
  };
  // Dismissed like the other informational boxes — a press outside it or Escape — since there
  // is nothing here to confirm.
  const dismiss = wireDismiss({ scrim: () => scrim, keep: (target) => target !== scrim, close: onClose });
  dismiss.attach();
  close.addEventListener("click", onClose);
}
