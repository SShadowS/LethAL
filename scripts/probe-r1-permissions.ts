#!/usr/bin/env bun
/**
 * ROADMAP R1 live probe — fenced-path write permissions (Stream A).
 *
 * Calls the `LethALControl_RunMutant` OData action DIRECTLY for one named test method, at
 * BASELINE (`mutantId: ""`, i.e. nothing activated), and prints the server's raw answer. The point
 * is to capture BC's VERBATIM permission error text off the fenced path, which the orchestrator
 * only ever surfaces as the summarised note "unstable test X: fails at baseline confirmation".
 *
 * It deliberately does NOT go through `RunMutantTransport`/the orchestrator: those classify and
 * summarise, and the whole question here is what the server actually said.
 *
 * Usage:
 *   bun run scripts/probe-r1-permissions.ts <TestMethodName> [moreMethods...]
 *
 * Connection details come from the gitignored `fixtures/sandbox-data/lethal.config.local.json`,
 * never from constants here — the same file the table gate reads, so this probe can never target a
 * different container than the run it is explaining.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const CONFIG_PATH = join(REPO_ROOT, "fixtures", "sandbox-data", "lethal.config.local.json");

/** `LethAL Sandbox Data` — fixtures/sandbox-data/app.json `id`. The mutation target. */
const TARGET_APP_ID = "aa2f0691-47c3-470e-a351-5bfe955d4f13";
/**
 * `Data Tests` (79310) — fixtures/sandbox-data-tests/src/DataTests.Codeunit.al. Override with
 * `R1_CODEUNIT` to point at the R1 permission probe codeunit (79311) instead.
 */
const TEST_CODEUNIT_ID = (() => {
  const raw = process.env.R1_CODEUNIT;
  if (raw === undefined) return 79310;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw new Error(`R1_CODEUNIT must be an integer, got ${raw}`);
  return parsed;
})();

interface BcDevSection {
  readonly server: string;
  readonly serverInstance: string;
  readonly company: string;
  readonly username: string;
  readonly password: string;
  readonly tenant?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Fail loudly on a missing/!string key rather than defaulting: a probe that silently targets
 * `undefined:7048` and reports a connection error would be blamed on the container.
 */
function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v === "") {
    throw new Error(`lethal.config.local.json: bcdev.${key} must be a non-empty string`);
  }
  return v;
}

async function loadConfig(): Promise<BcDevSection> {
  const parsed: unknown = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.bcdev)) {
    throw new Error(`${CONFIG_PATH}: expected a top-level "bcdev" object`);
  }
  const b = parsed.bcdev;
  const tenant = b.tenant;
  return {
    server: requireString(b, "server"),
    serverInstance: requireString(b, "serverInstance"),
    company: requireString(b, "company"),
    username: requireString(b, "username"),
    password: requireString(b, "password"),
    ...(typeof tenant === "string" ? { tenant } : {}),
  };
}

class Client {
  private readonly baseUrl: string;
  private readonly auth: string;

  constructor(private readonly cfg: BcDevSection) {
    // Mirrors packages/runner/src/cli.ts odataBaseUrl(): `<server>:7048/<instance>`.
    this.baseUrl = `${cfg.server}:7048/${cfg.serverInstance}`;
    this.auth = `Basic ${btoa(`${cfg.username}:${cfg.password}`)}`;
  }

  private url(action: string): string {
    const params = new URLSearchParams({ company: this.cfg.company });
    if (this.cfg.tenant !== undefined) params.set("tenant", this.cfg.tenant);
    return `${this.baseUrl}/ODataV4/LethALControl_${action}?${params.toString()}`;
  }

