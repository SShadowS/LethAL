#!/usr/bin/env bash
# R-658: itest:hang with the BASELINE leg, on bc2 or bc3 only, under lane bugs' coord lease.
# Release the coord lease ONLY on gate exit 0 or 1 with the leg marker `passed` or absent, and the
# [itest target] line naming the leased server. HOLD on everything else (5 = STOP, 3, 130, 137, ...),
# whenever the leg marker reads `armed` or `stop`, and on any INT/TERM while the gate runs.
# Binding spec: docs/superpowers/specs/2026-10-22-r658-hang-baseline-leg-precommitment.md §5
# (00d508c4), plus the R-669 delta (/coord/handoff/R-658/precommitment-hang-leg-delta-draft.md):
# refuse an existing out-of-use marker before the lease, check the offline call's exit status, and
# a fresh per-run owner token (`owner: <32 hex>`) written ONLY into the in-use marker.
#
# Injectable for scripts/r658-hang-gate.test.ts (defaults are the live values):
#   LETHAL_COORD_ROOT (marker dir <root>/machine/out-of-use, resolved as in
#   packages/runner/itest/out-of-use.ts), R658_EVIDENCE_DIR, R658_WORKTREE,
#   R658_BEAT_SECS (heartbeat interval, 60), R658_HOLD_MAX_BEATS (hold loop cap; unset = forever).
# kraken, bun, git and openssl are found on PATH.
set -u
SRV=${1:-}
case "$SRV" in
  bc2) WANT="server=192.168.2.157:7149" ;;
  bc3) WANT="server=192.168.2.157:7249" ;;
  bc1) echo "refused: bc1 is never used for this gate"; exit 2 ;;
  *) echo "refused: server must be bc2 or bc3, got '$SRV'"; exit 2 ;;
esac
# The coord root, as outOfUseDir() resolves it: inside kraken a LETHAL_COORD_ROOT that differs from
# CG_COORD_ROOT refuses, and a missing <root>/machine refuses (never read as "no marker").
if [ -n "${KRAKEN_PROJECT:-}" ] && [ -n "${LETHAL_COORD_ROOT:-}" ] && [ "$LETHAL_COORD_ROOT" != "${CG_COORD_ROOT:-}" ]; then
  echo "refused: LETHAL_COORD_ROOT=$LETHAL_COORD_ROOT differs from CG_COORD_ROOT=${CG_COORD_ROOT:-(unset)}"; exit 2
fi
ROOT=${LETHAL_COORD_ROOT:-}
[ -n "$ROOT" ] || { [ -n "${KRAKEN_PROJECT:-}" ] && ROOT=${CG_COORD_ROOT:-}; }
ROOT=${ROOT:-/coord}
[ -d "$ROOT/machine" ] || { echo "refused: $ROOT/machine does not exist; the coord root is wrong"; exit 2; }
H=${R658_EVIDENCE_DIR:-$ROOT/handoff/R-658/hang-$SRV}
WT=${R658_WORKTREE:-/work/lethal-wt/r658}
OOU=$ROOT/machine/out-of-use/$SRV.md
BEAT=${R658_BEAT_SECS:-60}
MAXB=${R658_HOLD_MAX_BEATS:-}
CFG="lethal.config.$SRV.json"
STATE="$H/baseline-leg.state"
# (a) An existing marker (a STOP, a lapsed hold, an unreviewed failure) refuses before anything else.
[ -e "$OOU" ] && { echo "refused: $OOU exists"; cat "$OOU"; exit 2; }
mkdir -p "$H" "$ROOT/machine/out-of-use"
cd "$WT" || exit 9
# Offline checks, before any lease: a clean worktree, and the config's target line (no login printed).
[ -z "$(git status --porcelain)" ] || { echo "refused: $WT is dirty"; exit 2; }
SHA=$(git rev-parse HEAD)
# (b) The exit status counts, not only the printed line.
TL=$(LETHAL_ITEST_CONFIG="$CFG" bun -e 'import { itestConfigPath, printItestTarget } from "./packages/runner/itest/config-path"; printItestTarget(itestConfigPath("fixtures/sandbox-hang"));') \
  || { echo "refused: the offline target check failed: $TL"; exit 2; }
