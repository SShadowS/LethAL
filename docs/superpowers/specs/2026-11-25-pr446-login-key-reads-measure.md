# PR-446 (R1182 unpark): gate and measure alrunner's login-key-reads draft on DO — pre-commitment r2

lethal-code, 2026-11-25.
- **r1** was b2b8cf1af.
- **r2** answers its spec-adversary: BLOCKs 1-2, SHOULDs 3-9, NIT 10. Each change is marked with its finding.

**Scope.** This is a measurement only:
- No LethAL code changes. PR-402's guard on `alRunnerV3.loginReplay` stays.
- Every daemon is started directly by a probe, as PR-443's `check-run.ts` did, never through LethAL's flag.
- Evidence goes to `/coord/handoff/PR-446/`.
- Only counts go to alrunner: no DO source, no DO object or test names.

## Why sharing is safe or not: the argument under test

- **How the selector reads.** In `emitResourceSelector` (`packages/schemata/src/selector.ts`), `Active(MutantId)`
  reads `active-mutant.txt` BEFORE it compares ids. Every mutated site calls it, whichever mutant is active. A mutant
  can change behaviour only after its own `Active` returns true, so only after a read.
- **What follows.** If NONE's login reaches no mutated site, no login under any mutant reads the resource. Every
  M@c then truly shares c's login, provided two things hold:
  - the login does not depend on the test codeunit (PR-443: 0 differ across codeunits);
  - the login depends on no input outside the key, such as the date (R1223's door).
- **What breaks it.** The draft might MISS a read that a login makes, for example:
  - its tracking window ends before the image is taken;
  - `NavApp.GetResourceAsText` is not hooked inside the SingleInstance selector;
  - a subscriber context is not tracked.
  Then the image holds the selector's state (`Loaded`, `ActiveId`; premise-v2 showed SingleInstance globals ARE in
  the image) under a key without the resource.
- **The false kill.** M1's login sets `ActiveId=M1`. M2@c replays that image and runs with M1 active, so M1's kill is
  scored for M2. The kill pair cannot catch it, because its rerun replays the same image.
- So a DO reading of `resources 0` means "the login reaches no site" only after P0 shows the draft sees the read.

## The builds

