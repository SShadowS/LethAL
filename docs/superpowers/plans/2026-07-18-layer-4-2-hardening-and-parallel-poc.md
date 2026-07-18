# Layer 4.2 — Execution Hardening + Parallel POC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop LethAL reporting a mutant as killed on the strength of its own client-side deadline, then prove parallel mutation testing end-to-end on the `al-runner` backend, which needs no cross-worker coordination.

**Architecture:** Three independent slices, in order. (1) Split the single `timeout` outcome into a runner-confirmed timeout versus a client `deadline-exceeded`, and give artifacts unique paths. (2) Add an opt-in al-runner server-mode transport that amortises compilation across a mutant's tests. (3) Add an N-worker parallel session path, where each worker owns its own backend instance and mutants are sharded across workers; a pool of one is exactly today's sequential behavior, so there is one code path, not two.

**Tech Stack:** Bun + TypeScript monorepo. `bun:sqlite`. No new runtime dependencies. Tests use `bun:test` with injected spawn/transport seams, following the existing patterns in `packages/runner/tests`.

**Design spec:** `docs/superpowers/specs/2026-07-18-layer-4-2-hardening-and-parallel-poc-design.md`

## Global Constraints

- Test outcome vocabulary becomes `pass | fail | skip | timeout | deadline-exceeded | error`. `timeout` means **runner-confirmed**; `deadline-exceeded` means our own timer fired.
- Mutant verdict vocabulary is unchanged: `killed | survived | no-coverage | timeout-killed | known-survivor | error`.
- `deadline-exceeded` MUST map to mutant verdict `error`, never `timeout-killed`. Mutants with verdict `error` are excluded from the mutation-score denominator (`killed / (killed + survived)` is unchanged; `error` was already outside it).
- al-runner runner-confirmed timeout is detected by `status === "fail"` with a message matching `/Test exceeded \d+s timeout/`.
- bcdev has NO known server-confirmed timeout signal. Every timeout it observes is `deadline-exceeded` until proven otherwise. Fail safe: under-report kills, never fabricate them.
- Never place `MutationSelector.Codeunit.al` in a `--stubs` directory: `stubPaths` are excluded from al-runner's cache fingerprint, so this yields cache hits serving a stale assembly (fast, silent, wrong verdicts).
- al-runner server protocol: newline-delimited JSON (NOT JSON-RPC). Commands `runTests`, `execute`, `shutdown`. Handshake line `{"ready":true}`. `runTests` requires `sourcePaths`; there is no per-procedure field, so it runs the whole suite.
- Concurrent workers MUST NOT share an artifact output path.
- `compileConcurrency` defaults to `min(workers, 4)` and is configurable independently of worker count.
- Verdicts must be identical at worker counts 1, 2, and 4.
- No non-null assertions (`!`) — biome sets `noNonNullAssertion: error`. `exactOptionalPropertyTypes` is on: use conditional spreads for optional fields.
- Every task ends green on: `bun test`, `bun run typecheck`, `bunx biome check packages/runner`. Delete stale `packages/*/dist` first if a full `bun test` shows phantom failures (they are gitignored build output; `rm -rf` may be blocked, use PowerShell `Remove-Item -Recurse -Force`).

---

## File Structure

```
packages/runner/src/
├── backend.ts               # MODIFY — add "deadline-exceeded" to TestOutcome
├── al-runner-backend.ts     # MODIFY — classify runner-confirmed timeout; deadline -> deadline-exceeded;
│                            #          delegate transport to a runner-transport
├── al-runner-transport.ts   # NEW — OneShotTransport | ServerTransport behind one interface
├── bcdev-backend.ts         # MODIFY — client deadline -> deadline-exceeded
├── publisher.ts             # MODIFY — unique artifact filename per (run, batch)
├── orchestrator.ts          # MODIFY — deadline-exceeded verdict mapping; extract runBatch so it
│                            #          can run per-worker; add pool fan-out
├── pool.ts                  # NEW — worker pool: shard mutants, bounded compile semaphore
└── report.ts                # MODIFY — report deadlineExceeded count distinctly

packages/runner/tests/
├── al-runner-backend.test.ts   # MODIFY
├── al-runner-transport.test.ts # NEW
├── bcdev-backend.test.ts       # MODIFY
├── publisher.test.ts           # MODIFY
├── orchestrator.test.ts        # MODIFY
└── pool.test.ts                # NEW
```

**Boundary rationale.** `al-runner-transport.ts` is separate because one-shot and server mode are two genuinely different I/O strategies behind one narrow interface; putting both in the backend would double an already busy file. `pool.ts` holds sharding and the compile semaphore — pure, testable logic with no I/O — so the parallel behavior can be tested without spawning anything.

---

## Task 1: Split client deadline from runner-confirmed timeout

**Files:**
- Modify: `packages/runner/src/backend.ts`
- Modify: `packages/runner/src/al-runner-backend.ts`
- Modify: `packages/runner/src/bcdev-backend.ts`
- Modify: `packages/runner/src/orchestrator.ts`
- Modify: `packages/runner/src/report.ts`
- Modify: `packages/runner/tests/al-runner-backend.test.ts`
- Modify: `packages/runner/tests/bcdev-backend.test.ts`
- Modify: `packages/runner/tests/orchestrator.test.ts`

**Interfaces:**
- Consumes: existing `TestOutcome`, `TestVerdict`, `MutantVerdict`, `SessionReport`.
- Produces (used by every later task):
  - `TestOutcome` = `"pass" | "fail" | "skip" | "timeout" | "deadline-exceeded" | "error"`
  - `SessionReport.counts.deadlineExceeded: number`

- [ ] **Step 1: Write the failing tests**

In `packages/runner/tests/al-runner-backend.test.ts`, append inside the existing top-level `describe("AlRunnerBackend.run", ...)` block (it already has `makeBackend`/`okSpawn` helpers — reuse them exactly as the neighbouring tests do):

```ts
  test("a runner-confirmed test timeout is outcome=timeout", async () => {
    const { spawn } = okSpawn(
      {
        tests: [
          {
            name: "PostingUpdatesTotal",
            status: "fail",
            durationMs: 0,
            message:
              "Test exceeded 3s timeout. Use --test-timeout 0 to disable timeout, or increase with --test-timeout <seconds>.",
          },
        ],
      },
      1,
    );
    const { backend } = await makeBackend(spawn);
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
    expect(v.outcome).toBe("timeout");
  });

  test("an ordinary assertion failure is still outcome=fail", async () => {
    const { spawn } = okSpawn(
      {
        tests: [
          { name: "PostingUpdatesTotal", status: "fail", durationMs: 3, message: "expected 2, got 1" },
        ],
      },
      1,
    );
    const { backend } = await makeBackend(spawn);
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
    expect(v.outcome).toBe("fail");
  });

  test("our own deadline is outcome=deadline-exceeded, not timeout", async () => {
    const spawn = async () => new Promise<never>(() => {}) as never;
    const { backend } = await makeBackend(spawn as never);
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 50 });
    expect(v.outcome).toBe("deadline-exceeded");
  });
```

