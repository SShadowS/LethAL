import { describe, expect, test } from "bun:test";
import type { ActivationConfig } from "../src/activation";
import { HarnessVerificationError, HarnessVerifier } from "../src/harness";

/**
 * R-385 T1: `fetchInstalledVersions(appId)` returns the versions of an app's INSTALLED rows only,
 * read by id (R433), and looks the company up once per verifier: R-385 calls it for about 13
 * Microsoft apps per run and per verify.
 */

const A = "dd0be2ea-f733-4d65-bb34-a28f4624fb14";
const B = "23de40a6-dfe8-4f80-80db-d70f83ce8caf";

const CFG: ActivationConfig = {
  baseUrl: "http://bc:7048/BC",
  company: "CRONUS Danmark A/S",
  username: "u",
  password: "p",
};

const row = (v: [number, number, number, number], isInstalled: unknown) => ({
  versionMajor: v[0],
  versionMinor: v[1],
  versionBuild: v[2],
  versionRevision: v[3],
  isInstalled,
});

function fake(rows: Record<string, unknown[]>) {
  const counts = { companies: 0, extensions: 0 };
  const fetchFn = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("/extensions")) {
      counts.extensions += 1;
      const id = /id\+eq\+([0-9a-f-]+)/.exec(u)?.[1] ?? "";
      return new Response(JSON.stringify({ value: rows[id] ?? [] }), { status: 200 });
    }
    counts.companies += 1;
    return new Response(JSON.stringify({ value: [{ id: "c-1", name: "CRONUS Danmark A/S" }] }), {
      status: 200,
    });
  }) as typeof fetch;
  return { counts, fetchFn };
}

describe("HarnessVerifier.fetchInstalledVersions (R-385 T1)", () => {
  test("returns the installed rows' versions only, not a published-but-not-installed one", async () => {
    const f = fake({
      [A]: [row([28, 4, 1, 0], true), row([28, 5, 2, 0], false)],
    });
    const v = new HarnessVerifier(CFG, f.fetchFn);
    expect(await v.fetchInstalledVersions(A)).toEqual(["28.4.1.0"]);
  });

  test("an id with no rows returns no versions", async () => {
    const f = fake({});
    expect(await new HarnessVerifier(CFG, f.fetchFn).fetchInstalledVersions(A)).toEqual([]);
  });

  test("two installed rows are both returned (the caller refuses that)", async () => {
    const f = fake({ [A]: [row([28, 4, 1, 0], true), row([28, 4, 2, 0], true)] });
    expect(await new HarnessVerifier(CFG, f.fetchFn).fetchInstalledVersions(A)).toEqual([
      "28.4.1.0",
      "28.4.2.0",
    ]);
  });

  test("a malformed row throws rather than reading as absent", async () => {
    const bad = { versionMajor: "28", versionMinor: 4, versionBuild: 1, versionRevision: 0 };
    for (const r of [{ ...bad, isInstalled: true }, row([28, 4, 1, 0], "yes")]) {
      const f = fake({ [A]: [r] });
      await expect(
        new HarnessVerifier(CFG, f.fetchFn).fetchInstalledVersions(A),
      ).rejects.toBeInstanceOf(HarnessVerificationError);
    }
  });

  test("a non-GUID id is refused before any request", async () => {
    const f = fake({});
    await expect(
      new HarnessVerifier(CFG, f.fetchFn).fetchInstalledVersions("app-1"),
    ).rejects.toBeInstanceOf(HarnessVerificationError);
    expect(f.counts).toEqual({ companies: 0, extensions: 0 });
  });

  test("N calls read the companies list ONCE", async () => {
    const f = fake({ [A]: [row([28, 4, 1, 0], true)], [B]: [row([28, 4, 1, 0], true)] });
    const v = new HarnessVerifier(CFG, f.fetchFn);
    await v.fetchInstalledVersions(A);
    await v.fetchInstalledVersions(B);
    await v.fetchInstalledVersions(A);
    await v.fetchExtensionInstalled(B);
    expect(f.counts).toEqual({ companies: 1, extensions: 4 });
  });
});
