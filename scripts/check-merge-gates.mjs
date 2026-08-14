#!/usr/bin/env node
// Verifies that every status check the branch ruleset requires can actually be reported
// on every pull request.
//
// GitHub's rule, and the whole reason this file exists: a workflow skipped by a TRIGGER
// filter (`on.pull_request.paths`) produces no check run at all, so a required check it
// carries stays "Expected" and the pull request can never merge; a JOB skipped by `if:`
// reports success and blocks nothing. Every path-dependent skip therefore has to live on
// the jobs and never on the trigger. The third case is the quiet one: a job skipped
// because something in its `needs:` failed ALSO reports success, so an aggregating gate
// has to run with `if: always()` and read `needs.*.result` itself rather than lean on
// `needs:` to fail it. The fourth arrived with `concurrency:`: a CANCELLED run reports
// neither success nor failure, so nothing turns red and the pull request merely stops
// being mergeable — which is why a group that cancels has to be keyed per run.
//
//   node scripts/check-merge-gates.mjs            check .github/workflows against the manifest
//   node scripts/check-merge-gates.mjs --ruleset  also diff the manifest against the live branch
//                                                 ruleset (needs `gh` authenticated as an admin)
//   node scripts/check-merge-gates.mjs --hook     check when a Claude Code PostToolUse payload
//                                                 names a workflow file or the manifest
//
// Exits 1 on findings; --hook exits 2 so the message is fed back to Claude.
//
// Zero dependencies, a YAML parser included: ci.yml runs this on a bare setup-node with no
// `pnpm install`. The reader below is not a YAML implementation — it reads the two levels
// these files actually use (events under `on:`, jobs under `jobs:`, and each one's own
// keys) and reports a file it cannot read that way as a finding, rather than passing it
// over with nothing to say.
//
// Known limits, deliberate:
//   - The ruleset is repository state, not a file, and GITHUB_TOKEN cannot read it
//     (`permissions:` has no administration scope), so CI checks the manifest against the
//     workflows and `--ruleset` closes the other half from an admin's own machine.
//   - A context reported by something other than GitHub Actions (Codecov's
//     `codecov/project`, say) has no job to check, so the manifest rejects it by name
//     instead of passing it over.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Resolved from this file rather than from the working directory: the same script runs
// from a pnpm script, from a CI step and from a PostToolUse hook, and only the first two
// are guaranteed to start at the repository root. Paths are still REPORTED relative,
// which is what a reader can act on.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOWS = ".github/workflows";
const MANIFEST = ".github/required-checks.json";

const findings = [];
const finding = (where, message) => findings.push(`${where}: ${message}`);

// Read out of the manifest, and only `--ruleset` reads it back: the workflow side has no
// say in which app reports a job.
let integrationId = null;

// --- the reader ---------------------------------------------------------------

// A "#" only starts a comment outside quotes and after whitespace, so a value like
// '!**/*.md' or a shell line inside a `run: |` block survives intact.
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

