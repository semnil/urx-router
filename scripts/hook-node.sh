# Sourced by the Claude Code hook wrappers before they run a checker. Hook processes do not
# inherit the login shell PATH, so node has to be located first (nodenv shims on this Mac,
# Homebrew elsewhere; Git Bash already has it). The wrapper sets $hook_name before sourcing.
for dir in "$HOME/.anyenv/envs/nodenv/shims" /opt/homebrew/bin /usr/local/bin; do
  [ -x "$dir/node" ] && PATH="$dir:$PATH"
done
command -v node >/dev/null 2>&1 || {
  echo "$hook_name: node not found, checks skipped" >&2
  exit 1
}
