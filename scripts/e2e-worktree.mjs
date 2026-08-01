// Run the E2E suite in a throwaway git worktree on a free port pair, so a second
// checkout can run it at the same time without the two colliding.
//
//   pnpm e2e:worktree                          # whole suite, isolated
//   pnpm e2e:worktree -- --project=chromium    # anything after -- goes to Playwright
//   pnpm e2e:worktree --keep                   # leave the worktree for inspection
//
// Ports alone are not enough. Two runs in ONE checkout still build into the same
// dist/ and dist-trace/, so the second one's `vite build` overwrites the bundle the
// first one is serving, mid-run — and both read the same sources, so an edit made
// while either is running changes what the other tests. A worktree gives each run
// its own tree and its own dist/, and the port pair gives it its own servers.
//
// A worktree checks out a COMMIT, so the working state has to be carried across or
// the run would test HEAD while reporting on the working tree — the same
// wrong-bundle failure this exists to prevent, one level up. Both halves are
// carried: tracked modifications as a patch, untracked-but-not-ignored files as
// copies. Ignored files (node_modules, dist, reference/) are deliberately left out;
// node_modules is linked instead.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const passThrough = argv.includes("--") ? argv.slice(argv.indexOf("--") + 1) : [];
const own = argv.includes("--") ? argv.slice(0, argv.indexOf("--")) : argv;
const flag = (name, fallback) => {
  const i = own.indexOf(`--${name}`);
  return i >= 0 && own[i + 1] !== undefined ? own[i + 1] : fallback;
};
const KEEP = own.includes("--keep");

function git(args, cwd = ROOT, allowFail = false) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
  if (!allowFail && r.status !== 0) throw new Error(`git ${args.join(" ")}\n${r.stderr ?? ""}`);
  return r.stdout ?? "";
}

/** A port is free when a listener can take it — the same question --strictPort asks. */
function free(port) {
  return new Promise((res) => {
    const s = createServer();
    s.once("error", () => res(false));
    s.once("listening", () => s.close(() => res(true)));
    s.listen(port, "127.0.0.1");
  });
}

/** A pair derived from this process's own id, not from scanning for a free one.
 *  Scanning looks right and is not: the ports are only bound once `vite build` has
 *  finished, ten seconds after the check, and a second run scanning inside that
 *  window sees the same pair free and takes it. Two runs then serve one port, and the
 *  loser's server dies mid-suite — which surfaces as ERR_CONNECTION_REFUSED on every
 *  remaining test rather than as a port error, so the run looks like a product
 *  failure. A pid is unique among live processes, so two concurrent runs cannot
 *  derive the same pair. The scan below is only a courtesy check for a long-dead
 *  run's leftovers; `strictPort` is what actually enforces it, loudly, at bind. */
async function portPair() {
  const SPAN = 200; // 100 pairs above the base
  const base = 4200 + ((process.pid * 2) % SPAN);
  for (let i = 0; i < SPAN / 2; i++) {
    const p = 4200 + ((base - 4200 + i * 2) % SPAN);
    if ((await free(p)) && (await free(p + 1))) return [p, p + 1];
  }
  throw new Error("no free port pair in 4200-4399");
}

const head = git(["rev-parse", "--short", "HEAD"]).trim();
const wt = resolve(flag("path", join(tmpdir(), `urx-e2e-${head}-${process.pid}`)));
if (existsSync(wt)) throw new Error(`${wt} already exists`);

const [port, tracePort] = flag("port", null) ? [Number(flag("port")), Number(flag("port")) + 1] : await portPair();

console.log(`worktree ${wt}\nHEAD     ${head}\nports    ${port} / ${tracePort}`);
git(["worktree", "add", "--detach", wt, "HEAD"]);

let status = 1;
try {
  // Tracked modifications, staged and unstaged alike. --binary so an image or any
  // other non-text change applies rather than being dropped from the patch.
  const patch = git(["diff", "HEAD", "--binary"]);
  if (patch.trim()) {
    const file = join(wt, ".e2e-worktree.patch");
    writeFileSync(file, patch);
    git(["apply", file], wt);
    rmSync(file);
    console.log(`carried   ${patch.split("\n").filter((l) => l.startsWith("diff --git")).length} modified file(s)`);
  }

  // Untracked but not ignored: a new spec or fixture that has not been added yet is
  // part of what is under test, and omitting it would run the suite without it.
  const untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  for (const rel of untracked) {
    mkdirSync(dirname(join(wt, rel)), { recursive: true });
    copyFileSync(join(ROOT, rel), join(wt, rel));
  }
  if (untracked.length) console.log(`carried   ${untracked.length} untracked file(s)`);

  // Linked, not installed: an install per run would cost more than the run. pnpm's
  // tree resolves through the link, and the worktree is discarded with it.
  symlinkSync(join(ROOT, "node_modules"), join(wt, "node_modules"), process.platform === "win32" ? "junction" : "dir");

  // Playwright is invoked directly rather than through `pnpm test:e2e`: a package
  // manager between the caller and the CLI swallows or reorders the pass-through, and
  // the failure is silent — `--project=race` that never arrives runs every project
  // and still exits 0 on a green suite, so the run reports on more than it was asked
  // for and nobody notices. node_modules is linked above, so the CLI is right there.
  const cli = join(ROOT, "node_modules", "@playwright", "test", "cli.js");
  const env = { ...process.env, E2E_PORT: String(port), E2E_TRACE_PORT: String(tracePort) };
  status = await new Promise((res) => {
    const child = spawn(process.execPath, [cli, "test", ...passThrough], { cwd: wt, env, stdio: "inherit" });
    child.on("exit", (code) => res(code ?? 1));
    child.on("error", (e) => {
      console.error(e.message);
      res(1);
    });
  });
} finally {
  // Drop the link before anything deletes the directory: it points at the real
  // node_modules, and a recursive delete that followed it would take the install
  // with it. unlinkSync removes the link itself, never its target.
  const link = join(wt, "node_modules");
  if (existsSync(link)) unlinkSync(link);
  if (KEEP) console.log(`\nkept ${wt} — remove with: git worktree remove --force ${wt}`);
  else {
    git(["worktree", "remove", "--force", wt], ROOT, true);
    rmSync(wt, { recursive: true, force: true });
  }
}
process.exit(status);
