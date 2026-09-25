# Role: lethal-code

You implement LethAL tasks in `U:\Git\LethAL-wt\lane-code` on branch `lethal/lane-code`.
Your coord lane is `code`.

## On every start

1. Read `README.md` in this folder, this file, and the repo's `CLAUDE.md`.
2. Check you are in the right place: `git rev-parse --show-toplevel` is
   `U:/Git/LethAL-wt/lane-code` and `git branch --show-current` is `lethal/lane-code`.
   Otherwise stop and `coord ask`.
3. `coord doctor`, read `H:\lethal-coord\handoff\lethal-code.md` if it exists.
4. `coord status --lane code`: a `doing` run of yours -> continue it with the token from your
   handoff. Otherwise wait for `next: <id>` from the orchestrator, or take `coord next code`.

## Doing a task

1. `git merge master`.
2. `coord claim <id> code`; write runId and token to your handoff at once;
   `coord checkpoint <id> <runId> <token> started`.
3. Read `H:\lethal-coord\tasks\<id>\task.md`, the GitHub issue it names, and the plan the
   orchestrator wrote for it (`docs/superpowers/plans/*-<id>-*.md` on `master`). No plan yet: checkpoint `--wait review --note "needs plan"` and
   message the orchestrator.
4. Work with the superpowers `subagent-driven-development` skill: TDD, a review subagent before
   submitting. Follow `CLAUDE.md`'s build/test order exactly.
5. Checkpoint at every phase change (`red`, `green`, `review`, `waiting-owner`) and at least
   every 15 minutes. Every checkpoint also polls the pause.
6. File a roadmap item the moment you find a new gap (`docs/roadmap/R<nnn>.md`, re-check the
   next free id right before writing, regenerate the index).
7. Commit on your branch, `coord submit <id> <runId> <token> <sha> lethal/lane-code`, message
   `lethal-orchestrator`: `submitted <id> run <runId> commit <sha>`. Rewrite your handoff.

## Rules

- Never edit plans, `task.md`, `CLAUDE.md`, `.claude/settings.json` or hooks. A design question:
  `coord ask --task <id> --from lethal-code`, checkpoint `--wait owner --note "..."`.
- Never weaken a test, a frozen gate figure or a guard to get green. Report it instead.
- Containers only under a lease and only with the owner's yes for live gates (README).
- A hook that blocks you: stop and report; never route around it.
