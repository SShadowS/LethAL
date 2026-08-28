# al-runner vs a real BC container: a designed parity probe, predictions committed first

Written BEFORE either run. Nothing above the OUTCOME line is edited afterwards.

## Why this shape rather than "run the whole fixture"

The obvious experiment — run all 345 table-fixture mutants through al-runner and diff against
`itest:tables` — was STARTED and ABANDONED, and the reason is itself a finding worth reporting
upstream.

al-runner reports no per-procedure coverage, so `AlRunnerBackend.capabilities()` declares
`coverage: "none"` and LethAL must run **every mutant against every green test** until one kills it.
On this fixture that is 345 mutants x 62 tests, roughly **13,000 CLI invocations at ~1.3 s each,
about five hours**. Against bcdev, coverage narrows the same run to the covering tests only.

**That is the single most valuable feature request in this document**, and it is not a correctness
complaint: if al-runner could emit which procedures each test executed, a mutation run against it
would collapse by more than an order of magnitude.

## The design: one predicted DIVERGENCE, one predicted AGREEMENT

Fishing for differences across 345 mutants would find some and prove nothing about why. Two operators
are chosen instead because each tests a specific, stated claim.

### A. `lethal.remove-commit` — predicted to DIVERGE

Upstream `docs/limitations.md` (v2.0.0.0 checkout) states plainly: *"There is one flat, in-memory
record store shared across the entire test run. `Commit()` and `Rollback()` are no-ops."*

If `Commit()` does nothing, then DELETING a `Commit()` changes nothing, so the mutant is equivalent
by construction on al-runner and cannot be killed. bcdev's committed baseline:

| mutant | bcdev |
| --- | --- |
| `Data Commit Ops.CommitThenFail` | **killed** |
| `Data Commit Ops.CommitThenRun` | survived |
| `Data Commit Ops.CommitThenRunValueForm` | **killed** |

**PREDICTION: all three `survived` on al-runner — the two kills flip.** This is a divergence that is
CORRECT for al-runner to have. It is a documented architectural limit doing exactly what the document
says, and confirming it is the point: it turns a README sentence into a measured verdict difference.

If instead a kill survives the crossing, upstream's own limitation note is understated somewhere.

### B. `lethal.flip-filter-literal` — predicted to AGREE 6/6

This operator mutates a FILTER STRING that BC re-parses at runtime (`SetFilter('<>0')` and friends) —
the only operator LethAL ships that mutates something the AL compiler never sees. It needs no service
tier, no transactions and no company: it is pure filter-expression semantics, which a process-hosted
runner should reproduce exactly. bcdev's committed baseline:

| mutant | bcdev |
| --- | --- |
| `Data Filter Ops.AnyExcluding` | survived |
| `Data Filter Ops.CountDecoyOrTarget` | killed |
| `Data Filter Ops.CountExcluding` | killed |
| `Data Filter Ops.CountBelowThresholdSparse` | survived |
| `Data Filter Ops.CountBelowThreshold` | killed |
| `Data Filter Ops.CountUpToBound` | killed |

**PREDICTION: all six identical.** The mix of 4 killed and 2 survived is what makes this a real test
rather than a formality — an al-runner that killed everything, or nothing, would be caught. The two
survivors are the discriminating half: they require the filter engine to agree about which rows do
NOT match, not merely that filtering happens.

## What a difference would mean, stated before seeing one

- **A in the predicted direction** confirms upstream's stated limit and tells LethAL users precisely
  which mutation class is unmeasurable offline.
- **B diverging at all** is a genuine, actionable al-runner bug with a minimal reproducer, and the
  arm names the exact predicted row count in its own `Error(...)` text, so the failure text says what
  the filter returned.
- **Any mutant scoring `error`** on al-runner and a verdict on bcdev is a third outcome and would
  mean the instrumented AL does not run there at all, which is neither of the above.

## Scope, stated so nothing is over-claimed

