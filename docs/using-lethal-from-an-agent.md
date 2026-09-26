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

Read-only, takes seconds, checks every pre-flight refusal in one pass instead of letting a real run
discover them one at a time. Run it first. Exit `0` means every check passed, `1` means at least
one failed.

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

- `checks[].name` is what to branch on. `detail` is prose for a human.
- `notChecked` is the part that matters when doctor PASSES: those two are not covered by a green
  report, so a run can still refuse for either reason.
- `caveat` appears only for a config shape that has one (`create-mode`, `al-runner-only`) and says
  which checks were skipped and why.

`--json` is accepted by `doctor` only. On any other subcommand it is refused rather than ignored.

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

**Scope it.** `--only <glob>` is an allow-list and `--exclude <glob>` its complement, applied after
it, so `--only "src/**" --exclude "src/Upgrade/**"` reads the way it sounds. Both are repeatable,
both select mutants rather than sources (every file is still parsed, compiled and published), and
both refuse a pattern that matches no file. The report records either narrowing and flags the run
`narrowed`, so a scoped score can never be mistaken for a project score.

**The database.** A run keeps its state in `<project>/lethal.sqlite` unless `--db` names another
file. `lethal verify` reads that same file, so give it the run's database, not a new one.

Durable exclusions belong in the config rather than the command line: a top-level
`"exclude": ["src/Upgrade/**"]` in `lethal.config.json` is UNIONED with any `--exclude` flag, never
replaced by one, so narrowing a run cannot silently re-enable mutation of code the project said to
leave alone.

An unscoped run on a real project is refused by default above 1,000 mutation sites,
because it costs days and usually cannot publish at all. `--allow-large-run` overrides the refusal
and does not make the run cheaper. Find the size first with `--dry-run`, which lists what would be
mutated, executes nothing, and reports both the raw site count and the deployed count.

**Know which flags can move a verdict.** `--only`, `--exclude` and `--operator` select which
MUTANTS run and cannot change a verdict. `--tests-only` selects which TESTS run at baseline and CAN: exclude a
killing test and its mutant is reported survived. The report flags a narrowed run in
`validity.caveats`, as `narrowed`, `operator-narrowed` or `tests-narrowed`.

**Backends.** `bcdev` is authoritative. `al-runner` is offline and is NOT: its coverage is
CONDITIONAL. LethAL reads al-runner's own coverage output (R220), but one file declaring more than one
object disables it for the whole run (upstream #3713), and then an unreached mutant comes back
survived rather than no-coverage. That is one measured route to a false survivor. No measurement has shown a false kill from this backend, but none rules one out (a pinned platform-app directory holding a mismatched build is untested, R235). Do not quote a score from it. (Its `asserterror` DID
fail to fail a test in 2026-07; that was fixed upstream in v2 and the startup canary re-measures
it every session.)

**Cost.** On `bcdev` a mutant's covering tests run in ONE call to the server (one per mutant, not
one per test), stopping at the first failure, so a survivor with forty covering tests costs one
round trip instead of forty. This needs LethAL Control 1.0.0.17 or newer on the server; an older
one is refused before any test runs. The report's `groupedCalls` says how many such calls were
made. Three flags touch it and you should not need them: `--max-methods-per-call <n>` caps one
call, `--request-ceiling-ms <n>` bounds one call (keep it under the hosting gateway's idle
timeout; the default is 300 s), and `--no-group-runs` goes back to one call per test. A
`--mutant-timeout-ms` above the ceiling minus 30 s makes every test run alone again, and the run
warns (`group-runs-inert`) when that happens.

### Which subcommand reads which flag (checked)

Every subcommand refuses a flag it does not read; none but the one exception below accepts one
and ignores it. The table lists
the flags an agent is most likely to reach for. Any flag on a subcommand not listed for it is
refused, with a message naming the subcommands that do read it. `campaign` also refuses some of
its flags per verb: `--project` only on `anchors`, `--expect-mutants` only on `freeze`.

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
`--backend` and `--workers`) and ignores them, because it executes nothing. That is filed as
R266.

### Traps (checked)

Commands that look right and are refused. Each one below is run by a test and must be refused.

| command | instead |
|---|---|
| `lethal run --project app --tests tests --backend bcdev --report r.json` | `run` writes its report with `--out`. |
| `lethal explain report.json --out e.json` | `explain` prints on stdout; redirect it: `lethal explain report.json > e.json`. |
| `lethal verify --db app/lethal.sqlite --artifact 0123456789abcdef0123456789abcdef --survivors 0/M0004 --tests tests --out v.json` | `verify` prints on stdout; redirect it. |

### Exit codes (checked)

| Code | Meaning |
|---|---|
| `0` | The run completed. This says nothing about whether mutants survived. |
| `1` | Error. The run did not produce a result you can use. |
| `3` | **Quarantined.** The run refused to vouch for its own verdicts. |
| `4` | **Nothing scored.** Every mutant errored; the run measured nothing. |