In `packages/runner/tests/bcdev-backend.test.ts`, append inside the existing `describe("BcDevMcpBackend.run", ...)` block. Replace the existing timeout test's expectation of `"timeout"` with `"deadline-exceeded"` (bcdev has no server-confirmed timeout signal):

```ts
  test("bcdev has no runner-confirmed timeout, so its deadline is deadline-exceeded", async () => {
    const backend = makeBackend(() => new Promise(() => {}) as never);
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 50 });
    expect(v.outcome).toBe("deadline-exceeded");
  });
```

In `packages/runner/tests/orchestrator.test.ts`, append a new top-level block (mirror the existing `StubBackend`/`makeProject`/`CAPS_NST`/`selectorIds` usage exactly as the neighbouring `describe("runSession", ...)` tests do):

```ts
describe("runSession — deadline vs runner-confirmed timeout", () => {
  test("runner-confirmed timeout under a mutant is timeout-killed", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(
      CAPS_NST,
      (mutant) => (mutant === null ? "pass" : "timeout"),
      ["IsOverBudget"],
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.timeoutKilled).toBeGreaterThan(0);
    expect(report.counts.deadlineExceeded).toBe(0);
    store.close();
  });

  test("a client deadline is infrastructure: verdict error, never a kill", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(
      CAPS_NST,
      (mutant) => (mutant === null ? "pass" : "deadline-exceeded"),
      ["IsOverBudget"],
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.timeoutKilled).toBe(0);
    expect(report.counts.killed).toBe(0);
    expect(report.counts.deadlineExceeded).toBeGreaterThan(0);
    expect(report.counts.errors).toBeGreaterThan(0);
    // excluded from the score denominator
    expect(report.mutationScore).toBeNull();
    store.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/runner/tests/al-runner-backend.test.ts packages/runner/tests/bcdev-backend.test.ts packages/runner/tests/orchestrator.test.ts`
Expected: FAIL — `deadline-exceeded` is not assignable to `TestOutcome`, and `counts.deadlineExceeded` does not exist.

- [ ] **Step 3: Widen the outcome type**

In `packages/runner/src/backend.ts`, replace the `TestOutcome` line:

```ts
/**
 * `timeout` means the TEST RUNNER confirmed the test did not terminate — real
 * evidence about the mutant (design.md §6.7).
 * `deadline-exceeded` means OUR client timer fired and we know nothing about
 * what the server did — infrastructure noise, never evidence about the mutant.
 */
export type TestOutcome =
  | "pass"
  | "fail"
  | "skip"
  | "timeout"
  | "deadline-exceeded"
  | "error";
```

- [ ] **Step 4: Classify in AlRunnerBackend**

In `packages/runner/src/al-runner-backend.ts`, add near the other module-level constants:

```ts
/** al-runner's own per-test timeout message (verified against v1.0.31). */
const RUNNER_TIMEOUT_MESSAGE = /Test exceeded \d+s timeout/;
```

Change the client-deadline return (currently `if (res === "timeout") return { ref, outcome: "timeout", durationMs };`) to:

```ts
      if (res === "timeout") return { ref, outcome: "deadline-exceeded", durationMs };
```

Then, where a parsed test result is mapped to an outcome (the `t.status === "pass" ? "pass" : "fail"` expression), replace it with:

```ts
      const runnerTimedOut =
        t.status === "fail" && t.message !== undefined && RUNNER_TIMEOUT_MESSAGE.test(t.message);
      const outcome: TestOutcome = t.status === "pass" ? "pass" : runnerTimedOut ? "timeout" : "fail";
```

and use `outcome` in the returned verdict. Import `TestOutcome` from `./backend` if not already imported.

- [ ] **Step 5: Classify in BcDevMcpBackend**

In `packages/runner/src/bcdev-backend.ts`, change the client-deadline return to `deadline-exceeded` and record why:

```ts
      if (res === "timeout") {
        call.catch(() => {}); // late result deliberately discarded
        // bc-dev exposes no server-confirmed test-timeout signal, so we cannot
        // tell "the mutant hung" from "our timer fired / the endpoint wedged".
        // Fail safe: report infrastructure, never fabricate a kill.
        return { ref, outcome: "deadline-exceeded", durationMs: Date.now() - started };
      }
```

- [ ] **Step 6: Map the verdict in the orchestrator**

In `packages/runner/src/orchestrator.ts`, in the per-mutant covering-test loop, the branch is currently:

```ts
          if (v.outcome === "timeout") {
            verdict = "timeout-killed";
            killingTest = ref.method;
            break;
          }
```

Insert a new branch immediately BEFORE it:

```ts
          if (v.outcome === "deadline-exceeded") {
            // Our timer, not the runner's: says nothing about the mutant.
            verdict = "error";
            failureNote = `deadline exceeded running ${ref.method} (infrastructure, not a kill)`;
            break;
          }
```

Apply the same treatment in the baseline loop: a baseline test returning `deadline-exceeded` must be excluded from `greenTests` (it already is, since only `outcome === "pass"` qualifies) — no change needed there, but do NOT let it count as a red-baseline failure caused by the project. Leave `baselineGreen` semantics as they are.

- [ ] **Step 7: Count it distinctly in the report**

In `packages/runner/src/report.ts`, add `deadlineExceeded: number` to the `counts` interface and initialise it to `0`.

**Amended 2026-07-18 (review finding, user-approved deviation from the original step).** Do NOT count by string-matching `failureNote`. `failureNote` is not owned by one code path — the batch-deploy-failure handler at `orchestrator.ts:217-222` sets it from arbitrary backend text (`String(err)`) for every mutant in the batch, and those outcomes reach `buildReport()`. Counting on that text lets unrelated errors corrupt the diagnostic.

Instead add an explicit discriminator to the internal `SessionOutcome` record:

```ts
  readonly cause?: "deadline-exceeded" | "unstable";
```

Set it at the two orchestrator sites that own those meanings (the `deadline-exceeded` branch added in Step 6, and the unstable-test confirmation branch), and count structurally:

```ts
        counts.errors++;
        if (o.cause === "unstable") counts.unstable++;
        if (o.cause === "deadline-exceeded") counts.deadlineExceeded++;
```

Remove BOTH `UNSTABLE_PREFIX` and any `DEADLINE_PREFIX` string matching — `counts.unstable` has the identical weakness and moves to the same mechanism. `failureNote` remains the human-readable message; only the counting changes.

