# Observability, interpretation, and the campaign method

Date: 2026-08-05. Status: design, approved for planning.

Every decision here is traceable to something the 2026-08-03 DO live campaign measured
(`docs/campaign/2026-08-03-do/`). Where a decision rests on judgement rather than measurement, it
says so.

## The problem, stated once

**LethAL produces one artifact, at one moment (the end), for one consumer (a human at a terminal).**
Every other consumer — an agent, a watching human, a supervising process, a campaign comparing runs,
CI — is served by accident or not at all.

Measured: `orchestrator.ts` is 3,877 lines and contains **zero** `console.log`/`process.stdout.write`
calls. All user-visible output comes from `report.ts` (1,328 lines) after the run finishes. A rung-2
run took **1,078 s and printed nothing until the end**; its baseline phase alone was 740 s of
silence. Twenty `console.warn` diagnostics in the orchestrator never reach the JSON at all.

Three consequences the campaign hit directly:

- A run that crashes produces **no report**, only store rows. R89's three stranded attempts each
  needed manual sqlite queries to reconstruct.
- Piping run output through `grep` silently swallowed the real error **twice in one session**,
  because stdout carried everything and nothing arrived until the end.
- An agent consumer shelled out to `jq` repeatedly to discover the report's shape, and derived its
  best insight from a raw field — one a weaker reader would have missed.

---

## A. The event stream

**Typed, in-process event emission. The report is folded from those events.**

Explicitly **not** accepted: a durable event store, replay-as-rebuild, or the event log as a resume
source. The sqlite store already *is* the incremental record and `--resume` reads it
(`resolveResume`, `orchestrator.ts:1737`). A second durable truth can disagree with the first, which
is R54's shape reborn.

### Why fold rather than bolt progress on

`BuildReportInput` (`report.ts:612-675`) is **already an event log flattened into a bag**. Every
field is a fact learned at one moment: mutation-set generation, test discovery, baseline, deploy,
scoring, teardown. The refactor names moments the code already has; it invents no structure. Roughly
19 input fields map onto ~12 event types.

The halfway option — keep `buildReport`, add progress prints — permanently creates a **second
accounting**: every progress line states a quantity the report restates, and the two drift. `report.ts`
has ~35 sites that recompute what the orchestrator already knew. **R54 is the measured cost of that
class**: a resumed run's `mutantsMs` summed durations of verdicts the resume *carried*, reporting
2,200.4 s of mutant time inside a 2,109.7 s run. The guard today is a forgettable
`.filter((o) => o.carried !== true)` at `report.ts:865`.

### The fold throws; it never defaults

`BuildReportInput` deliberately makes fields required — `untargetedTriggerCount` is a required
`number` because "an absent tally and a measured zero must never look alike" (`report.ts:666`). A
naive fold turns every missing event into zero/false/empty, industrialising this project's signature
bug across the whole report.

So the fold is a state machine whose `finalize()` **throws** unless the mandatory events arrived
(`mutation-set-generated`; `baseline-finished` OR `quarantined`; `session-finished`). Event payload
fields stay required. The quarantine path is modelled explicitly, never reached by defaulting.

### Carried verdicts get their own event, with no duration field

`mutant-carried { mutantId, verdict, fromRunId, priorDurationMs, coveringTests }` — distinct from
`mutant-scored { …, durationMs }`. Never replay the prior run's events: the current code deliberately
gives a carried verdict **this** run's covering tests and attribution
(`orchestrator.ts:2543-2549`), because the prior run's came from a different artifact.

`mutant-carried` has **no `durationMs` field at all**. Prior cost lives only in `priorDurationMs`, so
the fold cannot sum it into `mutantsMs` even by accident. **R54 becomes unrepresentable rather than
guarded.** Same treatment for `mutant-skipped-stranded` — its own type, not an error-verdict special
case.

### Invalidation is an event; verdict lines are provisional

`invalidateBatchVerdicts` (`orchestrator.ts:2769/2780/2869`) rewrites already-recorded verdicts on
lease loss, and an NDJSON line cannot be un-printed. So `batch-invalidated { batchIndex, reason }` is
its own event, the fold applies it, and the stream contract states plainly: **verdict lines are
provisional until `session-finished`.**

### Ordering, versioning, subscribers

Emission serialises on the JS event loop, but arrival order is completion order. Keep the final sort
(`orchestrator.ts:2901`) so the folded artifact stays deterministic, and stamp a monotonic `seq` on
every event so a crash-truncated stream is detectable. A first-line header event carries its own
`streamSchemaVersion`, independent of `REPORT_SCHEMA_VERSION`, with the rule **consumers ignore
unknown event types**.

