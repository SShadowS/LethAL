# `lethal campaign` and the Campaign Method Skill Implementation Plan (subsystem D)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the campaign gate machinery that already exists but is hardcoded to one campaign, make "committed before the run" machine-checked rather than trusted, and capture the measurement method as a skill that loads when it is needed.

**Architecture:** Three existing scripts become `lethal campaign` subcommands with a parameterised records directory and a git-cleanliness refusal. A skill carries the five method rules the tool cannot enforce.

**Tech Stack:** Bun + TypeScript, `bun:test`, a Claude Code skill.

**Spec:** `docs/superpowers/specs/2026-08-05-observability-and-campaign-method-design.md`, section D. Read it before starting.

**Scope:** Subsystem D only. `lethal explain` (B) and the tool features (C) have their own plans. None depend on this one — though if C lands first, the skill should reference `lethal doctor` in its preflight sequence.

## Why the machinery exists but is unfinished

`campaign-anchors.ts`, `campaign-anchors-run.ts` and `campaign-freeze.ts` were written during the 2026-08-03 DO campaign, for a stated reason in `campaign-anchors-run.ts`'s own doc comment:

> *"an operator running them ad hoc against a live billed environment is where 'I printed the results and they looked fine' replaces a gate."*

But `campaign-freeze.ts:37` pins `const RECORDS_RELATIVE = "docs/campaign/2026-08-03-do"`. The next campaign forks the file or edits a constant.

**And the discipline's spine is still on the honour system.** The method says pre-commitments are committed BEFORE the run. Nothing checks it. That is one `git status` call away from being mechanical.

## Global Constraints

- **No `!` non-null assertions** — biome `noNonNullAssertion: error`.
- **`exactOptionalPropertyTypes`** — `...(v !== undefined ? { k: v } : {})`.
- **Fail loudly on caller-contract violations.** Throw; never return a plausible empty default. **This subsystem is gate machinery — a gate that passes while measuring nothing is the failure it exists to prevent.**
- **Build order:** `bun run typecheck` FIRST, THEN clear each package's `dist` (six literal deletes; the globbed form is blocked by a safety hook, and `packages/builtin-tier2/dist` is not in CLAUDE.md's list but goes stale), THEN `bun test`.
- **Report the FULL `bun run typecheck` output in every task report.**
- **Do not scaffold.** `lethal campaign init` writing empty pre-commitment templates was considered and REJECTED: the value of those files is their content and their git-history ordering, and a scaffold supplies neither.

## File Structure

| path | responsibility |
|---|---|
| `packages/runner/src/campaign-freeze.ts` | **Modify.** Records directory becomes a parameter, not a constant. |
| `packages/runner/src/campaign-manifest.ts` | **New.** Reads a small campaign manifest naming the records dir. |
| `packages/runner/src/campaign-git.ts` | **New.** The cleanliness check: refuse if a pre-commitment file is uncommitted or dirty. Injected `git` runner so it is testable. |
| `packages/runner/src/cli.ts` | **Modify.** `lethal campaign freeze \| anchors \| compare`. |
| `scripts/campaign/{freeze,anchors,compile-only}.ts` | **Modify.** Thin shims over the subcommands, or deleted if the subcommand fully replaces them. |
| `.claude/skills/measurement-campaign/SKILL.md` | **New.** The method. |
| `packages/runner/tests/campaign-git.test.ts` | **New.** |
| `packages/runner/tests/campaign-manifest.test.ts` | **New.** |

---

### Task 1: The git-cleanliness refusal

**Do this first.** It is the piece that converts a discipline into a check, and it is small.

**Files:**
- Create: `packages/runner/src/campaign-git.ts`
- Test: `packages/runner/tests/campaign-git.test.ts`

**Interfaces:**
- Produces: `assertCommitted(paths: readonly string[], deps: { readonly status: (p: string) => Promise<string> }): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { assertCommitted } from "../src/campaign-git";

describe("assertCommitted — 'committed BEFORE the run', made mechanical", () => {
  test("a clean, tracked file passes", async () => {
    await expect(assertCommitted(["docs/campaign/x/rung1.precommit.md"], { status: async () => "" })).resolves.toBeUndefined();
  });

  test("a MODIFIED file is refused, naming it", async () => {
    await expect(
      assertCommitted(["docs/campaign/x/rung1.precommit.md"], { status: async () => " M docs/campaign/x/rung1.precommit.md" }),
    ).rejects.toThrow(/rung1\.precommit\.md/);
  });

  test("an UNTRACKED file is refused — the commonest way to skip the discipline", async () => {
    await expect(
      assertCommitted(["docs/campaign/x/rung1.precommit.md"], { status: async () => "?? docs/campaign/x/rung1.precommit.md" }),
    ).rejects.toThrow(/untracked|not committed/i);
  });

  test("the refusal explains WHY, not just what", async () => {
    try {
      await assertCommitted(["p.md"], { status: async () => "?? p.md" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(String((err as Error).message)).toMatch(/before the run|after seeing/i);
    }
  });
});
```

