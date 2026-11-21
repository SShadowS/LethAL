# PR-294 pre-commitment: warn by name when a v3 run's pinned al-runner build is not `current` (R1164)

Coord PR-294 (lethal-code, 2026-11-21). The combined DO run c1 ran edge-4ebfe7913 instead of `current` main-ccd0f823d,
through a reused config's `alRunnerV3.path`. Nothing said so except the R834 stderr line.

## What exists (checked first, so nothing is built twice)
- **R1018 `pinV3Binary`** resolves the config's path once per run (`resolveV3Binary` = realpath).
- **R814 `checkGated`** accepts any gated build (right: older gated builds are legitimate for A/Bs).
- **R834's stderr line** `[lethal] al-runner: <path> (<version>)` names the build, with no comparison to `current`.
- **The report's execution contexts** carry the build, again with no comparison.
- **R739 `setNotify`** already turns a backend notice into a report `warning` event plus its stderr line.

## What is built
1. **The notice.** In `AlRunnerV3Backend`, where R834 announces the binary (once per session), compare `cfg.alRunnerPath`
   with `resolveV3Binary(AL_RUNNER_V3_DEFAULT_PATH)`, the resolved `current` link.
   - When they differ: `this.notify("al-runner-v3-pinned-not-current", ...)`. The message names this session's binary path
     and version and `current`'s resolved path. It says this is not a refusal, and tells the user to check the config's
     `alRunnerV3.path` if `current` was meant.
2. **It stays silent when:**
   - they are equal;
   - no `current` link resolves (a user's box);
   - the session is in candidate mode (`cfg.candidate === true`), since the update gate runs a non-current candidate on
     purpose.
3. **Gates:** the code joins `LOGGED_ONLY` in `packages/runner/itest/gate-warnings.ts` (PR-264's list): every gate prints
   it and never compares it. So a private gate of a not-yet-current build moves no pre-committed warning set.
4. **No new `SessionReport` field or `Caveat`:** the warning is an ordinary `warning` event, already folded into the
   report.

## Tests (red-checked both ways; injected paths, no real link needed)
- The path equals the resolved `current`: no notice.
- The path is another build: exactly one notice, with code `al-runner-v3-pinned-not-current`, naming both paths.
- Candidate mode with another build: no notice.
- No `current` link: no notice.
- `LOGGED_ONLY` holds the new code (the gate-warnings test).

## Gates
- VERIFY (CPUs 12-21, nice 10, while PR-281's A/B is timed).
- An Opus build review.
- CI green.
- The full v3 gate after PR-281's A/B frees the box. It runs on `current`, so no new warning is expected, and the logged-only
  rule covers it if one appears.
