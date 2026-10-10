// The document hook's reach into the private ledgers. `scripts/md-hook.sh` runs the anchor check
// of the reference/ in this repository's main checkout when the EDITED FILE sits in it, from the
// main checkout and from any worktree of it alike, and nothing for a file anywhere else. Driven
// against a throwaway checkout — the real hook beside stand-ins for the public checkers, a private
// reference/ carrying a stand-in for the anchor check, and a git worktree of that checkout, which
// has no reference/ of its own because the directory is ignored. The worktree is the placement a
// session normally works from, and the hook that runs there is the worktree's own copy.
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("./md-hook.sh", import.meta.url));
const HOOK_NODE = fileURLToPath(new URL("./hook-node.sh", import.meta.url));
const PUBLIC = ["check-md-tables", "check-assets-index", "check-merge-gates", "check-comment-provenance"];
const PASSING = "process.exit(0);\n";
const REFUSING_PUBLIC = 'process.stderr.write("public check refused\\n"); process.exit(2);\n';
// A checker that dies rather than answering: node exits 1 on an uncaught throw.
const CRASHING = (what) => `throw new Error("${what} crashed");\n`;
// The anchor check's own contract, reduced: it reads the payload, ignores anything that is not
// one of its ledgers, and checks the ledger in ITS OWN checkout — so the root it names is the
// checkout the hook delegated to.
const ANCHORS = `import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const file = JSON.parse(readFileSync(0, "utf8")).tool_input?.file_path ?? "";
if (!file.endsWith("work/e2e-flakes.md")) process.exit(0);
if (readFileSync(join(root, "work", "e2e-flakes.md"), "utf8").includes("### 決着条件")) process.exit(0);
process.stderr.write("ledger-anchors: broken ledger in " + root + "\\n");
process.exit(2);
`;
const VALID_LEDGER = "## `e2e/a.spec.ts` — case\n\n### 決着条件\n\nA run that settles it.\n";
const BROKEN_LEDGER = "## `e2e/a.spec.ts` — case\n\nNo settlement condition.\n";

const made = [];
afterAll(() => {
  for (const root of made) rmSync(root, { recursive: true, force: true });
});

function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/**
 * A main checkout holding the real hook and the public stand-ins, optionally a private
 * reference/ with the anchor stand-in and a ledger, and a git worktree of it.
 */
function checkout({ reference, ledger = BROKEN_LEDGER, refusingPublic = false, publics = {}, anchors = ANCHORS }) {
  // Canonical, since the anchor check names its root by the real path node resolved it to.
  const main = realpathSync(scratch("md-hook-main-"));
  const config = join(scratch("md-hook-git-"), "empty-gitconfig");
  writeFileSync(config, "");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_SYSTEM: config,
    GIT_CONFIG_NOSYSTEM: "1",
    LC_ALL: "C",
    LANG: "C",
  };
  const git = (...args) => execFileSync("git", args, { cwd: main, encoding: "utf8", env });
  mkdirSync(join(main, "scripts"));
  mkdirSync(join(main, "src"));
  copyFileSync(HOOK, join(main, "scripts", "md-hook.sh"));
  copyFileSync(HOOK_NODE, join(main, "scripts", "hook-node.sh"));
  for (const name of PUBLIC) {
    const body = publics[name] ?? (refusingPublic && name === "check-md-tables" ? REFUSING_PUBLIC : PASSING);
    writeFileSync(join(main, "scripts", `${name}.mjs`), body);
  }
  writeFileSync(join(main, "src", "a.ts"), "export {};\n");
  writeFileSync(join(main, ".gitignore"), "/reference\n/worktree\n");
  if (reference) {
    mkdirSync(join(main, "reference", "scripts"), { recursive: true });
    mkdirSync(join(main, "reference", "work"));
    writeFileSync(join(main, "reference", "scripts", "check-ledger-anchors.mjs"), anchors);
    writeFileSync(join(main, "reference", "work", "e2e-flakes.md"), ledger);
  }
  git("init", "-q", "-b", "main", ".");
  git("add", ".gitignore", "scripts", "src");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
  const worktree = join(main, "worktree");
  git("worktree", "add", "-q", "-b", "work", worktree);
  return { main, worktree };
}

