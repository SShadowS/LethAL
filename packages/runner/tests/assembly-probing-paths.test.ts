// R900: alc's assembly probing paths: resolution, refusals, argv, the AL0451 note, the fingerprint,
// the v3 test-app cache key and the doctor check. alc itself is not run here (CI has none); the
// offline alc proof is scripts/r900-probing-probe.ts.
import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { IDENTITY_SCHEME } from "@lethal/schemata";
import { testAppCacheKey } from "../src/al-runner-v3-testapp-cache";
import { AlcCompileError, ArtifactCompiler, type ArtifactCompilerConfig } from "../src/artifact";
import {
  AssemblyProbingPathMissingError,
  AssemblyProbingPathSeparatorError,
  resolveAssemblyProbingPaths,
} from "../src/assembly-probing-paths";
import { buildBackend, buildDoctorDeps, runFromCli } from "../src/cli";
import { runDoctor } from "../src/doctor";
import { sessionFingerprint } from "../src/resume";
import { buildFakeAppWithEntries } from "./helpers/fake-app";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();
const fwd = (p: string) => p.replaceAll("\\", "/");

async function project(opts: {
  settings?: string;
  netpackages?: boolean;
  dirs?: readonly string[];
}): Promise<string> {
  const dir = scratch("lethal-r900-");
  for (const d of opts.dirs ?? []) await mkdir(join(dir, d), { recursive: true });
  if (opts.netpackages === true) await mkdir(join(dir, ".netpackages"));
  if (opts.settings !== undefined) {
    await mkdir(join(dir, ".vscode"));
    await writeFile(join(dir, ".vscode", "settings.json"), opts.settings);
  }
  return dir;
}

