#!/usr/bin/env bash
# One Bun version, everywhere.
#
# A pin is only a pin if nothing else is allowed to say a version. Left to
# drift, CI adopts a new runtime the day it ships while developers stay
# wherever their install landed, and the difference is found by whoever runs
# the tests last. `bun-version: latest` in a workflow is that failure with a
# friendly name.
set -euo pipefail

cd "$(dirname "$0")/.."

status=0

bun_pinned=$(tr -d '[:space:]' < .bun-version)
if [ -z "$bun_pinned" ]; then
  echo "::error::.bun-version is empty"
  exit 1
fi

# The runtime actually running is a statement of the version, and it is the one
# that decides what is built. Nothing checked it, so a lockfile could be
# written, a suite passed and an artefact compiled by a Bun that is not the
# pinned one -- and every other check here would still say the pins agree.
#
# It has bitten twice. mise resolves the pin per repository from .bun-version,
# but a shell's PATH is fixed before it enters the directory, and a second Bun
# installed at ~/.bun/bin shadows mise for anything that shells out. Both are
# silent: the wrong runtime does the work and says nothing.
#
# CI passes this without doing anything, because setup-bun puts the pinned
# version on PATH. It is here for the machine where the fault actually happens.
bun_running=$(bun --version 2>/dev/null || true)
if [ -z "$bun_running" ]; then
  echo "::error::no bun on PATH, and .bun-version pins ${bun_pinned}"
  status=1
elif [ "$bun_running" != "$bun_pinned" ]; then
  echo "::error::bun on PATH is ${bun_running}; .bun-version pins ${bun_pinned}"
  echo "::error::\`which bun\` is $(command -v bun). Run through the pinned toolchain:"
  echo "::error::  export PATH=\"\$(dirname \"\$(mise which bun)\"):\$PATH\""
  echo "::error::A second install at ~/.bun/bin shadows mise for anything that shells out."
  status=1
fi

# @types/bun describes the runtime, so it is the runtime's version. Where a
# repository has no docs/the-stack.md the table below checks nothing, and this
# is the only thing holding the two together.
while IFS= read -r file; do
  declared=$(jq -r '(.devDependencies["@types/bun"] // .dependencies["@types/bun"] // empty)' "$file")
  [ -n "$declared" ] || continue
  if [ "$declared" != "$bun_pinned" ]; then
    echo "::error file=${file}::@types/bun is ${declared}; .bun-version pins ${bun_pinned}"
    status=1
  fi
done < <(find . -name package.json -not -path "*/node_modules/*" -not -path "./.git/*" -not -path "./.claude/*")

while IFS= read -r line; do
  file=${line%%:*}
  echo "::error file=${file}::workflows must use 'bun-version-file: .bun-version', not a literal or 'latest'"
  status=1
# Anchored. Unanchored, this matched the line doing the matching -- a check
# that is always red is a check nobody reads. A key is a key only at the start
# of a line.
done < <(grep -rnE '^[[:space:]]*bun-version:' .github/workflows/ || true)

# A workflow that sets up Node is a workflow for a service this shape does not
# have. Everything here runs on Bun.
#
# scribe is a library published to npm, and publish.yml is the one exception:
# trusted publishing and provenance need the npm client, which Bun does not
# provide. Bun still builds and tests there; Node only runs `npm publish`.
while IFS= read -r line; do
  file=${line%%:*}
  echo "::error file=${file}::nothing here runs on Node; remove the setup-node step"
  status=1
done < <(grep -rnE '^[[:space:]]*node-version' .github/workflows/ | grep -v '^.github/workflows/publish.yml:' || true)

# Docker cannot read `.bun-version`, so the base tag is checked instead. The
# floating `oven/bun:1-*` tag is the same drift wearing a different name.
while IFS= read -r line; do
  file=${line%%:*}
  tag=$(printf '%s' "${line#*FROM oven/bun:}" | cut -d' ' -f1 | sed 's/-.*//')
  if [ "$tag" != "$bun_pinned" ]; then
    echo "::error file=${file}::base image oven/bun:${tag} does not match .bun-version '${bun_pinned}'"
    status=1
  fi
done < <(grep -rn "^FROM oven/bun:" --include=Dockerfile . 2>/dev/null | grep -v node_modules || true)