Add a test proving it: a batch deploy failure whose thrown value stringifies to text starting with `"deadline exceeded"` must NOT increment `counts.deadlineExceeded`, while still counting as an error.

In `renderConsole`, extend the summary line so the number is visible:

```ts
      `(killed ${r.counts.killed}, survived ${r.counts.survived}, no-coverage ${r.counts.noCoverage}, ` +
```
becomes the same line with `deadline-exceeded ${r.counts.deadlineExceeded}, ` inserted before the closing of that segment. Keep the existing `[unstable N]` suffix.

- [ ] **Step 8: Run tests**

Run: `bun test packages/runner`
Expected: PASS.

Then the full suite: `bun test` — PASS. Then `bun run typecheck` and `bunx biome check packages/runner` — both clean.

- [ ] **Step 9: Commit**

```bash
git add packages/runner
git commit -m "fix(runner): never report a client deadline as a killed mutant

A client-side Promise.race deadline produced outcome \"timeout\", which the
orchestrator mapped to verdict \"timeout-killed\" — so an MCP hang, a wedged
endpoint or a slow server manufactured kills and inflated the mutation score.

Splits the outcome: \"timeout\" now means the RUNNER confirmed the test did not
terminate (al-runner reports this distinguishably, verified against v1.0.31),
while \"deadline-exceeded\" means our own timer fired and maps to verdict
\"error\", outside the score denominator. bc-dev exposes no server-confirmed
timeout signal, so every timeout it observes is a deadline until proven
otherwise: under-report kills rather than fabricate them."
```

---

## Task 2: Unique artifact paths

**Files:**
- Modify: `packages/runner/src/publisher.ts`
- Modify: `packages/runner/src/orchestrator.ts`
- Modify: `packages/runner/tests/publisher.test.ts`

**Interfaces:**
- Consumes: `PublisherConfig` (has `outputDir`), `Publisher.compile(instrumentedDir)`.
- Produces (used by Task 5): `Publisher.compile(instrumentedDir: string, artifactName?: string): Promise<string>` — when `artifactName` is given, the emitted `.app` is `<outputDir>/<artifactName>.app`; when omitted, behavior is unchanged (`lethal-instrumented.app`).

- [ ] **Step 1: Write the failing test**

Append to `packages/runner/tests/publisher.test.ts` (reuse the existing `recordingSpawn` helper and `cfg` object):

```ts
describe("Publisher artifact identity", () => {
  test("distinct artifact names never collide in one outputDir", async () => {
    const { calls, spawn } = recordingSpawn();
    const p = new Publisher(cfg, spawn);
    const a = await p.compile("C:/instr/batch-0", "run7-batch0");
    const b = await p.compile("C:/instr/batch-1", "run7-batch1");
    expect(a).not.toBe(b);
    expect(a).toContain("run7-batch0");
    expect(b).toContain("run7-batch1");
    expect(calls[0]).toContain(`/out:${a}`);
    expect(calls[1]).toContain(`/out:${b}`);
  });

  test("omitting the name keeps the existing single-artifact behavior", async () => {
    const { spawn } = recordingSpawn();
    const out = await new Publisher(cfg, spawn).compile("C:/instr");
    expect(out).toContain("lethal-instrumented.app");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/runner/tests/publisher.test.ts`
Expected: FAIL — `compile` takes one argument.

- [ ] **Step 3: Implement**

In `packages/runner/src/publisher.ts`, change the signature and the path it builds:

```ts
  /**
   * `artifactName` must be unique per concurrent compile: a fixed filename in a
   * shared outputDir means two workers overwrite each other's .app and one
   * publishes the other's code.
   */
  async compile(instrumentedDir: string, artifactName = "lethal-instrumented"): Promise<string> {
    const appPath = toForwardSlashes(join(this.cfg.outputDir, `${artifactName}.app`));
```

Leave the rest of `compile` unchanged.

- [ ] **Step 4: Thread a unique name from the orchestrator**

In `packages/runner/src/orchestrator.ts`, the deploy call is `await cfg.backend.deploy(batchDir)`. `deploy` takes only a directory, so the uniqueness must come from the directory, which is already `batch-<idx>` per run. Add the run id so two concurrent sessions cannot collide:

Where `batchDir` is built (currently `join(cfg.instrumentedDir, \`batch-${batchIdx}\`)`), change to:

```ts
      const batchDir = join(cfg.instrumentedDir, `run-${runId}-batch-${batchIdx}`);
```

- [ ] **Step 5: Run tests**

Run: `bun test packages/runner` — PASS. `bun run typecheck`, `bunx biome check packages/runner` — clean.

- [ ] **Step 6: Commit**

```bash
git add packages/runner
git commit -m "fix(runner): unique artifact and batch-dir paths per run

Publisher.compile wrote a fixed lethal-instrumented.app into outputDir, so two
concurrent workers would overwrite each other's package and one would publish
the other's code. Batch scratch dirs likewise collided across sessions."
```

---

## Task 3: al-runner transport seam (one-shot extracted)

Pure refactor with no behavior change, so the server transport in Task 4 has somewhere to live and the backend stops owning process I/O.

**Files:**
- Create: `packages/runner/src/al-runner-transport.ts`
- Create: `packages/runner/tests/al-runner-transport.test.ts`
- Modify: `packages/runner/src/al-runner-backend.ts`

**Interfaces:**
- Consumes: `SpawnFn`, `defaultSpawn` from `./publisher`.
- Produces (used by Tasks 4, 6):

```ts
export interface AlRunnerRequest {
  readonly sourceDir: string;
  readonly testDir: string;
  readonly method: string;          // informational; one-shot passes --run, server ignores it
  readonly packagesDir?: string;
  readonly stubsDir?: string;
  readonly testTimeoutSeconds: number;
  readonly deadlineMs: number;
}
export interface AlRunnerRawTest {
  readonly name: string;
  readonly status: string;          // "pass" | "fail" | "error"
  readonly durationMs?: number;
  readonly message?: string;
}
export type AlRunnerResult =
  | { readonly kind: "tests"; readonly tests: readonly AlRunnerRawTest[] }
  | { readonly kind: "deadline" }
  | { readonly kind: "skip"; readonly detail: string }
  | { readonly kind: "error"; readonly detail: string };
export interface AlRunnerTransport {
  send(req: AlRunnerRequest): Promise<AlRunnerResult>;
  close(): Promise<void>;
}
export class OneShotTransport implements AlRunnerTransport {
  constructor(alRunnerPath: string, spawn?: SpawnFn);
}
export function parseAlRunnerPayload(stdout: string): readonly AlRunnerRawTest[];
```

- [ ] **Step 1: Write the failing test**

Create `packages/runner/tests/al-runner-transport.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { OneShotTransport, parseAlRunnerPayload } from "../src/al-runner-transport";

const req = {
  sourceDir: "/instr",
  testDir: "/tests",
  method: "PostingUpdatesTotal",
  testTimeoutSeconds: 5,
  deadlineMs: 5000,
};

function recording(payload: unknown, exitCode = 0) {
  const calls: string[][] = [];
  const spawn = async (argv: readonly string[]) => {
    calls.push([...argv]);
    return { exitCode, stdout: JSON.stringify(payload), stderr: "" };
  };
  return { calls, spawn };
}

describe("parseAlRunnerPayload", () => {
  test("reads the envelope's tests array", () => {
    const tests = parseAlRunnerPayload(
      JSON.stringify({ tests: [{ name: "A", status: "pass", durationMs: 3 }], passed: 1 }),
    );
    expect(tests).toEqual([{ name: "A", status: "pass", durationMs: 3 }]);
  });
  test("missing tests array yields empty, not a throw", () => {
    expect(parseAlRunnerPayload(JSON.stringify({ passed: 0 }))).toEqual([]);
  });
});

describe("OneShotTransport", () => {
  test("passes --run, --output-json, --test-isolation method and the timeout", async () => {
    const { calls, spawn } = recording({ tests: [{ name: "PostingUpdatesTotal", status: "pass" }] });
    const t = new OneShotTransport("al-runner", spawn);
    const res = await t.send(req);
    expect(res.kind).toBe("tests");
    const argv = calls[0] ?? [];
    expect(argv).toContain("--run");
    expect(argv).toContain("PostingUpdatesTotal");
    expect(argv).toContain("--output-json");
    expect(argv).toContain("--test-isolation");
    expect(argv).toContain("method");
    expect(argv).toContain("--test-timeout");
    expect(argv).toContain("5");
  });

  test("exit 2 is a runner limitation (skip), exit 3 is an error", async () => {
    for (const [code, kind] of [[2, "skip"], [3, "error"]] as const) {
      const { spawn } = recording({ tests: [] }, code);
      const res = await new OneShotTransport("al-runner", spawn).send(req);
      expect(res.kind).toBe(kind);
    }
  });

  test("a hung process yields kind=deadline", async () => {
    const spawn = (async () => new Promise(() => {})) as never;
    const res = await new OneShotTransport("al-runner", spawn).send({ ...req, deadlineMs: 40 });
    expect(res.kind).toBe("deadline");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/runner/tests/al-runner-transport.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `al-runner-transport.ts`**

```ts
import { type SpawnFn, defaultSpawn } from "./publisher";

export interface AlRunnerRequest {
  readonly sourceDir: string;
  readonly testDir: string;
  readonly method: string;
  readonly packagesDir?: string;
  readonly stubsDir?: string;
  readonly testTimeoutSeconds: number;
  readonly deadlineMs: number;
}

export interface AlRunnerRawTest {
  readonly name: string;
  readonly status: string;
  readonly durationMs?: number;
  readonly message?: string;
}

export type AlRunnerResult =
  | { readonly kind: "tests"; readonly tests: readonly AlRunnerRawTest[] }
  | { readonly kind: "deadline" }
  | { readonly kind: "skip"; readonly detail: string }
  | { readonly kind: "error"; readonly detail: string };

export interface AlRunnerTransport {
  send(req: AlRunnerRequest): Promise<AlRunnerResult>;
  close(): Promise<void>;
}

export function parseAlRunnerPayload(stdout: string): readonly AlRunnerRawTest[] {
  const parsed = JSON.parse(stdout) as { tests?: AlRunnerRawTest[] };
  return parsed.tests ?? [];
}

/** One al-runner process per request. Correct, and pays full compilation each time. */
export class OneShotTransport implements AlRunnerTransport {
  constructor(
    private readonly alRunnerPath: string,
    private readonly spawn: SpawnFn = defaultSpawn,
  ) {}

  async send(req: AlRunnerRequest): Promise<AlRunnerResult> {
    const argv = [
      this.alRunnerPath,
      "--run",
      req.method,
      req.sourceDir,
      req.testDir,
      "--output-json",
      // al-runner defaults to `codeunit` isolation (state shared within a
      // codeunit); force `method` to match the advertised full-reset capability.
      "--test-isolation",
      "method",
      "--test-timeout",
      String(req.testTimeoutSeconds),
    ];
    if (req.packagesDir) argv.push("--packages", req.packagesDir);
    if (req.stubsDir) argv.push("--stubs", req.stubsDir);

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        this.spawn(argv, { signal: controller.signal }),
        new Promise<"deadline">((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve("deadline");
          }, req.deadlineMs);
        }),
      ]);
      if (res === "deadline") return { kind: "deadline" };
      if (res.exitCode === 2) return { kind: "skip", detail: res.stdout || res.stderr };
      if (res.exitCode === 3 || res.exitCode < 0)
        return { kind: "error", detail: res.stderr || res.stdout };
      return { kind: "tests", tests: parseAlRunnerPayload(res.stdout) };
    } catch (err) {
      return { kind: "error", detail: String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    // nothing retained between requests
  }
}
```

- [ ] **Step 4: Rewire `AlRunnerBackend` onto the transport**

In `packages/runner/src/al-runner-backend.ts`: construct a `OneShotTransport` in the constructor (from `cfg.alRunnerPath` and the injected spawn), and replace the body of `run()` so it builds an `AlRunnerRequest` and maps `AlRunnerResult` to `TestVerdict`:

```ts
    const started = Date.now();
    const res = await this.transport.send({
      sourceDir: this.activeDir(),
      testDir: this.cfg.testDir,
      method: ref.method,
      ...(this.cfg.packagesDir !== undefined ? { packagesDir: this.cfg.packagesDir } : {}),
      ...(this.cfg.stubsDir !== undefined ? { stubsDir: this.cfg.stubsDir } : {}),
      testTimeoutSeconds: Math.max(1, Math.ceil(opts.timeoutMs / 1000)),
      deadlineMs: opts.timeoutMs,
    });
    const durationMs = Date.now() - started;
    if (res.kind === "deadline") return { ref, outcome: "deadline-exceeded", durationMs };
    if (res.kind === "skip") return { ref, outcome: "skip", durationMs, failureMessage: res.detail };
    if (res.kind === "error") return { ref, outcome: "error", durationMs, failureMessage: res.detail };
    const t = res.tests.find((x) => x.name === ref.method);
    if (!t)
      return {
        ref,
        outcome: "error",
        durationMs,
        failureMessage: "al-runner output missing the requested test",
      };
    const runnerTimedOut =
      t.status === "fail" && t.message !== undefined && RUNNER_TIMEOUT_MESSAGE.test(t.message);
    const outcome: TestOutcome = t.status === "pass" ? "pass" : runnerTimedOut ? "timeout" : "fail";
    return {
      ref,
      outcome,
      // Wall-clock, NOT the runner's in-VM figure: the orchestrator derives each
      // mutant's timeout budget from this and must include round-trip cost.
      durationMs,
      ...(t.message !== undefined ? { failureMessage: t.message } : {}),
    };
