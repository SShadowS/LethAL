# Background to CLAUDE.md's rules

CLAUDE.md keeps its rules short. This page keeps the history and figures behind the rules that are
not about one gate (gate history is under `docs/gates/`). Moved here by R-592.

## Roadmap

- **One file per item (R118).** The roadmap used to be one table. A field-wise read on `|` silently
  returned a fraction of a row and looked complete; one file per row makes that impossible. The
  generated index is about 6 KT (thousand tokens) to read. Two sessions filing at once cannot
  collide.
- **Ruling closures.** R77 and R101 are the two rows closed with a RULING rather than a commit, and
  they were written that way deliberately: a ruling has no commit to name.
- **Re-check the next free id (R174).** R174 was overwritten by a concurrent session and had to be
  restored from HEAD.

## Build and test loop

- **The dist trap.** `tsc --build` regenerates `packages/*/dist`; its stale compiled `*.test.js`
  cause about 21 phantom failures under `bun test`.
- **Home directory hidden (R264).** `scripts/test-preload.ts` hides the real home directory from every
  unit test.
- **Snapshots (R393).** A plain `bun test` lets a timed-out test write its snapshot under the NEXT
  test's name; `scripts/verify.ts` runs bun with `CI=true`, so new snapshots are refused.
- **compile:fixtures (R56).** A docs-only commit deleted a procedure's body in a fixture, and
  `itest:tables` stayed green for days, because the gate kept measuring the previously published
  test app.
- **`bun run mutate`.** It currently covers `selection.ts` and `line-map.ts`. It would NOT have
  caught R175, because that was a wrong belief about BC encoded in the code AND in the test pinning
  it, and mutating such a gate kills the mutant. It catches the OTHER hazard, a test that would pass
  either way, and found one in hour-old code on its first run.
- **Lint debt.** The noise from `biome check .` is pre-existing organizeImports and format debt in
  `engine` and `builtin-tier1`.

## AL tooling

- The probe-both-locations rule for `alc.exe` and `altool.exe` is R167.

## Writing a screen

Two design rules came out of `itest:tables`' history (see `docs/gates/tables.md`). They guide
anyone who writes a new screen, a check that tags kills as suspect.

- Keep the tag when in doubt (R143). A receiver the project cannot resolve keeps
  `run-trigger-skipped-insert`. For a screen, the unsafe direction is tagging too little.
- Pin what the screen separates, not a count (R132). The same number of flagged kills means
  opposite things on a suite that raises through an assertion library and on one that raises
  through bare `Error(...)`. Pinning `discrimination` (`vacuous`, `partial`) is what stops the same
  number from reading as a finding.

## Campaign reports

- Two Continia Document Output reports were committed with 2,550 `originalText`/`mutatedText`
  fields before anyone noticed (redacted 2026-08-09). The ruling that filenames, paths, procedure
  names and test names may be published but source code may not dates from that day.
- `freeze` started recording `coverageMode` with R355. It refuses a report without
  `coverageMode` and records the mode in the stage baseline. `campaign compare` refuses by name
  when both sides record a mode and the modes differ. A stage frozen before R252 records no mode:
  it still compares, but never as a plain "identical"; the result says "coverage mode UNVERIFIED"
  (console and JSON) until the stage is re-frozen. The `measurement-campaign` skill carries the
  same rules.

## al-runner builds

**The .NET al-runner (v2) was retired on 2026-10-22 (R654).** Its backend and its gate,
`itest:alrunner`, are gone. While it was in use, the Windows host pinned a source build of upstream
main instead of the released global tool, because v2.12.0 crashed concurrent sessions (R345); the
paths and history are in `docs/gates/alrunner.md`.

The Rust al-runner (v3) is pinned under `/work/tools/al-runner-v3/`, and its `.gated` file names the
one build the backend will run. The pin moves only through `bun scripts/al-runner-v3-update.ts`,
which runs `itest:alrunner-v3` on the new build first. Details: `docs/gates/alrunner-v3.md`, "The
pin and the update gate".

## Editing files

- A scan of 77,844 agent commands (2026-10-01) found about half of all inline-script text was
  hand-written find-and-replace, failing 3.7% of the time, and appends to source files failing 11%.
  The largest single failure was broken quoting (`unexpected EOF`) inside `bun -e '...'` and
  heredocs.
- Searches started with `find /` have run for hours as orphans after the agent that started them
  finished.
