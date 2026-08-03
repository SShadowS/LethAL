# A phased live campaign against Continia Document Output, ending in an agent reading the report

Date: 2026-08-03. Status: design, approved for planning.

Revised after an adversarial review that found the first version **not safe to implement**: both
pre-committed numbers at the base of the ladder were wrong, the per-mutant reference rung 1's
primary gate consumed does not exist on this machine, and rung 1 as written tripped its own
two-quarantine abort deterministically. The architecture survived unchanged; the gates did not.
Every number below was re-derived or re-verified against the repository on 2026-08-03.

## What this is

Four rungs of increasing scope against a real app, each with a pre-committed gate, ending with a
real Claude Code agent — a separate process, its own context — reading a real LethAL report and
trying to make survivors die.

Two questions are being answered, in this order:

1. **Does LethAL work on a real app when driven end to end, rather than in the pieces already
   measured?** Every DO number this repo holds came from a targeted measurement (R40's site census,
   R44's publish scaling, R45's baseline narrowing, R69's coverage classification). No one has run
   the ladder from provisioning to verdicts to a fix.
2. **Is the report legible to the agent that has to act on it?** Nothing in `ROADMAP.md` treats the
   report as an interface. `SessionReport` carries `notInstrumented`, `survivorsByProcedure`,
   `guardObserved`, `coverageAttribution`, `validity.reliability` and a caveat list — all of it
   written for a careful human reader, none of it ever tested on a consumer.

## Non-goals

- **Not improving DO's test suite.** Tests the rung-3 agent writes are evidence. They live in a
  throwaway worktree and are never proposed upstream.
- **Not a full-app score.** R48 measured the default DO invocation at 19,832 sites; at the measured
  ~19.5 s/mutant that is days. The ladder stops at one module.
- **Not a fix campaign.** A gate failure produces an `R<n>` row and an explicit decision to fix or
  continue. Fixing everything found is out of scope by construction.

## The gate rule

**Every rung writes its expected result to a file before its run starts.** This is the repo's own
method and it exists because results get rationalised otherwise: R13's thresholds were committed at
`349901a` before a single candidate was counted, R69's 5% threshold at `49c2ec0` before the number
existed, R82's 30 per-mutant verdicts before the gate ran.

**A gate failure blocks the ladder.** It does not get waved through as "close enough" — the same
rule `CLAUDE.md` already applies to a differing live-gate verdict.

## The ladder

| rung | goal | gate |
|---|---|---|
| **0 — plumbing** | Fresh Continia environment running DO; LethAL Control published and harness-verified; DO's test app published; the target parses **and compiles instrumented** | `--dry-run` reports **176** mutant sites; the instrumented project compiles offline under the chosen in-range selector ids; harness verification passes; compiler resolves to alc 17 |
| **1 — smoke** | Establish a per-mutant baseline on real code that later rungs can be compared against | **Two runs, verdict-identical per mutant**, run 1 frozen per-mutant to a committed file, plus four falsifiable prose anchors. Determinism *and* a coarse regression payload — see below for why the historical per-mutant anchor cannot serve |
| **2 — module** | One real DO module, several publish batches | Completes without an unexplained quarantine; **survivor count > 0**; every survivor has `guardObserved === true`; `notInstrumented` accounting reconciles against a stated oracle |
| **3 — agent** | A real agent reads the rung-2 report and tries to kill survivors | Pre-committed prediction of what it should attack and what it should refuse, diffed against the transcript; **every claimed kill red-checked** |

## Rung 0 — provisioning

### Worktree

The user pulls `U:/Git/do-rel2` (currently on `development/dfc491cc-814e-4739-b23f-6f647f140d38-promotion`
with an untracked `.promotion-state.json`) — their repo, their call, done by them and not silently.
Then:

```bash
git -C U:/Git/do-rel2 worktree add U:/Git/do-lethal -b lethal/campaign-2026-08-03
git -C U:/Git/do-lethal rev-parse HEAD    # RECORD THIS
```

LethAL runs `--project U:/Git/do-lethal/Cloud`; the test app builds from `U:/Git/do-lethal/Test`.
Undo for the entire experiment is `git worktree remove`.

**The worktree commit is pinned in the rung-0 record**, because the ladder's first step is a user
`git pull` and every later "did a verdict change?" question is unanswerable if the source underneath
it moved. (As of 2026-08-03 no commit has touched `Cloud/` or `Test/` since 2026-07-27, and
`Codeunit 6175297` last changed 2025-12-01 — so pinning costs nothing today and is the only thing
that keeps it costing nothing tomorrow.)

### Environment

Create fresh from profile `c803cb93-a8e4-4fb1-b61f-e5f60f17b43a` — the profile `lethal-do-trial`
(`f19aca88`) was created from, BC 28.0.0.0, `NavUserPassword`, on `demoportaldev.continiaonline.com`.

```bash
cd U:/Git && ./CLI/continia.exe env create --name lethal-do-campaign \
  --profile c803cb93-a8e4-4fb1-b61f-e5f60f17b43a --json
```

**Fresh rather than reusing `f19aca88`.** That environment still carries whatever the R69 coverage
work published. R31 is **done** — `staleTestApp.missingTests` now detects a published test app
missing tests the source declares — but the shape it cannot see is **R56's**: an older-but-COMPLETE
published build, where nothing diverges and the run measures the wrong binary while looking healthy.
A fresh environment is the only mitigation for that shape, which is what makes the creation wait
worth paying.

`continia.exe` holds its own login: `env list` and `env get --json` both answered on 2026-08-03 with
no `CONTINIA_API_TOKEN` set in the shell. Whether LethAL's `envTool.env` block still needs the token
passed through is **unmeasured** and rung 0 settles it.

### Selector ids — a blocker, not a detail

DO's `Cloud/app.json` declares `idRanges: [{ from: 6175271, to: 6175468 }]`. `DEFAULT_SELECTOR_IDS`
(79197–79199, `cli.ts:80-84`) is outside it, so `validateSelectorIdsForProject` refuses. This is
exactly the scenario R3 was closed for, which also means the earlier DO sweeps already solved it —
**recover the config those runs used before re-deriving three ids**, then validate the chosen ids
against the range and against the codeunit ids DO already declares (all three injected objects are
codeunits, so the declared-codeunit set is the right collision set — `id-ranges.ts:65-90`; there is
no separate table-id hole).

**`--dry-run` does NOT exercise this.** It returns at `cli.ts:2058-2060`, before `resolveSession`
reaches `validateSelectorIdsForProject` at `cli.ts:1704` — a DO dry-run today runs happily under the
out-of-range default ids and is not refused. So a gate 0 built only from a dry-run would declare the
plumbing sound and hand rung 1 the first execution of the id path. Gate 0 therefore carries an
explicit instrumented-compile item; see below.

### Compiler

`bcdev.alcPath` pins alc **17**. DO declares `runtime 17.0`, and R43 measured that alc 18 writes OPC
part names with single-encoded spaces, producing a package BC 28 cannot load.

### Config shape

An `envTool` config at `U:/Git/do-lethal/lethal.config.envtool.json`, gitignored, secrets only as
`${VAR}` placeholders — the `no-committed-secrets` PreToolUse hook enforces this and the rule behind
it is standing. Shape per `fixtures/README.md` §"Running against an external environment tool", with
`publishApps` naming the compiled DO test app and a `selectorIds` section carrying the in-range ids.

### Gate 0

Blocks rung 1. All five must hold:

1. LethAL Control publishes to the new environment and harness-verifies (R25/R28: a stale local
   `lethal-control.app` fails with a confusing `clientProtocol` rejection — build it, do not assume).
2. DO's test app compiles and publishes. **Known exclusion:** the 2026-07-27 run record notes the
   test app excludes `CDOTelemetryTests` (pre-existing source/dependency mismatch, cited again in
   R53's DO-route rejection). Building `Test/` as-is may not compile; the exclusion is applied
   deliberately and recorded, not rediscovered mid-run.
3. The resolved compiler is alc 17. **Observable:** the resolved `alcPath` is read back from the
   run's own config resolution (`resolveToolPaths`, `cli.ts:1098-1102`) and its version confirmed by
   invoking it — not inferred from the fact that a path was configured.
4. `lethal run --dry-run --only "Al/Codeunit/Codeunit 6175297 CDO Send Cust. Statement Mgt.al"`
   reports **176 mutant sites**, 1 file, 1 batch.
5. The instrumented project **compiles offline** under the chosen in-range selector ids. This is the
   item that actually exercises `validateSelectorIdsForProject` and the AL0297 class; without it
   nothing in gate 0 touches the id path at all.

   **This is a BUILD item, not a checkbox — no single invocation does it today.** `--dry-run`
   returns before validation, a real `lethal run` compiles but cannot stop before publish, and there
   is no `--compile-only` (verified: zero occurrences in `cli.ts`). It needs a ~40-line script
   gluing four pieces that are already exported and already driven standalone elsewhere:
   `validateSelectorIdsForProject` (`cli.ts:224`), `generateMutationSet` + `writeInstrumentedProject`
   (driven outside the CLI by `scripts/measure-testpage-exclusive.ts`), `ArtifactCompiler` +
   `defaultArtifactIo` (driven outside the CLI by `scripts/probe-r58-differential.ts:222-289`), and
   alc resolution via `resolveToolPaths`. Left as a bare checkbox it gets "verified" by running
   something that does not exercise the path — which is this finding's original disease.

6. **The hosted hang-stop probe.** `--stop-hung-sessions` decides M0013's pre-committed branch and is
   unmeasured on the hosted topology, so it is measured **in gate 0**, not in rung-1 prose — a probe
   outside the gate is a probe that gets skipped. Implementation: publish `fixtures/sandbox-hang`
   (committed, own app id and id range, collides with nothing) to the fresh environment and run
   `itest:hang`'s ON leg through an envtool config. That is committed machinery measuring exactly
   "does the held-request stop survive the hosted proxy", and it touches no DO code. Note this is
   **not** implementable against DO itself with existing flags: `--only` selects files, not mutants,
   so scoping to the codeunit runs every covered mutant.

**176 is today's number and is re-derived at plan time.** It is not the historical 138 or 105. Its
composition against 138 is **partly unexplained, and that is stated rather than smoothed over**:

- **13 are certainly new by operator name** — `swap-call-arguments` 10 (`f9e055c`, 2026-08-03) and
  `remove-commit` 3 (`9b541cf`, 2026-07-31), both after the differential.
- **The remaining 25 are unreconciled.** The obvious explanation — "the Tier-2 record-method set is
  new" — is **false**: the Tier-2 scaffold registered at `fbda298` and `RemoveSetRange` landed at
  `50a7118`, both on **2026-07-26**, before the 2026-07-28 differential. So those mutants were, or
  should have been, inside the 138. The gap is roster or behaviour drift between 2026-07-26 and
  today, and **reconciling it exactly is impossible without the lost per-mutant record** — which is
  one more reason per-identity comparison to 07-28 is dead rather than merely inconvenient.

Any operator landing between this spec and the run moves the number again, and a pre-commit that
silently drifts is worse than none — so it is regenerated and re-committed as the plan's first
action, with its per-operator composition recorded.

## Rung 1 — smoke

**Target, recovered from the run record rather than reconstructed:**

```
--project U:/Git/do-lethal/Cloud
--only "Al/Codeunit/Codeunit 6175297 CDO Send Cust. Statement Mgt.al"
--tests-only "Src/AutomaticDocuments/**"          # narrows 1,246 tests -> 56
--stop-hung-sessions                              # see M0013 below
```

Note the project path is the **worktree**, not `U:/Git/do-rel2` — the whole point of rung 0's
worktree is that no run touches the user's checkout.

### The gate is determinism, and the historical anchor cannot replace it

**The primary gate: two runs, verdict-identical per mutant, run 1's PER-MUTANT verdicts frozen to a
committed file.** `itest:bcdev` and `itest:alrunner` do both halves — they run twice *and* compare
against a committed frozen baseline file — and this campaign needs both for the reason in
"Preserve the record" below.

This is a demotion from what the first draft of this spec asserted, and the reason is not a
preference:

- **`4 / 8 / 92 / 1` over 105 is not a complete run's result.** It is what the 2026-07-28 fenced run
  *reached* before M0013 latched the session and the tail was lost — "105 of 138"
  (`docs/measurements/README.md:313-316`). The deployed count that day was 138. `docs/measurements`
  says outright: *a clean, COMPLETE fenced DO run does not exist*.
- **Today the same scope generates 176.** Neither 105 nor 138 is comparable to it.
- **The per-mutant record is gone.** The 2026-07-28 differential was never bench-recorded
  (`docs/benchmarks/runs.jsonl` jumps 07-27 → 07-31), `scripts/probe-r58-differential.ts` wrote its
  dumps to a scratch `--out` and its store to a `mkdtemp` sqlite, and no surviving temp dir holds a
  DO run. Only the aggregate and the transition counts survive, in prose.

So a "compare per mutant against 2026-07-28" gate consumes a reference that does not exist — and its
natural implementation (*join today's run to the reference by identity, count mismatches*) reports
**0 mismatches against a missing reference and PASSES**. That is this repo's signature bug, written
into a gate whose entire job is to prevent it.

**Therefore, a hard rule for any comparator built for this campaign:** it asserts it loaded exactly
*N* reference verdicts, with *N* pre-committed, and **throws** otherwise. Never `if (!ref) return
ok`. This applies to rung 1's run-to-run comparator and to every later one.

**Do not anchor on `16 / 86 / 15 / 21` either.** Those are the same codeunit's **hub** numbers
(`coverageMode: "procedure"`, the legacy escape hatch), against a **red baseline of 12 fail / 44
pass**, and R63 established 77 of the 86 survivors were **vacuous** — scored against tests that
never executed the mutated code. They are reproducible (the run record shows them reproduced exactly
on a rebuilt environment), which makes them tempting and no less wrong.

### The regression payload: four falsifiable anchors, not a taxonomy

An earlier revision put a four-class "deviation taxonomy" here, keyed to the 2026-07-28 reference.
**That was a rationalization door and mostly dead text**: two of its classes (*no-reference*,
*shared-identity-changed*) require per-identity 07-28 verdicts, which the section above establishes
are gone — so nobody can prove any given identity was among the 105, and any inconvenient deviation
could be filed as "no reference for that one". Unfalsifiable. It was also orphaned: under a
run-1-vs-run-2 gate the other classes are impossible by construction.

Source drift survives, promoted to what it actually is: **a validity precondition**, asserted before
the run (worktree commit == the pinned rung-0 commit), not a way to explain a result afterwards.

The regression payload comes instead from four anchors that **survive in committed prose**, need no
per-mutant reference, and are each falsifiable:

| # | anchor | catches |
|---|---|---|
| 1 | **Fenced baseline is 56/56 green** | session/runner regressions; binary, stated in the record |
| 2 | **Coverage split by LOCATION**: every covered (non-`no-coverage`) mutant's site lies inside `SendPeriodStatements` or carries object-level attribution; every mutant outside it is `no-coverage` | the R29/R63 false-survivor class, on real code. The record pins it exactly — *"its 13 covered mutants are exactly `SendPeriodStatements` (12) plus one object-level entry"* |
| 3 | **M0013's identity scores per the branch above** | the hosted-stop question |
| 4 | **killed >= 1** | a total collapse of scoring; the 07-28 fence killed 4 in that procedure |

Anchor 2 is deliberately **location-based, not count-based**, so it survives roster growth: a mutant
from a new operator landing inside `SendPeriodStatements` is allowed to be covered. Every anchor is
a committed constant, so the throw-on-missing-reference rule above is trivially satisfiable for all
four.

Determinism plus these four is a genuine, if coarse, regression gate. It is weaker than a per-mutant
reference and the spec says so rather than implying otherwise.

### M0013 will hang, and the spec must plan for it rather than be surprised

M0013 is `negate-conditional` on `until DOCustSetup.Next() = 0`; it is covered by the
`SendPeriodStatements` tests, which are inside the 56. It stranded at both the 30 s and 120 s
budgets.

**Resume does NOT re-execute it.** `buildResumeIndex` marks stranded identities (`resume.ts:62,95-97,152`)
and the mutant loop skips them, recording `error` with the note *"not re-run on resume … It is NOT
scored either way"* (`orchestrator.ts:2566-2578`); `--retry-stranded` is the explicit opt-in to
attempt them anyway, and the resume banner states all of it (`orchestrator.ts:1799`). So the flagless
sequence is: strand → quarantine **#1** → recover → `--resume` → M0013 **skipped and unscored** →
tail completes. One quarantine, not two.

**Never pass `--retry-stranded` mid-gate.** It converts the safe skip back into the re-strand loop.

So:

- Rung 1 runs with **`--stop-hung-sessions`** — the flag R53 built for exactly this mutant — and
  therefore **no quarantine is expected at rung 1 at all**. There is no exemption and no allowance:
  a quarantine at M0013's identity means the hosted stop did not work, which is a finding, not an
  expected cost.
- **M0013's verdict is pre-committed as a BRANCH**, decided by gate 0's probe, not assumed:
  - *stop confirmed on hosted* → `timeout-killed`, and the determinism comparison covers all 176.
  - *stop unconfirmable* → an `R<n>` row is filed, each fresh run strands once at M0013's identity,
    recovery is `--resume` (auto-skip, unscored), and the comparison covers **175 plus exactly one
    named excluded identity, with that cardinality asserted**.
- **Identity is the code's own key** — `astHash` + codeunit + operator (`resume.ts:106`) — never an
  eyeballed M-number. M-numbers shift across re-batching (R47 deliberately excludes
  `maxGuardsPerBatch` from the resume fingerprint), so an M-number match can both false-match a
  genuinely new hang and false-miss a real repeat.
- `--stop-hung-sessions` is **unmeasured on the hosted topology** (R53's own caveat; it was measured
  against a container). At a ~30–60 s budget the held request resolves well inside the proxy's ~362 s
  window, so it plausibly works — *plausibly* is the operative word, which is why gate 0 probes it
  (item 6) instead of the ladder resting on it.

Expect more of this at rung 2, not less: 19 `remove-setrange` mutants now sit in this loop-heavy
codeunit, and deleting a `SetRange` that bounds a `repeat … until Next() = 0` is a near-hang shape on
real data.

Cost anchors for planning, all measured on DO: total 1065 s unnarrowed (generate 0.7 + deploy 40.8 +
baseline 863.8 + mutants 151.9 + overhead 8.5), 231.2 s with `--tests-only` (baseline 744.8 → 25.0
s); publish 36.8 s per batch. Rung 1 pays that twice.

## Rung 2 — one module

**The module is chosen by measurement, not by name.** Candidates are ranked offline from R69's
per-test coverage data by sites × test-coverage density, so survivors have a real chance of being
findings rather than dead code. **First confirm that data still exists on disk** — it is another
uncommitted live-run artifact, and if it is gone the ranking silently costs hours of hub
re-measurement. If it is gone, rank on a cheaper offline proxy (sites per file × whether any test
file names the object) and record that the ranking is weaker.

Target size ~500–1500 mutants, several publish batches. **Above 1,000 sites the run is refused by
default** — `LARGE_RUN_MUTANT_THRESHOLD = 1_000` (`orchestrator.ts:106`), R48 — so a module in the
upper half of that band needs `--allow-large-run`, deliberately and recorded.

Gate:

- **A BASELINE quarantine is a gate failure, period.** Only mutant-phase strands have a recovery
  story: a baseline `in-flight-unknown` quarantines unconditionally (`orchestrator.ts:2360-2365`)
  and the stop machinery does not reach the baseline at all — there is no per-test budget there, and
  R69 Task 7 measured the R30-shape `TestPage` baseline hang as deterministic and unrescuable,
  twice. "We can explain it, it's the R30 shape" is precisely the rationalisation this rules out.
  **Screen candidate modules during selection** for covering tests that declare a `TestPage` — a
  cheap grep; the corrected figure is 5 files carrying `TestPage` tests in `do-rel2/Test`.
- A mutant-phase strand scored `timeout-killed` by `--stop-hung-sessions` is an expected outcome and
  not a gate failure. A mutant-phase *quarantine* is one, on the same terms as rung 1.
- **Survivor count > 0.** Otherwise the survivor gate below passes vacuously, and on a module chosen
  for coverage density zero survivors is itself an anomaly worth stopping for.
- **Every survivor carries `guardObserved === true`.** R46 exists because a survivor no instrumented
  guard fired for is not a finding at all, and R29 produced ten false survivors before anything
  distinguished them. **State the weakness at the same time:** `true` is the weak direction —
  `ControlState.IsActive` sets `observedAny` for *any* guard in the artifact, not this mutant's, so
  `true` does not prove *this* mutation was in play. `false` is the strong signal, and it is the one
  that must never appear on a survivor.
- **`notInstrumented` reconciles against a genuinely INDEPENDENT oracle.** Not the dry-run: that
  deliberately mirrors the session's own accounting (R5, same producer), so comparing them is a
  producer against itself. The oracle is a file-kind census taken by object-header scan over the
  module's files, computed outside LethAL's spec pipeline. R40 left a recorded ambiguity in exactly
  this accounting under `--only`, which rung 2 uses, so the oracle is named in the plan before the
  run rather than negotiated after it.

The rung-2 report is the input to rung 3 and is archived verbatim.

## Rung 3 — the agent

### Harness

`claude -p`, not the Agent SDK. A separate process is a genuinely cold context and is the surface a
real user's agent has; the SDK's advantages (`maxTurns`, a `canUseTool` veto callback) only pay off
if the experiment needs repeats across models or prompt variants. Escalate only if the first run
raises a question that needs N trials.

```bash
claude -p "<task>" \
  --output-format stream-json --verbose \
  --session-id <fixed-uuid> \
  --max-budget-usd <n> \
  --allowedTools ... --disallowedTools ...
```

The stream-json transcript **is** the measurement: every tool call in order, replayable, rather than
a narrated impression of what an agent would do. `--max-budget-usd` was verified against the
installed CLI's `--help` (exists, `--print` only). `--max-turns` is SDK-side and has no CLI flag.

`<task>` is authored at rung 3, from the actual rung-2 report — it cannot be written earlier without
inventing survivors. `<fixed-uuid>` and the budget are set then too. What IS fixed in advance is the
prediction below, which is written before the agent starts and after the task text exists.

### Contamination, accepted deliberately

Run without `--bare`, so the agent inherits this machine's global `CLAUDE.md`, plugins and skills.
`--bare` would give a clean room but also skips hooks, which is how the agent gets fenced; whether
hooks supplied via `--settings` survive `--bare` is unmeasured, and the fence was judged worth more
than the clean room.

**The reading rule this forces, committed now:** the agent is a stronger-than-typical reader, so
**confusion is a hard finding** (even a superpowered agent misread the report) while **success is
weak evidence** (a vanilla agent might still fail). Rung 3 can prove the report is bad. It cannot
prove the report is good.

### Fences

- May invoke `lethal run` only with **both** `--only` and `--tests-only`.
  Note the tension this creates and do not forget it at interpretation time: `--only` selects
  mutants and cannot change a verdict, but `--tests-only` selects **tests** and **can** — R45 models
  the two differently for exactly this reason. So a kill the agent claims under a narrowed suite may
  be an artifact of the narrowing. The red-check below is what catches that, and it must be run at
  the same scoping the agent used **and** unnarrowed.
- May not write anywhere under `U:/Git/LethAL`.
- Bounded by `--max-budget-usd`.
- Works in `U:/Git/do-lethal`, which is a worktree; the user's checkout is never touched.

**These fences are a rung-3 BUILD item, not an existing capability.** No hook enforcing them exists
today. `--allowedTools`/`--disallowedTools` give the coarse cut; anything finer (rejecting a
`lethal run` that omits `--only`) needs a `PreToolUse` hook written and supplied via `--settings`,
and it must be tested against a deliberately-violating prompt before the real run — an unenforced
fence that is *assumed* enforced is worse than none.

### The pre-commitment

Before the agent starts, written to a file: which survivors are genuine targets, which are
equivalent-mutant or `no-coverage` traps, and what a correct reaction to each looks like. The
transcript is diffed against that afterwards.

### Every claimed kill is red-checked

When the agent says its new test kills a survivor, revert that test, confirm the mutant returns to
`survived`, restore. Two measured reasons:

- **R86**: `failure_note` is `NULL` for all 109 killed mutants in the last gate run, so no kill
  records *why* it died. A genuine kill and arm E's length-overflow false kill are indistinguishable
  in the record.
- This repo's signature bug is a test that passes for the wrong reason. An unverified kill claim is
  that bug wearing a success costume.

**Budget the red-check explicitly, because unbudgeted cost is pressure to skip the leg that
matters.** Each confirmation runs twice — once at the agent's own scoping, once **unnarrowed** —
and the unnarrowed leg pays the full 1,246-test baseline (~750 s hosted, inside R44's flakiness
window). At three claimed kills that is roughly an hour of live time. If that is not affordable at
run time, the correct response is to **cap the number of claimed kills accepted for verification**
and say so in the result — never to drop the unnarrowed leg, which is the exact false-kill door this
section exists to close.

## Preserve the record, or this campaign becomes the next one's dead anchor

The 2026-07-28 anchor died because its per-mutant record lived only in a scratch `--out` and a
`mkdtemp` sqlite, and only its aggregate survived in prose. **This campaign is set up to repeat that
exactly** — the run store and reports live in the worktree, and the stated undo is
`git worktree remove`, which deletes them.

So, per rung, before any teardown:

- Every run uses **`--out <json>`** to a path **outside** the worktree.
- **Run 1's per-mutant verdicts are frozen to a committed campaign-records file**, the pattern the
  itest gates already use — not an aggregate in prose.
- The rung's report is archived **before** environment deletion or `git worktree remove`.
- The pinned worktree commit, the resolved selector ids, the alc version, the flag set, and the
  environment id are recorded alongside, since a verdict file without its configuration is another
  unreproducible aggregate.

**Decide up front, not after:** whether a quarantine-resumed completion is an admissible input to
the determinism comparison. `docs/measurements` bars resumed runs from *differential* inputs; a
verdict-only run-vs-run comparison is defensible, but the decision is pre-committed either way.

## Recovery and abort

**The hang is known; the quarantine is not licensed by it.** R53 is live on DO: `negate-conditional` on
`until DOCustSetup.Next() = 0` becomes `<> 0` and never terminates, quarantining the tier and
blocking every mutant behind it. Recovery is the `recover-tier` skill — `env stop`, `env start`,
**wait for `Running`**, `force-reset-lease`, `clear-quarantine`. A restart alone clears neither
piece of state: the quarantine record is a local file, the op marker is a row in the environment's
database.

**Rule: with `--stop-hung-sessions` on, NO quarantine is expected. Any quarantine is a finding.**

An earlier revision carried an exemption here — "the same mutant re-hanging after a `--resume` does
not count twice" — and it is **deleted**, for three reasons, all verified against the code:

- **Its premise was false.** Resume does not re-execute a stranded identity; it skips it and records
  it unscored (`orchestrator.ts:2566-2578`, `resume.ts:62,95-97,152`). The flagless sequence is one
  quarantine, not two, so nothing needed excusing.
- **It excused the wrong thing.** With `--stop-hung-sessions` active, a quarantine at M0013 means
  the hosted stop was unconfirmable — R53's own named caveat, and the single most valuable
  measurement rung 1 can produce. Filing that as "expected" swallows it.
- **It had no identity predicate and no iteration cap**, so it converted a hard stop into an
  unbounded recover-resume loop keyed on an eyeballed M-number that can shift across re-batching.

Recovery, when a quarantine does happen: the `recover-tier` skill, then `--resume`, which skips the
stranded identity and records it unscored. **Never `--retry-stranded` mid-gate.** Each quarantine
gets an `R<n>` row; a second one at the same rung stops the ladder.

Watched, not fixable in flight:

- **R47** — `MIN_MUTANT_BUDGET_MS = 30_000` is a hardcoded floor with no flag or config key reaching
  it, and one slow (mutant, test) pair costs the whole run.
- **R34** — an environment that idles to `Stopped` makes the next run abort. Status is checked
  before each rung, never assumed.
- A severed run resumes with `--resume`; R52's selection bug (an empty run shadowing one holding real
  verdicts) is fixed.
- Environment expiry. A created environment carries an `expiresUtc`; it is read at creation and the
  ladder is planned inside it.

## What this campaign will not tell us

- **Nothing about the 41% of DO that is never instrumented.** R40: 287 of 449 files carrying sites,
  8,259 of 20,036 sites, are pages, reports, enums and extension objects that no operator claims.
  Any score here is over the instrumented remainder and the report says so.
- **Nothing about GUI-guarded behaviour.** R60: every verdict describes the app's non-GUI branch,
  because the fenced path runs `GuiAllowed=No`, `ClientType=ODataV4`.
- **Nothing general about report legibility from a single agent run** — see the asymmetric reading
  rule above.
