# R-606 CDO pre-commitment: the R546 slice on serve, patched and unpatched al-runner v3 at 93415c0bb

Drafted 2026-10-21 by the bugs lane's agent, BEFORE any leg ran. Nothing below has been measured on
these builds yet. The lane commits this file; the legs start only after that commit.

## 1. The builds (select BY PATH, never through `current`)

Both print `al-runner 3.0.0-alpha.3 (93415c0bb)`, so the version line cannot tell them apart. The
sha256 of the binary is checked against these values before EVERY leg, and written on the leg log's
first lines. A mismatch stops the leg before it starts.

| Build | Path | sha256 |
|---|---|---|
| PATCHED (upstream main 93415c0bb + `resfix.patch`, R-606) | `/work/tools/al-runner-v3/local-93415c0bb-resfix/al-runner` | `f02a04ed358ec8c9ba25496767f2e9b30322a51934efedd4a30f49eb10e9acbf` |
| UNPATCHED (upstream main 93415c0bb, clean) | `/work/tools/al-runner-v3/local-93415c0bb-unpatched/al-runner` | `379a5fad88617096698ef70d3883d741920cd76d4321244d013ff0cda861eece` |

Both hashes were checked at draft time and equal the `SHA256SUM` files beside them.

## 2. The slice (exactly R546's and R594's)

- CDO `5f2a71d36215a83fa4a554de90637f151521feb5`, read-only checkout `/work/lethal-wt/cdo-r396`.
  Checked at draft time: clean (0 lines of `git status --porcelain`), at that commit, corpus
  fingerprint `aa47c61c1fcbb7e3` (540 `.al`, `scripts/corpus-fingerprint.ts`). Re-checked at the
  start of every leg; any difference refuses the leg.
