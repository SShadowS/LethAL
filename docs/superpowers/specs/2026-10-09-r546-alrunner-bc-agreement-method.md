# R546 method: al-runner vs bcdev verdict agreement on one real slice

Committed before any live run. This is a MEASUREMENT, not a gate: no count, rate or verdict is
predicted here. Roadmap: `docs/roadmap/R546.md`. Coord task: R-546. Plan and its adversarial review
(r1 → this r2): `/coord/handoff/R-546/plan.md`, `review-plan-opus.md`.

## Slice

| Item | Value |
|---|---|
| Project | Continia Document Output at `5f2a71d` (app 28.4), worktree `/work/lethal-wt/cdo-r396`, clean, detached |
| Target | `Cloud`; `--only .dependencies/CDO/Codeunit/CDORecipientMgt.Codeunit.al` (codeunit 6175295 "CDO Recipient Mgt.") |
| Tests | `Test`; `--tests-only Src/Recipients/CDORecipientMgtTests.Codeunit.al` (codeunit 68933, 21 tests) |
| Selector ids | `--selector-id 6175460 --control-id 6175459 --table-id 6175458` |
| Operators | LethAL's default set at the measured commit; no `--operator` flag |
| Packages | `/work/lethal-wt/cdo-r396/Test/.alpackages`, the 17 packages pinned by sha256 in the R396 pre-commitment, addendum 2 |

Chosen because R396 already ran this slice end to end on al-runner (one batch, 63 mutants, green
baseline, coverage not refused), because Cronus28 (BC 28.4) has run CDO 5f2a71d before, and because
the file is one object with no `#if` (so neither [[R383]] nor [[R497]] applies). It is ONE codeunit
and about 63 mutants: the agreement rate it yields bounds nothing beyond this slice, and the
write-up says so.

**Slice gate, before every leg:**
- `cdo-r396` HEAD is `5f2a71d`, `git status --porcelain` is empty, and `scripts/corpus-fingerprint.ts` gives the value recorded before the first leg.
- The sha256 of all 17 packagesDir files is unchanged (the folder is gitignored, so git cannot see it).
- The al-runner binary is the copied build (below).

## Backends and configuration

Every leg uses the same LethAL commit (recorded), the same flags, and a fresh `--db` and `--out` in
scratch. `--resume` is never used: a stopped leg is re-run from a fresh `--db`.

**Dry-run gate.** `lethal run --dry-run` with each backend's leg-A config must give the same deployed
count and the same per-file `sites=`/`deployed=` on both. If they differ, the measurement stops, and
that difference is the finding.

**al-runner:**
- `readlink -f /work/tools/al-runner/current`, resolved once. That build folder is copied into scratch, and every run (repros included) uses the copy. Record `--version`, the banner's BC build, and which BaseApp it loaded (the verbose `[pkg-cache]` line).
- Config: `{"alRunner": {"alRunnerPath": <copy>, "packagesDir": <the packages above>, "coverage": "none" | "al-runner"}}`.
- Transport: `--server` with the resource selector (the defaults). One-shot is not run: R396 measured it per-mutant identical to `--server` on this slice.

**bcdev:**
- Cronus28, under `coord lease Cronus28 bugs`, with a background heartbeat every 4 min or less for as long as the lease is held. The heartbeat is killed on release.
- Config: the `bcdev` section of the gitignored Cronus28 fixture config, transformed inside a script and never printed, under `umask 077`. The scratch file is deleted by a `trap` on exit:
  `jq '{bcdev: .bcdev} | .bcdev.coverageMode = "<none|fenced>" | .bcdev.packageCachePath = "/work/lethal-wt/cdo-r396/Test/.alpackages"'`
- Before the lease, an offline `alc` compile of `Cloud` against that cache must succeed (output to scratch).
- Flag: `--stop-hung-sessions`.

**BC prerequisites, inside the lease.** Every check is per app id: the dev endpoint's per-app `dev/packages` read, or an extensions query `$filter=id eq <GUID>`. A list call filtered on our side does not count, and nothing lists every extension.
- **P1.** The 5 Continia dependencies are installed (Core, System Application, Delivery Network, Connector App, Core Internal Activation), along with the Microsoft apps in the packagesDir. Each installed version must EQUAL the packagesDir file's version. If anything is missing or differs: STOP and report. A third-party dependency is never published.
- **P2.** Record the resident CDO target (`f4b69b55-c90d-4937-8f53-2742898fa948`) version before and after. LethAL republishes the instrumented target itself.
- **P3.** Test app `1c350336-8dcb-42db-8c2f-b33d56c5e527`.
  - Fetch the published package into scratch, never into any `.alpackages`.
  - Normalise the `.al` sources to LF, then sha256 them. The multiset of hashes must equal the local `Test` sources', and the count must equal the number of local `.al` files, which must be more than 0.
  - If they differ, republish from a scratch copy with only `app.json` `version` raised, after proving every `.al` hash unchanged. The republish is announced to the orchestrator and recorded.
