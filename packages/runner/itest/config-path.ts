/**
 * Which fixture config a live itest runs against.
 *
 * Every env-gated itest read `lethal.config.local.json` from its fixture directory by a hardcoded
 * name. That is right for the human workflow, where one developer has one set of containers. It is
 * not enough for the autonomous orchestrator, which runs the same gates against DEDICATED
 * containers so its runs can never collide with the owner's own session. Two configs have to be
 * selectable without editing the gate files, because editing a gate to point it somewhere else is
 * exactly the kind of change that gets left behind: a crashed run would leave the owner's next
 * `itest:tables` publishing to the agent's container.
 *
 * So the name comes from `LETHAL_ITEST_CONFIG`, defaulting to the existing one. Nothing changes for
 * a human who does not set it.
 *
 * The value is a BASENAME, never a path. It is joined onto the fixture directory the caller
 * chose, and a value carrying a separator, a drive letter or `..` is refused rather than resolved.
 * A live itest publishes to whatever server its config names, so "which file is this" decides
 * which machine gets written to; letting an environment variable redirect that outside the fixture
 * would make an env var enough to aim a publish anywhere.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { configuredOdataBaseUrl } from "../src/cli";
import { ServerOutOfUseError, markedServerFor, outOfUseDir, outOfUseRefusal } from "./out-of-use";

/** The `bcdev` fields the target line reads; nothing else of the config reaches it. */
interface TargetFields {
  readonly server: string;
  readonly serverInstance: string;
  readonly port?: number;
  readonly baseUrl?: string;
  readonly apiBaseUrl?: string;
}

/**
 * R589: the line a BC itest prints first, naming what it will measure: the config file, the server
 * (host and dev port), the OData root and the API root. Built from those fields alone, so no login
 * can reach it. With parallel servers, a log that cannot say which one it ran against proves
 * nothing about a server.
 */
export function itestTargetLine(configName: string, bcdev: TargetFields): string {
  const u = new URL(bcdev.server);
  const devPort = bcdev.port ?? (u.port !== "" ? Number(u.port) : undefined);
  const odata = withoutUserinfo(configuredOdataBaseUrl(bcdev));
  const api = bcdev.apiBaseUrl !== undefined ? withoutUserinfo(bcdev.apiBaseUrl) : odata;
  return `[itest target] config=${configName} server=${u.hostname}:${devPort ?? `${DEFAULT_DEV_PORT} (default)`} odata=${odata} api=${api}`;
}

/** BC's dev-endpoint port when nothing states one (bc-dev-mcp's and altool's default). */
const DEFAULT_DEV_PORT = 7049;

/** A URL with any `user:pass@` removed, so a login written into a URL cannot reach the line. */
function withoutUserinfo(url: string): string {
  try {
    const u = new URL(url);
    if (u.username === "" && u.password === "") return url;
    u.username = "";
    u.password = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return "(unparseable URL)";
  }
}

/**
 * Prints `itestTargetLine` for a config file, reading only its `bcdev` target fields. R669: it
 * first throws `ServerOutOfUseError` when that server (bc1-bc3 only) has an out-of-use marker,
 * BEFORE the line is printed, so a script that greps for the line fails closed even if it ignores
 * the exit status. Every BC itest calls this right after it picks its config, so the refusal comes
 * before any lease or server call. `outOfUse` is a test seam; a unit test passes its own temp dir
 * and never reads `/coord`.
 */
export function printItestTarget(
  configPath: string,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
  outOfUse: { readonly dir: string; readonly env: NodeJS.ProcessEnv } = {
    dir: outOfUseDir(process.env),
    env: process.env,
  },
): void {
  let bcdev: Partial<TargetFields> | undefined;
  try {
    bcdev = (JSON.parse(read(configPath)) as { bcdev?: Partial<TargetFields> }).bcdev;
  } catch {
    console.log(`[itest target] config=${basename(configPath)} is missing or unreadable`);
    return;
  }
  const { server, serverInstance } = bcdev ?? {};
  if (typeof server !== "string" || typeof serverInstance !== "string") {
    console.log(`[itest target] config=${basename(configPath)} names no bcdev server`);
    return;
  }
  const { port, baseUrl, apiBaseUrl } = bcdev ?? {};
  const u = new URL(server);
  const devPort = port ?? (u.port !== "" ? Number(u.port) : DEFAULT_DEV_PORT);
  const name = markedServerFor(u.hostname, devPort);
  // Not bc1-bc3: such a server has no marker (Cronus28, envtool), so it is not checked.
  if (name !== undefined) {
    const refusal = outOfUseRefusal(name, { ...outOfUse, override: "owner" });
    if (refusal !== undefined) throw new ServerOutOfUseError(refusal);
  }
  console.log(
    itestTargetLine(basename(configPath), {
      server,
      serverInstance,
      ...(port !== undefined ? { port } : {}),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(apiBaseUrl !== undefined ? { apiBaseUrl } : {}),
    }),
  );
}

