# Roadmap Execution Plan — sequencing every open item

**Goal:** clear `ROADMAP.md` R1-R25 in an order that puts wrong-verdict risks first, unblocks real-project use second, and ships features third — running independent work in parallel where the shared state allows it.

**This is a program plan, not an implementation plan.** Each wave below names the per-subsystem plan to write when that wave starts (via `superpowers:writing-plans`). Writing twenty-one bite-sized task lists now would be fiction: half of them depend on what the wave before them learns.

**Status:** written 2026-07-26, immediately after Layer 6C merged. Open items at that moment: R1-R14 (minus R15/R16, done) and R17-R25.

---

## The three constraints that shape everything below

**1. One implementer per working tree.** Two implementers sharing a tree corrupted a `git add` in an earlier layer — one agent staged another's in-flight work. Parallel streams get isolated worktrees (`isolation: "worktree"`), no exceptions.

**2. Live gates cannot share a server.** The lease is machine-global and BC publication is service-instance-wide, so two streams gating against one container will fence each other out or, worse, publish over each other. Each parallel stream needs its own target. **R15/R16 made this cheap:** a Continia environment now provisions in ~6.5 minutes at no cost, so a stream can own one for its lifetime instead of queueing for a container. That is the single biggest enabler of the parallelism below — before this week it would not have been affordable.

**3. Frozen baselines are shared state.** `bcdev.baseline.json`, `al-runner.baseline.json`, `tables.baseline.json` and `envtool.baseline.json` are per-mutant verdict records. If two streams both change what a mutant does, whoever merges second must re-run the gates and reconcile — a baseline conflict is a real regression signal, never a merge artifact to resolve by picking one side. **Merge order is therefore part of the plan, not an afterthought.**

---

## Wave 0 — the sweep (one stream, start immediately)

Small, mechanical, all in code written this week while the context is still fresh. Batched deliberately: each is too small to justify its own review cycle, and together they clear the noise that would otherwise obscure real findings in later waves.

| id | item | why now |
|---|---|---|
| **R24** | make `validateEnvToolConfig`'s `bcdevDeclaredKeys` parameter required | a future second caller silently losing the "two sources, one value" guard is exactly the class of defect this project keeps finding late |
| **R23** | refuse `username`/`password` in `envTool.publish.reads` | closes the one path where credential-withholding would silently break version-conflict recovery |
| **R25** | stale-control-app detection | cost real time during the first gate run; a verifier check naming the real cause beats BC's parameter error |
| **R22** | five one-line test-quality gaps | each survives a mutation today; they rot if deferred |
| **R18** | warn when `envTool` is configured with `--backend al-runner` | a whole ignored config section deserves what a single ignored flag already gets |
| **R21** | stop requiring `altool.exe` on the env-tool path | confusing gate on a path that never uses it |
| **R17** | read the crash-recovery record (`readdir` + warn on stale entries) | the recovery story for a leaked environment is currently a file nothing reads |
| **R2** | single-tenant enforcement: document or check | tiny; unchanged since 5C, still unenforced |
| **R9** | make `itest:tables` run twice like its siblings | determinism failures should say "nondeterministic", not "baseline mismatch" |

**Plan to write:** none. This is a single task list; dispatch it as one implementer with the nine items and a red-check requirement per item.

**Gate:** unit suite + one bcdev container run. No new environment needed.

---

## Wave 1 — parallel: correctness and real-project blockers (four streams)

Everything here is independent in both file scope and gate target. Start all four together.

### Stream A — R1: fenced-path write permissions ⭐ highest value

`RunMutant` runs under the OData runner session, which lacks the target test app's write permissions, so a test that INSERTs fails with *"the current permissions prevented the action."* The fixture only passes because it carries `InherentPermissions = RIMD`; **a real customer table will not.**

This is investigation-first, not implementation-first: the answer might be a permission set the control app grants, running the test under a different session context, or something the BC platform simply does not allow. Budget for the possibility that it ends in "documented limitation" rather than a fix — and if so, that outcome must be written down as loudly as a fix would be, because it bounds what Tier-2 trigger operators can promise.

- **Owns:** its own Continia environment (create-mode, deleted at the end)
- **Plan:** write one after the investigation spike, not before
- **Blocks:** the trigger half of Tier 2 (Wave 2b)