- **draft:** fork `SShadowS/BusinessCentral.AL.Runner` branch `login-key-reads` at a09d4bbb8, on main efa411fea
  (#8211).
- **base:** efa411fea.
- **Build:** each from a clean clone, `cargo build --release --locked -p alrunner-cli`, in its own target dir, under a
  heavy-slot.
- **Gate:** each privately on the PR-226 route (`al-runner-v3-update.ts --root /coord/handoff/PR-446/gate-root
  --local-candidate <bin>`). Never `/work/tools`, never `current`. A failed gate stops the task.

## P0 (BLOCK 1): a positive control for read tracking, on the REAL selector

- **Corpus.** PR-420's stand-in login (`/coord/handoff/PR-420/probe/`). Its login-path subscriber is changed to call
  an emitted `Mutation Selector`.`Active(<id>)`, built from `emitResourceSelector`, instead of a raw resource read. A
  mutant at that site changes a row the login writes. A test sees the row.
- **The draft `=1` daemon:** requests M1@c, M2@c, NONE@c, M1@c. Pre-committed:
  - the keys line shows `resources` > 0, so M1, M2 and NONE are three keys;
  - the 4th entry replays M1's image;
  - the rows are M1 kills, M2 kills (with its own row), NONE passes, M1 kills;
  - the rows are identical to an `=0` daemon's.
- **The draft `=1` + `_CHECK=1` daemon:** the same requests, `0 differ` and `compared` ≥ 1.
- **The negative control:** the same subscriber with the read moved AFTER the login (a test-time read). Pre-committed:
  `resources 0`, so all three entries share one key. Rows are still equal to `=0`, because the read happens per
  session, after the image.
- **Rule.** If P0 fails (the draft misses the selector's read), DO's P2 reading cannot be trusted. That goes to
  alrunner as a BLOCK, and P4 is reported as "unsafe, not sized".

## The input: DO's REAL instrumented app (finding 8)

PR-443's CHECK run used the plain app. The real run serves the instrumented app.

- **How it is made.**
  - A full DO `lethal run`: no `--only`, a scratch store, `--progress-out`, on the build `current` names.
    - The instrumented source is LethAL's own output and does not depend on the al-runner build.
    - This avoids R814 refusing an ungated pin.
  - LethAL's own pid is recorded (the `exec` trick).
  - When the progress stream shows `batch-published` (the staged app is compiled and published), the driver copies
    `al-runner-v3/active` to `/coord/handoff/PR-446/active` at once, then sends TERM to LethAL's pid.
    - The first TERM is "budget spent" (R955), so the run winds down and writes its report.
    - A second TERM goes only if it is still alive after 10 minutes.
  - Its child daemon pids come from its log. Their exit is confirmed by `kill -0`, on those pids only.
- **Validation of the copy.**
  - Every file named in `mutant-manifest.json` is present.
  - The echo codeunit is present.
  - `app.json`'s `resourceFolders` holds `LethALResources`.
  - The test-codeunit list is the run's own union, recorded and compared with PR-443's 110.
- The copy holds DO source: it stays under `/coord/handoff`, is never committed, and is deleted at submit.

## The requests, built the way LethAL builds them (findings 2, 3)

- **Order and echoes.** Entries are made by LethAL's `encodeGroups` (`al-runner-v3-entries.ts`): the echo first, then
  each covering codeunit sorted by id. Every echo row must read `LETHAL-ECHO:<m>:true`.
- **Mutants and codeunits.** Each mutant M on codeunit c is one c5 scored KILLED with a killing test in c. Where c5
  has them, M1 and M2 on one c fail different tests. Each set of mutants also includes one survivor S, which must
  pass.
- **R1-R2:** PR-443's NONE over all codeunits, then reversed.
- **R3-R5:** PR-443's R3, then NONE@c then M@c, then M@c alone. Each with real killed mutants.
- **R6 (new; the case the draft creates).** On a FRESH daemon, M1@c, M2@c, NONE@c, M1@c, S@c, on 4 codeunits. Here
  c's image is recorded by a MUTANT, not by NONE.
- **Expected rows, pre-committed per entry:** each M's killing test fails, NONE passes everything, S passes
  everything.

## P1: alrunner's ask (the same requests on draft and base, `ALRUNNER_LOGIN_REPLAY=1`)

- **What is compared.** Per request, the md5 of its answer: the sorted (entry id, test, outcome, error text) rows,
  with timings dropped. Also the `login start:`, `login image:` and `login replay keys:` lines.
- **Predictions:**
  1. Draft and base give an equal md5 for every request, and every row is as expected. A difference is a BLOCK on the
     draft.
  2. **A `login start:` line on both builds (finding 4).** If base has no such line, P1 records it as absent and drops
     its R1/R2 predictions for base.
  3. **R1 replays 0** on both builds.
  4. **R2 replays EXACTLY 8 on both builds,** with `not imaged 0` and `too large 0`. R1 leaves its last 8 codeunits
     cached, and R2 starts with them.
  5. **R4 and R6 on base:** every M@c is a new key, because base keys on the resource. **On draft:** the order of
     keys follows from P2.

## P2: the CHECK run on the draft (`=1` + `_CHECK=1`)

- **Pass:** every `login replay check:` line reads 0 differ, overall and across codeunits.
- **The `compared` floor (finding 5):** at least the R2 repeats (110), plus every R3-R6 entry whose key was seen
  before on that daemon. The script counts this floor from the requests before the run.
- **The key split (finding 6).** It comes from the `login replay keys:` line:
  - **`resources 0`** (P0 passed): no login reaches a mutated site, so every entry of codeunit c shares c's key.
  - **`resources > 0`:** a login-path site exists. By the argument above, EVERY M@c is then its own key, and the
    draft adds nothing over base on DO. That is stated, and P4 is not run.
- **R1223 (finding 9).** In R4, the record is whether M@c's first entry is "a key seen before", per codeunit. It is
  DATA ONLY: no result here lifts R1223 or its D5 routing.
  - In a real run, a prefetch M@c can log in for real after an eviction (a new day, a new login) while the NONE twin
    replays the warm-up image. The asymmetry stays.
  - The draft WIDENS exposure to inputs outside the key: every prefetch entry of c now reuses one image.

## P3: replay ON vs OFF on the draft

- **Same requests R1-R6, two daemons:** `=1` and `=0`, both with `AL_STRICT_SEQUENTIAL=1`.
- **Pass:** every (entry, test) row is equal (outcome and error text) and as expected. Any difference is a BLOCK.
- **Cost:** wall time per request, with the replayed and not-imaged counts beside it (NIT 10), and load1 at start and
  end. The per-hit saving = (OFF − ON) / replayed, over R2 and R6. There is no absolute comparison across runs.

## P4: the hit rate on full DO (finding 7); only if P0 passed and P2 read `resources 0`

- **The sequence.**
  - c5's per-mutant `coveringTests` go through LethAL's own `prefetchGroups` / `encodeGroups` order, with echoes.
  - There is one cache per (lane, request mode): codeunit-isolated and method-isolated daemons are separate.
  - The cache is reset at each `serve-daemon-closed` in c5's events.
- **Lanes.** c5 does not record unit-to-lane assignment. So the bound is given for two layouts: units in c5's report
  order dealt round-robin to 5 lanes, and the same in reverse.
- **The R857 single-test entries** may key on the method, which is unmeasured. They are counted as misses.
- **The cache.** 8 images, with the eviction rule read from the draft's source.
- **Checked against a real daemon.** A 200-entry slice of one lane's modelled sequence, echoes included, goes to a
  draft `=1` daemon. Its replayed count must EQUAL the model's. If it differs, the model is wrong, and only the
  live slice is reported.
- **Report:** the hit share of mutant entries per layout, and the saving at P3's measured per-hit figure, as a share
  of c5's mutants phase.

## After

- R1182 and R1223 get P0's verdict, the P2 key split, the R4 data and P4's bound (or "not sized", with the reason).
- Building the leg-C fact, the flag, or R1223's daemon is a SEPARATE task, filed by the orchestrator.
- Heavy jobs (builds, gates, the staging run, daemons of ~3.8 GiB each) go through `scripts/heavy-slot.sh`, with load
  named.
