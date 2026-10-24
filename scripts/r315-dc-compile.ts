/**
 * R315: compile a real corpus's INSTRUMENTED target offline with alc, next to a negative control.
 *
 *   bun scripts/r315-dc-compile.ts <project-dir> <symbols-dir> <out-dir> [--control-symbol <app>]
 *
 * Instruments <project-dir> as a real run does (`compileOnlyMutationSet`, `stageCompileOnlyBatch`,
 * then the LethAL Control dependency and a package-cache copy holding `lethal-control.app`), keeps
 * the emitted project under <out-dir>/instrumented, and compiles it against <symbols-dir>. The
 * negative control is the UN-instrumented original, compiled against the same symbols. An error in
 * the control is the environment's (a missing symbol, a version gap); an error only in the
 * instrumented compile is LethAL's emit. Logs and summary.json go to <out-dir>; the summary holds
 * codes, file names and line numbers only, never source text.
 *
 * R735: `--isolate <bad> [--keep <n>]` runs the real isolation (`isolateAndNote`) instead. It thins
 * the spec set to `--keep` (default 2000) at a fixed stride, corrupts `<bad>` of them at a fixed
 * stride (alternating a syntax fault and a binding fault, `R735Undefined`, AL0118), and checks that
 * isolation names exactly those sites. `summary.isolation` holds the figures.
 *
 * <project-dir> and <symbols-dir> are only read. Selector ids: the top three ids of the project's
 * last app.json idRange unless `--selector-id/--control-id/--table-id` say otherwise (validated).
 * alc: `$LETHAL_ALC_DIR/alc`.
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AlcCompileError,
  ArtifactCompiler,
  buildPackageCacheCopy,
  defaultArtifactIo,
  removePackageCacheCopy,
} from "../packages/runner/src/artifact";
import { type AlcDiag, parseAlcErrors } from "../packages/runner/src/bisect";
import { validateSelectorIdsForProject } from "../packages/runner/src/cli";
import { compileOnlyMutationSet } from "../packages/runner/src/compile-only-args";
import { injectControlDependency } from "../packages/runner/src/harness";
import {
  identityOrdinalsOf,
  isolateAndNote,
  prepareArtifactDir,
  targetAppIdOf,
} from "../packages/runner/src/orchestrator";
import type { InstrumentedFile, MutantManifest } from "../packages/schemata/src/project";
import { CONTROL_APP } from "./bc-linux-setup";
import { stageCompileOnlyBatch } from "./campaign/compile-only";

export interface Args {
  readonly projectDir: string;
  readonly symbolsDir: string;
  readonly outDir: string;
  readonly controlSymbol: string;
  readonly selectorIds: { selectorId?: number; controlId?: number; tableId?: number };
  /** R735: how many specs to corrupt; absent means the normal compile run. */
  readonly isolate?: number;
  /** R735: how many specs to keep before corrupting (only with `isolate`). */
  readonly keep: number;
}

export { type AlcDiag, parseAlcErrors };

export function parseArgs(argv: readonly string[]): Args {
  const pos: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`r315-dc-compile: ${a} needs a value`);
    flags.set(a, v);
    i++;
  }
  const [projectDir, symbolsDir, outDir, extra] = pos;
  if (projectDir === undefined || symbolsDir === undefined || outDir === undefined || extra) {
    throw new Error(
      "usage: bun scripts/r315-dc-compile.ts <project-dir> <symbols-dir> <out-dir> [--control-symbol <app>]",
    );
  }
  const known = [
    "--control-symbol",
    "--selector-id",
    "--control-id",
    "--table-id",
    "--isolate",
    "--keep",
  ];
  for (const k of flags.keys()) {
    if (!known.includes(k)) throw new Error(`r315-dc-compile: unknown flag ${k}`);
  }
  const id = (flag: string): number | undefined => {
    const raw = flags.get(flag);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0)
      throw new Error(`r315-dc-compile: ${flag} ${raw} is not a positive integer`);
    return n;
  };
  const sel = id("--selector-id");
  const ctl = id("--control-id");
  const tbl = id("--table-id");
  const isolate = id("--isolate");
  const keepFlag = id("--keep");
  if (keepFlag !== undefined && isolate === undefined) {
    throw new Error("r315-dc-compile: --keep needs --isolate");
  }
  const keep = keepFlag ?? 2000;
  if (isolate !== undefined && isolate > keep) {
    throw new Error(`r315-dc-compile: --isolate ${isolate} is more than --keep ${keep}`);
  }
  return {
    ...(isolate !== undefined ? { isolate } : {}),
    keep,
    projectDir,
    symbolsDir,
    outDir,
    controlSymbol: flags.get("--control-symbol") ?? CONTROL_APP,
    selectorIds: {
      ...(sel !== undefined ? { selectorId: sel } : {}),
      ...(ctl !== undefined ? { controlId: ctl } : {}),
      ...(tbl !== undefined ? { tableId: tbl } : {}),
    },
  };
}

