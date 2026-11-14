#!/usr/bin/env bash
# R905: run a command in the first free heavy slot and record the slot's class.
#
#   scripts/heavy-slot.sh [--wait] [--peak serve|baseline|gate|build|<GiB>] <baseapp|other> <cmd...>
#
# R952 (R953) `--peak`: the job's expected memory peak (serve 8, baseline 12, gate 2, build 1 GiB, or
# a number); none = the class default (other 8, baseapp 12). It goes into the class file
# ("<class> <pid> <peak>") and the guard admits the job only when the container's cgroup has room for
# it: used + peak + reserve and the held slots' peaks + peak + reserve both fit under memory.max
# (scripts/heavy-slot-class.ts, memoryVerdict). A memory refusal is a guard refusal like any other.
# R960 (owner ruling 2026-11-13): where the cgroup names a limit, memory is the ONLY rule: no job
# count, no BaseApp-class cap; a heavy job in no slot counts at its class default peak. The six slot
# files are a ceiling that binds only when six small jobs run at once. On a
# host with no cgroup limit, the old count rule (two jobs while a BaseApp-class job runs, else
# three) still decides.
#
# Use `baseapp` for a job over BC.History or any copy of it (even under /coord/handoff), `other`
# for everything else (al-runner v3 gates, campaigns, measurements). It takes the first free
# /coord/locks/heavy.<n> (n = 1..6; LETHAL_HEAVY_LOCK_DIR overrides the folder) with flock,
# writes its own pid into the lock file and heavy.<n>.class ("<class> <pid> <peak>"), then runs the
# guard (scripts/heavy-slot-guard.ts). If the guard refuses, the slot is released and the command
# does not run. The class file is removed on exit.
#
# R934 `--wait`: instead of exit 75, take a numbered ticket in <lock dir>/heavy-queue/ and wait in
# FIFO order. Only the oldest LIVE ticket tries for a slot, every LETHAL_HEAVY_POLL_S seconds
# (default 5); a ticket whose pid is gone, or is no longer a heavy-slot.sh, is dropped, so a dead
# waiter never blocks the queue. Admission is the guard's, and a waiter holding no slot is no job
# to it. A caller WITHOUT --wait exits 75 while any live ticket waits, so it
# cannot overtake the queue.
# A waiter the GUARD refused (a free slot, but no room: its peak does not fit the memory left) marks
# its ticket `.refused`. It then retries every poll out of turn, and no longer
# blocks the waiters behind it or plain callers, so a slot it may not take is not left empty. The
# price: a refused waiter can be overtaken while it stays refused. corpus-snapshot.ts and
# v3-timing.ts take their slots without looking at the queue.
# R991 (starvation): only for a while. The marker keeps the time of the FIRST refusal; once a ticket
# has been refused for LETHAL_HEAVY_STARVE_S seconds (default 900) it is the queue's head again, so
# no later waiter and no plain caller is admitted before it: the held slots drain until it fits. A job
# that can never fit (its peak plus the reserve over memory.max) is failed by the guard (exit 2), so
# it never holds the head.
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
peak=""
if [ "${1:-}" = "--peak" ]; then
  case "${2:-}" in
  serve) peak=8 ;;
  baseline) peak=12 ;;
  gate) peak=2 ;;
  build) peak=1 ;;
  *)
    # a zero peak passes here and is refused by the guard (exit 2, the command never runs)
    if [[ "${2:-}" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
      peak="$2"
    else
      echo "heavy-slot: --peak takes serve, baseline, gate, build or a number of GiB above 0" >&2
      exit 2
    fi
    ;;
  esac
  shift 2
fi
cls="${1:-}"
case "$cls" in baseapp | other) ;; *)
  echo "heavy-slot: first argument must be baseapp or other" >&2
  exit 2
  ;;
esac
shift
[ -n "$peak" ] || { [ "$cls" = baseapp ] && peak=12 || peak=8; }
[ $# -gt 0 ] || { echo "heavy-slot: no command" >&2; exit 2; }
case "$1" in --wait | --peak)
  echo "heavy-slot: $1 goes before the class (order: --wait, --peak, class)" >&2
  exit 2
  ;;
