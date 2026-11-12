#!/usr/bin/env bash
# R905: run a command in the first free heavy slot and record the slot's class.
#
#   scripts/heavy-slot.sh [--wait] <baseapp|other> <cmd...>
#
# Use `baseapp` for a job over BC.History or any copy of it (even under /coord/handoff), `other`
# for everything else (al-runner v3 gates, campaigns, measurements). It takes the first free
# /coord/locks/heavy.<n> (n = 1, 2, 3; LETHAL_HEAVY_LOCK_DIR overrides the folder) with flock,
# writes its own pid into the lock file and heavy.<n>.class ("<class> <pid>"), then runs the same
# guard as corpus-snapshot (scripts/heavy-slot-guard.ts): while a BaseApp-class job runs, or a slot
# has no class, at most two heavy jobs run container-wide, else three. If the guard refuses, the
# slot is released and the command does not run. The class file is removed on exit.
#
# R934 `--wait`: instead of exit 75, take a numbered ticket in <lock dir>/heavy-queue/ and wait in
# FIFO order. Only the oldest LIVE ticket tries for a slot, every LETHAL_HEAVY_POLL_S seconds
# (default 5); a ticket whose pid is gone is dropped, so a dead waiter never blocks the queue. The
# caps are the guard's, unchanged, and a waiter holding no slot is no job to either guard. A caller
# WITHOUT --wait exits 75 while any live ticket waits, so it cannot overtake the queue.
#
# Exit code: the command's; 75 when all slots are held, the guard refused or a waiter queues (retry
# later); 2 for a bad class, a bad lock folder or a flock failure (retrying never helps).
# Do NOT wrap corpus-snapshot.ts or v3-timing.ts in this: they take their own slot, so the job
# would hold two (and they do not queue).
set -u
wait=0
if [ "${1:-}" = "--wait" ]; then
  wait=1
  shift
fi
cls="${1:-}"
case "$cls" in baseapp | other) ;; *)
  echo "heavy-slot: first argument must be baseapp or other" >&2
  exit 2
  ;;
esac
shift
[ $# -gt 0 ] || { echo "heavy-slot: no command" >&2; exit 2; }
dir="${LETHAL_HEAVY_LOCK_DIR:-/coord/locks}"
mkdir -p "$dir" || exit 2
qdir="$dir/heavy-queue"
mkdir -p "$qdir" || exit 2
poll="${LETHAL_HEAVY_POLL_S:-5}"
ticket=""
class=""
cleanup() {
  [ -n "$ticket" ] && rm -f "$qdir/$ticket"
  [ -n "$class" ] && rm -f "$class"
}
trap cleanup EXIT

# The oldest ticket whose pid is alive; dead ones are removed on the way.
head_ticket() {
  local f pid
  for f in $(ls "$qdir" 2>/dev/null | sort); do
    pid="${f#*.}"
    if [ -d "/proc/$pid" ]; then
      echo "$f"
      return
    fi
    rm -f "$qdir/$f"
  done
}

# One pass over the slots: runs the command and exits with its code, or returns 75.
try_once() {
  local n rc g
  for n in 1 2 3; do
    # >> not >: > would wipe the pid a corpus-snapshot holder keeps in the lock file.
    exec 9>>"$dir/heavy.$n" || exit 2
    flock -n 9
    rc=$?
    if [ "$rc" -eq 1 ]; then # busy
      exec 9>&-
      continue
    fi
    [ "$rc" -eq 0 ] || exit 2
    class="$dir/heavy.$n.class"
    echo "$$" >"$dir/heavy.$n" # the guard trusts a holder it can name by pid
    echo "$cls $$" >"$class"
    "${BUN:-bun}" "$(dirname "$0")/heavy-slot-guard.ts" "$dir" "$n" "$cls"
    g=$?
    if [ "$g" -eq 0 ]; then
      [ -n "$ticket" ] && rm -f "$qdir/$ticket"
      ticket=""
      "$@"
      exit $?
    fi
    rm -f "$class" # refused: the slot is released and the command does not run
    class=""
    exec 9>&-
    [ "$g" -eq 75 ] && return 75
    exit 2
  done
  return 75
}

if [ "$wait" -eq 0 ]; then
  if [ -n "$(head_ticket)" ]; then
    echo "heavy-slot: a --wait job queues for a slot ($qdir); not overtaking it" >&2
    exit 75
  fi
  try_once "$@"
  echo "heavy-slot: all three heavy slots held or the guard refused ($dir/heavy.1, heavy.2, heavy.3)" >&2
  exit 75
fi

# --wait: a numbered ticket, then FIFO.
exec 8>>"$dir/heavy-queue.lock" || exit 2
flock 8 || exit 2
seq=$(cat "$dir/heavy-queue.seq" 2>/dev/null)
seq=$((${seq:-0} + 1))
echo "$seq" >"$dir/heavy-queue.seq"
ticket="$(printf '%012d' "$seq").$$"
: >"$qdir/$ticket"
exec 8>&-
echo "heavy-slot: queued as ticket $seq ($qdir)" >&2
while :; do
  if [ "$(head_ticket)" = "$ticket" ]; then
    try_once "$@"
  fi
  sleep "$poll"
done
