# PR-169 (R1122): confirm only the noted al-runner-v3 survivors on BC — design, r1

Coord task PR-169, lethal-preproc, 2026-11-18. A spec only. The orchestrator decides on a build after the adversary
review. Related: [[R1122]], [[R1121]], [[R586]], [[R1116]].

## 0a. Amendment 1 (r2): the spec-adversary review of r1 (a81396e6)
The review found no path to a false kill, but five points must change before a build. Each overrides the section it
names. The review checked the key join on PR-155: `keyOf` matches the full v3 and bc reports one to one (86 mutants, no
duplicate and no unmatched keys).
1. **R1121 stub kills (overrides §4 and §5).** bc.json carries no per-mutant R1121 flag.
   - The merge computes it from `killingTestFailure` with `failureTextMechanisms` (`platform-artifact-kills.ts`), as
     `platformArtifactKills` does.
   - A flagged mutant keeps BC's `killed` (R72's rule: never re-scored), with flag `linux-rdlc-stub`.
   - It is counted on its own line beside the score ("of which K are R1121 platform-stub kills") and left out of the
     "confirmed kills" list. On PR-137, 11 of 21 BC kills were stub kills.
2. **Identity ordinals (overrides §3 "How it narrows").** `identityOrdinal` is numbered over the FULL generated set,
   before the confirm filter drops anything, and bc.json carries those numbers.
   - The filter must therefore run after `numberIdentityOrdinals` (schemata `project.ts`). It must not run beside PR-144's
     `exactSites`, which filters before numbering.
   - Test: twins of which the sample draws only the second (ordinal 1) join, and are not refused.
