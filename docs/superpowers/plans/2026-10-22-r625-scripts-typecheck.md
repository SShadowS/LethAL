# R-625 plan r2: every tracked script is type-checked or excluded by name with a reason

## r2: the Opus plan review (`review-plan-opus.md`, ADOPT with fixes) applied. These OVERRIDE r1 below.

- **The blind spot is closed by measurement:** the reviewer built batch 1 in the REAL composite project (tsc 7.0.2);
  all six packages are composite and reached through runner; no new reference is needed; typecheck 1.24 → 1.26 s.
- **I1, I2, I3, and a rule:** a file that an admitted file imports, or that an admitted test runs, is admitted too.
  So `r216-classify-gained.ts` (imported by its test), `fixtures/r393/late-write.fixture.ts` (run by
  `snapshot-late-write.test.ts`) and `measure-peak.ts` (imported by its test; R329's tool) are ADMITTED.
  `operator-catalogue.ts` is the only unknown: read it; if unused, it and `lib/al-layout.ts` (then used only by its
  own test) go to the deletion list TOGETHER.
- **I4, the coverage test:** reuse `importable-scripts.test.ts`'s `execFileSync("git", ["ls-files", ...])`; read
  `tsconfig.json` with `Bun.JSONC.parse`; normalise every path to repo-relative with forward slashes (never
  `path.join`); "exists" means "in the `git ls-files` output"; assert a FLOOR (at least 200 tracked scripts, and
  `scripts/verify.ts` among them) so an empty listing cannot pass. Red-checks: a tracked script in neither list; one
  in both; an excluded entry not tracked; and the floor (an empty listing must go red).
- **M1:** `probe-grammar-crosscheck.test.ts` widens the EXPECTED array's type (`expect<(number | null)[]>([0, 1])`),
  not the value. **M2:** `itest-timeline.ts` reverse loop with `const w = out[i]; if (w !== undefined && ...)`.
  **M3:** the `r595-gap-map.ts` union cast, type-only.
- **M4:** `r161-emit-proof.ts` has a type-only fix (`const alcBin: string = alc` after its top-level null check) and
  three unit tests name it as the real proof: ADMIT it. Its r1 "behaviour-changing" label was wrong.
- **M5:** `scripts/tsconfig.json`'s header comment about `probe-continia-env.ts` points to the exclusion list.
- **M6:** the deletion list names every reference to each file (`automation-api-guard.test.ts`'s `ALLOWED` map for
  `probe-continia-env.ts`; `cdo-d1c-and-cost.sh` for `r586-probe/run-fixture.ts`; `r236-baseline-probe/probe.test.ts`
  for `r126-server-probe/probe.ts`). `r624-absent-status.ts` stays and is admitted (its log is cited).
- **M7:** the JSON list stands; each reason must be non-empty. **M8:** expected about 61 admitted, 63 excluded;
  the builder reports the exact numbers.
- Already-admitted spent probes (r236, r289, r514, r518, probe-r58) stay admitted.

Task R-625 (lane bugs, run 001). Base master b970d08c, branch `lethal/r625`, worktree `/work/lethal-wt/r625`.
Survey (measurement only): `/coord/handoff/R-625/survey.md`. 124 files outside `scripts/tsconfig.json` (R625's 123 +
`r624-absent-status.ts`); under the repo's strict flags 109 have 0 errors and 15 have 32 errors. Classes: live 23,
test 24, lib 8, spent-probe 67, unknown 2.

## Caveat the survey could not cover

The survey's scratch tsconfig dropped `composite` and the project references. The real `scripts/tsconfig.json` is
composite and references only `packages/runner` and `repro/nst-wedges`, so a script that imports another package's
source by relative path (engine, schemata, builtin-tier1, operator-sdk) can fail with TS6059/TS6307 there. So every
batch is measured in the REAL project before it lands; such a file needs a reference added (if the package is
composite) or stays out with that reason.

## The rule that closes R625 (and keeps it closed)

A committed list `scripts/typecheck-excluded.json`: `{ "<path>": "<reason>" }` for every tracked `scripts/**/*.ts`
that is NOT in `scripts/tsconfig.json` `files`. A new unit test, `scripts/typecheck-coverage.test.ts`:
- every tracked `scripts/**/*.ts` (`git ls-files`) is in exactly ONE of `files` or the excluded list;
- every excluded entry exists and has a non-empty reason;
- nothing is in both.

So a new script can no longer be silently outside: it must be admitted or excluded by name. Red-checked by adding a
tracked script to neither list, and by listing one in both.

## Batches

1. **Load-bearing: live + lib + test + unknown** (57 files). The 54 with 0 errors are admitted; the three with
   errors get type-only fixes:
   - `itest-timeline.ts`: `findLast` (ES2023) → a reverse loop; `lib` is NOT raised;
   - `r595-gap-map.ts`: the cast that collapses to `never`;
   - `probe-grammar-crosscheck.test.ts`: `number | null` passed as `number`, narrowed in the TEST.
   Each fix is checked to be type-only (same output on the same input); any that is not is listed for the
   orchestrator instead of landed. The two `unknown` files (`measure-peak.ts`, `operator-catalogue.ts`) are read
   first: used → admitted; unused → the deletion list.
2. **Spent probes (67): NOT admitted.** Typing a one-off probe makes every later API change break the build for a
   file nobody runs. Each is excluded with the reason `spent probe for R<n> (<status>)`, plus whether it is cited as
   evidence, from the survey. The ones that can never compile (`r214/pp.ts`, `r214/presence.ts` import a dead
   `H:/` path; `r165-probe/census.ts` imports a removed module; `probe-continia-env.ts` needs a non-dependency, R120)
   say so in their reason.
3. **The deletion list, for the orchestrator's ruling, not deleted here:** spent probes run by nothing and cited by
   nothing as evidence (from the survey; `r624-absent-status.ts` is NOT one: R624.md and servers.md cite its log and
   it stays, admitted with batch 1 if clean). Groups that import each other are listed together.
4. **Behaviour-changing fixes, listed, not made:** the spent-probe errors whose fix would add a throw or pick a value
   (`r159-aor-spike/compile-proof.ts`, `r161-emit-proof.ts`, `c0204b-live-probe.ts`, `r193-r197-baseline-proof.ts`,
   and the stale-name comparisons in `r174-ignore-methods-probe.ts`, `r159-aor-spike/aor.ts`). They stay excluded.

## Checks

typecheck (now covering ~57 more files), `bun scripts/verify.ts`, biome on touched files, the new coverage test
red-checked both ways, roadmap-index + line-citations, both CI jobs. No live run: nothing here changes behaviour.
R625 `done (<commit>)` with the excluded list as its evidence.
