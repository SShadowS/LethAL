import { describeThrown } from "./describe-error";
import { defaultSpawn } from "./publisher";
import type { SpawnFn } from "./publisher";

/**
 * Config surface for an external environment tool (spec:
 * docs/superpowers/specs/2026-07-26-custom-env-tool-design.md). Pure — no I/O, no BC knowledge:
 * everything here is decidable from the config text plus an environment map, so every "your
 * config is wrong" error is unit-testable and fires BEFORE any process is spawned.
 */
export interface EnvToolBlock {
  readonly command: readonly string[];
  readonly reads?: Readonly<Record<string, string>>;
  readonly successWhen?: EnvToolSuccessExpectation;
}

/**
 * R107: what the tool's own output must say for the command to count as having SUCCEEDED, on top
 * of exiting 0.
 *
 * The hole this fills was measured (R90): `continia publish` exits **0** while printing
 * `{"success": false, "message": "The operation timed out."}`. Every gate `run()` had — a spawn
 * throw, LethAL's own timeout abort, `exitCode !== 0` — is blind to that, so the publish read as
 * fine and `decidePublishOutcome` recorded `indeterminate` rather than `failed`. Every verdict
 * after such a publish is measured against a build that never landed.
 *
 * Three properties, each deliberate:
 *
 * 1. **Vocabulary-neutral.** LethAL hardcodes no vendor's success field or value — same rule
 *    `requireStatus` and `readyWhen` already follow. The config names both the path and the value.
 * 2. **Positive evidence, so it fails CLOSED.** This says "success looks like THIS"; anything
 *    else — a different value, a missing path, output that is not JSON at all — is a failure. The
 *    opposite polarity (`failWhen`) fails OPEN the moment the tool's output shape drifts, and
 *    "we saw nothing wrong" reading as "it worked" is this project's signature bug.
 * 3. **Undeclared changes nothing.** A config without `successWhen` behaves exactly as before, so
 *    adding this cannot turn a working project's publish into a refusal.
 */
export interface EnvToolSuccessExpectation {
  /**
   * Dot-separated path into the command's JSON stdout, read the same way `reads` paths are —
   * `"success"`, `"result.status"`, `"items.0.state"`.
   */
  readonly path: string;
  /**
   * The value at `path` that means SUCCESS, compared as a string (`true` matches `"true"`).
   * Anything else, including the path resolving to nothing, is a failure.
   */
  readonly equals: string;
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

/**
 * R34: what a REUSED environment's status must be before LethAL will touch it. The status VALUE is
 * read like any other field — an ordinary `resolve[].reads.status` entry — and the value that
 * counts as ready is declared here. Both sides come from config on purpose: Layer 6C's whole point
 * is that the external tool is described by the project, so LethAL hardcodes no vendor's status
 * vocabulary (`Running`, `Active`, `Started`, …) anywhere in its source.
 *
 * Deliberately NOT a block of its own: it carries no `command`, because the status must come from
 * the same call that already produced the endpoint. A second spawn would cost an extra round trip
 * AND open a window where LethAL checks one snapshot and publishes into another.
 */
export interface EnvToolStatusExpectation {
  readonly equals: string;
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
  readonly requireStatus?: EnvToolStatusExpectation;
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
        `envTool.${field}: environment variable \${${name}} is not set (or empty) — set it, or put a literal value in the config`,
      );
    }
    return v;
  });
}

function blocksOf(
  cfg: Partial<EnvToolConfigSection>,
): Array<{ name: string; block: EnvToolBlock }> {
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function describeShape(v: unknown): string {
  if (Array.isArray(v)) return "an array";
  if (v === null) return "null";
  return typeof v;
}

/** `envTool.<path>` must be an array of strings — `command` and `publishApps`. */
function requireStringArray(v: unknown, path: string): void {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new EnvToolError(`envTool.${path} must be an array of strings (got ${describeShape(v)})`);
  }
}

/** `envTool.<path>` must be a plain object whose every value is a string — `vars`, `env`, and a
 * block's `reads`. */
