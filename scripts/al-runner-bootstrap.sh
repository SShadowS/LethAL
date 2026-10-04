#!/usr/bin/env bash
# Setup step (.kraken/project.yaml, third entry): make /work/tools/al-runner/current exist, pointing at the
# build baked into the image, so LETHAL_ALRUNNER_PATH works before the first daily update
# (scripts/al-runner-update.sh). Never touches an existing `current`. Idempotent.
# AL_RUNNER_TOOLS and AL_RUNNER_BOOTSTRAP override the paths (the unit test uses them).
set -euo pipefail
tools="${AL_RUNNER_TOOLS:-/work/tools/al-runner}"
boot="${AL_RUNNER_BOOTSTRAP:-/opt/al-runner/c39ad5de}"
mkdir -p "$tools"
# four worktrees run setup at once: one at a time
(
  flock 9
  if [ ! -e "$tools/current" ] && [ ! -L "$tools/current" ]; then ln -s "$boot" "$tools/current"; fi
) 9>"$tools/.lock"
