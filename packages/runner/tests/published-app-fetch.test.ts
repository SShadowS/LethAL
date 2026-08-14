import { describe, expect, it } from "bun:test";
import { BcDevMcpBackend, devPackagesUrl } from "../src/bcdev-backend";

/**
 * R139 check 2's server READ: the dev endpoint's own `dev/packages`, which hands back the package
 * BC currently holds for an app. Chosen because it needs no new deployment step, no control-app
 * change and no second credential source — the same server/instance/tenant and the same
 * BC_DEV_USER/BC_DEV_PASSWORD the backend already passes to bc-dev-mcp.
 *
 * Every failure path returns null rather than throwing. A check that cannot read must never be able
 * to stop a run.
 */

const APP = { publisher: "LethAL", name: "LethAL Sandbox Data Tests" };

const BASE_CFG = {
  mcpCommand: ["bun", "x", "bc-dev-mcp"],
  project: "/project",
  server: "http://Cronus283",
  serverInstance: "BC",
  tenant: "default",
  packageCachePath: "/cache",
  controlSymbolPath: "/control.app",
  env: { BC_DEV_USER: "sshadows", BC_DEV_PASSWORD: "1234" },
};

describe("devPackagesUrl", () => {
  it("composes the dev endpoint from server, instance, tenant and the default dev port", () => {
    expect(devPackagesUrl(BASE_CFG, APP)).toBe(
      "http://cronus283:7049/BC/dev/packages?publisher=LethAL&appName=LethAL%20Sandbox%20Data%20Tests&versionText=&tenant=default",
    );
  });

  it("prefers a configured port over the 7049 fallback", () => {
    expect(devPackagesUrl({ ...BASE_CFG, port: 7149 }, APP)).toContain("http://cronus283:7149/BC/");
  });

  it("keeps a port the server URL already carries", () => {
    expect(devPackagesUrl({ ...BASE_CFG, server: "http://Cronus283:7249" }, APP)).toContain(
      "http://cronus283:7249/BC/",
    );
  });

  it("returns null rather than guessing when the server or instance is unknown", () => {
    const { server: _server, ...noServer } = BASE_CFG;
    const { serverInstance: _instance, ...noInstance } = BASE_CFG;
    expect(devPackagesUrl(noServer, APP)).toBeNull();
    expect(devPackagesUrl(noInstance, APP)).toBeNull();
  });
});

describe("BcDevMcpBackend.fetchPublishedAppPackage", () => {
  it("returns the package bytes and sends Basic auth built from the backend's own env", async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const backend = new BcDevMcpBackend(BASE_CFG);
    const bytes = await backend.fetchPublishedAppPackage(APP, async (url, init) => {
      seen.push({
        url: String(url),
        auth: (init?.headers as Record<string, string> | undefined)?.authorization,
      });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(seen[0]?.url).toContain("/dev/packages?publisher=LethAL");
    expect(seen[0]?.auth).toBe(`Basic ${btoa("sshadows:1234")}`);
  });

  it("returns null when the server was ASKED and answered anything but 200", async () => {
    const backend = new BcDevMcpBackend(BASE_CFG);
    const bytes = await backend.fetchPublishedAppPackage(
      APP,
      async () => new Response("nope", { status: 404 }),
    );
    expect(bytes).toBeNull();
  });

  it("returns null when the request itself fails, never throwing", async () => {
    const backend = new BcDevMcpBackend(BASE_CFG);
    const bytes = await backend.fetchPublishedAppPackage(APP, async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(bytes).toBeNull();
  });

  it("returns UNDEFINED, not null, when no credentials are configured: nothing was tried", async () => {
    let called = false;
    const backend = new BcDevMcpBackend({ ...BASE_CFG, env: {} });
    const bytes = await backend.fetchPublishedAppPackage(APP, async () => {
      called = true;
      return new Response(new Uint8Array([1]), { status: 200 });
    });
    expect(bytes).toBeUndefined();
    expect(called).toBe(false);
  });
});

describe("fetchPublishedAppPackage's not-applicable answer", () => {
  it("returns undefined when no dev server can be named, so the caller stays silent", async () => {
    const { server: _server, ...noServer } = BASE_CFG;
    let called = false;
    const backend = new BcDevMcpBackend(noServer);
    const bytes = await backend.fetchPublishedAppPackage(APP, async () => {
      called = true;
      return new Response(new Uint8Array([1]), { status: 200 });
    });
    expect(bytes).toBeUndefined();
    expect(called).toBe(false);
  });
});
