#!/usr/bin/env bun
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { SelectorConfig } from "@lethal/schemata";
import { MutationControlClient } from "./activation";
import { AlRunnerBackend } from "./al-runner-backend";
import type { ExecutionBackend } from "./backend";
import { BcDevMcpBackend } from "./bcdev-backend";
import { generateMutationSet, runSession } from "./orchestrator";
import { Publisher, defaultAlToolPaths, defaultSpawn } from "./publisher";
import { renderConsole, writeJsonReport } from "./report";
import type { SessionReport } from "./report";
import { ResultsStore } from "./store";

/**
 * `cli.ts` is argument marshaling only — everything that decides pass/fail
 * (batching, deploy, activation, verdicts) lives in orchestrator.ts/selection.ts,
 * which are independently unit-tested. This file wires flags + a JSON config
 * file into the already-tested library calls and renders the result.
 */

// Verified against a real BC server (2026-07-18): the real `alc.exe` enforces app.json's
// `idRanges` (AL0297) for every object it compiles, including the injected Mutation
// Selector/Control/Active objects — unlike al-runner's compiler, which tolerated
// out-of-idRange ids without complaint. 50000/50001/50002 fall outside the fixture's
// 79000-79199 idRange and failed real compilation; these must live inside whatever
// idRange the target app declares. There is no general solution for arbitrary target
// apps yet (no CLI flag to override), so this default only holds for apps whose idRange
// covers 79197-79199 (e.g. the fixture) — a real target app may need its own ids.
const DEFAULT_SELECTOR_IDS: SelectorConfig = {
  selectorId: 79199,
  controlId: 79198,
  tableId: 79197,
};

export interface DryRunCliConfig {
  readonly mode: "dry-run";
  readonly projectDir: string;
}

export interface RunCliConfig {
  readonly mode: "run";
  readonly projectDir: string;
  readonly testDir: string;
  readonly backendKind: "bcdev" | "al-runner";
  readonly dbPath: string;
  readonly configPath: string;
  readonly skipKnownSurvivors: boolean;
  readonly outPath?: string;
  readonly workers: number;
  readonly compileConcurrency?: number;
}

export type CliConfig = DryRunCliConfig | RunCliConfig;

const VALID_SUBCOMMANDS = ["run"] as const;

/**
 * `lethal` only has one subcommand today (`run`), but the CLI is invoked as
 * `lethal run --project ...` (see fixtures/README.md) rather than bare flags
 * — require and validate it explicitly so an unknown/missing subcommand
 * fails with a clear message instead of silently ignoring it.
 */
