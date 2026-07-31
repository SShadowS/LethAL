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

  // R65. A Bun spawn ENOENT carries an EMPTY `message`; the diagnosis lives on `code`/`path`/
  // `syscall`. Stringifying `err.message` alone produced a bare `Error` with no text — which is
  // how R64's wrong-platform binary presented, and why it took a long external session to trace.
  // The fake below reproduces that exact shape: message "", errno fields populated.
  // The configured path ("alc") and the errno path ("/ext/bin/linux/alc") are DELIBERATELY
  // different — the OS reports what it resolved, the config holds what the user wrote. Asserting
  // on a path the surrounding message already interpolates would pass whether or not the errno
  // fields were surfaced at all.
  it("names the OS error code and the failing binary when the spawn fails with an EMPTY message", async () => {
    const compiler = new ArtifactCompiler(CFG, {
      spawn: async () => {
        throw Object.assign(new Error(""), {
          code: "ENOENT",
          syscall: "spawn",
          path: "/ext/bin/linux/alc",
        });
      },
      readArtifact: async () => new Uint8Array(),
      writeArtifact: async () => {},
    });
    const err = await compiler.compile(BASE_INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArtifactPrepareError);
    const message = (err as Error).message;
    expect(message).toContain("ENOENT");
    expect(message).toContain("/ext/bin/linux/alc");
    // The operation still names itself — the code is added detail, not a replacement.
    expect(message).toContain("could not run alc");
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
    let spawnCallCount = 0;
    const compiler = new ArtifactCompiler(CFG, {
      spawn: async () => {
        spawnCallCount++;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
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
    // Fail-fast: the manifest-consistency check runs BEFORE alc is ever spawned (see
    // ArtifactCompiler.compile), same pattern as ContainerDeployer's digest-mismatch test above.
    expect(spawnCallCount).toBe(0);
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
    let spawnCallCount = 0;
    const deployer = new ContainerDeployer(DEPLOY_CFG, {
      spawn: async () => {
        spawnCallCount++;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      // Bytes on disk hash to something other than artifact.sha256 — simulates the file
      // having changed after compilation.
      readArtifact: async () => new Uint8Array([9, 9, 9, 9]),
    });
    await expect(deployer.publish(artifact)).rejects.toThrow(/digest/);
    expect(spawnCallCount).toBe(0);
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

  // R65, second catch site. Same empty-message spawn ENOENT, same silent catch — a missing exec
  // bit on bin/linux/altool, a pinned `bcdev.altoolPath` typo, or a partial install all land here.
  it("names the OS error code when altool cannot be spawned at all (EMPTY-message ENOENT)", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const artifact = fakeArtifact({ sha256: Bun.SHA256.hash(bytes, "hex") });
    // `altoolPath` is overridden to a bare name here so the errno `path` is a DIFFERENT string
    // from the one the `(altoolPath: …)` suffix already prints — otherwise the path assertion
    // below passes whether or not the errno fields reach the message.
    const deployer = new ContainerDeployer(
      { ...DEPLOY_CFG, altoolPath: "altool.exe" },
      {
        spawn: async () => {
          throw Object.assign(new Error(""), {
            code: "EACCES",
            syscall: "spawn",
            path: "C:/ext/bin/win32/altool.exe",
          });
        },
        readArtifact: async () => bytes,
      },
    );
    const err = await deployer.publish(artifact).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("EACCES");
    expect(message).toContain("C:/ext/bin/win32/altool.exe");
    expect(message).toContain("altool publishapp failed");
  });

  // Regression (Task 8, verified live against Cronus281 2026-07-20): on a real version-conflict
  // rejection, altool prints only a generic wrapper to stderr ("Publish failed: Publish
  // operation failed. Check the output for details.") while BC's actual, machine-parseable
  // rejection text ("Cannot install the extension ... because a newer version X was already
  // installed.") — the exact text `parseVersionConflict` needs — lands on STDOUT. The original
  // `res.stderr || res.stdout` silently discarded stdout whenever stderr was non-empty, which
  // broke the version-conflict retry path (orchestrator.ts) for every real publish failure.
  it("includes BOTH stdout and stderr in the thrown error, not just whichever is non-empty first", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const artifact = fakeArtifact({ sha256: Bun.SHA256.hash(bytes, "hex") });
    const deployer = new ContainerDeployer(DEPLOY_CFG, {
      spawn: async () => ({
        exitCode: 1,
        stdout:
          "Cannot install the extension LethAL Sandbox App by LethAL 1.0.1.1 because a newer " +
          "version 1.0.106.0 was already installed.",
        stderr: "Publish failed: Publish operation failed. Check the output for details.",
      }),
      readArtifact: async () => bytes,
    });
    const err = await deployer.publish(artifact).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("newer version 1.0.106.0 was already installed");
    expect(message).toContain("Publish operation failed");
  });
});
