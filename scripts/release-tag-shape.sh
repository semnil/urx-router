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
#   called wrong  exits 2, which a caller cannot read as a declined tag
set -u
shopt -s extglob

if [[ $# -ne 1 ]]; then
  echo "usage: ${0##*/} <tag>" >&2
  exit 2
fi

case "${1#v}" in
  +([0-9]).+([0-9]).+([0-9]))
    echo false
    ;;
  +([0-9]).+([0-9]).+([0-9])-@(alpha|beta|rc)*([0-9.]))
    echo true
    ;;
  *)
    echo "$1 is not a tag this repository releases — the forms it takes are vX.Y.Z and vX.Y.Z-alpha/-beta/-rc followed by digits and dots" >&2
    exit 1
    ;;
esac