```

Add `async close(): Promise<void> { await this.transport.close(); }` to the backend.

Delete the now-unused local `parseAlRunnerOutput` and `AlRunnerTest` from the backend.

- [ ] **Step 5: Run tests**

Run: `bun test packages/runner` — PASS (Task 1's al-runner tests must still pass unchanged; that is the point of this refactor).
`bun run typecheck`, `bunx biome check packages/runner` — clean.

- [ ] **Step 6: Commit**

```bash
git add packages/runner
git commit -m "refactor(runner): extract al-runner transport behind an interface

No behavior change. Separates process I/O from verdict mapping so server mode
can be added as a second transport rather than a branch inside the backend."
```

---

## Task 4: al-runner server-mode transport

**Files:**
- Modify: `packages/runner/src/al-runner-transport.ts`
- Modify: `packages/runner/src/al-runner-backend.ts`
- Modify: `packages/runner/tests/al-runner-transport.test.ts`

**Interfaces:**
- Consumes: `AlRunnerTransport`, `AlRunnerRequest`, `AlRunnerResult`, `parseAlRunnerPayload` (Task 3).
- Produces (used by Task 6):
  - `class ServerTransport implements AlRunnerTransport` — `constructor(alRunnerPath: string, io?: ServerIo)`
  - `interface ServerIo { start(): { write(line: string): void; lines(): AsyncIterableIterator<string>; kill(): void } }` — injectable so tests need no real process.
  - `AlRunnerConfig.serverMode?: boolean` (default `false`).

**Protocol facts (verified against v1.0.31 — do not re-derive):** newline-delimited JSON; handshake line `{"ready":true}`; request `{"command":"runTests","sourcePaths":[...],"packagePaths":[...],"stubPaths":[...]}`; response envelope `{tests,passed,failed,errors,total,exitCode,cached}`; `{"error":"..."}` on failure; `{"command":"shutdown"}` replies `{"status":"shutting down"}`. There is NO per-procedure field — `runTests` runs the whole suite.

- [ ] **Step 1: Write the failing test**

Append to `packages/runner/tests/al-runner-transport.test.ts`:

```ts
import { ServerTransport } from "../src/al-runner-transport";

