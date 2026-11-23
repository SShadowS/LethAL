# PR-347 pre-commitment: flip `alRunnerV3.refusedCutTail` to default-on, with the fixture leg PR-297 asked for (R1160)

Status: pre-commitment (coord PR-347, lethal-preproc, 2026-11-23), after the spec-adversary (1 BLOCK, 7 SHOULD-FIXes and
3 NITs, all taken below) and two premise probes, before the build. Evidence: `/coord/handoff/PR-347/`: `plan.md`, `flipped/`,
`compare.txt`, `probe-format/`, `probe-tailcut/`, `kept-check.ts`, `bc68874/`. Also `/coord/handoff/PR-371/control/`.
Related: PR-297 (`2026-11-21-pr297-refused-cut-tail.md`, review SF6), PR-302, PR-344, PR-365 (R1187), [[R1160]].

## What step 1 measured (the default flipped, uncommitted, full v3 gate, master 9a490c686)
- 23 of 23 legs PASS, and 0 per-mutant differences against a same-commit control, in every leg.
- **That proves nothing about the tail route:** all 18 `al-runner-v3-refused-cut-tail` lines read 0 cut entries and 0 tail
  alone calls. The PR-250 cut never fired in any leg, and both `tailRouting` and the stability pass need a cut.
  - So the basis for "every other leg is unchanged" is "0 cuts in every other leg on today's fixtures". It is re-gated on the
    final head.
- **RC cannot cut:** `refusedCut()` cuts only at the first baseline row that is a named refusal AND not daemon-reusable.
  RC's A0 and B0 Evaluate a 10-NUL text, which `PR56_KEPT` keeps (`\x00{10}`), so the daemon is reused. RC measures PR-144's
  recheck, by design.

## What the flip does on DO today (R1160's evidence, corrected; adversary S1)
- On current master (PR-365 landed), the tail route fires only in DO codeunit 68874. That is the rest of c3's cuts on
  main-bf3a3e863: 68874 (54 errors, "Report.SaveAs as Pdf of report ...: not measured on BC", which matches no kept row),
  68975 and 68984 (now kept by PR-365). 68906 is not cut on current.
- PR-302's M13065 (#8721) is an al-runner false kill that the flag SURFACES, not a flag-free one: with the flag off it was
  `error`. It is in 68975, which no longer takes the tail route.
- The figures for the owner come from PR-344's arm A (current master) and a BC check of all 54 of 68874's verdicts in both
  directions (`/coord/handoff/PR-347/bc68874/`, its rule written first). R1160 closes only on that line. Any false kill,
  false survivor or unjudgeable row is listed there, not rounded away.

## The refusal for the new fixture (probed on current main-bf3a3e863)
- `Format(8, 2, '<Integer,2>')` gives `NotRun: out-of-scope: Format of Integer 8 with length 2 and a format string (not
  pinned)`.
  - It matches none of the 134 `V3_SERVE_SAFE_REFUSALS` entries and has no keep near-miss: **unkept**.
  - LethAL's serve path (whole codeunit, `isolation: "test"`) closes the daemon with reason `refusal` and the family
    "Format of Integer N with length N and a format string".
  - It is deliberate ("not pinned"). DO's 68906 cut came from it on the older build.
- The same fixture's baseline under the flag: the stability pass ran, and read T1, T2 and T3 stable and T4 unstable. T4 passes
  after T3 in the whole-codeunit baseline and fails alone ("T3 must run first").

## The fixture (v3-only): `fixtures/sandbox-tailcut` and `fixtures/sandbox-tailcut-tests`
- Runtime 17, the recheck fixtures' symbols, object ids 76100-76199, selector ids 76147-76149 (free in `fixtures/README.md`).
- Codeunit 76100 "Tailcut Logic":
  ```al
  procedure Triple(N: Integer): Integer begin exit(N * 3); end;
  procedure Double(N: Integer): Integer begin exit(N * 2); end;
  procedure IsBig(N: Integer): Boolean begin exit(N > 5); end;
  procedure IsSmall(N: Integer): Boolean begin exit(N < 3); end;
  ```
