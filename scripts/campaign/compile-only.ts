/**
 * Validate selector ids, generate the mutation set, write the instrumented project, and compile
 * it with `alc` — stopping before any publish.
 *
 * Exists because gate 0 of the DO campaign has to exercise the selector-id path, and nothing
 * shipped does: `--dry-run` returns before `validateSelectorIdsForProject`, and a real `lethal
 * run` cannot stop before publishing. Without this, gate 0 would declare the plumbing sound and
 * hand rung 1 the first execution of the id path.
 *
 *   bun scripts/campaign/compile-only.ts --project <dir> \
 *     --selector-id <n> --control-id <n> --table-id <n> \
 *     --alc <path/to/alc.exe> --package-cache <dir> \
 *     --control-symbol <path/to/lethal-control.app> [--config <lethal.config.json>]
 *
 * `--config` (default `<project>/lethal.config.json`, as `lethal run`) supplies the
 * `preprocessorSymbols` a real run builds with, for both enumeration and alc (R379).
 *
 * `--control-symbol` is staged into `--package-cache` here, exactly as
 * `BcDevMcpBackend.stageForCompile` does for a real run — so gate 0 imposes no setup step that a
 * real `lethal run` does not.
 *
 * Exit 0 = validation passed AND alc produced an artifact. Any other exit is a gate-0 failure.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactCompiler, defaultArtifactIo } from "../../packages/runner/src/artifact";
import { validateSelectorIdsForProject } from "../../packages/runner/src/cli";
// Parsing lives in packages/runner/src, not here — see that file's doc comment for why
// (packages/runner/tests needs to import it, and packages/runner/tsconfig.json's composite
// rootDir can't reach into scripts/). Re-exported so this stays the interface callers of the
// script expect.
import {
  type CompileOnlyArgs,
  compileOnlyMutationSet,
  parseCompileOnlyArgs,
} from "../../packages/runner/src/compile-only-args";
import { injectControlDependency } from "../../packages/runner/src/harness";
import {
  batchFlatNames,
  identityOrdinalsOf,
  operatorTiers,
  prepareBatchProject,
  targetAppIdOf,
} from "../../packages/runner/src/orchestrator";
import { writeInstrumentedProject } from "../../packages/schemata/src/project";

export type { CompileOnlyArgs } from "../../packages/runner/src/compile-only-args";
export { parseCompileOnlyArgs } from "../../packages/runner/src/compile-only-args";

/**
 * The batch a compile-only check compiles, written as a real run writes it: the instrumented files,
 * then app.json and every other source and resource file (`prepareBatchProject`, which skips any
 * flat name `writeInstrumentedProject` already wrote). R219 (sol run 001): ONE flat-name map
 * (`batchFlatNames`) for both writers. A map over `set.files` alone would name an instrumented
 * duplicate by its plain basename while the copy named both originals by their folders, and alc
 * would see that file twice. R-422: `prepareBatchProject` also writes `/` for `\` in app.json's
 * logo, screenshots and resourceFolders and returns what it changed; ignored here on purpose (a
 * compile-only tool has no run to warn through, and the normalised app.json is what it needs).
 */
export async function stageCompileOnlyBatch(input: {
  readonly projectDir: string;
  readonly target: string;
  readonly set: Awaited<ReturnType<typeof compileOnlyMutationSet>>["set"];
  readonly selectorIds: CompileOnlyArgs["selectorIds"];
  readonly artifactId: string;
  readonly targetAppId: string;
  readonly appManifest: Record<string, unknown>;
}): Promise<void> {
  const flatNames = await batchFlatNames(input.projectDir);
  await writeInstrumentedProject({
    targetDir: input.target,
    files: input.set.files,
    identityOrdinals: identityOrdinalsOf(input.set),
    selectorIds: input.selectorIds,
    artifactId: input.artifactId,
    targetAppId: input.targetAppId,
    operatorTiers,
    flatNames,
  });
  await prepareBatchProject(
    input.projectDir,
    input.target,
    input.appManifest,
    String(input.appManifest.version),
    undefined,
    [],
    flatNames,
  );
}

