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

`--json` is accepted by `doctor` only. On any other subcommand it is refused rather than ignored.

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

**Backends.** `bcdev` is authoritative. `al-runner` is offline and is NOT: its coverage is
CONDITIONAL. LethAL reads al-runner's own coverage output (R220), but one file declaring more than one
object disables it for the whole run (upstream #3713), and then an unreached mutant comes back
survived rather than no-coverage. That is one measured route to a false survivor. No measurement has shown a false kill from this backend, but none rules one out (a pinned platform-app directory holding a mismatched build is untested, R235). Do not quote a score from it. (Its `asserterror` DID
fail to fail a test in 2026-07; that was fixed upstream in v2 and the startup canary re-measures
it every session.)

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
| `--project` | `run`, `init`, `clear-ceiling`, `force-reset-lease`, `doctor`, `export`, `campaign` |
| `--tests` | `run`, `doctor`, `verify` |
| `--config` | `run`, `clear-ceiling`, `force-reset-lease`, `doctor`, `verify` |
| `--db` | `run`, `clear-ceiling`, `verify` |
| `--out` | `run`, `init`, `export` |
| `--progress-out` | `run` |
| `--json` | `doctor` |
| `--top` | `explain` |
| `--report` | `campaign` |
| `--only` | `run` |
| `--exclude` | `run` |
| `--tests-only` | `run` |
| `--operator` | `run` |
| `--artifact` | `verify` |
| `--survivors` | `verify` |

One exception remains: `lethal run --dry-run` still accepts its execution flags (such as
`--out`, `--backend` and `--workers`) and ignores them, because it executes nothing. So
`--dry-run --out plan.json` writes nothing. That is filed as R266.

#### Flag notes (guidance)

A stored flag can also go unused when the config makes it moot. `campaign` also refuses some of
its flags per verb: `--project` only on `anchors`, `--expect-mutants` only on `freeze`.

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

`4` means the report exists but holds no verdict: every recorded mutant is an `error` and the score
is `null`. The cause is in the mutants' `failureNote` (the one measured case was an instrumented
build the compiler refused). Fix that and re-run; there is nothing to `--resume`.

A non-zero exit is never "the test suite is bad". Mutation results live in the report, not the exit
code.

## Reading the result (checked)

Each surface below is versioned separately and has a published JSON Schema in [`../schemas/`](../schemas/):

- the report: [../schemas/report-v2.schema.json](../schemas/report-v2.schema.json)
- `lethal explain`: [../schemas/explain-v6.schema.json](../schemas/explain-v6.schema.json)
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

`schemaVersion: 2`. The top level carries `counts`, `mutationScore`, `validity` and `mutants`.
`validity` carries `reliability`, `scoreDescribes` and `caveats`.

#### Report notes (guidance)

The report is the full result: every mutant with its verdict, location, operator, covering tests
and coverage attribution. This is the artifact to archive.

**Read `validity` before quoting `mutationScore`.** `validity.reliability`,
`validity.scoreDescribes` and `validity.caveats` say what the number covers. A score from a
narrowed run describes the slice, not the project. A run whose baseline was red could not score
some mutants at all, and they read `no-coverage` rather than `survived`.

### `lethal explain report.json`: what it MEANS (checked)

`explainSchemaVersion: 6`. The top level carries `contract`, `score`, `survivors`, `notMeasured`
and `survivorSelection`. Each `survivors` row carries `executionProven` and `reach`.

A report from another schema version, or carrying a value this build cannot interpret, is REFUSED
rather than explained with the unrecognised value dropped.

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
quarantined run, which stops scheduling mutants mid-run. Each gap has
exactly one of `artifactId` (the artifact to verify it against) and `artifactIdAbsent` (why there
is none, with the same values as on a survivor row; a gap is `carried` when any of its members is).
`--top` never shortens `gaps`: every gap is listed, even one none of whose survivors is shown.

`noCoverageBlocks` lists the no-coverage mutants by block. It is a location list, not a verify
input: an entry has no gap id and no counts.

Each `survivors` row can also carry `gapId`, the gap it belongs to.

#### Explain notes (guidance)

`explain` reads that file and nothing else: no server, no database, no config. It prints JSON on
stdout.

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

`verifySchemaVersion: 2`. Schema: [../schemas/verify-v2.schema.json](../schemas/verify-v2.schema.json).

