# R-265: a reader gets a mutant's mark key from LethAL (short plan)

**Problem.** A `lethal.equivalent.json` mark needs the serialized R166 identity (5 fields, or 6
for a twin after the first, R230) plus the current `identityScheme` (3 since R323, 4 since R-318).
Nothing prints it, so a reader builds it by hand, which is how R229's trigger marks were lost.

**Smallest surface: the key on each `lethal explain` survivor.** The reader decides to mark a
SURVIVOR, and explain is the survivor view they already read. Not a new `lethal key` command, not
a `--mark` writer (writing marks stays the reader's act; YAGNI), and not a new report row field:
report rows already carry every key input (`astHash`, `codeunitName`, `procedureName`,
`triggerName`, `operatorName`, `operatorMajor`, `identityOrdinal`).

**One definition.** report.ts already has `markIdentityOf(m)`, the key the mark join matches
against (R229's `||` rule, the ordinal from R230). Export it, and have explain call it. No second
spelling of the format anywhere; explain never calls `serializeKey` itself.

**Shape.**
- `ExplainSurvivor.markKey: string`, required, on every survivor.
- Explain's output also states the scheme a mark file needs (`markIdentityScheme`, copied from the
  report's `identityScheme`, absent when the report has none).
- Console `lethal explain` prints `mark key: <key>` under each survivor.
- `EXPLAIN_SCHEMA_VERSION` 6 -> 7 (a new required field is a shape change): `explain-v7.schema.json`
  generated, v6 frozen; the agent guide's explain section and its agent-contract test updated,
  plus a short "marking a survivor" recipe (copy `markKey`, set `identityScheme` to
  `markIdentityScheme`).
- The report schema does NOT change (no SessionReport field).

**Tests (round trip through the real path).** Real mutation set on inline AL, then `buildReport`,
then `explain`. For (a) a plain procedure mutant, (b) an ordinal-1 twin, (c) a table-trigger
mutant: take explain's `markKey`, write a marks file at `markIdentityScheme`, run the report path
again, and assert THAT mutant (and only it) is reader-marked, and that `parseEquivalenceMarks`
accepts the key. Red-checks: explain building the key with `??` instead of the shared helper makes
(c) go red; dropping the ordinal makes (b) go red.

**Tasks.** 1. Export `markIdentityOf`; add `markKey` and `markIdentityScheme` to explain, with the
console line; v7 schema and ripple (explain tests, agent guide, agent-contract). 2. Round-trip
tests and red-checks. 3. Close R265.
