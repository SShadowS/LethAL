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
  return {
    projectDir: req(map, "--project"),
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
