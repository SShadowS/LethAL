/**
 * R387: the CLI-default leg of `itest:alrunner`, and the evidence that its defaults took effect.
 *
 * The leg builds its backend through `buildBackend` (cli.ts) with an `alRunner` section that sets
 * no transport key, so it measures what a CLI user gets with no config. Its verdict table cannot
 * tell the fast path from the one-shot static path (both reach 3 / 16 / 0), so the leg also records,
 * independently of the config:
 * - every al-runner spawn, through `buildBackend`'s injectable `deps` spawns: exactly one `--server`
 *   daemon per backend, and no one-shot call except the exact argvs `expectedOneShotArgvs` allows;
 * - the resource selector: the resource file exists after each `deploy()`, holds the activated id
 *   after each `activate()`, and the bundle's `*.al` text changes once per deploy, never per
 *   activation. al-runner's output cache keys on that text (R222), so the number of distinct `*.al`
 *   hashes is the number of compiles.
 *
 * Pre-committed in docs/superpowers/specs/2026-10-01-r387-cli-default-leg-precommitment.md. Kept out
 * of `al-runner.itest.ts` because that script runs its gate at import (R186), and so the checks can
 * be unit-tested offline (`packages/runner/tests/cli-al-runner-defaults.test.ts`).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  SELECTOR_RESOURCE_FOLDER,
  SELECTOR_RESOURCE_NAME,
  SELECTOR_RESOURCE_NONE,
} from "@lethal/schemata";
import { provisionArgv } from "../src/al-runner-backend";
import { isPredefinedProbeArgv } from "../src/al-runner-predefined-probe";
import type { ServerProcessHandle, ServerSpawnFn } from "../src/al-runner-server";
import {
  normalisePlatformAppsPath,
  parseAlRunnerPlatformAppsDir,
} from "../src/al-runner-transport";
import type { ExecutionBackend } from "../src/backend";
import type { SpawnFn } from "../src/publisher";
import type { SessionReport } from "../src/report";

export const CLI_DEFAULT_SPEC =
  "docs/superpowers/specs/2026-10-01-r387-cli-default-leg-precommitment.md";

/** The file whose mutants are `no-coverage` in leg A and `survived` here (coverage is off). */
const PRICING_FILE = "SandboxPricing.Codeunit.al";

export interface SpawnRecord {
  readonly oneShotArgv: string[][];
  readonly serverArgv: string[][];
  /** Everything every daemon wrote to stderr, for the platform-app directory it names, if any. */
  serverStderr: string;
}

/** Wraps the real spawns so the leg sees every argv and the daemons' stderr. */
export function recordSpawns(
  oneShot: SpawnFn,
  server: ServerSpawnFn,
): { record: SpawnRecord; spawn: SpawnFn; serverSpawn: ServerSpawnFn } {
  const record: SpawnRecord = { oneShotArgv: [], serverArgv: [], serverStderr: "" };
  const spawn: SpawnFn = (argv, opts) => {
    record.oneShotArgv.push([...argv]);
    return oneShot(argv, opts);
  };
  const serverSpawn: ServerSpawnFn = (argv) => {
    record.serverArgv.push([...argv]);
    const handle = server(argv);
    const decoder = new TextDecoder();
    const stderr: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        for await (const chunk of handle.stderr) {
          record.serverStderr += decoder.decode(chunk, { stream: true });
          yield chunk;
        }
      },
    };
    const teed: ServerProcessHandle = { ...handle, stderr };
    return teed;
  };
  return { record, spawn, serverSpawn };
}

export interface ResourceEvidence {
  deploys: number;
  activations: number;
  /** One entry per deploy or activate that broke the resource contract, naming which. */
  readonly problems: string[];
  /** Hash of the bundle's `*.al` text seen at each activation. */
  readonly alHashes: Set<string>;
}

async function alHash(dir: string): Promise<string> {
  const h = createHash("sha256");
  const rels = (await readdir(dir, { recursive: true }))
    .map((e) => e.toString())
    .filter((e) => e.toLowerCase().endsWith(".al"))
    .sort();
  for (const rel of rels) {
    h.update(rel);
    h.update(await readFile(join(dir, rel)));
  }
  return h.digest("hex");
}

