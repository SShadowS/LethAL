/**
 * PR-212 (R1113): which selected test METHODS write the Company table, read from the test app's parse
 * (`buildTestAppModel`, the model the TestPage scan uses; no text matching).
 *
 * A method writes a company when `Insert`, `Delete` or `Rename` is called on a variable declared
 * `Record Company` / `Record 2000000006`: in its own body (`direct`), or in ONE test-app procedure it calls
 * (`via <procedure>`): a bare call in the same object, or a call on a `Codeunit "X"` variable whose codeunit is in
 * the test app. A write two calls away is not listed (the stated limit). `commits` says the method or that
 * procedure calls `Commit()`.
 *
 * Also gathers `reach`: the names of the objects the method and its one-hop helper name (variable types
 * `Record|Codeunit|Page|Report|Query|XmlPort "X"`, and `Codeunit::`/`Database::`/`Page::`/... references). Run
 * without these tests, a mutant in such an object that no remaining test covers is UNMEASURED (§2c).
 */
import { normalizeAlName } from "@lethal/engine";
import type { TestMethodRef } from "./backend";
import type { Proc, TestAppModel, Unit } from "./testpage-scan";

export interface CompanyWriteMethod {
  readonly test: TestMethodRef;
  /** `direct`, or `via <procedure as written>`. */
  readonly path: string;
  readonly commits: boolean;
  /** Normalised names of the objects the method (and its helper) name. */
  readonly reach: ReadonlySet<string>;
}

const COMPANY_TYPE = /^\s*record\s+(?:"?company"?|2000000006)(?:\s+temporary)?\s*$/i;
const NAMED_TYPE =
  /^\s*(?:record|codeunit|page|report|query|xmlport)\s+(.+?)(?:\s+temporary)?\s*$/i;
const WRITES = new Set(["insert", "delete", "rename"]);

/** Every type text the name has in the procedure (a local hides a global), or none. */
const typesOf = (unit: Unit, proc: Proc, name: string): readonly string[] =>
  proc.scope.get(name) ?? unit.globals.get(name) ?? [];

const norm = (s: string): string => normalizeAlName(s.trim());

function writesCompany(proc: Proc): boolean {
  return (proc.sites ?? []).some(
    (s) =>
      s.kind === "member" &&
      s.recv.k === "name" &&
      WRITES.has(norm(s.member)) &&
      typesOf(proc.unit, proc, norm(s.receiver)).some((t) => COMPANY_TYPE.test(t)),
  );
}

const commits = (proc: Proc): boolean =>
  (proc.sites ?? []).some((s) => s.kind === "bare" && norm(s.name) === "commit");

/** The test-app procedures `proc` calls directly: bare calls, and calls on a test-app codeunit variable. */
function calledProcs(model: TestAppModel, proc: Proc): Proc[] {
  const out: Proc[] = [];
  for (const s of proc.sites ?? []) {
    if (s.kind === "bare") {
      const n = norm(s.name);
      out.push(...proc.unit.procs.filter((p) => p.name === n && p.params === s.args));
    } else if (s.recv.k === "name") {
      for (const t of typesOf(proc.unit, proc, norm(s.receiver))) {
        const target = /^\s*codeunit\s+(.+?)\s*$/i.exec(t)?.[1];
        if (target === undefined) continue;
        const cu = norm(target);
        const m = norm(s.member);
        for (const u of model.units)
          if (u.name === cu)
            out.push(...u.procs.filter((p) => p.name === m && p.params === s.args));
      }
    }
  }
  return out;
}

/** The object names `proc` names: its variable types (locals, and globals it calls through) and references. */
function namesIn(proc: Proc, into: Set<string>): void {
  const add = (t: string) => {
    const n = NAMED_TYPE.exec(t)?.[1];
    if (n !== undefined) into.add(norm(n));
  };
  for (const types of proc.scope.values()) for (const t of types) add(t);
  for (const s of proc.sites ?? [])
    if (s.kind === "member" && s.recv.k === "name" && !proc.scope.has(norm(s.receiver)))
      for (const t of proc.unit.globals.get(norm(s.receiver)) ?? []) add(t);
  for (const r of proc.idRefs) {
    if (/^\d+$/.test(r)) continue;
    into.add(norm(r.replace(/^[a-z]+::/i, "")));
  }
}

export function companyWriteMethods(
  model: TestAppModel,
  tests: readonly TestMethodRef[],
): CompanyWriteMethod[] {
  const out: CompanyWriteMethod[] = [];
  for (const t of tests) {
    const decls = model.units
      .filter((u) => u.id === t.codeunitId)
      .flatMap((u) => u.procs.filter((p) => p.name === norm(t.method) && p.params === 0));
    let path: string | undefined;
    let doesCommit = false;
    const reach = new Set<string>();
    for (const d of decls) {
      const helpers = calledProcs(model, d).filter(writesCompany);
      const direct = writesCompany(d);
      const first = helpers[0];
      if (!direct && first === undefined) continue;
      path ??= direct ? "direct" : `via ${first?.display ?? ""}`;
      doesCommit ||= commits(d) || helpers.some(commits);
      namesIn(d, reach);
      for (const h of helpers) namesIn(h, reach);
    }
    if (path !== undefined) out.push({ test: t, path, commits: doesCommit, reach });
  }
  return out;
}

const SHOWN = 10;

/** The warning lines (the run's warning and the dry run print the same text). Empty when none write a company. */
export function companyWriteLines(
  ms: readonly CompanyWriteMethod[],
  kept: boolean,
  total: number,
  rest = "the report's excludedTests lists all",
): string[] {
  if (ms.length === 0) return [];
  const head = kept
    ? `company writes: ${ms.length} of ${total} selected test method(s) create, delete or rename a company and RUN (--keep-company-tests). On BC 29 a test that writes a company made the server refuse every later web-service call, and could break the tier (R1113).`
    : `company writes: ${ms.length} of ${total} selected test method(s) create, delete or rename a company and are LEFT OUT of this run (reason company-write). On BC 29 such a test broke the server's tier (R1113); where SQL has no Full-Text Search (bc1-bc3) Company.Insert fails at once. Run them with --keep-company-tests on a server you can restart. A write two calls away is not seen.`;
  const lines = [head];
  for (const m of ms.slice(0, SHOWN))
    lines.push(
      `  ${m.test.codeunitName}.${m.test.method} (${m.path}${m.commits ? ", commits" : ""})`,
    );
  if (ms.length > SHOWN) lines.push(`  ... and ${ms.length - SHOWN} more (${rest})`);
  return lines;
}
