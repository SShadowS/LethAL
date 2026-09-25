# LethAL autonomous run: protocol and launch contract

Two Claude Code sessions work through LethAL's open GitHub issues, coordinated through
`agent-coord` (`U:\Git\agent-coord`). The same tool coordinates CentralGauge; both projects
share the BC containers, so they share container leases and the owner's pause.

## Sessions

| Session | Worktree | Branch | Does | Never does |
| --- | --- | --- | --- | --- |
| `lethal-orchestrator` | `U:\Git\LethAL` | `master` | plans per task, `task.md` files, reviews, merges, pushes, closes GitHub issues, asks the owner | writes product code, resolves merge conflicts by writing code, runs live gates, loosens a hook or rule |
| `lethal-code` | `U:\Git\LethAL-wt\lane-code` | `lethal/lane-code` | implements tasks with TDD and subagents, files roadmap items, runs live gates only when the owner said yes | pushes, edits plans or `task.md`, starts or restarts containers |

`CLAUDE.md` in the repo still applies in full: the build/test order (typecheck, then
`rm -rf packages/*/dist`, then `bun test`), biome on touched files only, `compile:fixtures`
after any fixture `.al` change, and the roadmap rules (`docs/roadmap/R<nnn>.md`, re-check the
next free id right before writing).

## coord

```
CG_COORD_ROOT=H:\lethal-coord deno run --allow-all U:\Git\agent-coord\coord.ts <command> ...
```

Always pass `CG_COORD_ROOT=H:\lethal-coord`: the machine-wide default points at CentralGauge's
root. Below, `coord` means that full command.

- Tasks: `GH-<n>` for standalone issues, `C02-0N` for the children of epic #10 (c02), with the
  epic's own dependency order. Each `task.md` carries the issue number and URL.
- Lifecycle: `claim` -> `checkpoint` (at every phase change and at least every 15 minutes) ->
  `submit` -> orchestrator `accept` or `reject`. `fail` gives up an attempt. Dependencies unlock
  only on `accepted`, which means merged into `master`.
- `coord ask "<what you need>" --task <id> --from <session>` followed by
  `coord checkpoint ... --wait owner --note "<one line>"` for anything that needs the owner.
- Queries: `coord overview`, `coord why <id>`, `coord next code`, `coord questions`, `coord stale`.
- Owner status screen: `pwsh -File U:\Git\agent-coord\status.ps1 -CoordRoot H:\lethal-coord`.

## Containers, leases and the pause (shared with CentralGauge)

`H:\lethal-coord\coord.json` sets `machineRoot` to `H:\cg-coord`, so LethAL leases and the
owner's pause live in the same folder CentralGauge uses. A LethAL lease is seen by
CentralGauge's lanes and the other way round.

- Before any work that touches a BC container (live gates, control-app publish, fixture
  publish): check it is running
  (`pwsh -File U:\Git\agent-coord\containers.ps1 status -Names Cronus281`), then
  `coord lease Cronus281 code`, heartbeat every 5 minutes, release right after. Held by
  CentralGauge: wait, do not take another container the fixtures are not on.
- A stopped container: `coord ask`, never start it.
- Live gates (`itest:bcdev`, `itest:tables`, `itest:envtool`, and anything publishing to a
  container) are user-invoked by this repo's rules. The lane runs one only after the owner
  answered yes to a `coord ask` naming the exact gate. `itest:alrunner` runs locally and needs
  no container.
- Pause: `coord checkpoint` answers `"paused": true` while the owner has paused the machine.
  Finish the running step (never kill a live gate midway), release leases, commit, checkpoint
  `--wait paused`, and go idle until the orchestrator says `resume`.

## Launch contract

- Approvals: the orchestrator plus GPT-6 Sol via `pi_ask` (`gpt-6-sol`, `require_evidence`
  on, frozen `git show <sha>:<path>` copies under `H:\lethal-coord\reviews\`), at most 2 rounds.
  `gpt-6-astra` only for the c02 epic's plan. Unresolved after 2 rounds: `coord ask`.
- Authorized: lane commits on its branch; orchestrator merges to `master`, pushes to `origin`,
  and closes the task's GitHub issue with `gh issue close <n> -R SShadowS/LethAL --comment
  "Done in <sha>"` after `coord accept`.
- Forbidden without the owner: publishing a package or release, starting/stopping/recreating
  containers, force pushes or history rewrites, weakening a test, a frozen gate figure or a
  hook to get green, editing `CLAUDE.md` or `.claude/settings.json`, re-recording a live gate
  baseline.
- Always reported to the owner: a frozen gate figure that moved, a test that looks wrong, an
  uncertain lease or run owner, an unresolved reviewer objection, a hook blocking needed work.
- The owner's own interactive LethAL sessions also commit to `master`. The orchestrator
  merges onto the current `master` every time and re-runs checks on the merged tree.

## Restart

`claude --resume <session-name>`, then: `Resume. Follow the "On every start" section of your
role file.` State lives in coord and git, never in chat.
