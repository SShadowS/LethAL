/**
 * R586 §12 (plan `docs/superpowers/plans/2026-10-21-r586-alrunner-v3-backend.md`, r2 §12 with r3's
 * F6): the pin. Each gated v3 build lives in `/work/tools/al-runner-v3/<version>-<commit>/` with
 * the binary named `al-runner` and a `.gated` file beside it; `current` points at the gated build.
 * The backend runs a binary only when its `.gated` names exactly its `--version` line and sha256
 * (`al-runner-v3-ungated-build` otherwise). The update gate runs a CANDIDATE, which has no `.gated`
 * yet, with `LETHAL_ALRUNNER_V3_CANDIDATE=1`; only that check is relaxed.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const AL_RUNNER_V3_ROOT = "/work/tools/al-runner-v3";
export const AL_RUNNER_V3_DEFAULT_PATH = `${AL_RUNNER_V3_ROOT}/current/al-runner`;

/** `.gated`, as the update script writes it when every leg passed. */
export interface GatedBuild {
  readonly version: string;
  readonly binarySha256: string;
  /** The LethAL commit whose gate passed this build (F6 b): candidates are gated at it. */
  readonly lethalCommit: string;
  readonly tarballSha256?: string;
  readonly gatedAt?: string;
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
  return {
    version: g.version,
    binarySha256: g.binarySha256,
    lethalCommit: g.lethalCommit,
    ...(typeof g.tarballSha256 === "string" ? { tarballSha256: g.tarballSha256 } : {}),
    ...(typeof g.gatedAt === "string" ? { gatedAt: g.gatedAt } : {}),
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
 * read and the measured sha256 is returned with an empty `lethalCommit`.
 */
export async function checkGated(
  alRunnerPath: string,
  version: string,
  opts: { readonly candidate?: boolean } = {},
): Promise<GatedBuild> {
  const sha = await sha256OfFile(alRunnerPath);
  if (opts.candidate === true) return { version, binarySha256: sha, lethalCommit: "" };
  const where = join(dirname(alRunnerPath), ".gated");
  let text: string;
  try {
    text = await readFile(where, "utf8");
  } catch {
    throw new AlRunnerV3UngatedBuildError(
      `${alRunnerPath} has no ${where}; only a gated build runs`,
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
  return gated;
}
