#!/bin/bash
# The single home for what a release tag looks like.
#
# Three callers read this file and nothing else: tag-release.yml, which refuses before it
# pushes a tag; release.yml's check-tag, which is the gate the build hangs off; and
# scripts/release-tag.test.mjs, which asks the same question on the pull request that sets
# the version. release.yml's `on.push.tags` globs are the one copy that cannot be folded in
# here, because a trigger filter cannot run a script; that workflow's header carries where
# the two lists agree and where they do not.
#
# Takes one argument: the tag, or the version with no leading `v`.
#   accepted      prints `true` or `false` — whether the tag is a prerelease — on stdout,
#                 writes nothing to stderr, exits 0
#   declined      prints nothing on stdout, the forms a release tag takes on stderr, exits 1
#   called wrong  exits 2 — no argument, more than one, or an empty one, which is what a
#                 caller whose variable went missing passes, since both quote theirs
#
# The two streams are the contract: a caller reads stdout for the answer and stderr for the
# message, and treats any status other than 0 or 1 as this check being broken rather than as
# a verdict on the tag.
set -u
shopt -s extglob

if [[ $# -ne 1 ]] || [[ -z "$1" ]]; then
  echo "usage: ${0##*/} <tag>" >&2
  exit 2
fi

decline() {
  echo "$1 is not a tag this repository releases — the forms it takes are vX.Y.Z and vX.Y.Z-alpha/-beta/-rc followed by digits and dots" >&2
  exit 1
}

case "${1#v}" in
  # `git tag` refuses a ref name that holds `..` or ends in `.`, and the trailing
  # `*([0-9.])` below accepts both. Declining them here is what keeps that refusal off the
  # push, where it would be a red run by the bot on a version already merged.
  *..* | *.)
    decline "$1"
    ;;
  +([0-9]).+([0-9]).+([0-9]))
    echo false
    ;;
  +([0-9]).+([0-9]).+([0-9])-@(alpha|beta|rc)*([0-9.]))
    echo true
    ;;
  *)
    decline "$1"
    ;;
esac
