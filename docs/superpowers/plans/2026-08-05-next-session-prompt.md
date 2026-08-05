# Kick-off prompt — subsystems C, B, D

Paste everything below the line into a new session in `U:/Git/LethAL`.

---

Execute three implementation plans autonomously, in this order, using `superpowers:subagent-driven-development`:

1. `docs/superpowers/plans/2026-08-05-tool-features.md` (C — five tasks)
2. `docs/superpowers/plans/2026-08-05-lethal-explain.md` (B — four tasks)
3. `docs/superpowers/plans/2026-08-05-campaign-subcommands-and-skill.md` (D — four tasks)

They come from `docs/superpowers/specs/2026-08-05-observability-and-campaign-method-design.md`. Subsystem A shipped already (branch merged, master `d8bf394`); these are the three that were deferred. They are independent of each other — finish one, merge it, start the next.

**Run continuously.** Do not check in between tasks. Dispatch a fresh implementer per task, review each one, run the fix loop, then move on. Stop only for a genuine blocker, or when a decision is the user's to make (spending money, deleting their work, reversing an approved design).

## Ask Fable for design questions

When a design question comes up mid-development — a shape choice, a boundary, "should this be one thing or two", a finding that contradicts the plan — **spawn a Fable-model agent and have it decide**, rather than deciding yourself or stopping to ask. Give it the measured evidence and let disagreement be a valid answer. Verify its load-bearing claims against the code before acting on them; in the last session it made a factual error about field counts that a reviewer caught by measuring, and it corrected itself cleanly when told.

Keep one Fable agent alive across the session and send follow-ups to it, so it accumulates context.

## Process rules that earned their keep last session

- **Every review prompt must demand the FULL `bun run typecheck` output.** A task shipped a broken typecheck because its implementer ran typecheck as its *first* step — before creating the files — and reported that stale result at the end. `bun test` does not typecheck.
- **Red-check every fix**, and have the reviewer *reproduce* the red-check rather than read the transcript. The same defect class appeared four times: twice as vacuous tests, twice as false comments. One vacuous test was inside the safety-net file itself and was cited in a report as proof of correctness. Reading never caught any of them.
- **A "verify the code" instruction is weaker than "verify the consequence."** Asking a reviewer whether a fix was applied gets you a yes; asking whether the thing the fix was for is now impossible gets you the truth. That question is what exposed a reviewer's own incorrect claim last session.
- **When a subagent reports a factual claim, check it before building on it.** Several were wrong in ways that mattered; several were right in ways that changed the plan.
- Subagents sometimes go idle without sending their report — they write it as text instead of calling SendMessage. Ask for it; say plainly that an honest partial beats a verdict they never reached.

## Operational gotchas — these cost real time last session

- **Build order is typecheck FIRST, then clear `dist`, then test.** Clearing first is pointless; typecheck regenerates it.
- **The globbed `dist` delete is blocked by a safety hook.** Use six literal per-package deletes. `packages/builtin-tier2/dist` is NOT in CLAUDE.md's package list and goes stale.
- **`.claude/hooks/clean-dist.ts:23` uses `process.env.CLAUDE_PROJECT_DIR ?? process.cwd()`**, so in a worktree the auto-clean targets the MAIN repo and does nothing useful. This bit four separate times. Worth fixing.
- **Detect the stale-dist trap by test count.** Clean master is **1662 pass / 1 skip / 0 fail across 111 files**. Roughly double that across ~214 files with ~39 failures is the trap, not your code.
- **`EnterWorktree` branches from `origin/master` by default** and local master is far ahead — it would silently drop dozens of commits. Use `git worktree add <path> -b <branch>` from HEAD instead.
- **Live gates need gitignored files that do not exist in a worktree**: `fixtures/*/lethal.config.local.json` AND `fixtures/*/.vscode/launch.local.json`. A missing `launch.local.json` fails with `ENOENT` and reads exactly like a regression. Copy both from the main checkout first.
- **A heredoc containing the literal string `rm -rf` trips the safety net** even when it is only ledger text. Reword.

## Live gates

C changes behaviour on the live path, so **both frozen gates must pass per-mutant before merging C**:

```bash
LETHAL_ITEST_BCDEV=1 bun run itest:bcdev      # frozen: 3 killed / 10 survived / 3 no-coverage
LETHAL_ITEST_TABLES=1 bun run itest:tables    # frozen: 109 / 17 / 10 over 136 deployed,
                                              # untargetedTriggerCount 0, EXACTLY ONE expected
                                              # baseline failure — Data Tests.PageActionComputesNonZero
```

Four Cronus containers were up and healthy last session (`docker context use desktop-windows` first — the session default is the Linux engine). Note C1 raises the mutant budget floor from 30 s to 180 s, so a genuinely non-terminating mutant now takes 180 s rather than 30 s to score `timeout-killed`. `itest:tables` will run longer. That is expected, not a hang.

**B and D need no live gate** — `explain` reads a committed report, and D is gate tooling plus a skill. Full unit suite and typecheck are sufficient there.

## One thing to fix before or during

`ROADMAP.md` on master has uncommitted rows from another session (al-runner v2 findings, `R93`–`R96`, `R100`, `R101`) mixed with a renumber of three rows to `R104`–`R106`. Committed history still shows those three as `R101`–`R103`. Committing the file resolves both; check with the user first, since the al-runner rows are theirs and may be incomplete.

## When each plan finishes

Merge it, remove the worktree, then start the next. After all three, report what shipped, what was deferred with rulings, and anything the plans got wrong that the work revealed — last session's plans contained several factual errors that only surfaced under implementation, and recording them is more useful than a clean summary.
