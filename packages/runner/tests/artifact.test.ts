import { describe, expect, it } from "bun:test";
import { AlcCompileError, ArtifactCompiler, ArtifactPrepareError } from "../src/artifact";
import type { CompiledArtifact } from "../src/artifact";
import { ContainerDeployer } from "../src/publisher";

const CFG = {
  alcPath: "alc",
  packageCachePath: "/cache",
  outputDir: "/out",
};

// Same shape as the inline object in the first test — reused by the tests that don't care
// about the exact ids, only about which error type surfaces.
const BASE_INPUT = {
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

describe("ArtifactCompiler", () => {
  it("returns a descriptor whose sha256 matches the produced bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const compiler = new ArtifactCompiler(CFG, {
      spawn: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      readArtifact: async () => bytes,
      writeArtifact: async () => {},
    });
    const art = await compiler.compile({
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
    });
    expect(art.sha256).toBe(Bun.SHA256.hash(bytes, "hex"));
    expect(art.appPath).toContain(art.sha256.slice(0, 16));
    expect(art.artifactId).toBe("0123456789abcdef0123456789abcdef");
  });

  it("throws a TYPED AlcCompileError on a compiler rejection", async () => {
    const compiler = new ArtifactCompiler(CFG, {
      spawn: async () => ({ exitCode: 1, stdout: "AL0118: unknown identifier", stderr: "" }),
      readArtifact: async () => new Uint8Array(),
      writeArtifact: async () => {},
    });
    await expect(compiler.compile(BASE_INPUT)).rejects.toBeInstanceOf(AlcCompileError);
  });

  it("throws ArtifactPrepareError — NOT AlcCompileError — when the compiler cannot be spawned", async () => {
    const compiler = new ArtifactCompiler(CFG, {
      spawn: async () => {
        throw new Error("ENOENT: alc not found");
      },
      readArtifact: async () => new Uint8Array(),
      writeArtifact: async () => {},
    });
    const err = await compiler.compile(BASE_INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArtifactPrepareError);
    expect(err).not.toBeInstanceOf(AlcCompileError);
  });

  it("throws ArtifactPrepareError when the output file is missing", async () => {
    const compiler = new ArtifactCompiler(CFG, {
      spawn: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      readArtifact: async () => {
        throw new Error("ENOENT");
      },
      writeArtifact: async () => {},
    });
    await expect(compiler.compile(BASE_INPUT)).rejects.toBeInstanceOf(ArtifactPrepareError);
  });

  it("throws ArtifactPrepareError when the manifest artifactId does not match the requested id", async () => {
    const bytes = new Uint8Array([9, 9, 9]);
    const compiler = new ArtifactCompiler(CFG, {
      spawn: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      readArtifact: async () => bytes,
      writeArtifact: async () => {},
    });
    await expect(
      compiler.compile({
        ...BASE_INPUT,
        artifactId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        mutantManifest: {
          ...BASE_INPUT.mutantManifest,
          artifactId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      }),
    ).rejects.toBeInstanceOf(ArtifactPrepareError);
  });

  it("passes /project, /packagecachepath and /out to alc with forward slashes", async () => {
    const bytes = new Uint8Array([5, 6, 7]);
    const calls: string[][] = [];
    const compiler = new ArtifactCompiler(
      {
        alcPath: "C:/ext/alc.exe",
        packageCachePath: "C:\\proj\\.alpackages",
        outputDir: "C:\\out",
      },
      {
        spawn: async (argv) => {
          calls.push([...argv]);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        readArtifact: async () => bytes,
        writeArtifact: async () => {},
      },
    );
    await compiler.compile({ ...BASE_INPUT, projectDir: "C:\\proj\\instrumented" });
    expect(calls[0]?.[0]).toBe("C:/ext/alc.exe");
    expect(calls[0]).toContain("/project:C:/proj/instrumented");
    expect(calls[0]).toContain("/packagecachepath:C:/proj/.alpackages");
  });
});