- Codeunit 76150 "Tailcut Tests" (one global `Marked: Boolean`), in declared order:
  1. `G0_TripleTwo`: `Triple(2) = 6`. A green covering test BEFORE the refusal (S3), so the cut entry is not empty, as on DO.
  2. `T0_RefusedFormat`: `Format(8, 2, '<Integer,2>')`. It covers no mutant.
  3. `T1_DoubleTwo`: `Double(2) = 4`.
  4. `T2_IsBigTen`: `IsBig(10)` is true.
  5. `T3_SetsMark`: `Marked := true`.
  6. `T4_SeesTheMark`: `Marked` must be true, and `IsBig(5)` must be false. Unstable (fails alone).
  7. `T5_IsSmallOne`: `IsSmall(1)` is true. Stable.
- Not in any BC gate (no `lethal.config` in either directory, and no BC itest names it). Not in `compile:fixtures`' symbol
  pairs (`fixtures/sandbox-symbols` only). `compile:fixtures` compiles it like every fixture.

## The per-mutant table, predicted by hand (S2)
The probe's offline census of a near-identical target gave the operators: per procedure an `empty-block` and a
`return-value`, plus a `conditional-boundary` on each comparison. So 10 mutants:

| site | mutation | off (flag false) | on (default) | alone truth (`isolateTests`) |
|---|---|---|---|---|
| Triple | empty-block (returns 0) | killed by G0 | killed by G0 | killed by G0 |
| Triple | `exit(0)` | killed by G0 | killed by G0 | killed by G0 |
| Double | empty-block | `error` (cut) | killed by T1 (alone) | killed by T1 |
| Double | `exit(0)` | `error` (cut) | killed by T1 (alone) | killed by T1 |
| IsBig | empty-block (false) | `error` (cut) | killed by T2 (alone) | killed by T2 |
| IsBig | `exit(not (N > 5))` | `error` (cut) | killed by T2 (alone) | killed by T2 |
| IsBig | `N >= 5` | `error` (cut) | **`error`**: T2 passes and T4 is unstable | survived (T4 is red alone at baseline, so not covering) |
| IsSmall | empty-block (false) | `error` (cut) | killed by T5 (alone) | killed by T5 |
| IsSmall | `exit(not (N < 3))` | `error` (cut) | killed by T5 (alone) | killed by T5 |
| IsSmall | `N <= 3` | `error` (cut) | survived (T5 passes alone) | survived |

- If the census gives a different set (another operator, or a dedup), that is recorded in an amendment before the record
  run. A row that moves after it is pre-committed is a BLOCK.

## The leg: TC in `itest:alrunner-v3`, three sessions on `current`, serve-entries, `isolation: "test"`
1. **TC-off:** `refusedCutTail: false`, explicit;
2. **TC-on:** the key absent (the new default);
3. **TC-alone:** `isolateTests` (per-test mode, where `refusedCut()` is undefined).

The judge, in order:
- **(a1) The cut fires,** asserted first: in TC-off and TC-on, the stats line's `cut before a baseline-refused test (PR-250)`
  is above 0 for codeunit 76150. If not, the leg fails as `TC: no PR-250 cut`, printing T0's actual baseline row (status,
  notRun, text) and its keep or near-miss result. It never guesses a cause (S4).
- **(a2) The tail ran,** in TC-on: the stability pass ran (its notice names T1, T2, T3 and T5 stable and T4 unstable), and
  the tail alone calls under a mutant are above 0. If not, it fails as `TC: the tail route did not run`, quoting any
  "stability pass was not run (...)" notice.
- **(b)** The three sessions equal the table above, per mutant: verdict and `killingTest`.
- **(c)** TC-on equals TC-alone for every mutant except those covered by T4 that no stable test kills. Those are `IsBig
  N >= 5`, exactly 1, never `survived`.
