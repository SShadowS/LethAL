# R-675 plan r1: fail closed on any text before v3's refusal marker

FULL class (a verdict rule). Base: master `6a328a33` (R-672 merged). Measurement: `/coord/handoff/R-675/measure.md`.
Steer (orchestrator): prefer failing closed in leg C and at session level over widening K1(a)'s strip.

## 0. The idea in two lines

- **Verdicts stop depending on any prefix model.** K1(a), the serve-keep rule and the two defect-fact readers treat
  a `pass`/`fail` row as a refusal when its message CONTAINS `NotRun: out-of-scope:` anywhere (`includes`), not
  "at the start, after at most one word". Measured: 0 of 13,773 kills and 0 stored v3 `pass`/`fail` rows contain it.
- **The prefix check moves to KNOWN text.** Leg C's `message-has-no-type-prefix` reads `diverged` unless each probe
  message starts with its exact expected text (`boom 5`; `Assert.AreEqual failed.`). Any added text, of any shape,
  then reads `diverged`, which fails the update gate and refuses a session (its `Fails` half). Both probe texts
  start exactly so on alpha.2 and edge (6 logs).

`V3_TYPE_PREFIX` and the one-word model are deleted: nothing reads them any more.

## 1. The design, site by site

### 1a. One predicate, `isV3RefusalText` (`al-runner-rows.ts`)

```ts
/** v3's not-trusted refusal marker. R675: ONE source; `al-runner-v3-backend.ts` re-exports it. */
export const V3_REFUSAL_PREFIX = "NotRun: out-of-scope:";

/**
 * R675: a message that holds v3's refusal marker ANYWHERE (fail closed): whatever v3 writes before it (a
 * `<Type>: `, `Runtime error: `, `a::b: `, a chain) or whatever quotes it, the row is not trusted. The cost is a
 * lost kill for a user message that quotes the marker (the safe direction; measured 0 of 13,773 kills).
 */
export function isV3RefusalText(m: string | undefined): boolean {
  return m !== undefined && m.includes(V3_REFUSAL_PREFIX);
}
```

