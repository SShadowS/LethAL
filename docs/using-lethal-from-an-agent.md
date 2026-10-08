# Driving LethAL from an agent

Everything a program needs to run LethAL and read the result: the argv, the exit codes, which file
answers which question, and the six rules that stop a caller reaching a confident wrong
conclusion. Written for an autonomous consumer (an agent, a CI job, a script). A human should read
[`../README.md`](../README.md) instead.

There is a copyable skill next to this document at
[`../skills/lethal-mutation-testing/SKILL.md`](../skills/lethal-mutation-testing/SKILL.md). It is
the short operational form of this page; this page is the reference.

## What LethAL answers (guidance)

It breaks your AL code on purpose, one small change at a time, and runs your tests against each
break. A change your tests catch is **killed**. One they miss is a **survivor**. One no test even
executes is **no-coverage**. The share killed is the **mutation score**.

The question it answers is not "did this line run" but "would anyone notice if this line were
wrong". That is why its output needs the interpretation rules below: a survivor is a lead, not a
proven test-suite gap.

## Before anything else: `doctor` (checked)

```bash
lethal doctor --config lethal.config.json --json
```

The `--json` payload:

```json
{
  "doctorSchemaVersion": 1,
  "ok": false,
  "checks": [{ "name": "control-version", "ok": false, "detail": "…" }],
  "notChecked": ["publish-ceiling", "baseline-test-health"],
  "caveat": { "kind": "create-mode", "note": "…" }
}
```

`notChecked` is always `publish-ceiling` and `baseline-test-health`. `caveat` is present only for
a config shape that has one, and `caveat.kind` is `create-mode` or `al-runner-only`.

`--json` is accepted by `doctor` and `campaign` only. On any other subcommand it is refused rather than ignored, and `campaign` reads it only on `compare`.

### Doctor notes (guidance)

Read-only, takes seconds, checks every pre-flight refusal in one pass instead of letting a real run
discover them one at a time. Run it first. Exit `0` means every check passed, `1` means at least
one failed.

- `checks[].name` is what to branch on. `detail` is prose for a human.
- `notChecked` is the part that matters when doctor PASSES: those two are not covered by a green
  report, so a run can still refuse for either reason.
- `caveat` says which checks were skipped and why.

## Running (checked)

```bash
lethal run --project <app-dir> \
           --tests   <test-app-dir> \
           --backend bcdev \
           --config  lethal.config.json \
           --only       "src/Posting/**" \
           --tests-only "src/Posting/**" \
           --out        report.json \
           --progress-out events.ndjson
```

A run keeps its state in `<project>/lethal.sqlite` unless `--db` names another file.

An unscoped run on a real project is refused by default above 1,000 mutation sites.

A narrowed run carries `narrowed`, `operator-narrowed`, `line-narrowed` or `tests-narrowed` in
`validity.caveats`.

### Running notes (guidance)

**Scope it.** `--only <glob>` is an allow-list and `--exclude <glob>` its complement, applied after
it, so `--only "src/**" --exclude "src/Upgrade/**"` reads the way it sounds. Both are repeatable,
both select mutants rather than sources (every file is still parsed, compiled and published), and
both refuse a pattern that matches no file. The report records either narrowing and flags the run
`narrowed`, so a scoped score can never be mistaken for a project score.

**The database.** `lethal verify` reads the run's database, so give it that file, not a new one.

Durable exclusions belong in the config rather than the command line: a top-level
`"exclude": ["src/Upgrade/**"]` in `lethal.config.json` is UNIONED with any `--exclude` flag, never
replaced by one, so narrowing a run cannot silently re-enable mutation of code the project said to
leave alone.

The large-run refusal exists because an unscoped run costs days and usually cannot publish at all. `--allow-large-run` overrides the refusal
and does not make the run cheaper. Find the size first with `--dry-run`, which lists what would be
mutated, executes nothing, and reports both the raw site count and the deployed count.

**Know which flags can move a verdict.** `--only`, `--exclude`, `--operator`, `--lines` and
`--changed-since` select which
MUTANTS run and cannot change a verdict. `--tests-only` selects which TESTS run at baseline and CAN: exclude a
killing test and its mutant is reported survived. `--only` and `--exclude` give the `narrowed`
caveat, `--operator` gives `operator-narrowed`, `--lines` and `--changed-since` give `line-narrowed`,
and `--tests-only` gives `tests-narrowed`.

**Backends.** `bcdev` is authoritative. `al-runner` is offline and is NOT: its coverage is OFF by
default and CONDITIONAL when on. `lethal run` reads al-runner's own coverage output (R220) only with
`"alRunner": { "coverage": "al-runner" }`, and one file declaring more than one object or holding a
`#if`-wrapped object turns it off for the whole run, with a warning naming the file. (Multi-object:
upstream #3713 is fixed, but al-runner v2.12.0-main.c39ad5de reports later objects' lines in the
wrong frame, R383. `#if`: R298, pending R300.) Without coverage an unreached mutant comes back survived rather than no-coverage. That is one measured route to a false survivor. No measurement has shown a false kill from this backend, but none rules one out (a pinned platform-app directory holding a mismatched build is untested, R235). Do not quote a score from it. (Its `asserterror` DID
fail to fail a test in 2026-07; that was fixed upstream in v2 and the startup canary re-measures
it every session.)

**al-runner settings (R387).** The `alRunner` section accepts `alRunnerPath`, `packagesDir`,
`serverMode`, `selectorMode` and `coverage`, and refuses any other key by name. With none of the last
three set, `lethal run` uses `--server` (one daemon per worker) and the resource selector (one compile
per batch). `"serverMode": false` gives one process per test with the `"static"` selector (a recompile
per mutant), which is much slower. The run prints one `[lethal] al-runner settings:` line naming any
slow or unmeasured setting; until coverage is on by default it always names `coverage`. `lethal
doctor` checks the binary's version only, not the transport. Under `--server` a hung test becomes an
error after one suite deadline of at least 10 minutes, not a per-test timeout.

**Cost.** On `bcdev` a mutant's covering tests run in ONE call to the server (one per mutant, not
one per test), stopping at the first failure, so a survivor with forty covering tests costs one
round trip instead of forty. This needs LethAL Control 1.0.0.20 or newer on the server; an older
one is refused before any test runs. The report's `groupedCalls` says how many such calls were
made. Three flags touch it and you should not need them: `--max-methods-per-call <n>` caps one
call, `--request-ceiling-ms <n>` bounds one call (keep it under the hosting gateway's idle
timeout; the default is 300 s), and `--no-group-runs` goes back to one call per test. A
`--mutant-timeout-ms` above the ceiling minus 30 s makes every test run alone again, and the run
warns (`group-runs-inert`) when that happens.

### Which subcommand reads which flag (checked)

