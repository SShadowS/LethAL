/**
 * R589: bring one or more of the BC on Linux servers on server1 (bc1, bc2, bc3) to the state the
 * LethAL BC gates need, and check it with `lethal doctor`.
 *
 *   bun scripts/bc-linux-setup.ts --server bc1|bc2|bc3|all [--lane <lane>] [--dry-run]
 *                                 [--with-continia] [--accept-build <v>] [--held-lease <token>]
 *   bun scripts/bc-linux-setup.ts --server bc1|bc2|bc3|all --write-config-only
 *
 * The coord lease is taken in the caller's lane (R598): `--lane`, else the kraken agent identity
 * (`KRAKEN_AGENT`: `lane-<x>` is lane `<x>`, `orchestrator` is `orchestrator`). With neither, the run
 * refuses by name before anything else, so a lease is never held in another lane's name.
 *
 * `--with-continia` (R594) adds step (d2) after LethAL Control: check that the server's Microsoft
 * apps are the R546 packagesDir's 28.4.53241.53758, then publish the 5 sha256-pinned Continia
 * apps (Dev scope) that Continia Document Output depends on, after checking each one's declared
 * dependencies against the server. `--accept-build <v>` makes P1 accept that Microsoft build
 * instead (R594's ruling: bc3 at 28.4.53241.56646 is a NEW oracle). `--held-lease` names a coord lease
 * the caller already holds for that one server: the script heartbeats it but never takes or
 * releases it.
 *
 * In order, per server:
 *   (a) read /coord/secrets/bc-linux.env in this process (exactly BC_DEV_USER and BC_DEV_PASSWORD);
 *   (b) check that git ignores every config and launch path it will write;
 *   (c) take the coord lease for the server, record its token at once, heartbeat, release in a
 *       `finally`;
 *   (c2) fill, or reuse when it is complete, the SHARED write-once Microsoft symbol cache
 *       `/coord/cache/bc-symbols/<server>/<build>-<hash8>/` (`bc-symbol-cache.ts`: Microsoft packages
 *       only), then write one gitignored `lethal.config.<server>.json` per gate fixture, with its
 *       launch file, whose `packageCachePath` names that dir;
 *   (d) publish, in Dev scope over the dev endpoint (`dev/apps`), LethAL Control (`CONTROL_APP`) and then
 *       each gate's fixture pair, target before tests, skipping an app the server already holds at
 *       the same or a higher version;
 *   (e) run `lethal doctor` on every written config;
 *   (f) print a summary.
 *
 * `--write-config-only` does (a), (b) and the config writes alone: NO server call and NO lease.
 * The configs name the newest verified build dir of the shared cache for that server, read from
 * its own marker; with none, it names `<server>/unfilled-run-setup-first`, prints "symbol cache
 * empty for <server>: run setup --server <server> once" and fails, so it never claims gate-ready.
 *
 * The databases are in memory: a container restart or a server1 reboot resets a server to a fresh
 * CRONUS, and re-running this script is the fix. It is idempotent for that reason.
 *
 * CREDENTIALS. The login is read from the secret file into memory and goes to the server only as a
 * Basic auth header this process builds. It never reaches a command line, a log line or an error
 * message: errors name the key, never the value, and the summary prints key names and lengths only.
 * `altool` is not used because its publish path takes the login from its environment, and the
 * in-process `dev/apps` POST needs no child process at all. The per-server config files hold the
 * login, which is why they must be git-ignored.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { compareAppVersions } from "../packages/runner/src/app-version.ts";
import { bcFetch } from "../packages/runner/src/bc-fetch.ts";
import { devPackagesUrl } from "../packages/runner/src/bcdev-backend.ts";
import { appInputsOfPackage } from "../packages/runner/src/digest-inputs.ts";
import { readAppIdentity } from "../packages/runner/src/published-test-app.ts";
import { defaultAlToolPaths } from "../packages/runner/src/publisher.ts";
import {
  type AppItem,
  type AppManifest,
  type Conn,
  type Decided,
  HOST,
  SERVERS,
  type ServerName,
  type ServerOps,
  actAll,
  contentDigest,
  decideAll,
  fixtureManifests,
  headerPackageId,
  manifest,
  publishBytes,
  realOps,
  refusals,
  sha256Of,
} from "./bc-app-content.ts";
import {
  SYMBOL_CACHE_ROOT,
  UNFILLED,
  fillSymbolCache,
  lookupSymbolCache,
} from "./bc-symbol-cache.ts";

// Moved down into bc-app-content.ts (R599); re-exported so no importer's line changes.
export {
  type AppManifest,
  type Conn,
  HOST,
  SERVERS,
  type ServerName,
  manifest,
  publishBytes,
  sha256Of,
};

const REPO = join(import.meta.dir, "..");
export const SECRET_PATH = "/coord/secrets/bc-linux.env";
export const EXPECTED_KEYS = ["BC_DEV_USER", "BC_DEV_PASSWORD"] as const;
// R389: the 1.0.0.23 build (adds `DependentCount`), compiled clean with alc and published to bc3.
export const CONTROL_APP =
  "/coord/handoff/R-389/control-1.0.0.23/LethAL_LethAL Control_1.0.0.23.app";
export const CONTROL_SHA256 = "c2a959480579943a667cab5fc4abe581e2741307561a05890ce735e54a37d4bd";
const CONTROL_VERSION = "1.0.0.23";
const TOKEN_DIR = "/coord/handoff/R-589";
const STATE_ROOT = join(REPO, ".kraken-local", "bc-linux");
const BC_DEV_MCP = "/home/dev/src/bc-dev-mcp";
const HEARTBEAT_MS = 60_000;

/**
 * The fixtures whose config directory a BC gate reads (`itestConfigPath(<dir>)` in
 * packages/runner/itest), with the pair each one needs published. `sandbox-app` also serves
 * `itest:bcdev-names`, `-wrapped`, `:verify`, `:lease`, `:stale-publish` and `:testapp`;
 * `sandbox-data` serves `:tables`, `:chunked` and `:verify-scale`; `sandbox-harden` also serves
 * `:verify-agreement`. What each gate needs PUBLISHED is `PUBLISH_PLAN`, which is longer.
 */
export const GATE_FIXTURES = [
  { configDir: "sandbox-app", target: "sandbox-app", tests: "sandbox-tests" },
  { configDir: "sandbox-data", target: "sandbox-data", tests: "sandbox-data-tests" },
  { configDir: "sandbox-hang", target: "sandbox-hang", tests: "sandbox-hang-tests" },
  { configDir: "sandbox-harden", target: "sandbox-harden", tests: "sandbox-harden-tests" },
] as const;

