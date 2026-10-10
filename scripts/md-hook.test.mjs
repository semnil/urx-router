// The document hook's reach into the private ledgers. `scripts/md-hook.sh` runs the private
// repository's anchor check when that checkout sits beside it as reference/, and nothing when it
// does not. Driven against a throwaway layout — the real hook beside stand-in checkers — so the
// question is the wiring rather than what any one checker decides: the stand-in for the anchor
// check refuses everything, and the hook has to carry that refusal out.
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("./md-hook.sh", import.meta.url));
const HOOK_NODE = fileURLToPath(new URL("./hook-node.sh", import.meta.url));
const PASSING = "process.exit(0);\n";
const REFUSING = 'process.stderr.write("anchor check reached\\n"); process.exit(2);\n';

const made = [];
afterAll(() => {
  for (const root of made) rmSync(root, { recursive: true, force: true });
});

/** A checkout-shaped directory holding the real hook and a stand-in for each checker it runs. */
function layout(withReference) {
  const root = mkdtempSync(join(tmpdir(), "md-hook-"));
  made.push(root);
  mkdirSync(join(root, "scripts"));
  copyFileSync(HOOK, join(root, "scripts", "md-hook.sh"));
  copyFileSync(HOOK_NODE, join(root, "scripts", "hook-node.sh"));
  for (const name of ["check-md-tables", "check-assets-index", "check-merge-gates", "check-comment-provenance"]) {
    writeFileSync(join(root, "scripts", `${name}.mjs`), PASSING);
  }
  if (withReference) {
    mkdirSync(join(root, "reference", "scripts"), { recursive: true });
    writeFileSync(join(root, "reference", "scripts", "check-ledger-anchors.mjs"), REFUSING);
  }
  return root;
}

const run = (root) =>
  spawnSync("sh", [join(root, "scripts", "md-hook.sh")], {
    input: JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: join(root, "reference", "work", "e2e-flakes.md") },
    }),
    encoding: "utf8",
    env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` },
  });

describe("the document hook and the private ledgers", () => {
  it("runs the anchor check when reference/ is there, and carries its refusal out", () => {
    const res = run(layout(true));
    expect(res.stderr).toContain("anchor check reached");
    expect(res.status).toBe(2);
  });

  it("passes when there is no reference/ beside it", () => {
    const res = run(layout(false));
    expect(res.stderr).not.toContain("anchor check reached");
    expect(res.status).toBe(0);
  });
});
