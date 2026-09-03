/**
 * Source pins on the LethAL Control extension's AL (R198, R206). AL has no unit-test harness in
 * this repo, so the invariants that decide verdicts are pinned by reading the source: each of
 * these is a STATEMENT-ORDER or SINGLE-WRITER fact whose violation would not fail any gate
 * (the guard it protects fails silently, in the direction of a wrong verdict).
 *
 * - PROGRESS_BETWEEN_FIRST: `ProgressBetween` is the first statement after the runner returns, at
 *   BOTH run sites. R204's after-408 narrowing reads `lastCompletedIndex`; anything placed between
 *   the run's return and that write widens its false-kill branch.
 * - LOOP_READS_LEASE_ONLY: the loop re-reads the marker with a plain Get, never a lock.
 * - The pair-keyed suite map (R206 §4 item 1): a request resolves on BOTH `Test Codeunit` and
 *   `Name`; a name-only map runs the wrong line when two codeunits share a method name.
 * - Provenance of the inner `method` (R206 §4 item 3): read off the function line record, never
 *   echoed from the request, or the client's inner-method check compares the request with itself.
 * - The session-freshness predicate (R206 §2.1): `TestMethodRuns` has ONE writer, is incremented
 *   immediately before each run site, is never reset, and is read at the very top of both actions.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "..", "extensions", "lethal-control", "src");
const read = (file: string): string => readFileSync(join(SRC, file), "utf8");

/** Statements after `anchor`, comment lines and blank lines removed, up to `count` of them. */
function statementsAfter(source: string, anchor: string, count: number): string[] {
  const at = source.indexOf(anchor);
  if (at < 0) throw new Error(`anchor not found: ${anchor}`);
  const rest = source.slice(at + anchor.length).split("\n");
  const out: string[] = [];
  for (const raw of rest) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("//")) continue;
    out.push(line);
    if (out.length === count) break;
  }
  return out;
}

/** Statements BEFORE `anchor` (nearest first), comment lines and blank lines removed. */
function statementsBefore(source: string, anchor: string, count: number): string[] {
  const at = source.indexOf(anchor);
  if (at < 0) throw new Error(`anchor not found: ${anchor}`);
  const before = source.slice(0, at).split("\n").reverse();
  const out: string[] = [];
  for (const raw of before) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("//")) continue;
    out.push(line);
    if (out.length === count) break;
  }
  return out;
}

/** The source with every comment line removed, so a prose mention never counts as code. */
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

function procedureBody(source: string, name: string): string {
  const start = source.search(new RegExp(`(local )?procedure ${name}\\(`));
  if (start < 0) throw new Error(`procedure not found: ${name}`);
  const end = source.indexOf("\n    end;", start);
  return source.slice(start, end);
}

describe("PROGRESS_BETWEEN_FIRST (R198), pinned at both run sites", () => {
  test("LC Run Method: ProgressBetween is the first statement after RunAllTests returns", () => {
    const src = read("RunMethod.Codeunit.al");
    const after = statementsAfter(src, "Mgt.RunAllTests(Line);", 2);
    expect(after[0]).toBe("if FenceAttemptId <> '' then");
    expect(after[1]).toMatch(/^State\.ProgressBetween\(FenceAttemptId, FenceOpSeq, FenceIndex\);$/);
  });

  test("LC Run Many: ProgressBetween is the first statement after RunTests returns", () => {
    const src = read("RunMany.Codeunit.al");
    const after = statementsAfter(src, "Mgt.RunTests(RunLine, ALTestSuite);", 1);
    expect(after[0]).toMatch(/^State\.ProgressBetween\(FenceAttemptId, FenceOpSeq, Index\);$/);
  });

  test("LC Run Many does not delegate to LC Run Method any more (so the pin above is the live one)", () => {
    const src = read("RunMany.Codeunit.al");
    expect(src).not.toContain('Codeunit "LC Run Method"');
    expect(src).not.toContain("RunAllTests(");
  });
});

describe("LOOP_READS_LEASE_ONLY (R198)", () => {
  test("the loop re-reads the marker through IsOwnRunActive, and that is a plain Get", () => {
    const many = read("RunMany.Codeunit.al");
    expect(many).toContain("State.IsOwnRunActive(FenceAttemptId, FenceOpSeq)");
    expect(many).not.toContain("LockTable");
    const body = procedureBody(read("ControlState.Codeunit.al"), "IsOwnRunActive");
    expect(body).toContain("Lease.Get('')");
    expect(body).not.toContain("LockTable");
  });
});

describe("the pair-keyed suite map (R206 §4 item 1)", () => {
  test("ResolvePairs ranges on BOTH Test Codeunit and Name before counting matches", () => {
    const body = procedureBody(read("RunMany.Codeunit.al"), "ResolvePairs");
    expect(body).toContain('Line.SetRange("Test Codeunit", CodeunitId);');
    expect(body).toContain("Line.SetRange(Name, MethodName);");
    expect(body).toContain("MatchCount := Line.Count();");
    expect(body).toContain("if MatchCount <> 1 then begin");
    // A second pair resolving to a line already taken refuses the call.
    expect(body).toContain('if FnLineNos.Contains(Line."Line No.") then begin');
    expect(body).toContain("SuiteUnresolved := true;");
  });

  test("the resolution happens before any method runs, and the run is filtered to header|function", () => {
    const src = read("RunMany.Codeunit.al");
    const resolveAt = src.indexOf("if not ResolvePairs(");
    const runAt = src.indexOf("Mgt.RunTests(RunLine, ALTestSuite);");
    expect(resolveAt).toBeGreaterThan(0);
    expect(runAt).toBeGreaterThan(resolveAt);
    const before = statementsBefore(src, "Mgt.RunTests(RunLine, ALTestSuite);", 6);
    expect(before).toContain("RunLine.SetFilter(\"Line No.\", '%1|%2', HeaderLineNo, FnLineNo);");
    expect(before).toContain("RunLine.FindFirst();");
  });
});