Every subcommand refuses a flag it does not read; none but the one exception below accepts one
and ignores it. "Read" means the parse stores it: a stored flag can still be overridden by a
precedence rule (`clear-ceiling --config` under an explicit `--server`/`--instance` pair, listed
in `cli.test.ts`).

The table lists only the flags an agent is most likely to reach for. A listed flag is refused
outside its listed owners, with a message naming the subcommands that do read it. `lethal --help`
has the complete set.

| flag | read by |
|---|---|
| `--project` | `run`, `init`, `clear-ceiling`, `force-reset-lease`, `doctor`, `explain`, `export`, `campaign` |
| `--tests` | `run`, `doctor`, `verify` |
| `--config` | `run`, `clear-ceiling`, `force-reset-lease`, `doctor`, `verify` |
| `--db` | `run`, `clear-ceiling`, `verify` |
| `--out` | `run`, `init`, `export` |
| `--progress-out` | `run` |
| `--json` | `doctor`, `campaign` |
| `--top` | `explain` |
| `--suggest` | `explain` |
| `--report` | `campaign` |
| `--only` | `run` |
| `--exclude` | `run` |
| `--tests-only` | `run` |
| `--operator` | `run` |
| `--artifact` | `verify` |
| `--survivors` | `verify` |
| `--max-new-tests` | `verify` |
| `--no-reach-filter` | `verify` |

`lethal run --dry-run` executes no tests, so it refuses every execution flag by name (`--tests`,
`--workers`, `--progress-out` and the rest: "has no effect with --dry-run"). `--backend` is
optional there and changes the listing. With `--backend al-runner` a dry run runs al-runner ONCE
to measure the preprocessor symbols it predefines (R392), needs `alRunner.alRunnerPath` in the
config and refuses without it, and lists the `#if` arms for the MEASURED set (absent lists alc's
build). The other
exception is `--out <file>`, which writes the dry-run listing as JSON:
`{files, sites, deployed, perFile[{file, sites, deployed}], batches[{index, sites[{file, line,
operator, deployed}]}], notInstrumented[{file, kinds, sites}]}`. `sites` counts raw mutation sites;
`deployed` counts what would ship.

#### Flag notes (guidance)

A stored flag can also go unused when the config makes it moot. `campaign` also refuses some of
its flags per verb: `--project` only on `anchors`, `--expect-mutants` only on `freeze`, `--json`
only on `compare`.

`lethal campaign compare --json` prints one object on stdout and its lines on stderr:
`{campaignCompareSchemaVersion, stage, baselinePath, mutantCount, identical, differences[],
coverage}`. Read `coverage` before `identical` (R355). `coverage.verified: true` carries the one
`coverageMode` both sides share. `coverage.verified: false` means the stage was frozen before R355
(its baseline records no mode) or the report predates R252, and it always carries
`stageCoverageMode`, `reportCoverageMode` (`null` where unrecorded) and a `statement`: a matching
`no-coverage` or `survived` verdict then proves nothing across coverage modes. Two recorded modes
that differ never produce a document; compare refuses and exits 1 with both modes named.

### Traps (checked)

Commands that look right and are refused. Each one below is run by a test and must be refused.
The `instead` column is guidance.

| command | instead |
|---|---|
| `lethal run --project app --tests tests --backend bcdev --report r.json` | `run` writes its report with `--out`. |
| `lethal explain report.json --out e.json` | `explain` prints on stdout; redirect it: `lethal explain report.json > e.json`. |
| `lethal verify --db app/lethal.sqlite --artifact 0123456789abcdef0123456789abcdef --survivors 0/M0004 --tests tests --out v.json` | `verify` prints on stdout; redirect it. |

### Exit codes (checked)

| Code | Meaning |
|---|---|
| `0` | The run completed. This says nothing about whether mutants survived. |
| `1` | Error, including an argv the parse refuses. The message is on stderr. |
| `3` | **Quarantined.** The run refused to vouch for its own verdicts. |
| `4` | **Nothing scored.** Every mutant errored; the run measured nothing. |

`4` is returned when `validity.caveats` carries `all-errors`. When a run is both quarantined and
scored nothing, `3` wins.

#### Exit code notes (guidance)

An exit `1` means the run did not produce a result you can use.

`3` is the one to handle deliberately. It does not mean the tests failed, and the verdicts it
produced must not be reported as findings. It means LethAL could not prove the server was in a
state where its answers mean anything. `--resume` continues such a run once the cause is fixed.

On bcdev a resumed run scans the test app again before it sends anything. A test the scan refuses
(it has a reachable call that may open a TestPage) is reported in `testPageRefused` as refused and
is never sent, even if the saved run recorded it green or recorded BC's own TestPage refusal. A
saved mutant verdict that such a test took part in (it killed the mutant, or it was among the
tests the mutant ran against) is not carried: the resumed run scores that mutant again without the
test, and says so in a `resume-testpage-rescored` warning.

A file LethAL cannot instrument is refused whole and published unchanged (R307). The run goes on
with the other files, so the score does not cover the refused file's sites: `reliability` is
`narrowed` (or `narrowed-degraded`), `validity.caveats` carries `files-refused`,
`scoreDescribes` says "N file(s) refused, M site(s) not mutated", the
`instrumentation-refused-files` warning names each file, and `excludedSites` has one row per file
with reason `instrumentation-refused` and the cause in `detail`. When every file with mutation sites
is refused, nothing is left to measure and the run exits `1`, naming each file. When it was refused
because no object name could be read from it, a mutant elsewhere that matches one of its sites
apart from the object name could hold a key an earlier run gave that file. For that run such a
mutant is not skipped by `--skip-known-survivors`, not carried by `--resume` or `--resume-run`, and
takes no equivalence mark (a mark on its key reads stale). The `identity-carry-disabled` warning
names the file and the count, and the refused file's row says "identity carry disabled for N
mutant(s)". Its key is still recorded, so the next run without the refusal carries it normally.

Every such refusal is decided in PLAN, the first of the two steps LethAL uses to instrument a file
(PLAN decides what to change; EMIT writes the new text). So a `--dry-run` sees every refusal a real
run would, with one exception: the latch-owner and no-anchor refusals can first fire when the
writer re-instruments a smaller batch of a file's mutants (see R419). EMIT can fail in one named way only: a RangeError "Invalid string length", when a file's
instrumented text is too large for one string. That is a real-run crash a dry run does not see (it
is the one entry in `EMIT_CRASHES`).

`4` means the report exists but holds no verdict: every recorded mutant is an `error` and the score
is `null`. The cause is in the mutants' `failureNote` (the one measured case was an instrumented
build the compiler refused). Fix that and re-run; there is nothing to `--resume`.

A non-zero exit is never "the test suite is bad". Mutation results live in the report, not the exit
code.

## Reading the result (checked)

Each surface below is versioned separately and has a published JSON Schema in [`../schemas/`](../schemas/):