export type GateConfigDir = (typeof GATE_FIXTURES)[number]["configDir"];

/**
 * R596: the config's top-level `selectorIds`, per fixture. `itest:agreement` refuses unless
 * sandbox-harden's config names the ids its full runs use (`SELECTOR_IDS` in
 * verify-agreement.itest.ts, R261), because `lethal verify` reads them from the config. The other
 * fixtures keep LethAL's defaults.
 */
export const FIXTURE_SELECTOR_IDS: Partial<
  Record<GateConfigDir, { selectorId: number; controlId: number; tableId: number }>
> = {
  "sandbox-harden": { selectorId: 79547, controlId: 79548, tableId: 79549 },
};

export interface PublishStep {
  /** The fixture published first. */
  readonly target: string;
  /** `/define:` symbols for the target's compile (fixtures/README.md says which). */
  readonly defines?: readonly string[];
  /** Apps that depend on `target`, compiled against the LOCAL target build (R599, F3). */
  readonly dependents: readonly string[];
  /**
   * R599 (I3): a gate deploys this target itself as an instrumented, minted build, so setup KEEPS
   * a resident build above app.json when that build is instrumented. Unmarked (`sandbox-probes`):
   * a resident build above app.json is refused.
   */
  readonly gateDeploys?: boolean;
}

/**
 * Every app a BC gate needs on the server, after LethAL Control, in this order (Cronus28's setup,
 * /coord/handoff/R-583/cronus28-setup.md). LethAL publishes only the instrumented target; the rest
 * is the user's job (CLAUDE.md, R56):
 * - `sandbox-probes` before `sandbox-app`: `itest:bcdev`'s protocol-invariant probes call it
 *   (`ZzFailsIfMarkerPresent`, codeunit 79210), and without it they find 0 methods.
 * - `sandbox-harden-answers` for `itest:harden`'s answer key (fixtures/README.md, sandbox-harden).
 * - `sandbox-wrapped` with `/define:WRAPDEF` for `itest:bcdev-wrapped` (fixtures/README.md: the
 *   tests app must be compiled against the WRAPDEF build, or the run refuses `StaleTestAppError`).
 * - `sandbox-names` for `itest:bcdev-names`.
 * `itest:chunked` and `:verify-scale` use the `sandbox-data` pair, `:verify`, `:lease`,
 * `:stale-publish` and `:testapp` the `sandbox-app` pair, `:agreement` the `sandbox-harden` pair.
 */
export const PUBLISH_PLAN: readonly PublishStep[] = [
  { target: "sandbox-probes", dependents: [] },
  { target: "sandbox-app", dependents: ["sandbox-tests"], gateDeploys: true },
  { target: "sandbox-data", dependents: ["sandbox-data-tests"], gateDeploys: true },
  { target: "sandbox-hang", dependents: ["sandbox-hang-tests"], gateDeploys: true },
  {
    target: "sandbox-harden",
    dependents: ["sandbox-harden-tests", "sandbox-harden-answers"],
    gateDeploys: true,
  },
  {
    target: "sandbox-wrapped",
    defines: ["WRAPDEF"],
    dependents: ["sandbox-wrapped-tests"],
    gateDeploys: true,
  },
  { target: "sandbox-names", dependents: ["sandbox-names-tests"], gateDeploys: true },
];

/**
 * The Microsoft packages the shared symbol cache holds: `System` plus every Microsoft dependency of
 * a `PUBLISH_PLAN` target, which is what a gate's instrumented compile reads from
 * `packageCachePath`. A dependent's symbols (its target, Library Assert) are never put there: the
 * dependent's compile builds its own private cache.
 */
export function symbolNames(fixtures: string = join(REPO, "fixtures")): string[] {
  const deps = PUBLISH_PLAN.flatMap((s) =>
    (manifest(join(fixtures, s.target)).dependencies ?? [])
      .filter((d) => d.publisher === "Microsoft")
      .map((d) => d.name),
  );
  return [...new Set(["System", ...deps])];
}

// ---------------------------------------------------------------------------------------------
// (a) the secret file

export class SecretFileError extends Error {}

export interface BcLogin {
  readonly user: string;
  readonly password: string;
}

/**
 * Parses `KEY=value` lines. Blank lines and `#` comments are allowed. The value is everything after
 * the first `=`, kept byte for byte apart from a trailing CR: no trimming and no unquoting, so a
 * password ending in `!` (or holding `=`) arrives intact. Every refusal names a key or a line
 * number, never a value.
 */
export function parseSecretEnv(text: string): BcLogin {
  const seen = new Map<string, string>();
  const lines = text.split("\n");
  for (const [i, raw] of lines.entries()) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const eq = line.indexOf("=");
    // The line itself is not quoted: a line with no `=` may be a bare password.
    if (eq < 0) throw new SecretFileError(`${SECRET_PATH}: line ${i + 1} is not KEY=value`);
    const key = line.slice(0, eq).trim();
    if (!(EXPECTED_KEYS as readonly string[]).includes(key)) {
      // Named only when it looks like an env key: a bare password holding `=` would otherwise
      // have its first half printed as the "key".
      const named = /^[A-Z_][A-Z0-9_]*$/.test(key) ? ` ${JSON.stringify(key)}` : "";
      throw new SecretFileError(
        `${SECRET_PATH}: unexpected key${named} on line ${i + 1}; only ${EXPECTED_KEYS.join(" and ")} are allowed`,
      );
    }
    if (seen.has(key)) throw new SecretFileError(`${SECRET_PATH}: ${key} is set twice`);
    seen.set(key, line.slice(eq + 1));
  }
  return { user: required(seen, "BC_DEV_USER"), password: required(seen, "BC_DEV_PASSWORD") };
}

function required(seen: ReadonlyMap<string, string>, key: string): string {
  const value = seen.get(key);
  if (value === undefined) throw new SecretFileError(`${SECRET_PATH}: ${key} is missing`);
  if (value === "") throw new SecretFileError(`${SECRET_PATH}: ${key} is empty`);
  return value;
}

export function readSecretFile(path: string = SECRET_PATH): BcLogin {
  if (!existsSync(path)) {
    throw new SecretFileError(
      `${path} does not exist. The owner writes it, holding exactly BC_DEV_USER=... and BC_DEV_PASSWORD=...`,
    );
  }
  return parseSecretEnv(readFileSync(path, "utf8"));
}

/** What may be printed about the login: key names and lengths. */
export function describeLogin(login: BcLogin): string {
  return `BC_DEV_USER (${login.user.length} chars), BC_DEV_PASSWORD (${login.password.length} chars)`;
}

// ---------------------------------------------------------------------------------------------
// (b) the per-server configs

export class NotIgnoredError extends Error {}

