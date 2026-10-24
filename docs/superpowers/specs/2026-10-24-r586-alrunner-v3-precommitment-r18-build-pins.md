# R-586 pre-commitment r18 (R-586c): per-build pins for al-runner v3.0.0-alpha.5, judged in advance

DRAFT for review. Not committed. Master path when committed:
`docs/superpowers/specs/2026-10-24-r586-alrunner-v3-precommitment-r18-build-pins.md` (r18 is the next free number after r17; re-check against origin/master).
Commit it alone, `[skip ci]`, from a scratch origin/master worktree, before any live run of the new code and before any alpha.5 run at the pin code.

Written by lane bugs on 2026-10-24 from READING ONLY (design: `/coord/handoff/R-586c/design.md`). No gate, probe or al-runner call was run.

Delta to r15, r16, r17 (`docs/superpowers/specs/2026-10-24-r586-alrunner-v3-precommitment-r15-alpha5.md`, `...-r16-serve-keep.md`, `...-r17-hub-oracle.md`). Everything there stands except
what is named here. A differing reading is still a BLOCK. This delta is the "R-586c per-build pins" that r15 ("When the #5700 ruling is lifted") and r17 ("alpha.5 stays held")
named; it re-pre-commits the held facts, one by one.

## What changes

The gate gets a table of pins, keyed by BOTH the `--version` line and the binary's sha256, in code: `packages/runner/itest/al-runner-v3-pins.ts`. One pin exists:

| Field | Value |
|---|---|
| version | `al-runner 3.0.0-alpha.5 (07342060e)` |
| binarySha256 | `fd4d6d406a2f2170fccfe13413d51bbb1317b78b3ef5af3800ca9a6009b51db2` |

A pin entry passes only when the reading is EXACTLY the pinned one. **B1: on a pinned build, any other reading of a pinned entry is the WORSE of the rules of r14 to r17 and `held`**: it is never a
pass, even where today's rules would pass it (alpha.2's `defect-present` for a pinned fact, alpha.2's X (b) 7/1/1, all seven T rows `survived` all read `held`); a `gate-fail` stays `gate-fail`. A build with no pin (alpha.2, alpha.3,
alpha.4, edge, a rebuild of alpha.5 with another sha or another version string) is judged by the unchanged code path. The pin is used by the gate only; a user session is unchanged.
This supersedes r17 "alpha.5 stays held" for the entries below, and only for them.

## The pinned readings

### Leg C (7 defect facts; the other 21 facts are as r14 to r17)

All `measured` values are the text of `C: <fact> = <verdict> | <measured>` in `gate.log`; `\d+` = a number that varies by run. The code builds each pattern from the logged text with an
escaping helper (everything escaped; only `{n}` becomes `\d+`, and `{cut}` becomes `[^"]*` for `sleep-is-noop` alone), anchored `^...$`, no flags.

