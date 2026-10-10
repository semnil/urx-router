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
# rather than through that repository's own. Run when that checkout is present; a clone
# without it has no ledger to break.
anchors="$self/../reference/scripts/check-ledger-anchors.mjs"
if [ -f "$anchors" ]; then
  printf '%s' "$payload" | node "$anchors" --hook || status=$?
fi
exit $status