function requireRunSubcommand(positionals: readonly string[]): void {
  const [subcommand] = positionals;
  if (subcommand !== undefined && (VALID_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    return;
  }
  const got = subcommand === undefined ? "none" : `"${subcommand}"`;
  throw new Error(
    `unknown subcommand: got ${got}, expected one of: ${VALID_SUBCOMMANDS.join(", ")}`,
  );
}

/**
 * Pure argument parsing/validation — no file or network I/O. Kept separate
 * from `main()` so arg-validation errors (missing --project, unknown
 * --backend, ...) are directly unit-testable without spawning a process.
 */
export function parseCliConfig(argv: readonly string[]): CliConfig {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      project: { type: "string" },
      tests: { type: "string" },
      backend: { type: "string" },
      db: { type: "string" },
      out: { type: "string" },
      config: { type: "string" },
      "skip-known-survivors": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      workers: { type: "string" },
      "compile-concurrency": { type: "string" },
    },
  });

  requireRunSubcommand(positionals);

  const projectDir = values.project;
  if (projectDir === undefined || projectDir === "") {
    throw new Error("missing required --project <dir>");
  }

  if (values["dry-run"] === true) {
    return { mode: "dry-run", projectDir };
  }

  const testDir = values.tests;
  if (testDir === undefined || testDir === "") {
    throw new Error("missing required --tests <dir> (omit only together with --dry-run)");
  }

  const backendArg = values.backend;
  if (backendArg === undefined || backendArg === "") {
    throw new Error('missing required --backend <"bcdev" | "al-runner">');
  }
  if (backendArg !== "bcdev" && backendArg !== "al-runner") {
    throw new Error(`unknown --backend "${backendArg}" (expected "bcdev" or "al-runner")`);
  }

  const workers = values.workers === undefined ? 1 : Number(values.workers);
  if (!Number.isInteger(workers) || workers < 1)
    throw new Error("--workers must be a positive integer");
  const compileConcurrency =
    values["compile-concurrency"] === undefined ? undefined : Number(values["compile-concurrency"]);
  if (
    compileConcurrency !== undefined &&
    (!Number.isInteger(compileConcurrency) || compileConcurrency < 1)
  )
    throw new Error("--compile-concurrency must be a positive integer");

  // bcdev mutant activation (MutationControlClient.setActive) is a single
  // server-side record shared by every worker — server + serverInstance +
  // company, one row. Per-worker Publisher.outputDir isolates each worker's
  // COMPILED ARTIFACT, but not this: two workers running concurrently would
  // both call setActive() against the SAME server record, so worker B's
  // activation can clobber worker A's while A's test is still in flight,
  // silently attributing a result to the wrong mutant. The setActive echo
  // check does not catch this — it validates its own response, not a later
  // overwrite by another worker. Every worker would also publish the same
  // app id to the same server instance. Real parallelism against the
  // authoritative backend needs per-container isolation (deferred to the
  // container-pool layer) — reject rather than silently corrupt results.
  if (backendArg === "bcdev" && workers > 1) {
    throw new Error(
      "--workers > 1 is not supported with --backend bcdev: mutant activation is a single " +
        "server-side record shared by all workers, so concurrent workers would overwrite each " +
        "other's active mutant. Parallel execution on a real BC server needs per-container " +
        "isolation (deferred to the container-pool layer).",
    );
  }

  return {
    mode: "run",
    projectDir,
    testDir,
    backendKind: backendArg,
    dbPath: values.db ?? join(projectDir, "lethal.sqlite"),
    configPath: values.config ?? join(projectDir, "lethal.config.json"),
    skipKnownSurvivors: values["skip-known-survivors"] ?? false,
    workers,
    ...(values.out !== undefined ? { outPath: values.out } : {}),
    ...(compileConcurrency !== undefined ? { compileConcurrency } : {}),
  };
}

export interface BcDevConfigSection {
  readonly mcpCommand: readonly string[];
  readonly server: string;
  readonly serverInstance: string;
  readonly tenant?: string;
  readonly company: string;
  readonly username: string;
  readonly password: string;
  readonly packageCachePath: string;
  // Extra env vars for the spawned bc-dev-mcp server process, e.g.
  // { "BC_DEV_USER": "...", "BC_DEV_PASSWORD": "..." } — see BcDevConfig.env.
  readonly env?: Record<string, string>;
}

export interface AlRunnerConfigSection {
  readonly alRunnerPath: string;
  readonly packagesDir?: string;
  readonly stubsDir?: string;
  // Opt-in server-mode transport (Task 4): keeps one al-runner process warm
  // instead of spawning one per test. Off by default.
  readonly serverMode?: boolean;
}

export interface LethalConfigFile {
  readonly bcdev?: Partial<BcDevConfigSection>;
  readonly alRunner?: Partial<AlRunnerConfigSection>;
}

/** Pure validators — no I/O — so "missing config field" errors are unit-testable directly. */
export function validateBcDevConfig(
  raw: Partial<BcDevConfigSection> | undefined,
): BcDevConfigSection {
  if (!raw) {
    throw new Error(
      'lethal.config.json is missing the "bcdev" section (required for --backend bcdev)',
    );
  }
  const missing: string[] = [];
  if (!Array.isArray(raw.mcpCommand) || raw.mcpCommand.length === 0) missing.push("mcpCommand");
  if (!raw.server) missing.push("server");
  if (!raw.serverInstance) missing.push("serverInstance");
  if (!raw.company) missing.push("company");
  if (!raw.username) missing.push("username");
  if (!raw.password) missing.push("password");
  if (!raw.packageCachePath) missing.push("packageCachePath");
  if (missing.length > 0) {
    throw new Error(
      `lethal.config.json "bcdev" section is missing required field(s): ${missing.join(", ")}`,
    );
  }
  return raw as BcDevConfigSection;
}

