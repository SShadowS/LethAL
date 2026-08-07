# Kick-off prompt — R86, R93, R114

Paste everything below the line into a new session in `U:/Git/LethAL`.

---

Work three roadmap items, in this order, using `superpowers:subagent-driven-development` where a task
is big enough to earn it. **Run continuously.** Do not check in between items. Stop only for a
genuine blocker, or when a decision is the user's to make (spending money, deleting their work,
reversing an approved design).

Master is at `4ab68a0`. Baseline before you touch anything: `bun run typecheck` exit 0, and
`bun test` **1932 pass / 1 skip / 0 fail across 120 files**.

## 1. R86 — a false kill and a real kill are indistinguishable in the record

**Start here.** It is the smallest of the three, it needs no live environment, and it is about
whether a verdict means what it says.

`docs/roadmap/R086.md` has the measurement: on the R82 gate run, `failure_note` is `NULL` for **all
109** killed mutants. The fixture's arm E — a swap killed by BC's *"The length of the string is 18,
but it must be less than or equal to 10 characters"*, under a test that asserts **nothing** — is
stored byte-identically to a genuine kill.

The product claim is that `killed` means a test caught the change. Arm E is a kill produced by BC
rejecting the mutated data, which no assertion noticed. Read the row before designing anything: it
names what was measured and what was not.

Design questions worth putting to a Fable agent rather than deciding alone: whether the fix is
recording the failure text, classifying it, or both; and whether a false kill should change the
VERDICT or only annotate it. Changing a verdict changes every frozen gate figure, so treat that as
the expensive branch and price it before choosing.

## 2. R93 — you have lost a live gate, and it blocks seven rows