/**
 * Wraps `deploy` and `activate` ON THE INSTANCE, so `instanceof` and every structural check
 * `runSession` makes still see the real backend. `activeDir` is where `AlRunnerBackend.deploy`
 * copies each batch: `<scratchDir>/al-runner-active/active` for a backend built by `buildBackend`.
 */
export function watchResourceSelector(
  backend: ExecutionBackend,
  activeDir: string,
): ResourceEvidence {
  const ev: ResourceEvidence = { deploys: 0, activations: 0, problems: [], alHashes: new Set() };
  const resource = join(activeDir, SELECTOR_RESOURCE_FOLDER, SELECTOR_RESOURCE_NAME);
  const deploy = backend.deploy.bind(backend);
  const activate = backend.activate.bind(backend);
  backend.deploy = async (dir) => {
    const out = await deploy(dir);
    ev.deploys += 1;
    if (!existsSync(resource))
      ev.problems.push(`deploy ${ev.deploys}: no resource file ${resource}`);
    return out;
  };
  backend.activate = async (id) => {
    await activate(id);
    ev.activations += 1;
    const want = id ?? SELECTOR_RESOURCE_NONE;
    const got = existsSync(resource) ? await readFile(resource, "utf8") : undefined;
    if (got !== want) {
      ev.problems.push(
        `activate(${String(id)}): resource file holds ${got === undefined ? "nothing" : JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
      );
    }
    ev.alHashes.add(await alHash(activeDir));
  };
  return ev;
}

/**
 * THE ONE-SHOT ALLOW-LIST under `--server`, and its only home. Under `--server` the only one-shot
 * calls are `provisionOnce`'s (its exact argv, from the same `provisionArgv` the backend spawns) and
 * `status()`'s probe, exactly `[alRunnerPath, "--version"]`. `cliDefaultMechanismFailures` allows a
 * one-shot argv only when it is element-for-element EQUAL to one of these, each at most once per
 * backend. A different binary path, an extra element, or a test filter beside the sentinel is not
 * equal, so it fails. A new legitimate one-shot call is added HERE, by exact argv, never by a looser
 * pattern.
 */
export function expectedOneShotArgvs(
  cfg: Parameters<typeof provisionArgv>[0],
): readonly (readonly string[])[] {
  return [provisionArgv(cfg), [cfg.alRunnerPath, "--version"]];
}

const sameArgv = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Every one-shot argv without the binary path, for the leg's log line. */
export function oneShotArgvSummary(record: SpawnRecord): string[] {
  return record.oneShotArgv.map((a) => a.slice(1).join(" "));
}

/** Every mechanism failure at once, so a red-check shows each default that did not take effect. */
export function cliDefaultMechanismFailures(
  record: SpawnRecord,
  resource: ResourceEvidence,
  /** `expectedOneShotArgvs(cfg)` for the config the leg's backend was built from. */
  allowedOneShot: readonly (readonly string[])[],
  backends = 1,
): string[] {
  const out: string[] = [];
  const servers = record.serverArgv.filter((a) => a.includes("--server")).length;
  if (servers !== backends) {
    out.push(`server: expected ${backends} --server spawn(s), saw ${servers}`);
  }
  // An EXACT allow-list (see `expectedOneShotArgvs`), not a `--test` filter or a sentinel search: a
  // whole-suite run carries no `--test`, and a real test run can carry the sentinel as a stray
  // element. Measured live 2026-10-01: `provisionOnce` runs under `--server` too, and `runSession`
  // calls `status()` first. Anything else is a one-shot run the daemon should have made.
  const seen = allowedOneShot.map(() => 0);
  const other: string[][] = [];
  // R392: the predefined-symbol probe is the one other allowed one-shot spawn, exactly once per
  // backend and REQUIRED (a session that skipped it would run on an assumed symbol list). Its
  // scratch dirs are random, so `isPredefinedProbeArgv` rebuilds the argv from `predefinedProbeArgv`.
  // The binary path is the first element of every allowed argv (they all come from one config).
  const alRunnerPath = allowedOneShot[0]?.[0] ?? "";
  let probes = 0;
  for (const argv of record.oneShotArgv) {
    const i = allowedOneShot.findIndex((a) => sameArgv(a, argv));
    if (i >= 0) seen[i] = (seen[i] ?? 0) + 1;
    else if (isPredefinedProbeArgv(argv, alRunnerPath)) probes += 1;
    else other.push(argv);
  }
  if (other.length !== 0) {
    out.push(
      `server: expected no one-shot run besides the allowed provisioning, --version and R392 probe argvs, saw ${other.length}: ${other.map((a) => a.join(" ")).join(" | ")}`,
    );
  }
  if (probes === 0) out.push(`server: R392 probe did not run (expected ${backends})`);
  else if (probes > backends) {
    out.push(`server: expected at most ${backends} R392 probe spawn(s), saw ${probes}`);
  }
  allowedOneShot.forEach((a, i) => {
    const n = seen[i] ?? 0;
    if (n > backends) {
      out.push(`server: expected at most ${backends} of ${a.slice(1).join(" ")}, saw ${n}`);
    }
  });
  if (resource.activations === 0) out.push("resource: no activate() was observed");
  out.push(...resource.problems.map((p) => `resource: ${p}`));
  // At most one per deploy: two batches with byte-identical text would share one compile.
  if (resource.alHashes.size > resource.deploys) {
    out.push(
      `resource: the bundle's *.al text took ${resource.alHashes.size} distinct value(s) over ${resource.activations} activation(s) and ${resource.deploys} deploy(s); one per deploy means one compile per batch`,
    );
  }
  return out;
}

/** What two legs are compared on, per mutant. */
export interface LegRow {
  readonly mutantCode: string;
  readonly verdict: string;
  readonly killingTest: string | undefined;
}

export function legShape(r: SessionReport): LegRow[] {
  return [...r.mutants]
    .map((m) => ({ mutantCode: m.mutantCode, verdict: m.verdict, killingTest: m.killingTest }))
    .sort((a, b) => a.mutantCode.localeCompare(b.mutantCode));
}

/** The pre-committed table, derived from leg A: only `SandboxPricing`'s rows change. */
export function expectedCliDefaultShape(legA: SessionReport): LegRow[] {
  const pricing = new Set(
    legA.mutants.filter((m) => m.file.endsWith(PRICING_FILE)).map((m) => m.mutantCode),
  );
  if (pricing.size !== 4) {
    throw new Error(
      `R387: leg A holds ${pricing.size} ${PRICING_FILE} mutants; ${CLI_DEFAULT_SPEC} pre-committed 4`,
    );
  }
  return legShape(legA).map((row) =>
    pricing.has(row.mutantCode)
      ? { mutantCode: row.mutantCode, verdict: "survived", killingTest: undefined }
      : row,
  );
}

/**
 * A REPORT line, never an assertion: whether the platform-app directory the daemon named on stderr
 * agrees with leg A's pinned one. Only the daemon's own words count: a directory derived from its
 * `[bc] selected` line (`selected-artifact`) is an inference, so it reads as "not named".
 */
export function platformAppsAgreement(legADir: string | undefined, daemonStderr: string): string {
  const parsed = parseAlRunnerPlatformAppsDir(daemonStderr);
  const named =
    parsed.kind === "found" && parsed.basis !== "selected-artifact"
      ? [parsed.dir]
      : parsed.kind === "conflicting"
        ? [...parsed.dirs]
        : [];
  if (named.length === 0) {
    return "platform apps: the daemon named no platform-app directory on stderr (a stated limit, not inferred)";
  }
  const a = legADir ?? "<not recorded>";
  const agree =
    legADir !== undefined &&
    named.every((d) => normalisePlatformAppsPath(d) === normalisePlatformAppsPath(legADir));
  return `platform apps: ${agree ? "AGREE" : "DIFFER"}, leg A ${a}, daemon ${named.join(" | ")}`;
}

/** The platform-app directory a daemon named on stderr, if it named one. Never inferred. */
export function daemonPlatformAppsLines(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .filter((l) => /platform[-_ ]apps/i.test(l))
    .map((l) => l.trim());
}
