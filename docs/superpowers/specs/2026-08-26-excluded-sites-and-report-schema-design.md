# Design: the excluded-sites spine (A), and the standard mutation-testing report schema (E)

Written 2026-08-26. Not yet implemented. Supersedes an earlier A+B pairing whose B half was
measured away as [R174](../../roadmap/R174.md).

## 0. Where this came from, and what changed on the way

A comparison against Stryker.NET identified five features worth borrowing. Two were selected:
a shared "sites we deliberately did not mutate" record (**A**), and a call-site ignore list (**B**),
with A justified by B as its first consumer.

**B did not survive its own measurement and is now R174.** The measurement also invalidated the
reasoning that produced it: a first estimate read "229 of 476 mutants were in `CDO Telemetry`" off a
committed report and inferred that an ignore list would remove them. It would not. Those mutants are
that codeunit's own control flow. Worse, the report could not have answered the question at all:
43% of calls in real AL are not in a statement slot, `void-method-call` claims only statement-slot
calls, and so nearly half the relevant population leaves no trace in any `SessionReport`. That is
recorded in R174 as the transferable lesson.

**A survives, with a different consumer.** E needs exactly the same record, does not depend on any
measurement, and closes a gap that started the whole comparison: Stryker has an HTML report and
LethAL does not.

An adversarial review of the A+B draft produced nine findings. Every structural one applies
unchanged to A and is folded in below. The **(Fn)** labels are that review's own numbering, kept so
the findings can be traced against each other within this document; the review itself was a session
artifact and is not a file, so each finding is restated here in full rather than cited.

Two of its findings were checked and did NOT hold as stated, and both are recorded where they land
(1.4 corrects the counting claim it made in passing; 1.6 records that its proposed fix was
unavailable). Nothing here is folded in on the review's authority alone.

---

## 1. A — the excluded-sites spine

### 1.1 The problem

`report.ts` carries two records with an identical shape and an identical stated purpose:

- `NotInstrumentedFile { file, kinds, sites }` — this FILE cannot carry the injected selector var.
- `DeclarativeSiteFile { file, kinds, sites }` — this SITE is not executable AL (R144).

`DeclarativeSiteFile`'s doc comment already calls it a "SIBLING" of the first and says "same shape and same
reason as `notInstrumented` (R5)". E's `Ignored` status is a third consumer of the same concept.

### 1.2 Shape

```ts
type ExclusionReason = "not-instrumentable" | "declarative";

interface ExcludedSiteFile {
  readonly file: string;
  readonly kinds: string;          // describeObjectKinds, as today
  readonly sites: number;          // see 1.4 — the counting rule DIFFERS by reason
  readonly reason: ExclusionReason;
  readonly detail?: string;        // reserved; unused by the two current reasons
}

readonly excludedSites?: {
  readonly totalFiles: number;     // (F7a) — notInstrumented's denominator has no other home
  readonly siteCount: number;
  readonly fileCount: number;      // DISTINCT FILES, not rows — see 1.4
  readonly files: readonly ExcludedSiteFile[];
};
```

### 1.3 Optional now, required later — one schema bump, not two **(F2)**

The draft said "required, following the precedent recorded on `REPORT_SCHEMA_VERSION`". **That passage records the
precedent as the defect, not the pattern.** R157's rule is that an added OPTIONAL field is free and
an added REQUIRED field is a new shape and bumps, and `schemas.test.ts`'s "the root required set of every published schema is pinned (R157)" test
pins the root `required` set of every published schema to enforce it. `declarativeSites` and
`preprocessorSymbols` were both added as required while `REPORT_SCHEMA_VERSION` stayed 2, which is
why `docs/campaign/2026-08-08-r85-swap-population/rung2.report.json` is a genuine v2 report that
`schemas/report-v2.schema.json` rejects.

So:

- **Now:** `excludedSites` is OPTIONAL. No bump, no schema churn, no `explain` version refusal.
- **Later:** the release that DELETES `notInstrumented` and `declarativeSites` promotes
  `excludedSites` to required and bumps to 3, in one move.

Shipping it required today would cost a bump now and a second bump at removal, and `explain`'s `schemaVersion is ... but this build explains` refusal
would immediately refuse every archived v2 report.

### 1.4 The two counting rules are NOT the same, and must both be stated **(F7b)**

The draft asserted "`sites` counted per SPEC, as `DeclarativeSiteFile.sites` is". That is false for
the other reason:

- **`declarative`** counts specs PRE-filter, at the point they are dropped inside the visit loop.
- **`not-instrumentable`** counts `fileSpecs.length` AFTER dedup and after the `--operator` filter
  (in `generateMutationSet`, the `admittedOperators` block), and a file whose specs are entirely
  filtered away leaves the list altogether, because `if (fileSpecs.length === 0) continue;` precedes
  the `canCarryMutationSelectorVar` check.

