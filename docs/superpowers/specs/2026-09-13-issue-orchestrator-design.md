# Issue orchestrator: design

Date: 2026-09-13
Status: revision 1. Five sections, each reviewed by gpt-5.6-sol and gemini-3.8-flash through pi,
adversarially, with every mechanical claim acted on verified against this repo before acceptance.
Owner: SShadowS

## Goal

A fully autonomous flow that takes GitHub issues on `SShadowS/LethAL` from open to squash-merged
on `master`, one at a time, with no human gate. It picks its own issues, files what it discovers,
drives the live Business Central gates on its own containers, and stops on its own when the queue
is empty, a cap is hit, a merge regresses `master`, or a human drops the kill switch.

Two reference implementations were read end to end and neither is copied wholesale:
`U:/Git/al-call-hierarchy` (a Python executor plus prose commands, single issue, two-model panel,
attestation, HALT, validated revert) and `U:/Git/AL.Runner-v2` (GitHub labels as the state
machine, three subagents, two parallel implementers, assignee as the human boundary). The shape
here follows the first. The reasons are specific to LethAL and are given under Shape.

### What makes LethAL different from both references

CI is not the authority. `.github/workflows/ci.yml` runs typecheck, a dist clean and `bun test`,
and deliberately does not run the live gates. For a large class of change a green PR proves close
to nothing. The authority is a live BC container, the gates are minutes each, and their pass
condition is per-mutant equality with a frozen baseline.

And a correct change is often *supposed* to move that baseline. That single fact drives most of
this design.

## Non-goals and stated limits

- Parallel issues. One at a time. Even the two-container parallelism the reviewers judged
  defensible (bcdev on one container while tables runs on the other) is deferred: the leg
  ordering constraints below already make the serial schedule non-trivial.
- Cloud runners. The flow depends on local Windows Docker BC containers, `alc`, `altool`, a
  globally installed `al-runner`, and pi. None of that exists off this machine.
- Closing issues by judgment. Issues close through a merged PR carrying `Closes #N`, or through a
  recorded ruling, never through a model deciding an item is not worth doing.
- **Sandboxing (stated limit).** Workers run as the owner, with the owner's `gh` token and
  filesystem. Mitigation is eligibility and protected paths, not isolation.
- **Spend ceiling (stated limit).** Token spend is not observable from inside the harness. The
  proxies are the subagent, pi-call and live-minute caps.
- **Semantic honesty of a pre-commitment (stated limit).** The executor can prove a prediction was
  committed before the first live run, and that it matched. It cannot prove the prediction was
  believed. See Residual risk.

## Shape

Three parts.

| Part | Role |
|------|------|
| `scripts/agentflow/` (TypeScript, run by Bun; entry `bun scripts/agentflow`) | The **executor**. Every state mutation lives here: lock, lease, claim, label, comment, push, PR, merge, revert, container publish and reset, gate invocation, red-check, discovery filing, sanitizing, baseline re-record. Deterministic, unit-tested with a fake `gh`, with a `--dry-run` that performs no write anywhere. |
| `/orchestrate [--dry-run] [--max-issues N]` | One tick: preflight, fetch, rank, claim, run `/issue N`, verify the merge, file discoveries, finish. |
| `/issue N` | The per-issue pipeline: worktree, classify, probes, oracle, spec, plan, implement, ladder, panel, PR, merge. |

**The capability boundary is real, not stylistic.** Reference A's spec says all mutation belongs
to the executor, but its `/issue` command still instructs the model to run `git worktree add` and
`git rebase` directly. That inconsistency is not reproduced here. The executor owns the container
configs, the leases and the credentials, and the conductor has no path to a live container except
through it. That property is what makes the pre-commitment rule below enforceable rather than
aspirational.

**TypeScript, not Python.** The repo is Bun, `bun test` already covers `scripts/`, and
`roadmap-index.ts` and `redact-campaign-report.ts` are the existing precedent for a script that is
also a gate with its own test file. The runtime is shared with the code under test, which carries
two hazards, both closed by construction: the executor launches from the trusted main checkout and
never from a candidate worktree, and it imports nothing from the product packages. It does not
re-implement baseline comparison at all. It runs the itest as a subprocess and reads its receipt,
so there is exactly one definition of mutant identity and it lives where it already lives.

**Self-maintenance.** The executor and the commands are installed and changed by hand. An issue
requiring a change to a protected path is `blocked self-modification`.

## Trust boundary

The repo is public and seven of the eight open issues were filed by an external collaborator.
Issue text is data, never instructions.

**Eligibility** (executor, deterministic, before any model sees the issue): author is the owner or
a collaborator with write access; no `agent-*`, `manual-only` or `epic` label; the body carries
the required schema below; no open dependency; not in a dependency cycle.

