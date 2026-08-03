# A phased live campaign against Continia Document Output, ending in an agent reading the report

Date: 2026-08-03. Status: design, approved for planning.

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
| **0 — plumbing** | Fresh Continia environment running DO; LethAL Control published and harness-verified; DO's test app published; the target parses | `--dry-run` on the differential-run codeunit reproduces **105** deployable mutants; harness verification passes; compiler resolves to alc 17 |
| **1 — smoke** | Reproduce the one sweep that already happened | `4 killed / 8 survived / 92 no-coverage / 1 error` over 105 mutants — the **fenced** column of the 2026-07-28 differential. Compared **per mutant**, not on aggregates |
| **2 — module** | One real DO module, several publish batches | Completes without a second quarantine; report caveats numerically correct; **every survivor has `guardObserved === true`** |
| **3 — agent** | A real agent reads the rung-2 report and tries to kill survivors | Pre-committed prediction of what it should attack and what it should refuse, diffed against the transcript; **every claimed kill red-checked** |

## Rung 0 — provisioning

### Worktree

The user pulls `U:/Git/do-rel2` (currently on `development/dfc491cc-814e-4739-b23f-6f647f140d38-promotion`
with an untracked `.promotion-state.json`) — their repo, their call, done by them and not silently.
Then:

```bash
git -C U:/Git/do-rel2 worktree add U:/Git/do-lethal -b lethal/campaign-2026-08-03
```

LethAL runs `--project U:/Git/do-lethal/Cloud`; the test app builds from `U:/Git/do-lethal/Test`.
Undo for the entire experiment is `git worktree remove`.

### Environment

Create fresh from profile `c803cb93-a8e4-4fb1-b61f-e5f60f17b43a` — the profile `lethal-do-trial`
(`f19aca88`) was created from, BC 28.0.0.0, `NavUserPassword`, on `demoportaldev.continiaonline.com`.

```bash
cd U:/Git && ./CLI/continia.exe env create --name lethal-do-campaign \
  --profile c803cb93-a8e4-4fb1-b61f-e5f60f17b43a --json
```

**Fresh rather than reusing `f19aca88`.** That environment still carries whatever the R69 coverage
work published, and R31 records that nothing detects a stale published test app — a failure mode
that has already cost two debugging sessions. A new environment is a known state; that is worth the
creation wait.

`continia.exe` holds its own login: `env list` and `env get --json` both answered on 2026-08-03 with
no `CONTINIA_API_TOKEN` set in the shell. Whether LethAL's `envTool.env` block still needs the token
passed through is **unmeasured** and rung 0 settles it.

### Selector ids — a blocker, not a detail

DO's `Cloud/app.json` declares `idRanges: [{ from: 6175271, to: 6175468 }]`. `DEFAULT_SELECTOR_IDS`
(79197–79199) is outside it, so `validateSelectorIdsForProject` refuses before any compile is
attempted. This is exactly the scenario R3 was closed for, which also means the earlier DO sweeps
already solved it — **recover the config those runs used before re-deriving three ids**, then
validate the chosen ids against the range and against the codeunit ids DO already declares.

### Compiler

`bcdev.alcPath` pins alc **17**. DO declares `runtime 17.0`, and R43 measured that alc 18 writes OPC
part names with single-encoded spaces, producing a package BC 28 cannot load.

### Config shape

An `envTool` config at `U:/Git/do-lethal/lethal.config.envtool.json`, gitignored, secrets only as
`${VAR}` placeholders — the `no-committed-secrets` PreToolUse hook enforces this and the rule behind
it is standing. Shape per `fixtures/README.md` §"Running against an external environment tool", with
`publishApps` naming the compiled DO test app and a `selectorIds` section carrying the in-range ids.

### Gate 0

Blocks rung 1. All four must hold:

1. LethAL Control publishes to the new environment and harness-verifies (R25/R28: a stale local
   `lethal-control.app` fails with a confusing `clientProtocol` rejection — build it, do not assume).
2. DO's test app publishes.
3. The resolved compiler is alc 17.
4. `lethal run --dry-run` on the rung-1 codeunit reports **105** deployable mutants.

## Rung 1 — smoke

**Target: the configuration the 2026-07-28 differential ran** — `U:/Git/do-rel2/Cloud`, one codeunit
in scope (instrumented object `Codeunit 6175297`), 56 baseline tests, default coverage mode.

**Pre-commit: `4 killed / 8 survived / 92 no-coverage / 1 error`, 105 mutants.** That is the
**fenced** column, and the fenced path is what R58 made the default — so it is what a run today
should produce. Identity was verified there on `mutantCode` + file + line + operator with **0
mismatches**, and the fenced baseline was fully green (56 pass), so the anchor does not depend on a
red baseline.

**Do not anchor on `16 / 86 / 15 / 21`.** Those are the same codeunit's **hub** numbers
(`coverageMode: "procedure"`, the legacy escape hatch), taken against a **red baseline of 12 fail /
44 pass** — and R63 established that 77 of those 86 survivors were **vacuous**, scored against tests
that never executed the mutated code. R45's "verdicts identical, 16/86/15/21" measurement of
`--tests-only` was made in that mode. Reproducing the hub column would reproduce a known-wrong
answer.

Compared **per mutant**. A deviation means something that shipped since 2026-07-28 changed a verdict
on real code, which is a regression, not a curiosity.

**Fallback if the exact scoping cannot be recovered.** The `--only` glob and test scoping of that
run must come from its record. If they cannot be recovered exactly, rung 1 degrades to a weaker but
still real gate: two runs of whatever scoping is used, **verdict-identical per mutant** (what
`itest:bcdev` does), with the aggregate frozen from run 1. That is a determinism gate, not a
regression gate, and the difference is recorded rather than glossed.

Cost anchors for planning, all measured on DO: total 1065 s unnarrowed (generate 0.7 + deploy 40.8 +
baseline 863.8 + mutants 151.9 + overhead 8.5), 231.2 s with `--tests-only` (baseline 744.8 → 25.0
s); publish 36.8 s per batch.

## Rung 2 — one module

**The module is chosen by measurement, not by name.** Candidates are ranked offline from R69's
per-test coverage data by sites × test-coverage density, so survivors have a real chance of being
findings rather than dead code. Target size ~500–1500 mutants, several publish batches.

Gate:

- Completes without a second quarantine (see recovery below).
- The report's caveats are numerically correct — `notInstrumented` counts, `only`/`testsOnly`
  narrowing, `validity.reliability`.
- **Every survivor carries `guardObserved === true`.** R46 exists because a survivor no instrumented
  guard fired for is not a finding at all, and R29 produced ten false survivors before anything
  distinguished them.

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

## Recovery and abort

**A quarantine is expected, not a surprise.** R53 is live on DO: `negate-conditional` on
`until DOCustSetup.Next() = 0` becomes `<> 0` and never terminates, quarantining the tier and
blocking every mutant behind it. Recovery is the `recover-tier` skill — `env stop`, `env start`,
**wait for `Running`**, `force-reset-lease`, `clear-quarantine`. A restart alone clears neither
piece of state: the quarantine record is a local file, the op marker is a row in the environment's
database.

**Rule: one quarantine per rung is normal; a second at the same rung stops the ladder** and gets an
`R<n>` row.

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
