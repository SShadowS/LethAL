# Issue orchestrator, phase 1: offline first

Date: 2026-09-19
Status: revision 2, answering a NOT READY review by Fable (3 blockers, 10 important, 5 minor; all
fixes folded in, two changed after measuring, see Review record at the end). Awaiting owner review.
Owner: SShadowS
Parent spec: `docs/superpowers/specs/2026-09-13-issue-orchestrator-design.md` (revision 2). Everything
this file does not change, that one still decides. This file only records what phase 1 builds, in
what order, and what it deliberately leaves out.

## Why a phase 1

The parent spec is ready and five slices of it are built (`scripts/agentflow/`: the three-outcome
gate, the gate table, receipts, merge-tree, HALT, run-state guards, the effects seam, and a vertical
slice against fake ports). But its proof order puts containers, crash races and HALT races before
the first real merge, so the flow has not closed a single real issue.

Phase 1 reaches a real squash merge first, on changes that need no live Business Central gate, and
leaves the live ladder to phase 2.

**Scope, stated honestly.** `gate-table.ts` routes every path under `packages/` to at least one live
leg. Only `docs/`, root `*.md` and `scripts/` (outside `scripts/agentflow/`) are offline, and
revision 2 protects the gate scripts inside `scripts/` as well. Of the 16 issues open on 2026-09-19,
phase 1 can close about two (#3, which looks like a prose sweep, and #6, a measurement script).
Phase 1 proves the loop against real GitHub on low-risk changes. The value for the real queue
arrives with phase 2.

## Decisions taken for phase 1

| Decision | Reason |
|---|---|
| Wire the existing TypeScript tick with real adapters (not a port of al-call-hierarchy's Python, not a prose-only loop) | Reuses everything built; one language; the dry-run and HALT guarantees stay structural. |
| Intake through a `/triage` pass that writes the missing fields | The battleplan issues (#10 to #18) and the collaborator's issues (#3 to #9) carry neither the parent spec's body schema nor labels. Triage works for every source, including hand-filed ones. |
| No automatic revert | A red post-merge check writes an incident and HALT; the owner reverts. al-call-hierarchy's revert path needed three review rounds and still nearly reverted a green commit (`c56b1c31`). |
| No acceptance oracle | It exists for R175, a wrong belief about BC. Prose and script changes cannot carry one. Returns in phase 2. |
| Two reviewers, a plain findings list | The parent spec's findings taxonomy exists for live empirical questions, which phase 1 never has. |
| No separate discovery-receipt files | The committed ledger records each discovery. Cost: a discovery from a run that never merges lives only in the GitHub issue. |

## The loop

Started with `/loop /orchestrate` in a local Claude Code session on the main checkout.

- **Conductor**: the Claude session following the prose commands. Reads, plans, edits files, runs
  subagents. Never runs `git`, `gh` or `docker`. This is a discipline, not a sandbox; the parent
  spec's "Shape" section says what it does and does not buy. In particular the conductor runs its
  own code while doing TDD, so nothing here stops candidate code executing on the owner's machine.
  What the executor guarantees is narrower: it never runs candidate code it already knows cannot
  merge (see step 5).
- **Executor**: `bun scripts/agentflow <step>`, JSON out. Every write goes through the existing
  `EffectRunner`, so HALT and `--dry-run` apply to every step without the step checking them.

| # | Step | Actor | What happens |
|---|---|---|---|
| 1 | `preflight` | executor | No HALT, no `failed` incident, clean `master` equal to `origin/master`, lock free, loop budget left. Otherwise the loop stops. A `verifying` incident routes to recovery (see Safety), not to a refusal. |
| 2 | `next` | executor | Oldest eligible `ready` issue (FIFO), with its kind: `code` or `spike`. Or `queue-empty`, which stops the loop. |
| 3 | `claim N` | executor | Lock, label `agent-claimed`, comment with the session URL. For `code` only: worktree `.claude/worktrees/issue-N` on branch `agent/issue-N` from `origin/master` (commit `B`). Refuses if that branch or worktree already exists (`stale-branch`). A spike takes the lock and makes no worktree. |
| 4 | implement | conductor | Issue text is data. Plans, builds with TDD in the worktree, writes `.agent/issue-N/ledger.md`. |
| 5 | `candidate N` | executor | Commits the worktree EXCEPT `.agent/`, with an executor-templated message, and returns `H`. Then, BEFORE any candidate code is run by the executor: `selectLegs` over `B..H`, the protected-path check, and the `scripts/tsconfig.json` rule. Any failure blocks here. `.agent/` stays out of `B..H` because `selectLegs` would treat it as unmatched and answer the full live set. |
| 6 | `redcheck N` | executor | One receipt per added or changed test file, bound to `H`. See Merge. |
| 7 | `gate N` | executor | Runs the offline ladder in a detached worktree created from `H`, never in the conductor's worktree, and seals it for `H`. |
| 8 | review | conductor | `code-review` at high plus one pi reviewer, into `.agent/issue-N/findings.json`. A fix goes back to step 5, which makes a new `H` and invalidates every receipt and seal bound to the old one. |
| 9 | `pr N` | executor | Refuses unless the worktree `HEAD` is the sealed `H` and nothing outside `.agent/` is dirty (content-aware probe: refresh the index, then diff against `HEAD`). Commits the ledger and findings as the evidence commit `F`, pushes `agent/issue-N` only, opens a PR carrying `Closes #N`. |
| 10 | `merge N` | executor | Checks every merge criterion through `canMerge`, then `gh pr merge --squash --match-head-commit F --subject <template> --body <template>`. Reads `M` from `gh pr view --json mergeCommit` and persists it to state before doing anything else. |
| 11 | `post-merge N` | executor | See Safety. |
| 12 | `file-discovery` | executor | See Safety. |
| 13 | `finish N` | executor | Removes the worktree, releases the lock, counts the tick. |

Every exit other than a merge goes through `block N <reason>`: label `agent-blocked`, a comment with
the reason, branch kept, lock released. A blocked issue is ineligible until the owner removes the
label, and the owner deletes the stale branch then too, since step 3 refuses one.

**Tick is split, not reused whole.** `tick.ts` today selects legs from `B..H` before the claim, and
in phase 1 `H` does not exist until step 5. So `runTick` splits into `pickAndClaim` and
`gateAndMerge(head)`, and the two tests that pin the old order (`tick.test.ts:68` "reports the pick
and the legs" and `:286` "a manual-only path parks BEFORE the claim") are rewritten to the new order
rather than left passing on a path the CLI never takes. `RunFacts` gains `ladderSealedOn`,
`ciGreenOn`, `openBlockingFindings`, `protectedPathsTouched`, `scanHits` and `redcheckMissing`, and
`canMerge` checks all of them. That puts every phase 1 merge criterion in one pure function that
proof 1 can red-check, instead of in imperative CLI code. `gateAndMerge` does not call
`ports.gates.expectedArtifacts` when `selectLegs` returned no leg, so no stub sits on the merge path.

State between steps lives in `.agent/runs/<runId>/state.json`.

## Triage and eligibility

`/triage` runs once at the start of each `/loop` cycle, never between ticks. It visits every open
issue with no status label, AND every `ready` issue whose current body no longer matches its triage
`Body-hash` (otherwise an edited issue keeps `ready`, is never revisited, and is stuck). The
`issue-triager` subagent (Opus) reads each issue as data and proposes the fields. The executor
(`triage-write N --fields <json>`) checks every field against its closed set of values, posts them
as one comment carrying the marker `<!-- agentflow:triage -->`, and labels the issue `ready` or
`needs-input`. The triager neither posts nor labels.

```
Type:            spike | bounded | architectural
Resolution-mode: code | measurement | ruling | recurring
Gate-class:      offline | live
Depends-on:      #N, #M            (resolved from an epic's checklist when there is one)
Acceptance:      one testable line per item
Body-hash:       sha256 of the issue body at triage time
```

**Eligibility**, deterministic, all must hold:

1. Author is the owner, or a collaborator whose permission (`gh api .../collaborators/<login>/permission`) is write or higher.
2. No `epic`, `manual-only`, `agent-blocked` or `agent-claimed` label.
3. The newest triage comment authored by the owner's account parses AND has never been edited
   (REST `updated_at == created_at`). The three outside collaborators hold write access, and write
   access can edit anyone's issue comments, so an unedited comment is the only one the executor
   can attribute to itself. An edited one means re-triage.
4. Its `Body-hash` equals the current body's hash. An edited issue drops out until it is triaged
   again. The merge step re-checks the current body against the same hash.
5. Every `Depends-on` issue is closed.
6. Phase 1 only: `Gate-class: offline`, `Type` is not `architectural`, and either `Type: spike` or
   `Resolution-mode: code`. The spike branch is decided here, at `next`, so a spike never reaches
   the worktree step.

`Gate-class` is a prediction. It decides which issues are tried, never what may merge: step 5 checks
the real diff.

**Roadmap rows.** Triage never writes a `Roadmap:` field. An issue's own roadmap row is honoured
only when the issue is authored by the owner AND its body itself carries a `Roadmap: R<n>` line.
Otherwise a collaborator's text, or a triager inference, could name any row as "own" and let a prose
sweep close a measurement item on the durable record (R213 is the parent spec's example of a row
that must not be reduced).

**Epics** are never claimed, only their children. The flow never writes to an epic, since an epic
checkbox is a GitHub write outside git that a crash can leave wrong. The owner closes epics.

**Spikes** (`Type: spike`): the conductor probes read-only, the executor posts the answer as a
comment and labels `spike-answered`, and the issue stays open for the owner to close. No worktree,
no PR. This keeps the parent spec's rule that no model closes an issue by its own judgement.

## Merge

**Protected paths**: the parent spec's list, plus the gate implementations that live under
`scripts/` and that the parent missed because it protected only `package.json`'s `scripts` block,
not the files that block and the test suite reach:

- `scripts/compile-fixtures.ts` (the `compile:fixtures` gate; its skip path exits 0)
- `scripts/build-binary.ts` (builds every released binary)
- `scripts/roadmap-index.ts` and `scripts/roadmap-index.test.ts`
- `scripts/redact-campaign-report.ts`, its test, and `scripts/redact-first-party-reports.json`
  (the public-repo guard)
- `scripts/generate-schemas.ts` (spawned by `packages/runner/tests/schemas.test.ts`)
- `scripts/lib/**`

**`scripts/tsconfig.json`** lists every typechecked script explicitly, by design (R119), so a new
script outside the list is never typechecked, and a candidate could choose its own typecheck scope.
Rule, checked at step 5: every added `scripts/**/*.ts` must appear in that file's `files` list, and
the only change allowed to the file is added lines that each name one `.ts` path. Anything else in
it is a protected-path block.

**Offline ladder**, run by the executor in a detached worktree created from `H`, each step with its
own timeout, argv, exit code and log hash recorded in a manifest kept outside the repo:

1. `bun install --frozen-lockfile` (a fresh worktree has no `node_modules`)
2. `bun run typecheck`
3. `rm -rf packages/*/dist` (the dist trap, in CLAUDE.md's order)
4. `bun test`: passes only on exit 0 AND a parsed executed-test count above zero
5. `bunx biome check <touched files>`
6. `bun scripts/redact-campaign-report.ts --check` over every added or changed `*.json` whose top
   level carries a `mutants` array. The unit test only globs report-shaped names, so a report
   committed under another name would otherwise escape.

The ladder worktree is deleted afterwards under the same two-conjunct rule as the red-check.

**Red-check**, executor-owned as in the parent spec's "The red-check is executor-owned".
`mutation-red-checker` only designs the fault, as a patch. The patch may touch only production files
that are themselves changed in `B..H`, and never a test. The executor creates a detached worktree
from `H`, requires the named test green there, applies the patch, and requires that same test to
fail. Compile failure, zero tests, timeout, or a different test failing is a failed check. It then
deletes the worktree and writes a receipt bound to `H` (reusing `receipt.ts`'s `candidateSha`
binding). A new `H` invalidates every receipt. Every worktree the executor deletes, here and in
`finish`, is removed only when its path is BOTH under `.claude/worktrees/` AND carries this run's
name prefix (al-call-hierarchy's two-conjunct rule for argv-aimed deletes).

**What counts as tested**: a diff touching only `docs/**` or root `*.md` needs no test. A `scripts/`
change needs at least one added or changed test file in `B..H`, and EVERY added or changed test file
needs its own receipt. A receipt on an unrelated existing test, faulting an unrelated file, does not
count, because the patch may only touch files changed in `B..H`. No test file in the diff is
`blocked no-test`. The parent spec's four no-test witnesses are deferred.

**Review**: `code-review` at high, and `gpt-5.6-sol` through pi with `require_evidence` on and a
blind first pass (diff and issue only, no conductor opinions). Each finding is
`{source, severity, summary, disposition}` in `findings.json`. A critical or important finding
closes only as `fixed`, confirmed by a re-review, or as `refuted`, which requires the reviewer that
raised it to accept the refutation. After two rounds, anything still open is `blocked review-disputed`.

**CI green is a positive fact, never an absence.** The repo's CI is the workflow `CI` with one job,
`check`. GitGuardian also reports on every commit and finishes in about 30 s, long before the
Windows job has even been created, so "`gh pr checks` exits 0" would read green with CI never having
run. The predicate is: a check run named `check`, from workflow `CI`, with `head_sha` equal to the
commit, `status` completed and `conclusion` success. Missing, pending, or bound to another SHA is not
green.

**Merge criteria**, all checked in `canMerge`:

1. `selectLegs` over `B..H` returns zero legs, zero parked and zero unmatched paths.
2. The offline ladder is sealed green on `H`.
3. The testing rule above holds, with every receipt bound to `H`.
4. No critical or important finding is open.
5. CI is green on `F` by the predicate above.
6. No protected path is touched, and the `scripts/tsconfig.json` rule holds.
7. The outbound scan is clean.
8. The current issue body matches the triage `Body-hash`; the base has not moved since the seal
   (else one rebase and a re-gate); `H..F` holds only `.agent/issue-N/ledger.md` and
   `.agent/issue-N/findings.json`.

**Roadmap**: when the owner-authored body names `Roadmap: R<n>`, the conductor sets that row's status
to `done (#<issue>)` inside the candidate and regenerates `ROADMAP.md`. The status only has to start
with `done` (`roadmap-index.ts`), and the issue links to the PR and its squash commit. The existing
roadmap-index test checks the two agree. `merge-tree.ts` still allows the own-row status line in
`H..F`; phase 1 does not use that allowance.

**Outbound scan**, the one piece of new security work. The parent spec records that free-text
scanning does not exist yet. One small executor function, applied to everything that leaves the
machine:

- every comment and PR body, and the PR title
- the added lines of `git diff B..F`, which covers the ledger and `findings.json`
- every commit message in `B..F`, and the squash subject and body. The repo squashes with
  `COMMIT_MESSAGES`, so branch commit messages land in `master`'s history; the executor writes them
  from templates and sets the squash subject and body explicitly.

It checks for token shapes, absolute local user paths, `CDO_WS` and `.alpackages` paths. A hit is
`blocked sanitize-failed`.

## Safety

**HALT** is the existing `.agent/HALT`. `ExecutorAction` is a closed union, so every phase 1 action
is classified in `halt.ts`:

- **Allowed under HALT**: reads (post-merge verification is reads), writing an incident, appending to
  the ledger and run directory, killing processes this run launched, and one terminal comment plus
  label.
- **Refused under HALT**: claim, worktree add, commit, push, fetch, local `master` fast-forward,
  triage writes, spike answers, PR creation, merge, discovery filing.

**Incidents** follow al-call-hierarchy's fix (`c56b1c31`, "could not verify is not proven bad"). An
incident is `verifying`, `failed` or `resolved`, in `.agent/incidents/<merge-sha>.json`.

- `post-merge` writes the incident as `verifying` before it waits on anything.
- A red, timed-out or unreadable result moves it to `failed`, and the incident is written BEFORE
  HALT, so a halted runner can never be left holding HALT without the record that explains it.
- Preflight refuses on any `failed` incident, independently of HALT, so deleting the HALT file does
  not resume the loop over an unverified merge.
- A `verifying` incident does not refuse. It routes to recovery, which re-runs `post-merge` for that
  SHA. Refusing on it would block the very recovery that discharges it, which is the trap the cited
  commit's preflight comment names.

**Owner commands**: `clear-halt --reason` and `resolve-incident <sha> --reason` run outside the
`EffectRunner` and port al-call-hierarchy's `require_operator` checks, so they are fenced in code,
not only in prose: refuse when a run id is in context (`--run-id` or `AGENTFLOW_RUN_ID`), refuse
while a live lock exists, refuse a no-op clear, and record the reason in the ledger.

**Post-merge**: `M`'s parent is `B` and its tree equals `F`'s; then wait up to 45 minutes for CI
green on `M` by the positive predicate. Zero `check` runs after 45 minutes is a timeout, therefore
`failed`, not "unreadable". On green the incident becomes `resolved` and the executor fast-forwards
local `master` to `M`.

**Lock and crashes**: the executor is a fresh process per step, so its own PID proves nothing about
a run. The lock's liveness signal is the conductor session itself. Every command the conductor runs
descends from the Claude Code process (measured 2026-09-19: `pwsh` <- `cmd` <- `claude.exe`), so
`claim` walks its ancestors, finds the nearest `claude.exe`, and records that PID and its creation
time in `.agent/lock.json` with the run id and issue. It refuses to claim when no such ancestor
exists. The lock is stale only when that PID with that creation time no longer exists, which is
exactly when the conductor session has died. A second `/orchestrate` session in the same checkout
sees a different, live `claude.exe` and is refused. In phase 1 a dead session is sufficient proof of
a dead writer, because no container operation can outlive it; the parent spec's "prove the writer
dead" rule returns in phase 2.

Recovery on the next preflight reconciles with GitHub first: if the PR merged, persist `M` and run
`post-merge`; otherwise `block N crashed`, keep worktree and branch, release the lock.

**Budgets**. Exceeding one is `block N budget:<name>`.

| Cap | Phase 1 | Enforced by |
|---|---|---|
| Issues per `/loop` | 3 (`--max-issues`), durable across ticks | executor |
| Per-step timeout | 45 min, kills the process tree | executor |
| Wall clock per issue | 3 h | executor |
| Red-to-green attempts per test | 3 | executor |
| Review rounds | 2 | executor, counted from `findings.json` |
| CI fix, rebase re-gate | 1 each | executor |
| Discoveries per issue | 5, charged after a successful create | executor |
| Subagents, pi calls | 40, 10 | conductor reports, ledger records, not enforced |

**Discoveries**: `file-discovery --title --body` runs the outbound scan, fingerprints the normalised
title into a hidden `<!-- agentflow:fp=<hash> -->` marker, refuses a duplicate of any open issue or
any issue closed in the last 90 days, and files with `agent-discovered` and no status label, so the
next `/triage` picks it up. The cap of 5 per issue and 3 issues per loop stops the loop feeding
itself without bound.

## Build

New, under `scripts/agentflow/`, each with a test file:

| File | Job |
|---|---|
| `index.ts` | CLI entry; steps print JSON |
| `real-ports.ts` | real `gh`, `git`, spawn (timeout, tree kill) behind the existing `Ports`; container and gate ports stay unbuilt |
| `triage.ts` | field schema, triage-comment parse (including the never-edited rule), eligibility as one pure function |
| `offline-ladder.ts` | the six steps, the executed-count parse, the CI predicate |
| `redcheck.ts` | throwaway worktree, green, red, delete, receipt |
| `outbound-scan.ts` | the free-text scanner |
| `local-state.ts` | lock (with the `claude.exe` ancestor walk), incidents, loop budget, owner-command fences |

Changed: `tick.ts` (split), `run-state.ts` (`RunFacts` and `canMerge` extended), `halt.ts` (every
phase 1 action classified). New prose: `.claude/commands/orchestrate.md`, `issue.md`, `triage.md`,
`.claude/agents/issue-triager.md`.

## Proof, in order

1. Unit tests per module. Every guard that decides a merge or a block is red-checked: revert the
   guard, confirm the named test goes red, restore. `canMerge` is the main target, one red-check per
   criterion.
2. Dry run writes nothing: the parent spec's proof 2, with adapters that fail the test on any
   attempted write to fs, git, gh or spawn, rather than a list of places a write would be expected.
3. HALT between every pair of steps; a crash after the PR merged but before bookkeeping, which the
   next tick must finish through `post-merge`; a crash during `post-merge`, which the next preflight
   must route to recovery rather than refuse.
4. `/orchestrate --dry-run` on the real repo: triage output and the chosen issue, zero writes.
5. One seeded real docs issue, end to end, to a squash merge and a green post-merge.
6. The real queue: #3 and #6, if triage classes them offline.

## Owner prerequisites

These touch protected paths, are rulings, or publish. Drafts can be prepared; the owner applies them.

1. **Push `master`.** Local `master` is 15 commits ahead of `origin/master` (2026-09-19), including
   all of `scripts/agentflow/`, so none of it has ever run in CI, and preflight's
   "`master` equals `origin/master`" refuses today.
2. **CLAUDE.md doctrine exception**: the flow may squash-merge to `master` once the phase 1 merge
   criteria hold, and may make no other write to `master`; the protected-path list; the flow files
   discoveries as issues, not roadmap rows.
3. **Labels**: `ready`, `needs-input`, `agent-claimed`, `agent-blocked`, `agent-discovered`,
   `spike-answered`, `manual-only`, `epic`.
4. **`.gitignore`**: `.agent/` is not ignored today. Git cannot re-include a file under an excluded
   directory, so the re-include is two levels (checked in a scratch repo by the reviewer):

   ```
   .agent/*
   !.agent/issue-*/
   .agent/issue-*/*
   !.agent/issue-*/ledger.md
   !.agent/issue-*/findings.json
   ```

Not a prerequisite, stated so it is not mistaken for one: `master` has no branch protection, and the
three outside collaborators have write access, so they could push to `master` directly. Nothing in
this design defends against that, and nothing needs to for the flow to be correct.

## Phase 2, not designed here

The parent spec, unchanged: real container and gate ports, leases and the container generation,
qualification of Cronus284 and Cronus285, pre-commitment and the three-outcome gate (built), the
acceptance oracle, proofs 8 and 10 to 13, and a fresh decision on automatic revert.

## Review record

Revision 1 (`6ed0549`) was reviewed adversarially by Fable through `spec-adversary`, read-only, with
every mechanical claim verified against the repo, GitHub and al-call-hierarchy. Verdict NOT READY.

| Finding | Where it landed |
|---|---|
| B1 CI "green" by absence: GitGuardian passes before the CI job exists | positive CI predicate |
| B2 lock PID is a process that exits after every step | lock bound to the `claude.exe` ancestor (reviewer proposed a detached holder process; the ancestor was measured and is the real liveness signal, with nothing to keep alive) |
| B3 `verifying` incident blocks its own recovery; no state for red | three states, recovery on `verifying`, incident before HALT |
| I1 ladder in the conductor's worktree: tested tree can differ from merged tree | ladder in a detached worktree from `H`; `pr` refuses a moved or dirty `HEAD` |
| I2 any receipt satisfied the testing rule | patch limited to files changed in `B..H`; one receipt per changed test, bound to `H` |
| I3 path checks ran after candidate code executed | path checks at step 5; `scripts/tsconfig.json` append-only rule (reviewer proposed protecting the file; that would block every new script, since R119 makes the list explicit by design) |
| I4 gate scripts under `scripts/` unprotected | named in the protected list (reviewer also proposed refusing any edit to any existing test; kept narrower: gate tests protected, other changed tests each need a receipt) |
| I5 triage comment editable by write collaborators | never-edited rule; triage revisits `ready` issues whose hash moved |
| I6 triager-inferred `Roadmap:` could close any row | owner-authored body line only |
| I7 outbound scan missed commit messages, diff, PR title | scan widened; commit and squash messages templated |
| I8 `tick.ts` cannot be reused whole; criteria outside `canMerge` | tick split; `RunFacts` and `canMerge` extended |
| I9 phase 1 actions unclassified under HALT | every action classified |
| I10 owner commands fenced by prose only | `require_operator` checks ported |
| Minors: re-claim over a kept branch, spike reaching the worktree step, `M` not persisted, dropped `redact --check`, unpushed `master` | all folded in |
