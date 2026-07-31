# Roadmap Execution Plan 2 — the remaining open items, in order

**Goal:** clear the open half of `ROADMAP.md` — R65, R35, R60, R53, R19, R30, R59, R33 — strictly one item
at a time, in an order that spends live-gate minutes once rather than repeatedly, and hand off to a fresh
program plan for Tier 3 (R13, which unblocks R11).

**This is a program plan, not an implementation plan.** Each item below names what must be true before it
starts and what proves it done. The per-item spec and task list are written just-in-time, when that item
comes up — writing eight task lists now would be fiction, because half of them depend on what the item
before them measures. This is the same shape as `2026-07-26-roadmap-execution.md`, which cleared R1–R25.

**Status:** written 2026-07-31, after the R64 Linux/macOS follow-ups merged (`7ea3f9b`). Working tree clean.
Open items at that moment: R11 (blocked on R13), R13, R14 (recurring), R19, R30 (partly), R33, R35, R53
(partly), R59, R60, R65.

---

## The three constraints that shape everything below

**1. One item in flight, one working tree.** No worktree isolation, no parallel streams. Every gate result
is then unambiguous: exactly one change is in the tree when a verdict differs from frozen, so a differing
verdict names its own cause. The 2026-07-26 plan ran four parallel streams because R15/R16 had just made
per-stream environments cheap; that bought wall-clock at the cost of merge-order planning and baseline
reconciliation. This plan buys certainty instead.

**2. Frozen baselines move once, at the end.** `bcdev.baseline.json`, `al-runner.baseline.json`,
`tables.baseline.json` and `envtool.baseline.json` are per-mutant verdict records. Three of the eight items
(R30, R33, R59) can legitimately change what a mutant does. They are batched into the last wave so the
frozen figures are re-recorded once, from a known-good state, rather than drifting item by item.

**3. A differing verdict is a BLOCK, not a nuance.** Live execution is the authority. Per-mutant equality
against the frozen baseline is the gate; aggregate counts matching is not sufficient and never was.

