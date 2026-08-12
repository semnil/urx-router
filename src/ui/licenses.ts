import { t } from "../i18n";
import { el, holdAppInert, wireDismiss } from "./dom";

// Third-party license notice, rendered as app DOM. The bundled cargo-about page
// (src-tauri/about.hbs output) is parsed — not embedded: an iframe would scroll
// through WKWebView's subframe scroller, a separate code path measured to
// reserve an unpainted scrollbar gutter, draw only a paint-only indicator (no
// thumb dragging), and pick the indicator palette from the app scheme rather
// than the page it indicates. Native DOM scrolls with the app's own main-frame
// scrollbar and follows the app theme.

interface LicenseVariant {
  crates: string[];
  text: string;
}

interface LicenseFamily {
  name: string;
  variants: LicenseVariant[];
  crateCount: number;
}

/** Parse the generated notice into license families (one family per license
 *  name, one variant per distinct license text, in document order). DOMParser
 *  yields an inert document — nothing executes — and rendering re-inserts every
 *  value as a text node, so the notice never runs as markup in the app. */
export function parseNotice(html: string): LicenseFamily[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const families: LicenseFamily[] = [];
  for (const item of doc.querySelectorAll(".licenses-list .license")) {
    const name = item.querySelector("h3")?.textContent?.trim() ?? "";
    const text = item.querySelector("pre.license-text")?.textContent ?? "";
    if (!name || !text.trim()) continue;
    const crates = [...item.querySelectorAll(".license-used-by li")]
      .map((c) => c.textContent?.trim().replace(/\s+/g, " ") ?? "")
      .filter(Boolean);
    let family = families.find((f) => f.name === name);
    if (!family) families.push((family = { name, variants: [], crateCount: 0 }));
    family.variants.push({ crates, text: text.trim() });
    family.crateCount += crates.length;
  }
  return families;
}

export function showLicenses(html: string): void {
  const families = parseNotice(html);
  // The notice is a bundled resource, so an unparseable one is a packaging
  // defect — surface it through the caller's error dialog, never an empty box.
  if (families.length === 0) throw new Error("no licenses found in the bundled notice");

  const scrim = document.getElementById("licenses-modal") as HTMLElement;
  const body = document.getElementById("licenses-body") as HTMLElement;
  const title = document.getElementById("licenses-title") as HTMLElement;
  const close = document.getElementById("licenses-close") as HTMLButtonElement;

  const m = t().licenses;
  title.textContent = m.title;
  close.textContent = m.close;

  // The collapsed family headers are the index: every section starts folded,
  // so the modal opens on an 8-row overview and each header unfolds its texts.
  const sections: HTMLElement[] = [];
  for (const family of families) {
    const sec = el("section", "lic-sec");
    const head = el("h3", "lic-head");
    const toggle = el("button", "lic-toggle") as HTMLButtonElement;
    toggle.type = "button";
    const arrow = el("span", "lic-arrow");
    toggle.append(arrow, document.createTextNode(family.name));
    const count = el("span", "lic-count");
    count.textContent = m.familyMeta(family.crateCount, family.variants.length);
    head.append(toggle, count);
    const detail = el("div", "lic-detail");
    for (const variant of family.variants) {
      const wrap = el("div", "lic-variant");
      const used = el("p", "lic-used");
      used.textContent = variant.crates.join(", ");
      const text = el("pre", "lic-text");
      text.textContent = variant.text;
      wrap.append(used, text);
      detail.append(wrap);
    }
    const setOpen = (open: boolean): void => {
      detail.hidden = !open;
      arrow.textContent = open ? "▾" : "▸";
      toggle.setAttribute("aria-expanded", String(open));
    };
    setOpen(false);
    // Boolean(): lib.dom types `hidden` as boolean | string ("until-found").
    toggle.addEventListener("click", () => setOpen(Boolean(detail.hidden)));
    sec.append(head, detail);
    sections.push(sec);
  }
  body.replaceChildren(...sections);
  body.scrollTop = 0;

  const release = holdAppInert();
  scrim.hidden = false;
  close.focus();

  const onClose = (): void => {
    release();
    dismiss.detach();
    scrim.hidden = true;
    // Release the rendered notice (thousands of nodes) — it is rebuilt from the
    // resource on the next open, like the other rebuilt-on-open modals.
    body.replaceChildren();
    close.removeEventListener("click", onClose);
  };
  // Informational, nothing to confirm: a press outside the box or Escape
  // dismisses, like the Preferences modal.
  const dismiss = wireDismiss({ keep: (target) => target !== scrim, close: onClose });
  dismiss.attach();
  close.addEventListener("click", onClose);
}
