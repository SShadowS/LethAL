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
  Windows check. A local verify quoted in a submit note is the `VERIFY FULL` line of
  `bun scripts/verify.ts` with no arguments; `--changed` and package runs print `VERIFY PARTIAL`,
  exit 4 even when every test passes, and are an inner loop only (R593).
- **Never pipe a gating command into `grep` or `tail` before `&&`.** The pipeline's status is the
  last command's. Use `set -o pipefail;` if the output must be trimmed.
- **A lone timeout in a full `verify` while another full `verify` overlaps is starvation, not a
  result** (R482): keep the log, re-run once, and investigate only if it fails again or fails with
  no overlap. Never raise a timeout to make it pass.
- **At most two BaseApp-corpus jobs at once.** At 24 GB a third census or diff process was
  OOM-killed (R-458 planner, 2026-10-05). Since 2026-10-22 the container has 32 GB: the heavy-job
  limit is THREE, but still at most TWO of them may be BaseApp (BC.History) corpus jobs (three of
  those would not fit with margin). The heavy-job limit counts corpus jobs and
  local runners (itest:alrunner, the Rust runtime); a BC gate against a remote server (bc1/bc2/bc3) is
  about 100 MB locally and does NOT count: run up to one per bc server in parallel, and back off if
  `free -g` shows under 10 GB available (2026-10-21). A parallel itest counts as ONE job: count its
  root `bun packages/runner/itest/` process (the one WITHOUT `--worker` in its argv), not its
  workers; it runs at `--parallel` 3 or lower (about 4 GB), under the same 10 GB back-off.
- **Push work early, but WIP pushes carry `[skip ci]`** in the head commit's message. Unplanned
  restarts happen, so push; but CI runs on every branch and every red run emails the owner. Push
  WITHOUT `[skip ci]` only when you want a real CI result (before submitting, or to reproduce a
  Windows-only failure); the submitted head must have a CI run. A clean MERGE commit as the
  submit head may start no CI run at all when the same push also carries `[skip ci]` commits
  (R-577, 1ab9cbdc): after pushing, check `gh run list --commit <sha>`; if there is no run, push an
  empty "CI run for the submit" commit on top.
- **Start CI as soon as the build review passes, not at submit (owner, 2026-10-22).** Push the
  reviewed head WITHOUT `[skip ci]` at once, so CI (median 5 min) runs while the live gates run.
  If later commits change code, push again for a fresh run; only the submitted head's run counts.
  A red run there is fixed before the gates are trusted, never after.
- **Measure a corpus once per master commit, and reuse it (owner, 2026-10-08).** A full
  BC.History dump of master costs hours, and plan rounds repeated it. Keep master's dump in
  `/coord/cache/dumps/<master sha>/<set>/` (sets: `bch`, `cdo`, `dc`, `do`, `fixtures`), with a
  `DONE` file written last. Before dumping master, look there; another lane or an earlier round may
  have it. A build's dump re-reads only the projects its change can touch (the R-487 keydiff
  approach) and compares against the cached master. Re-dump master only when master moved and the
  move touches mutant generation. Say in your report which cache entry you used. A cache entry is
  never edited, only replaced whole. The tool is `bun scripts/corpus-snapshot.ts snapshot <set>
  --master` and `diff <set> --branch <worktree> [--projects ...]` (R593); it keys each entry by its
  dumper (`<sha>/<set>/<dumperKey>/`) and takes one of three heavy slots, `/coord/locks/heavy.1`,
  `heavy.2` and `heavy.3`, with `flock`. It refuses a fourth heavy job, and a third BaseApp
  (BC.History) corpus job (R642). Known limit: two corpus jobs started from ONE shell (`a & b`) share a
  process group and count as one, and a job on a corpus COPY is invisible to its `ps` scan; such
  jobs take a slot themselves: `flock -n /coord/locks/heavy.<n> <cmd>`. A slot taken by hand like
  that writes no pid, so the tool counts it twice: once as a held slot and once as a running job.
  That errs on the safe side. A slot taken by hand (`flock heavy.N <cmd>`) counts toward the
  BaseApp cap only while one of its processes names /work/src/BC.History; a job over a COPY of the
  corpus counts toward the total cap only.
