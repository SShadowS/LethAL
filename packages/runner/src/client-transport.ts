/**
 * PR-479 (479a) round 3a: the shapes of the three fenced client actions of LethAL Control 1.0.0.31 (1.0.0.32 pages the read)
 * (`ActivateForClient`, `DeactivateForClient`, `ReadClientAttestation`) and their strict readers.
 * Each reader fails loudly on anything unexpected: a wrong type, a missing field, a field that must not be there.
 * The calls themselves are `RunMutantTransport`'s (`postAction` is private to it).
 * Shapes: `extensions/lethal-control/src/ControlApi.Codeunit.al` and `docs/superpowers/specs/2026-11-27-pr478-control-1031.md`.
 */

/** An answer from a client action that is not the documented shape. */
export class ClientAnswerShapeError extends Error {
  constructor(
    readonly action: string,
    message: string,
  ) {
    super(`${action} answered an unexpected shape: ${message}`);
    this.name = "ClientAnswerShapeError";
  }
}

export type ActivateForClientAnswer =
  | { readonly claimed: true; readonly generation: number }
  | { readonly claimed: false; readonly reason: string };

export interface DeactivateForClientAnswer {
  readonly deactivated: boolean;
  readonly alreadyCompleted?: true;
  readonly reason?: string;
  /** The bound session's id, echoed on `client-session-alive`. */
  readonly sessionId?: number;
}

/** One `LC Client Attestation` row, every field typed. */
export interface ClientAttestationRow {
  readonly attemptId: string;
  readonly opSeq: number;
  readonly codeunitId: number;
  readonly method: string;
  readonly loaded: boolean;
  readonly loadedGeneration: number;
  readonly loadedMutantId: string;
  readonly observedAny: boolean;
  readonly observedIdentityMismatch: boolean;
  readonly observedActive: boolean;
  readonly success: boolean;
  readonly testMethodRuns: number;
  readonly sessionId: number;
  readonly serverGeneration: string;
  readonly databaseId: string;
}

/** 1.0.0.32 (PR-479 amendment 8): ONE page of the op's rows; `total` is the op's row count, `from` the page's start. */
export type ReadClientAttestationAnswer =
  | {
      readonly read: true;
      readonly total: number;
      readonly from: number;
      readonly rows: readonly ClientAttestationRow[];
    }
  | { readonly read: false; readonly reason: string };

type Obj = Record<string, unknown>;

function int(action: string, o: Obj, key: string, what = key): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isSafeInteger(v)) {
    throw new ClientAnswerShapeError(action, `${what} is ${JSON.stringify(v)}, not an integer`);
  }
  return v;
}
function bool(action: string, o: Obj, key: string, what = key): boolean {
  const v = o[key];
  if (typeof v !== "boolean") {
    throw new ClientAnswerShapeError(action, `${what} is ${JSON.stringify(v)}, not a boolean`);
  }
  return v;
}
function str(action: string, o: Obj, key: string, what = key): string {
  const v = o[key];
  if (typeof v !== "string") {
    throw new ClientAnswerShapeError(action, `${what} is ${JSON.stringify(v)}, not a string`);
  }
  return v;
}
function only(action: string, o: Obj, allowed: readonly string[]): void {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    throw new ClientAnswerShapeError(action, `unexpected field(s) ${extra.join(", ")}`);
  }
}

/** `{claimed, generation?, reason?}`: a claim carries a generation and no reason; a refusal carries a reason. */
export function parseActivateForClient(o: Obj): ActivateForClientAnswer {
  const a = "ActivateForClient";
  only(a, o, ["claimed", "generation", "reason"]);
  if (bool(a, o, "claimed")) {
    if ("reason" in o) throw new ClientAnswerShapeError(a, "a claim carries a reason");
    return { claimed: true, generation: int(a, o, "generation") };
  }
  if ("generation" in o) throw new ClientAnswerShapeError(a, "a refusal carries a generation");
  const reason = str(a, o, "reason");
  if (reason === "") throw new ClientAnswerShapeError(a, "a refusal with an empty reason");
  return { claimed: false, reason };
}

