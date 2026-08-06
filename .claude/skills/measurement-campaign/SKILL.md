---
name: measurement-campaign
description: Use when running LethAL against a real project or customer app, measuring a real codebase's suite, comparing two live runs, or writing a pre-commitment for any of those. Drives live, billed environments.
---

# Running a measurement campaign

A campaign is a sequence of live runs whose numbers are meant to be believed months later. What
makes a number believable is not the run — it is what was written down before it.

## The mistake to expect

The 2026-08-03 campaign (`docs/campaign/2026-08-03-do/` — a preflight rung plus three measured
rungs, records committed per rung) followed CLAUDE.md throughout — every fix red-checked, every
gate per-mutant rather than aggregate — **and still made two errors.** It pre-committed the wrong
QUANTITY as its expected mutant count, and it silently dropped a gate between rungs. Both became
visible as errors rather than as results, and both were caught by rules that are nowhere in
CLAUDE.md.

That is the argument for this skill. CLAUDE.md governs **code changes**: prove the fix is
load-bearing, gate the frozen fixtures per mutant. These five rules govern **measurements**, where
the failure is not a broken build but a number you now believe for the wrong reason. Following
CLAUDE.md is demonstrably not sufficient to avoid them.

## Preflight — this is what a rung 0 is

```bash
bun packages/runner/src/cli.ts doctor --config <lethal.config.json> [--project <dir>]
```

Read-only, and reports EVERY refusal in one pass rather than one per slow retry (R109). It prints
its own caveat on every invocation: it does not check the per-file publish ceiling, baseline test
health, or the machine-global lease/op-marker — no read-only peek at the lease exists on the control
app (R110). Exit 0 means every check it CAN run passed, not that the run will work.

Then `scripts/campaign/compile-only.ts`, offline, before anything is published. It is the only gate
item that exercises `validateSelectorIdsForProject` — `--dry-run` dispatches to `printDryRun` and
returns before the run path that calls it, so a selector id colliding with the target app's own
objects survives a clean dry run and fails later, live.

## Rule 1 — pre-commit expectations to a committed file, before the run

This is what made the campaign's two errors visible *as* errors. Half of it is now machine-checked:
`lethal campaign freeze | anchors | compare` each read a campaign manifest
(`{"recordsDir": ..., "campaignId": ...}`), resolve the records directory it names, and REFUSE
unless the manifest and that rung's own committed records are clean in git — before reading a
report.

```bash
bun packages/runner/src/cli.ts campaign freeze  --manifest <path> --rung <name> --report <out.json> --expect-mutants <n>
bun packages/runner/src/cli.ts campaign anchors --manifest <path> --rung <name> --report <out.json> [--project <dir>]
bun packages/runner/src/cli.ts campaign compare --manifest <path> --rung <name> --report <out.json>
```

The records are `<rung>.precommit.md`, `<rung>.anchors.json` and `<rung>.baseline.json` inside that
directory. (`scripts/campaign/{freeze,anchors}.ts` are gone — these verbs replaced them, and derive
the config path from the manifest plus `--rung` rather than taking it as a free-form flag, which is
what makes the file the gate READS and the file the gate CHECKS provably the same file.)

**Machine-checked:** the path EXISTS on disk, git TRACKS it (echo-verified through `git ls-files`,
so an answer about some other path cannot be read as an answer about this one), and it is clean
against HEAD. Missing, untracked, gitignored, staged-only and modified all refuse, and a non-zero
git exit is a refusal, never a pass — "the check could not run" must not round down to "the check
passed".

**Still yours to hold:** whether the content was honest when it was committed. The check cannot see
`git update-index --assume-unchanged`, and it cannot see a pre-commitment committed AFTER the run —
only the git history shows that, and reading it is a review question, not a `git status` question.
So commit the file, then run. Never write the pre-commitment and commit it "along with the results".

Also still yours: `campaign anchors` evaluates three built-in anchors — `baseline-green`,
`coverage-location`, `killed-at-least-one` — plus a `notinstrumented-reconciliation` when the config
asks for it (that one THROWS rather than skipping when `--project` is missing; a requested gate item
is never quietly dropped). Everything else in `<rung>.precommit.md` is prose the tool cannot check.
The driver already names one anchor it cannot derive from a report; name yours the same way. A clean
exit must never read as "all of my expectations passed".

## Rule 2 — assert cardinality before any anchor reads the report

Rung 1 pre-committed **176**, its gate refused, and the tool was right: `--dry-run` reports mutation
**sites** (raw specs), while `SessionReport.mutants[]` holds **deployed** mutants after §3.2 dedup
drops a Tier-1 mutant wherever a Tier-2 operator claims the same site. On real code that is
**176 → 148** (-16%); also measured 991 → 973 and 476 → 473. The gap depends on the file's operator
mix, so it cannot be estimated. Predicting one quantity from the other is what broke rung 1's gate.