describe("resolveAssemblyProbingPaths", () => {
  test("the config wins over the settings file and .netpackages; relative entries resolve against the project", async () => {
    const dir = await project({
      settings: '{ "al.assemblyProbingPaths": ["./fromSettings"] }',
      netpackages: true,
      dirs: ["asm/a", "fromSettings"],
    });
    const r = await resolveAssemblyProbingPaths(dir, ["asm/a", "./asm"]);
    expect(r).toEqual({
      paths: [fwd(join(dir, "asm", "a")), fwd(join(dir, "asm"))],
      source: "config",
    });
  });

  test("the settings file is read as JSON with comments and trailing commas, and wins over .netpackages", async () => {
    const dir = await project({
      settings:
        '{\n  // the AL extension\'s setting\n  "al.assemblyProbingPaths": [\n    "./dlls", /* comment */\n  ],\n  "al.other": "c://not-a-comment",\n}\n',
      netpackages: true,
      dirs: ["dlls"],
    });
    expect(await resolveAssemblyProbingPaths(dir, undefined)).toEqual({
      paths: [fwd(join(dir, "dlls"))],
      source: "vscode-settings",
    });
  });

  test("an empty list in the settings file means none, and is not replaced by .netpackages", async () => {
    const dir = await project({ settings: '{ "al.assemblyProbingPaths": [] }', netpackages: true });
    expect(await resolveAssemblyProbingPaths(dir, undefined)).toEqual({
      paths: [],
      source: "vscode-settings",
    });
  });

  test("a settings file without the key falls through to ./.netpackages, which is used only when it exists", async () => {
    const withNet = await project({ settings: '{ "editor.tabSize": 4 }', netpackages: true });
    expect(await resolveAssemblyProbingPaths(withNet, undefined)).toEqual({
      paths: [fwd(join(withNet, ".netpackages"))],
      source: "default",
    });
    const without = await project({ settings: '{ "editor.tabSize": 4 }' });
    expect(await resolveAssemblyProbingPaths(without, undefined)).toEqual({
      paths: [],
      source: "none",
    });
  });

  test("a missing folder is refused by name, from the config and from the settings file", async () => {
    const dir = await project({ settings: '{ "al.assemblyProbingPaths": ["./gone"] }' });
    const fromConfig = resolveAssemblyProbingPaths(dir, ["./nope"], "my.config.json");
    await expect(fromConfig).rejects.toBeInstanceOf(AssemblyProbingPathMissingError);
    await expect(fromConfig).rejects.toThrow(/my\.config\.json "assemblyProbingPaths".*"\.\/nope"/);
    const fromSettings = resolveAssemblyProbingPaths(dir, undefined);
    await expect(fromSettings).rejects.toBeInstanceOf(AssemblyProbingPathMissingError);
    await expect(fromSettings).rejects.toThrow(
      /settings\.json "al\.assemblyProbingPaths".*"\.\/gone"/,
    );
  });

  test("a file where a folder belongs is refused as missing", async () => {
    const dir = await project({});
    await writeFile(join(dir, "a.dll"), "x");
    await expect(resolveAssemblyProbingPaths(dir, ["a.dll"])).rejects.toBeInstanceOf(
      AssemblyProbingPathMissingError,
    );
  });

  test("a path holding alc's list separator (, or ;) is refused, even when the folder exists", async () => {
    const dir = await project({ dirs: ["a,b", "c;d"] });
    for (const entry of ["a,b", "c;d"]) {
      await expect(resolveAssemblyProbingPaths(dir, [entry])).rejects.toBeInstanceOf(
        AssemblyProbingPathSeparatorError,
      );
    }
  });

  test("a relative entry under a project folder holding a comma is refused (alc would split the resolved path)", async () => {
    const parent = await project({});
    const dir = join(parent, "a,b", "proj");
    await mkdir(join(dir, "libs"), { recursive: true });
    await expect(resolveAssemblyProbingPaths(dir, ["./libs"])).rejects.toBeInstanceOf(
      AssemblyProbingPathSeparatorError,
    );
  });

  test("an unreadable settings file that never mentions the key warns once and falls through", async () => {
    const dir = await project({ settings: '{ "editor.tabSize": 4 ', netpackages: true });
    const warned: string[] = [];
    const r = await resolveAssemblyProbingPaths(dir, undefined, "c", (l) => warned.push(l));
    expect(r).toEqual({ paths: [fwd(join(dir, ".netpackages"))], source: "default" });
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(join(dir, ".vscode", "settings.json"));
  });

  test("an unreadable settings file that mentions the key is refused by name", async () => {
    const dir = await project({
      settings: '{ "al.assemblyProbingPaths": ["./x" ',
      netpackages: true,
    });
    const warned: string[] = [];
    await expect(
      resolveAssemblyProbingPaths(dir, undefined, "c", (l) => warned.push(l)),
    ).rejects.toThrow(/settings\.json mentions assemblyProbingPaths/);
    expect(warned).toEqual([]);
  });

  test("a config value that is not a non-empty list of strings is refused", async () => {
    const dir = await project({});
    for (const bad of ["./x", [], [""], [3]]) {
      await expect(resolveAssemblyProbingPaths(dir, bad)).rejects.toThrow(/assemblyProbingPaths/);
    }
  });

  test("no fixture resolves any probing path, so no fixture's alc argv changes", async () => {
    const fixtures = resolve(import.meta.dir, "../../../fixtures");
    const projects = readdirSync(fixtures).filter((d) => existsSync(join(fixtures, d, "app.json")));
    expect(projects.length).toBeGreaterThan(10);
    for (const p of projects) {
      const r = await resolveAssemblyProbingPaths(join(fixtures, p), undefined);
      expect({ p, ...r }).toEqual({ p, paths: [], source: "none" });
    }
  });
});

const INPUT = {
  projectDir: "/proj",
  artifactId: "0123456789abcdef0123456789abcdef",
  appId: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
  appVersion: "1.0.1.1",
  mutantManifest: {
    selectorIds: { selectorId: 1, controlId: 2, tableId: 3 },
    artifactId: "0123456789abcdef0123456789abcdef",
    mutants: [],
  },
  appManifest: {},
};

function compilerSeeing(
  extra: Partial<ArtifactCompilerConfig>,
  result = { exitCode: 0, stdout: "", stderr: "" },
): { compiler: ArtifactCompiler; argv: string[][] } {
  const argv: string[][] = [];
  const compiler = new ArtifactCompiler(
    { alcPath: "alc", packageCachePath: "/cache", outputDir: "/out", ...extra },
    {
      spawn: async (a) => {
        argv.push([...a]);
        return result;
      },
      readArtifact: async () => new Uint8Array([1]),
      writeArtifact: async () => {},
    },
  );
  return { compiler, argv };
}

