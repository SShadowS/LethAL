import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ActivationConfig } from "./activation";
import type { BcDevConfigSection } from "./cli";
import { EnvToolError, renderCommand } from "./env-tool";
import type { EnvToolClient, EnvToolConfigSection, EnvToolReadyBlock } from "./env-tool";

const EXPIRY_MARGIN_MS = 60 * 60_000;

export interface EnvToolSession {
  readonly bcdev: BcDevConfigSection;
  readonly createdEnvId?: string;
  teardown(opts: { keepEnv: boolean; quarantined: boolean }): Promise<void>;
}

/**
 * Runs the provisioning lifecycle ONCE per process and returns a fully resolved bcdev section.
 * `cli.ts` calls `validateBcDevConfig` at three separate seams; a naive port would resolve — and in
 * create-mode PROVISION AN ENVIRONMENT — three times. This runs before all of them and its output
 * is substituted into the config they read.
 */
export async function startEnvToolSession(args: {
  cfg: EnvToolConfigSection;
  bcdevRaw: Partial<BcDevConfigSection>;
  projectDir: string;
  testDir: string;
  runId: string;
  client: EnvToolClient;
  makePublisher: (bcdev: BcDevConfigSection) => { publishFile: (p: string) => Promise<void> };
  verifyHarness: (cfg: ActivationConfig) => Promise<void>;
  allowExpiring?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>; // injected so readiness polling is testable without waiting
  stateDir?: string;
}): Promise<EnvToolSession> {
  const { cfg, client } = args;
  const now = args.now ?? Date.now;
  const sleep = args.sleep ?? ((ms: number) => Bun.sleep(ms));
  const stateDir = args.stateDir ?? join(homedir(), ".lethal", "env-state");
  const supplied: Record<string, string> = {
    projectDir: args.projectDir,
    testDir: args.testDir,
    runId: args.runId,
    packageCache: args.bcdevRaw.packageCachePath ?? join(args.projectDir, ".alpackages"),
  };

  // 1. envId — taken, or created.
  let createdEnvId: string | undefined;
  let envId = cfg.envId;
  if (envId === undefined || envId === "") {
    const createBlock = cfg.createEnv;
    if (createBlock === undefined) throw new EnvToolError("create-mode without envTool.createEnv");
    const out = await client.run(createBlock, "createEnv", supplied);
    const created = out.envId;
    if (created === undefined) throw new EnvToolError("createEnv produced no envId");
    envId = created;
    createdEnvId = created;
    await recordCreatedEnv(stateDir, args.runId, created, cfg, now);

    // 1b. Start, then WAIT — but only when this config actually declares both steps. A config
    // that has been through create-mode validation (Task 3's validateEnvToolConfig) always has
    // both; a config built directly for a narrower purpose may legitimately have neither (nothing
    // to start/wait for — e.g. the tool's `env create` already returns a running environment).
    // Exactly one of the two present is not a coherent state either way, so THAT combination fails
    // loudly rather than silently skipping half the contract.
    const startBlock = cfg.startEnv;
    const readyBlock = cfg.readyWhen;
    if (startBlock !== undefined || readyBlock !== undefined) {
      if (startBlock === undefined || readyBlock === undefined) {
        throw new EnvToolError(
          "envTool.startEnv and envTool.readyWhen must both be configured, or neither",
        );
      }
      // Measured 2026-07-26: create returns a Draft environment, `env start` returns "start
      // requested" in ~2s, and the BC endpoint answers ~391s later. Publishing before that fails
      // against a dead endpoint.
      await client.run(startBlock, "startEnv", { ...supplied, envId });
      await waitUntilReady(client, readyBlock, { ...supplied, envId }, now, sleep);
    }
  }
  supplied.envId = envId;

  // 2. resolve.
  const resolved: Record<string, string> = {};
  for (const [i, block] of (cfg.resolve ?? []).entries()) {
    Object.assign(resolved, await client.run(block, `resolve[${i}]`, supplied));
  }

  // 3. expiry — refuse rather than warn: expiring mid-run lands as in-flight-unknown and
  //    durably quarantines the tier, which needs an operator clear-quarantine to undo.
  const expiresUtc = resolved.expiresUtc;
  if (expiresUtc !== undefined && args.allowExpiring !== true) {
    const at = Date.parse(expiresUtc);
    if (!Number.isNaN(at) && at - now() < EXPIRY_MARGIN_MS) {
      throw new EnvToolError(
        `environment ${envId} expires at ${expiresUtc}, within the hour — refusing to start. A run that outlives its environment quarantines the tier. Re-run with --allow-expiring-env to override.`,
      );
    }
  }

  // 4. derive server/serverInstance/port from baseUrl unless read explicitly. A path-routed HTTPS
  //    portal (Continia) has no listener at bc-dev-mcp's OnPrem fallback port (7049), so the port
  //    bc-dev-mcp actually needs must be derived here rather than left to that fallback.
  const baseUrl = resolved.baseUrl;
  if (baseUrl === undefined) throw new EnvToolError("resolve produced no baseUrl");
  const { server, serverInstance } = splitBaseUrl(
    baseUrl,
    resolved.server,
    resolved.serverInstance,
  );
  const port = deriveMcpPort(baseUrl);
  const username = resolved.username;
  const password = resolved.password;
  if (username === undefined || password === undefined) {
    throw new EnvToolError("resolve produced no username/password");
  }
  const packageCachePath = args.bcdevRaw.packageCachePath ?? join(args.projectDir, ".alpackages");
  const bcdev: BcDevConfigSection = {
    ...(args.bcdevRaw as BcDevConfigSection),
    baseUrl,
    server,
    serverInstance,
    port,
    username,
    password,
    packageCachePath,
    env: { ...(args.bcdevRaw.env ?? {}), BC_DEV_USER: username, BC_DEV_PASSWORD: password },
  };

  // 5. symbols.
  if (cfg.downloadSymbols !== undefined) {
    await client.run(cfg.downloadSymbols, "downloadSymbols", {
      ...supplied,
      packageCache: packageCachePath,
    });
  }

  // 6. prepublish + control app. Verify FIRST: the machine-global lease lives in the control
  //    app's own tables, and republishing runs its install/upgrade codeunits, which would disturb
  //    a concurrent session's lease and serverGeneration on a shared long-lived environment.
  const publisher = args.makePublisher(bcdev);
  for (const app of cfg.publishApps ?? []) await publisher.publishFile(app);
  const odataCfg: ActivationConfig = {
    baseUrl,
    company: bcdev.company,
    username,
    password,
    ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
  };
  let harnessOk = true;
  try {
    await args.verifyHarness(odataCfg);
  } catch {
    harnessOk = false;
  }
  if (!harnessOk) {
    await publisher.publishFile(bcdev.controlSymbolPath);
    await args.verifyHarness(odataCfg); // throws if it still does not answer
  }

  return {
    bcdev,
    ...(createdEnvId !== undefined ? { createdEnvId } : {}),
    async teardown(opts) {
      if (createdEnvId === undefined) return;
      const block = cfg.deleteEnv;
      if (opts.keepEnv || opts.quarantined) {
        const hint =
          block === undefined
            ? ""
            : ` Delete it with: ${renderCommand(block, cfg, { ...supplied, envId: createdEnvId }).join(" ")}`;
        console.warn(
          `[lethal] keeping environment ${createdEnvId} (${
            opts.quarantined ? "session quarantined" : "--keep-env"
          }).${hint}`,
        );
        return;
      }
      if (block === undefined) return;
      try {
        await client.run(block, "deleteEnv", { ...supplied, envId: createdEnvId });
      } catch (err) {
        // Cleanup failure must never replace the session's verdicts or exit code.
        console.warn(
          `[lethal] could not delete environment ${createdEnvId}: ` +
            `${err instanceof Error ? err.message : String(err)}\n` +
            `[lethal] delete it manually: ${renderCommand(block, cfg, { ...supplied, envId: createdEnvId }).join(" ")}`,
        );
      }
    },
  };
}

