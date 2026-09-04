// The assumptions field's checker, shown each arrangement it refuses beside the good one
// it is a mutation of — a rule that fires on everything is as useless as one that fires on
// nothing, and this one sits on a field every pull request fills in.
//
// The shapes that must stay clean are the ones the template already offers: an unticked
// box, "none", and an item that names the external thing its observation needs. The shape
// that must fail is the one this exists for — a ticked box listing work this side could
// have done, which is what a body carries when a measurement was deferred instead of taken.
//
// It also drives the command line, since the module's own function passing says nothing
// about whether the program exits non-zero: the check runs in a workflow, and an exit code
// is the whole of what that workflow reads.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { untagged } from "./check-pr-assumptions.mjs";

const SCRIPT = fileURLToPath(new URL("./check-pr-assumptions.mjs", import.meta.url));

/** A body with the field answered as given, in the template's own shape. */
const body = (field) => `# Summary

Something changed.

## Testing

- [ ] Verified on hardware — model and System firmware:
- [ ] Nothing beyond the checks
${field}

## Checklist

- [ ] E2E coverage added for new behavior
`;

const run = (text) =>
  spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env: { ...process.env, PR_BODY: text } });

describe("what the field may hold", () => {
  it("passes a box with nothing written under it, ticked or not", () => {
    for (const tick of [" ", "x"]) {
      const text = body(
        `- [${tick}] Assumptions this PR rests on are listed here, each with what would settle it — or "none"`,
      );
      expect(untagged(text)).toEqual([]);
    }
  });

  // The shipped template, verbatim. It is the one body every pull request starts from, so
  // a rule that fires on it fires on everything.
  it("passes the template as it ships", () => {
    const template = readFileSync(new URL("../.github/PULL_REQUEST_TEMPLATE.md", import.meta.url), "utf8");
    expect(untagged(template)).toEqual([]);
    expect(run(template).status).toBe(0);
  });

  it('passes "none", the answer the template offers', () => {
    const text = body('- [x] Assumptions this PR rests on are listed here — or "none":\n  - none');
    expect(untagged(text)).toEqual([]);
  });

  it("passes an item that names what its observation needs", () => {
    const text = body(
      "- [x] Assumptions this PR rests on are listed here:\n" +
        "  - **[hardware]** whether the unit announces the recorder's own change is unmeasured;\n" +
        "    a front-panel move with a subscription open settles it.",
    );
    expect(untagged(text)).toEqual([]);
  });

  it("passes each of the three tags", () => {
    for (const tag of ["[hardware]", "[operator]", "[other-checkout]"]) {
      const text = body(`- [x] Assumptions this PR rests on are listed here:\n  - ${tag} something outside this side.`);
      expect(untagged(text)).toEqual([]);
    }
  });
});

describe("what it refuses", () => {
  // The arrangement this exists for: an observation needing nothing external, declared
  // rather than taken. It reads as careful — it even says what would settle it — which is
  // why no reader catches it and why the check asks for the dependency instead.
  const deferred =
    "- [x] Assumptions this PR rests on are listed here:\n" +
    "  - **The teardown drain's quiet window is a chosen value, not a derived one.** What\n" +
    "    would settle it: instrumenting the drain to report the largest gap it bridges.";

  it("refuses an item that names no external dependency", () => {
    expect(untagged(body(deferred))).toHaveLength(1);
  });

  it("exits non-zero on it, and zero on the same item tagged", () => {
    expect(run(body(deferred)).status).toBe(1);
    expect(run(body(deferred.replace("  - **The", "  - **[hardware]** The"))).status).toBe(0);
  });

  it("reports every untagged item, not only the first", () => {
    const text = body(
      "- [x] Assumptions this PR rests on are listed here:\n" +
        "  - [hardware] one that names its dependency.\n" +
        "  - a second that does not.\n" +
        "  - a third that does not either.",
    );
    expect(untagged(text)).toHaveLength(2);
  });

  // The tick and what was written beside it are independent. Read as the question, an
  // unticked box hid every item under it — which is the shape a body has when someone
  // wrote the answer and did not tick, and the answer is what the check is about.
  it("refuses an untagged item under a box nobody ticked", () => {
    const text = body(
      "- [ ] Assumptions this PR rests on are listed here:\n" + "  - the teardown window is still an unmeasured guess.",
    );
    expect(untagged(text)).toHaveLength(1);
    expect(run(text).status).toBe(1);
  });

  it("refuses an answer written inline rather than as a list", () => {
    const text = body("- [x] Assumptions this PR rests on are listed here: the window is a guess for now.");
    expect(untagged(text)).toHaveLength(1);
  });
});

describe("bodies it is not about", () => {
  it("passes a body with no such field, which an external contributor writes", () => {
    expect(untagged("# Summary\n\nFixes a typo.\n")).toEqual([]);
    expect(run("# Summary\n\nFixes a typo.\n").status).toBe(0);
  });

  it("passes an empty body, which is what a push has", () => {
    expect(run("").status).toBe(0);
  });

  // The field is the last entry of its list, so its block ends at the next heading. Without
  // that bound the whole checklist below reads as assumptions and every unticked box there
  // is an untagged item.
  it("stops at the next heading rather than swallowing the checklist", () => {
    const text = body("- [x] Assumptions this PR rests on are listed here:\n  - none");
    expect(untagged(text)).toEqual([]);
  });

  // Prose written under the field belongs to the field, not to its last entry. Read as a
  // continuation it turns a "none" answer into an item with no tag, which is what a body
  // carrying a note beside its answer looks like.
  it("ends an item at a blank line rather than absorbing the note after it", () => {
    const text = body(
      "- [x] Assumptions this PR rests on are listed here:\n" +
        "  - none\n" +
        "\n" +
        "**A note.** Something worth recording beside the answer, at no indentation.",
    );
    expect(untagged(text)).toEqual([]);
  });
});