- **A lane commits its own pre-commitment to `master` (owner, 2026-10-08).** Once a pre-commitment
  is written (and plan-reviewed), commit it yourself, specs-only, as
  `docs/superpowers/specs/<date>-<id>-...-precommitment.md` with `[skip ci]`, BEFORE any live run.
  Commit it from a scratch worktree of `origin/master` (never from your task branch, never from the
  main checkout), then `git push origin HEAD:master`; on a rejected push, fetch, rebase and push
  again. Touch nothing else in that commit. Send the orchestrator its sha
  with your next message. The rule is unchanged: the file lands on master before the run, and a
  differing result is a block, never a re-record. The orchestrator still commits the adopted plan.
- **Speed rules (owner, 2026-10-21).** The waits, not the thinking, set our pace:
  - **One deep plan review, not rounds.** Measure first. Then brief the opus reviewer to do it all
    in ONE pass: attack every class-1 door, AND list every open "what else could break / what is
    unmeasured" question, AND propose the narrowing for anything over a cost bar. Fold everything
    in, and re-measure ONCE. A second review looks only at the changed parts (a delta brief, not the
    whole plan). A third full round needs a reason in the message to the orchestrator.
  - **Small tasks: ONE build review, no plan review (owner, 2026-10-22).** A task is small when its
    diff can move no verdict, kill, survive, refusal, lend or publish: docs-only, roadmap-only,
    test-only (new or tightened tests, no product change), a pure message or wording change, or a
    script that no gate, verify, merge chain, setup or campaign path runs, or a new fail-closed
    refusal in an operational path that can only BLOCK (never admit a build or change a verdict).
    For those: build
    test-first, red-check as usual, then one opus BUILD review of the final diff; no plan, no plan
    review, no delta rounds unless the build review finds a blocker. Anything that changes a
    verdict rule, a guard, a gate figure, what is deployed or what lends keeps the full process
    (plan, one deep review, pre-commitment). When unsure, it is not small; say which in the
    message to the orchestrator.
  - **Use the master dump cache (rule above) every time.** Before any master-leg dump, look in
    `/coord/cache/dumps/<master sha>/`. After a fresh master dump, WRITE it there with `DONE`, so
    the next lane and the next round reuse it. Branch legs re-dump only the projects the change can
    touch. Say in every measure report which cache entry was used or written.
  - **Nothing load-bearing in session scratch.** Restarts wipe it (three times in October). Tools go
    in the repo under `scripts/` (committed with `[skip ci]`); outputs, logs and evidence go in
    `/coord/handoff/<task>/` or `/coord/cache/`. A gate's log that is evidence for a submit is
    written to `/coord/handoff/<task>/` as it runs.
  - **Wait for at most one OTHER heavy job, not zero.** A driver that waits for an empty container
    can starve for hours. The limit stays two heavy jobs container-wide.
  - **Check before any status line (owner, 2026-10-21).** Before you report the state of background
    work (a gate, a driver, a queue), read its log and the running processes with their working
    directory. Never repeat the last state you remember: R-577 reported a confirm as "still waiting for
    a slot" an hour after it had PASSED, because the confirm and the slice queue ran as one background
    job, so the confirm's end raised no notification. Run each phase as its own background job (or
    watch the log's phase lines), so every phase's end reaches you.

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

