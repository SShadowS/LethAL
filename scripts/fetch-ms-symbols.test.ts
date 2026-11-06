// R834: version choice and unpacking of fetch-ms-symbols, with an injected fetch (no network).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFakeAppWithEntries } from "../packages/runner/tests/helpers/fake-app.ts";
import {
  FEED_INDEX,
  type FetchFn,
  NoBuildForMajorError,
  PACKAGE_IDS,
  fetchSymbols,
  pickNewest,
} from "./fetch-ms-symbols";

const BASE = "https://feed.test/flat/";
const SYS = PACKAGE_IDS[2];

function fakeFeed(versionsOf: (id: string) => string[]): { fetchFn: FetchFn; urls: string[] } {
  const urls: string[] = [];
  const fetchFn: FetchFn = async (url) => {
    urls.push(url);
    if (url === FEED_INDEX) {
      return Response.json({
        resources: [
          { "@id": "https://feed.test/q/", "@type": "SearchQueryService/3.0.0-beta" },
          { "@id": BASE, "@type": "PackageBaseAddress/3.0.0" },
        ],
      });
    }
    if (url.endsWith("/index.json")) {
      const id = PACKAGE_IDS.find((p) => url === `${BASE}${p.toLowerCase()}/index.json`);
      return id === undefined
        ? new Response("no", { status: 404 })
        : Response.json({ versions: versionsOf(id) });
    }
    const m = /\/([^/]+)\/([^/]+)\/[^/]+\.nupkg$/.exec(url);
    if (m === null) return new Response("no", { status: 404 });
    // The .app inside is named after the package and version, so a wrong pick is visible.
    const body = buildFakeAppWithEntries({ [`${m[1]}_${m[2]}.app`]: "x" });
    return new Response(body);
  };
  return { fetchFn, urls };
}

describe("pickNewest", () => {
  test("compares number by number, so 28.0.9 is older than 28.0.10, and takes three-number versions", () => {
    expect(pickNewest(["29.0.1", "28.0.9", "28.0.10", "27.0.99999"], 28)).toBe("28.0.10");
    expect(pickNewest(["28.5.1.1", "28.10.0.0", "28.1.9.9"], 28)).toBe("28.10.0.0");
  });
  test("no build of the major gives undefined; a prerelease tag is ignored", () => {
    expect(pickNewest(["29.0.1", "27.0.1"], 28)).toBeUndefined();
    expect(pickNewest(["28.9.9-beta"], 28)).toBeUndefined();
  });
});

describe("fetchSymbols", () => {
  test("picks each package's own newest build, unpacks the .app, and names the System Application version", async () => {
    const { fetchFn } = fakeFeed((id) =>
      id === SYS
        ? ["29.0.1.1", "28.5.2.2", "28.4.9.9"]
        : id === PACKAGE_IDS[0]
          ? ["28.0.54265", "28.0.48590"]
          : ["28.5.2.3", "28.5.2.1"],
    );
    const out = mkdtempSync(join(tmpdir(), "lethal-fetch-sym-"));
    try {
      const r = await fetchSymbols(28, out, fetchFn);
      expect(r.bcVersion).toBe("28.5.2.2");
      const names = readdirSync(out).sort();
      expect(names).toHaveLength(PACKAGE_IDS.length);
      expect(names).toContain(`${SYS.toLowerCase()}_28.5.2.2.app`);
      expect(names).toContain(`${PACKAGE_IDS[0].toLowerCase()}_28.0.54265.app`);
      expect(readFileSync(join(out, names[0] ?? "")).length).toBeGreaterThan(0);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("a major with no build is refused by name before any package is downloaded", async () => {
    const { fetchFn, urls } = fakeFeed((id) => (id === SYS ? ["27.0.1.1"] : ["28.0.1.1"]));
    const out = mkdtempSync(join(tmpdir(), "lethal-fetch-sym-"));
    try {
      await expect(fetchSymbols(28, out, fetchFn)).rejects.toThrow(NoBuildForMajorError);
      expect(urls.some((u) => u.endsWith(".nupkg"))).toBe(false);
      expect(readdirSync(out)).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
