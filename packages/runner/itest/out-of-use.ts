/**
 * R669: a BC on Linux server with an out-of-use marker, `<coord>/machine/out-of-use/<server>.md`,
 * is refused by name before any lease or server call.
 *
 * A lane writes the marker when a live probe or gate's STOP rule fires (R658): the server may still
 * carry a live session, and the control-app lease and `lethal doctor` can read it clean. The coord
 * lease alone does not keep it off, because it lapses when the holding session dies; the marker
 * does not. Two entry points read it: `scripts/bc-linux-setup.ts` and `printItestTarget`
 * (`config-path.ts`), which every BC itest calls right after it picks its config.
 *
 * Two named overrides, each honoured by ONE entry point:
 * - `LETHAL_OUT_OF_USE_CLEARING=<server>` (bc-linux-setup only): the clearing step itself, which
 *   every marker's "How to clear it" names. It must name the exact server.
 * - `LETHAL_OUT_OF_USE_OWNER=<token>` (the itests only): the marker is the caller's own "in use"
 *   marker, written by a gate wrapper before it starts the gate (R-658's hang wrapper). It passes
 *   only when the marker carries exactly one line `owner: <token>`. The token is 32 lowercase hex
 *   (128 random bits): the wrapper makes it fresh for each run (`openssl rand -hex 16`) and passes
 *   it ONLY on the gate's command line, never exported for the whole wrapper, so no constant and
 *   no leftover shell variable can match a later marker. A STOP marker must not carry the line.
 * Either one, when it lets a server through, logs that the marker exists and why.
 *
 * Entry points honouring the clearing override: `scripts/bc-linux-setup.ts` and
 * `scripts/bc-republish.ts`. The owner override: `printItestTarget` only.
 *
 * This package cannot import `scripts/`, so the host and dev ports below mirror `HOST` and
 * `SERVERS` in `scripts/bc-app-content.ts`; `scripts/bc-linux-setup.test.ts` pins the two equal.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** A server that has an out-of-use marker, refused before any lease or server call. */
export class ServerOutOfUseError extends Error {}

type Env = Readonly<Record<string, string | undefined>>;

export const CLEARING_ENV = "LETHAL_OUT_OF_USE_CLEARING";
export const OWNER_ENV = "LETHAL_OUT_OF_USE_OWNER";

/** The BC on Linux host, as a URL hostname (mirrors `HOST`). */
export const MARKER_HOST = "192.168.2.157";
/** Dev port to server name (mirrors `SERVERS[*].dev`). */
export const MARKER_SERVERS: Readonly<Record<number, string>> = {
  7049: "bc1",
  7149: "bc2",
  7249: "bc3",
};

/**
 * The server name a config's host and dev port name, or `undefined`. Only bc1-bc3 can have a
 * marker: a config naming any other server (the parked Cronus28, an envtool environment, a
 * Windows container) is not checked, so it is never refused here.
 */
export function markedServerFor(host: string, devPort: number): string | undefined {
  return host.toLowerCase() === MARKER_HOST ? MARKER_SERVERS[devPort] : undefined;
}

/** The coord root is wrong for this check: its `machine` dir is missing, or the env disagrees. */
export class OutOfUseRootError extends Error {}

/**
 * The marker directory: under `LETHAL_COORD_ROOT`, else kraken's `CG_COORD_ROOT`, else a default.
 *
 * This copies `resolveRoot` in `scripts/coord-status.ts` instead of calling it, because this
 * package cannot import `scripts/`. It keeps that function's kraken refusal: inside kraken a
 * `LETHAL_COORD_ROOT` that differs from `CG_COORD_ROOT` throws, since the coord CLI there reads
 * `CG_COORD_ROOT`, and the marker would come from another root than the lease. It differs in the
 * last default only: `resolveRoot` returns `H:\lethal-coord` on every platform, right on the
 * Windows host and never right on Linux, where this returns `/coord`. A wrong root cannot read
 * as "no marker" either way: `outOfUseRefusal` throws when `<root>/machine` is missing.
 */
