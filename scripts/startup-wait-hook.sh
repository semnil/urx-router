#!/bin/sh
# Claude Code PreToolUse / PostToolUse wrapper for Bash commands that launch or wait for the
# dev app. The checker reads the hook payload on the stdin this wrapper hands over.
hook_name=startup-wait-hook
. "$(dirname "$0")/hook-node.sh"
exec node "$(dirname "$0")/check-startup-wait.mjs" --hook