- **(d)** Tail kills in TC-on carry `selection: "alone"` and the `[refused-cut tail ...]` note.
- **(e) A frozen baseline:** `al-runner-v3.tailcut.baseline.json` holds the three tables. Recorded once by R332's procedure,
  then compared.

**GATE_WARNINGS, three keys** (S5): `al-runner-v3/TC-off`, `TC-on`, `TC-alone`. Each starts from RC's committed set (the
same environment and transport); the build pins the exact base. Then:
- TC-off adds `al-runner-v3-baseline-refused-cut` (`handNotify`);
- TC-on adds that, the `al-runner-v3-refused-cut-tail` stability notice, and `alone-confirm` (R1067);
- TC-alone adds the per-test isolation notices that leg DBI's set carries, and neither cut code.
If a key differs on the first run, the difference is pre-committed in an amendment before the record run, with its cause.

## The flip
- **The backend:** `refusedCutTail` is on unless `false` (the four `=== true` reads become `!== false`).
- **The CLI (BLOCK B1):** `v3SectionPassThrough` (`cli.ts`) passes the key whenever it is set (`!== undefined`), so an
  explicit `false` reaches the backend. The same goes for the lane rig's key (`tests/helpers/v3-lanes-rig.ts`). Today it
  passes only `true`, which under the flip would silently turn a user's `false` into ON.
  - Test: through the real pass-through, `false` reaches the backend and the getter reads false. Red-checked by restoring
    `=== true`.
- **RC keeps `refusedCutTail: false`,** explicitly, so PR-144's recheck path stays measured. Every other leg takes the default.
- **`--resume` across the flip (S6):** a named refusal, as PR-209 (M6) and PR-340 did: a search for an unfinished run whose
  fingerprint differs only by `v3RefusedCutTail`, and a message that says so and how to resume (the old setting, explicit).
- **The fingerprint and the lending tag:** every default v3 run gains ` refused-cut-tail`. Rows lent from builds without the
  tag no longer match. Named on `docs/gates/alrunner-v3.md` and in R1160.
  - **N1, accepted and stated:** per-test, method-isolation and one-shot v3 runs are tagged too, though `refusedCut()` never
    acts there; that costs lending matches between such runs. The report text is reworded so it does not claim that a test
    "was measured alone" when no cut happened.
