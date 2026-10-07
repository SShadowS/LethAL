import { describe, expect, test } from "bun:test";
import type { ActivationConfig } from "../src/activation";
import { refuseRedirects } from "../src/bc-fetch";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import { type MicrosoftMode, dependencyFingerprint } from "../src/digest-inputs";
import {
  HarnessVerificationError,
  HarnessVerifier,
  UnfilteredExtensionsQueryError,
} from "../src/harness";
import { buildFakeAppWithEntries } from "./helpers/fake-app";
import { fakeMicrosoftMode } from "./helpers/microsoft-mode";

/**
 * R433 / R-385 T0: BC's automation `extensions` list, asked for every row (no `$filter`) or
 * filtered by publisher, never answered on Cronus28 (BC 28.4, about 166 s, three times) and the
 * service tier then stopped answering. By app id it answered in 39-49 ms. So `fetchApiRows`, the
 * one sender, refuses any `extensions` request that is not filtered by exactly one GUID, BEFORE a
 * request is sent, and `fetchExtensionInstalled` refuses a non-GUID id before any request.
 */

const GUID = "437dbf0e-84ff-417a-965d-ed2bb9650972";

const CFG: ActivationConfig = {
  baseUrl: "http://bc:7048/BC",
  company: "CRONUS Danmark A/S",
  username: "u",
  password: "p",
  tenant: "default",
};

