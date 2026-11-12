// R886: the .NET sidecar: the config field, the `.gated` and manifest-row fields, and doctor.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlRunnerV3Backend } from "../src/al-runner-v3-backend";
import { V3_ISOLATION_DEFAULT, validateAlRunnerV3Config } from "../src/al-runner-v3-config";
import { AlRunnerV3UngatedBuildError, parseGated, sha256OfFile } from "../src/al-runner-v3-pin";
import { V3_BUILD_PINS, parseGatedBuilds } from "../src/al-runner-v3-pins";
import type { ArtifactIo } from "../src/artifact";
import { buildDoctorDeps } from "../src/cli";
import { runDoctor } from "../src/doctor";
import type { SpawnFn } from "../src/publisher";
import { buildFakeAppWithEntries } from "./helpers/fake-app";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const base = { packagesDir: "/p", bcVersion: "28.0.46665.47126" };

describe("R886: alRunnerV3.dotnetSidecar", () => {
  test("a path and false are accepted, absent stays absent", () => {
    expect(validateAlRunnerV3Config({ ...base, dotnetSidecar: "/x/a.dll" }).dotnetSidecar).toBe(
      "/x/a.dll",
    );
    expect(validateAlRunnerV3Config({ ...base, dotnetSidecar: false }).dotnetSidecar).toBe(false);
    expect("dotnetSidecar" in validateAlRunnerV3Config(base)).toBe(false);
  });
  test("true, an empty string and a number are refused by name", () => {
    for (const bad of [true, "", 3])
      expect(() => validateAlRunnerV3Config({ ...base, dotnetSidecar: bad })).toThrow(
        "al-runner-v3-config-refused",
      );
  });
});

describe("R890, R896: alRunnerV3.isolation", () => {
  test("auto, test and method are accepted, absent is auto (R896), anything else is refused by name", () => {
    expect(validateAlRunnerV3Config({ ...base, isolation: "method" }).isolation).toBe("method");
    expect(validateAlRunnerV3Config({ ...base, isolation: "test" }).isolation).toBe("test");
    expect(validateAlRunnerV3Config({ ...base, isolation: "auto" }).isolation).toBe("auto");
    expect(validateAlRunnerV3Config(base).isolation).toBe("auto");
    expect(V3_ISOLATION_DEFAULT).toBe("auto");
    for (const bad of ["codeunit", "Auto", "", true])
      expect(() => validateAlRunnerV3Config({ ...base, isolation: bad })).toThrow(
        "al-runner-v3-config-refused",
      );
  });
});

describe("R886: .gated and the manifest row", () => {
  const g = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      version: "v",
      binarySha256: sha("b"),
      lethalCommit: "a".repeat(40),
      ...over,
    });
  test(".gated: the sidecar and a note parse; a bad shape is a corrupt pin", () => {
    const ok = parseGated(
      g({
        dotnetSidecar: { file: "dotnet-sidecar/AlDotNetSidecar.dll", sha256: sha("d") },
        dotnetSidecarNote: "n",
      }),
      ".gated",
    );
    expect(ok.dotnetSidecar?.sha256).toBe(sha("d"));
    expect(ok.dotnetSidecarNote).toBe("n");
    expect(parseGated(g(), ".gated").dotnetSidecar).toBeUndefined();
    for (const bad of [
      { file: "a.dll", sha256: "xyz" },
      { file: "", sha256: sha("d") },
      { file: "../a.dll", sha256: sha("d") },
      { file: "/etc/a.dll", sha256: sha("d") },
      "a.dll",
    ])
      expect(() => parseGated(g({ dotnetSidecar: bad }), ".gated")).toThrow(
        AlRunnerV3UngatedBuildError,
      );
    expect(() => parseGated(g({ dotnetSidecarNote: 3 }), ".gated")).toThrow(
      AlRunnerV3UngatedBuildError,
    );
  });

  const HAND = new Set(V3_BUILD_PINS.map((p) => p.id));
  const row = (over: Record<string, unknown> = {}) => ({
    id: "edge-abc123456",
    track: "edge",
    version: "al-runner 3.0.0-alpha.13+edge.20261105 (abc123456)",
    binarySha256: sha("b"),
    readingsFrom: V3_BUILD_PINS[0]?.id,
    readingsDigest: sha("d"),
    lethalCommit: "a".repeat(40),
    gatedAt: "2026-11-05T00:00:00Z",
    ...over,
  });
  test("manifest row: the optional fields parse, bad ones refuse", () => {
    expect(
      parseGatedBuilds([row({ dotnetSidecarSha256: sha("d"), dotnetSidecarNote: "n" })], HAND),
    ).toHaveLength(1);
    expect(() => parseGatedBuilds([row({ dotnetSidecarSha256: "xyz" })], HAND)).toThrow(
      "dotnetSidecarSha256",
    );
    expect(() => parseGatedBuilds([row({ dotnetSidecarNote: "" })], HAND)).toThrow(
      "dotnetSidecarNote",
    );
  });
});

