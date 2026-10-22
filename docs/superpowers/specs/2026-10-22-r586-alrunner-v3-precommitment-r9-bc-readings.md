# R-586 pre-commitment r9 (R-639): #5608 becomes a defect fact, a still-refused HTTP probe, and a refusal never scores

This file is final (plan r4), dated 2026-10-22. The orchestrator has ruled on Q7: `unlike-bc` refuses NORMAL sessions
by name, and only warns inside the update gate's own candidate legs (§2).

Lane bugs committed this file to master before any R-639 code and before any live run.

This is a delta on r8 (`2026-10-22-r586-alrunner-v3-precommitment-r8-dependent-notrun.md`, 848371cb), as it stands
once R-637 is merged (head b2424bc7, 25 facts). Everything earlier stands, except what is below. A differing verdict in
any leg is still a BLOCK.

**BC evidence:** `docs/measurements/r639/bc1-probe.json` and its README, at `lethal/r639` 55081fc1.
- The server: bc1, BC 28.4 (Base and System Application 28.4.53241.56590), LethAL Control 1.0.0.23.
- The runner: `Test Runner - Isol. Codeunit` (130450). `TestHttpRequestPolicy` is absent.
- There were two runs:
  - run 1 (09:17Z) gave the HTTP readings;
  - run 2 (09:21Z, `TestPermissions = Disabled`) gave the duplicate-key readings.
- Both probe apps were removed and read back absent.

## Why

edge-57f1e4f98 (`al-runner 3.0.0-alpha.4+edge.20261022 (57f1e4f98)`) was gated by hand on 2026-10-22, at de8f43e2.
The evidence is in `/work/tools/al-runner-v3/failed/edge-57f1e4f98@de8f43e2…/`. Three things went wrong:

