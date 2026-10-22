#!/usr/bin/env bash
# R586 plan r2: alc cost of the compile proof on the R546 CDO slice (a CORPUS job: one at a time,
# and wait for at most one other heavy job). Works on scratch copies; prints wall times and counts
# only, never source text. Measurement tool only.
# Usage: cdo-alc-cost.sh <instrumented active dir of the slice batch> <cdo checkout> <scratch dir> <out file>
set -u
ACTIVE="$1"; CDO="$2"; S="$3"; OUT="$4"
ALC="${LETHAL_ALC_DIR:?set LETHAL_ALC_DIR}/alc"
mkdir -p "$S"
wall() { awk "BEGIN{printf \"%.2f\", $EPOCHREALTIME - $1}"; }
rm -rf "$S/cdo"; cp -r "$ACTIVE" "$S/cdo"
for i in 1 2; do
  t0=$EPOCHREALTIME
  timeout 900 "$ALC" "/project:$S/cdo" "/packagecachepath:$CDO/Test/.alpackages" "/out:$S/cdo-$i.app" > "$S/cdo-$i.log" 2>&1
  rc=$?
  echo "batch run $i exit=$rc wall=$(wall "$t0")s errors=$(grep -c 'error AL' "$S/cdo-$i.log")" >> "$OUT"
done
# The test app against the batch's .app (the proof's second compile, plan r2 §3).
rm -rf "$S/cdotest" "$S/cdotpk"; cp -r "$CDO/Test" "$S/cdotest"; rm -rf "$S/cdotest/.alpackages"
mkdir -p "$S/cdotpk"; cp "$CDO"/Test/.alpackages/*.app "$S/cdotpk/"; cp "$S/cdo-1.app" "$S/cdotpk/"
for i in 1 2; do
  t0=$EPOCHREALTIME
  timeout 900 "$ALC" "/project:$S/cdotest" "/packagecachepath:$S/cdotpk" "/out:$S/cdotest-$i.app" > "$S/cdotest-$i.log" 2>&1
  rc=$?
  echo "test app vs batch run $i exit=$rc wall=$(wall "$t0")s errors=$(grep -c 'error AL' "$S/cdotest-$i.log")" >> "$OUT"
done
# Sleep( call lines per source set (counts only), for plan r2 §6.
for d in Cloud Test; do
  echo "$d: lines with a Sleep( call: $(grep -rhiE '\bSleep\s*\(' --include=*.al "$CDO/$d" | wc -l)" >> "$OUT"
done
for a in "$CDO"/Test/.alpackages/*.app; do
  n=$(timeout 300 unzip -p "$a" '*.al' 2>/dev/null | grep -ciE '\bSleep\s*\(')
  echo "$(basename "$a"): lines with a Sleep( call: $n" >> "$OUT"
done
cat "$OUT"