Current frozen figures (`CLAUDE.md`, re-verified under R58's fenced default):

| gate | killed / survived / no-coverage |
|---|---|
| `itest:bcdev` | 3 / 10 / 3 |
| `itest:alrunner` | 3 / 13 / 0 |
| `itest:envtool` | 3 / 10 / 3 |
| `itest:tables` | 64 / 9 / 2 over 75 deployed mutants (81 raw specs), `untargetedTriggerCount` 0 |

---

## Loop-start checklist (run before picking up each item)

1. `ROADMAP.md` — has anything been filed since the last item that outranks the next one? (Triage rule below.)
2. **R14** — check for a new `tree-sitter-al` release. If one exists, it is not an item to squeeze in: it
   is a bump procedure with a per-site baseline proof (`packages/engine/vendor/README.md`), and it goes
   through the same cycle as everything else. R14 stays `recurring` in the roadmap either way.
3. `git status` clean, `bun run typecheck` green, `rm -rf packages/*/dist`, `bun test` green. Starting an
   item on a red tree makes the first red-check meaningless.

---

## Wave 0 — the no-gate sweep

Both items are unit-testable, touch no AL, and move no frozen figure. They go first because both are
*diagnostic* fixes: they change what LethAL says when something goes wrong, and every later wave benefits
from that being accurate. Diagnosing a wave-2 gate failure through R65's empty error message is exactly the
long external debugging session R64 already paid for once.

### R65 — a failed tool spawn can report nothing at all

`ArtifactCompiler.compile` (`packages/runner/src/artifact.ts`) stringifies `err.message` in its catch, and
a Bun spawn `ENOENT` arrives with an **empty** message — so a wrong-platform binary presented as a bare
`Error` with no text. R64 removed one cause (the path); the class is still open: a missing exec bit on
`bin/linux/alc`, a pinned `alcPath` typo, or a partial install all land in the same silent catch.

- **Fix:** include `err.code` / `err.path` and a `String(err)` fallback in the thrown message.
- **Spec:** none. Straight to a task list.
- **Red-check:** the test must go red when the `err.code`/`err.path` inclusion is reverted — that means
  asserting on a *spawn-shaped* error, not a hand-constructed `Error("boom")`, which would pass either way.
  This is the project's signature bug class; treat the test as the deliverable, not the fix.
- **Gate:** unit only.

### R35 — the `TestPermissions` diagnosis has two blind spots

It fires only on the `unstable` path (`packages/runner/src/orchestrator.ts`, R27's fix). Two holes:

1. Tests refused at **baseline discovery** are dropped from the green set and their mutants become
   `no-coverage` with no explanation at all — the user is told "your tests don't cover this" when the truth
   is "your tests were refused."
2. The detector matches BC's **English** refusal text, so a non-English server gets a silent miss.

- **Fix:** carry the diagnosis onto the discovery path; decide and record how far the non-English half can
  go (an error-code match if BC exposes one; otherwise state the limitation loudly rather than pretend).
- **Spec:** short one, because hole 2 may end in "documented limitation" and that outcome must be written
  down as loudly as a fix.
- **Gate:** unit only. A live confirmation is not available — the fixtures declare `TestPermissions = Disabled`
  since `769f667`, so nothing on the gate path reproduces a refusal. Say so in the roadmap row.

---

## Wave 1 — the honesty wave

Three items where LethAL currently produces a *reading* that is wrong, or can. None of them should move a
frozen figure; if one does, that is a BLOCK.

### R60 — every verdict describes the app's non-GUI branch, and nothing says so

Measured under R57: the fenced `RunMutant` path — the source of every verdict, on every backend, in both
coverage modes — runs as `GuiAllowed=No`, `ClientType=ODataV4`. A developer running the same suite from
VS Code runs GUI-allowed. So a mutant inside a `GuiAllowed`-guarded branch, or behind
`Confirm`/`Message`/`Page.RunModal`, can never be killed — and it is reported `survived` or `no-coverage`,
both of which read as a statement about the test suite rather than about LethAL.

- **Measure first.** Count how much real AL sits behind such guards on Document Output before deciding how
  loud the signal must be. A one-line Limits entry and a `guardObserved`-style report field are very
  different amounts of work, and the count decides which is warranted. R46 already proved this project
  cannot distinguish "ran and survived" from "never ran" without attestation, so the ceiling on what the
  report can honestly claim is already known.
- **Spec:** yes — after the measurement, not before.
- **Gate:** bcdev. Verdicts must not move; only the report's shape does.

### R53 — a hanging mutant quarantines instead of scoring `timeout-killed`

The blocking half is fixed; the scoring half is not. Measured on Document Output: **M0013** is
`negate-conditional` on `until DOCustSetup.Next() = 0;`, which becomes `<> 0` and never terminates. LethAL
sees only its own client-side abort, which it must treat as `in-flight-unknown` because BC may still be
executing — so it quarantines, and blocks every mutant after it. **125 of 138 mutants have never run.**
Raising `--mutant-timeout-ms` cannot help: 180 s and 330 s both aborted, and 360 s is the hosting proxy's
own ceiling.

The fix is server-side: `RunMutant` must enforce its own time limit **inside AL** and return a terminal
`timed-out` result — a completed operation the client can score — rather than leaving the client to guess
from a severed connection. Needs an AL change plus a protocol version bump (`ControlApi.Codeunit.al:65`
currently answers `protocolVersion: 2`; `MIN_PROTOCOL_VERSION` in `packages/runner/src/harness.ts` is the
client half).

- **Why it sits here rather than last:** it is the item that unblocks a clean COMPLETE fenced Document
  Output run, which is the remaining rollout item of the fenced-coverage spec alongside R59.
- **Spec:** yes, and it is the most consequential design in this plan — see the Fable review below.
- **The hazard to design against:** the client must distinguish "AL enforced its own limit and returned"
  from "the connection was severed and the operation may still be running." Conflating them turns a
  stranded operation into a scored `timeout-killed` — a **false kill**, the one error class LethAL
  otherwise structurally avoids. Every other open item on this roadmap fails in the safe direction; this
  one does not.
- **Gate:** bcdev + tables + `compile:fixtures` (AL changed). A protocol bump also means the version
  refusal path itself needs a test: a v2 server against a v3 client must be refused before any publish,
  the way `ControlApi.Codeunit.al`'s existing handshake check does it.

### R19 — prepublish and the control-app republish both happen before the lease is acquired

Reworded 2026-07-28 after an external review found the original framing wrong in three ways. What is **not**
the problem: publishing `publishApps` in reuse mode — that is documented behaviour, and skipping it would
re-open the R31/R56 staleness class, observed twice, badly disguised, two lost debugging sessions each.
Trading a measured, twice-observed failure class for a never-once-observed race is not a trade.

- **Spec:** short. Read the current row in full first — the reworded text is what is true, and the item is
  narrower than its title suggests.
- **Gate:** bcdev.

---

## Wave 2 — coverage and features, where the baselines move

Everything here can legitimately change a per-mutant verdict. Batched so the frozen figures are re-recorded
once, at the end, from a tree that has already passed waves 0 and 1.

### R30 — Tier-2 refuses sites inside `tableextension` / `pageextension`

`OBJECT_KINDS` (`packages/builtin-tier2/src/receiver.ts:74`) omits extension objects, so no Tier-2 operator
claims anything declared in one. Safe direction — a missed site costs one operator's signal — but a great
deal of real BC code lives in extensions, so the practical coverage loss on a customer project could be
large. The *shadowing* half was the unsafe direction and is already fixed: `resolveTable` scans
`tableextension` objects targeting the resolved table.

- **Expect the tables baseline to move.** New sites mean new specs, new deployed mutants, new frozen
  figures. That is the point of this item, not a regression — but every *pre-existing* mutant must keep its
  verdict. Gate on the join, not the totals.
- **Spec:** yes.
- **Gate:** tables (primary) + bcdev. `compile:fixtures` if any `.al` under `fixtures/` gains an extension
  object to exercise the new path — which it probably must.

### R59 — the unsafe direction of the runner disagreement is undetected

Moot on the default path: R58's fenced default removed the second runner, so there is no hub green set for
such a test to enter through. The row now tracks **only** the legacy `coverageMode: "procedure"` escape
hatch, and closes when the hub is deleted (fenced-coverage spec, decision 2).

**This item has two branches; pick at the boundary, do not decide now:**

- **If `procedure` mode's one-release grace has expired** — delete the hub. R59 closes by removing its
  cause, and the coverage surface that R30/R33 work against gets smaller.
- **If it has not** — build the detector instead. The spec is explicit that if decision 2 is reversed and
  the hub stays, R59 still needs one. Do not delete a documented escape hatch early to save work.

- **Gate:** all four. Deleting a coverage mode touches every backend's path; the detector branch is
  narrower but still wants bcdev + tables.
- **Use `/coverage-differential`** on either branch — it is the two-mode differential gate built for exactly
  this class of change, and the frozen gates cannot detect these regressions on their own.

### R33 — Tier-2 Phase 2 operators

`RemoveCommit`, `RemoveSetLoadFields` (tagged `likely-equivalent`, scored separately), and `SwapRecXRec`.
Spec §5 of `2026-07-25-tier2-mutation-operators-design.md`.

**`SwapRecXRec` gates itself.** Its go/no-go experiment runs before any operator code: when `Modify(true)`
is driven from AL rather than from a page, `xRec` may carry the same values as `Rec` — and LethAL drives
every test headlessly. If the two do not differ on that path the operator is near-worthless in this
execution model, and **"we measured it and it does not work here" is the better outcome**, recorded as
loudly as a shipped operator. Use `/bc-measure`; do not reason about it from documentation.

`RemoveCommit` needs the report to distinguish a genuine kill from BC's *"cannot run codeunit in a write
transaction"* platform artifact. That distinction is part of the item, not a follow-up.

- **Spec:** yes, after the `SwapRecXRec` experiment reports.
- **Gate:** all four, and this is where the baselines are re-recorded and committed. Re-record, then
  **prove the new baseline compares against itself on a subsequent run** — R29 exists because a committed
  `tables.baseline.json` could never match itself and nobody noticed.

---

## Exit — hand off to the Tier-3 program

R13 (Tier-3 operators, design not started) and R11 (`tierRank` has no tier-3 rank; a tier-3 operator
colliding with a tier-1 one hits "cannot order" and throws) are a program, not an item. The last step of
this plan is a fresh `superpowers:brainstorming` pass for Tier 3, producing its own spec, plan, and
battleplan. R11 rides along with it and is fixed as part of making tier 3 real, not before.

---

## The per-item cycle

Fixed. Runs autonomously between items; the only stops are the ones under **Stop conditions** below.

| # | step | who | model |
|---|---|---|---|
| 1 | recon — locate files, existing tests, prior evidence, the roadmap row **in full** | `cavecrew-investigator` | Haiku |
| 2 | spec (skipped for wave 0) | main thread, `superpowers:brainstorming` | Opus |
| 3 | plan — TDD task list | main thread, `superpowers:writing-plans` | Opus |
| 4 | implement, one task at a time | subagent per task | Sonnet |
| 5 | red-check every fix — revert, confirm red, restore, report both | `mutation-red-checker` | Sonnet |
| 6 | review | `cavecrew-reviewer` | Opus |
| 7 | verify: `bun run typecheck` → `rm -rf packages/*/dist` → `bun test` → `bun run compile:fixtures` if any `.al` changed | main thread | Sonnet |
| 8 | live gate, foreground, never polled | main thread | Opus |
| 9 | `ROADMAP.md` row → `done (<commit>)` with the evidence, then commit | main thread | Sonnet |

Step 7's ordering is not stylistic: `tsc --build` regenerates `packages/*/dist`, and stale compiled
`*.test.js` there get picked up by `bun test` and cause ~21 phantom failures.

Step 9 closes the row in place and leaves it for one release cycle before deletion, per `ROADMAP.md`'s own
rule. A row closed without an evidence pointer is a rumour.

### The one Fable 5 review

Spend it at **step 2 of R53** — the spec plus the AL/runner protocol boundary, before implementation.

- **Why there:** R53 is the only item that introduces a new terminal verdict and a protocol version bump
  across two layers, and its failure mode is a false kill. The frozen gates are structurally blind to it —
  no fixture has a hanging mutant, and M0013 lives on Document Output, which no gate covers. Unit tests
  cannot see it either. No automated authority exists, so judgment is the only check available.
- **Scope it tightly:** the spec, `packages/runner/src/run-mutant-transport.ts`, the `RunMutant` procedure
  in `extensions/lethal-control/src/`, and the version-negotiation path (`ControlApi.Codeunit.al` +
  `packages/runner/src/harness.ts`). Not a branch diff. Fable 5 is $10/$50 per MTok against Opus 5's
  $5/$25 — at ~40k in the difference is under a dollar, so context size, not price, is the thing to
  control. A merged-branch review would cost 10× for diluted attention.

---

## Injected

New findings land here **and** as an `R<n>` row in `ROADMAP.md`, the moment they are found. The roadmap row
is the durable record; this table is only the scheduling view.

| id | item | found during | wave fit |
|---|---|---|---|
| **R66** | The `TestPermissions` refusal detector is English-only, so a non-English server gets a silent miss. Split out of R35 rather than bundled into it: closing it needs a language-independent signal **measured** against a localized server (AL-side `GetLastErrorCode()`, or the structural `(TableData …)` parenthetical), and neither can be settled from a unit test. Not a wrong-verdict finding — the direction is a miss, never a false diagnosis — so it queued rather than preempting. | R35 | **W1**, alongside R53: both want an AL-side change and a live measurement, and R53 is already opening `RunMutant` and bumping the protocol. |

**Triage happens at item boundaries, not mid-item.** One preempt class: a finding that makes LethAL emit a
**wrong verdict** jumps the queue immediately, ahead of whatever is next. Everything else waits its turn and
gets the same nine-step cycle — no shortcuts for small items, because "too small to justify a review cycle"
is how the wave-0 class of defect accumulated in the first place.

---

## Stop conditions

Hard stop, report, wait:

1. **Any per-mutant gate verdict differing from frozen** — a real regression, never "close enough". The
   exception is R30/R33's *new* mutants, which have no frozen entry by construction; pre-existing mutants
   must still match exactly.
2. **A wrong-verdict-class finding**, whether it comes from this work or is noticed in passing.
3. **An item whose spec turns out to need a product decision** — R59's deletion timing is the known one;
   assume there will be others.
4. **A red-check that will not go red** — the test passes whether or not the fix is present, which means the
   hole is not closed and the fix is not yet understood.

Everything else — green gates, clean reviews, ordinary implementation questions — rolls straight into the
next item without asking.
