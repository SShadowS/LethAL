# R-619 plan: one lend function that all four lend sites call

Based on master 82244a33. The order table is `/coord/handoff/R-619/order-table.md`.
Predicted outcome changes: **none** (0 CHANGES cells there).

## The problem, in one line

`runMayLend` (store.ts) is tested (R586's T14) but no production code calls it. The four lend
sites copy its three steps inline. A change at one copy leaves T14 green.

## The design

### One function, on the store

Move `runMayLend` from a free function to a method of `ResultsStore`, and give it one new input:
the site's own checks, run between step 1 and step 2.

```ts
/** R619: why a run lends nothing, by step; `undefined` = it lends. */
export type LendRefusal =
  | { readonly step: "backend-build"; readonly why: string }
  | { readonly step: "site" } // the site's own check refused and already said why
  | { readonly step: "al-runner-unmarked" }
  | { readonly step: "al-runner-renamed"; readonly tests: readonly string[] };

runMayLend(
  run: { id: number; backend: string; runnerBuild: string | null; alRunnerNames: boolean },
  session: LendingSession | undefined,
  ctx: {
    /** Which site calls; for the R619 counters and for an error message. */
    readonly site: "history" | "resume" | "resume-run" | "snapshot";
    /** The site's own checks, after step 1 and before step 2. `true` = refused (the site has
     *  already reported it). May throw: a throw is the site's refusal. */
    readonly siteChecks?: () => boolean;
    readonly baselineErrorMethods: () => readonly string[];
    readonly renamed?: (methods: readonly string[]) => readonly string[];
  },
): LendRefusal | undefined
```

The order inside is fixed: step 1 (`backendBuildRefusal`), then `siteChecks`, then step 2
(`runLendsAlRunnerNames`), then step 3 (`renamed` over `baselineErrorMethods`, only when
`run.backend === "al-runner"`). This is the order every site has today (see the order table, §1),
so no outcome moves.

Why a method: every site already holds the store (`this` in `priorSurvivorKeys`, `cfg.store` in
`resolveResume`, `store` in `scoreBatch`). A test can then count calls with
`spyOn(store, "runMayLend")` (the repo already spies on an object method, `bcdev-backend.test.ts`),
and that also catches `this.runMayLend` inside `priorSurvivorKeys`. A free function called inside
its own module cannot be spied on.

`backendBuildRefusal` and `runLendsAlRunnerNames` stay exported (the method calls them, and
`lend-seed.test.ts` and `store.test.ts` read them), but `orchestrator.ts` stops importing them.

### How each site calls it

**H, `priorSurvivorKeys` (store.ts).** After the `if (!run) return none` line, one call:
- `siteChecks`: the existing scheme, coverage mode, test app, symbols, `carry_hidden` and hidden
  files checks, moved into the closure unchanged, each still calling its `on.*` callback. The
  parsed `hidden` is assigned to an outer `let` for the row filter below.
- `baselineErrorMethods: () => this.baselineErrorMethods(run.id)`; `renamed` only when
  `on.alRunnerTestNames` is given.
- Map: `backend-build` to `on.backendBuildRefused`, `al-runner-unmarked` to `on.alRunnerUnmarked`,
  `al-runner-renamed` to `on.alRunnerTestNames.refused`, `site` to nothing; each returns `none`.
- Deleted: the inline step 1 block, the inline step 2 block, the inline step 3 block.

**RL and RR, `resolveResume` (orchestrator.ts).** One local helper, called once in EACH branch (two
call sites, so each has its own red check):

```ts
const lend = (row: RunRow, flag: string, site: "resume" | "resume-run", siteChecks: () => boolean) => {
  const r = cfg.store.runMayLend(row, lendingSession, {
    site, siteChecks,
    baselineErrorMethods: () => cfg.store.baselineErrorMethods(row.id),
    renamed: alRunnerRenamed,
  });
  if (r?.step === "backend-build") throw new Error(`${flag}: ${r.why}; none of its verdicts is carried. Drop the resume flag to run from scratch.`);
  if (r?.step === "site") throw new Error(`${flag}: a resume site check returned instead of throwing (R619)`);
  return r?.step === "al-runner-unmarked" ? `run ${row.id} ${AL_RUNNER_UNMARKED_WHY}`
    : r?.step === "al-runner-renamed" ? alRunnerRefusal(row.id, r.tests) : undefined;
};
```

- RL: after `findResumableRun` and its 1a-1d diagnostics (unchanged), a null `getRun(found)` throws
  `--resume: the run it found is no longer in this database` (today's text). Then
  `carryRefused = lend(foundRow, "--resume: run N", "resume", () => { sameTestApp; assertSameBuildSymbols; carry_hidden null throw; return false; })`.
- RR: the not-found, project, finished and backend-equality checks stay before the call
  (unchanged). Then `carryRefused = lend(row, "--resume-run N", "resume-run", () => { scheme; mode; sameTestApp; symbols; fingerprint; carry_hidden; return false; })`.
- The common block after the branches keeps the `resume-al-runner-test-names` warning, now fed by
  `carryRefused`.
- Deleted: `assertLends`, the common step 2/step 3 expression (`priorRow === null || !runLendsAlRunnerNames(priorRow) ? ... : alRunnerRefusal(...)`) and the `priorRow` variable.
- Unchanged and outside the function: `findResumableRun`'s SQL (same backend, same v3 build), the
  hidden-files check after generation, the after-hook and under-lease test-app checks
  (`TestAppRepublishedError`). They already run after the R557 warning today.

**SN, `scoreBatch` (orchestrator.ts).** After `snapshotApplies`, when `reused !== undefined`:
- `getRun(reused.runId)` null: throw (the SQL guarantees the row; today it silently lends; the
  order table lists this unreachable difference).
- `store.runMayLend(snapshotRun, input.snapshot.lendingSession, { site: "snapshot", baselineErrorMethods: () => reused.baseline.filter(error).map(method), renamed: alRunnerRenamed })`, no `siteChecks`.
- Map: `backend-build` to `snapshot-backend-build-changed`; `al-runner-unmarked` and
  `al-runner-renamed` to `resume-al-runner-test-names` with today's two texts; then
  `reused = undefined`.
- Deleted: the `lendWhy` block and the two inline R557 blocks. The R-236c scope check stays after.

### Size

- `store.ts`: about +35 / -30 (the method and `LendRefusal`; `priorSurvivorKeys` reshaped).
- `orchestrator.ts`: about +40 / -55 (`lend` helper, two calls, snapshot call; imports).
- Tests: one new file `tests/r619-one-lend.test.ts`, about 300 lines; `r586-run-may-lend.test.ts`
  T14 bare cases edited (about 15 lines: call `store.runMayLend` with `site`).
- Docs: `docs/gates/lend.md` ("What this gate cannot reach": the `runMayLend` bullet goes; no
  figure changes), the header comment of `itest/lend.itest.ts` (2 lines), `R619.md` status.
- About 4 source/test files, about 450 lines touched.

## Test plan, test first

Write `tests/r619-one-lend.test.ts` before the refactor. On master, part (a) fails to compile or
fails (there is no `store.runMayLend`); (b) must pass on master except where it names the method,
because the outcomes do not change. That is the evidence for "zero changes".

Harnesses already in the repo: `runSession` with `ClockBackend` (al-runner shape,
`authoritative: false`) and an in-memory `ResultsStore` (`tests/resume.test.ts`, R557 block);
`V3KindStub` and `v3Session` for an al-runner-v3 session (`tests/r586-backend-kind.test.ts`);
seeding by `store.createRun` / `recordMutant` / `finishRun` or an `UPDATE runs` (both files do
this). Move `V3KindStub` to a shared test helper if it is not exported.

### (a) A call counter per site

Each test wraps the store with `spyOn(store, "runMayLend")` (calls through) and pushes, into one
shared log, `runMayLend:<site>:<step or lends>`. Where order matters it also spies the step before
(`findResumableRun`, `findBaselineSnapshot`) into the same log, so the test asserts order by call
sequence, never by time.

- A1 history: a finished bcdev run, a `--skip-known-survivors` session. Log is exactly one
  `runMayLend:history:lends` per batch, and the known survivors are its survivors.
- A2 `--resume`: log `findResumableRun`, then `runMayLend:resume:lends` once.
- A3 `--resume-run`: `runMayLend:resume-run:lends` once.
- A4 snapshot: a resume whose batch has a reusable snapshot. Log `findBaselineSnapshot`, then
  `runMayLend:snapshot:lends`, then the `resume-baseline-reused` warning.
- A5 negative: a session with no flag and an empty store logs no `runMayLend` call.

### (b) R586's T14 cases through the real sites

One table-driven `describe` per site, the same cases as T14, each asserting the SITE's effect
(lend or not, the warning code or error text) AND the spy's returned step:

| case | H | RL | RR | SN |
|---|---|---|---|---|
| v3 run, v2 session | `history-backend-build-changed`, 0 keys | not found (SQL); spy not called | backend-equality throw; spy not called | `snapshot-backend-build-changed` |
| v2 run, v3 session | as above | as above | as above | as above |
| v3 run, other build | step 1, 0 keys | not found (SQL) | throw `/al-runner-v3 build .* lent only to the same build/` | `snapshot-backend-build-changed` |
| v3 run, NULL build | step 1 | not found | throw, step 1 | step 1 |
| v3 same build | lends | lends | lends | reused |
| v2 and bcdev pair | lends (R592) | n/a | n/a | reused (coverage `none`) |
| unmarked v2 | `history-al-runner-test-names` | warn, 0 carried | warn, 0 carried | warn, baseline re-runs |
| marked v2, renamed error | warn (tests text) | warn (tests text) | warn (tests text) | warn (tainted text, from the snapshot's rows) |
| order: unmarked v3 other build | step 1 named | n/a | step 1 named | step 1 named |
| order: unmarked v2 + other coverage mode | `history-coverage-mode-changed`, spy step `site` | R354 throw | R354 throw, spy saw `siteChecks` throw | silent (SQL) |

The last row pins that site checks run BEFORE step 2 (the `siteChecks` slot), at each site where it
can be reached. Keep T14's bare cases in `r586-run-may-lend.test.ts` (now on the method); they are
fine once the method has production callers.

### (c) One red check per site

Revert, run, restore, with Edit only. Report both outputs.

| delete | goes red |
|---|---|
| H's `this.runMayLend` call (return keys without it) | A1; (b) H rows; `r618-lend-order.test.ts` N1o and RC4a; `r586-run-may-lend.test.ts` "T14 at the store sites"; `resume.test.ts` T8a, I1 (b) |
| RL's `lend(...)` call | A2; (b) RL "unmarked v2" and "renamed" rows; `resume.test.ts` T9a, I1 (a), I1 (c) |
| RR's `lend(...)` call | A3; (b) RR "v3 other build" (no throw) and "unmarked v2" rows |
| SN's `store.runMayLend` call | A4; (b) SN rows; `resume.test.ts` T10a, I1 (snapshot) |
| move step 2 above `siteChecks` inside the method | (b) last row at H (names `history-al-runner-test-names`) |

Also red-check each direction of the new snapshot null-row throw only if it is kept (it is
unreachable through `findBaselineSnapshot`, so a unit test must call the site with a fake store).

## Existing tests that pin the inline copies

- `tests/r586-run-may-lend.test.ts`: T14 calls the free `runMayLend` (14 uses) and
  `backendBuildRefusal` (5). Change the `runMayLend` calls to `new ResultsStore(":memory:").runMayLend(..., { site: ..., ... })`. "T14 at the store sites" already goes through `priorSurvivorKeys` and needs no change.
- `tests/r618-lend-order.test.ts`: drives `priorSurvivorKeys` (the real H site). No change; it now
  pins the method through H.
- `tests/resume.test.ts` (R557 block): `resume-al-runner-test-names` (10), `history-al-runner-test-names` (4), through `runSession`. No change expected; they must stay green as is.
- `tests/store.test.ts`: `runLendsAlRunnerNames` alone. No change.
- `itest/lend-seed.test.ts`: `backendBuildRefusal` message. No change.
- `tests/r586-backend-kind.test.ts`: a comment only.
- No test names `assertLends`. No offline test pins `snapshot-backend-build-changed` or
  `history-backend-build-changed`; only `itest/lend.itest.ts` does (exact texts). (b) adds offline
  ones.

## What `itest:lend` exercises, and why it stays unchanged

L0, L1, N0 (history lends), N1 (H step 1, exact `history-backend-build-changed` text), N5 (H test
app, revoked), R1 (`--resume-run` carry), R2 (`--resume` plus snapshot reuse), R3 (`--resume-run`
plus SN step 1, exact `snapshot-backend-build-changed` text), RN1 (RL test app, pending), RN2 (RR
test app, revoked), RN3 (RR backend equality, before step 1), RN4 (RR finished). Each of these is
decided by a check whose position and text the design keeps (order table rows 1, 12, 13, 19 and
C1). The `why` text still comes from `backendBuildRefusal`, and the callers keep today's message
templates. So the gate must pass with no edit to `lend.itest.ts` beyond its header comment and no
change to `gate-expected.ts`. Run it once on the final head (bcdev path; it touches
`orchestrator.ts` and `store.ts`), plus `itest:bcdev` per the gates-on-final-head rule. The
al-runner gates' R557 legs (`itest:alrunner` names legs) also read the R557 steps; run
`itest:alrunner` too.

## Out of scope

- R592 (v2 and bcdev lend to each other) and R621 (stored no-coverage carried against this
  session's coverage). The design keeps both as they are.
- Making the snapshot site check symbols or `carry_hidden`. Not checked today; no change.

## r2: rulings and plan-review fixes (2026-10-22)

These override anything above that disagrees.

- **Orchestrator ruling (b): THROW.** A snapshot whose run row is missing throws (caller-contract
  violation). Test: build that state directly through the store and assert the throw. Red check:
  revert to the old skip, and the snapshot lends.
- **Orchestrator ruling (a):** the same `--resume` throw, slightly earlier, is fine.
- **Review I1:** the snapshot step-3 test seeds a renamed `error` in the snapshot PAYLOAD ONLY (not
  in that run's `test_results`), and also the reverse (renamed in `test_results` only, which must
  NOT refuse). Then wiring the site to `baselineErrorMethods(snapshotRun.id)` goes red.
- **Review I2:** test order. Write the effect-only assertions (lend or no-lend, the throw, the warning
  code and text) first, and run them on master unchanged: they must pass there, and that run is the
  "zero outcome changes" evidence. Only then add the spy-log assertions, which go red on master
  (no method) and green after the build.
- **Review M3:** drop test A5.
- **Review M4:** `--resume`'s step 1 cannot fire in production (`findResumableRun`'s SQL filters by
  backend and, on v3, by build). It stays as a guard; its red check runs through `--resume-run` only,
  and the page and test names say so.
- **Review M5:** `hidden`, `priorHidden` and `recorded`, set inside the `siteChecks` closure, get a
  second check outside it that THROWS if unset (never a `!`, never a default).
