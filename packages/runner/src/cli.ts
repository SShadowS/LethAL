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
import { batchByOverlap } from "./selection";
import { ResultsStore } from "./store";

/**
 * `cli.ts` is argument marshaling only — everything that decides pass/fail
 * (batching, deploy, activation, verdicts) lives in orchestrator.ts/selection.ts,
 * which are independently unit-tested. This file wires flags + a JSON config
 * file into the already-tested library calls and renders the result.
 */

const DEFAULT_SELECTOR_IDS: SelectorConfig = {
  selectorId: 50000,
  controlId: 50001,
  tableId: 50002,
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

  return {
    mode: "run",
    projectDir,
    testDir,
    backendKind: backendArg,
    dbPath: values.db ?? join(projectDir, "lethal.sqlite"),
    configPath: values.config ?? join(projectDir, "lethal.config.json"),
    skipKnownSurvivors: values["skip-known-survivors"] ?? false,
    ...(values.out !== undefined ? { outPath: values.out } : {}),
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
}

export interface AlRunnerConfigSection {
  readonly alRunnerPath: string;
  readonly packagesDir?: string;
  readonly stubsDir?: string;
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

/** bc-dev's OData base URL isn't a separate config field — it's server + serverInstance. */
function odataBaseUrl(server: string, serverInstance: string): string {
  return `${server.replace(/\/+$/, "")}/${serverInstance}`;
}

async function buildBackend(
  kind: "bcdev" | "al-runner",
  configFile: LethalConfigFile,
  projectDir: string,
  testDir: string,
  scratchRoot: string,
): Promise<ExecutionBackend> {
  if (kind === "al-runner") {
    const c = validateAlRunnerConfig(configFile.alRunner);
    return new AlRunnerBackend({
      alRunnerPath: c.alRunnerPath,
      instrumentedDir: join(scratchRoot, "instrumented"),
      testDir,
      ...(c.packagesDir !== undefined ? { packagesDir: c.packagesDir } : {}),
      ...(c.stubsDir !== undefined ? { stubsDir: c.stubsDir } : {}),
      selectorObjectId: DEFAULT_SELECTOR_IDS.selectorId,
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
  const outputDir = join(scratchRoot, "publish");
  await mkdir(outputDir, { recursive: true });
  const publisher = new Publisher(
    {
      alcPath: toolPaths.alcPath,
      altoolPath: toolPaths.altoolPath,
      packageCachePath: c.packageCachePath,
      outputDir,
      server: c.server,
      serverInstance: c.serverInstance,
      ...(c.tenant !== undefined ? { tenant: c.tenant } : {}),
    },
    defaultSpawn,
  );
  const activation = new MutationControlClient({
    baseUrl: odataBaseUrl(c.server, c.serverInstance),
    company: c.company,
    username: c.username,
    password: c.password,
  });
  return new BcDevMcpBackend(
    {
      mcpCommand: c.mcpCommand,
      project: projectDir,
      server: c.server,
      serverInstance: c.serverInstance,
      company: c.company,
      ...(c.tenant !== undefined ? { tenant: c.tenant } : {}),
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

async function printDryRun(projectDir: string): Promise<void> {
  const files = await generateMutationSet(projectDir);
  const sites = files.flatMap((f) =>
    f.specs.map((spec) => ({
      file: f.path,
      startIndex: spec.before.startIndex,
      endIndex: spec.before.endIndex,
      operatorName: spec.operatorName,
      line: lineOfIndex(f.source, spec.before.startIndex),
    })),
  );
  const batches = batchByOverlap(sites);

  console.log(
    `dry run: ${files.length} file(s), ${sites.length} mutant site(s), ${batches.length} batch(es)`,
  );
  for (const [i, batch] of batches.entries()) {
    console.log(`\nbatch ${i} (${batch.length} mutant site(s)):`);
    for (const s of batch) {
      console.log(`  ${s.file}:${s.line}  ${s.operatorName}`);
    }
  }
}

async function runFromCli(parsed: RunCliConfig): Promise<SessionReport> {
  const configFile = await loadLethalConfigFile(parsed.configPath);
  const scratchRoot = await mkdtemp(join(tmpdir(), "lethal-"));
  const backend = await buildBackend(
    parsed.backendKind,
    configFile,
    parsed.projectDir,
    parsed.testDir,
    scratchRoot,
  );
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
    });
  } finally {
    store.close();
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