export function validateAlRunnerConfig(
  raw: Partial<AlRunnerConfigSection> | undefined,
): AlRunnerConfigSection {
  if (!raw) {
    throw new Error(
      'lethal.config.json is missing the "alRunner" section (required for --backend al-runner)',
    );
  }
  if (!raw.alRunnerPath) {
    throw new Error(
      'lethal.config.json "alRunner" section is missing required field(s): alRunnerPath',
    );
  }
  return raw as AlRunnerConfigSection;
}

async function loadLethalConfigFile(path: string): Promise<LethalConfigFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read config file at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return JSON.parse(text) as LethalConfigFile;
  } catch (err) {
    throw new Error(
      `config file at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * bc-dev's OData base URL isn't a separate config field — it's server + serverInstance, with
 * port 7048 injected. Verified against a real BC server (2026-07-18): `server` (e.g.
 * "http://Cronus28", used unqualified by bc-dev-mcp's own dev-service protocol) has no port,
 * which resolves to 80 for a plain HTTP request — but BC's OData/web-service endpoint listens
 * on 7048, not 80 (confirmed: port 80 returns 404, port 7048 serves OData correctly). Mirrors
 * bc-mcp's `deriveODataUrl` (a separately verified, already-working reference for this exact
 * container), which unconditionally forces port 7048 unless it's already exactly that.
 */
export function odataBaseUrl(server: string, serverInstance: string): string {
  const url = new URL(server);
  if (url.port !== "7048") url.port = "7048";
  return `${url.toString().replace(/\/+$/, "")}/${serverInstance}`;
}

/**
 * Builds one backend instance targeting `scratchDir` for all of its own scratch
 * output. Called once for the session's main backend (baseline/coverage), and —
 * when `--workers > 1` — once more per worker with a distinct `scratchDir`
 * (`cli.ts`'s `runFromCli`), so that:
 *   - each al-runner worker gets its own `instrumentedDir` — `AlRunnerBackend`
 *     copies each batch's compiled source into a private subdirectory of it on
 *     every `deploy()` call (see the comment there), so a distinct
 *     `instrumentedDir` per worker is what makes those copies land in
 *     genuinely separate directories instead of racing on the same one, and
 *   - each bcdev worker gets its own `Publisher.outputDir` — required per the
 *     Layer 4.2 plan's Task 2 review note: `BcDevMcpBackend.deploy` calls
 *     `publisher.compile(instrumentedDir)` with a single argument, so nothing
 *     stops two workers compiling to the same `<outputDir>/lethal-instrumented.app`
 *     and one publishing over the other's code UNLESS `outputDir` itself differs.
 */
async function buildBackend(
  parsed: RunCliConfig,
  configFile: LethalConfigFile,
  scratchDir: string,
): Promise<ExecutionBackend> {
  if (parsed.backendKind === "al-runner") {
    const c = validateAlRunnerConfig(configFile.alRunner);
    return new AlRunnerBackend({
      alRunnerPath: c.alRunnerPath,
      instrumentedDir: join(scratchDir, "al-runner-active"),
      testDir: parsed.testDir,
      ...(c.packagesDir !== undefined ? { packagesDir: c.packagesDir } : {}),
      ...(c.stubsDir !== undefined ? { stubsDir: c.stubsDir } : {}),
      selectorObjectId: DEFAULT_SELECTOR_IDS.selectorId,
      ...(c.serverMode !== undefined ? { serverMode: c.serverMode } : {}),
    });
  }

  const c = validateBcDevConfig(configFile.bcdev);
  const toolPaths = await defaultAlToolPaths();
  if (!toolPaths) {
    throw new Error(
      "could not locate alc.exe/altool.exe under the AL Language VS Code extension install " +
        "(~/.vscode/extensions/ms-dynamics-smb.al-*); install the extension, or run with --backend al-runner",
    );
  }
  const outputDir = join(scratchDir, "publish");
  await mkdir(outputDir, { recursive: true });
  const publisher = new Publisher(
    {
      alcPath: toolPaths.alcPath,
      altoolPath: toolPaths.altoolPath,
      packageCachePath: c.packageCachePath,
      outputDir,
      server: c.server,
      serverInstance: c.serverInstance,
      username: c.username,
      password: c.password,
      ...(c.tenant !== undefined ? { tenant: c.tenant } : {}),
    },
    defaultSpawn,
  );
  const activation = new MutationControlClient({
    baseUrl: odataBaseUrl(c.server, c.serverInstance),
    company: c.company,
    username: c.username,
    password: c.password,
    ...(c.tenant !== undefined ? { tenant: c.tenant } : {}),
  });
  return new BcDevMcpBackend(
    {
      mcpCommand: c.mcpCommand,
      project: parsed.projectDir,
      server: c.server,
      serverInstance: c.serverInstance,
      company: c.company,
      ...(c.tenant !== undefined ? { tenant: c.tenant } : {}),
      ...(c.env !== undefined ? { env: c.env } : {}),
    },
    undefined,
    publisher,
    activation,
  );
}

function lineOfIndex(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/**
 * One artifact per session (Layer 4.3): overlapping mutants coalesce into a
 * flat dispatch chain at compile time, so every site generated for the
 * project lands in a single batch — there's nothing left to split by overlap.
 */
async function printDryRun(projectDir: string): Promise<void> {
  const files = await generateMutationSet(projectDir);
  const sites = files.flatMap((f) =>
    f.specs.map((spec) => ({
      file: f.path,
      operatorName: spec.operatorName,
      line: lineOfIndex(f.source, spec.before.startIndex),
    })),
  );

  console.log(`dry run: ${files.length} file(s), ${sites.length} mutant site(s), 1 batch(es)`);
  console.log(`\nbatch 0 (${sites.length} mutant site(s)):`);
  for (const s of sites) {
    console.log(`  ${s.file}:${s.line}  ${s.operatorName}`);
  }
}

async function runFromCli(parsed: RunCliConfig): Promise<SessionReport> {
  const configFile = await loadLethalConfigFile(parsed.configPath);
  const scratchRoot = await mkdtemp(join(tmpdir(), "lethal-"));
  const backend = await buildBackend(parsed, configFile, scratchRoot);
  // `SessionConfig.backendFactory` is synchronous (`runSession` calls it
  // without awaiting — see orchestrator.ts), but building a worker's backend
  // is async (bcdev needs `defaultAlToolPaths()` + `mkdir`). So every worker
  // backend is constructed here, up front, each with its own
  // `<scratchRoot>/worker-<i>` scratch dir; the factory below just hands back
  // the already-built instance for that index. `runSession` still owns
  // disposing them (see `closeIfSupported` in orchestrator.ts) — it just
  // doesn't own constructing them.
  const workerBackends: ExecutionBackend[] = [];
  if (parsed.workers > 1) {
    for (let i = 0; i < parsed.workers; i++) {
      workerBackends.push(await buildBackend(parsed, configFile, join(scratchRoot, `worker-${i}`)));
    }
  }
  const store = new ResultsStore(parsed.dbPath);
  try {
    return await runSession({
      backend,
      store,
      projectDir: parsed.projectDir,
      testDir: parsed.testDir,
      instrumentedDir: join(scratchRoot, "instrumented"),
      selectorIds: DEFAULT_SELECTOR_IDS,
      skipKnownSurvivors: parsed.skipKnownSurvivors,
      workers: parsed.workers,
      ...(parsed.compileConcurrency !== undefined
        ? { compileConcurrency: parsed.compileConcurrency }
        : {}),
      ...(parsed.workers > 1
        ? {
            backendFactory: (i: number) => {
              const b = workerBackends[i];
              if (b === undefined) {
                throw new Error(`runFromCli: no worker backend pre-built for index ${i}`);
              }
              return b;
            },
          }
        : {}),
    });
  } finally {
    store.close();
    // Release whatever the backend is holding open: the spawned bc-dev MCP
    // child, or (server mode) the one warm al-runner process. The
    // `process.exit(0)` below would paper over a leak here, but only for this
    // entry point — anything else embedding the backend would hang or leak a
    // process instead.
    if (backend instanceof BcDevMcpBackend) await backend.close();
    if (backend instanceof AlRunnerBackend) await backend.close();
  }
}

async function main(): Promise<void> {
  const parsed = parseCliConfig(process.argv.slice(2));
  if (parsed.mode === "dry-run") {
    await printDryRun(parsed.projectDir);
    return;
  }
  const report = await runFromCli(parsed);
  console.log(renderConsole(report));
  if (parsed.outPath !== undefined) await writeJsonReport(report, parsed.outPath);
}

if (import.meta.main) {
  main()
    .then(() => {
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? (err.stack ?? String(err)) : String(err));
      process.exit(1);
    });
}
