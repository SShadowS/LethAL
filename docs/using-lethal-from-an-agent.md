# Driving LethAL from an agent

Everything a program needs to run LethAL and read the result: the argv, the exit codes, which file
answers which question, and the four rules that stop a caller reaching a confident wrong
conclusion. Written for an autonomous consumer (an agent, a CI job, a script). A human should read
[`../README.md`](../README.md) instead.

There is a copyable skill next to this document at
[`../skills/lethal-mutation-testing/SKILL.md`](../skills/lethal-mutation-testing/SKILL.md). It is
the short operational form of this page; this page is the reference.

## What LethAL answers

It breaks your AL code on purpose, one small change at a time, and runs your tests against each
break. A change your tests catch is **killed**. One they miss is a **survivor**. One no test even
executes is **no-coverage**. The share killed is the **mutation score**.

The question it answers is not "did this line run" but "would anyone notice if this line were
wrong". That is why its output needs the interpretation rules below: a survivor is a lead, not a
proven test-suite gap.

## Before anything else: `doctor`

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

## Running

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

**Scope it.** An unscoped run on a real project is refused by default above 1,000 mutation sites,
because it costs days and usually cannot publish at all. `--allow-large-run` overrides the refusal
and does not make the run cheaper. Find the size first with `--dry-run`, which lists what would be
mutated, executes nothing, and reports both the raw site count and the deployed count.

**Know which flags can move a verdict.** `--only` and `--operator` select which MUTANTS run and
cannot change a verdict. `--tests-only` selects which TESTS run at baseline and CAN: exclude a
killing test and its mutant is reported survived. The report flags a narrowed run in
`validity.caveats`, as `narrowed`, `operator-narrowed` or `tests-narrowed`.

**Backends.** `bcdev` is authoritative. `al-runner` is offline and is NOT: its `asserterror` never
fails a test, so mutants killable only that way come back survived there. Under-reporting only,
never a false kill. Do not quote a score from it.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | The run completed. This says nothing about whether mutants survived. |
| `1` | Error. The run did not produce a result you can use. |
| `3` | **Quarantined.** The run refused to vouch for its own verdicts. |

`3` is the one to handle deliberately. It does not mean the tests failed, and the verdicts it
produced must not be reported as findings. It means LethAL could not prove the server was in a
state where its answers mean anything. `--resume` continues such a run once the cause is fixed.

A non-zero exit is never "the test suite is bad". Mutation results live in the report, not the exit
code.

## Reading the result

Three surfaces, three purposes, each versioned separately.

Two of them have a published JSON Schema in [`../schemas/`](../schemas/) — the `explain` projection
and `doctor --json`. Validate against those rather than trusting a shape you inferred from one
example. The report and the event stream do not have one yet.

### `--out report.json` — the record

`schemaVersion: 2`. The full result: `counts`, `mutationScore`, `validity`, and every mutant with
its verdict, location, operator, covering tests and coverage attribution. This is the artifact to
archive.

**Read `validity` before quoting `mutationScore`.** `validity.reliability`,
`validity.scoreDescribes` and `validity.caveats` say what the number covers. A score from a
narrowed run describes the slice, not the project. A run whose baseline was red could not score
some mutants at all, and they read `no-coverage` rather than `survived`.

### `lethal explain report.json` — what it MEANS

`explainSchemaVersion: 4`. Reads that file and nothing else: no server, no database, no config.
Prints JSON on stdout.

Its own `contract` block states the split: **structure is contractual, prose is not.** Field names,
nesting and value domains are stable under `explainSchemaVersion`. Do not parse `meaning` text;
every machine-usable fact is already a field.

The field that decides what a survivor is worth is `executionProven`. It is `true` only for an
exact, member-level coverage match, meaning a test is measured to have executed the mutated
procedure. `false` means some test touched the object and no test is measured to have run the
mutated code, so the survivor may be no finding at all. `reach` adds what the coverage signal and
the mutant run's own guard attestation say together: `covered-but-unreached` is a test that enters
the procedure and never reaches the statement.

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
was applied and `actionability` when one was — ranked so that the rows carrying the most evidence
survive the cut, ordered totally, so the same report and the same cap give the same rows every
time. The cap bounds survivors only; `notMeasured` is never shortened. `--top 0` is refused.

### `--progress-out events.ndjson` — following a live run

`streamSchemaVersion: 1`. One JSON object per line, flushed as each event arrives, so a killed
process still leaves a readable file. Line 1 is a header this sink writes itself and carries
`ndjsonHeader: true`; every later line is an event with `seq`, `type` and `runId`.

**Every verdict line is PROVISIONAL until `session-finished` appears.** A `batch-invalidated` event
can supersede a verdict already written to the file — a lease loss, or a deploy that turns out
unsound, sends its batch round again. Acting on a `survived` line that a later event retracts means
acting on a fact the run itself no longer stands behind.

Unknown event types are ignored by design, so a future event type does not break a consumer.

## The four rules

1. **Read `validity` before quoting `mutationScore`.** The number without its caveats is not a
   result.
2. **A survivor is a lead, not a proven test-suite gap.** Some survivors cannot be killed by any
   test. Check `executionProven` before treating one as work.
3. **Verdict lines in the NDJSON stream are provisional until `session-finished`.**
4. **Exit `3` means the run does not vouch for its own verdicts.** Do not report them.

## What LethAL cannot measure

Stated so a consumer does not read an absence as a finding.

- Every verdict describes the NON-GUI branch. Tests run with `GuiAllowed=No` and
  `ClientType=ODataV4`, so a handler-less `Confirm` returns its default silently and GUI-guarded
  code takes the non-interactive path. Measured on a real app: 62 of 19,850 mutation sites (0.3%)
  sit lexically inside such a branch.
- A test that opens a `TestPage` cannot be scored, and on the default path one such test can hang
  and quarantine the whole run. The report names the refusal rather than guessing at a verdict.
- A mutant that never terminates is recorded as an unmeasured error, not scored. AL cannot preempt
  a running loop.
- Coverage is procedure-level, and object-level for extension objects.

Full evidence for each is in [`../README.md`](../README.md) under Limits.

## Config

`lethal.config.json` sits next to the app by default; `--config` points elsewhere. Every required
field is checked at startup and a missing one is named rather than defaulted. The shape is in the
README's Configuration section. Credentials live in it, so treat it as a secret: do not read it
into a transcript and do not copy it into an issue.

## Safety

- Point LethAL at a **sandbox or dev container only, never a production tenant.** The changed build
  stays published until you republish your own app.
- Your source tree is never modified. LethAL copies the project to a scratch directory and mutates
  the copy.
- `--stop-hung-sessions` lets LethAL END a BC session on your server. It is off by default. Do not
  turn it on without being asked to.
- A report from a real project carries that project's source code in every mutant's `originalText`
  and `mutatedText`. Do not publish one, and run `bun scripts/redact-campaign-report.ts <report>`
  before committing one anywhere public.