`3` is the one to handle deliberately. It does not mean the tests failed, and the verdicts it
produced must not be reported as findings. It means LethAL could not prove the server was in a
state where its answers mean anything. `--resume` continues such a run once the cause is fixed.

`4` means the report exists but holds no verdict: every recorded mutant is an `error`, the score
is `null`, and `validity.caveats` carries `all-errors`. The cause is in the mutants' `failureNote`
(the one measured case was an instrumented build the compiler refused). Fix that and re-run; there
is nothing to `--resume`. When a run is both quarantined and scored nothing, `3` wins.

A non-zero exit is never "the test suite is bad". Mutation results live in the report, not the exit
code.

## Reading the result (checked)

Three surfaces, three purposes, each versioned separately.

All four have a published JSON Schema in [`../schemas/`](../schemas/):

- the report: [../schemas/report-v2.schema.json](../schemas/report-v2.schema.json)
- `lethal explain`: [../schemas/explain-v5.schema.json](../schemas/explain-v5.schema.json)
- the event stream: [../schemas/stream-v1.schema.json](../schemas/stream-v1.schema.json)
- `lethal doctor --json`: [../schemas/doctor-v1.schema.json](../schemas/doctor-v1.schema.json)

Validate against those rather than trusting a shape you inferred from one example. Two caveats
that [`../schemas/README.md`](../schemas/README.md) spells out: the stream
schema describes an EVENT line, not the header the sink writes first, and the report schema
describes the shape the current build writes, so an archived report of the same version can lack a
now-required property.

**A real report is committed, so you can try this with no server at all:**

```bash
lethal explain docs/campaign/2026-08-16-gift-card/rehearsal.report.json --top 10
```

It is the gift card demo's rehearsal run: 60 mutants, 34 killed, 15 survived, 11 no-coverage. It
is kept unredacted because that app is ours. Every other committed report has its source stripped;
see `scripts/redact-first-party-reports.json` for the rule and how it is enforced.

### `--out report.json`: the record (checked)

`schemaVersion: 2`. The full result: `counts`, `mutationScore`, `validity`, and every mutant with
its verdict, location, operator, covering tests and coverage attribution. This is the artifact to
archive.

**Read `validity` before quoting `mutationScore`.** `validity.reliability`,
`validity.scoreDescribes` and `validity.caveats` say what the number covers. A score from a
narrowed run describes the slice, not the project. A run whose baseline was red could not score
some mutants at all, and they read `no-coverage` rather than `survived`.

### `lethal explain report.json`: what it MEANS (checked)

`explainSchemaVersion: 5`. Reads that file and nothing else: no server, no database, no config.
Prints JSON on stdout.

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

A report from another schema version, or carrying a value this build cannot interpret, is REFUSED
rather than explained with the unrecognised value dropped.

**Bound the output.** The projection of a 473-mutant report is 243 KB, 206 KB of it survivors.
`--top <n>` caps the survivor list:

```bash
lethal explain report.json --top 15
```

The output always carries `survivorSelection`, whether or not anything was capped:

```json
"survivorSelection": { "total": 125, "shown": 15, "omitted": 110, "rankedBy": "actionability" }
```

Read `total` before treating `survivors` as the whole set. `rankedBy` is `report-order` when no cap
was applied and `actionability` when one was, ranked so that the rows carrying the most evidence
survive the cut, ordered totally, so the same report and the same cap give the same rows every
time. The cap bounds survivors only; `notMeasured` is never shortened. `--top 0` is refused.

### `--progress-out events.ndjson`: following a live run (checked)

`streamSchemaVersion: 1`. One JSON object per line, flushed as each event arrives, so a killed
process still leaves a readable file. Line 1 is a header this sink writes itself and carries
`ndjsonHeader: true`; every later line is an event with `seq`, `type` and `runId`.

**Every verdict line is PROVISIONAL until `session-finished` appears.** A `batch-invalidated` event
can supersede a verdict already written to the file: a lease loss, or a deploy that turns out
unsound, sends its batch round again. Acting on a `survived` line that a later event retracts means
acting on a fact the run itself no longer stands behind.

Unknown event types are ignored by design, so a future event type does not break a consumer.

## The hardening loop (checked)

The loop that turns a survivor into a killed mutant: `lethal run`, `lethal explain`, write a test
that should kill a survivor, `lethal verify`, and repeat until verify exits `0`. Then a fresh
`lethal run` makes the record. LethAL never writes the test; you do.

### From an explain row to a verify command (checked)

Each `explain` survivor row carries the three values verify needs: `artifactId`, `batchIndex` and
`mutantCode`. The command, with `<project>` the run's `--project` and `<tests-dir>` the test
project you edited:

```bash
lethal verify --db <project>/lethal.sqlite --artifact <artifactId> --survivors <batchIndex>/<mutantCode> --tests <tests-dir>
```

A filled-in example:

```bash
lethal verify --db app/lethal.sqlite --artifact 0123456789abcdef0123456789abcdef --survivors 0/M0004 --tests tests
```

