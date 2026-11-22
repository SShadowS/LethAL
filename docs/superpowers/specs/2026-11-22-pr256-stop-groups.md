# PR-256 pre-commitment (R1146): per-entry stop groups on v3 mutant requests, behind `alRunnerV3.stopGroups` (default off)

Status: pre-commitment (coord PR-256, lethal-preproc, 2026-11-22), after the spec-adversary (2 BLOCKs and 4 SHOULD-FIXes,
all taken below), before the build. The build does not need #8564 in `current`. The `stop-groups` probe, the gates with the
flag on and the DO measurement follow bugs' gate of a main build that carries it. Sources: `/coord/handoff/PR-256/plan.md`,
`/coord/handoff/PR-257/` (PERF-18, master 9e71211c6). Names and numbers only.

## What upstream gives (PR-257, measured)
- A request with `stopAfterFirstFailure: true`, and `stopGroup` on every entry. After the first failing test in a group, its
  later tests are not run. Mixing grouped and ungrouped entries is refused, and so is a group with the stop off.
- **A skipped row** comes back as status `error`, `notRun: true`, with the message `NotRun: out-of-scope: the test
  <Codeunit>.<Method> failed before it, and stopAfterFirstFailure (--stop-after-first-failure) ...`.

## The rules
1. **One group per ENTRY,** `<mutant>|<codeunit>`. The echo entry is its own group, `<mutant>|echo`. (Adversary BLOCK 2: one
   group per mutant lets a failure in one codeunit's entry skip a test in another entry, which today reads as a refusal.)
2. **Only on mutant requests:** prefetch (packed) and live calls, an alone call under a mutant (PR-297's tail route), and
   the R897 alone re-run. NEVER on baseline, warm-up, coverage, the PR-144 recheck, PR-297's tail stability pass, a NONE
   confirm, or a **kill-pair request** (NONE and M share one request; pairs are a confirm path and are sent with the stop
   off; adversary S1).
3. **Recognising a skipped row,** strict, and otherwise it stays a refusal as today (fail closed). A row is "skipped by the
   stop" only when all hold:
   - the request carried `stopAfterFirstFailure: true` and the row's entry carried a `stopGroup`;
   - its message matches the pinned text, naming test F;
   - F is an earlier row of the SAME entry whose status is a plain `fail` (not a timeout, not a refusal-marked fail,
     R639 K1(a));
   - F is a covering test of this mutant and was green, and not refused, at baseline (adversary BLOCK 1: a test red at
     baseline, declared before a covering test, must never be credited with a kill).
4. **What a recognised skip does:** no verdict, no kill, no error, no refusal, no daemon close, no cut. It is counted
   (`stopSkipped`).
   - The recognition sits in the mutant-row reuse check (`serveDaemonReusable`'s mutant-entry use) and its two companions
     (`unkeptRowReason`, `cutRow`), never in the shared rule the baseline uses (adversary S3).
5. **A skipped ref the walk still needs** (the kill ledger's preferred killer, a later covering test after a kill that does
   not stand, a ref in another entry) is re-run ALONE under the same mutant without the stop, the R897 `aloneAfterStop`
   pattern. It is never `rowMissing` or `error`.
   - So the walk, the R197 kill order and `killingTest` are exactly today's. A skip only saves the tests nobody asks for
     (adversary BLOCK 2, S2).
6. **Shape errors** are refused BY NAME before sending, with a typed error that is not swallowed by the pair-skip catch:
   grouped and ungrouped entries mixed, or a grouped entry with the stop off.
7. **Flag and capability:**
   - `alRunnerV3.stopGroups`, default OFF. With the flag off, requests are byte-identical to today (pinned by a test).
   - With the flag on, a build fact `stop-groups` is required, otherwise the run is refused by name.
   - The fingerprint and the lending tag gain ` stop-groups`, so `--resume` across flag states is refused.

## Tests (red before the build)
1. a skip after a plain fail of a green covering test in the same entry: no refusal, no close, `stopSkipped` 1, the mutant
   killed by F;
2. a skip naming a test red at baseline: a refusal, as today;
3. a skip naming a test of ANOTHER entry: a refusal (cannot happen with per-entry groups; pinned anyway);
4. the pinned text on a request sent without the stop, or on an entry without a group: a refusal (N1);
5. a skip after a timeout row: a refusal;
6. the walk asks for a skipped ref: it is re-run alone without the stop, and the killing test equals the flag-off one;
7. a kill-pair request with the flag on carries no stop and no groups;
8. a mixed request is refused by name (the typed error, not `pair-skipped`);
9. flag off: requests byte-identical.

## Predictions
- **Flag off** (every gate's default): nothing moves; no gate sets the flag.
- **The probe** (`stop-groups`, on the first build with #8564):
  - two grouped entries, the first failing, must skip the second with the pinned text;
  - a timeout row and a refusal row as the first failure must NOT produce the pinned skip text on a later row, or, if
    they do, rule 3 keeps them refusals;
  - the daemon is reusable after a skip (adversary S4).
- **DO measurement (later, its own pre-commitment):** flag on against off, per mutant. Verdicts and `killingTest` must be
  equal (rule 5 keeps the walk). The saving: R1098's ~10.7% of serve test time after a kill is an upper bound; per-entry
  groups and alone re-runs make it smaller.
