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
# rather than through that repository's own. The checker run is the one of the checkout the
# EDITED FILE sits in — the nearest directory above it holding scripts/check-ledger-anchors.mjs —
# rather than one beside this hook, since a worktree of this repository has no reference/ while
# the ledger it edits lives in the main checkout's. A file in no such checkout runs nothing.
anchors=$(printf '%s' "$payload" | node -e '
const { existsSync, readFileSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");
let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const file = payload?.tool_input?.file_path;
if (typeof file !== "string" || !file) process.exit(0);
let dir = dirname(resolve(typeof payload.cwd === "string" ? payload.cwd : process.cwd(), file));
for (;;) {
  const checker = join(dir, "scripts", "check-ledger-anchors.mjs");
  if (existsSync(checker)) {
    process.stdout.write(checker);
    break;
  }
  if (dirname(dir) === dir) break;
  dir = dirname(dir);
}
') || status=$?
if [ -n "$anchors" ]; then
  printf '%s' "$payload" | node "$anchors" --hook || status=$?
fi
exit $status
