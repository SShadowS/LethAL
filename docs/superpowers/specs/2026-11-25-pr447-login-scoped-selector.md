# PR-447 (R1182): a login-scoped selector — each site reads only its own bucket — spec r3 (no build)

lethal-code, 2026-11-25.
- **r1** was 9adfdc5a9.
- **r2** (cbe416793) answers r1's spec-adversary: BLOCKs 1-2, SHOULDs 3-7, NITs 8-9, marked "(F1)" and so on. Those
  findings added the on-disk activation paths and three new measurements (`price/probe2.ts`,
  `price/out-probe2/probe2.txt`).
- **r3** answers the delta review, marked "(N1)" to "(N7)". No BLOCKs remained.

The orchestrator's ruling (PR-446):
- No login-context guard, and no change to what is instrumented: both would change what LethAL measures.
- Study a shape in which the login reads only what decides the login's own behaviour.

**Scope and switch (N2).**
- This spec is r3, for review. The build is a separate task, after the orchestrator's ruling.
- **C is emitted ONLY when `alRunnerV3.loginReplay` is on.** Otherwise today's selector stays, so a run with replay
  off pays nothing and keeps today's echo guarantee.
- `assertBound`'s selector comparison and `installResourceSelector` follow the same choice.

Evidence:
`/coord/handoff/PR-447/` (`census/`, `price/`, `findings.md`). Names and numbers only; no DO source.

## Why today's selector defeats replay (PR-446)

- `emitResourceSelector`'s `Active(id)` reads the ONE file `active-mutant.txt` on its first call in a session, caches
  the text, and compares.