export interface ConfigPaths {
  /** The bc-dev-mcp launch argv. */
  readonly mcpCommand: readonly string[];
  readonly controlSymbolPath: string;
  /** Microsoft symbols downloaded from THIS server, for LethAL's instrumented compile. */
  readonly packageCachePath: string;
}

export function configFileName(server: ServerName): string {
  return `lethal.config.${server}.json`;
}

/** The `.vscode` launch file the itests pair with `configFileName` (`itestLaunchName`). */
export function launchFileName(server: ServerName): string {
  return `launch.${server}.json`;
}

/**
 * The launch file for one server. The itests read only `environmentType` and `environmentName`
 * from it (`LaunchLocalConfig` in each itest); the rest is the AL launch shape, so the same file
 * also connects VS Code or `altool --project` to this server. An AL launch file carries no
 * password, and this one carries no login at all.
 */
export function buildLaunch(server: ServerName): object {
  return {
    version: "0.2.0",
    configurations: [
      {
        name: `LethAL ${server} (R589)`,
        type: "al",
        request: "launch",
        environmentType: "OnPrem",
        server: HOST,
        port: SERVERS[server].dev,
        serverInstance: "BC",
        tenant: "default",
        authentication: "UserPassword",
      },
    ],
  };
}

/**
 * The `bcdev` section for one server. Field names are `BcDevConfigSection`'s (cli.ts); values that
 * the schema leaves to the operator come from the R589 handoff; `alcPath`, `altoolPath` and
 * `coverageMode` are left absent so LethAL's own defaults apply (the newest AL extension, fenced).
 *
 * `server` carries the DEV port, not the bare host. All three servers share one host, and LethAL
 * keys its quarantine (`quarantineResourceKey`) and its publish queue (`canonicalContainerKey`)
 * on `server`, so a bare host would make bc1, bc2 and bc3 one resource. `baseUrl` is the OData
 * root, used verbatim (`odataBaseUrl` would force 7048), `apiBaseUrl` the API root LethAL's own
 * API reads (companies, extensions) use, and `BC_DEV_API_PORT` points bc-dev-mcp's Automation
 * API calls at the same port instead of its 7048 default. Measured on bc1 2026-10-21: the API
 * under the OData root answers 404 "Resource not found for the segment 'BC'".
 *
 * `configDir` adds that fixture's `selectorIds` (`FIXTURE_SELECTOR_IDS`, R596).
 */
export function buildConfig(
  server: ServerName,
  login: BcLogin,
  paths: ConfigPaths,
  configDir: GateConfigDir,
): object {
  const p = SERVERS[server];
  const selectorIds = FIXTURE_SELECTOR_IDS[configDir];
  return {
    ...(selectorIds !== undefined ? { selectorIds } : {}),
    bcdev: {
      mcpCommand: paths.mcpCommand,
      server: `${HOST}:${p.dev}`,
      serverInstance: "BC",
      tenant: "default",
      port: p.dev,
      baseUrl: `${HOST}:${p.odata}/BC`,
      apiBaseUrl: `${HOST}:${p.api}/BC`,
      company: "CRONUS International Ltd.",
      username: login.user,
      password: login.password,
      packageCachePath: paths.packageCachePath,
      controlSymbolPath: paths.controlSymbolPath,
      env: {
        BC_DEV_USER: login.user,
        BC_DEV_PASSWORD: login.password,
        BC_DEV_API_PORT: String(p.api),
      },
    },
  };
}

