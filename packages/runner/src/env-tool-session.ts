import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ActivationConfig } from "./activation";
import type { BcDevConfigSection } from "./cli";
import { EnvToolError, renderCommand } from "./env-tool";
import type { EnvToolClient, EnvToolConfigSection, EnvToolReadyBlock } from "./env-tool";
import { HarnessVerificationError } from "./harness";

const EXPIRY_MARGIN_MS = 60 * 60_000;

/**
 * Fields `bcdevRaw` must carry that the env tool itself can never produce: `company` and
 * `controlSymbolPath` name local facts (which BC company to target, where the locally-compiled
 * control app lives on disk), and `mcpCommand` launches a local process — none of these come from
 * resolving an environment. `validateBcDevConfig` (cli.ts) cannot be reused here: it also demands
 * `server`/`serverInstance`, which do not exist yet at this point in env-tool mode (they're
 * derived from the resolved `baseUrl` further down). Checked explicitly, rather than trusting the
 * `as BcDevConfigSection` cast below, so a config missing one of these fails LOUDLY right here —
 * instead of producing a `BcDevConfigSection` whose string-typed field is `undefined` at runtime
 * and propagating silently into an OData call or backend construction.
 */
function requireBcDevRawFields(bcdevRaw: Partial<BcDevConfigSection>): void {
  const missing: string[] = [];
  if (!Array.isArray(bcdevRaw.mcpCommand) || bcdevRaw.mcpCommand.length === 0) {
    missing.push("mcpCommand");
  }
  if (bcdevRaw.company === undefined || bcdevRaw.company === "") missing.push("company");
  if (bcdevRaw.controlSymbolPath === undefined || bcdevRaw.controlSymbolPath === "") {
    missing.push("controlSymbolPath");
  }
  if (missing.length > 0) {
    throw new EnvToolError(
      `bcdev config is missing required field(s) the env tool cannot supply: ${missing.join(", ")}`,
    );
  }
}

