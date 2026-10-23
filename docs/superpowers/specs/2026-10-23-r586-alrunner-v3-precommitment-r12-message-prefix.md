# R-586 pre-commitment r12 (R667): a contract fact pins that v3's failure message has no `<Type>: ` prefix

Proposed master path: `docs/superpowers/specs/2026-10-23-r586-alrunner-v3-precommitment-r12-message-prefix.md`
(docs/gates/alrunner-v3.md on lethal/r656 already names that path).

The R-656 builder drafted this on 2026-10-23, after the fact was coded on `lethal/r656` and unit-tested against a
fake v3, and BEFORE any live leg-C run. It must be committed to master before any `itest:alrunner-v3` run of a
head that carries the fact, and before any `--regate`.

It is a delta on r11 (`2026-10-22-r586-alrunner-v3-precommitment-r11-xd-sleep5000.md`, 338af789) and the deltas
before it. Everything there stands, except what is below. A differing fact verdict in leg C is still a BLOCK.

## Why

R657 measured (`/coord/handoff/R-657/measure.md`) that v3's failure `message` carries no `<Type>: ` prefix on
alpha.2 (91253f2d6) and edge (57f1e4f98), one-shot and serve, on seven failure shapes. So v3 keeps bcdev's
assertion-screen rule (`screenMessageOf`). The unit tests that pin this use fixed strings. A future v3 build that
writes `{Type}: {Message}` (v2's shape) would leave them green and skew the R553 screen (v2: 51 of 51 kills read
`vacuous`). R667 asks that the live gate catch it by name.

## The new fact

**`message-has-no-type-prefix`**, kind `contract`.

**The probe.**
- Half 1, plain `Error()`: the existing `Fails` row (`Error('boom %1', 5)`) of the existing main call
  (`--verbose --codeunit 50650`). No new call.
- Half 2, `Assert.AreEqual`: one new one-shot call on a new, invented test codeunit in its own tests app (so the
  main probe tests app gains no dependency):

```al
codeunit 50661 "Probe Assert"
{
    Subtype = Test;

    var
        Assert: Codeunit "Library Assert";

    [Test]
    procedure AssertAreEqual()
    begin
        Assert.AreEqual(1, 2, 'R667 values differ');
    end;
}
```

  Its app.json depends on Microsoft `Library Assert` (dd0be2ea-..., 28.0.0.0), ids 50650-50699. The call is
  the probe's usual argv plus `--dep <Library Assert .app> --codeunit 50661`, with the probe target as the
  positional app. Leg C passes the one `Microsoft_Library Assert_*.app` in `fixtures/sandbox-data-tests/.alpackages`
  (28.0.46665.49944, from the pinned symbol tar). Leg C's `packagesDir` is unchanged.

**The reading.**
- `diverged` when either half's message matches `AL_RUNNER_EXCEPTION_PREFIX`
  (`/^(?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*Exception: /`, R553's regex; R654 S3 removed it from assertion-screen.ts
  with v2, and it now lives in `al-runner-v3-contract.ts`). `measured` then starts `prefix "<the prefix>"; `.
- `matches` when both rows are plain fails (`status: "fail"`, no `notRun`) and neither message matches.
- `unmeasurable` otherwise (a row missing, a refusal row, a pass, or leg C given no Library Assert app).

**Its classification** (the existing contract-fact rules, `classifyLegC`): `matches` passes; `diverged` is
`gate-fail` (the contract is broken); `unmeasurable` is `infra-fail`.

**In a session** (`gateOnlyTrusted` set): the Assert half is gate-only, as `timeout-is-cpu` is, because a
user's packages need not hold Library Assert. The session reads half 1 alone: a prefix there still refuses the
session (`v3ContractRefusals`, `status()` is `ok: false` before any mutant runs), as every diverged contract fact
does. No extra call in a session. Its `measured` says the Assert half was not re-measured, and that a `.gated`
recorded before r12 never read it (as `serve-keep-reasons` words a `.gated` from before R612), never "trusted".

**Why a session refuses, not only warns: a false kill.** The prefix is not only a report-figure skew of the R553
screen. `v3RowVerdict`'s K1(a) guard recognises v3's not-trusted refusal by `startsWith(V3_REFUSAL_PREFIX)`
(`NotRun: out-of-scope:`). A build that writes `SomeException: NotRun: out-of-scope: ...` as a plain `fail` would
slip past it, and the row would score as a KILL. The refusal text names this reason
(`MESSAGE_PREFIX_REASON`): "a `<Type>:` prefix would hide v3's not-trusted refusal from the K1(a) guard ...".

## Expected readings

| build | `message-has-no-type-prefix` |
|---|---|
| alpha.2 (91253f2d6, `current`) | `matches` |
| edge 3.0.0-alpha.4+edge.20261022 (57f1e4f98) | `matches` |

Basis (partly INFERRED):
- MEASURED by R657, byte-identical on both builds: its own `PlainError` test gave its `Error()` text with no
  prefix, and its `Assert.AreEqual(1, 2, ...)` gave `Assert.AreEqual failed. Expected:<1> (Integer). Actual:<2>
  (Integer). <text>`.
- INFERRED: that the probe's `Fails` row reads `boom 5` with no prefix. R657 measured `PlainError`, not `Fails`
  (the fake v3 in the unit tests answers `boom 5`).
- INFERRED for edge: the exact codeunit 50661 above was run offline on alpha.2 only (2026-10-23, R-656 builder,
  one-shot, `--dep` Library Assert): `status: "fail"`, the Assert text above, no prefix. Not run on edge.

## New counts

- Leg C: **27 facts** (was 26): **9 defect, 17 contract, 1 warn**. `V3_LEG_C_FACTS = 27`. A run with 26 facts
  is `gate-fail`.
- `V3_DEFECT_FACTS` and `V3_WARN_FACTS` are unchanged.
- Leg C's cost: one extra one-shot call (about 0.5 s on alpha.2).

## Live runs (R-656, on its final head)

- **Code:** `lethal/r656` at **a6233dfb**. Every run checks this sha and a clean tree. If master moves, an
  addendum names the new head.
- **Run 1, on `current` (alpha.2):** `LETHAL_ITEST_ALRUNNER_V3=1 LETHAL_ITEST_V3_LEGS=C bun run itest:alrunner-v3`.
  Leg C must PASS with 27 facts, and `message-has-no-type-prefix` must read `matches`.
- **Run 2, on edge (57f1e4f98):** the same command, plus `LETHAL_ALRUNNER_V3_CANDIDATE=1` and
  `LETHAL_ALRUNNER_V3_PATH=<edge>`. The new fact must read `matches`. Leg C's other facts keep their known edge
  readings (`refusal-row-shape` = `unlike-bc`, #5700, which is gate-fail in leg C as today). Only the new fact's
  reading is judged.
- **Stop:** the new fact reading anything other than `matches` on either build, or leg C's count not being 27.

## What does not move

No other fact, leg, figure, Sleep index size, refusal set or baseline. No session verdict changes on alpha.2 or
edge (the fact reads `matches` there).