- **LethAL uses the three BC on Linux servers `bc1`, `bc2` and `bc3`** (R589, owner allocation
  2026-10-21, enforced by coord through the allocation file). **`Cronus28` is PARKED** (owner,
  2026-10-21: unreachable at its new address; no lane waits for it, and the text about it below is
  kept for when it returns). **Cronus284 is
  CentralGauge's, not LethAL's** (owner, 2026-10-21; LethAL used it 2026-09-26 to 2026-10-20, and
  the measurements from that time stay as history). Cronus281, Cronus282, Cronus283 and Cronus284
  belong to CentralGauge; never lease or publish to them. Each server runs one gate at a time under
  a coord lease; lanes use whichever is free AMONG the servers proven for that gate (the bullet on
  proof below; the orchestrator may assign one per lane). Cronus28
  carries every fixture (`sandbox-app`, `sandbox-data`, `sandbox-hang`, ...). Which control version
  a server has installed is machine state, not repo state: `lethal doctor --config <path>` reads it
  from the server (its `control-version` check), and the client requires the version in
  `extensions/lethal-control/app.json`. Cronus28 has stalled on TestPage tests (R236,
  `docs/measurements/2026-09-27-nst-wedge-incidents.md`); an unrecoverable container goes to the
  owner.
- **The BC on Linux servers (R589).** BC 28.4 on server1 (192.168.2.157), reachable from the kraken
  container. W1 localization, company `CRONUS International Ltd.`, tenant `default`, instance `BC`,
  Basic authentication.

  | server | OData | dev endpoint | API |
  |---|---|---|---|
  | `bc1` | 7048 | 7049 | 7052 |
  | `bc2` | 7148 | 7149 | 7152 |
  | `bc3` | 7248 | 7249 | 7252 |

  - **Their databases are in memory.** A container restart or a server1 reboot resets each one to
    a fresh CRONUS, with no LethAL app on it. The fix is to re-run the setup script:
    `bun scripts/bc-linux-setup.ts --server bc1|bc2|bc3|all` (add `--dry-run` to see the plan). It
    takes and releases the coord lease itself, in your lane (`--lane`, else `KRAKEN_AGENT`; it refuses
    with neither, R598), writes each fixture's config and paired launch
    file, publishes LethAL Control and every app a BC gate needs (`sandbox-probes` included) over
    the dev endpoint (Dev scope), skips what is already there, and ends with `lethal doctor` on
    every config it wrote.
  - No BcContainerHelper and no Windows Docker context: everything goes over the dev endpoint.
  - The login is in the gitignored fixture config (`fixtures/<fixture>/lethal.config.<server>.json`,
    written by the setup script) and in `/coord/secrets/bc-linux.env`, which only the owner writes.
    Never print either. Select a server for a gate with `LETHAL_ITEST_CONFIG=lethal.config.bc1.json`;
    it requires `.vscode/launch.bc1.json` naming the same server, and the gate's first line names
    the target it measures.
  - The company is W1 `CRONUS International Ltd.`, not Cronus28's DK `CRONUS Danmark A/S`.
  - **Proof is PER SERVER (orchestrator ruling 2026-10-21).** A gate runs on a server only after
    its frozen figures have reproduced per mutant on THAT server, under the current fixture builds
    and the LethAL Control build master pins; any difference is a BLOCK. A proof on bc1 does not
    admit bc2: the servers can differ in app builds, in what else is installed (bc3 carries the
    Continia stack) and in the control build, and a proof holds only for the control build it ran
    under. Admitting a new (gate, server) pair is one ordinary run of the gate there.
    **As of 2026-10-21 (R-604), every BC gate is proven on every bc server under the control
    build master requires**: bcdev, bcdev-wrapped, bcdev-names, tables, verify, verify-scale,
    stale-publish, testapp, lease, chunked, hang, harden and agreement, on bc1, bc2 and bc3.
    The table, one row per pair with its log and control build, is `docs/gates/servers.md`
    §"Proof that the gates reproduce here". To reach it, bc2 was moved up to the pinned control
    build (`bc-republish.ts control`, an upgrade that removes nothing), and bc2's 13 and bc1's 9
    older proofs were re-proven under it. bc3's stale fixture apps were replaced first with
    `scripts/bc-republish.ts` (R599). The pre-committed app.json republish FAILED there (R605: a
    target a gate left at a minted version can only go back at a newer minted version); the
    minted restore was done under the orchestrator's ruling (a), `/coord/handoff/R-604/rulings.md`.
    Re-prove a server's gates whenever its control build or fixture apps change.
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
