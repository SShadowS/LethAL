#!/usr/bin/env bash
# R905: run a command in the first free heavy slot and record the slot's class.
#
#   scripts/heavy-slot.sh <baseapp|other> <cmd...>
#
# Use `baseapp` for a job over BC.History or any copy of it (even under /coord/handoff), `other`
# for everything else (al-runner v3 gates, campaigns, measurements). It takes the first free
# /coord/locks/heavy.<n> (n = 1, 2, 3; LETHAL_HEAVY_LOCK_DIR overrides the folder) with flock,
# writes its own pid into the lock file and heavy.<n>.class ("<class> <pid>"), then runs the same
# guard as corpus-snapshot (scripts/heavy-slot-guard.ts): while a BaseApp-class job runs, or a slot
# has no class, at most two heavy jobs run container-wide, else three. If the guard refuses, the
# slot is released and the command does not run. The class file is removed on exit.
# Exit code: the command's; 75 when all slots are held or the guard refused (retry later); 2 for a
# bad class, a bad lock folder or a flock failure (retrying never helps).
# Do NOT wrap corpus-snapshot.ts or v3-timing.ts in this: they take their own slot, so the job
# would hold two.
set -u
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
for n in 1 2 3; do
  # >> not >: > would wipe the pid a corpus-snapshot holder keeps in the lock file.
  exec 9>>"$dir/heavy.$n" || exit 2
  flock -n 9
  rc=$?
  [ "$rc" -eq 1 ] && continue # busy
  [ "$rc" -eq 0 ] || exit 2
  class="$dir/heavy.$n.class"
  echo "$$" >"$dir/heavy.$n" # the guard trusts a holder it can name by pid
  echo "$cls $$" >"$class"
  trap 'rm -f "$class"' EXIT
  "${BUN:-bun}" "$(dirname "$0")/heavy-slot-guard.ts" "$dir" "$n" "$cls"
  g=$?
  [ "$g" -eq 0 ] || { [ "$g" -eq 75 ] && exit 75 || exit 2; }
  "$@"
  exit $?
done
echo "heavy-slot: all three heavy slots held ($dir/heavy.1, heavy.2, heavy.3)" >&2
exit 75
