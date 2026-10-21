#!/usr/bin/env bash
# R586: probe-app plus an OnCompanyOpenCompleted subscriber that writes the database, in a scratch
# copy; runs one plain test. Measurement tool only.
# Usage: companyopen-probe.sh <al-runner binary> <out dir>
set -u
A="$1"; OUT="$2"
P="$(cd "$(dirname "$0")" && pwd)"
export ALRUNNER_CACHE="${ALRUNNER_CACHE:-/work/tools/al-runtime-rs/cache}"
W="$OUT/companyopen-work"; rm -rf "$W"; mkdir -p "$W"
cp -r "$P/probe-app" "$P/probe-tests" "$W/"
cp "$P/extras/ProbeOpenWriter.Codeunit.al" "$W/probe-app/src/"
cd "$W" && timeout 900 "$A" test --output-json --verbose --test-exact Codeunit50650.Passes probe-app probe-tests \
  > "$OUT/companyopen.out" 2> "$OUT/companyopen.err"
echo "exit $?" > "$OUT/companyopen.exit"
