#!/usr/bin/env bash
# R905: run a command in the first free heavy slot and record the slot's class.
#
#   scripts/heavy-slot.sh <baseapp|other> <cmd...>
#
# Use `baseapp` for a job over BC.History or any copy of it (even under /coord/handoff), `other`
# for everything else (al-runner v3 gates, campaigns, measurements). It takes the first free
# /coord/locks/heavy.<n> (n = 1, 2, 3; LETHAL_HEAVY_LOCK_DIR overrides the folder) with flock,
# writes heavy.<n>.class holding "<class> <pid>", runs the command, and removes the class file on
# exit. The guard in scripts/corpus-snapshot.ts reads it: while a BaseApp-class job runs, or a slot
# has no class, at most two heavy jobs run container-wide. Exit code: the command's, or 75 when all
# three slots are held (retry later), or 2 for a bad class.
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
mkdir -p "$dir"
for n in 1 2 3; do
  # >> not >: corpus-snapshot keeps its pid in the lock file, and > would wipe it.
  exec 9>>"$dir/heavy.$n"
  flock -n 9 || continue
  class="$dir/heavy.$n.class"
  echo "$cls $$" >"$class"
  trap 'rm -f "$class"' EXIT
  "$@"
  exit $?
done
echo "heavy-slot: all three heavy slots held ($dir/heavy.1, heavy.2, heavy.3)" >&2
exit 75
