import { t } from "../i18n";
import { copyText, holdAppInert } from "./dom";

// Show a copyable report in the shared modal. The default framing is a plan-load
// failure (a `?plan=` decode error or a routing validation failure); `opts`
// overrides the title and intro so the same copyable-<pre> surface serves other
// long, copyable reports (e.g. a read-only device↔plan comparison). The report
// text is selectable and the Copy button writes it to the clipboard. Re-showing
// replaces the text and re-binds the buttons.
//
// `opts.proceed` turns the report from an outcome into a decision: it adds the
// affirmative action beside Close, for a problem the plan can be opened in spite of.
// The button exists only for that framing — a refusal must carry nothing that could
// act on it — so it is built per show and removed with the modal.
//
// There is one showing at a time, so its inert claim and its listeners are held at
// module scope and a re-show inherits them rather than stacking a second set. The
// second set is what a re-show used to make: the new Proceed released only the new
// claim, the first one was never released, and the app stayed inert with no modal
// on screen until a reload.
let releaseInert: (() => void) | null = null;
let detachPrevious: (() => void) | null = null;

export function showLoadReport(
  report: string,
  opts?: { title: string; intro: string; proceed?: { label: string; run: () => void } },
): void {
  const scrim = document.getElementById("load-report") as HTMLElement;
  const title = document.getElementById("load-report-title") as HTMLElement;
  const intro = document.getElementById("load-report-intro") as HTMLElement;
  const body = document.getElementById("load-report-body") as HTMLElement;
  const copy = document.getElementById("load-report-copy") as HTMLButtonElement;
  const close = document.getElementById("load-report-close") as HTMLButtonElement;

  const m = t().loadReport;
  title.textContent = opts?.title ?? m.title;
  intro.textContent = opts?.intro ?? m.intro;
  copy.textContent = m.copy;
  close.textContent = m.close;
  body.textContent = report;

  // A re-show inherits the previous show's DOM, so drop what that show left: its
  // listeners first, then a proceed button its framing offered and this one may not.
  detachPrevious?.();
  document.getElementById("load-report-proceed")?.remove();
  const proceedRun = opts?.proceed?.run;
  let proceed: HTMLButtonElement | null = null;
  if (opts?.proceed) {
    proceed = document.createElement("button");
    proceed.id = "load-report-proceed";
    proceed.type = "button";
    proceed.className = "consent-btn-secondary";
    proceed.textContent = opts.proceed.label;
    close.before(proceed);
  }

  releaseInert ??= holdAppInert(scrim);
  scrim.hidden = false;
  // Close keeps the focus even when proceeding is offered: the report is what the
  // operator has to read before deciding, so the decision is not one Return away.
  close.focus();

  // Clipboard write can be unavailable (insecure context) or rejected; fall back
  // to selecting the report so the user can copy it by hand.
  const selectBody = (): void => {
    const range = document.createRange();
    range.selectNodeContents(body);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };
  const onCopy = (): void => {
    // Falls back to selecting the text, so the report is still takeable by hand when
    // the clipboard is refused or absent (an insecure context).
    void copyText(report).then((ok) => (ok ? void (copy.textContent = m.copied) : selectBody()));
  };
  // Unbinding this show, without closing it — what a re-show needs. Closing is
  // onClose, which is this plus dismissing the modal and giving the app back.
  const detach = (): void => {
    copy.removeEventListener("click", onCopy);
    close.removeEventListener("click", onClose);
    if (detachPrevious === detach) detachPrevious = null;
  };
  const onClose = (): void => {
    releaseInert?.();
    releaseInert = null;
    scrim.hidden = true;
    copy.textContent = m.copy;
    detach();
    proceed?.remove();
  };
  copy.addEventListener("click", onCopy);
  close.addEventListener("click", onClose);
  detachPrevious = detach;
  // Dismissed first, so whatever proceeding raises (a status line, a dialog of its
  // own) is not left behind this modal.
  if (proceed && proceedRun)
    proceed.addEventListener("click", () => {
      onClose();
      proceedRun();
    });
}