**Issue revision pinning.** The body hash is recorded at claim and re-checked immediately before
merge. A changed hash is `blocked issue-edited`. With most issues coming from an external author,
concurrent editing is an operating condition, not a hypothetical.

### Protected paths

A diff touching any of these is `blocked`:

- `.github/**`, `.claude/**`, `CLAUDE.md`, `.gitignore`
- `scripts/agentflow/**` (the executor itself)
- `packages/runner/itest/**` (the gate implementations)
- the `scripts` block of `package.json` (which is how every gate is invoked)
- the path-to-leg table (`scripts/agentflow/gate-table.ts`)
- the baseline comparison code (`packages/runner/itest/mutant-equality.ts`,
  `packages/runner/itest/baseline-guard.ts`)
- `docs/roadmap/R<nnn>.md` for any id other than the issue's own

Deliberately **not** protected: the baseline *data* files, which outcome 2 below must be able to
re-record. The distinction is that the flow may change what was measured; it may never change how
measurement is judged.

The reason this list is wider than reference A's: without it, a PR can weaken `growth.itest.ts` or
an assertion inside a live itest and then be verified by the weakened gate.

**Evidence sanitizing.** Everything leaving the machine is scanned first: issue bodies, comments,
PR bodies, and every committed file. `bun scripts/redact-campaign-report.ts --check <paths>` runs
over every added or changed campaign JSON with the paths enumerated explicitly (the script
requires at least one path and throws on an empty list). A violation is `blocked sanitize-failed`.

## The three-outcome live gate

This is the centre of the design and has no counterpart in either reference.

A live leg has three outcomes:

1. **Verdicts identical to the frozen baseline.** Merge candidate.
2. **Verdicts moved, and every movement was pre-committed.** Legitimate. Re-record in the same PR.
3. **Verdicts moved unpredicted.** Block. This is the only regression signal.

### Pre-commitment, enforced

- A pre-commitment file at `docs/superpowers/specs/<date>-issue-N-precommitment.md` must be
  committed **before the first live run for that issue**, not merely before the current
  invocation. The executor is the only path to a live container, so it knows every live run for an
  issue and can enforce the stronger condition. The weaker one is trivially bypassed: run the
  gate, observe what moved, write the file, commit, invoke. Both reviewers found that hole
  independently.
- Offline work stays freely available to the agent. What must not be observable before commitment
  is the live verdict.
- A failed prediction does not permit an edit. It requires a new pre-commitment **generation**,
  with its reason recorded, and the generation diff is what the panel reads.

### Entry shapes

Every entry is an explicit operation, because a removed mutant has no post-run verdict and a
schema demanding one for every moved key cannot express a removal at all:

```
add    <key>              expect <verdict>
remove <key>              was    <verdict>
change <key>              <old>  -> <new>
rename <key_old> -> <key_new>     because <evidence>
```

`rename` exists because mutant identity is not semantic identity. `selection.ts:44` takes the
ordinal from **source order** (the R193 comment at `:24-31` says so), so inserting a byte-identical
twin above an existing pair shifts every later twin's key. `astSubtreeHash` moves under an
unrelated refactor for the same reason. Without an explicit rename, that churn is either a false
block or a laundering channel for a real verdict flip hidden inside an add/remove pair.

### The offline structural delta is a widener, never a predictor

Running the mutation planner per fixture and diffing the mutant key set against the committed
baseline's key set predicts `add` and `remove`. It provably cannot predict a changed verdict on an
unchanged key, because the baseline stores `verdict`, `killingTest`, `coverageFiltered` and
`errorClass` separately from the key. R220 is the measured proof: wiring al-runner's `--coverage`
moved four SandboxPricing mutants from `survived` to `no-coverage` with the population unchanged
at 19. An earlier draft of this spec required the pre-commitment to *match* the offline delta,
which would have rejected R220's pre-commitment as invalid. Only `add` and `remove` entries
reconcile with the planner. `change` and `rename` are semantic claims the panel reviews and the run
confirms.

The delta may **add** required legs and may never remove one.

### Inconclusive, and the control run

A failed prediction is `inconclusive`, not blocked-forever: no merge, no baseline write, evidence
retained, one bounded retry after a clean reset. Whenever a candidate run disagrees with the
baseline, the executor reruns the same legs on the **base commit** in the same containers. If the
base also disagrees, the cause is the environment, and the outcome is `inconclusive` with the
environment fingerprint attached rather than a code block. That one mechanism answers the whole
drift class: `al-runner` is a global dotnet tool that ships several times a day.

A `killingTest`-only difference is `inconclusive`, never a block: R197 measured those as
order-dependent.

### Re-recording is two-phase