/** code -> file -> count. */
export function summarize(diags: readonly AlcDiag[]): Record<string, Record<string, number>> {
  const s: Record<string, Record<string, number>> = {};
  for (const d of diags) {
    const files = s[d.code] ?? {};
    s[d.code] = files;
    files[d.file] = (files[d.file] ?? 0) + 1;
  }
  return s;
}

/**
 * Lines shift under instrumentation, so compare per (code, file) COUNT: what the instrumented
 * compile has beyond the control's count is LethAL's emit; the rest is the environment's.
 */
export function classify(
  instrumented: readonly AlcDiag[],
  control: readonly AlcDiag[],
): { emit: AlcDiag[]; environment: AlcDiag[] } {
  const budget = new Map<string, number>();
  for (const d of control) {
    const k = `${d.code}|${d.file}`;
    budget.set(k, (budget.get(k) ?? 0) + 1);
  }
  const emit: AlcDiag[] = [];
  const environment: AlcDiag[] = [];
  for (const d of instrumented) {
    const k = `${d.code}|${d.file}`;
    const left = budget.get(k) ?? 0;
    if (left > 0) {
      budget.set(k, left - 1);
      environment.push(d);
    } else emit.push(d);
  }
  return { emit, environment };
}

async function alcOutcome(run: () => Promise<unknown>): Promise<{ exit0: boolean; log: string }> {
  try {
    await run();
    return { exit0: true, log: "" };
  } catch (e) {
    if (e instanceof AlcCompileError) return { exit0: false, log: e.message };
    throw e;
  }
}

type Spec = InstrumentedFile["specs"][number];

/** R735: `keep` of the specs, at a fixed stride across all files, in file order. */
export function thinFiles(files: readonly InstrumentedFile[], keep: number): InstrumentedFile[] {
  const flat = files.flatMap((f, fi) => f.specs.map((_, si) => `${fi}:${si}`));
  if (flat.length <= keep) return [...files];
  // L > keep, so the picked positions are strictly increasing: exactly `keep` distinct specs.
  const chosen = new Set(
    Array.from({ length: keep }, (_, k) => flat[Math.floor((k * flat.length) / keep)]),
  );
  return files
    .map((f, fi) => ({ ...f, specs: f.specs.filter((_, si) => chosen.has(`${fi}:${si}`)) }))
    .filter((f) => f.specs.length > 0);
}

/**
 * R735: corrupts `bad` specs at a fixed stride, alternating a syntax fault (an unbalanced `)`) and
 * a binding fault (an undeclared name, AL0118). Returns the files and the sites it corrupted, as
 * `path|startIndex|endIndex|operator`.
 */
export function corruptSpecs(
  files: readonly InstrumentedFile[],
  bad: number,
): { files: InstrumentedFile[]; injected: Set<string> } {
  const flat = files.flatMap((f, fi) => f.specs.map((_, si) => `${fi}:${si}`));
  const kindAt = new Map<string, number>();
  for (let j = 0; j < bad; j++) {
    const at = flat[Math.floor(((j + 0.5) * flat.length) / bad)];
    if (at !== undefined) kindAt.set(at, j % 2);
  }
  if (kindAt.size !== bad)
    throw new Error(`r315-dc-compile: cannot corrupt ${bad} of ${flat.length}`);
  const injected = new Set<string>();
  const out = files.map((f, fi) => ({
    ...f,
    specs: f.specs.map((s, si): Spec => {
      const kind = kindAt.get(`${fi}:${si}`);
      if (kind === undefined) return s;
      injected.add(`${f.path}|${s.before.startIndex}|${s.before.endIndex}|${s.operatorName}`);
      const text = kind === 0 ? `${s.before.text} ))` : "R735Undefined";
      return { ...s, after: { ...s.after, text } as Spec["after"] };
    }),
  }));
  return { files: out, injected };
}

/** A compile-only check shaped like bcdev's: a staged sibling copy with the Control dependency,
 *  compiled against the package-cache copy. Every call is logged to `log`. */
