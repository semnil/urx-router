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
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unsettled, untagged } from "./check-pr-assumptions.mjs";

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

  it("exits non-zero on it, and zero on the same item tagged and settled", () => {
    expect(run(body(deferred)).status).toBe(1);
    const tagged = deferred.replace("  - **The", "  - **[hardware]** The");
    expect(run(body(`${tagged}\n    - Result: the drain reported a 40 ms gap.`)).status).toBe(0);
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

// A tagged item names what its observation needs; it is settled with the operator before the
// pull request is opened all the same, and the entry under it says so. A tag alone describes
// a deferral rather than ending one.
describe("how a tagged item was settled", () => {
  const tagged =
    "- [x] Assumptions this PR rests on are listed here:\n" +
    "  - [hardware] whether the unit announces the recorder's own change.";

  it("refuses a tagged item with nothing under it", () => {
    expect(unsettled(body(tagged))).toEqual(["[hardware] whether the unit announces the recorder's own change."]);
    const said = run(body(tagged));
    expect(said.status).toBe(1);
    expect(said.stderr).toContain("unsettled assumption");
  });

  it("passes the same item with a Result entry under it", () => {
    const text = body(`${tagged}\n    - **Result** (URX44V, System 1.3.1.0): it does, one notify per move.`);
    expect(unsettled(text)).toEqual([]);
    expect(run(text).status).toBe(0);
  });

  it("passes the same item left open on the operator's quoted instruction", () => {
    const text = body(`${tagged}\n    - Left open by the operator: "open it with this unmeasured".`);
    expect(unsettled(text)).toEqual([]);
    expect(run(text).status).toBe(0);
  });

  // A result written as a sentence of the item's own text, or under a sibling, settles
  // nothing about this item: what is asked for is an entry under it.
  it("does not read a result from the item's own text or from a sibling", () => {
    expect(unsettled(body(`${tagged} Result: it does.`))).toHaveLength(1);
    const sibling = body(`${tagged}\n` + "  - [operator] a second item.\n" + "    - Result: settled.");
    expect(unsettled(sibling)).toEqual(["[hardware] whether the unit announces the recorder's own change."]);
  });

  it("does not take some other entry under the item for a result", () => {
    expect(unsettled(body(`${tagged}\n    - What would settle it: a front-panel move.`))).toHaveLength(1);
  });
});

describe("bodies it is not about", () => {
  it("passes a body with no such field, which an external contributor writes", () => {
    expect(untagged("# Summary\n\nFixes a typo.\n")).toEqual([]);
    expect(run("# Summary\n\nFixes a typo.\n").status).toBe(0);
  });

  it("passes an empty body, which is a pull request whose author wrote none", () => {
    expect(run("").status).toBe(0);
  });

  // Being told nothing is a different state from being handed an empty body, and the
  // command has to say so rather than print a verdict: a contributor running it out of
  // CONTRIBUTING would otherwise read that success as an answer about the body they are
  // about to write, and meet the check for the first time on the pull request.
  it("refuses a run given no body at all, naming both ways to give it one", () => {
    const bare = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "PR_BODY")),
    });
    expect(bare.status).toBe(1);
    expect(bare.stderr).toContain("--file");
    expect(bare.stderr).toContain("PR_BODY");
  });

  it("reads the body out of a file, which is how it is run by hand", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pr-body-")), "body.md");
    writeFileSync(path, "- [x] Assumptions this PR rests on are listed here:\n  - a guess nobody measured.\n");
    const said = spawnSync(process.execPath, [SCRIPT, "--file", path], {
      encoding: "utf8",
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "PR_BODY")),
    });
    expect(said.status).toBe(1);
    writeFileSync(path, "- [x] Assumptions this PR rests on are listed here:\n  - none\n");
    expect(spawnSync(process.execPath, [SCRIPT, "--file", path], { encoding: "utf8" }).status).toBe(0);
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

  // A tagged item settled after the merge carries its result as an entry under it. Read as
  // an item of its own, that result is an untagged assumption, and the edit that records
  // the settlement turns the merged pull request's check red.
  it("reads an entry indented under an item as part of that item", () => {
    const text = body(
      "- [x] Assumptions this PR rests on are listed here:\n" +
        "  - [operator] The draft's signatures name the version its manifest announces.\n" +
        "    - Result (after publish): both read the same version.\n" +
        "  - [hardware] A second item at the field's own indentation.\n" +
        "    - Result: settled as well.",
    );
    expect(untagged(text)).toEqual([]);
    expect(run(text).status).toBe(0);
  });

  it("does not let a sub-entry's tag vouch for an untagged item", () => {
    const text = body(
      "- [x] Assumptions this PR rests on are listed here:\n" +
        "  - the window is a guess nobody measured.\n" +
        "    - [hardware] a note that names a tag.\n" +
        "  - a second untagged item after the sub-entry.",
    );
    expect(untagged(text)).toEqual([
      "the window is a guess nobody measured.",
      "a second untagged item after the sub-entry.",
    ]);
  });

  // A result is often set off from its item by a blank line, and a second result from the
  // first. The blank line ends the item's text, not its hold on what is indented under it.
  it("reads a result as part of its item across blank lines", () => {
    const text = body(
      "- [x] Assumptions this PR rests on are listed here:\n" +
        "  - [operator] The draft's signatures name the version its manifest announces.\n" +
        "\n" +
        "    - Result (after publish): both read the same version.\n" +
        "\n" +
        "    - Result (a week on): an installed copy took the update.\n" +
        "\n" +
        "  - an untagged item after the results.",
    );
    expect(untagged(text)).toEqual(["an untagged item after the results."]);
    expect(run(text).status).toBe(1);
  });

  // A line wrapped back under the item's own dash, with no blank line before it, continues
  // the item's text, so the tag on it is the item's.
  it("reads a line wrapped left of the item's text as part of that item", () => {
    const text = body(
      "- [x] Assumptions this PR rests on are listed here:\n" +
        "  - The installer version needs a look at the packaged build,\n" +
        "  which only the other machine has [other-checkout].",
    );
    expect(untagged(text)).toEqual([]);
  });

  // CommonMark makes an entry a child only from the column the item's text starts at, so an
  // entry one column deeper than its neighbour is still its sibling, and still an assumption.
  it("refuses an untagged sibling indented a column deeper than the item before it", () => {
    const text = body(
      "- [x] Assumptions this PR rests on are listed here:\n" +
        "  - [operator] The installer version needs visual confirmation.\n" +
        "   - The timeout is still an unmeasured guess.",
    );
    expect(untagged(text)).toEqual(["The timeout is still an unmeasured guess."]);
    expect(run(text).status).toBe(1);
  });
});