Candidate run writes a temporary baseline to an executor-owned path; the executor prints the exact
old-to-new diff; it installs it; it reruns the affected legs with the escape hatch **absent**; only
then may it be committed. The guard's own comment records why (R29: a committed
`tables.baseline.json` could not match itself, and nothing caught it until it was proven to compare
on a subsequent run).

`LETHAL_RERECORD_BASELINE` is set only in an explicit per-child environment, never in the
executor's own process, or every child and subagent inherits a disarmed guard.

**Baselines are read-only inputs.** Each itest runs against a read-only committed copy. A missing
committed baseline is an error. Today `assertMatchesBaseline` writes the current run as the new
baseline when the file is absent (`baseline-guard.ts:58-66`), so a candidate that deletes a
baseline gets one minted from its own run and the gate exits green.

## The gate ladder

### Inventory

Offline, in this order, on every non-docs change:

1. `bun run typecheck`
2. `rm -rf packages/*/dist`, between typecheck and test, never before both
3. `bun test`
4. `bunx biome check <the .ts files this diff touched>`, repo-wide is knowingly dirty
5. `bun run compile:fixtures` if any `fixtures/**/*.al` touched
6. `alc` offline compile if `extensions/lethal-control/**` touched
7. `bun scripts/roadmap-index.ts --check` if `docs/roadmap/**` touched, with the tree asserted
   clean afterwards. The bare invocation writes; running the writer during validation would
   silently repair an incomplete PR after its SHA was sealed.
8. `bun scripts/redact-campaign-report.ts --check <enumerated paths>` if `docs/campaign/**` touched
9. structural delta per fixture
10. `bun run mutate` if `selection.ts` or `line-map.ts` touched: ledger only, never gates
11. `bun run itest:growth`: **ledger telemetry, not a gate**. It prints `LINEAR-ish` or `WARNING`
    and never fails (`growth.itest.ts:66-67`). Calling it a gate would be a fourth green-when-
    nothing-happened command.

Live legs, each with its own env var: `itest:bcdev`, `itest:lease`, `itest:stale-publish` (all
three on `LETHAL_ITEST_BCDEV`), `itest:tables`, `itest:chunked`, `itest:alrunner` (four legs),
`itest:hang`, `itest:envtool`.

### A leg passes on a receipt, never on an exit code

Every env-gated itest calls `process.exit(0)` on its skip path: `bcdev.itest.ts:49`,
`tables:53`, `hang:65`, `al-runner:48`, `chunked:78`, `envtool:132`. So "every required leg exited
0" is satisfied by a ladder that never contacted Business Central, and one misspelled env var in
the executor merges everything. That is empty-vs-empty, this project's named signature bug,
reproduced inside the thing built to prevent it.

Each itest therefore writes a machine-readable **completion receipt**: leg name, candidate SHA,
the sublegs it ran with their expected count, the artifact ids it observed, the container
generation, and `status: passed`. The executor requires the receipt. A skip is neither pass nor
failure; for a required leg it is an executor error.

The same rule closes the other two. `compile:fixtures` exits 0 saying "SKIPPED, not passed" when
`alc` is missing (`compile-fixtures.ts:87-89`) and skips a project with no `.alpackages` without
counting a failure (`:105`), so it must report the resolved `alc` path and hash, the expected
project inventory, and zero skipped affected projects.

### Selection is default-deny, by module

An unmatched path selects **every** leg. The first draft of the table omitted
`packages/builtin-tier2/**`, which exists, so Tier-2 operator changes would have selected zero
live legs. The table will always be incomplete; incompleteness must fail safe.

| changed path | required live legs |
|---|---|
| `docs/**`, `*.md` | none |
| `scripts/**` (not `agentflow/`) | none |
| `packages/engine/**`, `operator-sdk/**`, `builtin-tier1/**`, `builtin-tier2/**` | bcdev, tables, chunked, alrunner |
| `packages/schemata/**` | bcdev, tables, chunked, alrunner, hang |
| `packages/runner/**` | bcdev, lease, tables, chunked, alrunner |
| `packages/runner/src/publisher.ts`, `app-version.ts`, `publish-serializer.ts`, `deployment-verifier.ts` | the above, plus stale-publish |
| `packages/runner/src/run-mutant-transport.ts`, `harness.ts` | the above, plus hang |
| coverage, selection or attribution code | the above, plus the two-mode coverage differential |
| `extensions/lethal-control/**` | THE FULL SET, after a control-app bootstrap |
| `fixtures/sandbox-app/**`, `fixtures/sandbox-tests/**` | bcdev, alrunner |
| `fixtures/sandbox-probes/**` | bcdev, lease |
| `fixtures/sandbox-data/**`, `fixtures/sandbox-data-tests/**` | tables, chunked |
| `fixtures/sandbox-hang/**`, `fixtures/sandbox-hang-tests/**` | hang |
| `packages/runner/src/env-tool*.ts` | the envtool contract gate below, in place of the unrunnable live leg |
| anything unmatched | THE FULL SET |

