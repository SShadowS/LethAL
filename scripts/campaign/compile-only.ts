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
 *     --alc <path/to/alc.exe> --package-cache <dir>
 *
 * Exit 0 = validation passed AND alc produced an artifact. Any other exit is a gate-0 failure.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  parseCompileOnlyArgs,
} from "../../packages/runner/src/compile-only-args";
import { injectControlDependency } from "../../packages/runner/src/harness";
import {
  generateMutationSet,
  operatorTiers,
  prepareBatchProject,
  targetAppIdOf,
} from "../../packages/runner/src/orchestrator";
import { writeInstrumentedProject } from "../../packages/schemata/src/project";

export type { CompileOnlyArgs } from "../../packages/runner/src/compile-only-args";
export { parseCompileOnlyArgs } from "../../packages/runner/src/compile-only-args";

export async function compileOnly(args: CompileOnlyArgs): Promise<void> {
  // 1. The check --dry-run never reaches. Throws naming the offending id and range.
  await validateSelectorIdsForProject(args.projectDir, args.selectorIds);
  console.log(`[compile-only] selector ids validated against ${args.projectDir}/app.json`);

  // 2. Generate + instrument, exactly as a real run does.
  const set = await generateMutationSet(args.projectDir);
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
    await writeInstrumentedProject({
      targetDir: target,
      files: set.files,
      selectorIds: args.selectorIds,
      artifactId,
      targetAppId,
      operatorTiers,
    });
    // `writeInstrumentedProject` only wrote the files carrying >=1 mutant spec. `alc` needs the
    // WHOLE project — app.json plus every other source/resource file — so stamp and copy the
    // rest exactly as a real run's batch-prep step does (orchestrator.ts's `prepareBatchProject`;
    // it skips any basename `writeInstrumentedProject` already wrote, so the two never collide).
    await prepareBatchProject(args.projectDir, target, appManifest, String(appManifest.version));

    // The delegating selector schemata/project.ts just wrote always references
    // `Codeunit "LC Control State"` (packages/schemata/src/selector.ts), which resolves only
    // through a declared dependency on the LethAL Control app — never implied by the symbol
    // merely being present in the package cache. `injectControlDependency` (harness.ts) is the
    // same injection `BcDevMcpBackend.stageForCompile` (bcdev-backend.ts) applies to its own
    // throwaway sibling copy, for exactly this reason; `target` here is already our own private
    // temp dir, so the injection lands directly on it. Requires the caller's --package-cache to
    // already carry a staged `lethal-control.app` (the same requirement any real `lethal run`
    // against a bcdev backend has).
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
