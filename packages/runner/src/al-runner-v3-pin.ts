/**
 * R586 §12 (plan `docs/superpowers/plans/2026-10-21-r586-alrunner-v3-backend.md`, r2 §12 with r3's
 * F6): the pin. Each gated v3 build lives in `/work/tools/al-runner-v3/<version>-<commit>/` with
 * the binary named `al-runner` and a `.gated` file beside it; `current` points at the gated build.
 * The backend runs a binary only when its `.gated` names exactly its `--version` line and sha256
 * (`al-runner-v3-ungated-build` otherwise). The update gate runs a CANDIDATE, which has no `.gated`
 * yet, with `LETHAL_ALRUNNER_V3_CANDIDATE=1`; only that check is relaxed.
 * R814: a user has no `.gated`. A binary with none passes when the shipped gate manifest lists that
 * exact release (version line AND sha256); anything else is refused with the install command.
 */
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { adoptV3Pin, findGatedBuild, newestGatedRelease } from "./al-runner-v3-pins";

export const AL_RUNNER_V3_ROOT = "/work/tools/al-runner-v3";
export const AL_RUNNER_V3_DEFAULT_PATH = `${AL_RUNNER_V3_ROOT}/current/al-runner`;
/** R814: the hand pin a candidate is judged by; read only in candidate mode. */
export const V3_PIN_FROM_ENV = "LETHAL_V3_PIN_FROM";

/**
 * R814: `current` moves daily, so a session resolves it once, at its start: the binary measured is
 * the binary run, and the report names the right build. A path that does not resolve stays as it is.
 */
export function resolveV3Binary(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * R814: what a user does to get a gated build. Upstream's installer checks the download's sha256.
 * A sibling build: LethAL's own `current` follows edge, and this is the newest numbered release
 * that passed its own gate run. Only the linux x64 binary is gated.
 */
export function v3InstallHint(): string {
  const r = newestGatedRelease();
  if (r === undefined) return "No gated al-runner release is listed in this LethAL build.";
  return `To get a gated build on linux x64, install ${r.tag}: curl -fsSL https://github.com/aldevtools/BusinessCentral.AL.Runner/releases/download/edge/install.sh | sh -s -- ${r.tag} , then set alRunnerV3.path to ~/.local/bin/al-runner.`;
}

/**
 * The exact `--version` lines of builds that have no serve-entries path (alpha.2's `.gated`). R761
 * reads it for the transport default. `itest/alrunner-v3-legs.ts` keeps its own copy (it is pure,
 * with no `src` import); `r761-serve-default.test.ts` pins the two equal.
 */
export const V3_NO_SERVE_ENTRIES: readonly string[] = ["alrunner 3.0.0-alpha.2 (91253f2d6)"];

/** `.gated`, as the update script writes it when every leg passed. */
export interface GatedBuild {
  readonly version: string;
  readonly binarySha256: string;
  /** The LethAL commit whose gate passed this build (F6 b): candidates are gated at it. */
  readonly lethalCommit: string;
  readonly tarballSha256?: string;
  readonly gatedAt?: string;
  /** R612 M-2: what the gate's leg C read for each warn fact (`V3_WARN_FACTS`). A gate passes
   *  whatever these read, so a session shows them as read, never as `matches`. */
  readonly warnFacts?: Readonly<Record<string, string>>;
  /** R639 M5: a pass of `--edge-rejudge`: the kept folder its binary came from (no tarball). */
  readonly rejudgedFrom?: string;
  /** R814: the hand pin whose readings this build passed on (a mechanical pin). */
  readonly readingsFrom?: string;
  /** R814: where this record came from; absent: a `.gated` file. Never read from `.gated`. */
  readonly source?: "manifest";
}

/** R612 M-2: the warn-fact readings in `x` (a receipt's or `.gated`'s field); only verdicts are
 *  kept, since a warn fact changes no outcome. `undefined` when there are none. */
export function warnFactReadings(x: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof x !== "object" || x === null) return undefined;
  const kept = Object.entries(x).filter(
    (e): e is [string, string] =>
      e[1] === "matches" || e[1] === "diverged" || e[1] === "unmeasurable",
  );
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

/** The binary is not a gated build. Extends `Error` directly. */
export class AlRunnerV3UngatedBuildError extends Error {
  constructor(detail: string) {
    super(`al-runner-v3-ungated-build: ${detail} (R586 §12)`);
    this.name = "AlRunnerV3UngatedBuildError";
  }
}

/** Strict parse of a `.gated` text; a field of the wrong shape is a corrupt pin, never a default. */
export function parseGated(text: string, where: string): GatedBuild {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AlRunnerV3UngatedBuildError(`${where} is not JSON`);
  }
  const g = (raw ?? {}) as Record<string, unknown>;
  if (typeof g.version !== "string" || g.version === "") {
    throw new AlRunnerV3UngatedBuildError(`${where} has no version`);
  }
  if (typeof g.binarySha256 !== "string" || !/^[0-9a-f]{64}$/.test(g.binarySha256)) {
    throw new AlRunnerV3UngatedBuildError(`${where} has no binarySha256`);
  }
  // G5 (with F6): the full 40-character sha; a short one would make every update run infra-fail.
  if (typeof g.lethalCommit !== "string" || !/^[0-9a-f]{40}$/.test(g.lethalCommit)) {
    throw new AlRunnerV3UngatedBuildError(`${where} has no lethalCommit`);
  }
  const warnFacts = warnFactReadings(g.warnFacts);
  return {
    version: g.version,
    binarySha256: g.binarySha256,
    lethalCommit: g.lethalCommit,
    ...(typeof g.tarballSha256 === "string" ? { tarballSha256: g.tarballSha256 } : {}),
    ...(typeof g.gatedAt === "string" ? { gatedAt: g.gatedAt } : {}),
    ...(warnFacts !== undefined ? { warnFacts } : {}),
    ...(typeof g.rejudgedFrom === "string" ? { rejudgedFrom: g.rejudgedFrom } : {}),
    ...(typeof g.readingsFrom === "string" ? { readingsFrom: g.readingsFrom } : {}),
  };
}