### Stream B — R3 + R4: configurable selector object ids

`DEFAULT_SELECTOR_IDS` pins 79197-79199 with no flag and no config key, so any project whose `idRanges` exclude them cannot be instrumented at all, and two instrumented projects cannot share one container. R4 falls out of R3 for free.

- **Owns:** a numbered container (`Cronus281`); touches `cli.ts` + `schemata`
- **Watch:** overlaps Stream C in `schemata` — see the merge order below

### Stream C — R5 + R6: honest reporting and multi-object files

R5: object kinds the selector var cannot be injected into are dropped with a stderr warning only, so a page-heavy project gets a confident score computed over a fraction of its code — the report needs an explicit "N files not instrumented" field. R6: a file declaring two AL objects is refused outright; the real fix is per-object attribution.

- **Owns:** a numbered container (`Cronus282`); touches `schemata/project.ts` + `report.ts`

### Stream D — R7 + R8: al-runner truthfulness

R7: al-runner's `asserterror` never fails, so any mutant killable only by an asserterror assertion is reported survived — currently mitigated by a warning; a startup canary that runs a known-failing `asserterror` and refuses would be honest. R8: a table global var written by a trigger does not survive the call there, unchased.

- **Owns:** nothing live — al-runner is offline
- **Note:** R7 may end upstream rather than here; that is a legitimate outcome

**Merge order for Wave 1:** D (no shared files) → B → C (both touch `schemata`; whoever is second rebases and re-runs both container gates) → A (may change fixture AL, so it re-runs everything). Re-run all four frozen gates after the final merge of the wave, not after each.

---

## Wave 2 — Tier 2, split so R1 does not block half of it

**This split is the point of the wave.** The Tier-2 spec contains operators that touch table writes and operators that do not. Blocking the whole layer on R1 would idle the most valuable work in the project.

### 2a — non-trigger operators (starts with Wave 1, does not wait for R1)

`remove-testfield`, `remove-setloadfields`, `swap-modify-flag` and the rest of the spec's non-trigger set. None depends on the fenced write-permission answer.

- **Plan:** `superpowers:writing-plans` against `docs/superpowers/specs/2026-07-25-tier2-mutation-operators-design.md`, scoped to the non-trigger operators
- **Owns:** its own environment
- **Delivers:** **R12** for free — the first real Tier-1/Tier-2 site collision is what finally exercises `dedupeSpecs`'s collision branch live, which no Tier-1-only run can do

### 2b — trigger operators (gated on Stream A)

Starts when R1 lands or is formally accepted as a limitation. If R1 ends as "documented limitation", 2b still ships, but its operators carry an explicit precondition and the docs say so.

---

## Wave 3 — Tier 3

**R13** (design not started) and **R11** (`tierRank` has no tier-3 rank, so a tier-3/tier-1 collision throws "cannot order" instead of resolving) belong in one wave: R11 is a two-line fix that is untestable until a tier-3 operator exists to collide.

Brainstorm → spec → plan, as Tier 2 had.

---

## Continuous — R14

**Stay on the newest tree-sitter-al.** Not a wave: a checkpoint at the start of each wave. The bump procedure in `packages/engine/vendor/README.md` requires corpus site counts plus a **per-site** baseline proof, because a bump once silently zeroed `statementCalls` from 703,239 to 0 and a multiset signature would not have caught it.

---

## What "done" looks like per wave

Every wave ends with: unit suite green, `bun run typecheck` clean, every frozen gate re-run and unchanged (or changed with a recorded, understood reason), the roadmap items marked `done (<commit>)`, and anything discovered along the way filed as a new `R<n>` rather than left in a session ledger.

## Ordering rationale, stated once

Wrong-verdict risks precede everything, because a tool that reports confidently and wrongly is worse than one that reports nothing — that is why R1 leads Wave 1 and why Wave 0's sweep front-loads the guardrails (R23, R24, R25) rather than the conveniences. Real-project blockers (R3/R4, R5/R6) come next, because Tier 2 shipping into a tool that only works on our own fixture is a hollow win. Features follow. Polish that cannot produce a wrong answer (R18, R21) rides along in the sweep rather than earning its own slot.
