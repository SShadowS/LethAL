# PR-446 (R1182 unpark): gate and measure alrunner's login-key-reads draft on DO — pre-commitment

lethal-code, 2026-11-25. This is a measurement only. It changes no LethAL code, and PR-402's guard on
`alRunnerV3.loginReplay` stays as it is. Every daemon below is started directly by a probe, as in PR-443's
`check-run.ts`, never through LethAL's flag. Evidence goes to `/coord/handoff/PR-446/`. Only counts go to alrunner: no
DO source, and no DO object or test names.

## The builds

- **draft:** fork `SShadowS/BusinessCentral.AL.Runner` branch `login-key-reads` at a09d4bbb8, on main efa411fea
  (al-runner #8211). A login image is keyed on the resource texts the login READ, plus the test codeunit.
- **base:** efa411fea.
- Each is built from a clean clone with `cargo build --release --locked -p alrunner-cli`, in its own target dir and
  under a heavy-slot. Each is gated privately on the PR-226 route (`al-runner-v3-update.ts --root
  /coord/handoff/PR-446/gate-root --local-candidate <bin>`).
  - Never `/work/tools`, never `current`.
  - A private gate that fails stops the task. A failure is reported; it is never worked around.

## The input: DO's REAL instrumented app

PR-443's CHECK run used DO's plain app, plus an invented app that only held `active-mutant.txt`. A real run serves the
instrumented app, where every mutated procedure calls the selector, and the selector reads `active-mutant.txt`. If
code on the login path (a company-open or login subscriber in the app under test) holds a mutant, the login READS the
resource. That mutant then gets its own image. So "DO's login reads no mutant resource" is re-measured here, not
assumed.

- **How the app is made:**
  - one full DO `lethal run` on the gated base build, with `alRunnerV3.path` and no `--only`;
  - LethAL's own pid is recorded (the `exec` trick);
  - it is stopped by TERM to that pid once the staged `al-runner-v3/active` holds the compiled target, before the
    mutants phase.
- The probes read the staged `active` dir and the test project as source paths. The test codeunits are those of
  PR-443's `codeunits.json` (110).

## P1: alrunner's ask (the same requests on draft and base, `ALRUNNER_LOGIN_REPLAY=1`)

- **The requests:** PR-443's R1-R3, with R3's mutant ids chosen from the real manifest. Two extra requests:
  - **R4:** NONE@c, then M@c, for 4 codeunits, one M per codeunit;
  - **R5:** M@c alone, on 4 codeunits not used before.
- **Daemons:** one per build, with `v3MutantDaemonEnv(…, true)` and DO's offline args.
- **For each request:** the md5 of its answer, normalised to the sorted (entry id, test, outcome, error text) rows with
  timings dropped. Also the counts lines that start `login start:` / `login image:` / `login replay keys:`.
- **Predictions (pre-committed):**
  1. The md5 is equal on draft and base for every request. A differing md5 is a BLOCK on the draft, reported to alrunner
     with the differing row counts.
  2. On base, R1 replays 0 (every key is new). On draft, R1 also replays 0, because each codeunit is its own key.
  3. **On draft, R2 replays at most 8** (8 images kept): the last 8 codeunits of R1, which come first in reverse order.
     The images are expected to be about 3.6 MB each.
  4. The R3 mutants: see P2.

## P2: the CHECK run on the draft (`ALRUNNER_LOGIN_REPLAY=1` + `_CHECK=1`)

- **The requests:** R1-R5 as in P1.
- **Pass:** "0 differ" in every `login replay check:` line, both overall and across test codeunits.
- **The open question, with no pre-committed figure.** The `login replay keys:` line splits what made each key new
  into `resources N` and `test_codeunit N`.
  - With `resources 0`: no login read the mutant resource. Every M@c shares c's key.
  - With `resources > 0`: some mutant sits in login-path code. Each such M@c is its own key, and a replay can never
    hide that mutant's own effect on the login.
- **R1223 re-measured:** in R4, is M@c's first entry "a key seen before" (it replays NONE@c's image)? The answer is
  recorded per codeunit.
  - If yes, R1223's asymmetry is gone on this build: NONE and M replay the same image.
  - The door then changes shape. A login input outside the key, such as the date, splits the prefetch from the
    warm-up for M and for NONE alike. Whether a kill pair still needs a replay-off daemon is argued in R1223's update.
    It is not decided here.

## P3: replay ON vs OFF on the draft (rows equal per test, cost)

- **Same requests, two daemons:** `=1` and `=0` (both with `AL_STRICT_SEQUENTIAL=1`).
- **Pass:** every (entry, test) row is equal, with outcome and error text compared. Any difference is a BLOCK and goes
  to alrunner as counts.
- **Cost:** the wall time per request, ON vs OFF, on the same core set. It is reported with load1 at start and end;
  there is no absolute comparison across runs (server1 is shared).
- **Expected:** if P2 reads `resources 0`, ON saves ~0.25 s per replayed entry (PR-439's real login).

## P4: the hit rate on full DO (the bound for R1182)

- c5's events do not record each entry's codeunit. So the bound comes from a model:
  - take c5's report (`/coord/handoff/PR-422/c5/report.json`);
  - lay out each lane's mutant entries in mutant order, one entry per (mutant, covering codeunit);
  - put the key sequence (the codeunit, plus the mutant where P2 showed the login reads it) through an 8-image cache
    with the draft's eviction rule. The rule is read from its source, LRU or FIFO.
- **Checked against a real daemon:** a 200-entry slice of that sequence is sent to a draft `=1` daemon. Its `login
  start:` replay count must equal the model's within ±2. Otherwise the model is wrong, and only the live slice is
  reported.
- **Report:** the hit share of mutant entries, and the lane-s saved at ~0.25 s per hit, as a share of c5's mutants
  phase. Equal counts of a lane's entries are not claimed unless the slice exercised them.

## After

- R1182 and R1223 get the measured bound, the R1223 answer and the P2 key split.
- Building the leg-C fact, the flag, or R1223's daemon is a SEPARATE task, filed by the orchestrator.
- The heavy jobs (builds, gates, the full DO staging run, the daemons, ~3.8 GiB each) all go through
  `scripts/heavy-slot.sh`, with the load named in each result.
