import { t } from "../i18n";

// Show a copyable report in the shared modal. The default framing is a plan-load
// failure (a `?plan=` decode error or a routing validation failure); `opts`
// overrides the title and intro so the same copyable-<pre> surface serves other
// long, copyable reports (e.g. a read-only device↔plan comparison). The report
// text is selectable and the Copy button writes it to the clipboard. Re-showing
// replaces the text and re-binds the buttons.
export function showLoadReport(report: string, opts?: { title: string; intro: string }): void {
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

  scrim.hidden = false;
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
  };
  copy.addEventListener("click", onCopy);
  close.addEventListener("click", onClose);
}
