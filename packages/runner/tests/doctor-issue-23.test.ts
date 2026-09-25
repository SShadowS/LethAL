import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivationConfig } from "../src/activation";
import { readSystemRuntime } from "../src/app-package";
import { checkAlcRuntime, checkTestApp } from "../src/doctor";
import { HarnessVerifier } from "../src/harness";
import { buildFakeAppWithEntries } from "./helpers/fake-app";

/**
 * Issue #23: doctor was green on a BC29 server with an alc 17 (every compile then failed with
 * AL1153), and on a server with no test app installed.
 */

const manifest = (name: string, version: string, runtime: string) =>
  `<Package xmlns="http://schemas.microsoft.com/navx/2015/manifest">
  <App Id="8874ed3a-0643-4247-9ced-7a7002f7135d" Name="${name}" Publisher="Microsoft" Version="${version}" Runtime="${runtime}" Target="OnPrem" />
</Package>`;

describe("readSystemRuntime", () => {
  test("reads the NEWEST Microsoft System package's Runtime, ignoring other apps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-sysrt-"));
    const app = (m: string) => buildFakeAppWithEntries({ "NavxManifest.xml": m });
    await writeFile(join(dir, "old.app"), app(manifest("System", "28.0.1.0", "17.0")));
    await writeFile(join(dir, "new.app"), app(manifest("System", "29.0.54226.0", "18.0")));
    await writeFile(
      join(dir, "sysapp.app"),
      app(manifest("System Application", "30.0.0.0", "19.0")),
    );
    expect(await readSystemRuntime(dir)).toBe("18.0");
  });
  test("absent cache or no System package is undefined, not a guess", async () => {
    expect(await readSystemRuntime(join(tmpdir(), "lethal-no-such-cache-xyz"))).toBeUndefined();
    const dir = await mkdtemp(join(tmpdir(), "lethal-sysrt-empty-"));
    expect(await readSystemRuntime(dir)).toBeUndefined();
  });
});

describe("checkAlcRuntime", () => {
  const base = { alcPath: "C:/alc.exe", cachePath: "C:/cache" };
  test("alc 17 against runtime 18 FAILS, naming both and the fix", () => {
    const c = checkAlcRuntime({ ...base, alcVersion: "17.0.29.1", systemRuntime: "18.0" });
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("server needs runtime 18.0");
    expect(c.detail).toContain("is 17.0");
    expect(c.detail).toContain("bcdev.alcPath");
  });
  test("an equal or newer alc passes", () => {
    expect(checkAlcRuntime({ ...base, alcVersion: "18.0.41.1", systemRuntime: "18.0" }).ok).toBe(
      true,
    );
    expect(checkAlcRuntime({ ...base, alcVersion: "18.0.41.1", systemRuntime: "17.0" }).ok).toBe(
      true,
    );
  });
  test("a minor below fails too", () => {
    expect(checkAlcRuntime({ ...base, alcVersion: "18.0.1.1", systemRuntime: "18.1" }).ok).toBe(
      false,
    );
  });
  test("an unreadable alc banner fails rather than passing", () => {
    expect(checkAlcRuntime({ ...base, alcVersion: "", systemRuntime: "18.0" }).ok).toBe(false);
  });
  test("no System symbols yet passes and SAYS nothing was compared", () => {
    const c = checkAlcRuntime({ ...base, alcVersion: "17.0.29.1" });
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("not compared");
  });
});

describe("checkTestApp", () => {
  test("installed passes; not published and published-but-uninstalled fail", () => {
    const p = { appId: "a", name: "Tests" };
    expect(checkTestApp({ ...p, installed: true, versions: ["1.0.0.1"] }).ok).toBe(true);
    const none = checkTestApp({ ...p, installed: false, versions: [] });
    expect(none.ok).toBe(false);
    expect(none.detail).toContain("not published");
    expect(none.detail).toContain("Publish the test app first");
    expect(
      checkTestApp({ ...p, installed: false, versions: ["1.0.0.1 (published, not installed)"] }).ok,
    ).toBe(false);
  });
});

describe("HarnessVerifier.fetchExtensionInstalled", () => {
  const CFG: ActivationConfig = {
    baseUrl: "http://bc:7048/BC",
    company: "CRONUS Danmark A/S",
    username: "u",
    password: "p",
    tenant: "default",
  };
  // Shapes measured on Cronus283 (BC 28.4), 2026-09-25.
  function fake(extensions: unknown[]) {
    const urls: string[] = [];
    const fetchFn = (async (url: unknown) => {
      urls.push(String(url));
      const body = String(url).includes("/extensions")
        ? { value: extensions }
        : { value: [{ id: "c-1", name: "CRONUS Danmark A/S" }] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    return { urls, fetchFn };
  }

  test("filters by app id in the configured company, and reads isInstalled", async () => {
    const { urls, fetchFn } = fake([
      {
        id: "app-1",
        isInstalled: true,
        versionMajor: 1,
        versionMinor: 0,
        versionBuild: 0,
        versionRevision: 17,
      },
    ]);
    const r = await new HarnessVerifier(CFG, fetchFn).fetchExtensionInstalled("app-1");
    expect(r).toEqual({ installed: true, versions: ["1.0.0.17"] });
    expect(urls[1]).toBe(
      "http://bc:7048/BC/api/microsoft/automation/v2.0/companies(c-1)/extensions?%24filter=id+eq+app-1&tenant=default",
    );
  });
  test("an empty list is not installed", async () => {
    const r = await new HarnessVerifier(CFG, fake([]).fetchFn).fetchExtensionInstalled("app-1");
    expect(r).toEqual({ installed: false, versions: [] });
  });
});