function fake() {
  const urls: string[] = [];
  const fetchFn = (async (url: unknown) => {
    urls.push(String(url));
    const body = String(url).includes("/extensions")
      ? { value: [] }
      : { value: [{ id: "c-1", name: "CRONUS Danmark A/S" }] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { urls, fetchFn };
}

type RowsFn = (
  path: string,
  what: string,
  extra?: Readonly<Record<string, string>>,
) => Promise<readonly unknown[]>;

/** The private sender, reached through a cast: the refusal must hold for ANY caller inside
 *  harness.ts, including a future method that forgets the filter. */
function rowsOf(v: HarnessVerifier): RowsFn {
  const fn = (v as unknown as { fetchApiRows: RowsFn }).fetchApiRows;
  return fn.bind(v);
}

/** The one allowed URL. The source guard (`scripts/automation-api-guard.test.ts`) allows the
 *  automation API text in a test file only on a line that carries the GUID filter, so the bare
 *  path below is derived from this line rather than written out a second time. */
const ALLOWED_URL =
  "http://bc:7048/BC/api/microsoft/automation/v2.0/companies(c-1)/extensions?%24filter=id+eq+437dbf0e-84ff-417a-965d-ed2bb9650972&tenant=default";
const EXT = new URL(ALLOWED_URL).pathname.slice("/BC/".length);

describe("fetchApiRows refuses an extensions query not filtered by one GUID (R433)", () => {
  const refused: [string, string, Record<string, string> | undefined][] = [
    ["no filter at all", EXT, undefined],
    ["an empty extra", EXT, {}],
    ["a publisher filter", EXT, { $filter: "publisher eq 'Microsoft'" }],
    ["a non-GUID id", EXT, { $filter: "id eq app-1" }],
    ["a malformed GUID (short last group)", EXT, { $filter: `id eq ${GUID.slice(0, -1)}` }],
    ["a quoted GUID", EXT, { $filter: `id eq '${GUID}'` }],
    ["a GUID plus $top", EXT, { $filter: `id eq ${GUID}`, $top: "5" }],
    ["a GUID or-ed with a publisher", EXT, { $filter: `id eq ${GUID} or publisher eq 'x'` }],
    ["a GUID followed by a newline", EXT, { $filter: `id eq ${GUID}\n` }],
    ["a filter key in another case", EXT, { $Filter: `id eq ${GUID}` }],
    ["a tenant smuggled in extra", EXT, { $filter: `id eq ${GUID}`, tenant: "default" }],
    ["?$top=5 inside the path", `${EXT}?$top=5`, { $filter: `id eq ${GUID}` }],
    [
      "the filter itself inside the path",
      `${EXT}?$filter=publisher eq 'Microsoft'`,
      { $filter: `id eq ${GUID}` },
    ],
    ["a fragment in the path", `${EXT}#x`, { $filter: `id eq ${GUID}` }],
    ["the path in another case", EXT.replace("extensions", "Extensions"), undefined],
    ["the path with an encoded slash", EXT.replace("/extensions", "%2Fextensions"), undefined],
    // Review r1 #2: any percent-encoding of `extensions` is still `extensions`.
    ["a percent-encoded letter", EXT.replace("extensions", "ext%65nsions"), undefined],
    ["an upper-case hex escape", EXT.replace("extensions", "ext%45nsions"), undefined],
    ["a lower-case hex escape", EXT.replace("extensions", "extensio%6es"), undefined],
    [
      "every letter encoded",
      EXT.replace("extensions", "%65%78%74%65%6e%73%69%6f%6e%73"),
      undefined,
    ],
    ["a double-encoded letter", EXT.replace("extensions", "ext%2565nsions"), undefined],
    ["an encoded `?` in the path", `${EXT}%3F$top=5`, { $filter: `id eq ${GUID}` }],
    ["a malformed escape beside the name", EXT.replace("extensions", "extensions%zz"), undefined],
  ];
  for (const [name, path, extra] of refused) {
    test(`refuses ${name}, with zero fetches`, async () => {
      const { urls, fetchFn } = fake();
      const send = rowsOf(new HarnessVerifier(CFG, fetchFn));
      const call = extra === undefined ? send(path, "extensions list") : send(path, "x", extra);
      await expect(call).rejects.toBeInstanceOf(UnfilteredExtensionsQueryError);
      expect(urls).toEqual([]);
    });
  }

  test("the error extends Error directly and names the path", async () => {
    const { fetchFn } = fake();
    const err = await rowsOf(new HarnessVerifier(CFG, fetchFn))(EXT, "x", {
      $filter: "publisher eq 'Microsoft'",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnfilteredExtensionsQueryError);
    expect(Object.getPrototypeOf(UnfilteredExtensionsQueryError.prototype)).toBe(Error.prototype);
    expect(String((err as Error).message)).toContain(EXT);
    expect(String((err as Error).message)).toContain("publisher eq 'Microsoft'");
  });

  test("ALLOWS `id eq <GUID>`: exactly one fetch, filtered by that id", async () => {
    const { urls, fetchFn } = fake();
    await rowsOf(new HarnessVerifier(CFG, fetchFn))(EXT, "x", { $filter: `id eq ${GUID}` });
    expect(EXT.startsWith("api/microsoft/")).toBe(true);
    expect(EXT.endsWith("/companies(c-1)/extensions")).toBe(true);
    expect(urls).toEqual([ALLOWED_URL]);
  });

  test("the companies path, which carries an encoded character, is not refused", async () => {
    const { urls, fetchFn } = fake();
    await rowsOf(new HarnessVerifier(CFG, fetchFn))("api/v2.0/companies%281%29", "x");
    expect(urls.length).toBe(1);
  });

  test("ALLOWS an upper-case GUID", async () => {
    const { urls, fetchFn } = fake();
    await rowsOf(new HarnessVerifier(CFG, fetchFn))(EXT, "x", {
      $filter: `id eq ${GUID.toUpperCase()}`,
    });
    expect(urls.length).toBe(1);
  });

  test("the companies path is unaffected", async () => {
    const { urls, fetchFn } = fake();
    expect(await new HarnessVerifier(CFG, fetchFn).fetchCompanies()).toEqual([
      "CRONUS Danmark A/S",
    ]);
    expect(urls).toEqual(["http://bc:7048/BC/api/v2.0/companies?tenant=default"]);
  });
});

/** `s` with every `%` escaped `n` more times: `nest("%65", 2)` is `%252565`. */
function nest(s: string, n: number): string {
  let cur = s;
  for (let i = 0; i < n; i++) cur = cur.replaceAll("%", "%25");
  return cur;
}

describe("the refusal also covers the query and leftover escapes (R438)", () => {
  const COMPANIES = "api/v2.0/companies";
  const refusedKV: [string, string, Record<string, string>][] = [
    ["an $expand value naming extensions", COMPANIES, { $expand: "extensions" }],
    ["an encoded value naming extensions", COMPANIES, { $expand: "%65xtensions" }],
    ["a key naming extensions", COMPANIES, { "extensions($select=id)": "x" }],
    ["a $filter value naming extensions", COMPANIES, { $filter: "extensions/any()" }],
  ];
  const refusedLeftover: [string, string, Record<string, string>][] = [
    ["a 17-deep escape in the path", nest("%65xtensions", 17), {}],
    ["a 17-deep escape in a value", COMPANIES, { $expand: nest("%65xtensions", 17) }],
    ["a 17-deep escape in a key", COMPANIES, { [nest("%65xtensions", 17)]: "x" }],
  ];
  for (const [name, path, extra] of [...refusedKV, ...refusedLeftover]) {
    test(`refuses ${name}, with zero fetches`, async () => {
      const { urls, fetchFn } = fake();
      const call = rowsOf(new HarnessVerifier(CFG, fetchFn))(path, "x", extra);
      await expect(call).rejects.toBeInstanceOf(UnfilteredExtensionsQueryError);
      expect(urls).toEqual([]);
    });
  }

  test("a 3-deep escape of a harmless string still passes", async () => {
    const { urls, fetchFn } = fake();
    await rowsOf(new HarnessVerifier(CFG, fetchFn))(COMPANIES, "x", { $top: nest("%41", 2) });
    expect(urls.length).toBe(1);
  });

  test("a harmless query on the companies path still sends", async () => {
    const { urls, fetchFn } = fake();
    await rowsOf(new HarnessVerifier(CFG, fetchFn))(COMPANIES, "x", { $top: "5" });
    expect(urls.length).toBe(1);
  });

  test("the allowed GUID filter on the extensions path still sends", async () => {
    const { urls, fetchFn } = fake();
    await rowsOf(new HarnessVerifier(CFG, fetchFn))(EXT, "x", { $filter: `id eq ${GUID}` });
    expect(urls).toEqual([ALLOWED_URL]);
  });
});

describe("the refusal reads the URL fetch actually sends (R441)", () => {
  // fetch's URL parser drops tab, CR and LF, so `ext\tensions` reaches the server as `extensions`.
  for (const [name, path] of [
    ["a tab inside extensions", EXT.replace("extensions", "ext\tensions")],
    ["CR/LF inside extensions", EXT.replace("extensions", "ext\r\nensions")],
  ] as const) {
    test(`refuses ${name}, with zero fetches`, async () => {
      const { urls, fetchFn } = fake();
      await expect(rowsOf(new HarnessVerifier(CFG, fetchFn))(path, "x")).rejects.toBeInstanceOf(
        UnfilteredExtensionsQueryError,
      );
      expect(urls).toEqual([]);
    });
  }

  // R-441 review: the parsed query is a LIST. A map kept only the last `$filter` and dropped every
  // `tenant`, while the URL sent them all.
  const TAB = EXT.replace("extensions", "ext\tensions");
  const { tenant: _unused, ...NO_TENANT } = CFG;
  const cases: [string, ActivationConfig, string, Record<string, string>][] = [
    [
      // No tenant configured: otherwise `?tenant=` lands inside the last value and hides the bypass.
      "a second $filter beside the GUID one",
      NO_TENANT,
      `${TAB}?$filter=publisher eq 'Microsoft'&$filter=id eq ${GUID}`,
      {},
    ],
    [
      "a caller tenant with none configured",
      NO_TENANT,
      TAB,
      { $filter: `id eq ${GUID}`, tenant: "other" },
    ],
  ];
  for (const [name, cfg, path, extra] of cases) {
    test(`refuses ${name}, with zero fetches`, async () => {
      const { urls, fetchFn } = fake();
      const call = rowsOf(new HarnessVerifier(cfg, fetchFn))(path, "x", extra);
      await expect(call).rejects.toBeInstanceOf(UnfilteredExtensionsQueryError);
      expect(urls).toEqual([]);
    });
  }

  test("a caller tenant is replaced by the configured one, so only that one is sent", async () => {
    const { urls, fetchFn } = fake();
    await rowsOf(new HarnessVerifier(CFG, fetchFn))(TAB, "x", {
      $filter: `id eq ${GUID}`,
      tenant: "other",
    });
    expect(urls).toEqual([ALLOWED_URL]);
  });
});

describe("fetchExtensionInstalled refuses a non-GUID id before any request (R433)", () => {
  for (const id of ["", "app-1", ` ${GUID}`, `{${GUID}}`, `${GUID} or publisher eq 'x'`]) {
    test(`refuses ${JSON.stringify(id)} with zero fetches`, async () => {
      const { urls, fetchFn } = fake();
      const err = await new HarnessVerifier(CFG, fetchFn)
        .fetchExtensionInstalled(id)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HarnessVerificationError);
      expect(urls).toEqual([]);
    });
  }

  test("every extensions URL it sends carries `$filter=id eq <that guid>`", async () => {
    const { urls, fetchFn } = fake();
    await new HarnessVerifier(CFG, fetchFn).fetchExtensionInstalled(GUID);
    const ext = urls.filter((u) => u.toLowerCase().includes("extensions"));
    expect(ext.length).toBe(1);
    for (const u of ext) {
      expect(new URL(u).searchParams.get("$filter")).toBe(`id eq ${GUID}`);
    }
  });
});

/**
 * R496: the dependency fingerprint now checks EVERY extension it hashes installed (partner ones and
 * transitive ones too), so those reads multiply. Each must be the per-app `$filter=id eq <GUID>`
 * read, never a list, and a read that is not one is refused before it is sent and aborts the walk
 * (never read as "not installed").
 */
describe("R496: the fingerprint's installed checks are per-app filtered reads only", () => {
  const NS = 'xmlns="http://schemas.microsoft.com/navx/2015/manifest"';
  const A = { id: "aaaaaaaa-0000-4000-8000-00000000000a", name: "Partner A", publisher: "P" };
  const B = { id: "bbbbbbbb-0000-4000-8000-00000000000b", name: "Partner B", publisher: "P" };
  const pkg = (app: typeof A, dep?: typeof B) =>
    new Uint8Array(
      buildFakeAppWithEntries({
        "NavxManifest.xml": `<?xml version="1.0" encoding="utf-8"?><Package ${NS}><App Id="${app.id}" Name="${app.name}" Publisher="${app.publisher}" Version="1.0.0.0" />${
          dep === undefined
            ? ""
            : `<Dependencies><Dependency Id="${dep.id}" Name="${dep.name}" Publisher="${dep.publisher}" MinVersion="1.0.0.0" /></Dependencies>`
        }</Package>`,
        "src/X.al": `// ${app.name}`,
      }),
    );
  /** The test app depends on A, which depends on B: both partner apps, B transitive. */
  const root = {
    dependencies: [{ ...A, version: "1.0.0.0" }],
    application: undefined,
    platform: undefined,
    buildInputs: "",
  };
  const read = async (dep: { readonly id: string }) =>
    dep.id === A.id ? [pkg(A, B)] : dep.id === B.id ? [pkg(B)] : null;
  /** A server whose extensions endpoint answers the filtered id with one installed 1.0.0.0 row. */
  function server() {
    const urls: string[] = [];
    const fetchFn = (async (url: unknown) => {
      urls.push(String(url));
      const u = new URL(String(url));
      if (!u.pathname.includes("/extensions")) {
        return new Response(JSON.stringify({ value: [{ id: "c-1", name: "CRONUS Danmark A/S" }] }));
      }
      const id = (u.searchParams.get("$filter") ?? "").replace(/^id eq /, "");
      return new Response(
        JSON.stringify({
          value: [
            {
              id,
              isInstalled: true,
              versionMajor: 1,
              versionMinor: 0,
              versionBuild: 0,
              versionRevision: 0,
            },
          ],
        }),
      );
    }) as typeof fetch;
    return { urls, fetchFn };
  }
  const bytesMode = (installed: (id: string) => Promise<readonly string[]>): MicrosoftMode => {
    const base = fakeMicrosoftMode();
    if (base.kind !== "bytes") throw new Error("fakeMicrosoftMode is not bytes mode");
    return { ...base, installed };
  };

  // Allowed direction: if the guard refused every extensions read, this walk could not finish.
  test("every partner extension in the closure is read once, each by its own `id eq <GUID>`", async () => {
    const { urls, fetchFn } = server();
    const v = new HarnessVerifier(CFG, fetchFn);
    const fp = await dependencyFingerprint(
      root,
      read,
      bytesMode((id) => v.fetchInstalledVersions(id)),
    );
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    const ext = urls.filter((u) => u.toLowerCase().includes("extensions"));
    expect(ext.map((u) => new URL(u).searchParams.get("$filter")).sort()).toEqual([
      `id eq ${A.id}`,
      `id eq ${B.id}`,
    ]);
  });

  // Refused direction: an installed read that would go out unfiltered is refused before any request
  // and aborts the fingerprint with the typed error (it is not turned into "unproven").
  test("an installed read that is not filtered by one GUID is refused before it is sent, and propagates", async () => {
    const { urls, fetchFn } = server();
    const v = new HarnessVerifier(CFG, fetchFn);
    const err = await dependencyFingerprint(
      root,
      read,
      bytesMode(async () => {
        await rowsOf(v)(EXT, "extensions list");
        return ["1.0.0.0"];
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnfilteredExtensionsQueryError);
    expect(Object.getPrototypeOf(UnfilteredExtensionsQueryError.prototype)).toBe(Error.prototype);
    expect(urls.filter((u) => u.toLowerCase().includes("extensions"))).toEqual([]);
  });
});

describe("R-496 review: fetchApiRows never follows a redirect", () => {
  /** The unfiltered extensions URL, built from EXT so this file carries no unfiltered text. */
  const UNFILTERED = `http://bc:7048/BC/${EXT}?tenant=default`;

  /** Answers the FIRST request with a 302 to `location`; follows it as real fetch does unless the
   *  caller asked for `redirect: "manual"`, so a missing opt-out shows up as a second request. */
  function redirecting(location: string) {
    const urls: string[] = [];
    const fetchFn = (async (url: unknown, init?: RequestInit): Promise<Response> => {
      urls.push(String(url));
      if (urls.length === 1) {
        const r = new Response(null, { status: 302, headers: { location } });
        return init?.redirect === "manual" ? r : fetchFn(location, init);
      }
      return new Response(JSON.stringify({ value: [] }), { status: 200 });
    }) as typeof fetch;
    return { urls, fetchFn };
  }

  test("a filtered extensions read redirected to the unfiltered list throws the refusal, one request", async () => {
    const { urls, fetchFn } = redirecting(UNFILTERED);
    const err = await rowsOf(new HarnessVerifier(CFG, fetchFn))(EXT, "x", {
      $filter: `id eq ${GUID}`,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnfilteredExtensionsQueryError);
    expect(urls).toEqual([ALLOWED_URL]);
  });

  test("a companies read redirected to the unfiltered extensions list throws the refusal, one request", async () => {
    const { urls, fetchFn } = redirecting(UNFILTERED);
    await expect(new HarnessVerifier(CFG, fetchFn).fetchCompanies()).rejects.toBeInstanceOf(
      UnfilteredExtensionsQueryError,
    );
    expect(urls).toEqual(["http://bc:7048/BC/api/v2.0/companies?tenant=default"]);
  });

  test("a redirect to a harmless URL is not followed either, and fails as a transport error", async () => {
    const { urls, fetchFn } = redirecting("http://bc:7048/BC/api/v2.0/companies?tenant=other");
    await expect(new HarnessVerifier(CFG, fetchFn).fetchCompanies()).rejects.toBeInstanceOf(
      HarnessVerificationError,
    );
    expect(urls).toHaveLength(1);
  });
});

describe("R-496 review: no BC request follows a redirect (bc-fetch's refuseRedirects)", () => {
  const UNFILTERED = `http://bc:7048/BC/${EXT}?tenant=default`;
  const BCDEV_CFG = {
    mcpCommand: ["bun", "x", "bc-dev-mcp"],
    project: "/project",
    server: "http://bc",
    serverInstance: "BC",
    tenant: "default",
    packageCachePath: "/cache",
    controlSymbolPath: "/control.app",
    env: { BC_DEV_USER: "u", BC_DEV_PASSWORD: "p" },
  };
  const APP = { publisher: "Microsoft", name: "System" };

  /** Answers the FIRST request with `status` to `location`, and follows it as real fetch does
   *  unless `redirect: "manual"` was passed, so a missing opt-out shows up as a second request. */
  function autoFollowing(status: number, location: string) {
    const urls: string[] = [];
    const fetchFn = (async (url: unknown, init?: RequestInit): Promise<Response> => {
      urls.push(String(url));
      if (urls.length === 1) {
        const r = new Response(null, { status, headers: { location } });
        return init?.redirect === "manual" ? r : fetchFn(location, init);
      }
      return new Response(JSON.stringify({ value: [] }), { status: 200 });
    }) as typeof fetch;
    return { urls, fetchFn: refuseRedirects(fetchFn) };
  }

  for (const status of [302, 303]) {
    test(`HarnessInfo answered ${status} to the unfiltered extensions list throws the refusal, one request`, async () => {
      const { urls, fetchFn } = autoFollowing(status, UNFILTERED);
      const err = await new HarnessVerifier(CFG, fetchFn).checkReachable().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnfilteredExtensionsQueryError);
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain("/ODataV4/LethALControl_HarnessInfo");
    });

    test(`the dev-endpoint package download answered ${status} to the unfiltered extensions list throws the refusal, one request`, async () => {
      const { urls, fetchFn } = autoFollowing(status, UNFILTERED);
      const err = await new BcDevMcpBackend(BCDEV_CFG)
        .fetchPublishedAppPackage(APP, fetchFn)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnfilteredExtensionsQueryError);
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain("/dev/packages?");
    });

    test(`a companies read through the wrapper answered ${status} to the unfiltered list keeps the refusal's type`, async () => {
      const { urls, fetchFn } = autoFollowing(status, UNFILTERED);
      await expect(new HarnessVerifier(CFG, fetchFn).fetchCompanies()).rejects.toBeInstanceOf(
        UnfilteredExtensionsQueryError,
      );
      expect(urls).toHaveLength(1);
    });
  }

  test("a redirect to a harmless URL is not followed: the wrapper throws an ordinary error naming status and Location", async () => {
    const harmless = "http://bc:7048/BC/somewhere-else";
    const { urls, fetchFn } = autoFollowing(302, harmless);
    const err = await fetchFn("http://bc:7048/BC/ODataV4/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnfilteredExtensionsQueryError);
    expect(String(err)).toContain("HTTP 302");
    expect(String(err)).toContain(harmless);
    expect(urls).toHaveLength(1);
    // Through the callers: HarnessInfo fails as a transport error, the package read as "unreadable".
    const viaHarness = autoFollowing(303, harmless);
    await expect(
      new HarnessVerifier(CFG, viaHarness.fetchFn).checkReachable(),
    ).rejects.toBeInstanceOf(HarnessVerificationError);
    expect(viaHarness.urls).toHaveLength(1);
    const viaDev = autoFollowing(302, harmless);
    expect(
      await new BcDevMcpBackend(BCDEV_CFG).fetchPublishedAppPackage(APP, viaDev.fetchFn),
    ).toBeNull();
    expect(viaDev.urls).toHaveLength(1);
  });

  test("bcFetch itself, on a real socket: HarnessInfo's 303 to the unfiltered list is refused, the list never requested", async () => {
    const paths: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        paths.push(u.pathname);
        if (u.pathname.includes("HarnessInfo")) {
          return new Response(null, {
            status: 303,
            headers: { location: `/BC/${EXT}?tenant=default` },
          });
        }
        return new Response(JSON.stringify({ value: [] }), { status: 200 });
      },
    });
    try {
      const err = await new HarnessVerifier({
        ...CFG,
        baseUrl: `http://127.0.0.1:${server.port}/BC`,
      })
        .checkReachable()
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnfilteredExtensionsQueryError);
      expect(paths).toEqual(["/BC/ODataV4/LethALControl_HarnessInfo"]);
    } finally {
      server.stop(true);
    }
  });
});
