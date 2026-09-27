# Pre-commitment: GH-06, tree-sitter-al 4.3.0 against the AL compiler parser

Written and committed BEFORE the positive controls and the reference-corpus runs. Nothing above
"Measured" is edited after. Plan: docs/superpowers/plans/2026-09-27-GH-06-tree-sitter-vs-compiler-ast.md.
Issue: GitHub #6.

## Instrument
scripts/probe-grammar-crosscheck.ts at commit ab2d2fc, grammar vendored 4.3.0, compiler
parser as printed (v18.0.41.45789 at drafting), alc bin as printed.

## Scope of every claim below
Agreement or "no blind spot" means: none in the six audited families (comparison, additive,
multiplicative, logical, unary, call) and the two context probes (call and assignment in statement
position), on COMPARABLE files. Literals, `in`, `as`/`is`, the conditional expression, member
access and array index are not audited. A corpus where no file is comparable is INCONCLUSIVE.

## Positive controls (must pass before any corpus result is read)
| grammar | file | predicted |
| --- | --- | --- |
| v3.2.1 (checked-in wasm at tag) | al-kind-mapping-linkprobe.al | control A: comparable 1; kinds onlyTreeSitter.UNEXPLAINED = comparison_expression [218,247] and call_expression [235,247] (as measured by 84b2194); nothing else; verdict disagree. |
| v4.0.1 (checked-in wasm at tag) | al-kind-mapping-continue.al | control B: comparable 1; kinds onlyCompiler.UNEXPLAINED = call_expression [89,104]; call-probe onlyCompiler.UNEXPLAINED at [89]; nothing else. |
| vendored 4.3.0 | both files | agree, exit 0. |

Control rule, applied mechanically:
- v3.2.1 reads linkprobe cleanly AND matches its row: control A PROVEN.
- linkprobe is unhealthy under v3.2.1 (verdict inconclusive): control A is unusable, and control B
  matching its row ALONE suffices. v3.2.1 is NOT rebuilt.
- v3.2.1 reads linkprobe cleanly but does NOT match its row: control A FAILED. STOP and find why.
- If NEITHER control produces its expected delta: STOP and report the check UNPROVEN. No corpus
  result is read or published.
- Both 4.3.0 rows must be agree, exit 0, in every case.

## Corpus (identity is the hash, printed first by the harness)
| path | files expected |
| --- | ---: |
| fixtures/ | 68 |
| U:/Git/do-rel2/Cloud (reference corpus; do-lethal/Cloud is the SAME hash, not run) | 417 |
| U:/Git/DC/Cloud | 475 |
| U:/Git/BusinessCentral.Sentinel | 67 |
| U:/Git/BC.History/BusinessFoundation | 104 |
| U:/Git/BC.History/System Application | 1718 |
| U:/Git/BC.History/BaseApp | 9620 |
A hash differing from docs/measurements/README.md for the first three is recorded, not a stop.
(BC.History counts are taken with `bun scripts/corpus-fingerprint.ts <dir>`, which reads no parse
output and is allowed before this commit.)

## Comparison unit
Kinds: per file, the multiset of (kind, start, end) over the six audited tree-sitter kinds, after
mapping compiler kinds through al-kind-mapping.ts. Context: per probe, the multiset of
(file, start) of statement-position sites; per-file and per-corpus totals are summaries only.
Health: tree-sitter ERROR and MISSING nodes, compiler diagnostics of severity Error.

## Rules (decided now, not after reading the output)
- R1 Comparable files: a file where EITHER parser reports an error is removed from BOTH site lists
  before diffing. It is listed under parse health. The comparable count is reported per corpus.
- R2 Directive: a delta inside a tree-sitter preproc_conditional* span is R214, counted, not a
  finding. A span guards itself only, never the rest of its file.
- R3 asserterror: a compiler-only context delta at the start of a tree-sitter node of the probe's
  kind whose parent is asserterror_statement is R216. Matched by position, never by count.
- R4 Unmapped kinds: an unruled compiler *Expression kind makes the verdict unruled-mapping
  (exit 3), never agree. It is a MAPPING gap, ruled in al-kind-mapping.ts with a reason, never a
  grammar finding. The corpus is re-run after a ruling.
- R5 Verdict: agree only when comparable files > 0, no delta in any bucket, and no unruled kind.
  Unhealthy files are warnings and never change it.
Everything else is UNEXPLAINED and is triaged.

## Triage
Group unexplained deltas into CLUSTERS by (direction, kinds or probe, construct). The construct is
named by reading the source locally and is written up ONLY as a hand-written minimal AL file that
reproduces the same delta on both parsers. A position-verified corpus cluster that will NOT minimise
is never dropped: it becomes an UNRESOLVED roadmap item carrying its positions (file, offsets,
kinds), its counts and a stated risk. Clusters over 20 sites: read a stride sample of 20, and
assign every site by a mechanical rule written down with the cluster.

## What earns a roadmap item (one item per cluster)
- OVER-CLAIM (tree-sitter only, kinds or context): at least ONE site in the cluster's hand-written
  reproduction survives the filtered planning pipeline (scripts/census-fixture-mutants.ts:
  targets, generate, validateSpec, isMutableSite, dedupe, carrier), matched to the reproduction's
  site by line AND exact before-text. A NEGATIVE match is not proof: every census line on that
  line is inspected and the reason each does not match is written down. An over-claim cluster
  that will not minimise is an UNRESOLVED item (see Triage) with risk "may deploy". Section correctness-risks. Nothing survives: findings doc
  only, plus an upstream grammar issue if the grammar mis-shapes the construct.
- BLIND SPOT (compiler only, kinds): at least ONE site inside a procedure or trigger body.
  Section product-gaps. Declarative-only: findings doc only.
- CONTEXT (compiler only, context): traced to a container not in SINGLE_STATEMENT_SLOTS. One item
  per container, linking R217. Section product-gaps.
- PARSE HEALTH: a construct that makes tree-sitter report ERROR or MISSING on a file the compiler
  parses without error. One item per construct. Section correctness-risks. (These files are
  excluded from the site diff by R1, so this channel is where their losses are counted.)
- Zero clusters is a valid result, recorded with the scope sentence above. It closes issue #6
  with no new item.

## Predictions
- Controls: as in the table.
- fixtures/: six kinds agree; the 9-position call-probe gap is 9 explained, 0 unexplained; predicted U = 0. If not, the fixture gap is the first triage item.
- BC.History parts: over-claims only under R2; the R215 and #20 to #23 shapes at ZERO.
- No reference corpus produces an over-claim that survives the filtered pipeline.

## Measured
(filled after the runs, below this line only)
