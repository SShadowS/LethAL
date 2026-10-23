# R-672 plan r2: one `<Type>: ` prefix, shared by K1(a), the serve-keep rule and the leg-C fact

FULL class (a verdict rule). This is plan r1 (`/coord/handoff/R-672/plan.r1.md`) plus the changes from the deep
review (`/coord/reviews/R-672-plan/adversary-r1.md`, CHANGES) and the orchestrator's rulings:
- R-656 lands AS IS.
- Leg C's fact is widened INSIDE R-672, to the same prefix shape, and pre-committed.
- The session refusal stays; only its reason text is rewritten.

Measurement: `/coord/handoff/R-672/measure.md` (unchanged). Base: master after R-656 merges.

## What changed from r1

1. One shared PREFIX (`V3_TYPE_PREFIX`), not one shared regex. The leg-C fact now uses it, replacing
   `AL_RUNNER_EXCEPTION_PREFIX` (§1, §1b). A property test ties the two (§2).
2. A new site: the v3 serve-keep rule (`serveDaemonReusable`) no longer keeps the daemon after a refusal written
   as a plain `pass`/`fail` (§1c).
3. `MESSAGE_PREFIX_REASON` now says that only a ONE-word prefix is covered (§3).
4. The residuals are named: `A: B: ` is refused by the fact; `Runtime error: ` and `a::b: ` go to a new item (§6).
5. The pre-commitment is complete (§5).
6. The "S13 is not this item" lines are removed.

## 1. The change

### 1a. The prefix and the predicate, in `packages/runner/src/al-runner-rows.ts`

`al-runner-rows.ts` imports only types from `./backend`. So the backend, the server and the contract can all
import from it without a cycle (`al-runner-server.ts` cannot import `al-runner-v3-backend.ts`, which imports it).

```ts
/**
 * R672: ONE `<Type>: ` failure-message prefix: the type slot of R534's `RUNNER_REFUSAL`, a strict superset of
 * R553's `...Exception: ` (every `[\w.]`-word ending in `Exception` is one such word). It is the one source for
 * K1(a), the v3 serve-keep rule and leg C's `message-has-no-type-prefix`. `Assert.*` text never fills it, because
 * a space comes before its first colon.
 */
export const V3_TYPE_PREFIX = String.raw`[A-Za-z_][\w.]*: `;

/**
 * R672: v3's refusal text after at most one `V3_TYPE_PREFIX`. It is one anchored regex with an OPTIONAL group,
 * never "strip, then startsWith": the slot also matches `NotRun: `, and stripping that would lose today's
 * unprefixed refusal. The engine backtracks to the empty group.
 */
const V3_REFUSAL_TEXT = new RegExp(`^(?:${V3_TYPE_PREFIX})?NotRun: out-of-scope:`);
export function isV3RefusalText(m: string | undefined): boolean {
  return m !== undefined && V3_REFUSAL_TEXT.test(m);
}
```

Uses (the r1 sites stay as they were):
- **S1, K1(a)** (`v3RowVerdict`): `startsWith(V3_REFUSAL_PREFIX)` becomes `isV3RefusalText(row.message)`. The
  verdict it returns does not change, so an unprefixed row is byte-identical.
