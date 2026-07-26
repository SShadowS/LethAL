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