/** The argv with the per-call random scratch name removed. */
const stable = (a: readonly string[]) => a.map((x) => (x.startsWith("/out:") ? "/out:" : x));

describe("ArtifactCompiler and /assemblyprobingpaths", () => {
  test("absent or empty: exactly the argv of a compiler that never heard of the field", async () => {
    const plain = compilerSeeing({});
    const empty = compilerSeeing({ assemblyProbingPaths: [] });
    await plain.compiler.compile(INPUT);
    await empty.compiler.compile(INPUT);
    expect(stable(plain.argv[0] ?? [])).toEqual([
      "alc",
      "/project:/proj",
      "/packagecachepath:/cache",
      "/out:",
    ]);
    expect(stable(empty.argv[0] ?? [])).toEqual(stable(plain.argv[0] ?? []));
  });

  test("non-empty: one comma-joined flag, before /out, on compile and on compileProject", async () => {
    const { compiler, argv } = compilerSeeing({
      preprocessorSymbols: ["A"],
      assemblyProbingPaths: ["/p/one", "/p/two"],
    });
    await compiler.compile(INPUT);
    await compiler.compileProject({ projectDir: "/t", packageCachePath: "/c", name: "t" });
    for (const a of argv) {
      expect(stable(a).slice(3)).toEqual([
        "/define:A",
        "/assemblyprobingpaths:/p/one,/p/two",
        "/out:",
      ]);
    }
  });

  test("an AL0451 failure names the paths passed; other failures do not gain the line", async () => {
    const al0451 = {
      exitCode: 1,
      stdout:
        "X.al(3,14): error AL0451: An assembly named 'N' could not be found in the assembly probing paths ''",
      stderr: "",
    };
    const none = compilerSeeing({}, al0451).compiler.compile(INPUT);
    await expect(none).rejects.toBeInstanceOf(AlcCompileError);
    await expect(none).rejects.toThrow(/LethAL passed alc no assembly probing paths/);
    const some = compilerSeeing({ assemblyProbingPaths: ["/p/one"] }, al0451).compiler.compile(
      INPUT,
    );
    await expect(some).rejects.toThrow(/these assembly probing paths: \/p\/one/);
    const other = compilerSeeing({}, { exitCode: 1, stdout: "error AL0118: x", stderr: "" });
    const err = await other.compiler.compile(INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlcCompileError);
    expect((err as Error).message).not.toContain("probing");
  });

  test("R951: an ASP.NET Core assembly also names the shared-framework folder; any other assembly does not", async () => {
    const failing = (name: string) => ({
      exitCode: 1,
      stdout: `dotnet.al(9,3): error AL0451: An assembly named '${name}' could not be found in the assembly probing paths '/svc'`,
      stderr: "",
    });
    const asp = await compilerSeeing(
      { assemblyProbingPaths: ["/svc"] },
      failing("Microsoft.AspNetCore.StaticFiles"),
    )
      .compiler.compile(INPUT)
      .catch((e: unknown) => e);
    expect(asp).toBeInstanceOf(AlcCompileError);
    expect((asp as Error).message).toContain(
      "Microsoft.AspNetCore.StaticFiles is part of the ASP.NET Core shared framework",
    );
    expect((asp as Error).message).toContain(
      "<dotnet root>/shared/Microsoft.AspNetCore.App/<version>",
    );
    const other = await compilerSeeing({ assemblyProbingPaths: ["/svc"] }, failing("Contoso.Pdf"))
      .compiler.compile(INPUT)
      .catch((e: unknown) => e);
    expect(other).toBeInstanceOf(AlcCompileError);
    expect((other as Error).message).toContain("these assembly probing paths: /svc");
    expect((other as Error).message).not.toContain("ASP.NET Core");
  });
});

