#!/bin/sh
# Claude Code PostToolUse wrapper for the repository's own file checks (documents, and
# the workflow arrangement the branch ruleset depends on).
hook_name=md-hook
. "$(dirname "$0")/hook-node.sh"
# Each checker reads the whole PostToolUse payload from fd 0 and decides for itself
# whether the edited file is one it cares about, so the payload is read once here and
# replayed. Piping the hook's own stdin through them in sequence would leave the second
# one reading a drained fd, where it parses nothing and exits 0 — wired, and checking
# nothing. Both exit 2 on a finding, and 2 is what the hook has to return for the
# message to reach Claude, so the first non-zero status is carried to the end.
payload=$(cat)
self=$(dirname "$0")
status=0
for check in check-md-tables check-assets-index check-merge-gates check-comment-provenance; do
  printf '%s' "$payload" | node "$self/$check.mjs" --hook || status=$?
done
# The private ledgers under reference/ (a checkout of another repository, ignored here) carry
# their own anchor check, and an edit made from this repository reaches them through this hook
# rather than through that repository's own. That checkout lives in the MAIN checkout of this
# repository, which a worktree's hook finds through git's common directory rather than beside
# itself (a worktree has no reference/). Its checker runs only when the EDITED FILE is inside
# that reference/, so an edit anywhere else — including a tree that carries a checker of the
# same name — runs nothing, and so does a clone without reference/.
common=$(git -C "$self" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) && main=$(dirname "$common") || main="$self/.."
anchors=$(printf '%s' "$payload" | node -e '
const { existsSync, readFileSync, realpathSync } = require("node:fs");
const { isAbsolute, join, relative, resolve, sep } = require("node:path");
let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const file = payload?.tool_input?.file_path;
if (typeof file !== "string" || !file) process.exit(0);
const reference = join(process.argv[1], "reference");
const checker = join(reference, "scripts", "check-ledger-anchors.mjs");
if (!existsSync(checker)) process.exit(0);
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const edited = relative(real(reference), real(resolve(typeof payload.cwd === "string" ? payload.cwd : process.cwd(), file)));
if (!edited || edited === ".." || edited.startsWith(`..${sep}`) || isAbsolute(edited)) process.exit(0);
process.stdout.write(checker);
' "$main") || status=$?
if [ -n "$anchors" ]; then
  printf '%s' "$payload" | node "$anchors" --hook || status=$?
fi
exit $status