esac
dir="${LETHAL_HEAVY_LOCK_DIR:-/coord/locks}"
mkdir -p "$dir" || exit 2
qdir="$dir/heavy-queue"
mkdir -p "$qdir" || exit 2
poll="${LETHAL_HEAVY_POLL_S:-5}"
starve="${LETHAL_HEAVY_STARVE_S:-900}"
ticket=""
class=""
# R992: the admitted job, for its line in <lock dir>/heavy-peaks.tsv (written by `cleanup`, so a job this
# shell ends by a signal gets its line too): when it started, its slot, the sampler and its peak file.
job_started=""
job_slot=""
job_cmd=""
sampler=""
peakfile=""
cleanup() {
  local rc=$?
  # Only this shell: a forked copy of it (the sampler's, signalled before it becomes bun) must neither
  # write a line nor remove this job's class file and ticket.
  [ "$BASHPID" = "$$" ] || return 0
  if [ -n "$job_started" ]; then
    # SIGKILL, never SIGTERM: a SIGTERM that reaches bun while it starts can be lost (the sampler, which
    # ends only when this shell does, and this shell, waiting for it, would wait for each other). It
    # holds nothing: a cut sample reads `?`.
    kill -KILL "$sampler" 2>/dev/null
    wait "$sampler" 2>/dev/null
    # start, end, slot, class, declared GiB, measured GiB (`?`: no sample yet), exit code, the class file
    # (its ` small` mark), the command (tabs and line ends made spaces, so one job is one line).
    printf '%s\t%s\theavy.%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$job_started" "$(date -u +%FT%TZ)" "$job_slot" "$cls" \
      "$peak" "$([ -s "$peakfile" ] && awk '{printf "%.2f", $1 / 1048576}' "$peakfile" || echo '?')" "$rc" \
      "$(cat "$class" 2>/dev/null)" "$job_cmd" >>"$dir/heavy-peaks.tsv"
    rm -f "$peakfile"
  fi
  [ -n "$ticket" ] && rm -f "$qdir/$ticket" "$qdir/$ticket.refused"
  [ -n "$class" ] && rm -f "$class"
}
trap cleanup EXIT
# A signal's exit code, not the last command's (`$?` in an EXIT trap run by a signal is the latter).
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# The oldest live ticket that the guard has not refused, or (R991) has refused for `starve` seconds
# or more; dead tickets (and their markers) are removed on the way. Live = the pid exists AND is a
# heavy-slot.sh, so a reused pid is not a waiter.
head_ticket() {
  local f pid now
  now=$(date +%s)
  for f in $(ls "$qdir" 2>/dev/null | sort); do
    case "$f" in *.refused) continue ;; esac
    pid="${f#*.}"
    if ! grep -qa "heavy-slot.sh" "/proc/$pid/cmdline" 2>/dev/null; then
      rm -f "$qdir/$f" "$qdir/$f.refused"
      continue
    fi
    if [ -e "$qdir/$f.refused" ]; then
      # a young refusal lets later work pass; an old one holds the head (R991)
      [ $((now - $(stat -c %Y "$qdir/$f.refused" 2>/dev/null || echo "$now"))) -ge "$starve" ] || continue
    fi
    echo "$f"
    return
  done
}

# One pass over the slots: runs the command and exits with its code, or returns 75 (all held) or
# 76 (the guard refused).
try_once() {
  local n rc g
  for n in 1 2 3 4 5 6; do # R960: SLOTS in corpus-snapshot.ts
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
    echo "$cls $$ $peak" >"$class"
    # R992: one guard at a time (a lock beside the slots): two small jobs deciding together would each
    # see the other's class file before it carries ` small`, and both be admitted past the limit.
    flock "$dir/heavy-guard.lock" "${BUN:-bun}" "$(dirname "$0")/heavy-slot-guard.ts" "$dir" "$n" "$cls" "$peak"
    g=$?
    if [ "$g" -eq 0 ]; then
      [ -n "$ticket" ] && rm -f "$qdir/$ticket" "$qdir/$ticket.refused"
      ticket=""
      # R992: the job's measured peak (its process tree, sampled beside it) against its declared one;
      # `cleanup` writes the line when this shell exits.
      job_slot="$n"
      job_cmd="$(printf '%s' "$*" | tr '\t\n' '  ' | cut -c1-160)"
      peakfile="$dir/heavy.$n.peak"
      "${BUN:-bun}" "$(dirname "$0")/heavy-slot-peak.ts" "$$" "$peakfile" "${LETHAL_HEAVY_SAMPLE_S:-5}" &
      sampler=$!
      job_started=$(date -u +%FT%TZ)
      "$@"
      exit $?
    fi
    rm -f "$class" # refused: the slot is released and the command does not run
    class=""
    exec 9>&-
    [ "$g" -eq 75 ] && return 76
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
  if [ $? -eq 76 ]; then
    echo "heavy-slot: the guard refused (its verdict is above)" >&2
  else
    echo "heavy-slot: all heavy slots held ($dir/heavy.1 .. heavy.6)" >&2
  fi
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
  h="$(head_ticket)"
  # A refused waiter retries out of turn, except past a STARVED head (R991): that head waits for the held
  # slots to drain, and a refused small job admitted by the R992 allowance would keep them from draining.
  if [ "$h" = "$ticket" ] || { [ -e "$qdir/$ticket.refused" ] && ! [ -e "$qdir/$h.refused" ]; }; then
    try_once "$@"
    # R991: the marker keeps the FIRST refusal's time (its age is how long this ticket was passed over).
    [ $? -eq 76 ] && { [ -e "$qdir/$ticket.refused" ] || : >"$qdir/$ticket.refused"; }
  fi
  sleep "$poll"
done
