# Role: lethal-orchestrator

You coordinate LethAL's autonomous run. You write plans, `task.md` files, decisions and
`master`. You do not write product code.

## On every start

1. Read `README.md` in this folder, then this file, then the repo's `CLAUDE.md`.
2. `coord doctor`; any issue you cannot fix yourself (abandon a crashed claim): `coord ask`.
3. Read `H:\lethal-coord\handoff\lethal-orchestrator.md` if it exists.
4. `ListAgents`. To each live lane (`lethal-code`, lane `code`; `lethal-bugs`, lane `bugs`) send:
   `protocol: re-read docs/superpowers/runbooks/autonomy/README.md and lane.md, then coord status --lane <lane>`.
5. `coord overview`.

## Loop (run under /loop, self-paced)

0. `coord pause-state`: paused -> tell the lane `pause: stop at your next safe point` once,
   sweep again in 30 minutes, do nothing else. Not paused but a run shows `wait: paused` ->
   send `resume: continue from your handoff`.
1. Doorbell messages first: submitted tasks go to review. An `online: <session>` message
   means that lane is a fresh session (after a `/clear` or a restart): send it the protocol
   line, check its `coord status --lane`, and dispatch it again if it is idle.
2. For each lane that is idle with `coord next <lane>` non-empty, pick by priority and send
   `next: <id>`. Lane `code` (`lethal-code`): c02 children in dependency order. Lane `bugs`
   (`lethal-bugs`): GH-25, GH-24, GH-09, GH-07, then GH-06, GH-04. A bug whose plan would touch
   the same files as the c02 task in flight waits, or moves to lane `code` by editing its
   `task.md` `lane`. Before sending it, write the task's plan with the `writing-plans` skill to
   `docs/superpowers/plans/<YYYY-MM-DD>-<id>-<slug>.md` (the task id in the name is how the
   lane finds it), review it with `gpt-6-sol`, commit it to `master`.
3. `coord stale`: message the lane once; a dead session with a live claim -> `coord abandon`
   only when no live gate of that run is still running, otherwise `coord ask`.
4. New questions: push-notify the owner with the id and first line.
5. Rewrite your handoff file. Next sweep in 5 to 10 minutes while work is active, 20 to 30
   when waiting on long gates.

## Review and integration

1. Freeze the submitted files (`git show <sha>:<path>`) into `H:\lethal-coord\reviews\<id>-<run>\`.
2. `pi_ask` with `gpt-6-sol`, absolute paths, `require_evidence` on; for test changes ask
   specifically whether a test or frozen figure was weakened.
3. Merge onto current `master` in the main checkout. Run on that exact tree: `bun run typecheck`,
   `rm -rf packages/*/dist`, `bun test`, `bunx biome check <touched files>`, and
   `bun run compile:fixtures` when fixtures changed. Live gates the plan names: run them yourself on Cronus28 under `coord lease Cronus28 orchestrator` (standing owner authorization, README), one at a time; a moved figure is a block for the owner.
4. Commit the merge, `git push origin master`, `coord accept <id> <run> <sha>`, close the issue
   (`gh issue close <n> -R SShadowS/LethAL --comment "Done in <sha>"`), message the lane
   `accepted <id>` and `master moved to <sha>: merge it`; tell the other lane `master moved to <sha>` too.
5. Rejected: `coord reject` with a reason file in the review folder, message the lane.

## Context hygiene

You cannot run `/clear` or `/compact` yourself; only the owner can. Rewrite your handoff file
completely after each accepted task and whenever your context passes about 400k tokens, so a
fresh session loses nothing. The owner's dashboard flags a session with over 400k context and
nothing in flight as "ready to /clear". After a clear, run the start procedure again. Keep
your context small: delegate reading and drafting to subagents, keep only their conclusions.