/**
 * Polls `readyWhen` until its status read equals `readyWhen.equals`, or the budget runs out.
 * Announces each status transition: a silent six-minute wait is indistinguishable from a hang.
 */
async function waitUntilReady(
  client: EnvToolClient,
  block: EnvToolReadyBlock,
  supplied: Readonly<Record<string, string>>,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const budgetMs = (block.timeoutSeconds ?? 1800) * 1000;
  const pollMs = (block.pollSeconds ?? 20) * 1000;
  const began = now();
  let lastStatus = "";
  for (;;) {
    const out = await client.run(block, "readyWhen", supplied);
    const status = out.status;
    if (status !== lastStatus) {
      console.log(`[lethal] environment ${supplied.envId ?? "?"} status: ${status}`);
      lastStatus = status ?? "";
    }
    if (status === block.equals) return;
    if (now() - began >= budgetMs) {
      throw new EnvToolError(
        `environment ${supplied.envId ?? "?"} did not reach status ${JSON.stringify(block.equals)} ` +
          `within ${block.timeoutSeconds ?? 1800}s (last status: ${JSON.stringify(status ?? "")})`,
      );
    }
    await sleep(pollMs);
  }
}

function splitBaseUrl(
  baseUrl: string,
  serverOverride: string | undefined,
  instanceOverride: string | undefined,
): { server: string; serverInstance: string } {
  if (serverOverride !== undefined && instanceOverride !== undefined) {
    return { server: serverOverride, serverInstance: instanceOverride };
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new EnvToolError(`resolved baseUrl ${JSON.stringify(baseUrl)} is not a URL`);
  }
  const segment = url.pathname.split("/").filter((s) => s.length > 0)[0];
  if (segment === undefined) {
    throw new EnvToolError(
      `resolved baseUrl ${JSON.stringify(baseUrl)} has no path segment to use as serverInstance — declare a reads entry for serverInstance instead; LethAL will not guess one`,
    );
  }
  return {
    server: serverOverride ?? url.origin,
    serverInstance: instanceOverride ?? segment,
  };
}

