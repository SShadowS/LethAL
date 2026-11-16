# PR-54 pre-commitment: a keep census over the refusal ledger (the evidence step for inverting the keep-list)

Status: pre-commitment (coord PR-54, lethal-code, 2026-11-16), before the build. The proposal it serves:
`2026-11-16-pr53-setfilter-keep-and-general-fix.md` section 3. Keep the serve daemon after any `notRun` refusal, and close it only
on a timeout, a panic or a deny-list. The inversion itself comes back for a ruling. Families measured clean may join today's
keep-list in this task. Evidence: `/coord/handoff/PR-54/`. Invented AL only.

## The census

**Refusers (invented only).** These come from two sources:
- every refused cell of `scripts/refusal-family.ts`'s families, run on `current`;
- every upstream-repro test (`scripts/upstream-repros/`) that `current` refuses.
They are grouped into refusal classes by their stable text, as the generator's class key does. Up to 3 refusers per class are
measured.

**The kit, generalized.** A census mode of the generator (or a sibling script) does the following:
- it adds R-967's state, setter and reader objects (ids 50940-50999, clear of the families' 51000+) to each family app;
- it puts R-937's standard writes before each refused call;
- it drives one serve daemon per class.
Per refuser it runs 3 rounds of [refuser, reader] on a kept daemon, 1 two-entry request [refuser, reader], and 3 fresh-daemon
rounds. Every reader must equal the control (reader after setter); the reader also reports GlobalLanguage. The pid must stay
constant, with no panic text. Upstream-repro refusers in apps that cannot take the kit's objects are measured in their own app
with the kit's reader added beside them, or listed as not measured.

**Coverage.** Each ledger key (248 open, 24 unexamined) is mapped to a measured class by its stable text, or listed as
**unmeasured** (no invented refuser reproduces it).

**Verdicts per class:** CLEAN, NOT CLEAN (deny-list) or NOT MEASURED.

## Also in this task
- **Upstream question.** Does `serve` guarantee a clean session after ANY `notRun` refusal? That is: the refused test's store
  writes rolled back, and nothing else kept (SingleInstance, globals, GlobalLanguage, .NET handles, the sidecar). It is asked
  on an existing issue or a new one, with the census as evidence.
- **The DO saving.** From DO windows t1-t8's events (`/coord/handoff/R-984/`), count the refusal closes in the mutant phase by
  class. Price each at a daemon restart plus a warm-up, about 37 s. Give the saving under (a) today's keep-list plus this task's
  additions, and (b) the inversion.
- **Keep-list additions.** A class measured CLEAN that has closed a daemon in any DO window joins `V3_SERVE_SAFE_REFUSALS`, with
  a text anchored at both ends and leg C coverage, as in PR-47 and PR-53. Other clean classes are only reported.

## Predictions
1. Every measured class is CLEAN (no deny-list), or the deny-list is short and named.
2. A large share of ledger keys is unmeasured (corpus-only texts); the result gives the fraction.
3. Under the inversion, DO's saving is at least the GoToKey and SetFilter windows' share (t6, t7), and is stated per window.
4. Unit tests for the census mode: the kit objects' ids are clear, the standard writes are prepended, and classes are grouped.
   `itest:alrunner-v3` passes if keep entries are added.
