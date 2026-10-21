#!/usr/bin/env bash
# R586 plan r3: (1) the cost of per-call --coverage-json on a one-shot --codeunit call, against the
# same call without it; (2) whether an executed Sleep( statement shows as hit in --coverage-json (the
# premise of the Sleep fail-closed rule); (3) the Sleep no-op fact (a Sleep-only test's run time).
# Measurement tool only; works on scratch copies.
# Usage: covjson-cost.sh <v3 binary> <out file> <target dir> <tests dir> <test codeunit id> [runs]
set -u
B="$1"; OUT="$2"; APP="$3"; TST="$4"; CU="$5"; RUNS="${6:-10}"
P="$(cd "$(dirname "$0")" && pwd)"
export ALRUNNER_CACHE="${ALRUNNER_CACHE:-/work/tools/al-runtime-rs/cache}"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
ms() { awk "BEGIN{printf \"%.0f\", ($EPOCHREALTIME - $1) * 1000}"; }
{
echo "binary: $("$B" --version)"
echo "## 1 cost: $RUNS calls each, --codeunit $CU on $APP"
for mode in plain covjson; do
  tot=0; list=""
  for i in $(seq 1 "$RUNS"); do
    extra=(); [ "$mode" = covjson ] && extra=(--coverage-json "$W/cov-$i.json")
    t0=$EPOCHREALTIME
    timeout 900 "$B" test --output-json --isolation test --codeunit "$CU" "${extra[@]}" "$APP" "$TST" > "$W/o.json" 2>/dev/null
    rc=$?; d=$(ms "$t0"); tot=$((tot + d)); list="$list $d"
  done
  echo "  $mode: exit(last)=$rc total=${tot}ms per-call=[$list ] mean=$((tot / RUNS))ms"
done
echo "  covjson file size (last): $(wc -c < "$W/cov-$RUNS.json") bytes"
echo "## 2 Sleep statement coverage and 3 Sleep no-op (probe codeunit 50651, SleepHang only)"
cp -r "$P/probe-app" "$P/probe-tests" "$W/"
t0=$EPOCHREALTIME
timeout 900 "$B" test --output-json --isolation test --test-timeout-secs 3 --test-exact Codeunit50651.SleepHang --coverage-json "$W/sleep.json" "$W/probe-app" "$W/probe-tests" > "$W/s.json" 2>/dev/null
echo "  SleepHang alone at N=3: exit=$? wall=$(ms "$t0")ms row=$(grep -o '"status": "[a-z]*"' "$W/s.json" | head -1)"
bun -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const t of j.perTestCoverage){if(!/SleepHang/.test(t.test))continue;for(const f of t.coverage){if(!/ProbeHang/.test(f.file))continue;console.log("  "+t.test+" ProbeHang.Codeunit.al hit lines: "+f.statements.filter(s=>s.hits>0).map(s=>s.line).join(","))}}' "$W/sleep.json"
} | tee "$OUT"