describe("digests", () => {
  const fp = (extra: { assemblyProbingPaths?: readonly string[] }) =>
    sessionFingerprint({
      projectDir: "/proj",
      testDir: "/t",
      backend: "bcdev",
      skipKnownSurvivors: false,
      identityScheme: IDENTITY_SCHEME,
      selectorIds: { selectorId: 1, controlId: 2, tableId: 3 },
      ...extra,
    });

  test("the resume fingerprint is unchanged with no paths, and moves with the list and its order", () => {
    expect(fp({ assemblyProbingPaths: [] })).toBe(fp({}));
    expect(fp({ assemblyProbingPaths: ["/a"] })).not.toBe(fp({}));
    expect(fp({ assemblyProbingPaths: ["/a", "/b"] })).not.toBe(
      fp({ assemblyProbingPaths: ["/b", "/a"] }),
    );
  });

  test("the v3 test-app cache key is unchanged with no paths, and moves with them", () => {
    const k = (extra: { assemblyProbingPaths?: readonly string[] }) =>
      testAppCacheKey({
        testDirHash: "a",
        testOtherSha: new Map([["app.json", "b"]]),
        testAppJsonSha256: "b",
        activeAppJson: "{}",
        symbolInterface: "{}",
        testHasExtensionObject: false,
        deps: [{ name: "x.app", sha256: "c" }],
        alcPath: "/alc",
        alcSha256: "d",
        preprocessorSymbols: [],
        transport: "one-shot",
        ...extra,
      });
    expect(k({ assemblyProbingPaths: [] })).toBe(k({}));
    expect(k({ assemblyProbingPaths: ["/a"] })).not.toBe(k({}));
  });
});

describe("buildBackend hands the resolved list to the bcdev compiler", () => {
  async function compilerPaths(dir: string, cfg: Record<string, unknown>) {
    await writeFile(
      join(dir, "app.json"),
      JSON.stringify({
        id: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
        idRanges: [{ from: 79000, to: 79199 }],
      }),
    );
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const b = await buildBackend(
        {
          mode: "run",
          projectDir: dir,
          testDir: dir,
          backendKind: "bcdev",
          dbPath: "db",
          configPath: "cfg",
          skipKnownSurvivors: false,
          workers: 1,
          keepEnv: false,
          allowExpiringEnv: false,
        } as Parameters<typeof buildBackend>[0],
        {
          bcdev: {
            mcpCommand: ["bun", "mcp"],
            server: "https://host",
            serverInstance: "BC",
            company: "CRONUS",
            username: "u",
            password: "p",
            packageCachePath: join(dir, "pkg"),
            controlSymbolPath: join(dir, "lethal-control.app"),
          },
          ...cfg,
        },
        dir,
        undefined,
        { alToolPaths: async () => ({ alcPath: "fake-alc", altoolPath: "fake-altool" }) },
        { selectorId: 79199, controlId: 79198, tableId: 79197 },
      );
      return (
        b as unknown as {
          deployment: { compiler: { cfg: ArtifactCompilerConfig } };
        }
      ).deployment.compiler.cfg.assemblyProbingPaths;
    } finally {
      warn.mockRestore();
    }
  }

  test("./.netpackages reaches the compiler; nothing resolved leaves the field unset", async () => {
    const withNet = await project({ netpackages: true });
    expect(await compilerPaths(withNet, {})).toEqual([fwd(join(withNet, ".netpackages"))]);
    expect(await compilerPaths(await project({}), {})).toBeUndefined();
  });

  // v3 refuses every platform but Linux before it builds anything.
  const linuxOnly = test.if(process.platform === "linux");
  linuxOnly("al-runner-v3: the list reaches its alc compiler too", async () => {
    const dir = await project({ netpackages: true });
    await writeFile(
      join(dir, "app.json"),
      JSON.stringify({
        id: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
        idRanges: [{ from: 79000, to: 79199 }],
        runtime: "17.0",
      }),
    );
    const BC = "28.0.46665.47126";
    const deps = join(dir, "deps");
    await mkdir(deps);
    await writeFile(
      join(deps, "Microsoft_System Application.app"),
      buildFakeAppWithEntries({
        "NavxManifest.xml": `<?xml version="1.0"?><Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="1" Name="System Application" Publisher="Microsoft" Version="${BC}" /></Package>`,
      }),
    );
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const b = await buildBackend(
        {
          mode: "run",
          projectDir: dir,
          testDir: dir,
          backendKind: "al-runner-v3",
          dbPath: "db",
          configPath: "cfg",
          skipKnownSurvivors: false,
          workers: 1,
          keepEnv: false,
          allowExpiringEnv: false,
        } as Parameters<typeof buildBackend>[0],
        {
          alRunnerV3: {
            environment: "saas", // R938
            path: "/fake/al-runner",
            packagesDir: deps,
            bcVersion: BC,
            alcPath: "/fake/alc",
            cacheDir: join(dir, "cache"),
          },
        },
        dir,
        undefined,
        { alcRunnable: () => true },
        { selectorId: 79199, controlId: 79198, tableId: 79197 },
      );
      const cfg = (b as unknown as { compiler: { cfg: ArtifactCompilerConfig } }).compiler.cfg;
      expect(cfg.assemblyProbingPaths).toEqual([fwd(join(dir, ".netpackages"))]);
    } finally {
      warn.mockRestore();
    }
  });

  test("a missing config folder is refused before the backend is built", async () => {
    await expect(
      compilerPaths(await project({}), { assemblyProbingPaths: ["./missing"] }),
    ).rejects.toBeInstanceOf(AssemblyProbingPathMissingError);
  });
});

