# R-274b plan: `lethal explain --project <dir>` shows each gap's source with its survivors marked

Base: master `a6c78132`, worktree `/work/lethal-wt/r274b`. Roadmap item R274. Orchestrator ruling
(2026-10-06): option (2), explain reads the source from disk and refuses by name on a source
mismatch with the run; NO block source goes into the report.

## What exists
- `explain` reads only the report (`assertExplainableReport`, then `explain`). Gaps carry `file`,
  `blockStartLine`, `blockEndLine`, `members` (survived mutantCodes); each report row carries its own
  `startIndex`, `endIndex`, `originalText`, `mutatedText`.
- The run hashes its source ONCE: `hashSourceSnapshot(readTargetSource(project), cfg.preprocessorSymbols)`
  (`sourceHashAtGeneration`, orchestrator.ts; `baseline-snapshot.ts`), and stores it on the run row
  (`runs.generation_source_sha256`, R391). The report records `preprocessorSymbols` but not the hash.

## Design
1. **Report: one new field, `sourceSha256`** = `sourceHashAtGeneration`, carried exactly as R443
   carried `numberingDigest` into the report (the same event/fold/builder path). Optional in the
   schema (older reports lack it). Full report ripple per CLAUDE.md: events.ts, report-fold.ts,
   report.ts type/builder (banner: no line), `bun scripts/generate-schemas.ts`, `schemas.test.ts`
   (root list, older-reports expectation), `report-equality` snapshot, and the committed sample
   reports regenerated (or, if they cannot be regenerated live here, the schema keeps the field
   optional and the samples stay valid: say which).
   **Redaction:** a hash is not source; `redact-campaign-report.ts` needs no change (checked by its
   test).
2. **CLI: `lethal explain <report.json> --project <dir>`.** Explain stays a pure function of its
   inputs: the CLI reads the project and passes `ExplainOptions.source = { files, sha256 }`.
   - Recompute `hashSourceSnapshot(readTargetSource(dir), report.preprocessorSymbols)`.
   - Refuse BY NAME (a typed error, exit non-zero, nothing printed to stdout) when the report has
     no `sourceSha256` ("report predates R274: re-run"), when the project cannot be read, or when
     the hashes differ ("source-mismatch: the project at <dir> is not the source this run measured").
     Never a partial or best-effort render. A CRLF/LF checkout difference is a mismatch (raw bytes
     hashed), stated in the message's hint.
   - Without `--project`, output is byte-identical to today.
3. **Explain output: optional `gaps[].source`**, only with a verified project: the block's lines
   `blockStartLine..blockEndLine` from that file, each line once, with every SURVIVING member's site
   marked inline, as structured data, not prose:
   `{ startLine, lines: string[], marks: [{ mutantCode, line, startColumn, endColumn }] }`,
   columns from the row's `startIndex`/`endIndex` mapped onto the file (UTF-16 columns, 1-based
   line). A consumer renders it; no ANSI, no inline markers spliced into the text.
   - Per-site sanity on top of the hash: each marked site's file text at its offsets must equal the
     row's `originalText`; a difference throws (a defect, given the hash matched), never a silent
     mark. A redacted report (no `originalText`) skips only this sanity check: the hash already
     proved the bytes.
4. **Explain schema:** a new optional field `gaps[].source` plus a new CLI-only input does not
   change any existing field's meaning; per the schema history's rule, an optional additive field
   does not bump. BUT the field carries target SOURCE in explain's output: say so in the schema
   description and the agent guide (explain output with `--project` must not be committed to a
   public repo unredacted). Ask the orchestrator whether that warrants a bump anyway.
5. **Leaf registry and admissibility:** `$.gaps[].source.*` leaves join the pin, tagged
   `[source]` (read from the verified project), and the admissibility test admits strings read from
   the project only when `--project` is given (a separate test with a project fixture).

## Tests (each red in its own direction)
- report gains `sourceSha256` equal to the run's generation hash (red: field not threaded);
- `--project` with the same source renders each gap's lines and marks at the right columns (red:
  off-by-one line or column);
- a one-byte edit in ANY project file refuses by name (red: no hash compare); a report without
  `sourceSha256` refuses (red: treated as a match); an unreadable project refuses;
