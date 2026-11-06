// R834: fetch-alc with an injected fetch and `which` (no network, no dotnet needed).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFakeAppWithEntries } from "../packages/runner/tests/helpers/fake-app.ts";
import { DotnetMissingError, dotnetMajor, fetchAlc } from "./fetch-alc";

const RC = JSON.stringify({
  runtimeOptions: { framework: { name: "Microsoft.NETCore.App", version: "10.0.0" } },
});
const vsix = () =>
  buildFakeAppWithEntries({
    "extension/bin/alc.dll": "dll",
    "extension/bin/alc.runtimeconfig.json": RC,
    "extension/bin/sub/other.dll": "x",
    "extension/package.json": "{}",
  });
const feed = async () => new Response(vsix());

describe("dotnetMajor", () => {
  test("reads the major from the runtimeconfig", () => {
    expect(dotnetMajor(RC)).toBe("10");
    expect(() => dotnetMajor("{}")).toThrow(/no framework version/);
  });
});

describe("fetchAlc", () => {
  test("unpacks extension/bin and writes an executable wrapper naming dotnet and alc.dll", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lethal-fetch-alc-"));
    try {
      const alc = await fetchAlc(dir, feed, () => "/opt/dotnet/dotnet");
      expect(alc).toBe(join(dir, "alc"));
      expect(readFileSync(join(dir, "bin", "sub", "other.dll"), "utf8")).toBe("x");
      const text = readFileSync(alc, "utf8");
      expect(text).toContain(`exec "/opt/dotnet/dotnet" "${join(dir, "bin", "alc.dll")}" "$@"`);
      expect(statSync(alc).mode & 0o111).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no dotnet on PATH is refused by name with the major, and writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lethal-fetch-alc-"));
    try {
      const p = fetchAlc(dir, feed, () => null);
      await expect(p).rejects.toThrow(DotnetMissingError);
      await expect(fetchAlc(dir, feed, () => null)).rejects.toThrow(/\.NET 10/);
      expect(() => statSync(join(dir, "alc"))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
