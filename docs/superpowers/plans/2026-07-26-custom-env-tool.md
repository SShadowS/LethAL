# Custom Environment Tool Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a project point LethAL at an external CLI that owns its BC environments (first case: Continia's `continia.exe`), described entirely in config — a tool path plus command templates for create / resolve / symbols / publish / delete — while LethAL's fenced `RunMutant` path keeps deciding every verdict.

**Architecture:** `envTool` is a provisioner, not a backend. A new `EnvToolClient` spawns the tool from argv templates and reads declared JSON paths out of its stdout. `env-tool-session.ts` runs that lifecycle once per process and returns a fully resolved `BcDevConfigSection`, which is substituted into the config the existing three `cli.ts` seams already consume. Publishing goes through the tool instead of `altool`; everything downstream of publish is unchanged code.

**Tech Stack:** Bun + TypeScript monorepo. `bun:test` for units. Existing modules: `packages/runner/src/{cli,publisher,bcdev-backend,harness,deployment-verifier,activation,publish-serializer}.ts`.

**Spec:** `docs/superpowers/specs/2026-07-26-custom-env-tool-design.md` — read it before Task 2. Roadmap item **R15**.

## Global Constraints

- No `!` non-null assertions (biome `noNonNullAssertion: error`). Destructure, then check `undefined`.
- `exactOptionalPropertyTypes`: build optional props with `...(v !== undefined ? { k: v } : {})`.
- Typed error classes extend `Error` **directly**, never each other. `EnvToolError extends Error`. Bisection aborts on anything that is not `AlcCompileError` (`orchestrator.ts:1686`) — a broken tool invocation must never be mistaken for "this source subset does not compile".
- **Fail loudly on caller-contract violations — throw, never return a plausible empty default.** "Empty-vs-empty matches" is this project's signature bug.
- Assert phase ordering with call counters on stateful fakes, never wall-clock timing.
- Every test must fail if its implementation is reverted. Red-check anything subtle: revert, confirm the specific test goes RED, restore.
- Build loop, order matters: `bun run typecheck` → `rm -rf packages/*/dist` → `bun test`. Lint only files you touched: `bunx biome check <paths>`.
- Git bash on Windows; never `2>nul` (creates undeletable files) — use `2>/dev/null`.
- Secrets (`password`, and any value sourced from `${…}`) are redacted as `***` in every error, log and echoed command. A block whose `reads` include `username` or `password` never has raw stdout echoed anywhere.
- Do not run live integration tests unless the task says to; they need a real environment.

---

## Already measured (spike, 2026-07-26) — do not re-measure

One environment was created and deleted against the real portal. These are facts, not assumptions:

| phase | result |
|---|---|
| `env create` | returns promptly, status **`Draft`** — inert, nothing listening |
| `env start` | ~2 s, "start requested" — async |
| `Draft → Starting` | ~1 s after the request |
| `Starting → Running` | **390 s** |
| BC Automation API answers `200` | **391 s** after the start request |

Status vocabulary: `Draft`, `Starting`, `Running`, `Stopped`. A fresh environment already carries
the companies `CRONUS Danmark A/S` and `My Company`. The env URL is `{origin}/{envId}`, derived
from the id, so a stop/start cannot move it.

**This is why `startEnv` and `readyWhen` exist in the config** and why they are required in
create-mode: publishing to a `Draft` environment fails against a dead endpoint.

---

### Task 1: Live probe — the one thing still unmeasured

The spike settled provisioning. What remains is whether bc-dev-mcp can drive one of these
environments, which picks the coverage mode. No production code changes.

**Files:**
- Create: `scripts/probe-continia-env.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a recorded decision — `coverageMode: "procedure" | "none"` — that Task 5 and Task 8 both read from this plan's "Probe result" section (append it below when the probe runs).

**Requires from the human:** a Continia API token in `CONTINIA_API_TOKEN`, an existing env id in `CONTINIA_ENV_ID`, and `continia.exe` at `U:/Git/CLI/continia.exe`. If those are unavailable, STOP and report — do not fabricate a result.

- [ ] **Step 1: Write the probe**

```typescript
#!/usr/bin/env bun
/**
 * The one question the 2026-07-26 spike did not answer: can bc-dev-mcp reach a Continia
 * environment? That decides the coverage mode (spec §Coverage). Provisioning timings and URL
 * stability are already measured — see "Already measured" in the plan; do not re-measure them.
 *
 * Uses an EXISTING environment. Prints findings; changes nothing.
 *
 *   CONTINIA_API_TOKEN=... CONTINIA_ENV_ID=... bun run scripts/probe-continia-env.ts
 */
import { BcDevMcpBackend } from "../packages/runner/src/bcdev-backend";

const TOOL = process.env.CONTINIA_TOOL ?? "U:/Git/CLI/continia.exe";
const ENV_ID = process.env.CONTINIA_ENV_ID;
if (ENV_ID === undefined) throw new Error("set CONTINIA_ENV_ID");

