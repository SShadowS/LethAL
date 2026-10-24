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
 * <project-dir> and <symbols-dir> are only read. Selector ids: the top three ids of the project's
 * last app.json idRange unless `--selector-id/--control-id/--table-id` say otherwise (validated).
 * alc: `$LETHAL_ALC_DIR/alc`.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  AlcCompileError,
  ArtifactCompiler,
  buildPackageCacheCopy,
  defaultArtifactIo,
  removePackageCacheCopy,
} from "../packages/runner/src/artifact";
import { validateSelectorIdsForProject } from "../packages/runner/src/cli";
import { compileOnlyMutationSet } from "../packages/runner/src/compile-only-args";
import { injectControlDependency } from "../packages/runner/src/harness";
import { targetAppIdOf } from "../packages/runner/src/orchestrator";
import { CONTROL_APP } from "./bc-linux-setup";
import { stageCompileOnlyBatch } from "./campaign/compile-only";

export interface Args {
  readonly projectDir: string;
  readonly symbolsDir: string;
  readonly outDir: string;
  readonly controlSymbol: string;
  readonly selectorIds: { selectorId?: number; controlId?: number; tableId?: number };
}

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
  const known = ["--control-symbol", "--selector-id", "--control-id", "--table-id"];
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
  return {
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

export interface AlcDiag {
  readonly code: string;
  readonly file: string;
  readonly line: number;
}

/** The `error ALnnnn` lines of alc output, as code + file name + line. Message text is dropped. */
export function parseAlcErrors(text: string): AlcDiag[] {
  const out: AlcDiag[] = [];
  const re = /^(.*?)\((\d+),\d+(?:,\d+,\d+)?\):\s*error\s+(AL\d+|[A-Z]{2,}\d+)\b/;
  for (const raw of text.split(/\r?\n/)) {
    const m = re.exec(raw.trim());
    if (m === null) continue;
    out.push({
      code: m[3] as string,
      file: basename((m[1] as string).replaceAll("\\", "/")),
      line: Number(m[2]),
    });
  }
  return out;
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