**THE FULL SET** means bcdev, lease, stale-publish, tables, chunked, alrunner (all four legs),
hang, and the envtool contract gate. It does not include the live envtool leg, which cannot run;
see below.

`schemata` selects `hang` because the selector it emits is what the stop has to interrupt, and no
other fixture contains a non-terminating mutant.

### Order is by destructive residue, not cost

```
control-app bootstrap (if needed)
  -> bcdev -> lease -> stale-publish
  -> verified clean reset
  -> tables -> chunked -> alrunner
  -> hang            (last: its OFF leg strands an operation marker by design)
  -> final clean-state probe
```

`bcdev` precedes `lease` because the lease gate needs a registered artifact and says so
(`lease.itest.ts:1458-1474`). `hang` is terminal because its cleanup is best-effort and a failure
makes later bcdev runs refuse with `operation-orphaned` (`hang.itest.ts:526-541`). A failed final
reset quarantines the container and makes the attempt inconclusive rather than continuing.

The control-app bootstrap is a transaction, not a step: compile, publish to both containers,
inventory installed dependants, republish the fixture and test apps, prove the lease clean, then
re-qualify. Publishing or uninstalling the control app can silently uninstall dependants while app
listings still show them as published.

### Evidence is typed per leg

Verdict-baseline legs (bcdev, tables, alrunner, envtool) use the three-outcome model. Mechanism
legs (chunked, hang, lease, stale-publish) do not have frozen per-mutant baselines and declare
their own positive evidence in the manifest schema. Forcing them into the baseline model would
either hunt for files that do not exist or certify the verdict subset and discard the assertion
that gives the leg its value.

### envtool

Its environment was deleted 2026-09-01 and never restored, so the leg cannot run. Rather than
parking every runner change, both reviewers proposed the same substitute and it is adopted: a
**local external-process contract gate**, a fake env tool returning the documented `resolve` JSON
pointed at a dedicated container, which exercises `resolveEnvToolSession`, `buildBackend`,
`leaseSessionFor` and `withEnvTeardown`, the seams the itest says it exists to test. Its per-mutant
table is compared against bcdev's on the same day, which is what the real gate's value was.

Only provider-lifecycle changes park for a human. A hosted canary runs periodically rather than
per PR, because provider drift is independent of repository paths.

### The sealed manifest

A gate result binds: base SHA, candidate SHA, pre-commitment blob hash and generation, old and new
baseline hashes, every required leg with its receipt, published target and test-app hashes,
container id **and generation**, BC image digest, control-app version, `al-runner` version, `alc`
path and hash. Nothing may be re-recorded or merged against an unsealed manifest, and a rebase
invalidates it.

The target and test-app hashes are load-bearing. A PR can break a test fixture, fail to rebuild the
test app, have BC run the previous build, and match every frozen verdict. Nothing moves, so no
prediction logic catches it. That is R56, and R56 stayed green for days.

## Merge criteria

All must hold:

1. A sealed manifest for the exact candidate SHA, every required leg carrying a passing receipt.
2. Baseline outcome 1, or outcome 2 with a matched pre-commitment and the re-record proof run.
3. An executor-issued red-check receipt for every test added or changed. A change with no test is
   refused unless it carries one of the four witnesses below.
4. The findings register converged (see Review).
5. GitHub CI green.
6. Redaction clean, roadmap index consistent, protected paths untouched.
7. Issue body hash unchanged since claim; base unmoved since the manifest was sealed.

### The red-check is executor-owned

`mutation-red-checker` currently edits the tree, runs a test, restores, and reports prose. In an
autonomous loop a crash mid-check leaves the candidate without its fix, and nothing prevents a
conductor from reporting a check it never ran or one aimed at an already-red test. The subagent is
demoted to *designing* the mutation and emitting a structured proposal. The executor performs it:

1. Bind to candidate SHA `H`; refuse a dirty tree; hash the test file, production files and patch;
   verify the patch touches production code only, not tests, fixtures, runner arguments, snapshots
   or gate code.
2. Prove the test green on `H` first, requiring the expected test identity and a non-zero executed
   count. Exit 0 with zero tests run is not a pass.
3. Run the check in a **disposable detached worktree created from `H`**. The candidate tree is
   never mutated, so a crash leaves disposable residue instead of a candidate missing its fix.
4. On the red side require the *named* test to fail with a predeclared failure signature, and
   reject compile failure, discovery failure, timeout, zero tests, and a different test failing.
5. Restore by deleting the worktree; re-verify `H` green.
6. Seal a receipt: argv, working directory, executed test identity and count, failure category,
   red and green exit statuses, log hashes.

