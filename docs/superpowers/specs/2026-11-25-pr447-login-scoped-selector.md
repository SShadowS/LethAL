# PR-447 (R1182): a login-scoped selector — each site reads only its own bucket — spec r1 (no build)

lethal-code, 2026-11-25. The orchestrator's ruling (PR-446):
- No login-context guard, and no change to what is instrumented: both would change what LethAL measures.
- Study a shape in which the login reads only what decides the login's own behaviour.

This spec is r1, for review. The build is a separate task, after the orchestrator's ruling. Evidence:
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
  - **Why the census is exact.** A mutant can change the login only if `Active(its id)` returns true during the login,
    and that needs the call. So the ids asked under NONE are exactly the mutants that can affect the login.
- **The bound** (c5's prefetch shape: 16,903 covered mutants, 122,873 entries with echoes):
  - The login-path mutants are heavily covered: **12.4% of entries** (the license checks run under nearly every test).
  - **Upper bound:** 87.6% of entries could replay.
  - **Model, not a bound:** LRU-8 per lane in c5's mutant order, under two assumed layouts. 34.0-35.4% of entries hit.
    At ~0.25 s per real login (PR-439), that is ≈ 10.5-10.9k lane-s ≈ **11% of c5's mutants phase** (98,792 lane-s).
    The upper bound is ≈ 27%.
  - The cap of 8 images and the mutant-major order limit the hits: many mutants have more than 8 covering codeunits.
    A larger cap (al-runner's call) or a codeunit-major order are SEPARATE levers, not specified here.

## The shape: range buckets

- **Files.** LethAL ships one resource file per BUCKET of consecutive mutant ids: `LethALResources/b<k>.txt`,
  k = ⌊n / K⌋ for mutant `M<n>`. Each file's default text is empty. Ids are assigned in file and position order
  (`assignMutantIds`), so a bucket holds neighbouring sites, mostly of one procedure.
- **A file for NONE.** `bnone.txt`, default text `NONE`.
- **`active-mutant.txt` stays** (the echo and diagnostics read it).
- **Entry overrides.**
  - NONE: `active-mutant.txt = NONE` only.
  - Mutant `M<n>`: `active-mutant.txt = M<n>`, `b<⌊n/K⌋>.txt = M<n>`, `bnone.txt = M<n>`.
- **The resource selector (`emitResourceSelector`; the v3 backend only).** `Active(id)`:
  - keeps R887's `GetExecutionContext() <> Normal → false` guard, first;
  - names the file: `bnone.txt` for `NONE`, else `b<⌊n/K⌋>.txt`. An id that does not parse returns false: LethAL
    emits only `M<n>` and `NONE`;
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
  - `bnone.txt` holds `NONE` only under NONE.
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

## The cost (PR-447 `price/`)

- **The setup.** Copies of the staged DO app with today's selector (A) or a C prototype, on the gated draft.
  - One `=0` daemon life per arm, in the order A, C, A, C.
  - Each life runs the full NONE suite twice (110 test codeunits, 1,979 rows), and the second run is measured.
- **Rows.** Every life's md5 is identical, A and C alike, in all 6 rounds (24 lives).
- **Wall and CPU time cannot price this on server1.**
  - Today's selector alone read 50-164 s wall and 44-139 s daemon CPU, at load1 7-310.
  - The CPU is hybrid (performance and efficiency cores), so CPU time moves with scheduling.
- **The measure: the daemon's user-space instructions** (`perf stat -e instructions:u -p <daemon>`, core and atom
  counters summed). It does not move with load: each variant read the same count in both of its lives.

  | arm | G user instructions (two lives) | vs A |
  |---|---|---|
  | A, today | 165.1-173.0 | — |
  | B: range buckets K = 64 (`Evaluate`, `Format`, a per-bucket text cache) | 178.8, 178.9 | ≈ +6% |
  | D: decimal-prefix buckets plus a per-id answer cache | 225.2, 225.3 | ≈ +33% |

- **B is the shape.**
  - D's per-id `Dictionary.Get` on every call costs more than the parse it saves, because a site is called far more
    often than it is new.
  - B's extra ≈ 10 G instructions over 110 sessions is about +27 ms per entry, at A's ≈ 3.3 G instructions per CPU
    second.
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

- **Echo (§6) is unchanged in text and in meaning.** The echo reads `active-mutant.txt` (t) and asks `Active(t)`.
  - Under C, `Active(t)` reads t's bucket, so `LETHAL-ECHO:t:true` now also proves that the bucket override is in
    force. That is what decides the sites, so the check is stronger.
  - Under NONE, `Active('NONE')` reads `bnone.txt` = `NONE`, so it is true. Under a mutant, `bnone.txt` = the id, so
    it is false, as today.
  - The echo runs at test time; the login never calls it.
- **Leg C (PR-442's `entry-no-cross-*` facts)** must read `matches` with the C selector compiled in. The new
  SingleInstance bucket cache is per session, as `Loaded` / `ActiveId` are today.
- **New facts, before any replay use:**
  1. *bucket-keying*: a non-login mutant shares NONE's key, while a login-path mutant and a bucket-collision mutant
     key apart. Measured on the draft with the C prototype on DO (`price/keying.ts`):
     - 3 keys over NONE, X, NONE, X, L, K, with `resources 2`;
     - CHECK 0 differ;
     - rows equal to `=0`.
     A corpus version is to be pre-committed in leg C.
  2. *bucket-answers*: under NONE and under each mutant, the rows with C equal the rows with today's selector. On DO,
     the NONE rows are already equal: md5 equal over 1,979 rows in all 4 lives.
- **R1223.**
  - With C, a non-login mutant's FIRST entry for codeunit c can replay NONE's image of c, so today's split (NONE
    replays, M logs in for real) closes for those mutants.
  - The door does not close in general. A prefetch M@c that misses the cache (eviction, a new daemon) logs in for
    real, while the NONE twin replays an older image. Login inputs outside the key (the date) still split them.
  - C WIDENS the exposure: most prefetch entries now stand on a replayed login.
  - So R1223 (Form A, D5 routing: every confirm and reproduction on a replay-OFF daemon) stays a precondition. Nothing
    here lifts it.
- **PR-402's guard is unchanged:** `alRunnerV3.loginReplay` still needs the login-replay fact AND R1223.

## Not in scope

- The al-runner draft is upstream's (#9074); this shape works with it as gated (9e64be018).
- Neither the image cap nor LethAL's request order changes here.
- The BC backend's selector (`emitMutationSelector`) is untouched.