/** The hook of checkout `from`, handed an edit of `file`, as the harness runs it. */
const run = (from, file) =>
  spawnSync("sh", [join(from, "scripts", "md-hook.sh")], {
    input: JSON.stringify({ tool_name: "Edit", cwd: from, tool_input: { file_path: file } }),
    encoding: "utf8",
    env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` },
  });

const ledgerOf = (main) => join(main, "reference", "work", "e2e-flakes.md");

describe("the document hook and the private ledgers", () => {
  it("refuses a broken ledger edited from the checkout that holds reference/", () => {
    const { main } = checkout({ reference: true });
    const res = run(main, ledgerOf(main));
    expect(res.stderr).toContain(`ledger-anchors: broken ledger in ${join(main, "reference")}`);
    expect(res.status).toBe(2);
  });

  it("refuses the same ledger edited from a worktree, whose own tree has no reference/", () => {
    const { main, worktree } = checkout({ reference: true });
    const res = run(worktree, ledgerOf(main));
    expect(res.stderr).toContain(`ledger-anchors: broken ledger in ${join(main, "reference")}`);
    expect(res.status).toBe(2);
  });

  it("passes a valid ledger from either placement", () => {
    const { main, worktree } = checkout({ reference: true, ledger: VALID_LEDGER });
    for (const from of [main, worktree]) {
      const res = run(from, ledgerOf(main));
      expect(res.stderr).not.toContain("ledger-anchors");
      expect(res.status).toBe(0);
    }
  });

  it("passes an ordinary source edit beside a broken ledger", () => {
    const { main, worktree } = checkout({ reference: true });
    for (const from of [main, worktree]) {
      const res = run(from, join(from, "src", "a.ts"));
      expect(res.stderr).not.toContain("ledger-anchors");
      expect(res.status).toBe(0);
    }
  });

  it("passes in a clone with no private checkout", () => {
    const { main, worktree } = checkout({ reference: false });
    for (const from of [main, worktree]) {
      const res = run(from, ledgerOf(main));
      expect(res.stderr).toBe("");
      expect(res.status).toBe(0);
    }
  });

  it("runs no anchor check for a ledger-shaped file outside reference/, nor a checker found beside it", () => {
    // The main checkout's own ledger is broken, so running its checker for this edit refuses too.
    const { main, worktree } = checkout({ reference: true });
    const elsewhere = realpathSync(scratch("md-hook-elsewhere-"));
    mkdirSync(join(elsewhere, "scripts"));
    mkdirSync(join(elsewhere, "work"));
    writeFileSync(
      join(elsewhere, "scripts", "check-ledger-anchors.mjs"),
      'process.stderr.write("planted checker ran\\n"); process.exit(2);\n',
    );
    writeFileSync(join(elsewhere, "work", "e2e-flakes.md"), BROKEN_LEDGER);
    for (const from of [main, worktree]) {
      const res = run(from, join(elsewhere, "work", "e2e-flakes.md"));
      expect(res.stderr).not.toContain("planted checker ran");
      expect(res.stderr).not.toContain("ledger-anchors");
      expect(res.status).toBe(0);
    }
  });

  it("still carries a public check's refusal out", () => {
    const { main, worktree } = checkout({ reference: true, ledger: VALID_LEDGER, refusingPublic: true });
    for (const from of [main, worktree]) {
      const res = run(from, join(from, "src", "a.ts"));
      expect(res.stderr).toContain("public check refused");
      expect(res.status).toBe(2);
    }
  });

  // Only an exit 2 reaches Claude, so a refusal has to survive whatever the checks after it, or
  // before it, return — a crash is exit 1, which the harness shows the operator and not Claude.
  it("returns a refusal even when a later check crashes", () => {
    const { main } = checkout({
      reference: true,
      ledger: VALID_LEDGER,
      refusingPublic: true,
      publics: { "check-comment-provenance": CRASHING("provenance") },
    });
    const res = run(main, join(main, "src", "a.ts"));
    expect(res.stderr).toContain("public check refused");
    expect(res.stderr).toContain("provenance crashed");
    expect(res.status).toBe(2);
  });

  it("returns a refusal even when an earlier check crashed", () => {
    const { main } = checkout({
      reference: true,
      ledger: VALID_LEDGER,
      publics: { "check-md-tables": CRASHING("tables"), "check-comment-provenance": REFUSING_PUBLIC },
    });
    const res = run(main, join(main, "src", "a.ts"));
    expect(res.stderr).toContain("tables crashed");
    expect(res.stderr).toContain("public check refused");
    expect(res.status).toBe(2);
  });

  it("returns a public check's refusal when the anchor check crashes after it", () => {
    const { main, worktree } = checkout({ reference: true, refusingPublic: true, anchors: CRASHING("anchors") });
    for (const from of [main, worktree]) {
      const res = run(from, ledgerOf(main));
      expect(res.stderr).toContain("public check refused");
      expect(res.stderr).toContain("anchors crashed");
      expect(res.status).toBe(2);
    }
  });

  it("returns a crash as a non-zero status when nothing refused", () => {
    const { main } = checkout({
      reference: true,
      ledger: VALID_LEDGER,
      publics: { "check-merge-gates": CRASHING("gates") },
    });
    const res = run(main, join(main, "src", "a.ts"));
    expect(res.stderr).toContain("gates crashed");
    expect(res.status).toBe(1);
  });
});