describe("runFromCli resolves the paths before any env-tool provisioning", () => {
  test("a missing probing folder is refused with zero env-tool calls", async () => {
    const proj = await project({});
    const cfgDir = await project({});
    const configPath = join(cfgDir, "lethal.config.json");
    await writeFile(configPath, JSON.stringify({ assemblyProbingPaths: ["./missing"] }));
    let envToolCalls = 0;
    let builds = 0;
    await expect(
      runFromCli(
        {
          mode: "run",
          projectDir: proj,
          testDir: join(cfgDir, "tests"),
          backendKind: "bcdev",
          dbPath: "db",
          configPath,
          skipKnownSurvivors: false,
          workers: 1,
          keepEnv: false,
          allowExpiringEnv: false,
        },
        {
          validateSelectorIdsForProject: async () => {},
          resolveEnvToolSession: async () => {
            envToolCalls += 1;
            return { effectiveConfig: {} };
          },
          buildBackend: async () => {
            builds += 1;
            throw new Error("not reached");
          },
        },
      ),
    ).rejects.toBeInstanceOf(AssemblyProbingPathMissingError);
    expect({ envToolCalls, builds }).toEqual({ envToolCalls: 0, builds: 0 });
  });
});

describe("doctor: assembly-probing-paths", () => {
  const BCDEV = {
    server: "https://host",
    serverInstance: "env-4711",
    username: "admin",
    password: "pw",
    mcpCommand: ["bun", "mcp"],
    company: "CRONUS",
    controlSymbolPath: "/lethal-control.app",
    packageCachePath: "/no/such/pkg",
  };

  async function check(cfg: Record<string, unknown>, projectDir: string | undefined) {
    const d = await buildDoctorDeps(
      { bcdev: BCDEV, ...cfg },
      projectDir === undefined ? {} : { projectDir },
    );
    const { assemblyProbingPaths } = d.deps;
    if (assemblyProbingPaths === undefined) return undefined;
    return (await runDoctor({}, { assemblyProbingPaths })).checks;
  }

  test("ok, naming the list and its source", async () => {
    const dir = await project({ netpackages: true });
    const checks = await check({}, dir);
    expect(checks?.map((c) => [c.name, c.ok])).toEqual([["assembly-probing-paths", true]]);
    expect(checks?.[0]?.detail).toBe(`${fwd(join(dir, ".netpackages"))} (from default)`);
  });

  test("ok and says none when nothing resolves", async () => {
    const checks = await check({}, await project({}));
    expect(checks?.[0]?.ok).toBe(true);
    expect(checks?.[0]?.detail).toMatch(/^none \(/);
  });

  test("FAIL naming a missing folder", async () => {
    const checks = await check({ assemblyProbingPaths: ["./missing"] }, await project({}));
    expect(checks?.[0]?.ok).toBe(false);
    expect(checks?.[0]?.detail).toContain('"./missing"');
  });

  test("no --project: no check", async () => {
    expect(await check({}, undefined)).toBeUndefined();
  });
});
