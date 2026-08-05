# Tool Features Implementation Plan (subsystem C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four independent product fixes measured during the 2026-08-03 DO live campaign — a budget default that strands real runs, a publish ceiling nobody can discover before paying for it, an environment check that fires too late, and a recovery path that needs a hand-materialised config.

**Architecture:** Four unrelated changes to `packages/runner`. They share no code and can land in any order, but C2 depends on fixing R65's bare `Error` first, so its steps are sequenced internally.

**Tech Stack:** Bun + TypeScript, `bun:test`, `bun:sqlite`.

**Spec:** `docs/superpowers/specs/2026-08-05-observability-and-campaign-method-design.md`, section C. Read it before starting.

**Scope:** Subsystem C only. `lethal explain` (B) and `lethal campaign` + the skill (D) have their own plans. None of the three depend on each other.

## Global Constraints

- **No `!` non-null assertions** — biome `noNonNullAssertion: error`. Destructure, then check `undefined`.
- **`exactOptionalPropertyTypes`** — build optional props with `...(v !== undefined ? { k: v } : {})`.
- **Typed error classes extend `Error` directly, never each other.** `AlcCompileError` (deterministic alc rejection) vs `ArtifactPrepareError` (spawn/IO/hash/manifest) vs `DeploymentError`. Bisection reads ONLY `AlcCompileError` as "subset does not compile". **C2 adds a new one — preserve this separation.**
- **Fail loudly on caller-contract violations.** Throw; never return a plausible empty default.
- **Build order:** `bun run typecheck` FIRST, THEN clear each package's `dist`, THEN `bun test`. Clearing before typecheck is pointless — typecheck regenerates it.
- **The globbed `dist` delete is blocked by a safety hook.** Use six literal per-package deletes. `packages/builtin-tier2/dist` is NOT in CLAUDE.md's package list and goes stale.
- **Report the FULL `bun run typecheck` output in every task report.** A task in the previous plan shipped a broken typecheck because nobody ran one after the change.
- **Lint only what you touched:** `bunx biome check <paths>`.
- **Git bash on Windows, Windows paths.** Never `2>nul` — use `2>/dev/null`.

## File Structure

| path | responsibility |
|---|---|
| `packages/runner/src/orchestrator.ts` | **Modify.** C1: the budget default. C3: move the environment probe to the front. |
| `packages/runner/src/bcdev-backend.ts` | **Modify.** C2: throw a typed publish error carrying `guardCount` and `file`. |
| `packages/runner/src/publish-ceiling.ts` | **New.** C2: the per-tier measured bracket — record outcomes, answer "is this file over the known ceiling?". Pure logic plus an injected store. |
| `packages/runner/src/store.ts` | **Modify.** C2: persist per-tier publish outcomes. |
| `packages/runner/src/doctor.ts` | **New.** C3: read-only preflight checks, composed from the refusals that already exist. |
| `packages/runner/src/cli.ts` | **Modify.** C3: the `doctor` subcommand. C4: env-tool resolution for `force-reset-lease`/`clear-quarantine`. |
| `.claude/skills/recover-tier/scripts/materialize-config.ts` | **Delete.** C4 removes the need for it. |
| `.claude/skills/recover-tier/SKILL.md` | **Modify.** C4: drop the materialise step; KEEP the restart-before-reset ordering. |

---

### Task 1 (C1): Raise the mutant budget default

The cheapest measured win in the spec. One constant, one comment, one test.

**Files:**
- Modify: `packages/runner/src/orchestrator.ts` (`MIN_MUTANT_BUDGET_MS`, currently line 97)
- Test: `packages/runner/tests/orchestrator.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `MIN_MUTANT_BUDGET_MS` unchanged in name and export, new value.

- [ ] **Step 1: Write the failing test**

Add to `packages/runner/tests/orchestrator.test.ts`:

```ts
import { MIN_MUTANT_BUDGET_MS } from "../src/orchestrator";

