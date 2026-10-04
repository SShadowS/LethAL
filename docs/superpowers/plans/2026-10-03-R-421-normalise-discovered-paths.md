# R-421: normalise discovered paths to `/` once, at discovery (plan)

Task: `/coord/tasks/R-421/task.md`. Item: `docs/roadmap/R421.md`. Lane `code`. Base: **origin/master
c0acf418** (R-418 merged, `IDENTITY_SCHEME = 6`). Offline only: no live gate, no `.al` edit.
Evidence: `/coord/handoff/R-421/measurements.md` (cited below as M-a1, M-b3, …). Once reviewed, the
orchestrator commits this file as `docs/superpowers/plans/2026-10-03-R-421-normalise-discovered-paths.md`.

**Revision r2** (2026-10-03). Answers `/coord/reviews/R-421-plan/claude-adversary-r1.md`. Sections
that changed are marked [r2]. Every file and line reference below was checked at c0acf418 with
`git show c0acf418:<path>`.

## Changes since r1 [r2]

1. **Existing pins break on Windows.** Accepted. §1(c) was wrong: master has a byte pin of
   instrumented output, five of them. `packages/runner/tests/fixture-emission.test.ts` pins each
   fixture's `mutant-manifest.json` in the `\` form (lines 40, 94, 107, 121, 138; all matched), and
   the R411 shim (lines 173-184: comment 173-176, code 177-184) rewrites `/` to `\\` only off
   win32. `layout-fixture.test.ts` (host() at line 121, comment 120) and
   `multiobject-fixture.test.ts` (host() at line 113, comment 112; plus line 123, which turns the
   itest table's `/` into `\`) do the same. Task 3a now
   re-records the five hashes in the `/` form (values measured, M-d), deletes the shim, drops
   host(), rewrites both EXPECTED_MUTANTS tables to `/`, and adds a both-forms leg. §1(c) corrected.
2. **Test discovery.** Accepted, in this task: new Task 1b normalises `discoverTests`
   (`discovery.ts` lines 155-169: readdir at 160, sort at 161, read at 165) and `readTestAppSources`
   (`testpage-scan.ts` lines 1975-1978) with the same helper, failing test first. Checked: a
   test's file is in no identity key and in no fingerprint (Task 1b gives the citations).
3. **A literal `\` in a Linux file name.** Accepted: new Task 1a refuses it BY NAME off win32,
   with a typed error that extends `Error` directly. The platform is injected as a parameter
   defaulting to `process.platform`, the existing pattern (`defaultAlToolPaths` in
   `publisher.ts`, lines 211-221).
4. **Test 6 exact text.** Accepted: test 6 now checks the error class and the WHOLE message with
   `toBe`, and the plan gives that message.
5. **Scheme number.** Task 3 writes `IDENTITY_SCHEME = 7` (ruled: R-421 is 7 and lands first,
   R-307 becomes 8). Every literal that moves is listed with its current line (all hold `6` at
   c0acf418). No `explain` bump (ruled: explain versions shape, not values).
6. **clear-ceiling is not silent.** Accepted. `clearCeilingFromCli` (`cli.ts` lines 4207-4228)
   prints `NOTHING WAS CLEARED`, lists the rows the tier holds and exits 1. Wording fixed in §1(b)
   and Task 2; `measurements.md` b3 has a dated correction note, not a rewrite. Task 2 stays: the
   command the refusal suggests can still never match an old `\` row.

**Problem.** `generateMutationSet` (`packages/runner/src/orchestrator.ts`) keeps the relative paths
its recursive `readdir` returns (or the snapshot's keys, which `readTargetSource` -> `targetAlFiles`
builds with `relative()`). On Windows those contain `\`. They become `InstrumentedFile.path`, every
`file` in the manifest and report, and the key of three sorts. A plain `.sort()` puts `\` (0x5C)
after uppercase letters and digits, and `/` (0x2F) before them.

**Measured on Linux by feeding `\`-separated paths into the real functions** (this simulates the
Windows input; nothing ran on Windows). The simulation is faithful: a `\`-keyed snapshot of
`fixtures/sandbox-data` gives manifest `b03f52f2…`, byte-exactly the pin recorded on the Windows host
(M-c). [r2] It also reproduces all five `\`-form pins in `fixture-emission.test.ts` byte for byte
(M-d).

## 1. Findings in brief

**(a) Orderings (M-a1, M-a2).**

| Ordering | Sort | `\` vs `/` on `src/Foo/A.al` vs `src/FooBar.al` |
|---|---|---|
| discovery `entries.sort()` | code unit | **differs** (`FooBar` first on Windows) |
| `assignMutantIds` (`schemata/src/ids.ts`) | code unit | **differs**: M0001-M0003 move between files |
| `planArtifacts` batch membership | discovery order | **differs** |
| `identityOrdinalsOf` (manifest, `file.localeCompare`) | ICU | same (fuzz: 0 of 87,990 pairs differ) |
| `report-fold.ts` final sort | `localeCompare` | same |
| `explain` `rankSurvivors` | code unit | differs (display order only) |

`src/foo/a.al` vs `src/foobar.al` and `src/Foo/A.al` vs `src/Foo.al` do not move: only a character
between 0x2F and 0x5C at the first difference swaps the order.

**Identity keys.** The key text has no path (`astHash|codeunitName|scope|operator|major[|ordinal]`).
But master numbers identity ordinals PER BATCH, so batch membership decides the ordinal. Measured
(M-a2): `src/Foo/A.Table.al` and `src/Foo0.Codeunit.al` both hold an object "Twin"; at
`maxGuardsPerBatch: 6` Linux puts them in one batch (Foo0's mutants get ordinal 1), Windows splits
them (ordinal 0). **So an identity key CAN move on Windows after this fix**: a subfolder project,
with batching, with identity twins across files. That needs an `IDENTITY_SCHEME` bump (section 3).
(On the R-307 branch, R374 numbers ordinals once per run with `localeCompare`, and the same shape
does not move; master does not have R374.)

**(b) Old Windows artifacts (M-b1 to M-b4).** Every cross-session reader keys on the identity key,
not the path: `--resume`/`--resume-run`, `--skip-known-survivors`, equivalence marks, itest
baselines, `campaign freeze`/`compare`. Paths are already normalised in globs, `--lines`, gap ids,
`hashSourceSnapshot`, `hashAlTree`, the installed-bundle digest and al-runner coverage. The keys
that can move (a) are refused BY NAME after the scheme bump by resume, skip-known-survivors and
marks. No committed campaign or example key moves (M-b2: no cross-file twins, no order change), and
no fixture has a subfolder, so no frozen gate can move. **One mismatch [r2: not silent]:**
`clear-ceiling --file` matches `publish_outcomes.file` exactly. An old row `src\Big\Big.Codeunit.al`
survives the very command the post-fix refusal prints (`--file "src/Big/Big.Codeunit.al"`): removed
0, ceiling unchanged (M-b3). The CLI does say so: `clearCeilingFromCli` (`cli.ts` 4207-4228) prints
`NOTHING WAS CLEARED`, lists the `\` row and exits 1 (M-b3 correction note). So nothing is silent,
but the command the tool tells the user to run can never work on that row. Task 2 fixes that.

**A trap (M-b5).** Normalising `rel` alone breaks Windows: `snapshot.get(rel)` would miss every
`\`-keyed snapshot entry and throw "not in the source snapshot". Reads must use the original key.

**(c) Pins and samples (M-c, M-d) [r2].** No test pins a committed REPORT's bytes or `file` values
(`schemas.test.ts` validates gift-card's against the schema; `agent-contract` and `verify` tests read
counts and texts). r1 said the only byte pin of instrumented output was R-307's
`per-file-refusal.test.ts`. **That was wrong.** Master pins five, all in the Windows `\` form:
`packages/runner/tests/fixture-emission.test.ts` hashes each fixture's `mutant-manifest.json`
(lines 40, 94, 107, 121, 138), and its R411 shim (lines 173-184) rewrites the product's `/` to `\\`
before hashing, but only when `process.platform !== "win32"`. After Task 1 Linux still passes (the
shim converts) while Windows, now writing `/`, fails all five. M-d measured it: a `\`-keyed snapshot
reproduces all five pins byte for byte; a `/`-keyed one gives today's Linux values. Two more tests
pin path TEXT the same way: `layout-fixture.test.ts` (EXPECTED_MUTANTS lines 30-39 in `\` form,
`host()` line 121) and `multiobject-fixture.test.ts` (EXPECTED_MUTANTS lines 38-49, `host()` line
113, and line 123 turns the itest table's `/` into `\`). Task 3 fixes all three files.
Not affected, checked: `baseline-guard.test.ts`'s R411 test (line 247) is about how a POSIX host
parses a gate-file path, not about discovery. `itest/harden-fixture.test.ts` (line 64),
`itest/verify-agreement.test.ts` and `itest/verify-scale.test.ts` write `\` paths into SYNTHETIC
reports as test data; they do not read discovery output, so the fix cannot change them, and they
keep showing that readers still accept the old form. They stay.

## 2. Tasks (TDD: each test written first and seen red on c0acf418, then the change)

### Task 1. Discovery normalises once, reads through the original key [r2]

**The one helper [r2].** All three discovery sites (this task, Task 1a, Task 1b) go through one new
function in `packages/runner/src/line-filter.ts`, next to `normalizeRelPath`:

```ts
/** R421: thrown when a discovered file name cannot be given one `/`-separated path. */
export class DiscoveredPathError extends Error {        // extends Error DIRECTLY (CLAUDE.md)
  constructor(message: string, readonly paths: readonly string[]) {
    super(message);
    this.name = "DiscoveredPathError";
  }
}
export function discoveredRelPaths(
  raw: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Array<{ rel: string; raw: string }>;
```

It returns each raw name with its `normalizeRelPath` form, sorted by `rel` with the plain code-unit
order discovery uses today (`a.rel < b.rel`). It throws on a collision (test 6 below) and, from Task
1a, on a literal `\` off win32. `platform` is injected as a defaulted parameter, the existing pattern
(`defaultAlToolPaths` in `publisher.ts` lines 211-221 explains why: a `process.platform` read inside
the body makes the other branch untestable). Callers pass their own `platform` option through.
`MutationSetOptions` (orchestrator.ts line 424) gains `readonly platform?: NodeJS.Platform`;
`runSession` passes nothing, so production uses `process.platform`.

**Tests first**, new file `packages/runner/tests/discovered-paths.test.ts`. Each builds a temp project
and calls `generateMutationSet(dir, { source })` twice: snapshot keyed with `/` (default platform),
and the same snapshot keyed with `\` with `platform: "win32"` (comment: "simulates Bun's readdir on
Windows"; [r2] the platform is needed because Task 1a refuses a `\` name on any other platform). AL
bodies as in M-a1 (`procedure Pick … if Value > 10 then exit(1); exit(0);`, three mutants per file).
These tests use snapshots only, so they run on every host.
1. **Subfolder order is pinned.** Files `src/Foo/A.Table.al` (table "Twin"), `src/FooBar.Codeunit.al`
   (codeunit "Twin"), `src/Zed.Codeunit.al`. For BOTH forms: `files.map(f => f.path)` equals
   `["src/Foo/A.Table.al", "src/FooBar.Codeunit.al", "src/Zed.Codeunit.al"]`, and no path contains
   `\`. Red on old: `\` form gives `src\FooBar…` first (M-a1).
2. **Manifest.** `writeInstrumentedProject` of form `\`: every `file` uses `/`; M0001-M0003 are in
   `src/Foo/A.Table.al`; the whole manifest equals the `/` form's byte for byte. Red on old.
3. **Batching keeps identity.** `src/Foo/A.Table.al` and `src/Foo0.Codeunit.al` ("Twin"),
   `src/FooBar.Codeunit.al` ("Other"), `planArtifacts(files, { maxGuardsPerBatch: 6 })`: in both forms
   the batches are `[[Foo/A, Foo0], [FooBar]]` and Foo0's three rows have `identityOrdinal` 1, so
   `serializeKey(identityKeyOf(m))` is equal per mutant. Red on old: ordinal 0 (M-a2).
4. **Control, green before and after** (says so in its name): `src/Foo/A.al` vs `src/Foo.al` and
   `src/foo/a.al` vs `src/foobar.al` give the same order in both forms (M-a1).
5. **sandbox-data, both forms.** `readTargetSource(fixtures/sandbox-data)`, re-keyed with `\`: the
   manifest sha256 is `b754095f8aebddf35074c5d032bdac8692076e3e9c1b015d6810bc0ec0ff588e`, the same as
   from the plain readdir (selector ids 60000/60001/60002, artifact id `0123…cdef`, target app id
   `aaaaaaaa-…`, as R-307's pin). This is the cross-platform byte pin on master; it runs on any OS.
   Red on old: `b03f52f2…` (M-c). It also catches the M-b5 trap.
6. **Collision refused by name [r2: exact text].** A snapshot holding both `src\A.Codeunit.al` and
   `src/A.Codeunit.al` (same AL in both), with `platform: "win32"` (on any other platform Task 1a's
   refusal of the `\` name would fire first). The test catches the rejection and asserts
   `expect(err).toBeInstanceOf(DiscoveredPathError)`, `expect(err.paths).toEqual(["src/A.Codeunit.al",
   "src\\A.Codeunit.al"])` and `expect(err.message).toBe(<the whole text>)`, where the text, as
   printed, is:

   `two discovered files have the same path once "\" is read as "/": "src/A.Codeunit.al" and "src\A.Codeunit.al". Refusing rather than reading one of them and dropping the other.`

   The two raw names are listed in plain code-unit order (`/` 0x2F sorts before `\` 0x5C). No
   substring or regex match: an unrelated error on the old code (a duplicate-object refusal, say)
   must not pass it. Red on old: the old code throws nothing for this pair (it accepts both).

**Change** (`generateMutationSet`, orchestrator.ts lines 716-718 and 764-776):

```ts
const listed = snapshot !== undefined ? [...snapshot.keys()] : await readdir(projectDir, { recursive: true });
const discovered = discoveredRelPaths(
  listed.filter((e) => isEnumeratedAl(normalizeRelPath(e))),
  options.platform,
);
const readKeyOf = new Map(discovered.map((d) => [d.rel, d.raw]));
const entries = discovered.map((d) => d.rel);
```

`isEnumeratedAl` sees the normalised name, so its `basename` check behaves the same on both
platforms. In pass 1 read with the RAW key (`snapshot.get(raw)` / `readFile(join(projectDir, raw))`,
`raw = readKeyOf.get(rel)`, throwing if it is missing) and keep `path: rel`. Everything downstream
(`--only`/`--exclude` sets, line filter, `declarativeSites`, `preprocExcluded`, `skipped`, manifest,
report) then sees `/`. Do not touch `targetAlFiles`: `prepareBatchProject` and `hashSourceSnapshot`
already cope with either form. Leave the now-redundant `replaceAll("\\", "/")` in
`admittedByOnly`/`excludedByPatterns` (harmless, and other callers may pass raw paths).
Not changed, checked: `scanProjectCodeunitIds` (`cli.ts` line 275) reads raw names but only returns
object ids; `readAlSources` (`line-map.ts` line 915) and the al-runner coverage readers are
self-consistent (review r1, "These hold").

**Red-check** (`mutation-red-checker`): replace the `normalizeRelPath` call inside
`discoveredRelPaths` by the identity; tests 1, 2, 3, 5 must go red (test 6 too: no collision is
seen). Restore; all green. Report both outputs.

### Task 1a. Refuse a literal `\` in a file name off Windows [r2, new]

**Why.** On Linux or macOS `\` is an ordinary file-name character. Normalising `src/a\b.Codeunit.al`
would record it as `src/a/b.Codeunit.al`, a path that does not exist. Worse, `writeInstrumentedProject`
writes the instrumented copy as `b.Codeunit.al` (its basename after normalising), while
`prepareBatchProject` (orchestrator.ts lines 7970-7987) takes `basename` of the RAW snapshot key,
`a\b.Codeunit.al`, finds no file of that name in the batch, and copies the original in as well. Two
copies of one object: the batch fails to compile and every mutant in it is lost. On win32 `\` is a
separator, so normalising is right there and nothing is refused.

**Test first** (in `discovered-paths.test.ts`):
7. **Refused by name off win32.** A snapshot with keys `src/a\b.Codeunit.al` and `src/Zed.Codeunit.al`,
   `platform: "linux"` passed explicitly (so the test means the same on every host). Assert
   `toBeInstanceOf(DiscoveredPathError)`, `err.paths` equal to `["src/a\\b.Codeunit.al"]` (JS
   source form), and `err.message` `toBe` exactly, as printed:

   `cannot use the file "src/a\b.Codeunit.al": its name contains a backslash. On linux a backslash is an ordinary file-name character, but LethAL writes every path with "/", so this file would be recorded as "src/a/b.Codeunit.al", which does not exist, and its batch would not compile. Rename the file.`

   (`linux` is the injected platform, interpolated.) Red on old: no error.
8. **The same snapshot with `platform: "win32"`** does not throw, and gives paths
   `["src/Zed.Codeunit.al", "src/a/b.Codeunit.al"]`. This is the win32 branch, run on every host.
9. **On a real POSIX disk** (`test.skipIf(process.platform === "win32")`, since Windows cannot create
   such a name): a temp project with a file literally named `src/a\b.Codeunit.al`,
   `generateMutationSet(dir)` with NO platform option rejects with the same class and text, with
   `linux` or `darwin` per host (the test builds the expected text from `process.platform`). This
   proves the default reaches the check. Red on old.

**Change:** in `discoveredRelPaths`, before normalising, if `platform !== "win32"` and
`raw.includes("\\")`, throw `DiscoveredPathError` with the text above and `paths: [raw]`. It is
checked before the collision check, so a POSIX `src\A` + `src/A` pair is refused for the backslash,
by name. Checked at c0acf418: no existing unit test feeds a `\`-keyed snapshot to
`generateMutationSet` (`git grep 'src\\\\' -- packages/*/tests` finds only expected-output tables
and `parseLineArg`/`gapIdOf` inputs), so nothing existing turns red.

**Red-check:** delete the refusal branch; tests 7 and 9 go red (the expected rejection never
comes: `generateMutationSet` returns the normalised `src/a/b.Codeunit.al`). Restore; green. Report
both.

### Task 1b. Test discovery normalises too [r2, new]

**Where `\` leaks today.** `discoverTests` (`discovery.ts` lines 155-169; readdir at line 160, the
`.sort()` at 161, reads at 165) passes the raw readdir name as `TestMethodRef.file` (via
`testsInAlSource(rel, …)`, line 147). That reaches the report's `testFiles`
(`report.ts` lines 2414-2417) and the folded `baselineTests[].file` (`report-fold.ts` lines 361-364,
from the `tests-discovered` event). `readTestAppSources` (`testpage-scan.ts` lines 1972-1980; readdir
at 1975) gives the raw name as each source's `path`, which becomes `Unit.file` in the test-app model
and appears in error messages.

**A test's file is in no identity key, checked at c0acf418.** The mutant key is
`identityTupleOf` (`packages/schemata/src/project.ts` lines 74-88:
`astHash|codeunitName|scope|operatorName|major`) plus the ordinal (`serializeKey`,
`packages/runner/src/selection.ts` lines 69-78). Tests are keyed by `testKeyOf`
(`selection.ts` lines 283-285: `codeunitId::method`). `sessionFingerprint` (`resume.ts` line 348
onward) holds `testDir` and the `testsOnly` patterns, never a test file. The test digests
(`test-digest.ts`) hash file TEXT (`fileHashes`, `testpage-scan.ts` lines 1885-1894), not names. One
indirect effect: file order sets the `#n` suffix of a `Proc.key` only when the same procedure key is
declared in two files (`testpage-scan.ts` lines 530-546); if a Windows subfolder order changes, such a
digest changes, which `verify` reads as "edited" and re-checks: the safe direction, per
`test-digest.ts`'s header. So Task 1b needs no scheme change of its own.

**Change:** `DiscoverOptions` (discovery.ts line 56) gains `readonly platform?: NodeJS.Platform`;
`readTestAppSources(testDir, platform = process.platform)`. Both build their list with
`discoveredRelPaths(entries.filter((e) => e.toLowerCase().endsWith(".al")), platform)`, match
`--tests-only` (`admittedTestFiles`) and label with `rel`, and read with `join(testDir, raw)`.
Callers of `readTestAppSources` (orchestrator.ts 4487, test-digest.ts 278, verify.ts 810,
testpage-scan.ts 1987) and of `discoverTests` (orchestrator.ts 4464, verify.ts 798) pass nothing.
The off-win32 `\` refusal applies here too, for one rule at every discovery site: the report would
otherwise name a test file that does not exist.

**Tests first** (`packages/runner/tests/discovery.test.ts` and `testpage-scan.test.ts`). The test
codeunit is one `Subtype = Test` codeunit with one `[Test] procedure T()`.
10. **POSIX host, win32 platform** (`test.skipIf(process.platform === "win32")`): a temp test dir
    holding a file literally named `Sub\T.Codeunit.al`. `discoverTests(dir, { platform: "win32" })`
    returns exactly one ref whose `file` is `Sub/T.Codeunit.al` (`toEqual` on the whole ref);
    `readTestAppSources(dir, "win32")` returns `[{ path: "Sub/T.Codeunit.al", text }]`; and
    `discoverTests(dir, { platform: "win32", only: ["Sub/**"] })` still admits it. This is how a
    Windows readdir result is simulated on Linux, the same way the measurements did. Red on old:
    `Sub\T.Codeunit.al`.
11. **POSIX host, default platform** (same skip): `discoverTests(dir)` and `readTestAppSources(dir)`
    reject with `DiscoveredPathError` and the exact Task 1a text for `Sub\T.Codeunit.al`. Red on old.
12. **Every host, a real subfolder** `Sub/T.Codeunit.al`: `file` is `Sub/T.Codeunit.al`. On Linux
    this is a CONTROL, green before and after (its name says so); on a Windows host it is the
    red-on-old case, since there readdir returns `Sub\T.Codeunit.al`.

**Red-check:** in `discoverTests` and in `readTestAppSources`, use `raw` where `rel` now goes; test
10 goes red (`Sub\T…`). Restore; green. Report both.

### Task 2. `clear-ceiling --file` matches either separator [r2: wording]

**Why [r2].** Not because the mismatch is silent: `clearCeilingFromCli` (`cli.ts` lines 4207-4228)
prints `NOTHING WAS CLEARED`, lists the rows the tier holds and exits 1. But the command LethAL's own
refusal prints after this fix names the file with `/`, so on a store holding a pre-fix Windows row it
can never succeed; the user must notice the `\` in the listed row and retype it.

**Test first** (`packages/runner/tests/publish-ceiling.test.ts`): with a real `ResultsStore`,
record `failed` at 900 guards for `src\Big\Big.Codeunit.al`, then `clearPublishCeiling(store, tier,
"src/Big/Big.Codeunit.al")`: one row removed and `knownCeiling` empty after. And the reverse (row `/`,
argument `\`). A third row for another file stays. Red on old: removed 0, ceiling 900 (M-b3).
**Change:** `clearPublishCeiling` filters on `normalizeRelPath(r.file) === normalizeRelPath(file)`;
`ResultsStore.deletePublishOutcomes` uses `WHERE tier = ? AND REPLACE(file, '\', '/') = ?` with the
normalised argument, so the existing "deleted vs identified" check still agrees.
**Red-check:** revert the two comparisons; the test goes red; restore.

### Task 3. One path form in the pins, and `IDENTITY_SCHEME` 7 (LAST code task) [r2]

Tasks 1 to 1b must not be merged without this task: after Task 1 Windows writes `/`, and the pins
below still expect `\` there (Linux keeps passing only through the R411 shim). Land it on the same
branch before the merge.

**3a. Pins in the `/` form [r2, review item 1].**

`packages/runner/tests/fixture-emission.test.ts`, at c0acf418. Replace each `mutant-manifest.json`
value (all five were matched at these lines; M-d):

| Fixture | Line | Current (`\` form, Windows capture) | New (`/` form) |
|---|---|---|---|
| sandbox-app | 40 | `5db0c7e3d16b31f2c66a9bdfc042a9acda228ee93bd79923d4db5a529e179b78` | `24960578e7b86f7ee0d6009295ec27c714ad429e6c82c717d2f1a36bf1be5641` |
| sandbox-data | 94 | `0ae3b2f7075846542c1d6d1acca2c90512120fa9c59501df905abf3aa700a308` | `90fa82e468b6c90a88a73bb74bf9e55c0c19cd56a07bcccdc8cbce976ca317ba` |
| sandbox-hang | 107 | `3d4d02389ce5a49d712dadac2d7eb1005cd86cefce79fd29509addcbe72efc8d` | `f7b49d85171168e3a2403e55ad69b077fc1ab6645ecf44492b7d9de2de1f86e6` |
| sandbox-harden | 121 | `3c3f0bdef04e0d952eaa8507c9c130e7e244e61493180df2cf098f010c2f73f9` | `71fe65be7ce4ae7a5e342f67b084fa48c92d7d241fcddb74ab18fa18b40094b4` |
| sandbox-coverage-probe | 138 | `a6d004e2ae6344d4361108568879dd8b96dfd95db6a946cf577182b911661a61` | `da594088aba11817ac3a5d78f17c931d82f1f30b506b17588cc7365e40cc63cc` |

Delete the R411 shim (lines 173-184: the comment and the `if (name === "mutant-manifest.json" &&
process.platform !== "win32")` block) and hash the bytes as read. Keep line 185's
`name.split("\\").join("/")` on the emitted NAME (harmless; the emitted names are flat). Update the
header comment (lines 9-19) to say the manifest pins were re-recorded for R421 in the one `/` form
every platform now writes, and give the old `\` values' first 8 hex digits so the history reads.

**What "re-record" means, and how it is checked.** On Linux, "re-record" is NOT "whatever the fixed
code prints". The new value must equal TODAY's Linux output, which M-d measured on unchanged c0acf418
(plain readdir and a `/`-keyed snapshot give the same hash). Two checks, both in the test file:
- the existing leg, `generateMutationSet(fixtureDir)`, must give the table's new value with no shim;
- **a new both-forms leg per fixture**: `readTargetSource(fixtureDir)` re-keyed with `\`, passed as
  `{ source, platform: "win32" }`, must give the SAME manifest hash. On Linux this is the simulated
  Windows input (M-d shows that input reproduces the old `\` pins byte for byte on c0acf418, so the
  simulation is faithful); on Windows it is the real form. One expected value, two input forms, any
  host. Red on old for the new leg: it gives the old `\` values.
Red-check: revert Task 1's `normalizeRelPath` call; the both-forms leg goes red for all five fixtures
(it reproduces the `\` pins), while the plain leg stays green on Linux. Restore.

`packages/runner/tests/layout-fixture.test.ts`: rewrite EXPECTED_MUTANTS (lines 30-39) with `src/`
instead of `src\\`; delete `host` (line 121) and its R411 comment (line 120); expect
`[["src/LayoutAlpha.Codeunit.al"], ["src/LayoutBeta.Codeunit.al"]]` and `EXPECTED_MUTANTS` directly;
drop `sep` from the `node:path` import (line 4) if nothing else uses it.

`packages/runner/tests/multiobject-fixture.test.ts`: the same for EXPECTED_MUTANTS (lines 38-49),
`host` (line 113), its comment (line 112) and the `sep` import (line 4); and at line 123 drop
`.replace(/\//g, "\\")`, so the itest table's own `/` paths (`itest/multiobject-fixture.ts` lines
28-29) are compared as they are.

In all three files the R411 comment becomes one line: "R411/R421: discovered paths are written in one
form, `/`, on every platform, so these pins hold everywhere." On Linux the layout and multiobject
tests are green before and after (they already produced `/`); on Windows they go from red after
Task 1 back to green.

**3b. `IDENTITY_SCHEME = 7` [r2, review item 5; ruled: R-421 is 7 and lands first, R-307 is 8].**
The rule (`project.ts` doc comment): bump for any change that can move an existing key for unchanged
AL source. Task 1 moves Windows keys in the M-a2 shape. Every literal that moves, each checked at
c0acf418 to hold `6` today, and confirmed by M-e (setting 7 fails exactly the five tests behind the
three test literals, nothing else):

| File | Line at c0acf418 | Change |
|---|---|---|
| `packages/schemata/src/project.ts` | 115 | `export const IDENTITY_SCHEME = 6;` -> `7`. Append to the doc comment (it ends at line 114): "7: R421, discovered paths are normalised to `/`, so on Windows a project with subfolders gets the file order, mutant ids and batches Linux gets, and with per-batch ordinals an identity twin in another file can change ordinal." |
| `CHANGELOG.md` | new entry beside line 117 (`**Identity scheme 6** (R418)`) | `**Identity scheme 7** (R421)`: what moves (as above), `lethal.equivalent.json` files need `"identityScheme": 7` after re-checking each mark, older-scheme history and resume are refused by name (R325). The scheme-6 entry stays as it is. |
| `docs/using-lethal-from-an-agent.md` | 532 | `{ "identityScheme": 6, … }` -> `7` |
| `fixtures/sandbox-harden/lethal.equivalent.json` | 2 | `"identityScheme": 6` -> `7` |
| `packages/runner/tests/resume.test.ts` | 460 (comment 452-459) | `PINNED` `b3f6072b…0c0e` -> `5c8357ec03b8f337e9b444a80a03be4f5a7bd021aee3a048079fe36804e00c4b` (M-e); add to the comment "It moved again for R421 (scheme 7); it was b3f6072b...0c0e under scheme 6." |
| `packages/runner/tests/__snapshots__/report-equality.test.ts.snap` | 58 | `"identityScheme": 6` -> `7`, by `bun test --update-snapshots packages/runner/tests/report-equality.test.ts` (the only snapshot that may change) |

No `explain` version bump (ruled: explain versions its shape, not its values). If master moves
before the merge, re-run `git grep -n -E 'IDENTITY_SCHEME = |"identityScheme": [0-9]|PINNED = '` and
`git log -S "IDENTITY_SCHEME"` on the new base to catch a literal added since.

### Task 4. Old artifacts and sample reports (no code)

- Committed Windows reports (M-b1: ten files under `docs/campaign/**` and `examples/credit-limit/`)
  are **not regenerated**: they are records of runs as made, no test pins their `file` text, their
  baselines hold identity keys only, and M-b2 shows none of their keys can move. Regenerating
  `docs/campaign` reports would need live, billed runs and buys nothing.
- `CHANGELOG.md`: one line: reports made on Windows before this version show `src\X.al`; from this
  version every platform writes `src/X.al`.
- Console samples `examples/gift-card/README.md:71-72` and `docs/releasing.md:302` show `src\…`;
  change them to `/` only if a test or the redaction script reads them (none does today): optional.

## 3. Pin re-record on R-307 and branching [r2: ruled]

**Ruling (orchestrator, r1 review round).** R-421 takes scheme 7 and lands on master first; R-307
renumbers to 8 when it merges master, moving the same literals again (Task 3b's table, with
`PINNED` recomputed under 8). The proposal below stands as the order of work.

**Proposal (r1, accepted).** Build R-421 on its own branch `lethal/r421` from origin/master c0acf418, in a separate
worktree (`/work/lethal-wt/r421`), so it merges to master without R-307. Then, on `lethal/lane-code`,
merge master (with R-421) and re-record R-307's pin in `per-file-refusal.test.ts` ONCE, deliberately,
from `b03f52f2…`/`e889a463…` to `b754095f…`/`9abd8f06…` (measured on Linux on both master and R-307's
head, M-c). Commit message names R421 and test 5 above as the cross-platform evidence. R-307 renumbers
its scheme after R-421's (the second to merge renumbers). R-307's reserved identity entries take `rel`
from discovery, so they are normalised for free; check the merge of `generateMutationSet` by hand
(it must keep `discoveredRelPaths`, the raw-key reads and the `platform` option). [r2] R-307's
`per-file-refusal.test.ts` pin should then also get Task 3a's both-forms leg (`\`-keyed snapshot with
`platform: "win32"`), so it too is checked in both forms on any host.

## 4. Final steps

1. `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun scripts/verify.ts` (no snapshot may
   change except the deliberate report-equality one from Task 3b). [r2] Nothing here runs on
   Windows; the both-forms legs (tests 1-3, 5, 6, 8, 10 and Task 3a's) are what stands in for a
   Windows run, and say so in the commit message.
2. `bunx biome check <touched files>` only.
3. `docs/roadmap/R421.md`: status `done (<commit>)`; body: the fix, the measured moves, and the
   re-record step left for R-307. Then `bun scripts/roadmap-index.ts` and commit `ROADMAP.md` with it.
4. Clean up any scratch worktree with `git worktree remove` (no `--force`).
