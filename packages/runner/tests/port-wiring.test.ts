/**
 * R589 (R591 folded in): a bcdev config whose server is not on the default ports must reach ITS
 * ports, on all three planes: OData (`baseUrl`), the dev endpoint through bc-dev-mcp (`port`), and
 * the altool publish (`--port`). A config that names no port (Cronus28) must produce exactly what
 * it did before. The three BC on Linux servers share one host, so a port that falls back to its
 * default silently aims a gate at `bc1`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { FetchFn } from "../src/activation";
import {
  type BcDevConfigSection,
  configuredOdataBaseUrl,
  deployerFor,
  devPortOf,
  odataCfgFor,
  recoveryBaseUrl,
  validateBcDevConfig,
} from "../src/cli";
import { HarnessVerifier } from "../src/harness";
import { ContainerDeployer, type ContainerDeployerConfig } from "../src/publisher";

const BASE: BcDevConfigSection = {
  mcpCommand: ["node", "bc-dev-mcp.js"],
  server: "http://Cronus28",
  serverInstance: "BC",
  tenant: "default",
  company: "CRONUS Danmark A/S",
  username: "u",
  password: "p",
  packageCachePath: "/x/.alpackages",
  controlSymbolPath: "/x/control.app",
};

// bc2's shape, as scripts/bc-linux-setup.ts writes it.
const BC2: BcDevConfigSection = {
  ...BASE,
  server: "http://192.168.2.157:7149",
  port: 7149,
  baseUrl: "http://192.168.2.157:7148/BC",
  apiBaseUrl: "http://192.168.2.157:7152/BC",
  company: "CRONUS International Ltd.",
};

const COMPANY_ID = "11111111-2222-3333-4444-555555555555";
const APP_ID = "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a";

/**
 * Every URL the harness calls during `act`, through a fetch that records each one. It answers the
 * companies list (so the extensions read behind it is reached) and refuses everything else.
 */
async function urlsOf(
  section: BcDevConfigSection,
  act: (v: HarnessVerifier) => Promise<unknown>,
): Promise<string[]> {
  const urls: string[] = [];
  const fake = (async (input: string | URL | Request): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    if (url.includes("/api/v2.0/companies?")) {
      return Response.json({ value: [{ id: COMPANY_ID, name: section.company }] });
    }
    throw new Error("recorded, not sent");
  }) as FetchFn;
  await act(new HarnessVerifier(odataCfgFor(section), fake)).catch(() => {});
  if (urls.length === 0) throw new Error("the harness made no call");
  return urls;
}

async function firstOdataUrl(section: BcDevConfigSection): Promise<string> {
  const [url] = await urlsOf(section, (v) => v.fetchControlVersion());
  return url ?? "";
}

