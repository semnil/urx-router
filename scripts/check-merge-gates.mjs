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
// `needs:` to fail it.
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
import { fileURLToPath } from "node:url";

// Resolved from this file rather than from the working directory: the same script runs
// from a pnpm script, from a CI step and from a PostToolUse hook, and only the first two
// are guaranteed to start at the repository root. Paths are still REPORTED relative,
// which is what a reader can act on.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOWS = ".github/workflows";
const MANIFEST = ".github/required-checks.json";

const findings = [];
const finding = (where, message) => findings.push(`${where}: ${message}`);

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
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) close(stack.pop(), n);
    const parent = stack[stack.length - 1];
    if (body === "-" || body.startsWith("- ")) {
      parent.items.push(body.slice(1).trim());
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

function readWorkflows() {
  const dir = join(ROOT, WORKFLOWS);
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
        .sort()
    : [];
  if (!files.length) finding(WORKFLOWS, "no workflow files found — this check would pass on an empty tree");
  return files.map((name) => {
    const path = `${WORKFLOWS}/${name}`;
    const root = parse(readFileSync(join(dir, name), "utf8"));
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
    return { path, root, pullRequest: on.children.get("pull_request") ?? null, jobs: jobsNode.children };
  });
}

function checkWorkflows(required) {
  const workflows = readWorkflows();
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
  return { workflows, seen };
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
  // 6. A gate that waits for everything and then fails on nothing is the worst outcome
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

function readManifest() {
  const path = join(ROOT, MANIFEST);
  if (!existsSync(path)) {
    finding(MANIFEST, "missing — the list of required contexts has no source of truth");
    return new Set();
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    finding(MANIFEST, `is not readable JSON: ${err.message}`);
    return new Set();
  }
  const contexts = parsed?.contexts;
  if (!Array.isArray(contexts) || contexts.length === 0) {
    finding(MANIFEST, "`contexts` is missing or empty — nothing would be checked");
    return new Set();
  }
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

// Reported per ruleset rather than as one union: two rulesets requiring different sets is
// itself the thing worth seeing.
function checkRuleset(required) {
  let repo;
  try {
    repo = gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
  } catch (err) {
    finding("gh", `${err.message}\n    --ruleset needs an authenticated gh with admin rights on the repository`);
    return;
  }
  let rulesets;
  try {
    rulesets = JSON.parse(gh(["api", `repos/${repo}/rulesets`]));
  } catch (err) {
    finding("gh", err.message);
    return;
  }
  const active = rulesets.filter((ruleset) => ruleset.target === "branch" && ruleset.enforcement === "active");
  if (!active.length) {
    finding(repo, "no active branch ruleset — nothing is a merge condition");
    return;
  }
  let carrying = 0;
  for (const summary of active) {
    let detail;
    try {
      detail = JSON.parse(gh(["api", `repos/${repo}/rulesets/${summary.id}`]));
    } catch (err) {
      finding("gh", err.message);
      continue;
    }
    const rule = detail.rules?.find((entry) => entry.type === "required_status_checks");
    if (!rule) {
      console.log(`    ruleset "${detail.name}": no required status checks`);
      continue;
    }
    carrying++;
    const live = new Set((rule.parameters?.required_status_checks ?? []).map((check) => check.context));
    for (const context of live) {
      if (!required.has(context)) {
        finding(
          `ruleset "${detail.name}"`,
          `requires \`${context}\`, which ${MANIFEST} does not list — nothing checks that it can report`,
        );
      }
    }
    for (const context of required) {
      if (!live.has(context)) {
        finding(`ruleset "${detail.name}"`, `does not require \`${context}\`, which ${MANIFEST} lists`);
      }
    }
    console.log(`    ruleset "${detail.name}": ${live.size} required context(s)`);
  }
  if (!carrying) finding(repo, "no active branch ruleset requires any status check");
}

// --- report ---------------------------------------------------------------------

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

const required = readManifest();
const { workflows, seen } = checkWorkflows(required);
if (argv.includes("--ruleset")) checkRuleset(required);

if (findings.length) {
  for (const message of findings) console.error(message);
  console.error(`\n${findings.length} finding(s)`);
  process.exit(hook ? 2 : 1);
}
if (hook) process.exit(0);

// The pull-request workflows that contribute nothing are named, not counted: a workflow
// whose result no one has to wait for is a decision, and it should be readable as one.
const prWorkflows = workflows.filter((workflow) => workflow.pullRequest);
const silent = prWorkflows.filter((workflow) => ![...seen.values()].includes(workflow.path));
console.log(
  `OK: ${required.size} required context(s) over ${prWorkflows.length} pull-request workflow(s), ` +
    `all reportable on every pull request`,
);
for (const [context, path] of seen) console.log(`    ${context} <- ${path}`);
if (silent.length) console.log(`    advisory only (no required context): ${silent.map((w) => w.path).join(", ")}`);