  /** Raw POST. Returns the HTTP status and the untouched body text — no classification. */
  async post(
    action: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; text: string }> {
    const res = await fetch(this.url(action), {
      method: "POST",
      headers: { authorization: this.auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  }

  /** POST an action whose AL result is a `JsonObject.WriteTo`'d string inside OData's `value`. */
  async postJson(action: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { status, text } = await this.post(action, body);
    if (status < 200 || status >= 300) {
      throw new Error(`${action} -> HTTP ${status}: ${text}`);
    }
    const envelope: unknown = JSON.parse(text);
    const value = isRecord(envelope) ? envelope.value : undefined;
    if (typeof value !== "string") throw new Error(`${action}: no string "value" in ${text}`);
    const inner: unknown = JSON.parse(value);
    if (!isRecord(inner)) throw new Error(`${action}: "value" is not a JSON object: ${value}`);
    return inner;
  }

  /** `RegisteredArtifact` returns a bare AL `Text`, so its `value` needs ONE parse, not two. */
  async registeredArtifact(targetAppId: string): Promise<string> {
    const { status, text } = await this.post("RegisteredArtifact", { targetAppId });
    if (status < 200 || status >= 300) {
      throw new Error(`RegisteredArtifact -> HTTP ${status}: ${text}`);
    }
    const envelope: unknown = JSON.parse(text);
    const value = isRecord(envelope) ? envelope.value : undefined;
    if (typeof value !== "string")
      throw new Error(`RegisteredArtifact: no string "value" in ${text}`);
    return value;
  }
}

async function main(): Promise<void> {
  const methods = process.argv.slice(2);
  if (methods.length === 0) {
    throw new Error("usage: bun run scripts/probe-r1-permissions.ts <TestMethodName> [...]");
  }

  const cfg = await loadConfig();
  const client = new Client(cfg);
  console.log(`target: ${cfg.server}:7048/${cfg.serverInstance} company=${cfg.company}`);

  const info = await client.postJson("HarnessInfo", { clientProtocol: 2 });
  const serverGeneration = info.serverGeneration;
  if (typeof serverGeneration !== "string") {
    throw new Error(`HarnessInfo returned no string serverGeneration: ${JSON.stringify(info)}`);
  }
  console.log(`serverGeneration: ${serverGeneration}`);

  const artifactId = await client.registeredArtifact(TARGET_APP_ID);
  if (artifactId === "") {
    throw new Error(
      `no artifact registered for target ${TARGET_APP_ID} — publish an instrumented build first`,
    );
  }
  console.log(`registered artifactId: ${artifactId}`);

  const acquire = await client.postJson("AcquireLease", {
    owner: "probe-r1-permissions",
    ttlSeconds: 300,
    clientNonce: `r1-${Date.now()}`,
    expectedGeneration: serverGeneration,
  });
  if (acquire.granted !== true) {
    throw new Error(`lease not granted: ${JSON.stringify(acquire)}`);
  }
  const epoch = acquire.epoch;
  const token = acquire.token;
  const lastCompletedOpSeq = acquire.lastCompletedOpSeq;
  if (
    typeof epoch !== "number" ||
    typeof token !== "string" ||
    typeof lastCompletedOpSeq !== "number"
  ) {
    throw new Error(`malformed acquire grant: ${JSON.stringify(acquire)}`);
  }
  console.log(`lease granted: epoch=${epoch} lastCompletedOpSeq=${lastCompletedOpSeq}\n`);

  let opSeq = lastCompletedOpSeq;
  try {
    for (const [i, method] of methods.entries()) {
      opSeq += 1;
      console.log(`--- RunMutant baseline (mutantId="") method=${method} opSeq=${opSeq} ---`);
      const { status, text } = await client.post("RunMutant", {
        targetAppId: TARGET_APP_ID,
        artifactId,
        attemptId: `probe-r1-${Date.now()}-${i}`,
        mutantId: "",
        testCodeunitId: TEST_CODEUNIT_ID,
        testMethod: method,
        leaseEpoch: epoch,
        leaseToken: token,
        serverGeneration,
        opSeq,
      });
      console.log(`HTTP ${status}`);
      // Print the fully unwrapped codeunitResults when present — that is where the test
      // framework's own message lives, and it is a JSON string nested inside a JSON string.
      try {
        const envelope: unknown = JSON.parse(text);
        const value = isRecord(envelope) ? envelope.value : undefined;
        if (typeof value === "string") {
          const inner: unknown = JSON.parse(value);
          console.log(JSON.stringify(inner, null, 2));
          if (isRecord(inner) && typeof inner.codeunitResults === "string") {
            console.log("--- codeunitResults (parsed) ---");
            console.log(JSON.stringify(JSON.parse(inner.codeunitResults), null, 2));
          }
        } else {
          console.log(text);
        }
      } catch {
        console.log(text);
      }
      console.log("");
    }
  } finally {
    const released = await client.postJson("ReleaseLease", {
      epoch,
      token,
      generation: serverGeneration,
    });
    console.log(`ReleaseLease: ${JSON.stringify(released)}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
