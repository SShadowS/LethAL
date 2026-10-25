/**
 * R783: the BC on Linux host (bc1-bc3), from ONE place. Every consumer derives it from here:
 * `HOST` in `scripts/bc-app-content.ts` (the setup script and the configs it writes), the
 * out-of-use marker check (`itest/out-of-use.ts`), `printItestTarget`'s refusal of a config left on
 * the other host (`itest/config-path.ts`), and `scripts/r658-hang-gate.sh`'s `WANT` (it runs this
 * file, which prints the host).
 *
 * `LETHAL_BC_HOST=http://<host>` overrides the committed default. A switch of servers is a change
 * of `DEFAULT_BC_HOST`, or the variable set for every process that touches the servers; then the
 * setup script rewrites the configs (R783's runbook).
 */

/** The known BC on Linux hosts: server1 (the original) and docker1 (its copy, R783). */
export const BC_HOSTS = { server1: "192.168.2.157", docker1: "192.168.2.77" } as const;

/** The host in use when `LETHAL_BC_HOST` is unset. */
export const DEFAULT_BC_HOST: string = BC_HOSTS.server1;

export class BcHostError extends Error {}

/** A config naming the other known BC on Linux host; thrown by `printItestTarget`. */
export class BcHostMismatchError extends Error {}

/** The host name, lower case and with no scheme; `LETHAL_BC_HOST` wins when set. */
export function bcLinuxHost(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const v = env.LETHAL_BC_HOST;
  if (v === undefined || v === "") return DEFAULT_BC_HOST;
  const host = /^http:\/\/([A-Za-z0-9.-]+)$/.exec(v)?.[1];
  if (host === undefined)
    throw new BcHostError(
      `LETHAL_BC_HOST must be http://<host> with no port or path, got ${JSON.stringify(v)}`,
    );
  return host.toLowerCase();
}

/**
 * The refusal for a config naming a KNOWN BC on Linux host other than the one in use, else
 * `undefined`. A config left on the old host after a switch would otherwise run with its out-of-use
 * markers unchecked (they match only the host in use). Other hosts (Cronus28, an envtool
 * environment) have no markers and are never refused here.
 */
export function bcHostMismatch(
  host: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const named = host.toLowerCase();
  const inUse = bcLinuxHost(env);
  if (named === inUse || !(Object.values(BC_HOSTS) as string[]).includes(named)) return undefined;
  return `the config names the BC on Linux host ${named}, but the host in use is ${inUse} (LETHAL_BC_HOST, else ${DEFAULT_BC_HOST}). Rerun bun scripts/bc-linux-setup.ts for this server so its configs name ${inUse}, or set LETHAL_BC_HOST=http://${named} if that host is meant (R783).`;
}

if (import.meta.main) console.log(bcLinuxHost());