- Project `Cloud`, `--only .dependencies/CDO/Codeunit/CDORecipientMgt.Codeunit.al`.
- Tests `Test`, `--tests-only Src/Recipients/CDORecipientMgtTests.Codeunit.al`.
- Selector ids 6175460 (selector) / 6175459 (control) / 6175458 (table).
- Packages `Test/.alpackages` (read only).
- A fresh results store per leg (`run-fixture.ts` deletes and recreates `<tag>-scratch/`, which holds
  the leg's `lethal.sqlite`). Never `--resume`.
- Coverage OFF on every leg (`--coverage none`).
- `ALRUNNER_CACHE=/work/tools/al-runtime-rs/cache`, as R-586.

## 3. The driver and the LethAL commit

- R-586's method, unchanged: `scripts/r586-probe/run-fixture.ts` builds LethAL's own
  `AlRunnerBackend` + `runSession`, with `alRunnerPath` pointing at a per-leg launcher that runs
  `scripts/r586-probe/v2-shim.sh` (answers `--version` with a v2 line, `--server` -> `serve`, maps
  exit 7/8 to 1). The new `al-runner-v3` backend is NOT used: it is one-shot only and refuses the
  resource selector by name.
- Run from a NEW scratch worktree of `lethal/r586` at `5eb544ef` (the branch head at draft time),
  detached, never committed to. The R-586 worktree and its branch are not touched.
- **Guards on resource-on-serve.** On this path none is expected: `AlRunnerBackend` refuses the
  resource selector only for an app `runtime` below 14.0 (CDO `Cloud` and `Test` are 17.0), and
  R-586's recommendation 7 refusal is not in `AlRunnerBackend`; it lives in `al-runner-v3-backend.ts`,
  which is not on this path; `run-fixture.ts` does not go through the CLI. If any guard refuses
  anyway, it is lifted in the scratch worktree only, and results.md names the guard, the file and
  the exact change. Nothing lands on any branch.
- **One measurement-only addition: a serve-traffic tap**, in the scratch worktree's copy of the
  launcher/shim only. On `--server`, the shim tees the daemon's stdin (every request line) to
  `<leg>.serve-in.ndjson` and, from stdout, ONLY the `"type":"summary"` lines and `{"error":...}`
  lines to `<leg>.serve-out.ndjson`. Test rows (which carry failure messages) are not tapped. Both
  files are written under `/coord/handoff/R-606/cdo/`; request lines hold paths and test names only.
  The bytes passing between LethAL and the daemon are not changed.

## 4. The legs (one at a time, each a background job, coverage off)

| Leg | Build | Transport | Selector | Oracle |
|---|---|---|---|---|
| (c) | UNPATCHED | `serve` | RESOURCE | `docs/measurements/r594/bc3-A.report.json` |
| (a) | PATCHED | `serve` | RESOURCE | same |
| (b) | PATCHED | `serve` | STATIC (the control) | same |

Run order: (c), (a), (b). Each starts only when at most ONE other heavy job runs container-wide
(local al-runner / itest processes and corpus jobs, counted with the `[b]racket` pgrep form), and
each logs as it runs to `/coord/handoff/R-606/cdo/<leg>.log`, whose first lines are the build path,
its sha256 checked at start, the LethAL commit and the CDO commit + fingerprint. A leg is never
signal-stopped.

(a) against (c) is the patch's effect on one base; (b) is the static-selector control on the
patched build.

## 5. The oracle

`docs/measurements/r594/bc3-A.report.json` (bc3, live BC 28.4, coverage `none`, LethAL `ef0e54ea`,
identity scheme 40): 63 mutants, **51 killed / 12 survived / 0 no-coverage**, equal 63 of 63 on
verdict and killing test to R546 `bc-A`. It is redacted, so mutated-text comparisons are marker to
marker: results.md says how many rows were text-verified (by mutated-text hash) and how many were
not, as R-586 did (16 / 47 there).

Comparison: `run-fixture.ts`'s own `normalizeForComparison` + `compareMutants` (verdict, killing
test, coverage filter, mutated-text hash), plus `scripts/r594/compare.ts` (R546's `bucket`) and
`scripts/report-diff.ts`, each against the oracle.

## 6. Predictions

| Leg | Verdict + killing test vs oracle | Counts | `killReproduced` | Baseline |
|---|---|---|---|---|
| (c) unpatched, resource | **63 of 63 equal** | 51 / 12 / 0 | on all 51 kills | 21 of 21 green |
| (a) patched, resource | **63 of 63 equal** | 51 / 12 / 0 | on all 51 kills | 21 of 21 green |
| (b) patched, static | **63 of 63 equal** | 51 / 12 / 0 | on all 51 kills | 21 of 21 green |

Why (c) is predicted correct: on unpatched main a changed resource file is in serve's warm compile
key, so the next request recompiles and answers with the current content (R-606 `result.md`,
"resource file changed", `cached: false`, current resource named). It is correct but slow. The patch
(a) keeps the warm program and refreshes the resources (`cached: true`).

**`cached` prediction (read per request from the tap, §7):**
- (c): every request that is the FIRST after a mutant switch (the resource file changed) answers
  `cached: false`, i.e. recompiles per mutant.
- (a): those same requests answer `cached: true`; only the first request of each daemon, and any
  request after a source change, are `cached: false`.
- (b): the static selector changes SOURCE per mutant, so the first request after each switch is
  `cached: false` on (b) too.

**Why `killReproduced` is predicted on every kill, checked in the code (lethal/r586 `5eb544ef`):**
`AlRunnerBackend` declares `readonly killsMustReproduce = true` as a plain class field, for every
transport and selector mode. The orchestrator's covering loop calls `reproduceKill` at each kill
site whenever `args.backend.killsMustReproduce === true` (the `reproduce` closure in the covering
loop); a reproduced kill sets `MutantOutcome.killReproduced`, which the report carries as
`killReproduced: true`. `reproduceKill` re-activates the mutant before re-running the killer
(mandatory on `--server`), so on the resource legs the reproduction is itself a resource switch
after an unmutated confirmation: on (a) it is exactly the request a stale refresh would get wrong.
(R-586's alpha.2 reports carry no `killReproduced` because they predate R577's landing on that
path; that is not evidence against this prediction.)

**A known risk, stated in advance:** on alpha.3 every test of this slice was refused before the
first test (#5606, an `OnCompanyOpenCompleted` subscriber that writes the database). 93415c0bb is
later than alpha.3; whether it carries a fix for #5606 was not checked by running anything. If the
baseline is refused on a leg, that leg is a FINDING (§8, cause "baseline refused, #5606 suspected"),
every mutant is expected `error`, and the speed figures for it are reported but not compared.

## 7. The speed figures that will be REPORTED (named in advance, not targets)

For all three legs side by side:

1. **Wall time per leg (s):** `run-fixture.ts`'s `wall=` value on the first line of `<leg>.compare.txt`:
   from just before `runSession` starts to after `backend.close()` returns, rounded to seconds. It
   excludes the oracle comparison and the worktree setup.
2. **Serve requests:** the number of lines in `<leg>.serve-in.ndjson` whose `command` is `runTests`,
   over every daemon the leg started (summed). Also reported: the number of daemons started (the
   `serve` rows in `<leg>.shim.tsv`), and how many requests ended in a summary vs an `{"error"}` line.
3. **Median ms of a cached request:** over every `"type":"summary"` line in `<leg>.serve-out.ndjson`
   with `cached: true`, the median of `wallSeconds * 1000` (the daemon's own figure for that request;
   no client-side round trip is measured). "Cached" means exactly `cached: true` in that summary.
   Reported with its count n, and beside it the same median and n for `cached: false` summaries.

Requests and summaries are paired in order per daemon (the protocol answers one request at a time).
If the counts of `runTests` requests and of summaries + error lines per daemon disagree, results.md
says so and reports the summary-side figures only.

## 8. A per-mutant difference is a FINDING, not a block

These are upstream builds, one locally patched. A difference against the oracle does not block
anything and is not re-run away. Each is listed in results.md with:
- the leg; the mutant (`<batch>/<code>`, procedure, operator);
- what differs: verdict, killing test, or both (and `killReproduced` missing on a kill);
- the suspected cause, one of: the patch (a difference on (a) that is NOT on (c) and NOT on (b));
  upstream main itself (a difference also on (c) or (b)); the resource selector on serve (on (a) and
  (c) but not (b)); the static path (on (b) only); a refused baseline (#5606); not explained. A
  difference on (a) only is the one that matters most: it would mean the patch makes a resource
  switch answer stale on a real app.

No CDO source text goes into any log, results file, message or commit: names and line numbers only.