Adapters are needed per test kind, because AL fixture tests have no unit harness and need compile
and live adapters.

### The four witnesses for a no-test change

Reverting a refactor is not a red check: both versions are meant to pass. The injected fault must
target the invariant the refactor could have broken. A no-test change may merge only with one of:
a deliberate fault at the changed seam that reddens a **named** existing gate; an old-versus-new
differential over a proven non-empty corpus with the changed branch proven exercised; a
mechanically checkable transformation (formatting, a generated index); or a compiler-enforced
rename plus a broken-reference red check. Otherwise it parks.

## Roles

### Commands

`/orchestrate`, `/issue N`, and `/triage`, which makes one pass over issues carrying no `status:`
label, sets `ready` or `needs-input`, and never loops. It runs once at the start of a cycle, not
between ticks.

`Type: spike` short-circuits the pipeline: probe read-only, write the answer to the ledger, and
return `spike-answered`. No worktree commit, no PR, no live container unless the probe itself is a
measurement, in which case it runs through the executor under a container lease like any other
live work and its receipt is the answer's evidence.

The owner's existing skills stay human-only and untouched:
`live-gate`, `al-compile`, `control-app`, `coverage-differential`, `measurement-campaign`,
`al-probe`, `release`, `recover-tier`.

### Existing subagents

| Agent | Use | Change required |
|---|---|---|
| `al-compiler` | offline AL compile | **Bug:** `al-compiler.md:17` globs only `bin/win32/alc.exe`; R167 requires probing `bin/` too, which `al-compile/SKILL.md:16` does. Fix before use, or move discovery into the executor. |
| `mutation-red-checker` | designs the mutation only | Demoted; no longer executes or attests. |
| `roadmap-auditor` | close-time evidence audit only | Not intake. `roadmap-auditor.md:52` forbids judging worth, `:54-55` puts anything needing a live server out of scope. It defines no issue search or dedupe. |
| `spec-adversary` | local leg of the spec review | Emits findings, not register transitions. The conductor may not fabricate `accepted` on its behalf. |
| `wiring-completeness` | mandatory on any new report, config or statics field | **Bug:** `wiring-completeness.md:14-17` stops on a required field because "tsc proves every construction site sets it", contradicting its own steps 4 and 5, where a field set everywhere but read nowhere, or produced by a loader never called, is the same bug. Remove the early exit. |

### New roles

- `issue-triager` (Opus): eligibility detail, concreteness, candidate R-id, gate class, dedupe
  against the archive and open issues.
- `acceptance-oracle` (Opus): owns the minimal reproducer and the acceptance tests. Works **before
  and independently of** the implementer, derives expected behaviour from issue evidence, a frozen
  fixture, or an executor-run AL probe, writes tests but never production code, produces the
  initial red receipt through the executor, and cannot revise expectations after seeing the
  implementation except through a new reviewed generation.
- `baseline-diff-triager`: classifies each moved mutant as predicted, explained-by-drift, or
  unexplained. An unexplained line blocks and becomes a discovery.
- `precommitment-adversary`: attacks the predicted verdict table before the live run.

Container hygiene is executor code, not an agent: a preflight and quarantine decision, not a
judgment.

**Why the oracle exists.** The executor's red-check proves a test depends on the code. It cannot
prove the test asserts the right thing. If the implementer writes both from the same misreading,
the red-check passes honestly and the oracle is wrong. That is R175 exactly, which CLAUDE.md
already records as the case mutation testing would not catch. The red-checker answers "does this
test depend on this implementation". The oracle answers "does this test assert the right
behaviour". They are different questions and one role cannot hold both.

### Review, three stages

- **Spec.** `spec-adversary` locally. Foreign review only on a disputed blocking finding, or when
  the design changes verdict semantics, recovery, publication or baseline identity. The two-model
  foreign spec panel from reference A is dropped: it largely duplicates a domain-tuned local
  adversary and creates the anchoring problem below.
- **Pre-commitment.** `precommitment-adversary` always; one fresh foreign reviewer for ordinary
  movement; two for high-risk movement (killed-to-survived, timeout semantics, coverage
  attribution, baseline replacement). Its unique value is timing, not redundancy: models that
  cannot run BC cannot turn speculation into measurement, but they can catch omissions, impossible
  causality, key mismatches and unjustified movements.
- **Final.** `code-review` at high over the diff, then both foreign models over diff, spec and
  ledger. Always. This stage sees the artifacts that can actually merge, including the case where
  a correct spec is wired into one of two construction sites.

**Anchoring.** No `continuation_id` across stages, only within one. Reviewers get a **blind first
pass**: the artifacts without prior verdicts or conductor dispositions, with the register shown
only in a later disposition pass. Different families reduce shared training bias; they do nothing
about a reviewer's commitment to its own earlier answer.

