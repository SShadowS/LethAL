/**
 * R663: set up, or reset, `bc-demo`, the BC on Linux instance on server1 that belongs to the
 * Directions EMEA talk, and check it with `lethal doctor`.
 *
 *   bun scripts/bc-demo-setup.ts [--dry-run]
 *
 * bc-demo is NOT a gate server. It is in no lease pool and no allocation, no gate reads its config,
 * and `bc-linux-setup.ts --server all` never reaches it (`DEMO_SERVER` in `bc-app-content.ts` is
 * deliberately not in `SERVERS`). So this script takes NO coord lease: there is no pool to lease it
 * from, and it refuses to run if kraken's allocation file ever lists it.
 *
 * In order:
 *   (a) refuse if `/coord/machine/allocation.json` lists bc-demo in any project;
 *   (b) probe bc-demo's dev port with ONE unauthenticated GET. No answer: print the owner steps
 *       (only the host can start the instance) and exit 2, having called nothing else;
 *   (c) read the login in this process: `/coord/secrets/bc-demo.env` if the owner wrote one, else
 *       the bc servers' `/coord/secrets/bc-linux.env` (`readSecretFile`; the password is never
 *       printed and never reaches a command line);
 *   (d) fill, or reuse, the write-once Microsoft symbol cache `/coord/cache/bc-symbols/bc-demo/...`
 *       FROM bc-demo itself, so nothing is fetched from the internet (the talk runs network-off);
 *   (e) write the gitignored `examples/gift-card/lethal.config.demo.json`;
 *   (f) compile gift-card and gift-card-tests, decide every app by content (`bc-app-content.ts`),
 *       and only if nothing is refused publish LethAL Control (`CONTROL_APP`, sha256-pinned), then
 *       gift-card, then its tests, in Dev scope over the dev endpoint;
 *   (g) run `lethal doctor` on the config.
 *
 * The database is in memory, so after a server1 reboot bc-demo is a fresh CRONUS: re-running this
 * script is the demo reset. A second run against an unchanged server publishes nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AppItem,
  type AppManifest,
  type Conn,
  DEMO_PORTS,
  DEMO_SERVER,
  HOST,
  type ServerOps,
  actAll,
  decideAll,
  manifest,
  realOps,
  refusals,
  residentPackage,
} from "./bc-app-content.ts";
import {
  type BcLogin,
  CONTROL_APP,
  type PublishStep,
  SECRET_PATH,
  bcDevMcpCommand,
  bcdevSection,
  describeLogin,
  doctor,
  errText,
  gitIgnores,
  pinnedControl,
  readSecretFile,
  realCompile,
  writeConfig,
} from "./bc-linux-setup.ts";
import { SYMBOL_CACHE_ROOT, fillSymbolCache } from "./bc-symbol-cache.ts";

const REPO = join(import.meta.dir, "..");
const EXAMPLES = join(REPO, "examples");
export const DEMO_SECRET_PATH = "/coord/secrets/bc-demo.env";
export const ALLOCATION_PATH = "/coord/machine/allocation.json";
export const DEMO_CONFIG = join(EXAMPLES, "gift-card", "lethal.config.demo.json");
/** gift-card's own idRanges hold 90197-90199 (`lethal.config.example.json`). */
const SELECTOR_IDS = { selectorId: 90199, controlId: 90198, tableId: 90197 };
const STEP: PublishStep = {
  target: "gift-card",
  dependents: ["gift-card-tests"],
  // `lethal run` deploys gift-card itself as an instrumented, minted build: keep that one.
  gateDeploys: true,
};

export function ownerSteps(): string[] {
  return [
    "1. On server1, check `free -g`: one more BC instance needs a few GB.",
    `2. Start a fourth BC on Linux instance the way bc3 runs (BC 28.4 W1, tenant default, instance BC, company CRONUS International Ltd.), with its OData, dev and API ports on host ports ${DEMO_PORTS.odata}, ${DEMO_PORTS.dev} and ${DEMO_PORTS.api}, and a restart policy.`,
    `3. Open ${DEMO_PORTS.odata}, ${DEMO_PORTS.dev} and ${DEMO_PORTS.api} in server1's firewall to the laptop.`,
    `4. Login: create the same user as on bc1-bc3 (${SECRET_PATH}), or write ${DEMO_SECRET_PATH} with exactly BC_DEV_USER=... and BC_DEV_PASSWORD=...`,
    `5. Do NOT add ${DEMO_SERVER} to ${ALLOCATION_PATH}: it is outside every lease pool.`,
    "6. Re-run: bun scripts/bc-demo-setup.ts",
  ];
}

export class DemoInPoolError extends Error {}

/** Refuses an allocation (kraken's lease pools, project -> servers) that lists bc-demo anywhere. */
export function checkNotPooled(allocationJson: string | null): void {
  if (allocationJson === null) return;
  const pools = JSON.parse(allocationJson) as Record<string, unknown>;
  for (const [project, servers] of Object.entries(pools)) {
    if (Array.isArray(servers) && servers.includes(DEMO_SERVER))
      throw new DemoInPoolError(
        `${ALLOCATION_PATH} lists ${DEMO_SERVER} for ${project}; it must stay outside every lease pool (R663). Ask the owner to remove it.`,
      );
  }
}

export interface DemoDeps {
  readonly allocation: () => string | null;
  /** One unauthenticated GET on the dev port: any HTTP answer means the instance is up. */
  readonly reachable: () => Promise<boolean>;
  readonly readSecret: () => BcLogin;
  readonly isIgnored: (path: string) => boolean;
  readonly writeConfig: (path: string, config: object) => void;
  /** The symbol cache dir, filled from bc-demo or reused. */
  readonly fillSymbols: (c: Conn) => Promise<string>;
  readonly controlBytes: () => Buffer;
  readonly compile: (c: Conn, symbols: string, log: string[]) => Promise<AppItem[]>;
  readonly serverOps: (c: Conn) => ServerOps;
  readonly doctor: (configPath: string) => Promise<boolean>;
  readonly mcpCommand: () => string[];
}

