// What `.gitignore` covers, asked of git rather than read off the file.
//
// A trailing slash restricts a pattern to DIRECTORIES, and a symlink is not one — so
// `node_modules/` does not ignore a `node_modules` symlink, which is how a shared install gets
// committed from a git worktree. The file's own header says that, and nothing was holding it
// to it: `/.agents/` and `/.codex/` were added with the slash, and `git add --dry-run .` over
// a checkout where a tool had made them symlinks answered `add '.agents'`. A rule stated in a
// comment does not enforce itself.
//
// A NEGATION is the same rule read backwards. `!x` re-includes both shapes, so a symlink slips
// in where the author meant a directory; `!x/` re-includes only the directory, which is what
// fails safe. The slash is therefore required on one kind and refused on the other, and which
// kind a negation is cannot be read off the pattern — so each is declared.
//
// Two halves, because one alone proves little. The SHAPE rules are total — every pattern in
// the file is classified, including ones added later — and the BEHAVIOUR half is what says
// they are the right rules: each pattern is materialised in a throwaway repository, in both
// shapes where both are possible, and git is asked what it would add.
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

/**
 * What each negation re-includes, declared rather than inferred.
 *
 * A pattern cannot say which it is — `!x` is the same text whether the author meant a file or
 * a directory — and the two want opposite things from the trailing slash. So a new negation
 * has to be entered here, and the rules below say what its entry then obliges.
 */
const NEGATIONS = new Map([
  ["!.claude/settings.json", "file"],
  ["!.claude/skills/", "directory"],
  ["!.claude/skills/urx-routing-planner/", "directory"],
]);

/** Whether this machine can make a symlink at all. Windows refuses one without Developer Mode
 *  or the create-symbolic-link privilege, and this repository is worked from two machines. */