/**
 * Derives the port bc-dev-mcp's `ConnectionConfig.port` needs from a resolved `baseUrl`. The
 * WHATWG URL API normalizes away a default port — `new URL("https://host:443").port === ""` — so
 * an explicit port survives only when the URL text actually carries one; everything else falls
 * back to the protocol default. Without this, bc-dev-mcp's OWN fallback (`DEFAULT_DEV_PORT = 7049`,
 * `bc-dev-mcp/src/core/urls.ts:12`) would fire instead, which is unreachable on a path-routed
 * HTTPS portal.
 */
function deriveMcpPort(baseUrl: string): number {
  const url = new URL(baseUrl);
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/**
 * Records a created environment where a LATER process can find it. Session scratch is a mkdtemp
 * directory nobody can locate after a crash, and a crashed process cannot print. A residual window
 * remains: a crash DURING createEnv leaves an environment whose id LethAL never learned — the
 * tool's own `env list` is the recovery for that one.
 */
async function recordCreatedEnv(
  stateDir: string,
  runId: string,
  envId: string,
  cfg: EnvToolConfigSection,
  now: () => number,
): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const deleteArgv =
    cfg.deleteEnv === undefined ? [] : renderCommand(cfg.deleteEnv, cfg, { envId });
  await writeFile(
    join(stateDir, `${runId}.json`),
    `${JSON.stringify({ runId, envId, deleteArgv, startedAtMs: now() }, null, 2)}\n`,
    "utf8",
  );
}
