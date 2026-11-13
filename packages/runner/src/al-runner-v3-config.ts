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
 *     "secondEcho": true,                                      // R635 §5, serve-entries only
 *     "downloadDemoData": true,                                // R885; false passes --no-download (offline, gates); true: the feed's copy replaces an older Microsoft app in .alpackages
 *     "noClient": false,                                       // R907; true passes --no-client: tests run as a session without a client (GuiAllowed() false, as on BC's web-service path); a pass that rests on an unprobed assumption is flagged
 *     "isolation": "auto",                                    // R896; "auto" (default): per codeunit, "method" where the baseline passes strictly more tests so; R890: "test" or "method" force one mode
 *     "memoryHeadroomGb": 4,                                  // R948; no new test call starts while the container uses more than its cgroup limit less this many GiB; the run then stops with its report. 0 = guard off
 *     "daemonMaxRssGb": 6,                                    // R952 (R948); a serve daemon whose RSS passed this many GiB is replaced by a fresh one before its next request. 0 = off
 *     "daemonMaxRequests": 0,                                 // R952 (R948); a serve daemon is replaced after this many requests. 0 (default) = off
 *     "license": "<optional .bclicense file>",             // R956; passed as --license on every al-runner call that runs tests; its sha256 is in the fingerprint and the report
 *     "dotnetSidecar": "<optional AlDotNetSidecar.dll>"      // R886; passed as --dotnet-sidecar. Absent: the pinned build's own sidecar, when its .gated names one; false: none (gates)
 *   }
 *
 * `serverMode` and `selectorMode` are refused by name (the static selector only, and no v2-style serve).
 */
import { createHash } from "node:crypto";
import { constants, accessSync, existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MEMORY_HEADROOM_GB_DEFAULT } from "./al-runner-v3-baseline-check";
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
  /** R885: may v3 download the CRONUS demo data into `cacheDir`? `false` passes `--no-download`. */
  readonly downloadDemoData: boolean;
  /** R907: `--no-client` for every al-runner call (serve: the `noClient` request field). */
  readonly noClient: boolean;
  /** R886: `--dotnet-sidecar <dll>` for every al-runner call. Absent: the pinned build's sidecar, if any. `false`: none. */
  readonly dotnetSidecar?: string | false;
  /**
   * R890: `"test"`: one codeunit per call, rollback per test, globals kept. `"method"`: every test
   * alone, codeunit isolation, a fresh codeunit per test (as BC's runner). R896: `"auto"` (the
   * default, `V3_ISOLATION_DEFAULT`): `"test"`, except a codeunit whose baseline passes strictly
   * more tests under `"method"`, chosen once per session.
   */
  readonly isolation: "auto" | "test" | "method";
  /** R938: `--environment` for every al-runner call. Absent: the target's launch.json decides, else no flag. */
  readonly environment?: "saas" | "onprem";
  /** R956: a `.bclicense` file, absolute, passed as `--license <path>` on every al-runner call that runs tests. Absent: none. */
  readonly license?: string;
  /**
   * R948: GiB the memory guard keeps free below the container's cgroup limit: no new test call
   * starts while the container uses more than `memory.max` less this, and the run stops with its
   * report if that does not clear. `0` turns the guard off. Default `MEMORY_HEADROOM_GB_DEFAULT` (4).
   */
  readonly memoryHeadroomGb: number;
  /** R952 (R948): replace a serve daemon whose RSS passed this many GiB; 0 = off. Default `V3_DAEMON_MAX_RSS_GB_DEFAULT`. */
  readonly daemonMaxRssGb: number;
  /** R952 (R948): replace a serve daemon after this many requests; 0 (default) = off. */
  readonly daemonMaxRequests: number;
}

/**
 * R956: the license file's identity as the report and the fingerprint carry it: its path and the
 * sha256 of its bytes, never its contents.
 */
export interface V3LicenseIdentity {
  readonly path: string;
  readonly sha256: string;
}

/** R956: reads the file `alRunnerV3.license` names. Throws by name when it cannot be read. */
export async function readLicenseIdentity(path: string): Promise<V3LicenseIdentity> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (e) {
    throw new Error(
      `al-runner-v3-license-unreadable: "alRunnerV3.license" is ${path}, which cannot be read (${e instanceof Error ? e.message : String(e)}) (R956).`,
    );
  }
  return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * R885: THE default for "may v3 download the CRONUS demo data (about 0.5 GB)". Owner ruling
 * 2026-11-09: yes, as al-runner does. The only place this is decided; flip it here.
 */
