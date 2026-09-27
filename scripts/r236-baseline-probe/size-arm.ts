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
 * not byte-equal, did not score `fail`, did not carry the `CreateNavTestService` refusal, or if the
 * readback itself failed (recorded as `readError`; a failed readback never aborts the run with exit 2,
 * and does not stop the loop unless the server itself becomes unreachable). Every call line, whole or
 * not, carries the T call's own trace fields so a lost body can be classified per §C1's definition.
 * Orchestrator ruling (Task 9 Step 2): if ZERO calls arrive whole, the byte-equality check never ran
 * once, so the run is NOT MEASURED rather than a vacuous pass; it exits 4 and the summary records
 * `measured: false` with a `reason`. A `bad` call wins over that (see `keptCheckVerdict`): a bad call is
 * a real failure whether or not any call arrived whole.
 *
 * This script issues no network call itself when the env var is unset (prints `skipped`, exit 0), and
 * refuses (exit 2) before any network call if the required flags are missing, the config's `bcdev.server`
 * host does not match `--expect-container`, or `--out`'s directory does not exist.
 *
 * Exit codes: 0 the arm ran to completion (or S was not runnable), or `--kept-check` passed; 1 a
 * `--kept-check` mismatch; 2 a harness/config fault, before any network call; 3 a wedge (a failed
 * preflight after a break); 4 `--kept-check` ran but was NOT MEASURED (zero calls arrived whole).
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
import type { TestMethodRef, TestOutcome } from "../../packages/runner/src/backend";
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

/** The T call's own action names, shared by `keepOriginalBody` and `selectOriginalTrace`: never the
 *  `GetOpAnswer` readback the transport (or this script) makes for the SAME attempt id afterward. */
const ORIGINAL_ACTIONS = new Set([
  "LethALControl_RunMutant",
  "LethALControl_RunMutantWithCoverage",
]);