- the report: [../schemas/report-v3.schema.json](../schemas/report-v3.schema.json)
- `lethal explain`: [../schemas/explain-v13.schema.json](../schemas/explain-v13.schema.json)
- the event stream: [../schemas/stream-v1.schema.json](../schemas/stream-v1.schema.json)
- `lethal doctor --json`: [../schemas/doctor-v1.schema.json](../schemas/doctor-v1.schema.json)

**A real report is committed, so you can try this with no server at all:**

```bash
lethal explain docs/campaign/2026-08-16-gift-card/rehearsal.report.json --top 10
```

It is the gift card demo's rehearsal run: 60 mutants, 34 killed, 15 survived, 11 no-coverage.

### Result notes (guidance)

Validate against the schemas rather than trusting a shape you inferred from one example. Two
caveats that [`../schemas/README.md`](../schemas/README.md) spells out: the stream schema describes
an EVENT line, not the header the sink writes first, and the report schema describes the shape the
current build writes, so an archived report of the same version can lack a now-required property.

The gift card report is kept unredacted because that app is ours. Every other committed report has
its source stripped; see `scripts/redact-first-party-reports.json` for the rule and how it is
enforced.

### `--out report.json`: the record (checked)

`schemaVersion: 3`. The top level carries `counts`, `mutationScore`, `validity` and `mutants`.
`validity` carries `reliability`, `scoreDescribes` and `caveats`. `coverageMode` names the coverage
mode the run used; a report written before it existed has none.

#### Report notes (guidance)

The report is the full result: every mutant with its verdict, location, operator, covering tests
and coverage attribution. This is the artifact to archive.

Mutant codes restart in every batch, so a code alone names a mutant only together with its
`batchIndex`. The run-level lists therefore name each mutant as `<batchIndex>/<mutantCode>`, the
same id `lethal verify --survivors` takes, and a reader-mark entry carries `batchIndex` beside its
code.

**Read `validity` before quoting `mutationScore`.** `validity.reliability`,
`validity.scoreDescribes` and `validity.caveats` say what the number covers. A score from a
narrowed run describes the slice, not the project. A run whose baseline was red could not score
some mutants at all, and they read `no-coverage` rather than `survived`.

### `lethal explain report.json`: what it MEANS (checked)

`explainSchemaVersion: 13`. The top level carries `contract`, `score`, `survivors`, `notMeasured`,
`survivorSelection` and `markIdentityScheme`. Each `survivors` row carries `executionProven`,
`reach` and `markKey`. The top level can also carry `markKeysStale`. Each `survivors` row can
also carry `mark`. Explain writes it for a report that records its numbering facts.

A report whose schema version is anything other than 2 or 3, or that holds a value this build
cannot interpret, is REFUSED rather than explained with the unrecognised value dropped.

When the report says coverage was off (its coverage mode is "none"), no coverage was collected, so
a survivor has `attribution: "not-measured"`: coverage not measured, neither covered nor uncovered.
Its `executionProven` is false, and its `reach` is decided only by the mutant's own measured reach.
A survivor with no attribution under any other mode is refused. A report written before the
coverage mode was recorded is refused too, and the refusal says so: re-run with this LethAL to
explain it.

`--top <n>` caps the survivor list:

```bash
lethal explain report.json --top 15
```

The top level carries `survivorSelection` whether or not anything was capped:

```json
"survivorSelection": { "total": 125, "shown": 15, "omitted": 110, "rankedBy": "actionability" }
```

`rankedBy` is `report-order` when no cap was applied and `actionability` when one was. `--top 0` is
refused.

The top level can also carry `gaps` and `noCoverageBlocks`. Both are present exactly when the
report's rows have gap ids, and absent on an older report. A gap block is the innermost branch body
holding a mutant, and one `gaps` entry lists one block with at least one survivor. Each `gaps` row
carries `gapId`, `batchIndex`, `members`, `survived`, `killed`, `noCoverage` and `other`. `members`
lists the block's survivors only; the four counts cover every recorded mutant of the block. Each
`gaps` row can also carry `unobservedBlock`, `artifactId` and `artifactIdAbsent`.
`unobservedBlock` says whether every RECORDED mutant of the block survived. It speaks about the
mutants the run recorded, not ones it never generated, and it is absent on a run narrowed with
`--operator`, `--lines` or `--changed-since`, which can drop mutants inside a block, and on a
quarantined run, which stops scheduling mutants mid-run. It is also absent for every gap in a file
the source report lists as hang-refused among its excluded sites (R447): there a loop's own step was
refused and never generated, so "every recorded mutant survived" would overstate what was measured.
Each gap has
exactly one of `artifactId` (the artifact to verify it against) and `artifactIdAbsent` (why there
is none, with the same values as on a survivor row; a gap is `carried` when any of its members is).
`--top` never shortens `gaps`: every gap is listed, even one none of whose survivors is shown.

`--project <dir>` adds each gap's source (R274):

```
lethal explain report.json --project <dir>
```