const conn = (login: BcLogin): Conn => ({
  server: DEMO_SERVER,
  authorization: `Basic ${Buffer.from(`${login.user}:${login.password}`).toString("base64")}`,
});

export const REAL_DEPS: DemoDeps = {
  allocation: () => (existsSync(ALLOCATION_PATH) ? readFileSync(ALLOCATION_PATH, "utf8") : null),
  reachable: async () => {
    try {
      await fetch(`${HOST}:${DEMO_PORTS.dev}/BC/`, { signal: AbortSignal.timeout(5000) });
      return true;
    } catch {
      return false;
    }
  },
  readSecret: () =>
    existsSync(DEMO_SECRET_PATH) ? readSecretFile(DEMO_SECRET_PATH) : readSecretFile(),
  isIgnored: gitIgnores,
  writeConfig: (path, config) => writeConfig(path, config, gitIgnores),
  fillSymbols: async (c) =>
    (
      await fillSymbolCache({
        root: SYMBOL_CACHE_ROOT,
        server: DEMO_SERVER,
        names: ["System"],
        download: (name) => residentPackage(c, "Microsoft", name),
      })
    ).dir,
  controlBytes: pinnedControl,
  compile: (c, symbols, log) => realCompile(c, STEP, symbols, log, EXAMPLES),
  serverOps: realOps,
  doctor: (configPath) =>
    doctor(configPath, join(EXAMPLES, "gift-card"), join(EXAMPLES, "gift-card-tests")),
  mcpCommand: bcDevMcpCommand,
};

function demoManifests(): Map<string, AppManifest> {
  return new Map(
    ["gift-card", ...STEP.dependents].map((d) => [d, manifest(join(EXAMPLES, d))] as const),
  );
}

async function setup(deps: DemoDeps, dryRun: boolean, summary: string[]): Promise<number> {
  checkNotPooled(deps.allocation());
  summary.push(
    `${DEMO_SERVER} (OData ${DEMO_PORTS.odata}, dev ${DEMO_PORTS.dev}, API ${DEMO_PORTS.api}; not a gate server, no lease)`,
  );
  if (dryRun) {
    summary.push(
      `  would probe ${HOST}:${DEMO_PORTS.dev}, fill or reuse ${join(SYMBOL_CACHE_ROOT, DEMO_SERVER, "<build>-<hash8>")}, write ${DEMO_CONFIG}, publish LethAL Control, gift-card and gift-card-tests, run doctor`,
    );
    return 0;
  }
  if (!(await deps.reachable())) {
    summary.push(
      `  ${DEMO_SERVER} does not answer on ${HOST}:${DEMO_PORTS.dev}. Only the owner can start it:`,
      ...ownerSteps().map((s) => `    ${s}`),
    );
    return 2;
  }
  const login = deps.readSecret();
  summary.push(`  login: ${describeLogin(login)}`);
  if (!deps.isIgnored(DEMO_CONFIG))
    throw new Error(`${DEMO_CONFIG} is not ignored by .gitignore; nothing was written`);
  const c = conn(login);
  const symbols = await deps.fillSymbols(c);
  summary.push(`  symbols   ${symbols}`);
  deps.writeConfig(DEMO_CONFIG, {
    selectorIds: SELECTOR_IDS,
    bcdev: bcdevSection(DEMO_SERVER, login, {
      mcpCommand: deps.mcpCommand(),
      controlSymbolPath: CONTROL_APP,
      packageCachePath: symbols,
    }),
  });
  summary.push(`  wrote     ${DEMO_CONFIG}`);

  const items: AppItem[] = [
    { dir: "lethal-control", local: deps.controlBytes(), role: "control", gateDeploys: false },
    ...(await deps.compile(c, symbols, summary)),
  ];
  const ops = deps.serverOps(c);
  const log = (s: string) => summary.push(s);
  const decided = await decideAll(items, ops, "setup", demoManifests(), log);
  if (refusals(decided).length > 0) {
    summary.push(`  STOPPED   ${refusals(decided).length} app(s) refused: NOTHING was published`);
    return 1;
  }
  await actAll(decided, ops, log);
  const ok = await deps.doctor(DEMO_CONFIG);
  summary.push(`  doctor    ${ok ? "ok" : "FAILED"}`);
  return ok ? 0 : 1;
}

export async function run(
  argv: readonly string[],
  deps: DemoDeps,
  print: (s: string) => void = console.log,
): Promise<number> {
  const unknown = argv.filter((a) => a !== "--dry-run");
  if (unknown.length > 0) {
    print(
      `unknown argument ${JSON.stringify(unknown[0])}; usage: bun scripts/bc-demo-setup.ts [--dry-run]`,
    );
    return 1;
  }
  const dryRun = argv.includes("--dry-run");
  const summary: string[] = [];
  let code: number;
  try {
    code = await setup(deps, dryRun, summary);
  } catch (err) {
    code = 1;
    summary.push(`  FAILED    ${errText(err)}`);
  }
  print(`\nbc-demo-setup${dryRun ? " (dry run)" : ""}:\n${summary.join("\n")}`);
  print(code === 0 ? "\nok" : code === 2 ? "\nNOT UP: owner steps above" : "\nFAILED");
  return code;
}

if (import.meta.main) process.exit(await run(process.argv.slice(2), REAL_DEPS));
