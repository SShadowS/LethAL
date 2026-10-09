// R340 (plan review I1): the trigger-header collision matrix as a MUTANT-level alc proof. In every
// context of `alcp/`, a trigger header name Z: Integer collides with a field Z: Text of the implicit
// record, and the body uses `Z + Z`. LethAL types Z by the header (Integer), so swap-additive emits
// `Z - Z`; if alc resolved Z to the Text field instead, that mutant would fail (AL0175). This generates
// with this checkout, instruments every emitted mutant behind its guard into ONE project, and compiles
// it with alc against a bcdev symbol cache plus the LethAL Control symbol file, as a real deploy does.
// Measured 2026-10-09: 14 `Z - Z` mutants (table, table field, page, page field, page parameter,
// page action `OnAction`, usercontrol event parameter, pageextension x2, tableextension, report data
// items x2, request page, TableNo codeunit; the xmlport is not instrumented), and the instrumented
// project COMPILES. The batch is completed by the runner's own `prepareBatchProject` (app.json
// stamped, every file without sites and every resource copied), as a real deploy does.
// Usage (repo root): bun scripts/r340-probe/compile-mutants.ts <out dir> <bcdev lethal.config json>
//   The config is read only for `bcdev.packageCachePath` and `bcdev.controlSymbolPath`.
import { copyFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactCompiler, defaultArtifactIo } from "../../packages/runner/src/artifact";
import { validateBcDevConfig } from "../../packages/runner/src/cli";
import {
  generateMutationSet,
  identityOrdinalsOf,
  operatorTiers,
  planArtifacts,
  prepareBatchProject,
} from "../../packages/runner/src/orchestrator";
import { defaultAlToolPaths } from "../../packages/runner/src/publisher";
import { writeInstrumentedProject } from "../../packages/schemata/src/index";

const [out = "", configPath = ""] = process.argv.slice(2);
if (out === "" || configPath === "")
  throw new Error("usage: compile-mutants.ts <out dir> <config>");
const here = import.meta.dir;
const proj = join(here, "alcp");
const repo = join(here, "..", "..");

const set = await generateMutationSet(proj, { emit: () => {} });
let zSites = 0;
for (const f of set.files)
  for (const s of f.specs)
    if (s.before.text === "Z + Z") {
      zSites++;
      console.log(
        `  ${f.path}:${s.before.startPosition.row + 1} ${s.operatorName} -> ${s.after.text}`,
      );
    }
console.log(`Z + Z mutants emitted: ${zSites}`);

const [batch, ...more] = planArtifacts(set.files, {});
if (batch === undefined || more.length > 0) throw new Error("expected one batch");
await rm(out, { recursive: true, force: true });
const dir = join(out, "instrumented");
await writeInstrumentedProject({
  targetDir: dir,
  files: batch,
  identityOrdinals: identityOrdinalsOf(set),
  selectorIds: { selectorId: 92849, controlId: 92848, tableId: 92847 },
  artifactId: "0123456789abcdef0123456789abcdef",
  targetAppId: "11111111-2222-3333-4444-555555555555",
  operatorTiers,
});
const app = JSON.parse(await readFile(join(proj, "app.json"), "utf8"));
const control = JSON.parse(
  await readFile(join(repo, "extensions/lethal-control/app.json"), "utf8"),
);
app.dependencies = [
  { id: control.id, name: control.name, publisher: control.publisher, version: control.version },
];
await prepareBatchProject(proj, dir, app, "1.0.0.0");
const bcdev = validateBcDevConfig(JSON.parse(await readFile(configPath, "utf8")).bcdev);
const tools = await defaultAlToolPaths();
if (!tools) throw new Error("no alc under the AL Language extension");
const cache = join(out, "cache");
await mkdir(cache, { recursive: true });
for (const n of await readdir(bcdev.packageCachePath))
  if (n.toLowerCase().endsWith(".app"))
    await copyFile(join(bcdev.packageCachePath, n), join(cache, n));
await copyFile(bcdev.controlSymbolPath, join(cache, "LethAL_LethAL Control.app"));
await mkdir(join(out, "app"), { recursive: true });
const compiler = new ArtifactCompiler(
  { alcPath: tools.alcPath, packageCachePath: cache, outputDir: join(out, "app") },
  defaultArtifactIo,
);
const r = await compiler.compileProject({
  projectDir: dir,
  packageCachePath: cache,
  name: "r340probe",
});
console.log(`alc: the instrumented project COMPILES (sha256 ${r.sha256.slice(0, 12)})`);
