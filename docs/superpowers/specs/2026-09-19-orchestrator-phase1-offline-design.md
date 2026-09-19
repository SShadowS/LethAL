# Issue orchestrator, phase 1: offline first

Date: 2026-09-19
Status: approved section by section in session, awaiting owner review of this file.
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
leg. Only `docs/`, root `*.md` and `scripts/` (outside `scripts/agentflow/`) are offline. Of the 16
issues open on 2026-09-19, phase 1 can close about two (#3, which looks like a prose sweep, and #6,
a measurement script). Phase 1 proves the loop against real GitHub on low-risk changes. The value
for the real queue arrives with phase 2.

## Decisions taken for phase 1

| Decision | Reason |
|---|---|
| Wire the existing TypeScript tick with real adapters (not a port of al-call-hierarchy's Python, not a prose-only loop) | Reuses everything built; one language; the dry-run and HALT guarantees stay structural. |
| Intake through a `/triage` pass that writes the missing fields | The battleplan issues (#10 to #18) and the collaborator's issues (#3 to #9) carry neither the parent spec's body schema nor labels. Triage works for every source, including hand-filed ones. |
| No automatic revert | A red post-merge check writes HALT and an incident; the owner reverts. al-call-hierarchy's revert path needed three review rounds and still nearly reverted a green commit (`c56b1c31`). |
| No acceptance oracle | It exists for R175, a wrong belief about BC. Prose and script changes cannot carry one. Returns in phase 2. |
| Two reviewers, a plain findings list | The parent spec's findings taxonomy exists for live empirical questions, which phase 1 never has. |
| No separate discovery-receipt files | The committed ledger records each discovery. Cost: a discovery from a run that never merges lives only in the GitHub issue. |

## The loop

Started with `/loop /orchestrate` in a local Claude Code session on the main checkout.

- **Conductor**: the Claude session following the prose commands. Reads, plans, edits files, runs
  subagents. Never runs `git`, `gh` or `docker`. This is a discipline, not a sandbox; the parent
  spec's "Shape" section says what it does and does not buy.
- **Executor**: `bun scripts/agentflow <step>`, JSON out. Every write goes through the existing
  `EffectRunner`, so HALT and `--dry-run` apply to every step without the step checking them.

| # | Step | Actor | What happens |
|---|---|---|---|
| 1 | `preflight` | executor | No HALT, no open incident, clean `master` equal to `origin/master`, lock free, loop budget left. Otherwise the loop stops. |
| 2 | `next` | executor | Oldest eligible `ready` issue (FIFO), or `queue-empty`, which stops the loop. |
| 3 | `claim N` | executor | Lock, label `agent-claimed`, comment with the session URL, worktree `.claude/worktrees/issue-N` on branch `agent/issue-N` from `origin/master` (commit `B`). |
| 4 | implement | conductor | Issue text is data. Plans, builds with TDD in the worktree, writes `.agent/issue-N/ledger.md`. |
| 5 | `candidate N` | executor | Commits the worktree EXCEPT `.agent/`, returns `H`. The ledger and findings enter only at step 9: under `B..H` they would be unmatched paths, and `selectLegs` would answer the full live set. |
| 6 | `redcheck N` | executor | Per added or changed test: applies the fault `mutation-red-checker` designed, in a throwaway worktree. See Merge. |
| 7 | `gate N` | executor | `selectLegs` over `B..H`. Any leg, parked path or unmatched path is `blocked needs-live`. Otherwise runs the offline ladder on `H` and seals it. |
| 8 | review | conductor | `code-review` at high plus one pi reviewer, into `.agent/issue-N/findings.json`. A fix goes back to step 5 with a new `H`. |
| 9 | `pr N` | executor | Commits the ledger and findings as the evidence commit `F`, pushes `agent/issue-N` only, opens a PR carrying `Closes #N`. |
| 10 | `merge N` | executor | Checks every merge criterion, then `gh pr merge --squash --match-head-commit F`. |
| 11 | `post-merge N` | executor | See Safety. |
| 12 | `file-discovery` | executor | See Safety. |
| 13 | `finish N` | executor | Removes the worktree, releases the lock, counts the tick. |

Every exit other than a merge goes through `block N <reason>`: label `agent-blocked`, a comment with
the reason, branch kept, lock released.

`tick.ts`'s gate, seal and merge sequence becomes the body of the `gate` and `merge` steps, so phase 1
and phase 2 share one ordering rather than two. Its tests stay and keep guarding that ordering.
State between steps lives in `.agent/runs/<runId>/state.json`.

## Triage and eligibility

`/triage` runs once at the start of each `/loop` cycle, never between ticks, over every open issue
with no status label. The `issue-triager` subagent (Opus) reads each issue as data and proposes the
fields. The executor (`triage-write N --fields <json>`) checks every field against its closed set of
values, posts them as one comment carrying the marker `<!-- agentflow:triage -->`, and labels the
issue `ready` or `needs-input`. The triager neither posts nor labels.

```
Type:            spike | bounded | architectural
Resolution-mode: code | measurement | ruling | recurring
Gate-class:      offline | live
Depends-on:      #N, #M            (resolved from an epic's checklist when there is one)
Roadmap:         R<n>              (optional)
Acceptance:      one testable line per item
Body-hash:       sha256 of the issue body at triage time
```

**Eligibility**, deterministic, all must hold:

1. Author is the owner, or a collaborator whose permission (`gh api .../collaborators/<login>/permission`) is write or higher.
2. No `epic`, `manual-only`, `agent-blocked` or `agent-claimed` label.
3. The newest triage comment authored by the owner's account parses. The executor posts as the owner, so an outside collaborator cannot forge one.
4. Its `Body-hash` equals the current body's hash. An edited issue drops out until it is triaged again. This replaces a separate hash recorded at claim: the merge step re-checks the current body against the same triage hash.
5. Every `Depends-on` issue is closed.
6. Phase 1 only: `Gate-class: offline`, `Resolution-mode: code`, `Type` is not `architectural`.

`Gate-class` is a prediction. It decides which issues are tried, never what may merge: step 7 checks
the real diff.

**Epics** are never claimed, only their children. The flow never writes to an epic, since an epic
checkbox is a GitHub write outside git that a crash can leave wrong. The owner closes epics.

**Spikes** (`Type: spike`): the conductor probes read-only, the executor posts the answer as a
comment and labels `spike-answered`, and the issue stays open for the owner to close. No worktree
commit, no PR. This keeps the parent spec's rule that no model closes an issue by its own judgement.

## Merge

**Offline ladder**, run by the executor in the worktree at `H`, each step with its own timeout, argv,
exit code and log hash recorded in a manifest kept outside the repo:

1. `bun install --frozen-lockfile` (a fresh worktree has no `node_modules`)
2. `bun run typecheck`
3. `rm -rf packages/*/dist` (the dist trap, in CLAUDE.md's order)
4. `bun test`: passes only on exit 0 AND a parsed executed-test count above zero
5. `bunx biome check <touched files>`

**Red-check**, executor-owned as in the parent spec's "The red-check is executor-owned".
`mutation-red-checker` only designs the fault, as a patch to production files, never to tests. The
executor creates a detached worktree from `H`, requires the named test green there, applies the
patch, and requires that same test to fail. Compile failure, zero tests, timeout, or a different
test failing is a failed check. It then deletes the worktree and writes the receipt. The candidate
tree is never touched. The delete removes a path only when it is BOTH under `.claude/worktrees/`
AND named `redcheck-<runId>-*` (al-call-hierarchy's two-conjunct rule for argv-aimed deletes).

**What counts as tested**: a diff touching only `docs/**` or root `*.md` needs no test. Any
`scripts/` change needs at least one test with a red-check receipt, or it is `blocked no-test`. The
parent spec's four no-test witnesses are deferred.

**Review**: `code-review` at high, and `gpt-5.6-sol` through pi with `require_evidence` on and a
blind first pass (diff and issue only, no conductor opinions). Each finding is
`{source, severity, summary, disposition}` in `findings.json`. A critical or important finding
closes only as `fixed`, confirmed by a re-review, or as `refuted`, which requires the reviewer that
raised it to accept the refutation. After two rounds, anything still open is `blocked review-disputed`.

**Merge criteria**, all must hold:

1. `selectLegs` over `B..H` returns zero legs, zero parked and zero unmatched paths.
2. The offline ladder is sealed green on `H`.
3. The testing rule above holds.
4. No critical or important finding is open.
5. GitHub CI is green on `F`.
6. No protected path is touched, using the parent spec's list unchanged.
7. The outbound scan is clean.
8. The current issue body matches the triage `Body-hash`; the base has not moved since the seal
   (else one rebase and a re-gate); `H..F` holds only `.agent/issue-N/ledger.md` and
   `.agent/issue-N/findings.json`.

**Roadmap**: when triage names `Roadmap: R<n>`, the conductor sets that row's status to
`done (#<issue>)` inside the candidate and regenerates `ROADMAP.md`. The status only has to start
with `done` (`roadmap-index.ts`), and the issue links to the PR and its squash commit. The existing
roadmap-index test checks the two agree. `merge-tree.ts` still allows the own-row status line in
`H..F`; phase 1 does not use that allowance.

**Outbound scan**, the one piece of new security work. The parent spec records that free-text
scanning does not exist yet. A small executor function scans every comment, PR body and committed
ledger for token shapes, absolute local user paths, `CDO_WS` and `.alpackages` paths. A hit is
`blocked sanitize-failed`.

## Safety

**HALT** is the existing `.agent/HALT` and `HALT_ALLOWED` in `halt.ts`. From al-call-hierarchy's fix
(`c56b1c31`, "could not verify is not proven bad"):

- A red post-merge writes HALT AND `.agent/incidents/<merge-sha>.json`. Preflight refuses while any
  incident is open, independently of HALT, so deleting the HALT file does not resume the loop over
  an unverified merge.
- `clear-halt` and `resolve-incident <sha>` are owner commands, each requiring `--reason`, recorded
  in the ledger. The command prose says the conductor never runs them.

**Post-merge**: `M`'s parent is `B` and its tree equals `F`'s; then wait for CI on `master` at `M`,
up to 45 minutes. Red, timed out or unreadable all write HALT plus an incident and stop the loop.
Incidents are `verifying` or `resolved`, so a crash during post-merge stays recoverable. On green the
executor fast-forwards local `master` to `M`. The clean-tree probe refreshes the index before
diffing, so a line-ending-only difference is not dirt (the false alarm behind `c56b1c31`).

**Lock and crashes**: `.agent/lock.json` holds run id, PID, process start time and issue. It is stale
when that PID with that start time no longer exists. In phase 1 that is sufficient proof, because no
container operation can outlive the process; the parent spec's "prove the writer dead" rule returns
in phase 2. Recovery on the next preflight reconciles with GitHub first: if the PR merged, run
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
| `triage.ts` | field schema, triage-comment parse, eligibility as one pure function |
| `offline-ladder.ts` | the five steps and the executed-count parse |
| `redcheck.ts` | throwaway worktree, green, red, delete, receipt |
| `outbound-scan.ts` | the free-text scanner |
| `local-state.ts` | lock, incidents, loop budget |

Changed: `tick.ts` (as above). New prose: `.claude/commands/orchestrate.md`, `issue.md`, `triage.md`,
`.claude/agents/issue-triager.md`.

## Proof, in order

1. Unit tests per module. Every guard that decides a merge or a block is red-checked: revert the
   guard, confirm the named test goes red, restore.
2. Dry run writes nothing: the parent spec's proof 2, with adapters that fail the test on any
   attempted write to fs, git, gh or spawn, rather than a list of places a write would be expected.
3. HALT between every pair of steps; a crash after the PR merged but before bookkeeping, which the
   next tick must finish through `post-merge`.
4. `/orchestrate --dry-run` on the real repo: triage output and the chosen issue, zero writes.
5. One seeded real docs issue, end to end, to a squash merge and a green post-merge.
6. The real queue: #3 and #6, if triage classes them offline.

## Owner prerequisites

These touch protected paths or are rulings. Drafts can be prepared; the owner applies them.

1. **CLAUDE.md doctrine exception**: the flow may squash-merge to `master` once the phase 1 merge
   criteria hold, and may make no other write to `master`; the protected-path list; the flow files
   discoveries as issues, not roadmap rows.
2. **Labels**: `ready`, `needs-input`, `agent-claimed`, `agent-blocked`, `agent-discovered`,
   `spike-answered`, `manual-only`, `epic`.
3. **`.gitignore`**: `.agent/` is not ignored today. Git cannot re-include a file under an excluded
   directory, so the re-include is two levels:

   ```
   .agent/*
   !.agent/issue-*/
   .agent/issue-*/*
   !.agent/issue-*/ledger.md
   !.agent/issue-*/findings.json
   ```

## Phase 2, not designed here

The parent spec, unchanged: real container and gate ports, leases and the container generation,
qualification of Cronus284 and Cronus285, pre-commitment and the three-outcome gate (built), the
acceptance oracle, proofs 8 and 10 to 13, and a fresh decision on automatic revert.