Three subscribers:

| subscriber | destination | purpose |
|---|---|---|
| human renderer | **stderr** | phase lines + heartbeat during the run |
| report fold | in-memory → `SessionReport` | the authoritative artifact |
| NDJSON sink | `--progress-out <file>` | agents, CI, crash diagnosis |

stderr matters: progress must never mix with the report on stdout. That is what made `grep` eat the
real error twice.

The 20 orphaned `console.warn` diagnostics become warning events, so they land in **both** the stream
and the folded report, where today an agent reading the JSON never sees them.

---

## B. `lethal explain` — the interpretation layer

A **projection of the finished `SessionReport`**, not a stream subscriber. Raw events and
interpretation have different stability contracts: events need a frozen machine schema; interpretation
is prose that must be free to improve.

### The decisive fact: promote, don't author

The rung-3 agent's prize insight already exists in the code, verbatim, at `selection.ts:141-153`:

> `object` — FALLBACK 1. The tests executed something in this OBJECT; whether they reached the
> mutated member is unknown. "Covered but survived" here may be no finding at all, and **telling an
> agent to strengthen one of these tests can send it chasing a test that never ran the code.**

That is literally the trap the campaign pre-committed as #1 and the agent re-derived at **$18.56** —
sitting in a doc comment beside a citation of R29's ten false survivors, which the report cannot
emit.

So the danger is not "prose about data rots". It is: **the prose lives where the rule lives, the
projection cannot reach it, so someone writes a second copy that rots.** The fix is promotion.

### The mechanism: keyed, co-located, based

An interpretation may exist **only if**:

1. **Keyed** to a machine value the report already carries — an enum variant, a caveat flag, a
   computed field. Never freestanding. The projection emits the machine value as a field beside the
   prose (per-survivor `executionProven: false`, derived from `attribution !== "exact"`), so prose is
   a caption on a computed predicate.
2. **Co-located** as an exported constant in the module owning that value —
   `Record<CoverageAttribution, Interpretation>` from `selection.ts`,
   `Record<Caveat, Interpretation>` from `report.ts`. Adding a variant **fails to compile** until its
   interpretation is written; deleting one takes the dead prose with it.
3. **Based** — a `basis` field naming its evidence, adopting the rule the report already enforces at
   `ExecutionContext.basis` (`report.ts:182-184`: "Never a bare claim"). A unit test asserts every
   emitted basis **resolves**: the roadmap row exists, the measurement file exists.

**Prerequisite refactor:** `caveats` is `readonly string[]` (`report.ts:103`) with 11 free
`caveats.push(` literals. Promote to a `Caveat` string-literal union. This also means the projection
never restates a caveat — it emits the shared constant keyed on the flag, so there is exactly one
statement of each fact.

**The honesty clause, stated plainly:** semantic drift — `object` becoming precise while keeping its
name — is **not** mechanically provable against prose, and no test here pretends otherwise. Two real
defences: co-location (whoever changes `byObject` precedence is editing the file whose constant states
the interpretation), and a tripwire test pinning the behavioural premise — a fixture where the
covering test provably does not execute the mutated member yet attribution returns `object`, with a
comment naming the constant to re-review if it ever moves. The R70 pattern: you cannot assert "never
regresses", you plant a detector where it would move.

### What ships, and the line that decides

**Ships** (all keyed, all measured): attribution semantics (R29); site-vs-deployed dedup (R92);
caveat gating including R55's consequence ("baseline-red dropped N tests from the green set; mutants
covered only by them read `no-coverage` — resolve before reading survivors"); execution-context
consequences (R60, 0.3% lower bound); carried/resumed provenance; stranded-vs-timeout semantics.

**Refused:** "surviving `remove-setrange` is often equivalent" and its class.

The line is **target-semantics vs tool-mechanics**, not "no operator-specific advice":

- An equivalence guess is a claim about the **customer's code** that no LethAL machinery measures.
  There is no report field to key on, so clause 1 excludes it automatically.
- "`void-method-call` on a query-shaping call produces SLOW mutants, not hung ones — raise
  `--mutant-timeout-ms`" is a claim about **LethAL's own timeout machinery**, keyed on the verdict
  distinction, measured twice with a within-run control (R91). Refusing it would withhold the finding
  that cost three stranded runs.

