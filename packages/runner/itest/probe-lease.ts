import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { ActivationConfig } from "../src/activation";
import { HarnessVerifier } from "../src/harness";
import { LeaseClient, MAX_TTL_SECONDS } from "../src/lease";
import type { Lease } from "../src/lease";

// Shared by the gates that drive `RunMutantTransport` DIRECTLY after `runSession` (bcdev's
// protocol-invariant probes, and GH-24's reach baseline in tables). Moved here unchanged from
// bcdev.itest.ts.

/**
 * Layer 5C-B1 (Task 8): the protocol-invariant probes below drive `RunMutantTransport` DIRECTLY,
 * not through `runSession`, so they must take the machine-global lease themselves — the two-phase
 * fence (design §5) refuses any RunMutant whose (epoch, token, serverGeneration) tuple does not
 * match the row, or whose `opSeq` is not exactly `lastCompletedOpSeq + 1`. `runSession` has
 * already released its own lease by the time the probes run, so this acquire is uncontended.
 *
 * Also live-exercises the renew heartbeat: the probes take minutes and the ttl is 15s, so without
 * renewing, the lease would lapse mid-probe (phase 1 honors a matching-but-lapsed tuple, but a
 * competing acquire could then steal it — exactly the design §9 "slow-run-under-renew" case).
 */
export interface ProbeLease {
  readonly client: LeaseClient;
  readonly lease: Lease;
  /** The next exactly-next `opSeq` for a fenced RunMutant. */
  readonly nextOpSeq: () => number;
  /**
   * Task 9 diagnosability fix: the heartbeat used to be `client.renew(...).catch(() => {})` with
   * `renewed` never inspected — a genuinely lost probe lease then surfaced only as a downstream
   * protocol-invariant assertion failure with no hint it was actually a lease problem. Returns
   * `lost:true` once the heartbeat has seen `renewed:false` TWICE in a row (retry-once on a lost
   * ack before concluding loss, design §6) or a renew call itself throw twice in a row — a single
   * bad renew is not conclusive, but two are.
   */
  readonly leaseLostDiagnosis: () => string | undefined;
  readonly stop: () => Promise<void>;
}

export async function acquireProbeLease(cfg: ActivationConfig): Promise<ProbeLease> {
  const harness = await new HarnessVerifier(cfg).verify();
  const client = new LeaseClient(cfg);
  const outcome = await client.acquire(
    `${hostname()}:${process.pid}:probes`,
    MAX_TTL_SECONDS,
    randomUUID(),
    harness.serverGeneration,
  );
  if (!outcome.granted) {
    throw new Error(
      `probe lease was not granted (${JSON.stringify(outcome)}) — the container is held or has a stranded operation; recover per design §8 before re-running the gate`,
    );
  }
  const lease = outcome.lease;
  let opSeq = lease.lastCompletedOpSeq;
  let consecutiveRenewFailures = 0;
  let lostDiagnosis: string | undefined;
  const heartbeat = setInterval(
    () => {
      void client
        .renew(lease, MAX_TTL_SECONDS)
        .then((r) => {
          if (r.renewed) {
            consecutiveRenewFailures = 0;
            return;
          }
          consecutiveRenewFailures++;
          if (consecutiveRenewFailures >= 2 && lostDiagnosis === undefined) {
            lostDiagnosis = `probe lease heartbeat: RenewLease returned renewed:false twice in a row (epoch=${lease.epoch}) — the lease is genuinely lost, not a single dropped ack`;
          }
        })
        .catch((err: unknown) => {
          consecutiveRenewFailures++;
          if (consecutiveRenewFailures >= 2 && lostDiagnosis === undefined) {
            lostDiagnosis = `probe lease heartbeat: RenewLease threw twice in a row: ${err instanceof Error ? err.message : String(err)}`;
          }
        });
    },
    Math.floor((MAX_TTL_SECONDS * 1000) / 3),
  );
  return {
    client,
    lease,
    nextOpSeq: () => ++opSeq,
    leaseLostDiagnosis: () => lostDiagnosis,
    stop: async () => {
      clearInterval(heartbeat);
      await client.release(lease).catch(() => {});
    },
  };
}

/**
 * Read the artifact id the deployed target self-registered, via the control extension's read-only
 * `LethALControl_RegisteredArtifact` OData action (Task 6/7). Single-parse OData scalar `value`
 * (a bare string, not the double-JSON RunMutant shape).
 */
export async function odataReadRegisteredArtifact(
  cfg: ActivationConfig,
  targetAppId: string,
): Promise<string> {
  const params = new URLSearchParams({ company: cfg.company });
  if (cfg.tenant !== undefined) params.set("tenant", cfg.tenant);
  const url = `${cfg.baseUrl}/ODataV4/LethALControl_RegisteredArtifact?${params.toString()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${cfg.username}:${cfg.password}`)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ targetAppId }),
  });
  if (!res.ok) {
    throw new Error(`RegisteredArtifact read failed: HTTP ${res.status} ${await res.text()}`);
  }
  const value = ((await res.json()) as { value?: unknown }).value;
  return typeof value === "string" ? value : "";
}
