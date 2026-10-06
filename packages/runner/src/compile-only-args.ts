/**
 * Argument parsing for the gate-0 compile-only driver, `scripts/campaign/compile-only.ts`.
 *
 * Lives under `packages/runner/src`, not next to the driver itself, because `scripts/` is
 * deliberately outside every package's `tsconfig.json` project graph — scripts run directly
 * under `bun`, never through `tsc --build` — while `packages/runner/tsconfig.json` is
 * `composite`. A test under `packages/runner/tests` importing a sibling file from `scripts/`
 * (outside the package's inferred `rootDir`) fails `tsc --build` with TS6059/TS6307, even though
 * `bun test` itself resolves the same import fine. Splitting the pure, unit-tested argument
 * parsing out here keeps it inside the package boundary the test lives in; the driver script
 * re-exports it for its own CLI use.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validatePreprocessorSymbols } from "./cli";
import { type MutationSetResult, generateMutationSet } from "./orchestrator";

export interface CompileOnlyArgs {
  readonly projectDir: string;
  readonly selectorIds: {
    readonly selectorId: number;
    readonly controlId: number;
    readonly tableId: number;
  };
  readonly alcPath: string;
  readonly packageCachePath: string;
  /**
   * Absolute path to the compiled `lethal-control.app` — the same `BcDevConfig.controlSymbolPath`
   * a real run reads from its config. Required, not optional: the driver stages it into the
   * package cache itself (exactly as `BcDevMcpBackend.stageForCompile` does), so that an operator
   * running gate 0 never meets the missing symbol as an unexplained alc resolution failure. An
   * optional flag would reinstate that trap for anyone who left it off.
   */
  readonly controlSymbolPath: string;
  /** R379: the config whose `preprocessorSymbols` a real run would build with (`--config`, default
   *  `<project>/lethal.config.json`, as `lethal run`). A missing file adds no symbols. */
  readonly configPath: string;
}

/**
 * R379: the config's `preprocessorSymbols`, validated as `lethal run` validates them. A config file
 * that does not exist gives none; one that exists but does not parse throws.
 */
export async function compileOnlyConfigSymbols(configPath: string): Promise<readonly string[]> {
  if (!existsSync(configPath)) return [];
  const raw = JSON.parse(await readFile(configPath, "utf8")) as { preprocessorSymbols?: unknown };
  return validatePreprocessorSymbols(raw.preprocessorSymbols);
}

/**
 * R379: the mutation set compile-only builds, enumerated under the same effective symbols as a
 * real run: the config's `preprocessorSymbols` here, plus `app.json`'s, which `generateMutationSet`
 * adds itself. Returns the config symbols too, for the alc step.
 */
export async function compileOnlyMutationSet(
  args: CompileOnlyArgs,
): Promise<{ readonly set: MutationSetResult; readonly configSymbols: readonly string[] }> {
  const configSymbols = await compileOnlyConfigSymbols(args.configPath);
  const set = await generateMutationSet(args.projectDir, { preprocessorSymbols: configSymbols });
  return { set, configSymbols };
}

function req(map: Map<string, string>, flag: string): string {
  const v = map.get(flag);
  if (v === undefined) throw new Error(`compile-only: missing required flag ${flag}`);
  return v;
}

export function parseCompileOnlyArgs(argv: readonly string[]): CompileOnlyArgs {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k !== undefined && v !== undefined) map.set(k, v);
  }
  const projectDir = req(map, "--project");
  return {
    projectDir,
    configPath: map.get("--config") ?? join(projectDir, "lethal.config.json"),
    selectorIds: {
      selectorId: Number(req(map, "--selector-id")),
      controlId: Number(req(map, "--control-id")),
      tableId: Number(req(map, "--table-id")),
    },
    alcPath: req(map, "--alc"),
    packageCachePath: req(map, "--package-cache"),
    controlSymbolPath: req(map, "--control-symbol"),
  };
}