function fakeArtifact(overrides: Partial<CompiledArtifact> = {}): CompiledArtifact {
  return {
    artifactId: "0123456789abcdef0123456789abcdef",
    appId: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
    appVersion: "1.0.1.1",
    appPath: "C:/out/deadbeefdeadbeef-0123456789abcdef0123456789abcdef.app",
    sha256: Bun.SHA256.hash(new Uint8Array([1, 2, 3]), "hex"),
    mutantManifest: {
      selectorIds: { selectorId: 1, controlId: 2, tableId: 3 },
      artifactId: "0123456789abcdef0123456789abcdef",
      mutants: [],
    },
    appManifest: {},
    ...overrides,
  };
}

const DEPLOY_CFG = {
  altoolPath: "C:/ext/bin/altool.exe",
  server: "http://bcserver",
  serverInstance: "BC",
  username: "testuser",
  password: "testpass",
};

describe("ContainerDeployer.publish", () => {
  it("re-hashes the artifact bytes and refuses to publish on a digest mismatch", async () => {
    const artifact = fakeArtifact();
    const deployer = new ContainerDeployer(DEPLOY_CFG, {
      spawn: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      // Bytes on disk hash to something other than artifact.sha256 — simulates the file
      // having changed after compilation.
      readArtifact: async () => new Uint8Array([9, 9, 9, 9]),
    });
    await expect(deployer.publish(artifact)).rejects.toThrow(/digest/);
  });

  it("invokes altool publishapp with server params and ForceSync when the digest matches", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const artifact = fakeArtifact({ sha256: Bun.SHA256.hash(bytes, "hex") });
    const calls: string[][] = [];
    const deployer = new ContainerDeployer(DEPLOY_CFG, {
      spawn: async (argv) => {
        calls.push([...argv]);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      readArtifact: async () => bytes,
    });
    await deployer.publish(artifact);
    expect(calls[0]?.slice(0, 2)).toEqual(["C:/ext/bin/altool.exe", "publishapp"]);
    expect(calls[0]).toContain(artifact.appPath);
    expect(calls[0]?.join(" ")).toContain("ForceSync");
  });

  it("uses the verified altool flag spellings and explicit UserPassword auth", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const artifact = fakeArtifact({ sha256: Bun.SHA256.hash(bytes, "hex") });
    const calls: string[][] = [];
    const deployer = new ContainerDeployer(DEPLOY_CFG, {
      spawn: async (argv) => {
        calls.push([...argv]);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      readArtifact: async () => bytes,
    });
    await deployer.publish(artifact);
    const argv = calls[0] ?? [];
    expect(argv).toContain("--serverinstance");
    expect(argv).not.toContain("--serverInstance");
    expect(argv).toContain("--schemaupdatemode");
    expect(argv).not.toContain("--schemaSyncMode");
    expect(argv).toContain("--authentication");
    expect(argv[argv.indexOf("--authentication") + 1]).toBe("UserPassword");
    expect(argv).toContain("--environmenttype");
  });

  it("passes credentials as BC_SERVER_USERNAME/BC_SERVER_PASSWORD env vars, not CLI flags", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const artifact = fakeArtifact({ sha256: Bun.SHA256.hash(bytes, "hex") });
    const calls: string[][] = [];
    const envs: Array<Record<string, string> | undefined> = [];
    const deployer = new ContainerDeployer(DEPLOY_CFG, {
      spawn: async (argv, opts) => {
        calls.push([...argv]);
        envs.push(opts?.env);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      readArtifact: async () => bytes,
    });
    await deployer.publish(artifact);
    expect(envs[0]).toEqual({ BC_SERVER_USERNAME: "testuser", BC_SERVER_PASSWORD: "testpass" });
    expect(calls[0]).not.toContain("testuser");
    expect(calls[0]).not.toContain("testpass");
  });

  it("surfaces altool failure with stderr", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const artifact = fakeArtifact({ sha256: Bun.SHA256.hash(bytes, "hex") });
    const deployer = new ContainerDeployer(DEPLOY_CFG, {
      spawn: async () => ({ exitCode: 1, stdout: "", stderr: "publish rejected" }),
      readArtifact: async () => bytes,
    });
    await expect(deployer.publish(artifact)).rejects.toThrow("publish rejected");
  });
});
