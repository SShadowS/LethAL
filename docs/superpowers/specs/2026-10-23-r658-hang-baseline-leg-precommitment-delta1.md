# R-658 itest:hang BASELINE leg: DELTA 1 to the pre-commitment 00d508c4 §5

Committed 2026-10-23 by lane bugs, before any lease for the live run. It is reviewed: one delta review, ADOPT with
fixes F1-F4, all applied.

Base: `docs/superpowers/specs/2026-10-22-r658-hang-baseline-leg-precommitment.md` (master 00d508c4).
- This delta changes ONLY the wrapper's behaviour in §5, plus one line of R-669's marker printing (F1).
- Everything else in 00d508c4 is unchanged: §1-§4, §6 and §7, the STOP triggers, the leg marker, the gate's STOP path,
  the exit codes, the release table and the heartbeat-only hold.

**Where the build is.** `lethal/r658` at **4cb58698** holds:
- the wrapper `scripts/r658-hang-gate.sh`, with its test `scripts/r658-hang-gate.test.ts` (that test is listed in
  `scripts/tsconfig.json`, so it is type-checked);
- the F1 filter in `packages/runner/itest/out-of-use.ts`, with its test.

`/coord/handoff/R-658/run-hang-gate.sh` is now a pointer: a shebang plus one line that execs the repo script.

## Why

1. **R-669 added a reader.** The marker is no longer write-only. `printItestTarget` (every BC itest) and
   `bc-linux-setup.ts` refuse a server whose `<coord>/machine/out-of-use/<server>.md` exists. So §5's "No reader:
   nothing reads it automatically yet" is now false.
   - Without proof of ownership, the hang gate would refuse the wrapper's own in-use marker.
   - R-669's owner override, `LETHAL_OUT_OF_USE_OWNER=<token>`, gives that proof. It passes only a marker with
     exactly one line `owner: <32 lowercase hex>` that equals the token.
2. **The R-669 build review's finding 1 (HIGH): the lapsed-STOP overwrite.** 00d508c4's wrapper never looked for an
   existing marker, and it read only the offline call's printed line, not its exit status.
   - Suppose a hold lapsed: the session died and the coord lease expired.
   - A retry would then lease the server again and overwrite the STOP marker with a fresh in-use marker.
   - That erases the evidence that the server may still carry a live session.
3. **The delta review (ADOPT with fixes)** found F1-F4, below.

## What changes

- **(a) An existing marker refuses, before the offline check and the lease.** `[ -e "$OOU" ]` exits 2. It prints the
  path, and then the marker without its `owner:` lines (`grep -v '^owner:'`, F1). No lease call is made.
- **(b) The offline target check checks its exit status.** `TL=$(...) || { refuse; exit 2; }`. The `case` matches on
  `:7049` and on `$WANT ` stay as they are.