const KEY = /^("[^"]+"|'[^']+'|[A-Za-z_][\w.-]*):(?:\s+(.*))?$/;
const unquote = (text) => text.trim().replace(/^(['"])(.*)\1$/, "$2");

// Indentation-only, and shallow by design: block scalars (`run: |`) and step lists land
// under keys nothing here reads, so their contents cannot be mistaken for a job.
//
// A sequence item gets a node of its own even though nothing reads it, and YAML's rule
// that an item may sit at its key's OWN column is why. Popping on `indent <= top.indent`
// the way a mapping key is popped would close `steps:` on its first item, and every step
// key after it would land on the JOB — where `name:` renames the check run and a step's
// `if:` overwrites the job's, since the later `set` wins. The reader then does not fail
// to read the file, which would be honest; it reports a confident diagnosis of a job that
// does not exist.
function parse(text) {
  const lines = text.split("\n");
  const root = { key: "", indent: -1, value: "", children: new Map(), items: [], from: 0, to: lines.length };
  const stack = [root];
  const close = (node, at) => {
    node.to = at;
  };
  for (let n = 0; n < lines.length; n++) {
    const line = stripComment(lines[n]);
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    const isItem = body === "-" || body.startsWith("- ");
    while (stack.length > 1) {
      const top = stack[stack.length - 1];
      // An item closes a sibling item at its own column, but not the key it belongs to.
      const closes = isItem && !top.item ? indent < top.indent : indent <= top.indent;
      if (!closes) break;
      close(stack.pop(), n);
    }
    const parent = stack[stack.length - 1];
    if (isItem) {
      parent.items.push(body.slice(1).trim());
      stack.push({
        key: "-",
        item: true,
        indent,
        value: "",
        children: new Map(),
        items: [],
        from: n,
        to: lines.length,
      });
      continue;
    }
    const match = KEY.exec(body);
    if (!match) continue;
    // `from`/`to` bracket the node's own lines. Nothing structural is read out of them —
    // they exist so a rule that is about a job's STEPS can look at the text, which this
    // reader deliberately does not model.
    const node = {
      key: unquote(match[1]),
      indent,
      value: (match[2] ?? "").trim(),
      children: new Map(),
      items: [],
      from: n,
      to: lines.length,
    };
    parent.children.set(node.key, node);
    stack.push(node);
  }
  root.lines = lines;
  return root;
}

const textOf = (root, node) => root.lines.slice(node.from, node.to).join("\n");

// Accepts the three shapes these files use: `needs: a`, `needs: [a, b]` and a block list.
function listOf(node) {
  if (!node) return [];
  if (node.value.startsWith("[")) {
    return node.value
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map(unquote)
      .filter(Boolean);
  }
  if (node.value) return [unquote(node.value)];
  return node.items.map(unquote);
}

// `if: always()` and `if: ${{ always() }}` are the same job.
const condition = (job) => {
  const node = job.children.get("if");
  if (!node) return null;
  return node.value.replace(/^\$\{\{|\}\}$/g, "").trim();
};

// The check-run name is the job's `name:` when it has one, and the job id otherwise —
// which is what the ruleset matches on.
const contextOf = (id, job) => unquote(job.children.get("name")?.value ?? "") || id;

// --- the workflows ------------------------------------------------------------

function readWorkflowSources() {
  const dir = join(ROOT, WORKFLOWS);
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
        .sort()
    : [];
  return files.map((name) => ({ path: `${WORKFLOWS}/${name}`, text: readFileSync(join(dir, name), "utf8") }));
}

function readWorkflows(sources) {
  if (!sources.length) finding(WORKFLOWS, "no workflow files found — this check would pass on an empty tree");
  return sources.map(({ path, text }) => {
    const root = parse(text);
    const on = root.children.get("on");
    const jobsNode = root.children.get("jobs");
    if (!on || !jobsNode || jobsNode.children.size === 0) {
      finding(path, "could not be read as `on:` + `jobs:` — the checker below cannot speak for this file");
      return { path, pullRequest: null, jobs: new Map() };
    }
    // `on: [push, pull_request]` carries no place to hang a filter, so it is legal — but
    // this reader would take it for "no pull-request trigger" and pass the file over in
    // silence, which is the one outcome a checker must not produce.
    if (on.value.includes("pull_request")) {
      finding(
        path,
        "`on:` is a flow list; write the block form (`on:` then `  pull_request:`) so this checker can read it",
      );
    }
    const pullRequest = on.children.get("pull_request") ?? null;
    // The same reasoning one level down, which is where it actually bites:
    // `pull_request: { paths: [...] }` is a filter, and the reader stores the whole
    // mapping as a VALUE, leaving `children` empty — so every rule below asks an empty map
    // whether a filter is present and is told no. A block-form filter is caught; the same
    // filter in flow form was waved through with "all reportable on every pull request",
    // which is the sentence this file exists to be able to print truthfully.
    if (pullRequest && pullRequest.value) {
      finding(
        path,
        "`pull_request:` carries an inline value; write its filters in block form (`  pull_request:` then `    paths:`) " +
          "so this checker can see them — a filter it cannot see is one it will report as absent",
      );
    }
    return { path, root, pullRequest, jobs: jobsNode.children };
  });
}

function checkWorkflows(workflows, required) {
  const seen = new Map();
  for (const workflow of workflows) {
    if (!workflow.pullRequest) continue;
    for (const [id, job] of workflow.jobs) {
      const context = contextOf(id, job);
      if (!required.has(context)) continue;
      if (seen.has(context)) {
        finding(
          workflow.path,
          `context \`${context}\` is also reported by ${seen.get(context)} — one of them wins, unpredictably`,
        );
        continue;
      }
      seen.set(context, workflow.path);
      checkJob(workflow, id, job, context);
    }
  }
  for (const context of required) {
    if (seen.has(context)) continue;
    finding(
      MANIFEST,
      `\`${context}\` is required but no pull-request workflow reports it — the merge waits for a check that never arrives`,
    );
  }
  return seen;
}

function checkJob(workflow, id, job, context) {
  const where = `${workflow.path} (${id})`;
  // 1. The trigger has to be unfiltered, or the whole workflow — and this context with
  //    it — silently does not exist for the changes the filter excludes.
  for (const key of ["paths", "paths-ignore", "branches", "branches-ignore"]) {
    if (workflow.pullRequest.children.has(key)) {
      finding(
        where,
        `\`on.pull_request.${key}\` skips the whole workflow, so required context \`${context}\` reports nothing at all ` +
          `on an excluded pull request. Move the condition onto the jobs, where a skip reports success`,
      );
    }
  }
  // 1b. `types:` is a filter too, and the quietest one: the default set is opened +
  //     synchronize + reopened, and narrowing it (`types: [opened]`) leaves every later
  //     push to the branch with no run — so the context exists on the first commit and
  //     never on the head that gets merged. Narrowing is legal only by ADDING events.
  const types = listOf(workflow.pullRequest.children.get("types"));
  if (types.length) {
    const missing = ["opened", "synchronize", "reopened"].filter((event) => !types.includes(event));
    if (missing.length) {
      finding(
        where,
        `\`on.pull_request.types\` omits ${missing.join(", ")}, so no run happens for that event and required context ` +
          `\`${context}\` goes missing on the head commit it produces. List the three defaults and add to them`,
      );
    }
  }
  // 2. A matrix job reports one check per combination ("race (1)"), never the bare name.
  if (job.children.get("strategy")?.children.has("matrix")) {
    finding(
      where,
      `required context \`${context}\` is a matrix job, which reports "${context} (…)" per combination and never \`${context}\``,
    );
  }
  // 3. Its own condition would skip it into a green that measured nothing.
  const cond = condition(job);
  if (cond !== null && cond !== "always()") {
    finding(
      where,
      `required context \`${context}\` carries \`if: ${cond}\`; a skipped job reports success, so the condition belongs on the jobs it gates`,
    );
  }
  // 4. `needs:` without `always()` is the quiet hole: the job is skipped when a
  //    dependency fails, and a skipped required check counts as passed.
  const needs = listOf(job.children.get("needs"));
  if (needs.length && cond !== "always()") {
    finding(
      where,
      `required context \`${context}\` has \`needs:\` but not \`if: always()\` — a failed dependency skips it, and a skip reports success`,
    );
  }
  // 5. A required context speaks for its whole workflow: a job it does not wait for is a
  //    job whose failure blocks nothing, which is how a new job joins a workflow and is
  //    never required by anyone.
  const uncovered = [...workflow.jobs.keys()].filter((other) => other !== id && !needs.includes(other));
  if (uncovered.length) {
    finding(
      where,
      `\`${context}\` does not wait for ${uncovered.join(", ")}, so a failure there blocks nothing — add them to \`needs:\` (with \`if: always()\`)`,
    );
  }
  // 6. A cancelled run is the FOURTH way a required context fails to arrive, and the one
  //    the header above had no reason to name until concurrency reached these workflows.
  //    GitHub accepts `success`, `skipped` and `neutral` as a satisfied required check;
  //    `cancelled` is neither that nor a failure, so nothing goes red — the pull request
  //    simply stops being mergeable. A group that cancels therefore has to be one that no
  //    OTHER run reporting the same context on the same commit can join, and the key that
  //    guarantees it is a per-run one. Keyed by the ref instead, a `workflow_dispatch` on
  //    a pull request's branch joins that pull request's own run (CLAUDE.md tells the
  //    operator to make exactly that dispatch), and a push to the default branch joins the
  //    next push — which is how a cancelled CI run on main would leave tag-release.yml's
  //    `conclusion == 'success'` false and a version bump untagged.
  //
  //    Coarse in the same way rule 7 below is: it asks whether `github.run_id` appears in
  //    the key, not what the whole expression evaluates to.
  //    Both levels, because a group on the JOB cancels the same check run a group on the
  //    workflow would.
  for (const [level, node] of [
    ["workflow", workflow.root.children.get("concurrency")],
    ["job", job.children.get("concurrency")],
  ]) {
    if (!node) continue;
    // The flow form (`concurrency: { group: …, cancel-in-progress: true }`) is stored as
    // a VALUE with no children, so every read below would find nothing and this rule
    // would report the safest possible answer about a group it never saw. Refused for
    // the same reason `pull_request:` in flow form is refused above.
    if (node.value) {
      finding(
        where,
        `${level} \`concurrency:\` for \`${context}\` carries an inline value; write it in block form (\`group:\` and ` +
          `\`cancel-in-progress:\` on their own lines) so this checker can see the key — one it cannot see is one it ` +
          `will report as absent`,
      );
      continue;
    }
    const group = node.children.get("group")?.value ?? "";
    const cancel = unquote(node.children.get("cancel-in-progress")?.value ?? "");
    // NOT `=== "true"`. GitHub takes an expression here, and reading `${{ … }}` as "does
    // not cancel" would pass exactly the arrangement this rule exists to refuse. Absent
    // is the documented default of false; anything else counts as cancelling.
    const cancels = cancel !== "" && cancel !== "false";
    if (cancels && !group.includes("github.run_id")) {
      finding(
        where,
        `\`${context}\` comes from a ${level} whose concurrency group \`${group}\` cancels in progress and is not keyed ` +
          `per run — two runs reporting it on one commit share the group, and the cancelled one leaves the context at ` +
          `\`cancelled\`, which satisfies no merge. Key the non-pull-request case on \`github.run_id\``,
      );
    }
  }
  // 7. A gate that waits for everything and then fails on nothing is the worst outcome
  //    here: a required check that is green by construction. The rules above are all
  //    about the job's own keys and cannot see that, because the failing part lives in a
  //    step. This one reads the job's text — coarse on purpose, since the alternative is
  //    a rule that passes an empty gate.
  if (cond === "always()") {
    const body = textOf(workflow.root, job);
    if (!/needs\.\*\.result/.test(body) || !/exit 1/.test(body)) {
      finding(
        where,
        `gate \`${context}\` never reads \`needs.*.result\` or never runs \`exit 1\` — with \`if: always()\` it reports success ` +
          `whatever its dependencies did, which makes it a required check that cannot fail`,
      );
    }
  }
}

// --- the manifest -------------------------------------------------------------

function readManifestSource() {
  const path = join(ROOT, MANIFEST);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function readManifest(source) {
  if (source === null) {
    finding(MANIFEST, "missing — the list of required contexts has no source of truth");
    return new Set();
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    finding(MANIFEST, `is not readable JSON: ${err.message}`);
    return new Set();
  }
  const contexts = parsed?.contexts;
  if (!Array.isArray(contexts) || contexts.length === 0) {
    finding(MANIFEST, "`contexts` is missing or empty — nothing would be checked");
    return new Set();
  }
  // The app a required check must come from. A ruleset entry matches on the provider as
  // well as the name, so the id is half of what the rule says and cannot be left implicit.
  if (!Number.isInteger(parsed.integration_id) || parsed.integration_id <= 0) {
    finding(
      MANIFEST,
      "`integration_id` is missing or not a positive integer — `--ruleset` cannot check who reports a context",
    );
  }
  integrationId = parsed.integration_id;
  for (const context of contexts) {
    if (typeof context !== "string" || !context.trim()) {
      finding(MANIFEST, `\`${JSON.stringify(context)}\` is not a context name`);
    } else if (context.includes("/")) {
      finding(
        MANIFEST,
        `\`${context}\` looks like a third-party check (Codecov and friends); this file only carries contexts a workflow job reports`,
      );
    }
  }
  return new Set(contexts.filter((context) => typeof context === "string"));
}

// --- the live ruleset (--ruleset) ----------------------------------------------

function gh(args) {
  const run = spawnSync("gh", args, { encoding: "utf8", cwd: ROOT });
  if (run.error || run.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${(run.stderr || run.error?.message || "").trim()}`);
  }
  return run.stdout.trim();
}

// A ruleset's include / exclude entries are PATTERNS, not names: GitHub matches them
// against the full ref with Ruby's File.fnmatch under File::FNM_PATHNAME. Comparing them
// as strings reads `exclude: ["refs/heads/ma*"]` as excluding nothing, which is the
// direction that reports a governed branch when the branch is in fact exempt.
//
// Every rule below is measured against Ruby rather than assumed, because three of them
// are not what a JavaScript author would write:
//   - `*` and `?` stop at a `/`, and `?` matches one CHARACTER — `release-?` matches
//     `release-🚀`, which a regex without the `u` flag counts as two.
//   - `**` crosses separators only when it is a whole path segment followed by `/`.
//     `qa**/**/*` matches `qa/foo` because the first `**` shares its segment with `qa`
//     and is therefore an ordinary `*`; a trailing `refs/heads/**` is ordinary too, and
//     does not match `refs/heads/a/b`.
//   - a character class does not match the separator either, so `main[/]extra` does NOT
//     match `main/extra`.
// GitHub additionally documents two things as unsupported, and both are refused rather
// than guessed at: `\` is not a quoting character (a backslash is a literal backslash),
// and `[^…]` complements are not supported (`[!…]` is the negation fnmatch defines).
export class PatternError extends Error {}

const literally = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The first `]` closes the class, even immediately: Ruby does NOT read POSIX's
// leading-`]`-is-literal form here, and measuring it is the only way to know — `[]]x`
// matches neither `]x` nor `x`, because `[]` matches nothing and `]x` is then literal.
// `[!]` is the one degenerate form that matches something: a negated empty class, which
// is any single character the separator rule still excludes.
function classEnd(pattern, start) {
  let i = start + 1;
  if (pattern[i] === "!" || pattern[i] === "^") i++;
  for (; i < pattern.length; i++) if (pattern[i] === "]") return i;
  return -1;
}

export function refMatches(pattern, ref) {
  if (pattern === "~ALL" || pattern === "~DEFAULT_BRANCH") return true;
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      const ownSegment = i === 0 || pattern[i - 1] === "/";
      if (ownSegment && pattern[i + 1] === "*" && pattern[i + 2] === "/") {
        out += "(?:[^/]+/)*";
        i += 2;
      } else {
        while (pattern[i + 1] === "*") i++;
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "[") {
      const end = classEnd(pattern, i);
      // An unterminated `[` is not a literal bracket: Ruby matches nothing at all with it,
      // `"a["` included. Measured, because reading it as a literal is the natural guess.
      if (end === -1) return false;
      let body = pattern.slice(i + 1, end);
      if (body.startsWith("^")) {
        throw new PatternError("GitHub documents `[^…]` complements as unsupported");
      }
      const negated = body.startsWith("!");
      if (negated) body = body.slice(1);
      // Guarded rather than rewritten: the separator has to be impossible for both a
      // plain class and a negated one, and a lookahead says that once.
      // A backslash is literal here too, and POSIX lets the body lead with `]`.
      out += `(?!/)[${negated ? "^" : ""}${body.replace(/[\\\]]/g, "\\$&")}]`;
      i = end;
    } else {
      out += literally(ch);
    }
  }
  let expression;
  try {
    // `u` so that `[^/]` and `?` count code points rather than UTF-16 units.
    expression = new RegExp(`^${out}$`, "u");
  } catch (err) {
    throw new PatternError(`it does not compile as a pattern (${err.message})`);
  }
  return expression.test(ref);
}

// The gh half. Everything it learns is handed to compareRulesets, which is where the
// judgement lives and is the half a test can drive.
function readRulesets() {
  let repo;
  let defaultBranch;
  try {
    const view = JSON.parse(gh(["repo", "view", "--json", "nameWithOwner,defaultBranchRef"]));
    repo = view.nameWithOwner;
    defaultBranch = view.defaultBranchRef?.name;
  } catch (err) {
    finding("gh", `${err.message}\n    --ruleset needs an authenticated gh with admin rights on the repository`);
    return null;
  }
  if (!defaultBranch) {
    finding("gh", "could not read the repository's default branch — cannot tell which ruleset governs a merge");
    return null;
  }
  let rulesets;
  try {
    rulesets = JSON.parse(gh(["api", `repos/${repo}/rulesets`]));
  } catch (err) {
    finding("gh", err.message);
    return null;
  }
  const active = rulesets.filter((ruleset) => ruleset.target === "branch" && ruleset.enforcement === "active");
  if (!active.length) {
    finding(repo, "no active branch ruleset — nothing is a merge condition");
    return null;
  }
  const details = [];
  for (const summary of active) {
    try {
      details.push(JSON.parse(gh(["api", `repos/${repo}/rulesets/${summary.id}`])));
    } catch (err) {
      finding("gh", err.message);
    }
  }
  return { repo, defaultBranch, details };
}

// Reported per ruleset rather than as one union: two rulesets requiring different sets is
// itself the thing worth seeing. Returns the lines to print; findings go to the list.
function compareRulesets({ repo, defaultBranch, details }, required, integrationId) {
  const notes = [];
  let carrying = 0;
  for (const detail of details) {
    const rule = detail.rules?.find((entry) => entry.type === "required_status_checks");
    if (!rule) {
      notes.push(`    ruleset "${detail.name}": no required status checks`);
      continue;
    }
    const where = `ruleset "${detail.name}"`;
    // Which refs a ruleset governs is as load-bearing as what it requires. A rule aimed at
    // some other branch pattern satisfies every comparison below while leaving the branch
    // that matters ungated — so it is not counted as carrying anything.
    const refName = detail.conditions?.ref_name ?? {};
    const include = refName.include ?? [];
    const exclude = refName.exclude ?? [];
    // Every entry is evaluated, not just up to the first match: a pattern this checker
    // cannot decide has to be named even when something before it already answered.
    let undecidable = null;
    const governs = (ref) => {
      try {
        return refMatches(ref, `refs/heads/${defaultBranch}`);
      } catch (err) {
        undecidable ??= `\`${ref}\` — ${err.message}`;
        return false;
      }
    };
    const covers = include.map(governs).some(Boolean) && !exclude.map(governs).some(Boolean);
    if (undecidable) {
      finding(
        where,
        `carries a ref pattern this checker will not guess at: ${undecidable}. Decide by hand whether it governs ` +
          `${defaultBranch}, or write the condition in a form fnmatch defines`,
      );
      continue;
    }
    if (!covers) {
      finding(
        where,
        `requires ${rule.parameters?.required_status_checks?.length ?? 0} status check(s) but does not govern ` +
          `${defaultBranch} (include: ${include.join(", ") || "none"}; exclude: ${exclude.join(", ") || "none"}) — ` +
          `a merge to ${defaultBranch} waits for none of them`,
      );
      continue;
    }
    carrying++;
    const entries = rule.parameters?.required_status_checks ?? [];
    const live = new Map(entries.map((check) => [check.context, check.integration_id]));
    for (const [context, appId] of live) {
      if (!required.has(context)) {
        finding(where, `requires \`${context}\`, which ${MANIFEST} does not list — nothing checks that it can report`);
        continue;
      }
      // A name alone is not the rule. An entry pinned to the wrong app is satisfied by
      // nothing this repository can produce — the check goes green and the merge stays
      // blocked, with the two halves of the reason in different places. An entry pinned to
      // no app is the opposite hazard and quieter: any app reporting that name counts.
      if (appId === undefined || appId === null) {
        finding(
          where,
          `requires \`${context}\` from any provider — pin \`integration_id\` to ${integrationId} so only GitHub Actions can satisfy it`,
        );
      } else if (integrationId !== null && appId !== integrationId) {
        finding(
          where,
          `requires \`${context}\` from app ${appId}, but a workflow job reports it as app ${integrationId} — that rule can never be satisfied`,
        );
      }
    }
    for (const context of required) {
      if (!live.has(context)) {
        finding(where, `does not require \`${context}\`, which ${MANIFEST} lists`);
      }
    }
    notes.push(`    ${where}: ${live.size} required context(s)`);
  }
  if (!carrying) finding(repo, "no active branch ruleset requires any status check");
  return notes;
}

// --- one run ---------------------------------------------------------------------

// The whole judgement, with every read already done by the caller. The CLI below is the
// only thing that touches the filesystem or gh; this is what scripts/check-merge-gates.test.mjs
// drives, so the tests exercise the composition and not a paraphrase of it.
export function inspect({ workflowSources, manifestSource, ruleset = null }) {
  findings.length = 0;
  const required = readManifest(manifestSource);
  const workflows = readWorkflows(workflowSources);
  const seen = checkWorkflows(workflows, required);
  const notes = ruleset ? compareRulesets(ruleset, required, integrationId) : [];
  return { findings: findings.slice(), required, workflows, seen, notes };
}

// --- the command -----------------------------------------------------------------

// Guarded so the module can be imported by a test without running: everything above is
// pure or explicitly the gh half, and only this part reads the tree and exits.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const argv = process.argv.slice(2);
  const hook = argv.includes("--hook");

  if (hook) {
    let file;
    try {
      file = JSON.parse(readFileSync(0, "utf8"))?.tool_input?.file_path;
    } catch {
      process.exit(0);
    }
    const rel = (file ?? "").split("\\").join("/");
    const relevant = /\.github\/workflows\/[^/]+\.ya?ml$/.test(rel) || rel.endsWith(MANIFEST);
    if (!relevant) process.exit(0);
  }

  const manifestSource = readManifestSource();
  const workflowSources = readWorkflowSources();
  // Read before inspect(), which clears the list — so a gh failure is carried across and
  // reported alongside the rest rather than being dropped by the reset.
  const ruleset = argv.includes("--ruleset") ? readRulesets() : null;
  const pending = findings.slice();
  const run = inspect({ workflowSources, manifestSource, ruleset });
  const all = [...pending, ...run.findings];

  if (all.length) {
    for (const message of all) console.error(message);
    console.error(`\n${all.length} finding(s)`);
    process.exit(hook ? 2 : 1);
  }
  if (hook) process.exit(0);

  for (const note of run.notes) console.log(note);
  // The pull-request workflows that contribute nothing are named, not counted: a workflow
  // whose result no one has to wait for is a decision, and it should be readable as one.
  const prWorkflows = run.workflows.filter((workflow) => workflow.pullRequest);
  const silent = prWorkflows.filter((workflow) => ![...run.seen.values()].includes(workflow.path));
  console.log(
    `OK: ${run.required.size} required context(s) over ${prWorkflows.length} pull-request workflow(s), ` +
      `all reportable on every pull request`,
  );
  for (const [context, path] of run.seen) console.log(`    ${context} <- ${path}`);
  if (silent.length) console.log(`    advisory only (no required context): ${silent.map((w) => w.path).join(", ")}`);
}