- **P4.** The 21 tests run once through `bcdev_test_run`. Any environment failure (activation, licence, permission) is a STOP, and the measurement goes to the owner. The tests are never narrowed on one side. This screen is cheap but not sufficient: see leg validity.
- **P5.** `lethal doctor` shows the control app at `MIN_CONTROL_VERSION`.

| Leg | bcdev `coverageMode` | al-runner `coverage` | Purpose |
|---|---|---|---|
| A | `none` | `none` | every mutant against every green test on both sides: kill-vs-survive flips |
| B | `fenced` (default) | `al-runner` | the defaults users run: verdict-vs-no-coverage |

**Stops:**
- al-runner leg over 2 × 3461 s.
- bcdev leg over 2 × a projection from P4's per-test time (tests per mutant times mutants, plus publish).
- A quarantined tier, or a session abort.

A stopped leg is not compared.

## Leg validity (all must hold, or the leg is not compared)
- Both reports have a baseline of 21 tests, 0 failing, with the same 21 names.
- `mutants.length` equals the dry-run's deployed count on both sides.
- Normal exit and no quarantine.
- Leg B only: `coverageMode` is `fenced` on the bc report and `al-runner` on the ar report. If it is not, leg B is "not run".

## Comparison rule

Use `scripts/report-diff.ts` for the gate-style view, plus a small bucketing script (committed with
the results) that imports `keyOf` and `normalizeForComparison`.

**Row checks.** Every key group has size 1 on each side. Per key, `file`, `startIndex`, `endIndex`,
`originalText` and `mutatedText` are equal across the two sides. A mismatch is a LethAL defect, and
that row is not classified further.

**Class, from the (bc, ar) verdict pair, per row and per leg:**
1. **agree:** the same verdict in {killed, survived, no-coverage}. Sub-counts: `killingTest` differs; both no-coverage.
2. **kill-vs-survive flip:** killed against survived, with its direction.
3. **verdict-vs-no-coverage:** killed or survived against no-coverage.
4. **error/timeout:** `error`, `timeout-killed` or any other non-plain verdict on EITHER side, including when both sides have one.
5. **one side only:** a key present on one side only.
- `known-survivor` is refused (not expected: no suppression file is used).

**Rates.** Rate 1 = agree / union of mutants. Rate 2 = agree / mutants scored killed-or-survived on
both sides. Classes 2 and 3 are always reported separately. Informational, not a class: R396's
`run-ii-new.report.json` diffed against `ar-A`, to separate al-runner/LethAL drift since R396 from
backend differences.

**Re-run (flaky screen).** For each leg with at least one non-agree row: ONE whole-slice re-run on
EACH side, from a fresh `--db`. `--lines` is never used, because it renumbers twins. A row whose
verdict changes between its two runs on either side is flaky. One re-run shows "reproduced once",
not "not flaky". The re-runs also give each backend's self-agreement rate.

## Cause, per non-agree row (first match wins)
1. **Flaky:** the verdict changed in the re-run.
2. **R383/R497:** the report's own warning or fields name the al-runner coverage fallback or the wrapped refusal for that file.
3. **BC-side refusal:** the bc row carries an R298 refusal reason.
4. **Coverage attribution** (leg B, the row agrees in leg A): leg A's killing test is missing from leg B's `coveringTests` on the side that did not kill. That side under-attributes. Cite a roadmap id, or file one.
5. **Warm kill:** bc `killPosition > 1`, and the kill does not reproduce with the killing test run alone (cold).
6. **Environment:** the killing side's failure text names activation, licence or permission.
7. **al-runner defect or platform difference (BC 28.4 vs al-runner's BC):** ONLY with a minimal self-contained repro (no CDO/DC/DO text), measured on Cronus28 under a lease and on the copied al-runner build. An al-runner defect then gets an upstream issue (each filing approved by the owner) and a roadmap item.
8. **Otherwise:** "unexplained (suspected <X>)", counted and reported.

## Reporting

- Reports go under `docs/measurements/r546/`. Each goes through `bun scripts/redact-campaign-report.ts` and `--check` before commit.
- Redacted reports still carry `killingTestFailure`, under the 2026-08-09 ruling. The write-up, roadmap items and upstream issues quote no Continia source or failure text.
- The write-up (under `docs/measurements/`) gives both rates, classes 2 and 3 separately, a cause table, the builds and commits, every app published to Cronus28, and the statement that this is one slice.