- **S9** (`refusalRowShape`'s last line) and **S10** (`commit-under-test-isolation`): the same predicate. A
  prefixed refusal written as a plain fail now reads `diverged`. Today's readings do not change. On alpha.2 both
  read `defect-present`. On edge, `refusal-row-shape` reads `unlike-bc` (BC-like text, not a refusal) and
  `commit-under-test-isolation` reads `defect-present`.

### 1b. The leg-C fact (S13, in `al-runner-v3-contract.ts`)

- `AL_RUNNER_EXCEPTION_PREFIX` is deleted. Its only user is this fact, on `lethal/r656`; the docs and plans
  that name it are history.
- The fact reads `new RegExp(`^${V3_TYPE_PREFIX}`).exec(m)?.[0]` on the same two messages: `Fails`
  (`boom 5`) and `AssertAreEqual`.
- Leave the other unchanged. Both of today's texts have no `<word>: ` at the start, so the fact reads `matches`
  on alpha.2 and edge, as on a6233dfb. The fact still gives 27 facts.
- The fact is wider than K1 on purpose:
  - `A: B: boom` matches the fact, so the build is refused, but K1 does not match `A: B: NotRun: ...`.
  - Refusing the build is the net for chains.
- New `expected` text: "Fails (a plain Error()) and AssertAreEqual are plain fails whose message does not start
  with a `<Type>: ` prefix (V3_TYPE_PREFIX, `[A-Za-z_][\w.]*: `; R672)".
- `docs/gates/alrunner-v3.md` (line 23 on `lethal/r656`): name `V3_TYPE_PREFIX` in `al-runner-rows.ts`, and say it
  is the prefix K1(a) also reads. Add one History line, for R672.

### 1c. The serve-keep door (new site S5', `serveDaemonReusable`, v3 branch, in `al-runner-server.ts`)

Today a `pass` or `fail` row keeps the daemon when `t.notRun !== true`. This includes a refusal written as a
plain fail, prefixed or not, which is the very case R672 exists for.

Change: `return t.notRun !== true && !isV3RefusalText(t.message);`. The v2 branch does not change. Every v3 caller
goes through this rule:
- the warm-up check;
- the R612 cut in `request`;
- the `!serveDaemonReusable` row finder;
- the plain serve path's `daemon.dirty`.

**The false-kill sequence it closes:**
1. Request R: v3 refuses a test (for example a panic) but writes the row as a plain `fail` without `notRun`.
2. K1(a) makes that one row `error`. But the keep rule reads only status and flag, so the daemon is kept. Yet the
   refusal says the runtime's state is not trusted.
3. The next request, under mutant M, runs on the tainted daemon. A test fails because of the taint, not because of
   M. That failure is a kill candidate.

**Does the R653 pair confirm already contain it? Only in part.**
- R577 / R653 sends NONE and M again, NONE first.
  - On the entries path they go in one request.
  - On the plain serve path they go as live requests on the same kept daemon (`sendKillPair` returns early when
    entries is off).
- A taint that fails every run is caught: NONE fails, so there is no kill.
- A taint that is mutant-path-dependent is NOT caught. That is a corrupted state that only the code M changes
  reads. NONE passes, M fails again, and the false kill stands on both paths.
- So the confirm is not a proof, and the keep rule must close.

Measured cost: 0 rows. No measured build writes a refusal without `notRun` (measure §2), so no daemon closes
change.

### Not changed (as r1, minus S13)

- S2 (v2's rule): a second net.
- S3, S4: flag-based; a prefixed timeout becomes `error`, which is safe.
- S5's keep LIST (R612): it widens only by probe.
- S6, S7.
- S8, S11: exact contract facts.
- S12: report figures only.

## 2. Tests (one red test per direction per site; each red check reported both ways)

`tests/al-runner-v3-backend.test.ts`, K1 (as r1):
- **Prefixed refusals become `error`/`runner-test-error`.** `fail` and `pass` rows, each with one of:
  - `SomeException: NotRun: out-of-scope: x`;
  - `Microsoft.Dynamics.Nav.Types.Exceptions.NavNCLAssertErrorException: NotRun: out-of-scope: x`;
  - `Error: NotRun: out-of-scope: x`.

  They are red on master.
- **Still scored as a `fail`:**
  - `Assert.AreEqual failed. Expected: NotRun: out-of-scope: x`;
  - K1-d's `x NotRun: ...`.

  Red check: swap the predicate for `includes(...)`.
- **Residual pins**, scored as a `fail` and NAMED as known false-kill residuals in the test title:
  - `A: B: NotRun: out-of-scope: x`, with a comment pointing at the leg-C fact that refuses such a build;
  - `Runtime error: NotRun: out-of-scope: x`, with a comment pointing at the new item (§6).

  Red check: a repeated group `(?:P)*` turns the `A: B:` pin red. These pins exist so that widening the rule is a
  deliberate change.
- **Byte-identical:** the unprefixed `fail` and `pass` give the WHOLE verdict object (`toEqual`). Red check: the
  strip-then-startsWith form.
- **S9 and S10:** as r1. A prefixed plain fail reads `diverged` (red on master: `unlike-bc` and `gone`). The
  other readings do not change.

**Property test** (new, in `tests/al-runner-rows.test.ts`):
- The list of prefixes:
  - `X: `, `X.Y: `, `NavNCLDialogException: `,
    `Microsoft.Dynamics.Nav.Types.Exceptions.NavNCLAssertErrorException: `, `Error: `, `_a1: `;
  - `Runtime error: `, `a::b: `, `x `, `Assert.AreEqual failed. Expected: `, `1X: `, `: `.
- For each prefix p in the list: `^V3_TYPE_PREFIX` matches `p + "boom"` exactly when `isV3RefusalText` matches
  `p + "NotRun: out-of-scope: x"`.
- Two exceptions are pinned on their own:
  - `""`: K1 is true and the fact is false (an unprefixed refusal);
  - `A: B: `: the fact is true and K1 is false (the chain asymmetry).
- Red check: give K1 its own copy of the prefix without the dot (`[A-Za-z_]\w*: `). The dotted entries go red.

`tests/al-runner-server.test.ts`, the serve-keep rule:
- **Not kept:** `[{status:"fail", notRun:false, message:"NotRun: out-of-scope: x"}]`, and the same with
  `Error: ` in front, read `false` under the `"v3"` rule. They are red on master (`true`).
- **Kept:** `fail` with `Assert.AreEqual failed. Expected: NotRun: out-of-scope: x`, plain `fail` `boom`, and
  `pass` read `true`. Every R612 keep-list `notRun` refusal still reads `true`.
- The `"v2"` rule on the first row stays `true`, so v2 is unchanged. Red check: drop the `!isV3RefusalText` term,
  and the not-kept test goes red.

Leg-C fact (`tests/al-runner-v3-contract*.test.ts`, the R-656 fact tests on a fake v3):
- `Error: boom 5` and `A: B: boom 5` read `diverged`. This is a gate-fail and a session refusal, with
  `MESSAGE_PREFIX_REASON` printed. Red on `lethal/r656`, where they read `matches`.
- `SomeException: boom 5` reads `diverged`, as before.
- `boom 5` and `Assert.AreEqual failed. ...` read `matches`, as before.

Then `bun scripts/verify.ts runner`, and the full `bun scripts/verify.ts` before submit.

## 3. `MESSAGE_PREFIX_REASON` (the session refusal stays a refusal)

New text:

> "a `<Type>:` prefix on v3's failure messages would turn v3's timeouts into errors (`V3_TIMEOUT_MESSAGE` is
> anchored), close the serve daemon on every refusal (R612's keep list is anchored), and skew the R553 assertion
> screen. K1(a) keeps a refusal written as a plain fail unscored only after a ONE-word prefix (`V3_TYPE_PREFIX`,
> R672); a longer prefix could still make it score as a kill (R667)"

The unit test that pins the text is updated with it.

## 4. Gates (on the final head)

- `bun scripts/verify.ts` (full).
- `LETHAL_ITEST_ALRUNNER_V3=1 bun run itest:alrunner-v3`, all default legs:
  - on `current` (alpha.2, 91253f2d6);
  - then the candidate legs on edge (57f1e4f98, `LETHAL_ALRUNNER_V3_CANDIDATE=1`).
- The serve-entries legs E0-S, E0-T, E0-D, E1, E2, E3a and E3b, as R-668 ran them: report-diff 0 against R-668's
  reports, and its serve counters equal.
- No BC gate. No path of bcdev, al-runner v2, the tables gate or the hang gate is touched. `serveDaemonReusable`'s
  v2 branch does not change.
- **The gates cannot exercise the new branches,** because no build writes a prefix or a refusal without `notRun`.
  The unit red checks in §2 are the only evidence for them, so each must be reported in both directions.

## 5. Pre-commitment (commit to master, `[skip ci]`, before any live run)

> **R-672 pre-commitment (2026-10-23).** Head: **lethal/r672 at `<sha after build>`**, to be fixed by an addendum
> commit before the first live run.
>
> **Change.** `V3_TYPE_PREFIX = [A-Za-z_][\w.]*: ` (in `al-runner-rows.ts`) is the one prefix source for:
> - K1(a) (`v3RowVerdict`), `refusalRowShape` and `commit-under-test-isolation`, which read v3's refusal as
>   `^(?:V3_TYPE_PREFIX)?NotRun: out-of-scope:` (`isV3RefusalText`) instead of
>   `startsWith("NotRun: out-of-scope:")`;
> - the v3 branch of `serveDaemonReusable`, which keeps the daemon after a `pass`/`fail` row only when
>   `!notRun && !isV3RefusalText(message)`;
> - leg C's `message-has-no-type-prefix`, which reads `^V3_TYPE_PREFIX` on `Fails` and `AssertAreEqual` and
>   replaces `AL_RUNNER_EXCEPTION_PREFIX` (a strict superset of it).
>
> The session refusal stays. Its reason text becomes the §3 text above, verbatim.
>
> **Measured** (`/coord/handoff/R-672/measure.md`):
> - every v3 refusal row on alpha.2 (91253f2d6) and edge (57f1e4f98) carries `notRun: true`, `status: "error"`
>   and no prefix;
> - 0 of 6797 v3 kills, and 0 of 12645 kills on any backend, contain `NotRun:`;
> - neither of leg C's two probe texts (`boom 5`, `Assert.AreEqual failed. Expected:<1> ...`) starts with a
>   `<word>: `.
>
> **Prediction, on both builds:**
> 1. Every leg of `itest:alrunner-v3` and every serve-entries leg gives per-mutant verdicts, `killingTest` and
>    failure texts identical to its last recorded run.
> 2. Leg C reads its **27** facts exactly as on a6233dfb, `message-has-no-type-prefix` = **`matches`** on alpha.2
>    and on edge:
>    - alpha.2: PASS;
>    - edge: GATE-FAIL on its pre-existing readings only, with `refusal-row-shape` = `unlike-bc` and
>      `commit-under-test-isolation` = `defect-present` unchanged.
> 3. The serve-keep change closes no extra daemon. In E1, E2, E3a and E3b, the serve-entries counters equal
>    R-668's (`/coord/handoff/R-668/live/E*.log`):
>    - `daemons` / `cachedFalse` / `warmups`: E1 1/1/1, E2 8/8/8, E3a 1/1/1, E3b 1/1/1;
>    - the request, entry, pair and fallback counts of each leg are equal too.
>
> Any moved verdict, text, fact reading or daemon count is a BLOCK.

## 6. Roadmap and residuals

R672 gets `status: "done (<commit>)"` in the submitted branch. Then regenerate the index and run
`bun test scripts/line-citations.test.ts`.

The residuals:
- **`A: B: ` (two or more prefix words): closed by leg C, not by K1.** The widened fact refuses such a build, so
  it never becomes `current`, and a session refuses it. The unit pin names this.
- **`Runtime error: `, `a::b: ` (a prefix with a space or a `::` path): open.** Neither K1 nor the fact sees
  them. The text for the new item, for the coordinator to file:

> **al-runner v3: a failure-message prefix with a space or a `::` path is seen by neither K1(a) nor leg C**
> (section `correctness-risks`).
>
> **Filed 2026-10-23 by lethal-code**, from R-672's plan review. Related: [[R672]], [[R667]], [[R657]].
>
> **What.** R672 made K1(a) (`v3RowVerdict`), the v3 serve-keep rule and leg C's `message-has-no-type-prefix`
> read one shared prefix, `V3_TYPE_PREFIX` = `[A-Za-z_][\w.]*: `: one word, dots allowed. Two shapes fill
> neither:
> - a prefix with a space (`Runtime error: `);
> - a Rust-style path (`al_runtime::Error: `).
>
> Suppose a future v3 build wrote its failures that way, and also wrote a refusal as a plain `fail` without
> `notRun`. Then the refusal would score as a KILL, the serve daemon would be kept on a tainted runtime, and the
> leg-C fact would still read `matches`. Nothing measured writes either shape: alpha.2 and edge write no prefix,
> and 0 of 12645 stored kills contain `NotRun:`. The unit test that pins `Runtime error: NotRun: out-of-scope: x`
> as a `fail` names this item.
>
> **To close.** Either:
> - measure, on each new v3 build, that no failure message carries such a prefix; or
> - widen `V3_TYPE_PREFIX` by a probe and a new pre-commitment. For example, add `::` to the class, or allow a
>   bounded run of words, after checking that no `Assert.*` or BC text can then fill the slot.
>
> FULL class: it touches a verdict rule.
