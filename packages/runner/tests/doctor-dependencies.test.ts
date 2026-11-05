// Issue #29, part 1: `lethal doctor` reports app.json dependencies with no package in the cache.
import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildDoctorDeps, renderDoctorReport } from "../src/cli";
import { checkDependencies, runDoctor } from "../src/doctor";
import { buildFakeAppWithEntries } from "./helpers/fake-app";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();

const DEP_ID = "11111111-1111-1111-1111-111111111111";
const dep = (version: string, id = DEP_ID) => ({
  id,
  name: "MDep",
  publisher: "MP",
  version,
});
const probe = (
  dependencies: ReturnType<typeof dep>[],
  packages: { id: string; version: string }[],
  unread: string[] = [],
  downloadsSymbols = false,
) => checkDependencies({ cachePath: "/cache", downloadsSymbols, dependencies, packages, unread });

describe("checkDependencies", () => {
  test("a dependency with a matching package reads ok", () => {
    const c = probe([dep("1.2.0.0")], [{ id: DEP_ID, version: "1.2.0.0" }]);
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("equal or higher");
  });

  test("a dependency with no package fails, names it, and says the rule", () => {
    const c = probe(
      [dep("1.2.0.0")],
      [{ id: "22222222-2222-2222-2222-222222222222", version: "9.0.0.0" }],
    );
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("MP MDep 1.2.0.0");
    expect(c.detail).toContain("AL1022");
    expect(c.detail).toContain("equal or higher");
  });

  test("a package older than the declared version reads as missing and names what it found", () => {
    const c = probe([dep("1.2.0.0")], [{ id: DEP_ID, version: "1.1.9.9" }]);
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("only 1.1.9.9");
  });

  test("a higher version, even of a higher major, is compatible (alc 18.1, measured)", () => {
    expect(probe([dep("1.2.0.0")], [{ id: DEP_ID, version: "1.2.0.5" }]).ok).toBe(true);
    expect(probe([dep("1.2.0.0")], [{ id: DEP_ID, version: "2.0.0.0" }]).ok).toBe(true);
  });

  test("versions compare as numbers, not as text", () => {
    expect(probe([dep("1.9.0.0")], [{ id: DEP_ID, version: "1.10.0.0" }]).ok).toBe(true);
  });

  test("the id matches without regard to case; the name is not compared", () => {
    const c = probe([dep("1.0.0.0", DEP_ID.toUpperCase())], [{ id: DEP_ID, version: "1.0.0.0" }]);
    expect(c.ok).toBe(true);
  });

  test("one missing among several fails and names only the missing one", () => {
    const other = "33333333-3333-3333-3333-333333333333";
    const c = probe(
      [dep("1.0.0.0"), { ...dep("1.0.0.0", other), name: "Gone" }],
      [{ id: DEP_ID, version: "1.0.0.0" }],
    );
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("Gone");
    expect(c.detail).not.toContain("MDep");
  });

  test("unreadable cache files are listed when something is missing", () => {
    const c = probe([dep("1.0.0.0")], [], ["broken.app"]);
    expect(c.detail).toContain("broken.app");
    expect(c.detail).toContain("may fail");
    expect(probe([dep("1.0.0.0")], []).detail).toContain("will fail");
  });

  test("downloadSymbols: a gap is skipped; a clean cache is still plainly ok", () => {
    const gap = probe([dep("1.0.0.0")], [], [], true);
    expect(gap.skipped).toBe(true);
    expect(gap.ok).toBe(true);
    expect(
      probe([dep("1.0.0.0")], [{ id: DEP_ID, version: "1.0.0.0" }], [], true).skipped,
    ).toBeUndefined();
  });

  test("a skip reason is reported as a skipped check", () => {
    const c = checkDependencies({ skip: "because" });
    expect(c).toMatchObject({ ok: true, skipped: true });
    expect(c.detail).toContain("because");
  });
});

const manifest = (id: string, name: string, version: string) =>
  `<Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="${id}" Name="${name}" Publisher="MP" Version="${version}"/></Package>`;
const plain = (id: string, name: string, version: string) =>
  buildFakeAppWithEntries({ "NavxManifest.xml": manifest(id, name, version) });
const wrapper = (id: string, name: string, version: string) =>
  buildFakeAppWithEntries({
    "readytorunappmanifest.json": JSON.stringify({ EmbeddedAppId: id }),
    [`${id}_${version}.app`]: plain(id, name, version),
  });