function mirrorCompileCheck(alcPath: string, cacheCopy: string, outputDir: string, log: string[]) {
  let n = 0;
  return async (dir: string): Promise<void> => {
    const call = ++n;
    const staged = `${dir}-staged`;
    await rm(staged, { recursive: true, force: true });
    await cp(dir, staged, { recursive: true });
    try {
      const appPath = join(staged, "app.json");
      const app = JSON.parse(await readFile(appPath, "utf8")) as Record<string, unknown>;
      await writeFile(appPath, `${JSON.stringify(injectControlDependency(app), null, 2)}\n`);
      const compiler = new ArtifactCompiler(
        { alcPath, packageCachePath: cacheCopy, outputDir },
        defaultArtifactIo,
      );
      const { appPath: built } = await compiler.compileProject({
        projectDir: staged,
        packageCachePath: cacheCopy,
        name: `isolate-${call}`,
      });
      await rm(built, { force: true }).catch(() => {});
      log.push(`compile ${call}: ok`);
    } catch (e) {
      if (e instanceof AlcCompileError) {
        log.push(`compile ${call}: rejected, ${parseAlcErrors(e.message).length} error(s)`);
      }
      throw e;
    } finally {
      await rm(staged, { recursive: true, force: true }).catch(() => {});
    }
  };
}

