/**
 * Which fixture config a live itest runs against.
 *
 * Every env-gated itest read `lethal.config.local.json` from its fixture directory by a hardcoded
 * name. That is right for the human workflow, where one developer has one set of containers. It is
 * not enough for the autonomous orchestrator, which runs the same gates against DEDICATED
 * containers so its runs can never collide with the owner's own session. Two configs have to be
 * selectable without editing the gate files, because editing a gate to point it somewhere else is
 * exactly the kind of change that gets left behind: a crashed run would leave the owner's next
 * `itest:tables` publishing to the agent's container.
 *
 * So the name comes from `LETHAL_ITEST_CONFIG`, defaulting to the existing one. Nothing changes for
 * a human who does not set it.
 *
 * The value is a BASENAME, never a path. It is joined onto the fixture directory the caller
 * chose, and a value carrying a separator, a drive letter or `..` is refused rather than resolved.
 * A live itest publishes to whatever server its config names, so "which file is this" decides
 * which machine gets written to; letting an environment variable redirect that outside the fixture
 * would make an env var enough to aim a publish anywhere.
 */

import { join } from "node:path";

/** Thrown for a malformed `LETHAL_ITEST_CONFIG`. Never falls back to the default silently. */
export class ItestConfigNameError extends Error {}

/** The default every itest used before this existed, and still uses when nothing is set. */
export const DEFAULT_ITEST_CONFIG = "lethal.config.local.json";

/**
 * `lethal.config.<name>.json`, where `<name>` is alphanumeric with dashes.
 *
 * Deliberately narrower than "no separators". The files this selects between are all siblings with
 * one naming convention, so a name outside it is a mistake worth hearing about rather than a
 * filename worth honouring.
 */
const VALID = /^lethal\.config\.[A-Za-z0-9-]+\.json$/;

export function itestConfigName(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.LETHAL_ITEST_CONFIG;
  if (raw === undefined || raw === "") return DEFAULT_ITEST_CONFIG;
  if (!VALID.test(raw)) {
    throw new ItestConfigNameError(
      `LETHAL_ITEST_CONFIG=${JSON.stringify(raw)} is not a bare fixture config filename. Expected something like lethal.config.agent.json: a sibling of the fixture's own config, with no path separators. A live itest publishes to whatever server its config names, so this value decides which machine gets written to.`,
    );
  }
  return raw;
}

/** The config path for a fixture directory, honouring `LETHAL_ITEST_CONFIG`. */
export function itestConfigPath(projectDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(projectDir, itestConfigName(env));
}