/** Scripted stand-in for the al-runner server process. */
function fakeIo(responses: unknown[]) {
  const written: string[] = [];
  let resolveNext: ((v: IteratorResult<string>) => void) | null = null;
  const queue: string[] = ['{"ready":true}'];
  let killed = false;
  const push = (l: string) => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r({ value: l, done: false });
    } else queue.push(l);
  };
  const io = {
    start() {
      return {
        write(line: string) {
          written.push(line);
          const req = JSON.parse(line) as { command: string };
          if (req.command === "shutdown") return push('{"status":"shutting down"}');
          const next = responses.shift() ?? { tests: [] };
          push(JSON.stringify(next));
        },
        lines(): AsyncIterableIterator<string> {
          return {
            [Symbol.asyncIterator]() {
              return this;
            },
            next(): Promise<IteratorResult<string>> {
              const q = queue.shift();
              if (q !== undefined) return Promise.resolve({ value: q, done: false });
              return new Promise((res) => {
                resolveNext = res;
              });
            },
          } as AsyncIterableIterator<string>;
        },
        kill() {
          killed = true;
        },
      };
    },
  };
  return { io, written, wasKilled: () => killed };
}

describe("ServerTransport", () => {
  test("consumes the handshake and sends a runTests command with both source dirs", async () => {
    const { io, written } = fakeIo([{ tests: [{ name: "A", status: "pass", durationMs: 2 }] }]);
    const t = new ServerTransport("al-runner", io);
    const res = await t.send({ ...req, method: "A" });
    expect(res.kind).toBe("tests");
    const sent = JSON.parse(written[0] ?? "{}") as { command: string; sourcePaths: string[] };
    expect(sent.command).toBe("runTests");
    expect(sent.sourcePaths).toEqual(["/instr", "/tests"]);
    await t.close();
  });

  test("reuses one process across requests (handshake read once)", async () => {
    const { io, written } = fakeIo([
      { tests: [{ name: "A", status: "pass" }] },
      { tests: [{ name: "A", status: "pass" }] },
    ]);
    const t = new ServerTransport("al-runner", io);
    await t.send({ ...req, method: "A" });
    await t.send({ ...req, method: "A" });
    expect(written).toHaveLength(2);
    await t.close();
  });

  test("an {error} response becomes kind=error", async () => {
    const { io } = fakeIo([{ error: "sourcePaths is required" }]);
    const t = new ServerTransport("al-runner", io);
    const res = await t.send(req);
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.detail).toContain("sourcePaths is required");
    await t.close();
  });

  test("close shuts the process down", async () => {
    const { io, wasKilled } = fakeIo([]);
    const t = new ServerTransport("al-runner", io);
    await t.send(req);
    await t.close();
    expect(wasKilled()).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/runner/tests/al-runner-transport.test.ts`
Expected: FAIL — `ServerTransport` is not exported.

- [ ] **Step 3: Implement `ServerTransport`**

Append to `packages/runner/src/al-runner-transport.ts`:

```ts
export interface ServerProcess {
  write(line: string): void;
  lines(): AsyncIterableIterator<string>;
  kill(): void;
}
export interface ServerIo {
  start(): ServerProcess;
}

const defaultServerIo = (alRunnerPath: string): ServerIo => ({
  start(): ServerProcess {
    const proc = Bun.spawn([alRunnerPath, "--server"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    let buf = "";
    return {
      write(line) {
        proc.stdin.write(`${line}\n`);
        proc.stdin.flush();
      },
      lines(): AsyncIterableIterator<string> {
        return {
          [Symbol.asyncIterator]() {
            return this;
          },
          async next(): Promise<IteratorResult<string>> {
            while (true) {
              const nl = buf.indexOf("\n");
              if (nl >= 0) {
                const l = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (l.length > 0) return { value: l, done: false };
                continue;
              }
              const { value, done } = await reader.read();
              if (done) return { value: undefined as never, done: true };
              buf += dec.decode(value, { stream: true });
            }
          },
        } as AsyncIterableIterator<string>;
      },
      kill() {
        proc.kill();
      },
    };
  },
});

/**
 * Keeps ONE al-runner process warm. It caches compiled assemblies under a
 * SHA256 fingerprint of source CONTENTS (8-entry LRU), so a mutant that
 * rewrites MutationSelector.Codeunit.al still pays a recompile — but every test
 * for that mutant afterwards is near-free.
 *
 * `runTests` has no per-procedure field, so the whole suite runs each time and
 * the requested method is picked out of the results. That is acceptable here:
 * this backend reports coverage:"none", so the orchestrator already runs every
 * test per mutant.
 *
 * NEVER move the selector into `--stubs` to dodge recompiles: stubPaths are
 * excluded from the cache fingerprint, so that yields a cache HIT serving a
 * stale assembly — fast, silent, wrong verdicts.
 */
export class ServerTransport implements AlRunnerTransport {
  private proc: ServerProcess | undefined;
  private iter: AsyncIterableIterator<string> | undefined;
  private readonly io: ServerIo;

  constructor(alRunnerPath: string, io?: ServerIo) {
    this.io = io ?? defaultServerIo(alRunnerPath);
  }

  private async ensureStarted(): Promise<{ proc: ServerProcess; iter: AsyncIterableIterator<string> }> {
    const existing = this.proc;
    const existingIter = this.iter;
    if (existing !== undefined && existingIter !== undefined)
      return { proc: existing, iter: existingIter };
    const proc = this.io.start();
    const iter = proc.lines();
    const hello = await iter.next(); // {"ready":true}
    if (hello.done) throw new Error("al-runner server closed before the ready handshake");
    this.proc = proc;
    this.iter = iter;
    return { proc, iter };
  }

  async send(req: AlRunnerRequest): Promise<AlRunnerResult> {
    try {
      const { proc, iter } = await this.ensureStarted();
      const payload: Record<string, unknown> = {
        command: "runTests",
        sourcePaths: [req.sourceDir, req.testDir],
      };
      if (req.packagesDir) payload.packagePaths = [req.packagesDir];
      if (req.stubsDir) payload.stubPaths = [req.stubsDir];
      proc.write(JSON.stringify(payload));

      const deadline = new Promise<"deadline">((resolve) =>
        setTimeout(() => resolve("deadline"), req.deadlineMs),
      );
      const line = await Promise.race([iter.next(), deadline]);
      if (line === "deadline") {
        // The process is now out of step with our request stream; drop it.
        await this.close();
        return { kind: "deadline" };
      }
      if (line.done) return { kind: "error", detail: "al-runner server closed unexpectedly" };
      const parsed = JSON.parse(line.value) as { error?: string; tests?: AlRunnerRawTest[] };
      if (parsed.error !== undefined) return { kind: "error", detail: parsed.error };
      return { kind: "tests", tests: parsed.tests ?? [] };
    } catch (err) {
      return { kind: "error", detail: String(err) };
    }
  }

  async close(): Promise<void> {
    const proc = this.proc;
    if (proc === undefined) return;
    this.proc = undefined;
    this.iter = undefined;
    try {
      proc.write(JSON.stringify({ command: "shutdown" }));
    } catch {
      // process may already be gone
    }
    proc.kill();
  }
}
```

- [ ] **Step 4: Make it opt-in from the backend**

In `packages/runner/src/al-runner-backend.ts`, add `readonly serverMode?: boolean;` to `AlRunnerConfig` and select the transport in the constructor:

```ts
    this.transport = cfg.serverMode
      ? new ServerTransport(cfg.alRunnerPath)
      : new OneShotTransport(cfg.alRunnerPath, spawn);
```

- [ ] **Step 5: Run tests**

Run: `bun test packages/runner` — PASS. `bun run typecheck`, `bunx biome check packages/runner` — clean.

- [ ] **Step 6: Verify equivalence against the REAL runner**

This is the gate the spec requires before server mode may ever become the default.

```bash
LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe" \
  bun packages/runner/src/cli.ts run --project fixtures/sandbox-app \
  --tests fixtures/sandbox-tests --backend al-runner \
  --config fixtures/sandbox-app/lethal.config.local.json
```

Expected (the known table): `killed 3, survived 13, no-coverage 0`, score `18.8%`.

Then add `"serverMode": true` to the `alRunner` section of `fixtures/sandbox-app/lethal.config.local.json` (gitignored) and rerun. **The verdict table must be identical.** Record both wall-clock timings in the commit message. If they differ, server mode is wrong — fix it or stop; do not adjust the expectations.

- [ ] **Step 7: Commit**

```bash
git add packages/runner
git commit -m "feat(runner): opt-in al-runner server-mode transport

Keeps one al-runner process warm instead of spawning one per test. Compilation
is cached under a content fingerprint (8-entry LRU), so cost moves from
per-test to per-mutant: a mutant's selector rewrite still forces a recompile,
but its tests then run in ~1-4ms instead of ~6.9s each.

runTests has no per-procedure field, so the whole suite runs and the requested
method is selected from the results - fine for a backend reporting
coverage:\"none\". Off by default until proven verdict-equivalent."
```

---

## Task 5: Worker pool — sharding and compile bounding

Pure logic, no I/O, so it is testable without processes.

**Files:**
- Create: `packages/runner/src/pool.ts`
- Create: `packages/runner/tests/pool.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (used by Task 6):

```ts
export function shardEvenly<T>(items: readonly T[], workers: number): T[][];
export class Semaphore {
  constructor(permits: number);
  run<T>(fn: () => Promise<T>): Promise<T>;
  get inFlight(): number;
}
```

- [ ] **Step 1: Write the failing test**

Create `packages/runner/tests/pool.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Semaphore, shardEvenly } from "../src/pool";

describe("shardEvenly", () => {
  test("splits round-robin so shard sizes differ by at most one", () => {
    const shards = shardEvenly([1, 2, 3, 4, 5, 6, 7], 3);
    expect(shards).toHaveLength(3);
    expect(shards.flat().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const sizes = shards.map((s) => s.length).sort();
    expect(sizes[sizes.length - 1] - sizes[0]).toBeLessThanOrEqual(1);
  });

  test("one worker gets everything, in order", () => {
    expect(shardEvenly([1, 2, 3], 1)).toEqual([[1, 2, 3]]);
  });

  test("more workers than items yields empty shards, never undefined", () => {
    const shards = shardEvenly([1], 3);
    expect(shards).toHaveLength(3);
    expect(shards.flat()).toEqual([1]);
    for (const s of shards) expect(Array.isArray(s)).toBe(true);
  });

  test("is deterministic — same input, same shards", () => {
    expect(shardEvenly([1, 2, 3, 4, 5], 2)).toEqual(shardEvenly([1, 2, 3, 4, 5], 2));
  });
});

describe("Semaphore", () => {
  test("never exceeds its permit count", async () => {
    const sem = new Semaphore(2);
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        sem.run(async () => {
          peak = Math.max(peak, sem.inFlight);
          await new Promise((r) => setTimeout(r, 5));
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(2);
  });

  test("a throwing task releases its permit", async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await sem.run(async () => "recovered")).toBe("recovered");
    expect(sem.inFlight).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/runner/tests/pool.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `pool.ts`**

```ts
/**
 * Round-robin so that a run of expensive items lands on different workers
 * rather than all in one contiguous block. Deterministic: verdicts must not
 * depend on how work was distributed.
 */
export function shardEvenly<T>(items: readonly T[], workers: number): T[][] {
  const n = Math.max(1, workers);
  const shards: T[][] = Array.from({ length: n }, () => []);
  for (const [i, item] of items.entries()) {
    const target = shards[i % n];
    if (target !== undefined) target.push(item);
  }
  return shards;
}

/**
 * Bounds genuinely expensive operations (transpile/compile) independently of
 * worker count. Worker count says how many mutants are in flight; it must not
 * silently become compile concurrency, because `alc` is CPU-bound.
 */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly permits: number) {}

  get inFlight(): number {
    return this.active;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.permits) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.waiting.shift();
      if (next !== undefined) next();
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/runner/tests/pool.test.ts` — PASS. Export both from `src/index.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/runner
git commit -m "feat(runner): deterministic sharding + a compile-bounding semaphore"
```

---

## Task 6: Parallel session

**Files:**
- Modify: `packages/runner/src/orchestrator.ts`
- Modify: `packages/runner/tests/orchestrator.test.ts`

**Interfaces:**
- Consumes: `shardEvenly`, `Semaphore` (Task 5); `AlRunnerTransport` (Tasks 3–4); the existing `runSession`.
- Produces:
  - `SessionConfig.workers?: number` — default `1`.
  - `SessionConfig.compileConcurrency?: number` — default `min(workers, 4)`.
  - `SessionConfig.backendFactory?: (workerIndex: number) => ExecutionBackend` — required when `workers > 1`; each worker needs its own backend instance (its own instrumented dir and, for al-runner, its own server process).

**Design note for the implementer.** Do NOT fork a second session implementation. Refactor the existing per-batch body of `runSession` into an internal `runBatchOnBackend(backend, batchDir, mutants, ...)` that returns outcomes. Sequential is then `workers = 1` running one shard — the exact path that is already verified live, so it stays exercised.

- [ ] **Step 1: Write the failing test**

Append to `packages/runner/tests/orchestrator.test.ts`:

```ts
describe("runSession — parallel workers", () => {
  test("verdicts are identical at 1, 2 and 4 workers", async () => {
    const shape = (r: Awaited<ReturnType<typeof runSession>>) =>
      [...r.mutants]
        .map((m) => `${m.file}:${m.line}:${m.operatorName}:${m.verdict}`)
        .sort();

    const results: string[][] = [];
    for (const workers of [1, 2, 4]) {
      const dirs = await makeProject();
      const store = new ResultsStore(":memory:");
      const report = await runSession({
        backend: new StubBackend(CAPS_NST, (mutant) => (mutant === null ? "pass" : "fail"), [
          "IsOverBudget",
        ]),
        backendFactory: () =>
          new StubBackend(CAPS_NST, (mutant) => (mutant === null ? "pass" : "fail"), [
            "IsOverBudget",
          ]),
        store,
        ...dirs,
        selectorIds,
        workers,
      });
      results.push(shape(report));
      store.close();
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  test("more than one worker actually runs concurrently", async () => {
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    let concurrent = 0;
    let peak = 0;
    const make = () =>
      new StubBackend(
        CAPS_NST,
        (mutant) => (mutant === null ? "pass" : "fail"),
        ["IsOverBudget"],
        async () => {
          concurrent++;
          peak = Math.max(peak, concurrent);
          await new Promise((r) => setTimeout(r, 5));
          concurrent--;
        },
      );
    await runSession({
      backend: make(),
      backendFactory: make,
      store,
      ...dirs,
      selectorIds,
      workers: 3,
    });
    expect(peak).toBeGreaterThan(1);
    store.close();
  });
});
```

Extend `StubBackend`'s constructor with an optional fourth parameter `private readonly onRun?: () => Promise<void>` and `await this.onRun?.()` at the top of its `run()` so the concurrency probe works.

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/runner/tests/orchestrator.test.ts`
Expected: FAIL — `workers` / `backendFactory` are not in `SessionConfig`.

- [ ] **Step 3: Implement**

In `packages/runner/src/orchestrator.ts`:

1. Add to `SessionConfig`:

```ts
  readonly workers?: number; // default 1 — a pool of one IS the sequential path
  readonly compileConcurrency?: number; // default min(workers, 4)
  /** Required when workers > 1: each worker needs its own backend instance. */
  readonly backendFactory?: (workerIndex: number) => ExecutionBackend;
```

2. Extract the existing per-mutant loop body into a module-level function:

```ts
async function runMutantsOnBackend(args: {
  readonly backend: ExecutionBackend;
  readonly mutants: readonly MutantManifestEntry[];
  readonly perMutantTests: ReadonlyMap<string, readonly TestMethodRef[]>;
  readonly baselineDuration: ReadonlyMap<string, number>;
  readonly fallbackTimeoutMs: number;
  readonly store: ResultsStore;
  readonly runId: number;
  readonly batchIndex: number;
  readonly outcomes: SessionOutcome[];
}): Promise<void>
```

Move the loop verbatim — activation, covering-test iteration, short-circuit, kill confirmation, `deadline-exceeded` handling from Task 1, and `record(...)` — changing only `cfg.backend` to `args.backend`.

3. In the batch loop, replace the single call with a fan-out:

```ts
      const workers = Math.max(1, cfg.workers ?? 1);
      const compileLimit = new Semaphore(cfg.compileConcurrency ?? Math.min(workers, 4));
      if (workers === 1) {
        await runMutantsOnBackend({ backend: cfg.backend, mutants: execute, /* …rest… */ });
      } else {
        const factory = cfg.backendFactory;
        if (factory === undefined)
          throw new Error("runSession: workers > 1 requires backendFactory");
        const shards = shardEvenly(execute, workers);
        await Promise.all(
          shards.map(async (shard, i) => {
            if (shard.length === 0) return;
            const backend = factory(i);
            // Each worker deploys its own copy: deploy is the compile-heavy
            // step, so it is what the semaphore bounds — not the test runs.
            await compileLimit.run(() => backend.deploy(batchDir));
            await runMutantsOnBackend({ backend, mutants: shard, /* …rest… */ });
          }),
        );
      }
```

`outcomes` is shared, and `store.recordMutant` / `recordTestResult` are synchronous `bun:sqlite` calls inside a single process, so no locking is needed. Sort `outcomes` before building the report so ordering is worker-independent:

```ts
  outcomes.sort((a, b) =>
    `${a.mutant.file}:${a.mutant.startIndex}`.localeCompare(`${b.mutant.file}:${b.mutant.startIndex}`),
  );
```

4. Import `shardEvenly` and `Semaphore` from `./pool`.

- [ ] **Step 4: Run tests**

Run: `bun test packages/runner` — PASS. `bun test` — PASS. `bun run typecheck`, `bunx biome check packages/runner` — clean.

- [ ] **Step 5: Commit**

```bash
git add packages/runner
git commit -m "feat(runner): parallel mutant execution across N workers

Mutants are sharded deterministically across workers, each with its own backend
instance; a bounded semaphore limits compile-heavy deploys independently of
worker count, because alc is CPU-bound. workers=1 is the existing sequential
path, so there is one implementation rather than two that can drift."
```

---

## Task 7: CLI flags and live verification

**Files:**
- Modify: `packages/runner/src/cli.ts`
- Modify: `packages/runner/tests/cli.test.ts`
- Modify: `packages/runner/itest/al-runner.itest.ts`
- Modify: `fixtures/README.md`

**Interfaces:**
- Consumes: `SessionConfig.workers` / `compileConcurrency` / `backendFactory` (Task 6).
- Produces: `--workers <n>` and `--compile-concurrency <n>` CLI flags.

- [ ] **Step 1: Write the failing test**

Append to `packages/runner/tests/cli.test.ts` (reuse the existing `parseCliConfig` import and style):

```ts
describe("parseCliConfig — worker flags", () => {
  test("defaults to a single worker", () => {
    const p = parseCliConfig(["run", "--project", "p", "--tests", "t", "--backend", "al-runner"]);
    if (p.mode === "dry-run") throw new Error("expected a run config");
    expect(p.workers).toBe(1);
  });

  test("accepts --workers and --compile-concurrency", () => {
    const p = parseCliConfig([
      "run", "--project", "p", "--tests", "t", "--backend", "al-runner",
      "--workers", "4", "--compile-concurrency", "2",
    ]);
    if (p.mode === "dry-run") throw new Error("expected a run config");
    expect(p.workers).toBe(4);
    expect(p.compileConcurrency).toBe(2);
  });

  test("rejects a non-positive worker count with a clear message", () => {
    expect(() =>
      parseCliConfig([
        "run", "--project", "p", "--tests", "t", "--backend", "al-runner", "--workers", "0",
      ]),
    ).toThrow(/--workers must be a positive integer/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/runner/tests/cli.test.ts`
Expected: FAIL — unknown options.

- [ ] **Step 3: Implement**

In `packages/runner/src/cli.ts`: add `workers: { type: "string" }` and `"compile-concurrency": { type: "string" }` to the `parseArgs` options; parse them into the returned config:

```ts
  const workers = values.workers === undefined ? 1 : Number(values.workers);
  if (!Number.isInteger(workers) || workers < 1)
    throw new Error("--workers must be a positive integer");
  const compileConcurrency =
    values["compile-concurrency"] === undefined
      ? undefined
      : Number(values["compile-concurrency"]);
  if (compileConcurrency !== undefined && (!Number.isInteger(compileConcurrency) || compileConcurrency < 1))
    throw new Error("--compile-concurrency must be a positive integer");
```

Include `workers` and `compileConcurrency` on the parsed run config, and pass them to `runSession` in `runFromCli`. When `workers > 1`, supply a `backendFactory` that builds a fresh backend of the selected kind per worker, giving each al-runner worker its own instrumented scratch dir:

```ts
      backendFactory: (i: number) => buildBackend(parsed, configFile, `${scratchRoot}/worker-${i}`),
```

Adjust `buildBackend` to take the scratch dir it should use.

- [ ] **Step 4: Run tests**

Run: `bun test packages/runner` — PASS. `bun run typecheck`, `bunx biome check packages/runner` — clean.

- [ ] **Step 5: Verify against the real runner at 1, 2 and 4 workers**

```bash
for W in 1 2 4; do
  echo "=== workers=$W ==="
  LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe" \
    bun packages/runner/src/cli.ts run --project fixtures/sandbox-app \
    --tests fixtures/sandbox-tests --backend al-runner \
    --config fixtures/sandbox-app/lethal.config.local.json --workers $W
done
```

Expected at EVERY worker count, identical: `killed 3, survived 13, no-coverage 0`, score `18.8%`. Record each wall-clock time. If any count disagrees, the sharding is wrong — fix it; do not change the expectations.

Then confirm no regression on the authoritative backend:

```bash
LETHAL_ITEST_BCDEV=1 bun run itest:bcdev     # expect: bcdev itest: PASS
```

- [ ] **Step 6: Document and commit**

Add a short "Parallel execution" section to `fixtures/README.md` recording the measured wall-clock at 1/2/4 workers, and stating that verdicts are identical at every worker count.

```bash
git add packages/runner fixtures/README.md
git commit -m "feat(runner): --workers and --compile-concurrency flags

Verified on the sandbox fixture: identical verdicts at 1, 2 and 4 workers
(3 killed / 13 survived / 0 no-coverage, 18.8%), with measured wall-clock
recorded in fixtures/README.md."
```

---

## Self-Review

**Spec coverage.** §4.1 timeout taxonomy → Task 1. §4.2 artifact identity → Task 2. §5 server mode (protocol, constraints, opt-in, equivalence gate) → Tasks 3–4. §6 worker model, two separate limits, sharding, determinism → Tasks 5–6. CLI surface and live verification → Task 7. §8 exit criteria → Task 1 (no kill from a deadline), Task 4 Step 6 and Task 7 Step 5 (fixture table at 1/2/4, both transports), Task 7 Step 5 (bcdev unaffected), Task 2 (no shared artifact paths). §7 out-of-scope items are correctly absent.

**Deliberate gap.** Per-worker baselines (spec §6) are not separately implemented: the batch loop establishes the baseline once per batch before fan-out, and every worker deploys the same artifact to its own dir. This is sound for al-runner, whose isolation is `full-reset` and whose workers are identical processes. It is NOT sound for heterogeneous containers — the container spec must add per-worker baseline qualification. Recorded here so it is not silently inherited.

**Type consistency.** `TestOutcome` gains `deadline-exceeded` in Task 1 and is used under that exact name in Tasks 3, 4, 6. `AlRunnerResult.kind` values (`tests`/`deadline`/`skip`/`error`) are consistent across Tasks 3 and 4. `shardEvenly`/`Semaphore` signatures match between Tasks 5 and 6. `workers`/`compileConcurrency`/`backendFactory` are named identically in Tasks 6 and 7. `counts.deadlineExceeded` is introduced in Task 1 and asserted there only.

**Placeholder scan.** No TBD/TODO. Every code step carries the code. The two `/* …rest… */` markers in Task 6 Step 3 refer to the argument object fully specified in that same step's `runMutantsOnBackend` signature.
