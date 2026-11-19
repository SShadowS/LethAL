# PR-233 pre-commitment: leg O1's corpus set on builds that refuse row inserts after a partner login (al-runner f9116dc96)

Lane lethal-bugs, coord PR-233, 2026-11-19. Ruling: the orchestrator's (2026-11-19, the "reshape"). It is committed before any
code. The build merges AFTER PR-209 (both edit the v3 itest tables).

## What is known (measured)
- **The change upstream.** al-runner f9116dc96 (#8149; alrunner's bisect, posted on #8239 2026-11-19 16:37Z) deleted the
  assumption `partner-login-subscriber-in-test-session`. Since then, a SingleInstance codeunit that a partner app's
  `OnAfterLogin` subscriber changed is marked unmeasured unless it has the one pinned shape, and a read of its globals is
  refused. A partner `IsSaaS()` fills System Application's "Server Setting Impl.", which is always marked. With Base Application,
  a row insert reads it (database trigger setup), so the insert is refused.
- **O1 on plain upstream 0e6397742** (leg O1 only, gateOne's candidate env, `/coord/handoff/PR-233/o1-base/gate.log`):
  - own set: pass;
  - corpus set (18 package apps): every R entry passes as today. In EVERY W entry (W1.0, W2.1, W3.0, W3.2) exactly
    `InsertRow` and `InsertDepRow` are refused; the other six W tests pass. In EVERY C entry (C5.0, C6.1, C7.0, C7.2) exactly
    `CommitLocalRow` and `CommitDepRow` are refused; the other four pass as today. So exactly the 4 tests that insert a row,
    in all 8 W and C entries, with this one text (status `error`, `notRun`):

    `NotRun: out-of-scope: a read of a global of SingleInstance codeunit Server Setting Impl.: OnAfterLogin raised to the login subscribers of the partner dependency apps changed it before the first test, and it is not the one codeunit of the one subscriber's app with the measured globals (two Integer, a List of [Text], a Text): what BC leaves there is not pinned`
  - perf-combined 2bb4b686 gives the same (`/coord/handoff/PR-217/gate/`).
- **BC's answer** (BC 29 W1, bc4, an invented two-app probe; posted on #8239, issuecomment-7014017475): the partner login runs
  once, before the first test, in the test's own session. The memo values it leaves are those the test computes itself, and a
  plain row insert works. So the refusal is a fail-closed coverage loss, **not** a move toward BC. It is tracked on #8239.
  Upstream's planned probe (P2) would let these reads run with BC's value.
- **DO itself hits none of it.** Upstream main c5861dcd9 contains f9116dc96 (checked by `git merge-base --is-ancestor`). PR-223's
  "before" leg ran 90 DO mutants on it: 519 test rows, 0 refusal messages, verdicts equal to y2.

## The change (itest tables and judge only; no product code)
1. **A pin field.** `V3BuildPin.o1.partnerLoginRefusal?: { text, issue, evidence }`. It is set only on a hand pin for a build
   whose own gate run shows the refusal above. It never says "correct": its `issue` is #8239, and its doc comment calls it a
   known coverage loss.
2. **`judgeOrderProbe`, corpus set only, when the active pin has the field:** for each W entry, `InsertRow` and `InsertDepRow`
   must be status `error` with message EXACTLY `text`; for each C entry, `CommitLocalRow` and `CommitDepRow` the same. Every
   other test of those entries is judged exactly as today (W: pass; C: by `commitRuns`), and every R entry as today. Any
   other status or text on those 4 tests, any refusal on another test, or a PASS on one of the 4 is a gate-fail by name. A pass
   means upstream changed again, so re-pre-commit.
3. **Without the field** (every pin today, and `current`'s): if a corpus-set W or C failure is EXACTLY these 4 tests with EXACTLY
   this text and nothing else differs, the set's outcome is **held** (a named refusal: the update gate puts the build in
   `held/`, never `failed/`), with one line naming #8239 and "re-pre-commit with `o1.partnerLoginRefusal`". Any other
   difference stays a gate-fail as today. So the first edge carrying f9116dc96 stops once for a hand pin; later builds that
   inherit that pin's readings pass with no person.
4. **The own set and every other leg:** unchanged.
5. **Log:** O1's per-request line also prints W rows (`test=status`), as the measurement above needed.

## Red tests (both ways, each by mutation)
- With the field: the measured answer passes. Each of these is a gate-fail by name: one of the 4 passes; a 5th test is refused
  with the text; the text differs by one character; an R entry reads a writer value.
- Without the field: the measured answer is held (not gate-fail, not pass), and a 5th refused test makes it a gate-fail.
- The own set ignores the field.
- `current`'s pin (edge-d72d3197d readings) is unchanged, so the full v3 gate on `current` still passes.

## Predictions for the landing
- The full v3 gate (`LETHAL_ITEST_ALRUNNER_V3=1`, `LETHAL_ITEST_V3_CDO`, `LETHAL_ITEST_V3_TABLES`) on `current` edge-4ebfe7913:
  PASS, every leg as today.
- Leg O1 on plain 0e6397742 with candidate env and `LETHAL_V3_PIN_FROM=edge-d72d3197d`: **held** (not gate-fail), with the #8239
  line.
- No pin entry is added in this landing: a hand pin is pre-committed per build, when the daily update holds one.

## Consequences
- The daily update stops the first edge carrying f9116dc96 as held. A hand pin with `o1.partnerLoginRefusal` (pre-committed)
  then lets `current` move past edge-4ebfe7913 legitimately.
- PERF-10 can be gated privately through PR-226 the same way. Every mutant whose covering tests hit this refusal is set aside in
  verdict AND speed, with the count reported (expected about 0 on DO, by the c5861dcd9 evidence).
- **A roadmap item** (filed with this commit) restores the old expectation when upstream's P2 lands. We would value P2, and alrunner
  is told so in PR-233's result.