export interface EnvToolSession {
  readonly bcdev: BcDevConfigSection;
  /**
   * The resolved environment id — from config in reuse-mode, or `createEnv`'s output in
   * create-mode. This is the id a `publish` call must target, NOT `bcdev.serverInstance`: that
   * field is only a same-value coincidence when `serverInstance` happens to be derived from
   * `baseUrl`'s first path segment AND that segment happens to equal the envId — neither holds
   * for an explicit `reads: { serverInstance: ... }` override, or a portal whose path segment
   * names something else entirely (e.g. `https://host/tenants/env-4711`).
   */
  readonly envId: string;
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
  makePublisher: (
    bcdev: BcDevConfigSection,
    envId: string,
  ) => { publishFile: (p: string) => Promise<void> };
  verifyHarness: (cfg: ActivationConfig) => Promise<void>;
  allowExpiring?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>; // injected so readiness polling is testable without waiting
  stateDir?: string;
}): Promise<EnvToolSession> {
  const { cfg, client } = args;
  requireBcDevRawFields(args.bcdevRaw);
  const now = args.now ?? Date.now;
  const sleep = args.sleep ?? ((ms: number) => Bun.sleep(ms));
  const stateDir = args.stateDir ?? join(homedir(), ".lethal", "env-state");
  // R17: `recordCreatedEnv`/`removeRecordedEnv` below maintain this directory, but until now
  // nothing ever LISTED it — the entire crash-recovery story for a leaked environment was a file
  // nothing reads. Scan it at the start of every session and warn on whatever is still there.
  // Never deletes anything: LethAL cannot know whether another concurrent session owns a given
  // record, so this is strictly advisory.
  await warnStaleEnvRecords(stateDir, args.runId);
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
  }
  supplied.envId = envId;

  // Everything below this point runs against an environment that — if THIS call just created it
  // — is already real and billed, with nothing pointing back to it yet except the crash-recovery
  // record `recordCreatedEnv` just wrote above. A failure anywhere in here (a `readyWhen` timeout,
  // a symbols failure, a `publishApps` typo, a control-app publish rejection) must not leak it:
  // this function's own caller (`resolveEnvToolSession`) only gets an `EnvToolSession` — and hence
  // a `teardown` to call — once this function RETURNS, so a throw from anywhere below would
  // otherwise escape with no teardown ever attempted. The catch below performs the same delete
  // `teardown` would, before rethrowing the ORIGINAL error unchanged — a failed delete is logged,
  // never allowed to replace or mask it. A reused (non-created) environment has nothing here to
  // delete, so the catch is a no-op rethrow for that case.
  try {
    if (createdEnvId !== undefined) {
      // 1b. Start, then WAIT — unconditionally required once THIS call created the environment.
      // `validateEnvToolConfig` (env-tool.ts) already makes both mandatory in create-mode with no
      // carve-out: `env create` returns a Draft environment with nothing listening, and `env start`
      // is async (Starting → Running measured at ~390s). A caller that skips both would publish
      // into that dead Draft endpoint minutes into a paid provisioning cycle. Each branch names
      // exactly the block that's missing, rather than a generic "both or neither" message, so a
      // config with exactly one configured is diagnosed precisely too.
      const startBlock = cfg.startEnv;
      const readyBlock = cfg.readyWhen;
      if (startBlock === undefined) {
        throw new EnvToolError(
          "envTool.startEnv is required once an environment is created — a newly created " +
            "environment is inert (Draft, nothing listening) until it is started",
        );
      }
      if (readyBlock === undefined) {
        throw new EnvToolError(
          "envTool.readyWhen is required once an environment is created — starting is " +
            "asynchronous (measured ~390s to Running), so LethAL must know how to poll for " +
            "readiness rather than publishing into a dead endpoint",
        );
      }
      // Measured 2026-07-26: create returns a Draft environment, `env start` returns "start
      // requested" in ~2s, and the BC endpoint answers ~391s later. Publishing before that fails
      // against a dead endpoint.
      await client.run(startBlock, "startEnv", { ...supplied, envId });
      await waitUntilReady(client, readyBlock, { ...supplied, envId }, now, sleep);
    }

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

    // 4. derive server/serverInstance/port from baseUrl unless read explicitly. A path-routed
    //    HTTPS portal (Continia) has no listener at bc-dev-mcp's OnPrem fallback port (7049), so
    //    the port bc-dev-mcp actually needs must be derived here rather than left to that fallback.
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
    //    app's own tables, and republishing runs its install/upgrade codeunits, which would
    //    disturb a concurrent session's lease and serverGeneration on a shared long-lived
    //    environment.
    const publisher = args.makePublisher(bcdev, envId);
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
    } catch (err) {
      // Only a HarnessVerificationError plausibly means "the control app is missing or the wrong
      // build" (appId mismatch, protocol version too low, missing isolation/test type, no
      // serverGeneration — see harness.ts). Anything else — most importantly a
      // MultiTenantContainerError (design §7's single-tenant gate: a supported-configuration
      // refusal, not "app missing"; it extends `Error` directly, never `HarnessVerificationError`,
      // precisely so it can't be mistaken for one here) — is rethrown unwrapped. Republishing runs
      // `LethAL Control`'s install/upgrade codeunits, and the machine-global lease lives in that
      // app's own tables: a needless republish for a refusal it cannot fix (multi-tenant, auth, a
      // transient blip) can disturb a concurrent session's lease and serverGeneration.
      if (!(err instanceof HarnessVerificationError)) throw err;
      harnessOk = false;
    }
    if (!harnessOk) {
      await publisher.publishFile(bcdev.controlSymbolPath);
      await args.verifyHarness(odataCfg); // throws if it still does not answer
    }

    return {
      bcdev,
      envId,
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
          // Cleanup failure must never replace the session's verdicts or exit code. The
          // crash-recovery record deliberately survives a failed delete — the environment may
          // still exist, and an operator recovering later needs it to find that out.
          console.warn(
            `[lethal] could not delete environment ${createdEnvId}: ` +
              `${err instanceof Error ? err.message : String(err)}\n` +
              `[lethal] delete it manually: ${renderCommand(block, cfg, { ...supplied, envId: createdEnvId }).join(" ")}`,
          );
          return;
        }
        await removeRecordedEnv(stateDir, args.runId);
      },
    };
  } catch (err) {
    // The leak-prevention path (see the doc comment above the `try`): only a session THIS call
    // created has anything to delete — a reused (config-supplied) environment is never LethAL's
    // to delete, matching `teardown`'s own `createdEnvId === undefined` no-op.
    if (createdEnvId === undefined) throw err;
    const block = cfg.deleteEnv;
    // Unreachable once `validateEnvToolConfig` has run (it requires `deleteEnv` in create-mode) —
    // this only guards a caller (a unit test, or a future caller) that skipped validation.
    if (block === undefined) throw err;
    try {
      await client.run(block, "deleteEnv", { ...supplied, envId: createdEnvId });
    } catch (deleteErr) {
      // The delete attempt's own failure must NEVER replace or mask the original error — that is
      // what the caller needs to see and act on. Logged at `error` (not `teardown`'s `warn`):
      // unlike a normal end-of-session teardown, this is a first-run failure mode with the
      // crash-recovery record as the only other trace, so it must not be easy to miss.
      const deleteArgv = renderCommand(block, cfg, { ...supplied, envId: createdEnvId }).join(" ");
      const deleteDetail = deleteErr instanceof Error ? deleteErr.message : String(deleteErr);
      console.error(
        `[lethal] environment ${createdEnvId} could not be deleted after a startup failure — it may still exist and be billing. Delete it manually: ${deleteArgv}\n[lethal] delete failure: ${deleteDetail}`,
      );
      throw err;
    }
    // Deleted successfully — the crash-recovery record now describes an environment that is
    // already gone; remove it the same way a normal successful teardown would (best-effort:
    // `removeRecordedEnv` itself never throws, matching every other call site of it here).
    await removeRecordedEnv(stateDir, args.runId);
    throw err;
  }
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
 * R17: the crash-recovery reader — `recordCreatedEnv` below writes one `<runId>.json` per created
 * environment, and until now nothing ever read the directory back. Every entry found here (other
 * than THIS run's own, written moments from now by `recordCreatedEnv`, or in flight if a PRIOR
 * call to this same function already wrote nothing — there is none yet) is necessarily left over
 * from an earlier run: either it ended without ever reaching `removeRecordedEnv` (crash, kill,
 * `--keep-env`, a quarantine) or its delete attempt failed. `console.warn`s each one with its
 * envId and the EXACT delete command `recordCreatedEnv` already rendered and stored — never
 * deletes anything itself: this process cannot know whether another concurrent session still
 * owns the environment a given record names.
 */
