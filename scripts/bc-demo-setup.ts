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
 *
 * R663b LAPTOP MODE, `--laptop`: the talk runs on server1 itself, network-off, from a plain clone
 * with no kraken and no /coord (`docs/talk-laptop.md`). It is chosen by the flag only, never by
 * guessing from a missing /coord: a kraken run where /coord is briefly unmounted must refuse, not
 * quietly turn into a different mode, and the container simulation needs laptop mode WITH /coord
 * present. Without the flag nothing changes. With it, nothing under /coord or a container path is
 * read (`laptopTools`, `laptopLogin`, `laptopDeps`):
 *   - host `http://localhost` (`LETHAL_DEMO_HOST` overrides it), the same ports;
 *   - login from BC_DEV_USER and BC_DEV_PASSWORD in the environment, else from the checkout's
 *     `.lethal-demo.env`, read only after git confirms it is ignored;
 *   - symbol cache, the pinned control app and bc-dev-mcp under the checkout's `.lethal-cache/`;
 *   - alc and altool from `LETHAL_ALC_DIR`, else the newest AL extension in this user's home;
 *   - no allocation check: kraken's pools do not exist on the laptop.
 * Every missing dependency is refused by name, with its install step.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homeDir } from "../packages/runner/src/home.ts";
import { defaultAlToolPaths } from "../packages/runner/src/publisher.ts";
import {
  type AppItem,
  type Conn,
  DEMO_PORTS,
  DEMO_SERVER,
  HOST,
  type ServerOps,
  actAll,
  decideAll,
  realOps,
  refusals,
  residentPackage,
  sha256Of,
} from "./bc-app-content.ts";
import {
  type BcLogin,
  CONTROL_APP,
  CONTROL_SHA256,
  type PublishStep,
  SECRET_PATH,
  bcDevMcpCommand,
  bcdevSection,
  describeLogin,
  doctor,
  errText,
  gitIgnores,
  parseSecretEnv,
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
  /** R663b: set only in laptop mode (`laptopDeps`); kraken mode leaves it absent. */
  readonly laptop?: LaptopTools;
}

const conn = (login: BcLogin, host?: string): Conn => ({
  server: DEMO_SERVER,
  authorization: `Basic ${Buffer.from(`${login.user}:${login.password}`).toString("base64")}`,
  ...(host !== undefined ? { host } : {}),
});