Nine mutants on one fixture. This says nothing about the other 336, and nothing about the
architectural limits LethAL's fixtures deliberately do not exercise (permissions, company context,
base-app data, parallel sessions). Where upstream documents a limit and LethAL has no arm for it,
LethAL has NO independent evidence — neither confirming nor contradicting.

---

## OUTCOME, appended after both runs. Nothing above is edited.

**Both experiments ran. B matched exactly; A did not, and the miss is the most interesting result.**

### B — `flip-filter-literal`: 6/6, prediction confirmed

| procedure | bcdev | al-runner 2.7.0.0 |
| --- | --- | --- |
| `AnyExcluding` | survived | survived |
| `CountBelowThreshold` | killed | killed |
| `CountBelowThresholdSparse` | survived | survived |
| `CountDecoyOrTarget` | killed | killed |
| `CountExcluding` | killed | killed |
| `CountUpToBound` | killed | killed |

Filter-expression semantics reproduce EXACTLY, including which two survive — the discriminating half,
since those require agreeing about which rows do NOT match.

### A — `remove-commit`: 2/3, and the prediction was wrong in al-runner's favour

| procedure | bcdev | al-runner 2.7.0.0 | |
| --- | --- | --- | --- |
| `CommitThenFail` | killed | **killed** | prediction WRONG |
| `CommitThenRun` | survived | survived | |
| `CommitThenRunValueForm` | killed | **survived** | the divergence |

The prediction was that all three survive, because upstream's `docs/limitations.md` (v2.0.0.0 checkout)
says `Commit()` and `Rollback()` are no-ops. `CommitThenFail` was KILLED, with al-runner's own message:

```
NavNCLDialogException: expected the row committed before the error to survive it, but it is gone
```

Removing the `Commit()` made the row vanish when the error fired, which is BC's behaviour. **So
error-rollback IS modelled on 2.7.0 and that limitations note is out of date.** The residual gap is
narrower and more specific than the doc implies: only `CommitThenRunValueForm` diverges — R72's arm,
`Codeunit.Run` with its return value CONSUMED, which on real BC is the factor that decides the
write-transaction refusal. That transaction boundary around `Codeunit.Run` is what al-runner does not
reproduce.

This also means LethAL's own `authoritative: false` justification is partly stale: it cites
"`Commit()`/`Rollback()` are no-ops" as current fact, and that is measurably no longer the whole
story.

### A correction to a finding this probe made an hour earlier

Running the fixture through al-runner directly showed FIVE failing tests, and
`NegationFlipChangesTheCount` was read as a filter bug (`expected 2 rows other than FILT-A1, got 19`).
**That was wrong.** Under `--isolation test` it PASSES:

```
default (--isolation codeunit) : 61 tests, 5 fail
--isolation test               : 61 tests, 4 fail   <- NegationFlipChangesTheCount passes
```

It is record-store contamination, not filter semantics — earlier tests in the same codeunit leave
rows behind and the count sees 19 instead of 2. Experiment B agreeing 6/6 is the independent
confirmation that filtering itself is correct.

**That is still a real divergence, just a different one:** BC's `Isol. Codeunit` (130450) rolls the
database back between tests within a codeunit; al-runner's same-named DEFAULT mode does not. A suite
ported from BC hits order-dependent false failures. LethAL never sees it because it runs one test per
invocation.

### The failures that remain under `--isolation test`

Three of the four are one bug: every test calling Microsoft's `Library Assert` dies with

```
NavNCLMissingMethodException: Function ID -1626256597 was called.
The object with ID 0 does not have a member with that ID.
```

because the library never compiled — `[dep-load-fail] Microsoft_Library Assert: EMIT-ZERO`.
`--precompile` with `BCCOMPILER_DIAG=1` names three independent causes, recorded in the artifact
handed to upstream. The fourth, `PageActionComputesNonZero`, opens a `TestPage` and fails on bcdev
too, so it is not a divergence.