### The findings register, with a LethAL taxonomy

Reference A's register assumes disagreements are settleable by argument. Here a reviewer that
cannot run BC can re-raise a platform objection forever, three rounds expire, and a measured
result parks for human arbitration.

```
kind:        code-defect | design-defect | empirical-question |
             measurement-validity | environment-drift
disposition: open | fixed | refuted | deferred |
             measurement-required | measured-confirmed | measured-falsified
severity:    critical | important | minor
```

- An `empirical-question` is settled by an executor-sealed, predeclared probe receipt, not by
  reviewer assent.
- Reviewers keep the power to block on **measurement-validity**: wrong control, stale artifact,
  empty population, unverified join, environment mismatch.
- Findings bind to an artifact kind and hash (spec hash, pre-commitment hash, candidate SHA), not
  one ambiguous "current hash" spanning three stages.
- Live findings locate by receipt id, leg and mutant key, not `file:line`.
- A blocking finding from the local adversary does not disappear because the foreign reviewers
  accept the conductor's refutation.
- Reviewers emit the closed schema **directly**. Where the conductor must normalise, both the
  original and normalised severity are kept and any downgrade blocks until another reviewer
  accepts the mapping. An executor can check that a word is one of three values; it cannot check
  that "critical" was honestly mapped.

Convergence means all normative objections resolved and all empirical questions measured.

### Model routing

Deterministic eligibility and duplicate detection in the executor. Sonnet 5 for ranking *after*
that filtering. Opus 5 for semantic triage, the acceptance oracle, and implementation. Per-task
review routes by risk: Opus for verdict classification, baseline identity, coverage attribution,
lease and recovery, publication ordering, timeout and false-kill logic; Sonnet for the rest.
Foreign reviewers `gpt-5.6-sol` and `gemini-3.8-flash` through pi, thinking high,
`require_evidence` on.

**A claim about current BC or `al-runner` behaviour is never triaged `ready` from text.** It
becomes a spike with a version-stamped probe. `al-runner` ships several times a day, and the last
sweep found stale claims in prose rather than code.

## The queue

### One queue on GitHub, with a git-durable evidence trail

The 19 still-open roadmap rows migrate to issues. The 201 settled rows stay in `docs/roadmap/` as
the archive, and `ROADMAP.md` keeps generating.

A discovery is filed as a GitHub issue **and** as a minimal immutable **discovery receipt**
committed at discovery time: id, issue URL, body hash, evidence pointer, and the discovery text.
The full archive row is written at settlement.

The receipt exists because an issue body can be edited, narrowed during deduplication, transferred
or deleted, and a settlement that writes the archive row from the *current* body leaves the
original observation in no clone. R213 is the worked example: reduced to "implement ModifyAll
support", it would lose the measurement that rejected `DeleteAll` and the prerequisite that says
measure before building.

CLAUDE.md's "file a roadmap item the moment you discover one" becomes "open an issue and commit a
receipt the moment you discover one". CLAUDE.md is protected, so the owner makes that edit.

### No hand-maintained epics

Grouping comes from `area:*` labels and saved queries or a generated view. Six manual task lists
are the pattern this repo already rejected: `roadmap-index.ts:10-12` says a hand-maintained index
is a second copy and a second copy rots, which is why `ROADMAP.md` is generated. An epic checkbox
is also a separate GitHub write outside the git transaction, so a crash between the child merge and
the checkbox leaves the epic permanently wrong. Keep an epic only where it carries its own
acceptance or a release decision.

### Issue schema (eligibility requires it)

```
## What breaks, for whom
## Acceptance          (each item testable, or "not deliverable, because")
## Evidence            (file:line, a probe command, or a measurement pointer)
Type: spike | bounded | architectural
Resolution-mode: code | measurement | ruling | recurring
Roadmap: R<n>          (optional, at most one)
Depends-on: #N         (optional)
```

`Type` lets the executor decide whether an item may reach a live container at all, without asking
a model. `Resolution-mode` lets it decide whether a merged PR is even the terminal state: R213 says
measure before building, R089 calls itself a standing watch while carrying an open status, and R14
is recurring. Without it the flow eventually claims something that cannot terminate through a
merge.

### Migration is manifest-driven, not automatic

An owner-approved manifest maps every one of the 19 rows and 8 issues exactly once, with an
explicit relation:

```
exact | supersedes | partially-overlaps | split-into | already-settled-by | standalone | recurring
```

Only `exact` permits automatic reuse and later automatic archival. The executor refuses to infer
semantic equivalence, to map one issue to multiple roadmap ids, to combine or split acceptance
scopes, to close either side of a partial overlap, or to migrate a `recurring` or standing-watch
row as ordinary ready work.

