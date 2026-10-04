import { describe, expect, test } from "bun:test";
import type { ActivationConfig } from "../src/activation";
import {
  HarnessVerificationError,
  HarnessVerifier,
  UnfilteredExtensionsQueryError,
} from "../src/harness";

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
