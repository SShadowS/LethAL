# Next-session prompt — R79, then the R69 go/no-go, then R70

Paste/load this as the opening instruction of a fresh session.

---

Continue LethAL execution. Work autonomously; only stop to ask when a decision is genuinely mine
(a product call, or a hard-to-reverse / shared-infra action beyond what is authorised below).

## Read first (in order)

- `docs/superpowers/plans/2026-08-02-r79-then-r69-decision-then-r70.md` — the plan. Three phases, in
  that order, and the reasoning for the order. Follow it.
- `ROADMAP.md` rows **R79, R69, R74, R75, R76, R77, R78, R70** — the durable record. R69's row is
  very long; read it, because most of what looks like an obvious idea there has already been tried
  and refuted, usually by measurement.
- `CLAUDE.md` — build/test loop (the dist trap is real and bites every session), conventions, gate
  commands.

## State as of 2026-08-02 (master, pushed through `4e3a1d1`; later commits local)

- **Shipped and live:** `describeTestPageUnsupported` names the `CreateNavTestService` refusal in the
  report. Verified end-to-end on a real fixture case, not just unit tests.
- **Built but deliberately UNWIRED:** the client-services routed path (`batch-transport.ts`,
  `testpage-router.ts`, control-app objects 71011-71014, LethAL Control **1.0.0.13** on Cronus281 and
  Cronus283). Behind a tripwire that throws unless a caller names R74/R75.
- **Frozen gates:** `itest:bcdev` 3/10/3 · `itest:alrunner` 3/13/0 · `itest:envtool` 3/10/3 ·
  `itest:tables` **69/9/9 over 87** (96 raw) with **exactly one expected baseline failure**,
  `Data Tests.PageActionComputesNonZero`.
- A per-mutant baseline guard (`tables.baseline.json`) will refuse any changed verdict. Trust it.

## FIRST — R79, and do it before anything else

A comment containing `codeunit <id> "Name"` silently deletes every `[Test]` after it from discovery.
Found by accident: source had 22 tests, `discoverTests` returned 21, the missing one was simply
absent — baseline green, no caveats, empty `unsupportedTests`, and its three mutants reported
`no-coverage`. **A dropped test is indistinguishable from one that never existed.**

Plan Phase 1 has the tasks. TDD, and note task 1.6: `fixtures/sandbox-data-tests/src/DataTests.Codeunit.al`
currently carries a DEFENSIVELY REWORDED comment to dodge this bug — restore the natural wording once
fixed, because a fixture should not have to work around a bug we have closed.

## THEN — the R69 go/no-go. Produce ONE number, and pre-commit the threshold BEFORE measuring.

Count the **mutants covered exclusively by TestPage tests** on the available Document Output corpus
(`/u/Git/DO`), under `coverageMode: "procedure"` so the baseline survives.

Every earlier sizing figure was in the wrong unit or unreproducible — "9 of 104 test files" cannot be
reproduced against any checkout on this machine, and "18% of tests" says nothing about worth. This
number is the only thing that justifies continuing, and the threshold must be written into
`ROADMAP.md` before it is known. This row has produced FIVE retracted over-generalisations in two
days; the pre-commitment is the countermeasure, so honour it either way.

Above threshold → R74/R75 (plain discards, ~30 lines), then R78 (the router keys on the wrong
event), then wire and prove it on the fixture: `Data Value Card` / `Data Value Source`'s three
mutants must flip from `no-coverage` to scored, tagged `runner: "client-services"`.

Below threshold → close R69 as "named, not recovered; recovery measured unprofitable", DELETE the
routed path and control-app objects 71011-71014, KEEP `testpage-unsupported.ts` and the fixture.

## THEN — R70, which has been waiting two days and is the dangerous one

`buildSymbolTable` keys scope on the bare object name, so `page "CDO Setup"` overwrites
`table "CDO Setup"` — 13 such collisions on Document Output, 12 page+table. Direction is UNSAFE: a
receiver that should be refused can be CLAIMED, and a wrong claim deletes the correct Tier-1 mutant
at that site under §3.2 dedup precedence. All four gates are blind to it, so a fixture is part of the
fix.

## Authorised without asking

- Publishing `LethAL Control` and the fixture apps to **Cronus281** and **Cronus283**
  (`$env:DOCKER_CONTEXT='desktop-windows'` FIRST — the session default is the Linux engine).
- Running any `itest:*` gate. Foreground, never poll; they take minutes.
- Container recovery when a run wedges: `force-reset-lease`, then `clear-quarantine`, and a Docker
  restart of the container only if the NST is genuinely stuck.

## Working style

- Roll from one step into the next; do not check in between.
- **Measure, do not reason, about BC.** Every unmeasured confident claim in this thread was wrong at
  least once, including three of mine that had to be retracted from `ROADMAP.md` after being written
  there.
- **Verify the row's prescribed fix against the code BEFORE implementing.** It caught two plan
  defects in two days — including a brief that had the pass/fail enum backwards, which would have
  inverted every routed verdict.
- **Red-check every load-bearing test** with `mutation-red-checker`. It found two holes in a guard
  written minutes earlier in this session, one of them a test that passed only because a token
  happened to contain the string it was asserting.
- Report per step: what shipped, what you verified, and — explicitly — what you did NOT prove. Say
  "unproven" when it is.
- `ROADMAP.md` is the durable record; `.superpowers/` ledgers are gitignored scratch.

## After these three

R72/R73 (RemoveCommit debts) → R66 (localized-refusal parenthetical) → R71 (`SwapRecXRec` scoped to
OnValidate/OnRename) → R67/R68 (safe-direction coverage losses) → Tier-3 program (R13, unblocks R11;
fresh brainstorming, own spec/plan). R77 (custom test runner for `TestIsolation = Function`) is filed
with an entry criterion: a measured false survivor from intra-codeunit bleed, or multi-method
batching. Do not build it speculatively — Microsoft ships no Function-isolation runner, and at one
method per invocation the gain is close to zero.