/** `{deactivated, alreadyCompleted?, reason?, sessionId?}`. */
export function parseDeactivateForClient(o: Obj): DeactivateForClientAnswer {
  const a = "DeactivateForClient";
  only(a, o, ["deactivated", "alreadyCompleted", "reason", "sessionId"]);
  const deactivated = bool(a, o, "deactivated");
  if ("alreadyCompleted" in o && o.alreadyCompleted !== true) {
    throw new ClientAnswerShapeError(a, "alreadyCompleted is present and not true");
  }
  return {
    deactivated,
    ...("alreadyCompleted" in o ? { alreadyCompleted: true as const } : {}),
    ...("reason" in o ? { reason: str(a, o, "reason") } : {}),
    ...("sessionId" in o ? { sessionId: int(a, o, "sessionId") } : {}),
  };
}

const ROW_KEYS = [
  "attemptId",
  "opSeq",
  "codeunitId",
  "method",
  "loaded",
  "loadedGeneration",
  "loadedMutantId",
  "observedAny",
  "observedIdentityMismatch",
  "observedActive",
  "success",
  "testMethodRuns",
  "sessionId",
  "serverGeneration",
  "databaseId",
] as const;

function parseRow(i: number, raw: unknown): ClientAttestationRow {
  const a = "ReadClientAttestation";
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ClientAnswerShapeError(a, `row ${i} is not an object`);
  }
  const o = raw as Obj;
  only(a, o, ROW_KEYS);
  for (const k of ROW_KEYS) {
    if (!(k in o)) throw new ClientAnswerShapeError(a, `row ${i} has no ${k}`);
  }
  const w = (k: string) => `row ${i} ${k}`;
  return {
    attemptId: str(a, o, "attemptId", w("attemptId")),
    opSeq: int(a, o, "opSeq", w("opSeq")),
    codeunitId: int(a, o, "codeunitId", w("codeunitId")),
    method: str(a, o, "method", w("method")),
    loaded: bool(a, o, "loaded", w("loaded")),
    loadedGeneration: int(a, o, "loadedGeneration", w("loadedGeneration")),
    loadedMutantId: str(a, o, "loadedMutantId", w("loadedMutantId")),
    observedAny: bool(a, o, "observedAny", w("observedAny")),
    observedIdentityMismatch: bool(a, o, "observedIdentityMismatch", w("observedIdentityMismatch")),
    observedActive: bool(a, o, "observedActive", w("observedActive")),
    success: bool(a, o, "success", w("success")),
    testMethodRuns: int(a, o, "testMethodRuns", w("testMethodRuns")),
    sessionId: int(a, o, "sessionId", w("sessionId")),
    serverGeneration: str(a, o, "serverGeneration", w("serverGeneration")),
    databaseId: str(a, o, "databaseId", w("databaseId")),
  };
}

/**
 * `{read, total?, from?, rows?, reason?}`: a valid read carries `total`, `from` and `rows` (possibly empty) and no
 * reason; an invalid one only a reason.
 */
export function parseReadClientAttestation(o: Obj): ReadClientAttestationAnswer {
  const a = "ReadClientAttestation";
  only(a, o, ["read", "total", "from", "rows", "reason"]);
  if (bool(a, o, "read")) {
    if ("reason" in o) throw new ClientAnswerShapeError(a, "a read carries a reason");
    if (!Array.isArray(o.rows)) throw new ClientAnswerShapeError(a, "a read carries no rows array");
    return {
      read: true,
      total: int(a, o, "total"),
      from: int(a, o, "from"),
      rows: o.rows.map((r, i) => parseRow(i, r)),
    };
  }
  for (const k of ["rows", "total", "from"]) {
    if (k in o) throw new ClientAnswerShapeError(a, `a failed read carries ${k}`);
  }
  return { read: false, reason: str(a, o, "reason") };
}
