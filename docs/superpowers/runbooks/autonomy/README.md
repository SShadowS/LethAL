# LethAL autonomous run: protocol and launch contract

Four Claude Code sessions (an orchestrator and three lanes) work through LethAL's open GitHub issues, coordinated through
`agent-coord` (`U:\Git\agent-coord`). The same tool coordinates CentralGauge; both projects
share the BC containers, so they share container leases and the owner's pause.

## Sessions

| Session | Worktree (host) | Container | Branch | Does | Never does |
| --- | --- | --- | --- | --- | --- |
| `lethal-orchestrator` | `U:\Git\LethAL` | `/work/lethal` | `master` | plans per task, `task.md` files, reviews, merges, pushes, closes GitHub issues, asks the owner | writes product code, resolves merge conflicts by writing code, re-records a gate baseline, loosens a hook or rule |
| `lethal-code` | `U:\Git\LethAL-wt\lane-code` | `/work/lethal-wt/lane-code` | `lethal/lane-code` | the c02 epic (coord lane `code`): implements tasks with TDD and subagents, files roadmap items, runs live gates on Cronus28 under a lease (standing owner authorization) | pushes, edits plans or `task.md`, starts or restarts containers |
| `lethal-bugs` | `U:\Git\LethAL-wt\lane-bugs` | `/work/lethal-wt/lane-bugs` | `lethal/lane-bugs` | the standalone `GH-*` issues (coord lane `bugs`), same rules as `lethal-code` | same as `lethal-code` |
| `lethal-preproc` | `H:\LethAL-wt\lane-preproc` | `/work/lethal-wt/lane-preproc` | `lethal/lane-preproc` | the `#if` preprocessor roadmap family (coord lane `preproc`), same rules as `lethal-code` | same as `lethal-code` |

`CLAUDE.md` in the repo still applies in full: the build/test order (typecheck, then
`rm -rf packages/*/dist`, then `bun test`), biome on touched files only, `compile:fixtures`
after any fixture `.al` change, and the roadmap rules (`docs/roadmap/R<nnn>.md`, re-check the
next free id right before writing).

## Working rules for every session (owner, 2026-10-03 to 2026-10-05)

- **Pick the model per task, not Opus for everything.** Set `model` on every Agent call:
  `haiku` for lookups, greps and status reads; `sonnet` for mechanical work (the build/test loop,
  running a gate and reporting figures, red-checks that follow a recipe, routine edits, regenerating
  the roadmap index); `opus` for design, plans, hard root-causing and reviewing verdict logic. A
  session's own model is set by the owner, not by the session.
- **Edit files only with the Edit and Write tools.** Never `sed -i`, inline scripts or shell
  redirects (`printf`/`cat >>`) on any file, including temporary red-check reverts. Put this sentence
  in every subagent brief.
- **Never let a subagent grep or print a credential file.** Briefs name the non-secret config fields.
- **A task branch lives in its own worktree** (`/work/lethal-wt/<task>`); a lane worktree stays on
  its lane branch, or kraken refuses to start.
- **Reviews:** gpt-6.1-sol through `pi_ask` (provider `openai-codex`). For any two-way check, require a
  red-going test for EACH direction; "it works both ways" is not evidence.
- **Submit only on green CI, both jobs.** Push the task branch; `check` (Windows) and `unit-linux`
  must both pass, and the submit note names the run id. The container is Linux, so CI is the only
  Windows check.
- **Never pipe a gating command into `grep` or `tail` before `&&`.** The pipeline's status is the
  last command's. Use `set -o pipefail;` if the output must be trimmed.
- **A lone timeout in a full `verify` while another full `verify` overlaps is starvation, not a
  result** (R482): keep the log, re-run once, and investigate only if it fails again or fails with
  no overlap. Never raise a timeout to make it pass.
- **At most two BaseApp-corpus jobs at once.** The container has 24 GB; a third census or diff
  process gets OOM-killed (R-458 planner, 2026-10-05).
- **Push work early, but WIP pushes carry `[skip ci]`** in the head commit's message. Unplanned
  restarts happen, so push; but CI runs on every branch and every red run emails the owner. Push
  WITHOUT `[skip ci]` only when you want a real CI result (before submitting, or to reproduce a
  Windows-only failure); the submitted head must have a CI run.