describe("lethal doctor reads the target's dependencies from the real cache folder", () => {
  interface Over {
    /** Raw app.json text, in place of `appJson` (a BOM test). */
    readonly rawAppJson?: string;
    readonly noProject?: boolean;
    /** A cache path that is a regular file: reading it fails with something other than ENOENT. */
    readonly cacheIsFile?: boolean;
    /** A cache path that does not exist. */
    readonly absentCache?: boolean;
    /** `null`: the config names no packageCachePath at all. */
    readonly noCachePath?: boolean;
    /** Declares envTool.downloadSymbols. */
    readonly downloadSymbols?: boolean;
  }

  async function setup(
    appJson: Record<string, unknown>,
    cache: Record<string, Buffer | string>,
    over: Over = {},
  ): Promise<Awaited<ReturnType<typeof buildDoctorDeps>>> {
    const project = scratch("lethal-doctor-deps-proj-");
    const cacheDir =
      over.absentCache || over.cacheIsFile
        ? join(scratch("lethal-doctor-deps-cache-"), "not-there")
        : scratch("lethal-doctor-deps-cache-");
    if (over.cacheIsFile) await writeFile(cacheDir, "i am a file, not a folder");
    await writeFile(join(project, "app.json"), over.rawAppJson ?? JSON.stringify(appJson));
    for (const [name, bytes] of Object.entries(cache)) {
      await mkdir(dirname(join(cacheDir, name)), { recursive: true });
      await writeFile(join(cacheDir, name), bytes);
    }
    const bcdev = {
      mcpCommand: ["bun", "mcp"],
      company: "CRONUS",
      controlSymbolPath: "C:/lethal-control.app",
      // Connection fields come from the env tool's resolve steps when one is declared.
      ...(over.downloadSymbols
        ? {}
        : { server: "https://host", serverInstance: "BC", username: "u", password: "p" }),
      ...(over.noCachePath ? {} : { packageCachePath: cacheDir }),
    };
    return buildDoctorDeps(
      {
        bcdev,
        ...(over.downloadSymbols
          ? {
              envTool: {
                toolPath: "tool.exe",
                envId: "env-4711",
                resolve: [
                  { command: ["env", "get", "{envId}"], reads: { baseUrl: "url" } },
                  { command: ["env", "users", "{envId}"], reads: { username: "u", password: "p" } },
                ],
                publish: { command: ["publish", "{envId}", "{appFile}"] },
                downloadSymbols: { command: ["env", "download-symbols", "{envId}"] },
              },
            }
          : {}),
      },
      {
        ...(over.noProject ? {} : { projectDir: project }),
        alToolPaths: async () => ({ alcPath: "alc", altoolPath: "altool" }),
        alcSpawn: async () => ({
          exitCode: 0,
          stdout: "AL Compiler version 18.0.1.1\n",
          stderr: "",
        }),
      },
    );
  }
  const app = { dependencies: [{ id: DEP_ID, name: "MDep", publisher: "MP", version: "1.2.0.0" }] };

  async function check(deps: Promise<Awaited<ReturnType<typeof buildDoctorDeps>>>) {
    const { deps: d } = await deps;
    const dependencies = d.dependencies;
    if (dependencies === undefined) throw new Error("buildDoctorDeps gave no dependencies probe");
    const report = await runDoctor(
      {},
      { dependencies, toolPaths: async () => ({ alc: "a", altool: "b" }) },
    );
    return report.checks.find((c) => c.name === "dependencies");
  }

  test("present: found by the manifest, whatever the file is called", async () => {
    const c = await check(
      setup(app, { "totally-unrelated-name.app": plain(DEP_ID, "MDep", "1.2.0.0") }),
    );
    expect(c?.ok).toBe(true);
  });

  test("present inside a Ready-to-Run wrapper", async () => {
    const c = await check(setup(app, { "w.app": wrapper(DEP_ID, "MDep", "1.3.0.0") }));
    expect(c?.ok).toBe(true);
  });

  test("absent: the dependency fails, even with a file that merely LOOKS like it", async () => {
    const other = "44444444-4444-4444-4444-444444444444";
    const c = await check(setup(app, { "MP_MDep_1.2.0.0.app": plain(other, "Other", "1.2.0.0") }));
    expect(c?.ok).toBe(false);
    expect(c?.detail).toContain("MP MDep 1.2.0.0");
  });

  test("too old: fails", async () => {
    const c = await check(setup(app, { "d.app": plain(DEP_ID, "MDep", "1.0.0.0") }));
    expect(c?.ok).toBe(false);
  });

  test("a cache folder with no packages at all fails the dependency", async () => {
    const c = await check(setup(app, {}));
    expect(c?.ok).toBe(false);
  });

  test("a malformed app.json dependency is a FAIL with a message, never a quiet pass", async () => {
    const c = await check(setup({ dependencies: [{ name: "NoId", version: "1.0.0.0" }] }, {}));
    expect(c?.ok).toBe(false);
    expect(c?.detail).toContain("no string id");
  });

  test("without --project the check is SKIPPED, by name, never silent", async () => {
    const c = await check(setup(app, {}, { noProject: true }));
    expect(c?.skipped).toBe(true);
    expect(c?.ok).toBe(true);
    expect(c?.detail).toContain("--project");
  });

  test("a config with no packageCachePath is SKIPPED, by name", async () => {
    const c = await check(setup(app, {}, { noCachePath: true, downloadSymbols: true }));
    expect(c?.skipped).toBe(true);
    expect(c?.detail).toContain("packageCachePath");
  });

  test("the issue's command (no --project) renders a skipped line in the banner", async () => {
    const { deps } = await setup(app, {}, { noProject: true });
    const dependencies = deps.dependencies;
    if (dependencies === undefined) throw new Error("buildDoctorDeps gave no dependencies probe");
    const report = await runDoctor(
      {},
      { dependencies, toolPaths: async () => ({ alc: "a", altool: "b" }) },
    );
    expect(renderDoctorReport(report)).toContain("[skip] dependencies");
  });

  test("a package in a SUBFOLDER of the cache counts (alc searches subfolders)", async () => {
    const c = await check(setup(app, { "deep/er/d.app": plain(DEP_ID, "MDep", "1.2.0.0") }));
    expect(c?.ok).toBe(true);
  });

  test("a cache folder that does not exist fails the dependency", async () => {
    const c = await check(setup(app, {}, { absentCache: true }));
    expect(c?.ok).toBe(false);
    expect(c?.skipped).toBeUndefined();
    // Failed because the dependency is MISSING, not because reading the folder threw.
    expect(c?.detail).toContain("no compatible package");
  });

  test("the older `appId` spelling is read", async () => {
    const old = {
      dependencies: [{ appId: DEP_ID, name: "MDep", publisher: "MP", version: "1.2.0.0" }],
    };
    expect((await check(setup(old, { "d.app": plain(DEP_ID, "MDep", "1.2.0.0") })))?.ok).toBe(true);
    expect((await check(setup(old, {})))?.ok).toBe(false);
  });

  test("a broken .app beside a good one: the good one counts and the broken one is listed", async () => {
    const files = { "good.app": plain(DEP_ID, "MDep", "1.2.0.0"), "broken.app": "not a package" };
    expect((await check(setup(app, files)))?.ok).toBe(true);
    const other = "55555555-5555-5555-5555-555555555555";
    const c = await check(
      setup(app, { "good.app": plain(other, "X", "1.0.0.0"), "broken.app": "not a package" }),
    );
    expect(c?.ok).toBe(false);
    expect(c?.detail).toContain("broken.app");
    expect(c?.detail).toContain("may fail");
  });

  test("with envTool.downloadSymbols a gap is skipped, not failed; with nothing missing it is ok", async () => {
    const gap = await check(setup(app, {}, { downloadSymbols: true }));
    expect(gap?.skipped).toBe(true);
    expect(gap?.ok).toBe(true);
    expect(gap?.detail).toContain("run doctor again");
    const full = await check(
      setup(app, { "d.app": plain(DEP_ID, "MDep", "1.2.0.0") }, { downloadSymbols: true }),
    );
    expect(full?.ok).toBe(true);
    expect(full?.skipped).toBeUndefined();
  });

  test("a UTF-8 BOM at the start of app.json is read", async () => {
    const raw = `﻿${JSON.stringify(app)}`;
    const c = await check(
      setup(app, { "d.app": plain(DEP_ID, "MDep", "1.2.0.0") }, { rawAppJson: raw }),
    );
    expect(c?.ok).toBe(true);
  });

  test("a two-part dependency version names the dependency and the file", async () => {
    const two = { dependencies: [{ id: DEP_ID, name: "MDep", publisher: "MP", version: "1.2" }] };
    const c = await check(setup(two, {}));
    expect(c?.ok).toBe(false);
    expect(c?.detail).toContain('"MDep"');
    expect(c?.detail).toContain("app.json");
  });

  test("no dependencies: ok, and no package is read (a broken .app does not matter)", async () => {
    const c = await check(setup({ dependencies: [] }, { "broken.app": "not a package" }));
    expect(c?.ok).toBe(true);
    expect(c?.detail).toContain("no dependencies");
  });

  test("no dependencies reads nothing, so even an unreadable cache path is ok", async () => {
    const c = await check(setup({ dependencies: [] }, {}, { cacheIsFile: true }));
    expect(c?.ok).toBe(true);
  });

  test("only an ABSENT cache folder reads as empty; any other read failure surfaces", async () => {
    const c = await check(setup(app, {}, { cacheIsFile: true }));
    expect(c?.ok).toBe(false);
    expect(c?.detail).not.toContain("no compatible package");
  });

  test("the ok line says only direct dependencies were checked", async () => {
    const c = await check(setup(app, { "d.app": plain(DEP_ID, "MDep", "1.2.0.0") }));
    expect(c?.detail).toContain("direct");
  });
});
