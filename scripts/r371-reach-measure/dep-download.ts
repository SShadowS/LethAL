// R-371: the live cost of the bcdev dependency fingerprint (lethal verify's server step).
// Run LATER, under a container lease: it reads packages over the container's HTTP /packages.
// Usage: bun scripts/r371-reach-measure/dep-download.ts --config <lethal.config.json>
//          --test <test-app-dir> [--project <target-app-dir>]
// --project defaults to the config's directory (the target project holds lethal.config.json).
// Prints JSON only: wall time, peak RSS, packages read and their bytes, a fingerprint prefix.
// Exit 2 on DependencyUnreadableError. Never prints AL source (this repo is PUBLIC).
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BcDevMcpBackend } from "../../packages/runner/src/bcdev-backend";
import {
  buildBackend,
  loadDryRunConfig,
  resolveSelectorIds,
  validateSelectorIdsConfig,
} from "../../packages/runner/src/cli";
import {
  DependencyUnreadableError,
  bcdevDependencyFingerprint,
} from "../../packages/runner/src/digest-inputs";

const { values } = parseArgs({
  options: { config: { type: "string" }, test: { type: "string" }, project: { type: "string" } },
});
if (values.config === undefined || values.test === undefined)
  throw new Error("usage: dep-download.ts --config <path> --test <test-dir> [--project <dir>]");
const configPath = resolve(values.config);
const projectDir = resolve(values.project ?? dirname(configPath));
const testDir = resolve(values.test);

const configFile = await loadDryRunConfig(configPath, true);
if (configFile === undefined) throw new Error("no config");
const backend = await buildBackend(
  { backendKind: "bcdev", projectDir, testDir },
  configFile,
  projectDir,
  undefined,
  {},
  // The config's selector ids, as `lethal run` resolves them; the defaults fall outside a
  // fixture's own id range.
  resolveSelectorIds({}, validateSelectorIdsConfig(configFile.selectorIds)),
);
if (!(backend instanceof BcDevMcpBackend))
  throw new Error("the config did not build a bcdev backend");
const fetchPublished = backend.fetchPublishedAppPackage?.bind(backend);
if (fetchPublished === undefined) throw new Error("the backend cannot fetch published packages");

let packages = 0;
let bytes = 0;
const fetchCounted: typeof fetchPublished = async (app) => {
  const r = await fetchPublished(app);
  if (r !== null && r !== undefined) {
    packages += 1;
    bytes += r.byteLength;
  }
  return r;
};

let peak = process.memoryUsage().rss;
const sample = (): void => {
  peak = Math.max(peak, process.memoryUsage().rss);
};
const timer = setInterval(sample, 5);
const t0 = performance.now();
let code = 0;
try {
  // R-385: Microsoft packages, System and the control app's dependencies by bytes, as run and
  // verify read them; System and the control package are counted too.
  const mode = backend.microsoftMode();
  const fp = await bcdevDependencyFingerprint(
    fetchCounted,
    testDir,
    projectDir,
    mode.kind === "bytes"
      ? {
          ...mode,
          readSystem: () => fetchCounted({ publisher: "Microsoft", name: "System" }),
          readControl: () => fetchCounted({ publisher: "LethAL", name: "LethAL Control" }),
        }
      : mode,
  );
  sample();
  console.log(
    JSON.stringify({
      wallMs: Math.round(performance.now() - t0),
      peakRssMb: Math.round(peak / 1048576),
      endRssMb: Math.round(process.memoryUsage().rss / 1048576),
      packagesRead: packages,
      totalBytes: bytes,
      fingerprintPrefix: fp.slice(0, 12),
    }),
  );
} catch (err) {
  if (!(err instanceof DependencyUnreadableError)) throw err;
  console.log(`DependencyUnreadableError: ${err.message}`);
  code = 2;
} finally {
  clearInterval(timer);
  await backend.close();
}
process.exit(code);