- **The stats line** prints on every serve-entries run. It is a console line after notify is restored, not a warning, so no
  committed warning set moves (step 1's flipped run passed every set).
- **Tests pinning the new default (S7)**, on the REAL backend:
  - the key absent: the getter is true, the tag is present, and the report carries `refusedCutTail: true`;
  - `false`: the getter is false and the tag is absent.
  - Each direction is red-checked by reverting the getter. The stub-based tests (pr297 6c, r586-backend-kind, pr256-stop-groups
    573) do not move. pr297 6a (the validator: "absent stays absent") does not move either, since the validator is unchanged.
- **Text:** `al-runner-v3-config.ts`'s "OFF by default" comment, PR-297's spec note, and PR-344's spec prediction "no gate
  turns the flag on" (TC now does).

## Predictions
- **Every leg except TC:** unchanged per mutant (0 cuts on today's fixtures); re-gated on the final head. RC pinned off.
- **TC:** (a1)-(e) hold with the table above; its baseline is recorded once, then passes.
- **BC gates:** no move. The flag is v3-only (bcdev never defines the getter).
- **R1160 closes** on the BC-checked line for 68874, with #8721 named as the false kill the flag surfaced on the older build's
  68975 (now kept).

## Pages to change
- `fixtures/README.md`: the two fixtures and their ids.
- `docs/gates/alrunner-v3.md`: leg TC, its baseline, its three warning keys, and the flip's fingerprint and lending note.
- `docs/gates/README.md`: the feature line, if that page lists v3 defaults.

## Amendment 1 (2026-11-23, the build 6abba9995 + 605de6920, before any gate)
- **The census matches the table:** 10 mutants, the operators as predicted. The table stands.
- **A golden that moves (not predicted above):** `tests/v3-lane-trace.expected.json` gains one notice, the tail stats line.
  In that scripted session `notify` is still the event emitter when the stats line prints, so it lands among the notices.
  In real sessions notify is restored first, which is why step 1's warning sets did not move. Accepted.
- **Departures, accepted:**
  1. `al-runner-v3.tailcut.baseline.json` holds TC-on's table only (`assertGateBaseline` takes one report). TC-off and
     TC-alone are frozen in code (`TC_TABLE`) and judged per mutant from it.
  2. (d) checks the `[refused-cut tail` note on TC-on's tail kills. `selection: "alone"` is not a report field.
  3. (a1)'s failure prints the refused tests, T0's `baseline-refused-cut` notice and `unsupportedTests`, but not T0's exact
     row or its keep result, which the report does not carry. It still names no guessed cause.
  4. The warning keys, predicted:
     - TC-off: `al-runner-v3-baseline-refused-cut`;
     - TC-on: that, `al-runner-v3-refused-cut-tail` and `alone-confirm`;
     - TC-alone: `al-runner-v3-isolate-tests`, ISO's set. DBI's `memory-guard` and `serve-flagged-unknown` come from its
       daemon baseline, which TC does not use.
     If the first run differs, an amendment states it before the record run.
  5. The resume refusal is symmetric (on to off as well as off to on), a plain `Error` prefixed
     `refused-cut-tail-resume-refused`, like PR-209's.
  6. The real backend's report field is not tested in a whole session: it reads the tested getter.
- **The first live run:** TC is recorded once (R332: `LETHAL_ITEST_RECORD_BASELINE=al-runner-v3.tailcut.baseline.json`,
  which exits 3), then re-run to confirm a pass, then the full v3 gate on the final head.

## Amendment 2 (2026-11-23, the Opus build review of 6abba9995: no BLOCK, 3 SHOULD-FIXes; before any gate)
- **The carry gate is in scope (S1).** `itest:alrunner-v3-carry` builds the real backend without the key, so the flip turns
  the flag on there. Step 1 did not measure it. It runs on the final head with PR-347's gates. **Prediction: unchanged**,
  because `fixtures/sandbox-carry` has no baseline refusal: 0 cuts, 0 tail calls, and its committed figures and warning sets
  pass as today.
- **`compile:fixtures` and the new fixtures (S2):** the pinned symbol tar does not hold the two new fixtures, so
  `compile:fixtures` SKIPs them on a fresh worktree. That corrects "compiles it like every fixture" above. The skip is
  recorded in R1128 by name (the orchestrator's ruling). Leg TC is unaffected: it takes its Microsoft symbols as RC does.
- **A golden that grows (S3, the orchestrator's ruling: keep):** `tests/__fixtures__/instrumented-output-golden.json` gains
  two entries, `TailcutLogic` (10 mutants, equal to the census and the table above) and `TailcutTests` (34). They are additions
  only: no existing entry's bytes change, and the result shows the diff.
- **Merge order:** TC is a default leg, so the update gate refuses at preflight until `al-runner-v3.tailcut.baseline.json` is
  committed. The baseline is recorded and committed in the branch before the merge.
- **NITs fixed in round 2:**
  - the judge's extra-row and duplicate-row guards get red-going tests;
  - (a1)'s evidence comes from the session that failed;
  - the fixture test ties the `IsBig(5)` check to T4;
  - the resume message says "with refusedCutTail off" or "on", not "the default".
- **NITs accepted:** about 18 un-awaited `baselinePhase(false)` calls in one test file (production awaits); PR-209's generic
  message for runs from before PR-209 (still refused); the flag message coming first on `--resume-run` (still refused).