/** R663's probe: one unauthenticated GET on bc-demo's dev port at `host`. */
export async function probe(host: string = HOST): Promise<boolean> {
  try {
    await fetch(`${host}:${DEMO_PORTS.dev}/BC/`, { signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

export const REAL_DEPS: DemoDeps = {
  allocation: () => (existsSync(ALLOCATION_PATH) ? readFileSync(ALLOCATION_PATH, "utf8") : null),
  reachable: () => probe(),
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

// ---------------------------------------------------------------------------------------------
// R663b: laptop mode. Every path below is inside the checkout, or comes from the environment.

export const LAPTOP_FLAG = "--laptop";
export const DEFAULT_LAPTOP_HOST = "http://localhost";
/** The login file: exactly BC_DEV_USER=... and BC_DEV_PASSWORD=... (gitignored). */
export const LOCAL_LOGIN = join(REPO, ".lethal-demo.env");
export const LOCAL_CACHE = join(REPO, ".lethal-cache");
export const LAPTOP_SYMBOLS = join(LOCAL_CACHE, "bc-symbols");
export const LAPTOP_CONTROL = join(LOCAL_CACHE, "control", basename(CONTROL_APP));
export const LAPTOP_BC_DEV_MCP = join(LOCAL_CACHE, "bc-dev-mcp");
/** The bc-dev-mcp commit the gates run (the container's checkout, v0.4.0-2). */
export const BC_DEV_MCP_COMMIT = "8371d0b";
export const NATIVE_PARSER = join(
  REPO,
  "packages",
  "engine",
  "vendor",
  "native",
  `lethal-parser.${process.platform}-${process.arch}.node`,
);

/** Everything laptop mode reads from outside this module goes through here (tests fake it). */
export interface LaptopIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly exists: (path: string) => boolean;
  readonly readText: (path: string) => string;
  readonly readBytes: (path: string) => Buffer;
  readonly isIgnored: (path: string) => boolean;
  readonly which: (cmd: string) => string | null;
  readonly home: string;
  readonly alTools: (
    extensionsDir: string,
  ) => Promise<{ alcPath: string; altoolPath: string } | undefined>;
}

export function realIo(): LaptopIo {
  return {
    env: process.env,
    exists: existsSync,
    readText: (p) => readFileSync(p, "utf8"),
    readBytes: (p) => readFileSync(p),
    isIgnored: gitIgnores,
    which: (cmd) => Bun.which(cmd),
    home: homeDir(),
    alTools: (dir) => defaultAlToolPaths(dir),
  };
}

export class LaptopRefused extends Error {}

export interface LaptopTools {
  readonly host: string;
  readonly symbolRoot: string;
  readonly controlPath: string;
  readonly mcpCommand: string[];
  readonly alcPath: string;
  readonly altoolPath: string;
}

const refuse = (what: string, fix: string) =>
  new LaptopRefused(`${what}. ${fix} (docs/talk-laptop.md)`);

/** Resolves every tool `setup`, `lethal run` and `lethal doctor` need, or refuses by name. */
export async function laptopTools(
  io: LaptopIo,
  controlSha: string = CONTROL_SHA256,
): Promise<LaptopTools> {
  const host = io.env.LETHAL_DEMO_HOST ?? DEFAULT_LAPTOP_HOST;
  if (!/^https?:\/\/[^/:]+$/.test(host))
    throw refuse(
      `LETHAL_DEMO_HOST ${JSON.stringify(host)} is not a bare http(s) host`,
      "Use e.g. http://localhost",
    );
  if (io.which("node") === null)
    throw refuse("node is not on PATH (bc-dev-mcp runs on it)", "Install Node.js 18 or newer");
  const mcpDir = io.env.LETHAL_BC_DEV_MCP ?? LAPTOP_BC_DEV_MCP;
  const mcpInstall = `Install it: git clone https://github.com/SShadowS/bc-dev-mcp ${mcpDir} && cd ${mcpDir} && git checkout ${BC_DEV_MCP_COMMIT} && bun install && bun run build`;
  if (!io.exists(join(mcpDir, "package.json")))
    throw refuse(`bc-dev-mcp is missing: no ${join(mcpDir, "package.json")}`, mcpInstall);
  const mcpCommand = bcDevMcpCommand(mcpDir, io.readText);
  const entry = mcpCommand[1] ?? "";
  if (!io.exists(entry))
    throw refuse(
      `bc-dev-mcp is not built: no ${entry}`,
      `Run: cd ${mcpDir} && bun install && bun run build`,
    );
  const exe = process.platform === "win32" ? ".exe" : "";
  const alcDir = io.env.LETHAL_ALC_DIR;
  let tools: { alcPath: string; altoolPath: string } | undefined;
  if (alcDir !== undefined) {
    tools = { alcPath: join(alcDir, `alc${exe}`), altoolPath: join(alcDir, `altool${exe}`) };
    for (const p of [tools.alcPath, tools.altoolPath])
      if (!io.exists(p))
        throw refuse(
          `alc/altool: LETHAL_ALC_DIR has no ${basename(p)} (${p})`,
          "Point LETHAL_ALC_DIR at the AL extension's bin/linux folder",
        );
  } else {
    tools = await io.alTools(join(io.home, ".vscode", "extensions"));
    if (tools === undefined)
      throw refuse(
        "alc/altool: no AL Language extension in this user's VS Code extensions",
        "Install it: code --install-extension ms-dynamics-smb.al, or set LETHAL_ALC_DIR",
      );
  }
  if (!io.exists(LAPTOP_CONTROL))
    throw refuse(
      `LethAL Control is missing: no ${LAPTOP_CONTROL}`,
      `Copy the pinned build (sha256 ${controlSha}) there from the coord folder handoff/R-389/control-1.0.0.23/`,
    );
  const controlGot = sha256Of(io.readBytes(LAPTOP_CONTROL));
  if (controlGot !== controlSha)
    throw refuse(
      `LethAL Control: ${LAPTOP_CONTROL} has sha256 ${controlGot}, not the pinned ${controlSha}`,
      "Copy the pinned build again",
    );
  if (!io.exists(NATIVE_PARSER))
    throw refuse(
      `the native AL parser is missing: no ${NATIVE_PARSER}`,
      "Build it with bun scripts/build-native-parser.ts (Rust and LLVM), or copy the .node built at this same commit",
    );
  return { host, symbolRoot: LAPTOP_SYMBOLS, controlPath: LAPTOP_CONTROL, mcpCommand, ...tools };
}

/** The login: BC_DEV_USER and BC_DEV_PASSWORD from the environment, else `.lethal-demo.env`. */
export function laptopLogin(io: LaptopIo): BcLogin {
  const user = io.env.BC_DEV_USER;
  const password = io.env.BC_DEV_PASSWORD;
  if (user !== undefined || password !== undefined) {
    if (user === undefined || user === "" || password === undefined || password === "")
      throw refuse(
        `only one of BC_DEV_USER and BC_DEV_PASSWORD is set (${user ? "BC_DEV_PASSWORD" : "BC_DEV_USER"} is missing or empty)`,
        "Set both, or unset both and use .lethal-demo.env",
      );
    return { user, password };
  }
  // Checked BEFORE the file is read: the repository is public.
  if (!io.isIgnored(LOCAL_LOGIN))
    throw refuse(
      `${LOCAL_LOGIN} is not ignored by .gitignore; it holds the login and this repository is public, so it was not read`,
      "Restore the .gitignore line `.lethal-demo.env`",
    );
  if (!io.exists(LOCAL_LOGIN))
    throw refuse(
      `no login: BC_DEV_USER and BC_DEV_PASSWORD are not set and ${LOCAL_LOGIN} does not exist`,
      "Write that file with exactly BC_DEV_USER=... and BC_DEV_PASSWORD=...",
    );
  return parseSecretEnv(io.readText(LOCAL_LOGIN), LOCAL_LOGIN);
}

export function laptopDeps(io: LaptopIo, t: LaptopTools, login: BcLogin): DemoDeps {
  return {
    // Kraken's lease pools are a /coord file; the laptop has none.
    allocation: () => null,
    reachable: () => probe(t.host),
    readSecret: () => login,
    isIgnored: io.isIgnored,
    writeConfig: (path, config) => writeConfig(path, config, io.isIgnored),
    fillSymbols: async (c) =>
      (
        await fillSymbolCache({
          root: t.symbolRoot,
          server: DEMO_SERVER,
          names: ["System"],
          download: (name) => residentPackage(c, "Microsoft", name),
        })
      ).dir,
    controlBytes: () => pinnedControl(t.controlPath, io.readBytes),
    compile: (c, symbols, log) => realCompile(c, STEP, symbols, log, EXAMPLES, t.alcPath),
    serverOps: realOps,
    doctor: REAL_DEPS.doctor,
    mcpCommand: () => t.mcpCommand,
    laptop: t,
  };
}

/** How to start bc-demo on the laptop (it is compose project `bc-demo`, R663's owner addendum). */
export function laptopStartSteps(host: string): string[] {
  return [
    "1. Start it: cd ~/bclan && docker compose -p bc-demo --env-file bc-demo.env up -d",
    `2. Wait until ${host}:${DEMO_PORTS.dev}/BC/ answers (a minute or two), then re-run.`,
  ];
}

async function setup(deps: DemoDeps, dryRun: boolean, summary: string[]): Promise<number> {
  checkNotPooled(deps.allocation());
  const lap = deps.laptop;
  const host = lap?.host ?? HOST;
  summary.push(
    `${DEMO_SERVER} (OData ${DEMO_PORTS.odata}, dev ${DEMO_PORTS.dev}, API ${DEMO_PORTS.api}; not a gate server, no lease)`,
  );
  if (lap !== undefined)
    summary.push(
      `  laptop    host ${lap.host}, cache ${lap.symbolRoot}, alc ${lap.alcPath}, bc-dev-mcp ${lap.mcpCommand.join(" ")}`,
    );
  if (dryRun) {
    summary.push(
      `  would probe ${host}:${DEMO_PORTS.dev}, fill or reuse ${join(lap?.symbolRoot ?? SYMBOL_CACHE_ROOT, DEMO_SERVER, "<build>-<hash8>")}, write ${DEMO_CONFIG}, publish LethAL Control, gift-card and gift-card-tests, run doctor`,
    );
    return 0;
  }
  if (!(await deps.reachable())) {
    summary.push(
      lap === undefined
        ? `  ${DEMO_SERVER} does not answer on ${HOST}:${DEMO_PORTS.dev}. Only the owner can start it:`
        : `  ${DEMO_SERVER} does not answer on ${host}:${DEMO_PORTS.dev}.`,
      ...(lap === undefined ? ownerSteps() : laptopStartSteps(host)).map((s) => `    ${s}`),
    );
    return 2;
  }
  const login = deps.readSecret();
  summary.push(`  login: ${describeLogin(login)}`);
  if (!deps.isIgnored(DEMO_CONFIG))
    throw new Error(`${DEMO_CONFIG} is not ignored by .gitignore; nothing was written`);
  const c = conn(login, lap?.host);
  const symbols = await deps.fillSymbols(c);
  summary.push(`  symbols   ${symbols}`);
  const bcdev = bcdevSection(
    DEMO_SERVER,
    login,
    {
      mcpCommand: deps.mcpCommand(),
      controlSymbolPath: lap?.controlPath ?? CONTROL_APP,
      packageCachePath: symbols,
    },
    lap?.host,
  );
  deps.writeConfig(DEMO_CONFIG, {
    selectorIds: SELECTOR_IDS,
    // Laptop mode pins the alc/altool it resolved, so `lethal run` and doctor use the same ones.
    bcdev:
      lap === undefined ? bcdev : { ...bcdev, alcPath: lap.alcPath, altoolPath: lap.altoolPath },
  });
  summary.push(`  wrote     ${DEMO_CONFIG}`);

  const items: AppItem[] = [
    { dir: "lethal-control", local: deps.controlBytes(), role: "control", gateDeploys: false },
    ...(await deps.compile(c, symbols, summary)),
  ];
  const ops = deps.serverOps(c);
  const log = (s: string) => summary.push(s);
  const decided = await decideAll(items, ops, "setup", log);
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
  /** Builds laptop mode's deps; called only when `argv` holds `--laptop`. */
  laptop: () => Promise<DemoDeps> = realLaptopDeps,
): Promise<number> {
  const unknown = argv.filter((a) => a !== "--dry-run" && a !== LAPTOP_FLAG);
  if (unknown.length > 0) {
    print(
      `unknown argument ${JSON.stringify(unknown[0])}; usage: bun scripts/bc-demo-setup.ts [--dry-run]`,
    );
    return 1;
  }
  const dryRun = argv.includes("--dry-run");
  const onLaptop = argv.includes(LAPTOP_FLAG);
  const summary: string[] = [];
  let code: number;
  try {
    code = await setup(onLaptop ? await laptop() : deps, dryRun, summary);
  } catch (err) {
    code = 1;
    summary.push(`  FAILED    ${errText(err)}`);
  }
  print(
    `\nbc-demo-setup${onLaptop ? " (laptop)" : ""}${dryRun ? " (dry run)" : ""}:\n${summary.join("\n")}`,
  );
  print(code === 0 ? "\nok" : code === 2 ? "\nNOT UP: owner steps above" : "\nFAILED");
  return code;
}

async function realLaptopDeps(): Promise<DemoDeps> {
  const io = realIo();
  return laptopDeps(io, await laptopTools(io), laptopLogin(io));
}

if (import.meta.main) process.exit(await run(process.argv.slice(2), REAL_DEPS));