export const V3_DOWNLOAD_DEMO_DATA_DEFAULT = true;

/**
 * R952 (R948): THE default of `alRunnerV3.daemonMaxRssGb`. One daemon grew from 1.9 GB to 9.7 GB
 * over a long Subcontracting run (R948); a serve run's tree reached 15.7 GB of the container's 32 GiB.
 * 6 GiB lets a daemon pass its working set many times over before one fresh warm-up replaces it.
 */
export const V3_DAEMON_MAX_RSS_GB_DEFAULT = 6;

/** R907: THE default of `alRunnerV3.noClient`: off, so a run is as before. */
export const V3_NO_CLIENT_DEFAULT = false;

/** R896: THE default of `alRunnerV3.isolation`. Every gate sets `"test"` explicitly. */
export const V3_ISOLATION_DEFAULT = "auto";

const KEYS = [
  "memoryHeadroomGb",
  "daemonMaxRssGb",
  "daemonMaxRequests",
  "license",
  "environment",
  "isolation",
  "downloadDemoData",
  "noClient",
  "dotnetSidecar",
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
 * R834: a configured `alcPath` that is missing or not executable is refused by name here, before
 * the contract probe, whose own report would call it a divergence and say "re-measure".
 */
export function defaultAlcRunnable(
  p: string,
  which: (cmd: string) => string | null = (c) => Bun.which(c),
): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    // A bare name such as "alc" is found on PATH, as a shell would.
    return which(p) !== null;
  }
}