- [ ] **Step 2: Run to confirm failure, then implement**

`assertCommitted` throws on any non-clean status for the named paths. The message must say why the rule exists — *a pre-commitment written or edited after the run is not a pre-commitment* — because a bare "file is dirty" invites the reader to `git add` and carry on, which is precisely the thing being prevented.

- [ ] **Step 3: Suite, lint, commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/engine/dist && rm -rf packages/operator-sdk/dist && rm -rf packages/builtin-tier1/dist && rm -rf packages/builtin-tier2/dist && rm -rf packages/schemata/dist && rm -rf packages/runner/dist && bun test packages/runner/tests/campaign-git.test.ts
bunx biome check packages/runner/src/campaign-git.ts packages/runner/tests/campaign-git.test.ts
git add packages/runner/src/campaign-git.ts packages/runner/tests/campaign-git.test.ts
git commit -m "feat(campaign): refuse to freeze against an uncommitted pre-commitment"
```

---

### Task 2: Parameterise the records directory

**Files:**
- Create: `packages/runner/src/campaign-manifest.ts`
- Modify: `packages/runner/src/campaign-freeze.ts`
- Test: `packages/runner/tests/campaign-manifest.test.ts`

**Interfaces:**
- Consumes: `freezeRungTo(reportPath, rung, expectedCount, recordsDir)` — already exists and already takes the directory; only `freezeRung`'s default is hardcoded.
- Produces: `readCampaignManifest(path): CampaignManifest` where `CampaignManifest = { readonly recordsDir: string; readonly campaignId: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
test("a manifest names its records directory", () => {
  const m = readCampaignManifest(fixturePath("campaign.json"));
  expect(m.recordsDir).toBe("docs/campaign/2026-08-03-do");
});

test("a manifest missing recordsDir throws, naming the field and the file", () => {
  expect(() => readCampaignManifest(fixturePath("campaign-missing.json"))).toThrow(/recordsDir/);
});

test("the records dir resolves against the repo root, never process.cwd()", () => {
  // campaign-freeze.ts already walks up to `.git` for exactly this reason — a cwd-relative
  // path silently creates a records tree somewhere else and reports success.
  const resolved = resolveRecordsDir({ recordsDir: "docs/campaign/x", campaignId: "x" });
  expect(resolved).toMatch(/^[A-Za-z]:/);
});
```

- [ ] **Step 2: Implement, preserving the `.git` walk-up**

`campaign-freeze.ts` already resolves via a `.git` walk-up from `import.meta.dir` rather than `process.cwd()`, with a doc comment explaining that a cwd-relative path *"would silently create a records tree somewhere else and report success"*. **Keep that mechanism** — only the directory NAME becomes a parameter.

Note for the implementer: `.git` is a FILE in a worktree, not a directory. The existing walk-up uses `existsSync`, which is indifferent — do not "fix" it to `statSync().isDirectory()`.

- [ ] **Step 3: Suite, commit.**

---

### Task 3: The `lethal campaign` subcommands

**Files:**
- Modify: `packages/runner/src/cli.ts`
- Modify: `scripts/campaign/{freeze,anchors}.ts` — thin shims or deleted
- Test: `packages/runner/tests/cli.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test("campaign freeze refuses when the pre-commitment is uncommitted", async () => {
  // The whole point: "committed before the run" is now checked, not trusted.
  await expect(runCampaignFreeze({ ...args, gitStatus: async () => "?? rung1.precommit.md" })).rejects.toThrow(/precommit/);
});

test("campaign anchors exits non-zero when an anchor fails", async () => {
  const code = await runCampaignAnchors({ ...args, report: reportWithFailingAnchor() });
  expect(code).not.toBe(0);
});

test("campaign anchors asserts cardinality BEFORE reading any anchor", async () => {
  // assertMatchesBaseline self-records when the baseline file is absent, so a cardinality
  // check running second would freeze a truncated report and compare it against itself.
  const order: string[] = [];
  await runCampaignAnchors({ ...args, onStep: (s) => order.push(s) }).catch(() => {});
  expect(order[0]).toBe("cardinality");
});
```

- [ ] **Step 2: Wire the three subcommands**

`freeze`, `anchors`, `compare`. Each reads the campaign manifest, resolves the records dir, and calls `assertCommitted` on the relevant pre-commitment/anchor file **before doing anything else**.

- [ ] **Step 3: Reduce the scripts to shims**

`scripts/campaign/*.ts` either become one-line shims over the subcommands or are deleted. State which you chose. `compile-only.ts` stays a script — it is gate-0 tooling, not a campaign subcommand.

- [ ] **Step 4: Add to help and `README.md`. Suite, commit.**

---

### Task 4: The measurement-campaign skill

**Files:**
- Create: `.claude/skills/measurement-campaign/SKILL.md`

Read `.claude/skills/recover-tier/SKILL.md` and `.claude/skills/coverage-differential/SKILL.md` first — 117 and 87 lines, and both opinionated about what earns a skill. **This repo's house test: a skill earns its place by encoding "the mistake to expect."** `recover-tier`'s whole reason to exist is that *a restart looks like it should have been enough*.

- [ ] **Step 1: Write the frontmatter and trigger**

```markdown
---
name: measurement-campaign
description: Use when running LethAL against a real project or customer app, measuring a real codebase's suite, comparing two live runs, or writing a pre-commitment for any of those. Drives live, billed environments.
---
```

Model-invocable — unlike `recover-tier` it mutates nothing itself, and the live commands it sequences are permission-gated anyway. But the description must say it drives live, billed environments.

- [ ] **Step 2: The five method rules, each with the measured error that produced it**

Not principles — checkable rules, each carrying its evidence:

1. **Pre-commit expectations to a committed file before the run.** This is what made the campaign's two errors visible *as* errors rather than as results.
2. **Assert cardinality before any anchor reads the report.** Caught a units error: `--dry-run` reports mutation *sites*, `SessionReport.mutants[]` holds *deployed* mutants after dedup. 176 → 148 on real code. Predicting one from the other is what broke rung 1's gate.
3. **Gates carry forward across rungs unless retired IN WRITING before the run.** *This rule exists nowhere else.* It is the fix for a recorded plan defect: rung 1's "baseline green" anchor was silently not carried into rung 2, and rung 2 came back `baseline-red` with no gate to catch it.
4. **Retire, don't retune — and name the replacement.** A stale coverage anchor was retired and superseded by the per-mutant baseline, not rewritten into a tautology. Rewriting an expectation after seeing the data is the rationalisation the pre-commitment rule exists to prevent.
5. **Record negative results.** The model: *"R31's detector was not exercised, and no hole in it is demonstrated."* An unreproduced finding is a finding.

- [ ] **Step 3: The rest of the skill**

- **The rung ladder**: mechanics → repeatability → consumer, each gated before the next.
- **Module selection by MEASURED coverage, not name-matching.** A campaign module picked because a test area *mentioned* its codeunits came back 66% no-coverage against another rung's 10%.
- **Narrow tests, not mutants, as the cost lever.** Baseline was 69% of one rung's wall clock because it is paid PER BATCH (R45). Mutant median was 433 ms.
- **Screen candidate modules for `TestPage` in their covering tests.** A baseline `in-flight-unknown` quarantines unconditionally and the stop machinery does not reach the baseline; R69 Task 7 measured that hang deterministic and unrescuable.
- **Prefer `--resume-run <id>` over bare `--resume`** until R89 closes — with the R89 pointer, so the workaround dies when the defect does.
- **Point at the target stack's own provisioning runbook.** The LethAL skill stays customer-agnostic; it says only that such a runbook must exist and that the publish-before-deps ordering class is the kind of thing it must state.

- [ ] **Step 4: Say why this is not CLAUDE.md restated**

CLAUDE.md's rules govern *code changes* — red-check a fix, per-mutant gates on frozen fixtures. These govern *measurement campaigns*, and rules 1–5 appear nowhere in it. The empirical proof they are not redundant: the campaign followed CLAUDE.md's discipline throughout **and still made both errors**; the campaign gates caught them because they encode something CLAUDE.md does not.

- [ ] **Step 5: Commit**

```bash
cd U:/Git/LethAL && git add .claude/skills/measurement-campaign/SKILL.md
git commit -m "feat(skill): the measurement-campaign method, with each rule's measured error"
```

---

## Out of scope, deliberately

**The Continia provisioning runbook.** Bare-sandbox `deps install`, the publish-before-deps ordering, `continia deploy`'s AppSourceCop failure, alc 17 living inside `continia.exe`, replacing catalogue symbols with a local build for a promotion branch — that is **one customer stack's facts**, and two of the five will age with `continia.exe` releases LethAL cannot test. It belongs in a runbook beside the campaign records or in the CLI repo, not in this skill.

## The live gate

None of this subsystem changes an execution path — it is gate tooling and documentation. Run the full unit suite and typecheck.

**If C has already landed**, add `lethal doctor` to the skill's preflight sequence.