export async function compileOnly(args: CompileOnlyArgs): Promise<void> {
  // 1. The check --dry-run never reaches. Throws naming the offending id and range.
  await validateSelectorIdsForProject(args.projectDir, args.selectorIds);
  console.log(`[compile-only] selector ids validated against ${args.projectDir}/app.json`);

  // 2. Generate + instrument, exactly as a real run does: under the config's preprocessor symbols
  //    plus app.json's (R379).
  const { set, configSymbols } = await compileOnlyMutationSet(args);
  const specCount = set.files.reduce((n, f) => n + f.specs.length, 0);
  console.log(
    `[compile-only] ${set.totalFiles} .al file(s), ${set.files.length} instrumentable, ${specCount} raw spec(s)`,
  );

  const appManifest = JSON.parse(
    await readFile(join(args.projectDir, "app.json"), "utf8"),
  ) as Record<string, unknown>;
  // Throws naming the missing field rather than letting `String(appManifest.id)` silently
  // coerce an absent id into the literal string "undefined" (orchestrator.ts's own
  // `prepareArtifactDir` validates the same way, for the same reason).
  const targetAppId = targetAppIdOf(appManifest);
  const artifactId = randomBytes(16).toString("hex");
  const target = await mkdtemp(join(tmpdir(), "lethal-compile-only-"));
  const outputDir = await mkdtemp(join(tmpdir(), "lethal-compile-only-out-"));

  try {
    await stageCompileOnlyBatch({
      projectDir: args.projectDir,
      target,
      set,
      selectorIds: args.selectorIds,
      artifactId,
      targetAppId,
      appManifest,
    });

    // The delegating selector schemata/project.ts just wrote always references
    // `Codeunit "LC Control State"` (packages/schemata/src/selector.ts), which resolves only
    // through a declared dependency on the LethAL Control app — never implied by the symbol
    // merely being present in the package cache. `injectControlDependency` (harness.ts) is the
    // same injection `BcDevMcpBackend.stageForCompile` (bcdev-backend.ts) applies to its own
    // throwaway sibling copy, for exactly this reason; `target` here is already our own private
    // temp dir, so the injection lands directly on it.
    //
    // The DEPENDENCY needs the SYMBOL: alc resolves the declared dependency out of the package
    // cache, so both halves have to be present. `stageForCompile` does both (`cp(controlSymbolPath,
    // join(packageCachePath, "lethal-control.app"))`, bcdev-backend.ts), so this driver does too —
    // an earlier version injected the dependency and left the staging to the caller, described as
    // "the same requirement any real `lethal run` has". It is not: no other path imposes it, and
    // on a hard gate the operator would have met it as an unexplained alc symbol-resolution
    // failure.
    if (!existsSync(args.controlSymbolPath)) {
      throw new Error(
        `compile-only: --control-symbol ${args.controlSymbolPath} does not exist. Build the LethAL Control extension first (the /control-app skill); a missing symbol would surface as an alc symbol-resolution error with no hint about its cause.`,
      );
    }
    await mkdir(args.packageCachePath, { recursive: true });
    await cp(args.controlSymbolPath, join(args.packageCachePath, "lethal-control.app"));
    console.log(`[compile-only] staged lethal-control.app into ${args.packageCachePath}`);

    const targetAppJsonPath = join(target, "app.json");
    const stagedManifest = JSON.parse(await readFile(targetAppJsonPath, "utf8")) as Record<
      string,
      unknown
    >;
    const compiledManifest = injectControlDependency(stagedManifest);
    await writeFile(targetAppJsonPath, `${JSON.stringify(compiledManifest, null, 2)}\n`, "utf8");

    const mutantManifest = JSON.parse(await readFile(join(target, "mutant-manifest.json"), "utf8"));

    // 3. alc. An AlcCompileError here means the instrumented source does not compile — which is
    //    the thing gate 0 exists to find, including AL0297 if validation were ever bypassed.
    const compiler = new ArtifactCompiler(
      {
        alcPath: args.alcPath,
        packageCachePath: args.packageCachePath,
        outputDir,
        // R379: alc builds under the config's symbols too, as a real run's compile does.
        ...(configSymbols.length > 0 ? { preprocessorSymbols: configSymbols } : {}),
      },
      defaultArtifactIo,
    );
    const artifact = await compiler.compile({
      projectDir: target,
      artifactId,
      appId: targetAppId,
      appVersion: String(compiledManifest.version),
      mutantManifest,
      appManifest: compiledManifest,
    });
    console.log(
      `[compile-only] OK — instrumented project compiled, artifact ${artifactId} (${JSON.stringify(
        Object.keys(artifact),
      )})`,
    );
  } finally {
    await rm(target, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await compileOnly(parseCompileOnlyArgs(process.argv.slice(2)));
}