`--db` is the database the run wrote: the run's own `--db`, or its default. Only the LAST batch a
run published stays installed on the server, so a survivor from an earlier batch is refused as
`batch-not-installed`.

A row with no `artifactId` carries `artifactIdAbsent` instead:

| artifactIdAbsent | what it means for verify |
|---|---|
| `carried` | The verdict was carried from an earlier run, so nothing of it is installed. Run a fresh `lethal run`. |
| `not-recorded` | The report predates artifact ids. Run again. |
| `not-published` | The backend published nothing for that batch. Verify cannot help. |

### Running verify (checked)

Verify works on `bcdev` only. It prints one JSON object on stdout and its progress on stderr. The
ids are checked when verify runs, not when the argv is parsed, so a wrong id is exit `6` with
`malformed-request` rather than a usage error (exit `1`). Each call that runs at least one survivor
publishes the test app once. **The test project IS published, and it stays installed afterwards**:
verify does not put back the one that was there before. A refused or all-skipped call publishes
nothing.

### Reading a verify result (checked)

`verifySchemaVersion: 1`. Schema: [../schemas/verify-v1.schema.json](../schemas/verify-v1.schema.json).

| field | values |
|---|---|
| `results[].verdict` | `killed`, `survived`, `error`, `skipped` |
| `newTests[].state` | `stable`, `flaky`, `red`, `flaky-unknown` |
| `results[].killedBy` | `assertion`, `runtime-error`, `other` |

`killedBy` never changes the exit code: a kill by a runtime error is still a kill, and says only
that no assertion caught it. `killedByNewTest` says whether the killing test is one your edit
added. `invalidBaseline` lists the requested tests that had no fresh green unmutated run. Verify then
does not run the mutant at all: that survivor's row is `error`. Fix those tests (they must pass
unmutated, in a fresh session) and run verify again.

### Verify exit codes (checked)

| code | meaning |
|---|---|
| `0` | Every named survivor was killed and every new test is `stable`. Also returned when every survivor skipped, which measured nothing. Skipped rows are left out: some killed and the rest skipped is `0`. |
| `1` | An error, including an argv verify refuses (a missing flag, the `--out` trap). The message is on stderr and there is no JSON. |
| `3` | **Quarantined**, including the test-app outcomes `publish-indeterminate` and `publish-anomalous`, which leave the container needing a recycle. |
| `4` | Every non-skipped survivor is `error`: verify measured nothing. |
| `5` | Not every named survivor was killed, or a new test is not `stable`. |
| `6` | Refused before measuring; `refused.reason` says why. |

When several apply, the first in this order wins. Precedence: `3`, `6`, `4`, `5`, `0`.

### Verify refusals (checked)

The set of reasons is checked; the advice is guidance.

| reason | what to do |
|---|---|
| `malformed-request` | Fix the argv: a 32-character lowercase hex `--artifact` and `<batchIndex>/<mutantCode>` ids. |
| `unknown-artifact` | Pass the run's `--db` and the `artifactId` from explain. |
| `batch-not-installed` | Only the last batch is installed. Run the slice in one batch. |
| `wrong-batch` | Take the artifact and the id from the same explain row. |
| `unknown-mutant` | Re-copy the mutant code from explain. |
| `not-a-survivor` | That mutant was not a survivor. Drop the id. If it is a known survivor the run skipped, run again without `--skip-known-survivors`. |
| `carried` | The verdict was carried, so nothing of it is installed. Run a fresh `lethal run`. |
| `source-predates-verify` | Run `lethal run` again: the run predates verify, stopped early, or its source changed while it ran. |
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

Some survivors cannot be killed by any test, because the change does not change behaviour. Mark
one in `<project>/lethal.equivalent.json`:

```json
{ "marks": [ { "key": "...", "reason": "..." } ] }
```

`reason` is required. No command prints the key yet (R265), so build it from the survivor's row in
`report.json`:

```text
key = <astHash>|<codeunitName>|<procedureName>|<operatorName>|<operatorMajor>
```

Use `triggerName` when `procedureName` is empty. **A row with `identityOrdinal` (a twin after the
first) cannot be marked today, because the marks file accepts only five-field keys (R230).**

A marked survivor is `skipped`: verify never runs it, and it is not a measured kill or survival.
`equivalenceRisk` alone never skips a survivor. A mark never changes the score.

### Writing the killing test (guidance)

Start from the row's `coveringTests` and the mutated span. Prefer a row with
`executionProven: true`; a `false` one may be no finding at all. `reach: "covered-but-unreached"`
means a test enters the procedure and never reaches the statement, so it needs a new case rather
than a stronger assertion. The test must pass twice on the unmutated build, or verify reports it
`flaky` or `red`. Verify runs the covering tests the run recorded plus the tests your edit added,
so an edit to an existing test that did NOT cover the mutant is never run against it: that is a
blind spot, not a survival.

### After verify (guidance)

A verify `killed` proves the test kills that mutant in the installed build. Make it the record
with a fresh `lethal run`, never with `--resume`, which would carry the old verdicts (R247).

## The six rules (checked)

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

## Safety (checked)

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
