#!/usr/bin/env bash
# R586 contract probes: run alrunner (al-runtime-rs) on the invented probe projects and log, per
# case, the exact command, the exit code, stdout and stderr. Measurement tool only.
# Usage: contract.sh <alrunner binary> <out dir> [case ...]
set -u
A="$1"; OUT="$2"; shift 2
P="$(cd "$(dirname "$0")" && pwd)"
APP="$P/probe-app"; TST="$P/probe-tests"
export ALRUNNER_CACHE="${ALRUNNER_CACHE:-/work/tools/al-runtime-rs/cache}"
mkdir -p "$OUT"

run() { # run <case> <args...>
  local name="$1"; shift
  local t0=$EPOCHREALTIME
  (cd "$OUT" && timeout 900 "$A" "$@" > "$OUT/$name.out" 2> "$OUT/$name.err")
  local rc=$?
  local t1=$EPOCHREALTIME
  printf '%s\texit=%s\twall=%ss\t%s %s\n' "$name" "$rc" "$(awk "BEGIN{printf \"%.2f\", $t1 - $t0}")" "$A" "$*" >> "$OUT/INDEX.tsv"
}

want() { [ $# -eq 0 ] && return 0; for c in "${WANT[@]}"; do [ "$c" = "$1" ] && return 0; done; return 1; }
WANT=("$@")
w() { [ ${#WANT[@]} -eq 0 ] || want "$1"; }

J=(--output-json)
# --- selection and names (R551, R557) ---
w sel-substring    && run sel-substring    test "${J[@]}" --test Codeunit50650.Passes "$APP" "$TST"
w sel-exact        && run sel-exact        test "${J[@]}" --test Codeunit50650.Passes --test-exact Codeunit50650.Passes "$APP" "$TST"
w sel-exclude      && run sel-exclude      test "${J[@]}" --test Codeunit50650.Passes --exclude-test Codeunit50650.PassesToo "$APP" "$TST"
w sel-space        && run sel-space        test "${J[@]}" --test-exact "Codeunit50650.Space Step" "$APP" "$TST"
w sel-dot          && run sel-dot          test "${J[@]}" --test-exact "Codeunit50650.Dot.Name" "$APP" "$TST"
w sel-digit        && run sel-digit        test "${J[@]}" --test-exact "Codeunit50650.1Leading" "$APP" "$TST"
w sel-default      && run sel-default      test "${J[@]}" --test-exact "Codeunit50650.Default" "$APP" "$TST"
w sel-nordic       && run sel-nordic       test "${J[@]}" --test-exact "Codeunit50650.Blåbær Step" "$APP" "$TST"
w sel-quoted       && run sel-quoted       test "${J[@]}" --test-exact 'Codeunit50650."Space Step"' "$APP" "$TST"
w sel-none         && run sel-none         test "${J[@]}" --test Codeunit0.__lethal_provision_only__ "$APP" "$TST"
w sel-exact-none   && run sel-exact-none   test "${J[@]}" --test Codeunit0.LethalR551NoSuchTest --test-exact Codeunit0.LethalR551NoSuchTest "$APP" "$TST"
w sel-v2-argv      && run sel-v2-argv      test --output-json --isolation test --test Codeunit50650.Fails --auto-provision "$APP" "$TST"
w bad-flag         && run bad-flag         test --lethal-wire-contract-probe "$APP" "$TST"
w bad-flag-top     && run bad-flag-top     --lethal-wire-contract-probe
w v2-server-flag   && run v2-server-flag   --server
# --- isolation ---
w iso-codeunit     && run iso-codeunit     test "${J[@]}" --codeunit 50650 --test PersistB --test PersistA "$APP" "$TST"
w iso-test         && run iso-test         test "${J[@]}" --isolation test --codeunit 50650 --test PersistB --test PersistA "$APP" "$TST"
w iso-test-only-b  && run iso-test-only-b  test "${J[@]}" --isolation test --test-exact Codeunit50650.PersistB "$APP" "$TST"
w iso-disabled     && run iso-disabled     test "${J[@]}" --isolation disabled --test-exact Codeunit50650.Passes "$APP" "$TST"
# --- defines and resources ---
w def-none         && run def-none         test "${J[@]}" --test-exact Codeunit50650.ArmIs "$APP" "$TST"
w def-a            && run def-a            test "${J[@]}" --define LETHALA --test-exact Codeunit50650.ArmIs "$APP" "$TST"
w def-b            && run def-b            test "${J[@]}" --preprocessor-symbols LETHALB --test-exact Codeunit50650.ArmIs "$APP" "$TST"
w res              && run res              test "${J[@]}" --test-exact Codeunit50650.ResourceIs "$APP" "$TST"
# --- hang and timeout (R516, R518) ---
w hang-cpu         && run hang-cpu         test "${J[@]}" --test-timeout-secs 3 --codeunit 50651 "$APP" "$TST"
w hang-cpu-env     && AL_RUNNER_TEST_TIMEOUT_SEC=2 run hang-cpu-env test "${J[@]}" --test-exact Codeunit50651.CpuHang "$APP" "$TST"
w hang-sleep       && run hang-sleep       test "${J[@]}" --test-timeout-secs 1 --test-exact Codeunit50651.SleepHang "$APP" "$TST"
# --- coverage (R220, R383, R407) ---
w cov              && run cov              test "${J[@]}" --codeunit 50652 --coverage-out "$OUT/cov.cobertura.xml" --coverage-json "$OUT/cov.json" "$APP" "$TST"
w cov-one          && run cov-one          test "${J[@]}" --test-exact Codeunit50652.CoversOnlyA --coverage-out "$OUT/cov-one.cobertura.xml" "$APP" "$TST"
# --- refusals and environment ---
w refusals         && run refusals         test "${J[@]}" --verbose --codeunit 50653 "$APP" "$TST"
w refusals-allow   && run refusals-allow   test "${J[@]}" --allow-not-run --codeunit 50653 "$APP" "$TST"
w perms            && run perms            test "${J[@]}" --verbose --codeunit 50654 "$APP" "$TST"
w junit            && run junit            test --junit "$OUT/refusals.junit.xml" --codeunit 50653 "$APP" "$TST"
exit 0