const symlinksWork = (() => {
  const tmp = mkdtempSync(join(tmpdir(), "gitignore-symlink-probe-"));
  try {
    mkdirSync(join(tmp, "at"));
    symlinkSync(join(tmp, "at"), join(tmp, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
})();

describe("what .gitignore covers", () => {
  // What the rules below are asked ABOUT comes from the file itself, which is what lets them
  // reach a pattern added later — and is also why they cannot see one that is removed: the
  // rule and the check would go together. So the three this exists for are named.
  it("names the three entries the agent tooling writes into a checkout", () => {
    expect(ignores).toEqual(expect.arrayContaining(["/.agents", "/.codex", "/AGENTS.md"]));
  });

  it("narrows no ignore rule to a real directory", () => {
    expect(ignores.filter((pattern) => pattern.endsWith("/"))).toEqual([]);
  });

  // …and the negations the other way round, which is where a slash is the safe form. Every one
  // in the file is declared, so a new one cannot arrive unclassified, and what it is declared
  // as decides whether it must carry a slash.
  it("declares every negation, and gives a directory one its slash", () => {
    expect([...NEGATIONS.keys()].sort()).toEqual([...negations].sort());
    for (const [pattern, kind] of NEGATIONS) {
      expect(["file", "directory"], `${pattern}: ${kind}`).toContain(kind);
      expect(pattern.endsWith("/"), `${pattern} re-includes a ${kind}`).toBe(kind === "directory");
    }
  });

  /**
   * A throwaway repository carrying this file's rules, and what git would add to it.
   *
   * Its git configuration is EMPTY on purpose: a `core.excludesFile` in the operator's own
   * global config reaches every repository, so a `target/` in one would delete this run's
   * positive control and fail a correct change. The locale is pinned for the same reason the
   * rest of this repository pins it when it parses another tool's output.
   */
  const inRepo = (build, rules = IGNORE) => {
    const tmp = mkdtempSync(join(tmpdir(), "gitignore-shape-"));
    // …beside the repository rather than in it, or git would offer to add the file itself.
    const beside = mkdtempSync(join(tmpdir(), "gitignore-config-"));
    try {
      const config = join(beside, "empty-gitconfig");
      writeFileSync(config, "");
      const env = {
        ...process.env,
        GIT_CONFIG_GLOBAL: config,
        GIT_CONFIG_SYSTEM: config,
        GIT_CONFIG_NOSYSTEM: "1",
        LC_ALL: "C",
        LANG: "C",
      };
      const git = (...args) => execFileSync("git", args, { cwd: tmp, encoding: "utf8", env });
      git("init", "-q", "-b", "main", ".");
      writeFileSync(join(tmp, ".gitignore"), rules);
      writeFileSync(join(tmp, "control.txt"), "a path no rule names\n");
      mkdirSync(join(tmp, "target"), { recursive: true });
      writeFileSync(join(tmp, "target", "inside"), "what a symlink points at\n");
      const put = (path, shape) => {
        const at = join(tmp, path);
        mkdirSync(dirname(at), { recursive: true });
        if (shape === "a symlink") symlinkSync(join(tmp, "target"), at);
        else if (shape === "a file") writeFileSync(at, "what the rule has to cover\n");
        else {
          mkdirSync(at, { recursive: true });
          writeFileSync(join(at, "inside"), "what the rule has to cover\n");
        }
      };
      build(put);
      return git("add", "--dry-run", ".").split("\n").filter(Boolean).sort();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(beside, { recursive: true, force: true });
    }
  };
  // `target/` is what the symlinks point at and no rule names it, so it is added like the
  // control — which is also what says the run reached the working tree at all.
  const ALWAYS = ["add '.gitignore'", "add 'control.txt'", "add 'target/inside'"];

  for (const shape of ["a directory", "a symlink"]) {
    const needsLink = shape === "a symlink";
    it.skipIf(needsLink && !symlinksWork)(
      `ignores every path it names when the path is ${shape}` +
        (needsLink && !symlinksWork ? " — SKIPPED, this machine cannot create one" : ""),
      () => {
        expect(inRepo((put) => plain.forEach((path) => put(path, shape)))).toEqual(ALWAYS);
      },
    );
  }

  // …and the negations, one repository each, since they nest: `.claude/skills/` re-includes the
  // directory its own child negation then reaches into.
  //
  // What is measured is the SLASH, against the same pattern written without it — a re-include
  // is git's own behaviour and not this repository's, so the contract here is only which
  // shapes it reaches. Without that second run the first asserts nothing: a path git was never
  // going to add is not evidence that the slash kept it out.
  for (const [pattern, kind] of NEGATIONS) {
    const path = pattern.slice(1).replace(/\/$/, "");
    const parents = path
      .split("/")
      .slice(0, -1)
      .map((_, n, all) => all.slice(0, n + 1).join("/"));
    const build = (shape) => (put) => {
      for (const parent of parents) put(parent, "a directory");
      put(path, shape);
    };
    /** The same rules with the slash moved on THIS negation alone, which is the arrangement
     *  the shape rule refuses. */
    const flipped = IGNORE.replace(pattern, kind === "directory" ? pattern.replace(/\/$/, "") : pattern + "/");

    if (kind === "directory") {
      it.skipIf(!symlinksWork)(
        `keeps a symlink out of ${pattern}` + (symlinksWork ? "" : " — SKIPPED, this machine cannot create one"),
        () => {
          expect(inRepo(build("a symlink"))).toEqual(ALWAYS);
          // …and the same negation without its slash re-includes the symlink, which is the
          // whole of why the slash is required and what a new one written without it costs.
          expect(inRepo(build("a symlink"), flipped)).toEqual([...ALWAYS, `add '${path}'`].sort());
        },
      );
    } else {
      it(`re-includes ${pattern}`, () => {
        expect(inRepo(build("a file"))).toEqual([...ALWAYS, `add '${path}'`].sort());
        // …and given the slash a directory negation needs, it re-includes nothing at all,
        // which is why the two kinds are declared rather than read off the pattern.
        expect(inRepo(build("a file"), flipped)).toEqual(ALWAYS);
      });
    }
  }
});
