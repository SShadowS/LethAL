// R834: fetch-alc with an injected fetch and `which` (no network, no dotnet needed).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFakeAppWithEntries } from "../packages/runner/tests/helpers/fake-app.ts";
import {
  ALC_VERSION,
  DotnetMissingError,
  dotnetMajor,
  fetchAlc,
  platformRefusal,
  vsixUrl,
  wrapperText,
} from "./fetch-alc";

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

describe("platformRefusal", () => {
  test("refuses Windows by name", () => {
    expect(platformRefusal("win32")).toContain("On Windows, alc comes with");
  });

  test("lets Linux and macOS through", () => {
    expect(platformRefusal("linux")).toBeUndefined();
    expect(platformRefusal("darwin")).toBeUndefined();
  });
});

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
      expect(text).toContain(`exec '/opt/dotnet/dotnet' '${join(dir, "bin", "alc.dll")}' "$@"`);
      expect(text).toContain(`# alc from AL Language VSIX ${ALC_VERSION}`);
      // Windows has no execute bit (mode & 0o111 is 0 there); the wrapper is an sh script for Linux.
      if (process.platform !== "win32") expect(statSync(alc).mode & 0o111).not.toBe(0);
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
      expect(() => statSync(join(dir, "bin"))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the download is pinned to a stable version, not latest", async () => {
    const urls: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "lethal-fetch-alc-"));
    try {
      await fetchAlc(
        dir,
        async (u) => {
          urls.push(u);
          return feed();
        },
        () => "/d",
      );
      expect(urls).toEqual([vsixUrl(ALC_VERSION)]);
      expect(urls[0]).not.toContain("/latest/");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the wrapper sets DOTNET_ROOT to the real folder of the dotnet it found (a symlink is followed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lethal-fetch-alc-"));
    try {
      const alc = await fetchAlc(
        dir,
        feed,
        () => "/home/u/bin/dotnet",
        () => "/home/u/.dotnet/dotnet",
      );
      const text = readFileSync(alc, "utf8");
      expect(text).toContain("export DOTNET_ROOT='/home/u/.dotnet'\n");
      expect(text).toContain("exec '/home/u/bin/dotnet' ");
      expect(text.indexOf("export DOTNET_ROOT")).toBeLessThan(text.indexOf("exec "));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two alc versions give different wrapper bytes (the cache identity changes)", () => {
    expect(wrapperText("/d", "/a/alc.dll", "18.1.1")).not.toBe(
      wrapperText("/d", "/a/alc.dll", "18.1.2"),
    );
  });

  test("a hostile path in the wrapper stays text: quotes, dollar and backtick are quoted", () => {
    const t = wrapperText("/d", "/a/$(x)`y`\"z'w/alc.dll");
    expect(t).toContain(`'/a/$(x)\`y\`"z'\\''w/alc.dll'`);
  });

  test("an entry that climbs out of bin/ is refused and nothing is written", async () => {
    const evil = async () =>
      new Response(
        buildFakeAppWithEntries({
          "extension/bin/alc.dll": "dll",
          "extension/bin/alc.runtimeconfig.json": RC,
          "extension/bin/../../../escaped.txt": "x",
        }),
      );
    const dir = mkdtempSync(join(tmpdir(), "lethal-fetch-alc-"));
    try {
      await expect(fetchAlc(dir, evil, () => "/d")).rejects.toThrow(/outside bin/);
      expect(() => statSync(join(dir, "bin"))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
