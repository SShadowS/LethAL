# R220: enabling al-runner coverage — prediction, written BEFORE the gate runs

`itest:alrunner` is frozen at **3 killed / 16 survived / 0 no-coverage** over 19 mutants. Wiring
al-runner's `--coverage` into the backend changes what that gate measures, so the expected result is
written here first and the run either matches it or the change is wrong. Recorded the way [[R136]],
[[R134]], [[R161]] and [[R171]] recorded theirs: a matching TOTAL proves nothing on its own, so the
prediction is per mutant.

## The prediction

**3 killed / 12 survived / 4 no-coverage.** Exactly four verdicts move, all `survived` to
`no-coverage`, and they are the four mutants in `SandboxPricing.Codeunit.al`:

| mutant | file:line | operator | today | predicted |
| --- | --- | --- | --- | --- |
| M0016 | `src\SandboxPricing.Codeunit.al:4` | `lethal.empty-block` | survived | **no-coverage** |
| M0017 | `src\SandboxPricing.Codeunit.al:5` | `lethal.conditional-boundary` | survived | **no-coverage** |
| M0018 | `src\SandboxPricing.Codeunit.al:7` | `lethal.return-value` | survived | **no-coverage** |
| M0019 | `src\SandboxPricing.Codeunit.al:7` | `lethal.swap-additive` | survived | **no-coverage** |

**Every other verdict is unchanged**, including all three kills (M0001, M0002, M0003) and the twelve
survivors in `SandboxLogic.Codeunit.al` (M0004 to M0015).

## Why those four and no others

Measured before any code was written, al-runner's own coverage on this fixture:

```text
al-runner --coverage --coverage-out cov.xml fixtures/sandbox-app fixtures/sandbox-tests
  SandboxLogic.Codeunit.al     line-rate 0.8571
  SandboxPricing.Codeunit.al   line-rate 0.0000     <- every line hits="0"
  SandboxTests.Codeunit.al     line-rate 0.6250
```

`SandboxPricing` is reached by no test, which is why `itest:bcdev` — the authoritative gate, which
has always had coverage — reports exactly those four as `no-coverage` in its frozen
**3 / 12 / 4**. So this prediction is not a guess about what coverage will say; it is the claim that
al-runner's coverage agrees with bcdev's, and the two frozen baselines becoming IDENTICAL is the
result worth having.

`SandboxLogic` is covered but at `line-rate 0.8571`, so it has an unhit line. That must NOT produce a
no-coverage verdict for any mutant on it: the twelve survivors there are survivors because the tests
run and do not catch the mutation, which is a different fact from never running.

## What would falsify it

- **Any of M0001 to M0015 moving.** A kill becoming `no-coverage` would mean the covering test was
  filtered away, i.e. the coverage says a test does not reach code it demonstrably kills a mutant in.
- **Fewer than four moving.** Coverage attributed a line to `SandboxPricing` that was never hit,
  which is [[R63]]'s manufactured coverage.
- **More than four moving.** Attribution is losing real coverage, most likely a member key that does
  not resolve, and the `procedure`-level entries would be to blame.
- **`coverageAttribution` reporting `object` for a non-trigger mutant.** On this path members are
  resolved by parsing the source through `line-map.ts`, so an object-level fallback means the line
  map failed to place a line and the widening hid it.

## What this does NOT claim

`authoritative` stays **false**. [[R183]] holds it false for two reasons and this addresses one.
The other — `Codeunit.Run` not scoping a write transaction — is unmeasured on 2.11.0 beyond the
canary's note that it may have closed, and flipping the flag on half the evidence is the kind of
claim this file exists to prevent.
