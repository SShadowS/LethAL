# PR-109 pre-commitment: a hang refusal for `remove-not` on `while not S.EOS` when S is read before the loop

Coord PR-109 (lethal-code, 2026-11-17). Found by PR-108's analysis (`/coord/handoff/PR-108/analysis.md` §4). Method: PR-44's
(`docs/superpowers/specs/2026-11-16-pr44-t5-hang-shapes.md`), unchanged. Invented AL only in anything committed.

## The shape
- **The two DO hangs.** DO t13's M36641 (`ReadAsText`, hung in 19 of 22 covering tests, about 1,981 s) and M25653 (`GetEMail`,
  timeout-killed, 60 s) are both `lethal.remove-not` on the exit of `while not S.EOS do`, where:
  - S is an InStream the procedure READS once before the loop (a straight-line `S.ReadText(...)` / `S.Read(...)`);
  - the body reads S again.
- **Why removing the `not` hangs.** The loop then runs while S is at its end. After the pre-read of a short stream it IS at its
  end, and reading at the end never moves it, so the loop never exits.
- **What R173 ruled.** R173 ruled this `remove-not` safe because "EOS is false at the start". That holds only with no
  pre-read.
- **DO's numbers.** DO has 11 `remove-not` sites on an EOS exit. The scored ones with a pre-read are ReadAsText
  (timeout-killed), GetEMail (timeout-killed) and ReadStreamToString (killed): 2 hangs of 3. The scored one without a pre-read
  was an error.

## The rule (`packages/builtin-tier1/src/loop-hazard.ts`, as PR-44's rules)
`lethal.remove-not` is hang-refused when ALL of these hold:
- the `not` is the whole condition of a `while` loop, and its operand is `S.EOS` or `S.EOS()` on a plain name S;
- S is declared as `InStream` in the procedure: a local or a parameter;
- in the same procedure, BEFORE the loop statement and in straight-line code (not inside another loop or a branch that may be
  skipped), there is a call `S.Read(...)` or `S.ReadText(...)`.

Everything else keeps today's R173 ruling:
- a `while not S.EOS` with no pre-read;
- a pre-read only inside an `if`;
- an EOS of a member or call (`X.S.EOS`, `GetStream().EOS`);
- `until S.EOS`, which has no `not` to remove;
- a `not` combined with `and` or `or`.

## Acceptance (measured before the build lands)
- **The runs.** A dry-run of the corpus (72 BC.History modules) and of DO, before and after, on the PR's head. "Before" is
  re-run on that head, because PR-48/50/53 changed the rules since PR-44's run.
- **The classification.** Each removed site is classified against the stored verdicts (DO: t13's report, with t12's or
  earlier's for sites t13 never reached; the corpus: PR-37's stored verdicts, as PR-44 did), with timeout-killed counted as a
  hang.
- **The bar.** The rule is kept only if its hang rate is at least PR-37's: 1 hang per 8 scored sites lost, corpus and DO
  together.

## Predictions (pre-committed)
- **P1, DO.** DO loses the sites of ReadAsText, GetEMail and ReadStreamToString, and possibly others the diff lists: at least 2
  hangs per 3 scored. The rule's no-pre-read EOS sites stay.
- **P2, the corpus.** The corpus loses few or no sites. With fewer than 3 corpus sites removed, the combined rate is above the
  bar.
- **P3, fixtures.** The dry-run of every `fixtures/*` project is unchanged, or each moved site is named before any gate. A moved
  emit golden needs the orchestrator's ruling. `itest:alrunner-v3` and `itest:hang` pass unchanged.
- **P4, DO windows.** From the next DO window on a head with PR-109, those sites are not mutated: no timeout close comes from
  them. The moved DO sites are sent to lethal-bugs before that window, because its baseline reuse depends on the mutation set.
- **Unit tests, each red when its condition is reverted:**
  - refused:
    - `while not S.EOS do S.ReadText(T);` with `S.ReadText(T);` before it;
    - the same with `S.Read(B)`, and with `S.EOS()`;
    - S as a parameter;
  - kept:
    - no pre-read;
    - a pre-read inside an `if`;
    - a pre-read inside another loop;
    - a pre-read of another stream;
    - S not an InStream;
    - `not (S.EOS and X)`;
    - `until S.EOS`.

## Addendum 1 (2026-11-17, the build's measurement; before any gate)
**"Straight-line before the loop" means: a statement of a block that also contains the loop, ending before the loop starts.**
- **Why the change.** Read as "a statement of the procedure's own block", the rule removed only ReadStreamToString and left both
  hangs mutated. In ReadAsText and GetEMail, the pre-read and the loop sit together inside one `if ... then begin ... end`.
- **The condition kept.** The loop can never run without the read before it.
- **Still kept (not refused):**
  - a read inside an `if` or loop that the `while` is not inside;
  - a read in the other branch;
  - a read after the loop.
- **Not applicable.** `until S.EOS` has no `not`. The test uses `until not S.EOS`, a repeat and so not refused.

**Measured** (`/coord/handoff/PR-109/measure.md`; dry-runs before and after on this head):

| target | sites before | after | removed |
|---|---|---|---|
| corpus (72 BC.History modules) | — | byte-identical | 0 |
| DO | 45021 | 45014 | 7 |
| 15 `fixtures/*` targets | — | byte-identical | 0 (no emit golden moves) |

- **The 7 DO sites, t13 verdicts.** All are `lethal.remove-not`:
  - `GetEMail` (M25653) and `ReadAsText` (M36641): timeout-killed;
  - `ReadStreamToString` (M36508): killed;
  - 4 sibling `GetEMail`-style procedures: no-coverage.
- **The bar.** 2 hangs per 3 scored sites lost, far above PR-37's 1 per 8. **Kept.**
- **What stays mutated.** The 4 EOS sites with no pre-read or no loop.
- **P1-P3 held** (P3's gates follow on the final head). P4 waits for a DO window. The 7 sites go to lethal-bugs before it.