describe("MIN_MUTANT_BUDGET_MS (R91)", () => {
  test("is 180s — measured, not a guess", () => {
    // R91: at the old 30s floor, three consecutive runs against DO codeunit 6175297 each
    // stranded and quarantined the tier, costing ~10 min of recycle + force-reset-lease +
    // clear-quarantine + resume EACH TIME. The stranding mutants were `void-method-call`
    // deleting a `SetCurrentKey` — which does not hang, it makes the following filtered
    // query pick a worse plan and scan. Slow, not hung.
    //
    // The asymmetry decides the number: too low costs a strand (catastrophic — everything
    // behind it blocked). Too high costs the rare genuine hang taking 180s instead of 30s
    // to score `timeout-killed` (bounded, linear). Measured p95 per-mutant on that codeunit
    // was 3.7s, so 180s is ~48x p95.
    expect(MIN_MUTANT_BUDGET_MS).toBe(180_000);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

```bash
cd U:/Git/LethAL && bun test packages/runner/tests/orchestrator.test.ts -t "MIN_MUTANT_BUDGET_MS"
```

Expected: FAIL — `Expected: 180000, Received: 30000`.

- [ ] **Step 3: Change the constant and its comment**

In `packages/runner/src/orchestrator.ts`, change `export const MIN_MUTANT_BUDGET_MS = 30_000;` to `180_000`, and replace its doc comment with the R91 reasoning above — specifically that **adaptive/derived-from-baseline was considered and rejected as false precision**: the stranding mutants had a 0 ms baseline, because deleting a `SetCurrentKey` blows up the *query plan*, and no multiplier of that test's baseline duration predicts a scan. Only a generous absolute floor covers the class.

- [ ] **Step 4: Run the full suite**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/engine/dist && rm -rf packages/operator-sdk/dist && rm -rf packages/builtin-tier1/dist && rm -rf packages/builtin-tier2/dist && rm -rf packages/schemata/dist && rm -rf packages/runner/dist && bun test
```

Expected: PASS. **If any test asserted the old 30 s floor indirectly** (a computed budget, a timeout message), it will fail — fix the test, not the constant, and say so in your report.

- [ ] **Step 5: Commit**

```bash
cd U:/Git/LethAL && bunx biome check packages/runner/src/orchestrator.ts packages/runner/tests/orchestrator.test.ts
git add packages/runner/src/orchestrator.ts packages/runner/tests/orchestrator.test.ts
git commit -m "fix(R91): raise the mutant budget floor to 180s — 30s stranded three real runs"
```

---

### Task 2 (C2a): Make the publish failure typed and informative

R90's fix depends on this. Today the publish timeout surfaces as a bare `Error` with no message (R65's class), which is exactly why nothing can learn from it.

**Files:**
- Modify: `packages/runner/src/bcdev-backend.ts` (the deploy/publish path)
- Test: `packages/runner/tests/bcdev-backend.test.ts`

**Interfaces:**
- Produces: `PublishFailedError extends Error` with `readonly guardCount: number`, `readonly file: string | undefined`, `readonly tier: string`, `readonly detail: string`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { PublishFailedError } from "../src/bcdev-backend";

describe("PublishFailedError (R65/R90)", () => {
  test("extends Error DIRECTLY, never another typed error", () => {
    const e = new PublishFailedError("timed out", { guardCount: 660, file: "X.al", tier: "t", detail: "d" });
    expect(Object.getPrototypeOf(PublishFailedError)).toBe(Error);
    expect(e).toBeInstanceOf(Error);
  });

  test("carries the guard count and file so the ceiling can be learned", () => {
    const e = new PublishFailedError("timed out", { guardCount: 660, file: "X.al", tier: "t", detail: "d" });
    expect(e.guardCount).toBe(660);
    expect(e.file).toBe("X.al");
  });

  test("its message is never empty — R65's failure was a bare Error with no text", () => {
    const e = new PublishFailedError("timed out", { guardCount: 1, file: undefined, tier: "t", detail: "raw" });
    expect(e.message.length).toBeGreaterThan(0);
    expect(e.message).toContain("timed out");
  });
});
```

- [ ] **Step 2: Run it, confirm it fails.** Expected: no export named `PublishFailedError`.

- [ ] **Step 3: Implement**

Define `PublishFailedError` extending `Error` **directly** (never `DeploymentError` — CLAUDE.md's separation rule), and throw it from the publish path where the bare `Error` is raised today. The message must always carry text; R65's original defect was a Bun spawn `ENOENT` arriving with an EMPTY message, so a fallback like `String(err) || "publish failed with no detail"` is required rather than optional.

- [ ] **Step 4: Run the suite, then commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/engine/dist && rm -rf packages/operator-sdk/dist && rm -rf packages/builtin-tier1/dist && rm -rf packages/builtin-tier2/dist && rm -rf packages/schemata/dist && rm -rf packages/runner/dist && bun test packages/runner
bunx biome check packages/runner/src/bcdev-backend.ts packages/runner/tests/bcdev-backend.test.ts
git add packages/runner/src/bcdev-backend.ts packages/runner/tests/bcdev-backend.test.ts
git commit -m "fix(R65): a publish failure carries its guard count and file, never a bare Error"
```

---

### Task 3 (C2b): The publish ceiling as a measured per-tier bracket

**A hardcoded constant would be wrong in both directions** — the ceiling is topology-dependent. Measured on the campaign's hosted tier: **176 and 229 guards publish; 331 and 660 time out.** A different container or proxy has a different ceiling, and nobody can know it in advance.

**Files:**
- Create: `packages/runner/src/publish-ceiling.ts`
- Modify: `packages/runner/src/store.ts` (persist outcomes), `packages/runner/src/orchestrator.ts` (pre-flight refusal), `packages/runner/src/cli.ts` (`--dry-run` output)
- Test: `packages/runner/tests/publish-ceiling.test.ts`

**Interfaces:**
- Consumes: `PublishFailedError` from Task 2.
- Produces: `recordPublishOutcome(store, tier, guardCount, ok): void`, `knownCeiling(store, tier): { smallestFailure?: number; largestSuccess?: number }`, `assertUnderCeiling(input): void`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { assertUnderCeiling, knownCeiling } from "../src/publish-ceiling";

describe("publish ceiling (R90)", () => {
  test("with no history, nothing is refused — a fresh topology eats one honest failure", () => {
    expect(() => assertUnderCeiling({ file: "X.al", guardCount: 9_999, ceiling: {} })).not.toThrow();
  });

  test("refuses a file at or above the smallest recorded failure", () => {
    expect(() =>
      assertUnderCeiling({ file: "Big.al", guardCount: 660, ceiling: { smallestFailure: 331, largestSuccess: 229 } }),
    ).toThrow(/Big\.al/);
  });

  test("the refusal states the bracket as MEASUREMENT, never as law", () => {
    try {
      assertUnderCeiling({ file: "Big.al", guardCount: 660, ceiling: { smallestFailure: 331, largestSuccess: 229 } });
      throw new Error("should have thrown");
    } catch (err) {
      const m = String((err as Error).message);
      expect(m).toContain("331");
      expect(m).toContain("229");
      expect(m).toMatch(/measured|observed|recorded/i);
    }
  });

  test("allows a file below the largest recorded success", () => {
    expect(() =>
      assertUnderCeiling({ file: "Small.al", guardCount: 176, ceiling: { smallestFailure: 331, largestSuccess: 229 } }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to confirm failure, then implement**

`assertUnderCeiling` throws only when `guardCount >= smallestFailure`. With no recorded failure it never throws — **a fresh topology must still be allowed to discover its own ceiling by failing once.** The refusal exists to prevent the *second* waste, not the first.

The message names the file, its guard count, the measured bracket with the date, and the levers (`--only` to exclude the file; splitting the file). Phrase it as measurement: *"331 guards timed out on this tier on 2026-08-05; 229 published"* — never *"the limit is 331"*.

- [ ] **Step 3: Persist outcomes and wire the pre-flight**

Add a per-tier publish-outcome table to `store.ts`. Record `(guardCount, ok)` after every publish attempt — success from the deploy path, failure from Task 2's `PublishFailedError`. Call `assertUnderCeiling` per FILE before publishing, since **batches split at file granularity** and `--max-guards-per-batch` cannot rescue a file that alone exceeds the ceiling.

- [ ] **Step 4: Report both counts in `--dry-run` (R92)**

Bundle here — same surface, one change. `--dry-run` prints per-file guard counts descending, with both the site count and the deployed count (they differ: 176 sites → 148 deployed on real code, and conflating them broke a real pre-commitment), plus the known bracket for the configured tier if any.

- [ ] **Step 5: Full suite, then commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/engine/dist && rm -rf packages/operator-sdk/dist && rm -rf packages/builtin-tier1/dist && rm -rf packages/builtin-tier2/dist && rm -rf packages/schemata/dist && rm -rf packages/runner/dist && bun test
bunx biome check packages/runner/src/publish-ceiling.ts packages/runner/tests/publish-ceiling.test.ts packages/runner/src/store.ts packages/runner/src/orchestrator.ts packages/runner/src/cli.ts
git add -A && git commit -m "feat(R90/R92): refuse a file over the measured publish ceiling, and report both counts"
```

---

### Task 4 (C3): Probe the environment first, then `lethal doctor`

R34's refusal is already correct — it fires *after* generate has burned time.

**Files:**
- Create: `packages/runner/src/doctor.ts`
- Modify: `packages/runner/src/orchestrator.ts` (move the probe), `packages/runner/src/cli.ts` (the subcommand)
- Test: `packages/runner/tests/doctor.test.ts`

**Interfaces:**
- Produces: `runDoctor(cfg, deps): Promise<DoctorReport>` and `DoctorReport = { readonly checks: readonly { name: string; ok: boolean; detail: string }[]; readonly ok: boolean }`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { runDoctor } from "../src/doctor";

describe("lethal doctor", () => {
  test("reports every check, not just the first failure", async () => {
    const r = await runDoctor(cfgFixture(), { envStatus: async () => "Stopped", leaseState: async () => "clear", quarantine: async () => "clear", controlVersion: async () => "1.0.0.14", toolPaths: async () => ({ alc: "ok", altool: "ok" }) });
    expect(r.checks.length).toBeGreaterThanOrEqual(5);
    expect(r.ok).toBe(false);
  });

  test("a Stopped environment names the restart command", async () => {
    const r = await runDoctor(cfgFixture(), { envStatus: async () => "Stopped", leaseState: async () => "clear", quarantine: async () => "clear", controlVersion: async () => "1.0.0.14", toolPaths: async () => ({ alc: "ok", altool: "ok" }) });
    const env = r.checks.find((c) => c.name === "environment");
    expect(env?.ok).toBe(false);
    expect(env?.detail).toMatch(/start/i);
  });

  test("all green means ok", async () => {
    const r = await runDoctor(cfgFixture(), { envStatus: async () => "Running", leaseState: async () => "clear", quarantine: async () => "clear", controlVersion: async () => "1.0.0.14", toolPaths: async () => ({ alc: "ok", altool: "ok" }) });
    expect(r.ok).toBe(true);
  });
});
```

Write `cfgFixture()` in the same file against the existing config-fixture pattern — grep `packages/runner/tests/` for how other tests build one.

- [ ] **Step 2: Implement**

`runDoctor` is read-only and runs **every** check before reporting, because a user fixing one problem at a time across five slow round-trips is the experience this replaces. Compose it from the refusals that already exist — environment status, lease/op-marker state, quarantine record, control-app version (R28's machinery exists), resolved tool paths — rather than reimplementing them.

- [ ] **Step 3: Move the environment probe to the front of `runSession`**

The existing refusal is correct; it just fires late. Move the status probe before generation, and make the message name the restart command.

- [ ] **Step 4: Wire `lethal doctor <config>`**, exiting non-zero with named causes. Add it to the help text and to `README.md`'s CLI table.

- [ ] **Step 5: Suite, then commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/engine/dist && rm -rf packages/operator-sdk/dist && rm -rf packages/builtin-tier1/dist && rm -rf packages/builtin-tier2/dist && rm -rf packages/schemata/dist && rm -rf packages/runner/dist && bun test
git add -A && git commit -m "feat(R34): probe the environment before generating, and add lethal doctor"
```

---

### Task 5 (C4): Recovery resolves env-tool configs; the skill keeps its ordering

`force-reset-lease` and `clear-quarantine` read the `bcdev` section directly, so an env-tool config needs a materialised copy with `packageCachePath` injected by hand. That is a tool bug wearing a skill costume — it cost a manual `python`-injection step mid-recovery during the campaign.

**Files:**
- Modify: `packages/runner/src/cli.ts` (`forceResetLeaseFromCli`, `clearQuarantineFromCli`)
- Delete: `.claude/skills/recover-tier/scripts/materialize-config.ts`
- Modify: `.claude/skills/recover-tier/SKILL.md`
- Test: `packages/runner/tests/cli.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("force-reset-lease resolves an envTool config the way run does", async () => {
  // The campaign had to hand-materialise a config and inject packageCachePath before this
  // command would run at all. It should resolve the same way `run` does.
  const cfg = envToolConfigFixture(); // no server/username/password/packageCachePath spelled out
  await expect(resolveForceResetLeaseConfig(cfg)).resolves.toMatchObject({
    server: expect.any(String),
    serverInstance: expect.any(String),
  });
});
```

- [ ] **Step 2: Implement**, reusing `resolveEnvToolSession` rather than duplicating resolution.

- [ ] **Step 3: Delete the bundled script and update the skill**

Remove `materialize-config.ts` and its steps from `SKILL.md`.

**KEEP the restart-before-reset ordering, and keep the skill user-invoked.** Its precondition — *"the stranded AL is actually dead"* — is guaranteed by a restart the tool cannot verify happened *after* the strand. It can check `Running`; it cannot check ordering. **Do NOT build a one-shot `lethal recover`**: automating that precondition away is precisely the unsafe part, and the skill's own §"the whole reason this is user-invoked" says so.

- [ ] **Step 4: Suite, then commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/engine/dist && rm -rf packages/operator-sdk/dist && rm -rf packages/builtin-tier1/dist && rm -rf packages/builtin-tier2/dist && rm -rf packages/schemata/dist && rm -rf packages/runner/dist && bun test
git add -A && git commit -m "fix(R51): force-reset-lease resolves envTool configs; drop the materialise step"
```

---

## The live gate

C1, C2 and C3 all change behaviour on the live path. Before merging, run both frozen gates and compare **per mutant**:

```bash
LETHAL_ITEST_BCDEV=1 bun run itest:bcdev      # frozen: 3 killed / 10 survived / 3 no-coverage
LETHAL_ITEST_TABLES=1 bun run itest:tables    # frozen: 109 / 17 / 10 over 136 deployed,
                                              # untargetedTriggerCount 0, EXACTLY ONE expected
                                              # baseline failure — Data Tests.PageActionComputesNonZero
```

**In a worktree, both gates need gitignored local files that do not exist there**: `fixtures/*/lethal.config.local.json` AND `fixtures/*/.vscode/launch.local.json`. A missing `launch.local.json` fails with `ENOENT` and reads exactly like a regression. Copy them from the main checkout first.

C1 in particular deserves attention: raising the floor means a genuinely non-terminating mutant now takes 180 s instead of 30 s to score `timeout-killed`, so `itest:tables` will run longer. That is expected, not a hang.
