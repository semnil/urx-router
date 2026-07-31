import { t } from "../i18n";

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

  // A re-show inherits the previous show's DOM, so drop a proceed button left by one
  // whose framing offered it before deciding whether this one does.
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
    const done = (): void => void (copy.textContent = m.copied);
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(report).then(done, selectBody);
    } else {
      selectBody();
    }
  };
  const onClose = (): void => {
    scrim.hidden = true;
    copy.textContent = m.copy;
    copy.removeEventListener("click", onCopy);
    close.removeEventListener("click", onClose);
    proceed?.remove();
  };
  copy.addEventListener("click", onCopy);
  close.addEventListener("click", onClose);
  // Dismissed first, so whatever proceeding raises (a status line, a dialog of its
  // own) is not left behind this modal.
  if (proceed && proceedRun)
    proceed.addEventListener("click", () => {
      onClose();
      proceedRun();
    });
}