`assertCardinality` refuses first and independently, in `freeze`, `anchors` and `compare` alike:
*"pre-committed mutant cardinality not met — expected 176, got 148. A gate comparing against a
report of the wrong size is not measuring what it claims."* Without it, an empty report satisfies
every "for all mutants …" anchor vacuously.

R92 has since closed the input side: `--dry-run` now prints `N mutant site(s), D deployed mutant(s)`
plus per-file `sites=`/`deployed=`, and marks every dropped site `[not deployed — displaced by a
higher-tier operator]`. **Pre-commit the deployed number, read off that output.** The rule survives
the fix, because the report is still a different artifact from the dry run.

## Rule 3 — gates carry forward across rungs unless retired IN WRITING before the run

This rule exists nowhere else in this repo, and it is the fix for a recorded plan defect.

Rung 1's anchor 1 was "fenced baseline is 56/56 green". Rung 2's pre-committed gate list did not
carry it. Rung 2 came back with **11 of 409 baseline tests failing** — the report flagged itself
`narrowed-degraded [baseline-red, narrowed, tests-narrowed]` — and no gate caught it. Adding the
gate after seeing it fail is exactly the rationalisation rule 1 exists to prevent, so it was
recorded as a plan defect found by running the plan.

It is not cosmetic: R55 measured that tests failing at baseline are dropped from the green set, and
mutants covered only by them are recorded `no-coverage` — a real survivor converted into a
non-finding.

So: a rung's gate list starts as the previous rung's, in writing. Removing one is an act with a
date and a reason, committed before the run.

## Rule 4 — retire, don't retune, and name the replacement

Rung 1's anchor 2 pinned covered mutants to one procedure's line range, taken from an older record
(105 mutants, 92 no-coverage). Measured now: 15 no-coverage of 148, 133 covered across 14
procedures. Coverage attribution had been substantially fixed since (R61–R63), so the anchor
described a superseded reality.

It was **retired**, not rewritten — a whitelist derived from the run it was meant to gate is a
tautology — and the replacement was named: the per-mutant frozen baseline, which pins every verdict
rather than a set of locations. Rewriting an expectation after seeing the data is the exact
rationalisation rule 1 exists to prevent. Retirement is legitimate; retuning is not. Name what now
carries the weight, or the expectation is simply gone.

## Rule 5 — record negative results

An unreproduced finding is a finding. The model, from rung 3, verbatim:

> **R31's detector was not exercised, and no hole in it is demonstrated.**

The rung-3 agent diagnosed a stale published test app; the setup was reconstructed exactly and it
did not reproduce, because the agent had hit it through a path that is not LethAL's publish path.
That was written down as a negative result and NOT filed as a roadmap row on the strength of one
unreproduced account. A gate that passes vacuously gets recorded as vacuous too — rung 2's
`notInstrumented` reconciliation passed with nothing to reconcile, and says so rather than counting
as evidence.

## The rung ladder

Three rungs, each gated before the next starts. The point of the ladder is that a failure at rung
*n* is cheap and interpretable, because rung *n-1* already holds.

| rung | question | gate to pass before the next |
|---|---|---|
| **1 — mechanics** | can one real file be measured end to end? | two clean runs, verdict-identical per mutant on semantic identity, run 1 frozen |
| **2 — repeatability** | does it hold at module scale, across several publish batches? | same, plus the carried gates of rung 1 (rule 3) |
| **3 — consumer** | is the report legible to the thing that must act on it? | every claimed kill red-checked |

Compare on semantic identity (`astHash` / `codeunitName` / `operatorName` / `operatorMajor`), never
`mutantCode` or `file:line`, which re-batching shifts. `campaign freeze` mints the baseline on the
first run and `campaign compare` REFUSES a missing one — that difference is the whole reason they
are separate verbs.

Rung 3 red-checks because **R86 is open: `failure_note` is NULL for every killed mutant, so no kill
records why it died** — a false kill and a real one are indistinguishable in the record. Commit its
reading rule before the consumer starts: **confusion is a hard finding, success is weak evidence.**
A rung 3 can prove the report is illegible; it cannot prove it is legible, and the write-up must say
which of those it got. If the consumer is an agent, `fixtures/do-campaign/` holds the workspace
contract: a PreToolUse fence (`settings.json` + `fence-hook.ts`) whose `preflight.ts` must pass
FIRST, because hooks fail open and a missing hook file means no fence at all, silently. Its threat
model is accident, not adversary, and `fence-probe-matrix.md` states the residual honestly.

## Choose the module by MEASURED coverage, not by name

