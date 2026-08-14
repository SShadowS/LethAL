# R135: the mechanism for declarative surfaces — measurement, ruling, and what the ruling costs

Written 2026-08-14. `docs/roadmap/R135.md` asks for one decision before any operator can be
specified against FlowField `CalcFormula`, query objects, or filter-bearing properties, and says the
decision needs a measurement. This is that measurement and that ruling.

No operator is specified here, deliberately. An operator spec written against a mechanism that does
not exist is the speculative-fix shape R11 refused.

## 1. The problem, restated in one paragraph

LethAL's mechanism is a runtime guard wrapped around executable AL: every mutation in a batch ships
in ONE artifact, and a selector decides at run time which one is active. A property cannot dispatch
at run time. `isMutableSite` (`packages/schemata/src/enclosing.ts`) therefore drops every declarative
site, correctly — there is no statement to wrap. That leaves the whole declarative surface
unreachable no matter how many operators ship, and the only alternative deployment is one artifact
per mutant, with the mutation applied in SOURCE.

## 2. The measurement

`scripts/r135-publish-probe/` — a two-table app whose only interesting member is a FlowField whose
`CalcFormula` carries a `where(... "Category" = const('A'))` condition. The driver alternates that
literal between A and B, republishes an unchanged build as a control, and adds/drops an ordinary
stored field as a real schema change. Cronus281, BC 28.0.46665.47126, `alc` 18.0.38.8509, 13 publishes.

    property-changed   publish + sync + install median  4404 ms  (n=3)
    no-change control  publish + sync + install median  4433 ms  (n=3)
    schema-changed     publish + sync + install median  4351 ms  (n=6)
    compile median 664 ms; cold first publish 5278 ms

**The publish is the cost, and what changed does not move it.** All three categories are within noise
of each other.

Two consequences fall straight out.

**Option B is dead on its own terms.** R135's Option B restricts declarative mutations to
schema-neutral rewrites "so ForceSync stays cheap". There is no cheap ForceSync to protect: a
schema-neutral change and a schema change cost the same, and so does changing nothing. Option B would
shrink the reachable surface and buy nothing on the axis it was proposed for. It is rejected on
measurement rather than on judgement.

**4.4 s is a floor, not a per-mutant cost on a real project.** BC publishes whole extensions, so a
per-mutant artifact for a real app is a whole-project publish. The measured figure for one:

| what | measured | source |
| --- | --- | --- |
| this probe, 2 tables, local container | 4.4 s publish + 0.66 s compile | this wave |
| Continia Document Output, whole project, one deploy | 40.8 s | R45 |
| DO, single file, 176 guards, hosted | 36–97 s | R90 |
| DO, single file, 331 guards, hosted | publish TIMES OUT | R90 |

## 3. The arithmetic Option A implies

Today's DO campaign (R45's first live run, 163 mutant sites after `--only`): total 1065 s =
generate 0.7 + **deploy 40.8** + baseline 863.8 + mutants 151.9 + overhead 8.5. One deploy, amortised
over every mutant in the batch: **0.25 s of deployment per mutant**. Per-mutant execution is a median
433 ms, p95 6.4 s (R91).

Under Option A each declarative mutant is its own artifact, so it pays a whole-project publish:

- at this probe's local floor, 4.4 s + compile — **~18x** today's amortised per-mutant deployment;
- at DO's own measured whole-project deploy, 40.8 s — **~163x**, because "amortised over 163" becomes
  "once each".

For the surface R135 names, the 658-file DO snapshot holds **91 CalcFormula lines** and **zero query
objects** (2026-08-12 census, recorded on the row). Deploying 91 declarative mutants:

- 91 x 4.4 s = **6.7 minutes** at the probe's floor, which no real project will see;
- 91 x 40.8 s = **62 minutes** at DO's own measured publish cost, deployment alone, against the
  40.8 s that campaign spends on deployment today for all 523 of its mutants.

