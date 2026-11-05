// Issue #29, part 1: `lethal doctor` reports app.json dependencies with no package in the cache.
import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildDoctorDeps } from "../src/cli";
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
) => checkDependencies({ cachePath: "/cache", dependencies, packages, unread });

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
  async function setup(
    appJson: Record<string, unknown>,
    cache: Record<string, Buffer | string>,
  ): Promise<Awaited<ReturnType<typeof buildDoctorDeps>>> {
    const project = scratch("lethal-doctor-deps-proj-");
    const cacheDir = scratch("lethal-doctor-deps-cache-");
    await writeFile(join(project, "app.json"), JSON.stringify(appJson));
    for (const [name, bytes] of Object.entries(cache)) await writeFile(join(cacheDir, name), bytes);
    return buildDoctorDeps(
      {
        bcdev: {
          mcpCommand: ["bun", "mcp"],
          company: "CRONUS",
          controlSymbolPath: "C:/lethal-control.app",
          packageCachePath: cacheDir,
          server: "https://host",
          serverInstance: "BC",
          username: "u",
          password: "p",
        },
      },
      {
        projectDir: project,
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

  test("without --project there is no dependencies check", async () => {
    const { deps } = await buildDoctorDeps(
      {
        bcdev: {
          mcpCommand: ["bun", "mcp"],
          company: "CRONUS",
          controlSymbolPath: "C:/lethal-control.app",
          packageCachePath: scratch("lethal-doctor-deps-cache-"),
          server: "https://host",
          serverInstance: "BC",
          username: "u",
          password: "p",
        },
      },
      { alToolPaths: async () => ({ alcPath: "alc", altoolPath: "altool" }) },
    );
    expect(deps.dependencies).toBeUndefined();
  });
});
