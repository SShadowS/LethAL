/**
 * R586 (plan r2 §9, T16, T17): the `alRunnerV3` section of `lethal.config.json` (v2's `alRunner` is refused, R654 F2),
 * and the refusals by name that keep v1 of the backend to what was measured:
 *
 *   "alRunnerV3": {
 *     "path": "~/.local/bin/al-runner",                        // default (R834); the pinned build when /work/tools has one
 *     "packagesDir": "<the folder v3 gets as --package-cache and alc as its package cache>",
 *     "bcVersion": "28.0.46665.47126",                         // required, four numbers
 *     "coverage": "al-runner",                                 // or "none"; default "al-runner"
 *     "alcPath": "<optional; else the AL extension's alc>",
 *     "cacheDir": "<optional ALRUNNER_CACHE>",
 *     "transport": "serve-entries",                            // or "one-shot"; absent: serve-entries where proven, else one-shot (R761)
 *     "secondEcho": true                                       // R635 §5, serve-entries only
 *   }
 *
 * `serverMode` and `selectorMode` are refused by name (the static selector only, and no v2-style serve).
 */
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { AL_RUNNER_V3_DEFAULT_PATH } from "./al-runner-v3-pin";
import { homeDir } from "./home";
import { symbolPackageIdentity } from "./published-test-app";

export interface AlRunnerV3ConfigSection {
  readonly path: string;
  readonly packagesDir: string;
  readonly bcVersion: string;
  readonly coverage: "al-runner" | "none";
  readonly alcPath?: string;
  readonly cacheDir?: string;
  /** R635, R761: `"serve-entries"` (default) or `"one-shot"`. */
  readonly transport: "one-shot" | "serve-entries";
  /**
   * R761: `"default"` when the config names no `transport`. Then the session picks serve-entries
   * where it is proven and one-shot otherwise, with a named warning (`AlRunnerV3Backend.decideTransport`).
   * `"explicit"`: the named transport is used as written.
   */
  readonly transportSource: "default" | "explicit";
  /** R635 §5: the echo before the coverage request (default on; serve-entries only). */
  readonly secondEcho: boolean;
}

const KEYS = [
  "path",
  "packagesDir",
  "bcVersion",
  "coverage",
  "alcPath",
  "cacheDir",
  "transport",
  "secondEcho",
];
/** Keys of the v2 section that mean a transport v1 of v3 does not have. */
const REFUSED = ["serverMode", "selectorMode", "alRunnerPath"];

/**
 * R834: the default for `path`. The pinned build when this machine has one (LethAL's own boxes),
 * else where upstream's install.sh puts the binary, so a clean box's error names a path the
 * installer wrote.
 */
export function defaultV3Path(
  exists: (p: string) => boolean = existsSync,
  home: string = homeDir(),
): string {
  return exists(AL_RUNNER_V3_DEFAULT_PATH)
    ? AL_RUNNER_V3_DEFAULT_PATH
    : join(home, ".local", "bin", "al-runner");
}

/** T16 / T17: the section, validated; every refusal names its key. Extends nothing: plain Errors. */
export function validateAlRunnerV3Config(
  raw: unknown,
  exists: (p: string) => boolean = existsSync,
  home: string = homeDir(),
): AlRunnerV3ConfigSection {
  if (raw === undefined || raw === null || typeof raw !== "object") {
    throw new Error(
      'lethal.config.json is missing the "alRunnerV3" section (required for --backend al-runner-v3)',
    );
  }
  const r = raw as Record<string, unknown>;
  for (const k of REFUSED) {
    if (r[k] !== undefined) {
      throw new Error(
        k === "selectorMode"
          ? 'al-runner-v3-resource-selector-refused: "alRunnerV3.selectorMode" is refused: v1 of the al-runner-v3 backend runs the static selector only (R586).'
          : `al-runner-v3-config-refused: "alRunnerV3.${k}" is refused: ${k === "serverMode" ? 'v3 has no v2-style serve; set "alRunnerV3.transport" instead (R635)' : 'the v3 binary is "path"'} (R586).`,
      );
    }
  }
  const unknown = Object.keys(r).filter((k) => !KEYS.includes(k));
  if (unknown.length > 0) {
    throw new Error(
      `lethal.config.json "alRunnerV3" has unknown key(s): ${unknown.join(", ")}. Allowed: ${KEYS.join(", ")}.`,
    );
  }
  if (typeof r.bcVersion !== "string" || !/^\d+\.\d+\.\d+\.\d+$/.test(r.bcVersion)) {
    throw new Error(
      `"alRunnerV3.bcVersion" is required as a four-number BC build (got ${JSON.stringify(r.bcVersion)}): v3 runs with --no-download, and without a build it picks the newest BC (R586).`,
    );
  }
  if (typeof r.packagesDir !== "string" || r.packagesDir === "") {
    throw new Error(
      '"alRunnerV3.packagesDir" is required: the folder v3 and alc both read packages from (R586).',
    );
  }
  if (r.coverage !== undefined && r.coverage !== "al-runner" && r.coverage !== "none") {
    throw new Error(
      `"alRunnerV3.coverage" must be "al-runner" or "none", got ${JSON.stringify(r.coverage)}`,
    );
  }
  for (const k of ["path", "alcPath", "cacheDir"]) {
    if (r[k] !== undefined && (typeof r[k] !== "string" || r[k] === "")) {
      throw new Error(`"alRunnerV3.${k}" must be a non-empty string`);
    }
  }
  if (r.transport !== undefined && r.transport !== "one-shot" && r.transport !== "serve-entries") {
    throw new Error(
      `al-runner-v3-config-refused: "alRunnerV3.transport" must be "one-shot" or "serve-entries", got ${JSON.stringify(r.transport)} (R635).`,
    );
  }
  if (r.secondEcho !== undefined && typeof r.secondEcho !== "boolean") {
    throw new Error(
      `al-runner-v3-config-refused: "alRunnerV3.secondEcho" must be a boolean, got ${JSON.stringify(r.secondEcho)} (R635).`,
    );
  }
  return {
    path: (r.path as string | undefined) ?? defaultV3Path(exists, home),
    packagesDir: r.packagesDir,
    bcVersion: r.bcVersion,
    transport: r.transport ?? "serve-entries",
    transportSource: r.transport === undefined ? "default" : "explicit",
    secondEcho: r.secondEcho ?? true,
    coverage: (r.coverage as "al-runner" | "none" | undefined) ?? "al-runner",
    ...(typeof r.alcPath === "string" ? { alcPath: r.alcPath } : {}),
    ...(typeof r.cacheDir === "string" ? { cacheDir: r.cacheDir } : {}),
  };
}