- `V3_REFUSAL_PREFIX` moves from `al-runner-v3-backend.ts` to `al-runner-rows.ts` (rows imports types only, so no
  cycle), and the backend keeps `export { V3_REFUSAL_PREFIX } from "./al-runner-rows"`, so its importers
  (`al-runner-v3-contract.ts`'s `isRefusalRow`) do not change.
- `V3_TYPE_PREFIX` and the anchored `V3_REFUSAL_TEXT` regex are deleted.

### 1b. K1(a) (S1, `v3RowVerdict`)

Code unchanged: it already calls `isV3RefusalText(row.message)` after the `notRun` branch. Only the comment
changes ("R675: the marker anywhere"). The returned object is unchanged, so an unprefixed refusal is
byte-identical; a row without the marker falls to `verdictFromRunnerTest` as today.

Newly `error`/`runner-test-error` (never scored): a `pass`/`fail` row whose message holds the marker after any
text: `Runtime error: `, `al_runtime::Error: `, `A: B: `, `x `, and also a user `Assert` text quoting the marker.
Measured today: 0 rows, 0 kills.

### 1c. Serve-keep (S5', `serveDaemonReusable`, v3 branch) and `r672Unkept`

Code unchanged: both call `isV3RefusalText`. With `includes`, a `pass`/`fail` row holding the marker anywhere closes
the daemon, and the warm-up/cut text names the rule. The pinned text "which R672 does not keep" stays (still
true); only the doc comments add R675. Measured: 0 rows, 0 extra closes.

### 1d. Defect facts (S9 `refusalRowShape`, S10 `commit-under-test-isolation`)

Code unchanged (same predicate). A plain `fail` holding the marker anywhere reads `diverged` (never `unlike-bc`,
never `gone`). Today's readings do not move: alpha.2 `defect-present` for both; edge `refusal-row-shape` =
`unlike-bc` (its HttpGet text is BC-like, no marker), `commit-under-test-isolation` = `defect-present`.

### 1e. Leg C's `message-has-no-type-prefix` (S13, `al-runner-v3-contract.ts`): an exact expected start

```ts
/** R675: the start each leg-C probe message must have, from LethAL's own probe AL. */
const PROBE_MESSAGE_START = { Fails: "boom 5", AssertAreEqual: "Assert.AreEqual failed." } as const;
```

- For each read message (`plain` from `Fails`, `assertMsg` from `AssertAreEqual`, as today), `bad` = the message is
  defined and does NOT `startsWith` its expected start.
- Verdict: any `bad` → `diverged`; else every message defined → `matches`; else `unmeasurable` (as today).
- `measured`: on `diverged`, lead with `unexpected start <JSON of the text before the expected start, or the first
  60 chars when the expected start is absent>; ` (the session's refusal shows it first, as today), then the same
  `Fails ...; <assert rows>` text.
- `expected` text: "Fails (a plain Error()) and AssertAreEqual are plain fails whose messages start exactly with
  `boom 5` and `Assert.AreEqual failed.` (any text before them is a prefix; R675)".
- `MESSAGE_TYPE_PREFIX` is deleted. The fact keeps its NAME (`.gated` files and leg-C lists carry it) and its kind
  (`contract`), so leg C still has 27 facts.
- `startsWith`, not equality: an appended call stack is not a prefix, and no site reads the end of the message.

### 1f. The session refusal (`v3ContractRefusals`, `MESSAGE_PREFIX_REASON`)

- No new code path: a session runs the same fact on its own `Fails` row, so ANY text before `boom 5` now refuses
  the session by name. The Assert half stays gate-only (as since r12).
- No row-level session refusal: the brief's alternative ("refuse when a row holds the marker away from the accepted
  position") has nothing left to catch, because with `includes` every position is accepted and the row is `error`.
  A run-wide refusal on a user message quoting the marker would also stop a whole session for a safe lost kill.
- New `MESSAGE_PREFIX_REASON`, verbatim:

> "text before the expected start of v3's failure messages (a `<Type>:` prefix of any shape) would turn v3's
> timeouts into errors (`V3_TIMEOUT_MESSAGE` is anchored), close the serve daemon on every refusal (R612's keep list
> is anchored), and skew the R553 assertion screen. K1(a) and the serve-keep rule read v3's refusal marker anywhere
> in a message (R675), so a prefix cannot turn a refusal into a kill; the session still refuses, because v3 no
> longer writes what was measured"

### 1g. Not changed

S2 (`RUNNER_REFUSAL`, v2's rule), S3/S4 (timeout, flag-based), S6 (`batchRefusalReason`), S7, S8 (`isRefusalRow`,
exact), S11, S12, and R612's keep LIST `V3_SERVE_SAFE_REFUSALS`: all anchored or flag-based, and a miss there is an
`error`, a closed daemon, a loud stop or a `diverged` fact. Not a verdict door.

## 2. What moves on today's builds: nothing

- K1(a) and serve-keep: 0 of 13,773 kills, 0 of 1,180 stored v3 `fail` rows, 0 of 63,264 `pass` rows contain the
  marker (measure §1). So 0 verdicts and 0 daemon closes move.
- S9/S10: 0 (measure §2).
- Leg C / session: `boom 5` and `Assert.AreEqual failed. Expected:<1> ...` start exactly with their expected start
  on alpha.2 (91253f2d6) and edge (57f1e4f98), in all 6 logs (measure §3). `matches` on both.

## 3. Tests (one red test per direction per site; byte-identity; each red check reported both ways)

Tests R-672 pinned that this plan INVERTS on purpose (each rewritten, its title naming R675):
- `al-runner-v3-backend.test.ts`: K1-d (`x NotRun: ...` scored `fail`), "an Assert text that quotes the refusal is
  still a kill", and both residual pins (`A: B: `, `Runtime error: `) become `error`/`runner-test-error`.
- `al-runner-v3-contract.test.ts`: "S9: an Assert text ... still unlike-bc" and "S10: ... still gone" become
  `diverged`.
- `al-runner-serve-rule.test.ts`: "v3 still keeps on ... an Assert text quoting the refusal" moves that row to the
  not-kept test.
- `al-runner-rows.test.ts`: the `V3_TYPE_PREFIX` property test is deleted (no shared prefix any more), replaced by
  the predicate test below.

**Predicate (`al-runner-rows.test.ts`).**
- True for the marker at 0 and after each of: `X: `, `X.Y: `, `Runtime error: `, `al_runtime::Error: `, `A: B: `,
  `x `, `[x] `, `Assert.AreEqual failed. Expected: `. Red: the R672 anchored regex makes the spaced, `::`, chained
  and quoted entries false.
- False for: `undefined`, `""`, `boom`, `NotRun: out-of-scope` (no colon), `notrun: out-of-scope: x` (case),
  `NotRun:  out-of-scope: x`. Red: `/NotRun/i` or `includes("out-of-scope")` makes one true.

**K1(a) (`al-runner-v3-backend.test.ts`).**
- Error direction: `fail` and `pass` with `Runtime error: `, `al_runtime::Error: `, `A: B: ` and the Assert-quoting
  text in front of `NotRun: out-of-scope: x` → `["error", "runner-test-error"]`, and the text says "never scored".
  Red on master (they score `fail`/`pass`).
- Kill direction: `fail` `boom 5`, `fail` `Assert.AreEqual failed. Expected:<1> ...`, `fail`
  `out-of-scope: x` (no marker) still score `fail` through `verdictFromRunnerTest`, compared as the whole object
  against master's. Red: a predicate that is always true, or `includes("out-of-scope")`.
- Byte-identity: the existing R672 whole-object test for the unprefixed `fail`/`pass` refusal stays as is. Plus one
  new whole-object test: a row WITHOUT the marker (`boom 5`) gives master's exact object.

**Serve-keep (`al-runner-serve-rule.test.ts`).**
- Not kept: `fail`/`pass` with `Runtime error: `, `a::b: `, `A: B: ` and the Assert-quoting text → `false`. Red on
  master (`true` for all four).
- Kept: `fail` `boom`, `pass`, every R612 keep-list `notRun` refusal → `true`; the v2 rule on the first row stays
  `true`. Red: drop the `!isV3RefusalText` term (the not-kept test goes red), or make the predicate always true
  (the kept test goes red).
- `al-runner-v3-entries.test.ts`'s stateful fake (tainted next request never scores): add one case with a
  `Runtime error: ` prefixed refusal written as a plain fail. Red on master: the daemon is kept and M scores `fail`.

**S9/S10 (`al-runner-v3-contract.test.ts`).** A plain fail with `Runtime error: ` / `a::b: ` / the Assert-quoting
text before the marker reads `diverged` (red on master: `unlike-bc` / `gone`). The no-marker readings (BC text →
`gone`/`unlike-bc`, other text → `unlike-bc`/`gone`) do not change: red with an always-true predicate.

**Leg C / session (`al-runner-v3-contract.test.ts`).**
- `diverged` + gate-fail + session refusal with `why: MESSAGE_PREFIX_REASON`: `Fails` = `Runtime error: boom 5`,
  `al_runtime::Error: boom 5`, ` boom 5`, `[x] boom 5`, `A: B: boom 5`, `Error: boom 5`; and AssertAreEqual =
  `Runtime error: Assert.AreEqual failed. ...`. Red on master for the first four and the Assert one (`matches`).
- `matches`: `boom 5`, `boom 5` + `\n<stack>`, and the measured Assert text. Red: equality instead of `startsWith`
  makes the stack case `diverged`; a wrong expected start (`boom`→`Boom`) makes `boom 5` `diverged`.
- The `measured` text leads with `unexpected start "Runtime error: "` (pinned).
- `unmeasurable` cases unchanged. The `MESSAGE_PREFIX_REASON` pin is updated to the §1f text.
- The session half: a session (`gateOnlyTrusted` set, no Assert app) with `Fails` = `Runtime error: boom 5` is
  refused (`v3ContractRefusals` non-empty, names the fact). Red on master.

Then `bun scripts/verify.ts runner` and the full `bun scripts/verify.ts` before submit. Docs: `docs/gates/alrunner-v3.md`
lines 20-29 (the fact's description: exact starts; `V3_TYPE_PREFIX` gone; K1(a) reads the marker anywhere) and one
History line for R675. R675 `status: "done (<commit>)"`, regenerate the index, `bun test scripts/line-citations.test.ts`.

## 4. Gates (on the final head; the same set as R-672)

- `bun scripts/verify.ts` (full).
- `LETHAL_ITEST_ALRUNNER_V3=1 LETHAL_ITEST_V3_TABLES=1 LETHAL_ITEST_V3_CDO=/work/lethal-wt/cdo-r396 bun run
  itest:alrunner-v3`, all 12 legs, on `current` (alpha.2, 91253f2d6); then the same 12 on edge 57f1e4f98
  (`LETHAL_ALRUNNER_V3_CANDIDATE=1`). Script: a copy of `/coord/handoff/R-672/live/run.sh` with the new head.
- The serve-entries chain E0-S, E1, E0-T, E2, E0-D, E3a, E3b through `/coord/handoff/R-653/live/chain.sh` with
  `Q=/coord/handoff/R-672/live` (R-672's reports and counters, which equal R-668's) and `OUT=/coord/handoff/R-675/live`.
  No V2 step (retired).
- No BC gate: no bcdev, v2, tables-on-BC or hang path is touched.
- The gates cannot reach the new branches (no build writes a prefix or a refusal without `notRun`); the unit red
  checks are their only evidence.

## 5. Pre-commitment (commit to master, `[skip ci]`, before any live run)

> **R-675 pre-commitment (2026-10-23).** Head: **lethal/r675 at `<sha after build>`**, fixed by an addendum commit
> before the first live run.
>
> **Change.**
> - `isV3RefusalText(m)` (in `al-runner-rows.ts`, with `V3_REFUSAL_PREFIX` moved there) is
>   `m.includes("NotRun: out-of-scope:")`. K1(a) (`v3RowVerdict`), the v3 branch of `serveDaemonReusable`,
>   `r672Unkept`, `refusalRowShape` and `commit-under-test-isolation` read it unchanged. `V3_TYPE_PREFIX` is
>   deleted.
> - Leg C's `message-has-no-type-prefix` reads `diverged` unless `Fails`' message starts with `boom 5` and
>   `AssertAreEqual`'s with `Assert.AreEqual failed.`; it no longer reads a prefix regex.
> - The session refusal stays; `MESSAGE_PREFIX_REASON` becomes the plan's §1f text, verbatim.
>
> **Measured** (`/coord/handoff/R-675/measure.md`): 0 of 13,773 kills (7,538 v3, 4,689 v2, 1,546 bcdev) contain the
> marker, `NotRun:` or `out-of-scope`; 0 of 1,180 stored v3 `fail` rows and 0 of 63,264 `pass` rows contain the
> marker; every stored refusal row has `notRun: true` and the marker at position 0; the two probe messages are
> `boom 5` and `Assert.AreEqual failed. Expected:<1> (Integer). Actual:<2> (Integer). R667 values differ.` on
> alpha.2 (91253f2d6) and edge (57f1e4f98), in all six logs.
>
> **Prediction.**
> 1. alpha.2, 12 legs: every leg PASS; leg C reads its **27** facts as in `/coord/handoff/R-672/live/step1-alpha2.log`,
>    `message-has-no-type-prefix` = **`matches`**.
> 2. edge, 12 legs: `message-has-no-type-prefix` = `matches`; leg C GATE-FAILs on exactly the six pre-existing
>    readings of `/coord/handoff/R-672/live/step2-edge.log` (`refusal-row-shape` = `unlike-bc`,
>    `duplicate-key-insert-raises` refused; `none-selected-exit`, `quoted-name-unselectable`, `refusal-cascade`,
>    `sleep-is-noop` gone), no new reading; X HELD at X (b); T HELD on exactly M0157-M0159, M0161-M0164; K skipped;
>    S1, S3, N1, L1, Y-A, Y-B, D1, D1c PASS; per-mutant verdicts, `killingTest` and failure texts as R-672's.
> 3. Serve-entries chain: report-diff 0 against R-672's seven reports; E0-T and E2 HELD on the same 7 rows; the
>    counters equal R-672's: E1 1/1/1, live 3, pair 3; E2 8/8/8, live 305, pair 290; E3a 1/1/1, live 51, coverage
>    37, echo 74; E3b 1/1/1, live 51, echo 37; every request, entry, pair and fallback count equal.
>
> Any moved verdict, killing test, failure text, fact reading or daemon count is a BLOCK.

## 6. Residuals

**Closed by this item.**
- `Runtime error: ` and `a::b: ` before a refusal written as a plain fail (R675's two shapes): `error`, daemon
  closed, defect facts `diverged`; and leg C/session see any added text on the probe rows.
- `A: B: ` chains: now closed in K1(a) too, not only by the build refusal.
- A refusal text reaching a LATER message (quoted by an `Assert`/`GetLastErrorText`): `error`, never a kill.

**Left open (none can make a false kill through the message prefix).**
- **Lost kills:** a user test whose failure quotes the marker loses its kill (`error`, shown, never scored).
  Measured 0; the safe direction. Recorded in the predicate's doc comment; no item.
- **A prefix on some message kinds only** (for example runtime errors, not `Error()` or `Assert`): leg C's two
  probes do not see it. Verdicts are safe (K1 is prefix-free); the cost is timeouts read as `error`, more daemon
  closes and a skewed R553 screen figure. No item unless a build shows it.
- **A reworded marker** (v3 writing something other than `NotRun: out-of-scope:`) on a refusal written as a plain
  fail: nothing in K1 sees it. Leg C's refusal facts (`isRefusalRow`, the R612 keep-reason fact) compare exact
  refusal texts and would read `diverged` on such a build, so it would not become `current`. Out of R675's scope;
  file only if wanted.
- **The Assert half in a session** is still trusted from `.gated`, which does not record which rule read it (as
  since r12). With K1 prefix-free this half only guards figures, so it is not a false-kill path.
