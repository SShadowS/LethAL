# PR-217 pre-commitment: the Company-table keep entries also accept upstream's reworded text

Lane lethal-bugs, coord PR-217, 2026-11-19. The orchestrator's ruling (option (a)), and the owner's: widen ONLY with the kept-vs-fresh
proof (principle 9).

## The finding
PERF-10's first start (19:37Z) restarted the serve daemon 32 times in 40 minutes on one refusal, which y3 kept. al-runner after
edge-4ebfe7913 (records.rs:751 at 0e6397742, perf-combined 2bb4b686 and upstream main c5861dcd9) words it:

`%COMPANYM% on the Company table: the database may hold companies this runtime does not know; name them with --companies NAME[,NAME...] (serve: the `companies` field); `all` needs test data (ADR-046 decision 4a)`

LethAL's two entries for it (`company-findset` in `V3_SERVE_SAFE_REFUSALS`, `company-table-read` in `PR56_KEPT`) match only the
old text (`... does not know (ADR-046 decision 4a)`). The audit of all 128 keep entries (`/coord/handoff/PR-217/keep-audit.md`)
found no other entry reworded upstream.

## The change
- `company-findset` and `company-table-read` each match EITHER the old text exactly (unchanged) OR the new text exactly (the
  clause above, anchored at both ends, the same slot for the method name). Nothing looser: no wildcard over the inserted clause.
- No other entry changes. The 12 entries that never match because of a missing " (not pinned)" (audit section 2) are a separate
  item: a roadmap item, each needing its own proof.

## The proof (before the code lands)
The keep standard's direct DO check on perf-combined (`/coord/handoff/PR-217/keepcheck/`): perf-combined's gated copy and its own
.NET sidecar, y2's flags, test mode, 28 requests over the 9 DO test codeunits that refused with the new text (per codeunit: the
refusing no-mutant request, up to 2 y3 mutants that codeunit alone covers, then a no-mutant control). KEPT (one daemon for all) vs
FRESH (one daemon per request), every row compared, plus EXERCISED (the new text occurs on the kept daemon, with requests after
it) and the planted-difference self-test.
- **Prediction:** 0 of 28 requests differ; the new text exercised; the self-test caught. Any difference means no widening, and it
  becomes a finding.

## Tests (red both ways)
- The old text still matches; the new text matches; the new text with any one character changed, or the clause alone with the
  old tail, does not match.
- The `pr56-measured-refusals.json` pin is updated only by adding the new text to the class's measured texts.

## Then
The v3 gate on the landing head, CI, merge, and PERF-10's restart from master (its third head: c7c66255f plus this change, named in
the result).