async function altoolArgv(cfg: ContainerDeployerConfig): Promise<string[]> {
  const bytes = new Uint8Array([1, 2, 3]);
  const calls: string[][] = [];
  const deployer = new ContainerDeployer(cfg, {
    spawn: async (argv) => {
      calls.push([...argv]);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    readArtifact: async () => bytes,
  });
  await deployer.publish({ appPath: "/x/a.app", sha256: Bun.SHA256.hash(bytes, "hex") });
  const [argv] = calls;
  if (argv === undefined) throw new Error("altool was not spawned");
  return argv;
}

const DEPLOY = { altoolPath: "altool", serverInstance: "BC", username: "u", password: "p" };

describe("non-default ports reach their own server", () => {
  test("OData goes to the configured baseUrl's port (7148), not 7048", async () => {
    expect(configuredOdataBaseUrl(BC2)).toBe("http://192.168.2.157:7148/BC");
    expect(await firstOdataUrl(BC2)).toStartWith("http://192.168.2.157:7148/BC/ODataV4/");
  });

  test("the dev port (7149) reaches the backend config and the altool argv", async () => {
    expect(devPortOf(BC2)).toEqual({ port: 7149 });
    const argv = await altoolArgv({ ...DEPLOY, server: BC2.server, ...devPortOf(BC2) });
    expect(argv.slice(3, 7)).toEqual(["--server", "http://192.168.2.157", "--port", "7149"]);
  });

  test("a port written only into server still reaches altool as --port", async () => {
    const argv = await altoolArgv({ ...DEPLOY, server: "http://192.168.2.157:7249" });
    expect(argv.slice(3, 7)).toEqual(["--server", "http://192.168.2.157", "--port", "7249"]);
  });

  test("the companies list and the extensions read go to the API port (7152)", async () => {
    // Measured on bc1 2026-10-21: these under the OData root answer 404 on BC on Linux.
    const companies = await urlsOf(BC2, (v) => v.fetchCompanies());
    expect(companies).toEqual(["http://192.168.2.157:7152/BC/api/v2.0/companies?tenant=default"]);
    const ext = await urlsOf(BC2, (v) => v.fetchExtensionInstalled(APP_ID));
    expect(ext).toHaveLength(2);
    // The path itself is harness.ts's alone (scripts/automation-api-guard.test.ts): check the root.
    expect(ext[1]).toStartWith("http://192.168.2.157:7152/BC/api/");
    expect(ext[1]).toContain(`/companies(${COMPANY_ID})/extensions?`);
  });

  test("lethal run's own deployer gets the configured dev port", () => {
    const d = deployerFor(BC2, "altool") as unknown as { cfg: ContainerDeployerConfig };
    expect(d.cfg.port).toBe(7149);
  });
});

describe("a config with no ports is unchanged (Cronus28)", () => {
  test("OData stays on 7048", async () => {
    expect(configuredOdataBaseUrl(BASE)).toBe("http://cronus28:7048/BC");
    expect(await firstOdataUrl(BASE)).toStartWith("http://cronus28:7048/BC/ODataV4/");
  });

  test("the API reads stay under the OData root on 7048", async () => {
    expect(await urlsOf(BASE, (v) => v.fetchCompanies())).toEqual([
      "http://cronus28:7048/BC/api/v2.0/companies?tenant=default",
    ]);
    const ext = await urlsOf(BASE, (v) => v.fetchExtensionInstalled(APP_ID));
    expect(ext[1]).toStartWith("http://cronus28:7048/BC/api/");
    expect(ext[1]).toContain(`/companies(${COMPANY_ID})/extensions?`);
  });

  test("no dev port is sent anywhere, and altool's argv is the old one", async () => {
    expect(devPortOf(BASE)).toEqual({});
    const argv = await altoolArgv({ ...DEPLOY, server: BASE.server, ...devPortOf(BASE) });
    expect(argv).toEqual([
      "altool",
      "publishapp",
      "/x/a.app",
      "--server",
      "http://Cronus28",
      "--serverinstance",
      "BC",
      "--environmenttype",
      "OnPrem",
      "--authentication",
      "UserPassword",
      "--schemaupdatemode",
      "ForceSync",
    ]);
  });
});

describe("every bcdev itest takes its ports from the config", () => {
  const dir = join(import.meta.dir, "..", "itest");
  const itests = readdirSync(dir).filter((f) => f.endsWith(".itest.ts"));

  test("no itest derives OData with odataBaseUrl (which forces 7048) or sets baseUrl itself", () => {
    // A hand-set `baseUrl:` drops `apiBaseUrl`; every itest spreads `odataUrlsOf(bcdev)` instead.
    const offenders = itests.filter((f) =>
      /\bodataBaseUrl\(|\bbaseUrl:/.test(readFileSync(join(dir, f), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  test("every ContainerDeployer and BcDevMcpBackend an itest builds is given devPortOf", () => {
    // Per constructor, not per file: a count per file let an extra `devPortOf` elsewhere mask a
    // constructor without one. Each config object names `server` within its first few lines.
    const short: string[] = [];
    let built = 0;
    for (const f of itests) {
      const text = readFileSync(join(dir, f), "utf8");
      for (const m of text.matchAll(/new (ContainerDeployer|BcDevMcpBackend)\(/g)) {
        built += 1;
        const window = text.slice(m.index ?? 0, (m.index ?? 0) + 500);
        if (!window.includes("...devPortOf(bcdev)")) short.push(`${f}: ${m[1]} at ${m.index}`);
      }
    }
    expect(short).toEqual([]);
    expect(built).toBeGreaterThan(20);
  });
});

describe("one config, one dev port (R589 review M1)", () => {
  test("a server port and a bcdev.port that agree pass", () => {
    expect(validateBcDevConfig({ ...BC2 }).port).toBe(7149);
    expect(validateBcDevConfig({ ...BASE }).server).toBe("http://Cronus28");
  });

  test("a server port and a bcdev.port that disagree are refused", () => {
    // A bc3 config copied from bc2's with `port` edited and `server` not.
    expect(() => validateBcDevConfig({ ...BC2, port: 7249 })).toThrow(/two dev ports/);
  });
});

describe("force-reset-lease resets only the server --server names (R589 review M4)", () => {
  const bc1Base = "http://192.168.2.157:7048/BC";

  test("--server naming bc2's dev port against a bc1 config is refused", () => {
    expect(() => recoveryBaseUrl("http://192.168.2.157:7149", "BC", bc1Base, 7049)).toThrow(
      /not the server the config describes/,
    );
  });

  test("--server naming another host is refused", () => {
    expect(() => recoveryBaseUrl("http://Cronus28", "BC", bc1Base, 7049)).toThrow(
      /not the server the config describes/,
    );
  });

  test("--server naming the config's own host and dev port passes", () => {
    expect(recoveryBaseUrl("http://192.168.2.157:7049", "BC", bc1Base, 7049)).toBe(bc1Base);
    expect(recoveryBaseUrl("http://192.168.2.157", "BC", bc1Base, 7049)).toBe(bc1Base);
  });
});