async function tool(args: readonly string[]): Promise<string> {
  const proc = Bun.spawn([TOOL, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${args.join(" ")} exited ${code}: ${err || out}`);
  return out;
}

const env = JSON.parse(await tool(["env", "get", ENV_ID, "--json"])) as {
  url: string;
  expiresUtc?: string;
};
const users = JSON.parse(await tool(["env", "users", ENV_ID, "--json"])) as Array<{
  username: string;
  password: string;
}>;
const user = users[0];
if (user === undefined) throw new Error("env has no users");
console.log(`url=${env.url} expiresUtc=${env.expiresUtc ?? "(none)"} user=${user.username}`);

const origin = new URL(env.url).origin;
const instance = new URL(env.url).pathname.replace(/^\/+|\/+$/g, "");

// Baseline: does the BC surface answer these credentials at all? If this fails, nothing below
// can succeed and the environment — not bc-dev-mcp — is the problem.
const auth = `Basic ${btoa(`${user.username}:${user.password}`)}`;
const probeUrl = `${origin}/${instance}/api/microsoft/automation/v2.0/companies`;
const res = await fetch(probeUrl, { headers: { Authorization: auth } });
console.log(`automation api: ${res.status} ${res.statusText}`);

// THE question: drive the real backend exactly as a session would, rather than eyeballing
// bc-dev-mcp by hand. `status()` is what runSession hard-gates on (orchestrator.ts), so this is
// the same call that would abort a real run.
const backend = new BcDevMcpBackend({
  mcpCommand: ["bun", "run", "U:/Git/bc-dev-mcp/src/mcp/index.ts"],
  server: origin,
  serverInstance: instance,
  tenant: "default",
  company: "CRONUS Danmark A/S",
  username: user.username,
  password: user.password,
  packageCachePath: ".alpackages",
  controlSymbolPath: "unused-for-status",
  env: { BC_DEV_USER: user.username, BC_DEV_PASSWORD: user.password },
});
try {
  const status = await backend.status();
  console.log(`bcdev_status ok=${status.ok}`);
  console.log(status.details.slice(0, 800));
  console.log(
    status.ok
      ? '\nVERDICT: coverageMode "procedure" — bc-dev-mcp drives this environment.'
      : '\nVERDICT: coverageMode "none" — quote the details above in the plan.',
  );
} finally {
  await backend.close();
}
```

- [ ] **Step 2: Run it**

Run: `CONTINIA_API_TOKEN=… CONTINIA_ENV_ID=… bun run scripts/probe-continia-env.ts`
Expected: the env url, an Automation-API status line, then `bcdev_status ok=true|false` and a
VERDICT line. Either verdict is a valid result — the point is to learn which, not to get `true`.

- [ ] **Step 3: If `bcdev_status` failed, establish WHY before accepting the fallback**

A `"none"` verdict costs real fidelity, so do not accept it on one failed call. Check that the
Automation-API line above returned 200 (if it did not, the environment is the problem, not
bc-dev-mcp), and quote bc-dev-mcp's own error text. A connection refused, an auth rejection, and an
unsupported-endpoint error are three different findings with three different follow-ups.

- [ ] **Step 4: Record the answer in this plan**

Append a `## Probe result` section to this file stating the chosen `coverageMode` and the evidence for it. If bc-dev-mcp failed, quote its error verbatim — Task 5 and Task 8 both read this section.

- [ ] **Step 5: Commit**

```bash
git add scripts/probe-continia-env.ts docs/superpowers/plans/2026-07-26-custom-env-tool.md
git commit -m "probe(envtool): measure what a Continia environment supports"
```

---

## Probe result (2026-07-26)

**`coverageMode: "none"`.** `bcdev_status` was run against the one existing environment
(`continia env list --json` → `description: "WI-63396"`, `status: "Running"` at the start of the
probe) and returned `ok: false` on every attempt, fast (no hang — each call returned in well under a
second, so this is a clean failure, not a timeout).

Ran with `BcDevMcpBackend({ mcpCommand: ["bun", "run", "U:/Git/bc-dev-mcp/src/mcp/index.ts"], server:
origin, serverInstance: instance, tenant: "default", company: "CRONUS Danmark A/S",
packageCachePath: ".alpackages", controlSymbolPath: "unused-for-status", env: { BC_DEV_USER,
BC_DEV_PASSWORD } }).status()` (project added — see "Deviation from the brief" below).

### Evidence, and why the fallback — not a shrug

Two independent, distinguishable failures, both established before accepting `"none"`:

1. **The environment surface itself was not answering.** The baseline Automation-API check
   (`{origin}/{instance}/api/microsoft/automation/v2.0/companies`) returned `503 Service Temporarily
   Unavailable` from `nginx` — and so did the bare root path `{origin}/{instance}/` with no API
   suffix at all, and a retry loop (3 attempts, 2s apart) got the identical `503` every time. Mid-probe,
   `continia env list --json` showed the environment's own reported status flip from `Running` to
   `Starting` — i.e. it had gone idle since the last real request and our probing triggered a cold
   start. The plan's own "Already measured" table above says `Starting → Running` takes **390s**; a
   background poll (`continia env list --json` every 15s) confirmed it stayed `Starting` for 60s+
   without flipping back to `Running` within the probe's run. This half of the failure is the
   **environment being asleep**, not bc-dev-mcp — consistent with Step 3's instruction to check the
   Automation-API status first.

2. **Independent of (1): bc-dev-mcp's dev-endpoint resolution is structurally incompatible with how
   Continia hosts this environment**, and would fail even against a fully-awake environment. Because
   `server` is supplied without `environmentType`, bc-dev-mcp's `resolveConnection`
   (`bc-dev-mcp/src/core/launch-config.ts:121`) treats the connection as `"OnPrem"`, and OnPrem
   metadata resolution (`bc-dev-mcp/src/core/urls.ts`, `DEFAULT_DEV_PORT = 7049`) always targets
   `{origin}:7049/{instance}/dev/metadata` — a raw TCP port. `bcdev_status`'s own error text:

   ```
   Dev endpoint unreachable at https://demoportaldev.continiaonline.com:7049/0494e53d-c76e-4a05-96f5-593d49830a64/dev/metadata?tenant=default
   — is the BC server running and the developer service port open?
   (Error: Unable to connect. Is the computer able to access the url?)
   ```

   That is a **connection-refused/unreachable** failure (TCP-level, verified directly: fetching
   `{origin}:7049/...` gave the same "Unable to connect" outside the backend too), not an auth
   rejection (no 401/403 was ever seen) and not an unsupported-endpoint-version error (bc-dev-mcp
   never got far enough to negotiate a version). Continia's hosted portal
   (`demoportaldev.continiaonline.com`) fronts everything through a single HTTPS reverse proxy,
   path-routed by environment id — there is no dev-service TCP port exposed at that hostname for
   bc-dev-mcp to reach, awake or not. `BcDevConfig`/`connectionShape` do carry a `port` override, but
   pointing it at 443 would not help: the dev endpoint's own routing (`/dev/metadata`, not
   `/{instance}/api/...`) is not one nginx is proxying through at all judging by the identical 503 on
   every path tried, including the bare root.

Given both a (possibly transient) environment-availability problem and a structural port-model
mismatch, `"procedure"` cannot be claimed. Per spec §Coverage, the session runs every mutant against
all green tests (`coverage: "none"`) — slower, never wrong.

### Deviation from the brief's literal script (recorded per the brief's own step 4)

The brief's Step 1 script was written against an earlier/assumed shape of `BcDevConfig`
(`packages/runner/src/bcdev-backend.ts`). Checked against the actual current interface before
running:

- `BcDevConfig.project` is a **required** `string` (not optional) — added
  `project: process.cwd()` to the constructed config. `bcdev_status`'s own schema
  (`connectionShape.project`, bc-dev-mcp) treats it as optional (falls back to the server's own cwd,
  and only matters for `.vscode/launch.json` discovery, which is fully overridden here anyway by the
  explicit `server`/`serverInstance`/`tenant` — this repo's root has no `.vscode/launch.json`, so
  the value is inert either way).
- `BcDevConfig` has **no** `username`/`password` fields at all — removed from the brief's literal
  script. `bcdev_status`'s wire schema carries no credential params; credentials reach the spawned
  bc-dev-mcp server only through `BC_DEV_USER`/`BC_DEV_PASSWORD` in `env`, which the brief's script
  already set correctly.

Neither change affects the verdict — both are TypeScript-shape corrections, not behavior changes.

---

### Task 2: `env-tool.ts` — config types and pure validation

**Files:**
- Create: `packages/runner/src/env-tool.ts`
- Test: `packages/runner/tests/env-tool-config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface EnvToolBlock { readonly command: readonly string[]; readonly reads?: Readonly<Record<string, string>> }`
  - `interface EnvToolConfigSection` (fields below)
  - `class EnvToolError extends Error`
  - `function validateEnvToolConfig(raw: Partial<EnvToolConfigSection> | undefined, opts: { env: Readonly<Record<string, string | undefined>>; hasPackageCachePath: boolean }): EnvToolConfigSection` — returns the section with every `${VAR}` already substituted.
  - `const LETHAL_PLACEHOLDERS`, `const READS_KEYS`, `const CREDENTIAL_READS_KEYS`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from "bun:test";
import { validateEnvToolConfig } from "../src/env-tool";
import type { EnvToolConfigSection } from "../src/env-tool";

const ENV = { CONTINIA_ENV_ID: "env-4711", TOKEN: "s3cret" };

function base(over: Partial<EnvToolConfigSection> = {}): Partial<EnvToolConfigSection> {
  return {
    toolPath: "C:/tools/continia.exe",
    envId: "env-4711",
    resolve: [
      { command: ["env", "get", "{envId}", "--json"], reads: { baseUrl: "url" } },
      { command: ["env", "users", "{envId}", "--json"],
        reads: { username: "0.username", password: "0.password" } },
    ],
    publish: { command: ["publish", "{envId}", "{appFile}", "--json"] },
    ...over,
  };
}

const opts = { env: ENV, hasPackageCachePath: true };

describe("validateEnvToolConfig", () => {
  it("accepts a reuse-mode config and substitutes ${VAR}", () => {
    const out = validateEnvToolConfig(
      base({ envId: "${CONTINIA_ENV_ID}", env: { CONTINIA_API_TOKEN: "${TOKEN}" } }),
      opts,
    );
    expect(out.envId).toBe("env-4711");
    expect(out.env?.CONTINIA_API_TOKEN).toBe("s3cret");
  });

  it("throws naming the variable and the field when ${VAR} is unset", () => {
    expect(() => validateEnvToolConfig(base({ envId: "${NOPE}" }), opts)).toThrow(
      /NOPE.*envId|envId.*NOPE/,
    );
  });

  it("rejects an unknown reads key", () => {
    const cfg = base({ resolve: [{ command: ["x"], reads: { baseUrl: "url", nope: "a" } }] });
    expect(() => validateEnvToolConfig(cfg, opts)).toThrow(/nope/);
  });

  it("rejects the same reads key produced by two blocks", () => {
    const cfg = base({
      resolve: [
        { command: ["a"], reads: { baseUrl: "url" } },
        { command: ["b"], reads: { baseUrl: "other", username: "u", password: "p" } },
      ],
    });
    expect(() => validateEnvToolConfig(cfg, opts)).toThrow(/baseUrl/);
  });

  it("rejects an unknown {placeholder}", () => {
    const cfg = base({ publish: { command: ["publish", "{nope}"] } });
    expect(() => validateEnvToolConfig(cfg, opts)).toThrow(/nope/);
  });

  it("rejects a vars entry nothing references, across ALL declared blocks", () => {
    const cfg = base({ vars: { unused: "x" } });
    expect(() => validateEnvToolConfig(cfg, opts)).toThrow(/unused/);
  });

  it("rejects a vars key shadowing a LethAL placeholder", () => {
    const cfg = base({
      vars: { envId: "x" },
      publish: { command: ["publish", "{envId}", "{appFile}"] },
    });
    expect(() => validateEnvToolConfig(cfg, opts)).toThrow(/envId/);
  });

  it("rejects a vars value referencing another vars entry", () => {
    const cfg = base({
      vars: { a: "1", b: "{a}" },
      publish: { command: ["publish", "{a}", "{b}", "{appFile}"] },
    });
    expect(() => validateEnvToolConfig(cfg, opts)).toThrow(/\ba\b/);
  });

  it("allows a LethAL placeholder inside a vars value", () => {
    const cfg = base({
      vars: { envName: "lethal-{runId}" },
      publish: { command: ["publish", "{envName}", "{appFile}"] },
    });
    expect(validateEnvToolConfig(cfg, opts).vars?.envName).toBe("lethal-{runId}");
  });

  it("requires the whole create-mode block set, one message at a time", () => {
    // Measured 2026-07-26: `env create` yields a Draft environment with nothing listening, and
    // `env start` is async — so create-mode without startEnv/readyWhen would publish to a dead
    // endpoint after paying ~6.5 minutes for the environment.
    const step = (over: Partial<EnvToolConfigSection>) => base({ envId: undefined, ...over });
    const createEnv = { command: ["env", "create", "--json"], reads: { envId: "id" } };
    const deleteEnv = { command: ["env", "delete", "{envId}"] };
    const startEnv = { command: ["env", "start", "{envId}"] };
    const readyWhen = {
      command: ["env", "get", "{envId}", "--json"],
      reads: { status: "status" },
      equals: "Running",
    };
    expect(() => validateEnvToolConfig(step({}), opts)).toThrow(/createEnv/);
    expect(() => validateEnvToolConfig(step({ createEnv }), opts)).toThrow(/deleteEnv/);
    expect(() => validateEnvToolConfig(step({ createEnv, deleteEnv }), opts)).toThrow(/startEnv/);
    expect(() => validateEnvToolConfig(step({ createEnv, deleteEnv, startEnv }), opts)).toThrow(
      /readyWhen/,
    );
    expect(() =>
      validateEnvToolConfig(step({ createEnv, deleteEnv, startEnv, readyWhen }), opts),
    ).toThrow(/publishApps/);
    expect(() =>
      validateEnvToolConfig(
        step({ createEnv, deleteEnv, startEnv, readyWhen, publishApps: ["tests.app"] }),
        opts,
      ),
    ).not.toThrow();
  });

  it("requires readyWhen to read status and to declare what ready means", () => {
    const common = {
      envId: undefined,
      createEnv: { command: ["env", "create", "--json"], reads: { envId: "id" } },
      deleteEnv: { command: ["env", "delete", "{envId}"] },
      startEnv: { command: ["env", "start", "{envId}"] },
      publishApps: ["tests.app"],
    };
    const noStatus = base({
      ...common,
      readyWhen: { command: ["env", "get", "{envId}", "--json"], equals: "Running" },
    });
    expect(() => validateEnvToolConfig(noStatus, opts)).toThrow(/status/);
    const noEquals = base({
      ...common,
      readyWhen: { command: ["env", "get", "{envId}", "--json"], reads: { status: "status" } },
    });
    expect(() => validateEnvToolConfig(noEquals, opts)).toThrow(/equals/);
  });

  it("requires downloadSymbols when packageCachePath is absent", () => {
    expect(() => validateEnvToolConfig(base(), { env: ENV, hasPackageCachePath: false })).toThrow(
      /downloadSymbols/,
    );
  });

  it("requires resolve to produce baseUrl, username and password", () => {
    const cfg = base({ resolve: [{ command: ["env", "get"], reads: { baseUrl: "url" } }] });
    expect(() => validateEnvToolConfig(cfg, opts)).toThrow(/username|password/);
  });

  it("allows a block with no reads at all", () => {
    const cfg = base({ deleteEnv: { command: ["env", "delete", "{envId}"] } });
    expect(() => validateEnvToolConfig(cfg, opts)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/runner/tests/env-tool-config.test.ts`
Expected: FAIL — `Cannot find module '../src/env-tool'`.

- [ ] **Step 3: Implement**

```typescript
/**
 * Config surface for an external environment tool (spec:
 * docs/superpowers/specs/2026-07-26-custom-env-tool-design.md). Pure — no I/O, no BC knowledge:
 * everything here is decidable from the config text plus an environment map, so every "your
 * config is wrong" error is unit-testable and fires BEFORE any process is spawned.
 */
export interface EnvToolBlock {
  readonly command: readonly string[];
  readonly reads?: Readonly<Record<string, string>>;
}

/**
 * A block that is polled until its `status` read equals `equals`. Measured 2026-07-26: `env create`
 * returns a Draft environment and `env start` is async, so create-mode must WAIT — provisioning is
 * a fast call plus ~390s of polling, which is why readiness carries its own budget instead of
 * borrowing the per-command `timeoutSeconds`.
 */
export interface EnvToolReadyBlock extends EnvToolBlock {
  readonly equals: string;
  readonly pollSeconds?: number;
  readonly timeoutSeconds?: number;
}

export interface EnvToolConfigSection {
  readonly toolPath: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly vars?: Readonly<Record<string, string>>;
  readonly envId?: string;
  readonly timeoutSeconds?: number;
  readonly publishApps?: readonly string[];
  readonly createEnv?: EnvToolBlock;
  readonly startEnv?: EnvToolBlock;
  readonly readyWhen?: EnvToolReadyBlock;
  readonly resolve?: readonly EnvToolBlock[];
  readonly downloadSymbols?: EnvToolBlock;
  readonly publish?: EnvToolBlock;
  readonly deleteEnv?: EnvToolBlock;
}

/**
 * Extends `Error` DIRECTLY, never `AlcCompileError`: bisection reads only `AlcCompileError` as
 * "this source subset does not compile" and aborts on everything else (orchestrator.ts). A broken
 * tool invocation must land in the abort branch, never be mistaken for a compile verdict.
 */
export class EnvToolError extends Error {}

/** Placeholders LethAL supplies. A `vars` key may not shadow one of these. */
export const LETHAL_PLACEHOLDERS = [
  "envId",
  "appFile",
  "projectDir",
  "testDir",
  "packageCache",
  "runId",
] as const;

/** The only keys a `reads` map may name. */
export const READS_KEYS = [
  "envId",
  "baseUrl",
  "username",
  "password",
  "server",
  "serverInstance",
  "expiresUtc",
  "status",
] as const;

/** Reads keys whose block must never have raw stdout echoed into an error. */
export const CREDENTIAL_READS_KEYS = ["username", "password"] as const;

const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const PLACEHOLDER_PATTERN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function substituteVars(
  value: string,
  field: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return value.replace(VAR_PATTERN, (_m, name: string) => {
    const v = env[name];
    if (v === undefined || v === "") {
      throw new EnvToolError(
        `envTool.${field}: environment variable \${${name}} is not set (or empty) — set it, or ` +
          `put a literal value in the config`,
      );
    }
    return v;
  });
}

function blocksOf(cfg: Partial<EnvToolConfigSection>): Array<{ name: string; block: EnvToolBlock }> {
  const out: Array<{ name: string; block: EnvToolBlock }> = [];
  if (cfg.createEnv) out.push({ name: "createEnv", block: cfg.createEnv });
  if (cfg.startEnv) out.push({ name: "startEnv", block: cfg.startEnv });
  if (cfg.readyWhen) out.push({ name: "readyWhen", block: cfg.readyWhen });
  (cfg.resolve ?? []).forEach((b, i) => out.push({ name: `resolve[${i}]`, block: b }));
  if (cfg.downloadSymbols) out.push({ name: "downloadSymbols", block: cfg.downloadSymbols });
  if (cfg.publish) out.push({ name: "publish", block: cfg.publish });
  if (cfg.deleteEnv) out.push({ name: "deleteEnv", block: cfg.deleteEnv });
  return out;
}

export function validateEnvToolConfig(
  raw: Partial<EnvToolConfigSection> | undefined,
  opts: { env: Readonly<Record<string, string | undefined>>; hasPackageCachePath: boolean },
): EnvToolConfigSection {
  if (!raw) throw new EnvToolError('config file is missing the "envTool" section');

  // 1. ${VAR} substitution first — later checks read substituted values.
  const cfg = substituteSection(raw, opts.env);

  // 2. Structural requirements.
  if (!cfg.toolPath) throw new EnvToolError("envTool.toolPath is required");
  if (!cfg.resolve || cfg.resolve.length === 0) {
    throw new EnvToolError("envTool.resolve is required — LethAL cannot find the environment");
  }
  if (!cfg.publish) throw new EnvToolError("envTool.publish is required");
  const createMode = cfg.envId === undefined || cfg.envId === "";
  if (createMode) {
    if (!cfg.createEnv) {
      throw new EnvToolError(
        "envTool.createEnv is required when envTool.envId is absent (create-mode)",
      );
    }
    if (!cfg.deleteEnv) {
      throw new EnvToolError(
        "envTool.deleteEnv is required in create-mode — LethAL will not create an environment it " +
          "cannot delete",
      );
    }
    // Measured 2026-07-26: `env create` returns a Draft environment with nothing listening, and
    // `env start` is async (~390s to a usable endpoint). Publishing to it before it is Running
    // fails against a dead endpoint AFTER paying the provisioning cost.
    if (!cfg.startEnv) {
      throw new EnvToolError(
        "envTool.startEnv is required in create-mode — a newly created environment is inert until " +
          "it is started",
      );
    }
    const ready = cfg.readyWhen;
    if (!ready) {
      throw new EnvToolError(
        "envTool.readyWhen is required in create-mode — starting is asynchronous, so LethAL must " +
          "know how to poll for readiness rather than publishing into a dead endpoint",
      );
    }
    if (ready.reads?.status === undefined) {
      throw new EnvToolError("envTool.readyWhen.reads must contain a status path");
    }
    if (!ready.equals) {
      throw new EnvToolError(
        'envTool.readyWhen.equals is required — it names the status that means ready (e.g. "Running")',
      );
    }
    if (!cfg.publishApps || cfg.publishApps.length === 0) {
      throw new EnvToolError(
        "envTool.publishApps is required in create-mode: a freshly created environment contains " +
          "no test app, so every discovered test would fail at execution",
      );
    }
  }
  if (!opts.hasPackageCachePath && !cfg.downloadSymbols) {
    throw new EnvToolError(
      "envTool.downloadSymbols is required when bcdev.packageCachePath is absent",
    );
  }

  // 3. reads keys: known, and produced exactly once across all blocks.
  const produced = new Map<string, string>();
  for (const { name, block } of blocksOf(cfg)) {
    for (const key of Object.keys(block.reads ?? {})) {
      if (!(READS_KEYS as readonly string[]).includes(key)) {
        throw new EnvToolError(
          `envTool.${name}.reads: unknown key ${JSON.stringify(key)} — expected one of ` +
            `${READS_KEYS.join(", ")}`,
        );
      }
      const prior = produced.get(key);
      if (prior !== undefined) {
        throw new EnvToolError(
          `envTool: reads key ${JSON.stringify(key)} is produced by both ${prior} and ${name} — ` +
            `two sources for one value is how two clients end up pointed at different endpoints`,
        );
      }
      produced.set(key, name);
    }
  }
  for (const required of ["baseUrl", "username", "password"]) {
    if (!produced.has(required)) {
      throw new EnvToolError(`envTool.resolve must produce ${required} (no block reads it)`);
    }
  }
  if (createMode && !produced.has("envId")) {
    throw new EnvToolError("envTool.createEnv.reads must produce envId in create-mode");
  }

  // 4. Placeholders: known, and every declared var referenced by something.
  const varNames = new Set(Object.keys(cfg.vars ?? {}));
  for (const name of varNames) {
    if ((LETHAL_PLACEHOLDERS as readonly string[]).includes(name)) {
      throw new EnvToolError(
        `envTool.vars.${name} shadows a placeholder LethAL supplies — rename it`,
      );
    }
  }
  for (const [name, value] of Object.entries(cfg.vars ?? {})) {
    for (const [, ref] of value.matchAll(PLACEHOLDER_PATTERN)) {
      if (varNames.has(ref)) {
        throw new EnvToolError(
          `envTool.vars.${name} references another vars entry {${ref}} — only LethAL-supplied ` +
            `placeholders may appear inside a vars value`,
        );
      }
      if (!(LETHAL_PLACEHOLDERS as readonly string[]).includes(ref)) {
        throw new EnvToolError(`envTool.vars.${name}: unknown placeholder {${ref}}`);
      }
    }
  }
  const referenced = new Set<string>();
  for (const { name, block } of blocksOf(cfg)) {
    for (const arg of block.command) {
      for (const [, ref] of arg.matchAll(PLACEHOLDER_PATTERN)) {
        const known =
          (LETHAL_PLACEHOLDERS as readonly string[]).includes(ref) || varNames.has(ref);
        if (!known) {
          throw new EnvToolError(
            `envTool.${name}.command: unknown placeholder {${ref}} — expected one of ` +
              `${LETHAL_PLACEHOLDERS.join(", ")} or a key of envTool.vars`,
          );
        }
        referenced.add(ref);
      }
    }
  }
  for (const name of varNames) {
    if (!referenced.has(name)) {
      throw new EnvToolError(
        `envTool.vars.${name} is never referenced by any declared command — that is a typo, not a ` +
          `default`,
      );
    }
  }
  return cfg;
}

function substituteSection(
  raw: Partial<EnvToolConfigSection>,
  env: Readonly<Record<string, string | undefined>>,
): EnvToolConfigSection {
  const sub = (v: string, field: string) => substituteVars(v, field, env);
  const subBlock = (b: EnvToolBlock, field: string): EnvToolBlock => ({
    command: b.command.map((a, i) => sub(a, `${field}.command[${i}]`)),
    ...(b.reads !== undefined ? { reads: b.reads } : {}),
  });
  return {
    toolPath: raw.toolPath === undefined ? "" : sub(raw.toolPath, "toolPath"),
    ...(raw.cwd !== undefined ? { cwd: sub(raw.cwd, "cwd") } : {}),
    ...(raw.env !== undefined
      ? {
          env: Object.fromEntries(
            Object.entries(raw.env).map(([k, v]) => [k, sub(v, `env.${k}`)]),
          ),
        }
      : {}),
    ...(raw.vars !== undefined
      ? {
          vars: Object.fromEntries(
            Object.entries(raw.vars).map(([k, v]) => [k, sub(v, `vars.${k}`)]),
          ),
        }
      : {}),
    ...(raw.envId !== undefined ? { envId: sub(raw.envId, "envId") } : {}),
    ...(raw.timeoutSeconds !== undefined ? { timeoutSeconds: raw.timeoutSeconds } : {}),
    ...(raw.publishApps !== undefined
      ? { publishApps: raw.publishApps.map((p, i) => sub(p, `publishApps[${i}]`)) }
      : {}),
    ...(raw.createEnv !== undefined ? { createEnv: subBlock(raw.createEnv, "createEnv") } : {}),
    ...(raw.resolve !== undefined
      ? { resolve: raw.resolve.map((b, i) => subBlock(b, `resolve[${i}]`)) }
      : {}),
    ...(raw.downloadSymbols !== undefined
      ? { downloadSymbols: subBlock(raw.downloadSymbols, "downloadSymbols") }
      : {}),
    ...(raw.publish !== undefined ? { publish: subBlock(raw.publish, "publish") } : {}),
    ...(raw.deleteEnv !== undefined ? { deleteEnv: subBlock(raw.deleteEnv, "deleteEnv") } : {}),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run typecheck && rm -rf packages/*/dist && bun test packages/runner/tests/env-tool-config.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
bunx biome check packages/runner/src/env-tool.ts packages/runner/tests/env-tool-config.test.ts
git add packages/runner/src/env-tool.ts packages/runner/tests/env-tool-config.test.ts
git commit -m "feat(envtool): config surface and validation that fires before anything spawns"
```

---

### Task 3: `env-tool.ts` — render, spawn, read, redact

**Files:**
- Modify: `packages/runner/src/env-tool.ts` (append)
- Test: `packages/runner/tests/env-tool-client.test.ts`

**Interfaces:**
- Consumes: `EnvToolConfigSection`, `EnvToolBlock`, `EnvToolError`, `CREDENTIAL_READS_KEYS` (Task 2); `SpawnFn` from `./publisher`.
- Produces:
  - `function renderCommand(block: EnvToolBlock, cfg: EnvToolConfigSection, supplied: Readonly<Record<string, string>>): string[]`
  - `function redact(text: string, secrets: readonly string[]): string`
  - `class EnvToolClient { constructor(cfg: EnvToolConfigSection, io?: { spawn: SpawnFn }); async run(block: EnvToolBlock, name: string, supplied: Readonly<Record<string,string>>): Promise<Record<string,string>>; addSecret(value: string): void }`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from "bun:test";
import { EnvToolClient, redact, renderCommand } from "../src/env-tool";
import type { EnvToolConfigSection } from "../src/env-tool";

const CFG: EnvToolConfigSection = {
  toolPath: "C:/tools/continia.exe",
  vars: { profile: "bc28-w1" },
  publish: { command: ["publish", "{envId}", "{appFile}", "--profile", "{profile}"] },
  resolve: [],
};

function fakeSpawn(results: Array<{ exitCode: number; stdout: string; stderr: string }>) {
  const calls: string[][] = [];
  let i = 0;
  return {
    calls,
    spawn: async (argv: readonly string[]) => {
      calls.push([...argv]);
      const r = results[i];
      i += 1;
      if (r === undefined) throw new Error("fake spawn: no result queued");
      return r;
    },
  };
}

describe("renderCommand", () => {
  it("prefixes toolPath and substitutes LethAL placeholders and vars", () => {
    const argv = renderCommand(CFG.publish as never, CFG, { envId: "e1", appFile: "a.app" });
    expect(argv).toEqual([
      "C:/tools/continia.exe", "publish", "e1", "a.app", "--profile", "bc28-w1",
    ]);
  });

  it("throws when a placeholder has no supplied value", () => {
    expect(() => renderCommand(CFG.publish as never, CFG, { envId: "e1" })).toThrow(/appFile/);
  });
});

describe("redact", () => {
  it("replaces every secret occurrence", () => {
    expect(redact("user=admin pw=hunter2 again hunter2", ["hunter2"])).toBe(
      "user=admin pw=*** again ***",
    );
  });
});

describe("EnvToolClient.run", () => {
  const block = { command: ["env", "get", "{envId}", "--json"], reads: { baseUrl: "url" } };

  it("reads a declared dot path out of stdout", async () => {
    const io = fakeSpawn([{ exitCode: 0, stdout: '{"url":"https://h/e1"}', stderr: "" }]);
    const client = new EnvToolClient(CFG, io);
    expect(await client.run(block, "resolve[0]", { envId: "e1" })).toEqual({
      baseUrl: "https://h/e1",
    });
    expect(io.calls[0]?.slice(1)).toEqual(["env", "get", "e1", "--json"]);
  });

  it("indexes arrays with numeric path segments", async () => {
    const users = { command: ["env", "users"], reads: { username: "0.username" } };
    const io = fakeSpawn([{ exitCode: 0, stdout: '[{"username":"admin"}]', stderr: "" }]);
    expect(await new EnvToolClient(CFG, io).run(users, "resolve[1]", {})).toEqual({
      username: "admin",
    });
  });

  it("throws with exit code and stderr on non-zero exit", async () => {
    const io = fakeSpawn([{ exitCode: 2, stdout: "", stderr: "boom" }]);
    await expect(new EnvToolClient(CFG, io).run(block, "resolve[0]", { envId: "e1" })).rejects.toThrow(
      /exit 2.*boom/s,
    );
  });

  it("throws naming key, path and command when the path is missing", async () => {
    const io = fakeSpawn([{ exitCode: 0, stdout: '{"other":1}', stderr: "" }]);
    await expect(new EnvToolClient(CFG, io).run(block, "resolve[0]", { envId: "e1" })).rejects.toThrow(
      /baseUrl.*url.*env get/s,
    );
  });

  it("throws on an empty resolved value rather than passing it on", async () => {
    const io = fakeSpawn([{ exitCode: 0, stdout: '{"url":""}', stderr: "" }]);
    await expect(new EnvToolClient(CFG, io).run(block, "resolve[0]", { envId: "e1" })).rejects.toThrow(
      /empty/,
    );
  });

  it("echoes stdout on a parse failure for a non-credential block", async () => {
    const io = fakeSpawn([{ exitCode: 0, stdout: "not json at all", stderr: "" }]);
    await expect(new EnvToolClient(CFG, io).run(block, "resolve[0]", { envId: "e1" })).rejects.toThrow(
      /not json/,
    );
  });

  it("NEVER echoes stdout on a parse failure for a credential-bearing block", async () => {
    // The password was never read as a value, so value-based redaction cannot scrub it.
    const creds = { command: ["env", "users"], reads: { username: "0.username", password: "0.password" } };
    const io = fakeSpawn([{ exitCode: 0, stdout: '[{"password":"hunter2"' , stderr: "" }]);
    const err = await new EnvToolClient(CFG, io)
      .run(creds, "resolve[1]", {})
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(err).not.toContain("hunter2");
    expect(err).toMatch(/withheld/);
  });

  it("redacts a known secret in a non-zero-exit error", async () => {
    const io = fakeSpawn([{ exitCode: 1, stdout: "", stderr: "auth failed for hunter2" }]);
    const client = new EnvToolClient(CFG, io);
    client.addSecret("hunter2");
    const err = await client
      .run(block, "resolve[0]", { envId: "e1" })
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(err).not.toContain("hunter2");
    expect(err).toContain("***");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/runner/tests/env-tool-client.test.ts`
Expected: FAIL — `renderCommand`/`EnvToolClient`/`redact` are not exported.

- [ ] **Step 3: Implement (append to `env-tool.ts`)**

```typescript
import { defaultSpawn } from "./publisher";
import type { SpawnFn } from "./publisher";

/** Renders one block's argv: `[toolPath, ...command]` with every `{placeholder}` substituted. */
export function renderCommand(
  block: EnvToolBlock,
  cfg: EnvToolConfigSection,
  supplied: Readonly<Record<string, string>>,
): string[] {
  const values: Record<string, string> = { ...(cfg.vars ?? {}), ...supplied };
  // A vars value may itself contain LethAL placeholders ("lethal-{runId}") — resolve those first.
  for (const [k, v] of Object.entries(cfg.vars ?? {})) {
    values[k] = v.replace(PLACEHOLDER_PATTERN, (m, ref: string) => supplied[ref] ?? m);
  }
  const args = block.command.map((arg) =>
    arg.replace(PLACEHOLDER_PATTERN, (_m, ref: string) => {
      const v = values[ref];
      if (v === undefined || v === "") {
        throw new EnvToolError(
          `envTool: no value available for placeholder {${ref}} while building ` +
            `${JSON.stringify(block.command.join(" "))}`,
        );
      }
      return v;
    }),
  );
  return [cfg.toolPath, ...args];
}

/** Replaces every occurrence of every secret with `***`. Order-independent, longest first. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of [...secrets].filter((s) => s.length > 0).sort((a, b) => b.length - a.length)) {
    out = out.split(s).join("***");
  }
  return out;
}

function readPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number.parseInt(seg, 10);
      if (Number.isNaN(idx)) return undefined;
      cur = cur[idx];
      continue;
    }
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Spawns the configured tool. argv array, never a shell: no quoting rules for the user to get
 * wrong and no injection surface from an interpolated value.
 */
export class EnvToolClient {
  private readonly secrets: string[] = [];

  constructor(
    private readonly cfg: EnvToolConfigSection,
    private readonly io: { spawn: SpawnFn } = { spawn: defaultSpawn },
  ) {
    for (const v of Object.values(cfg.env ?? {})) this.secrets.push(v);
  }

  /** Registers a value that must never appear in any error or log (resolved passwords). */
  addSecret(value: string): void {
    if (value.length > 0) this.secrets.push(value);
  }

  async run(
    block: EnvToolBlock,
    name: string,
    supplied: Readonly<Record<string, string>>,
  ): Promise<Record<string, string>> {
    const argv = renderCommand(block, this.cfg, supplied);
    const shown = redact(argv.join(" "), this.secrets);
    const readsCredentials = Object.keys(block.reads ?? {}).some((k) =>
      (CREDENTIAL_READS_KEYS as readonly string[]).includes(k),
    );
    const timeoutMs = (this.cfg.timeoutSeconds ?? 900) * 1000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: { exitCode: number; stdout: string; stderr: string };
    try {
      res = await this.io.spawn(argv, {
        signal: controller.signal,
        ...(this.cfg.env !== undefined ? { env: { ...this.cfg.env } } : {}),
      });
    } catch (err) {
      throw new EnvToolError(
        `envTool.${name}: ${shown} failed to run: ` +
          redact(err instanceof Error ? err.message : String(err), this.secrets),
      );
    } finally {
      clearTimeout(timer);
    }
    if (res.exitCode !== 0) {
      const detail = readsCredentials
        ? "(output withheld: this command's output carries credentials)"
        : redact([res.stdout, res.stderr].filter((s) => s.trim().length > 0).join("\n"), this.secrets);
      throw new EnvToolError(`envTool.${name}: ${shown} exited ${res.exitCode}:\n${detail}`);
    }
    const reads = block.reads;
    if (reads === undefined) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch (err) {
      const tail = readsCredentials
        ? "(output withheld: this command's output carries credentials)"
        : `stdout began: ${redact(res.stdout.slice(0, 200), this.secrets)}`;
      throw new EnvToolError(
        `envTool.${name}: ${shown} did not print JSON (${
          err instanceof Error ? err.message : String(err)
        }) — ${tail}`,
      );
    }
    const out: Record<string, string> = {};
    for (const [key, path] of Object.entries(reads)) {
      const value = readPath(parsed, path);
      if (typeof value !== "string" && typeof value !== "number") {
        throw new EnvToolError(
          `envTool.${name}: reads.${key} path ${JSON.stringify(path)} did not resolve to a ` +
            `string or number in the output of ${shown}`,
        );
      }
      const asString = String(value);
      if (asString.length === 0) {
        throw new EnvToolError(
          `envTool.${name}: reads.${key} path ${JSON.stringify(path)} resolved to an EMPTY value ` +
            `in the output of ${shown} — refusing to carry an empty ${key} forward`,
        );
      }
      out[key] = asString;
      if ((CREDENTIAL_READS_KEYS as readonly string[]).includes(key)) this.addSecret(asString);
    }
    return out;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run typecheck && rm -rf packages/*/dist && bun test packages/runner/tests/env-tool-client.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Red-check the credential-withholding rule**

Change `readsCredentials` in the JSON-parse branch to always `false`, run
`bun test packages/runner/tests/env-tool-client.test.ts`, confirm the "NEVER echoes stdout" test goes RED, restore, confirm GREEN. Report both.

- [ ] **Step 6: Commit**

```bash
bunx biome check packages/runner/src/env-tool.ts packages/runner/tests/env-tool-client.test.ts
git add packages/runner/src/env-tool.ts packages/runner/tests/env-tool-client.test.ts
git commit -m "feat(envtool): spawn, declared-path reads, and credential-safe error text"
```

---

### Task 4: publish through the tool

**Files:**
- Modify: `packages/runner/src/publisher.ts` (add `AppPublisher` interface)
- Modify: `packages/runner/src/bcdev-backend.ts` (`BcDevDeployment.deployer` types as `AppPublisher`)
- Create: `packages/runner/src/env-tool-publisher.ts`
- Test: `packages/runner/tests/env-tool-publisher.test.ts`

**Interfaces:**
- Consumes: `EnvToolClient`, `EnvToolBlock` (Tasks 2-3); `CompiledArtifact` from `./artifact`; `serializePublish`, `canonicalContainerKey` from `./publish-serializer`.
- Produces:
  - `interface AppPublisher { publish(artifact: CompiledArtifact): Promise<void> }` (in `publisher.ts`)
  - `class EnvToolPublisher implements AppPublisher` with also `publishFile(appPath: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "bun:test";
import { EnvToolPublisher } from "../src/env-tool-publisher";
import { EnvToolClient } from "../src/env-tool";
import type { EnvToolConfigSection } from "../src/env-tool";

const CFG: EnvToolConfigSection = {
  toolPath: "tool.exe",
  publish: { command: ["publish", "{envId}", "{appFile}"] },
  resolve: [],
};
const BYTES = new Uint8Array([1, 2, 3]);
const DIGEST = Bun.SHA256.hash(BYTES, "hex");

function publisherWith(spawnResult: { exitCode: number; stdout: string; stderr: string }) {
  const calls: string[][] = [];
  const client = new EnvToolClient(CFG, {
    spawn: async (argv) => {
      calls.push([...argv]);
      return spawnResult;
    },
  });
  const publishBlock = CFG.publish;
  if (publishBlock === undefined) throw new Error("fixture has no publish block");
  return {
    calls,
    publisher: new EnvToolPublisher(
      client,
      publishBlock,
      { envId: "e1", serializerKey: "https://h|e1|default" },
      { readArtifact: async () => BYTES },
    ),
  };
}

describe("EnvToolPublisher", () => {
  it("publishes an artifact whose digest still matches", async () => {
    const { calls, publisher } = publisherWith({ exitCode: 0, stdout: "{}", stderr: "" });
    await publisher.publish({
      appId: "a", artifactId: "0".repeat(32), appPath: "x.app", sha256: DIGEST, version: "1.0.0.1",
    } as never);
    expect(calls[0]).toEqual(["tool.exe", "publish", "e1", "x.app"]);
  });

  it("refuses to publish when the file changed after compilation", async () => {
    const { publisher } = publisherWith({ exitCode: 0, stdout: "{}", stderr: "" });
    await expect(
      publisher.publish({
        appId: "a", artifactId: "0".repeat(32), appPath: "x.app", sha256: "deadbeef",
        version: "1.0.0.1",
      } as never),
    ).rejects.toThrow(/digest/);
  });

  it("surfaces the tool's failure text so version-conflict recovery can parse it", async () => {
    const { publisher } = publisherWith({
      exitCode: 1,
      stdout: "Cannot install the extension because a newer version 1.0.0.9 was already installed.",
      stderr: "",
    });
    await expect(
      publisher.publish({
        appId: "a", artifactId: "0".repeat(32), appPath: "x.app", sha256: DIGEST, version: "1.0.0.1",
      } as never),
    ).rejects.toThrow(/newer version 1\.0\.0\.9/);
  });

  it("publishFile hashes at read instead of comparing to an expectation", async () => {
    const { calls, publisher } = publisherWith({ exitCode: 0, stdout: "{}", stderr: "" });
    await publisher.publishFile("lethal-control.app");
    expect(calls[0]).toEqual(["tool.exe", "publish", "e1", "lethal-control.app"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/runner/tests/env-tool-publisher.test.ts`
Expected: FAIL — module `../src/env-tool-publisher` not found.

- [ ] **Step 3: Add the interface to `publisher.ts`**

```typescript
/**
 * The publish half of a deployment channel. `ContainerDeployer` (altool against a container) and
 * `EnvToolPublisher` (an external environment CLI) both satisfy it, so `BcDevDeployment` can name
 * the contract rather than one implementation.
 */
export interface AppPublisher {
  publish(artifact: CompiledArtifact): Promise<void>;
}
```

In `bcdev-backend.ts`, change `BcDevDeployment.deployer`'s type from `ContainerDeployer` to `AppPublisher` and import the interface instead of the class where only the type is used.

- [ ] **Step 4: Implement `env-tool-publisher.ts`**

```typescript
import type { CompiledArtifact } from "./artifact";
import type { EnvToolBlock, EnvToolClient } from "./env-tool";
import { EnvToolError } from "./env-tool";
import { serializePublish } from "./publish-serializer";
import type { AppPublisher } from "./publisher";

export interface EnvToolPublisherIo {
  readonly readArtifact: (path: string) => Promise<Uint8Array>;
}

/**
 * Publishes through the configured environment tool instead of altool. Same guarantees as
 * `ContainerDeployer.publish`: the artifact's bytes are re-hashed immediately before the publish
 * and a mismatch refuses, and publishes serialize per environment (the key is
 * `canonicalContainerKey` of the resolved connection, whose serverInstance IS the envId).
 *
 * The tool's failure text is surfaced verbatim (both streams) because the orchestrator's one-shot
 * version-conflict recovery parses BC's rejection message out of it.
 */
export class EnvToolPublisher implements AppPublisher {
  constructor(
    private readonly client: EnvToolClient,
    private readonly block: EnvToolBlock,
    private readonly ctx: { readonly envId: string; readonly serializerKey: string },
    private readonly io: EnvToolPublisherIo,
  ) {}

  async publish(artifact: CompiledArtifact): Promise<void> {
    await serializePublish(this.ctx.serializerKey, async () => {
      const bytes = await this.io.readArtifact(artifact.appPath);
      const actual = Bun.SHA256.hash(bytes, "hex");
      if (actual !== artifact.sha256) {
        throw new EnvToolError(
          `refusing to publish ${artifact.appPath}: digest ${actual} does not match the compiled ` +
            `artifact's ${artifact.sha256} — the file changed after compilation`,
        );
      }
      await this.client.run(this.block, "publish", {
        envId: this.ctx.envId,
        appFile: artifact.appPath,
      });
    });
  }

  /**
   * Publishes a file that has no `CompiledArtifact` record — `lethal-control.app` and every
   * `publishApps` entry. The digest is computed and reported rather than compared: there is no
   * expectation to compare against, and inventing one would be theatre.
   */
  async publishFile(appPath: string): Promise<void> {
    await serializePublish(this.ctx.serializerKey, async () => {
      const bytes = await this.io.readArtifact(appPath);
      const digest = Bun.SHA256.hash(bytes, "hex");
      console.log(`[lethal] publishing ${appPath} (sha256 ${digest}) to env ${this.ctx.envId}`);
      await this.client.run(this.block, "publish", { envId: this.ctx.envId, appFile: appPath });
    });
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `bun run typecheck && rm -rf packages/*/dist && bun test packages/runner`
Expected: PASS — the 4 new tests plus every existing runner test.

- [ ] **Step 6: Commit**

```bash
bunx biome check packages/runner/src/env-tool-publisher.ts packages/runner/src/publisher.ts packages/runner/src/bcdev-backend.ts packages/runner/tests/env-tool-publisher.test.ts
git add packages/runner/src/env-tool-publisher.ts packages/runner/src/publisher.ts packages/runner/src/bcdev-backend.ts packages/runner/tests/env-tool-publisher.test.ts
git commit -m "feat(envtool): publish through the tool, same digest and serialization guarantees"
```

---

### Task 5: coverage mode and an MCP-free readiness probe

Without this, a fallback run aborts at `runSession`'s readiness gate before any fenced call — `status()` goes through bc-dev-mcp and `capabilities()` hardcodes `"procedure"`.

**Files:**
- Modify: `packages/runner/src/bcdev-backend.ts`
- Test: `packages/runner/tests/bcdev-backend.test.ts` (append)

**Interfaces:**
- Consumes: `HarnessVerifier` from `./harness` (already imported by callers).
- Produces: `BcDevConfig.coverageMode?: "procedure" | "none"` — default `"procedure"`, so every existing caller is unchanged.

- [ ] **Step 1: Write the failing tests**

```typescript
describe("coverageMode", () => {
  it("defaults to procedure and probes status through bc-dev-mcp", () => {
    const backend = new BcDevMcpBackend(baseConfig());
    expect(backend.capabilities().coverage).toBe("procedure");
  });

  it('reports coverage "none" when configured, keeping authoritative true', () => {
    const backend = new BcDevMcpBackend({ ...baseConfig(), coverageMode: "none" });
    expect(backend.capabilities().coverage).toBe("none");
    expect(backend.capabilities().authoritative).toBe(true);
  });

  it('status() in "none" mode probes the harness, never bc-dev-mcp', async () => {
    let harnessCalls = 0;
    const harnessVerifier = {
      verify: async () => {
        harnessCalls += 1;
        return { serverGeneration: "g1" } as never;
      },
    };
    const backend = new BcDevMcpBackend(
      { ...baseConfig(), coverageMode: "none" },
      () => {
        throw new Error("bc-dev-mcp must not be contacted in coverage:none mode");
      },
      { ...deploymentStub(), harnessVerifier } as never,
    );
    const status = await backend.status();
    expect(status.ok).toBe(true);
    expect(harnessCalls).toBe(1);
  });

  it('throws in "none" mode when no harness verifier was provided', async () => {
    const backend = new BcDevMcpBackend({ ...baseConfig(), coverageMode: "none" });
    await expect(backend.status()).rejects.toThrow(/harnessVerifier/);
  });
});
```

(`baseConfig()` and `deploymentStub()` already exist in this test file; reuse them.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/runner/tests/bcdev-backend.test.ts`
Expected: FAIL — `coverageMode` is not a known property, `capabilities().coverage` is always `"procedure"`.

- [ ] **Step 3: Implement**

In `BcDevConfig` add:

```typescript
  /**
   * Coverage the backend claims. Default "procedure" — bc-dev-mcp returns per-procedure coverage
   * for the baseline run. Set to "none" when bc-dev-mcp cannot reach the environment (the env-tool
   * fallback, spec §Coverage): the session then runs every mutant against all green tests, which
   * is slower and never wrong. Per-mutant execution is `coverage: "none"` through the fenced
   * transport in BOTH modes, so this changes baseline routing and selection only.
   */
  readonly coverageMode?: "procedure" | "none";
```

Replace `capabilities()` and `status()`:

```typescript
  capabilities(): BackendCapabilities {
    return {
      coverage: this.cfg.coverageMode ?? "procedure",
      deploy: "publish",
      isolation: "session",
      authoritative: true,
    };
  }

  async status(): Promise<BackendStatus> {
    // In "none" mode nothing in this session ever calls bc-dev-mcp — baseline and mutant runs both
    // go through RunMutantTransport, and discovery is static from source. Probing it here would
    // fail the session's readiness gate (orchestrator.ts) for a capability it does not use, so the
    // readiness question becomes "does the control app answer", which is the thing that matters.
    if ((this.cfg.coverageMode ?? "procedure") === "none") {
      const harnessVerifier = this.deployment?.harnessVerifier;
      if (harnessVerifier === undefined) {
        throw new Error(
          'BcDevMcpBackend: coverageMode "none" requires a harnessVerifier in BcDevDeployment — ' +
            "it is the readiness probe in that mode",
        );
      }
      try {
        const details = await harnessVerifier.verify();
        return { ok: true, details: `harness generation ${details.serverGeneration}` };
      } catch (err) {
        return { ok: false, details: err instanceof Error ? err.message : String(err) };
      }
    }
    // …existing bc-dev-mcp path unchanged…
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run typecheck && rm -rf packages/*/dist && bun test packages/runner`
Expected: PASS.

- [ ] **Step 5: Red-check**

Revert `capabilities()` to the hardcoded `"procedure"`, confirm the `coverage "none"` test goes RED, restore. Report both.

- [ ] **Step 6: Commit**

```bash
bunx biome check packages/runner/src/bcdev-backend.ts packages/runner/tests/bcdev-backend.test.ts
git add packages/runner/src/bcdev-backend.ts packages/runner/tests/bcdev-backend.test.ts
git commit -m "feat(runner): coverage mode as config, with an MCP-free readiness probe"
```

---

### Task 6: `env-tool-session.ts` — the lifecycle

**Files:**
- Create: `packages/runner/src/env-tool-session.ts`
- Modify: `packages/runner/src/cli.ts` — add `baseUrl?: string` to `BcDevConfigSection`, and make `odataCfgFor` prefer it
- Test: `packages/runner/tests/env-tool-session.test.ts`

**Interfaces:**
- Consumes: `EnvToolClient`, `EnvToolConfigSection`, `EnvToolError` (Tasks 2-3); `BcDevConfigSection` from `./cli`; `ActivationConfig` from `./activation`.
- Produces:

```typescript
export interface EnvToolSession {
  readonly bcdev: BcDevConfigSection;      // fully resolved; baseUrl set
  readonly createdEnvId?: string;
  teardown(opts: { keepEnv: boolean; quarantined: boolean }): Promise<void>;
}

export async function startEnvToolSession(args: {
  cfg: EnvToolConfigSection;
  bcdevRaw: Partial<BcDevConfigSection>;
  projectDir: string;
  testDir: string;
  runId: string;
  client: EnvToolClient;
  makePublisher: (bcdev: BcDevConfigSection) => { publishFile: (p: string) => Promise<void> };
  verifyHarness: (cfg: ActivationConfig) => Promise<void>;
  allowExpiring?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;   // injected so readiness polling is testable without waiting
  stateDir?: string;
}): Promise<EnvToolSession>;
```

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvToolClient } from "../src/env-tool";
import type { EnvToolConfigSection } from "../src/env-tool";
import { startEnvToolSession } from "../src/env-tool-session";

const FAR_FUTURE = "2099-01-01T00:00:00Z";

/** Canned tool output, parameterised by expiry so no test mutates shared state. */
function resolveOut(expiresUtc: string = FAR_FUTURE): Record<string, string> {
  return {
    "env get": `{"url":"https://host/env-4711","expiresUtc":"${expiresUtc}"}`,
    "env users": '[{"username":"admin","password":"hunter2"}]',
    "env create": '{"id":"env-new"}',
  };
}

function harness(
  cfgOver: Partial<EnvToolConfigSection> = {},
  out: Record<string, string> = resolveOut(),
) {
  const calls: string[][] = [];
  const published: string[] = [];
  const cfg: EnvToolConfigSection = {
    toolPath: "tool.exe",
    envId: "env-4711",
    publishApps: ["tests.app"],
    resolve: [
      { command: ["env", "get", "{envId}", "--json"],
        reads: { baseUrl: "url", expiresUtc: "expiresUtc" } },
      { command: ["env", "users", "{envId}", "--json"],
        reads: { username: "0.username", password: "0.password" } },
    ],
    publish: { command: ["publish", "{envId}", "{appFile}"] },
    createEnv: { command: ["env", "create", "--json"], reads: { envId: "id" } },
    deleteEnv: { command: ["env", "delete", "{envId}"] },
    ...cfgOver,
  };
  const client = new EnvToolClient(cfg, {
    spawn: async (argv) => {
      calls.push([...argv]);
      const key = Object.keys(out).find((k) => argv.join(" ").includes(k));
      return { exitCode: 0, stdout: key === undefined ? "{}" : (out[key] ?? "{}"), stderr: "" };
    },
  });
  return { calls, published, cfg, client };
}

const BCDEV_RAW = {
  company: "CRONUS", tenant: "default", mcpCommand: ["bun", "mcp"],
  packageCachePath: "C:/pkg", controlSymbolPath: "C:/lethal-control.app",
};

async function start(
  over: Record<string, unknown> = {},
  cfgOver: Partial<EnvToolConfigSection> = {},
  out: Record<string, string> = resolveOut(),
) {
  const h = harness(cfgOver, out);
  let harnessCalls = 0;
  const session = await startEnvToolSession({
    cfg: h.cfg,
    bcdevRaw: BCDEV_RAW,
    projectDir: "C:/proj",
    testDir: "C:/tests",
    runId: "r1",
    client: h.client,
    makePublisher: () => ({
      publishFile: async (p: string) => {
        h.published.push(p);
      },
    }),
    verifyHarness: async () => {
      harnessCalls += 1;
      if (harnessCalls === 1) throw new Error("no harness yet");
    },
    stateDir: await mkdtemp(join(tmpdir(), "lethal-envstate-")),
    ...over,
  });
  return { ...h, session, harnessCalls: () => harnessCalls };
}

describe("startEnvToolSession", () => {
  it("resolves a config-supplied env into a complete bcdev section", async () => {
    const { session } = await start();
    expect(session.bcdev.baseUrl).toBe("https://host/env-4711");
    expect(session.bcdev.server).toBe("https://host");
    expect(session.bcdev.serverInstance).toBe("env-4711");
    expect(session.bcdev.username).toBe("admin");
    expect(session.bcdev.company).toBe("CRONUS");
    expect(session.createdEnvId).toBeUndefined();
  });

  it("verifies the harness BEFORE publishing the control app, and again after", async () => {
    const { published, harnessCalls } = await start();
    expect(published).toContain("C:/lethal-control.app");
    expect(harnessCalls()).toBe(2); // failed probe, publish, successful probe
  });

  it("does NOT publish the control app when the harness already answers", async () => {
    const { published } = await start({ verifyHarness: async () => {} });
    expect(published).not.toContain("C:/lethal-control.app");
  });

  it("publishes publishApps before the control app", async () => {
    const { published } = await start();
    expect(published[0]).toBe("tests.app");
  });

  it("creates an env when none is configured and records it to state before use", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lethal-envstate-"));
    const { session } = await start({ stateDir }, { envId: undefined });
    expect(session.createdEnvId).toBe("env-new");
    const files = await readdir(stateDir);
    expect(files).toHaveLength(1);
    const rec = JSON.parse(await readFile(join(stateDir, files[0] ?? ""), "utf8")) as {
      envId: string; deleteArgv: string[];
    };
    expect(rec.envId).toBe("env-new");
    expect(rec.deleteArgv).toEqual(["tool.exe", "env", "delete", "env-new"]);
  });

  it("starts a created env and waits until readyWhen matches before publishing anything", async () => {
    // Measured 2026-07-26: create yields Draft, start is async, ~390s to Running. Assert the
    // ORDER with call counters, never timing: start must precede every publish, and no publish
    // may happen while the status is still Starting.
    const seen: string[] = [];
    const statuses = ["Draft", "Starting", "Starting", "Running"];
    let poll = 0;
    const cfg = harness({ envId: undefined }).cfg;
    const client = new EnvToolClient(
      {
        ...cfg,
        startEnv: { command: ["env", "start", "{envId}"] },
        readyWhen: {
          command: ["env", "get", "{envId}", "--status-json"],
          reads: { status: "status" },
          equals: "Running",
          pollSeconds: 0,
        },
      },
      {
        spawn: async (argv) => {
          const line = argv.join(" ");
          if (line.includes("--status-json")) {
            const s = statuses[Math.min(poll, statuses.length - 1)];
            poll += 1;
            seen.push(`poll:${s ?? ""}`);
            return { exitCode: 0, stdout: JSON.stringify({ status: s }), stderr: "" };
          }
          if (line.includes("env start")) seen.push("start");
          if (line.includes("env create")) seen.push("create");
          const out = resolveOut();
          const key = Object.keys(out).find((k) => line.includes(k));
          return {
            exitCode: 0,
            stdout: key === undefined ? "{}" : (out[key] ?? "{}"),
            stderr: "",
          };
        },
      },
    );
    const session = await startEnvToolSession({
      cfg: {
        ...cfg,
        startEnv: { command: ["env", "start", "{envId}"] },
        readyWhen: {
          command: ["env", "get", "{envId}", "--status-json"],
          reads: { status: "status" },
          equals: "Running",
          pollSeconds: 0,
        },
      },
      bcdevRaw: BCDEV_RAW,
      projectDir: "C:/proj",
      testDir: "C:/tests",
      runId: "r3",
      client,
      makePublisher: () => ({
        publishFile: async (p: string) => {
          seen.push(`publish:${p}`);
        },
      }),
      verifyHarness: async () => {},
      sleep: async () => {},
      stateDir: await mkdtemp(join(tmpdir(), "lethal-envstate-")),
    });
    expect(session.createdEnvId).toBe("env-new");
    expect(seen[0]).toBe("create");
    expect(seen[1]).toBe("start");
    expect(seen.filter((s) => s.startsWith("poll:")).at(-1)).toBe("poll:Running");
    const firstPublish = seen.findIndex((s) => s.startsWith("publish:"));
    const lastPoll = seen.map((s) => s.startsWith("poll:")).lastIndexOf(true);
    expect(firstPublish).toBeGreaterThan(lastPoll);
  });

  it("throws when the env never reaches the ready status inside its budget", async () => {
    const cfg = harness({ envId: undefined }).cfg;
    const readyWhen = {
      command: ["env", "get", "{envId}", "--status-json"],
      reads: { status: "status" },
      equals: "Running",
      pollSeconds: 0,
      timeoutSeconds: 1,
    };
    let clock = 0;
    const client = new EnvToolClient(
      { ...cfg, startEnv: { command: ["env", "start", "{envId}"] }, readyWhen },
      {
        spawn: async (argv) => {
          const line = argv.join(" ");
          if (line.includes("--status-json")) {
            clock += 1000; // one simulated second per poll
            return { exitCode: 0, stdout: '{"status":"Starting"}', stderr: "" };
          }
          const out = resolveOut();
          const key = Object.keys(out).find((k) => line.includes(k));
          return {
            exitCode: 0,
            stdout: key === undefined ? "{}" : (out[key] ?? "{}"),
            stderr: "",
          };
        },
      },
    );
    await expect(
      startEnvToolSession({
        cfg: { ...cfg, startEnv: { command: ["env", "start", "{envId}"] }, readyWhen },
        bcdevRaw: BCDEV_RAW,
        projectDir: "C:/proj",
        testDir: "C:/tests",
        runId: "r4",
        client,
        makePublisher: () => ({ publishFile: async () => {} }),
        verifyHarness: async () => {},
        now: () => clock,
        sleep: async () => {},
        stateDir: await mkdtemp(join(tmpdir(), "lethal-envstate-")),
      }),
    ).rejects.toThrow(/did not reach status "Running"/);
  });

  it("refuses to start when the env expires within the hour", async () => {
    const soon = new Date(Date.now() + 10 * 60_000).toISOString();
    await expect(start({}, {}, resolveOut(soon))).rejects.toThrow(/expires/);
  });

  it("proceeds on an imminent expiry when explicitly allowed", async () => {
    const soon = new Date(Date.now() + 10 * 60_000).toISOString();
    const { session } = await start({ allowExpiring: true }, {}, resolveOut(soon));
    expect(session.bcdev.baseUrl).toBe("https://host/env-4711");
  });

  it("never deletes a config-supplied env", async () => {
    const { session, calls } = await start();
    await session.teardown({ keepEnv: false, quarantined: false });
    expect(calls.some((c) => c.includes("delete"))).toBe(false);
  });

  it("deletes a created env, unless --keep-env or a quarantine", async () => {
    const a = await start({}, { envId: undefined });
    await a.session.teardown({ keepEnv: true, quarantined: false });
    expect(a.calls.some((c) => c.includes("delete"))).toBe(false);

    const b = await start({}, { envId: undefined });
    await b.session.teardown({ keepEnv: false, quarantined: true });
    expect(b.calls.some((c) => c.includes("delete"))).toBe(false);

    const c = await start({}, { envId: undefined });
    await c.session.teardown({ keepEnv: false, quarantined: false });
    expect(c.calls.some((cc) => cc.includes("delete"))).toBe(true);
  });

  it("a failing deleteEnv does not throw out of teardown", async () => {
    const h = harness({ envId: undefined });
    const failing = new EnvToolClient(h.cfg, {
      spawn: async (argv) => {
        h.calls.push([...argv]);
        if (argv.includes("delete")) return { exitCode: 1, stdout: "", stderr: "gone" };
        const out = resolveOut();
        const key = Object.keys(out).find((k) => argv.join(" ").includes(k));
        return { exitCode: 0, stdout: key === undefined ? "{}" : (out[key] ?? "{}"), stderr: "" };
      },
    });
    const session = await startEnvToolSession({
      cfg: h.cfg, bcdevRaw: BCDEV_RAW, projectDir: "C:/proj", testDir: "C:/tests", runId: "r2",
      client: failing,
      makePublisher: () => ({ publishFile: async () => {} }),
      verifyHarness: async () => {},
      stateDir: await mkdtemp(join(tmpdir(), "lethal-envstate-")),
    });
    await session.teardown({ keepEnv: false, quarantined: false }); // must not reject
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/runner/tests/env-tool-session.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add `baseUrl` to `BcDevConfigSection` and prefer it in `odataCfgFor` (`cli.ts`)**

```typescript
  /**
   * OData root, used VERBATIM when present. `odataBaseUrl` injects port 7048, which is right for a
   * container and wrong for an environment tool's `https://host/{envId}`. Set only by
   * `env-tool-session`; a hand-written bcdev section leaves it absent and keeps the derivation.
   */
  readonly baseUrl?: string;
```

```typescript
export function odataCfgFor(c: BcDevConfigSection): ActivationConfig {
  return {
    baseUrl: c.baseUrl ?? odataBaseUrl(c.server, c.serverInstance),
    company: c.company,
    username: c.username,
    password: c.password,
    ...(c.tenant !== undefined ? { tenant: c.tenant } : {}),
  };
}
```

- [ ] **Step 4: Implement `env-tool-session.ts`**

```typescript
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ActivationConfig } from "./activation";
import type { BcDevConfigSection } from "./cli";
import { EnvToolError, renderCommand } from "./env-tool";
import type { EnvToolClient, EnvToolConfigSection } from "./env-tool";

const EXPIRY_MARGIN_MS = 60 * 60_000;

export interface EnvToolSession {
  readonly bcdev: BcDevConfigSection;
  readonly createdEnvId?: string;
  teardown(opts: { keepEnv: boolean; quarantined: boolean }): Promise<void>;
}

/**
 * Runs the provisioning lifecycle ONCE per process and returns a fully resolved bcdev section.
 * `cli.ts` calls `validateBcDevConfig` at three separate seams; a naive port would resolve — and in
 * create-mode PROVISION AN ENVIRONMENT — three times. This runs before all of them and its output
 * is substituted into the config they read.
 */
export async function startEnvToolSession(args: {
  cfg: EnvToolConfigSection;
  bcdevRaw: Partial<BcDevConfigSection>;
  projectDir: string;
  testDir: string;
  runId: string;
  client: EnvToolClient;
  makePublisher: (bcdev: BcDevConfigSection) => { publishFile: (p: string) => Promise<void> };
  verifyHarness: (cfg: ActivationConfig) => Promise<void>;
  allowExpiring?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;   // injected so readiness polling is testable without waiting
  stateDir?: string;
}): Promise<EnvToolSession> {
  const { cfg, client } = args;
  const now = args.now ?? Date.now;
  const sleep = args.sleep ?? ((ms: number) => Bun.sleep(ms));
  const stateDir = args.stateDir ?? join(homedir(), ".lethal", "env-state");
  const supplied: Record<string, string> = {
    projectDir: args.projectDir,
    testDir: args.testDir,
    runId: args.runId,
    packageCache: args.bcdevRaw.packageCachePath ?? join(args.projectDir, ".alpackages"),
  };

  // 1. envId — taken, or created.
  let createdEnvId: string | undefined;
  let envId = cfg.envId;
  if (envId === undefined || envId === "") {
    const createBlock = cfg.createEnv;
    if (createBlock === undefined) throw new EnvToolError("create-mode without envTool.createEnv");
    const out = await client.run(createBlock, "createEnv", supplied);
    const created = out.envId;
    if (created === undefined) throw new EnvToolError("createEnv produced no envId");
    envId = created;
    createdEnvId = created;
    await recordCreatedEnv(stateDir, args.runId, created, cfg, client, now);

    // 1b. Start, then WAIT. Measured 2026-07-26: create returns a Draft environment, `env start`
    // returns "start requested" in ~2s, and the BC endpoint answers ~391s later. Publishing before
    // that fails against a dead endpoint.
    const startBlock = cfg.startEnv;
    const readyBlock = cfg.readyWhen;
    if (startBlock === undefined || readyBlock === undefined) {
      throw new EnvToolError("create-mode without envTool.startEnv/readyWhen");
    }
    await client.run(startBlock, "startEnv", { ...supplied, envId });
    await waitUntilReady(client, readyBlock, { ...supplied, envId }, now, sleep);
  }
  supplied.envId = envId;

  // 2. resolve.
  const resolved: Record<string, string> = {};
  for (const [i, block] of (cfg.resolve ?? []).entries()) {
    Object.assign(resolved, await client.run(block, `resolve[${i}]`, supplied));
  }

  // 3. expiry — refuse rather than warn: expiring mid-run lands as in-flight-unknown and
  //    durably quarantines the tier, which needs an operator clear-quarantine to undo.
  const expiresUtc = resolved.expiresUtc;
  if (expiresUtc !== undefined && args.allowExpiring !== true) {
    const at = Date.parse(expiresUtc);
    if (!Number.isNaN(at) && at - now() < EXPIRY_MARGIN_MS) {
      throw new EnvToolError(
        `environment ${envId} expires at ${expiresUtc}, within the hour — refusing to start. A run ` +
          `that outlives its environment quarantines the tier. Re-run with --allow-expiring-env to ` +
          `override.`,
      );
    }
  }

  // 4. derive server/serverInstance from baseUrl unless read explicitly.
  const baseUrl = resolved.baseUrl;
  if (baseUrl === undefined) throw new EnvToolError("resolve produced no baseUrl");
  const { server, serverInstance } = splitBaseUrl(baseUrl, resolved.server, resolved.serverInstance);
  const username = resolved.username;
  const password = resolved.password;
  if (username === undefined || password === undefined) {
    throw new EnvToolError("resolve produced no username/password");
  }
  const packageCachePath = args.bcdevRaw.packageCachePath ?? join(args.projectDir, ".alpackages");
  const bcdev: BcDevConfigSection = {
    ...(args.bcdevRaw as BcDevConfigSection),
    baseUrl,
    server,
    serverInstance,
    username,
    password,
    packageCachePath,
    env: { ...(args.bcdevRaw.env ?? {}), BC_DEV_USER: username, BC_DEV_PASSWORD: password },
  };

  // 5. symbols.
  if (cfg.downloadSymbols !== undefined) {
    await client.run(cfg.downloadSymbols, "downloadSymbols", { ...supplied, packageCache: packageCachePath });
  }

  // 6. prepublish + control app. Verify FIRST: the machine-global lease lives in the control
  //    app's own tables, and republishing runs its install/upgrade codeunits, which would disturb
  //    a concurrent session's lease and serverGeneration on a shared long-lived environment.
  const publisher = args.makePublisher(bcdev);
  for (const app of cfg.publishApps ?? []) await publisher.publishFile(app);
  const odataCfg: ActivationConfig = {
    baseUrl,
    company: bcdev.company,
    username,
    password,
    ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
  };
  let harnessOk = true;
  try {
    await args.verifyHarness(odataCfg);
  } catch {
    harnessOk = false;
  }
  if (!harnessOk) {
    await publisher.publishFile(bcdev.controlSymbolPath);
    await args.verifyHarness(odataCfg); // throws if it still does not answer
  }

  return {
    bcdev,
    ...(createdEnvId !== undefined ? { createdEnvId } : {}),
    async teardown(opts) {
      if (createdEnvId === undefined) return;
      if (opts.keepEnv || opts.quarantined) {
        console.warn(
          `[lethal] keeping environment ${createdEnvId} (${opts.quarantined ? "session quarantined" : "--keep-env"}). ` +
            `Delete it with: ${renderCommand(cfg.deleteEnv as never, cfg, { ...supplied, envId: createdEnvId }).join(" ")}`,
        );
        return;
      }
      const block = cfg.deleteEnv;
      if (block === undefined) return;
      try {
        await client.run(block, "deleteEnv", { ...supplied, envId: createdEnvId });
      } catch (err) {
        // Cleanup failure must never replace the session's verdicts or exit code.
        console.warn(
          `[lethal] could not delete environment ${createdEnvId}: ` +
            `${err instanceof Error ? err.message : String(err)}\n` +
            `[lethal] delete it manually: ${renderCommand(block, cfg, { ...supplied, envId: createdEnvId }).join(" ")}`,
        );
      }
    },
  };
}

/**
 * Polls `readyWhen` until its status read equals `readyWhen.equals`, or the budget runs out.
 * Announces each status transition: a silent six-minute wait is indistinguishable from a hang.
 */
async function waitUntilReady(
  client: EnvToolClient,
  block: EnvToolReadyBlock,
  supplied: Readonly<Record<string, string>>,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const budgetMs = (block.timeoutSeconds ?? 1800) * 1000;
  const pollMs = (block.pollSeconds ?? 20) * 1000;
  const began = now();
  let lastStatus = "";
  for (;;) {
    const out = await client.run(block, "readyWhen", supplied);
    const status = out.status;
    if (status !== lastStatus) {
      console.log(`[lethal] environment ${supplied.envId ?? "?"} status: ${status}`);
      lastStatus = status ?? "";
    }
    if (status === block.equals) return;
    if (now() - began >= budgetMs) {
      throw new EnvToolError(
        `environment ${supplied.envId ?? "?"} did not reach status ${JSON.stringify(block.equals)} ` +
          `within ${block.timeoutSeconds ?? 1800}s (last status: ${JSON.stringify(status ?? "")})`,
      );
    }
    await sleep(pollMs);
  }
}

function splitBaseUrl(
  baseUrl: string,
  serverOverride: string | undefined,
  instanceOverride: string | undefined,
): { server: string; serverInstance: string } {
  if (serverOverride !== undefined && instanceOverride !== undefined) {
    return { server: serverOverride, serverInstance: instanceOverride };
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new EnvToolError(`resolved baseUrl ${JSON.stringify(baseUrl)} is not a URL`);
  }
  const segment = url.pathname.split("/").filter((s) => s.length > 0)[0];
  if (segment === undefined) {
    throw new EnvToolError(
      `resolved baseUrl ${JSON.stringify(baseUrl)} has no path segment to use as serverInstance — ` +
        `declare a reads entry for serverInstance instead; LethAL will not guess one`,
    );
  }
  return {
    server: serverOverride ?? url.origin,
    serverInstance: instanceOverride ?? segment,
  };
}

/**
 * Records a created environment where a LATER process can find it. Session scratch is a mkdtemp
 * directory nobody can locate after a crash, and a crashed process cannot print. A residual window
 * remains: a crash DURING createEnv leaves an environment whose id LethAL never learned — the
 * tool's own `env list` is the recovery for that one.
 */
async function recordCreatedEnv(
  stateDir: string,
  runId: string,
  envId: string,
  cfg: EnvToolConfigSection,
  _client: EnvToolClient,
  now: () => number,
): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const deleteArgv =
    cfg.deleteEnv === undefined ? [] : renderCommand(cfg.deleteEnv, cfg, { envId });
  await writeFile(
    join(stateDir, `${runId}.json`),
    `${JSON.stringify({ runId, envId, deleteArgv, startedAtMs: now() }, null, 2)}\n`,
    "utf8",
  );
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `bun run typecheck && rm -rf packages/*/dist && bun test packages/runner/tests/env-tool-session.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Red-check the verify-before-publish rule**

Make the control publish unconditional (drop the `if (!harnessOk)`), confirm "does NOT publish the control app when the harness already answers" goes RED, restore. Report both.

- [ ] **Step 7: Commit**

```bash
bunx biome check packages/runner/src/env-tool-session.ts packages/runner/src/cli.ts packages/runner/tests/env-tool-session.test.ts
git add packages/runner/src/env-tool-session.ts packages/runner/src/cli.ts packages/runner/tests/env-tool-session.test.ts
git commit -m "feat(envtool): session lifecycle — resolve once, verify before publishing control, refuse an expiring env"
```

---

### Task 7: wire it into the CLI

**Files:**
- Modify: `packages/runner/src/cli.ts`
- Test: `packages/runner/tests/cli-envtool.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2-6.
- Produces: `LethalConfigFile.envTool?: Partial<EnvToolConfigSection>`; `RunCliConfig.keepEnv: boolean`; `RunCliConfig.allowExpiringEnv: boolean`.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from "bun:test";
import { parseCliConfig } from "../src/cli";

describe("env-tool CLI flags", () => {
  const argv = [
    "run", "--project", "p", "--tests", "t", "--backend", "bcdev", "--config", "c.json",
  ];

  it("defaults keepEnv and allowExpiringEnv to false", () => {
    const cfg = parseCliConfig(argv);
    if (cfg.mode !== "run") throw new Error("expected run mode");
    expect(cfg.keepEnv).toBe(false);
    expect(cfg.allowExpiringEnv).toBe(false);
  });

  it("accepts --keep-env and --allow-expiring-env", () => {
    const cfg = parseCliConfig([...argv, "--keep-env", "--allow-expiring-env"]);
    if (cfg.mode !== "run") throw new Error("expected run mode");
    expect(cfg.keepEnv).toBe(true);
    expect(cfg.allowExpiringEnv).toBe(true);
  });

  it("rejects --keep-env with --backend al-runner, which has no environment", () => {
    expect(() =>
      parseCliConfig([
        "run", "--project", "p", "--tests", "t", "--backend", "al-runner", "--config", "c.json",
        "--keep-env",
      ]),
    ).toThrow(/keep-env/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/runner/tests/cli-envtool.test.ts`
Expected: FAIL — `keepEnv` is not a property of `RunCliConfig`.

- [ ] **Step 3: Implement the flags**

Add to `RunCliConfig`: `readonly keepEnv: boolean; readonly allowExpiringEnv: boolean;`
Add to `parseArgs` options: `"keep-env": { type: "boolean", default: false }, "allow-expiring-env": { type: "boolean", default: false }`.
Before returning the run config:

```typescript
  const keepEnv = values["keep-env"] === true;
  const allowExpiringEnv = values["allow-expiring-env"] === true;
  if (keepEnv && backendArg === "al-runner") {
    throw new Error("--keep-env applies to the bcdev backend's environment tool; al-runner has no environment");
  }
```

and include both in the returned object.

- [ ] **Step 4: Wire the session into `runFromCli`**

```typescript
async function runFromCli(parsed: RunCliConfig): Promise<SessionReport> {
  const configFile = await loadLethalConfigFile(parsed.configPath);
  const scratchRoot = await mkdtemp(join(tmpdir(), "lethal-"));
  if (parsed.backendKind === "al-runner") warnAlRunnerNotAuthoritative();

  // Bun loads `.env` into process.env automatically, so ${VAR} in the config resolves from it
  // without a loader here. Resolution happens EXACTLY ONCE and its output is substituted into the
  // config the three downstream seams read (buildBackend, leaseSessionFor, resourceIdentityFor).
  let envSession: EnvToolSession | undefined;
  let effectiveConfig = configFile;
  if (parsed.backendKind === "bcdev" && configFile.envTool !== undefined) {
    const envCfg = validateEnvToolConfig(configFile.envTool, {
      env: process.env,
      hasPackageCachePath: Boolean(configFile.bcdev?.packageCachePath),
    });
    const client = new EnvToolClient(envCfg);
    const publishBlock = envCfg.publish;
    if (publishBlock === undefined) throw new Error("envTool.publish is required");
    envSession = await startEnvToolSession({
      cfg: envCfg,
      bcdevRaw: configFile.bcdev ?? {},
      projectDir: parsed.projectDir,
      testDir: parsed.testDir,
      runId: basename(scratchRoot),
      client,
      makePublisher: (bcdev) =>
        new EnvToolPublisher(
          client,
          publishBlock,
          { envId: bcdev.serverInstance, serializerKey: canonicalContainerKey(bcdev) },
          { readArtifact: async (p) => new Uint8Array(await readFile(p)) },
        ),
      verifyHarness: async (cfg) => {
        await new HarnessVerifier(cfg).verify();
      },
      allowExpiring: parsed.allowExpiringEnv,
    });
    effectiveConfig = { ...configFile, bcdev: envSession.bcdev };
  }

  const backend = await buildBackend(parsed, effectiveConfig, scratchRoot);
  // …worker backends, store, runSession — all reading `effectiveConfig` instead of `configFile`…
```

and in the `finally`:

```typescript
  } finally {
    store.close();
    if (backend instanceof BcDevMcpBackend) await backend.close();
    if (backend instanceof AlRunnerBackend) await backend.close();
    if (envSession !== undefined) {
      // Never allowed to change the report or the exit code: verdicts are the product.
      await envSession.teardown({
        keepEnv: parsed.keepEnv,
        quarantined: quarantinedThisSession,
      });
    }
  }
```

where `quarantinedThisSession` is set from the returned `SessionReport.quarantined !== undefined` (capture the report in a local before returning it).

- [ ] **Step 5: Make `buildBackend` publish through the tool**

In `buildBackend`, when `configFile.envTool !== undefined`, construct `EnvToolPublisher` instead of `ContainerDeployer` (the `deployer` field is now typed `AppPublisher`, so no other change is needed). `defaultAlToolPaths()` is still required for `alcPath` — compilation is local either way — so only the publish half changes.

- [ ] **Step 6: Run everything**

Run: `bun run typecheck && rm -rf packages/*/dist && bun test`
Expected: PASS, all existing tests plus the 3 new ones.

- [ ] **Step 7: Commit**

```bash
bunx biome check packages/runner/src/cli.ts packages/runner/tests/cli-envtool.test.ts
git add packages/runner/src/cli.ts packages/runner/tests/cli-envtool.test.ts
git commit -m "feat(envtool): wire the provisioner into the CLI, resolving exactly once"
```

---

### Task 8: live gate

**Files:**
- Create: `packages/runner/itest/envtool.itest.ts`
- Modify: `package.json` (add `"itest:envtool": "bun packages/runner/itest/envtool.itest.ts"`)
- Create (by the first run, then committed): `packages/runner/itest/envtool.baseline.json`

**Interfaces:**
- Consumes: `startEnvToolSession`, `EnvToolClient`, `validateEnvToolConfig`, `EnvToolPublisher`, `assertMatchesBaseline` from `./baseline-guard`.
- Produces: a frozen per-mutant baseline.

**Requires from the human:** a Continia environment and a config at `fixtures/sandbox-app/lethal.config.envtool.json` (gitignored) carrying both a `bcdev` section (company, tenant, mcpCommand, controlSymbolPath) and an `envTool` section.

- [ ] **Step 1: Write the itest**

Model it on `packages/runner/itest/tables.itest.ts` — same shape: env gate, skip cleanly with exit 0, dump the per-mutant table BEFORE asserting, assert aggregate counts, then `assertMatchesBaseline`. Target `fixtures/sandbox-app` + `fixtures/sandbox-tests`. Gate variable: `LETHAL_ITEST_ENVTOOL`.

```typescript
if (!process.env.LETHAL_ITEST_ENVTOOL) {
  console.log(
    "skipped (set LETHAL_ITEST_ENVTOOL=1 and populate the gitignored " +
      "fixtures/sandbox-app/lethal.config.envtool.json to run against a real environment)",
  );
  process.exit(0);
}
```

Expected verdicts come from Task 1's probe result:

```typescript
// Task 1's probe decides this: bc-dev-mcp reachable -> 3/10/3; not reachable -> 3/13/0, because
// coverage falls back to "none" and every mutant runs against all green tests.
const EXPECTED = { killed: 3, survived: 10, noCoverage: 3 };   // or { 3, 13, 0 }
```

- [ ] **Step 2: Run it**

Run: `LETHAL_ITEST_ENVTOOL=1 bun run itest:envtool`
Expected: the per-mutant table, then `envtool itest: no committed baseline … recorded`, then PASS.

- [ ] **Step 3: Commit the baseline**

```bash
git add packages/runner/itest/envtool.itest.ts packages/runner/itest/envtool.baseline.json package.json
git commit -m "test(envtool): live gate against a real environment, per-mutant baseline frozen"
```

- [ ] **Step 4: Prove teardown on a real environment**

Run once with no `envId` in the config: confirm an environment is created, `~/.lethal/env-state/<runId>.json` exists mid-run, the run completes, and the environment is gone afterwards. Then run again with `--keep-env` and confirm it survives. Record both in the commit message of the next task.

---

### Task 9: documentation

**Files:**
- Modify: `fixtures/README.md` (new section)
- Modify: `ROADMAP.md` (R15 status)
- Modify: `CLAUDE.md` (integration-test list)

- [ ] **Step 1: Document the feature in `fixtures/README.md`**

Add a section "## Running against an external environment tool (`envTool`)" containing: the full worked config from the spec, the `.env` variables, the flag list (`--keep-env`, `--allow-expiring-env`), what each lifecycle step does, the coverage mode Task 1 measured (with its evidence), and the recovery procedure for a leaked environment (`~/.lethal/env-state/`, plus the tool's own `env list`).

- [ ] **Step 2: Update `ROADMAP.md`**

Change R15's status to `done (<merge commit>)` and move it to "Recently closed" with a one-line result. If the probe forced the `coverage: "none"` fallback, file that as a new item (`R16`) naming what it would take to get procedure-level coverage on those environments.

- [ ] **Step 3: Update `CLAUDE.md`**

Add `itest:envtool` to the integration-test list with its env gate and its frozen counts, matching how `itest:bcdev` and `itest:alrunner` are listed.

- [ ] **Step 4: Commit**

```bash
git add fixtures/README.md ROADMAP.md CLAUDE.md
git commit -m "docs(envtool): worked config, lifecycle, recovery, and the measured coverage mode"
```

---

## Self-review notes

**Spec coverage.** Provisioning is two async phases (`startEnv` + `readyWhen`) → Task 2 (validation) and Task 6 (start, poll, timeout). Architecture → Tasks 6-7. Resolved-connection table → Task 6 (`startEnvToolSession`) with the both-sources rule in Task 2's validation. Coverage fork → Tasks 1 and 5. Test-app problem (`publishApps`) → Task 2 (validation) and Task 6 (publish order). Config schema, `${VAR}`, placeholders, `reads` → Tasks 2-3. Execution contract → Task 3. Publish semantics, digest, serialization → Task 4. Redaction → Task 3. Teardown, crash state, expiry → Task 6. `--keep-env` / `--dry-run` → Task 7. Files table → Tasks 2-7. Testing → every task, plus Task 8. Exit criteria 1-7 → Tasks 1, 8 (2-4), 2-3 (5), 3 (6), 9 (7).

**Deliberate deviation from the spec's file list.** The spec named `.env` loading as `cli.ts` work; Bun loads `.env` into `process.env` automatically, so Task 7 documents that rather than writing a loader. If a future non-Bun entry point appears, that assumption needs revisiting.

**Known residual risk, recorded rather than solved.** A crash *during* `createEnv` leaves an environment whose id LethAL never learned. `recordCreatedEnv` cannot close that window because the id does not exist until the call returns. Recovery is the tool's own `env list`.