Rung 2's module was picked because a large test area *referenced* its codeunits. It came back
**313 of 473 mutants `no-coverage` — 66%**, against rung 1's **10%** (15 of 148). The area had the
largest clean test count in the suite and barely executed the code. Rank candidates by measured
per-test coverage, or accept that a large test area is not a covering one.

Two hard constraints on the same choice:

- **A file too big to publish is unmeasurable, and `--max-guards-per-batch` cannot rescue it** —
  batches split at FILE granularity, so an oversized file becomes its own oversized batch (R90).
  Measured on one hosted environment: 176 and 229 guards publish, 331 and 660 time out. `lethal
  clear-ceiling` is the way back after the ratchet records a failure.
- **Screen candidates for `TestPage` in their covering tests** — grepping for the declaration, not
  the word: on a real suite 9 files MENTIONED `TestPage` and 5 actually contained one. **It is not a
  hang.** R69 filed one and then retracted the attribution: measured on the fenced path, a
  `TestPage` open is REFUSED in **87 ms** (`NavSession.CreateNavTestService()`) and the run
  COMPLETES — no quarantine, no strand. What you lose is the tests. They fail at baseline, drop out
  of the green set, and every mutant they alone covered is recorded `no-coverage` under the
  `baseline-red` caveat (R55) — a real survivor turned into a non-finding. So this is a **rule-3
  concern, not a hang: carry the baseline-green gate.** Sized on a real app: 19 of 1,287 tests, and
  439 of 19,081 deployable mutants = **2.30%**, which is why R69 closed as named-not-recovered
  rather than fixed. The report names the refusal (`testpage-unsupported.ts`). Rung 2 applied this
  screen to reject two otherwise-good test areas.

## Narrow TESTS, not mutants — that is the cost lever

Rung 2, 473 mutants over 4 batches: deploy 149 s, **baseline 740 s (69% of wall clock)**, mutants
171 s — per-mutant mean 1067 ms, **median 433 ms**. The baseline is paid PER BATCH (R45), so
`--tests-only` is the only lever with real leverage at scale; `--only` narrows a phase that was
already cheap.

`--tests-only` **CAN CHANGE A VERDICT** — exclude a killing test and its mutant reports `survived`.
The report flags itself `tests-narrowed`. That makes it a scoping decision to pre-commit, not an
optimisation to apply quietly, and two runs are only comparable when the narrowing is identical
across both.

Know the budget class even though the default now covers it. Rung 1 stranded three times on mutants
that were SLOW, not hung: deleting a `SetCurrentKey` makes the following filtered query scan, and on
the fenced path a budget overrun is indistinguishable from a genuine strand, so the tier quarantines
instead of scoring the mutant. `--mutant-timeout-ms 180000` eliminated both, while a genuinely
non-terminating mutant still scored `timeout-killed` — the control proving the distinction is real.
That measurement is why `MIN_MUTANT_BUDGET_MS` is now 180 s, so the flag is no longer needed by
default; raise it further only when a module's own shapes justify it, and record that you did.

## Prefer `--resume-run <id>` over bare `--resume`

Until **R89's SECOND defect** — the resume-selection one — closes. Key it to that, not to the row:
R89's headline is about `--stop-hung-sessions`, and its own body concludes the stop is *not*
deficient for that class (the 30 s floor was, and that is fixed), so a close granted for the
headline would delete live guidance. Measured: a valid unfinished target run existed with 113
verdicts recorded, and bare `--resume` created a fresh run anyway, printed no `RESUMED:` banner, and
re-measured from scratch. A resume that cannot use its target should throw. Naming the run id
sidesteps it.

A resumed run is admissible as a run-vs-run verdict comparison only if you decide so BEFORE seeing
the result and name the excluded identities. It is never a valid differential input — see
`coverage-differential`, and `recover-tier` for getting a quarantined tier back.

## The target stack's provisioning runbook is not this skill

A real customer stack needs its own runbook, committed beside the campaign records or in that
stack's own repo: how a bare environment gets its dependencies, in what order, with which compiler
version. **Ordering constraints of the publish-before-dependencies class are the kind of thing it
must state** — they are real, they cost time when unwritten, and they age with tooling LethAL does
not control and cannot test. Keeping them here would make this skill quietly wrong on someone
else's clock. This skill requires only that such a runbook exists and is cited from the campaign's
`manifest.md`, alongside the pinned source commit, binary provenance, selector ids and environment
id — a verdict file without its configuration is an unreproducible aggregate.

## Reporting

`lethal explain <report.json>` projects a finished report into what is PROVEN and what is not,
reading that file and nothing else. Use it rather than paraphrasing: `executionProven` is true only
for an exact member-level coverage match, so a survivor with `false` means some test touched the
object and none is measured to have executed the mutated procedure. That distinction is the
difference between "your test does not assert this" and "no test runs this line", and a campaign
result that blurs it is not worth the environment it cost.