The known relations to resolve by hand: #4 and R213, #7 and R196, #8 and R219, #6 overlapping both
R214 and R217, and #3 and #5 apparently already settled by R220 and R207.

### Closing

On merge, an issue carrying `Roadmap: R<n>` flips that file to `done <date> (#<PR>)` in the same
PR and regenerates the index. A ruling closure writes `closed <date> - <the ruling>`, since a
ruling has no commit to name. Both forms count as closed and any "how many are open" count must
accept either.

## Safety

### HALT

`.agent/HALT` in the main checkout, checked before every external write and every container
operation. Two carve-outs only: terminal bookkeeping, and emergency rollback.

**Container mutation under HALT is not a carve-out.** An earlier draft allowed quarantine and reset
so the next run would not be blocked, and both reviewers rejected it with the same argument: while
HALT exists there must be no next run. "Reset" also covers lease clearing, which
`recover-tier/SKILL.md:32-42` says is safe only once the stranded AL is actually dead, and forceful
app removal, which silently uninstalls dependants.

Under HALT the executor may perform **containment only**: write the quarantine marker, kill the
local process tree, stop or isolate the container, record what was in flight. Restoration requires
HALT cleared or a narrowly scoped human recovery token, and must prove the old operation dead first.

### Leases, and the container generation

Two layers, both fenced by run-id and heartbeated every 60 s by the supervisor, stale at 30
minutes: an issue lock, and one lease per container.

**Heartbeat staleness does not mean the old writer is dead.** Run A dispatches a mutant into a
container and its supervisor dies; the BC operation continues. Thirty minutes later run B declares
the leases stale, unpublishes the visible apps, sees a clean lease table, marks the container
qualified, and starts its ladder. A's operation then completes, or a stranded AL session performs a
delayed write. Run-id fencing stops A from issuing new executor commands; it cannot recall an
operation BC has already accepted. B seals a manifest on a contaminated container.

So qualification binds to a **monotonically increasing container generation**. Every publish,
operation, manifest seal and receipt carries and rechecks it. Recovery must kill or restart the BC
service, proving the old writer dead, **before** clearing the old lease and minting the next
generation.

### Container qualification

Containers are assigned to fixtures, not shared between them, because at most one instrumented
target may be installed per container: **Cronus284 carries `sandbox-app` and `sandbox-hang`**
(bcdev, lease, stale-publish, alrunner, hang), **Cronus285 carries `sandbox-data`** (tables,
chunked). This mirrors the owner's own split, where the two fixtures already target different
containers.

Before either may gate anything, each must reproduce every frozen baseline exactly.
Re-qualification is required after a BC image change, a control-app publish, a quarantine, any
manual intervention, and any generation bump. An unqualified container cannot seal a manifest.

Qualification is necessary and not sufficient: dirty tenant rows that no baseline test happens to
read will pass it. That is why the generation, the artifact hashes and the clean-state probe are in
the manifest too.

### Crash recovery

Reconcile with GitHub first. If the PR already merged, finish the run. Otherwise preserve the
worktree, quarantine the container, label `agent-blocked` with reason `crashed`. Container recovery:
prove the old writer dead, unpublish in dependency order (tests app first, since unpublishing the
target cascades), verify no residual instrumented target, verify the lease table clean, verify
`HarnessInfo` answers, bump the generation, re-qualify.

### Verifying the merge

Four commits matter, named once here and used throughout: `B` is the base the gates ran against,
`H` the code head they passed on, `F` the final head after the evidence-only commits allowed after
`H`, and `M` the squash merge.

Not a second full ladder. A **merge-tree equivalence check**: `M`'s parent is `B`, its
tree equals `F`'s tree, `H..F` contains only allowed evidence paths, the sealed manifest
and qualification generation re-hash correctly, and any leg proven SHA-sensitive is rerun. A squash
changes commit identity, not the checked-out tree, so this is sound for "did the merge introduce
ungated content" and saves 25 to 40 minutes per merge.

Stated honestly, it stops detecting: environment drift after the seal, flakes, and contamination
arising after qualification. The generation recheck covers the third.

On a red result: write HALT first, then a validated revert (the revert must itself pass the gate
that failed), reopen, label `agent-regressed`, notify, stop the loop.

### Budgets

| Cap | Value |
|---|---|
| Supervised per-gate timeout | 45 min default, per-leg override, kills the process tree |
| Wall clock per issue | 6 h |
| Live minutes per issue | 180, with recovery and qualification accounted separately |
| Live runs, per phase | reproduction 1, candidate ladder 2, control run 1, re-record proof 1, rebase re-gate 1 |
| Subagent dispatches | 60 |
| pi calls | 20 |
| Plan tasks | 12 |
| Red-to-green per task | 3 |
| Rebase re-gate | 1 |
| CI fix | 1 |
| Discoveries filed per issue | 5, charged only after a successful create |
| Per loop | `--max-issues` default 3, durable across ticks |

