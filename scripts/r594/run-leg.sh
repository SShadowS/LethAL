#!/usr/bin/env bash
# R594: one bcdev leg of the R546 CDO slice on bc3, with R546's exact flags.
#   bash scripts/r594/run-leg.sh A|B [--dry-run]
# Run it under a bc3 coord lease the caller holds and heartbeats. Never signal-stop it.
# The bc3 config is transformed inside jq and never printed; the derived copy is deleted on exit.
# packageCachePath is a per-leg copy of scripts/r594/cdo-publish.ts's bc3 package dir (R552:
# bcdev stages lethal-control.app there, so the source dir stays exactly as built).
set -u
leg=${1:-}; shift || true
case "$leg" in A) mode=none ;; B) mode=fenced ;; *) echo "usage: run-leg.sh A|B [--dry-run]" >&2; exit 2 ;; esac
REPO=$(cd "$(dirname "$0")/../.." && pwd)
OUT=/coord/handoff/R594
CDO=/work/lethal-wt/cdo-r396
WORK=$REPO/.kraken-local/r594
SRC=$REPO/fixtures/sandbox-app/lethal.config.bc3.json
[ -d "$WORK/bc3-packages" ] || { echo "no $WORK/bc3-packages: run scripts/r594/cdo-publish.ts first" >&2; exit 2; }
suffix=""; [ "${1:-}" = "--dry-run" ] && suffix="-dry"
CACHE=$WORK/bc-cache-$leg$suffix
rm -rf "$CACHE"; mkdir -p "$CACHE"; cp "$WORK"/bc3-packages/*.app "$CACHE"/
umask 077
CFG=$WORK/bc-$leg$suffix.config.json
trap 'rm -f "$CFG"' EXIT
jq --arg m "$mode" --arg c "$CACHE" '{bcdev: .bcdev} | .bcdev.coverageMode = $m | .bcdev.packageCachePath = $c' "$SRC" > "$CFG"
DB=$OUT/bc-$leg$suffix.sqlite; rm -f "$DB"
cd "$REPO"
echo "leg $leg$suffix start $(date -u +%FT%TZ) lethal $(git rev-parse --short HEAD) cdo $(git -C $CDO rev-parse --short HEAD)"
# A dry run refuses every flag that only matters when something executes, and writes no report.
live=(--tests "$CDO/Test" --tests-only Src/Recipients/CDORecipientMgtTests.Codeunit.al
  --selector-id 6175460 --control-id 6175459 --table-id 6175458
  --stop-hung-sessions --out "$OUT/bc-$leg.report.json" --progress-out "$OUT/bc-$leg.events.ndjson")
[ -n "$suffix" ] && live=()
bun packages/runner/src/cli.ts run --backend bcdev --config "$CFG" \
  --project "$CDO/Cloud" \
  --only .dependencies/CDO/Codeunit/CDORecipientMgt.Codeunit.al \
  --db "$DB" "${live[@]}" "$@"
rc=$?
echo "leg $leg$suffix exit $rc at $(date -u +%FT%TZ)"
exit $rc