## 4. The costs that are not time

Time alone would make Option A an expensive opt-in. Three further costs make it a second product.

1. **It is a second deployment mechanism, not a slower one.** Batching, `AlcCompileError`-driven
   bisection, resume, the deployment verifier's artifact-id echo, the 5C-B1 lease and the quarantine
   machinery all assume one artifact per batch with a selector inside it. A per-mutant artifact has
   no selector, no artifact-id echo to verify against a manifest of many mutants, and no meaningful
   batch to bisect. None of that is unbuildable; all of it is a parallel path through the layer this
   repo has spent the most correctness effort on.
2. **Publishing is the failure-prone step, and this multiplies it.** R44's proxy timeout quarantined
   a real run during deployment; R90 recorded publishes that return `{"success": false}` while
   exiting 0, and a per-file guard ceiling learned only by failing once. Those are per-publish risks.
   91 publishes is 91 chances, and a stranded tier costs ~10 minutes of recycle plus a manual
   `force-reset-lease` (R91).
3. **The `no-coverage` honesty problem does not go away.** A declarative mutant still needs a
   covering test, and coverage attribution for a FlowField is not the attribution problem this repo
   has solved: the mutated `CalcFormula` runs inside BC's own `CalcFields` implementation, not in AL
   the coverage map can name. Nothing measured says which tests reach it.

## 5. The ruling

**Option C, scoped: LethAL does not mutate declarative surfaces, and the report must say so.**

The refusal is not "declarative mutation is impossible" — the probe shows the deployment works fine
and costs 4.4 s. It is that the mechanism it requires is a second deployment path costing roughly
163x per mutant on the one real project this repo has measured, for a surface of 91 sites in 658
files, with the coverage question still unanswered. That is not a trade worth making before anyone
has asked for it.

Two things follow, and only the first is part of this ruling.

**Required.** The second half of Option C — "say so in the report" — is NOT implemented today, and
the ruling is incomplete without it. `generateMutationSet` already counts the dropped sites in
`nonExecutableSites` and emits a single `warn(...)` to stderr, where nothing can assert it and no
reader of a report will ever see it. That is the same unassertable-warning shape R140 and R132 were
about. Filed as **R144**.

**Not required, and not built.** Option A survives as a measured, costed opt-in that nobody has asked
for. Filed as **R145** so the measurement is not lost, explicitly blocked on demand rather than on
effort. Reopening it needs a user who wants FlowField coverage badly enough to pay an hour of
publishing, and an answer to the coverage question in §4.3.

## 6. What this ruling costs, named

- **91 CalcFormula lines** in the 658-file Document Output snapshot are unreachable. A wrong filter
  in a `CalcFormula` is a classic silent BC bug and LethAL will not find it. `lethal.remove-calcfields`
  mutates the executable `CalcFields(...)` CALL, which is a different bug; the formula itself is
  untouched.
- **Query objects**: zero in the DO corpus, so this surface has no measured population at all. A
  corpus that has them (BC.History) would need a census before the ruling could be said to cover it.
  Stated as a limit of the evidence, not as a claim that queries do not matter.
- **Filter-bearing properties** — `DataItemTableFilter`, `SourceTableView`, `RunPageLink`/`SubPageLink`,
  `TableRelation` conditions — are uncounted. The nearest figure is the 154 declarative specs across
  47 DO files that `isMutableSite` dropped when R40 first admitted pages (152 `negate-conditional`,
  2 `conditional-boundary`), which is a count of SPECS operators wrongly claimed, not of sites worth
  mutating. R144's report surface would turn that into a number a reader sees.

Grammar 4.0.x removed the PARSING blocker — single-entry links now parse as `link_value` with named
`where`/`field`/`const`/`upperlimit` markers — so this ruling is about deployment and cost, and
nothing about it is waiting on the grammar. If the ruling is ever revisited, the tree shapes are
already there.
