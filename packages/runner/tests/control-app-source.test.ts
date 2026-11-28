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
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CLIENT_ATTESTATION_PAGE_ROWS } from "../src/client-run";

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

  test("all three run sites call NoteTestMethodRun immediately before the run", () => {
    const method = statementsBefore(read("RunMethod.Codeunit.al"), "Mgt.RunAllTests(Line);", 1);
    expect(method[0]).toBe("State.NoteTestMethodRun();");
    const many = statementsBefore(
      read("RunMany.Codeunit.al"),
      "Mgt.RunTests(RunLine, ALTestSuite);",
      1,
    );
    expect(many[0]).toBe("State.NoteTestMethodRun();");
    // PR-478: the third site, in a client session only (gated on the bound client-run session)
    const third = codeOnly(
      procedureBody(read("ClientSubscribers.Codeunit.al"), "ResetObservationsBeforeMethod"),
    );
    expect(statementsBefore(third, "State.NoteTestMethodRun();", 2)).toEqual([
      "exit;",
      "if not State.IsBoundClientSession() then",
    ]);
    expect(
      codeOnly(read("ClientSubscribers.Codeunit.al")).match(/NoteTestMethodRun\(\)/g),
    ).toHaveLength(1);
  });

  test("no other AL file assigns it", () => {
    for (const file of ["RunMethod.Codeunit.al", "RunMany.Codeunit.al", "ControlApi.Codeunit.al"]) {
      expect(codeOnly(read(file))).not.toMatch(/TestMethodRuns\s*(:=|\+=|-=)/);
    }
  });

  test("both actions read it at the very top, before phase 1 claims", () => {
    // R236b: RunMutant is now a thin wrapper (see the GetOpAnswer describe block below); the
    // single-method logic this pin is about, including this read, lives in RunMutantCore.
    const api = read("ControlApi.Codeunit.al");
    for (const action of ["RunMutantCore", "RunMutantMany"]) {
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

const at = (body: string, needle: string): number => {
  const i = body.indexOf(needle);
  expect(i, `missing: ${needle}`).toBeGreaterThanOrEqual(0);
  return i;
};

describe("R1127: each method starts on the client's default WorkDate", () => {
  // The Test Runner's Initialize (130453) stores the WorkDate set before RunTests and restores it after the codeunit,
  // so the set must come after the run's positioning FindFirst and before the reset/note pair, with no other
  // WorkDate( write in between.
  test("LC Run Many: GetDefaultWorkDate once per call, WorkDate set before each method's run", () => {
    const body = codeOnly(procedureBody(read("RunMany.Codeunit.al"), "RunAll"));
    const computed = at(body, "StartWorkDate := LogInMgt.GetDefaultWorkDate();");
    const loop = at(body, "foreach Entry in Methods do begin");
    const find = at(body, "RunLine.FindFirst();");
    const set = at(body, "WorkDate(StartWorkDate);");
    const reset = at(body, "State.ResetObservedActive();");
    expect(computed).toBeLessThan(loop);
    expect(loop).toBeLessThan(find);
    expect(find).toBeLessThan(set);
    expect(set).toBeLessThan(reset);
    expect(body.match(/\bWorkDate\(/g)?.length).toBe(1); // \b: GetDefaultWorkDate( is not a set
    expect(body.match(/StartWorkDate :=/g)?.length).toBe(1);
  });
  test("LC Run Method: WorkDate set from GetDefaultWorkDate after the positioning FindFirst, before the note", () => {
    const body = codeOnly(procedureBody(read("RunMethod.Codeunit.al"), "RunOneMethod"));
    const set = at(body, "WorkDate(LogInMgt.GetDefaultWorkDate());");
    const note = at(body, "State.NoteTestMethodRun();");
    const run = at(body, "Mgt.RunAllTests(Line);");
    expect(body.lastIndexOf("Line.FindFirst();", set)).toBeGreaterThan(0);
    expect(body.lastIndexOf("Line.FindFirst();", set)).toBeGreaterThan(
      body.lastIndexOf('Line.SetRange("Test Suite", RunSuiteName);', set),
    );
    expect(set).toBeLessThan(note);
    expect(note).toBeLessThan(run);
    expect(body.match(/\bWorkDate\(/g)?.length).toBe(1); // \b: GetDefaultWorkDate( is not a set
  });
  test("R1131: each answer that ran a method returns the start WorkDate it set, as ISO text", () => {
    // RunMany: one `workDate` per per-method object, from the date it set before that method.
    const many = codeOnly(procedureBody(read("RunMany.Codeunit.al"), "RunAll"));
    expect(many).toContain("One.Add('workDate', Format(StartWorkDate, 0, 9));");
    // RunMethod: read back right after the set, before the run, and handed out through a getter.
    const method = codeOnly(procedureBody(read("RunMethod.Codeunit.al"), "RunOneMethod"));
    const set = at(method, "WorkDate(LogInMgt.GetDefaultWorkDate());");
    const text = at(method, "StartWorkDateText := Format(WorkDate, 0, 9);");
    expect(set).toBeLessThan(text);
    expect(text).toBeLessThan(at(method, "Mgt.RunAllTests(Line);"));
    expect(read("RunMethod.Codeunit.al")).toContain("procedure StartWorkDate(): Text");
    // BuildStatus adds it only when a method ran (a blank date is a fail-closed answer).
    const status = codeOnly(procedureBody(read("ControlApi.Codeunit.al"), "BuildStatus"));
    expect(status).toContain("if WorkDateText <> '' then");
    expect(status).toContain("Obj.Add('workDate', WorkDateText);");
    expect(read("ControlApi.Codeunit.al")).toContain("Runner.StartWorkDate()));");
  });
  test("R1131 amendment 2: HarnessInfo returns the fresh start WorkDate the same way, with no test run", () => {
    const info = codeOnly(procedureBody(read("ControlApi.Codeunit.al"), "HarnessInfo"));
    expect(info).toContain("Obj.Add('workDate', Format(LogInMgt.GetDefaultWorkDate(), 0, 9));");
    expect(info.match(/\bWorkDate\(/g)).toBeNull(); // reads only, never sets the session's WorkDate
  });
});

describe("GH-24: ObservedActive, reset per method and read after ProgressBetween", () => {
  test("LC Run Many resets ObservedActive right before each method runs", () => {
    const body = procedureBody(read("RunMany.Codeunit.al"), "RunAll");
    const loop = at(body, "foreach Entry in Methods do begin");
    const reset = at(body, "State.ResetObservedActive();");
    const note = at(body, "State.NoteTestMethodRun();");
    const run = at(body, "Mgt.RunTests(RunLine, ALTestSuite);");
    expect(loop).toBeLessThan(reset);
    expect(reset).toBeLessThan(note);
    expect(note).toBeLessThan(run);
    expect(body.slice(reset, note).split(";").length).toBe(2); // nothing between reset and note
  });
  test("ResetObservedActive clears the flag", () => {
    at(
      procedureBody(read("ControlState.Codeunit.al"), "ResetObservedActive"),
      "ObservedActive := false;",
    );
  });
  test("the entry reads ObservedActive only after ProgressBetween", () => {
    const body = procedureBody(read("RunMany.Codeunit.al"), "RunAll");
    const between = at(body, "State.ProgressBetween(FenceAttemptId, FenceOpSeq, Index);");
    const readAt = at(body, "One.Add('observedActive', State.AttestationObservedActive());");
    expect(readAt).toBeGreaterThan(between);
  });
  test("IsActive does not set ObservedActive (the root-grain trap)", () => {
    const body = procedureBody(read("ControlState.Codeunit.al"), "IsActive");
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toContain("ObservedActive");
  });
  test("both resets clear ObservedActive", () => {
    for (const p of ["WriteActive", "ResetAttestationState"]) {
      at(procedureBody(read("ControlState.Codeunit.al"), p), "ObservedActive := false;");
    }
  });
  test("RunMutant reads ObservedActive before phase 3 and answers it", () => {
    // R236b: the phases live in RunMutantCore now; RunMutant is the thin public wrapper.
    const body = procedureBody(read("ControlApi.Codeunit.al"), "RunMutantCore");
    const readAt = at(body, "State.AttestationObservedActive()");
    const phase3 = at(body, "State.TryFinishRun(");
    expect(readAt).toBeLessThan(phase3);
    at(
      procedureBody(read("ControlApi.Codeunit.al"), "BuildStatus"),
      "Obj.Add('observedActive', ObservedActive);",
    );
  });
});

describe("R236b: RunMutant is a thin wrapper over RunMutantCore, ran answers are kept", () => {
  test("RunMutantCore reports whether it reached 'ran', false at entry, true only on that exit", () => {
    const body = procedureBody(read("ControlApi.Codeunit.al"), "RunMutantCore");
    expect(body).toContain("var Ran: Boolean) ResultJson: Text");
    const start = at(body, "Ran := false;");
    const beforeExit = body.indexOf("Ran := true;\n        exit(BuildStatus('ran',");
    expect(beforeExit).toBeGreaterThan(start);
    // No other assignment to Ran anywhere in the body (every non-'ran' exit leaves it false).
    const writes = body.match(/Ran\s*:=/g) ?? [];
    expect(writes).toEqual(["Ran :=", "Ran :="]);
  });

  test("the public RunMutant wrapper delegates to RunMutantCore and keeps the answer only when it ran", () => {
    const body = procedureBody(read("ControlApi.Codeunit.al"), "RunMutant");
    expect(body).toContain(
      "ResultJson := RunMutantCore(TargetAppId, ArtifactId, AttemptId, MutantId, TestCodeunitId, TestMethod, LeaseEpoch, LeaseToken, ServerGeneration, OpSeq, Ran);",
    );
    const delegateAt = at(body, "ResultJson := RunMutantCore(");
    const ifRanAt = at(body, "if Ran then");
    const keepAt = at(
      body,
      "KeepAnswer(AttemptId, OpSeq, LeaseEpoch, ServerGeneration, ResultJson);",
    );
    expect(ifRanAt).toBeGreaterThan(delegateAt);
    expect(keepAt).toBeGreaterThan(ifRanAt);
  });
});

describe("R689: the discovery error is read from a cleared last error (RunOneMethod only)", () => {
  const anchor = "Mgt.SelectTestMethodsByRange(ALTestSuite, Format(RunTestCodeunitId));";
  test("ClearLastError() is the statement immediately before SelectTestMethodsByRange", () => {
    expect(statementsBefore(read("RunMethod.Codeunit.al"), anchor, 1)).toEqual([
      "ClearLastError();",
    ]);
  });
  test("the last error text and stack are copied straight after the select", () => {
    expect(statementsAfter(read("RunMethod.Codeunit.al"), anchor, 2)).toEqual([
      "DiscoveryText := GetLastErrorText();",
      "DiscoveryStack := GetLastErrorCallStack();",
    ]);
  });
  test("InstalledDependents (R733) raises on a bad GUID and keeps DependentCount", () => {
    const api = codeOnly(read("ControlApi.Codeunit.al"));
    expect(procedureBody(api, "InstalledDependents")).toContain(
      "Error('InstalledDependents: %1 is not a GUID', AppId);",
    );
    expect(api).toContain("procedure DependentCount(AppId: Text)");
    expect(api).toContain('tabledata "NAV App Installed App" = R');
  });
  // AL's standard Format of an Integer may add a thousands separator ("93,890"), which would never
  // match BC's stack text "(CodeUnit 93890)": every id of 1000 or more would silently quote nothing.
  test("Integers go into those StrSubstNo calls as Format(..., 0, 9), never bare", () => {
    expect(codeOnly(read("RunMethod.Codeunit.al"))).toContain(
      "StrSubstNo('(CodeUnit %1)', Format(RunTestCodeunitId, 0, 9))",
    );
    expect(
      procedureBody(codeOnly(read("ControlApi.Codeunit.al")), "InstalledDependents"),
    ).toContain(
      'StrSubstNo(\'%1.%2.%3.%4\', Format(Installed."Version Major", 0, 9), Format(Installed."Version Minor", 0, 9), Format(Installed."Version Build", 0, 9), Format(Installed."Version Revision", 0, 9))',
    );
  });
});

/**
 * R847 Part 1: the two read actions are in the source, NOT published and not yet proven on a server
 * (Part 2). These pins are statement facts whose violation would not fail any gate and would read as
 * a clean answer: a kind mapped to the wrong AllObj type, a loop that never stops, a short answer
 * that looks whole.
 */
describe("R847 (Part 1, not yet published): ObjectOwners and FieldOwners", () => {
  const api = codeOnly(read("ControlApi.Codeunit.al"));
  const KINDS = [
    ["Table", "Table"],
    ["Codeunit", "Codeunit"],
    ["Page", "Page"],
    ["Report", "Report"],
    ["Query", "Query"],
    ["XmlPort", "XMLport"],
    ["Enum", "Enum"],
    ["EnumExtension", "EnumExtension"],
    ["PermissionSet", "PermissionSet"],
    ["PermissionSetExtension", "PermissionSetExtension"],
    ["TableExtension", "TableExtension"],
    ["PageExtension", "PageExtension"],
    ["ReportExtension", "ReportExtension"],
  ] as const;

  test("AllObj and Field are declared, read only", () => {
    expect(api).toContain("tabledata AllObj = R");
    expect(api).toContain("tabledata Field = R");
  });

  test("each of the 13 kinds has its own case line, Table is never TableData, an unknown kind raises", () => {
    const body = procedureBody(api, "FilterObjectType");
    for (const [kind, option] of KINDS) {
      expect(body).toContain(
        `'${kind}':\n                AllObjRec.SetRange("Object Type", AllObjRec."Object Type"::${option});`,
      );
    }
    expect(body).not.toContain("TableData");
    expect(body).toContain("else\n                Error('unknown object kind \"%1\"', Kind);");
  });

  test("both loops stop at the deadline, count what they read, and answer one row per item read", () => {
    for (const name of ["ObjectOwners", "FieldOwners"]) {
      const body = procedureBody(api, name);
      expect(body).toContain(
        "if DurationMs(CurrentDateTime() - StartedAt) >= MaxMs then\n                break;",
      );
      expect(body).toContain("Rows.Add(Row);\n            Read += 1;");
      expect(body).toContain("Obj.Add('read', Read);");
      expect(body).toContain("Obj.Add('rows', Rows);");
      // A second row is never hidden: FindSet, a count, and more than one is unresolved.
      expect(body).toContain("FindSet()");
      expect(body).toContain("Count += 1;");
      expect(body).toContain("(Count > 1) or (Owner = '')");
      expect(body).toContain("Row.Add('outcome', 'none')");
    }
  });

  test("a call is refused loudly past 200 items, on a non-array, and with MaxMs not above 0", () => {
    const body = procedureBody(api, "ParseItems");
    expect(body).toContain("if MaxMs <= 0 then");
    expect(body).toContain("if not Items.ReadFrom(ItemsJson) then");
    expect(body).toContain("if Items.Count() > 200 then");
  });

  test("the owner is joined by App ID from the package, cached per call, and a null package is unresolved", () => {
    const body = procedureBody(api, "OwnerOfPackage");
    expect(body).toContain("if IsNullGuid(PackageId) then\n            exit('');");
    expect(body).toContain("if Cache.ContainsKey(PackageId) then");
    expect(body).toContain('Installed.SetRange("Package ID", PackageId);');
    expect(body).toContain("Installed.FindSet()");
    expect(body).toContain("Cache.Add(PackageId, Found);");
  });

  test("a field row carries FieldName and TableName as BC holds them, for the client to compare", () => {
    const body = procedureBody(api, "FieldOwners");
    expect(body).toContain("FieldNameRead := FieldRec.FieldName;");
    expect(body).toContain("TableNameRead := FieldRec.TableName;");
    expect(body).toContain("Row.Add('fieldName', FieldNameRead);");
    expect(body).toContain("Row.Add('tableName', TableNameRead);");
    // No second read of the record, and no fields the client never uses.
    expect(body).not.toContain("FindFirst()");
    expect(body).not.toContain("fieldId");
    expect(procedureBody(api, "ObjectOwners")).not.toContain("objectName");
    expect(procedureBody(api, "ObjectOwners")).not.toContain("FindFirst()");
  });
});

describe("PR-309: the lease renew does not lock during a run", () => {
  const state = (): string => read("ControlState.Codeunit.al");

  test("TryRenew's fast path comes before LockTable, on its own ReadUncommitted record, with no write", () => {
    const body = procedureBody(state(), "TryRenew");
    const lockAt = body.indexOf("Lease.LockTable();");
    const fastAt = body.indexOf("Peek.ReadIsolation := IsolationLevel::ReadUncommitted;");
    expect(fastAt).toBeGreaterThan(0);
    expect(lockAt).toBeGreaterThan(fastAt);
    const fast = codeOnly(body.slice(0, lockAt));
    expect(fast).not.toContain("Modify");
    expect(fast).not.toContain("Commit");
    expect(fast).not.toContain("LockTable");
    expect(fast).not.toContain("Lease.");
    // all five checks, in the one condition that answers
    expect(fast).toContain("(Peek.Epoch = Epoch)");
    expect(fast).toContain("(Peek.Token = Token)");
    expect(fast).toContain('(Peek."Server Generation" = Generation)');
    expect(fast).toContain(
      '((Peek."Op Kind" = Peek."Op Kind"::run) or (Peek."Op Kind" = Peek."Op Kind"::"client-run"))',
    );
    expect(fast).toContain('(Peek."Expires At" >= CurrentDateTime + (TtlSeconds * 1000))');
    expect(fast).toContain('ExpiresAt := Peek."Expires At";');
    // ONE contiguous text, whitespace-normalised: an `and` turned `or`, or a missing `exit;`, goes red.
    expect(fast.replace(/\s+/g, " ")).toContain(
      'if (Peek.Epoch = Epoch) and (Peek.Token = Token) and (Peek."Server Generation" = Generation) and ((Peek."Op Kind" = Peek."Op Kind"::run) or (Peek."Op Kind" = Peek."Op Kind"::"client-run")) and (Peek."Expires At" >= CurrentDateTime + (TtlSeconds * 1000)) then begin Renewed := true; ExpiresAt := Peek."Expires At"; exit; end;',
    );
  });

  test("TrimRunClaim is absent from TryEndPublish, TryRenew and TryBeginRun", () => {
    const src = state();
    for (const name of ["TryEndPublish", "TryRenew", "TryBeginRun"]) {
      expect(procedureBody(src, name), name).not.toContain("TrimRunClaim");
    }
  });

  test("the locked fallback keeps LockTable, Modify and Commit, and never pulls a run claim inwards", () => {
    const body = procedureBody(state(), "TryRenew");
    const locked = body.slice(body.indexOf("Lease.LockTable();"));
    expect(locked).toContain("Lease.Modify();");
    expect(locked).toContain("Commit();");
    expect(locked).toContain(
      '((Lease."Op Kind" = Lease."Op Kind"::run) or (Lease."Op Kind" = Lease."Op Kind"::"client-run")) and (Lease."Expires At" > NewExpiry)',
    );
    expect(locked).toContain('NewExpiry := Lease."Expires At";');
  });

  test("ExtendRunClaim adds the call's bound, clamped to MaxRunBoundMs, never inwards", () => {
    const src = state();
    const body = procedureBody(src, "ExtendRunClaim");
    expect(body).toContain("if RunBoundMs < 0 then");
    expect(body).toContain("RunBoundMs := 0;");
    expect(body).toContain("if RunBoundMs > MaxRunBoundMs() then");
    expect(body).toContain("RunBoundMs := MaxRunBoundMs();");
    expect(body).toContain("Runway := CurrentDateTime + RunClaimRunwayMs() + RunBoundMs;");
    expect(body).toContain('if Lease."Expires At" < Runway then');
    expect(procedureBody(src, "MaxRunBoundMs")).toContain("exit(600000);");
    expect(procedureBody(src, "SingleRunBoundMs")).toContain("exit(MaxRunBoundMs());");
    expect(procedureBody(src, "TryBeginRun")).toContain("ExtendRunClaim(Lease, RunBoundMs);");
  });

  test("RunMutantMany passes ceiling + stop grace, a single run passes SingleRunBoundMs()", () => {
    const api = read("ControlApi.Codeunit.al");
    // each wire value is clamped BEFORE the add, so a huge one cannot overflow an Integer
    expect(procedureBody(api, "RunMutantMany")).toContain(
      "MutantId, State.ClampRunBoundMs(RequestCeilingMs) + State.ClampRunBoundMs(StopGraceMs), Claimed, ClaimReason);",
    );
    const clamp = procedureBody(state(), "ClampRunBoundMs");
    expect(clamp).toContain("if Ms < 0 then");
    expect(clamp).toContain("exit(0);");
    expect(clamp).toContain("if Ms > MaxRunBoundMs() then");
    expect(clamp).toContain("exit(MaxRunBoundMs());");
    expect(procedureBody(api, "RunMutantCore")).toContain(
      "MutantId, State.SingleRunBoundMs(), Claimed, ClaimReason);",
    );
  });

  test("each of the four procedures that clear a run marker trims the runway inside its lock", () => {
    const src = state();
    const trim = procedureBody(src, "TrimRunClaim");
    expect(trim).toContain("Trimmed := CurrentDateTime + RunClaimRunwayMs();");
    expect(trim).toContain('if Lease."Expires At" > Trimmed then');
    for (const name of ["TryFinishRun", "TryRecoverOp", "TryStopHungRun", "TryStopHungRunAt"]) {
      const body = procedureBody(src, name);
      const trimAt = body.indexOf("TrimRunClaim(Lease);");
      expect(trimAt, name).toBeGreaterThan(body.indexOf("Lease.LockTable();"));
      expect(body.indexOf("Lease.Modify();", trimAt), name).toBeGreaterThan(trimAt);
      // the trim sits right before the one Modify that clears the marker
      expect(body.slice(trimAt, trimAt + 60), name).toContain("Lease.Modify();");
    }
  });
});

/**
 * PR-462 (1.0.0.30, R1170): the Generation counter must never refresh the cache of a session inside
 * its own op, nor after its phase 3. Inside an op the row's Generation never moves (every write is
 * fenced), so no gate can see this gate missing: only these pins can (pre-commitment
 * 2026-11-26-pr462-control-1030-generation.md).
 */
describe("the Generation refresh gate (PR-462)", () => {
  const state = read("ControlState.Codeunit.al");

  test("phase 1 (WriteActive) opens the op and clears the reset; ResetAttestationState does the reverse", () => {
    const write = codeOnly(procedureBody(state, "WriteActive"));
    expect(write).toContain("InOdataOp := true;");
    expect(write).toContain("ResetSinceLoad := false;");
    const reset = codeOnly(procedureBody(state, "ResetAttestationState"));
    expect(reset).toContain("InOdataOp := false;");
    expect(reset).toContain("ResetSinceLoad := true;");
    // and nothing else assigns either flag
    expect(codeOnly(state).match(/InOdataOp\s*:=/g)).toHaveLength(2);
    expect(codeOnly(state).match(/ResetSinceLoad\s*:=/g)).toHaveLength(2);
  });

  test("RefreshIfMoved exits on either flag BEFORE it reads the row", () => {
    const body = codeOnly(procedureBody(state, "RefreshIfMoved"));
    const gate = body.indexOf("if InOdataOp or ResetSinceLoad then");
    const firstGet = body.indexOf("Active.Get(");
    expect(gate).toBeGreaterThan(-1);
    expect(firstGet).toBeGreaterThan(gate);
    expect(statementsAfter(body, "if InOdataOp or ResetSinceLoad then", 1)).toEqual(["exit;"]);
  });

  test("the guard and the reach marker go through RefreshIfMoved, never EnsureLoaded directly", () => {
    for (const name of ["IsActive", "NoteReached"]) {
      const body = codeOnly(procedureBody(state, name));
      expect(body, name).toContain("RefreshIfMoved();");
      expect(body, name).not.toContain("EnsureLoaded();");
    }
  });

  test("every write of the tuple bumps Generation right before its Modify (exactly three writers)", () => {
    const writers = ["WriteActive", "ClearActiveIf", "ForceClearActive"];
    for (const name of writers) {
      const body = procedureBody(state, name);
      expect(statementsBefore(body, "Active.Modify();", 1), name).toEqual([
        "Active.Generation += 1;",
      ]);
    }
    expect(codeOnly(state).match(/Active\.Modify\(\);/g)).toHaveLength(writers.length);
    expect(codeOnly(state).match(/Active\.Generation \+= 1;/g)).toHaveLength(writers.length);
  });
});

/**
 * PR-478 (1.0.0.31): the client-session half of the control app (pre-commitment
 * 2026-11-27-pr478-control-1031.md). None of these can fail a headless gate: each guards a property
 * that only a client session, or a refused call, would show.
 */
describe("1.0.0.31 client sessions (PR-478)", () => {
  const state = read("ControlState.Codeunit.al");
  const subs = read("ClientSubscribers.Codeunit.al");
  const api = read("ControlApi.Codeunit.al");

  test("each subscriber acts only for the bound session of a client-run op", () => {
    for (const name of ["ResetObservationsBeforeMethod", "WriteAttestationAfterMethod"]) {
      const body = codeOnly(procedureBody(subs, name));
      const begin = body.indexOf("begin");
      expect(statementsAfter(body.slice(begin), "begin", 2), name).toEqual([
        "if not State.IsBoundClientSession() then",
        "exit;",
      ]);
    }
    const gate = codeOnly(procedureBody(state, "IsBoundClientSession")).replace(/\s+/g, " ");
    expect(gate).toContain('if Lease."Op Kind" <> Lease."Op Kind"::"client-run" then exit(false);');
    expect(gate).toContain('exit((SessionId() > 0) and (Lease."Op Session Id" = SessionId()));');
    expect(gate).not.toContain("LC Mutation Active");
  });

  test("the gate reads the lease ReadUncommitted, before the Get (no lock in a headless run)", () => {
    const gate = codeOnly(procedureBody(state, "IsBoundClientSession"));
    const iso = gate.indexOf("Lease.ReadIsolation := IsolationLevel::ReadUncommitted;");
    expect(iso).toBeGreaterThan(-1);
    expect(gate.indexOf("Lease.Get(")).toBeGreaterThan(iso);
    expect(gate).not.toContain("LockTable");
  });

  test("LC Client Subscribers has exactly two subscribers, both gated", () => {
    const code = codeOnly(subs);
    expect(code.match(/\[EventSubscriber\(/g)).toHaveLength(2);
    expect(code.match(/procedure /g)).toHaveLength(2);
    expect(code.match(/if not State\.IsBoundClientSession\(\) then/g)).toHaveLength(2);
    expect(code).toContain('Codeunit::"Test Runner - Mgt", OnBeforeTestMethodRun');
    expect(code).toContain('Codeunit::"Test Runner - Mgt", OnAfterTestMethodRun');
  });

  test("the gated OnBefore is the third place a test method is counted", () => {
    const body = codeOnly(procedureBody(subs, "ResetObservationsBeforeMethod"));
    expect(statementsAfter(body.slice(body.indexOf("begin")), "begin", 4)).toEqual([
      "if not State.IsBoundClientSession() then",
      "exit;",
      "State.NoteTestMethodRun();",
      "State.ResetObservations();",
    ]);
  });

  test("the observation reset clears the three observations and never sets ResetSinceLoad", () => {
    const reset = codeOnly(procedureBody(state, "ResetObservations"));
    expect(reset.match(/:=/g)).toHaveLength(3);
    expect(reset).toContain("ObservedAny := false;");
    expect(reset).toContain("ObservedIdentityMismatch := false;");
    expect(reset).toContain("ObservedActive := false;");
    expect(reset).not.toContain("ResetSinceLoad");
    expect(reset).not.toContain("TestMethodRuns");
    // the OnBefore subscriber calls it and nothing else of the state
    const before = codeOnly(procedureBody(subs, "ResetObservationsBeforeMethod"));
    expect(before).toContain("State.ResetObservations();");
    expect(before).not.toContain("ResetSinceLoad");
    expect(before.match(/State\./g)).toHaveLength(3);
  });

  test("the attestation writer never reads the tuple table", () => {
    const writer = codeOnly(procedureBody(state, "WriteClientAttestation"));
    expect(writer).not.toContain("Mutation Active");
    expect(writer).not.toContain("Active.Get");
    expect(writer).toContain("Attestation.Loaded := Loaded;");
    expect(writer).toContain('Attestation."Loaded Generation" := CachedGeneration;');
    expect(writer).toContain("Attestation.Success := Success;");
    expect(codeOnly(subs)).not.toContain("Mutation Active");
    expect(codeOnly(read("ClientAttestation.Table.al"))).not.toContain("Mutation Active");
    expect(codeOnly(read("ClientAttestation.Table.al"))).toContain("DataPerCompany = false;");
    expect(codeOnly(procedureBody(subs, "WriteAttestationAfterMethod"))).toContain(
      "State.WriteClientAttestation(CodeunitID, FunctionName, IsSuccess);",
    );
  });

  test("TryStopHungRun and TryStopHungRunAt refuse a client-run op, after the tombstone check", () => {
    for (const name of ["TryStopHungRun", "TryStopHungRunAt"]) {
      const body = codeOnly(procedureBody(state, name)).replace(/\s+/g, " ");
      const refuse =
        'if Lease."Op Kind" = Lease."Op Kind"::"client-run" then begin Refusal := \'client-run\'; exit; end;';
      const at = body.indexOf(refuse);
      expect(at, name).toBeGreaterThan(body.indexOf("Refusal := 'already-completed';"));
      expect(body.indexOf("StopSession(", at), name).toBeGreaterThan(at);
    }
    // IsOwnRunActive stays the headless kind only
    expect(codeOnly(procedureBody(state, "IsOwnRunActive"))).not.toContain("client-run");
  });

  test("only DeactivateForClient, after the bound session marked its end, tombstones a client-run op", () => {
    const code = codeOnly(state);
    // the six writers of the tombstone: EndPublish, FinishRun, RecoverOp, the two stops, Deactivate
    expect(code.match(/"Last Completed Op Seq" :=/g)).toHaveLength(6);
    expect(codeOnly(procedureBody(state, "TryFinishRun"))).toContain(
      '(Lease."Op Kind" = Lease."Op Kind"::run) and (Lease."Op Attempt Id" = AttemptId)',
    );
    expect(codeOnly(procedureBody(state, "TryEndPublish"))).toContain(
      '(Lease."Op Kind" = Lease."Op Kind"::publish)',
    );
    expect(codeOnly(procedureBody(state, "TryRecoverOp"))).toContain(
      '(Lease."Op Kind" <> Lease."Op Kind"::"client-run")',
    );
    const deact = codeOnly(procedureBody(state, "TryDeactivateForClient")).replace(/\s+/g, " ");
    // the tombstone is reached only through the mark the bound session set itself (amendment 3)
    const alive = deact.indexOf('if not Lease."Op Session Ended" then begin');
    expect(alive).toBeGreaterThan(-1);
    expect(deact.slice(alive, alive + 200)).toContain(
      "Reason := 'client-session-alive'; AliveSessionId := Lease.\"Op Session Id\"; exit; end;",
    );
    expect(deact.indexOf('Lease."Last Completed Op Seq" := OpSeq;')).toBeGreaterThan(alive);
    // the unconditional tuple clear follows the mark check directly
    expect(deact.slice(alive, alive + 200)).toContain("exit; end; ForceClearActive();");
    expect(deact).toContain(
      "if Lease.\"Op Session Id\" <= 0 then begin Reason := 'no-session-id';",
    );
    expect(deact.slice(alive, alive + 160)).toContain('AliveSessionId := Lease."Op Session Id";');
    expect(codeOnly(procedureBody(api, "DeactivateForClient"))).toContain(
      "State.TryDeactivateForClient(",
    );
    expect(codeOnly(procedureBody(api, "DeactivateForClient"))).toContain(
      "Obj.Add('sessionId', AliveSessionId);",
    );
  });

  test("nothing reads Active Session (it cannot prove a client session gone: measured on bcwin)", () => {
    for (const file of readdirSync(SRC).filter((f) => f.endsWith(".al"))) {
      const code = codeOnly(read(file));
      expect(code, file).not.toMatch(/Active Session/i);
      expect(code, file).not.toContain("ActiveSessionHolds");
      expect(code, file).not.toContain("2000000110");
    }
  });

  test("a session that has ended is no longer the bound session (the gate reads the mark, unlocked)", () => {
    const gate = codeOnly(procedureBody(state, "IsBoundClientSession")).replace(/\s+/g, " ");
    const ended = gate.indexOf('if Lease."Op Session Ended" then exit(false);');
    expect(ended).toBeGreaterThan(gate.indexOf("Lease.Get("));
    expect(ended).toBeLessThan(gate.indexOf("exit((SessionId() > 0)"));
    expect(gate).toContain("Lease.ReadIsolation := IsolationLevel::ReadUncommitted;");
    expect(gate).not.toContain("LockTable");
  });

  test("EndClientSession marks the end only for the bound caller, and records the caller's id with it", () => {
    const end = codeOnly(procedureBody(state, "EndClientSession")).replace(/\s+/g, " ");
    const mark = end.indexOf('Lease."Op Session Ended" := true;');
    expect(mark).toBeGreaterThan(-1);
    expect(end.match(/"Op Session Ended" :=/g)).toHaveLength(1);
    const checks = [
      'if Lease."Op Kind" <> Lease."Op Kind"::"client-run" then begin Reason := \'not-client-run\'; exit(false); end;',
      "if (AttemptId = '') or (Lease.\"Op Attempt Id\" <> AttemptId) or (Lease.\"Op Seq\" <> OpSeq) then begin Reason := 'op-mismatch'; exit(false); end;",
      "if SessionId() <= 0 then begin Reason := 'no-session-id'; exit(false); end;",
      "if Lease.\"Op Session Id\" <> SessionId() then begin Reason := 'not-bound-session'; exit(false); end;",
    ];
    let last = -1;
    for (const check of checks) {
      const at = end.indexOf(check);
      expect(at, check).toBeGreaterThan(last);
      last = at;
    }
    expect(mark).toBeGreaterThan(last);
    // the caller's id goes into LC Ended Session in the same transaction, before the one Commit
    const insert = end.indexOf('EndedSession."Session Id" := SessionId(); EndedSession.Insert();');
    expect(insert).toBeGreaterThan(last);
    expect(insert).toBeLessThan(end.indexOf("Commit();"));
    expect(mark).toBeLessThan(end.indexOf("Commit();"));
    // no other procedure sets the mark true
    expect(codeOnly(state).match(/"Op Session Ended" := true;/g)).toHaveLength(1);
    // the callers: the page's End action and the self-only OData action
    expect(codeOnly(read("ClientBind.Page.al"))).toContain(
      "Ended := State.EndClientSession(AttemptId, OpSeq, Reason);",
    );
    const wrapper = codeOnly(procedureBody(api, "EndCallerSession")).replace(/\s+/g, " ");
    expect(wrapper).toContain("Ended := State.EndClientSession(AttemptId, OpSeq, Reason);");
    expect(wrapper).toContain("Obj.Add('ended', Ended);");
    // the caller's own id is echoed on EVERY answer (before the conditional reason), and is output only
    const echo = "Obj.Add('sessionId', SessionId());";
    expect(wrapper).toContain(echo);
    expect(wrapper.indexOf(echo)).toBeLessThan(wrapper.indexOf("if Reason <> ''"));
    expect(wrapper.replace(echo, "")).not.toMatch(/SessionId|Lease|Modify|Insert/);
  });

  test("Activate clears the mark, and the force reset clears it and empties LC Ended Session", () => {
    const act = codeOnly(procedureBody(state, "TryActivateForClient"));
    expect(act).toContain('Lease."Op Session Ended" := false;');
    expect(act.indexOf('Lease."Op Session Ended" := false;')).toBeLessThan(
      act.indexOf("Lease.Modify();"),
    );
    const reset = codeOnly(procedureBody(state, "TryForceResetLease"));
    expect(reset).toContain("EndedSession.DeleteAll();");
    expect(reset).toContain('Lease."Op Session Ended" := false;');
    expect(reset.indexOf("EndedSession.DeleteAll();")).toBeLessThan(reset.indexOf("Commit();"));
    expect(codeOnly(read("EndedSession.Table.al"))).toContain("DataPerCompany = false;");
  });

  test("the bind refuses an ended caller, before the lock and before the Modify", () => {
    const bind = codeOnly(procedureBody(state, "BindClientSession")).replace(/\s+/g, " ");
    const check =
      "if EndedSession.Get(SessionId()) then begin Reason := 'session-ended'; exit(false); end;";
    const at = bind.indexOf(check);
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(bind.indexOf("Lease.LockTable();"));
    expect(at).toBeLessThan(bind.indexOf("Lease.Modify();"));
    // BindCallerSession goes through the same procedure
    expect(codeOnly(procedureBody(api, "BindCallerSession"))).toContain(
      "State.BindClientSession(AttemptId, OpSeq, Reason);",
    );
  });

  test("the bind page shows the last refusal reason, read-only, from both Bind and End", () => {
    const page = codeOnly(read("ClientBind.Page.al")).replace(/\s+/g, " ");
    expect(page).toContain("field(ReasonField; Reason) { Caption = 'Reason'; Editable = false;");
    // the field is the page's own variable: neither action may shadow it with a local Reason
    expect(page.match(/Reason: Text;/g)).toHaveLength(1);
    expect(page).toContain("Bound := State.BindClientSession(AttemptId, OpSeq, Reason);");
    expect(page).toContain("Ended := State.EndClientSession(AttemptId, OpSeq, Reason);");
    // the page's Reason is shared across clicks, so each procedure must clear it first: a refusal then a success shows ""
    for (const name of ["BindClientSession", "EndClientSession"]) {
      const body = codeOnly(procedureBody(state, name)).replace(/\s+/g, " ");
      const first = body.indexOf("begin");
      expect(first).toBeGreaterThan(-1);
      expect(body.indexOf("begin Reason := '';")).toBe(first);
    }
  });

  test("TryRenew's fast path and no-shrink rule both cover client-run", () => {
    const body = codeOnly(procedureBody(state, "TryRenew"));
    expect(body.match(/::"client-run"/g)).toHaveLength(2);
  });

  test("the bind sets Op Session Id only when blank and only for client-run, and nothing else binds", () => {
    const bind = codeOnly(procedureBody(state, "BindClientSession")).replace(/\s+/g, " ");
    const set = bind.indexOf('Lease."Op Session Id" := SessionId();');
    expect(set).toBeGreaterThan(-1);
    const checks = [
      "if AttemptId = '' then begin Reason := 'blank-attempt-id'; exit(false); end;",
      'if Lease."Op Kind" <> Lease."Op Kind"::"client-run" then begin Reason := \'not-client-run\'; exit(false); end;',
      'if (Lease."Op Attempt Id" <> AttemptId) or (Lease."Op Seq" <> OpSeq) then begin Reason := \'op-mismatch\'; exit(false); end;',
      "if Lease.\"Op Session Id\" <> 0 then begin Reason := 'already-bound'; exit(false); end;",
      "if SessionId() <= 0 then begin Reason := 'no-session-id'; exit(false); end;",
    ];
    for (const check of checks) {
      expect(bind.indexOf(check), check).toBeGreaterThan(-1);
      expect(bind.indexOf(check), check).toBeLessThan(set);
    }
    // exactly two places record SessionId(): TryBeginRun (headless run) and the bind
    expect(codeOnly(state).match(/"Op Session Id" := SessionId\(\)/g)).toHaveLength(2);
    expect(codeOnly(procedureBody(state, "TryBeginRun"))).toContain(
      'Lease."Op Session Id" := SessionId();',
    );
    expect(codeOnly(procedureBody(state, "TryActivateForClient"))).not.toContain("SessionId()");
    const page = codeOnly(read("ClientBind.Page.al"));
    expect(page).toContain("Bound := State.BindClientSession(AttemptId, OpSeq, Reason);");
    expect(page).not.toContain("Op Session Id");
    for (const file of ["ControlApi.Codeunit.al", "RunMany.Codeunit.al", "RunMethod.Codeunit.al"]) {
      expect(codeOnly(read(file)), file).not.toMatch(/"Op Session Id"\s*:=/);
    }
  });

  test("ActivateForClient ends with the serving session's state reset, after the Commit", () => {
    const body = codeOnly(procedureBody(state, "TryActivateForClient"));
    const write = body.indexOf("WriteActive(TargetAppId, ArtifactId, MutantId);");
    const commit = body.indexOf("Commit();", write);
    const reset = body.indexOf("ResetAttestationState();", commit);
    expect(write).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(write);
    expect(reset).toBeGreaterThan(commit);
    expect(statementsAfter(body, "ResetAttestationState();", 2)).toEqual([
      "Claimed := true;",
      "exit;",
    ]);
    expect(body).toContain("NewGeneration := CachedGeneration;");
    expect(body).toContain('Lease."Op Kind" := Lease."Op Kind"::"client-run";');
    expect(body).toContain("ExtendRunClaim(Lease, RunBoundMs);");
    expect(codeOnly(procedureBody(api, "ActivateForClient"))).toContain(
      "State.TryActivateForClient(",
    );
  });

  test("ActivateForClient's checks run in TryBeginRun's order, under the lease lock", () => {
    const order = [
      "ValidateFenceCredentials(Epoch, Token, Generation, AttemptId);",
      "Lease.LockTable();",
      'if (Lease.Epoch <> Epoch) or (Lease.Token <> Token) or (Lease."Server Generation" <> Generation) then begin',
      "RegisteredArtifact(TargetAppId) <> ArtifactId",
      'if OpSeq <= Lease."Last Completed Op Seq" then begin',
      "Reason := 'op-in-flight';",
      'if (OpSeq = Lease."Last Completed Op Seq" + 1) and (Lease."Op Kind" = Lease."Op Kind"::none) then begin',
    ];
    for (const name of ["TryBeginRun", "TryActivateForClient"]) {
      const body = codeOnly(procedureBody(state, name));
      let last = -1;
      for (const marker of order) {
        const at = body.indexOf(marker);
        expect(at, `${name}: ${marker}`).toBeGreaterThan(last);
        last = at;
      }
    }
    const act = codeOnly(procedureBody(state, "TryActivateForClient"));
    expect(act.indexOf("Lease.Modify();")).toBeLessThan(act.indexOf("WriteActive("));
  });

  test("BindCallerSession binds the CALLER's session through the page's own procedure", () => {
    const body = codeOnly(procedureBody(api, "BindCallerSession"));
    expect(body).toContain("Bound := State.BindClientSession(AttemptId, OpSeq, Reason);");
    expect(body).toContain("Obj.Add('bound', Bound);");
    // no session id comes from the wire, and the action writes nothing itself
    const echo = "Obj.Add('sessionId', SessionId());";
    expect(body).toContain(echo);
    expect(body.indexOf(echo)).toBeLessThan(body.indexOf("if Reason <> ''"));
    expect(body.replace(echo, "")).not.toMatch(/SessionId|Lease|Modify|Insert/);
    expect(body.match(/State\./g)).toHaveLength(1);
    // the one procedure takes the caller's own id, behind the same checks the page uses
    expect(codeOnly(procedureBody(state, "BindClientSession"))).toContain(
      'Lease."Op Session Id" := SessionId();',
    );
  });

  test("ReadClientAttestation is fenced and read-only", () => {
    const body = codeOnly(procedureBody(state, "TryReadClientAttestation"));
    const fence = body.indexOf("ValidateFenceCredentials(Epoch, Token, Generation, AttemptId);");
    const tuple = body.indexOf(
      'if (Lease.Epoch <> Epoch) or (Lease.Token <> Token) or (Lease."Server Generation" <> Generation) then',
    );
    const read = body.indexOf("Attestation.FindSet()");
    expect(fence).toBeGreaterThan(-1);
    expect(tuple).toBeGreaterThan(fence);
    expect(read).toBeGreaterThan(tuple);
    // Valid is set only AFTER the tuple check, which exits on a mismatch
    const flat = body.replace(/\s+/g, " ");
    expect(flat).toContain("<> Generation) then exit; Valid := true;");
    expect(flat.indexOf("Valid := true;")).toBeLessThan(flat.indexOf("Attestation.FindSet()"));
    expect(flat.indexOf("Valid := true;")).toBe(flat.lastIndexOf("Valid := true;"));
    // no lock: both records read ReadCommitted, before their first read
    const leaseIso = body.indexOf("Lease.ReadIsolation := IsolationLevel::ReadCommitted;");
    const attIso = body.indexOf("Attestation.ReadIsolation := IsolationLevel::ReadCommitted;");
    expect(leaseIso).toBeGreaterThan(-1);
    expect(attIso).toBeGreaterThan(-1);
    expect(body.indexOf("Lease.Get(")).toBeGreaterThan(leaseIso);
    expect(read).toBeGreaterThan(attIso);
    expect(body).toContain('Attestation.SetRange("Attempt Id", AttemptId);');
    expect(body).toContain('Attestation.SetRange("Op Seq", OpSeq);');
    for (const write of ["Modify(", "Insert(", "Delete(", "Commit(", "LockTable("]) {
      expect(body, write).not.toContain(write);
    }
    const wrapper = codeOnly(procedureBody(api, "ReadClientAttestation")).replace(/\s+/g, " ");
    expect(wrapper).toContain(
      "if Valid then begin Obj.Add('total', Total); Obj.Add('from', FromIndex); Obj.Add('rows', Rows); end else Obj.Add('reason', 'lease-invalid');",
    );
    // Amendment 8 (1.0.0.32): ONE page. The bound is refused before any read; the total is the Count() of the
    // filtered rows; the loop stops at MaxRows; and the server's page limit is the client's page size.
    expect(
      flat.indexOf("if (MaxRows < 1) or (MaxRows > MaxAttestationPageRows()) then"),
    ).toBeGreaterThan(flat.indexOf("ValidateFenceCredentials("));
    expect(flat.indexOf("if FromIndex < 0 then")).toBeLessThan(flat.indexOf("Lease.Get("));
    expect(flat.indexOf("Total := Attestation.Count();")).toBeGreaterThan(
      flat.indexOf('Attestation.SetRange("Op Seq", OpSeq);'),
    );
    expect(flat).toContain("if Attestation.Next(FromIndex) <> FromIndex then exit;");
    expect(flat).toContain("until (Taken >= MaxRows) or (Attestation.Next() = 0);");
    // the counter the bound reads: once per row, inside the loop (red: drop it and a page holds every later row)
    expect(flat).toContain("Rows.Add(Row); Taken += 1; until (Taken >= MaxRows)");
    expect(flat.indexOf("Taken += 1;")).toBe(flat.lastIndexOf("Taken += 1;"));
    expect(codeOnly(procedureBody(state, "MaxAttestationPageRows")).replace(/\s+/g, " ")).toContain(
      `exit(${CLIENT_ATTESTATION_PAGE_ROWS});`,
    );
    expect(wrapper).toContain("Obj.Add('read', Valid);");
    expect(codeOnly(procedureBody(api, "ReadClientAttestation"))).toContain(
      "State.TryReadClientAttestation(",
    );
    expect(codeOnly(procedureBody(api, "ReadClientAttestation"))).not.toMatch(
      /Modify|Insert|Delete|Commit/,
    );
    // every JSON field, as the full statement: the name AND the field it reads
    const fields: Array<[string, string]> = [
      ["attemptId", 'Attestation."Attempt Id"'],
      ["opSeq", 'Attestation."Op Seq"'],
      ["codeunitId", 'Attestation."Codeunit Id"'],
      ["method", "Attestation.Method"],
      ["loaded", "Attestation.Loaded"],
      ["loadedGeneration", 'Attestation."Loaded Generation"'],
      ["loadedMutantId", 'Attestation."Loaded Mutant Id"'],
      ["observedAny", 'Attestation."Observed Any"'],
      ["observedIdentityMismatch", 'Attestation."Observed Identity Mismatch"'],
      ["observedActive", 'Attestation."Observed Active"'],
      ["success", "Attestation.Success"],
      ["testMethodRuns", 'Attestation."Test Method Runs"'],
      ["sessionId", 'Attestation."Session Id"'],
      ["serverGeneration", 'Attestation."Server Generation"'],
      ["databaseId", 'Attestation."Database Id"'],
    ];
    for (const [json, source] of fields) {
      expect(body, json).toContain(`Row.Add('${json}', ${source});`);
    }
    expect(body.match(/Row\.Add\(/g)).toHaveLength(fields.length);
  });

  test("outside an op, loading the tuple also loads the expected ids, before the identity compare", () => {
    const load = codeOnly(procedureBody(state, "EnsureLoaded")).replace(/\s+/g, " ");
    expect(load).toContain(
      'if not InOdataOp then begin ExpectedTargetAppId := Active."Target App Id"; ExpectedArtifactId := Active."Artifact Id"; end;',
    );
    const guard = codeOnly(procedureBody(state, "IsActive"));
    expect(guard.indexOf("RefreshIfMoved();")).toBeGreaterThan(-1);
    expect(guard.indexOf("RefreshIfMoved();")).toBeLessThan(
      guard.indexOf("ObservedIdentityMismatch := true;"),
    );
  });
});
