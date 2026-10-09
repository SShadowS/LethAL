import { readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { FLAT_NAMES_FILENAME, type MutantManifest } from "@lethal/schemata";
import type { DeploymentVerification, PublishOutcome } from "./deployment-verifier";
import { describeThrown } from "./describe-error";
import { defaultSpawn } from "./publisher";
import type { SpawnFn } from "./publisher";

/**
 * R219: one line naming each file the batch wrote under a disambiguated flat name, or `undefined`
 * when it renamed none (no `FLAT_NAMES_FILENAME`).
 */
async function flatNamesNote(projectDir: string): Promise<string | undefined> {
  let sidecar: string;
  try {
    sidecar = await readFile(join(projectDir, FLAT_NAMES_FILENAME), "utf8");
  } catch {
    return undefined;
  }
  const pairs = Object.entries(JSON.parse(sidecar) as Record<string, string>)
    .map(([flat, project]) => `${flat} is ${project}`)
    .join("; ");
  return `files this batch wrote under a disambiguated flat name (R219): ${pairs}`;
}

/**
 * A deterministic compiler rejection: alc ran and said no. This is the ONLY error the bisection
 * predicate may read as "this subset does not compile". Everything else aborts the search.
 */
export class AlcCompileError extends Error {}

/** Any failure that is not a compiler verdict: spawn, I/O, manifest inconsistency. */
export class ArtifactPrepareError extends Error {}

/**
 * R461: alc rejected the batch's instrumented build, and then rejected LethAL's staged copy of the
 * UNMUTATED target too. States that observation and alc's own output, nothing more: staging stamps
 * `app.json`, flattens paths and rebases resources, so this claims neither broken source nor an
 * environment fault. Extends `Error` DIRECTLY: bisection reads only `AlcCompileError` as "this
 * subset does not compile", and this is not a subset answer.
 */
export class UnmutatedBuildFailedError extends Error {
  constructor(alcError: AlcCompileError) {
    super(
      `alc rejected LethAL's staged copy of the unmutated target, using this compiler and package cache. No mutant was in that build, so no mutant is blamed and the run stops here. alc's output:\n${alcError.message}`,
    );
    this.name = "UnmutatedBuildFailedError";
  }
}

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

/**
 * C02-04b: an ALREADY-installed artifact could not be bound to its recorded bytes and manifest,
 * or the server does not report it. Extends `Error` directly: it is neither a compiler verdict
 * (`AlcCompileError`, which bisection reads) nor a failed deployment (`DeploymentError`), since
 * nothing was compiled or published.
 */
export class InstalledArtifactError extends Error {
  constructor(
    readonly reason:
      | "no-record"
      | "local-copy-unreadable"
      | "local-copy-differs"
      | "manifest-differs"
      // R360: the stored installed files do not match the recorded payload digest, are over a
      // size limit, or were pruned when a later run finished.
      | "payload-differs"
      | "payload-too-large"
      | "replaced"
      | "mismatch"
      | "unavailable"
      | "unsupported",
    readonly detail: string,
  ) {
    super(`installed artifact refused (${reason}): ${detail}`);
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
  /**
   * R552: a second package-cache directory LethAL owns (the staged copy's `.lethal-symbols`, holding
   * `lethal-control.app`), sent after the configured cache in ONE `/packagecachepath:A;B`. alc
   * takes a `;`- or `,`-split list and resolves the highest version whatever the order (measured on
   * Linux alc 18.0.2732683; the Windows alc is unmeasured, R552). Absent: the argv is unchanged.
   */
  readonly extraPackageCachePath?: string;
}

/**
 * R552: the `/packagecachepath:` value for `compile`. With an extra path, a `;` or `,` in either
 * path is refused before any spawn: alc would split it silently and resolve symbols from a
 * directory nobody named. `ArtifactPrepareError`, never `AlcCompileError`: alc never ran.
 */
function packageCacheListOf(cache: string, extra: string | undefined): string {
  if (extra === undefined) return cache;
  for (const p of [cache, extra]) {
    if (/[;,]/.test(p)) {
      throw new ArtifactPrepareError(
        `package cache path ${p} contains ';' or ',', which alc reads as a list separator; LethAL refuses to pass it rather than let alc split it silently. Move the cache or the project to a path without them.`,
      );
    }
  }
  return `${cache};${extra}`;
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
    const { appPath, sha256 } = await this.alcToContentAddressed(
      input.projectDir,
      packageCacheListOf(this.cfg.packageCachePath, input.extraPackageCachePath),
      input.artifactId,
    );
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

  /**
   * Compiles a project that is not a mutation artifact (C02-05's test app): the same alc argv as
   * `compile`, R101(c)'s /define included, but against the caller's package cache and with no
   * manifest. Output is content-addressed in this compiler's outputDir: `<sha256[0:16]>-<name>.app`.
   */
  async compileProject(input: {
    readonly projectDir: string;
    readonly packageCachePath: string;
    readonly name: string;
  }): Promise<{ readonly appPath: string; readonly sha256: string }> {
    return this.alcToContentAddressed(input.projectDir, input.packageCachePath, input.name);
  }

  /** The alc spawn, read, hash and rename shared by `compile` and `compileProject`. */
  private async alcToContentAddressed(
    projectDir: string,
    packageCachePath: string,
    name: string,
  ): Promise<{ readonly appPath: string; readonly sha256: string }> {
    // R461: a scratch path this call alone owns, so the failure cleanup below can never delete a
    // concurrent same-name call's output or an earlier artifact whose file name is `${name}.app`.
    const scratch = toForwardSlashes(
      join(this.cfg.outputDir, `${name}.${crypto.randomUUID()}.partial.app`),
    );
    let res: { exitCode: number; stdout: string; stderr: string };
    try {
      const symbols = this.cfg.preprocessorSymbols ?? [];
      res = await this.io.spawn([
        this.cfg.alcPath,
        `/project:${toForwardSlashes(projectDir)}`,
        `/packagecachepath:${toForwardSlashes(packageCachePath)}`,
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
    try {
      return await this.placeOutput(res, scratch, name);
    } catch (err) {
      // R461: a failed compile or placement can leave alc's partial output; removed best-effort,
      // never masking the original error.
      await rm(scratch, { force: true }).catch(() => {});
      // R219: alc names a file by its flat name in the batch; one the batch renamed is named back.
      if (err instanceof AlcCompileError) {
        const note = await flatNamesNote(projectDir);
        if (note !== undefined) throw new AlcCompileError(`${err.message}\n${note}`);
      }
      throw err;
    }
  }

  private async placeOutput(
    res: { exitCode: number; stdout: string; stderr: string },
    scratch: string,
    name: string,
  ): Promise<{ readonly appPath: string; readonly sha256: string }> {
    if (res.exitCode !== 0) {
      // R461: BOTH streams, labelled. `stderr || stdout` let a stderr warning hide a stdout error.
      throw new AlcCompileError(
        `alc compile failed (exit ${res.exitCode}):\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
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
      join(this.cfg.outputDir, `${sha256.slice(0, 16)}-${name}.app`),
    );
    try {
      await this.io.writeArtifact(scratch, appPath);
    } catch (err) {
      throw new ArtifactPrepareError(
        `could not place artifact at ${appPath}: ${describeThrown(err)}`,
      );
    }
    return { appPath, sha256 };
  }
}