describe("provenance of the inner `method` (R206 §4 item 3)", () => {
  test("FunctionLineResults assigns `method` from the function line RECORD, never the request", () => {
    const body = procedureBody(read("RunMany.Codeunit.al"), "FunctionLineResults");
    expect(body).toContain("TestResult.Add('method', FnLine.Name);");
    expect(body).not.toContain("MethodName");
    expect(body).toContain("ResultInteger := FnLine.Result;");
    expect(body).toContain("TestResult.Add('startTime', FnLine.\"Start Time\");");
    expect(body).toContain("TestResult.Add('finishTime', FnLine.\"Finish Time\");");
  });

  test("the stack trace stripping is TestResultsToJSON's, byte for byte", () => {
    const body = procedureBody(read("RunMany.Codeunit.al"), "FunctionLineResults");
    expect(body).toContain("ConvertedText := ConvertedText.Replace('\\', ';');");
    expect(body).toContain("ConvertedText := ConvertedText.Replace('\"', '');");
  });
});

describe("the session-freshness predicate (R206 §2.1)", () => {
  const state = read("ControlState.Codeunit.al");

  test("TestMethodRuns has exactly one writer, NoteTestMethodRun, and it is an increment", () => {
    const writes = codeOnly(state).match(/TestMethodRuns\s*(:=|\+=|-=)/g) ?? [];
    expect(writes).toEqual(["TestMethodRuns +="]);
    const body = procedureBody(state, "NoteTestMethodRun");
    expect(body).toContain("TestMethodRuns += 1;");
  });

  test("ResetAttestationState does not touch it", () => {
    const body = procedureBody(state, "ResetAttestationState");
    expect(body).not.toContain("TestMethodRuns");
    expect(body).not.toContain("SuiteCounter");
  });

  test("both run sites call NoteTestMethodRun immediately before the run", () => {
    const method = statementsBefore(read("RunMethod.Codeunit.al"), "Mgt.RunAllTests(Line);", 1);
    expect(method[0]).toBe("State.NoteTestMethodRun();");
    const many = statementsBefore(
      read("RunMany.Codeunit.al"),
      "Mgt.RunTests(RunLine, ALTestSuite);",
      1,
    );
    expect(many[0]).toBe("State.NoteTestMethodRun();");
  });

  test("no other AL file assigns it", () => {
    for (const file of ["RunMethod.Codeunit.al", "RunMany.Codeunit.al", "ControlApi.Codeunit.al"]) {
      expect(codeOnly(read(file))).not.toMatch(/TestMethodRuns\s*(:=|\+=|-=)/);
    }
  });

  test("both actions read it at the very top, before phase 1 claims", () => {
    const api = read("ControlApi.Codeunit.al");
    for (const action of ["RunMutant", "RunMutantMany"]) {
      const body = procedureBody(api, action);
      const readAt = body.indexOf("TestRunsBefore := State.TestMethodRunsSoFar();");
      const claimAt = body.indexOf("State.TryBeginRun(");
      expect(readAt).toBeGreaterThan(0);
      expect(claimAt).toBeGreaterThan(readAt);
    }
  });

  test("a 'ran' answer carries testRunsBefore and sessionId; a refusal carries neither", () => {
    const api = read("ControlApi.Codeunit.al");
    const body = procedureBody(api, "AddSessionKeys");
    expect(body).toContain("if Status <> 'ran' then");
    expect(body).toContain("Obj.Add('testRunsBefore', TestRunsBefore);");
    expect(body).toContain("Obj.Add('sessionId', SessionId());");
    // Both builders route through it.
    expect(procedureBody(api, "BuildStatus")).toContain(
      "AddSessionKeys(Obj, Status, TestRunsBefore);",
    );
    expect(procedureBody(api, "BuildManyStatus")).toContain(
      "AddSessionKeys(Obj, Status, TestRunsBefore);",
    );
  });

  test("every group entry carries its own sessionId and lineNo", () => {
    const src = read("RunMany.Codeunit.al");
    expect(src).toContain("One.Add('lineNo', FnLineNo);");
    expect(src).toContain("One.Add('sessionId', SessionId());");
  });
});

describe("suite-unresolved (R206 §4 item 1)", () => {
  test("is answered AFTER phase 3 tombstones the op, so a refused request never strands it", () => {
    const body = procedureBody(read("ControlApi.Codeunit.al"), "RunMutantMany");
    const finishAt = body.indexOf("State.TryFinishRun(");
    const unresolvedAt = body.indexOf("BuildManyStatus('suite-unresolved'");
    expect(finishAt).toBeGreaterThan(0);
    expect(unresolvedAt).toBeGreaterThan(finishAt);
  });
});