async function warnStaleEnvRecords(stateDir: string, currentRunId: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(stateDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return; // nothing has ever been recorded — nothing to scan
    console.warn(
      `[lethal] could not scan the env-tool crash-recovery directory (${stateDir}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const runId = entry.slice(0, -".json".length);
    if (runId === currentRunId) continue; // this run's own record — not stale, just written
    const path = join(stateDir, entry);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch (err) {
      console.warn(
        `[lethal] env-tool crash-recovery record ${path} could not be read/parsed — leaving it ` +
          `in place: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const rec = parsed as { runId?: unknown; envId?: unknown; deleteArgv?: unknown };
    const recRunId = typeof rec.runId === "string" ? rec.runId : runId;
    const envId = typeof rec.envId === "string" ? rec.envId : "(unknown envId)";
    const deleteCmd = Array.isArray(rec.deleteArgv)
      ? rec.deleteArgv.join(" ")
      : "(no delete command recorded)";
    console.warn(
      `[lethal] stale env-tool crash-recovery record for run ${recRunId}: environment ${envId} ` +
        `may still exist and be billing. Delete it with: ${deleteCmd}`,
    );
  }
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

/**
 * Removes a crash-recovery record after the environment it describes has actually been deleted.
 * Without this, `stateDir` accumulates one file per historical run forever, and an operator
 * recovering from a REAL crash can no longer tell a stale record (session ended cleanly) from a
 * genuinely orphaned environment (session crashed mid-run). Only called from the successful branch
 * of `teardown`'s `deleteEnv` — never when the environment is kept (`keepEnv`/quarantined, where
 * the record is exactly the recovery hint an operator needs) or when the delete itself failed
 * (where the environment may still exist).
 */
async function removeRecordedEnv(stateDir: string, runId: string): Promise<void> {
  try {
    await unlink(join(stateDir, `${runId}.json`));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return; // already gone — nothing to do
    // Best-effort: a stale record left behind by a failed unlink must never fail an otherwise-
    // successful teardown (the environment itself IS already deleted at this point).
    console.warn(
      `[lethal] could not remove crash-recovery record for run ${runId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