This matters because the campaign's own pre-commitment carried the equivalence guess and **rung 3
disproved it** — the agent killed those mutants legitimately with decoy rows. Future proposals get
decided by the mechanism, not by whoever remembers rung 3.

### Meaning, not instructions — about the target

About the **target**: state what is proven, what is not, and what the data cannot support. Never what
test to write. The weak reader's failure (~87 pointless tests) is prevented by a meaning statement
with its entailed negative — "execution unproven; do not treat these as assertion gaps". The strong
reader's win was the **reframe**, and a projection saying "strengthen these 19" would have anchored
against it — the campaign's own pre-commitment framed "kill survivors" and the agent did better by
ignoring that frame.

About the **tool**: be fully prescriptive. Those steps are deterministic and LethAL's own domain —
"this file's guard count exceeds the measured publish ceiling; it cannot be published" (R90),
"stranded error, not a verdict — re-run with `--mutant-timeout-ms` raised" (R91).

### Contract

Split, and stated in the output itself. **Structure** is versioned and stable under its own
`EXPLAIN_SCHEMA_VERSION`, with the header also recording the `REPORT_SCHEMA_VERSION` it derived from.
**Prose strings are explicitly non-contractual** — consumers must not parse them; they may improve
without a version bump. The keying rule makes that safe rather than aspirational: every machine-usable
atom appears as a structured field by construction, so no consumer has a reason to regex prose.

---

## C. Tool features

### C1. Raise the mutant budget default (R91)

`MIN_MUTANT_BUDGET_MS` 30_000 → **180_000** (`orchestrator.ts:86`), comment citing R91, a test
pinning it. The flag stays for outliers.

**Adaptive/derived-from-baseline is rejected as false precision.** The stranding mutants had a **0 ms**
baseline: deleting a `SetCurrentKey` blows up the *query plan*, and no multiplier of that test's
baseline duration predicts a scan. Only a generous absolute floor covers the class.

The asymmetry decides the number: too low costs a strand — quarantine, ~10 min recovery, everything
behind it blocked, **measured three times**. Too high costs the rare genuine hang (1 in 148) taking
180 s instead of 30 s to score `timeout-killed`. Catastrophic versus bounded and linear.

### C2. The publish ceiling as a measured bracket (R90)

A limit nobody can know in advance must not be a constant. Three parts, in dependency order:

1. **Fix R65 on this path first.** The publish timeout is a bare `Error` with no message at
   `bcdev-backend.ts:468` — which is exactly why nothing can learn from it. It becomes a typed error
   carrying `guardCount` and `file`.
2. **Persist per-tier publish outcomes** — `(guardCount, ok | timed-out)`.
3. **Preflight refusal:** before publishing, any single **file** whose guard count ≥ the tier's
   smallest recorded failure refuses up front, naming the file, its count, the measured bracket
   ("331 timed out on this tier 2026-08-05; 229 published"), and the levers — **stated as
   measurement, never as law**. A fresh topology still eats one honest failure; the refusal prevents
   the second waste.

Bundle with R92: `--dry-run` prints per-file guard counts descending, with the known bracket and both
site and deployed counts. Same surface, one change.

### C3. Probe the environment first, then `lethal doctor` (R34)

The refusal is already correct; it fires *after* generate has burned time. Move the environment status
probe to the front of the session, message naming the restart command.