3. **The noted set is not a superset (overrides §7's first limit). The selection adds a second group, `nocov-noted`.**
   - `nocov-noted` is every v3 `no-coverage` mutant carrying R609's note: its only reaching tests were refused by v3.
     These are selected like the noted survivors.
   - **The remaining gap, stated in the docs:** a refused test in a codeunit that has NO green covering test of the
     mutant leaves the mutant unnoted. Only the sample can catch it.
4. **More refusals, mechanical (adds to §3's list, applied by both the confirm run and the merge):**
   - `sourceSha256`, `dependencySourceSha256` or `identityScheme` differ between the two reports;
   - `testsOnly` or `--exclude-tests` differ: a different suite on BC credits kills to tests outside v3's scope;
   - `--skip-known-survivors` on the confirm run is refused, because a `known-survivor` row is not a measurement made in
     this run.
   - §7's "run both from one commit" stays as advice; the sha checks now enforce it.
5. **§8 pre-commits every row, and the sample bound is printed only when it means something.**
   - The rows are counted from PR-155's full reports by the review's read-only script: 64 v3 survivors, 35 noted and 29
     unnoted.
   - **The noted 35 on BC:** 8 `killed` (M0001, M0002, M0047, M0048, M0049, M0082, M0083, M0084), 24 `survived`, 1
     `no-coverage`, 2 `error` (M0078 and M0079, TestPage-unsupported, so both take `bc-error`).
   - **The unnoted 29 on BC:** 28 `survived`, 1 `error`.
   - Those are figures of a FULL 86-mutant bcdev run. The confirm run narrows to 64, so this is also the probe of
     whether narrowing changes BC's answers. **Every row must match;** a difference in any row is investigated, and in
     the 8 kills it is a BLOCK.
   - **The upper bound is printed only when the sample is smaller than the unnoted set.** At n = 30 on PR-155 all 29 are
     measured, so the merge prints "all unnoted survivors measured" instead of a bound.
   - **The `nocov-noted` group is empty on PR-155:** v3 scored no mutant there `no-coverage`. So the confirm run selects
     exactly 64.
   - The counts were re-checked independently by lethal-preproc with a site-key join; the unnoted `error` is M0081.
6. **(should) A v3 kill BC does not confirm.** The merge does not re-check v3 kills. But when bc.json has a row for a
   v3-`killed` mutant (only possible for an overlap) whose BC verdict is `error` because its killing test is not green
   on BC, that row is flagged `v3-kill-unconfirmed`. PR-155's M0080 is such a case, named here. It is not in the confirm
   set, so the first live use does not show it.
7. **(should) A partial bc.json is refused by name** (an unfinished run, or stranded mutants), like the v3 input.

## 1. The problem, and the measured basis
A v3 run is fast and offline but not authoritative ([[R586]]). When v3 refuses a test at baseline, that test cannot
kill anything. A mutant it would have killed is then scored `survived` on the other covering tests. Such a survivor
carries the `[v3-refused-test-nearby]` note: some test of a covering codeunit was refused at baseline.

Two measurements, each joined per mutant against `bcdev` on the same scope:

| Measurement | Noted v3 survivors BC killed | Unnoted v3 survivors BC killed |
|---|---|---|
| PR-137 (PR-67's pilot scope, 1,494 mutants) | 10 of 78 (plus 11 R1121 RDLC-stub kills) | 2 of 947, one mutant counted twice (a v3 wrong answer) |
| PR-155/PR-166 (50 DO candidates, 86 deployed) | 8 of 35 | 0 of 29 |

So a noted survivor is a lead that needs BC; an unnoted one almost never is. Running only the noted set on BC buys most
of BC's correction at a fraction of its cost.

## 2. The flow (user view)
1. `lethal run --backend al-runner-v3 ... --out v3.json`, as today.
2. `lethal run --backend bcdev ... --confirm-from v3.json [--confirm-sample <n>] [--confirm-seed <s>] --out bc.json`.
   The new flags select the mutants to deploy (§3). Everything else is an ordinary bcdev run: its own baseline, its own
   SessionReport, unchanged.
3. `lethal confirm-merge v3.json bc.json --out confirmed.json`. This is a NEW artifact (§5), not a SessionReport, so
   the merge adds no report field. The only report change is the confirm narrowing's own accounting (§3).

## 3. Selection (`--confirm-from`)
- **The set:**
  - every v3 mutant with verdict `survived` whose `failureNote` starts with `V3_REFUSED_NEARBY_TAG` (the "noted" set);
  - plus `n` mutants drawn from the unnoted survivors (the "sample", §6).
  - Nothing else: killed, no-coverage and error mutants are not re-run.
- **Identity:** `keyOf` (`astHash|codeunitName|procedure-or-trigger|operatorName|operatorMajor[|identityOrdinal]`).
  - `mutantCode` is not used: it renumbers whenever the scope changes.
  - `keyOf` moves from `packages/runner/itest/mutant-equality.ts` to `packages/runner/src`, so the CLI can use it.
    The itest re-exports it; the identity scheme is unchanged.
- **How it narrows:** the bcdev run generates its full mutation set as usual, then keeps the mutants whose key is in the
  set, before deploy. It needs the same project, the same operators and the same config symbols as the v3 run.
- **Refusals, all by name (fail loudly; empty-vs-empty is this project's signature bug):**
  - **the input:** the file is not a SessionReport; or its run was not `al-runner-v3`; or it is a partial run (not
    finished);
  - **the input's selection flags differ from this run's:** `--only`, `--lines`, `--operator`, preprocessor symbols.
    Those are what the key depends on. A mismatch could shift keys and confirm a different mutant;
  - **a selected key matches no mutant, or more than one,** in this run's mutation set. Each is listed by key, file and
    line. This covers source changed between the two runs;
  - **the set is empty** ("nothing to confirm: the v3 run has no noted survivors and the sample is 0"). The run does
    not start;
  - **`--resume`/`--resume-run` with `--confirm-from`:** refused in r1, because a resumed confirm run would need its own
    identity rules.
- **What the run records.** It is a narrowing like `--only`, `--operator` and `--lines`, and it is accounted the same
  way:
  - `run-configured.confirm`: the input's path, its sha256, `n`, the seed, and the selected keys with their group (noted
    or sample);
  - `mutation-set-generated.excludedByConfirm`: the count of sites it left out.
  - Both fold into the SessionReport (a `confirm` block beside `only`/`operators`/`lines`). Otherwise the report's site
    totals would not add up and the selection would be unrecorded.
  - **Cost:** this is the CLAUDE.md ripple for a new SessionReport field (events.ts, report-fold.ts, report.ts,
    generated schemas, schemas.test.ts, report-equality snapshots, the committed sample reports regenerated). It is the
    one report change in this design. It is named here so the build is sized with it.

## 4. What the bcdev run measures, and does not
- **Baseline:** bcdev runs its own baseline over the covering tests of the selected mutants, as any narrowed run does.
- **Coverage:** bcdev attributes coverage itself. A noted survivor that bcdev scores `no-coverage` is reported as such,
  not as `survived`.
- **R1121 (Linux BC):** a BC kill whose killing test failure carries the `linux-rdlc-stub` mark keeps that mark. The
  merge never re-scores it (R1121's ruling: flagged, never re-scored).

## 5. The merged artifact (`confirm-merge`)
- **Input:** the two reports. They are joined on `keyOf`, the same rule as §3. The merge refuses by name if:
  - `bc.json`'s recorded input sha256 is not `v3.json`'s;
  - a selected key is missing from `bc.json`;
  - `bc.json` holds a key that was not selected.
- **Output:** `confirmed.json`, with its own JSON schema and `kind: "lethal-confirmation"`, and a version.
  - **Per mutant, every mutant of the v3 run,** with these fields:
    - `key`, `file`, `line`, `operatorName`, `procedureName`;
    - `v3Verdict`;
    - `group`: one of `noted`, `sample`, `unconfirmed`;
    - `bcVerdict`: absent unless confirmed;
    - `finalVerdict`;
    - `measuredBy`: `bcdev` or `al-runner-v3`;
    - `flags`: for example `linux-rdlc-stub` copied from bc.json, or `bc-error`.
  - **The final-verdict rule:**
    - a confirmed mutant takes BC's verdict, with `measuredBy: bcdev`;
    - every other mutant keeps v3's verdict, with `measuredBy: al-runner-v3`;
    - a BC `error` verdict leaves `finalVerdict` = v3's verdict, with flag `bc-error` and the error note. A BC error is
      not a measurement, so it does not override.
  - **Totals:** counts by `finalVerdict` and by `measuredBy`, and a score only with its provenance printed beside it:
    "N survivors, M of them measured on BC". Never one blended number without that line.
  - **The sample result (§6):** `sampled`, `sampleKilledOnBc`, and the upper bound.
- **Console:** a short banner with the same totals, then each confirmed kill (key, file:line, killing test).

## 6. The sample of unnoted survivors
- **Purpose:** re-measure, per project, the assumption that unnoted survivors agree with BC, not inherit it from
  PR-137.
- **Default `n` = 30,** drawn uniformly without replacement from the unnoted survivors with a seeded PRNG.
  - The seed defaults to the sha256 of `v3.json`, so the draw can be repeated, and it is recorded.
  - `n` above the number of unnoted survivors means all of them. `--confirm-sample 0` turns the sample off and is
    allowed.
- **Reading it:** with 0 kills in `n`, the merge prints the one-sided 95% upper bound on the unnoted kill rate (the
  rule of three, about 3/n: 10% at n = 30).
- **Stop rule:** any sampled unnoted survivor killed on BC (R1121-flagged kills excluded) makes the merge print
  `unnoted-disagreement` with the keys. It then recommends a full bcdev run of the scope, and the artifact carries
  `sampleVerdict: "disagreement"`.
  - The merge does not fail: the measurement is the product. Open for review: whether a CI user wants a non-zero exit
    code for this.

## 7. Known limits (stated in the user docs)
- **The note marks a codeunit, not a test.** A noted survivor's refused test may never have reached the mutant, so the
  BC set is a superset. It costs BC time, never correctness.
- **A mutant v3 scored `killed` is never re-checked.** v3's false kills (R1121-like, or a v3 wrong answer) need their
  own flow. Out of scope.
- **Unnoted survivors outside the sample** keep v3's verdict, labelled `measuredBy: al-runner-v3`. The sample bounds
  that error rate; it does not remove it.
- **Same source, same build:** the two runs must see the same source. The key check (§3) refuses a moved mutant, but an
  edit that keeps every key the same and changes behaviour is not caught. The docs say: run both from one commit.

## 8. Pre-committed predictions for the first live use (if built)
On PR-155's scope (DO, the 50 candidates' lines and 7 operators, edge-4ebfe7913, bc4), reusing PR-155's v3 report:
- **The confirm run selects 35 noted keys plus 29 unnoted ones** (n = 30 is above the 29 unnoted, so all are taken):
  64 mutants in all. No selection refusal.
- **BC kills 8 of the 35 noted ones,** M0001, M0002, M0047, M0048, M0049, M0082, M0083 and M0084 by PR-155's codes,
  matched by key. **It kills 0 of the 29 sampled.**
- **The merge prints** 8 confirmed kills, `sampleVerdict: "agreement"`, and an upper bound of about 10%.
- Any difference from these figures is investigated before any claim. A difference in the 8 is a BLOCK.

## 9. Tests a build must carry (red-checked each way)
- **Selection, `--confirm-from`:**
  - selects exactly the noted plus sampled keys;
  - refuses each §3 case by name, each with a test that goes red without its guard;
  - the seeded draw is deterministic.
- **Merge, `confirm-merge`:**
  - the final-verdict rule, including `bc-error` keeping v3's verdict;
  - each join refusal;
  - the stop rule firing on one sampled kill, and NOT on an R1121-flagged one;
  - totals equal the per-mutant rows.
- **`keyOf`'s move** leaves every itest baseline key byte-identical: an existing guard, re-run.