export async function sha256OfFile(path: string): Promise<string> {
  return createHash("sha256")
    .update(new Uint8Array(await readFile(path)))
    .digest("hex");
}

/**
 * T18: the binary at `alRunnerPath`, which answered `--version` with `version`, is the build its
 * `.gated` names. Returns the pin. Throws `AlRunnerV3UngatedBuildError` on no `.gated`, or another
 * sha256 or version. `candidate`: the update gate's run of an ungated build; then the pin is not
 * read and the measured sha256 is returned with an empty `lethalCommit`; `LETHAL_V3_PIN_FROM` then
 * names the hand pin it is judged by. R814: with no `.gated`, the manifest's release entry for this
 * exact binary stands in for one. A `.gated` that exists always decides.
 */
export async function checkGated(
  alRunnerPath: string,
  version: string,
  opts: {
    readonly candidate?: boolean;
    readonly pinFrom?: string;
    /** Tests: the manifest lookup. */
    readonly findBuild?: typeof findGatedBuild;
  } = {},
): Promise<GatedBuild> {
  if (!existsSync(alRunnerPath))
    throw new AlRunnerV3UngatedBuildError(`${alRunnerPath} does not exist. ${v3InstallHint()}`);
  const sha = await sha256OfFile(alRunnerPath);
  if (opts.candidate === true) {
    const from = opts.pinFrom ?? process.env[V3_PIN_FROM_ENV];
    if (from !== undefined && from !== "") adoptV3Pin(version, sha, from);
    return { version, binarySha256: sha, lethalCommit: "" };
  }
  const where = join(dirname(alRunnerPath), ".gated");
  let text: string;
  try {
    text = await readFile(where, "utf8");
  } catch {
    const listed = (opts.findBuild ?? findGatedBuild)(version, sha);
    if (listed?.track === "release")
      return {
        version,
        binarySha256: sha,
        lethalCommit: listed.lethalCommit,
        gatedAt: listed.gatedAt,
        ...(listed.warnFacts !== undefined ? { warnFacts: listed.warnFacts } : {}),
        readingsFrom: listed.readingsFrom,
        source: "manifest",
      };
    throw new AlRunnerV3UngatedBuildError(
      `${alRunnerPath} is "${version}" (sha256 ${sha}), which is not a gated build: it has no ${where} and the gate manifest does not list it; only a gated build runs. ${v3InstallHint()}`,
    );
  }
  const gated = parseGated(text, where);
  if (gated.binarySha256 !== sha) {
    throw new AlRunnerV3UngatedBuildError(
      `${alRunnerPath} has sha256 ${sha}, but ${where} pins ${gated.binarySha256}`,
    );
  }
  if (gated.version !== version) {
    throw new AlRunnerV3UngatedBuildError(
      `${alRunnerPath} reports "${version}", but ${where} pins "${gated.version}"`,
    );
  }
  if (gated.readingsFrom !== undefined) adoptV3Pin(version, sha, gated.readingsFrom);
  return gated;
}
