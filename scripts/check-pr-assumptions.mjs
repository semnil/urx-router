// The pull request template's assumptions field, held to what it is for.
//
// The field declares what a change RESTS on and nobody has observed. What it must not
// hold is an observation this side could have taken: writing one there reads as a
// declaration and merges as a resolution, and the body is gone from view the moment it
// does — a reader looking for the item afterwards has the repository, and the body is
// outside it.
//
// The two are hard to separate in prose and easy to separate by DECLARATION, which is
// what this asks for: an assumption names the external thing its observation needs —
// `[hardware]` a reading off the unit, `[operator]` their own hands, eyes or cursor,
// `[other-checkout]` the machine this one is not. An item that needs none of the three
// has no tag to write, so leaving it in the field is a false statement rather than a
// silence. Whether a tag is TRUE is a judgement, the same way the message catalog's
// dev/fixed/tr markers are: this asks that one was made.
//
// Narrow on purpose. What it reads is what someone WROTE — the items under the field, and
// an answer separated from the label by a colon — and not the tick beside it, which is
// independent of them. "none" is the answer the template already offers, an untouched
// template lists nothing, and a body carrying no such field at all — an external
// contributor writing their own — is not this check's business.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The three external dependencies an observation can have. */
const TAGS = ["[hardware]", "[operator]", "[other-checkout]"];

/** The field's own label, matched from its start so the trailing guidance can change.
 *  The tick is matched but NOT consulted: what someone wrote and whether they ticked the
 *  box beside it are independent, and reading the tick as the question let a field listing
 *  an untagged item pass on a box nobody had ticked. */
const LABEL = /^- \[[ xX]\]\s*Assumptions this PR rests on/;

/** An answer that claims nothing. */
const EMPTY = /^(none|none\.|無し|なし)$/i;

/**
 * The assumption items a body lists, or null when the field is absent altogether. An item
 * is a nested list entry under the field; a field answered on its own line carries that
 * answer as one item, which is what the trailing colon separates from the label. The
 * template's own line ends without one, so an untouched template lists nothing.
 */
export function assumptionItems(body) {
  const lines = body.split(/\r?\n/);
  const at = lines.findIndex((l) => LABEL.test(l));
  if (at < 0) return null;

  // The block runs to the next top-level list item or heading: the field is the last
  // entry of its list, so its continuation is everything indented under it.
  const block = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^(#{1,6} |- \[[ xX]\]|<!--)/.test(l)) break;
    block.push(l);
  }

  const items = [];
  let current = null;
  for (const l of block) {
    const nested = /^\s+[-*]\s+(.*)$/.exec(l);
    if (nested) {
      if (current !== null) items.push(current);
      current = nested[1];
    } else if (!l.trim()) {
      // A blank line ends the item. Prose written under the field belongs to the field
      // and not to its last entry — without this, a note after the list is read as part
      // of whatever item happened to come before it.
      if (current !== null) items.push(current);
      current = null;
    } else if (current !== null) {
      current += ` ${l.trim()}`;
    }
  }
  if (current !== null) items.push(current);

  // An answer written on the label's own line, which a COLON separates from the label.
  // Taken from anything after the label instead, the template's own trailing wording read
  // as an answer and an untouched template was a finding.
  const colon = lines[at].indexOf(":");
  const inline = colon < 0 ? "" : lines[at].slice(colon + 1).trim();
  if (inline) items.unshift(inline);
  return items;
}

/** Every listed assumption that names none of the three, in the order they appear. */
export function untagged(body) {
  const items = assumptionItems(body);
  if (items === null) return [];
  const text = items
    .join(" ")
    .replace(/[*_~`]/g, "")
    .trim();
  if (!items.length || EMPTY.test(text)) return [];
  return items.filter((item) => {
    const bare = item.replace(/[*_~`]/g, "").trim();
    if (EMPTY.test(bare)) return false;
    return !TAGS.some((t) => item.toLowerCase().includes(t));
  });
}

function main() {
  const argv = process.argv.slice(2);
  const fileAt = argv.indexOf("--file");
  const body = fileAt >= 0 ? readFileSync(argv[fileAt + 1], "utf8") : (process.env.PR_BODY ?? "");
  if (!body.trim()) {
    // A push, or a body nobody wrote. Nothing is claimed, so nothing is refused.
    console.log("OK: no pull request body to read");
    return;
  }
  const bad = untagged(body);
  if (!bad.length) {
    console.log("OK: every listed assumption names what its observation needs");
    return;
  }
  for (const item of bad) console.error(`untagged assumption: ${item.slice(0, 160)}`);
  console.error(
    `\n${bad.length} assumption(s) name none of ${TAGS.join(" / ")}.\n` +
      "An observation needing none of those is one to take before opening the pull request:\n" +
      "take it and drop the line, or tag the dependency that stops you.",
  );
  process.exitCode = 1;
}

/** Whether this file is the program. Node stamps `import.meta.url` with the resolved path
 *  and leaves `process.argv[1]` as it was typed, so a run reached through a symlink
 *  compares unequal as strings and would exit 0 having read nothing. */
function isEntry() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isEntry()) main();