| field | values |
|---|---|
| `results[].verdict` | `killed`, `survived`, `error`, `skipped` |
| `newTests[].state` | `stable`, `flaky`, `red`, `flaky-unknown`, `infra-error` |
| `newTests[].runs[].outcome` | `pass`, `fail`, `skip`, `timeout`, `deadline-exceeded`, `error`, `not-run` |
| `results[].killedBy` | `assertion`, `runtime-error`, `other` |

`killedBy` never changes the exit code. Each `results` row can also carry `killedByNewTest`,
`invalidBaseline` and `gapId`.
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
repeats. It blocks exit `0` like every state other than `stable`.

### Verify exit codes (checked)

| code | meaning |
|---|---|
| `0` | Every named survivor was killed and every new test is `stable`. Also returned when every survivor skipped, which measured nothing. Skipped rows are left out: some killed and the rest skipped is `0`. |
| `1` | An error, including an argv verify refuses (a missing flag, the `--out` trap). The message is on stderr and there is no JSON. |
| `3` | **Quarantined**, including the test-app outcomes `publish-indeterminate` and `publish-anomalous`. |
| `4` | Every non-skipped survivor is `error`: verify measured nothing. |
| `5` | Not every named survivor was killed, or a new test is not `stable`. |
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
| `source-changed` | The target changed since it was instrumented. Run again. A test project nested inside the target makes every test edit trigger this (R260). |
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

### Marking an equivalent survivor (checked)

Mark an equivalent survivor in `<project>/lethal.equivalent.json`:

```json
{ "identityScheme": 3, "marks": [ { "key": "...", "reason": "..." } ] }
```

`reason` is required. Set `identityScheme` to the report's own `identityScheme`. A file without it
was written before the field existed and reads as scheme 1, and a mark made under a scheme other than
the one the run keys under is reported stale and never applied, because a key can name a different
mutant after an engine change renumbers its twins (R325). Build the key from the survivor's row in
`report.json`:

```text
key = <astHash>|<codeunitName>|<procedureName>|<operatorName>|<operatorMajor>
```

Use `triggerName` when `procedureName` is empty. **A row with `identityOrdinal` (a twin after the
first) cannot be marked today, because the marks file accepts only five-field keys (R230).**

#### Marking notes (guidance)

Some survivors cannot be killed by any test, because the change does not change behaviour. No
command prints the key yet (R265). A marked survivor is `skipped`: verify never runs it, and it
is not a measured kill or survival. `equivalenceRisk` alone never skips a survivor. A mark never
changes the score.

### Writing the killing test (guidance)

Start from the row's `coveringTests` and the mutated span. Prefer a row with
`executionProven: true`; a `false` one may be no finding at all. `reach: "covered-but-unreached"`
means a test enters the procedure and never reaches the statement, so it needs a new case rather
than a stronger assertion. The test must pass twice on the unmutated build, or verify reports it
`flaky` or `red` (for `infra-error`, read both runs first: at least one call failed). Verify runs the covering tests the run recorded plus the tests your edit added,
so an edit to an existing test that did NOT cover the mutant is never run against it: that is a
blind spot, not a survival.

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

Six shapes have been found and three were fixed by giving the same question a form that cannot hang.
What remains is small and named, so a stranded run is diagnosable rather than mysterious.

**Fixed, and listed so an older report reads correctly:**

- `negate-conditional` at a `repeat` exit condition. `until Rec.Next() <> 0` never ends once the
  recordset is exhausted, which is the ordinary one-row fixture. Ceded to `loop-truncate`
  (`until true`), which runs the body once and cannot hang (R164).
- `empty-block` on a `while` loop's body. A `while` loop's body is what advances its condition, so
  emptying it freezes the loop forever. Ceded to `loop-skip` (`while false`), which runs the body
  zero times (R179).
- `flip-boolean-literal` at a loop's whole-condition literal. `until true` and `while false` flipped
  to loops whose condition never ends; both are refused (issue #7 and its follow-up). `until false`
  and `while true` are ceded to `loop-truncate` and `loop-skip`, which emit the same text.

**Remaining, accepted and documented rather than fixed:**

- `conditional-boundary` at a `while` condition of the form `<position> > 0`. Mutated to `>= 0` it
  never ends where the value cannot go below zero, which is the `StrPos(S, Find) > 0` scanning
  idiom. **Seven such sites on one real 554-file app.** It is NOT refused, because the identical
  syntax on a decrementing counter terminates and is a good mutant, and telling them apart requires
  reasoning about values rather than syntax (R173).
- `empty-block` on a `repeat` body whose condition its body advances. `repeat` always runs its body
  once, so there is no "run it zero times" rewrite to cede to. A handful of sites on the same app,
  and the count is an estimate rather than a measurement (R179).
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