- **Measure a corpus once per master commit, and reuse it (owner, 2026-10-08).** A full
  BC.History dump of master costs hours, and plan rounds repeated it. Keep master's dump in
  `/coord/cache/dumps/<master sha>/<set>/` (sets: `bch`, `cdo`, `dc`, `do`, `fixtures`), with a
  `DONE` file written last. Before dumping master, look there; another lane or an earlier round may
  have it. A build's dump re-reads only the projects its change can touch (the R-487 keydiff
  approach) and compares against the cached master. Re-dump master only when master moved and the
  move touches mutant generation. Say in your report which cache entry you used. A cache entry is
  never edited, only replaced whole.
- **A lane commits its own pre-commitment to `master` (owner, 2026-10-08).** Once a pre-commitment
  is written (and plan-reviewed), commit it yourself, specs-only, as
  `docs/superpowers/specs/<date>-<id>-...-precommitment.md` with `[skip ci]`, BEFORE any live run.
  Commit it from a scratch worktree of `origin/master` (never from your task branch, never from the
  main checkout), then `git push origin HEAD:master`; on a rejected push, fetch, rebase and push
  again. Touch nothing else in that commit. Send the orchestrator its sha
  with your next message. The rule is unchanged: the file lands on master before the run, and a
  differing result is a block, never a re-record. The orchestrator still commits the adopted plan.

## coord

```
bash scripts/coord.sh <command> ...
```

Inside a kraken container (`KRAKEN_PROJECT` is set) this runs `kraken coord` against the
project's own root. On the Windows host it runs agent-coord against
`H:\lethal-coord` and ignores an inherited `CG_COORD_ROOT` (the machine-wide default points at
CentralGauge's root); once the host root carries a `MOVED-TO-KRAKEN` marker it prints the marker
and exits 3. Below, `coord` means that command, and `<coord root>` means `/coord` in the
container and `H:\lethal-coord` on the host. Never expand `$CG_COORD_ROOT` on the host: it can
name CentralGauge's shared root.

- Tasks: `GH-<n>` for standalone issues, `C02-0N` for the children of epic #10 (c02), with the
  epic's own dependency order. Each `task.md` carries the issue number and URL.
- Lifecycle: `claim` -> `checkpoint` (at every phase change and at least every 15 minutes) ->
  `submit` -> orchestrator `accept` or `reject`. `fail` gives up an attempt. Dependencies unlock
  only on `accepted`, which means merged into `master`.
- `coord ask "<what you need>" --task <id> --from <session>` followed by
  `coord checkpoint ... --wait owner --note "<one line>"` for anything that needs the owner.
- Queries: `coord overview`, `coord why <id>`, `coord next code`, `coord questions`, `coord stale`.
- Status screen: host only, `pwsh -File U:\Git\agent-coord\status.ps1 -CoordRoot H:\lethal-coord`.
  In the container use `kraken tentacle status` and `bash scripts/coord.sh overview`.

## Containers, leases and the pause (shared with CentralGauge)

On the host, `H:\lethal-coord\coord.json` sets `machineRoot` to `H:\cg-coord`, so LethAL leases
and the owner's pause live in the same folder CentralGauge uses. A LethAL lease is seen by
CentralGauge's lanes and the other way round.

Inside the container the machine root is `/coord/machine`, with strict allocation: exactly the
containers assigned to this project can be leased. A missing `allocation.json` there is an error
(`coord-status.ts` refuses), not "no containers".
**The owner's host pause is not seen there.** To pause the container's sessions use
`kraken tentacle stop` (host) or `bash scripts/coord.sh pause` (inside).

- **LethAL may use `Cronus28` and `Cronus284`** (owner allocation 2026-09-25, Cronus284 added
  2026-09-26, enforced by coord through `H:\cg-coord\allocation.json`). Cronus281, Cronus282 and
  Cronus283 belong to CentralGauge; never lease or publish to them. **Owner (2026-09-27): load
  balance across both.** Each container runs one gate at a time under a coord lease; the two lanes
  use whichever is free (the orchestrator may assign one per lane). Cronus28 carries every fixture
  (`sandbox-app`, `sandbox-data`, `sandbox-hang`, ...). Cronus284 carries the control app and the
  `sandbox-data` pair only (others unpublished 2026-09-26). Which control version a container has
  installed is machine state, not repo state: `lethal doctor --config <path>` reads it from the
  server (its `control-version` check), and the client requires the version in
  `extensions/lethal-control/app.json`. Publish a fixture pair on Cronus284 before its
  first gate, and point a lane's gitignored `lethal.config.local.json` at `http://Cronus284` for that
  run. Both have stalled on TestPage tests (R236, `docs/measurements/2026-09-27-nst-wedge-incidents.md`);
  an unrecoverable container goes to the owner.
- Before any work that touches it (live gates, control-app publish, fixture publish): check it
  is running (host only: `pwsh -File U:\Git\agent-coord\containers.ps1 status -Names Cronus28`;
  in the container, `kraken tentacle status`), then
  `coord lease Cronus28 <lane>`, heartbeat every 5 minutes, release right after. Held by
  another lane: wait.
- **Standing owner authorization (2026-09-25): Cronus28 is LethAL's to use freely.** Publishing
  to it and running live gates on it need no further `coord ask`. Everything else in this file
  still holds: lease it first, heartbeat, release, one gate at a time, and a moved frozen figure
  or a re-recorded baseline still goes to the owner.
- **Cronus28's one-time setup was done 2026-09-25 by the orchestrator:** control app 1.0.0.18
  (Global), then through the dev endpoint `sandbox-app`, `sandbox-tests`, `sandbox-probes`,
  `sandbox-hang`, `sandbox-hang-tests`, `sandbox-data`, `sandbox-data-tests`, `gift-card`,
  `gift-card-tests`, all built fresh from `master`. Microsoft's test libraries (`Library Assert`,
  `Test Runner`, `Any`, `Library Variable Storage`, `Permissions Mock`) were already installed.
  Leave the Continia and `CG Test Harness` apps on it alone. After changing a fixture's AL, rebuild
  and republish that app (see `.claude/skills/control-app`, section on the dev endpoint).
