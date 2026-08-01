/**
 * R69 §3.2 — `BatchTransport`: seed one work item into the client-services batch queue, drive the
 * run over the WebSocket, read the result back over OData, and VALIDATE it.
 *
 * The row's own `Line No.`, `Codeunit ID`, `Method` and `nonce` are all COPIED by the server's
 * `RunBatch` loop from the queue row THIS CLIENT seeded (`BatchRunner.Codeunit.al` lines 36-42).
 * They round-trip the client's own input, so they are NOT evidence about what actually ran. The
 * only server-produced evidence is the inner `LC Run Method` `Results()` JSON — the SAME
 * `Test Suite Mgt.TestResultsToJSON` shape `run-mutant-transport.ts`'s `mapRanResult` already
 * validates for every fenced mutant. This module applies the SAME checks:
 *   - exactly one test line, or THROW (`lines.length !== 1` is a protocol fault, never a verdict);
 *   - that line's `method` equals the requested method, or THROW;
 *   - an unrecognised result enum THROWS.
 *
 * The nonce proves the row came from THIS invocation (closes the stale-row hazard R69's own
 * history demonstrated — a previous run's persisted rows were read as fresh). It proves nothing
 * about WHAT ran; that is `validateResultJson`'s job. Neither check substitutes for the other.
 */

export class BatchProtocolError extends Error {}

export interface BatchRunRequest {
  codeunitId: number;
  method: string;
  mutantId: string;
  targetAppId: string;
  artifactId: string;
  nonce: string;
  coverageFilter: string;
}

export interface BatchRunResult {
  ok: boolean;
  attested: boolean;
  identityMismatch: boolean;
  errorText: string;
  resultJson: unknown;
  coverage: unknown;
  coverageScannedRows: number;
  coverageEmittedRows: number;
}

export interface BatchOdata {
  post(action: string, body: unknown): Promise<unknown>;
}

export interface BatchWebSocket {
  runBatchAction(): Promise<void>;
}

/**
 * `Test Method Line.Result::Success` as `Test Suite Mgt.TestResultsToJSON` emits it — confirmed
 * live (`ControlApi.Codeunit.al`'s `TestResultSuccess()`) and already relied on by
 * `run-mutant-transport.ts`'s `RESULT_SUCCESS`. `RunMethod.Codeunit.al`'s `RunOneMethod` (the
 * routed path, used by both `RunMutant` and `RunBatch`) calls the identical `TestResultsToJSON`,
 * so the enum is the SAME wire contract on both paths — not a batch-specific encoding.
 */
const RESULT_SUCCESS = 2;
const RESULT_FAILURE = 1;

interface ResultTestLine {
  method?: unknown;
  result?: unknown;
  message?: unknown;
}

/**
 * Validates the ONLY server-produced evidence in a batch result row: the inner `Results()` JSON.
 * Mirrors `run-mutant-transport.ts`'s `mapRanResult` exactly — every shape other than "one line,
 * matching method, recognised enum" is a protocol fault, never a verdict.
 */
export function validateResultJson(
  resultJson: unknown,
  expectedMethod: string,
): { outcome: "pass" | "fail"; message?: string } {
  const parsed =
    resultJson !== null && typeof resultJson === "object"
      ? (resultJson as { testResults?: unknown })
      : {};
  const lines = Array.isArray(parsed.testResults) ? parsed.testResults : [];
  if (lines.length !== 1) {
    throw new BatchProtocolError(
      `batch result carried ${lines.length} test lines, expected exactly 1`,
    );
  }
  const line = lines[0] as ResultTestLine;
  if (line.method !== expectedMethod) {
    throw new BatchProtocolError(
      `batch result ran method ${JSON.stringify(line.method)}, expected ${expectedMethod}`,
    );
  }
  const message =
    typeof line.message === "string" && line.message.length > 0 ? line.message : undefined;
  if (line.result === RESULT_SUCCESS) {
    return { outcome: "pass", ...(message !== undefined ? { message } : {}) };
  }
  if (line.result === RESULT_FAILURE) {
    return { outcome: "fail", ...(message !== undefined ? { message } : {}) };
  }
  throw new BatchProtocolError(
    `batch result unrecognised result enum ${JSON.stringify(line.result)} for ${expectedMethod}`,
  );
}

interface BatchResultRow {
  nonce?: unknown;
  ok?: unknown;
  attested?: unknown;
  identityMismatch?: unknown;
  errorText?: unknown;
  result?: unknown;
  resultRaw?: unknown;
  coverage?: unknown;
  coverageScannedRows?: unknown;
  coverageEmittedRows?: unknown;
}

/** One method, one session, end to end (R69 §3.2). Never returns a plausible empty default —
 *  every unreadable-answer or contract-violation exit throws `BatchProtocolError`. */
export async function runOneBatchMethod(
  odata: BatchOdata,
  ws: BatchWebSocket,
  req: BatchRunRequest,
): Promise<BatchRunResult> {
  await odata.post("ClearBatch", {});
  await odata.post("SeedBatchItem", {
    codeunitId: req.codeunitId,
    method: req.method,
    mutantId: req.mutantId,
    targetAppId: req.targetAppId,
    artifactId: req.artifactId,
    nonce: req.nonce,
    coverageFilter: req.coverageFilter,
  });
  await ws.runBatchAction();
  const outer = await odata.post("GetBatchResults", {});
  const value = (outer as { value?: unknown } | undefined)?.value;
  if (typeof value !== "string") {
    throw new BatchProtocolError(
      `GetBatchResults returned no string \`value\`: ${JSON.stringify(outer)}`,
    );
  }
  let rows: unknown;
  try {
    rows = JSON.parse(value);
  } catch {
    throw new BatchProtocolError(`GetBatchResults \`value\` is not JSON: ${value}`);
  }
  if (!Array.isArray(rows) || rows.length !== 1) {
    const count = Array.isArray(rows) ? rows.length : 0;
    throw new BatchProtocolError(`GetBatchResults returned ${count} rows, expected exactly 1`);
  }
  const row = rows[0] as BatchResultRow;
  // The row's own identity fields (nonce included) are a client round-trip, not evidence — see
  // module doc comment. The nonce check below proves only that THIS row is THIS invocation's.
  if (row.nonce !== req.nonce) {
    throw new BatchProtocolError(
      `batch result nonce ${JSON.stringify(row.nonce)} does not match this invocation's ${JSON.stringify(req.nonce)} — stale row`,
    );
  }
  if (row.identityMismatch === true) {
    throw new BatchProtocolError(
      "batch result attestation identity mismatch: a non-matching (targetAppId, artifactId) ran during this session — wrong/stale binary",
    );
  }
  const resultJson = row.result !== undefined ? row.result : row.resultRaw;
  // Throws on every shape that is not "exactly one line, matching method, recognised enum" —
  // this is the content validation the nonce cannot substitute for (module doc comment).
  validateResultJson(resultJson, req.method);

  return {
    ok: row.ok === true,
    attested: row.attested === true,
    identityMismatch: false,
    errorText: typeof row.errorText === "string" ? row.errorText : "",
    resultJson,
    coverage: row.coverage,
    coverageScannedRows: typeof row.coverageScannedRows === "number" ? row.coverageScannedRows : 0,
    coverageEmittedRows: typeof row.coverageEmittedRows === "number" ? row.coverageEmittedRows : 0,
  };
}
