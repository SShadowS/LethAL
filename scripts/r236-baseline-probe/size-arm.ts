/**
 * R236b Task 2, plan section "§A2 The non-TestPage arm": alternates a TestPage call (T,
 * `PageActionComputesNonZero`) against a plain, non-TestPage call (S, `ExtCountRelatedIgnoresDecoys`)
 * on the SAME fixture, both through `RunMutantWithCoverage`, to see whether T's failure mode is really
 * about TestPage or just about a large answer. S's natural clean answer is ~2.9 KB against T's ~6.6 KB
 * (fact 4 in the pre-commitment spec), so S is first calibrated with a widened `coverageObjectIdFilter`
 * to make its answer comparably large.
 *
 * LETHAL_R236_SIZE_ARM=1 bun scripts/r236-baseline-probe/size-arm.ts --config <lethal.config.local.json>
 *   --expect-container <name> --out <file.ndjson> (--pairs <n> | --kept-check <n>)
 *
 * `--kept-check <n>` (R236b Task 8, C1b) skips calibration and the pairs: it makes n direct T calls and,
 * for each whose body arrived whole, reads the kept answer back with `GetOpAnswer` and compares it byte
 * for byte with the body the client received. It exits 1 if any whole call's answer was not found, was
 * not byte-equal, did not score `fail`, or did not carry the `CreateNavTestService` refusal.
 *
 * This script issues no network call itself when the env var is unset (prints `skipped`, exit 0), and
 * refuses (exit 2) before any network call if the required flags are missing, the config's `bcdev.server`
 * host does not match `--expect-container`, or `--out`'s directory does not exist.
 *
 * Exit codes: 0 the arm ran to completion (or S was not runnable); 1 a `--kept-check` mismatch; 2 a harness/config fault, before any
 * network call; 3 a wedge (a failed preflight after a break).
 */
import { appendFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  acquireProbeLease,
  odataReadRegisteredArtifact,
} from "../../packages/runner/itest/probe-lease";
import type { ActivationConfig } from "../../packages/runner/src/activation";
import type { TestMethodRef } from "../../packages/runner/src/backend";
import { bcFetch } from "../../packages/runner/src/bc-fetch";
import type { LethalConfigFile } from "../../packages/runner/src/cli";
import { odataBaseUrl, validateBcDevConfig } from "../../packages/runner/src/cli";
import { HarnessVerifier } from "../../packages/runner/src/harness";
import { RunMutantTransport } from "../../packages/runner/src/run-mutant-transport";
import { type CallTrace, traceFetch } from "./fetch-trace";

/** Pure per §A2's "Reading, first match wins" (task-2-brief step 1). */
export function readA2(r: {
  readonly pairsDone: number;
  readonly pairsPlanned: number;
  readonly sBreaks: number;
  readonly sRunnable: boolean;
}): "grouped fix required" | "grouped fix not required" {
  if (!r.sRunnable || r.sBreaks > 0 || r.pairsDone < r.pairsPlanned) return "grouped fix required";
  return "grouped fix not required";
}

/**
 * R236b C1b: keep a response body ONLY for the original action. The transport's own `GetOpAnswer`
 * readback carries the SAME attempt id, and an unfiltered map would replace the original body with
 * the readback's before the comparison (plan review r2, I5).
 */
export function keepOriginalBody(
  bodies: Map<string, string>,
  trace: { readonly action: string; readonly attemptId?: string },
  text: string,
): void {
  if (
    trace.action !== "LethALControl_RunMutant" &&
    trace.action !== "LethALControl_RunMutantWithCoverage"
  )
    return;
  if (trace.attemptId === undefined) return;
  bodies.set(trace.attemptId, text);
}

/** §A2's calibration ladder, tried in order; the first candidate that qualifies is used for S. */
const CALIBRATION_FILTERS = [
  "79300..79399|130000..130499",
  "79300..79399|130000..139999",
  "79300..79399|1..99999",
] as const;
const CALIBRATION_MIN_BYTES = 6_617;
const CALIBRATION_TIMEOUT_MS = 10_000;
const PAIR_TIMEOUT_MS = 120_000;
const T_FILTER = "79300..79399";

const T_REF: TestMethodRef = {
  codeunitId: 79310,
  codeunitName: "Data Tests",
  method: "PageActionComputesNonZero",
};
const S_REF: TestMethodRef = {
  codeunitId: 79310,
  codeunitName: "Data Tests",
  method: "ExtCountRelatedIgnoresDecoys",
};

class HarnessFault extends Error {}