/**
 * T17: `packagesDir`'s Microsoft System Application must equal `bcVersion`
 * (`al-runner-v3-bc-version-mismatch`): v3 would otherwise run one BC build's apps while the proof
 * and the report name another. M8: a folder where no System Application can be identified is
 * refused by name (`al-runner-v3-system-application-not-found`), never passed unchecked.
 */
export async function assertBcVersionMatchesPackages(
  packagesDir: string,
  bcVersion: string,
): Promise<void> {
  let found = 0;
  const unread: string[] = [];
  for (const name of (await readdir(packagesDir)).sort()) {
    if (!name.toLowerCase().endsWith(".app")) continue;
    let id: ReturnType<typeof symbolPackageIdentity>;
    try {
      // R820: a BC 29 dev endpoint serves System Application as a Ready-to-Run wrapper.
      id = symbolPackageIdentity(await readFile(join(packagesDir, name)));
    } catch (err) {
      // Not a package this check can read (the platform has its own shape). A broken wrapper is
      // named below, so the refusal does not send anyone looking for a missing file.
      if (/Ready-to-Run/.test(String(err))) unread.push(`${name}: ${String(err)}`);
      continue;
    }
    if (id.publisher !== "Microsoft" || id.name !== "System Application") continue;
    found += 1;
    if (id.version !== bcVersion) {
      throw new Error(
        `al-runner-v3-bc-version-mismatch: ${join(packagesDir, name)} is System Application ${id.version}, but "alRunnerV3.bcVersion" is ${bcVersion} (R586).`,
      );
    }
  }
  if (found === 0) {
    throw new Error(
      `al-runner-v3-system-application-not-found: no readable Microsoft System Application .app in ${packagesDir}, so "alRunnerV3.bcVersion" ${bcVersion} cannot be checked against it (R586 M8).${unread.length > 0 ? ` Unreadable: ${unread.join("; ")}` : ""}`,
    );
  }
}

/** T16 and M9: the platform refusal, before anything is built. Only Linux x64 was measured. */
export function refuseV3Platform(platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    throw new Error(
      "al-runner-v3-windows-unsupported: --backend al-runner-v3 is not measured on Windows (R586 v1).",
    );
  }
  if (platform !== "linux") {
    throw new Error(
      `al-runner-v3-platform-unsupported: ${platform}: --backend al-runner-v3 was measured on Linux only (R586 v1).`,
    );
  }
}

/** The once-per-session warning (plan r2 §9): why v3 is not authoritative, by issue. */
export const AL_RUNNER_V3_NOT_AUTHORITATIVE =
  "[lethal] al-runner-v3 is NOT authoritative (R586): on the pinned builds v3 refuses an app that does not compile (#5602 is fixed). A statement-form duplicate-key Insert fails with BC's text from edge 8078bcf49 on (#5788 is fixed); on alpha.5 and the edge builds before 8078bcf49 it is refused by name (a lost kill, never a wrong verdict); on an unpinned build (alpha.2) it does not raise, so its kills read survived (#5603), a wrong verdict. Sleep still returns at once on a virtual clock (#5605). On the pinned builds that counts toward the time limit (#5793: right verdict class only, wall time is not BC's); on an unpinned build a covering pass over a project Sleep reads error, and a dependency Sleep is not caught. Notes [v3-codeunit-state-possible] and [v3-refused-test-nearby] mark a kill made in a shared-codeunit run and a survivor beside a refused test. bcdev remains the authority.";
