import { describe, expect, it } from "bun:test";
import { BcRedirectRefusedError } from "../src/bc-fetch";
import { BcDevMcpBackend, devPackagesUrl } from "../src/bcdev-backend";
import { UnfilteredExtensionsQueryError } from "../src/harness";
import { deafBody, deafFetch } from "./helpers/lease-wire";

/**
 * R139 check 2's server READ: the dev endpoint's own `dev/packages`, which hands back the package
 * BC currently holds for an app. Chosen because it needs no new deployment step, no control-app
 * change and no second credential source — the same server/instance/tenant and the same
 * BC_DEV_USER/BC_DEV_PASSWORD the backend already passes to bc-dev-mcp.
 *
 * Every failure path returns `{ unread }` naming its cause (R630) rather than throwing. A check that
 * cannot read must never be able to stop a run.
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

  // R630: the server was ASKED and gave no package, and `unread` names why. Each status keeps its
  // own number; a 404 is not proven to mean "not resident" (review I2), so it says both readings.
  for (const [status, cause] of [
    [404, "HTTP 404 (no such app on the server, or the dev-endpoint path is wrong)"],
    [401, "HTTP 401 (the dev endpoint refused the login: check BC_DEV_USER / BC_DEV_PASSWORD)"],
    [403, "HTTP 403 (the dev endpoint refused the login: check BC_DEV_USER / BC_DEV_PASSWORD)"],
    [500, "HTTP 500 (a server error)"],
    [503, "HTTP 503 (a server error)"],
    [409, "HTTP 409"],
  ] as const) {
    it(`R630: a ${status} answer is unread, naming ${JSON.stringify(cause)}`, async () => {
      const backend = new BcDevMcpBackend(BASE_CFG);
      const read = await backend.fetchPublishedAppPackage(
        APP,
        async () => new Response("nope", { status }),
      );
      expect(read).toEqual({ unread: cause });
    });
  }

  it("R630: a refused connection is unread, naming it, never throwing", async () => {
    const backend = new BcDevMcpBackend(BASE_CFG);
    const read = await backend.fetchPublishedAppPackage(APP, async () => {
      throw Object.assign(new TypeError("Unable to connect."), { code: "ConnectionRefused" });
    });
    expect(read).toEqual({ unread: "the connection was refused (ConnectionRefused)" });
  });

  it("R630: a name that does not resolve is unread as DNS", async () => {
    const backend = new BcDevMcpBackend(BASE_CFG);
    const read = await backend.fetchPublishedAppPackage(APP, async () => {
      throw Object.assign(new TypeError("getaddrinfo ENOTFOUND cronus283"), { code: "ENOTFOUND" });
    });
    expect(read).toEqual({ unread: "the server name did not resolve (DNS, ENOTFOUND)" });
  });

  it("R630: a refused redirect is named", async () => {
    const backend = new BcDevMcpBackend(BASE_CFG);
    const read = await backend.fetchPublishedAppPackage(APP, async () => {
      throw new BcRedirectRefusedError("BC answered with HTTP 302 redirect to x");
    });
    expect(read).toEqual({ unread: "a redirect was refused (LethAL never follows one from BC)" });
  });

  it("R630: any other failure names its class and message, with the login blanked out", async () => {
    const backend = new BcDevMcpBackend(BASE_CFG);
    const read = await backend.fetchPublishedAppPackage(APP, async () => {
      throw new Error("socket hang up for sshadows:1234");
    });
    expect(read).toEqual({ unread: "the request failed (Error: socket hang up for ***:***)" });
  });

  // R630 review I3: `withDeadline` aborts the fetch before `bounded`'s guard fires, so a fetch
  // that HONOURS its signal rejects with an AbortError, and that is the timeout too.
  it("R630 I3: a fetch that honours its abort signal reads as a timeout", async () => {
    const backend = new BcDevMcpBackend(BASE_CFG);
    const honours = (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      });
    expect(await backend.fetchPublishedAppPackage(APP, honours, 20)).toEqual({
      unread: "no answer within 20 ms (timeout)",
    });
  });

  it("R630: no cause text carries the login", async () => {
    const backend = new BcDevMcpBackend(BASE_CFG);
    for (const status of [401, 403, 404, 500]) {
      const read = await backend.fetchPublishedAppPackage(
        APP,
        async () => new Response("sshadows 1234", { status }),
      );
      expect(JSON.stringify(read)).not.toContain("sshadows");
      expect(JSON.stringify(read)).not.toContain("1234");
    }
  });

  it("R-496: an UnfilteredExtensionsQueryError is still thrown", async () => {
    const backend = new BcDevMcpBackend(BASE_CFG);
    const err = await backend
      .fetchPublishedAppPackage(APP, async () => {
        throw new UnfilteredExtensionsQueryError("unfiltered");
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnfilteredExtensionsQueryError);
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

  // R506 K1-K2: the read is bounded through the body even when the body ignores its abort, and a
  // timeout is still the documented "could not read" answer, now naming the timeout (R630). No
  // wall-clock asserts: a missing bound goes red by bun's 5 s test timeout.
  for (const [name, make] of [
    ["K1 a body that ignores its abort", deafBody],
    ["K2 a fetch that never answers", deafFetch],
  ] as const) {
    it(`${name} resolves unread, as a timeout, within the bound`, async () => {
      const backend = new BcDevMcpBackend(BASE_CFG);
      expect(await backend.fetchPublishedAppPackage(APP, make(), 20)).toEqual({
        unread: "no answer within 20 ms (timeout)",
      });
    });
  }
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
