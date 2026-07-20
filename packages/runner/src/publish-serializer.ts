/**
 * Serializes `ContainerDeployer.publish()` calls that target the same physical Business Central
 * container. `altool publishapp --schemaupdatemode ForceSync`'s replace protocol (uninstall the
 * old app, install the new one, with a fallback attempt to reinstall the old one on failure) is
 * NOT concurrency-safe: two genuinely concurrent publishes to one container can race inside BC's
 * own uninstall/reinstall machinery and leave both the target app and its dependent test app
 * uninstalled — verified live against a real dev server (see `fixtures/README.md`'s "Deployment
 * identity (Layer 5A)" section, Probe B, 2026-07-20). This module guarantees LethAL itself never
 * dispatches two overlapping publishes to the same container.
 *
 * **Scope — read before reusing this to claim more than it provides.** This is an in-process
 * mutex: module-level state shared by every `ContainerDeployer` instance constructed in THIS
 * Node/Bun process, keyed by `canonicalContainerKey`. It makes two publishes issued by one
 * process run strictly one-at-a-time. It does NOT, and structurally cannot, coordinate two
 * separate LethAL processes (e.g. two terminal sessions, or two CI jobs) publishing to the same
 * container at the same time — nothing here is visible outside this process's memory. Two-process
 * safety needs a lock outside process memory (a file lock, a lease record on the container, etc.)
 * and is Layer 5C's machine-global lease, not this module. Do not describe this serializer as
 * cross-process safe in code, comments, or docs.
 */

/** Config shape needed to identify a physical BC container. Deliberately independent of
 * `ContainerDeployerConfig` (publisher.ts) rather than importing it, to avoid a dependency cycle
 * (publisher.ts imports FROM this module) — `ContainerDeployerConfig` already has exactly these
 * fields (plus more) and satisfies this interface structurally as-is. */
export interface ContainerKeyConfig {
  readonly server: string;
  readonly serverInstance: string;
  readonly tenant?: string;
}

/** Lowercases and strips exactly one trailing slash, so `http://Cronus281/` and
 * `http://cronus281` name the same container. */
function normalizeServer(server: string): string {
  const lower = server.toLowerCase();
  return lower.endsWith("/") ? lower.slice(0, -1) : lower;
}

/**
 * Canonical identity for a physical BC container: two configs naming the same server (modulo
 * case/trailing slash), server instance, and tenant (an omitted tenant is the same container as
 * an explicit `"default"`) collapse to the same key. This is the key `serializePublish` locks
 * on, and the key Layer 5D's container pool is expected to reuse for leasing — the normalization
 * needs to be correct now so that later reuse doesn't have to redo it.
 */
export function canonicalContainerKey(cfg: ContainerKeyConfig): string {
  return `${normalizeServer(cfg.server)}|${cfg.serverInstance}|${cfg.tenant ?? "default"}`;
}

/** Process-global (module-level) queue tail per container key — deliberately NOT attached to any
 * `ContainerDeployer` instance, so two deployer instances constructed separately but pointed at
 * the same container still serialize against each other. Each entry never rejects (see
 * `serializePublish`), so awaiting it as a "gate" can never itself throw. */
const chains = new Map<string, Promise<void>>();

/**
 * Runs `fn` exclusively among all callers currently queued on `key`, process-wide. Calls on the
 * same key run strictly one-at-a-time, in call order; calls on different keys run fully
 * concurrently — this must NOT become a single global lock across every container, since a later
 * layer's container pool depends on different containers publishing in parallel.
 *
 * A rejecting `fn` still releases the key for the next queued call: the queue chains on
 * settlement (success or failure), never on success alone, so one failed publish can never
 * deadlock a later one on the same key.
 */
export function serializePublish<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const gate = chains.get(key) ?? Promise.resolve();
  const run = gate.then(fn);
  const settled: Promise<void> = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, settled);
  // Best-effort cleanup: if no newer call queued behind us while we ran, drop the entry so the
  // map doesn't grow unboundedly over a long-lived process's lifetime across many containers.
  settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return run;
}
