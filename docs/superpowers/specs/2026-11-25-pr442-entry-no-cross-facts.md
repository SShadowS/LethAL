# PR-442 pre-commitment: leg-C facts that no state crosses serve ENTRIES (what R1221's C1 and the echo drop need)

Status: pre-commitment r2 (coord PR-442, lethal-code, 2026-11-25), before the build. r2 replaces r1 after the
spec-adversary (1 BLOCKER, 5 SERIOUS, 3 MINOR; answers in §"Answers to the review") and a second premise probe in
LethAL's real request shapes and environment. Precedent: PR-342 (`2026-11-22-pr342-stop-groups-fact.md`), a gate-only
fact family. Related: R1221, R1220, PR-441, PR-436, PR-402.

## Why
- R1221's C1 (one shared NONE per killer per batch) and R1220's echo drop are each sound only if NO state crosses entries
  of one serve request.
- LethAL's `batch-no-cross-*` facts measure across test codeunits in ONE plain request, without `AL_STRICT_SEQUENTIAL`,
  so they say nothing about entries.

## The premise, measured on `current` (edge-e5176a9fd) in LethAL's real shapes
**Probe v2:** `/coord/handoff/PR-442/probe442b.ts`, invented AL, output `probe-v2-current.json`.
- **Two apps:** a target app (the selector and the app-side state) and a tests app (a test-side SingleInstance, and the
  test codeunit).
- **Test order:** the codeunit runs `A_Reader1`, `B_Writer`, `C_Reader2` (declaration and name order agree).
- **Readers always fail** with `MEASURED` and every channel's value.

**What was sent:**
- Entry e1 (resource `MUT-A`) is the whole codeunit, so its `C_Reader2` is the positive control.
- Entry e2 (resource `MUT-B`) is the whole codeunit cut through `A_Reader1` (`excludeTests`), which is LethAL's cut.
- **Three modes:**
  - `T-flag`: `testIsolation: "test"` with `runSelectedOnly`;
  - `T-plain`: `"test"` unflagged, where the cut tail still runs hidden;
  - `C-method`: `"codeunit"` with method entries, after a whole-codeunit positive-control entry.
- **Each mode on two daemons:** `v3MutantDaemonEnv(undefined, false)` and `(undefined, true)` (login replay off, on).
- No coverage fields, as in mutant requests.

**Result, in all six runs:**
- **e2's `A_Reader1` is clean.** The selector cache equals `MUT-B`, the resource sent to e2. Every other channel is at
  its default.
- **The positive control** (`C_Reader2`, after `B_Writer` in one entry) sees these channels carry: app SingleInstance 7,
  test-side SingleInstance 8, codeunit global 9, library codeunit in a global 5, WorkDate 2031-01-01,
  GlobalLanguage 1030 (its booleans print in Danish), temp table in a SingleInstance 1, static-automatic SingleInstance
  subscriber 2, manual bound subscriber 1.
- **Not even live between tests of one entry:** rows 0, IsolatedStorage `No`, last error empty. NumberSequence carries
  within an entry only under `"codeunit"` (`Ja`) and reads clean across entries.
- Rows stream in entry order; each row carries its `entry`.

## The change
- **One probe layout, measured per mode and replay setting, read into one fact per channel.** The facts are
  `entry-no-cross-<channel>`:
  - **live channels** (their positive control must carry, or the fact reads a dead probe): `selector-cache`,
    `singleinstance`, `test-singleinstance`, `codeunit-global`, `library-global`, `workdate`, `globallanguage`,
    `temp-table`, `manual-subscriber`, `static-subscriber`;
  - **rollback channels** (no liveness asked; clean across entries is required): `rows`, `isolatedstorage`,
    `numbersequence`, `lasterror`.
- **The AL is probe v2's, as fixed ids in the contract:**
  - its own two invented apps (target and tests), in a free id range (the builder picks and names it);
  - the selector shaped like `emitResourceSelector` (it caches `NavApp.GetResourceAsText`);
  - readers that always fail with every value (`key=value` pairs the judge parses).
- **The servers:** two serve daemons for this family, `v3MutantDaemonEnv(undefined, false)` and
  `v3MutantDaemonEnv(undefined, true)`.
  - The argv is the contract probe's own: environment, `--no-download`, and the fact apps' symbols.
  - License and companies don't matter: the AL touches no licensed object and no company data beyond its own tables.
