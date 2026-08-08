import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { MutantManifest } from "@lethal/schemata";
import type { DeploymentVerification, PublishOutcome } from "./deployment-verifier";
import { describeThrown } from "./describe-error";
import { defaultSpawn } from "./publisher";
import type { SpawnFn } from "./publisher";

/**
 * A deterministic compiler rejection: alc ran and said no. This is the ONLY error the bisection
 * predicate may read as "this subset does not compile". Everything else aborts the search.
 */
export class AlcCompileError extends Error {}

/** Any failure that is not a compiler verdict: spawn, I/O, manifest inconsistency. */
export class ArtifactPrepareError extends Error {}

/**
 * A deployment whose outcome is not `accepted`: the publish failed, or identity verification
 * could not confirm the server runs the artifact we just published. Critically NOT an
 * `AlcCompileError` — this is never a compiler verdict, so compile-failure bisection must
 * never read it as "this subset does not compile" (Task 7's bisection guard keys on that).
 *
 * The message embeds `publishError` verbatim so callers can machine-parse BC's rejection text
 * (see `parseVersionConflict` in app-version.ts) without reaching into fields.
 */
export class DeploymentError extends Error {
  constructor(
    readonly outcome: Exclude<PublishOutcome, "accepted">,
    readonly publishError: string | undefined,
    readonly verification: DeploymentVerification,
  ) {
    const publishPart =
      publishError === undefined ? "publish succeeded" : `publish failed: ${publishError}`;
    const verifyPart =
      verification.status === "accepted"
        ? "identity accepted"
        : verification.status === "mismatch"
          ? `identity mismatch: server reports artifact ${verification.reported}`
          : `identity unavailable: ${verification.detail}`;
    super(`deployment ${outcome}: ${publishPart}; ${verifyPart}`);
  }
}

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
  /**
   * R101(c) — AL preprocessor symbols to define for this compile, passed to `alc` as
   * `/define:A,B`. Empty or absent means NO symbol is defined, which is a real configuration and
   * not an unset one: it selects every `#else` branch.
   *
   * MEASURED 2026-08-09 (`scripts/r101c-define-probe/`), and the measurement is why this exists.
   * With a symbol undefined, `alc` does NOT fail — it compiles the OTHER branch, cleanly, and
   * emits a different artifact (3473 bytes vs 3505). So a project whose real build defines a
   * symbol LethAL does not pass is instrumented, mutated and SCORED on code the customer never
   * ships, and nothing anywhere says so. That silence is the whole defect; a loud failure would
   * have been harmless.
   *
   * Worse in this codebase specifically: the AST layer does not evaluate `#if` at all — tree-sitter
   * treats the directives as trivia — so `generateMutationSet` produces mutants in BOTH branches.
   * Whichever branch `alc` then drops takes its mutants with it, and they are deployed-but-
   * unreachable, landing as `survived`/`no-coverage`. Those verdicts read as statements about the
   * test suite and are not.
   *
   * Comma-separated in the argv. Semicolon was measured to work too; comma is chosen because it is
   * what al-runner's own `--preprocessor-symbols A,B,...` uses, and one spelling across both
   * compile paths is worth more than supporting two here.
   */
  readonly preprocessorSymbols?: readonly string[];
}

export interface ArtifactIo {
  readonly spawn: SpawnFn;
  readonly readArtifact: (path: string) => Promise<Uint8Array>;
  readonly writeArtifact: (from: string, to: string) => Promise<void>;
}

function toForwardSlashes(p: string): string {
  return p.replaceAll("\\", "/");
}

/**
 * Real-filesystem `ArtifactIo`: spawn the actual process, read the actual bytes, and MOVE
 * (rename) the scratch output to its final content-addressed path — same-directory rename, so
 * no cross-device concern, and no scratch copy left behind to be mistaken for an artifact.
 */
export const defaultArtifactIo: ArtifactIo = {
  spawn: defaultSpawn,
  readArtifact: async (path) => new Uint8Array(await readFile(path)),
  writeArtifact: async (from, to) => {
    await rename(from, to);
  },
};

export class ArtifactCompiler {
  constructor(
    private readonly cfg: ArtifactCompilerConfig,
    private readonly io: ArtifactIo,
  ) {}

  async compile(input: CompileInput): Promise<CompiledArtifact> {
    // Consistency is checked BEFORE any process is spawned or byte written: this needs no
    // I/O, and checking it after the artifact reached its final content-addressed path (as an
    // earlier revision did) would orphan a .app on disk for an input that was never coherent.
    if (input.mutantManifest.artifactId !== input.artifactId) {
      throw new ArtifactPrepareError(
        `manifest artifactId ${input.mutantManifest.artifactId} does not match ${input.artifactId}`,
      );
    }
    const scratch = toForwardSlashes(join(this.cfg.outputDir, `${input.artifactId}.app`));
    let res: { exitCode: number; stdout: string; stderr: string };
    try {
      const symbols = this.cfg.preprocessorSymbols ?? [];
      res = await this.io.spawn([
        this.cfg.alcPath,
        `/project:${toForwardSlashes(input.projectDir)}`,
        `/packagecachepath:${toForwardSlashes(this.cfg.packageCachePath)}`,
        // R101(c). Omitted entirely when nothing is configured, rather than sent empty: `/define:`
        // with no value is a different thing to say to a compiler than not saying it.
        ...(symbols.length > 0 ? [`/define:${symbols.join(",")}`] : []),
        `/out:${scratch}`,
      ]);
    } catch (err) {
      throw new ArtifactPrepareError(
        `could not run alc (${this.cfg.alcPath}): ${describeThrown(err)}`,
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
          `${describeThrown(err)}`,
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
        `could not place artifact at ${appPath}: ${describeThrown(err)}`,
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