- The gitignored `fixtures/*/lethal.config.local.json` and
  `fixtures/sandbox-app/.vscode/launch.local.json` point at Cronus28 in the main checkout AND in
  each lane worktree, so a lane can gate its own branch. Acceptance gates run on the merged tree in
  the main checkout.
- A stopped container: `coord ask`, never start it.
- Live gates (`itest:bcdev`, `itest:tables`, `itest:chunked`, `itest:hang`, `itest:envtool`)
  run only on Cronus28 and only under a lease, and need no `coord ask` (standing authorization
  above). `itest:alrunner` runs locally and needs no container. A differing verdict or moved
  frozen figure is a block reported to the owner; never re-record a baseline yourself.
- **al-runner: use the pinned source build c39ad5de** (since 2026-10-02). It carries upstream's
  fix for R345 (concurrent sessions crashing on the shared ncl-shadow cache, #5018/#5019), so lanes
  no longer take turns. The released global v2.12.0 still has the defect: never run it beside
  another al-runner session.
  - **On the Windows host only:** `H:/al-runner-builds/c39ad5de/al-runner.exe`; set it as
    `LETHAL_ALRUNNER_PATH` and as `alRunner.alRunnerPath` in your gitignored fixture configs.
  - **Inside the kraken container:** al-runner is a daily local build of upstream `main`, not the
    pinned c39ad5de: `/work/tools/al-runner/current/al-runner`. `scripts/al-runner-update.sh` builds
    it and moves `current` onto it only after `itest:alrunner` passes on that build (until the first
    update, `current` points at the c39ad5de build baked into the image). It is already in
    `LETHAL_ALRUNNER_PATH` there and the container's fixture configs already name it: do not
    overwrite either with the host path.
- Pause: `coord checkpoint` answers `"paused": true` while the owner has paused the machine.
  Finish the running step (never kill a live gate midway), release leases, commit, checkpoint
  `--wait paused`, and go idle until the orchestrator says `resume`.

## Launch contract

- Approvals: the orchestrator plus GPT-6.1 Sol via `pi_ask` (`gpt-6.1-sol`, `require_evidence`
  on, frozen `git show <sha>:<path>` copies under `<coord root>/reviews/`), at most 2 rounds.
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

In the container the tentacle resumes each session itself; do nothing. On the host:
`claude --resume <session-name>`, then: `Resume. Follow the "On every start" section of your
role file.` State lives in coord and git, never in chat.
