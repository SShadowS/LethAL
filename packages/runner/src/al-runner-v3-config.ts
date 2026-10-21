/**
 * R586 (plan r2 §9, T16, T17): the `alRunnerV3` section of `lethal.config.json`, beside `alRunner`,
 * and the refusals by name that keep v1 of the backend to what was measured:
 *
 *   "alRunnerV3": {
 *     "path": "/work/tools/al-runner-v3/current/al-runner",   // default
 *     "packagesDir": "<the folder v3 gets as --package-cache and alc as its package cache>",
 *     "bcVersion": "28.0.46665.47126",                         // required, four numbers
 *     "coverage": "al-runner",                                 // or "none"; default "al-runner"
 *     "alcPath": "<optional; else the AL extension's alc>",
 *     "cacheDir": "<optional ALRUNNER_CACHE>"
 *   }
 *
 * `serverMode` and `selectorMode` are refused by name (one-shot, static selector only).
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { AL_RUNNER_V3_DEFAULT_PATH } from "./al-runner-v3-pin";
import { readAppIdentity } from "./published-test-app";

export interface AlRunnerV3ConfigSection {
  readonly path: string;
  readonly packagesDir: string;
  readonly bcVersion: string;
  readonly coverage: "al-runner" | "none";
  readonly alcPath?: string;
  readonly cacheDir?: string;
}

const KEYS = ["path", "packagesDir", "bcVersion", "coverage", "alcPath", "cacheDir"];
/** Keys of the v2 section that mean a transport v1 of v3 does not have. */
const REFUSED = ["serverMode", "selectorMode", "alRunnerPath"];

/** T16 / T17: the section, validated; every refusal names its key. Extends nothing: plain Errors. */
export function validateAlRunnerV3Config(raw: unknown): AlRunnerV3ConfigSection {
  if (raw === undefined || raw === null || typeof raw !== "object") {
    throw new Error('lethal.config.json is missing the "alRunnerV3" section (required for --backend al-runner-v3)');
  }
  const r = raw as Record<string, unknown>;
  for (const k of REFUSED) {
    if (r[k] !== undefined) {
      throw new Error(
        k === "selectorMode"
          ? 'al-runner-v3-resource-selector-refused: "alRunnerV3.selectorMode" is refused: v1 of the al-runner-v3 backend runs the static selector only (R586).'
          : `al-runner-v3-config-refused: "alRunnerV3.${k}" is refused: ${k === "serverMode" ? "v1 runs one-shot only (no serve)" : 'the v3 binary is "path"'} (R586).`,
      );
    }
  }
  const unknown = Object.keys(r).filter((k) => !KEYS.includes(k));
  if (unknown.length > 0) {
    throw new Error(`lethal.config.json "alRunnerV3" has unknown key(s): ${unknown.join(", ")}. Allowed: ${KEYS.join(", ")}.`);
  }
  if (typeof r.bcVersion !== "string" || !/^\d+\.\d+\.\d+\.\d+$/.test(r.bcVersion)) {
    throw new Error(
      `"alRunnerV3.bcVersion" is required as a four-number BC build (got ${JSON.stringify(r.bcVersion)}): v3 runs with --no-download, and without a build it picks the newest BC (R586).`,
    );
  }
  if (typeof r.packagesDir !== "string" || r.packagesDir === "") {
    throw new Error('"alRunnerV3.packagesDir" is required: the folder v3 and alc both read packages from (R586).');
  }
  if (r.coverage !== undefined && r.coverage !== "al-runner" && r.coverage !== "none") {
    throw new Error(`"alRunnerV3.coverage" must be "al-runner" or "none", got ${JSON.stringify(r.coverage)}`);
  }
  for (const k of ["path", "alcPath", "cacheDir"]) {
    if (r[k] !== undefined && (typeof r[k] !== "string" || r[k] === "")) {
      throw new Error(`"alRunnerV3.${k}" must be a non-empty string`);
    }
  }
  return {
    path: (r.path as string | undefined) ?? AL_RUNNER_V3_DEFAULT_PATH,
    packagesDir: r.packagesDir,
    bcVersion: r.bcVersion,
    coverage: (r.coverage as "al-runner" | "none" | undefined) ?? "al-runner",
    ...(typeof r.alcPath === "string" ? { alcPath: r.alcPath } : {}),
    ...(typeof r.cacheDir === "string" ? { cacheDir: r.cacheDir } : {}),
  };
}

/**
 * T17: when `packagesDir` holds Microsoft's System Application, its version must equal
 * `bcVersion` (`al-runner-v3-bc-version-mismatch`): v3 would otherwise run one BC build's apps
 * while the proof and the report name another.
 */
export async function assertBcVersionMatchesPackages(packagesDir: string, bcVersion: string): Promise<void> {
  for (const name of (await readdir(packagesDir)).sort()) {
    if (!name.toLowerCase().endsWith(".app")) continue;
    let id: ReturnType<typeof readAppIdentity>;
    try {
      id = readAppIdentity(await readFile(join(packagesDir, name)));
    } catch {
      continue; // not a manifest package (a Ready-to-Run wrapper or the platform): not this check
    }
    if (id.publisher === "Microsoft" && id.name === "System Application" && id.version !== bcVersion) {
      throw new Error(
        `al-runner-v3-bc-version-mismatch: ${join(packagesDir, name)} is System Application ${id.version}, but "alRunnerV3.bcVersion" is ${bcVersion} (R586).`,
      );
    }
  }
}

/** T16: the platform refusal, before anything is built. */
export function refuseV3Platform(platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    throw new Error("al-runner-v3-windows-unsupported: --backend al-runner-v3 is not measured on Windows (R586 v1).");
  }
}

/** The once-per-session warning (plan r2 §9): why v3 is not authoritative, by issue. */
export const AL_RUNNER_V3_NOT_AUTHORITATIVE =
  "[lethal] al-runner-v3 is NOT authoritative (R586): code that does not compile runs (#5602; closed on LethAL's side by the alc proof), a statement-form duplicate-key Insert does not raise (#5603: such kills read survived), and Sleep does nothing (#5605: a covering pass over a project Sleep reads error, a dependency Sleep is not caught). Notes [v3-codeunit-state-possible] and [v3-refused-test-nearby] mark a kill made in a shared-codeunit run and a survivor beside a refused test. bcdev remains the authority.";
