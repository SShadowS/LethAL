/**
 * R807: one run seed for every al-runner process LethAL starts.
 *
 * From alpha.11 on, al-runner draws a fresh seed for `Random`, `CreateGuid` and SystemIds in every
 * one-shot run and every `serve` request. A test whose result depends on those values could then
 * fail in one request and pass in the next, for a reason that is not the mutant. LethAL pins ONE
 * constant seed instead of a fresh one per run, so resume, lend and carried verdicts compare equal
 * values too. The mechanism is the environment variable: alpha.7 ignores it, harmlessly; the
 * `seed` field and `--seed` are refused by alpha.7 and are not used.
 *
 * Plain consequence: under a constant seed a test that depends on those values reads the same every
 * time, whichever way it goes. v3 therefore cannot report such a test as flaky, the way real BC may.
 *
 * No imports, so `publisher.ts` and `al-runner-server.ts` can both use it.
 */

export const V3_RUN_SEED = 1;
export const V3_SEED_ENV = "ALRUNNER_SEED";
/** Upstream's fallback name for the same variable; O1's unpinned daemon must not inherit it either. */
export const V3_SEED_ENV_FALLBACK = "AL_RUNNER_SEED";

/** The environment extras for an al-runner process: `extra` plus the pinned seed. The one helper every spawn site uses. */
export function v3ChildEnv(extra?: Readonly<Record<string, string>>): Record<string, string> {
  return { ...extra, [V3_SEED_ENV]: String(V3_RUN_SEED) };
}

/**
 * O1's sensitivity check ONLY (serve daemons): `extra` with the seed variable REMOVED from the child's
 * environment (value `undefined`), so an ambient value cannot leak in either.
 */
export function v3UnpinnedEnv(
  extra?: Readonly<Record<string, string>>,
): Record<string, string | undefined> {
  return { ...extra, [V3_SEED_ENV]: undefined, [V3_SEED_ENV_FALLBACK]: undefined };
}

/** The child's full environment: the parent's, then `extra` on top; an `undefined` value removes the name. */
export function mergeChildEnv(
  extra: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string | undefined> = { ...process.env, ...extra };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as Record<string, string>;
}

/** An answer reported a seed other than the pinned one. Extends `Error` directly. */
export class AlRunnerV3SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlRunnerV3SeedError";
  }
}

/**
 * Read-back. An answer with no `seed` is accepted (alpha.7 has fixed values). One that reports a
 * seed must report seed 1 with `seedSource` `env`; anything else refuses the session.
 * Returns the seed read, or `undefined` when the answer reported none.
 */
export function checkRunSeed(
  answer: { readonly seed?: unknown; readonly seedSource?: unknown },
  where: string,
): number | undefined {
  if (answer.seed === undefined) return undefined;
  if (answer.seed !== V3_RUN_SEED || answer.seedSource !== "env") {
    throw new AlRunnerV3SeedError(
      `al-runner v3 (${where}) reported seed ${JSON.stringify(answer.seed)} with seedSource ${JSON.stringify(answer.seedSource)}, LethAL pinned ${V3_SEED_ENV}=${V3_RUN_SEED} (source "env") (R807); refusing the session`,
    );
  }
  return V3_RUN_SEED;
}