Each `gaps` row can also carry `coveringTests` and `reachMeasuredMembers` (R272), on a report that
records testMethods. `coveringTests` lists every test covering one of the gap's survivors, each
with `name`, and where known `file`, `line` (the 1-based line of the method's name),
`reachedMembers` (how many of the gap's survivors that test reached) and `baselineDurationMs` (its
smallest baseline duration from this run's completed baseline batches, so a batch whose baseline
aborted adds nothing: al-runner's own per-test figure, or on bcdev the
per-test call's wall clock, which is mostly call overhead, and a session's first call also pays
the client's startup). `reachMeasuredMembers` is how many survivors had a
measured reach, the denominator of `reachedMembers`. A test discovered at two places (two #if
arms) has `lineAmbiguous` instead of a line. The order is a stated heuristic, not a measurement:
most survivors reached first, then by name. Duration is shown, never used to order (R489). Without
testMethods (an older report) the field is absent, which never means "no covering tests". On a run
whose coverage is object-level or not measured, a gap's list can be the whole suite.

Each `gaps` row can also carry `source`. Given `--project`, it holds `startLine` (the gap's `blockStartLine`),
`lines` (the block's lines, split on LF, with one trailing CR dropped per line) and `marks`, one per
member in `members` order, each `{ mutantCode, startLine, startColumn, endLine, endColumn }`. Lines and
columns start at 1; a column counts UTF-16 code units (a tab is one), and the end is exclusive, so a
site can span lines. Explain first hashes `<dir>` the way the run hashed its source (every .al
file the target build compiles plus app.json, raw bytes, with the config's preprocessor symbols)
and compares that with the report's sourceSha256. Any difference refuses by name (a
ProjectSourceRefusedError, reason source-mismatch) with nothing on stdout: a CRLF/LF checkout
difference, an app.json version bump, a changed preprocessor symbol or an edit to a test project
nested inside the target all count. A report from before R274 has no sourceSha256 and refuses with
reason no-source-hash. The output then holds TARGET SOURCE: do not publish it for a third party's
code.

`--suggest` adds a suggested fix kind per gap (R273), in its own section:

```
lethal explain report.json --suggest
```

The top level can also carry `suggestions`. It is a SUGGESTION, not a measurement, and it sits
outside the measured projection: everything else in the output is the same with or without the
flag. Each kind is derived only from a survivor's measured `reach` and coverage `attribution`.
The kinds:

| reach | attribution | kind |
|---|---|---|
| reached-unnoticed | any | check-the-result: the statement ran under a covering test and every covering test still passed |
| covered-but-unreached | exact | cover-the-branch: a test enters the procedure, but the statement did not run in this mutant's runs (or it is unreachable) |
| unreached-and-uncovered | object, all-green | cover-the-statement: it did not run in this mutant's runs, and entry to its procedure was not measured |
| not-decided | any | undecided: the report cannot tell |

A survivor a reader already marked is `reader-marked`. A gap takes its members' kind when they
agree, else `mixed`; it lists every member of the matching `gaps` entry, in the same order. The
section covers the recorded survivors only (on a narrowed run, not the whole block), and no-coverage
blocks are outside it. On a report without gap ids, `--suggest` refuses with nothing on stdout.

`noCoverageBlocks` lists the no-coverage mutants by block. It is a location list, not a verify
input: an entry has no gap id and no counts.

Each `survivors` row can also carry `gapId`, the gap it belongs to.

#### Explain notes (guidance)

`explain` reads that file and nothing else: no server, no database, no config. It prints JSON on
stdout. On stderr it prints each survivor's mark key under that survivor, for a human; the JSON has
the same keys.

Its own `contract` block states the split: **structure is contractual, prose is not.** Field names,
nesting and value domains are stable under `explainSchemaVersion`. Do not parse `meaning` text;
every machine-usable fact is already a field.

The field that decides what a survivor is worth is `executionProven`. It is `true` only for an
exact, member-level coverage match, meaning a test is measured to have executed the mutated
procedure. `false` means some test touched the object and no test is measured to have run the
mutated code, so the survivor may be no finding at all. `reach` adds what the coverage signal and
the mutant run's own guard attestation say together: `covered-but-unreached` is a test that enters
the procedure and never reaches the statement. Where the report measured the mutant's own statement
(`reachGrain: "statement"`), `reach` is decided by that instead: `reached-unnoticed` means the
statement ran under the tests listed in `reachedBy` and every one still passed.

**Bound the output.** The projection of a 473-mutant report is 243 KB, 206 KB of it survivors. Read
`total` before treating `survivors` as the whole set. The `actionability` ranking keeps the rows
carrying the most evidence and is a total order, so the same report and the same cap give the same
rows every time. The cap bounds survivors only; `notMeasured` is never shortened.

### `--progress-out events.ndjson`: following a live run (checked)

`streamSchemaVersion: 1`. Line 1 is a header this sink writes itself, with `ndjsonHeader: true`.
Every later line is an event. Every event carries `seq` and `type`. The `stream-started` event
carries `runId`. The `type` values include `session-finished` and `batch-invalidated`.

#### Stream notes (guidance)

One JSON object per line, flushed as each event arrives, so a killed process still leaves a
readable file.

**Every verdict line is PROVISIONAL until `session-finished` appears.** A `batch-invalidated` event
can supersede a verdict already written to the file: a lease loss, or a deploy that turns out
unsound, sends its batch round again. Acting on a `survived` line that a later event retracts means
acting on a fact the run itself no longer stands behind.

Unknown event types are ignored by design, so a future event type does not break a consumer.

## The hardening loop (guidance)

The loop that turns a survivor into a killed mutant: `lethal run`, `lethal explain`, write a test
that should kill a survivor, `lethal verify`, and repeat until verify exits `0`. Then a fresh
`lethal run` makes the record. LethAL never writes the test; you do.

### From an explain row to a verify command (checked)

The three values verify needs come from one `explain` survivor row: `artifactId`, `batchIndex` and
`mutantCode`. The command, with `<project>` the run's `--project`, `<config>` the run's `--config`
and `<tests-dir>` the test project you edited:

```bash
lethal verify --db <project>/lethal.sqlite --artifact <artifactId> --survivors <batchIndex>/<mutantCode> --tests <tests-dir> --config <config>
```

A filled-in example, for the run shown under Running with `<app-dir>` as `app` and
`<test-app-dir>` as `tests`:

```bash
lethal verify --db app/lethal.sqlite --artifact 0123456789abcdef0123456789abcdef --survivors 0/M0004 --tests tests --config lethal.config.json
```

`--db` is the database the run wrote: the run's own `--db`, or its default. `--config` is the
config the run used, as the run was given it. `--tests` is the run's test project.

A row with no `artifactId` has `artifactIdAbsent` instead. The values are checked; the meanings
are guidance.

| artifactIdAbsent | what it means for verify |
|---|---|
| `carried` | The verdict was carried from an earlier run, so nothing of it is installed. Run a fresh `lethal run`. |
| `not-recorded` | The report predates artifact ids. Run again. |
| `not-published` | The backend published nothing for that batch. Verify cannot help. |

### From an explain gap to a verify command (checked)

One verify call can prove a whole gap: name the gap id instead of the mutant ids. Take both
`<artifactId>` and `<gapId>` from the same `gaps[]` entry, never the artifact from a survivor row:

```bash
lethal verify --db <project>/lethal.sqlite --artifact <artifactId> --survivors <gapId> --tests <tests-dir> --config <config>
```

A filled-in example, for the same run:

```bash
lethal verify --db app/lethal.sqlite --artifact 0123456789abcdef0123456789abcdef --survivors G0123456789ab --tests tests --config lethal.config.json
```

Verify replaces the gap id by the block's survivors and runs each of them. A gap with no
`artifactId` has `artifactIdAbsent`, with the meanings in the table above.

#### Gap notes (guidance)

An edited or moved block gets a new gap id, so an id from an older `explain` is refused as
`unknown-gap`. A checkout with other line endings (CRLF against LF) also gives new gap ids.

#### Recipe notes (guidance)

Without `--config` verify reads `<project>/lethal.config.json`, which is a different file whenever
the run's config lived elsewhere. Only the LAST batch a run published stays installed on the
server, so a survivor from an earlier batch is refused as `batch-not-installed`.

### Running verify (guidance)

Verify works on `bcdev` only. It prints one JSON object on stdout and its progress on stderr. The
ids are checked when verify runs, not when the argv is parsed, so a wrong id is exit `6` with
`malformed-request` rather than a usage error (exit `1`). Each call that runs at least one survivor
publishes the test app once. **The test project IS published, and it stays installed afterwards**:
verify does not put back the one that was there before. A refused or all-skipped call publishes
nothing.

### Reading a verify result (checked)

`verifySchemaVersion: 8`. Schema: [../schemas/verify-v8.schema.json](../schemas/verify-v8.schema.json).

| field | values |
|---|---|
| `results[].verdict` | `killed`, `survived`, `error`, `skipped` |
| `newTests[].state` | `stable`, `flaky`, `red`, `flaky-unknown`, `infra-error`, `not-rerun` |
| `newTests[].runs[].outcome` | `pass`, `fail`, `skip`, `timeout`, `deadline-exceeded`, `error`, `not-run` |
| `results[].killedBy` | `assertion`, `runtime-error`, `other` |
| `reachFilter.state` | `on`, `off` |
| `reachFilter.reason` | `no-reach-filter`, `coverage-mode-none`, `coverage-mode-procedure`, `coverage-mode-line`, `coverage-mode-al-runner` |

`killedBy` never changes the exit code. Each `results` row can also carry `killedByNewTest`,
`invalidBaseline`, `gapId` and `sameProcedure`.
Every result names its `gapId`, whether the survivor was named directly or through a gap; only a
run whose build predates gap ids leaves it out.

#### Verify result notes (guidance)

A kill by a runtime error is still a kill, and says only that no assertion caught it.
`killedByNewTest` says whether the killing test is one your edit added. A row's `invalidBaseline`
lists the requested tests that had no fresh green unmutated run. Verify then does not run the mutant at all:
that survivor's row is `error`. Fix those tests (they must pass unmutated, in a fresh session) and
run verify again. If the test's state is `infra-error`, read both runs before editing it (below).

`infra-error` means at least one of the new test's two unmutated runs failed for infrastructure
reasons (its `runs[].outcome` is `error` or `deadline-exceeded`: the call failed, not the test).
Read both runs' `outcome` and `fresh` before concluding anything about the test: the other run may
still be evidence, for example a fresh `fail`. Then run verify again, and run `lethal doctor` if it
repeats. It blocks exit `0` like every state other than `stable` and `not-rerun`.

`not-rerun` (schema v6, R-427) means the reach filter sent the new test to no survivor, so verify
ran it once, unmutated, and did not rerun it. That one run passed in a fresh session; `runs` holds
just it. Its stability is unknown: it is never `stable`, and a test that is flaky but reaches no
survivor is not caught in this verify. It is caught when a later verify sends it to a survivor,
because then it is rerun. It does not block exit `0`, because it gated no verdict: it is in no
row's `testsRun` and killed nothing.

`sameProcedure` (schema v8, R259) is on every row killed by a new test, and on no other row. It
says what is known about that test (`sameProcedure.test`) against each OTHER survived or no-coverage
mutant of the source run in the same procedure or trigger (the same line span in the manifest).
Verify runs the test once more against each one it has no answer for yet, after the named survivors
and inside the same lease. These extra runs count against `--max-new-tests` with the rest, two per
mutant (the run, and the unmutated rerun a kill needs).
`alsoKills`, the only claim about the test on its own: the test ran first, in a fresh session,
against that mutant, failed, and passed when rerun unmutated. `notKilled`: that mutant survived a
run that included the test, possibly with other tests. `unknown`: no answer
(an error, a timeout, a session that latched or lost its lease, a carried or reader-marked
equivalent mutant, a procedure written on one line, or over the cap; `overCap` counts the last
kind). Read `unknown` as unknown, never as not killed. A long `alsoKills` list suggests the test is
broad rather than aimed at the survivor you named. The field never changes `results` or `counts`.
It does not change the exit code either, with one exception, by design: a probe that latches (a
timeout, or an in-flight call whose outcome is unknown) quarantines the whole call, so verify
exits `3`.

### Verify exit codes (checked)

| code | meaning |
|---|---|
| `0` | Every named survivor was killed and every new test is `stable` or `not-rerun`. Also returned when every survivor skipped, which measured nothing. Skipped rows are left out: some killed and the rest skipped is `0`. |
| `1` | An error, including an argv verify refuses (a missing flag, the `--out` trap). The message is on stderr and there is no JSON. |
| `3` | **Quarantined**, including the test-app outcomes `publish-indeterminate` and `publish-anomalous`. |
| `4` | Every non-skipped survivor is `error`: verify measured nothing. |
| `5` | Not every named survivor was killed, or a new test is neither `stable` nor `not-rerun`. |
| `6` | Refused before measuring; `refused.reason` says why. |

When several apply, the first in this order wins. Precedence: `3`, `6`, `4`, `5`, `0`.

#### Verify exit code notes (guidance)

`publish-indeterminate` and `publish-anomalous` leave the container needing a recycle.

### Verify refusals (checked)

The set of reasons is checked; the advice is guidance.

| reason | what to do |
|---|---|
| `malformed-request` | Fix the argv: a 32-character lowercase hex `--artifact` and `<batchIndex>/<mutantCode>` or gap ids. |
| `unknown-artifact` | Pass the run's `--db` and the `artifactId` from explain. |
| `batch-not-installed` | Only the last batch is installed. Run the slice in one batch. |
| `wrong-batch` | Take the artifact and the id from the same explain row. |
| `unknown-mutant` | Re-copy the mutant code from explain. |
| `unknown-gap` | Copy the gap id and its `artifactId` from one explain gap of the run that published this artifact. An edited or moved block, or other line endings, give a new id, and only the run's last batch stays installed. |
| `gap-has-no-survivor` | Every recorded mutant in this block is killed, not measured or no-coverage; there is nothing to verify as a gap. |
| `not-a-survivor` | That mutant was not a survivor. Drop the id. If it is a known survivor the run skipped, run again without `--skip-known-survivors`. |
| `carried` | The verdict was carried, so nothing of it is installed. Run a fresh `lethal run`. |
| `source-predates-verify` | Run `lethal run` again: the run predates verify, stopped early, or its source changed while it ran. A gap id against an artifact whose manifest was written before gap ids existed refuses this way too; name its mutants as `<batchIndex>/<mutantCode>` ids instead, or run again. |
| `source-changed` | The target changed since it was instrumented. Run again. |
| `test-project-nested` | The `--tests` folder lies inside the target project, contains it, or cannot be resolved (R-260). The target build compiles every `.al` under its folder, so nested tests are part of the installed target app. Move the test project out of the target folder so it sits beside it, update the `--tests` you pass to both `lethal run` and `lethal verify` to that folder (no config field names the test folder), run `lethal run` again, then verify with its artifact id. Since R445 `lethal run` refuses the same layout by name (`test-project-nested`) before it builds anything; `lethal run --dry-run` takes no `--tests` and lists a nested project's test files as mutants. |
| `covering-test-unmatched` | A covering test was renamed, renumbered or removed. Restore it, or run again. |
| `no-tests-to-run` | Write a test first. |
| `unsupported-config` | Verify runs on `bcdev` only, with no `envTool`. |
| `project-unreadable` | The run's project path does not resolve from here. It is stored as `lethal run` was given it: run verify from the same directory, or run `lethal run` again. |
| `equivalence-marks-unreadable` | Fix `lethal.equivalent.json`. |
| `stale-artifact` | Another run published since. Run again and use the new artifact id. |
| `artifact-files-unusable` | The run's local build files are gone or changed. Run again. |
| `artifact-identity-unavailable` | The server could not say what is installed. Run `lethal doctor`. |
| `test-app-manifest-unreadable` | Fix the test project's `app.json`. |
| `test-app-symbols-unreadable` | Fix the test project's `.alpackages`, or the control app symbol file the config names. |
| `test-app-compile-failed` | Fix the test AL; the detail has the compiler errors. |
| `test-app-version-below-resident` | Raise the test app's version above the installed one. |
| `test-app-publish-failed` | Read the detail. |
| `test-app-resident-unreadable` | Check the dev credentials with `lethal doctor`. It can also mean the test app was never published. |
| `coverage-mode-changed` | The source run was measured under another coverage mode, or before runs recorded one (R354), so its covering tests and verdicts do not apply. Run `lethal run` again under this configuration, then verify with its artifact id. |
| `too-many-new-tests` | The new or edited tests need more extra test runs than the budget, `--max-new-tests` (default 50) x (survivors + 2). With the reach filter off this is the old rule, more new tests than `--max-new-tests`. With it on, verify refuses before the lease when the one unmutated run per new test alone exceeds the budget, and otherwise after those unmutated runs, before any mutant, when the runs left after the filter still do (a second unmutated run per new test sent to a survivor, plus one run per survivor a new test joins); the detail then says the unmutated runs had already run. The detail names the count, the runs with and without the filter, the exact value to pass, what made the tests new (a subscriber, an object, the whole-source fallback, a procedure, a dependency) and up to five changed procedures. Pass `--max-new-tests <n>` to pay for them, or run `lethal run` again so this source is the recorded one. |
| `dependency-unreadable` | A dependency's package on the server could not be read, or did not check out (R385): a Microsoft package in the closure, `System`, or the `LethAL Control` package (which must be the version the running control app reports) was not served or was another app, or an app in the closure (any publisher since R496) has no installed version, two, or one that differs from the package served (an upgrade in progress). The detail names the app and its served and installed versions. Check the dev credentials with `lethal doctor`, and that every dependency of the test app is installed. |

### Marking an equivalent survivor (checked)

Mark an equivalent survivor in `<project>/lethal.equivalent.json`:

```json
{
  "identityScheme": 32,
  "marks": [
    {
      "key": "...",
      "reason": "...",
      "file": "src/Foo.Codeunit.al",
      "numberingDigest": "3b4c1e0f9a8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b",
      "fileSingleton": true
    }
  ]
}
```

`reason` is required. To mark a survivor:

1. Run `lethal explain report.json` and find the survivor.
2. Copy its whole `mark` object into `marks`, and replace its `reason` with why no test can kill
   the mutant. LethAL refuses the placeholder reason explain prints.
3. Set `identityScheme` to explain's `markIdentityScheme`.
4. If explain printed `markKeysStale`, the report was keyed under another identity scheme than this
   build's, and a mark written from it would be stale on the next run. Re-run under this build
   first, then take the mark from the new report's explain.
5. Keep the mark's `"preprocessorSymbols"` as explain printed it: the report's `buildSymbols`, the
   build's effective set (for example `"preprocessorSymbols": ["CLEAN27"]`). A mark without the
   field means `[]`: it applies only to a build with no symbols. A key names a site within one
   build, so a mark made under other symbols is reported stale and never applied (R214). A mark
   for an AL-RUNNER run lists the run's whole effective set, which includes `CLEANSCHEMA1` to
   `CLEANSCHEMA25` even when the project defines no symbols. Such a mark applies only to an
   al-runner build; a mark without them applies only to a build with no symbols (for example
   bcdev), so one mark cannot cover both backends. LethAL warns by name
   (`equivalence-marks-build-symbols`) when a mark's set differs.

A mark proves which mutant it names (R443). A key holds no file, and twins (mutants with the same
key apart from the ordinal) are told apart by a run-wide number, so an edit elsewhere, `--only`,
`--lines` or a repaired file header can hand a key to another twin. A later run therefore applies a
mark only:
- by its key, when the run's `numberingDigest` equals the mark's (the same numbering); or
- by its `file`, when the mark says `fileSingleton: true` and this run has no twin of it in that
  file.

Any other mark is listed in the report's `readerMarkedEquivalent.refused` with its reason, and its
mutant stays a plain survivor. A mark with the key alone (written before R443) is refused
(`no-proof`): re-mark it from a fresh report's explain. Explain prints no `mark` for a report from
before R443, because such a report records no numbering facts.

A marks file without `identityScheme` was written before the field existed and reads as scheme 1,
and a mark made under a scheme other than the one the run keys under is reported stale and never
applied, because a key can name a different mutant after an engine change renumbers its twins
(R325). `markKey` (and a mark's `key`) is this key, built from the survivor's row in `report.json`:

```text
key = <astHash>|<codeunitName>|<procedureName>|<operatorName>|<operatorMajor>
```

Use `triggerName` when `procedureName` is empty. For a row with `identityOrdinal` (a twin after
the first), append `|<identityOrdinal>` as a sixth field; a row without it takes no sixth field.

#### Marking notes (guidance)

Some survivors cannot be killed by any test, because the change does not change behaviour. Copy
the mark from `explain` rather than building it by hand. A marked survivor is `skipped`: verify never runs it, and it
is not a measured kill or survival. `equivalenceRisk` alone never skips a survivor. A mark never
changes the score.

### Writing the killing test (guidance)

Start from the row's `coveringTests` and the mutated span. Prefer a row with
`executionProven: true`; a `false` one may be no finding at all. `reach: "covered-but-unreached"`
means a test enters the procedure and never reaches the statement, so it needs a new case rather
than a stronger assertion. The test must pass twice on the unmutated build, or verify reports it
`flaky` or `red` (for `infra-error`, read both runs first: at least one call failed). Verify runs the covering tests the run recorded plus every NEW test: one your edit added, or
an existing test whose own source (its attributes and its procedure) changed since the run
(R-278, R258). A test is also new when anything it runs changed (R371): a test-app procedure or
handler it reaches, the header, globals or triggers of an object it reaches, ANY event-subscriber
codeunit in the test app (every test is then new), or a dependency, by the bytes of the package the
server holds (R385: Microsoft ones too, so a rebuild or an upgrade at an unchanged declared version is
seen). Every test also covers `System`, `Application` when the test app declares one, and Test
Runner, which the `LethAL Control` app runs every test through, so a platform or Base App update
makes every test new. Every app in the walk, Microsoft's and partner ones alike (R496: before, only
Microsoft's were checked), must have exactly one installed version, the one the server serves, or
verify refuses `dependency-unreadable` naming it. That includes a partner dependency that is
published but not installed (a staged upgrade): this refusal is intended, since a digest over it
would describe a package no test runs against. This adds about 4.3 s per run and per
verify (14 packages, 68.9 MB, on BC 28.4). A test with a call the walk cannot follow (an interface,
a `RecordRef` insert, a run by id) is new after ANY test-app edit. So one shared-helper edit can make
many tests new.

What verify still does NOT see, so it reports the affected tests as OLD (not re-run, no cause) with
no warning:
- an installed app no test-app dependency reaches (for example one with a global event
  subscriber), and a non-Microsoft dependency that is published but not the installed version
  (R434);
- a body-only rebuild of a symbols-only package (no `.al` source inside): measured, that is
  `Application`, which is expected because it is a wrapper app whose dependencies carry the source,
  and the `LethAL Control` package, whose bytes are not hashed anyway;
- a service-tier binary update with no new `System` package (unmeasured);
- the control app's own changes: its bytes are not hashed, or every control-app upgrade would make
  every test new;
- on al-runner, Microsoft apps are still read by declared version (R435; verify is bcdev only).

Under `fenced` coverage (bcdev's default) a new test is sent only to the survivors its own
coverage reaches (R-384), read from the unmutated run verify already makes of it, so the filter
costs no extra call. It reaches a survivor when it ran at least one line of the survivor's
procedure, or, for a trigger, of its object. A new test whose coverage cannot be used (its run did
not pass in a fresh session, or reported no coverage) runs against every survivor, and so does a
survivor coverage cannot place (an object inside `#if`, an unplaceable line, no member name). A
survivor's own covering tests are never dropped. A survivor that no new test reaches and that has
no covering test is sent nothing and stays `survived`, with `testsRun: []` and a `failureNote`
that says so; it still counts toward exit `5`. Every new test still runs once unmutated, and
again after the mutants when it was sent to at least one survivor; one sent to none is not rerun
and reads `not-rerun` (R-427). The
filter is off under the hub modes (`procedure`, `line`), whose coverage comes from another
session, and under `none`. One stderr line says which:
`[lethal] verify: reach filter on (fenced coverage): ...` with the runs it saved, or
`[lethal] verify: reach filter off (<why>): every new test runs against every survivor.`; a
`verify-reach-fail-closed` warning names each test and survivor that took every new test. Since
schema v5 (R-425) the JSON records it too: `reachFilter` is `{"state": "on"}` or
`{"state": "off", "reason": ...}`, and each planned row carries `reachNarrowed`, true when the filter
left at least one new test out of that survivor's request. The tests left out are
`newTests[].test` minus that row's `testsRun`. A MISSING field is unknown, never off: in a v5
document, a missing `reachFilter` means verify stopped before deciding it (an early refusal), and a
row without `reachNarrowed` is one the filter never decided for (skipped, every test
TestPage-refused, or the session stopped first). A document below v5 cannot say whether the filter
ran, so do not infer it from `testsRun`.

The filter sees only code a new test runs itself, in its own session. A test that fails only
because an EARLIER test in the same call left state behind (SingleInstance globals, committed
data), or because of code run in another session (StartSession, a scheduled task, the job queue),
is not sent to that survivor. A fresh `lethal run` has the same blind spot. Pass
`--no-reach-filter` to send every new test to every survivor, as before R-384. On apps that use
background sessions, the job queue or SingleInstance state (most real apps), prefer
`--no-reach-filter` when a missed kill would matter (R426).

The cap counts extra test runs: two unmutated runs per new test, plus one per survivor a new test
joins, against `--max-new-tests` (default 50) x (survivors + 2). With the reach filter on, a new
test sent to no survivor is not rerun, so it counts one unmutated run, not two (R-427); before the
lease only the one run per new test is checked. Above it verify refuses
`too-many-new-tests` and names the value that would run them. A run recorded before R385 (digest
scheme v1 or v2) is refused once as `source-predates-verify`, and the detail names both schemes
(`scheme v2, this build v3`). An edited test
gets the same unmutated runs as an added one. On bcdev the run records each test's source from the
PUBLISHED test app, the body the server ran (R372), so a test you edited without republishing reads
as new to verify. An env-tool session publishes its own test apps after it takes the lease, so it
reads the test app back after that publish and records the digests from that read (R373). It
records them only when the read-back is installed (exactly one installed version, the one served),
every app it published is installed at the version the server serves, and, when a `publishApps`
file is the test app, the read-back has that file's name, publisher, version and `.al` sources.
Where the run could not read that source or prove it (no dev endpoint, a failed or unproven
read-back, a package without source) it records none and warns `test-digests-unavailable` once,
naming why, and verify refuses that run as `source-predates-verify`. On al-runner the source on
disk is what runs, and that is what the run records.

An env-tool session's `--resume` finds the run to resume before the lease, against the test app the
server held then. If the test app read back after the publish differs from it or cannot be read,
the session refuses with `TestAppRepublishedError` (code `test-app-republished`) before the first
baseline (R486). `--skip-known-survivors` compares the read-back instead: after a new test app, or
an unreadable read-back, it skips nothing and warns `history-test-app-changed`. The run records the
read-back's identity, or none when it could not be read.

**A run lends its test-app identity to a later session only when it PROVED it (R495).** `--resume`,
`--resume-run`, `--skip-known-survivors` and the reuse of a saved baseline all require the earlier
run to have proven that the test app it recorded is the one it ran. The proof, by backend:
- bcdev with an env-tool hook: the read-back after the hook, as above;
- bcdev without a hook: the served package's own id and version (from the package, never from the
  local `app.json`) has exactly one installed row on the server. A served package that is published
  but not installed, a backend that cannot read installed versions, or no package read at all (no
  dev-endpoint credentials: the source on disk is not what BC runs) proves nothing;
- al-runner: it compiles the test source it hashed, so its identity is proven by construction.

An unproven run records no identity. It still runs and reports normally, and it lends nothing: a
later `--resume` of it is refused by name ("not proven installed"), and `--skip-known-survivors`
skips none of its survivors and warns `history-test-app-changed`. A session that proved its test app
and then reads a different one at a later batch, or cannot read it at all, stops there with
`TestAppDriftedError` (code `test-app-drifted`), before that batch records anything (no carried
verdict, no known survivor, no error row, no baseline), and its run keeps no identity. The same
happens to the run's proof when a stale-test-app refusal's re-read finds another test app. The read
runs at the top of each batch and again before its baseline, so a republish during a batch is
caught at the next one; a change to what is installed that leaves the served package unchanged is
not caught.

**One-time cost on upgrade.** Runs recorded before R495 carry no proof, so the first run after the
upgrade carries nothing on `--resume`, skips nothing on `--skip-known-survivors` and re-runs every
baseline. The runs it records are proven, so the next session lends normally again.

**The identity includes the test app's dependencies (R496).** A run's identity is its test-app hash
AND its dependency fingerprint: every app the test app depends on, transitive ones too, hashed by
the package the server holds, each with exactly one installed row at that version. A session lends
to another only when both are equal, so a library the tests depend on that was rebuilt between two
runs (same id and version, other bytes) carries nothing across. Where the fingerprint is taken:
- bcdev without a hook: under the lease, from the served test-app package's manifest (a package
  without `.al` source is fingerprinted too). If a dependency changed while the session waited for
  the lease, so that its pre-lease digests no longer match, the run keeps neither its identity nor
  its digests and warns `test-digests-unavailable` once; a fresh run then runs unproven, and a
  requested resume refuses with `TestAppRepublishedError`;
- bcdev with a hook: from the read-back after the hook;
- al-runner: from the test project's `app.json` and the `.app` files in its package folders.

A fingerprint that cannot be taken (a dependency not served, or not installed at the served
version) leaves the run unproven, with a `test-app-dependencies-unproven` or
`test-digests-unavailable` warning naming the app. A resume refused for this reason says "the test
app's dependencies changed (A, now B)" or "it recorded no dependency fingerprint". Not covered: an
installed app outside the dependency closure, a dependency changed during the batches, and the
control app's own bytes (only its version and its dependencies count). A hook session whose test app
has no `.al` source is never proven (R498).

**Second one-time cost on upgrade.** Runs recorded before R496, R495's included, carry no
fingerprint, so the first run after this upgrade carries nothing on `--resume`, skips nothing on
`--skip-known-survivors` and re-runs every baseline.

### After verify (guidance)

A verify `killed` proves the test kills that mutant in the installed build. Make it the record
with a fresh `lethal run`, never with `--resume`, which would carry the old verdicts (R247).

## The six rules (guidance)

1. **Read `validity` before quoting `mutationScore`.** The number without its caveats is not a
   result.
2. **A survivor is a lead, not a proven test-suite gap.** Some survivors cannot be killed by any
   test. Check `executionProven` before treating one as work.
3. **Verdict lines in the NDJSON stream are provisional until `session-finished`.**
4. **Exit `3` means the run does not vouch for its own verdicts.** Do not report them.
5. **Exit `4` means the run measured nothing.** There is no score and no survivor; read the
   failure notes.
6. **A verify `killed` is proof for the installed build; the record is a fresh `lethal run`,
   never with `--resume`.** `skipped` is not a measured kill or survival: it is a reader's mark,
   listed in `results[].verdict` so the output accounts for every named id.

## What LethAL cannot measure (guidance)

Stated so a consumer does not read an absence as a finding.

- Every verdict describes the NON-GUI branch. Tests run with `GuiAllowed=No` and
  `ClientType=ODataV4`, so a handler-less `Confirm` returns its default silently and GUI-guarded
  code takes the non-interactive path. Measured on a real app: 62 of 19,850 mutation sites (0.3%)
  sit lexically inside such a branch.
- A test that opens a `TestPage` cannot be scored, and on the default path one such test can hang
  and quarantine the whole run. The report names the refusal rather than guessing at a verdict.
- A mutant that never terminates is recorded as an unmeasured error, not scored. AL cannot preempt
  a running loop, so on the default path (`--stop-hung-sessions` off) it strands its tier and every
  mutant queued behind it is left unmeasured too. **This is the one limit that costs you a whole
  run rather than one verdict**, so the shapes that can cause it are named below.
- Coverage is procedure-level, and object-level for extension objects.


### Which mutants can fail to terminate (guidance)

Six shapes were listed. Three were fixed by giving the same question a form that cannot hang, and
one turned out never to be produced (below).
What remains is small and named, so a stranded run is diagnosable rather than mysterious.

**Fixed, and listed so an older report reads correctly:**

- `negate-conditional` at a `repeat` exit condition. `until Rec.Next() <> 0` never ends once the
  recordset is exhausted, which is the ordinary one-row fixture. Ceded to `loop-truncate`
  (`until true`), which runs the body once and cannot hang (R164).
- `empty-block` on a `while` loop's body. A `while` loop's body is what advances its condition, so
  emptying it freezes the loop forever. Ceded to `loop-skip` (`while false`), which runs the body
  zero times (R179).
- `empty-block` on a `repeat` body was listed here as a remaining hazard. It never occurred:
  `empty-block` has never claimed a `repeat` body on this grammar, so no such mutant exists (R244).
  Whether to add one for cursor loops only is R467.
- `flip-boolean-literal` at a loop's whole-condition literal. `until true` and `while false` flipped
  to loops whose condition never ends; both are refused (issue #7 and its follow-up). `until false`
  and `while true` are ceded to `loop-truncate` and `loop-skip`, which emit the same text.

**Remaining, accepted and documented rather than fixed:**

- `conditional-boundary` at a `while` condition of the form `<position> > 0`. Mutated to `>= 0` it
  never ends where the value cannot go below zero, which is the `StrPos(S, Find) > 0` scanning
  idiom. **Seven such sites on one real 554-file app.** It is NOT refused, because the identical
  syntax on a decrementing counter terminates and is a good mutant, and telling them apart requires
  reasoning about values rather than syntax (R173).
- `flip-boolean-literal` at a literal NESTED in a loop condition, under a unary `not`, or in the loop
  body guarding its only exit. None of these three shapes is refused; zero sites measured for the
  condition shapes, and the body-guard shape is not yet counted (R239).

**What to do about it.** Nothing, on a first run: the shapes are rare and the report names a
stranded tier rather than reporting a plausible score. If a run does strand, `--resume` continues it
and skips the stranded mutant by default. `--stop-hung-sessions` scores these properly as
`timeout-killed` instead, and it is off by default because it ENDS a session on your server, so do
not turn it on unless you have been asked to.

Full evidence for each is in [`../README.md`](../README.md) under Limits.

## Config (guidance)

`lethal.config.json` sits next to the app by default; `--config` points elsewhere. Every required
field is checked at startup and a missing one is named rather than defaulted. The shape is in the
README's Configuration section. Credentials live in it, so treat it as a secret: do not read it
into a transcript and do not copy it into an issue.

## Safety (guidance)

- Point LethAL at a **sandbox or dev container only, never a production tenant.** The changed build
  stays published until you republish your own app, and a plain republish is refused as a
  downgrade: the user's build needs a version above the one LethAL prints at the end of the run
  (README, "Restoring your app after a run").
- Your source tree is never modified. LethAL copies the project to a scratch directory and mutates
  the copy.
- `--stop-hung-sessions` lets LethAL END a BC session on your server. It is off by default and needs
  the user's yes; ask once, up front, and recommend it on a sandbox. A mutant that makes a loop
  infinite is ordinary on real code, and without the flag each one costs the mutant budget, a
  quarantine, and a full redeploy-and-baseline on `--resume` (measured 2026-09-02: about ten
  minutes per hang on a hosted sandbox). With it the mutant is stopped and scored `timeout-killed`.
- A report from a real project carries that project's source code in every mutant's `originalText`
  and `mutatedText`. Do not publish one, and run `bun scripts/redact-campaign-report.ts <report>`
  before committing one anywhere public.
