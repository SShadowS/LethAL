// R900: the offline alc proof that LethAL's own ArtifactCompiler passes assembly probing paths.
// Builds an invented AL project in a temp folder: one `dotnet { assembly(...) }` block naming two
// assemblies, each copied into its own probing folder, and one codeunit using both DotNet types.
// Then compiles it through `ArtifactCompiler.compileProject`, three times:
//   1. no probing paths resolve (no config field, no settings, no ./.netpackages): must FAIL with
//      AL0451 and AL0185, and the error must carry LethAL's AL0451 note;
//   2. the config field names both folders: must compile;
//   3. the project's .vscode/settings.json names both folders: must compile.
// Not a unit test because CI has neither alc nor the assemblies, and Microsoft's DLLs cannot be
// committed. Nothing is written under the repo or under the source folder.
// Usage (repo root): bun scripts/r900-probing-probe.ts [<alc>] [<folder holding the two DLLs>]
//   Defaults: $LETHAL_ALC_DIR/alc and /coord/cache/bc28-service (read only).
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AlcCompileError,
  ArtifactCompiler,
  defaultArtifactIo,
} from "../packages/runner/src/artifact";
import { resolveAssemblyProbingPaths } from "../packages/runner/src/assembly-probing-paths";

const [alcArg, srcArg] = process.argv.slice(2);
const alc = alcArg ?? join(process.env.LETHAL_ALC_DIR ?? "", "alc");
const src = srcArg ?? "/coord/cache/bc28-service";
const ASSEMBLIES = [
  { dll: "Newtonsoft.Json", type: "Newtonsoft.Json.Linq.JObject", alias: "InventedJObject" },
  {
    dll: "DocumentFormat.OpenXml.Framework",
    type: "DocumentFormat.OpenXml.OpenXmlElement",
    alias: "InventedOpenXmlElement",
  },
];

const root = await mkdtemp(join(tmpdir(), "lethal-r900-probe-"));
let failed = false;
const check = (ok: boolean, line: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
  if (!ok) failed = true;
};
try {
  const proj = join(root, "proj");
  await mkdir(join(proj, "src"), { recursive: true });
  const folders: string[] = [];
  for (const [i, a] of ASSEMBLIES.entries()) {
    const folder = join(root, `asm${i}`);
    await mkdir(folder);
    await copyFile(join(src, `${a.dll}.dll`), join(folder, `${a.dll}.dll`));
    folders.push(folder);
  }
  await writeFile(
    join(proj, "app.json"),
    JSON.stringify({
      id: "0f6a2c55-7d0e-4c1a-9a43-2b7f1e9d3a01",
      name: "R900 Probing Probe",
      publisher: "Invented",
      version: "1.0.0.0",
      dependencies: [],
      idRanges: [{ from: 50100, to: 50149 }],
      runtime: "17.0",
      target: "OnPrem",
    }),
  );
  const blocks = ASSEMBLIES.map(
    (a) => `    assembly("${a.dll}")\n    {\n        type("${a.type}"; "${a.alias}") { }\n    }`,
  ).join("\n");
  const vars = ASSEMBLIES.map((a, i) => `        V${i}: DotNet ${a.alias};`).join("\n");
  await writeFile(
    join(proj, "src", "Probe.Codeunit.al"),
    `dotnet\n{\n${blocks}\n}\n\ncodeunit 50100 "R900 Probing Probe"\n{\n    procedure Touch(): Boolean\n    var\n${vars}\n    begin\n        exit(IsNull(V0) and IsNull(V1));\n    end;\n}\n`,
  );
  const cache = join(root, "cache");
  await mkdir(cache);

  const compile = async (label: string, configValue: unknown) => {
    const r = await resolveAssemblyProbingPaths(proj, configValue);
    const out = join(root, `out-${label}`);
    await mkdir(out);
    const compiler = new ArtifactCompiler(
      {
        alcPath: alc,
        packageCachePath: cache,
        outputDir: out,
        ...(r.paths.length > 0 ? { assemblyProbingPaths: r.paths } : {}),
      },
      defaultArtifactIo,
    );
    try {
      const { sha256 } = await compiler.compileProject({
        projectDir: proj,
        packageCachePath: cache,
        name: label,
      });
      return {
        source: r.source,
        ok: true as const,
        text: `compiled, sha256 ${sha256.slice(0, 16)}`,
      };
    } catch (err) {
      if (!(err instanceof AlcCompileError)) throw err;
      return { source: r.source, ok: false as const, text: err.message };
    }
  };

  const none = await compile("none", undefined);
  const errors = none.text.split("\n").filter((l) => /error AL\d+/.test(l));
  for (const l of errors) console.log(`  red: ${l.slice(l.indexOf("error "))}`);
  const note = none.text.split("\n").find((l) => l.startsWith("AL0451: "));
  if (note !== undefined) console.log(`  red: ${note}`);
  check(
    !none.ok && none.source === "none" && /AL0451/.test(none.text) && /AL0185/.test(none.text),
    "no probing paths: alc refuses with AL0451 and AL0185",
  );
  check(
    note?.includes("no assembly probing paths") === true,
    "the error carries LethAL's AL0451 note",
  );

  const fromConfig = await compile("config", folders);
  console.log(`  green: ${fromConfig.text}`);
  check(fromConfig.ok && fromConfig.source === "config", "config assemblyProbingPaths: compiles");

  await mkdir(join(proj, ".vscode"));
  await writeFile(
    join(proj, ".vscode", "settings.json"),
    `{\n  // as VS Code writes it\n  "al.assemblyProbingPaths": ${JSON.stringify(folders)},\n}\n`,
  );
  const fromSettings = await compile("settings", undefined);
  console.log(`  green: ${fromSettings.text}`);
  check(
    fromSettings.ok && fromSettings.source === "vscode-settings",
    ".vscode/settings.json al.assemblyProbingPaths: compiles",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