function requireStringRecord(v: unknown, path: string): void {
  if (!isPlainObject(v)) {
    throw new EnvToolError(`envTool.${path} must be an object (got ${describeShape(v)})`);
  }
  for (const [key, val] of Object.entries(v)) {
    if (typeof val !== "string") {
      throw new EnvToolError(`envTool.${path}.${key} must be a string (got ${describeShape(val)})`);
    }
  }
}

/** Shape of one `EnvToolBlock`-like value at `path`: an object carrying a `command` array of
 * strings, and — if present — a `reads` map of strings. */
function validateBlockShape(v: unknown, path: string): void {
  if (!isPlainObject(v)) {
    throw new EnvToolError(`envTool.${path} must be an object (got ${describeShape(v)})`);
  }
  requireStringArray(v.command, `${path}.command`);
  if (v.reads !== undefined) requireStringRecord(v.reads, `${path}.reads`);
  if (v.successWhen !== undefined) validateSuccessWhenShape(v.successWhen, `${path}.successWhen`);
}

/**
 * R107: `successWhen`'s shape. Both halves are REQUIRED and both must be non-empty — a
 * `successWhen` missing either half would otherwise be a check that cannot fail, silently
 * restoring the exit-0-means-success behaviour it was added to remove, while reading in the
 * config as though the project were protected.
 */
function validateSuccessWhenShape(v: unknown, path: string): void {
  if (!isPlainObject(v)) {
    throw new EnvToolError(`envTool.${path} must be an object (got ${describeShape(v)})`);
  }
  for (const key of ["path", "equals"] as const) {
    const val = v[key];
    if (typeof val !== "string") {
      throw new EnvToolError(`envTool.${path}.${key} must be a string (got ${describeShape(val)})`);
    }
    if (val.length === 0) {
      throw new EnvToolError(
        `envTool.${path}.${key} must not be empty — an empty ${key} makes the success check unfalsifiable, which is worse than not declaring it`,
      );
    }
  }
}

const BLOCK_FIELDS = [
  "createEnv",
  "startEnv",
  "readyWhen",
  "downloadSymbols",
  "publish",
  "deleteEnv",
] as const;

/**
 * A shape pass over the RAW, untrusted config text — run BEFORE `substituteSection` (which
 * assumes every field already has its declared type) and before any later semantic check. This
 * module's own header claims every "your config is wrong" error is unit-testable and fires
 * BEFORE any process is spawned; without this pass that claim was false for five common typos —
 * each previously either crashed with a raw, unattributed `TypeError` deep inside
 * `substituteSection`/`renderCommand` (a missing/mistyped `command`, a `resolve` given as an
 * object instead of an array, a non-string `vars` value) or didn't throw here AT ALL — a
 * non-string `reads` value is never touched by substitution (only `command`/`vars`/`env` are), so
 * it silently reached `EnvToolClient.run`'s `readPath` at actual spawn time instead.
 */
function validateRawShape(raw: Partial<EnvToolConfigSection>): void {
  for (const name of BLOCK_FIELDS) {
    const v = raw[name];
    if (v !== undefined) validateBlockShape(v, name);
  }
  // `readyWhen.equals` isn't part of the generic block shape (only `createEnv`/`startEnv`/etc.
  // have it) — checked separately, and only for its TYPE; whether it's present at all is still
  // `validateEnvToolConfig`'s later "envTool.readyWhen.equals is required" check, not this one.
  if (raw.readyWhen !== undefined) {
    // `raw` is untrusted JSON cast to `Partial<EnvToolConfigSection>` — its declared type says
    // `equals: string`, but the whole point of this pass is to check what's ACTUALLY there at
    // runtime, which may not match. `as unknown as` first: `EnvToolReadyBlock` has no index
    // signature, so a direct cast to `Record<string, unknown>` doesn't overlap enough for TS.
    const equals = (raw.readyWhen as unknown as Record<string, unknown>).equals;
    if (equals !== undefined && typeof equals !== "string") {
      throw new EnvToolError(
        `envTool.readyWhen.equals must be a string (got ${describeShape(equals)})`,
      );
    }
  }
  // R34: `requireStatus` is not a block (no `command` — it reads a value some `resolve` step
  // already produces), so the block loop above cannot cover it. TYPE only here, same split as
  // `readyWhen.equals` above: whether the expectation is COHERENT (reuse-mode, and something
  // actually reads `status`) is `validateEnvToolConfig`'s later semantic check.
  if (raw.requireStatus !== undefined) {
    if (!isPlainObject(raw.requireStatus)) {
      throw new EnvToolError(
        `envTool.requireStatus must be an object (got ${describeShape(raw.requireStatus)})`,
      );
    }
    const equals = (raw.requireStatus as unknown as Record<string, unknown>).equals;
    if (equals !== undefined && typeof equals !== "string") {
      throw new EnvToolError(
        `envTool.requireStatus.equals must be a string (got ${describeShape(equals)})`,
      );
    }
  }
  if (raw.resolve !== undefined) {
    if (!Array.isArray(raw.resolve)) {
      throw new EnvToolError(
        `envTool.resolve must be an array (got ${describeShape(raw.resolve)})`,
      );
    }
    raw.resolve.forEach((b, i) => validateBlockShape(b, `resolve[${i}]`));
  }
  if (raw.vars !== undefined) requireStringRecord(raw.vars, "vars");
  if (raw.env !== undefined) requireStringRecord(raw.env, "env");
  if (raw.publishApps !== undefined) requireStringArray(raw.publishApps, "publishApps");
}