async function isolateMode(
  args: Args,
  bad: number,
  alcPath: string,
  set: Awaited<ReturnType<typeof compileOnlyMutationSet>>["set"],
  manifest: Record<string, unknown>,
  selectorIds: { selectorId: number; controlId: number; tableId: number },
): Promise<void> {
  const thin = thinFiles(set.files, args.keep);
  const { files, injected } = corruptSpecs(thin, bad);
  const kept = files.reduce((n, f) => n + f.specs.length, 0);
  // Over the THINNED set: ordinals number the specs that survive dedup, and the full set's differ.
  const identityOrdinals = identityOrdinalsOf({ ...set, files });
  const appVersion = String(manifest.version);
  const artifactId = "0123456789abcdef0123456789abcdef";
  const full = join(args.outDir, "isolation-full");
  const scratch = join(args.outDir, "isolation-scratch");
  await prepareArtifactDir({
    targetDir: full,
    files,
    identityOrdinals,
    selectorIds,
    projectDir: args.projectDir,
    projectManifest: manifest,
    appVersion,
    artifactId,
    source: undefined,
    excludeOutputs: [],
    configPath: undefined,
  });
  const written = JSON.parse(
    await readFile(join(full, "mutant-manifest.json"), "utf8"),
  ) as MutantManifest;
  await rm(full, { recursive: true, force: true });
  const siteOf = (m: {
    file: string;
    startIndex: number;
    endIndex: number;
    operatorName: string;
  }) => `${m.file}|${m.startIndex}|${m.endIndex}|${m.operatorName}`;
  const present = new Set(written.mutants.map(siteOf));
  for (const k of injected) {
    if (!present.has(k))
      throw new Error(`r315-dc-compile: injected site ${k} is not in the manifest`);
  }
  console.log(`[r315] isolate: ${kept} specs kept, ${injected.size} corrupted`);

  const scratchOut = await mkdtemp(join(tmpdir(), "r315-alc-out-"));
  const cacheCopy = await buildPackageCacheCopy(args.symbolsDir, args.controlSymbol);
  const log: string[] = [];
  try {
    const started = Date.now();
    const plan = await isolateAndNote({
      subsetMutants: written.mutants,
      scratchDir: scratch,
      batchFiles: files,
      identityOrdinals,
      selectorIds,
      projectDir: args.projectDir,
      projectManifest: manifest,
      appVersion,
      artifactId,
      compileCheck: mirrorCompileCheck(alcPath, cacheCopy, scratchOut, log),
      originalErr: new Error("r315 isolation harness: the corrupted batch failed to compile"),
      source: undefined,
      excludeOutputs: [],
      configPath: undefined,
    });
    const wallMs = Date.now() - started;
    const culpritSites =
      plan.kind === "isolated" ? new Set([...plan.removed.keys()].map(siteOf)) : new Set<string>();
    const equal =
      plan.kind === "isolated" &&
      plan.grouped === 0 &&
      culpritSites.size === injected.size &&
      [...injected].every((k) => culpritSites.has(k));
    const isolation = {
      kind: plan.kind,
      bad,
      keep: args.keep,
      specsKept: kept,
      compiles: plan.compiles,
      culpritSitesEqualInjected: equal,
      groupErrors: plan.kind === "isolated" ? plan.grouped : 0,
      unresolved: plan.kind === "isolated" ? plan.unresolved.length : 0,
      wallMs,
    };
    await writeFile(join(args.outDir, "isolation.log"), `${log.join("\n")}\n`);
    const summary = { specs: kept, isolation };
    await writeFile(join(args.outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await rm(scratchOut, { recursive: true, force: true });
    await removePackageCacheCopy(cacheCopy);
  }
}

async function main(args: Args): Promise<void> {
  const alcDir = process.env.LETHAL_ALC_DIR;
  if (alcDir === undefined || alcDir === "") throw new Error("r315-dc-compile: set LETHAL_ALC_DIR");
  const alcPath = join(alcDir, "alc");
  const manifest = JSON.parse(await readFile(join(args.projectDir, "app.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const ranges = (manifest.idRanges ?? []) as { to: number }[];
  const top = ranges[ranges.length - 1]?.to;
  const selectorIds = {
    selectorId: args.selectorIds.selectorId ?? (top ?? 0) - 2,
    controlId: args.selectorIds.controlId ?? (top ?? 0) - 1,
    tableId: args.selectorIds.tableId ?? top ?? 0,
  };
  await validateSelectorIdsForProject(args.projectDir, selectorIds);

  await mkdir(args.outDir, { recursive: true });
  const instrDir = join(args.outDir, "instrumented");
  await rm(instrDir, { recursive: true, force: true });
  await mkdir(instrDir, { recursive: true });
  const { set } = await compileOnlyMutationSet({
    projectDir: args.projectDir,
    selectorIds,
    alcPath,
    packageCachePath: args.symbolsDir,
    controlSymbolPath: args.controlSymbol,
    configPath: join(args.projectDir, "lethal.config.json"),
  });
  const specs = set.files.reduce((n, f) => n + f.specs.length, 0);
  console.log(
    `[r315] ${set.totalFiles} .al files, ${set.files.length} instrumented, ${specs} specs`,
  );
  if (args.isolate !== undefined) {
    await isolateMode(args, args.isolate, alcPath, set, manifest, selectorIds);
    return;
  }

  await stageCompileOnlyBatch({
    projectDir: args.projectDir,
    target: instrDir,
    set,
    selectorIds,
    artifactId: "0123456789abcdef0123456789abcdef",
    targetAppId: targetAppIdOf(manifest),
    appManifest: manifest,
    configPath: undefined,
  });
  const staged = JSON.parse(await readFile(join(instrDir, "app.json"), "utf8")) as Record<
    string,
    unknown
  >;
  await writeFile(
    join(instrDir, "app.json"),
    `${JSON.stringify(injectControlDependency(staged), null, 2)}\n`,
  );

  const scratchOut = await mkdtemp(join(tmpdir(), "r315-alc-out-"));
  const cacheCopy = await buildPackageCacheCopy(args.symbolsDir, args.controlSymbol);
  try {
    const compile = (projectDir: string, cache: string, name: string) =>
      alcOutcome(() =>
        new ArtifactCompiler(
          { alcPath, packageCachePath: cache, outputDir: scratchOut },
          defaultArtifactIo,
        ).compileProject({ projectDir, packageCachePath: cache, name }),
      );
    const control = await compile(args.projectDir, args.symbolsDir, "control");
    const inst = await compile(instrDir, cacheCopy, "instrumented");
    await writeFile(join(args.outDir, "control.alc.log"), control.log);
    await writeFile(join(args.outDir, "instrumented.alc.log"), inst.log);
    const cDiags = parseAlcErrors(control.log);
    const iDiags = parseAlcErrors(inst.log);
    const { emit, environment } = classify(iDiags, cDiags);
    const summary = {
      specs,
      control: { exit0: control.exit0, errors: cDiags.length, byCode: summarize(cDiags) },
      instrumented: { exit0: inst.exit0, errors: iDiags.length, byCode: summarize(iDiags) },
      classification: {
        emit: { errors: emit.length, byCode: summarize(emit) },
        environment: { errors: environment.length, byCode: summarize(environment) },
      },
      closes: inst.exit0 || emit.length === 0,
    };
    await writeFile(join(args.outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await rm(scratchOut, { recursive: true, force: true });
    await removePackageCacheCopy(cacheCopy);
  }
}

if (import.meta.main) await main(parseArgs(process.argv.slice(2)));
