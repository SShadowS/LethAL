# Driving LethAL from an agent

Everything a program needs to run LethAL and read the result: the argv, the exit codes, which file
answers which question, and the five rules that stop a caller reaching a confident wrong
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

## Reading the result

Three surfaces, three purposes, each versioned separately.

All four have a published JSON Schema in [`../schemas/`](../schemas/). Validate against those rather
than trusting a shape you inferred from one example. Two caveats that file spells out: the stream
schema describes an EVENT line, not the header the sink writes first, and the report schema
describes the shape the current build writes, so an archived report of the same version can lack a
now-required property.

**A real report is committed, so you can try this with no server at all:**

```bash
lethal explain docs/campaign/2026-08-16-gift-card/rehearsal.report.json --top 10
```

It is the gift card demo's rehearsal run — 43 mutants, 25 killed, 11 survived, 7 no-coverage — and it
is kept unredacted because that app is ours. Every other committed report has its source stripped;
see `scripts/redact-first-party-reports.json` for the rule and how it is enforced.

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

## The five rules

1. **Read `validity` before quoting `mutationScore`.** The number without its caveats is not a
   result.
2. **A survivor is a lead, not a proven test-suite gap.** Some survivors cannot be killed by any
   test. Check `executionProven` before treating one as work.
3. **Verdict lines in the NDJSON stream are provisional until `session-finished`.**
4. **Exit `3` means the run does not vouch for its own verdicts.** Do not report them.
5. **Exit `4` means the run measured nothing.** There is no score and no survivor; read the
   failure notes.

## What LethAL cannot measure

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


### Which mutants can fail to terminate

Three shapes have been found and two were fixed by giving the same question a form that cannot hang.
What remains is small and named, so a stranded run is diagnosable rather than mysterious.

**Fixed, and listed so an older report reads correctly:**

- `negate-conditional` at a `repeat` exit condition. `until Rec.Next() <> 0` never ends once the
  recordset is exhausted, which is the ordinary one-row fixture. Ceded to `loop-truncate`
  (`until true`), which runs the body once and cannot hang (R164).
- `empty-block` on a `while` loop's body. A `while` loop's body is what advances its condition, so
  emptying it freezes the loop forever. Ceded to `loop-skip` (`while false`), which runs the body
  zero times (R179).

**Remaining, accepted and documented rather than fixed:**

- `conditional-boundary` at a `while` condition of the form `<position> > 0`. Mutated to `>= 0` it
  never ends where the value cannot go below zero, which is the `StrPos(S, Find) > 0` scanning
  idiom. **Seven such sites on one real 554-file app.** It is NOT refused, because the identical
  syntax on a decrementing counter terminates and is a good mutant, and telling them apart requires
  reasoning about values rather than syntax (R173).
- `empty-block` on a `repeat` body whose condition its body advances. `repeat` always runs its body
  once, so there is no "run it zero times" rewrite to cede to. A handful of sites on the same app,
  and the count is an estimate rather than a measurement (R179).

**What to do about it.** Nothing, on a first run: the shapes are rare and the report names a
stranded tier rather than reporting a plausible score. If a run does strand, `--resume` continues it
and skips the stranded mutant by default. `--stop-hung-sessions` scores these properly as
`timeout-killed` instead, and it is off by default because it ENDS a session on your server, so do
not turn it on unless you have been asked to.

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
- `--stop-hung-sessions` lets LethAL END a BC session on your server. It is off by default and needs
  the user's yes; ask once, up front, and recommend it on a sandbox. A mutant that makes a loop
  infinite is ordinary on real code, and without the flag each one costs the mutant budget, a
  quarantine, and a full redeploy-and-baseline on `--resume` (measured 2026-09-02: about ten
  minutes per hang on a hosted sandbox). With it the mutant is stopped and scored `timeout-killed`.
- A report from a real project carries that project's source code in every mutant's `originalText`
  and `mutatedText`. Do not publish one, and run `bun scripts/redact-campaign-report.ts <report>`
  before committing one anywhere public.
