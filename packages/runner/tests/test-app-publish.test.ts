import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPackageEntry } from "../src/app-package";
import { AlcCompileError, ArtifactCompiler } from "../src/artifact";
import type { BoundArtifact } from "../src/backend";
import { readAppIdentity } from "../src/published-test-app";
import { TestAppError, compileTestApp } from "../src/test-app-publish";
import { buildFakeAppWithEntries } from "./helpers/fake-app";

const TARGET_ID = "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a"; // fixtures/sandbox-app
const TESTS_ID = "ff7935bb-9fe2-4f7a-adf3-aa7132a41fe7"; // fixtures/sandbox-tests
const CONTROL_ID = "5e7a1c00-1111-4c00-8c00-1e7a1c000701"; // extensions/lethal-control
const SYSTEM_ID = "8874ed3a-0643-4247-9ced-7a7002f7135d";
const manifest = (id: string, name: string, version: string) =>
  `<?xml version="1.0" encoding="utf-8"?><Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="${id}" Name="${name}" Publisher="LethAL" Version="${version}" /></Package>`;
const pkg = (id: string, name: string, version: string, extra: Record<string, string> = {}) =>
  buildFakeAppWithEntries({ "NavxManifest.xml": manifest(id, name, version), ...extra });

async function fixture(
  alpackages: Record<string, Buffer>,
  appJson: Record<string, unknown> = {
    id: TESTS_ID,
    name: "LethAL Sandbox Tests",
    publisher: "LethAL",
    version: "1.0.0.2",
  },
) {
  const dir = await mkdtemp(join(tmpdir(), "c0205-"));
  await writeFile(join(dir, "app.json"), JSON.stringify(appJson));
  await mkdir(join(dir, ".alpackages"));
  for (const [f, b] of Object.entries(alpackages)) await writeFile(join(dir, ".alpackages", f), b);
  const targetPath = join(dir, "bound.app");
  const targetBytes = pkg(TARGET_ID, "LethAL Sandbox App", "1.0.20357.100", {
    "marker.txt": "INSTRUMENTED",
  });
  await writeFile(targetPath, targetBytes);
  const controlPath = join(dir, "control.app");
  await writeFile(controlPath, pkg(CONTROL_ID, "LethAL Control", "1.0.0.18"));
  const target: BoundArtifact = {
    appId: TARGET_ID,
    artifactId: "a".repeat(32),
    sha256: "b".repeat(64),
    appPath: targetPath,
    instrumentedDir: dir,
    appBytes: new Uint8Array(targetBytes),
    appJsonText: "{}",
    alSources: [],
  };
  return { dir, target, controlPath, out: await mkdtemp(join(tmpdir(), "c0205-out-")) };
}

/** A compiler whose alc records what is in the package cache it was handed. */
function watchingCompiler(
  out: string,
  seen: Array<{ id: string; marker: string | null }>,
  exitCode = 0,
  stdout = "",
) {
  return new ArtifactCompiler(
    { alcPath: "alc", packageCachePath: "UNUSED", outputDir: out },
    {
      spawn: async (argv) => {
        const cache = argv
          .find((x) => x.startsWith("/packagecachepath:"))
          ?.slice("/packagecachepath:".length);
        if (cache === undefined) throw new Error("no package cache in argv");
        for (const f of await readdir(cache)) {
          const b = await readFile(join(cache, f));
          seen.push({
            id: readAppIdentity(b).id,
            marker: readPackageEntry(b, "marker.txt")?.toString("utf8") ?? null,
          });
        }
        return { exitCode, stdout, stderr: "" };
      },
      readArtifact: async () => new TextEncoder().encode("compiled-test-app"),
      writeArtifact: async () => {},
    },
  );
}

test("compileTestApp compiles against the bound artifact, never the stale target copy in .alpackages", async () => {
  const fx = await fixture({
    "Microsoft_System_28.0.0.0.app": pkg(SYSTEM_ID, "System", "28.0.0.0"),
    "LethAL_LethAL Sandbox App_1.0.0.0.app": pkg(TARGET_ID, "LethAL Sandbox App", "1.0.0.0", {
      "marker.txt": "STALE",
    }),
    "LethAL_LethAL Control_1.0.0.17.app": pkg(CONTROL_ID, "LethAL Control", "1.0.0.17"),
  });
  const seen: Array<{ id: string; marker: string | null }> = [];
  const app = await compileTestApp({
    testDir: fx.dir,
    target: fx.target,
    compiler: watchingCompiler(fx.out, seen),
    controlSymbolPath: fx.controlPath,
  });
  expect(seen.filter((s) => s.id === TARGET_ID).map((s) => s.marker)).toEqual(["INSTRUMENTED"]);
  expect(seen.filter((s) => s.id === CONTROL_ID)).toHaveLength(1);
  expect(seen.some((s) => s.id === SYSTEM_ID)).toBe(true);
  expect(app).toMatchObject({
    appId: TESTS_ID,
    name: "LethAL Sandbox Tests",
    publisher: "LethAL",
    version: "1.0.0.2",
    compiledAgainst: { artifactId: fx.target.artifactId, sha256: fx.target.sha256 },
  });
});

test("compileTestApp: an alc rejection is TestAppError compile-failed, never AlcCompileError", async () => {
  const fx = await fixture({});
  const err = await compileTestApp({
    testDir: fx.dir,
    target: fx.target,
    controlSymbolPath: fx.controlPath,
    compiler: watchingCompiler(
      fx.out,
      [],
      1,
      `error AL0132: 'Codeunit "Sandbox Logic"' does not contain a definition for 'NoSuchProcedure'`,
    ),
  }).catch((e) => e);
  expect(err).toBeInstanceOf(TestAppError);
  expect(err).not.toBeInstanceOf(AlcCompileError);
  expect((err as TestAppError).reason).toBe("compile-failed");
  expect((err as TestAppError).message).toContain("AL0132");
});

test("compileTestApp refuses an .alpackages entry it cannot identify, naming the file", async () => {
  const fx = await fixture({ "mystery.app": Buffer.from("not a package") });
  await expect(
    compileTestApp({
      testDir: fx.dir,
      target: fx.target,
      compiler: watchingCompiler(fx.out, []),
      controlSymbolPath: fx.controlPath,
    }),
  ).rejects.toMatchObject({
    reason: "symbols-unreadable",
    message: expect.stringContaining("mystery.app"),
  });
});

test("compileTestApp refuses a test project whose app.json lacks a name", async () => {
  const fx = await fixture({}, { id: TESTS_ID, publisher: "LethAL", version: "1.0.0.2" });
  const seen: Array<{ id: string; marker: string | null }> = [];
  await expect(
    compileTestApp({
      testDir: fx.dir,
      target: fx.target,
      compiler: watchingCompiler(fx.out, seen),
      controlSymbolPath: fx.controlPath,
    }),
  ).rejects.toMatchObject({ reason: "manifest-unreadable" });
  expect(seen).toEqual([]);
});
