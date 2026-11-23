# PR-301 pre-commitment: a removed step amount set before the loop is hang-refused; an overrun quarantine names the stop (GitHub #52)

Status: pre-commitment (coord PR-301, lethal-preproc, 2026-11-21), after the spec-adversary and the Opus build review
(both: no BLOCK, every finding applied and red-checked), before the gates. Branch `lethal/pr-301`. Evidence:
`/coord/handoff/PR-301/`. Invented AL only in anything committed.

## The report (#52)
LethAL 0.1.0-alpha.3 (build 3e4bc253), bcdev, BC 28.
- **The hang:** `remove-assignment` of `Chunk := MaxStrLen(...)` before `while Remaining <> '' do ... if StrLen(Remaining)
  > Chunk then Remaining := CopyStr(Remaining, Chunk + 1) else Remaining := '' ...`. With `Chunk` at 0 the step leaves
  `Remaining` unchanged and the else cannot run, so the loop never ends. The hang screen tagged 0 of the run's 17 mutants.
- **The quarantine:** the test overran its 180,000 ms budget and LethAL quarantined the tier ("returned no readable
  result ... container may be stranded"). 12 of 17 mutants never ran.

## Part 1: the rule (`loop-hazard.ts`, `stepStalls`, inside R1061's rule B `removedBoundHangs`)
Rule B refuses `remove-assignment` of `X := v` before a loop of the same block only when the loop's EXIT reads X. It now
also refuses it when X (or a PR-50 E same-typed local copy of X) is the AMOUNT of a step on the only name that moves the
exit. All must hold; unknown keeps the mutant (R1061):
1. The condition names no cursor method, and calls nothing but pure built-ins (`StrLen`, `MaxStrLen`, `CopyStr`, `DelStr`,
   `StrPos`, `LowerCase`, `UpperCase`, `Abs`): a call such as `Budget()` may end the loop itself.
2. A body assignment to a plain name T that the exit parts read (`loopExitParts`: condition, guards, feeds; called-function
   names are not values) is the identity at X = 0: `T += X`, `T -= X`, `T := T + X`, `T := X + T`, `T := T - X`,
   `T := CopyStr(T, X + 1)`, `T := CopyStr(T, X + 1, Len)` (not when the condition calls `StrLen`: the first cut can meet
   such an exit), `T := DelStr(T, 1, X)`. `1 + X` is accepted. `T.Substring(X + 1)` is not read: its base is unmeasured.
3. Every other body write to T sits under an `if` whose condition is exactly `StrLen(T) > X` or `X < StrLen(T)` (at X = 0
   true for every T <> '', so its else never runs). No call in the body may write T (R1061's same-object chain,
   event-publisher and outside-call checks: R830's blind spot).
4. Every body write to another exit name is an assignment whose value reads T (`Done := T = ''`), and no call may write one.
5. Rule B's own conditions: X an integer local or same-object global, not a parameter or field; the removed value is not
   X's default; plain `:=`; nothing in the loop writes X; the loop has no break or exit; straight-line in the same block.
6. Given back (PR-50 W) only when the earlier literal that stays is above 0 (a negative amount walks the wrong way).

Named limits: X set inside an `if` before the loop, or in another trigger (OnInit); the step through `Substring`;
arguments wrapped in brackets (`CopyStr(T, (X + 1))`), which keep the mutant.

## Part 2: the quarantine (`orchestrator.ts`, `classifyNonVerdictStep`)
- **Cause (code reading):** `--stop-hung-sessions` is off by default (R053; owner ruling R1064, because the stop ends a
  session on the user's server). With it off, at the budget the transport abandons its request (`deadline-exceeded`,
  `in-flight-unknown`), the server cannot confirm completion, and the tier is quarantined with the reporter's note. With
  it on, BC ends the session (408) and the mutant scores `timeout-killed`, as the reporter saw on an earlier build. The
  `RenewLease` 409s only log a warning on this path.
- **The change:** on a budget overrun in a session that ran WITHOUT the stop, the quarantine note and the persisted record
  also say that `--stop-hung-sessions` (or `bcdev.stopHungSessions: true`, which an envTool config ignores) lets LethAL end
  the hung session and score it `timeout-killed`, and that it is off unless the server's owner turns it on. The setting is
  threaded `cfg` -> `BatchScope` -> `RunMutantsArgs` -> every `classifyNonVerdictStep` call of a mutant run, the replay,
  confirm and reproduction paths included. With the stop on, inside the budget, or where the setting is unknown (named
  mutants), the note says nothing about it. Nothing parses this text.
- **Not changed:** the default. PR-301's result says whether R1064 should be revisited; the ruling is the orchestrator's
  or the owner's.

## Measured (production identity keys, `scripts/corpus-snapshot.ts diff`, against master d9261d1ed, branch head 02cdb866b)
Evidence: `/coord/handoff/PR-301/final-diff-<set>.txt`, `corpus4.log`.
| set | removed | added | tuples moved | ordinals moved |
|---|---|---|---|---|
| fixtures (31 projects) | 1 (`sandbox-optin` `OptinLogic.Codeunit.al`, `remove-assignment`) | 0 | 0 | 0 |
| CDO (6) | 0 | 0 | 0 | 0 |
| DC (14) | 0 | 0 | 0 | 0 |
| DO (7) | 0 | 0 | 0 | 0 |
| BC.History (519) | 5 (3 distinct files, `remove-assignment`) | 0 | 0 | 0 |

- **Every removed site is a real hang, read by eye:**
  - fixture: `Len := Step; while I < 10 do I += Len;` (`SpinCopy`, which no test calls);
  - BC.History `PhysInvtCountManagement` (BaseApp): a period length (`Days`) set before a date loop that steps a start
    date by it;
  - BC.History `GuidedExperienceItemCleanup` (System Application, and again in its Guided Experience module folder): a
    batch size set before `while i < MaxVersion` that steps `i` by it. At 0 it also commits on every pass;
  - BC.History `Base64ConvertTest` (System Application Test, and again in its module folder): a line length set before a
    line-splitting loop that steps an index by it.
- **Identity scheme:** no bump. No tuple and no ordinal moves in any set.
- **Fixture records (moved on the orchestrator's ruling):** `instrumented-output-golden.json`, one entry (OptinLogic,
  126 -> 125 mutants, new sha256); `reach-grain-golden.json` re-recorded byte-identical.
- **Gates:** `itest:alrunner-v3` leg DBM: `DBM_FIGURES` 125 sites (was 126), killed 17, survived 5, no-coverage 103 (was
  104); per-mutant agreement between the two sessions and `GATE_WARNINGS` unchanged. No other itest reads `sandbox-optin`,
  and no other fixture site moves, so every other gate's figures hold exactly. One unit snapshot moves
  (`orchestrator.test.ts.snap`, C02-04 case 5: the appended hint). Any other difference is a BLOCK.

## Tests (each red when its named guard is reverted, checked one by one)
`pr301-step-amount.test.ts` (22): the #52 shape, with a local call, a List Add and a record `Insert(true)` in the body;
`+=`, `:= +` with `repeat`, `DelStr`, the three-argument `CopyStr`, a local copy, `Done := T = ''`; given back at 3, not at
-1. Controls: the same loop's other writes, `Chunk := 0`, a loop that writes Chunk, another operator, a step on a name the
exit does not read, `CopyStr(T, X + 2)`, another moving exit name, a cursor, an else under an X-only guard, a same-object
writer of T, a defensive `(X = 0) or ...` guard, an impure condition call, a three-argument cut under a `StrLen` exit.
`orchestrator.test.ts`: an overrun with the stop off names it; with the stop on, and a fast failure, it does not.