export function outOfUseDir(env: Env = process.env): string {
  if (env.KRAKEN_PROJECT && env.LETHAL_COORD_ROOT && env.LETHAL_COORD_ROOT !== env.CG_COORD_ROOT)
    throw new OutOfUseRootError(
      `LETHAL_COORD_ROOT=${env.LETHAL_COORD_ROOT} differs from CG_COORD_ROOT=${env.CG_COORD_ROOT ?? "(unset)"}; inside kraken the coord root is CG_COORD_ROOT, so the out-of-use markers cannot be read reliably. Unset LETHAL_COORD_ROOT or make the two equal.`,
    );
  const root =
    env.LETHAL_COORD_ROOT ||
    (env.KRAKEN_PROJECT ? env.CG_COORD_ROOT : undefined) ||
    (process.platform === "win32" ? "H:\\lethal-coord" : "/coord");
  return join(root, "machine", "out-of-use");
}

export interface OutOfUseOptions {
  readonly dir: string;
  readonly env: Env;
  /** The one override this entry point honours. */
  readonly override: "clearing" | "owner";
  /** Where the override's loud line goes. */
  readonly log?: (line: string) => void;
}

/** An owner token: 128 random bits as lowercase hex (`openssl rand -hex 16`), never a constant. */
const TOKEN = /^[0-9a-f]{32}$/;

/**
 * `undefined` when `server` may be used; else the refusal, naming the server and the marker.
 * Throws `OutOfUseRootError` when `dir`'s parent (`<root>/machine`) does not exist, so a wrong
 * coord root never reads as "no marker". Only a missing `out-of-use` dir under it means none.
 */
export function outOfUseRefusal(server: string, opts: OutOfUseOptions): string | undefined {
  const machine = dirname(opts.dir);
  if (!existsSync(machine))
    throw new OutOfUseRootError(
      `${machine} does not exist, so ${server}'s out-of-use marker cannot be checked: the coord root is wrong or not mounted. Set LETHAL_COORD_ROOT to the coord root.`,
    );
  const path = join(opts.dir, `${server}.md`);
  if (!existsSync(path)) return undefined;
  const marker = readFileSync(path, "utf8").trimEnd();
  const body = marker
    .split(/\r?\n/)
    .map((l) => `    ${l}`)
    .join("\n");
  const log = opts.log ?? console.error;
  let note: string;
  if (opts.override === "clearing") {
    const v = opts.env[CLEARING_ENV];
    if (v === server) {
      log(
        `!!! ${server} has an out-of-use marker, ${path}; ${CLEARING_ENV}=${server} overrides it for the clearing step. The marker:\n${body}`,
      );
      return undefined;
    }
    note =
      v === undefined || v === ""
        ? `If this run IS the marker's clearing step, set ${CLEARING_ENV}=${server}.`
        : `${CLEARING_ENV}=${JSON.stringify(v)} does not name ${server}, so it does not override this marker.`;
  } else {
    const v = opts.env[OWNER_ENV];
    // Exactly ONE owner line, well formed: two (even if one matches), or a malformed one, refuse.
    const owners = marker
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^owner:/i.test(l));
    const [only] = owners;
    const token = only === undefined ? undefined : /^owner: ([^\s]+)$/.exec(only)?.[1];
    if (
      v !== undefined &&
      owners.length === 1 &&
      token !== undefined &&
      TOKEN.test(token) &&
      token === v
    ) {
      log(
        `!!! ${server} has an out-of-use marker, ${path}, owned by this run (${OWNER_ENV} matches its owner line); let through. The marker:\n${body}`,
      );
      return undefined;
    }
    note =
      v === undefined || v === ""
        ? "A gate run only when the marker is its own wrapper's (an `owner: <token>` line, and the same token in LETHAL_OUT_OF_USE_OWNER)."
        : `${OWNER_ENV} is set but does not match an \`owner:\` line in the marker, so it does not override it.`;
  }
  return `${server} is OUT OF USE: ${path} exists, so this run refuses before any lease or server call. The marker (its reason, and how to clear it):\n${body}\nClear it by the marker's own steps; whoever clears it deletes the file. ${note}`;
}