1. `none-selected-exit` = `gone` | `exit 6, stdout 0 rows`. Not a BC question (#5613 closed; r7's pre-committed fix shape). No issue.
2. `quoted-name-unselectable` = `gone` | `exit 0`. Not a BC question (#5572 closed). No issue. The fact measures nothing but the exit code; the contract fact `quoted-name-in-rows` (`matches`) covers the row. LethAL never selects a test by name, so no LethAL verdict depends on it.
3. `refusal-cascade` = `gone` | `[{"codeunit":50654,"method":"LaterFails","name":"Codeunit50654.LaterFails","status":"fail","durationMs":\d+,"message":"later","notRun":false}] exit 1`. As BC (an `Error()` test fails with its text; #5610 closed). The row is trusted: contract fact `dependent-fail-after-timeout-is-notrun` (`matches`) pins that a failure caused by a refused sibling's state comes back as `notRun`, not a plain `fail`.
4. `sleep-is-noop` = `gone` | N=3 call: `ShortSleep` `pass`, `LongSleepA` `error` (cut at 250 characters inside "Test e..."), then `; no flag: <ms> ms` with that wall under 1000 ms. BC evidence is the verdict class only (r11 at 120 s); wall time and `durationMs` are not BC's (virtual clock; instant without a limit flag). LethAL's §6 still refuses Sleep-covering mutants (R649 step 2).
   No #5605 issue (closed; upstream's design). **B2:** alpha.5 stops on a virtual clock but reports a real-clock `durationMs` (ShortSleep 0; LongSleepA stopped at "3s" after 37-46 ms), which `v3RowVerdict` would score as a timeout
   (a possible false kill). R-586c adds a guard, below, and the coordinator files an upstream issue for the durationMs mismatch (after a search for an existing one).
5. `upstream-compile-errors` = `gone` | `exit 3 null`. As BC in effect (nothing runs when the app does not compile; #5602 closed).
6. `refusal-row-shape` = `gone` | `[{"codeunit":50653,"method":"HttpGet","name":"Codeunit50653.HttpGet","status":"fail","durationMs":\d+,"message":"<BC_HTTP_HUB_TEXT>","notRun":false}] exit 1`. As BC on the hub path (R706, owner ruling R712). #5700 stays open; no new issue.
7. `duplicate-key-insert-raises` = **`refused`** | `[{"codeunit":50655,"method":"DuplicateNamedKey","name":"Codeunit50655.DuplicateNamedKey","status":"error","durationMs":\d+,"message":"NotRun: out-of-scope: the test ends while the error of a duplicate-key Insert into table Probe Row is deferred: whether the test runner raises it at the end of the test is not pinned","notRun":true}] exit 7`.
   **Differs from BC** (BC fails the test at its end: `BC_END_OF_TEST_TEXT`, bc1, `docs/measurements/r639/bc1-probe.json`). Upstream: **#5788** (open). Accepted as a pinned refusal because it fails closed and is better than alpha.2, which reads `survived` where BC reads `killed`. Two cases (M4): a decline UNDER a mutant reads `error` / `runner-refused` (fail-closed);
   a decline AT BASELINE leaves the test out of the covering set, so a mutant covered only by other passing tests reads `survived` with the `[v3-refused-test-nearby]` note, which matches BC, because BC fails that test at baseline too.
   No wrong verdict in either case; the cost is lost kills.

Not pinned, unchanged: `codeunit-runs-whole` `defect-present`; `commit-under-test-isolation` `defect-present` (#5607); all contract facts `matches`; `serve-keep-reasons` (warn).
A `gone` reading of any unpinned fact is `held` or `gate-fail` as today. A pinned fact reading anything else is at best `held` (B1).

### Leg T (the 7 rows)

Exactly these keys move from the alpha.2 baseline value (`survived`, errorClass none, killingTest none) to `error`, errorClass `runner-refused`, killingTest none. Every other field of the row,
including `coverageFiltered` and `mutatedTextSha256`, equals the baseline.

- M0157 `a811b46c95a74b761966dc4d0fd260793ba4c503b9cc6c7efd6e554acb7563d8|Data Flag Ops|InsertTwiceWithKeyTrigger|lethal.remove-assignment|1`
- M0158 `c88702df06dca2c0edbdf144edf99c2682ad63278023dbd7e46f42c9875e0364|Data Flag Ops|InsertTwiceWithKeyTrigger|lethal.toggle-blank-string|1`
- M0159 `e75f9a0967677be80d3659fdc47e601d3764ac75077fb4d25c54b5f1322b2a8a|Data Flag Ops|InsertTwiceWithKeyTrigger|lethal.swap-modify-flag|1`
- M0161 `dd3aa023aa7fb2b7893efe181ccbf517d3ca97cbfacec07f3818c25c45c127dc|Data Key Probe|OnInsert|lethal.empty-block|1`
- M0162 `2d119c2ec73ab1ae52dbba9a46ff0f4bc4d1489684b7064c985ef4a94112ee7e|Data Key Probe|OnInsert|lethal.negate-conditional|1`
- M0163 `c88702df06dca2c0edbdf144edf99c2682ad63278023dbd7e46f42c9875e0364|Data Key Probe|OnInsert|lethal.toggle-blank-string|1`
- M0164 `0121538c88a9342b484d6597b43bf7bc9d138149790fb204378e0afae2086339|Data Key Probe|OnInsert|lethal.remove-assignment|1`

BC reads `killed` (by `DoubleInsertWithoutKeyTriggerRaises`) for all seven; cause #5788. Cost: seven lost kills of 406 (1.7%) on this fixture; each reads `error` (declined), not `survived`.
Counts: **290 killed / 50 survived / 59 no-coverage over 406** (7 `error`); Sleep index 0 + 0; `unsupportedTests` 3; the other 45 known rows equal the baseline. `judgeLegT` reads `pass` and `assertGateBaseline` against alpha.2's baseline is replaced by the same compare against the baseline with these seven overrides.

### X (b)

M1, pinned shape: exit code 3; the document's `passed` and `notRun` PRESENT and `=== 0`; `failed` (if present) `=== 0`; no result rows; `compilationErrors` a non-empty array: `pass` (as BC: an app that does not
compile runs no test). The gate logs the document's keys and counts into gate.log first. Every other shape, alpha.2's 7/1/1 included, is at best `held` (B1); today's `gate-fail` stays.

### B2: the virtual-clock timeout guard (a backend change, part of this delta)

**Where (D-B1):** in the backend CALLER (`al-runner-v3-backend.ts`), after the baseline return `if (this.lastActivated === null) return verdict;`, next to the R-435 timeout check; NOT in `v3RowVerdict`, which also runs at
baseline (it would turn alpha.5's X (d) 600 s Sleep siblings into errors and gate-fail leg X, and break R678's baseline symmetry). So it applies only when a mutant is active; baselines and confirms are unchanged.
**Rule (D-M1):** when the verdict is `timeout` and the row's `durationMs` is a number `< n x 1000` (n = the stop in seconds; a genuine CPU stop has wall >= n x 1000: measured 3006, 3009, 2004-2007, 16038), the row is `error`,
`runnerRow: "runner-refused"`, with the bracketed text "[al-runner v3: stopped on v3's virtual clock; BC's real wait unknown; never scored]" (R-435 style, no `V3_NOT_RUN_SUFFIX`), not `timeout`. A CPU timeout is still scored; a
row with no `durationMs` is scored as today. Offline unit tests both ways (V-1 to V-6, including: a BASELINE call with a virtual-stop row still reads `timeout`; boundary n x 1000 - 1 refused, n x 1000 scored) with red checks.
**Predicted effect on any gated figure: none. Mutant-side only; no gate row timeout-kills on either build (`timeout-killed 0` in every leg), so no figure moves.** The full alpha.2 gate and the selected BC gates run on the final head because the backend changes.

### Record requests (M5)
Any `LETHAL_ITEST_RECORD_BASELINE` request on a pinned or candidate build is refused by name, for every recording leg. No baseline is recorded from alpha.5.

## K and serve on alpha.5 (r15's prerequisite)

- K on a candidate: opt-in `LETHAL_ITEST_V3_K_ON_CANDIDATE=1`, through a test seam `alRunnerCandidate` in `buildBackend`'s `deps` (no config key, no flag). Default (variable unset): K stays skipped on candidates; `V3_GATE_LEGS` is unchanged.
- Serve: the R635 protocol, E1 (S1), E2 (T), E3a (D1, second echo on) on alpha.5 as a candidate with `LETHAL_ITEST_V3_TRANSPORT=serve-entries`.

## Figures that move

None on alpha.2. No baseline file moves, no pre-committed count changes (fact count 28; T's alpha.2 counts 290 / 57 / 59 stay alpha.2's). No new receipt field.

## Predictions ("Measured" = a run showed it; "Inferred" = code, another build or the receipt)

### A. Full gate on alpha.2 at the final head
`LETHAL_ITEST_ALRUNNER_V3=1 LETHAL_ITEST_V3_CDO=/work/lethal-wt/cdo-r396 LETHAL_ITEST_V3_TABLES=1 bun run itest:alrunner-v3`, all default legs, alpha.2 via `current`:
**14 legs pass** (C S1 S3 N1 X L1 Y-A Y-B MO WR K D1 D1c T), the figures of r15 table A, unchanged; no `PIN` line. Leg C: 28 facts, 9 defect `defect-present`, 18 contract `matches`, `serve-keep-reasons` `matches`.
Any difference is a BLOCK. `itest:bcdev`, `itest:lease`, `itest:tables`, `itest:chunked` (the legs `selectLegs` picks for `packages/runner/`): unchanged figures per mutant; any difference is a BLOCK.

### B. Full gate on alpha.5 as a candidate (the L2 command of the plan; K opt-in)
First line after the head line: `al-runner-v3 itest: PIN alpha.5-07342060e applies`. Receipt-style result: **all 13 `V3_GATE_LEGS` `pass`, outcome `pass`**.

| Leg | Prediction | Status |
|---|---|---|
| C | `pass`: 28 facts; the 7 pinned lines print `pinned:`; no `held:` line, no `gate-fail:` line, no `unlike-bc` line; `codeunit-runs-whole` and `commit-under-test-isolation` `defect-present`; `serve-keep-reasons` `matches` (http: plain fail, commit: refusal, cascade: plain fail, onrun-failed: refusal) | Measured (6eddda0b log for 26 facts; `/coord/handoff/R-705/legC-alpha5.log` at 5973ed6b for all 28). Inferred: that a full run reads the same |
| S1 / S3 / N1 | `pass`; 3 / 12 / 4 over 19; refused by name; 36 / 0 / 0 over 36; 0 differences; no `unlike-bc` line | Measured at 6eddda0b |
| X | `pass`: X (b) is the pinned refusal (no `held` line); (d) the r5 table; (e), (f1)-(f3) as pre-committed; `baselineGreen false` from the three 600 s siblings is NOT a failure | Measured at 6eddda0b |
| L1, Y-A, Y-B | `pass`: 7 / 3 / 0 over 10; 5 / 4 / 0; 5 / 4 / 0; 0 differences from their baselines | **Inferred**, never run on alpha.5 |
| MO, WR | `pass`: 6 / 1 / 5 over 12 killers 6; 58 / 37 / 3 over 98, killers 58, 3 `WrappedArms` refusals, 6 state notes | **Inferred**, never run on alpha.5 |
| D1, D1c | `pass`: 51 / 12 / 0 and 51 / 8 / 4, 0 differences from bc3-A and bc3-B | Measured at 6eddda0b |
| T | `pass`, pinned: 290 / 50 / 59 over 406, errors 7, the seven keys above, Sleep 0 + 0, `unsupportedTests` 3; one `T: pinned 7 rows` line; no `T: held:` line | Measured at 6eddda0b (rows and counts); the equality of every other field is **Inferred** |
| K (opt-in) | `pass`: coverage `al-runner`, one-shot, 0 serve spawns, the not-authoritative warning, 3 / 12 / 4 over 19 equal per mutant to `bcdev.baseline.json` | **Inferred** (alpha.2 measured; never run on alpha.5) |

### C. Serve-entries on alpha.5 (E1, E2, E3a)
Each equals the same leg's one-shot control from B, per mutant: S1 3 / 12 / 4; T pinned (290 / 50 / 59, the seven rows); D1 51 / 12 / 0 with 0 differences from bc3-A, Sleep index 3 + 0. **Inferred** (alpha.2 measured by R635).
A difference in any of them, or in K, is a BLOCK on moving `current`: the orchestrator decides; it is not tuned away. Serve is opt-in; r15 made this measurement a prerequisite and r18 keeps it.

### E. alpha.3 and alpha.4 as candidates at the final head (M3 b), before the merge
Full gate, same command as B without K and without a pin (they have none), each from its kept binary (`failed/v3.0.0-alpha.{3,4}@6eddda0b…/al-runner`).
- alpha.3 (`al-runner 3.0.0-alpha.3 (c893e3633)`): **`gate-fail`**: D1 and D1c `gate-fail` (all 63 mutants `error`, 0 / 0 / 0, #5606), as the 6eddda0b receipt; C, S1, S3, N1, X, T `pass` there. Inferred for L1, Y-A, Y-B, MO, WR.
- alpha.4 (`al-runner 3.0.0-alpha.4 (7739d8132)`): **`gate-fail`**: C (`unlike-bc` line today; with r17 the hub text reads `gone`, so C is `held`), D1 and D1c `gate-fail` (63 `error`; the cause #5641 is **inferred** from the 6eddda0b receipt, which names no issue). So the outcome is `gate-fail` from D1/D1c. (alpha.3's cause, #5606, is grounded: R586 row 5.)
Neither can read `pass`: they have no pin, so their `gone`/refused readings stay `held`, and their D legs fail. Because the daily loop stops at the FIRST pass in the order 3, 4, 5, a pass of either would move `current` to it before
alpha.5. **Decision: that would NOT be accepted.** If either reads anything other than `gate-fail`, stop, do not merge, report to the orchestrator.

### D. The update gate for alpha.5 (after the merge; M3 a)
**Merge gate (M3 a):** do not merge until B, C and E match this document exactly at the final head. L4 starts only after the merge.
After the pin code is on master and `--regate <master sha>` on alpha.2 has passed (`.gated.lethalCommit` = that sha):
- `bun scripts/al-runner-v3-update.ts` gates alpha.3, then alpha.4, then alpha.5 (oldest first, until a pass). alpha.3 and alpha.4: `gate-fail` as at 6eddda0b (**Inferred**; D1 and D1c on alpha.3, C and D on alpha.4); each writes `failed/<tag>@<new sha>`.
- alpha.5: **`pass`**, receipt `dirty: false`, 13 legs `pass`. The script writes `/work/tools/al-runner-v3/3.0.0-alpha.5-07342060e/{al-runner,.gated}` and **`current` moves to alpha.5**, unless a v3 process is running ("deferred: in use"; then `current` stays alpha.2 and the next run finishes it).
- `.gated.warnFacts` = `{serve-keep-reasons: matches}`.
- If any pinned reading differs, the result is `held` (or `gate-fail`), `current` stays alpha.2, and the kept receipt names the reading (`pin-mismatch:` lines). That is a BLOCK to report, not a result to retune.

## Tests (red-checked)

Named in the plan (`/coord/handoff/R-586c/plan.md`), each red on its own single revert, in both directions: the pinned exact reading passes (C-pin-1, X-pin-1, T-pin-1); any other reading on alpha.5 does NOT pass
(C-pin-3 per fact and per case, each exactly `held`; C-pin-4, C-pin-5, C-pin-6, X-pin-2 with 7/1/1 exactly `held`, T-pin-0 with all 7 rows `survived` exactly `held`, T-pin-3 to T-pin-6); the guard (V-1 to V-6); record refusal (M5); alpha.2 and the pin-less call are unchanged (C-pin-2, X-pin-1 without pin, T-pin-2, the whole of `r586-gate.test.ts` unedited);
a same-version, different-sha build gets no pin, and a same-sha, different-version build gets none (P-key-2). Meta tests keep the table narrow (P-meta-1 to P-meta-4).

## Decisions (coordinator rulings)
1. `sleep-is-noop` is pinned, with the rider: BC evidence is the verdict class only (r11 at 120 s); wall time and `durationMs` are not BC's. The B2 guard closes the false-kill path.
2. The K seam (test-only, S3 wiring test) is accepted. K is measured on alpha.5 BEFORE admission, in L2 (table B).
3. No `--only <tag>`: the daily run re-gates alpha.3 and alpha.4 once (about 75 minutes with alpha.5); table E pre-commits what the candidate runs read.
4. Session warning noise (six `defect-gone` lines, one `defect-refused` line on alpha.5) is out of scope; a roadmap item is filed in the build: "mute al-runner-v3-defect-gone/refused session warnings for facts a per-build pin covers".