- without `--project` the output is byte-identical to before (red: field always emitted);
- a member whose `originalText` disagrees with the file at its offsets throws (red: drop the check);
- a redacted report (no `originalText`) still renders when the hash matches;
- multi-gap file, a mark on the block's first and last line, a CRLF file (columns on CRLF lines).

## Docs
CHANGELOG; the agent guide's explain section (the `--project` flag, the refusal, the source warning);
R274 closed.

## Changes since r1 (review r1, opus spec-adversary standing in for sol, whose quota is out;
`/coord/handoff/R-274b/review-r1.md`). These OVERRIDE the text above.
- **Which hash.** `sourceSha256` is `sourceHashAtGeneration` (the snapshot generation parsed), never
  the stored run hash `recordSourceHash` writes (withheld when the source changes mid-run). Explain
  recomputes with `report.preprocessorSymbols` (config symbols, as the run hashed), never
  `buildSymbols`; `app.json`'s symbols are covered by its bytes.
- **Explain hashes, not the caller.** The CLI passes only the file map; `explain()` itself calls
  `hashSourceSnapshot` on that map and renders from the SAME map, so what it renders is provably what
  matched.
- **B5, path keys.** The map is keyed `rel.replaceAll("\\", "/")` (as the hash already normalises);
  a report `file` missing from it after a hash match throws (a defect, never a silent omission).
- **B3, decoding.** The rendered text is decoded from the hashed Buffers with the SAME decode
  generation uses (`bytes.toString("utf8")`, which KEEPS a UTF-8 BOM so offsets line up), through one
  shared helper both call. Never `TextDecoder` or `Bun.file().text()`, which strip it.
- **B1, clipped text.** The per-site check compares `clipMutationText(file.slice(start, end))` with
  the row's `originalText` (the manifest clips at 600 characters).
- **B2, redaction.** Redaction sets `originalText` to `REDACTION_MARKER`, it does not remove it. The
  check is skipped only for that exact value (the constant moves into `packages/runner`, re-exported
  by the script so it keeps one source).
- **B4, multi-line sites.** A mark is `{ mutantCode, startLine, startColumn, endLine, endColumn }`,
  1-based lines, 1-based UTF-16 columns, end exclusive; tabs count 1. Reuse
  `mutation-elements.ts`'s `positionOf`. Lines are split on `\n` only (as `lineStartsOf`), one
  trailing `\r` stripped per line.
- **Edge cases.** A gap whose block is the whole file root throws rather than emitting the file.
  Nested gaps repeat lines (noted). The refusal message says "the source this report's positions refer
  to" (a resumed run carries verdicts measured on other source; R391), and its hint names CRLF/LF, an
  `app.json` version bump, a config-symbol change and a nested test-project edit as mismatches.
- **Schema: no bump** (reviewer agrees): an optional additive field (R275, R351 precedents); explain
  output already carries clipped source in `survivors[].originalText`; the redaction script already
  refuses explain JSON. The field's description and the agent guide say `--project` output holds
  target source.
- **Tests added:** T1 the generation hash on a run whose source changed mid-run (red: stored hash);
  T2 config symbol plus an extra `app.json` symbol (red: `[]` or `buildSymbols`); T3 a survivor
  longer than 600 characters renders (red: unclipped compare); T4 a redacted report renders, and a
  wrong unredacted `originalText` throws (red: any string skips); T5 a BOM file on a redacted report,
  marks at the right columns (red: a BOM-stripping decoder); T6 a multi-line site's start and end;
  T7 a snapshot with `\` keys renders under `/` paths (red: raw get); T8 a file written to disk after
  hashing never reaches the render; a refusal leaves stdout empty (captured); "byte-identical without
  `--project`" diffs against a stored output, not another call in the same build.

## Changes since r2 (review r2: safe, no blocker; `/coord/handoff/R-274b/review-r2.md`)
- **Offset bounds.** `positionOf` does not refuse an offset past the end of the text. Before mapping,
  require `0 <= startIndex <= endIndex <= text.length` and the mark inside
  `blockStartLine..blockEndLine`; throw otherwise (the only guard on a redacted report). Test: an
  out-of-range row throws (red: drop the check).
- **Refusal order and symbols.** Refuse a missing or malformed `sourceSha256` first; then require
  `report.preprocessorSymbols` to be a list of strings (`MalformedReportError` otherwise) before
  hashing. Test: a bare-string symbols value throws by name (red: spread into characters).
- Root-block throw kept (no committed report reaches it; it fails loudly, never silently).
