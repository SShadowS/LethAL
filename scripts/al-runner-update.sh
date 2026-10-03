#!/usr/bin/env bash
# Daily al-runner update inside a kraken-lethal container (orchestrator runbook).
# Builds upstream main, runs the itest:alrunner gate on that build, and moves
# /work/tools/al-runner/current onto it ONLY if the gate passes. Run it from a LethAL worktree
# (the gate runs there). Overrides, used by the unit test: KRAKEN_SETUP_SRC (sibling repos),
# AL_RUNNER_TOOLS (build folder), AL_RUNNER_REPO (upstream url).
#   exit 0: current is up to date, or moved to a new gated build
#   exit 1: the new build failed the gate (current is unchanged), or already failed on this commit
set -euo pipefail
src="${KRAKEN_SETUP_SRC:-/work/src}"
tools="${AL_RUNNER_TOOLS:-/work/tools/al-runner}"
repo="${AL_RUNNER_REPO:-https://github.com/StefanMaron/BusinessCentral.AL.Runner.git}"
bc="${AL_RUNNER_BC:-28.5.54151.55132}" # main's own default build; the c39ad5de build used the same
base="${AL_RUNNER_BASE_VERSION:-2.12.0}" # upstream's last release; main's csproj says 0.0.0-main
co="$src/al-runner-src"
mkdir -p "$src" "$tools/failed"

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

if [ -x "$tools/$sha/al-runner" ]; then
  echo "al-runner $sha is already built and gated: nothing to do"
  exit 0
fi
if [ -e "$tools/failed/$sha" ]; then
  echo "al-runner $sha already failed the gate (kept in $tools/failed/$sha); waiting for a newer main" >&2
  exit 1
fi

tmp=$(mktemp -d "$tools/.build-XXXXXX")
trap 'rm -rf "$tmp"; git -C "$co" worktree prune 2>/dev/null || true' EXIT
git -C "$co" worktree add --quiet --force --detach "$tmp/src" "$sha"
ver="$base-main.$sha"
# same steps and flags as .kraken/Dockerfile's c39ad5de bootstrap build
dotnet pack "$tmp/src/AlRunner/AlRunner.csproj" -c Release -p:Version="$ver" \
  -p:AllowBcArtifactDownload=true -p:ServiceTierPath="$tmp/bc/$bc" -o "$tmp/nupkg"
dotnet tool install MSDyn365BC.AL.Runner --tool-path "$tmp/out" --add-source "$tmp/nupkg" --version "$ver"
mv "$tmp/out" "$tools/$sha"

log="$tmp/gate.log"
if (LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH="$tools/$sha/al-runner" bun run itest:alrunner) >"$log" 2>&1; then
  ln -sfn "$tools/$sha" "$tools/.current.tmp"
  mv -T "$tools/.current.tmp" "$tools/current"
  echo "al-runner current -> $tools/$sha (gate passed)"
  # keep the newest two builds (and whatever current names); older ones go, and so do failures
  # (they are on older commits than this passing build)
  keep=$(readlink "$tools/current" || true)
  rm -rf "$tools/failed" && mkdir -p "$tools/failed"
  n=0
  for d in $(ls -1dt "$tools"/*/ 2>/dev/null); do
    d="${d%/}"
    case "$(basename "$d")" in failed | current) continue ;; esac
    n=$((n + 1))
    if [ "$n" -gt 2 ] && [ "$d" != "$keep" ]; then rm -rf "$d"; fi
  done
  exit 0
fi
mv "$tools/$sha" "$tools/failed/$sha"
echo "al-runner $sha FAILED the itest:alrunner gate; current is unchanged. Last output:" >&2
tail -n 40 "$log" >&2
exit 1
