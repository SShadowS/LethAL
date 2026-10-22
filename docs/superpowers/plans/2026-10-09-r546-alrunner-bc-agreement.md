# R-546 plan r1: al-runner vs bcdev per-mutant verdict agreement on one real slice

Saved by the bugs session from the Opus planner's hand-back. This is a measurement, not a gate, so no count is predicted.

## 0. Evidence
- **Where "52 of 55" comes from: the committed itest baselines.**
  - `bcdev.baseline.json` against `al-runner.baseline.json`: 19 against 19, all agree.
  - The wrapped baselines: 36 against 36, 3 differ. All 3 are in `Wrapped Arms|Pick` and come from R497's refusal: empty-block and return-value are killed on BC and no-coverage on al-runner; conditional-boundary is survived on BC and no-coverage on al-runner.
- **The slice already ran on al-runner in campaign R396.**
  - Sources: `docs/campaign/2026-10-02-r396/manifest.md`, and `docs/superpowers/specs/2026-10-02-r396-alrunner-speedup-precommitment.md` addendum 2.
  - Project: CDO `5f2a71d` (app 28.4), worktree `/work/lethal-wt/cdo-r396`, still at HEAD `5f2a71d`.
  - `--only .dependencies/CDO/Codeunit/CDORecipientMgt.Codeunit.al` (codeunit 6175295 "CDO Recipient Mgt.", 1 object, no `#if`).
  - `--tests-only Src/Recipients/CDORecipientMgtTests.Codeunit.al` (codeunit 68933, 21 tests, no TestPage).
  - 63 deployed mutants from 65 sites, 1 batch, baseline 21 of 21 green.
  - al-runner `--server` took 3461 s with coverage off and 3709 s with coverage `al-runner`.
  - R383 counts 0 CDO files and R497 counts 0, while DC has 24 wrapped files. So CDO is preferred.
  - Ids: 6175460 / 6175459 / 6175458.
  - packagesDir `/work/lethal-wt/cdo-r396/Test/.alpackages`: 17 packages pinned by sha256, downloaded from Cronus28.
- **Cronus28 has had this stack** (R396 addendum 2, the R175 rerun, the R-316 inventory). "Still there" is likely, not proven; P1–P3 check it.
- **Known BC risk, from R175 attempt 2:** Document Output is not activated on Cronus28, and tests that reach `CSC Core.IsAppActiveOrAskToActivate` fail. P4 checks this.
- **DO master b3b4459 and DC c895a7d are v30.** Cronus28 is BC 28.4, so neither is used.
- **Tooling to reuse:**
  - `bun scripts/report-diff.ts <bc> <ar>`: diffs per `keyOf` from `packages/runner/itest/mutant-equality.ts`, multiset per key.
  - `report-summary.ts`, `lethal explain`, `redact-campaign-report.ts` (`--check`), `corpus-fingerprint.ts`, `coord-status.ts`.
  - `campaign compare/freeze` is NOT used (it refuses on a coverage-mode mismatch).
  - No new comparison code is needed.

## 1. Slice (fixed)
- **Source:** `/work/lethal-wt/cdo-r396` (CDO 5f2a71d, detached, clean). Gate before each leg: `status --porcelain` is empty, HEAD is 5f2a71d, and the fingerprint is the same as at the first leg.
- **Flags:**
  - `--project /work/lethal-wt/cdo-r396/Cloud`
  - `--tests /work/lethal-wt/cdo-r396/Test`
  - `--only .dependencies/CDO/Codeunit/CDORecipientMgt.Codeunit.al`
  - `--tests-only Src/Recipients/CDORecipientMgtTests.Codeunit.al`
  - `--selector-id 6175460 --control-id 6175459 --table-id 6175458`
  - The default operator set, with no `--operator`.

## 2. Config (non-secret fields only)
- **Shared:** the same LethAL commit (recorded) and the same flags, with a fresh `--db` and `--out` per leg in scratch.
- **bcdev:**
  - Source config: `/work/lethal-wt/lane-bugs/fixtures/sandbox-app/lethal.config.local.json` (gitignored, Cronus28). NEVER opened, catted or grepped.
  - Transform without printing anything: `jq '{bcdev: .bcdev} | .bcdev.coverageMode = "none"' <src> > <scratch>/bc-A.json`, and the same with `"fenced"` into `bc-B.json`.
  - Check: `lethal doctor --config <scratch>/bc-A.json --project .../Cloud` shows Cronus28.
  - Flag: `--stop-hung-sessions`.
  - The scratch configs are deleted afterwards.
- **al-runner:** `{"alRunner": {"alRunnerPath": "<resolved>", "packagesDir": "/work/lethal-wt/cdo-r396/Test/.alpackages", "coverage": "none" | "al-runner"}}`.
  - `<resolved>` = `readlink -f /work/tools/al-runner/current/al-runner`, taken ONCE and reused for every run.
  - Record `--version` and the banner's BC build.
  - Run `--server` with the resource selector (the defaults). One-shot is skipped: R396 measured it per-mutant identical on this slice.
- **Legs:**
  - **A:** bcdev `none` / al-runner `none`. Every mutant runs against every green test, so this leg shows kill-vs-survive flips.
  - **B:** bcdev `fenced` / al-runner `al-runner`. These are the user defaults, so this leg shows verdict-vs-no-coverage.
- **Identity key:** `keyOf` (`astHash|object|procedure or trigger|operator|major[|ordinal]`), multiset.
- **Ordering:** there is no random seed. Covering tests run killer-first (R197), so `killingTest` may legitimately differ.
- **Pre-run gate:** `lethal run --dry-run` per backend (leg A config). The deployed counts and the per-file `sites=`/`deployed=` must be equal; if not, stop, because that is itself the finding.

