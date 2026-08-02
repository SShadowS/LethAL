# Next-session prompt — R13, the Tier-3 program (and R11 behind it)

Paste/load this as the opening instruction of a fresh session.

---

Continue LethAL execution. Work autonomously; only stop to ask when a decision is genuinely mine
(a product call, or a hard-to-reverse / shared-infra action beyond what is authorised below).

The whole previous queue is closed. This one is different in kind from everything before it:
**R13 has no spec and no design.** Do not start writing operators. Start by deciding whether Tier 3
should exist in the shape `design.md` sketched two weeks ago, and produce a spec that survives
adversarial review before any code.

## Read first (in order)

- `ROADMAP.md` rows **R13, R11, R80, R81, R72**. R13 is the work; R11 is blocked on it; R80/R81 are
  small filed debts you may pick up if Tier 3 stalls; R72 is measured-but-unbuilt and explains why.
- `design.md` §"Tier 3 · Advanced" (the three sketched operators), §"Tier 3 emit path (noted)" and
  the two deferral notes near the end. That sketch is the ONLY design input and it is two weeks old.
- `docs/superpowers/specs/2026-07-25-tier2-mutation-operators-design.md` — how a tier spec is
  written here, and §310's note on what Tier 3 was expected to need.
- `docs/superpowers/specs/2026-07-31-r33-tier2-phase2-design.md` — read this one for METHOD, not
  content: it is the document where two confident conclusions were measured wrong and corrected in
  place. Tier 3 will produce more of those than Tier 2 did.
- `CLAUDE.md` — build/test loop (the dist trap bites every session), conventions, gate commands.
- `docs/measurements/README.md` — every platform claim this project trusts, and how each was
  measured. Tier 3 mutates object METADATA, so it will need new entries here before it needs code.

## State as of 2026-08-02 (master, pushed through `7c24942`)

- **Frozen gates:** `itest:bcdev` 3/10/3 · `itest:alrunner` 3/13/0 · `itest:envtool` 3/10/3 ·
  `itest:tables` **84 killed / 12 survived / 10 no-coverage over 106 deployed** (118 raw), with
  exactly one expected baseline failure, `Data Tests.PageActionComputesNonZero`.
- **LethAL Control 1.0.0.14** on Cronus281 and Cronus283. `MIN_CONTROL_VERSION` is in lockstep.
- Tier 2 now holds SIX operators: `RemoveTestField`, `RemoveSetRange`, `RemoveCalcFields`,
  `SwapModifyFlag`, `RemoveCommit`, `SwapRecXRec`.
- A per-mutant baseline guard (`tables.baseline.json`) refuses any changed verdict. Trust it, and
  see "re-freezing" below.

## The actual first task: decide whether Tier 3 survives contact with this codebase

`design.md` names three operators — `PermissionReduce`, `IsolationLevelSwap`,
`EventPublisherSignature` — and says they "mutate AL object metadata rather than
expressions/statements" and "need a distinct emit path and a narrower interface". Every one of
those clauses is an assumption written before Tier 2 existed. Test them:

1. **Is the emit path actually distinct?** `schemata` instruments by wrapping executable sites in a
   runtime guard (`if MutationSelector.Active(...) then`). Object metadata is DECLARATIVE — you
   cannot wrap `Permissions = TableData X = RIMD;` in an `if`. So either Tier 3 needs a different
   activation mechanism (one artifact per mutant? a compile-time variant?), or those operators are
   not implementable in this architecture at all. **Answer this before anything else** — it decides
   whether R13 is one spec or three separate programs, and it may kill an operator outright.
2. **Is any of the three worth it?** Same standard as R69: a number before a decision, and the
   threshold written down BEFORE the number is known. Count candidate sites on `/u/Git/do-rel2`
   (Cloud is 28.4.0.0 and matches the deployed app; `scripts/measure-testpage-exclusive.ts` shows
   how to census a real project offline). An operator with no sites in a real app does not ship.
