# Rung 3 — pre-commitment

Written and committed **before** the agent starts.

## Input

**`rung1.report.json`** — 148 deployed mutants on `CDO Send Cust. Statement Mgt`, **107 survivors**,
all `guardObserved === true`, baseline green, two runs verdict-identical.

Rung 1's report is used rather than rung 2's, deliberately. Rung 2 has 66% `no-coverage`, so its
survivors would mostly be "no test reaches this code at all" — a real finding, but the *less*
interesting agent task. Rung 1's survivors sit in code the tests demonstrably execute: **your tests
run this line and do not check what it does.** That is the question a mutation report exists to ask.

## Reading the report the agent is given

| survivor attribution | count |
|---|---|
| `object` | 88 |
| `exact` | 19 |

| survivor operator | count |
|---|---|
| `void-method-call` | 20 |
| `empty-block` | 18 |
| `remove-setrange` | 18 |
| `negate-conditional` | 14 |
| `return-value` | 14 |
| `swap-call-arguments` | 10 |
| `conditional-boundary` | 8 |
| `remove-calcfields` | 3 |
| `remove-commit` | 1 |
| `remove-testfield` | 1 |

## What a correct reaction looks like

**Genuine targets — the agent should attack these:**

- The **19 `exact`-attributed survivors**. Exact attribution means a named covering test executes the
  mutated member, so a surviving mutant there is the strongest available statement that an assertion
  is missing rather than that coverage is absent.
- `negate-conditional`, `conditional-boundary` and `return-value` survivors in procedures with real
  assertions (`CreateStatement`, `IsCustomerStatementReport`, `ChangeAutomaticToManual` all have
  kills already, so their tests do assert something).

**Traps — a correct reaction refuses these, or at least flags them rather than writing a test:**

- **The 88 `object`-attributed survivors.** Object attribution runs *every* green test for the
  object rather than a precise covering set. A survivor under it is a weaker claim than one under
  `exact`, and cannot be distinguished from an attribution artefact by reading the report alone.
- **`remove-setrange` (18).** Deleting a filter frequently changes nothing observable when the test
  fixture holds few rows — a large share of these are plausibly **equivalent mutants**. An agent that
  writes tests to kill them is chasing equivalence, not quality.
- **`remove-commit` (1).** R72: deleting a `Commit()` before `Codeunit.Run` makes the platform refuse
  the call, which "kills" the mutant for a reason that says nothing about assertion quality.
- **`empty-block` on telemetry/logging paths.** Emptying a block whose only effect is a log write is
  unobservable to a test that does not read the log.

**Also correct:** not attempting all 107. A report with 107 survivors is a backlog, not a task list,
and `survivorsByProcedure` exists precisely so a reader attacks a procedure rather than a list.

## The reading rule, restated so it cannot drift

The agent runs **without `--bare`**, inheriting this machine's global `CLAUDE.md`, plugins and
skills. It is therefore a **stronger-than-typical** reader.

**Confusion is a hard finding. Success is weak evidence.** Rung 3 can prove the report is bad. It
cannot prove it is good.

## Fences

- `--settings fixtures/do-campaign/settings.json` (PreToolUse fence), **preflight must pass first** —
  hooks fail open, so a missing hook file means no fence at all, silently.
- `--disallowedTools Task` — closes the subagent question rather than resting on hook-inheritance
  semantics.
- `--max-budget-usd` bounds the run.
- Working directory `U:/Git/do-lethal`; the agent gets the **rebuilt** standalone binary, not the
  LethAL source tree.
- Threat model is **accident, not adversary** (decided 2026-08-04). The fence stops accidental
  routes; `$()`/`$VAR` obfuscation defeats it and is a documented, accepted residual.

## Binary provenance — Task 8 step 1b, done

Rebuilt from `30685d0`+ at rung-3 time; `grep -ac` returns **3** for every operator the rung-1 set
depends on, where the superseded 2026-07-27 build returned **0** for `swap-call-arguments` and
`remove-commit`. Filename identical between the two builds — see R88 and `manifest.md`.

## Every claimed kill is red-checked

Revert the agent's test, confirm the mutant returns to `survived`, restore. Run the confirmation at
the agent's own scoping **and** unnarrowed, because `--tests-only` selects tests and can change a
verdict (R45).

Two measured reasons this is not optional: **R86** — `failure_note` is `NULL` for every killed mutant,
so no kill records *why* it died; and this project's signature bug is a test that passes for the
wrong reason.

**If the budget will not cover verifying every claimed kill, cap the number accepted and say so in
the result — never drop the unnarrowed leg.**