## 3. BC prerequisites (inside the lease, checked by id only, never listing every extension)
- **P1.** These dependencies are installed (by appId):
  - Continia Core 4b915d7e-c02a-435f-85ab-649086c1e002
  - Continia System Application e4b442d0-e8e3-4210-bfca-f1e66686caa0
  - Continia Delivery Network 0745e76d-0b72-4641-87c2-ee45db5d2c32
  - Continia Connector App 2b9992c2-5eaf-4cdc-b33b-592d917780d2
  - Core Internal Activation c3755ece-dab0-4d16-987d-040661f18522

  If any is missing, `altool publishapp` it from the pinned packagesDir, in dependency order.
- **P2.** Target CDO f4b69b55-c90d-4937-8f53-2742898fa948. LethAL republishes it, so just record the version before and after.
- **P3.** Test app 1c350336-8dcb-42db-8c2f-b33d56c5e527 is installed AND built from the same Test source.
  - Check: `bcdev_package_download`, then compare the sha256 of the embedded `.al` files against `cdo-r396/Test`. Compare hashes only, no source printed.
  - If it is missing or differs: compile a scratch COPY with only the `app.json` version raised, prove every `.al` hash is unchanged, then publish.
- **P4.** `bcdev_test_run` of codeunit 68933's 21 tests. All green: go. Any environment failure ("not activated" and the like): STOP, release the lease, report. Never narrow the tests on one side only.
- **P5.** The control app is at `MIN_CONTROL_VERSION` (`lethal doctor` control-version).
- **Cleanup:** nothing is unpublished (that is host-only). Record any app published. Delete the scratch configs. Release.

## 4. Comparison rule
- Per leg: `report-diff.ts <bc> <ar>`. Each key falls in exactly one class:
  1. **agree**, where a differing `killingTest` alone is agree, counted separately;
  2. **kill-vs-survive flip**, with its direction, timeout-killed counting as killed;
  3. **verdict-vs-no-coverage**;
  4. **error or timeout difference**, or a differing errorClass;
  5. **one side only**, or a group-size change.
- **Rate:** agree / union of keys, per leg. Classes 2 and 3 are always reported separately.
- **Flaky screen:**
  - Each non-agree key is re-run ONCE on BOTH sides with the leg config, narrowed with `--lines` spans.
  - Run the whole slice instead if the spans would cover more than half of it, or if a narrowed run shifts an identity.
  - A key whose verdict changes on either side is flaky.

## 5. Classification (one class each; checks in order: flaky first, then the R383/R497 warnings, then leg A vs leg B, then message text, then a repro)
- **LethAL limitation R383/R407:** al-runner coverage fell back to `none`, or the file was skipped by its coverage index.
- **LethAL limitation R497:** the file holds a `#if`-wrapped object and the refusal is named. Expected 0 on CDO.
- **LethAL limitation, other:** the key agrees in A but differs in B, and `lethal explain` shows an attribution gap. Cite the roadmap id, or file one.
- **LethAL defect:** a different deployed AL or identity, or different LethAL handling. Filed as a roadmap item.
- **Intended:** a documented environment or session fact named in the report or failure text (fenced non-GUI session, activation or licence, permissions, BC 28.4 vs 28.5 platform).
- **al-runner defect:** al-runner's own output shows wrong AL behaviour, or it accepts what alc rejects.
  - Confirmed only by a minimal self-contained repro (no CDO text) measured on Cronus28 under a lease and on the recorded al-runner build.
  - Then an upstream issue (owner approves each filing) and a roadmap item.
- **Flaky:** from §4.
- **Otherwise unexplained:** counted and reported.

## 6. Redaction and results
- **Reports:** `docs/measurements/r546/{bc-A,ar-A,bc-B,ar-B}.report.json` (plus the re-runs), each redacted and `--check`ed before `git add`.
- **Write-up:** `docs/measurements/2026-10-xx-r546-alrunner-bc-agreement.md`.
- **No CDO source text** in commits, issues, roadmap items or the write-up (not even `killingTestFailure` quotes). Logs stay in scratch.

## 7. Resources
- **Corpus jobs:** at most 2 DC/DO/BC.History jobs container-wide. Check with `coord-status.ts` and `pgrep -af "lethal run|al-runner"` before each leg. Every leg runs serially (1 job).
- **Lease and order:**
  1. al-runner A, then al-runner B, with no lease.
  2. Lease Cronus28 (heartbeat every 4 min or less): P1–P5, bcdev A, bcdev B. Release.
  3. Flaky re-runs: al-runner first, then a short second lease for BC.
- **Never hold the lease idle.**
- **Stop rules:** a bcdev leg over 30 min, or a tier quarantined: stop, release, report. A partial run is not compared.

## 8. Risks and cost
- **Risks:**
  - P4 activation is the most likely blocker; if it hits, the owner is needed.
  - Dependencies may be gone (P1).
  - The test app may differ (P3).
  - The daily build moves mid-measurement: resolve the build once.
  - The mutant sets may differ: the dry-run gate catches it.
  - One slice can find nothing: a negative result about this slice only.
- **Cost:**
  - al-runner: about 60 min per leg, so about 2 h, plus re-runs.
  - bcdev: about 10–20 min per leg (unmeasured); the lease is about 40–55 min.
  - Total: about 3.5–4.5 h elapsed, under 1 h of Cronus28 time.

## 9. Method file
The text to commit as `docs/superpowers/specs/2026-10-09-r546-alrunner-bc-agreement-method.md`: see the planner's §9. The bugs session commits it after review (r2), with the review's changes applied.

## Open points
- Is the jq transform of the gitignored config into scratch acceptable? It reads the file only inside a script and prints nothing.
- The stack on Cronus28 is inferred, not checked live.
- P4 activation.
