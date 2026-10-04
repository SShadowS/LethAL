#!/usr/bin/env bash
# Daily al-runner update inside a kraken-lethal container (orchestrator runbook).
# Builds upstream main, runs the itest:alrunner gate on that build, and moves
# /work/tools/al-runner/current onto it ONLY if the gate passes and no al-runner process is running.
# The gate runs in the LethAL checkout this script lives in (it cds to the repo root first).
# Overrides, used by the unit test: KRAKEN_SETUP_SRC (sibling repos), AL_RUNNER_TOOLS (build
# folder), AL_RUNNER_REPO (upstream url), AL_RUNNER_BC, AL_RUNNER_BASE_VERSION, NUGET_PACKAGES.
#
# Exit codes:
#   0  current is up to date, or moved to a new gated build
#   0  another update is already running (it holds the lock; this run touches nothing)
#   0  "deferred: al-runner in use": the new build passed the gate and is kept, but current was not
#      moved because an al-runner process is running; the next run moves it
#   1  the new build FAILED the gate (current is unchanged; the build is kept under failed/), or
#      this commit already failed the gate on an earlier day
#   2  not run from a LethAL checkout
#   other: a build step (git, dotnet) failed; current is unchanged
#
# A build counts as gated only when $tools/<sha>/.gated exists. The gate runs on the temp build, and
# the build is moved to $tools/<sha> (with .gated) only after it passes, so a run killed mid-gate
# leaves nothing that looks good. `current` is only ever pointed at a gated build.
set -euo pipefail
src="${KRAKEN_SETUP_SRC:-/work/src}"
tools="${AL_RUNNER_TOOLS:-/work/tools/al-runner}"
repo="${AL_RUNNER_REPO:-https://github.com/StefanMaron/BusinessCentral.AL.Runner.git}"
bc="${AL_RUNNER_BC:-28.5.54151.55132}" # main's own default build; the c39ad5de build used the same
base="${AL_RUNNER_BASE_VERSION:-2.12.0}" # upstream's last release; main's csproj says 0.0.0-main
co="$src/al-runner-src"

cd "$(dirname "$0")/.."
if ! grep -q '"name": "lethal"' package.json 2>/dev/null || ! grep -q '"itest:alrunner"' package.json; then
  echo "al-runner-update: $(pwd) is not a LethAL checkout" >&2
  exit 2
fi

mkdir -p "$src" "$tools/failed"
exec 8>"$tools/.update.lock"
if ! flock -n 8; then
  echo "al-runner-update: already running (another update holds $tools/.update.lock)"
  exit 0
fi

# one fetch at a time through the shared sibling folder (same lock as kraken-setup.sh)
sha=$(
  {
    flock 9
    if [ ! -d "$co/.git" ]; then git clone --quiet --depth 50 "$repo" "$co"; fi
    git -C "$co" fetch --quiet --depth 50 origin main
    git -C "$co" checkout --quiet --detach origin/main
    git -C "$co" rev-parse --short=8 HEAD
  } 9>"$src/.lock"
)
final="$tools/$sha"

if [ ! -f "$final/.gated" ]; then
  if [ -e "$tools/failed/$sha" ]; then
    echo "al-runner $sha already failed the gate (kept in $tools/failed/$sha); waiting for a newer main" >&2
    exit 1
  fi
  rm -rf "$final" # an ungated leftover (a run killed after the move, or an old layout) is never trusted
  tmp=$(mktemp -d "$tools/.build-XXXXXX")
  trap 'rm -rf "$tmp"; git -C "$co" worktree prune 2>/dev/null || true' EXIT
  git -C "$co" worktree add --quiet --force --detach "$tmp/src" "$sha"
  ver="$base-main.$sha"
  # same steps and flags as .kraken/Dockerfile's c39ad5de bootstrap build
  dotnet pack "$tmp/src/AlRunner/AlRunner.csproj" -c Release -p:Version="$ver" \
    -p:AllowBcArtifactDownload=true -p:ServiceTierPath="$tmp/bc/$bc" -o "$tmp/nupkg"
  dotnet tool install MSDyn365BC.AL.Runner --tool-path "$tmp/out" --add-source "$tmp/nupkg" --version "$ver"

  log="$tmp/gate.log"
  if ! (LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH="$tmp/out/al-runner" bun run itest:alrunner) >"$log" 2>&1; then
    mv "$tmp/out" "$tools/failed/$sha"
    # keep the newest 5 failures
    for d in $(ls -1dt "$tools"/failed/*/ 2>/dev/null | tail -n +6); do rm -rf "$d"; done
    echo "al-runner $sha FAILED the itest:alrunner gate; current is unchanged. Last output:" >&2
    tail -n 40 "$log" >&2
    exit 1
  fi
  # passed: the build takes its permanent name, and only now is it marked gated
  mv "$tmp/out" "$final"
  : >"$final/.gated"
  rm -rf "$tools/failed" && mkdir -p "$tools/failed" # failures are on older commits than this build
fi

if [ "$(readlink "$tools/current" 2>/dev/null || true)" = "$final" ]; then
  echo "al-runner $sha is already current: nothing to do"
elif pgrep -x al-runner >/dev/null 2>&1; then # the process NAME, so a path in a command line never matches
  echo "deferred: al-runner in use; $sha passed the gate and stays at $final, current is unchanged"
else
  ln -sfn "$final" "$tools/.current.tmp"
  mv -T "$tools/.current.tmp" "$tools/current"
  echo "al-runner current -> $final (gate passed)"
fi

# keep the newest two builds (and whatever current names); older ones go
cur=$(readlink "$tools/current" 2>/dev/null || true)
n=0
for d in $(ls -1dt "$tools"/*/ 2>/dev/null); do
  d="${d%/}"
  case "$(basename "$d")" in failed | current) continue ;; esac
  n=$((n + 1))
  if [ "$n" -gt 2 ] && [ "$d" != "$cur" ]; then rm -rf "$d"; fi
done
# the NuGet cache keeps one package folder per built version: drop those of builds that are gone
pk="${NUGET_PACKAGES:-$HOME/.nuget/packages}/msdyn365bc.al.runner"
if [ -d "$pk" ]; then
  keepers=""
  for d in "$tools"/*/ "$cur"; do [ -n "$d" ] && [ -d "$d" ] && keepers="$keepers $(basename "${d%/}")"; done
  for v in "$pk"/*/; do
    v="${v%/}"
    keep=0
    case "$(basename "$v")" in *-main.*) ;; *) keep=1 ;; esac # a release version is not ours to drop
    for k in $keepers; do case "$(basename "$v")" in *-main."$k") keep=1 ;; esac; done
    [ "$keep" = 1 ] || rm -rf "$v"
  done
fi
