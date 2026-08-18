#!/usr/bin/env bash
# A CLEAN-ROOM install test: the PUBLISHED Linux binary, in a stock container, driven through the
# first fifteen minutes an attendee would spend with it.
#
#   bash scripts/clean-room.sh [ubuntu:24.04]
#
# WHAT THIS IS NOT. It is not the stranger test. A container cannot be confused, cannot give up, and
# cannot tell you which sentence in the README it read three times. That half needs a person.
#
# What it IS: a machine with none of this repository's caches, PATH, config or tooling, running the
# artifact people actually download. This repository has already paid for the lack of one — R64
# shipped Linux and macOS binaries on which the bcdev backend could never work, because
# `defaultAlToolPaths()` hardcoded `bin/win32/` and nothing ever ran the released binary anywhere
# but Windows.
#
# Every step below states what it EXPECTS. A step that produces a raw stack trace where a named
# refusal belongs is a finding, not a pass: the whole product claim is that it fails loudly and says
# what to do.
set -uo pipefail

# Git bash on Windows rewrites anything that looks like a unix path in an argument, so `-w /work`
# arrives at the daemon as `C:/Program Files/Git/work` and every step fails identically. Harmless
# elsewhere; without it this script cannot run on the machine it was written on.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

IMAGE="${1:-ubuntu:24.04}"
BIN="/tmp/cleanroom/lethal-linux"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[ -f "$BIN" ] || { echo "clean-room: download the published linux-x64 asset to $BIN first" >&2; exit 1; }

# Docker Desktop takes HOST paths for a bind mount, and a Git-bash path like /tmp/... is not
# one: the daemon sees a Linux path that does not exist and helpfully creates an empty
# DIRECTORY, so the mount silently succeeds and the binary is not there. `cygpath -m` gives the
# Windows path with forward slashes, which the daemon accepts. A no-op on a real unix host.
hostpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

pass=0
fail=0

# The version of the binary under test, so a step for a feature that POSTDATES it can say SKIP
# rather than FAIL. `init` landed after v0.1.0-alpha.2 was tagged; reporting that as a failure would
# be a lie about the artifact, and deleting the step would lose it for the next release.
BIN_VERSION="$(docker run --rm -v "$(hostpath "$BIN"):/opt/download/lethal:ro" "$IMAGE" \
  bash -lc 'install -m 0755 /opt/download/lethal /usr/local/bin/lethal && lethal --version | head -1' 2>/dev/null | tr -d '\r')"

skipped=0

check() { # check [--since <version>] <name> <expected-substring> <command...>
  local since=""
  if [ "$1" = "--since" ]; then since="$2"; shift 2; fi
  local name="$1" expect="$2"; shift 2
  if [ -n "$since" ] && [ "$(printf '%s\n%s\n' "$since" "$BIN_VERSION" | sort -V | head -1)" != "$since" ]; then
    echo "  SKIP  $name — needs $since, binary under test is $BIN_VERSION"
    skipped=$((skipped + 1))
    return
  fi
  local out
  out="$(docker run --rm \
    -v "$(hostpath "$BIN"):/opt/download/lethal:ro" \
    -v "$(hostpath "$REPO/examples"):/work/examples:ro" \
    -v "$(hostpath "$REPO/docs/campaign/2026-08-16-gift-card"):/work/report:ro" \
    -w /work "$IMAGE" bash -lc "$*" 2>&1)"
  if grep -qF -- "$expect" <<<"$out"; then
    echo "  PASS  $name"
    pass=$((pass + 1))
  else
    echo "  FAIL  $name — expected to find: $expect"
    echo "$out" | head -6 | sed 's/^/          /'
    fail=$((fail + 1))
  fi
}

echo "clean-room: $IMAGE, binary $(basename "$BIN") ($BIN_VERSION)"
echo

# 1. Does the artifact even run? R64's exact question.
check "the binary runs at all" "0.1.0-alpha.2" \
  "install -m 0755 /opt/download/lethal /usr/local/bin/lethal && lethal --version"

# 2. --version must carry provenance, not just a number (R88): the commit and the operator list.
check "--version reports the commit it was built from" "build:" \
  "install -m 0755 /opt/download/lethal /usr/local/bin/lethal && lethal --version"
check "--version lists the operators it can apply" "operators (" \
  "install -m 0755 /opt/download/lethal /usr/local/bin/lethal && lethal --version"

# 3. Help is the first thing a stranger types after --version.
check --since 0.1.0-alpha.3 "--help documents init" "lethal init" \
  "install -m 0755 /opt/download/lethal /usr/local/bin/lethal && lethal --help"

# 4. The half of the tool that needs NO server. This is what an attendee can do on the plane home.
check "explain works on the shipped sample report" "survivorSelection" \
  "install -m 0755 /opt/download/lethal /usr/local/bin/lethal && lethal explain /work/report/rehearsal.report.json --top 10"
check "explain --top caps and says what it dropped" '"omitted"' \
  "install -m 0755 /opt/download/lethal /usr/local/bin/lethal && lethal explain /work/report/rehearsal.report.json --top 3"

# 5. `init` reads the target's app.json and picks ids that fit it.
check --since 0.1.0-alpha.3 "init writes a config with selector ids from the app's own ranges" "90199" \
  "install -m 0755 /opt/download/lethal /usr/local/bin/lethal && cp -r /work/examples/gift-card /tmp/app && lethal init --project /tmp/app && cat /tmp/app/lethal.config.json"

# 6. A dry run needs no server either, and is how a user sizes the job.
check "dry-run reports site and deployed counts with no server" "deployed mutant(s)" \
  "install -m 0755 /opt/download/lethal /usr/local/bin/lethal && cp -r /work/examples/gift-card /tmp/app2 && lethal run --project /tmp/app2 --dry-run"

# 7. The failure paths. A named refusal, never a stack trace: this is the product claim.
check --since 0.1.0-alpha.3 "doctor refuses a missing config WITHOUT a stack trace" "LETHAL_DEBUG" \
  "install -m 0755 /opt/download/lethal /usr/local/bin/lethal && lethal doctor --config /tmp/nope.json; true"
check "a run without --tests is refused by name" "--tests" \
  "install -m 0755 /opt/download/lethal /usr/local/bin/lethal && lethal run --project /tmp/nothing --backend bcdev; true"

echo
echo "clean-room: $pass passed, $fail failed, $skipped skipped (version-gated)"
[ "$fail" -eq 0 ]