These are different numbers and the merged record must not pretend otherwise. The field keeps both
behaviours and the doc comment says which applies to which reason. Changing either is a separate
decision with its own gate consequences, and is out of scope here.

A file may appear under BOTH reasons (`DeclarativeSiteFile`'s doc comment says so explicitly: "in both lists, in neither, or in one alone"). Therefore `fileCount`
is **distinct files**, `files.length` is rows, and the two can differ. Stated on the field.

### 1.5 Views

`notInstrumented` and `declarativeSites` keep their exact current shapes and are derived from
`excludedSites` by reason. Byte-identical output for the same input is the acceptance criterion.

### 1.6 The check that can actually fail **(F1)** — the load-bearing part of A

The draft's landing proof was "A is verdict-neutral, so all four live gates stay frozen". **For the
`notInstrumented` half that proof cannot fail.** Every fixture file is a carrier kind
(`CARRIER_KINDS`, `packages/schemata/src/compile.ts`), so the population is empty on every gate
run, and **no itest references `notInstrumented` at all** (verified: zero hits across
`packages/runner/itest/*.ts`). Derive that view permanently empty and all four gates still pass.

The declarative half IS checked: `tables.itest.ts` sets it in `EXPECTED.declarativeSites` and asserts it by name, and
the comment above that block states this exact hazard. A is one field away from repeating it.

**The review proposed comparing against committed campaign-report data. That does not work, and
checking it is how we know:** all nine committed reports under `docs/campaign/` have
`notInstrumented.fileCount === 0`. There is no evidence anywhere in this repo that the field has
ever been non-zero on a real run.

So the check has to be manufactured, in two places:

1. **Unit:** a synthetic `generateMutationSet` input with a non-carrier object AND a declarative
   site AND a file in both categories, asserting the derived views equal hand-written expected
   values. Never derived-vs-derived, and never all-zero.
2. **Live:** one non-carrier object with a mutation site added to `fixtures/sandbox-data`
   (a `query` or `xmlport`), and `itest:tables` pins `notInstrumented` at a real non-zero count by
   file, mirroring what R144 did one field over. Mutant totals must not move, which is itself the
   assertion that a non-carrier file contributes no mutant.

Item 2 changes a fixture, so it needs a pre-commitment in the R171 style before the run.

### 1.7 Gates are cited by path, never by digits **(F3)**

The draft quoted four frozen figures and every one was stale (it had copied an earlier snapshot of
`CLAUDE.md`). The current values live in the `EXPECTED` blocks in `bcdev.itest.ts`,
`al-runner.itest.ts`, `envtool.itest.ts` and `tables.itest.ts`, plus the `*.baseline.json` files. **Specs cite those locations. They do not restate the numbers**, because a
spec that restates them goes stale silently and an implementer then verifies against the wrong
target or misreads a legitimate baseline as a re-record.

### 1.8 `explain`, and the roadmap pin **(F9)**

If A adds a caveat, `CAVEAT_INTERPRETATIONS` gains an entry, because `lethal explain` emits those
constants by reference with a path pin (see `CAVEAT_INTERPRETATIONS`). A caveat's `basis` must resolve against
the real `ROADMAP.md`, and `interpretation.test.ts` pins the count, so the roadmap item is
filed BEFORE the caveat lands, not after.

A as specified adds no new caveat: it renames nothing a reader sees and changes no score. If
implementation finds it needs one, that ordering applies.

---

## 2. E — the standard mutation-testing report schema

### 2.1 What it is

Stryker publishes `mutation-testing-report-schema`, a format shared by StrykerJS, Stryker.NET,
Stryker4s and others, plus `mutation-testing-elements`, an off-the-shelf viewer that renders any
conforming report: file tree, score per directory, each mutant inline in its source, filter by
status. Emitting the format means the viewer comes free.

Verified against the published schema:

| | required |
| --- | --- |
| root | `["schemaVersion", "thresholds", "files"]` |
| FileResult | `["language", "source", "mutants"]` |
| MutantResult | `["id", "mutatorName", "location", "status"]` |

`MutantStatus` is `Killed | Survived | NoCoverage | CompileError | RuntimeError | Timeout | Ignored
| Pending`. `location` is `{start, end}` of `{line, column}`, both 1-based, start inclusive and end
exclusive.

### 2.2 The constraint that shapes everything: `source` is REQUIRED

**A schema-valid report structurally cannot exist without the target's full source embedded in it.**
That collides head-on with the 2026-08-09 redaction ruling: filenames, paths, procedure names and
test names are publishable; source is not.

The collision is not resolvable by redaction. A report with `source` blanked is still schema-valid
but renders nothing, so the format's entire purpose is gone. Therefore:

- The schema report is written **only** by its own flag, never by `--out`. `--out` continues to
  write `SessionReport` and is unaffected.
- It is a **local artifact**. The default output path is gitignored, and a repo-level ignore rule
  covers the conventional filename.
- **`redact-campaign-report.ts` REFUSES the format outright** rather than trying to clean it. It
  already throws on a file with no `mutants` array ("a report shape this script cannot read is a
  report it cannot certify"); a schema-format report is detected by its root `schemaVersion` +
  `files` shape and refused with a message saying it must not be committed at all.
- A test asserts no schema-format report exists anywhere under the repo, the same way
  `redact-campaign-report.test.ts` asserts the two committed reports stay clean.

### 2.3 Mapping

| LethAL | schema | note |
| --- | --- | --- |
| `killed` | `Killed` | |
| `survived` | `Survived` | |
| `no-coverage` | `NoCoverage` | |
| `timeout-killed` | `Timeout` | |
| `error` | `RuntimeError` | `cause` goes to `statusReason` |
| bisect compile culprit | `CompileError` | the one `AlcCompileError` case |
| `known-survivor` | `Survived` | `statusReason` says it was carried from a prior run, not re-run. **Open**: `Pending` is arguably more honest; decide at implementation |
| `excludedSites` row | `Ignored` | one mutant-less entry per excluded site, `statusReason` = the reason |

Field mapping: `mutatorName` = `operatorName`; `coveredBy` = `coveringTests`; `killedBy` =
`killingTest`; `statusReason` = `killingTestFailure`, which the redaction ruling deliberately KEEPS.

`testsCompleted` exists in the schema precisely because a runner may bail after the first failing
test, which is what the covering-test loop already does (the `break` after a confirmed kill in the covering-test loop). It is emitted, and it will differ from `coveredBy.length` on kills.

`location` needs an end position, which the report does not carry (it has `line`, plus
`startIndex`/`endIndex` byte offsets). The emitter already holds the source, because the schema
requires it, so both positions are derived from the byte offsets against that source. **No new
report field.**

`thresholds` is required and LethAL has no threshold concept. It is emitted at the ecosystem default
(`high: 80, low: 60`), and a note records that a real value arrives if and when `--break-at` (the
deferred item D) lands.

`language` is `"al"`.

### 2.4 Scope: JSON only, no bundled viewer

Emit the JSON. Do **not** bundle `mutation-testing-elements` into the binary. A self-contained HTML
page means vendoring a third-party web component into a shipped artifact, and the JSON alone is
already renderable by the standard viewer. Deliberate YAGNI; revisit only if asked.

### 2.5 Gates for E

1. Emitted JSON validates against a vendored, version-pinned copy of the published schema.
2. The anti-commit test in 2.2.
3. A mapping test covering every `MutantVerdict` including `known-survivor` and both `error` paths,
   so a new verdict cannot be added without deciding its status.

---

## 3. What R174 would have added, and why it is not here

Recorded so the refusal is legible from this document, since R174 cites this section.

`ignoreMethods`: a `lethal.config.json` glob list matched case-insensitively against the callee as
written (`Name`, or `Receiver.Name`), dropping any spec whose `before` span lies within a matching
call's span. Measured on `do-lethal/Cloud`: **0.38% of raw specs** for a telemetry-only pattern set,
**1.70%** for one that also includes UI predicates, against R13's already-calibrated 5% bar for a
candidate needing a new mechanism. The upper figure is reached only by also dropping 88 specs inside
non-statement-slot calls, 27 of them `negate-guard` mutants on live branches. Full reasoning, both
pattern sets and the reopen condition are in [R174](../../roadmap/R174.md); the probe is
`scripts/r174-ignore-methods-probe.ts`.

Its `"ignored-method"` reason and the `detail` field are deliberately absent from
`ExclusionReason` in 1.2. `detail` is retained as optional because E's `Ignored` entries want a
human-readable reason string regardless.

---

## 4. Sequencing

1. **A**, including 1.6's two manufactured checks. The fixture half needs a pre-commitment and a
   `itest:tables` run.
2. **E**, on top of A's `excludedSites` for its `Ignored` entries.

D (`--break-at`) stays available as an independent, cheap follow-up and would retire the hardcoded
`thresholds` in 2.3.

## 5. Open questions for implementation

1. `known-survivor` to `Survived` or `Pending` (2.3).
2. Whether A wants a caveat at all; if it does, 1.8's ordering applies.
3. The exact non-carrier object kind for 1.6's fixture arm (`query` vs `xmlport`), decided by which
   one an operator actually claims a site in.