# An action runs with this job's token, in this job's workspace. `@v7` is a tag
# its owner can move, so it is a standing grant to whoever holds that
# repository rather than a decision we made once. A commit cannot be moved; the
# tag stays in a trailing comment so a reader can see what it was, and so an
# update is a visible edit somebody reviewed.
#
# Actions under `actions/` are pinned the same way. Being GitHub's is not
# provenance -- it is the same trust in a more familiar name.
while IFS= read -r line; do
  file=${line%%:*}
  ref=$(printf '%s' "$line" | sed 's/.*uses: *//' | cut -d' ' -f1)
  echo "::error file=${file}::${ref} is pinned to a tag; pin it to a commit and keep the tag in a comment"
  status=1
done < <(grep -rn "uses: *[^ ]*@v[0-9]" .github/workflows/ || true)

# Every dependency is pinned exactly, in every package.json.
#
# `^4.7.0` and `latest` are the same drift `.bun-version` exists to stop. A
# caret says "whatever is newest and claims to be compatible", which is a
# decision taken by somebody else, later, on a machine that is not this one.
#
# It matters twice over here. The tools -- the type checker, the linter, the
# schema library -- decide whether this repository is *correct*, so a fresh
# install and an old one must agree about which ones are judging. And the
# runtime dependencies are compiled into a binary that goes onto a customer's
# node, so what was chosen is part of what shipped.
#
# A lockfile records what was resolved. It does not say what was *chosen*, and
# a reader asking "which hono is this" should not have to open one.
#
# Upgrading is then a visible edit somebody reviewed, which is the same rule
# the actions above are held to.
while IFS= read -r file; do
  while IFS=$'\t' read -r name version; do
    [ -n "$name" ] || continue
    case "$version" in
      [0-9]*.[0-9]*.[0-9]*) ;;
      # An alias names a different package under this name, and is a pin as
      # long as it ends in an exact version -- `npm:@scope/pkg@1.2.3`. It is
      # how a tool that needs an older compiler carries one without the
      # repository adopting it.
      npm:*@[0-9]*.[0-9]*.[0-9]*) ;;
      # A workspace or file link names no version to drift.
      workspace:*|file:*|link:*) ;;
      *)
        echo "::error file=${file}::${name} is '${version}'; pin it exactly, so a fresh install and an old one agree"
        status=1
        ;;
    esac
  done < <(jq -r '[(.dependencies // {}), (.devDependencies // {})]
                  | add // {}
                  | to_entries[]
                  | "\(.key)\t\(.value)"' "$file")
done < <(find . -name package.json -not -path "*/node_modules/*" -not -path "./.git/*" -not -path "./.claude/*")

# The stack document names every version in a table, and a reader trusts it the
# way they trust the pin itself. Kept by hand it is a second answer to one
# question: the pin moves in the change somebody reviewed, and the table keeps
# naming what the repository was built from a month ago.
stack=docs/the-stack.md
if [ -f "$stack" ]; then
  pins=$(find . -name package.json -not -path "*/node_modules/*" -not -path "./.git/*" -not -path "./.claude/*" \
         -print0 | xargs -0 jq -r '[(.dependencies // {}), (.devDependencies // {})]
                                    | add // {}
                                    | to_entries[]
                                    | "\(.key)\t\(.value)"')

  while IFS=$'\t' read -r name version; do
    [ -n "$name" ] || continue
    if [ "$name" = "Bun" ]; then
      if [ "$version" != "$bun_pinned" ]; then
        echo "::error file=${stack}::the table says Bun ${version}; .bun-version says ${bun_pinned}"
        status=1
      fi
      continue
    fi
    pinned=$(printf '%s\n' "$pins" | awk -F'\t' -v n="$name" '$1 == n { print $2; exit }')
    if [ -z "$pinned" ]; then
      echo "::error file=${stack}::the table names ${name}, which nothing depends on"
      status=1
    elif [ "$pinned" != "$version" ]; then
      echo "::error file=${stack}::the table says ${name} ${version}; the pin is ${pinned}"
      status=1
    fi
  done < <(sed -n 's/^|[[:space:]]*`\?\([^`|]*[^`| ]\)`\?[[:space:]]*|[[:space:]]*`\([0-9][^`]*\)`[[:space:]]*|.*/\1\t\2/p' "$stack")
fi

if [ "$status" -eq 0 ]; then
  echo "Pins consistent: bun ${bun_pinned}, every action on a commit, every dependency exact"
fi
exit $status
