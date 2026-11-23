# PR-368 pre-commitment (R1012): after a real server1 restart, `--resume-run` refuses because the database id changed

Written 2026-11-23, before any restart, so the next one is measured, not lost. **The restart is the owner's;** this task causes
none. It asks kraken to tell us when the next one happens.

## What is measured
R969's negative half, which is proven only offline so far (`orchestrator.test.ts`, "R969: the database id decides ..."):
- bc1-bc3 hold their databases in memory, so a server1 restart gives each a new database, with a new id and a new server
  generation;
- a `--resume-run` of a run recorded before the restart must then REFUSE (R680's `ServerGenerationChangedError`). It must
  not carry the verdicts as R969's lease-reset warning does, because the database ids differ.

## The kept run (made now, `/coord/handoff/PR-368/r1012/make-run.sh`)
- **Where:** a dedicated, kept worktree `/work/lethal-wt/r1012` (master 31d6928b5, set up for bc1 by
  `gate-worktree-setup.ts`).
- **The run:** under a bc1 lease, a `lethal run` of `fixtures/sandbox-app` into a scratch store,
  `/coord/handoff/PR-368/r1012/store.sqlite`.
  - It is stopped by ONE SIGTERM to its own recorded pid as soon as its baseline phase has ended. R955: the first SIGTERM
    spends the time budget, so the run ends on its own, unfinished.
- **What is recorded:** the run id, `server_generation` and `database_id` (`run.txt`, from `runrow.py`).
- **After:** doctor; the lease is released only when doctor is healthy.

## The one-command check (after the restart and `bun scripts/bc-linux-setup.ts --server bc1`)
`bash /coord/handoff/PR-368/r1012/check.sh after-restart` runs, under a bc1 lease, `--resume-run <the kept id>` against the
same scratch store.
- **PASS**, the claim:
  - the command exits non-zero;
  - its output holds R680's refusal: "None of its verdicts is carried (R680)", with "here they did not" (the database ids
    differ);
  - it does NOT hold R969's carry text ("across a lease reset");
  - and the store has no second run row that carried any verdict.
- **FAIL**, anything else, is filed against R969 at once:
  - a carry across the restart is a correctness defect: verdicts measured against a database that is gone;
  - a refusal with another reason is a wrong diagnosis.
- **Guards:** the check runs once (it refuses if `check.out` exists). It must never run without a real restart: with the same
  database the resume would carry, and use the kept run up. A restart also resets bc2 and bc3, which this task does not
  need.

## Asked of kraken
One `kraken coord ask` (kind `bc-restart`, target server1, "notify only"): tell lethal-code when server1 next restarts.
**Do not cause one for this.**

## Checks
- The scripts parse, and the check refuses without its flag.
- The kept run's row shows a non-empty `server_generation` and `database_id`. If either is empty, the measurement is void,
  since R969 needs both, and that is said.