export function assertAlcRunnable(
  alcPath: string,
  canRun: (p: string) => boolean = defaultAlcRunnable,
): void {
  if (!canRun(alcPath)) {
    throw new Error(
      `al-runner-v3-alc-not-found: "alRunnerV3.alcPath" is ${alcPath}, which does not exist or is not executable. Fix the path; scripts/fetch-alc.ts writes a working alc wrapper (README, "Running without a BC server").`,
    );
  }
}

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
      `"alRunnerV3.bcVersion" is required as a four-number BC build (got ${JSON.stringify(r.bcVersion)}): without a build v3 picks the newest BC (R586).`,
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
  if (
    r.dotnetSidecar !== undefined &&
    r.dotnetSidecar !== false &&
    (typeof r.dotnetSidecar !== "string" || r.dotnetSidecar === "")
  ) {
    throw new Error(
      `al-runner-v3-config-refused: "alRunnerV3.dotnetSidecar" must be a non-empty path or false, got ${JSON.stringify(r.dotnetSidecar)} (R886).`,
    );
  }
  if (
    r.isolation !== undefined &&
    r.isolation !== "auto" &&
    r.isolation !== "test" &&
    r.isolation !== "method"
  ) {
    throw new Error(
      `al-runner-v3-config-refused: "alRunnerV3.isolation" must be "auto", "test" or "method", got ${JSON.stringify(r.isolation)} (R890, R896).`,
    );
  }
  if (r.environment !== undefined && r.environment !== "saas" && r.environment !== "onprem") {
    throw new Error(
      `al-runner-v3-config-refused: "alRunnerV3.environment" must be "saas" or "onprem", got ${JSON.stringify(r.environment)} (R938).`,
    );
  }
  // R956: refused by name before anything runs; the file is read (and hashed) once, by the caller.
  if (r.license !== undefined) {
    if (typeof r.license !== "string" || r.license === "") {
      throw new Error(
        `al-runner-v3-config-refused: "alRunnerV3.license" must be a non-empty path to a .bclicense file, got ${JSON.stringify(r.license)} (R956).`,
      );
    }
    let readable = exists(r.license);
    if (readable) {
      try {
        accessSync(r.license, constants.R_OK);
      } catch {
        readable = false;
      }
    }
    if (!readable) {
      throw new Error(
        `al-runner-v3-license-missing: "alRunnerV3.license" is ${r.license}, which does not exist or cannot be read (R956). Fix the path or drop the key.`,
      );
    }
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
  if (r.downloadDemoData !== undefined && typeof r.downloadDemoData !== "boolean") {
    throw new Error(
      `al-runner-v3-config-refused: "alRunnerV3.downloadDemoData" must be a boolean, got ${JSON.stringify(r.downloadDemoData)} (R885).`,
    );
  }
  if (r.noClient !== undefined && typeof r.noClient !== "boolean") {
    throw new Error(
      `al-runner-v3-config-refused: "alRunnerV3.noClient" must be a boolean, got ${JSON.stringify(r.noClient)} (R907).`,
    );
  }
  if (
    r.memoryHeadroomGb !== undefined &&
    (typeof r.memoryHeadroomGb !== "number" ||
      !Number.isFinite(r.memoryHeadroomGb) ||
      r.memoryHeadroomGb < 0)
  ) {
    throw new Error(
      `al-runner-v3-config-refused: "alRunnerV3.memoryHeadroomGb" must be a number of GiB, 0 or more (0 turns the memory guard off), got ${JSON.stringify(r.memoryHeadroomGb)} (R948).`,
    );
  }
  if (
    r.daemonMaxRssGb !== undefined &&
    (typeof r.daemonMaxRssGb !== "number" ||
      !Number.isFinite(r.daemonMaxRssGb) ||
      r.daemonMaxRssGb < 0)
  ) {
    throw new Error(
      `al-runner-v3-config-refused: "alRunnerV3.daemonMaxRssGb" must be a number of GiB, 0 or more (0 turns the daemon size bound off), got ${JSON.stringify(r.daemonMaxRssGb)} (R952).`,
    );
  }
  if (
    r.daemonMaxRequests !== undefined &&
    (typeof r.daemonMaxRequests !== "number" ||
      !Number.isInteger(r.daemonMaxRequests) ||
      r.daemonMaxRequests < 0)
  ) {
    throw new Error(
      `al-runner-v3-config-refused: "alRunnerV3.daemonMaxRequests" must be a whole number, 0 or more (0 turns the request bound off), got ${JSON.stringify(r.daemonMaxRequests)} (R952).`,
    );
  }
  return {
    memoryHeadroomGb: r.memoryHeadroomGb ?? MEMORY_HEADROOM_GB_DEFAULT,
    daemonMaxRssGb: r.daemonMaxRssGb ?? V3_DAEMON_MAX_RSS_GB_DEFAULT,
    daemonMaxRequests: r.daemonMaxRequests ?? 0,
    downloadDemoData: r.downloadDemoData ?? V3_DOWNLOAD_DEMO_DATA_DEFAULT,
    noClient: r.noClient ?? V3_NO_CLIENT_DEFAULT,
    path: (r.path as string | undefined) ?? defaultV3Path(exists, home),
    packagesDir: r.packagesDir,
    bcVersion: r.bcVersion,
    transport: r.transport ?? "serve-entries",
    transportSource: r.transport === undefined ? "default" : "explicit",
    secondEcho: r.secondEcho ?? true,
    coverage: (r.coverage as "al-runner" | "none" | undefined) ?? "al-runner",
    ...(typeof r.alcPath === "string" ? { alcPath: r.alcPath } : {}),
    ...(typeof r.cacheDir === "string" ? { cacheDir: r.cacheDir } : {}),
    ...(r.dotnetSidecar !== undefined ? { dotnetSidecar: r.dotnetSidecar as string | false } : {}),
    isolation: (r.isolation as "auto" | "test" | "method" | undefined) ?? V3_ISOLATION_DEFAULT,
    ...(r.environment !== undefined ? { environment: r.environment as "saas" | "onprem" } : {}),
    ...(typeof r.license === "string" ? { license: resolve(r.license) } : {}),
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
  "[lethal] al-runner-v3 is NOT authoritative (R586): on the pinned builds v3 refuses an app that does not compile (#5602 is fixed). A statement-form duplicate-key Insert fails with BC's text from edge 8078bcf49 on (#5788 is fixed); on alpha.5 and the edge builds before 8078bcf49 it is refused by name (a lost kill, never a wrong verdict); on an unpinned build (alpha.2) it does not raise, so its kills read survived (#5603), a wrong verdict. Sleep still returns at once on a virtual clock (#5605). On the pinned builds that counts toward the time limit (#5793: right verdict class only, wall time is not BC's); on an unpinned build a covering pass over a project Sleep reads error, and a dependency Sleep is not caught. Notes [v3-codeunit-state-possible] and [v3-refused-test-nearby] mark a kill made in a shared-codeunit run and a survivor beside a refused test. v3 runs every test of a test codeunit together, and bcdev runs one at a time, so state a test sets (the work date, the language, a codeunit variable, a SingleInstance codeunit, a bound subscriber) can carry over to later tests of that codeunit on v3 and change a verdict (R857). bcdev remains the authority.";
