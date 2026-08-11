#!/bin/sh
# Claude Code PostToolUse wrapper for the repository's own file checks (documents, and
# the workflow arrangement the branch ruleset depends on).
# Hook processes do not inherit the login shell PATH, so node has to be located
# first (nodenv shims on this Mac, Homebrew elsewhere; Git Bash already has it).
for dir in "$HOME/.anyenv/envs/nodenv/shims" /opt/homebrew/bin /usr/local/bin; do
  [ -x "$dir/node" ] && PATH="$dir:$PATH"
done
command -v node >/dev/null 2>&1 || {
  echo "md-hook: node not found, document checks skipped" >&2
  exit 1
}
# Each checker reads the whole PostToolUse payload from fd 0 and decides for itself
# whether the edited file is one it cares about, so the payload is read once here and
# replayed. Piping the hook's own stdin through them in sequence would leave the second
# one reading a drained fd, where it parses nothing and exits 0 — wired, and checking
# nothing. Both exit 2 on a finding, and 2 is what the hook has to return for the
# message to reach Claude, so the first non-zero status is carried to the end.
payload=$(cat)
self=$(dirname "$0")
status=0
for check in check-md-tables check-assets-index check-merge-gates; do
  printf '%s' "$payload" | node "$self/$check.mjs" --hook || status=$?
done
exit $status
