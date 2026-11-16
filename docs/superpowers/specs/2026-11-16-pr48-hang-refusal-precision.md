# PR-48 pre-commitment, part 1: R1053, narrow R1050's transitive step

Status: pre-commitment (coord PR-48, lethal-code, 2026-11-16), before the build. Part 2 (R1061, the narrowed rule B) gets its own
addendum before it is built. Evidence: `/coord/handoff/PR-48/`. Method and bar: PR-37's (`2026-11-15-pr37-r1050-emptied-progress.md`)
and PR-44's (`2026-11-16-pr44-t5-hang-shapes.md`). Invented AL only in anything committed.

## The change

R1050's rule 1 (`r1050Progress`, `loop-hazard.ts`) refuses `lethal.empty-block` of a progress procedure's body. The fixpoint
starts from calls in a loop whose exit reads a name the call moves. Today it then adds every callee P that a progress procedure Q
calls with a `var` argument Q can move.

The narrowed step adds P only when the name P moves is one Q moves TOWARD the outer exit:
- a `var` parameter of Q that the outer call binds to a name the outer loop's exit reads (directly, or through R818's body
  closure);
- or Q's return value, when the outer call's result is exit-read.

So a helper that writes a scratch `var` the loop overwrites right after the call (Filter Tokens' date and time helpers, R1053) is
no longer refused. The first hop and rule 2 are unchanged.

## Acceptance

- **Hang evidence stays refused.** Every site that R1050 refuses today and that any stored run scored `timeout-killed` stays
  refused. The stored runs are the 72 BC.History modules' v3 stores (R-969/R-961/R-953/R-964), PR-34's Filter Tokens stores, and DO
  windows t1-t7 (`/coord/handoff/R-984/`; t7 once it ends). One such site given back is a failure, and the change does not land.
- **Fixtures.** The dry-run of every `fixtures/*` project is unchanged; `sandbox-hang` is the important one. No emit golden moves.
- **Given back.** The corpus and DO dry-runs before and after list the sites given back and their stored verdicts. The R1053 figure
  to beat is the 11 Filter Tokens helper bodies, all killed on v3.

## Predictions

1. Unit tests, red both ways:
   - R1050's existing tests stay green, test B (a real two-hop hang) among them;
   - a new test gives back a helper called with a `var` the loop overwrites after the call;
   - a new test keeps refusing a helper whose `var` parameter is bound to an exit-read name.
2. Corpus: Filter Tokens' 11 helper bodies are given back, and no `timeout-killed` site is given back anywhere.
3. `itest:alrunner-v3` passes every leg; no gate's mutant set moves.
4. DO: the sites given back are listed for t8's pre-commitment (lethal-bugs).