The per-gate timeout was missing from an earlier draft and is the one that matters most: without
it a hung `altool` call consumes the whole six-hour budget while the supervisor faithfully
refreshes the heartbeat, so stale recovery never fires. R196 measured real nontermination: single
mutants at 180 s, and eight hangs consuming about 40 of 148 minutes.

A single global "live ladder runs: 3" was rejected because the protocol itself requires at least
four before any genuine retry.

## Ledger and retention

`.agent/issue-N/ledger.md` and `findings.json`, in the worktree, committed after sanitizing.
Sections: claim and classification; assumption probes; the acceptance matrix with its proving test
per item; pre-commitment generations with their reasons; the per-mutant movement table; gate
receipts with exit codes and log paths; red-check receipts; container and environment fingerprints
including the generation; findings register summary; discoveries; and what was not delivered, with
the reason.

Full reviewer outputs, gate logs, unsanitized originals and manifests are retained outside the repo
before the worktree is removed.

## Repo changes

- `scripts/agentflow/` and its tests (fake `gh`, fault injection around every side effect, a
  write-free dry run, lock and lease races, stale recovery preserving the tree, generation
  rechecks, receipt validation, protected-path detection, sanitizer rejection, migration-manifest
  validation).
- A shared **gate receipt** module, and the change to each itest to emit one.
- `compile:fixtures` reports a positive inventory rather than exiting 0 on a skip.
- `assertMatchesBaseline` refuses a missing committed baseline instead of minting one.
- `.claude/commands/orchestrate.md`, `issue.md`, `triage.md`.
- New agents: `issue-triager`, `acceptance-oracle`, `baseline-diff-triager`,
  `precommitment-adversary`.
- Fixes to `al-compiler.md` (alc discovery) and `wiring-completeness.md` (required-field exit).
- `.gitignore` for `.agent/` with single-level re-includes for the two evidence files.
- CLAUDE.md: the doctrine exception authorising two unrequested writes to `master` (the gated
  squash merge and the validated revert), the protected-path list, and the change from "file a
  roadmap item on discovery" to "open an issue and commit a receipt on discovery". Owner-authored.

## Proving the flow

1. Executor unit tests green, including: a stale lease is reclaimed only after the old writer is
   proven dead; a receipt-less leg fails a required gate; a skipped itest is an executor error;
   a deleted baseline is an error, not a re-record; a pre-commitment authored after the first live
   run is refused; a rename entry reconciles ordinal churn while a hidden verdict flip inside it
   does not.
2. `/orchestrate --dry-run` over the current queue: eligibility shown, a ranking, one pick,
   nothing written (verified by `git status`, label listing, lease absence, and an unchanged
   `.agent/runs/`).
3. Container qualification of Cronus284/285 against every frozen baseline.
4. A seeded bounded offline issue end to end.
5. A seeded issue that legitimately moves one mutant, with a correct pre-commitment: outcome 2, a
   two-phase re-record, a merged PR.
6. The same issue with a deliberately wrong pre-commitment: `inconclusive`, control run, no
   baseline write.
7. A seeded issue whose fix breaks a fixture without rebuilding the test app: the manifest's
   artifact hashes must catch what the verdicts cannot.
8. A crash injected between dispatch and completion: the container is not requalified until the
   old writer is proven dead.

## Residual risk

Ranked, with the mechanism rather than the category.

1. **A pre-commitment that is honest in form and wrong in belief.** The executor proves it was
   committed first and that it matched. It cannot prove it was believed. The mitigations are the
   pre-commitment adversary, the control run, and the fact that a wrong prediction is
   `inconclusive` rather than fatal.
2. **An acceptance oracle that encodes the same misreading as the issue.** The red-check then
   passes honestly. Separating the oracle from the implementer reduces the correlation; a probe
   against real BC removes it for platform claims, which is why `Resolution-mode: measurement`
   exists.
3. **Contamination arising after qualification but before the seal.** The generation, the artifact
   hashes and the final clean-state probe narrow the window; they do not close it.
4. **Migration deduplication losing decisive negative evidence.** Mitigated by the manifest and by
   refusing every relation except `exact` automatically.

## Two defects found while writing this spec

Both are independent of the orchestrator and worth filing on their own:

1. Every env-gated itest exits 0 on its skip path, so `bun run itest:tables` without the env var
   is indistinguishable from a pass to any caller reading exit codes.
2. `.claude/agents/al-compiler.md:17` probes only the `bin/win32` alc layout, which R167 records as
   insufficient; `.claude/skills/al-compile/SKILL.md:16` probes both.