echo "$TL"
case "$TL" in *":7049"*) echo "refused: the config names bc1 (:7049)"; exit 2 ;; esac
case "$TL" in *"$WANT "*) ;; *) echo "refused: target line does not name $WANT"; exit 2 ;; esac
# (c) A fresh owner token per run: never printed, never in lease.txt, never exported.
OWNER=$(openssl rand -hex 16 2>/dev/null)
[[ "$OWNER" =~ ^[0-9a-f]{32}$ ]] || { echo "refused: openssl gave no 32-hex owner token"; exit 2; }
out=$(kraken coord lease "$SRV" bugs 2>&1) || { echo "lease refused: $out"; exit 2; }
token=$(printf '%s' "$out" | grep -o '[0-9a-f]\{8\}-[0-9a-f-]\{27\}' | head -1)
[ -n "$token" ] || { echo "no token in: $out"; exit 2; }
echo "$SRV $token $(date -u +%FT%TZ) head $SHA" > "$H/lease.txt"
# (d) $1 = reason, $2 = the owner token ONLY for the in-use mark. Every mark rewrites the whole file,
# so a STOP or hold rewrite drops the owner line in the same write that adds its reason.
mark() {  # the durable out-of-use marker (orchestrator ruling D-D), modelled on bc3.md
  {
    echo "# $SRV is OUT OF USE"
    echo
    [ -n "${2:-}" ] && echo "owner: $2"
    echo "- **Since:** $(date -u +%FT%TZ)"
    echo "- **Set by:** lethal-bugs (R-658 itest:hang BASELINE leg, head $SHA)"
    echo "- **Reason:** $1"
    echo "- **Op:** $(grep -o 'opAttemptId[^ ,]*' "$H/hang.log" 2>/dev/null | tail -1 || true)"
    echo "- **Coord lease:** $SRV, held by lane bugs' wrapper scripts/r658-hang-gate.sh; token in $H/lease.txt"
    echo "- **Evidence:** $H (hang.log, baseline-leg.state, copied stores and quarantine dirs)"
    echo
    echo "## How to clear it"
    echo "1. The owner restarts $SRV (a host action)."
    echo "2. Run \`bun scripts/bc-linux-setup.ts --server $SRV\` until it is clean."
    echo "3. Lane bugs stops the wrapper, releases the coord lease, and deletes this file."
  } > "$OOU"
}
beat() { kraken coord heartbeat "$SRV" "$token" >/dev/null 2>&1 || echo "$(date -u +%T) heartbeat failed" >> "$H/lease.txt"; }
( while :; do sleep "$BEAT"; beat; done ) &
hb=$!
release() {
  kill "$hb" 2>/dev/null
  if kraken coord release "$SRV" "$token" >/dev/null 2>&1; then
    echo "released $SRV $(date -u +%FT%TZ)" >> "$H/lease.txt"
  else
    echo "release FAILED $SRV $(date -u +%FT%TZ)" >> "$H/lease.txt"
  fi
}
hold() {
  trap - EXIT INT TERM
  kill "$hb" 2>/dev/null
  mark "STOP or hold: $1. The control-app lease and lethal doctor may read $SRV CLEAN; do not trust that."
  msg="STOP: $SRV coord lease HELD, do not release until the owner restart + re-setup"
  echo "$msg"
  echo "LANE: SendMessage lethal-orchestrator NOW: $SRV STOP ($1), marker $OOU"
  echo "$(date -u +%FT%TZ) $msg ($1; token in this file)" >> "$H/lease.txt"
  n=0
  # ponytail: R658_HOLD_MAX_BEATS exists only so the tests can end the hold; live runs leave it unset.
  while [ -z "$MAXB" ] || [ "$n" -lt "$MAXB" ]; do sleep "$BEAT"; beat; n=$((n + 1)); done
  exit 4
}
trap release EXIT
rm -f "$STATE"
mark "in use by an R-658 itest:hang run (started $(date -u +%FT%TZ)); not yet finished" "$OWNER"
echo "$(date -u +%T) start at $SHA on $SRV"
sig=""
trap 'sig=INT' INT
trap 'sig=TERM' TERM
LETHAL_OUT_OF_USE_OWNER="$OWNER" LETHAL_ITEST_HANG=1 LETHAL_ITEST_CONFIG="$CFG" LETHAL_ITEST_HANG_LEG_STATE="$STATE" \
  LETHAL_ITEST_HANG_EVIDENCE_DIR="$H" bun run itest:hang > "$H/hang.log" 2>&1
g=$?
st=$(cat "$STATE" 2>/dev/null || echo absent)
echo "$(date -u +%T) gate exit=$g leg=$st${sig:+ (signal $sig)}"
[ -n "$sig" ] && hold "signal $sig, gate exit $g, leg $st"
case "$st" in armed|stop) hold "leg marker $st, gate exit $g" ;; esac
case "$(grep -m1 '^\[itest target\]' "$H/hang.log")" in
  *"$WANT "*) ;;
  *) hold "the gate's [itest target] line does not name $WANT, gate exit $g" ;;
esac
case "$g:$st" in
  0:passed) rm -f "$OOU"; exit 0 ;;
  0:absent|1:passed|1:absent) mark "gate exit $g, leg $st: released, believed clean; lane reviews and clears"; exit "$g" ;;
esac
hold "gate exit $g, leg $st"
