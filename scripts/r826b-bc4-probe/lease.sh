#!/usr/bin/env bash
# R-826b: hold the coord lease on bc4 for lane code across several driver calls.
#   lease.sh start     take the lease, record the token in $H/lease.txt (never printed), heartbeat until released
#   lease.sh release   release it; the token file is kept until `kraken coord release` says ok
# `start` runs in the foreground (run it in the background): it heartbeats every 60 s while $H/lease.pid names it.
set -u
SRV=bc4
LANE=code
H=/coord/handoff/R-826b/probe
mkdir -p "$H"
case "${1:-}" in
  start)
    out=$(kraken coord lease "$SRV" "$LANE" 2>&1) || { echo "lease refused (not printed)"; exit 2; }
    token=$(printf '%s' "$out" | grep -o '[0-9a-f]\{8\}-[0-9a-f-]\{27\}' | head -1)
    [ -n "$token" ] || { echo "no token found in the lease answer"; exit 2; }
    echo "$SRV $token $(date -u +%FT%TZ)" > "$H/lease.txt"
    echo $$ > "$H/lease.pid"
    echo "leased $SRV for lane $LANE at $(date -u +%FT%TZ); heartbeating"
    while [ -f "$H/lease.pid" ]; do
      sleep 20
      kraken coord heartbeat "$SRV" "$token" >/dev/null 2>&1 || echo "$(date -u +%T) heartbeat failed" >> "$H/lease.txt"
    done
    echo "heartbeat loop ended $(date -u +%FT%TZ)"
    ;;
  release)
    read -r _ token _ < "$H/lease.txt"
    rm -f "$H/lease.pid"
    sleep 1
    if kraken coord release "$SRV" "$token" >/dev/null 2>&1; then
      echo "released $SRV $(date -u +%FT%TZ)" >> "$H/lease.txt"
      echo "release ok"
    else
      echo "release FAILED $SRV $(date -u +%FT%TZ)" >> "$H/lease.txt"
      echo "release FAILED: lease kept"
      exit 1
    fi
    ;;
  *) echo "usage: lease.sh start|release"; exit 2 ;;
esac