3. **What can each one actually KILL?** `PermissionReduce` weakens a permission set — the mutant
   dies only if a test exercises a path the reduced set forbids. On the fenced path, permissions
   are already a live subject (R1, R26, R35, R66): `TestPermissions = Disabled` on the test codeunit
   means the test body is NOT permission-stripped. Work out whether that makes `PermissionReduce`
   unkillable by construction here, and MEASURE it on `fixtures/sandbox-probes` rather than
   reasoning about it. If it is unkillable, that is a finished answer, not a failure.

Only after those three: write the spec, run `spec-adversary` on it, then plan.

## R11 rides along, and it is small

`tierRank` (`packages/schemata/src/dedup.ts:26`) returns `NaN` for anything that is not tier 1 or 2,
and `dedupeSpecs` THROWS on an unorderable pair rather than guessing. So the first Tier-3 operator
that collides with a Tier-1 one at the same site crashes the run. The fix is one line plus a test —
but do NOT apply it speculatively: it is only correct once you know Tier 3's precedence relative to
Tier 2, and that is a spec decision, not a code decision. Close R11 in the same change that
registers the first Tier-3 operator, never before.

## Authorised without asking

- Publishing `LethAL Control` and the fixture apps to **Cronus281** and **Cronus283**
  (`$env:DOCKER_CONTEXT='desktop-windows'` FIRST — the session default is the Linux engine).
- Running any `itest:*` gate. Foreground, never poll; they take minutes.
- Starting/stopping the Continia environments via `U:/Git/CLI/continia.exe` (`env start|stop <id>`),
  and returning them to `Stopped` afterwards. `lethal-do-trial` = `f19aca88…`, the envtool gate's =
  `a8f54c93…`.
- Container recovery when a run wedges: `force-reset-lease`, then `clear-quarantine`, and a Docker
  restart only if the NST is genuinely stuck.

## Working style — the parts this project learned the hard way

- **Measure, do not reason, about BC.** Every unmeasured confident claim in the last two sessions
  was wrong at least once, including three that had to be retracted from `ROADMAP.md` after being
  written there.
- **Verify a row's prescribed fix against the code BEFORE implementing it.** R79's prescribed guard
  would have refused a legitimate shape this repo's own fixture has; R72's adversarial hazard turned
  out to be impossible; R71's blanket no-go came from a measurement that never covered the sites it
  was applied to. Three for three in one session.
- **A detector's premise must be an executable assertion, not a comment.** The R70 live detector
  worked only because R68 stayed open, that premise was written as a source comment, and it took an
  adversarial review to notice. The premise test that replaced the comment then fired exactly as
  designed when R68 landed one commit later. Any new detector gets the same treatment.
- **Prefer discriminants that are positive properties of code you own** over ones routed through the
  ABSENCE of a capability — absences are what future work erodes.
- **Red-check every load-bearing test** with `mutation-red-checker`, and READ ITS CAVEATS. On R70 it
  reported 23 tests going red and still named the real hole: none of them exercised the property.
  On R66 it found that the "no stack frame" test was protected by an unrelated part of the pattern.
- **Re-freezing `tables.baseline.json` is the one step that can silently launder a regression.**
  Always keep the previous file and diff it: report entries added, entries gone, and same-key
  verdict changes separately. "0 pre-existing changed" is the claim worth making; if a key
  legitimately changes (an operator flip), say so explicitly.
- **Adversarial review is cheap and it paid for itself.** `Agent(subagent_type: general-purpose,
  model: "fable")` refuted a fixture design before it shipped, on a parse-order argument I had not
  considered. Use it on the Tier-3 spec.
- Report per step: what shipped, what you verified, and — explicitly — what you did NOT prove.
- `ROADMAP.md` is the durable record; `.superpowers/` ledgers are gitignored scratch.

## If Tier 3 turns out not to be worth building

That is a legitimate outcome and it is the same shape as R69: close R13 as "designed, measured
unprofitable", record the measurement in `docs/measurements/README.md`, unblock R11 by giving
`tierRank` a documented reason to stay two-tier, and move to R80 (two AL comment-strippers that
disagree about string contents) and R81 (`buildCallerIndex` keys call sites on the bare owner name —
R70's sibling, filed unmeasured and asking for a measurement before a fix).