/** Thrown for a malformed `LETHAL_ITEST_CONFIG`. Never falls back to the default silently. */
export class ItestConfigNameError extends Error {}

/** The default every itest used before this existed, and still uses when nothing is set. */
export const DEFAULT_ITEST_CONFIG = "lethal.config.local.json";

/**
 * `lethal.config.<name>.json`, where `<name>` is alphanumeric with dashes.
 *
 * Deliberately narrower than "no separators". The files this selects between are all siblings with
 * one naming convention, so a name outside it is a mistake worth hearing about rather than a
 * filename worth honouring.
 */
const VALID = /^lethal\.config\.[A-Za-z0-9-]+\.json$/;

export function itestConfigName(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.LETHAL_ITEST_CONFIG;
  if (raw === undefined || raw === "") return DEFAULT_ITEST_CONFIG;
  if (!VALID.test(raw)) {
    throw new ItestConfigNameError(
      `LETHAL_ITEST_CONFIG=${JSON.stringify(raw)} is not a bare fixture config filename. Expected something like lethal.config.agent.json: a sibling of the fixture's own config, with no path separators. A live itest publishes to whatever server its config names, so this value decides which machine gets written to.`,
    );
  }
  return raw;
}

/** The config path for a fixture directory, honouring `LETHAL_ITEST_CONFIG`. */
export function itestConfigPath(projectDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(projectDir, itestConfigName(env));
}

/** The launch file every itest read before R589, and still reads when nothing is selected. */
export const DEFAULT_ITEST_LAUNCH = "launch.local.json";

/**
 * R589: the `.vscode` launch file that pairs with the selected config: `lethal.config.<name>.json`
 * pairs with `launch.<name>.json`, so the default `lethal.config.local.json` keeps
 * `launch.local.json` and `lethal.config.bc1.json` reads `launch.bc1.json`.
 */
export function itestLaunchName(env: NodeJS.ProcessEnv = process.env): string {
  const name = /^lethal\.config\.([A-Za-z0-9-]+)\.json$/.exec(itestConfigName(env))?.[1];
  if (name === undefined)
    throw new ItestConfigNameError("unreachable: itestConfigName validated it");
  return `launch.${name}.json`;
}

/** R589: a selected config whose paired launch file is missing, or names another server. */
export class ItestLaunchPairError extends Error {}

/**
 * The launch path for a fixture directory. STRICT (orchestrator ruling, 2026-10-21): with
 * `LETHAL_ITEST_CONFIG` selecting a config, its paired `launch.<name>.json` must exist, or the
 * itest refuses; there is no fallback to `launch.local.json`, which may describe another server.
 * With nothing selected, `launch.local.json` is returned as before (its readers decide whether a
 * missing one is an error).
 */
export function itestLaunchPath(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string {
  const named = join(projectDir, ".vscode", itestLaunchName(env));
  const local = join(projectDir, ".vscode", DEFAULT_ITEST_LAUNCH);
  if (named === local || exists(named)) return named;
  throw new ItestLaunchPairError(
    `LETHAL_ITEST_CONFIG=${itestConfigName(env)} pairs with ${named}, which does not exist (the default pair is ${local}). Fix: if ${local} targets the same server, copy it to ${named}; for a BC on Linux server, run bun scripts/bc-linux-setup.ts --server <name>.`,
  );
}

/** Host (lowercase) and port of a server URL; `port` only when the URL states one. */
function hostAndPort(url: string, what: string): { host: string; port?: number } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ItestLaunchPairError(`${what}: server ${JSON.stringify(url)} is not a URL`);
  }
  return { host: u.hostname.toLowerCase(), ...(u.port !== "" ? { port: Number(u.port) } : {}) };
}

/**
 * R589: refuses when the launch file and the selected lethal config name different servers. It
 * compares the host and the EFFECTIVE dev port (`port`, else a port written into `server`, else
 * BC's default 7049), so a port stated on one side only is compared with the default rather than
 * waved through. A launch file that names no server is not compared. Reads only `server` and
 * `port` from each side, so nothing else in either file reaches a message.
 */
export function assertLaunchMatchesConfig(
  launch: object,
  bcdev: { readonly server: string; readonly port?: number },
  launchPath: string,
): void {
  const l = launch as { server?: unknown; port?: unknown };
  if (typeof l.server !== "string" || l.server === "") return;
  const fromLaunch = hostAndPort(l.server, launchPath);
  const fromConfig = hostAndPort(bcdev.server, "the lethal config");
  const launchPort = (typeof l.port === "number" ? l.port : fromLaunch.port) ?? DEFAULT_DEV_PORT;
  const configPort = bcdev.port ?? fromConfig.port ?? DEFAULT_DEV_PORT;
  if (fromLaunch.host !== fromConfig.host || launchPort !== configPort) {
    throw new ItestLaunchPairError(
      `${launchPath} names ${fromLaunch.host}:${launchPort}, but the selected lethal config names ${fromConfig.host}:${configPort} (an unstated dev port is BC's default ${DEFAULT_DEV_PORT}). The pair must describe one server.`,
    );
  }
}