- The login of DO's instrumented app calls `Active` at mutated login-path sites, so the login READS that file.
- Its text differs per mutant, and the read-keyed replay (al-runner #9074, 9e64be018) therefore keys every mutant
  apart.

## Measured first (PR-447 `census/`)

- **The login census.** A copy of the staged DO app, with a recording selector of identical answer semantics. One NONE
  session, the census codeunit alone, so only the login ran before it.
  - The login made **274 `Active` calls about 139 distinct mutant ids**, out of 43,486.
  - Those ids sit in license-check, version and setup-registration procedures: for example `CDOFunctions`
    `GetCDOVerAsInteger`, `CDOContiniaLicenseMgt` `HasExecutePermission`, and `CDOSetupManagement`
    `OnRegisterAssistedSetup`.
  - **Why the census is exact for that one session.** A mutant can change the login only if `Active(its id)` returns
    true during the login, and that needs the call. So the ids asked under NONE are exactly the mutants that can affect
    THAT login.
  - It is one NONE session on one day (F8). A login path that depends on data, the date or earlier writes may ask
    other ids on another day.
  - **Correctness does NOT rest on the census.** It rests on al-runner keying by what each login actually read. The
    census only prices the shape. The survivor-direction case is in "R1223".
- **The bound** (c5's prefetch shape: 16,903 covered mutants, 122,873 entries with echoes):
  - The login-path mutants are heavily covered: **12.4% of entries** (the license checks run under nearly every test).
  - **Upper bound:** 87.6% of entries could replay.
  - **Model, not a bound:** LRU-8 per lane in c5's mutant order, under two assumed layouts. 34.0-35.4% of entries hit.
    At ~0.25 s per real login (PR-439), that is ≈ 10.5-10.9k lane-s ≈ **11% of c5's mutants phase** (98,792 lane-s).
    The upper bound is ≈ 27%.
  - The cap of 8 images and the mutant-major order limit the hits: many mutants have more than 8 covering codeunits.
    A larger cap (al-runner's call) or a codeunit-major order are SEPARATE levers, not specified here.

## The shape: range buckets

- **Files.** LethAL ships one resource file per BUCKET of consecutive mutant ids:
  `LethALResources/lethal-bucket-<k>.txt`, k = ⌊n / K⌋ for mutant `M<n>`. Each file's default text is empty.
  - Ids are assigned in file and position order (`assignMutantIds`), so a bucket holds neighbouring sites, mostly of
    one procedure.
  - The prototype's names were `b<k>.txt` and `bnone.txt`; this spec's distinctive names replace them (F4).
- **A file for NONE.** `lethal-none.txt`, default text `NONE`.
- **(F4) Name collisions.** An override replaces a file of that name in EVERY app under test (R-635 §1). Staging
  REFUSES, by name, when any other app under test declares a resource named `active-mutant.txt`, `lethal-none.txt`
  or `lethal-bucket-*.txt`.
- **(F9) Ids.** Staging asserts that every manifest id matches `^M\d+$` and throws otherwise. `assignMutantIds` emits
  `M` plus at least 4 digits, and `lift`, `wrap`, `duplicate` and `dispatch-emit` emit those ids.
- **`active-mutant.txt` stays** (the echo and diagnostics read it).
- **Entry overrides.**
  - NONE: `active-mutant.txt = NONE` only.
  - Mutant `M<n>`: `active-mutant.txt = M<n>`, `lethal-bucket-<⌊n/K⌋>.txt = M<n>`, `lethal-none.txt = M<n>`.
  - (F3) `assertEntriesWellFormed` checks the EXACT override set of every entry: those three files for a mutant,
    `{active-mutant.txt}` for NONE, and nothing else.
- **The resource selector (`emitResourceSelector`; the v3 backend only).** `Active(id)`:
  - keeps R887's `GetExecutionContext() <> Normal → false` guard, first;
  - names the file: `lethal-none.txt` for `NONE`, else `lethal-bucket-` + `Format(N div K, 0, 9)` + `.txt`.
    - Format 9 never inserts a thousands separator. Plain `Format` would name k ≥ 1000 `1,000` (F5).
    - A red test uses an id ≥ 64,000.
    - An id that does not parse returns false. Staging has already refused one (F9).
  - reads that file once per session (a SingleInstance `Dictionary of [Text, Text]` cache), and returns
    `id = text`.
- **Procedure set unchanged:** `Active`, `Reached`, `ArtifactId`, `TargetAppId`. `emitMutationSelector` and
  `emitStaticSelector` are untouched, so the identical-procedure-set rule holds.
- **Why the login now reads only what decides it.**
  - The login's sites call `Active` for their own ids, so the login reads the files of their buckets.
  - A mutant outside those buckets overrides a file the login never read. Al-runner's key keeps only overrides of
    files read (`resource_reads.rs` `ResourceReads::texts`), so its key EQUALS NONE's, and it replays NONE's (or any
    other such mutant's) login image.
  - A login-path mutant overrides a file the login read, so it keys apart.
  - A non-login mutant that shares a bucket with a login id also keys apart. That is a lost replay, the safe
    direction.
- **Answer semantics.** Under any override set LethAL sends, `Active(id)` is true exactly when `id` is the active
  mutant, as today:
  - the active mutant's own bucket file holds its id;
  - every other bucket holds the empty default;
  - `lethal-none.txt` holds `NONE` only under NONE.
- **K, from the census** (collisions against the login's buckets):

  | K | login ids' buckets | entries keyed apart | LRU-8 model hits |
  |---|---|---|---|
  | exact (per id) | 139 | 12.4% | 34.0-35.4% |
  | 4 | 44 | 13.6% | 34.0-35.4% |
  | 16 | 20 | 14.8% | 33.8-35.2% |
  | 64 | 8 | 17.0% | 33.6-35.0% |

  - Hashed buckets (id mod N) are worse at every cost: N=1024 gives 30.1-31.5%, and N=64 gives 0.7-0.9%.
  - **The proposed default is K = 64,** decided by the price below. That gives about 680 files for DO, and the
    measured B shape.

## (F1) The on-disk activation paths

Four paths write `active-mutant.txt` ON DISK instead of sending overrides:
- the carry walk (M, NONE, M; plain `strictOrder` requests);
- R937's one-shot mutant call (`beforeSpawn`);
- `runOneShotEcho`;
- the coverage window (echo, coverage, echo).

Under C, writing only that file would make every echo there answer false. So:
- **What they write.** The set `{active-mutant.txt, lethal-bucket-<k(m)>.txt, lethal-none.txt}`:
  - `lethal-none.txt` is written FIRST and restored LAST. Any dirty bucket left by a SIGKILL then coexists with
    `lethal-none.txt ≠ NONE`, and the next NONE echo fails loudly.
  - Measured (`probe2` B, with the prototype's names `b<k>.txt` / `bnone.txt`): on-disk activation of a login id L
    with its bucket and `bnone.txt` written gives `LETHAL-ECHO:L:true`. Restored to NONE, it gives
    `LETHAL-ECHO:NONE:true`.
  - **(N3) A failed restore of ANY of the three files throws, or closes the lane. It is never swallowed.** Today
    `carryWalkSend` restores with `.catch(() => undefined)`: a failed bucket restore under a good `lethal-none.txt`
    would hide a live site from the NONE echo.
- **The check before every request.** EVERY LethAL resource file holds its default: every bucket empty,
  `lethal-none.txt = NONE`, `active-mutant.txt = NONE`. Today's guard checks only `active-mutant.txt`, and it is
  widened.
- **(N3) Binding.** The bucket files and `lethal-none.txt` are bound by R608's no-change-since-proof check, with NO
  window exemption. A window runs `checkBound` before it writes, and its sends do not re-check.
  - The `active-mutant.txt` window flag becomes PER LANE. Today `inWindow` is one backend field, so one lane's window
    exempts every other lane's check. Each lane has its own `active.<k>/` (`makeLane`).
  - The bucket files are NOT added to `OTHER_FILES_UNBOUND`.
  - (N7) The widened check reads about 680 more files per send. The build prices `boundMs` before and after.
- **(F2, N1) Indicated, not settled: an on-disk change gave a fresh engine.**
  - On a draft `=1` + `_CHECK` daemon, an `entries` request with no resources and the disk at L showed "0 seen
    before", with the image store reset ("kept" 4 → 2). So did one with the disk back at request 0's state (NONE).
  - That was the ENTRIES shape. The carry walk sends `batchBody` + `strictOrder`, and a window sends a top-level
    `test`. No control with the disk unchanged was run.
  - **The *disk-change-no-replay* fact is pre-committed with the backend's OWN body builders** (`carryWalkSend`'s,
    `plainInFlight`'s) and covers:
    - (a) the same plain request with the disk unchanged, as the control;
    - (b) a plain request at disk m, then an `entries` prefetch at disk NONE on the same daemon: it must not replay
      m's image;
    - (c) two windows back to back for two ids in one bucket, with equal-length texts and nothing in between.
  - Until it reads `matches`, the carry walk and the coverage windows run on the replay-OFF daemon. Both are added to
    R1223's D5 list (N6). When the `=0` daemon cannot serve them, the walk ends `failed` and the window refuses: they
    NEVER fall back to `=1`.

## The cost (PR-447 `price/`)

- **The setup.** Copies of the staged DO app with today's selector (A) or a C prototype, on the gated draft.
  - One `=0` daemon life per arm, in the order A, C, A, C.
  - Each life runs the full NONE suite twice (110 test codeunits, 1,979 rows), and the second run is measured.
- **Rows.** Every life's md5 is identical, A and C alike, in all 6 rounds (24 lives).
- **Wall and CPU time cannot price this on server1.**
  - Today's selector alone read 50-164 s wall and 44-139 s daemon CPU, at load1 7-310.
  - The CPU is hybrid (performance and efficiency cores), so CPU time moves with scheduling.
- **The measure: the daemon's user-space instructions** (`perf stat -e instructions:u -p <daemon>`, core and atom
  counters summed).
  - It does not move with load: each C variant read the same count in both of its lives.
  - A's FIRST life read ≈ 8 G more than its second, in both rounds: a first-life position effect (F8). The build's
    price discards a first life.

  | arm | G user instructions (two lives) | vs A |
  |---|---|---|
  | A, today | 165.1-173.0 | — |
  | B: range buckets K = 64 (`Evaluate`, `Format`, a per-bucket text cache) | 178.8, 178.9 | ≈ +6% |
  | D: decimal-prefix buckets plus a per-id answer cache | 225.2, 225.3 | ≈ +33% |

- **B is the shape.**
  - D's per-id `Dictionary.Get` on every call costs more than the parse it saves, because a site is called far more
    often than it is new.
  - B's extra is ≈ 10 G instructions over 110 sessions against A's mean, or ≈ 14 G (+8.4%) against A's second life.
    That is about +27-37 ms per entry, at A's ≈ 3.3 G instructions per CPU second.
  - **Net:** a replay saves ≈ 0.25 s (PR-439). Per mutant entry that is ≈ 85 ms at the hit rate for cap 8, or
    ≈ 218 ms at cap ≥ 112, against ≈ 27 ms of cost.
  - A login-path entry (21% at K = 100, 17% at K = 64) pays the cost and saves nothing.

## The cap, not the key, limits the hits

At cap 8, the model's 34% sits far below the 87.6% of entries whose key could repeat. The difference is the 8-image
cap: c5's mutants have many covering codeunits, so LRU-8 cycles.

| images kept | modelled hits (exact keys; 2 assumed layouts) |
|---|---|
| 8 | 34.0-35.4% |
| 16 | 48.5-49.9% |
| 32 | 56.9-57.9% |
| 64 | 59.5-59.8% |
| ≥ 112 (every key: 110 test codeunits + echo) | 87.1-87.5% |

- **Memory.** At ≈ 3.6 MB per image, keeping every key is ≈ 400 MB per daemon, about +10% of c5's ~3.8 GiB per lane.
  c5's memory hold already capped it at 5 of 8 lanes, so the build measures whether it costs a lane.
- **On al-runner main (c854feb1f) the limits are constants:** `MAX_STARTS = 8`, `MAX_BYTES = 64 MiB`,
  `MAX_START_BYTES = 16 MiB`. `MAX_BYTES` alone stops at ≈ 17 images.
- **The ask** is drafted for the orchestrator to relay: `/coord/handoff/PR-447/alrunner-cap-ask.md`, configurable
  limits with today's defaults.
- **The value at cap ≥ 112.** About 107k replays × 0.25 s − 123k entries × 0.027 s ≈ 23.5k lane-s, ≈ 24% of c5's
  mutants phase (prefetch entries only). At cap 8 it is ≈ 7.3k lane-s, ≈ 7%.

## The contract and the facts

- **Echo (§6): the text is unchanged, but its scope is NARROWER (F3).** The echo reads `active-mutant.txt` (t) and
  asks `Active(t)`.
  - Under C, `LETHAL-ECHO:t:true` proves that `active-mutant.txt` and t's OWN bucket are in force. Today one file
    decides every site, so it also proves that no other site is live. Under C the other buckets are not proven by it.
  - They rest on al-runner resetting each file an entry does not override.
    - The detector: every mutant entry overrides `lethal-none.txt` and NONE never does. So a carried-over override
      fails the next NONE echo.
    - Measured (`probe2` C, `=0`): [M1, M2, NONE] in ONE request gives the same rows as each alone, with M1 and M2
      in different buckets, both c5-killed on that codeunit.
    - A leg-C fact (*bucket-no-carry*) pins it: a covered killing mutant in bucket i, then one in bucket j, then NONE.
    - Mutant-to-mutant survivors are covered only by that fact, not by any echo.
    - R1220's and R1221's echo drops must keep the NONE echo, the detector, or prove the same by fact.
  - Under NONE, `Active('NONE')` reads `lethal-none.txt` = `NONE`, so it is true. Under a mutant it is false, as
    today.
  - The echo runs at test time; the login never calls it.
- **Leg C (PR-442's `entry-no-cross-*` facts)** must read `matches` with the C selector compiled in. The new
  SingleInstance bucket cache is per session, as `Loaded` / `ActiveId` are today.
- **New facts, before any replay use:**
  1. *bucket-keying*: a non-login mutant shares NONE's key, while a login-path mutant and a bucket-collision mutant
     key apart.
     - Measured on the draft on the RANGE K=64 prototype, with echoes (`probe2` A, F6), on NONE, M1, NONE, M1, L,
       where M1 is c5-killed on that codeunit:
       - 10 sessions over 4 keys, `resources 2`;
       - M1 shares NONE's key for both the codeunit and the echo, and L keys apart for both;
       - 6 compared, 0 differ;
       - every echo reads `:true`, and M1's killing row fails.
     - (The earlier `keying.ts` run used the HASHED mod-1024 prototype, with no echo, and with mutants that did not
       kill. It is superseded.)
     - A corpus version is to be pre-committed in leg C.
  2. *bucket-answers*, PER MUTANT under mutants (F6): each mutant's rows with C equal its rows with today's selector.
     - NONE md5s prove nothing here: every `Active` is false in both arms.
     - Measured so far: two c5-killed mutants on one codeunit give the same status counts with C (`probe2` C) as with
       today's selector (PR-446's off arm): 1 fail and 10 error, and 4 pass and 7 error.
     - The gate: the full `itest:alrunner-v3` with ZERO figure moves, with leg C's selector copy
       (`al-runner-v3-contract.ts`) rebuilt on C.
  3. *bucket-no-carry* (F3) and *disk-change-no-replay* (F2, N1), as above.
- **(N2) Which code reads each fact:**
  - `loginReplayFor` (the flag) needs login-replay, *bucket-keying*, *disk-change-no-replay*, *bucket-no-carry*, AND
    R1223's built constant;
  - the C selector is never emitted unless *bucket-answers* is recorded for the build.
  - Each is a red test: a missing fact refuses the flag (or C) by name.
- **R1223.**
  - With C, a non-login mutant's FIRST entry for codeunit c can replay NONE's image of c, so today's split (NONE
    replays, M logs in for real) closes for those mutants.
  - The door does not close in general. A prefetch M@c that misses the cache (eviction, a new daemon) logs in for
    real, while the NONE twin replays an older image. Login inputs outside the key (the date) still split them.
  - C WIDENS the exposure: most prefetch entries now stand on a replayed login.
  - So R1223 (Form A, D5 routing: every confirm and reproduction on a replay-OFF daemon) stays a precondition. Nothing
    here lifts it.
- **(F7) A new door, in the survivor direction.**
  - A login whose path depends on data or the date may read another bucket on another day.
  - A mutant that is not on the login path by an earlier day's read set replays that day's image, so its login-time
    effect is lost and it may be scored survived.
  - Kill pairs confirm kills only, so nothing re-checks that survivor.
  - (N4) The door opens when a login's read set changes WITHIN one daemon life: the date crossing midnight, or data
    the login reads. Runs on two days each record on their own day, so they cannot reach it.
  - **It is filed as its own roadmap item, R1226,** a precondition of the flag beside R1223. Its fix shapes are:
    - restart every `=1` daemon when Today or WorkDate changes;
    - or a leg-C case with a forced date change inside one daemon life.
  - The build's ON vs OFF per-mutant equality on DO stays a gate. It is not a proof against this door.
- **(F7, N5) PR-402's guard must become code, not prose.** Today `status()` and `cacheEnv` check only
  `loginReplayFor(gatedRecord)`. R1223 is roadmap text.
  - `loginReplayFor` also requires R1223's ONE "R1223 is built" constant, as R1223 D6 says.
    - It sits beside `loginReplayFor`, and only R1223's own commit flips it.
    - It is never inferred from config or a version string.
  - **Red tests in EACH direction:**
    - the constant set without the fact → refused;
    - the fact recorded without the constant → refused.
  - `cacheEnv`'s `seams.loginReplayFact` bypasses `loginReplayFor`, so it stays test-only. A test asserts that no
    production caller sets it.
  - "R1223 before C's facts" is an ORDER OF WORK, not something code enforces. The code-enforced part is the
    interlock above.
  - So `alRunnerV3.loginReplay` needs the login-replay fact, C's facts (N2), R1223 and R1226 in code.

## Before a build ruling

- **Indicated by measurement (entries shape), to be settled by the leg-C facts:**
  - F2's premise (no replay across disk states; N1);
  - F6's keying, on the range-64 shape, with echoes and a killing mutant;
  - F3's carry-over, on one codeunit.
- **What the build needs:**
  - F7's interlock in code first;
  - R1223.md amended with the carry walk and the windows in D5 (N6), done in this task's roadmap commit;
  - R1226 filed;
  - which code reads each fact (N2);
  - then the facts *bucket-keying*, *bucket-answers*, *bucket-no-carry* and *disk-change-no-replay*, with N1's
    corpus in the real request shapes;
  - the on-disk paths per F1 and N3: three files, per-lane window flags, restores never swallowed;
  - the names, ids and Format per F4, F5 and F9;
  - (N7) the F4 refusal also scans dependency `.app` packages, if overrides reach them;
  - `boundMs` priced;
  - the full v3 gate with zero moves;
  - replay ON vs OFF per-mutant equality on DO.
- **Separately:** the cap ask to alrunner (the orchestrator relays it). The build is worth ≈ 7% at cap 8, and ≈ 24% at
  cap ≥ 112.

## Not in scope

- The al-runner draft is upstream's (#9074); this shape works with it as gated (9e64be018).
- Neither the image cap nor LethAL's request order changes here.
- The BC backend's selector (`emitMutationSelector`) is untouched.
