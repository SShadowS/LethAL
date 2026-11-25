# PR-442 pre-commitment: leg-C facts that no state crosses serve ENTRIES (what R1221's C1 and the echo drop need)

Status: pre-commitment (coord PR-442, lethal-code, 2026-11-25), before the build. Precedent: PR-342
(`2026-11-22-pr342-stop-groups-fact.md`), a gate-only fact family. Related: R1221, R1220, PR-441, PR-436.

## Why
- R1221's C1 (one shared NONE per killer per batch) and R1220's echo drop are each sound only if NO state crosses entries
  of one serve request.
- LethAL's existing `batch-no-cross-*` facts measure across test codeunits in ONE plain request, on a server without
  `AL_STRICT_SEQUENTIAL`. They do not measure across entries. R766 measured SingleInstance across entries once, on
  alpha.5.
- PR-441's spec-adversary asked for a standing per-build fact, covering one channel per probe, with a positive control
  and the entry order pinned.

## The premise, measured on `current` before this pre-commitment
`/coord/handoff/PR-442/probe442.ts`, invented AL. It ran on edge-e5176a9fd serve with `AL_STRICT_SEQUENTIAL=1`,
`ALRUNNER_SEED=1` and `testIsolation: "test"`. A writer test writes every channel; a reader test reports them all.
- **Across entries** (writer in entry e1 with resource MUT-A, reader in entry e2 with MUT-B): nothing carries. The
  selector cache equals e2's resource; app and test-side SingleInstance 0; codeunit global 0; library codeunit in a
  global 0; WorkDate is today; GlobalLanguage 1033; a temp table in a SingleInstance 0; a bound manual subscriber 0.
- **Across requests** on the same daemon: nothing carries.
- **Positive control** (writer then reader in ONE entry): every channel carries (7, 8, 9, 5, 2031-01-01, 1030, 1, 1,
  and the entry's own resource).
- Rows stream in entry order.

## The change
- **Eight facts**, `entry-no-cross-<channel>`, one per channel:
  - `selector-cache`: a SingleInstance codeunit shaped like LethAL's resource selector caches
    `NavApp.GetResourceAsText` once;
  - `singleinstance`;
  - `codeunit-global`: the test codeunit's own global;
  - `library-global`: a plain codeunit held in a test codeunit global;
  - `workdate`;
  - `globallanguage`;
  - `subscriber`: a manual subscriber bound by `BindSubscription` and held in a SingleInstance;
  - `temp-table`: a temp record held in a SingleInstance.
- **Each fact's AL.** Its own invented app: ten ids per fact, 50790-50869, one app per fact, so the resource read
  works in-app. One test codeunit holds `Writer` (sets the channel) and `Reader`. `Reader` errors `carried <value>`
  when it sees the writer's value, and passes otherwise. For `selector-cache`, `Reader` errors when the cached value
  differs from a fresh read of the resource.
- **The server.** One serve daemon for all eight facts, started with `AL_STRICT_SEQUENTIAL=1`: the mutant daemons'
  environment, as for the carry fact. `testIsolation: "test"`.
- **Each fact sends two requests:**
  1. **Cross-entry**, `runSelectedOnly: true`: entry `w` (`Writer`, resource `MUT-A`), then entry `r` (`Reader`,
     resource `MUT-B`).
  2. **Positive control:** one entry for the whole codeunit, resource `MUT-C`. `Writer` then `Reader` run in one
     codeunit run.
- **The judge.** `matches` when all of these hold; `diverged` otherwise; `unmeasurable` when there is no answer:
  - request 1 has exactly two rows, `w`'s writer row (pass) streamed BEFORE `r`'s reader row (pass);
  - request 2's reader row is a `fail` whose message starts `carried`, which proves the channel is live.
  - A request 2 reader that passes means a dead probe, and reads `diverged` with that said in `measured`.
- **The gate rule**, as PR-342's `stop-groups`:
  - `diverged` never fails the gate; it prints `al-runner-v3-entry-carry: <fact> diverged` in leg C only;
  - `unmeasurable` stays an infra-fail;
  - the facts sit outside `V3_CAPABILITY_FACTS`, so baseline batching never reads them.
  - A future consumer (C1, the echo drop) must read its channel's fact `matches` from the build's record
    (`batchFacts`); anything else keeps it off. Fail closed.
- **No DotNet cases.** Every daemon goes through `v3ChildEnv`, and the spawn guards count the new daemon.

## Predictions (any difference is a BLOCK until explained)
- **Leg C's fact count: 38 → 46.** `V3_LEG_C_FACTS` and its pin in `r586c-pins.test.ts` move together.
- **On `current` (edge-e5176a9fd):** all eight `entry-no-cross-*` read `matches`. No `al-runner-v3-entry-carry`
  warning.
- **`itest:alrunner-v3`, the full v3 gate:**
  - no per-mutant verdict, killing test, note set, refusal set or warning set moves in any leg;
  - leg C prints eight more fact lines;
  - the itest receipt's `batchFacts` gains the eight keys, and no other key moves.
- **`v3ReadingsDigest` is unchanged.** These are capability-shaped facts, outside the digest.
- **The update gate's leg C** (`bun scripts/al-runner-v3-update.ts`, run on `current` as a re-check): the eight facts
  `matches`. The record (`.gated` `batchFacts`) is written by the owner of the update gate after the merge, as PR-342's
  was.
- **The carry gate:** unchanged.
- **The BC gates:** no figure moves. The diff touches no BC path; they run only if `selectLegs` names them.

## Not in this PR
C1 and the echo drop themselves. Each reads its channel's fact; built later, under R1221.