1. **`refusal-row-shape` read `diverged`.** `HttpGet` to `http://localhost:1/x` is no longer refused. Instead it fails,
   with "There was an error while executing the HTTP request, the connecting endpoint violates security requirements.
   Make sure you are connecting to a valid endpoint."
   - That is upstream's #5608 fix, so the fact is a defect fact, as r7 found for #5613.
   - But bc1 shows that BC fails the same test with ANOTHER text, its default test-HTTP-policy error. So the edge row is
     not BC's reading. The text difference is filed upstream as
     [#5700](https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/5700).
2. **`duplicate-key-insert-raises` read `unmeasurable`.**
   - PR #5623 refuses a test that ends while a duplicate-key error is still deferred.
   - bc1 shows that BC FAILS that test at its end, with "The record in table Probe Row already exists. …".
   - So v3 declines a case that BC fails.
3. **No session leg ran.** The version pattern refused the build metadata. That is fixed in the same build (F1).

The review also found that nothing probed the refusal row shape any more (C1, K1).

## What changes

**Helpers used by every rule below:**
- `isRefusalRow(row)`: `notRun === true`, `status === "error"`, and a message starting `NotRun: out-of-scope: `.
- **The implied exit:** 1 if any row is a plain `fail` (`notRun` false); otherwise 7 if any row is `notRun`; otherwise
  0.
- Each decided row must be the only row of its method in its call.
- A missing message counts as `""`.
- **The pinned BC texts.** Each is byte-exact: no trim, no case folding, no prefix match. A unit test binds each one to
  `bc1-probe.json`.
  - `BC_HTTP_INTERNAL_TEXT` = `The request was blocked by the runtime to prevent accidental use of production services.`
    It is 92911's `raw` (`rawCode` `HttpRequest`) and 92910's first line, both `fail`.
  - `BC_END_OF_TEST_TEXT` = `The record in table Probe Row already exists. Identification fields and values: Key='K1'`
    - It is the first line of 92912's `DuplicateNamedKey` and of 92913. Both `fail`, raised from
      `Test Runner - Mgt(130454).RunTests`, so at the end of the test.
    - It is also 92915's `raw` (`DB:RecordExists`).

### 1. A refusal never scores (K1(a), a backend verdict rule)

- In `v3RowVerdict`, a row with `notRun === false` whose message STARTS with `NotRun: out-of-scope:` scores
  `outcome: "error"`, `runnerRow: "runner-test-error"`.
- Its message says "a refusal written as a `<status>`; never scored".
- It never reaches `verdictFromRunnerTest`.

### 2. `refusal-row-shape` becomes a defect fact (#5608)

The call is `--codeunit 50653`, unchanged. The row is `HttpGet`.

| Reading | When |
|---|---|
| `defect-present` | `isRefusalRow(HttpGet)`, with the implied exit |
| `gone` | `status: "fail"`, `notRun: false`, message `=== BC_HTTP_INTERNAL_TEXT`, implied exit 1 |
| `unlike-bc` | `status: "fail"`, `notRun: false`, a message that does not start with `NotRun: out-of-scope:` and is not `BC_HTTP_INTERNAL_TEXT`, implied exit 1 |
| `diverged` | anything else |
| `unmeasurable` | no decodable document |

`unlike-bc` is a new defect verdict, and only this fact can read it.
- **In leg C it is `gate-fail`,** with the line "v3 fails as BC does, with another text; #5700".
- **In a NORMAL session it refuses, by name** (`v3ContractRefusals`), as a `diverged` defect fact does under r6.
  "Both fail, only the text differs" is not safe for a user's suite. A test that asserts on `GetLastErrorText`, or
  catches the HTTP error, would get a different verdict from BC's.
- **Only in the update gate's own candidate legs does it WARN instead** (`cfg.candidate`, which only the gate sets).
  - The warning is `al-runner-v3-defect-unlike-bc`. It lets the gate measure every leg.
  - It is printed in EVERY leg's report that ran under it, so the D figures are read knowing this fact diverged. A D
    mutant that touches `HttpClient` shows up in the per-mutant comparison.
  - Leg C is still `gate-fail`, so such a build is never admitted.
- **Red tests, one each way:** a candidate session warns and runs; a non-candidate session is refused, naming the
  fact.

### 3. A new contract fact, `refusal-row-shape-public`, in a new codeunit 50654 with its own call

```al
codeunit 50654 "Probe Refusals Public"
{
    Subtype = Test;

    [Test]
    procedure HttpGetPublic()
    var
        Client: HttpClient;
        Response: HttpResponseMessage;
    begin
        Client.Get('http://example.com/x', Response);
    end;

    [Test]
    procedure LaterFails()
    begin
        Error('later');
    end;
}
```

The call: `<v3> test --output-json --isolation test --package-cache … --bc-version … --no-download --codeunit 50654 <app> <tests>`.

- **`matches`:** `isRefusalRow(HttpGetPublic)`, with the implied exit. The exit is 7 when `LaterFails` is `notRun`,
  and 1 when it is a plain fail.
- **`diverged`:** anything else, including no document. This fact has no `unmeasurable` reading.

**The gate needs no network.** v3 never opens a connection (ADR-027). It refuses `example.com` by its host string
alone, with no DNS lookup (upstream `crates/al-builtins/src/http.rs`). bc1 did not measure `example.com` (ruling E2),
and no rule needs BC's reading of it.

**Drift.** If a later build answers `example.com` instead of refusing it, this fact reads `diverged`. That is the
safe direction, and it needs a new delta.

### 4. `refusal-cascade` (#5610) moves to 50654's call

| Reading | When |
|---|---|
| `defect-present` | `LaterFails` has `notRun: true`, and `isRefusalRow(HttpGetPublic)` |
| `gone` | `LaterFails` has `status: "fail"`, `notRun: false`, message exactly `later`, and `isRefusalRow(HttpGetPublic)` |
| `unmeasurable` | `HttpGetPublic` is not a refusal row, or `LaterFails` has no row |
| `diverged` | anything else |

Codeunit 50653 keeps its `LaterFails` test, but no fact reads that row any more.

### 5. `commit-under-test-isolation` (#5607): a tighter `gone`

| Reading | When |
|---|---|
| `defect-present` | `notRun: true` |
| `gone` | `notRun: false`, AND the message does not start with `NotRun: out-of-scope:` |
| `diverged` | `notRun: false` with that prefix, or anything else |
| `unmeasurable` | no row |

### 6. `duplicate-key-insert-raises` (#5603), with the new defect verdict `refused`

**Codeunit 50655 gains `TestPermissions = Disabled;`.** Its test body is unchanged and is already identical to bc1's
92913, so the pinned BC text is for the same code.

| Reading | When |
|---|---|
| `defect-present` | `DuplicateNamedKey` reads `pass`, `notRun: false` |
| `gone` | `status: "fail"`, `notRun: false`, message `=== BC_END_OF_TEST_TEXT` |
| `refused` | `isRefusalRow`, and the message contains `duplicate-key Insert` |
| `diverged` | anything else |
| `unmeasurable` | no row |

**`refused` means "v3 declines; not BC's reading".**
- In leg C it is `held`, with the line "re-pre-commit".
- It never refuses a session. `v3DefectWarnings` prints `al-runner-v3-defect-refused`.
- It never counts as `gone`: `v3DefectsGone` does not list it, and R586 §7 never counts it.
- On a contract fact or a warn fact, `refused` is `gate-fail`.

### 7. Leg T: a narrow new `held`

A differing row is also `held` when ALL of these hold:
- it is a known row: `os.length === 1` and `b.get(k).length === 1`;
- v3's committed verdict differs from BC's committed verdict;
- the new row is `error` with `errorClass: "runner-refused"` and no killing test;
- neither side is a twin group.

Its line reads "a named refusal: v3 notRun or LethAL §6; not BC's verdict; re-pre-commit". LethAL §6 cannot fire on
leg T, because T's Sleep index is pre-committed at 0 + 0.

Every other move is `gate-fail`. That includes:
- an `error` of class `runner-test-error`;
- a known row that differs from BC only in its killing test;
- a #5603 row that moves anywhere other than to its BC row or to `error`/`runner-refused`.

### 8. The wording of held

`gateOne`'s held log line, `V3LegHeld`'s doc and the gate page say "every difference is a move toward BC or a named
refusal; read the receipt's lines".

## Figures that move

**Leg C: 26 facts, 9 defect, 16 contract and 1 warn.**
- r8 as merged after R-637 had 25 facts (8 defect, 16 contract, 1 warn): `classifyLegC(…, 25, V3_WARN_FACTS)` at
  b2424bc7.
- `refusal-row-shape` moves from contract to defect, and `refusal-row-shape-public` is added.
- `V3_DEFECT_FACTS` gains `refusal-row-shape`, for 9 names.
- Any other count is `gate-fail`.

**K1(a) moves no current figure on alpha.2.** This is inferred.
- The kept regate log (`regate/de8f43e2….gate.log`, alpha.2, all 8 legs pass) shows errors 0 on S1, N1, D1, D1c
  and T. It also shows 0 per-mutant differences from BC (for T, from its own baseline).
- That log does not print the mutant legs' per-test rows, so it cannot prove that no such row exists.
- The direct check: 51 kept v3 outputs (alpha.2, alpha.3, main 93415c0) hold 2913 rows that start
  `NotRun: out-of-scope:`. All 2913 carry `notRun: true`.
- Any figure that moves in the live `--regate` is a BLOCK.

**Cost:** one more one-shot call (50654), about 0.1 s per leg C, inferred.

## Predictions

"Measured" means a run showed it. "Inferred" means it comes from code, release notes or another build.

### A. `--regate <final R-639 head>` on alpha.2 (`alrunner 3.0.0-alpha.2 (91253f2d6)`): `pass` on all eight legs

| Fact or leg | Prediction | Basis |
|---|---|---|
| `refusal-row-shape` | `defect-present` | Measured: the same row read `matches` at de8f43e2 (exit 7, `notRun`, the prefix) |
| `refusal-row-shape-public` | `matches`, exit 7 | **Inferred (M8): new codeunit.** alpha.2 refused every unhandled `HttpClient` call and cascaded (R-586 measure.md row 14) |
| `refusal-cascade` | `defect-present` | **Inferred (M8): moved codeunit** |
| `commit-under-test-isolation` | `defect-present` | Measured |
| `duplicate-key-insert-raises` | `defect-present` | Measured without the property. **Inferred (M8) with `TestPermissions = Disabled`:** v3 has no permission model (R-586 measure.md row 13) |
| the other 21 | as in r8 and R-612 | Measured at de8f43e2, plus r8's and R-612's own measurements |
| S1, N1, X, D1, D1c, T | 3/12/4; 36/0/0; pass; 51/12/0 twice with 0 differences from bc3; 290/57/59 | Measured at de8f43e2; inferred unchanged at the new head, with K1(a) included |

On `pass`, `.gated` takes the new head. Nothing in `failed/` or `held/` moves.

### B. `--edge-rejudge 57f1e4f98` at that head

This runs after A passes. It gates the kept `failed/edge-57f1e4f98@de8f43e2…/al-runner`. Its sha256 is
`0642f9b2…8720`, which equals its receipt, and its version commit is `57f1e4f98`.

**Leg C: `gate-fail`.** That is CORRECT, because the edge row is not BC's reading.

| Fact | Prediction | Basis |
|---|---|---|
| `refusal-row-shape` | **`unlike-bc`, so `gate-fail`** | The edge row is measured (fail, edge's text, exit 1), and BC's text is measured on bc1. They differ (#5700) |
| `duplicate-key-insert-raises` | **`refused`, so held** | The row is measured. `notRun` was cut from the kept files and is inferred true. v3 does not model the property, so it is inferred unchanged |
| the 14 wire and CLI contract facts | `matches` | Measured on edge |
| `dependent-fail-after-timeout-is-notrun` | `matches` | **Inferred, not measured on edge** |
| `serve-keep-reasons` (warn) | not predicted | It never changes the outcome |
| `refusal-row-shape-public` | `matches`, exit 1 | **Inferred** from upstream source and PR #5623 |
| `refusal-cascade` | `gone` | **Inferred**, on the same basis |
| `commit-under-test-isolation` | `defect-present` | The prefix and `error` are measured; `notRun` is inferred true. If it is false, the reading is `diverged`, which refuses sessions too |
| `none-selected-exit`, `quoted-name-unselectable`, `sleep-is-noop`, `upstream-compile-errors` | `gone` | Measured |
| `codeunit-runs-whole` | `defect-present` | Measured |

**The other legs are the first runs of any edge build.**
- The gate's sessions are candidate sessions, so `unlike-bc` only warns there, and the warning is in each leg's
  report.
- `refused` and `gone` do not refuse them.
- A NORMAL session on this build would be refused by `unlike-bc`.

| Leg | Prediction | Basis |
|---|---|---|
| S3 | `pass` | Measured |
| S1 | 3/12/4, 0 differences from bc1 | Inferred |
| N1 | 36/0/0 | Inferred |
| X | (a), (c) `pass`; (b) `held` (exit 3 with AL0118 in `compilationErrors`); (d)-(f) unchanged | Inferred. (d) is the least certain, because a Sleep is now a timeout row on edge |
| **D1, D1c** | **51/12/0 over 63, with 0 differences from bc3-A and bc3-B** | See the notes below the table |
| T | `held` | **Inferred.** See the notes below the table |

Notes on the two longer rows:
- **D1, D1c.** Inferred. These figures are the point of the rejudge: the first CDO figures with PR #5668.
  - If #5668 does not cover the slice, all 63 read `error`, which is a gate-fail.
  - The two duplicate-key kills are raised inside the target on BC, so they are inferred unchanged.
  - The figures are kept in `/coord/handoff/R-639/rejudge/`.
- **T.** Inferred.
  - The arm-K row goes `survived` -> `error`/`runner-refused` under #5623.
  - The other six #5603 rows go to their BC row or to `error`/`runner-refused`.
  - The 41 Commit rows and the 4 TestPage rows are unchanged.
  - Any other move is a gate-fail.

**Overall: `gate-fail`, from leg C.**
- It goes to the NEW key `failed/edge-57f1e4f98@<head>/`, with a copy in `rejudge/edge-57f1e4f98@<head>/`.
- `failed/…@de8f43e2…` is untouched, and `current` does not move.
- The D-leg and T-leg figures are recorded as the first evidence on the new upstream fixes.
- Any difference from the predictions above is reported, never re-recorded.

### C. alpha.3, alpha.4 and later

- r7's predictions stand.
- alpha.4's `refusal-row-shape` and `duplicate-key-insert-raises` read as in B.
- The D legs of alpha.3 and alpha.4 still fail the gate (#5606, #5641).
- A build that adopts BC's text (#5700) reads `refusal-row-shape` as `gone`, which is held.

## Tests (pre-committed, coded after this delta is committed)

These are plan r2 §7 and plan r3, branch F only:
- P1-P13:
  - P9 includes the contract-`refused` case;
  - P12 and P13 cover `unlike-bc`. P12: a candidate session warns and runs, with the warning in the leg's report.
    P13: a non-candidate session is refused, naming the fact.
- T1-T5;
- R1-R10;
- L1-L6;
- K1-a to K1-d.

Each goes red on its own single revert. The red logs go in `/coord/handoff/R-639/red-unit/`.

**P4 is the binding test.** It parses `raw` from each test's `fullFailureText` in the committed `bc1-probe.json`, and
asserts:
- `BC_HTTP_INTERNAL_TEXT` equals 92911's `raw` and 92910's first line (both `fail`);
- `BC_END_OF_TEST_TEXT` equals the first line of 92912's `DuplicateNamedKey`, the first line of 92913 (both `fail`),
  and 92915's `raw`;
- the file names the server, the BC build, LethAL Control, the harness, `testHttpRequestPolicy: "absent"`,
  `testPermissions`, and the removal read-back (absent).