`itest:alrunner` is frozen at 3/13/0 in CLAUDE.md and is currently **RED and unrunnable**: al-runner
v2 (upstream PR #1654, merged 2026-08-05) rewrote the CLI, so every flag `al-runner-transport.ts`
sends is gone. `.claude/skills/live-gate/SKILL.md` already tells operators to skip that leg.

R94, R95, R96, R97, R99, R100 and R101 all sit behind it. Read all eight before planning — several
are not "port the flags" but decisions:

- **R99** says v2 *fixes* R7 and R8, measured. Both defects are what justify
  `capabilities().authoritative = false` on that backend. So the canary and the authoritative flag
  need **re-deciding, not re-asserting**.
- **R95** says v2 re-meaned exit codes 2 and 3 and our decode swallows the dangerous one.
- **R94** says v2 turns a hung mutant into a KILL — a false kill, which is R86's family.
- **R98** measured that v2 does not run on Windows at all (`libc` P/Invoke), so check whether that
  still holds before assuming anything is runnable here.

**Scope this before committing to it.** It is the largest item and part of it depends on upstream. A
scoping pass that produces a plan and an honest "this part is blocked on X" is a good outcome.

## 3. R114 — `explain`'s R91 prescription can never fire

A stranded mutant records `cause: undefined`: the in-flight-unknown branch in `orchestrator.ts`
writes a rich `failureNote` and `break`s before the `cause = "deadline-exceeded"` assignment in the
branch below. So `lethal explain`'s R91 prescription is keyed on the right machine value and still
never fires for the case R91 measured. Confirmed on real data — all three errors in
`rung1.run2-partial` carry `cause: undefined`.

The row states the open question: reuse `deadline-exceeded`, or add a distinct `"stranded"` member.
They mean different things — `deadline-exceeded` currently means "the budget elapsed and we know the
mutant is done", a strand means "we do not know" — so decide it deliberately. This changes what a
run RECORDS, so it needs its own red-check.

Acceptance is stated in the row: an explain projection over a report containing a strand must emit
the R91 prescription. That is the property it cannot have today.

## The defect this repo produces, fifteen times over

Across the last session, fifteen separate things shipped that **could not fail**. Mutation caught
every one; reading caught none. A doctor check hardcoded to pass and advertised in the README. Four
tests green under the exact regression they claimed to pin. A corrupted report projecting
byte-identically to an empty one. Four numbers swappable with the whole runner package green. A
fixture whose value matched the production default, so a mutant ignoring the file entirely passed
15/15.

Rules that earned their keep, and why:

- **Red-check with the mutation that models the drift you named**, not the one that deletes the
  mechanism. Deleting a mechanism proves the mutation is real; it does not prove the test earns its
  place. One implementer's tripwire looked like decoration until a reviewer built the *precision-
  relabel* mutation it was actually for — then it was the only test in 1396 that caught it.
- **Ask for the CONSEQUENCE, not the code.** "Is the bad outcome now impossible?" finds what "was
  the fix applied?" misses.
- **Reviewers reproduce red-checks; they never read them.** Every review prompt should say so.
- **A guard that polices one dimension does not police another.** Four guards policed prose and
  paths and none policed VALUES — swapping four numbers left the whole package green.
- **`bun test` cannot see type-level guarantees.** Typecheck is a separate step here, so a
  `satisfies`/`Record<>` guard is invisible to the test runner. One was found entirely inert because
  its type was unimported.
- **Do not cite `file.ts:NNN` across files** (R117). Four measured instances of rot, two of which
  invalidated their own pointer in the commit that wrote them — one comment pushed its target down
  by exactly its own length. Cite greppable names.
- **A realistic fixture value that coincides with a production default makes the test blind.** That
  is how the eleventh got in.
- **Verify a subagent's factual claims before building on them**, including claims about session
  state. Several were wrong in ways that mattered; several were right in ways that changed the plan.
- **Plans in this repo contain factual errors.** Six were found last session, one of which invalidated
  an entire task's premise. Check load-bearing plan claims against the code before dispatching.

## Operational gotchas — these cost real time

- **Run `bun run typecheck` and `bun test` as SEPARATE tool calls.** The clean-dist hook is
  PostToolUse, so chaining them means the test run sees the `dist` typecheck just generated. The
  trap presents as **~3300 tests across ~230 files with ~44 failures** — that is the trap, not your
  code.
- **The roadmap is one file per row now.** `docs/roadmap/R<nnn>.md` is the record; `ROADMAP.md` is
  GENERATED — never hand-edit it. File a row by writing the file and running
  `bun scripts/roadmap-index.ts`. Reading a row means reading its file (R118: field-wise reads of the
  old table silently returned a fraction of a row and looked complete).
- **`scripts/` is typechecked now** (R119), by an explicit file list in `scripts/tsconfig.json`.
  Eight scripts are deliberately excluded and named in R120 — do not admit one by relaxing a flag.
- **`git clean -f`, `git stash drop` and `git checkout --` are blocked by the safety net.** To
  restore a tracked file use `git show HEAD:<path> > <path>`.
- **Do not sweep for build output with a recursive PowerShell glob.** `Get-ChildItem -Recurse
  -Include *.d.ts` under `packages/` follows workspace symlinks into `node_modules` and deletes real
  dependency files. It also deleted a tracked, hand-written `wasm-asset.d.ts`. If you must, exclude
  `node_modules` explicitly and check `git status` after.
- **Worktrees:** `git worktree add <path> -b <branch> HEAD` (NOT `EnterWorktree`, which branches from
  `origin/master` and would silently drop local commits). `node_modules` is not shared — run
  `bun install` in the new worktree.
- **A test that passes only in a worktree is a real bug.** One asserted `.git` is a FILE, true in a
  worktree and false in a normal clone; it passed on the branch and failed on master. Verify a
  merged result on master, not just on the branch.

## Live gates

R86 and R114 both change what a run records, so **both frozen gates must pass per-mutant before
merging either**:

```bash
LETHAL_ITEST_BCDEV=1 bun run itest:bcdev      # frozen: 3 killed / 10 survived / 3 no-coverage
LETHAL_ITEST_TABLES=1 bun run itest:tables    # frozen: 109 / 17 / 10 over 136 deployed,
                                              # untargetedTriggerCount 0, EXACTLY ONE expected
                                              # baseline failure — Data Tests.PageActionComputesNonZero
```

A differing verdict is a BLOCK, never "close enough". Use `/live-gate`. `itest:alrunner` is expected
red — that is R93, not a regression. Four Cronus containers were up last session
(`docker context use desktop-windows` first — the session default is the Linux engine). Both gates
need gitignored files that do not exist in a worktree: `fixtures/*/lethal.config.local.json` AND
`fixtures/sandbox-app/.vscode/launch.local.json`. A missing `launch.local.json` fails with `ENOENT`
and reads exactly like a regression. Copy them from the main checkout first.

## Do not touch

- **`docs/campaign/**`** — committed pre-commitment records. Editing one after the fact is what the
  campaign gates exist to prevent. Corrections go in that directory's README as a forward note.
- **Dated plans under `docs/superpowers/plans/`** — records of what was planned on a date. If the
  tooling they name has been replaced, add a superseded header; do not rewrite the body.

## Two loose ends the user owns

- A stash entry `task2-lint-check-1785952619` is redundant (its tree is byte-identical to merged
  commit `d6ba04b`) but `git stash drop` is blocked by the safety net. Surface it; do not work around it.
- `.claude/skills/live-gate/SKILL.md` has another session's uncommitted edit (the al-runner v2 / R93
  skip guidance). Leave it alone unless the user says otherwise.

## When each item finishes

Merge it, remove the worktree, then start the next. After all three, report what shipped, what was
deferred with rulings, and anything the roadmap rows got wrong that the work revealed — recording
those is more useful than a clean summary.
