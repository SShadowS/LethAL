import { join } from "node:path";
import type { MutantManifest } from "@lethal/schemata";
import type { SpawnFn } from "./publisher";

/**
 * A deterministic compiler rejection: alc ran and said no. This is the ONLY error the bisection
 * predicate may read as "this subset does not compile". Everything else aborts the search.
 */
export class AlcCompileError extends Error {}

/** Any failure that is not a compiler verdict: spawn, I/O, hashing, manifest inconsistency. */
export class ArtifactPrepareError extends Error {}

export interface ArtifactCoverageMetadata {
  readonly methodIndexSource: string;
  readonly localProcedures: readonly string[];
}

export interface CompiledArtifact {
  readonly artifactId: string;
  readonly appId: string;
  readonly appVersion: string;
  /** Absolute, content-addressed, immutable once written. */
  readonly appPath: string;
  /** SHA-256 of the exact final .app bytes. Never embedded in the package. */
  readonly sha256: string;
  readonly mutantManifest: MutantManifest;
  readonly appManifest: Readonly<Record<string, unknown>>;
}

export interface CompileInput {
  readonly projectDir: string;
  readonly artifactId: string;
  readonly appId: string;
  readonly appVersion: string;
  readonly mutantManifest: MutantManifest;
  readonly appManifest: Readonly<Record<string, unknown>>;
}

export interface ArtifactCompilerConfig {
  readonly alcPath: string;
  readonly packageCachePath: string;
  readonly outputDir: string;
}

export interface ArtifactIo {
  readonly spawn: SpawnFn;
  readonly readArtifact: (path: string) => Promise<Uint8Array>;
  readonly writeArtifact: (from: string, to: string) => Promise<void>;
}

function toForwardSlashes(p: string): string {
  return p.replaceAll("\\", "/");
}

export class ArtifactCompiler {
  constructor(
    private readonly cfg: ArtifactCompilerConfig,
    private readonly io: ArtifactIo,
  ) {}

  async compile(input: CompileInput): Promise<CompiledArtifact> {
    const scratch = toForwardSlashes(join(this.cfg.outputDir, `${input.artifactId}.app`));
    let res: { exitCode: number; stdout: string; stderr: string };
    try {
      res = await this.io.spawn([
        this.cfg.alcPath,
        `/project:${toForwardSlashes(input.projectDir)}`,
        `/packagecachepath:${toForwardSlashes(this.cfg.packageCachePath)}`,
        `/out:${scratch}`,
      ]);
    } catch (err) {
      throw new ArtifactPrepareError(
        `could not run alc (${this.cfg.alcPath}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.exitCode !== 0) {
      throw new AlcCompileError(
        `alc compile failed (exit ${res.exitCode}):\n${res.stderr || res.stdout}`,
      );
    }

    let bytes: Uint8Array;
    try {
      bytes = await this.io.readArtifact(scratch);
    } catch (err) {
      throw new ArtifactPrepareError(
        `alc reported success but its output could not be read at ${scratch}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const sha256 = Bun.SHA256.hash(bytes, "hex");
    const appPath = toForwardSlashes(
      join(this.cfg.outputDir, `${sha256.slice(0, 16)}-${input.artifactId}.app`),
    );
    try {
      await this.io.writeArtifact(scratch, appPath);
    } catch (err) {
      throw new ArtifactPrepareError(
        `could not place artifact at ${appPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (input.mutantManifest.artifactId !== input.artifactId) {
      throw new ArtifactPrepareError(
        `manifest artifactId ${input.mutantManifest.artifactId} does not match ${input.artifactId}`,
      );
    }
    return {
      artifactId: input.artifactId,
      appId: input.appId,
      appVersion: input.appVersion,
      appPath,
      sha256,
      mutantManifest: input.mutantManifest,
      appManifest: input.appManifest,
    };
  }
}
