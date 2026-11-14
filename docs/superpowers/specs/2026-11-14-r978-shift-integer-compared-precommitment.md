# R-978 (R984) pre-commitment: shift-integer's comparison operands get compared-value; no gate figure moves

Written 2026-11-14 by lane code, before any gate run. The code is bugs' R984 half of lethal/r-971 (bafb1b91, build-reviewed there),
taken without R985 (the temporal stand-in), whose goldens and pins stay on R-971.

## The change

`shift-integer` sets R983's per-site `equivalenceRisk: "compared-value"` when its integer literal's parent is a
`comparison_expression` (by parse); an assigned literal keeps the operator's `value-rewrite`. The `compared-value` explanation text
now names any literal (`N = 5`), not only a blank toggle.

## Counted first (`/coord/handoff/R-978/count.out`)

Every `shift-integer` survivor in the stores under `/coord/handoff` whose project source still exists (68 projects), regenerated with
this code and joined on file and line: **208 of 448 distinct survivors (46%) sit in a comparison**, so they move from `value-rewrite`
("nothing downstream reads it") to `compared-value` in the report's likely-equivalent grouping. 0 lines held both kinds; 0 unjoined.

## Measured offline

Every fixture emitted with master's code and with this one (16): the only difference is `equivalenceRisk: "compared-value"` added to
15 `shift-integer` entries (sandbox-app 1, -codefree 1, -coverage-probe 4, -data 2, -harden-answers 5, -optin 2); every `.al` file
byte-identical. Re-pinned for that alone: three `fixture-emission` manifest hashes, the sandbox-data manifest hash
(`discovered-paths`, `per-file-refusal`) and the sandbox-data tree hash (`per-file-refusal`).

## Predictions

- **No gate figure moves.** Verdicts, killing tests and scores do not read the risk; the v3 baselines key on hashes and names; the
  harden gate's fixture (`sandbox-harden`) has no comparison `shift-integer` entry, so its `likelyEquivalentSurvivors` is unchanged.
- Unit: `r984-shift-integer-compared.test.ts`, red both ways (no site risk at all: the comparison case fails; the risk on every site:
  the assigned case fails).