export function validateEnvToolConfig(
  raw: Partial<EnvToolConfigSection> | undefined,
  opts: {
    env: Readonly<Record<string, string | undefined>>;
    hasPackageCachePath: boolean;
    /**
     * Keys the raw `bcdev` config section actually declares (non-empty) that overlap
     * `READS_KEYS` (e.g. `server`, `serverInstance`, `username`, `password`, `baseUrl`) — see the
     * "two sources, one value" check below (fixtures/README.md's worked example names this by
     * name). This module has no `BcDevConfigSection` type of its own to inspect directly (that
     * type lives in cli.ts, which imports FROM here); the caller derives this list and passes it
     * in. REQUIRED (R24) — not optional: an earlier version defaulted this to a no-op when
     * omitted, which means a future second caller of `validateEnvToolConfig` that simply forgot
     * to derive and pass it would silently lose the "two sources, one value" guard rather than
     * fail loudly. A caller with no bcdev section to check against passes an empty array to say
     * so explicitly, rather than omitting the parameter.
     */
    bcdevDeclaredKeys: readonly string[];
  },
): EnvToolConfigSection {
  if (!raw) throw new EnvToolError('config file is missing the "envTool" section');

  // 0. A shape pass over the RAW, untrusted config text — see `validateRawShape`'s doc comment
  // for why this must run before anything below, including substitution.
  validateRawShape(raw);

  // 1. ${VAR} substitution first — later checks read substituted values.
  const cfg = substituteSection(raw, opts.env);

  // 2. Structural requirements.
  if (!cfg.toolPath) throw new EnvToolError("envTool.toolPath is required");
  if (!cfg.resolve || cfg.resolve.length === 0) {
    throw new EnvToolError("envTool.resolve is required — LethAL cannot find the environment");
  }
  if (!cfg.publish) throw new EnvToolError("envTool.publish is required");
  // R23: `publish`'s failure text is exactly what the orchestrator's one-shot version-conflict
  // recovery parses BC's rejection message out of (see EnvToolPublisher's doc comment). Every
  // block's `reads` is otherwise free to name any known key, but `EnvToolClient.run`'s
  // credential-withholding rule replaces a NON-ZERO-EXIT failure's entire stdout/stderr with
  // "(output withheld: this command's output carries credentials)" the moment a block declares
  // it reads `username`/`password` — if `publish` itself did that, a real publish failure would
  // silently lose the detail that recovery depends on. No plausible tool actually emits
  // credentials from a publish command, so this is a guardrail, not a live bug — reject it here,
  // before any process is spawned, and name the reason.
  const publishCredKeys = Object.keys(cfg.publish.reads ?? {}).filter((k) =>
    (CREDENTIAL_READS_KEYS as readonly string[]).includes(k),
  );
  if (publishCredKeys.length > 0) {
    throw new EnvToolError(
      `envTool.publish.reads must not read ${publishCredKeys.join(", ")}: a publish failure's output is what the orchestrator's version-conflict recovery parses BC's rejection text out of, and the credential-withholding rule would silently replace it with "(output withheld)" on every failure`,
    );
  }
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
          `envTool: reads key ${JSON.stringify(key)} is produced by both ${prior} and ${name} — two sources for one value is how two clients end up pointed at different endpoints`,
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
  // R34: a reused environment that has idled to a not-ready status (measured live 2026-07-26 on
  // the gate environment: `Stopped`) used to resolve perfectly well, hand back a dead endpoint,
  // and abort minutes later inside the transport with an obscure error. `requireStatus` makes
  // LethAL refuse up front instead — but only if it can actually SEE a status, which is what these
  // checks pin down, before any process is spawned.
  const requireStatus = cfg.requireStatus;
  if (requireStatus !== undefined) {
    // Create-mode already starts the environment itself and polls `readyWhen` until it reports
    // ready, and `readyWhen.reads.status` is mandatory there — so `status` is necessarily produced
    // by `readyWhen`, and a `resolve` step reading it too would trip the "produced by both" rule
    // above. Naming that here is the difference between one clear message and a dead end.
    if (createMode) {
      throw new EnvToolError(
        "envTool.requireStatus applies only to a REUSED environment (envTool.envId set) — in " +
          "create-mode LethAL starts the environment itself and envTool.readyWhen already polls " +
          "it to ready. Remove requireStatus, or set envId.",
      );
    }
    if (!requireStatus.equals) {
      throw new EnvToolError(
        'envTool.requireStatus.equals is required — it names the status a reused environment must report before LethAL will use it (e.g. "Running")',
      );
    }
    // Must come from `resolve` specifically: `readyWhen` is never run for a reused environment, so
    // a status declared there would leave the check with nothing to compare and silently pass.
    const statusProducer = produced.get("status");
    if (statusProducer === undefined || !statusProducer.startsWith("resolve[")) {
      const where =
        statusProducer === undefined
          ? ""
          : ` (${statusProducer} reads it, but that block never runs for a reused environment)`;
      throw new EnvToolError(
        `envTool.requireStatus is declared but no envTool.resolve[] block reads "status"${where} — add a "status" entry to a resolve block's reads, or drop requireStatus: LethAL will not claim to check a status it never reads`,
      );
    }
  }
  // A field env-tool resolves via some block's `reads` must not ALSO be hand-written in the
  // bcdev config section — two sources for one value is how two clients end up pointed at
  // different endpoints (fixtures/README.md's worked example calls this out by name). This is
  // deliberately NOT a precedence rule: it is a validation error, not "resolved wins".
  for (const key of opts.bcdevDeclaredKeys) {
    const producer = produced.get(key);
    if (producer !== undefined) {
      throw new EnvToolError(
        `envTool: "${key}" is produced by ${producer}'s reads AND hand-written in the bcdev config section — two sources for one value is how two clients end up pointed at different endpoints. Remove it from one.`,
      );
    }
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
      if (ref === undefined) continue;
      if (varNames.has(ref)) {
        throw new EnvToolError(
          `envTool.vars.${name} references another vars entry {${ref}} — only LethAL-supplied placeholders may appear inside a vars value`,
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
        if (ref === undefined) continue;
        const known = (LETHAL_PLACEHOLDERS as readonly string[]).includes(ref) || varNames.has(ref);
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
        `envTool.vars.${name} is never referenced by any declared command — that is a typo, not a default`,
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
    ...(b.successWhen !== undefined
      ? {
          successWhen: {
            // Same untrusted-text reasoning as `subReadyBlock`'s `equals`: the type says `string`,
            // but `validateBlockShape` has already rejected anything else by the time we get here,
            // so these substitutions cannot see `undefined`.
            path: sub(b.successWhen.path, `${field}.successWhen.path`),
            equals: sub(b.successWhen.equals, `${field}.successWhen.equals`),
          },
        }
      : {}),
  });
  const subReadyBlock = (b: EnvToolReadyBlock, field: string): EnvToolReadyBlock => ({
    ...subBlock(b, field),
    // `equals` is required by the type, but raw config text is untrusted — a config missing it
    // must reach the "envTool.readyWhen.equals is required" check below, not crash here.
    equals: b.equals === undefined ? "" : sub(b.equals, `${field}.equals`),
    ...(b.pollSeconds !== undefined ? { pollSeconds: b.pollSeconds } : {}),
    ...(b.timeoutSeconds !== undefined ? { timeoutSeconds: b.timeoutSeconds } : {}),
  });
  return {
    toolPath: raw.toolPath === undefined ? "" : sub(raw.toolPath, "toolPath"),
    ...(raw.cwd !== undefined ? { cwd: sub(raw.cwd, "cwd") } : {}),
    ...(raw.env !== undefined
      ? {
          env: Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, sub(v, `env.${k}`)])),
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
    ...(raw.startEnv !== undefined ? { startEnv: subBlock(raw.startEnv, "startEnv") } : {}),
    ...(raw.readyWhen !== undefined
      ? { readyWhen: subReadyBlock(raw.readyWhen, "readyWhen") }
      : {}),
    ...(raw.requireStatus !== undefined
      ? {
          requireStatus: {
            // Same reason as `subReadyBlock`'s `equals`: the type says `string`, but raw config
            // text is untrusted — a config that omits it must reach the
            // "envTool.requireStatus.equals is required" check, not crash here.
            equals:
              raw.requireStatus.equals === undefined
                ? ""
                : sub(raw.requireStatus.equals, "requireStatus.equals"),
          },
        }
      : {}),
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

/** Renders one block's argv: `[toolPath, ...command]` with every `{placeholder}` substituted. */
export function renderCommand(
  block: EnvToolBlock,
  cfg: EnvToolConfigSection,
  supplied: Readonly<Record<string, string>>,
): string[] {
  const values: Record<string, string> = { ...(cfg.vars ?? {}), ...supplied };
  // A vars value may itself contain LethAL placeholders ("lethal-{runId}") — resolve those first,
  // but ONLY for vars keys THIS block's command actually references. Task 2's validation already
  // rejects a vars entry that nothing anywhere references, so a vars entry not referenced by THIS
  // block is legitimately used by some OTHER block — e.g. `vars: { tag: "{appFile}-suffix" }`
  // referenced only by `publish` must not abort rendering `deleteEnv`, which never mentions `tag`
  // and has no reason to have `appFile` supplied. A missing/empty reference in a referenced vars
  // entry must still throw (mirrors substituteVars's ${VAR} handling above): silently keeping the
  // literal "{runId}" text would ship a plausible-looking but corrupt argument to the external tool
  // (e.g. an environment literally named "lethal-{runId}").
  const referencedVarKeys = new Set<string>();
  for (const arg of block.command) {
    for (const [, ref] of arg.matchAll(PLACEHOLDER_PATTERN)) {
      if (ref !== undefined) referencedVarKeys.add(ref);
    }
  }
  for (const [k, v] of Object.entries(cfg.vars ?? {})) {
    if (!referencedVarKeys.has(k)) continue;
    values[k] = v.replace(PLACEHOLDER_PATTERN, (_m, ref: string) => {
      const sv = supplied[ref];
      if (sv === undefined || sv === "") {
        throw new EnvToolError(
          `envTool.vars.${k}: placeholder {${ref}} has no supplied value while rendering ` +
            `${JSON.stringify(block.command.join(" "))} — refusing to ship the literal placeholder text`,
        );
      }
      return sv;
    });
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
    // Fixtures/README.md documents `envTool.cwd`'s default as "the project dir" — this is that
    // default, supplied by the caller that actually knows the project dir (cli.ts), never guessed
    // here. `cfg.cwd` always wins when the config sets one explicitly.
    private readonly defaultCwd?: string,
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
    // Attribute render failures (e.g. an unresolved placeholder) to this named block, same as
    // every other failure below — otherwise the caller has no idea which of N configured blocks
    // is broken.
    let argv: string[];
    try {
      argv = renderCommand(block, this.cfg, supplied);
    } catch (err) {
      throw new EnvToolError(
        `envTool.${name}: ${redact(err instanceof Error ? err.message : String(err), this.secrets)}`,
      );
    }
    const shown = redact(argv.join(" "), this.secrets);
    const readsCredentials = Object.keys(block.reads ?? {}).some((k) =>
      (CREDENTIAL_READS_KEYS as readonly string[]).includes(k),
    );
    const timeoutSeconds = this.cfg.timeoutSeconds ?? 900;
    const timeoutMs = timeoutSeconds * 1000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: { exitCode: number; stdout: string; stderr: string };
    try {
      const cwd = this.cfg.cwd ?? this.defaultCwd;
      res = await this.io.spawn(argv, {
        signal: controller.signal,
        ...(this.cfg.env !== undefined ? { env: { ...this.cfg.env } } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
      });
    } catch (err) {
      // R65: `err.message` alone is EMPTY for a spawn ENOENT/EACCES, so a mistyped `envTool.tool`
      // path reported "failed to run: " and nothing else — on the one path where the tool path is
      // supplied by the user's own config and therefore most likely to be wrong. Still redacted:
      // `describeThrown` widens WHAT is reported, never who may read it.
      throw new EnvToolError(
        `envTool.${name}: ${shown} failed to run: ${redact(describeThrown(err), this.secrets)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    // Bun.spawn killed via AbortSignal does NOT throw — it resolves with exitCode 143 and
    // signalCode "SIGTERM" (verified live). Left unchecked, that falls into the generic
    // non-zero-exit branch below and reads like an ordinary tool crash, indistinguishable from
    // LethAL's own configured budget expiring. Check this BEFORE the exit-code branch can claim
    // it. No stdout/stderr is echoed here, so the credential-withholding rule holds automatically.
    if (controller.signal.aborted) {
      throw new EnvToolError(
        `envTool.${name}: ${shown} timed out after ${timeoutSeconds}s (envTool.timeoutSeconds) — this is LethAL's own budget expiring, not the tool crashing`,
      );
    }
    if (res.exitCode !== 0) {
      const detail = readsCredentials
        ? "(output withheld: this command's output carries credentials)"
        : redact(
            [res.stdout, res.stderr].filter((s) => s.trim().length > 0).join("\n"),
            this.secrets,
          );
      throw new EnvToolError(`envTool.${name}: ${shown} exit ${res.exitCode}:\n${detail}`);
    }
    const reads = block.reads;
    const successWhen = block.successWhen;
    if (reads === undefined && successWhen === undefined) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch (err) {
      // With `successWhen` declared the block's own output is the evidence, so the WHOLE output
      // goes into the error rather than the usual 200-character opening: R23's version-conflict
      // recovery parses BC's rejection text out of a publish failure's message, and a truncated
      // body would silently drop it. Without `successWhen` the message is unchanged.
      const tail = readsCredentials
        ? "(output withheld: this command's output carries credentials)"
        : successWhen !== undefined
          ? `full output:\n${redact(res.stdout, this.secrets)}`
          : `stdout began: ${redact(res.stdout.slice(0, 200), this.secrets)}`;
      throw new EnvToolError(
        `envTool.${name}: ${shown} did not print JSON (${
          err instanceof Error ? err.message : String(err)
        }) — ${tail}`,
      );
    }
    // R107: exit 0 is NOT the whole verdict when the config says what success looks like. Fails
    // closed — a missing path, a non-scalar, or any other value all count as failure, because the
    // declaration is positive evidence ("success looks like this"), not a blocklist.
    if (successWhen !== undefined) {
      const value = readPath(parsed, successWhen.path);
      const seen =
        typeof value === "string" || typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : undefined;
      if (seen !== successWhen.equals) {
        const detail = readsCredentials
          ? "(output withheld: this command's output carries credentials)"
          : redact(res.stdout, this.secrets);
        const found =
          seen === undefined
            ? "did not resolve to a string, number or boolean"
            : `resolved to ${JSON.stringify(seen)}`;
        throw new EnvToolError(
          `envTool.${name}: ${shown} exited 0 but its own output does not report success: ` +
            `successWhen.path ${JSON.stringify(successWhen.path)} ${found}, expected ` +
            `${JSON.stringify(successWhen.equals)}. Full output:\n${detail}`,
        );
      }
    }
    if (reads === undefined) return {};
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
