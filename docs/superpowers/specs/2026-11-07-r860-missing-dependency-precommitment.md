# R-860 pre-commitment: al-runner stops on a missing dependency (upstream #7139)

Written before any change or gate of it. Ruling (orchestrator, 2026-11-07): option 1, expect the new refusal; do not pass `--allow-missing-dependencies`.

## What changed upstream
From edge a461e6310 (alpha.13+edge.20261107), with `--no-download`, a dependency app that can't be found stops al-runner with exit 2, and the message names the app. In `serve` the request answers with an `error` line. Older builds print `dependency skipped:` and run on. LethAL's backend already refused a session on that line (R590), so a real run stopped either way, with different words.

## Pre-committed
- Leg C's fact `dependency-skip-line` reads `matches` on either form: the old `dependency skipped:` line naming the app, or exit 2 with stderr naming the app. All pinned builds read the old form and still read `matches`. Anything else is `diverged`.
- A real session on a build with the new form stops by name, naming the missing app and saying how to fix it: put the app's `.app` in `packagesDir`. It never reads as a kill, a survivor or an unknown error.
- No verdict, killing test, row or count moves on any pinned build: `current` and the manifest builds read as today. `IDENTITY_SCHEME` stays.
- `--allow-missing-dependencies` is never sent.
- Gate of a461e6310, or the newest edge, through `bun scripts/al-runner-v3-update.ts`. That build was blocked by this probe, so its other legs have never been read: 15 of 18 legs. **Their readings are not predicted.** Any leg that moves is reported and pre-committed in an addendum before the build is accepted. Only the update script moves `current`.

## Behaviour change for users
A run on such a build stops at the first request with a clear refusal, as R590 already did after a skip. The CHANGELOG says so.
