// What `.gitignore` covers, asked of git rather than read off the file.
//
// A trailing slash restricts a pattern to DIRECTORIES, and a symlink is not one — so
// `node_modules/` does not ignore a `node_modules` symlink, which is how a shared install gets
// committed from a git worktree. The file's own header says that and says no pattern here
// carries the narrowing, and nothing was holding it to that: `/.agents/` and `/.codex/` were
// added with the slash, and `git add --dry-run .` over a checkout where a tool had made them
// symlinks answered `add '.agents'`. A rule stated in a comment does not enforce itself.
//
// Two halves, because one alone proves little. The SHAPE rule is total — it reaches every
// pattern in the file, including ones added later — and the BEHAVIOUR half is what says the
// shape rule is the right rule: each pattern is materialised in both forms in a throwaway
// repository and git is asked what it would add.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IGNORE = readFileSync(resolve(repoRoot, ".gitignore"), "utf8");

const lines = IGNORE.split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));
const ignores = lines.filter((line) => !line.startsWith("!"));
const negations = lines.filter((line) => line.startsWith("!"));
/** The patterns that name one path rather than a shape, which are the ones a directory and a
 *  symlink can both be made of. A glob is left out: `*.log` is not a path to create. */
const plain = ignores.filter((pattern) => !pattern.includes("*")).map((pattern) => pattern.replace(/^\//, ""));

describe("what .gitignore covers", () => {
  // What the rules below are asked ABOUT comes from the file itself, which is what lets them
  // reach a pattern added later — and is also why they cannot see one that is removed: the
  // rule and the check would go together. So the three this exists for are named.
  it("names the three entries the agent tooling writes into a checkout", () => {
    expect(ignores).toEqual(expect.arrayContaining(["/.agents", "/.codex", "/AGENTS.md"]));
  });

  it("narrows no ignore rule to a real directory", () => {
    expect(ignores.filter((pattern) => pattern.endsWith("/"))).toEqual([]);
    // …while the NEGATIONS keep theirs on purpose: re-including only a real directory fails
    // safe, so a new one carrying a slash is a decision and a new one without is the accident.
    expect(negations.filter((pattern) => pattern.endsWith("/"))).toEqual([
      "!.claude/skills/",
      "!.claude/skills/urx-routing-planner/",
    ]);
  });

  // …and what that means to git, which is the half a shape rule cannot supply. `add` is asked
  // rather than `check-ignore`, because what the rule has to stop is a `git add .` sweeping the
  // path into a commit, and a control file goes in beside them: a run that adds NOTHING would
  // satisfy every assertion about what it does not add.
  for (const shape of ["a directory", "a symlink"]) {
    it(`ignores every path it names when the path is ${shape}`, () => {
      const tmp = mkdtempSync(join(tmpdir(), "gitignore-shape-"));
      try {
        execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: tmp });
        writeFileSync(join(tmp, ".gitignore"), IGNORE);
        writeFileSync(join(tmp, "control.txt"), "a path no rule names\n");
        mkdirSync(join(tmp, "target"), { recursive: true });
        writeFileSync(join(tmp, "target", "inside"), "what a symlink points at\n");
        for (const path of plain) {
          const at = join(tmp, path);
          mkdirSync(dirname(at), { recursive: true });
          if (shape === "a symlink") symlinkSync(join(tmp, "target"), at);
          else {
            mkdirSync(at, { recursive: true });
            writeFileSync(join(at, "inside"), "what the rule has to cover\n");
          }
        }
        const said = execFileSync("git", ["add", "--dry-run", "."], { cwd: tmp, encoding: "utf8" })
          .split("\n")
          .filter(Boolean)
          .sort();
        // `target/` is the thing the symlinks point at and no rule names it, so it is added
        // like the control — which is also what says the run reached the working tree at all.
        expect(said).toEqual(["add '.gitignore'", "add 'control.txt'", "add 'target/inside'"]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
});