describe("R886: the session takes the pinned build's sidecar from its .gated", () => {
  const VERSION = "alrunner 3.0.0-alpha.2 (91253f2d6)";
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  const sidecarAfterStatus = async (extra: { dotnetSidecar?: false }) => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-r886-session-"));
    dirs.push(dir);
    const bin = join(dir, "al-runner");
    await writeFile(bin, "binary");
    await mkdir(join(dir, "dotnet-sidecar"));
    const dll = join(dir, "dotnet-sidecar", "AlDotNetSidecar.dll");
    await writeFile(dll, "dll");
    await writeFile(
      join(dir, ".gated"),
      JSON.stringify({
        version: VERSION,
        binarySha256: await sha256OfFile(bin),
        lethalCommit: "5eb544ef0aafeab402ac050e4a9e7481a8e67790",
        dotnetSidecar: { file: "dotnet-sidecar/AlDotNetSidecar.dll", sha256: sha("dll") },
      }),
    );
    await mkdir(join(dir, "deps"));
    await writeFile(
      join(dir, "deps", "Microsoft_System Application.app"),
      buildFakeAppWithEntries({
        "NavxManifest.xml": `<?xml version="1.0"?><Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="1" Name="System Application" Publisher="Microsoft" Version="28.0.46665.47126" /></Package>`,
      }),
    );
    const spawn: SpawnFn = async () => ({ exitCode: 0, stdout: `${VERSION}\n`, stderr: "" });
    const b = new AlRunnerV3Backend(
      {
        alRunnerPath: bin,
        environmentChoice: { value: "saas", source: "config" },
        instrumentedDir: join(dir, "scratch"),
        testDir: join(dir, "tests"),
        packagesDir: join(dir, "deps"),
        bcVersion: "28.0.46665.47126",
        selectorObjectId: 50000,
        alcPath: "/fake/alc",
        coverage: "none",
        ...extra,
      },
      spawn,
      {} as ArtifactIo,
    );
    // The contract probe after the pin check cannot run on this fake; the sidecar is set before it.
    await b.status().catch(() => undefined);
    return { got: (b as unknown as { sidecarPath?: string }).sidecarPath, dll };
  };
  test("the default is the row's file; false turns it off", async () => {
    const on = await sidecarAfterStatus({});
    expect(on.got).toBe(on.dll);
    expect((await sidecarAfterStatus({ dotnetSidecar: false })).got).toBeUndefined();
  });
});

describe("R886: doctor", () => {
  const VERSION = "alrunner 3.0.0-alpha.2 (91253f2d6)";
  const BC = "28.0.46665.47126";
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  const spawn: SpawnFn = async () => ({ exitCode: 0, stdout: `${VERSION}\n`, stderr: "" });
  async function check(sidecar: "ok" | "changed" | "missing" | "none", cfgExtra = {}) {
    const dir = await mkdtemp(join(tmpdir(), "lethal-r886-doctor-"));
    dirs.push(dir);
    const bin = join(dir, "al-runner");
    await writeFile(bin, "binary");
    const deps = join(dir, "deps");
    await mkdir(deps);
    await writeFile(
      join(deps, "Microsoft_System Application.app"),
      buildFakeAppWithEntries({
        "NavxManifest.xml": `<?xml version="1.0"?><Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="1" Name="System Application" Publisher="Microsoft" Version="${BC}" /></Package>`,
      }),
    );
    const file = "dotnet-sidecar/AlDotNetSidecar.dll";
    if (sidecar !== "none") {
      if (sidecar !== "missing") {
        await mkdir(join(dir, "dotnet-sidecar"));
        await writeFile(join(dir, file), sidecar === "ok" ? "dll" : "other");
      }
    }
    await writeFile(
      join(dir, ".gated"),
      JSON.stringify({
        version: VERSION,
        binarySha256: await sha256OfFile(bin),
        lethalCommit: "5eb544ef0aafeab402ac050e4a9e7481a8e67790",
        ...(sidecar !== "none" ? { dotnetSidecar: { file, sha256: sha("dll") } } : {}),
      }),
    );
    const d = await buildDoctorDeps(
      { alRunnerV3: { path: bin, packagesDir: deps, bcVersion: BC, ...cfgExtra } },
      { alRunnerSpawn: spawn },
    );
    const r = await runDoctor(d.cfg, d.deps);
    return r.checks[0];
  }
  test("the pinned sidecar is named; a missing, changed or absent one is a warning, never a fault", async () => {
    const ok = await check("ok");
    expect(ok?.ok).toBe(true);
    expect(ok?.detail).toContain("AlDotNetSidecar.dll");
    expect(ok?.detail).not.toContain("WARNING");
    for (const s of ["changed", "missing", "none"] as const) {
      const c = await check(s);
      expect(c?.ok).toBe(true);
      expect(c?.detail).toContain("WARNING");
    }
  });
  test("a named sidecar that does not exist is a fault", async () => {
    const c = await check("ok", { dotnetSidecar: "/nope/a.dll" });
    expect(c?.ok).toBe(false);
    expect(c?.detail).toContain("al-runner-v3-dotnet-sidecar-missing");
  });
});