- **The requests:** probe v2's three modes, with bodies built like `requestBase` plus `encodeGroups` (whole-codeunit
  entries, `excludeTests` cuts). There are no coverage fields: the fact needs its own `ask`, not `batchFactsOn`'s, which
  injects coverage.
- **The judge, per channel.** `matches` only when ALL of these hold, in all six runs:
  - the rows are exactly the expected ones (count, `entry` ids, names, order);
  - e2's reader value is the channel's default; for `selector-cache`, both `selector` and `fresh` equal `MUT-B`, the
    resource sent to e2;
  - for a live channel, the positive control's value is NOT the default in the mode(s) where it is live.
- **Other verdicts:**
  - a channel whose cross-entry value is not the default reads `diverged` and prints `al-runner-v3-entry-carry: <fact>`;
  - a live channel whose positive control reads the default reads `diverged` and prints
    `al-runner-v3-entry-probe-dead: <fact>`;
  - no answer reads `unmeasurable`.
- **The gate rule** (as PR-342's `stop-groups`):
  - `diverged` never fails the gate, and the two codes are printed in leg C only;
  - `unmeasurable` is an infra-fail;
  - the facts sit outside `V3_CAPABILITY_FACTS`.
- **The plumbing sites:**
  - the facts' list;
  - `legCBatchFacts`'s filter in `al-runner-v3.itest.ts`, which must gain every new key or nothing is recorded;
  - `classifyLegC`'s non-blocking branch;
  - `V3_LEG_C_FACTS` and its pin in `r586c-pins.test.ts`;
  - the spawn guards, which count the two new daemons.
- **The consumers, later and not in this PR:**
  - **C1** requires EVERY `entry-no-cross-*` key `=== "matches"` in the build's record. An absent key means off.
  - **The echo drop** requires `entry-no-cross-selector-cache === "matches"`, plus R1220's two conditions (the hash
    checked against LethAL's own sha, failing loudly when absent).
  - Both cover login replay on and off, because the facts are judged over both.
- **A named limit.** The update gate writes `batchFacts` into `.gated` only when DBM passed and batched (PR-342
  amendment 1). A build whose DBM does not batch gets no keys, so both consumers stay off. That fails closed.
- **No DotNet cases.**

## Predictions (any difference is a BLOCK until explained)
- **Leg C's fact count: 38 → 52** (14 new facts). `V3_LEG_C_FACTS` and its pin move together. If another leg-C fact
  lands first, an amendment restates the count.
- **On `current`:** all 14 `entry-no-cross-*` read `matches`, and neither new warning code is printed.
- **`itest:alrunner-v3`:**
  - no per-mutant verdict, killing test, note set, refusal set or warning set moves in any leg;
  - leg C prints 14 more fact lines;
  - the receipt's `batchFacts` gains the 14 keys, and no other key moves.
- **`v3ReadingsDigest` is unchanged.**
- **The update gate's leg C on `current`:** the 14 facts `matches`. The record is written by the update gate's owner after
  the merge, as for PR-342.
- **The carry gate:** unchanged. **The BC gates:** no figure moves; they run only if `selectLegs` names them.

## Answers to the review
1. **The selector judge compared two reads that can both be wrong (BLOCKER).** It now compares with the resource sent to
   e2 (`MUT-B`) and checks each row's `entry`. Its positive control is probe v2's: in e1 the reader sees `MUT-A`, and in
   e2 it must see `MUT-B`. A stuck resource reads `MUT-A` in e2 and is `diverged`.
2. **Not LethAL's request shape.** Whole-codeunit entries with `excludeTests` cuts, flagged and unflagged, plus the
   `"codeunit"` method mode; no coverage.
3. **Environment and login replay.** Re-measured with `v3MutantDaemonEnv`, replay off and on. The facts run both.
4. **Missing channels.** Added test-side SingleInstance (two apps), rows, IsolatedStorage, NumberSequence, a
   static-automatic SingleInstance subscriber, and the last error.
5. **A clean reader that read nothing.** Readers always fail with every value, the judge compares with the defaults,
   and it needs the exact rows.
6. **Consumer wording.** C1 needs every key; the echo drop needs `selector-cache` plus R1220's conditions.
7. **Order.** `A_`/`B_`/`C_` prefixes; the judge pins row order and `entry`.
8. **One code for two causes.** Now `al-runner-v3-entry-carry` and `al-runner-v3-entry-probe-dead`.
9. **Recording and plumbing.** Named above, with the DBM limit stated.
