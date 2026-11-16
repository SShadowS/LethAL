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

## Addendum 1 (2026-11-16): part 1 measured; part 2 pre-committed

**Part 1 measured** (`/coord/handoff/PR-48/measure1.md`; built at lethal/pr-48 024ba0b2):
- Hang evidence: 33 distinct timeout-killed sites, from the BC.History v3 stores, PR-34's Filter Tokens runs and DO t1-t6
  (`timeouts.tsv`; t2 has no report, and t7 was still running). None is given back.
- Corpus, 72 of 72 modules: 13 sites given back. Filter Tokens gives back 8 helper bodies, all killed on v3. That is prediction 2
  missed in part: 3 of the 11 stay refused, because they still reach an exit-read name. Azure AD user sync gives back 5 bodies,
  all `error` on v3.
- DO: 1 site given back, the body of a logging procedure with no loop (`CDOEMailTemplateManagement`:104). No window reached it.
- Fixtures byte-identical; no golden moves.
- t7's timeouts are checked against the given-back list when t7 ends, before the merge.

**Part 2: R1061, the narrowed rule B.** `lethal.remove-assignment` of `X := <value>` in straight-line code before a loop of the
same procedure is hang-refused only when all of these hold:
1. The loop's exit reads X in a comparison whose value at X's DEFAULT (0, '' or false) keeps the loop running, read with rule A's
   polarity walk (`not`, `and`, `or`). For a number, only the strict bound forms count: `Y < X`, `X > Y`, `Y <> X` with Y a
   counter the body increments from a non-negative start. With X at 0, `Y < X` is false for every Y >= 0, so an `until` on it
   never ends.
2. The assigned value is not X's default: `X := 0` is never refused.
3. Nothing in the loop can write X: not a direct write, not a `var` argument, not a same-object call whose body writes X (R830's
   reach), and not a call to an event publisher of X's object (an event subscriber may write it). If X is a global and the body
   raises any event or calls outside the object, the rule does not refuse (R830's blind spot).
4. X is a local variable or a global of the same object, not a field.

**Part 2 acceptance** (as PR-44's): kept only if, measured alone on the 72 BC.History modules and DO, it reaches PR-37's bar (about
1 hang per 8 scored sites lost) AND moves no fixture site and no emit golden. M7544's site (DO `CDOeDocsSendCodeMigration`:285,
`until BatchCounter < CommitBatchSize`) must be refused, and sandbox-hang's 3 and sandbox-optin's 1 (PR-44) must not. Otherwise it
is dropped by an addendum, with its figures. Unit tests are red both ways per condition.
