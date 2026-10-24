#!/usr/bin/env bash
# R-705 / R706: run the client-path probe on bc1 under lane bugs' coord lease. Copied from
# scripts/r661-hub-probe/run-probe.sh.
# Lease -> token recorded -> heartbeat every 60 s -> the driver (foreground) -> release.
# The coord lease is released ONLY when the driver exits 0, 1, 2 or 3. Any other exit (5 = HOLD;
# 130/137/... = a signal or the OOM killer) and any INT/TERM while the driver runs go to HOLD:
# the coord lease is KEPT and heartbeated in the foreground until this script is killed by hand,
# and bc1 is marked out of use. The release comes only after the owner's restart and re-setup.
set -u
SRV=bc1
H=/coord/handoff/R-705/probe
WT=${R706_WORKTREE:-/work/lethal-wt/r706}
OOU=/coord/machine/out-of-use/$SRV.md
[ -e "$OOU" ] && { echo "refused: $OOU exists"; grep -v '^owner:' "$OOU"; exit 2; }
mkdir -p "$H"
cd "$WT" || exit 9
[ -z "$(git status --porcelain -- scripts/r706-client-probe)" ] || { echo "refused: probe sources not committed"; exit 2; }
git cat-file -e "HEAD:scripts/r706-client-probe/drive.ts" 2>/dev/null || { echo "refused: HEAD does not contain the probe sources"; exit 2; }
out=$(kraken coord lease "$SRV" bugs 2>&1) || { echo "lease refused: $out"; exit 2; }
token=$(printf '%s' "$out" | grep -o '[0-9a-f]\{8\}-[0-9a-f-]\{27\}' | head -1)
[ -n "$token" ] || { echo "no token in: $out"; exit 2; }
echo "$SRV $token $(date -u +%FT%TZ) head $(git rev-parse HEAD)" > "$H/lease.txt"
beat() { kraken coord heartbeat "$SRV" "$token" >/dev/null 2>&1 || echo "$(date -u +%T) heartbeat failed" >> "$H/lease.txt"; }
( while :; do sleep 60; beat; done ) &
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
  # Never release: drop every trap and the background heartbeat, then heartbeat here only.
  trap - EXIT INT TERM
  kill "$hb" 2>/dev/null
  {
    echo "# $SRV is OUT OF USE"
    echo
    echo "- **Set by:** lethal-bugs (R-705/R706 client-path probe), $(date -u +%FT%TZ)"
    echo "- **Why:** $1"
    echo "- **Coord lease:** held by lane bugs' scripts/r706-client-probe/run-probe.sh; token in $H/lease.txt"
    echo "- **Clears after:** the owner's check of bc1 (probe apps, hub session) and a clean bc-linux-setup.ts --server $SRV"
  } > "$OOU"
  msg="STOP: $SRV coord lease HELD, do not release until the owner has checked $SRV"
  echo "$msg"
  echo "$(date -u +%FT%TZ) $msg ($1; token in this file)" >> "$H/lease.txt"
  echo "token: $token"
  while :; do sleep 60; beat; done
}
trap release EXIT
echo "$(date -u +%T) start at $(git log --oneline -1) on $SRV"
# A signal while the driver runs means apps or a session may be live: hold, never release.
sig=""
trap 'sig=INT' INT
trap 'sig=TERM' TERM
bun scripts/r706-client-probe/drive.ts
g=$?
echo "$(date -u +%T) driver exit=$g${sig:+ (signal $sig)}"
[ -n "$sig" ] && hold "signal $sig, driver exit $g"
case $g in
  0|1|2|3) exit "$g" ;;
esac
hold "driver exit $g"
