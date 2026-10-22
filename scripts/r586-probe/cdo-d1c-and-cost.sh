#!/usr/bin/env bash
# R586 plan r3: the two CDO measurements the pre-commitment waits for. A CORPUS job: run it only when at
# most one other heavy job runs container-wide (check by hand first; this script does not wait).
#   1. M5: D1c through the shim: one-shot, coverage al-runner, against R546's bc-B.
#   2. Q20: the per-call --coverage-json cost on the slice's test codeunit 68933.
# Usage (from the repo root): scripts/r586-probe/cdo-d1c-and-cost.sh <v3 binary> <cdo checkout at 5f2a71d>
set -u
B="$1"; C="$2"
OUT=/coord/handoff/R-586/cdo-alpha2-d1c; mkdir -p "$OUT"
export ALRUNNER_CACHE="${ALRUNNER_CACHE:-/work/tools/al-runtime-rs/cache}"
timeout 1800 bun scripts/r586-probe/run-fixture.ts --alrunner "$B" --out "$OUT" --leg oneshot --tag oneshot-cov \
  --project "$C/Cloud" --tests "$C/Test" --oracle docs/measurements/r546/bc-B.report.json --coverage al-runner \
  --packages "$C/Test/.alpackages" --only .dependencies/CDO/Codeunit/CDORecipientMgt.Codeunit.al \
  --tests-only Src/Recipients/CDORecipientMgtTests.Codeunit.al --ids 6175460,6175459,6175458 > "$OUT/oneshot-cov.log" 2>&1
echo "d1c exit=$?"
head -4 "$OUT/oneshot-cov.compare.txt"
timeout 900 scripts/r586-probe/covjson-cost.sh "$B" /coord/handoff/R-586/plan-measure/covjson-cost-cdo.txt \
  /coord/handoff/R-586/cdo-alpha2/oneshot-covnone-scratch/instrumented/active "$C/Test" 68933 5
