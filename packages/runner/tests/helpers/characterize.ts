/**
 * C02-04 Part A: the characterization harness. One shared trace per scenario holds every backend
 * call (tagged by which backend made it) and every event, in the order they happened. Snapshotting
 * it, the verdict table and the store rows on UNMODIFIED code is the tripwire that proves the later
 * extraction of runSession's per-batch core changes nothing on the fakes.
 */
import { tmpdir } from "node:os";
import type { ExecutionBackend } from "../../src/backend";
import type { RunEvent } from "../../src/events";
import type { Lease } from "../../src/lease";
import type { SessionReport } from "../../src/report";
import type { ResultsStore } from "../../src/store";

export type Trace = unknown[];

/** Wraps a backend so every call lands in the SHARED trace, tagged by which backend made it. */
export function recording(inner: ExecutionBackend, trace: Trace, tag: string): ExecutionBackend {
  const b: ExecutionBackend = {
    capabilities: () => inner.capabilities(),
    status: async () => {
      trace.push({ call: "status", tag });
      return inner.status();
    },
    deploy: async (d) => {
      trace.push({ call: "deploy", tag });
      return inner.deploy(d);
    },
    compileCheck: async (d) => {
      trace.push({ call: "compileCheck", tag });
      return inner.compileCheck(d);
    },
    activate: async (id) => {
      trace.push({ call: "activate", tag, id });
      return inner.activate(id);
    },
    run: async (ref, o) => {
      trace.push({
        call: "run",
        tag,
        method: ref.method,
        coverage: o.coverage,
        timeoutMs: o.timeoutMs,
      });
      return inner.run(ref, o);
    },
  };
  const many = inner.runMany?.bind(inner);
  if (many !== undefined) {
    b.runMany = async (o) => {
      trace.push({
        call: "runMany",
        tag,
        methods: o.methods.map((m) => [m.ref.method, m.budgetMs]),
        confirmation: o.confirmation === true,
        requestCeilingMs: o.requestCeilingMs,
      });
      return many(o);
    };
  }
  const setLease = (inner as { setLease?: (l: Lease) => void }).setLease?.bind(inner);
  if (setLease !== undefined) {
    Object.assign(b, {
      setLease: (l: Lease) => {
        trace.push({ call: "setLease", tag, lastCompletedOpSeq: l.lastCompletedOpSeq });
        setLease(l);
      },
    });
  }
  const fetchPkg = inner.fetchPublishedAppPackage?.bind(inner);
  if (fetchPkg !== undefined) {
    b.fetchPublishedAppPackage = async (a) => {
      trace.push({ call: "fetchPublishedAppPackage", tag });
      return fetchPkg(a);
    };
  }
  return b;
}

/** Every event field except wall-clock ones; the subscriber writes into the SAME trace. */
export function traceEvents(trace: Trace) {
  return (e: RunEvent) => trace.push({ event: stripClock(e) });
}

function stripClock(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(stripClock);
  if (x === null || typeof x !== "object") return x;
  return Object.fromEntries(
    Object.entries(x)
      .filter(([k]) => !/(?:Ms|At|Iso)$/.test(k) || k === "timeoutMs" || k === "budgetMs")
      .map(([k, v]) => [k, stripClock(v)]),
  );
}

const ID32 = /[0-9a-f]{32}/g;

/**
 * `appVersion` is minted from the clock (`<major>.<minor>.<days>.<halfSeconds>`, reserved per
 * process), so its digits move between runs. Each distinct value becomes `<appVersion#n>` in order of
 * first appearance: the key stays, and "batch 1 got a different version from batch 0" still shows.
 */
const APP_VERSION = /"appVersion":"([^"]*)"/g;

function normalize(x: unknown): unknown {
  const seen = new Map<string, number>();
  return JSON.parse(
    JSON.stringify(x)
      .replace(ID32, "<id32>")
      .replaceAll(JSON.stringify(tmpdir()).slice(1, -1), "<tmp>")
      .replace(APP_VERSION, (_m, v: string) => {
        const n = seen.get(v) ?? seen.size + 1;
        seen.set(v, n);
        return `"appVersion":"<appVersion#${n}>"`;
      }),
  );
}

/** The fields the design says must not differ, per mutant (the same as orchestrator.test.ts's `verdictTable`). */
function verdictTable(report: SessionReport) {
  return report.mutants
    .map((m) => ({
      code: m.mutantCode,
      line: m.line,
      operator: m.operatorName,
      verdict: m.verdict,
      killingTest: m.killingTest ?? null,
      coveringTests: [...(m.coveringTests ?? [])].sort(),
    }))
    .sort((a, b) =>
      `${a.line}:${a.operator}:${a.code}`.localeCompare(`${b.line}:${b.operator}:${b.code}`),
    );
}

/**
 * `reportOrError` is what the session resolved OR rejected with: a thrown session is characterized
 * by its message, plus every row it wrote before the throw.
 */
export function characterize(trace: Trace, store: ResultsStore, reportOrError: unknown): unknown {
  const outcome =
    reportOrError instanceof Error
      ? { error: `${reportOrError.name}: ${reportOrError.message}` }
      : {
          verdicts: verdictTable(reportOrError as SessionReport),
          quarantined: (reportOrError as SessionReport).quarantined?.reason ?? null,
        };
  return normalize({
    ...outcome,
    trace,
    mutantRows: store.db
      .query(
        "SELECT batch_index, mutant_code, verdict, killing_test, killing_test_failure, kill_position, failure_note, duration_ms, covering_tests, coverage_attribution, unplaceable, runner FROM mutants ORDER BY id",
      )
      .all(),
    testRows: store.db
      .query(
        "SELECT mutant_row_id, mutant_code, codeunit_id, method, outcome, duration_ms, failure_message, op_kind, session_id FROM test_results ORDER BY id",
      )
      .all(),
  });
}
