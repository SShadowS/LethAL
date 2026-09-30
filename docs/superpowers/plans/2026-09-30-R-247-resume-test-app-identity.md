# R-247: no verdict carried across a test-app republish (short plan)

**Problem.** `sessionFingerprint` names the test DIRECTORY, not the test app the server runs. So
`--resume` carries verdicts (whole batches through R192 half 1, and single mutants too) that were
measured against a test app that has since been republished.

## 1. The identity

Use `testAppHashFor`'s value, the same key R192 half 2 already uses for baseline reuse:
`package:<sha256 of the published .app>` on bcdev, `source:<hash of the test .al tree>` on
al-runner (which compiles the test bundle itself, so the source is what runs).

Why the published package and not the compiled `.app`: `lethal run` does not compile or publish the
test app (only `verify`, C02-05, does), so the server's package is the only thing that says what
the server runs. The two agree anyway: C02-05's `publishTestApp` accepts a publish only when the
read-back hash equals the compiled `.app` hash.

- Republish of identical bytes: same hash, verdicts carry. Correct, the suite is the same.
- Republish with only a new version stamp: different bytes (`NavxManifest.xml`), different hash,
  refused. Over-strict but safe; the cost is one from-scratch run.
- A recompile that `alc` does not reproduce byte for byte: refused, same reasoning.

## 2. Recording

A new `runs.test_app_hash TEXT` column, written at `startRun`. NULL means unknown and never
matches, including NULL against NULL. It is NOT in the fingerprint: it is observed, not configured,
and keeping it out lets `--resume` find the run and then refuse it BY NAME, instead of "no run
found". One hash per run is enough: a resumed run carries only when the hashes are equal, so every
row it records (carried or measured) is under its own hash.

## 3. The resume rule: refuse by name

Refuse, like R325 and R354, in `resolveResume` on both `--resume` and `--resume-run`, after the
coverage-mode check: "run N was measured against test app X, this session's test app is Y (or
unknown) ... (R247). Drop --resume to run from scratch."

Why not re-measure: the problem is every carried verdict, not only whole batches. Re-measuring them
all IS a from-scratch run, done silently under a flag that promised a resume. Refusing costs the
same and tells the operator why. `--skip-known-survivors` gets the same rule as R354 gave it: a
different or unknown hash skips nothing, with a named warning.

## 4. Cost on resume

Zero extra reads. `reportPublishedTestApp` already reads the package once per session, before
`resolveResume`; it returns the bytes' hash instead of discarding them. The per-batch reads for the
snapshot key are unchanged.

## 5. Old runs

A pre-R247 run has NULL, so it is refused by name ("recorded no test-app identity"). One-time cost:
any unfinished run from before this build restarts from scratch, as with R354.

## 6. Live check: no

Both facts are already measured. Stable across reads with no republish: R192's live run (2026-09-03)
reused the baseline by this exact `package:` key on eleven resumes. Changes across a changed
republish: the server returns the uploaded bytes exactly (C02-05's `accepted` check, live in
`itest:testapp`), and a changed app has different bytes. No Cronus28 lease.

## 7. Tests (resume.test.ts, `describe("R247 ...")`)

1. Same hash: the batch carries (no deploy, no baseline), as today.
2. Different hash: `--resume` and `--resume-run` each refuse with the named message.
3. Prior run NULL: refused; current hash unknown (package read `null`): refused.
4. al-runner `source:` path: a changed test `.al` refuses.
5. `--skip-known-survivors` across a changed hash skips nothing and warns.
Red-check each: remove the comparison (or make NULL match), the named test goes red, restore.

## 8. Tasks

1. **Store** (`store.ts`): `test_app_hash` column, added through the existing ALTER list (a store
   migration, no backfill), `startRun` writes it, `getRun`/`findResumableRun` read it; store tests.
2. **Resume** (`orchestrator.ts`, `resume.ts` message constant): `reportPublishedTestApp` returns
   the hash (al-runner falls back to `testAppHashFor`'s source hash), `resolveResume` and
   `--skip-known-survivors` compare it; tests 1 to 5 in `resume.test.ts`, red-checked.
3. **Close**: `docs/roadmap/R247.md` status, regenerate `ROADMAP.md`.

## Approved 2026-09-30 (f7ecdbbc)

Scope: YES, the rule also applies to `--skip-known-survivors` (a survivor measured against another test app is not evidence, and a new test is exactly what might kill it). Additions: (1) a CHANGELOG line naming the one-time cost (unfinished pre-R247 runs refused once; the next `--skip-known-survivors` skips nothing once), and the refusal text says a version-stamp-only republish also counts as a change. (2) `lethal verify` republishes the test app on purpose and reads its source run: confirm verify never goes through the new resume or history refusal by accident, with a test if it touches resolveResume or priorSurvivorKeys. No Cronus28.