- **(c) A fresh owner token per run.** `OWNER=$(openssl rand -hex 16)`, checked to be 32 lowercase hex, else exit 2
  before the lease. It is passed only on the gate's command line, as `LETHAL_OUT_OF_USE_OWNER="$OWNER" ... bun run
  itest:hang`, and it is never exported.
- **(d) `mark` takes a second argument, the owner token.** Only the in-use call passes it, so only that marker
  carries the line `owner: $OWNER`. Every other mark (hold, STOP, and "released, believed clean") writes NO owner
  line. Each mark is a whole-file rewrite, so the owner line is dropped in the same write that adds the new reason.
- **F1. No printed form of a marker carries its owner line.**
  - In `out-of-use.ts`, the one `body` that every print uses now drops `owner:` lines with one `.filter`. That covers
    the owner-pass log (which goes to stderr, and so into `$H/hang.log`), the clearing log and the refusal text. The
    owner check itself still reads the unfiltered marker.
  - In the wrapper, (a) prints the marker with `grep -v '^owner:'`.
- **F2. The in-use marker is written with noclobber.**
  `( set -C; mark "in use…" "$OWNER" ) || { echo "refused: $OOU appeared or could not be written"; exit 2; }`.
  - This closes the window between check (a) and the write. The EXIT trap then releases the lease, and no gate has
    started.
  - Every other `mark` (hold or STOP, and believed-clean) echoes a loud `!!!` line if the write fails. A hold still
    holds.
- **F3. The knobs.**
  - `R658_EVIDENCE_DIR`: the evidence dir, default `<root>/handoff/R-658/hang-<server>`. Under the default root that
    is 00d508c4's `/coord/handoff/R-658/hang-<server>`.
  - `R658_BEAT_SECS`: the heartbeat interval, default 60. It must match `^[0-9]+(\.[0-9]+)?$` and be > 0 and <= 60,
    else exit 2 before the lease.
  - **Test-only:** `R658_HOLD_MAX_BEATS` (a cap on the hold loop; when it ends a hold the wrapper exits 4 WITHOUT
    releasing) and `R658_WORKTREE` (default `/work/lethal-wt/r658`).
    - Each is refused (exit 2, before the lease) unless `R658_EVIDENCE_DIR` is set too.
    - `R658_HOLD_MAX_BEATS` must also be a whole number.
    - A live run sets none of the three test knobs, and its hold runs forever, as before.
- **F4. `unset LETHAL_OUT_OF_USE_OWNER`** at the top of the wrapper. The gate's command-line prefix is the only
  source of the token, and no inherited value reaches any child.
- **The marker dir** is resolved as R-669's `outOfUseDir` does it: `LETHAL_COORD_ROOT`, else `CG_COORD_ROOT` inside
  kraken, else `/coord`.
  - Inside kraken, a `LETHAL_COORD_ROOT` that differs from `CG_COORD_ROOT` refuses.
  - A missing `<root>/machine` refuses (exit 2), so a wrong root never reads as "no marker".
  - After check (a), the wrapper runs `mkdir -p "$H" "<root>/machine/out-of-use"`. That creates `out-of-use/` under
    an existing `machine/` if it is missing, and never creates `machine/` itself.
- The marker's "Coord lease" line names `scripts/r658-hang-gate.sh` as the holding wrapper.

## The orchestrator's checks, and where each is tested

1. **A STOP rewrites the marker without the owner line**, so a retry with the same token cannot pass its own STOP.
   - Test: "a STOP rewrites the marker with no owner line…". The fake gate exits 5 with the leg marker `stop`. The
     marker then has no `owner:` line and has the STOP reason, and R-669's `outOfUseRefusal`, called with the
     original token, refuses it.
   - The other direction: the in-use marker passes `outOfUseRefusal` with its own token.
2. **The token is unique per run and stays out of every output.**
   - It is never printed to stdout, `lease.txt` or `hang.log`, and it reaches no child process but the gate.
   - It exists in the in-use marker only, and only while the run lasts. The point is uniqueness (no constant, no
     leftover value can match a later marker), not secrecy.
   - Tests:
     - two runs get different tokens;
     - the gate gets the same token as the in-use marker's one owner line;
     - the token is absent from stdout and stderr, `lease.txt`, and `hang.log`. To make the hang.log check real, the
       fake gate runs R-669's REAL `outOfUseRefusal` with the real bun, so the owner-pass log, marker body included,
       lands in `hang.log`;
     - every fake child but the gate logs the `LETHAL_OUT_OF_USE_OWNER` it inherited, and the call log never holds
       the token;
     - an inherited `LETHAL_OUT_OF_USE_OWNER` reaches no child (F4);
     - (a) prints an existing marker without its owner token (F1);
     - in R-669's module test, neither the owner-pass log, nor the refusal, nor the clearing log carries the token
       (F1).
3. **Two owner lines, or a malformed one, refuse.** R-669 already does this (`outOfUseRefusal` requires exactly one
   well-formed line), and its own tests cover it. The wrapper writes at most one owner line, and only in the in-use
   marker.

**Also tested:**
- an existing marker exits 2 with no lease call, and the marker is left byte for byte;
- a failing offline check exits 2 with no lease call, both with no line and with a matching line printed before the
  failure;
- a missing `<root>/machine` exits 2;
- a marker that appears during the lease (F2) exits 2: the marker is kept unchanged, the lease is released, and no
  gate starts;
- each F3 refusal;
- "released, believed clean" has no owner line, and the token is refused there;
- a clean pass (exit 0, leg `passed`) removes the marker and releases.

## Clearing bc2 or bc3 before the live run (R-669)

Setup on a server that has a marker now needs `LETHAL_OUT_OF_USE_CLEARING=<that server>` on that one command, never
exported.
- **bc3:**
  1. remove the probe apps (`scripts/r658-bc-probe/drive.ts --remove-only`, under the probe wrapper's held lease);
  2. stop the probe wrapper and release its lease;
  3. run the setup with the clearing override, until it is clean;
  4. delete `bc3.md`.
- **bc2:** run the setup with the clearing override, then a read-only doctor under a fresh lease, then delete
  `bc2.md`.
- Only then does this wrapper run. Its check (a) refuses while either marker remains.

## Unchanged, restated so the review can check it

- **The clean-worktree check stays strict.** The scratch `coverage.cobertura.xml` in `/work/lethal-wt/r658` is
  deleted before the live run, not ignored.
- The bc1 refusal, by argument and by `:7049` in the target line.
- The port check against `$WANT`.
- The leg marker path, `LETHAL_ITEST_HANG_LEG_STATE`.
- **The release table:**
  - release only on exit 0 or 1, with the leg marker `passed` or absent, and with the gate's `[itest target]` line
    naming `$WANT`;
  - hold on a leg marker of `armed` or `stop`, on INT or TERM during the gate, on a bad target line, and on every
    other exit.
- The marker is removed only on `0:passed`.
- The heartbeat-only hold, and the printed line telling the lane to message the orchestrator.
- No `kraken coord pause`.