function isOriginalAction(action: string): boolean {
  return ORIGINAL_ACTIONS.has(action);
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
  if (!isOriginalAction(trace.action)) return;
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

/** R236b kept-check (C1b): the trace fields §C1's lost-body definition needs, read off the T call's
 *  own `CallTrace` (never the `GetOpAnswer` readback's, which is a separate fetch). */
export interface KeptCheckTraceFields {
  readonly headersMs: number | null;
  readonly bytesReceived: number | null;
  readonly errorPhase: "fetch" | "body" | null;
  readonly bodyEndSeen: boolean;
  readonly status: number | null;
}

function traceFieldsOf(trace: CallTrace | undefined): KeptCheckTraceFields {
  return {
    headersMs: headersMsOf(trace),
    bytesReceived: trace?.bytesReceived ?? null,
    errorPhase: trace?.errorPhase ?? null,
    bodyEndSeen: trace?.bodyEndAt !== undefined,
    status: trace?.status ?? null,
  };
}

/** §C1's lost-body definition: headers arrived, then the body broke before it finished. A call that
 *  failed before headers even started (`errorPhase` `"fetch"`) is a different failure, not this one. */
export function isLostBody(trace: CallTrace | undefined): boolean {
  return trace?.errorPhase === "body" && trace?.bodyEndAt === undefined;
}

/**
 * Review r1: `runWithCoverage` can make its OWN internal recovery readback (a `GetOpAnswer` call, for
 * the SAME attempt id) after a lost body, so the traces one T call adds are sometimes
 * `[original (broken), recovery GetOpAnswer (clean)]`. Picking `calls.at(-1)` then reads the CLEAN
 * recovery trace and `isLostBody` always says false. Selects the original action's own trace (the same
 * filter `keepOriginalBody` uses) out of exactly the traces this one call added. Anything other than
 * exactly one match is ambiguous: the caller records that and treats the call as bad.
 */
export function selectOriginalTrace(added: readonly CallTrace[]): CallTrace | undefined {
  const originals = added.filter((t) => isOriginalAction(t.action));
  return originals.length === 1 ? originals[0] : undefined;
}

/**
 * Pure (review r1, the `dispatchOne` fix): the classification `dispatchOne` needs from the traces ONE
 * dispatch added, via `selectOriginalTrace` rather than `added.at(-1)`. After a lost body that
 * `runWithCoverage` recovers internally, the traces added are `[original (broken), recovery
 * GetOpAnswer (clean)]`; `at(-1)` would read the clean recovery trace and hide the break from the A2
 * arm's classification. An ambiguous resolution (not exactly one original-action trace) is
 * conservative: treated as a break, and `traceAmbiguous` records why on the call line.
 */
export function classifyDispatch(added: readonly CallTrace[]): {
  readonly trace: CallTrace | undefined;
  readonly traceAmbiguous: boolean;
  readonly broke: boolean;
} {
  const trace = selectOriginalTrace(added);
  const broke =
    trace === undefined ? true : trace.errorPhase === "body" || trace.errorPhase === "fetch";
  return { trace, traceAmbiguous: trace === undefined, broke };
}

/** One `--kept-check` call's outcome, as `keptCheckRecord` classifies it. */
export type KeptCheckCall =
  | {
      readonly whole: false;
      readonly outcome: TestOutcome;
      readonly operation: string | null;
      readonly replyRecovered: string | null;
      readonly recoveryReadback: boolean;
    }
  | {
      readonly whole: true;
      readonly outcome: TestOutcome;
      readonly clr: boolean;
      readonly replyRecovered: string | null;
      readonly recoveryReadback: boolean;
      readonly read:
        | { readonly ok: true; readonly found: boolean; readonly byteEqual: boolean }
        | { readonly ok: false; readonly readError: string };
    };

/**
 * Pure (Task 8 Step 2 / C1b fix): builds one kept-check NDJSON line from the T call's own trace (as
 * `selectOriginalTrace` resolved it, `undefined` when ambiguous) and its outcome, and classifies it.
 * An ambiguous trace is always `bad` (its `lostBody` cannot be judged). A whole call whose readback
 * failed (abort, timeout, network error, bad response) is `bad`: §C1b already exits 1 on any mismatch,
 * and a failed readback is one. It is NEVER a lost body, though: the body already arrived whole,
 * `GetOpAnswer` is what failed. `lostBody` (§C1's definition) applies only to a `whole: false` call with
 * a resolved trace.
 */
export function keptCheckRecord(
  i: number,
  trace: CallTrace | undefined,
  call: KeptCheckCall,
): { readonly record: Record<string, unknown>; readonly bad: boolean; readonly lostBody: boolean } {
  const fields = traceFieldsOf(trace);
  const traceAmbiguous = trace === undefined;
  if (!call.whole) {
    return {
      record: {
        kind: "kept-check",
        i,
        whole: false,
        outcome: call.outcome,
        operation: call.operation,
        replyRecovered: call.replyRecovered,
        recoveryReadback: call.recoveryReadback,
        traceAmbiguous,
        ...fields,
      },
      bad: traceAmbiguous,
      lostBody: traceAmbiguous ? false : isLostBody(trace),
    };
  }
  if (!call.read.ok) {
    return {
      record: {
        kind: "kept-check",
        i,
        whole: true,
        found: false,
        readError: call.read.readError,
        outcome: call.outcome,
        clr: call.clr,
        replyRecovered: call.replyRecovered,
        recoveryReadback: call.recoveryReadback,
        traceAmbiguous,
        ...fields,
      },
      bad: true,
      lostBody: false,
    };
  }
  const { found, byteEqual } = call.read;
  const bad = !found || !byteEqual || call.outcome !== "fail" || !call.clr || traceAmbiguous;
  return {
    record: {
      kind: "kept-check",
      i,
      whole: true,
      found,
      byteEqual,
      outcome: call.outcome,
      clr: call.clr,
      replyRecovered: call.replyRecovered,
      recoveryReadback: call.recoveryReadback,
      traceAmbiguous,
      ...fields,
    },
    bad,
    lostBody: false,
  };
}

/** The counts `keptCheckVerdict` needs out of a `--kept-check` run: how many calls arrived whole, and
 *  how many (whole or not) were classified `bad` by `keptCheckRecord`. */
export interface KeptCheckSummaryCounts {
  readonly whole: number;
  readonly bad: number;
}

/**
 * Orchestrator ruling (R236b Task 9 Step 2): C1b must not pass vacuously. If zero calls arrived whole,
 * the byte-equality check never ran once, so the run is `not-measured`, never `pass`. A `bad` call wins
 * over that, though: a bad call (e.g. an ambiguous trace) is a real failure whether or not any call
 * arrived whole, so it is never softened to `not-measured` for lack of whole calls.
 */
export function keptCheckVerdict(
  summary: KeptCheckSummaryCounts,
): "pass" | "fail" | "not-measured" {
  if (summary.bad > 0) return "fail";
  if (summary.whole === 0) return "not-measured";
  return "pass";
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
    let lostBodies = 0;
    let notWhole = 0;
    let whole = 0;
    try {
      for (let i = 1; i <= pairsPlanned; i++) {
        const attemptId = `r236s-k-${i}`;
        const lease = fence();
        const before = calls.length;
        const { verdict } = await tx.runWithCoverage({
          ref: T_REF,
          mutantId: "",
          attemptId,
          timeoutMs: PAIR_TIMEOUT_MS,
          lease,
          coverageObjectIdFilter: T_FILTER,
        });
        // Review r1: only the traces THIS call added, never `calls.at(-1)`, which after a lost body is
        // the transport's own recovery `GetOpAnswer` readback rather than the original action's trace.
        const added = calls.slice(before);
        const trace = selectOriginalTrace(added);
        const recoveryReadback = added.some((t) => t.action === "LethALControl_GetOpAnswer");
        const replyRecovered = verdict.replyRecovered ?? null;
        const body = bodies.get(attemptId);
        let call: KeptCheckCall;
        let readFailed = false;
        if (body === undefined) {
          notWhole++;
          call = {
            whole: false,
            outcome: verdict.outcome,
            operation: verdict.operation ?? null,
            replyRecovered,
            recoveryReadback,
          };
        } else {
          whole++;
          const clr = verdict.failureMessage?.includes("CreateNavTestService") === true;
          try {
            const kept = await tx.readKeptAnswer(lease, attemptId, lease.opSeq, 15_000);
            call = {
              whole: true,
              outcome: verdict.outcome,
              clr,
              replyRecovered,
              recoveryReadback,
              read: {
                ok: true,
                found: kept.found,
                byteEqual:
                  kept.found && kept.answer === (JSON.parse(body) as { value?: unknown }).value,
              },
            };
          } catch (err) {
            // R236b: readKeptAnswer can throw (abort, timeout, network error, bad response). Recorded
            // as a bad call, never left to escape as an uncaught harness fault (exit 2).
            readFailed = true;
            call = {
              whole: true,
              outcome: verdict.outcome,
              clr,
              replyRecovered,
              recoveryReadback,
              read: { ok: false, readError: String(err) },
            };
          }
        }
        const result = keptCheckRecord(i, trace, call);
        writeRecord(out, result.record);
        if (result.bad) bad++;
        if (result.lostBody) lostBodies++;
        if (readFailed) {
          // Continue past a readback failure by default; stop only if the server itself is now
          // unreachable, so the run still ends with exit 1 (a real fault), never exit 2.
          try {
            await harnessVerifier.checkReachable();
          } catch {
            break;
          }
        }
      }
    } finally {
      await probe.stop();
    }
    const verdict = keptCheckVerdict({ whole, bad });
    writeRecord(out, {
      kind: "kept-check-summary",
      calls: pairsPlanned,
      bad,
      lostBodies,
      notWhole,
      whole,
      verdict,
      measured: verdict !== "not-measured",
      ...(verdict === "not-measured" ? { reason: "zero calls arrived whole" } : {}),
    });
    process.exit(verdict === "fail" ? 1 : verdict === "not-measured" ? 4 : 0);
  }

  let tBreaks = 0;
  let sBreaks = 0;
  let pairsDone = 0;
  let sRunnable = false;
  let wedged = false;

  /** One dispatch of `ref` under `filter`. A throw (e.g. malformed coverage) leaves outcome/operation
   *  null; `broke` comes from `classifyDispatch` over the traces THIS dispatch added (review r1: never
   *  `calls.at(-1)`, which after a lost body is the transport's own recovery `GetOpAnswer` readback and
   *  would hide a broken body behind a clean read). */
  const dispatchOne = async (
    ref: TestMethodRef,
    attemptId: string,
    filter: string,
    timeoutMs: number,
  ): Promise<{
    broke: boolean;
    trace: CallTrace | undefined;
    traceAmbiguous: boolean;
    opSeq: number;
    outcome: string | null;
    operation: string | null;
  }> => {
    const lease = fence();
    let outcome: string | null = null;
    let operation: string | null = null;
    const before = calls.length;
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
    const { trace, traceAmbiguous, broke } = classifyDispatch(calls.slice(before));
    return { broke, trace, traceAmbiguous, opSeq: lease.opSeq, outcome, operation };
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
      traceAmbiguous: r.traceAmbiguous,
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
