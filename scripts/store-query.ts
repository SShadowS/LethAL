/**
 * Read-only queries over a LethAL results store (`lethal.sqlite`).
 *
 *   bun scripts/store-query.ts <lethal.sqlite> runs
 *   bun scripts/store-query.ts <lethal.sqlite> [--run latest|<id>] verdicts
 *   bun scripts/store-query.ts <lethal.sqlite> [--run latest|<id>] tests
 *
 * The database is opened `readonly`: `ResultsStore`'s constructor runs the schema and migrations,
 * which WRITE, so it is deliberately not used here.
 *
 * "LATEST RUN" (the default for `--run`) is defined once, in `latestRunId`: the highest `runs.id`
 * whose `finished_at` is set. `id` is AUTOINCREMENT, so highest is newest, and requiring
 * `finished_at` is the same rule `ResultsStore.priorSurvivorKeys` uses for "the latest finished
 * run" (store.ts), minus its per-project filter, since this tool sees the whole file. A newer
 * UNFINISHED run (crashed or still running) is not "latest"; it is named on stderr, and
 * `--run <id>` reads it.
 *
 *   runs      every run: id, start, finish, backend, coverage mode, mutant count, project
 *   verdicts  the run's mutant counts by verdict, then one line per mutant
 *   tests     the run's test results by test, with outcome counts
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export class StoreQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreQueryError";
  }
}

export function openReadonly(path: string): Database {
  if (!existsSync(path)) throw new StoreQueryError(`${path} does not exist`);
  return new Database(path, { readonly: true });
}

/** The ONE definition of "latest run": highest id with `finished_at` set. Throws when none. */
export function latestRunId(db: Database): { id: number; newerUnfinished: number[] } {
  const row = db.query("SELECT MAX(id) AS id FROM runs WHERE finished_at IS NOT NULL").get() as {
    id: number | null;
  };
  if (row.id === null) throw new StoreQueryError("the store has no finished run; pass --run <id>");
  const newer = db.query("SELECT id FROM runs WHERE id > ? ORDER BY id").all(row.id) as Array<{
    id: number;
  }>;
  return { id: row.id, newerUnfinished: newer.map((r) => r.id) };
}

export function resolveRun(db: Database, run: string): number {
  if (run === "latest") return latestRunId(db).id;
  if (!/^\d+$/.test(run))
    throw new StoreQueryError(`--run must be 'latest' or a run id, got '${run}'`);
  const id = Number(run);
  if (db.query("SELECT 1 FROM runs WHERE id = ?").get(id) === null) {
    throw new StoreQueryError(`no run ${id} in this store`);
  }
  return id;
}

export function runsReport(db: Database): string {
  const rows = db
    .query(
      `SELECT r.id, r.started_at, r.finished_at, r.backend, r.coverage_mode, r.project_path,
              (SELECT COUNT(*) FROM mutants m WHERE m.run_id = r.id) AS mutants
       FROM runs r ORDER BY r.id`,
    )
    .all() as Array<{
    id: number;
    started_at: string;
    finished_at: string | null;
    backend: string;
    coverage_mode: string | null;
    project_path: string;
    mutants: number;
  }>;
  if (rows.length === 0) throw new StoreQueryError("the store has no runs");
  return rows
    .map(
      (r) =>
        `run ${r.id}  ${r.started_at}  ${r.finished_at ?? "UNFINISHED"}  ${r.backend}  ${r.coverage_mode ?? "mode?"}  ${r.mutants} mutants  ${r.project_path}`,
    )
    .join("\n");
}

export function verdictsReport(db: Database, runId: number): string {
  const rows = db
    .query(
      `SELECT mutant_code, batch_index, verdict, operator_name, codeunit_name, procedure_name, file, line, killing_test
       FROM mutants WHERE run_id = ? ORDER BY batch_index, id`,
    )
    .all(runId) as Array<{
    mutant_code: string;
    batch_index: number | null;
    verdict: string;
    operator_name: string;
    codeunit_name: string;
    procedure_name: string | null;
    file: string;
    line: number;
    killing_test: string | null;
  }>;
  if (rows.length === 0) throw new StoreQueryError(`run ${runId} has no mutant rows`);
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);
  const head = `run ${runId}: ${rows.length} mutants, ${[...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([v, n]) => `${v} ${n}`)
    .join(" / ")}`;
  const lines = rows.map(
    (r) =>
      `  ${r.batch_index ?? "?"}/${r.mutant_code} ${r.verdict} ${r.operator_name} ${r.codeunit_name}.${r.procedure_name ?? ""} ${r.file}:${r.line}${r.killing_test ? ` killed by ${r.killing_test}` : ""}`,
  );
  return [head, ...lines].join("\n");
}

export function testsReport(db: Database, runId: number): string {
  const rows = db
    .query(
      `SELECT COALESCE(codeunit_name, CAST(codeunit_id AS TEXT)) AS cu, method, outcome, COUNT(*) AS n
       FROM test_results WHERE run_id = ? GROUP BY cu, method, outcome ORDER BY cu, method, outcome`,
    )
    .all(runId) as Array<{ cu: string; method: string; outcome: string; n: number }>;
  if (rows.length === 0) throw new StoreQueryError(`run ${runId} has no test results`);
  const byTest = new Map<string, string[]>();
  for (const r of rows) {
    const key = `${r.cu}.${r.method}`;
    const list = byTest.get(key) ?? [];
    list.push(`${r.outcome} ${r.n}`);
    byTest.set(key, list);
  }
  return [
    `run ${runId}: ${byTest.size} tests`,
    ...[...byTest].map(([t, o]) => `  ${t}: ${o.join(" / ")}`),
  ].join("\n");
}

const USAGE =
  "usage: bun scripts/store-query.ts <lethal.sqlite> [--run latest|<id>] verdicts|runs|tests";

function main(argv: readonly string[]): number {
  const args = [...argv];
  let run = "latest";
  const at = args.indexOf("--run");
  if (at >= 0) {
    const value = args[at + 1];
    if (value === undefined) throw new StoreQueryError(USAGE);
    run = value;
    args.splice(at, 2);
  }
  const [path, cmd, ...extra] = args;
  if (path === undefined || cmd === undefined || extra.length > 0) throw new StoreQueryError(USAGE);
  const db = openReadonly(path);
  try {
    if (cmd === "runs") {
      console.log(runsReport(db));
      return 0;
    }
    if (cmd !== "verdicts" && cmd !== "tests") throw new StoreQueryError(USAGE);
    if (run === "latest") {
      const { newerUnfinished } = latestRunId(db);
      if (newerUnfinished.length > 0) {
        console.error(
          `note: newer UNFINISHED run(s) ${newerUnfinished.join(", ")} exist; --run <id> reads one`,
        );
      }
    }
    const id = resolveRun(db, run);
    console.log(cmd === "verdicts" ? verdictsReport(db, id) : testsReport(db, id));
    return 0;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(e instanceof StoreQueryError ? 2 : 1);
  }
}
