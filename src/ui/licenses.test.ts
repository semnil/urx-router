// @vitest-environment jsdom

// parseNotice pins the contract between the cargo-about template
// (src-tauri/about.hbs) and the native licenses rendering: families group by
// license name, variants keep their own used-by mapping, and markup in the
// notice arrives as data (text), never as live DOM.

import { describe, it, expect } from "vitest";
import { parseNotice } from "./licenses";

// The template's structure in miniature: two Apache text variants, one MIT.
const NOTICE = `<html><body><main class="container">
  <div class="intro"><h1>urx-router — Third-Party Licenses</h1></div>
  <h2>Overview of licenses:</h2>
  <ul class="licenses-overview"><li><a href="#Apache-2.0">Apache License 2.0</a> (3)</li></ul>
  <h2>All license text:</h2>
  <ul class="licenses-list">
    <li class="license">
      <h3 id="Apache-2.0">Apache License 2.0</h3>
      <h4>Used by:</h4>
      <ul class="license-used-by">
        <li><a href=" https://example.com/a "> alpha 1.0.0 </a></li>
        <li><a href="https://crates.io/crates/beta">beta 2.1.0</a></li>
      </ul>
      <pre class="license-text">
Apache License text, variant one.</pre>
    </li>
    <li class="license">
      <h3 id="Apache-2.0">Apache License 2.0</h3>
      <h4>Used by:</h4>
      <ul class="license-used-by"><li><a href="#">gamma 0.3.0</a></li></ul>
      <pre class="license-text">Apache License text, variant two.</pre>
    </li>
    <li class="license">
      <h3 id="MIT">MIT License</h3>
      <h4>Used by:</h4>
      <ul class="license-used-by"><li><a href="#">delta 4.0.0</a></li></ul>
      <pre class="license-text">MIT License &lt;text&gt; &amp; body.</pre>
    </li>
  </ul>
</main></body></html>`;

describe("parseNotice", () => {
  it("groups variants into families in document order with crate totals", () => {
    const families = parseNotice(NOTICE);
    expect(families.map((f) => f.name)).toEqual(["Apache License 2.0", "MIT License"]);
    const apache = families[0];
    expect(apache.crateCount).toBe(3);
    expect(apache.variants).toHaveLength(2);
    expect(apache.variants[0].crates).toEqual(["alpha 1.0.0", "beta 2.1.0"]);
    expect(apache.variants[1].crates).toEqual(["gamma 0.3.0"]);
    expect(apache.variants[0].text).toBe("Apache License text, variant one.");
  });

  it("decodes entities to plain text (markup arrives as data)", () => {
    const mit = parseNotice(NOTICE)[1];
    expect(mit.variants[0].text).toBe("MIT License <text> & body.");
  });

  it("drops sections without a name or text and reports an empty page as empty", () => {
    expect(parseNotice("<html><body><p>not a notice</p></body></html>")).toEqual([]);
    const broken = NOTICE.replace(/<pre class="license-text">Apache License text, variant two.<\/pre>/, "");
    const families = parseNotice(broken);
    expect(families[0].variants).toHaveLength(1);
  });
});
