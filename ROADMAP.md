# LethAL Roadmap — open work and known limitations

Living list of everything known-but-not-done: planned work, correctness risks we have measured and
not yet closed, and product gaps a real user would hit. Session ledgers under `.superpowers/` are
scratch and get archived; **this file is the durable record.**

## How to use this file

- **Add an item the moment it is discovered**, even mid-task — one line of "what breaks, for whom"
  beats a perfect write-up later. Items get a stable `R<n>` id; never renumber, never reuse an id.
- **Every item names its evidence** — a file, a commit, a measured result. An item with no evidence
  pointer is a rumour, not a roadmap entry.
- **Status:** `open` · `in progress` · `blocked (<on what>)` · `done (<commit>)`.
- **Closing an item:** mark it `done` with the commit, leave it in place for one release cycle, then
  delete it. Deleted items live on in git history.
- **Do not** duplicate what the code or `design.md` already says. This file records what is *missing*
  or *wrong*, not how the system works.

Priority is deliberately not a column: the ordering inside each section is the priority.

---

## Next up

| id | item | status |
|---|---|---|
| **R10** | **Tier-2 Phase 1 — the first real Tier-2 operators.** Spec: `docs/superpowers/specs/2026-07-25-tier2-mutation-operators-design.md`. Phase 0 (merged 2026-07-25) proved table triggers mutate, execute and kill on a live server; Phase 1 writes the operators that target them. | open |
| **R12** | **Live proof of a dedup collision.** `dedupeSpecs` is unit-proven and runs on the live path, but no two Tier-1 operators claim the same site, so the collision branch has never fired against a real server. Do it at Phase 1's gate, with a real Tier-1/Tier-2 overlap — do not fake one with a throwaway duplicate operator. | blocked (R10) |
| **R11** | **`tierRank` has no tier-3 rank.** A tier-3 operator colliding with a tier-1 one hits "cannot order" and throws instead of resolving by precedence. Fix when tier 3 becomes real. | blocked (R13) |
| **R13** | **Tier-3 operators.** Design not started; sequenced after Tier 2 ships. | open |
| **R15** | **Custom environment tool support** — run LethAL against environments owned by an external CLI (first case: Continia's `continia.exe`), described purely in config: tool path plus command templates for create / resolve / symbols / publish / delete. The tool provisions; LethAL's fenced `RunMutant` path still decides every verdict. Spec: `docs/superpowers/specs/2026-07-26-custom-env-tool-design.md`. **First task is a live probe** of bc-dev-mcp against a Continia env — it decides whether coverage is `"procedure"` or falls back to `"none"`. | open (spec approved) |

## Correctness risks (measured, not closed)

| id | item | status |
|---|---|---|
| **R1** | **Fenced-path write permissions.** `RunMutant` executes under the OData runner session, which does not hold the target test app's write permissions: a test that INSERTs fails with *"Sorry, the current permissions prevented the action"* while passing everywhere else. The fixture worked around it with `InherentPermissions = RIMD` (`fixtures/sandbox-data/src/*.Table.al`) — **a real customer table will not carry that**, so any project whose tests write to its own tables hits this. Needs its own answer before Tier-2 trigger operators are usable outside the fixture. Evidence: `fixtures/README.md` §Tier-2 Phase 0. | open |
| **R2** | **Single-tenant containers only, unenforced.** The harness reports `tenantCountReachable:false` — AL cannot enumerate tenants from an extension — so the 5C-B1 lease cannot fence a second tenant, and app publication is service-instance-wide regardless. Verify single-tenancy out of band (`Get-BcContainerTenants`). Evidence: `fixtures/README.md` §"Single-tenant containers only". | open (documented limitation) |
| **R8** | **al-runner drops a table global var written by a trigger.** After `Validate("No.", 'B2')` the fixture's `TouchCount()` returns 0 there, though the trigger body demonstrably ran. Unchased. Any mutant whose only observable effect is table-global state may be misjudged on that backend. Evidence: `fixtures/README.md` §Tier-2 Phase 0, last paragraph. | open |

## Product gaps a real project hits

| id | item | status |
|---|---|---|
| **R3** | **Selector object ids are hardcoded.** `DEFAULT_SELECTOR_IDS` in `packages/runner/src/cli.ts` pins 79197–79199 with no flag and no config key. A project whose `idRanges` exclude those three cannot be instrumented at all (`alc` rejects with AL0297). | open |
| **R4** | **Two instrumented projects cannot share one BC container** — a direct consequence of R3: publishing a second one fails with *"The application object of type 'CodeUnit' with the ID '79197' is defined in multiple apps"*. Multi-project users hit this immediately. Closed by fixing R3. | blocked (R3) |
| **R5** | **The report does not say how much of the project was skipped.** Object kinds the selector var cannot be injected into (page, report, query, xmlport) are dropped at spec generation with a stderr warning only, so a page-heavy project can get a confident-looking score computed over a small fraction of its code. Wants an explicit "N files not instrumented" field on the report itself. | open |
| **R6** | **A file declaring two AL objects is refused outright.** Legal AL, rare in practice. Every layer below `objectHeaderOf` assumes one object per file — the real fix is per-object attribution, not a looser check. Refusal is correct until then. Evidence: `packages/schemata/src/project.ts`, commit `81c1e96`. | open |

## Backends and tooling

| id | item | status |
|---|---|---|
| **R7** | **al-runner's `asserterror` never fails a test** — `asserterror I := 1;` is reported `pass`, so any mutant killable only by an `asserterror` assertion comes back SURVIVED there while bcdev kills it (measured: 0/7 vs 3/2/2 on the table fixture). Under-reporting only, never a false kill. The CLI now warns once per al-runner session; a stronger answer is a startup canary that runs a known-failing `asserterror` and refuses or hard-warns, or an upstream fix. Evidence: `fixtures/README.md` §Tier-2 Phase 0, `scripts/probe-alrunner-tables.ts`. | open (mitigated by warning) |
| **R9** | **`itest:tables` runs its session once**, where `itest:bcdev`/`itest:alrunner` run twice and assert run-to-run equality. Cross-run nondeterminism there surfaces as a confusing per-mutant baseline mismatch rather than an explicit determinism failure. | open |
| **R14** | **Stay on the newest tree-sitter-al.** Policy, not a defect: a grammar bump silently changed node shapes once (v2.5.0 → v3.0.1 inserted container nodes and zeroed `statementCalls` 703,239 → 0). The bump procedure — corpus site counts plus a **per-site** baseline proof, not a multiset signature — is in `packages/engine/vendor/README.md`. Re-check on every upstream release. | recurring |

---

**Recently closed** (delete these once a release has passed):

- Tier-2 Phase 0 — table triggers mutate, execute and kill on a live server; merged 2026-07-25 (`841069c`), frozen at `itest:tables` 3 killed / 2 survived / 2 no-coverage.
- Coverage keyed on `(objectType, objectId)` rather than the bare id (`6e89948`) — a table and a codeunit sharing an id sent a trigger mutant at the wrong object's tests.
- Per-mutant time budget floored at 30 s (`ab58469`) — an unfloored `2 × baseline` quarantined a cold start as in-flight-unknown.