/** Same derivation as `probe.ts`'s `containerFromServer`, kept local: not a declared dependency. */
function hostOf(server: string | undefined): string {
  const host = /^[a-z][a-z0-9+.-]*:\/\/([^/:?#]+)/i.exec(server ?? "")?.[1];
  if (host === undefined || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(host)) {
    throw new HarnessFault(
      `cannot derive the container name from bcdev.server ${JSON.stringify(server)}: expected a URL such as http://Cronus284`,
    );
  }
  return host;
}

/** Always leaves the record somewhere: the file, else stdout (mirrors `probe.ts`'s `writeRecord`). */
function writeRecord(out: string, record: unknown): void {
  let line = "";
  try {
    line = JSON.stringify(record);
    appendFileSync(out, `${line}\n`);
  } catch (err) {
    console.error(`could not append to ${out}: ${String(err)}; the record follows on stdout`);
    console.log(`R236S-RECORD:${line === "" ? String(record) : line}`);
  }
}

function headersMsOf(trace: CallTrace | undefined): number | null {
  if (trace?.headersAt === undefined) return null;
  return trace.headersAt - trace.dispatchedAt;
}

async function main(): Promise<void> {
  if (process.env.LETHAL_R236_SIZE_ARM !== "1") {
    console.log("skipped");
    process.exit(0);
  }
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      config: { type: "string" },
      "expect-container": { type: "string" },
      out: { type: "string" },
      pairs: { type: "string" },
      "kept-check": { type: "string" },
    },
  });
  const { config, out: outArg } = values;
  const expectContainer = values["expect-container"];
  const keptArg = values["kept-check"];
  const countArg = values.pairs ?? keptArg;
  if (
    config === undefined ||
    expectContainer === undefined ||
    outArg === undefined ||
    countArg === undefined ||
    (values.pairs !== undefined && keptArg !== undefined)
  ) {
    throw new HarnessFault(
      "--config, --expect-container, --out and exactly one of --pairs or --kept-check are required",
    );
  }
  const pairsPlanned = Number(countArg);
  if (!Number.isInteger(pairsPlanned) || pairsPlanned < 1) {
    throw new HarnessFault(
      `--pairs/--kept-check must be a positive integer, got ${JSON.stringify(countArg)}`,
    );
  }
  const out = resolve(outArg);
  if (!existsSync(dirname(out))) {
    throw new HarnessFault(`--out directory does not exist: ${dirname(out)}`);
  }

  const configFile = JSON.parse(await readFile(resolve(config), "utf8")) as LethalConfigFile;
  const bcdev = validateBcDevConfig(configFile.bcdev);
  const configuredHost = hostOf(bcdev.server);
  if (configuredHost !== expectContainer) {
    throw new HarnessFault(
      `refusing: config's bcdev.server host is ${JSON.stringify(configuredHost)}, --expect-container is ${JSON.stringify(expectContainer)}`,
    );
  }

  const odataCfg: ActivationConfig = {
    baseUrl: odataBaseUrl(bcdev.server, bcdev.serverInstance),
    company: bcdev.company,
    username: bcdev.username,
    password: bcdev.password,
    ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
  };

  const projectDir = join(import.meta.dir, "..", "..", "fixtures", "sandbox-data");
  const targetAppJson = JSON.parse(await readFile(join(projectDir, "app.json"), "utf8")) as {
    id?: unknown;
  };
  const targetAppId = targetAppJson.id;
  if (typeof targetAppId !== "string") {
    throw new HarnessFault(`fixtures/sandbox-data/app.json has no string "id"`);
  }

  const artifactId = await odataReadRegisteredArtifact(odataCfg, targetAppId);
  if (!/^[0-9a-f]{32}$/.test(artifactId)) {
    throw new HarnessFault(
      `LethALControl_RegisteredArtifact(${targetAppId}) returned ${JSON.stringify(artifactId)}, not a 32-hex artifact id`,
    );
  }

  const probe = await acquireProbeLease(odataCfg);
  const leaseTuple = () => ({
    epoch: probe.lease.epoch,
    token: probe.lease.token,
    serverGeneration: probe.lease.serverGeneration,
  });
  const fence = () => ({ ...leaseTuple(), opSeq: probe.nextOpSeq() });
  const harnessVerifier = new HarnessVerifier(odataCfg);
  const calls: CallTrace[] = [];
  const bodies = new Map<string, string>();
  const tx = new RunMutantTransport(
    odataCfg,
    targetAppId,
    artifactId,
    traceFetch(bcFetch, calls, { onBody: (trace, text) => keepOriginalBody(bodies, trace, text) }),
  );

  if (keptArg !== undefined) {
    let bad = 0;
    try {
      for (let i = 1; i <= pairsPlanned; i++) {
        const attemptId = `r236s-k-${i}`;
        const lease = fence();
        const { verdict } = await tx.runWithCoverage({
          ref: T_REF,
          mutantId: "",
          attemptId,
          timeoutMs: PAIR_TIMEOUT_MS,
          lease,
          coverageObjectIdFilter: T_FILTER,
        });
        const body = bodies.get(attemptId);
        if (body === undefined) {
          writeRecord(out, {
            kind: "kept-check",
            i,
            whole: false,
            outcome: verdict.outcome,
            operation: verdict.operation ?? null,
            replyRecovered: verdict.replyRecovered ?? null,
          });
          continue;
        }
        const kept = await tx.readKeptAnswer(lease, attemptId, lease.opSeq, 15_000);
        const record = {
          kind: "kept-check",
          i,
          whole: true,
          found: kept.found,
          byteEqual: kept.found && kept.answer === (JSON.parse(body) as { value?: unknown }).value,
          outcome: verdict.outcome,
          clr: verdict.failureMessage?.includes("CreateNavTestService") === true,
        };
        writeRecord(out, record);
        if (!record.found || !record.byteEqual || record.outcome !== "fail" || !record.clr) bad++;
      }
    } finally {
      await probe.stop();
    }
    writeRecord(out, { kind: "kept-check-summary", calls: pairsPlanned, bad });
    process.exit(bad > 0 ? 1 : 0);
  }

  let tBreaks = 0;
  let sBreaks = 0;
  let pairsDone = 0;
  let sRunnable = false;
  let wedged = false;

  /** One dispatch of `ref` under `filter`. A throw (e.g. malformed coverage) leaves outcome/operation
   *  null; `broke` reads only the trace's own `errorPhase`, which `fetch-trace` sets independently. */
  const dispatchOne = async (
    ref: TestMethodRef,
    attemptId: string,
    filter: string,
    timeoutMs: number,
  ): Promise<{
    broke: boolean;
    trace: CallTrace | undefined;
    opSeq: number;
    outcome: string | null;
    operation: string | null;
  }> => {
    const lease = fence();
    let outcome: string | null = null;
    let operation: string | null = null;
    try {
      const result = await tx.runWithCoverage({
        ref,
        mutantId: "",
        attemptId,
        timeoutMs,
        lease,
        coverageObjectIdFilter: filter,
      });
      outcome = result.verdict.outcome;
      operation = result.verdict.operation ?? null;
    } catch {
      // handled below via the trace's own error fields
    }
    const trace = calls.at(-1);
    const broke = trace?.errorPhase === "body" || trace?.errorPhase === "fetch";
    return { broke, trace, opSeq: lease.opSeq, outcome, operation };
  };

  /** One arm of one pair: dispatch, record the `call` line, and on a break read the status and the
   *  preflight. Returns true only when the preflight failed (a wedge: the caller stops the loop). */
  const runArm = async (
    arm: "T" | "S",
    ref: TestMethodRef,
    attemptId: string,
    filter: string,
    pair: number,
  ): Promise<boolean> => {
    const r = await dispatchOne(ref, attemptId, filter, PAIR_TIMEOUT_MS);
    writeRecord(out, {
      kind: "call",
      arm,
      pair,
      bytesReceived: r.trace?.bytesReceived ?? null,
      headersMs: headersMsOf(r.trace),
      errorPhase: r.trace?.errorPhase ?? null,
      error: r.trace?.error ?? null,
      outcome: r.outcome,
      operation: r.operation,
    });
    if (!r.broke) return false;
    if (arm === "T") tBreaks++;
    else sBreaks++;
    const status = await tx
      .getOperationStatus(leaseTuple(), attemptId, r.opSeq)
      .catch((err: unknown) => ({ error: String(err) }) as const);
    writeRecord(out, { kind: "status-read", arm, pair, status });
    try {
      await harnessVerifier.checkReachable();
      return false;
    } catch {
      writeRecord(out, { kind: "wedge" });
      return true;
    }
  };

  try {
    // ---- calibration (not counted) ----
    for (const [i, filter] of CALIBRATION_FILTERS.entries()) {
      const started = Date.now();
      const { trace } = await dispatchOne(S_REF, `r236s-cal-${i}`, filter, CALIBRATION_TIMEOUT_MS);
      const ms = Date.now() - started;
      const bytes = trace?.bytesReceived ?? 0;
      writeRecord(out, {
        kind: "calibration",
        filter,
        bytes,
        ms,
        ...(trace?.errorPhase !== undefined ? { errorPhase: trace.errorPhase } : {}),
      });
      if (
        trace?.errorPhase === undefined &&
        bytes >= CALIBRATION_MIN_BYTES &&
        ms <= CALIBRATION_TIMEOUT_MS
      ) {
        sRunnable = true;
        // ---- the T/S loop, only once a filter qualified ----
        for (let pair = 1; pair <= pairsPlanned; pair++) {
          if (await runArm("T", T_REF, `r236s-t-${pair}`, T_FILTER, pair)) {
            wedged = true;
            break;
          }
          if (await runArm("S", S_REF, `r236s-s-${pair}`, filter, pair)) {
            wedged = true;
            break;
          }
          pairsDone++;
        }
        break; // calibration done, whether or not the loop above wedged
      }
    }
  } finally {
    await probe.stop();
  }

  const reading = readA2({ pairsDone, pairsPlanned, sBreaks, sRunnable });
  writeRecord(out, {
    kind: "summary",
    tBreaks,
    sBreaks,
    pairsDone,
    pairsPlanned,
    sRunnable,
    reading,
  });
  process.exit(wedged ? 3 : 0);
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    console.error(
      `harness fault: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    process.exit(2);
  }
}
