# PR-56 pre-commitment: every census-CLEAN refusal class on the keep-list (option a), with a drift guard

Status: pre-commitment (coord PR-56, lethal-code, 2026-11-16), before the build. Ruling (orchestrator, 2026-11-16): option (a)
now; inverting the keep-list waits for upstream #8180. Evidence: PR-54's census (`/coord/handoff/PR-54/census.md`, strict
re-run: 74 of 74 measured classes CLEAN). Out: `/coord/handoff/PR-56/`.

## 1. The keep entries

For each CLEAN class in `/coord/handoff/PR-54/classes.tsv`, one entry in `V3_SERVE_SAFE_REFUSALS`, unless an existing entry
already keeps all of its measured texts. The text:
- **Exact** where the census measured one text: anchored at both ends.
- **Pattern** where the class key has `*` parts. Each `*` becomes an anchored wildcard limited to the shape the measured variants
  show: one line, no `:` unless a variant has one, and a length bound of the longest measured variant plus 50%. The pattern must
  match every measured text of the class, which is tested, and must not match a text of any other class in the census or the
  ledger, which is also tested. A class whose pattern cannot be bounded that way gets exact entries for its measured texts only.
- **Leg C coverage** only for refusals that need no .NET helper (leg C runs without it on the update gate). The others are pinned
  by serve-rule tests only.

## 2. The drift guard (a backstop for every kept refusal, old and new)

After a request in which a kept refusal row occurred, the backend checks the NEXT request on the same daemon. A row of that request
is **drift** when it differs from the batch's baseline row for the same test, and it is a row that cannot legitimately differ:
- any row of a NONE (unmutated) entry;
- in a mutant entry, the row of a test that runs BEFORE the first test covering that mutant in that codeunit (al-runner's order is
  fixed and state flows forward, R857, so a non-covering test after a covering one may differ legitimately).

"Differs": status, or message after the normalization the warm-up compare (R612) already uses. Tests the baseline refused or
timed out, and rows the baseline has none for, are not compared.

On drift:
1. close the daemon;
2. re-run that request on a fresh daemon, and use the fresh rows;
3. emit a named event `serve-drift-after-kept-refusal` naming the refusal text, the drifting test, and both rows. A warning code
   in the report counts them.
No verdict is read from a drifting request.

## Predictions
1. Unit tests, red both ways:
   - each new entry keeps its measured texts and refuses a reworded one;
   - patterns match all measured variants and no other class's text;
   - the guard fires on a NONE-row difference and on a pre-first-covering-row difference;
   - it does NOT fire on a covering test's row or on a later non-covering row;
   - on drift, the request is re-run fresh and the fresh rows are used.
2. No frozen verdict moves; `itest:alrunner-v3` passes every leg (leg C reads `matches` with the added cases); `serve-drift-after-
   kept-refusal` never fires on the gate's fixtures.
3. DO, the next window carrying it: the CLEAN classes close no daemon in a mutant request. The expected saving over t1-t8's
   pattern is about 15.6k s (301 of 413 refusal closes). The guard fires 0 times; any firing is reported by name, and the
   class is then taken off the list.
