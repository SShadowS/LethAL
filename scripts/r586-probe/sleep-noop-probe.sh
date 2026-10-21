#!/usr/bin/env bash
# R586 plan r4: the `sleep-is-noop` fact and the Sleep rule's raw premise, on codeunit 50660 (NO CPU-bound
# sibling: that isolation from #5611 is load-bearing). A light run (one codeunit, under a second expected).
# Writes, per case: exit code, wall ms, each row's status and message, and the hit lines of ProbeSleeper and
# ProbeSleep in --coverage-json. Measurement tool only; scratch copies only.
# Expected on alpha.2 (lane, sleep-noop-recheck.md): every test well under 1 s of wall, Sleep tests `pass` with
# 0 ms, LongSleepThenAssert FAILS ("after sleep <small n>"), with and without --test-timeout-secs.
# Usage: sleep-noop-probe.sh <v3 binary> <out file> [N]
set -u
B="$1"; OUT="$2"; N="${3:-3}"
P="$(cd "$(dirname "$0")" && pwd)"
export ALRUNNER_CACHE="${ALRUNNER_CACHE:-/work/tools/al-runtime-rs/cache}"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
cp -r "$P/probe-app" "$P/probe-tests" "$W/"
cp "$P/extras/ProbeSleeper.Codeunit.al" "$W/probe-app/src/"
cp "$P/extras/ProbeSleep.Codeunit.al" "$W/probe-tests/src/"
ms() { awk "BEGIN{printf \"%.0f\", ($EPOCHREALTIME - $1) * 1000}"; }
{
echo "binary: $("$B" --version)"
for args in "--test-timeout-secs $N" ""; do
  t0=$EPOCHREALTIME
  # shellcheck disable=SC2086
  timeout 900 "$B" test --output-json --isolation test --codeunit 50660 $args --coverage-json "$W/cov.json" \
    "$W/probe-app" "$W/probe-tests" > "$W/o.json" 2>/dev/null
  rc=$?
  echo "## --codeunit 50660 ${args:-<no timeout flag>}: exit=$rc wall=$(ms "$t0")ms"
  bun -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const t of j.tests)console.log(`  ${t.method} ${t.status} ${t.durationMs}ms ${JSON.stringify(t.message??"")}`)' "$W/o.json"
  bun -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const t of j.perTestCoverage??[])for(const f of t.coverage)if(/ProbeSleep/.test(f.file))console.log(`  cov ${t.test} ${f.file.split("/").pop()}: ${f.statements.filter(s=>s.hits>0).map(s=>s.line).join(",")}`)' "$W/cov.json"
done
} | tee "$OUT"
