// In the mono UI font the infinity glyph (U+221E) draws at x-height, so a bare
// "-∞" reads markedly smaller and fainter than the digits it stands in for. Write
// the text with each ∞ wrapped in a span (.glyph-inf scales it back up to the
// digits' height), so an off / out-of-range readout stays as legible as a value.
export function setLevelText(el: HTMLElement, text: string): void {
  if (!text.includes("∞")) {
    el.textContent = text;
    return;
  }
  el.replaceChildren();
  for (const part of text.split(/(∞)/)) {
    if (!part) continue;
    if (part === "∞") {
      const span = document.createElement("span");
      span.className = "glyph-inf";
      span.textContent = part;
      el.append(span);
    } else {
      el.append(document.createTextNode(part));
    }
  }
}