Then `lethal doctor <config>`: read-only checks — environment status, lease/op-marker state,
quarantine record, control-app version (R28's machinery exists), tool paths — exiting non-zero with
named causes. Cheap, because every check already exists as a scattered refusal; doctor runs them
without wasting a publish.

### C4. Recovery: fix the tool bug, keep the skill (R51's neighbourhood)

`force-reset-lease`/`clear-quarantine` must resolve env-tool configs the way `run` does. Today they
read the `bcdev` section directly, so an env-tool config needs a materialized copy with
`packageCachePath` injected by hand — a tool bug wearing a skill costume. Fix it, then delete the
bundled `materialize-config.ts` from `recover-tier`.

The **restart-before-reset ordering stays a user-invoked skill**, unchanged. Its precondition — "the
stranded AL is actually dead" — is guaranteed by a restart the tool cannot verify happened *after* the
strand. It can check `Running`; it cannot check ordering. **Do not build a one-shot `lethal
recover`**: automating that precondition away is precisely the unsafe part.

---

## D. `lethal campaign` and the skill

### D1. Finish the machinery that exists

The gate drivers are already code — `campaign-anchors.ts` (pure predicates), `campaign-anchors-run.ts`
(I/O driver), `campaign-freeze.ts` (freeze + per-mutant diff) — built because "an operator running
them ad hoc against a live billed environment is where 'I printed the results and they looked fine'
replaces a gate" (`campaign-anchors-run.ts`'s own words).

But `campaign-freeze.ts:37` pins `RECORDS_RELATIVE = "docs/campaign/2026-08-03-do"`. The next campaign
forks it or edits a constant.

Deliverable: parameterise the records directory behind a small campaign manifest, promote the three
drivers to `lethal campaign freeze | anchors | compare`, and add the check that enforces the
discipline's spine:

> **`freeze` and `anchors` REFUSE if the pre-commitment or anchor file is uncommitted or dirty in
> git.**

"Committed before the run" becomes machine-checked instead of resting on the operator's honesty. It is
a one-liner against `git status`, and it is tool-shaped by the project's own criterion: deterministic
verification, not judgement.

**Rejected:** `lethal campaign init` writing empty templates. The value of those files is their
content and their git-history ordering; a scaffold supplies neither.

### D2. The skill

Trigger: the user asks to run LethAL against a real project or customer app, to measure a real
codebase's suite, or to compare two live runs — and on writing any pre-commitment. Model-invocable
(unlike `recover-tier`, it mutates nothing itself), but its description must say it drives live,
billed environments.

**The method — five rules, each carrying the measured error that produced it:**

1. **Pre-commit expectations to a committed file before the run.** This is what made the campaign's
   two errors visible *as* errors.
2. **Assert cardinality before any anchor reads the report.** Caught the site-count-as-cardinality
   error (R92).
3. **Gates carry forward across rungs unless retired in writing BEFORE the run.** This rule exists
   nowhere today. It is the fix for rung 2's recorded plan defect — rung 1's "baseline green" anchor
   was silently not carried, and the rung came back `baseline-red` with no gate to catch it.
4. **Retire, don't retune** — with the replacement named. The stale coverage anchor was retired and
   superseded by the per-mutant baseline, not rewritten into a tautology.
5. **Record negative results.** The unreproduced stale-test-app finding is the model: "R31's detector
   was not exercised, and no hole in it is demonstrated."

**Also in the skill:** the rung ladder (mechanics → repeatability → consumer, each gated before the
next); module selection by **measured coverage**, not name-matching (rung 2's 66% no-coverage);
narrow-tests-not-mutants as the cost lever (R45, structural — baseline was 69% of rung 2's wall
clock); and the temporary "prefer `--resume-run <id>` over bare `--resume`" workaround **with an R89
pointer so it dies when R89 closes**.

**Why this is not CLAUDE.md restated:** CLAUDE.md's rules govern *code changes* — red-check a fix,
per-mutant gates on frozen fixtures. These govern *measurement campaigns*, and rules 1–5 appear
nowhere in it. The empirical proof they are not redundant: the campaign followed CLAUDE.md's discipline
throughout **and still made both errors**; the campaign gates caught them because they encode
something CLAUDE.md does not.

---

## Out of scope: the Continia provisioning runbook

The campaign's provisioning knowledge — bare-sandbox `deps install`, the publish-before-deps ordering,
`continia deploy`'s AppSourceCop failure, alc 17 living inside `continia.exe`, replacing catalogue
symbols with a local build for a promotion branch — is **one customer stack's facts**, and two of the
five will age with `continia.exe` releases LethAL cannot test.

It goes in a runbook committed beside the campaign records, or in the CLI repo. The LethAL skill stays
customer-agnostic and says only: *your target's stack has a provisioning runbook; read it first, and
the publish-before-deps ordering class is the kind of thing it must state.*

---

## Migration order and the gate

1. Define the event union and emitter.
2. Route `record()` and the phase boundaries through it — `record()` stays the single choke point that
   writes the store row **and** emits the event, so no call site can do one without the other.
3. Rewrite `buildReport` as the presence-asserting fold, driving the existing R54-class unit tests
   through synthetic event lists. Those tests already drive `buildReport` directly, so the strategy
   survives.
4. stderr renderer.
5. `--progress-out` NDJSON.
6. `lethal explain` projection.
7. C1–C4, then D1, then D2.

**The gate, non-negotiable:** this refactor touches how every verdict reaches the report. The frozen
itests must hold **per mutant** — `itest:bcdev` 3/10/3, `itest:tables` 109/17/10 plus its named
baseline-failure assertion — and a before/after report on the same fixture must be **field-identical**.
Run that equality check *before* and *after* step 3, not only after: it is the entire safety net.
