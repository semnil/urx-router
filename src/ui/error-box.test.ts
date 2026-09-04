// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { CSS, RULES, decl } from "./style-css.test-util";
import { APP_BODY } from "../main.test-util";
import { showErrorBox } from "./error-box";
import { showLicenses } from "./licenses";
import { setLang } from "../i18n";

// Where a failure goes when its dialog could not be raised. The rung is the whole of what makes
// it readable: the box is opened BY something going wrong under whatever is already on screen,
// so a rung shared with that leaves it behind the thing it interrupts — between equal rungs the
// tiebreak is document order.
describe("the error box's place in the overlay ladder", () => {
  const z = (selector: string): number => {
    const rule = RULES.find((r) => r.selector === selector && decl(r.body, "z-index") !== undefined);
    expect(rule, `${selector} declares no z-index of its own`).toBeDefined();
    return Number(decl(rule!.body, "z-index"));
  };

  it("sits above every other overlay, decision gates included", () => {
    const box = z("#error-box-modal");
    // Every rung the ladder names, read from the stylesheet rather than restated here.
    for (const selector of [".consent-scrim", ".dropzone", ".gate-scrim"]) {
      expect(z(selector), selector).toBeLessThan(box);
    }
  });

  it("is not left on the shared rung the tool modals sit on", () => {
    // The defect this replaced: the box carried no z-index of its own, so it took
    // `.consent-scrim`'s and lost the DOM-order tiebreak to anything declared after it.
    expect(z("#error-box-modal")).toBeGreaterThan(z(".consent-scrim"));
  });
});

// Every dismissal wiring listens on the DOCUMENT, so one Escape reaches all of them: without a
// scrim to read, the modal UNDER the error box closes with it. And the box takes focus when it
// opens, so the modal it interrupted has to get it back.
describe("an error box raised over another modal", () => {
  const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
  const NOTICE = `<div class="licenses-list"><div class="license"><h3>MIT</h3>
    <div class="license-used-by"><li>crate</li></div><pre class="license-text">text</pre></div></div>`;

  const open = (): void => {
    document.body.innerHTML = APP_BODY;
    // The real stylesheet, because the ladder is what decides which scrim is on top — with no
    // style sheet every z-index reads `auto` and DOM order alone answers, which is the tiebreak
    // that produced the defect.
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);
    setLang("en");
    showLicenses(NOTICE);
    showErrorBox("boom");
  };

  afterEach(() => {
    document.body.innerHTML = "";
    document.head.querySelectorAll("style").forEach((s) => s.remove());
  });

  it("closes on Escape without taking the modal underneath with it", () => {
    open();
    expect($("error-box-modal").hidden).toBe(false);
    expect($("licenses-modal").hidden).toBe(false);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect($("error-box-modal").hidden).toBe(true);
    // …and the one it was raised over is still up, still holding the app inert.
    expect($("licenses-modal").hidden).toBe(false);
    expect(($("app") as HTMLElement).inert).toBe(true);
  });

  it("hands focus back to the modal underneath when it closes", () => {
    open();
    expect(document.activeElement).toBe($("error-box-close"));

    ($("error-box-close") as HTMLButtonElement).click();
    // Not the hidden button it left, and not BODY: the control the interrupted modal had.
    expect(document.activeElement).toBe($("licenses-close"));
  });
});
