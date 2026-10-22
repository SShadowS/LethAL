#!/usr/bin/env bash
# R586 plan measurements (2026-10-21). Measurement tool only; works on scratch copies.
#   1. sandbox-names: which of the 12 tests can be selected by --test-exact / --test (alpha.2).
#   2. sandbox-names: --codeunit 78850 + --coverage-json gives per-test coverage under AL names.
#   3. a mutated quoted-name procedure is killed through a --codeunit run.
#   4. probe: the row of a test read from a --codeunit run equals the row of a --test-exact run.
#   5. alc cost: the sandbox-app instrumented batch, the sandbox-tests app against it, and a
#      broken batch (alc rejects it; v3 runs it and passes a test).
# Usage: plan-measure.sh <v3 binary> <out dir> <names fixtures parent> <sandbox instrumented active dir> <sandbox .alpackages>
#   <names fixtures parent> holds sandbox-names and sandbox-names-tests (git archive of master).
set -u
B="$1"; OUT="$2"; NAMES="$3"; SB="$4"; PK="$5"
P="$(cd "$(dirname "$0")" && pwd)"
R="$(cd "$P/../.." && pwd)"
export ALRUNNER_CACHE="${ALRUNNER_CACHE:-/work/tools/al-runtime-rs/cache}"
ALC="${LETHAL_ALC_DIR:?set LETHAL_ALC_DIR}/alc"
mkdir -p "$OUT"; W="$OUT/work"; rm -rf "$W"; mkdir -p "$W"
log="$OUT/plan-measure.txt"; : > "$log"
say() { printf '%s\n' "$*" | tee -a "$log"; }
wall() { awk "BEGIN{printf \"%.2f\", $EPOCHREALTIME - $1}"; }

say "binary: $("$B" --version)"
say "alc: $("$ALC" --version 2>&1 | head -1)"
say "## 1 selection on sandbox-names"
for t in "Space Step" "Dash-Step" "Paren(Step)" "Dot.Step" "Slash/Step" "Amp&Step" "7Digit Step" "Default" "Blåbær Step" "Twin Pair" "Twin_PairLong" "PlainControl"; do
  (cd "$NAMES" && timeout 900 "$B" test --output-json --test-exact "Codeunit78850.$t" sandbox-names sandbox-names-tests > "$W/sel.json" 2>/dev/null); e1=$?
  (cd "$NAMES" && timeout 900 "$B" test --output-json --test "Codeunit78850.$t" sandbox-names sandbox-names-tests > "$W/sel2.json" 2>/dev/null); e2=$?
  say "  $t: --test-exact exit=$e1 rows=$(grep -c '"name": "Codeunit' "$W/sel.json") ; --test exit=$e2 rows=$(grep -c '"name": "Codeunit' "$W/sel2.json")"
done
say "## 2 per-test coverage by codeunit run"
(cd "$NAMES" && timeout 900 "$B" test --output-json --codeunit 78850 --coverage-json "$W/cov.json" sandbox-names sandbox-names-tests > "$W/cu.json" 2>/dev/null); say "  exit=$?"
say "  tests in perTestCoverage: $(grep -o '"test": "[^"]*"' "$W/cov.json" | tr '\n' ' ')"
say "## 3 kill of a quoted-name test through --codeunit"
mkdir -p "$W/mut"; cp -r "$NAMES/sandbox-names" "$NAMES/sandbox-names-tests" "$W/mut/"
bun "$P/replace-in-copy.ts" "$W/mut/sandbox-names/src/NamesCalc.Codeunit.al" "exit(x + 1);" "exit(x - 1);"
(cd "$W/mut" && timeout 900 "$B" test --output-json --codeunit 78850 sandbox-names sandbox-names-tests > "$W/mut.json" 2>/dev/null); say "  exit=$?"
say "  non-pass rows: $(grep -o '"name": "[^"]*"\|"status": "[a-z]*"' "$W/mut.json" | paste - - | grep -v pass | tr '\n' ' ')"
say "## 4 --codeunit row vs --test-exact row (probe, --isolation test)"
for sel in "--codeunit 50650" "--test-exact Codeunit50650.PersistB"; do
  timeout 900 "$B" test --output-json --isolation test $sel "$P/probe-app" "$P/probe-tests" > "$W/p.json" 2>/dev/null; e=$?
  say "  [$sel] exit=$e PersistB: $(bun -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const t=j.tests.find(x=>x.name==="Codeunit50650.PersistB");console.log(JSON.stringify({status:t.status,message:t.message}))' "$W/p.json")"
done
say "## 5 alc cost"
cp -r "$SB" "$W/sb"
for i in 1 2 3; do t0=$EPOCHREALTIME; timeout 900 "$ALC" "/project:$W/sb" "/packagecachepath:$PK" "/out:$W/sb-$i.app" > "$W/sb-$i.log" 2>&1; say "  sandbox-app batch run $i: exit=$? wall=$(wall "$t0")s"; done
mkdir -p "$W/tpk"; cp "$W/sb-1.app" "$W/tpk/"
for i in 1 2; do t0=$EPOCHREALTIME; timeout 900 "$ALC" "/project:$R/fixtures/sandbox-tests" "/packagecachepath:$W/tpk" "/out:$W/tests-$i.app" > "$W/tests-$i.log" 2>&1; say "  sandbox-tests vs batch run $i: exit=$? wall=$(wall "$t0")s"; done
cp -r "$SB" "$W/sbbad"
bun "$P/replace-in-copy.ts" "$W/sbbad/SandboxLogic.Codeunit.al" "begin" "begin NoSuchVar := 1;"
t0=$EPOCHREALTIME; timeout 900 "$ALC" "/project:$W/sbbad" "/packagecachepath:$PK" "/out:$W/bad.app" > "$W/bad.log" 2>&1; say "  broken batch: alc exit=$? wall=$(wall "$t0")s $(grep -o 'error AL[0-9]*' "$W/bad.log" | head -1)"
timeout 900 "$B" test --output-json "$W/sbbad" "$R/fixtures/sandbox-tests" > "$W/bad-v3.json" 2>/dev/null
say "  broken batch on v3: exit=$? $(grep -o '"passed": [0-9]*\|"notRun": [0-9]*' "$W/bad-v3.json" | head -2 | tr '\n' ' ')"
