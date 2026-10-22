/**
 * R639 probe against a server named by a lethal config (Cronus28, a Windows BC container), not by
 * `SERVERS`. Same driver as bc1 (`drive.ts`), same apps and ids, but ONLY the two HTTP codeunits:
 * 92910 (HttpGet) and 92911 (HttpGetRaw).
 *
 *   bun scripts/r639-bc-probe/drive-config.ts --config <lethal.config.json> [--server-label Cronus28]
 *
 * The login comes from the config's `bcdev.username` / `bcdev.password`, read in-process through
 * LethAL's own loader and never printed. REFUSES (exit 2) a label that is Cronus284 or Cronus281-4
 * (CentralGauge's), and unless `kraken coord holder <label>` names lane bugs.
 *
 * Writes docs/measurements/r639/<label>-probe.json; logs to /coord/handoff/R-639/<label>/drive.log.
 * Exit: 0 ran and removed; 1 a step failed; 2 a guard refused.
 */
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import {
  type BcDevConfigSection,
  configuredOdataBaseUrl,
  loadLethalConfigFile,
  urlPortOf,
  validateBcDevConfig,
} from "../../packages/runner/src/cli";
import type { Conn } from "../bc-app-content.ts";
import { ALL_CASES, type ProbeOdata, type Target, main } from "./drive";

const REPO = join(import.meta.dir, "..", "..");

/** CentralGauge's servers (owner ruling 2026-10-21). Throws by name. */
export function refuseLabel(label: string): void {
  if (/^Cronus28[1-4]$/i.test(label))
    throw new Error(`${label} is not LethAL's (CentralGauge's): refused`);
}

const noUserinfo = (url: string): string => {
  const u = new URL(url);
  u.username = "";
  u.password = "";
  return u.toString().replace(/\/+$/, "");
};

/** The probe connection from a validated `bcdev` section. Pure: no I/O, no logging of the login. */
export function connFromBcdev(
  bcdev: BcDevConfigSection,
  label: string,
  configName: string,
): { c: Conn; odata: ProbeOdata; extra: Record<string, unknown> } {
  const tenant = bcdev.tenant ?? "default";
  // bc-app-content's helpers send `tenant=default`; any other tenant would be silently ignored.
  if (tenant !== "default")
    throw new Error(`bcdev.tenant is ${tenant}: only "default" is supported`);
  const u = new URL(bcdev.server);
  const devPort = bcdev.port ?? urlPortOf(bcdev.server);
  // Same rule as `devPackagesUrl`: a bare https portal keeps its protocol port, anything else 7049.
  const port = devPort ?? (u.protocol === "https:" ? undefined : 7049);
  const dev = `${u.protocol}//${u.hostname}${port === undefined ? "" : `:${port}`}/${bcdev.serverInstance}`;
  const baseUrl = configuredOdataBaseUrl(bcdev);
  const apiBaseUrl = bcdev.apiBaseUrl ?? baseUrl;
  const api = `${apiBaseUrl}/api`;
  return {
    c: {
      server: label,
      authorization: `Basic ${Buffer.from(`${bcdev.username}:${bcdev.password}`).toString("base64")}`,
      urls: { dev, api, company: bcdev.company },
    },
    odata: {
      baseUrl,
      apiBaseUrl,
      company: bcdev.company,
      username: bcdev.username,
      password: bcdev.password,
      tenant,
    },
    extra: {
      connection: {
        config: configName,
        dev: noUserinfo(dev),
        odata: noUserinfo(baseUrl),
        api: noUserinfo(api),
        company: bcdev.company,
        tenant,
      },
    },
  };
}

export function targetFor(bcdev: BcDevConfigSection, label: string, configName: string): Target {
  return {
    label,
    evidence: `/coord/handoff/R-639/${label.toLowerCase()}`,
    out: join(REPO, "docs", "measurements", "r639", `${label.toLowerCase()}-probe.json`),
    cases: ALL_CASES.filter((k) => k.codeunit === 92910 || k.codeunit === 92911),
    run: 1,
    connect: () => connFromBcdev(bcdev, label, configName),
    sources: [
      "scripts/r639-bc-probe/target",
      "scripts/r639-bc-probe/tests",
      "scripts/r639-bc-probe/drive.ts",
      "scripts/r639-bc-probe/drive-config.ts",
    ],
  };
}

async function cli(): Promise<number> {
  const { values } = parseArgs({
    options: { config: { type: "string" }, "server-label": { type: "string" } },
  });
  let target: Target;
  try {
    if (values.config === undefined) throw new Error("--config <path> is required");
    const label = values["server-label"] ?? "Cronus28";
    refuseLabel(label);
    const file = await loadLethalConfigFile(values.config);
    target = targetFor(validateBcDevConfig(file.bcdev), label, basename(values.config));
  } catch (err) {
    console.error(`REFUSED: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  return await main(target);
}

if (import.meta.main) process.exit(await cli());