/** True when the repo's own .gitignore ignores `path` (a global excludes file is not trusted). */
export function gitIgnores(path: string): boolean {
  const r = Bun.spawnSync(
    [
      "git",
      "-C",
      REPO,
      "-c",
      `core.excludesFile=${join(tmpdir(), "bc-linux-setup-no-excludes")}`,
      "check-ignore",
      "--no-index",
      "-q",
      path,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  return r.exitCode === 0;
}

export function writeConfig(
  path: string,
  config: object,
  isIgnored: (p: string) => boolean = gitIgnores,
): void {
  if (!isIgnored(path)) {
    throw new NotIgnoredError(
      `${path} is not ignored by .gitignore. It would hold the BC login and this repository is public, so nothing was written.`,
    );
  }
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  // `mode` applies only when the file is CREATED. A re-run (after every server1 reboot) or a file
  // someone made by hand would keep 644 while holding the login, so set it on every write.
  chmodSync(path, 0o600);
}

// ---------------------------------------------------------------------------------------------
// (c) the coord lease

export interface LeaseDeps {
  take(server: ServerName): Promise<string>;
  recordToken(server: ServerName, token: string): void;
  heartbeat(server: ServerName, token: string): Promise<void>;
  release(server: ServerName, token: string): Promise<void>;
}

export class LeaseLostError extends Error {}

/**
 * Takes the lease, records its token BEFORE anything else runs (so a crash leaves a token someone
 * can release with), heartbeats while `body` runs, and releases in a `finally`.
 *
 * A failed heartbeat fails the run (`LeaseLostError` after the body): the lease may have lapsed and
 * another lane may hold the server now, so a PASS would claim work done under a lease nobody held.
 * A failed release never replaces the body's own error.
 */
export async function withLease<T>(
  server: ServerName,
  deps: LeaseDeps,
  body: () => Promise<T>,
  heartbeatMs: number = HEARTBEAT_MS,
): Promise<T> {
  const token = await deps.take(server);
  let timer: ReturnType<typeof setInterval> | undefined;
  let heartbeatError: string | undefined;
  let result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown };
  try {
    deps.recordToken(server, token);
    timer = setInterval(() => {
      deps.heartbeat(server, token).catch((err) => {
        heartbeatError ??= errText(err);
        console.error(`  [FAIL] heartbeat for ${server} failed: ${errText(err)}`);
      });
    }, heartbeatMs);
    const value = await body();
    if (heartbeatError !== undefined) {
      throw new LeaseLostError(
        `${server}: a heartbeat failed during the run (${heartbeatError}); the lease may have lapsed, so the run is not trusted`,
      );
    }
    result = { ok: true, value };
  } catch (error) {
    result = { ok: false, error };
  }
  if (timer !== undefined) clearInterval(timer);
  try {
    await deps.release(server, token);
  } catch (err) {
    if (result.ok) throw err;
    console.error(`  [FAIL] releasing ${server} failed too: ${errText(err)}`);
  }
  if (!result.ok) throw result.error;
  return result.value;
}

export async function kraken(args: readonly string[]): Promise<string> {
  const p = Bun.spawn(["kraken", "coord", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`kraken coord ${args[0]} failed (exit ${code}): ${out}${err}`);
  return out;
}

/** R598: no lane could be found for the coord lease; the run refuses rather than borrow one. */
export class LaneUnknownError extends Error {}

/**
 * R598: the lane the coord lease is taken in. `--lane` wins; else the kraken agent identity
 * (`KRAKEN_AGENT`, mapped as `scripts/coord-join-role.ts` maps it: `lane-<x>` is lane `<x>`,
 * `orchestrator` is `orchestrator`). With neither, or an identity that names no lane, it refuses.
 */
export function resolveLane(
  cliLane: string | undefined,
  env: Record<string, string | undefined>,
): string {
  if (cliLane !== undefined && cliLane !== "") {
    // The likeliest slip is the agent name (`lane-preproc`): kraken would lease under that holder,
    // which is no lane, so the holder shown to other lanes would be wrong again.
    if (cliLane.startsWith("lane-")) {
      throw new LaneUnknownError(
        `--lane ${JSON.stringify(cliLane)} is an agent name, not a lane; pass --lane ${JSON.stringify(cliLane.slice("lane-".length))}`,
      );
    }
    return cliLane;
  }
  const agent = env.KRAKEN_AGENT;
  if (agent === "orchestrator") return "orchestrator";
  if (agent?.startsWith("lane-") && agent.length > "lane-".length)
    return agent.slice("lane-".length);
  throw new LaneUnknownError(
    agent === undefined || agent === ""
      ? "no lane for the coord lease: pass --lane <lane>, or run as a kraken agent (KRAKEN_AGENT is not set)"
      : `no lane for the coord lease: KRAKEN_AGENT ${JSON.stringify(agent)} names no lane; pass --lane <lane>`,
  );
}

/** The coord lease in `lane`'s name. `run` is the kraken-call seam (`kraken` in a real run). */
export function krakenLeaseFor(
  lane: string,
  run: (args: readonly string[]) => Promise<string> = kraken,
): LeaseDeps {
  return {
    async take(server) {
      const out = await run(["lease", server, lane]);
      const token = (JSON.parse(out) as { token?: unknown }).token;
      if (typeof token !== "string" || token === "") {
        throw new Error(`kraken coord lease ${server}: no token in its answer`);
      }
      return token;
    },
    recordToken(server, token) {
      writeFileSync(join(TOKEN_DIR, `lease-${server}.txt`), `${token}\n`, "utf8");
    },
    async heartbeat(server, token) {
      await run(["heartbeat", server, token]);
    },
    async release(server, token) {
      await run(["release", server, token]);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// (d) publishing over the dev endpoint

/** The package the server holds for publisher/name, or `null` when it holds none. */
export async function residentPackage(
  c: Conn,
  publisher: string,
  name: string,
): Promise<Buffer | null> {
  const url = devPackagesUrl(
    { server: HOST, serverInstance: "BC", tenant: "default", port: SERVERS[c.server].dev },
    { publisher, name },
  );
  if (url === null) throw new Error("unreachable: devPackagesUrl refused a fixed URL");
  const res = await bcFetch(url, { headers: { authorization: c.authorization } });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`${c.server}: the dev endpoint refused the login (HTTP ${res.status})`);
  }
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

async function residentVersion(c: Conn, publisher: string, name: string): Promise<string | null> {
  const pkg = await residentPackage(c, publisher, name);
  return pkg === null ? null : readAppIdentity(pkg).version;
}

export type AppOutcome = "published" | "skipped";

/**
 * Publishes `bytes` unless the server already holds the app at the same or a higher version (a
 * gate run leaves the target at a higher minted version, and a downgrade would be refused). After
 * a publish, the server must report exactly the local version.
 *
 * R599: the fixture path no longer uses this (it decides by content, `bc-app-content.ts`).
 * `ensureContinia`'s act pass and `scripts/r594/cdo-publish.ts` still do.
 */
export async function ensureApp(
  c: Conn,
  bytes: Uint8Array,
  label: string,
): Promise<{ outcome: AppOutcome; version: string }> {
  const local = readAppIdentity(Buffer.from(bytes));
  const before = await residentVersion(c, local.publisher, local.name);
  if (before !== null && compareAppVersions(before, local.version) >= 0) {
    return { outcome: "skipped", version: before };
  }
  await publishBytes(c, `${local.publisher}_${local.name}_${local.version}.app`, bytes);
  const after = await residentVersion(c, local.publisher, local.name);
  if (after !== local.version) {
    throw new Error(
      `${c.server}: ${label} was published as ${local.version} but the server reports ${after ?? "nothing"}`,
    );
  }
  return { outcome: "published", version: after };
}

/** Downloads System plus every Microsoft dependency of `dir` from the server into `cache`. */
export async function downloadSymbols(c: Conn, dir: string, cache: string): Promise<void> {
  const deps = (manifest(dir).dependencies ?? []).filter((d) => d.publisher === "Microsoft");
  for (const name of ["System", ...deps.map((d) => d.name)]) {
    const pkg = await residentPackage(c, "Microsoft", name);
    if (pkg === null) {
      throw new Error(
        `${c.server}: the server holds no Microsoft "${name}" package, which ${basename(dir)} needs to compile (owner question)`,
      );
    }
    writeFileSync(join(cache, `Microsoft_${name}.app`), pkg);
  }
}

export async function alcCompile(
  alc: string,
  project: string,
  cache: string,
  out: string,
  defines: readonly string[] = [],
): Promise<void> {
  const argv = [alc, `/project:${project}`, `/packagecachepath:${cache}`];
  if (defines.length > 0) argv.push(`/define:${defines.join(",")}`);
  argv.push(`/out:${out}`);
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  const errors = `${stdout}${stderr}`.split(/\r?\n/).filter((l) => /: error [A-Z]{2}\d+:/.test(l));
  if (code !== 0 || errors.length > 0 || !existsSync(out)) {
    throw new Error(
      `alc failed on ${basename(project)} (exit ${code}):\n${errors.slice(0, 15).join("\n")}`,
    );
  }
}

/** The compile line: version, raw sha256 and the header's per-compile id (the future packageId). */
export function compiledLine(bytes: Buffer, note = ""): string {
  const id = readAppIdentity(bytes);
  return `  compiled  ${id.name} ${id.version}${note} sha256 ${sha256Of(bytes)} digest ${contentDigest(bytes).slice(0, 12)} header packageId ${headerPackageId(bytes)}`;
}

/**
 * Compiles one `PUBLISH_PLAN` step: the target against the shared, read-only symbol dir
 * (`bc-symbol-cache.ts`, nothing is written into it), then each dependent against the LOCAL target
 * build (F3: a test app's digest does not depend on which target build it was compiled against),
 * in its own private cache. Nothing is published here.
 */
async function compileStep(
  c: Conn,
  alc: string,
  step: PublishStep,
  symbols: string,
  log: string[],
): Promise<AppItem[]> {
  const targetDir = join(REPO, "fixtures", step.target);
  const build = join(STATE_ROOT, c.server, "build", step.target);
  rmSync(build, { recursive: true, force: true });
  mkdirSync(build, { recursive: true });
  const t = manifest(targetDir);
  const out = join(build, "target.app");
  await alcCompile(alc, targetDir, symbols, out, step.defines);
  const target = readFileSync(out);
  log.push(compiledLine(target));
  const items: AppItem[] = [
    { dir: step.target, local: target, role: "target", gateDeploys: step.gateDeploys === true },
  ];
  for (const dependent of step.dependents) {
    const depDir = join(REPO, "fixtures", dependent);
    const cache = join(build, `${dependent}-symbols`);
    mkdirSync(cache, { recursive: true });
    await downloadSymbols(c, depDir, cache);
    writeFileSync(join(cache, `${t.publisher}_${t.name}.app`), target);
    const dOut = join(build, `${dependent}.app`);
    await alcCompile(alc, depDir, cache, dOut);
    const bytes = readFileSync(dOut);
    log.push(compiledLine(bytes));
    items.push({
      dir: dependent,
      local: bytes,
      role: "dependent",
      gateDeploys: false,
      targetDir: step.target,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------------------------
// (e) doctor, and the driver

async function doctor(configPath: string, projectDir: string, testsDir: string): Promise<boolean> {
  const p = Bun.spawn(
    [
      "bun",
      join(REPO, "packages", "runner", "src", "cli.ts"),
      "doctor",
      "--config",
      configPath,
      "--project",
      projectDir,
      "--tests",
      testsDir,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  return (await p.exited) === 0;
}

function bcDevMcpCommand(): string[] {
  const pkg = JSON.parse(readFileSync(join(BC_DEV_MCP, "package.json"), "utf8")) as {
    bin?: Record<string, string>;
    main?: string;
  };
  const entry = pkg.bin?.["bc-dev-mcp"] ?? pkg.main;
  if (entry === undefined) throw new Error(`${BC_DEV_MCP}/package.json: no bin or main`);
  return ["node", join(BC_DEV_MCP, entry)];
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface SetupArgs {
  readonly servers: ServerName[];
  readonly dryRun: boolean;
  /** R598: the lane the coord lease is taken in, when given on the command line. */
  readonly lane?: string;
  readonly withContinia: boolean;
  /** A lease token the CALLER holds and heartbeats; the script then neither takes nor releases one. */
  readonly heldLease?: string;
  /** `--with-continia` only: the Microsoft build P1 accepts instead of the pinned one. */
  readonly acceptBuild?: string;
  /** Only write the configs and launch files: no server call, no lease. */
  readonly writeConfigOnly?: boolean;
  /** R599: decide every app and print it, under the lease; publish nothing, write no config. */
  readonly predict?: boolean;
}

const USAGE =
  "usage: bun scripts/bc-linux-setup.ts --server bc1|bc2|bc3|all [--lane <lane>] [--dry-run | --predict] [--with-continia [--accept-build <version>]] [--held-lease <token>]\n" +
  "       bun scripts/bc-linux-setup.ts --server bc1|bc2|bc3|all --write-config-only";

export function parseArgs(argv: readonly string[]): SetupArgs {
  let server: string | undefined;
  let lane: string | undefined;
  let dryRun = false;
  let withContinia = false;
  let heldLease: string | undefined;
  let acceptBuild: string | undefined;
  let writeConfigOnly = false;
  let predict = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--predict") predict = true;
    else if (a === "--write-config-only") writeConfigOnly = true;
    else if (a === "--with-continia") withContinia = true;
    else if (a === "--server") server = argv[++i];
    else if (a === "--lane") {
      lane = argv[++i];
      if (lane === undefined || lane === "" || lane.startsWith("-"))
        throw new Error(`--lane needs a lane name; ${USAGE}`);
    } else if (a === "--held-lease") {
      heldLease = argv[++i];
      if (heldLease === undefined || heldLease === "") throw new Error(USAGE);
    } else if (a === "--accept-build") {
      acceptBuild = argv[++i];
      if (acceptBuild === undefined || !/^\d+\.\d+\.\d+\.\d+$/.test(acceptBuild))
        throw new Error(USAGE);
    } else throw new Error(`unknown argument ${JSON.stringify(a)}`);
  }
  if (acceptBuild !== undefined && !withContinia) throw new Error(USAGE);
  // The config-only mode reaches no server, so a flag about the server run is a mistake.
  if (
    writeConfigOnly &&
    (dryRun || predict || withContinia || heldLease !== undefined || lane !== undefined)
  )
    throw new Error(`--write-config-only takes only --server\n${USAGE}`);
  if (predict && dryRun) throw new Error(`--predict and --dry-run exclude each other\n${USAGE}`);
  if (
    writeConfigOnly &&
    (server === "bc1" || server === "bc2" || server === "bc3" || server === "all")
  )
    return {
      servers: server === "all" ? ["bc1", "bc2", "bc3"] : [server],
      dryRun,
      withContinia,
      writeConfigOnly,
    };
  const rest = {
    dryRun,
    ...(lane !== undefined ? { lane } : {}),
    withContinia,
    ...(heldLease !== undefined ? { heldLease } : {}),
    ...(acceptBuild !== undefined ? { acceptBuild } : {}),
    ...(predict ? { predict } : {}),
  };
  if (server === "bc1" || server === "bc2" || server === "bc3")
    return { servers: [server], ...rest };
  // One token leases one server.
  if (server === "all" && heldLease === undefined)
    return { servers: ["bc1", "bc2", "bc3"], ...rest };
  throw new Error(USAGE);
}

/** The caller holds the lease (R594): heartbeat it too, but never take or release it. */
export function heldLeaseDeps(token: string): LeaseDeps {
  return {
    take: async () => token,
    recordToken() {},
    // R598 removed the fixed-lane `krakenLease`; a heartbeat names the token, not a lane.
    heartbeat: async (server, t) => {
      await kraken(["heartbeat", server, t]);
    },
    release: async () => {},
  };
}

// ---------------------------------------------------------------------------------------------
// (d2) the Continia stack (R594), for the R546 CDO slice

/** The packagesDir R546 measured with, pinned by sha256 in the R396 pre-commitment, addendum 2. */
export const CONTINIA_PACKAGES_DIR = "/work/lethal-wt/cdo-r396/Test/.alpackages";

/** The 5 Continia apps, dependencies first (System Application, then Core, then its dependents). */
export const CONTINIA_APPS = [
  {
    file: "Continia Software_Continia System Application_28.5.0.336834.app",
    sha256: "5eee39f7f79dd7242e632c9bb3a8872870105618ac997f95fc2990ea6a0af7d4",
  },
  {
    file: "Continia Software_Continia Core_28.5.0.336883.app",
    sha256: "8b09259ac3d5d7fb407c4aa64e4df2311293879b6cffa37abea414eaebafa52d",
  },
  {
    file: "Continia Software_Continia Connector App_28.5.0.336834.app",
    sha256: "82487ec6ad0f2e5b105aecdd4b09060898e69f49a7cc6ada06d88664fd8b3966",
  },
  {
    file: "Continia Software_Continia Delivery Network_28.5.0.336910.app",
    sha256: "922e59ea6d22746714a032fe548d9dd8520757f6f6d5c560f1c1b5622f34cf6f",
  },
  {
    file: "Continia Software_Continia Core Internal Activation App_28.0.0.218906.app",
    sha256: "c57fb082a313d61c8e7b1b6811c9e220dd54af9916e7d9999ad5ea270f60d3b8",
  },
] as const;

/** The Microsoft apps of that packagesDir, which the server must already hold at these versions. */
export const PINNED_MICROSOFT = [
  "Any",
  "Application Test Library",
  "Application",
  "Base Application",
  "Business Foundation",
  "Library Assert",
  "Permissions Mock",
  "System Application Test Library",
  "System Application",
  "Test Runner",
  "Tests-TestLibraries",
] as const;
export const PINNED_MICROSOFT_VERSION = "28.4.53241.53758";

/** A pinned Continia file, read and sha256-checked. */
export function readContinia(app: (typeof CONTINIA_APPS)[number]): Buffer {
  const bytes = readFileSync(join(CONTINIA_PACKAGES_DIR, app.file));
  const sha = sha256Of(bytes);
  if (sha !== app.sha256) throw new Error(`${app.file}: sha256 ${sha}, expected ${app.sha256}`);
  return bytes;
}

/**
 * `a < b`, part by part. Not `compareAppVersions`: that refuses a part above 65535 (LethAL's own
 * minted versions), and Continia's builds carry revisions like 336834.
 */
function versionBelow(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) throw new Error(`not a version: ${a} or ${b}`);
    if (x !== y) return x < y;
  }
  return false;
}

/**
 * Why the server would refuse a Continia app, or [] when it would not: a Microsoft dependency
 * below its declared minimum, a Continia dependency the pinned set does not satisfy, or an
 * `Application`/`Platform` above the server's Application/System. `resident` maps a Microsoft
 * app name (and "System") to the version the server holds.
 */
export function continiaDependencyProblems(
  pkg: Uint8Array,
  resident: ReadonlyMap<string, string | null>,
  pinned: ReadonlyMap<string, string>,
): string[] {
  const me = readAppIdentity(Buffer.from(pkg)).name;
  const inp = appInputsOfPackage(pkg);
  const out: string[] = [];
  const atLeast = (what: string, have: string | null | undefined, min: string): void => {
    if (have === null || have === undefined) out.push(`${me}: needs ${what} >= ${min}, absent`);
    else if (versionBelow(have, min)) out.push(`${me}: needs ${what} >= ${min}, has ${have}`);
  };
  for (const d of inp.dependencies) {
    if (d.publisher === "Microsoft")
      atLeast(`Microsoft ${d.name}`, resident.get(d.name), d.version);
    else atLeast(`${d.publisher} ${d.name}`, pinned.get(d.name), d.version);
  }
  if (inp.application !== undefined)
    atLeast("Application", resident.get("Application"), inp.application);
  if (inp.platform !== undefined)
    atLeast("System (platform)", resident.get("System"), inp.platform);
  return out;
}

/**
 * P1 then the install. Every Microsoft app must be resident at exactly the pinned version (or at
 * `acceptBuild`, R594's ruling for bc3: a NEW oracle, recorded, never silently), or nothing is
 * published: another build makes R546's frozen oracle incomparable. Then every Continia app's
 * declared dependencies are checked against the server, and only if all would be accepted is each
 * file published, skipped when the server holds exactly that version, and refused when it holds a
 * different one (a third-party app is never replaced here).
 */
/** What the Continia step does on the server (R599 F5: a fake counts it in tests). */
export interface ContiniaOps {
  /** The lenient read `residentVersion` always used (M6: any failure reads as absent). */
  residentVersion(publisher: string, name: string): Promise<string | null>;
  publish(fileName: string, bytes: Buffer): Promise<void>;
}

export function realContiniaOps(c: Conn): ContiniaOps {
  return {
    residentVersion: (publisher, name) => residentVersion(c, publisher, name),
    publish: (fileName, bytes) => publishBytes(c, fileName, bytes),
  };
}

/**
 * The DECIDE half of the Continia step (R599 F5): every read and check, no publish. Returns the
 * files to publish, or `ok: false` when anything stops it; its rules are unchanged (an equal
 * version skips, a different one refuses).
 */
export async function decideContinia(
  ops: ContiniaOps,
  files: readonly { readonly bytes: Buffer }[],
  summary: string[],
  acceptBuild: string | undefined,
): Promise<{ ok: boolean; toPublish: Buffer[] }> {
  const want = acceptBuild ?? PINNED_MICROSOFT_VERSION;
  const resident = new Map<string, string | null>();
  let ok = true;
  for (const name of PINNED_MICROSOFT) {
    const v = await ops.residentVersion("Microsoft", name);
    resident.set(name, v);
    const same = v === want;
    summary.push(`  P1        Microsoft ${name}: ${v ?? "absent"}${same ? "" : " (DIFFERS)"}`);
    ok &&= same;
  }
  resident.set("System", await ops.residentVersion("Microsoft", "System"));
  summary.push(`  P1        Microsoft System: ${resident.get("System") ?? "absent"}`);
  if (!ok) {
    summary.push(`  STOPPED   the Microsoft apps are not all ${want}: no Continia app published`);
    return { ok: false, toPublish: [] };
  }
  const pinned = new Map(
    files.map((f) => [readAppIdentity(f.bytes).name, readAppIdentity(f.bytes).version]),
  );
  const problems = files.flatMap((f) => continiaDependencyProblems(f.bytes, resident, pinned));
  if (problems.length > 0) {
    for (const p of problems) summary.push(`  DEPENDS   ${p}`);
    summary.push("  STOPPED   a Continia app would be refused: none published");
    return { ok: false, toPublish: [] };
  }
  summary.push("  P1        every Continia app's declared dependencies are satisfied");
  const toPublish: Buffer[] = [];
  for (const { bytes } of files) {
    const local = readAppIdentity(bytes);
    const before = await ops.residentVersion(local.publisher, local.name);
    if (before === local.version) {
      summary.push(`  skipped   ${local.name} ${before} (resident, equal)`);
      continue;
    }
    if (before !== null) {
      summary.push(
        `  refuse    ${local.name} is resident at ${before}, not the pinned ${local.version}; not replacing it`,
      );
      ok = false;
      continue;
    }
    summary.push(`  publish   ${local.name} ${local.version} (Dev scope, sha256 ${sha256Of(bytes)})`);
    toPublish.push(bytes);
  }
  return { ok, toPublish };
}

/** The ACT half: publishes each file, then the server must report exactly its version. */
export async function actContinia(
  ops: ContiniaOps,
  toPublish: readonly Buffer[],
  summary: string[],
): Promise<void> {
  for (const bytes of toPublish) {
    const local = readAppIdentity(bytes);
    await ops.publish(`${local.publisher}_${local.name}_${local.version}.app`, bytes);
    const after = await ops.residentVersion(local.publisher, local.name);
    if (after !== local.version)
      throw new Error(
        `${local.name} was published as ${local.version} but the server reports ${after ?? "nothing"}`,
      );
    summary.push(`  published ${local.name} ${after} (Dev scope, sha256 ${sha256Of(bytes)})`);
  }
}

/**
 * Everything the driver reaches outside this process, so a test can count it. Every server call
 * in this script goes through a `Conn`, and the only way to get one is `connect`.
 */
export interface RunDeps {
  readonly readSecret: () => BcLogin;
  readonly connect: (server: ServerName, login: BcLogin) => Conn;
  readonly lease: (lane: string, heldLease: string | undefined) => LeaseDeps;
  readonly isIgnored: (path: string) => boolean;
  /** The repo root the `fixtures/<dir>/` config paths are under. */
  readonly repo: string;
  readonly cacheRoot: string;
  readonly mcpCommand: () => string[];
  readonly env: Record<string, string | undefined>;
  /** Every config and launch write goes through here (a test counts them). */
  readonly writeConfig: (path: string, config: object) => void;
  /** One Microsoft package for the shared symbol cache. */
  readonly downloadSymbol: (c: Conn, name: string) => Promise<Buffer | null>;
  readonly serverOps: (c: Conn) => ServerOps;
  readonly continiaOps: (c: Conn) => ContiniaOps;
  readonly continiaFiles: () => { readonly bytes: Buffer }[];
  /** The pinned LethAL Control build, sha256-checked. */
  readonly controlBytes: () => Buffer;
  /** Compiles one `PUBLISH_PLAN` step; publishes nothing. */
  readonly compile: (c: Conn, step: PublishStep, symbols: string, log: string[]) => Promise<AppItem[]>;
  readonly fixtures: () => ReadonlyMap<string, AppManifest>;
  readonly doctor: (configPath: string, projectDir: string, testsDir: string) => Promise<boolean>;
}

function pinnedControl(): Buffer {
  const control = readFileSync(CONTROL_APP);
  const sha = sha256Of(control);
  if (sha !== CONTROL_SHA256) {
    throw new Error(
      `${CONTROL_APP}: sha256 ${sha}, expected ${CONTROL_SHA256}; refusing to publish it`,
    );
  }
  return control;
}

async function realCompile(
  c: Conn,
  step: PublishStep,
  symbols: string,
  log: string[],
): Promise<AppItem[]> {
  const tools = await defaultAlToolPaths();
  if (tools === undefined) throw new Error("no alc found under the AL Language extension");
  return compileStep(c, tools.alcPath, step, symbols, log);
}

export const REAL_DEPS: RunDeps = {
  readSecret: () => readSecretFile(),
  connect: (server, login) => ({
    server,
    authorization: `Basic ${Buffer.from(`${login.user}:${login.password}`).toString("base64")}`,
  }),
  // R594's held lease, else R598's lease in the caller's lane.
  lease: (lane, held) => (held !== undefined ? heldLeaseDeps(held) : krakenLeaseFor(lane)),
  isIgnored: gitIgnores,
  repo: REPO,
  cacheRoot: SYMBOL_CACHE_ROOT,
  mcpCommand: bcDevMcpCommand,
  env: process.env,
  writeConfig: (path, config) => writeConfig(path, config, gitIgnores),
  downloadSymbol: (c, name) => residentPackage(c, "Microsoft", name),
  serverOps: realOps,
  continiaOps: realContiniaOps,
  continiaFiles: () => CONTINIA_APPS.map((app) => ({ bytes: readContinia(app) })),
  controlBytes: pinnedControl,
  compile: realCompile,
  fixtures: fixtureManifests,
  doctor,
};

function configTargets(repo: string, server: ServerName) {
  return GATE_FIXTURES.map((f) => ({
    fixture: f,
    path: join(repo, "fixtures", f.configDir, configFileName(server)),
    launch: join(repo, "fixtures", f.configDir, ".vscode", launchFileName(server)),
  }));
}

/** (b) Every path is checked before any is written, so a refusal leaves nothing half-written. */
function checkIgnored(deps: RunDeps, server: ServerName): void {
  for (const { path, launch } of configTargets(deps.repo, server)) {
    for (const p of [path, launch]) {
      if (!deps.isIgnored(p)) throw new NotIgnoredError(`${p} is not ignored by .gitignore`);
    }
  }
}

function writeServerConfigs(
  deps: RunDeps,
  server: ServerName,
  login: BcLogin,
  packageCachePath: string,
  summary: string[],
): void {
  const paths: ConfigPaths = {
    mcpCommand: deps.mcpCommand(),
    controlSymbolPath: CONTROL_APP,
    packageCachePath,
  };
  for (const { fixture, path, launch } of configTargets(deps.repo, server)) {
    deps.writeConfig(path, buildConfig(server, login, paths, fixture.configDir));
    mkdirSync(dirname(launch), { recursive: true });
    deps.writeConfig(launch, buildLaunch(server));
    summary.push(`  wrote     ${path}`);
    summary.push(`  wrote     ${launch}`);
  }
}

/**
 * `--write-config-only`: the configs and launch files for each server, pointing at the shared
 * symbol cache, with NO server call and NO lease. Whether the cache is filled is read from its own
 * marker; an empty or unverified cache is named, and the run then fails: never "gate-ready".
 */
export function writeConfigOnly(args: SetupArgs, deps: RunDeps, summary: string[]): boolean {
  const login = deps.readSecret();
  summary.push(`login: ${describeLogin(login)}`);
  for (const server of args.servers) checkIgnored(deps, server);
  let ready = true;
  for (const server of args.servers) {
    summary.push(`${server} (config only: no server call, no lease)`);
    const found = lookupSymbolCache(
      deps.cacheRoot,
      server,
      symbolNames(join(deps.repo, "fixtures")),
    );
    for (const u of found.unverified) summary.push(`  unverified ${u}`);
    const cache = found.chosen?.dir ?? join(deps.cacheRoot, server, UNFILLED);
    writeServerConfigs(deps, server, login, cache, summary);
    if (found.chosen === undefined) {
      ready = false;
      summary.push(`  symbol cache empty for ${server}: run setup --server ${server} once`);
      summary.push(`  NOT gate-ready: ${server}'s configs name ${cache}, which holds no symbols`);
    } else {
      const m = found.chosen.marker;
      summary.push(
        `  symbol cache for ${server}: ${found.chosen.dir} (build ${m.build}, ${m.fileCount} files: ${m.packages.map((p) => p.name).join(", ")}; verified; written ${m.writtenAt}); server build not checked (config-only)`,
      );
      if (found.verified.length > 1)
        summary.push(
          `  note: ${found.verified.length} verified builds for ${server}; the newest by writtenAt is used`,
        );
    }
  }
  return ready;
}

async function setupServer(
  server: ServerName,
  login: BcLogin,
  args: SetupArgs,
  summary: string[],
  lane: string,
  deps: RunDeps,
): Promise<boolean> {
  const { dryRun } = args;
  const configs = configTargets(deps.repo, server);
  checkIgnored(deps, server);
  summary.push(
    `${server} (OData ${SERVERS[server].odata}, dev ${SERVERS[server].dev}, API ${SERVERS[server].api})`,
  );
  if (dryRun) {
    for (const { path, launch } of configs) summary.push(`  would write ${path}, ${launch}`);
    summary.push(
      `  would ${args.heldLease !== undefined ? "use the held lease on" : "lease"} ${server}${args.heldLease !== undefined ? "" : ` in lane ${lane}`}, fill or reuse ${join(deps.cacheRoot, server, "<build>-<hash8>")}, publish LethAL Control,${args.withContinia ? " check P1 and publish the 5 Continia apps," : ""} then ${PUBLISH_PLAN.map((s) => s.target).join(", ")} with their dependents, run doctor`,
    );
    return true;
  }

  const control = deps.controlBytes();
  const conn = deps.connect(server, login);
  const log = (s: string) => summary.push(s);
  return await withLease(server, deps.lease(lane, args.heldLease), async () => {
    // The shared Microsoft symbol cache first, so the configs can name it. `--predict` fills it
    // too (ruling (b)): a read from the server into the write-once cache, not a change to either.
    const cache = await fillSymbolCache({
      root: deps.cacheRoot,
      server,
      names: symbolNames(join(deps.repo, "fixtures")),
      download: (name) => deps.downloadSymbol(conn, name),
    });
    summary.push(
      `  symbols   ${cache.dir} (${cache.outcome === "filled" ? "downloaded and sealed" : "already complete, verified"}; ${cache.downloads} download${cache.downloads === 1 ? "" : "s"})`,
    );
    if (args.predict !== true) writeServerConfigs(deps, server, login, cache.dir, summary);

    // DECIDE every app (M4): compile all, read what the server holds, print each decision.
    const items: AppItem[] = [
      { dir: "lethal-control", local: control, role: "control", gateDeploys: false },
    ];
    let compiled = true;
    for (const step of PUBLISH_PLAN) {
      try {
        items.push(...(await deps.compile(conn, step, cache.dir, summary)));
      } catch (err) {
        compiled = false;
        summary.push(`  FAILED    ${step.target}: ${errText(err)}`);
      }
    }
    const cops = deps.continiaOps(conn);
    const continia = args.withContinia
      ? await decideContinia(cops, deps.continiaFiles(), summary, args.acceptBuild)
      : { ok: true, toPublish: [] };
    const ops = deps.serverOps(conn);
    const decided: Decided[] = await decideAll(items, ops, "setup", deps.fixtures(), log);
    const refused = refusals(decided);
    if (!compiled || refused.length > 0 || !continia.ok) {
      summary.push(
        `  STOPPED   ${refused.length} app(s) refused${compiled ? "" : ", a compile failed"}${continia.ok ? "" : ", the Continia step stopped"}: NOTHING was published`,
      );
      return false;
    }
    if (args.predict === true) {
      summary.push("  predicted: nothing published, no config or launch file written, no doctor");
      return true;
    }
    // ACT: control, then Continia (before the fixtures, as before), then each step's apps.
    const [controlDecided, ...fixtureDecided] = decided;
    await actAll(controlDecided === undefined ? [] : [controlDecided], ops, log);
    await actContinia(cops, continia.toPublish, summary);
    await actAll(fixtureDecided, ops, log);
    // (e)
    let ok = true;
    for (const { fixture, path } of configs) {
      const pass = await deps.doctor(
        path,
        join(REPO, "fixtures", fixture.target),
        join(REPO, "fixtures", fixture.tests),
      );
      summary.push(`  doctor    ${fixture.configDir}: ${pass ? "ok" : "FAILED"}`);
      ok &&= pass;
    }
    return ok;
  });
}

export async function run(
  argv: readonly string[],
  deps: RunDeps,
  print: (s: string) => void = console.log,
): Promise<number> {
  const args = parseArgs(argv);
  if (args.writeConfigOnly === true) {
    const summary: string[] = [];
    let ok: boolean;
    try {
      ok = writeConfigOnly(args, deps, summary);
    } catch (err) {
      ok = false;
      summary.push(`  FAILED    ${errText(err)}`);
    }
    print(`\nbc-linux-setup (write config only):\n${summary.join("\n")}`);
    print(
      ok
        ? "\nok: configs written, symbol cache verified; server build not checked (config-only)"
        : "\nFAILED",
    );
    return ok ? 0 : 1;
  }
  const { servers, dryRun, lane: cliLane } = args;
  // R598: decided before the secret is read or anything is written, so a refusal changes nothing.
  const lane = resolveLane(cliLane, deps.env);
  const login = deps.readSecret();
  const summary = [`login: ${describeLogin(login)}`, `lane: ${lane}`];
  let ok = true;
  for (const server of servers) {
    try {
      ok = (await setupServer(server, login, args, summary, lane, deps)) && ok;
    } catch (err) {
      ok = false;
      summary.push(`  FAILED    ${server}: ${errText(err)}`);
    }
  }
  print(`\nbc-linux-setup${dryRun ? " (dry run)" : ""}:\n${summary.join("\n")}`);
  print(ok ? "\nok" : "\nFAILED");
  return ok ? 0 : 1;
}

if (import.meta.main) process.exit(await run(process.argv.slice(2), REAL_DEPS));
