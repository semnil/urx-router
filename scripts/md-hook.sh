#!/bin/sh
# Claude Code PostToolUse wrapper for check-md-tables.mjs.
# Hook processes do not inherit the login shell PATH, so node has to be located
# first (nodenv shims on this Mac, Homebrew elsewhere; Git Bash already has it).
for dir in "$HOME/.anyenv/envs/nodenv/shims" /opt/homebrew/bin /usr/local/bin; do
  [ -x "$dir/node" ] && PATH="$dir:$PATH"
done
command -v node >/dev/null 2>&1 || {
  echo "md-hook: node not found, Markdown table check skipped" >&2
  exit 1
}
exec node "$(dirname "$0")/check-md-tables.mjs" --hook
