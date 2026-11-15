/**
 * PR-36 (R1048, upstream #8160): which tests an al-runner-v3 run passes that BC, as LethAL runs it, would refuse.
 *
 * Measured on BC 28.4 (PR-33, PR-35: three probes on bc3, Permissions Mock installed, Microsoft's test runner): a test codeunit
 * that declares no `TestPermissions` runs Restrictive, the AL default. Until the test lowers its permissions, BC refuses every
 * write and every read of a table that holds rows, in any app's code. al-runner allows them. So a test whose first table access
 * comes before its first lowering passes on al-runner and fails on BC.
 *
 * A static, LABEL-ONLY reading over the session's one parse of the test app (`TestAppModel`). It never decides a verdict:
 * the report labels the kills and survivors that rest on these tests, and counts and `mutationScore` stay as they are.
 *
 * - **The mock must be installed:** the test app depends on Permissions Mock, or on Tests-TestLibraries (which depends on it;
 *   PR-35 found no other path in 84 projects). Without it BC's behaviour is not measured, and nothing is labelled.
 * - **The codeunit is exposed:** no `TestPermissions`, or `Restrictive`.
 * - **The test, in statement order** (same-codeunit procedures followed, depth 5), reaches a record access before any lowering
 *   (a `Permissions Mock` call, or any `Library - Lower Permissions` method). The tier is over every access before that
 *   lowering:
 *   - `firm`: an Insert or a Modify (refused whatever the table holds, and whatever came before it);
 *   - `uncertain-write`: otherwise a DeleteAll, ModifyAll, Delete or Rename (refused at its read when the table holds rows);
 *   - `uncertain-read`: reads only (refused when the table holds rows).
 * - **Not counted:** an access under `asserterror` (an error there is expected); temporary records (they need no permission).
 * - **Not seen (documented limits, so a label can be wrong both ways):**
 *   - an access or a lowering inside another codeunit (a library), which PR-35 left out because a stored BC run passes some;
 *   - branches: the walk is a flat statement-order pass over every branch and every `#if` arm, so an access in an untaken
 *     branch counts; a call's arguments are walked after the call;
 *   - `this.Helper()`, and a bare record method inside `with Row do`;
 *   - a table's `InherentPermissions`, and a codeunit's own `Permissions`;
 *   - `TestPermissions = NonRestrictive` or `InheritFromTestRunner` (not measured; not labelled).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeAlName } from "@lethal/engine";
import type { TestMethodRef } from "./backend";
import type { Proc, TestAppModel, Unit } from "./testpage-scan";

/** Permissions Mock, and Tests-TestLibraries, which depends on it (its 28.4 manifest). */
export const PERMISSIONS_MOCK_APP_ID = "40860557-a18d-42ad-aecb-22b7dd80dc80";
export const TESTS_TESTLIBRARIES_APP_ID = "5d86850b-0d76-4eca-bd7b-951ad998e997";

export type RestrictiveTier = "firm" | "uncertain-write" | "uncertain-read";

/** The hedge and the instruction, stated once (the caveat's `meaning` and the report field's `diagnosis`). */
export const RESTRICTIVE_DEFAULT_DIAGNOSIS =
  "Tests al-runner passes that Business Central, as LethAL runs it, would refuse (R1048, upstream " +
  "#8160): the test app installs Permissions Mock, the test's codeunit declares no TestPermissions " +
  "(or Restrictive), and the test reaches a table access before it lowers its permissions. On BC " +
  "such a codeunit runs Restrictive: every write, and every read of a table that holds rows, is " +
  "refused until the test calls Permissions Mock or Library - Lower Permissions. The kills and " +
  "survivors resting on these tests are labelled, not changed. A fix in the test app: declare " +
  "TestPermissions = Disabled on the codeunit, or lower permissions before the first access.";

export interface RestrictiveAtRisk {
  /** `Codeunit.method`, the form a mutant's `coveringTests` uses. */
  readonly test: string;
  readonly tier: RestrictiveTier;
  /** The first access, as `<record method>` (lower-cased), for the reader. */
  readonly firstAccess: string;
}

const WRITE_FIRM = new Set(["insert", "modify"]);
const WRITE_UNCERTAIN = new Set(["delete", "deleteall", "modifyall", "rename"]);
const READS = new Set([
  "get",
  "getbysystemid",
  "find",
  "findfirst",
  "findlast",
  "findset",
  "next",
  "isempty",
  "count",
  "countapprox",
  "calcfields",
  "calcsums",
]);
const MOCK_LOWERING = new Set([
  "set",
  "assign",
  "start",
  "addpermissionset",
  "setexactpermissionset",
]);
/** By object id too: Permissions Mock is codeunit 131006, Library - Lower Permissions 132217. */
const MOCK_TYPE = /^codeunit (?:131006|(?:[\w.]+\.)?"?permissions mock"?)$/;
const LOWER_TYPE = /^codeunit (?:132217|(?:[\w.]+\.)?"?library - lower permissions"?)$/;
const MAX_DEPTH = 5;

/** Whether the test app's own app.json depends on Permissions Mock, directly or through Tests-TestLibraries. */
export function installsPermissionsMock(appJsonText: string): boolean {
  const app = JSON.parse(appJsonText.replace(/^﻿/, "")) as {
    dependencies?: ReadonlyArray<{ id?: string; appId?: string }>;
  };
  return (app.dependencies ?? []).some((d) => {
    const id = (d.id ?? d.appId ?? "").toLowerCase();
    return id === PERMISSIONS_MOCK_APP_ID || id === TESTS_TESTLIBRARIES_APP_ID;
  });
}

/**
 * A test project with no app.json (R-371 runs one) declares no dependency, so installs no mock; any other read or parse failure
 * is thrown, never read as "not installed".
 */
export async function testAppInstallsPermissionsMock(testDir: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(join(testDir, "app.json"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  return installsPermissionsMock(text);
}

/** A codeunit is exposed when it declares no `TestPermissions`, or `Restrictive`. */
export function isExposed(unit: Unit): boolean {
  const tp = unit.testPermissions?.trim().toLowerCase();
  return tp === undefined || tp === "restrictive";
}

type Kind = "record" | "temporary" | "mock" | "lower" | "codeunit" | "other";
function kindOf(types: readonly string[] | undefined): Kind {
  // a name with several types across `#if` arms counts as the first that is not "other"
  for (const raw of types ?? []) {
    const t = raw.replace(/\s+/g, " ").trim().toLowerCase();
    if (t.startsWith("record ")) return /\btemporary\b/.test(t) ? "temporary" : "record";
    if (t === "recordref" || t.startsWith("recordref ")) return "record";
    if (MOCK_TYPE.test(t)) return "mock";
    if (LOWER_TYPE.test(t)) return "lower";
    if (t.startsWith("codeunit ")) return "codeunit";
  }
  return "other";
}

type Event = { readonly e: "access"; readonly method: string } | { readonly e: "lower" };

/** The record accesses of one procedure up to the first lowering, in statement order, same-codeunit calls followed. */
function walk(proc: Proc, unit: Unit, depth: number, seen: Set<Proc>, out: Event[]): void {
  if (seen.has(proc) || depth > MAX_DEPTH) return;
  seen.add(proc);
  for (const s of proc.sites ?? []) {
    if (out.at(-1)?.e === "lower") return; // nothing after the first lowering counts
    if (s.kind === "member") {
      const name = normalizeAlName(s.receiver.replace(/^"|"$/g, ""));
      const k = kindOf(proc.scope.get(name) ?? unit.globals.get(name));
      const m = s.member.replace(/^"|"$/g, "").toLowerCase();
      // review: an access under `asserterror` expects an error, so it is not one BC's refusal would turn red
      if (
        k === "record" &&
        s.inAssertError !== true &&
        (WRITE_FIRM.has(m) || WRITE_UNCERTAIN.has(m) || READS.has(m))
      )
        out.push({ e: "access", method: m });
      else if ((k === "mock" && MOCK_LOWERING.has(m)) || k === "lower") out.push({ e: "lower" });
    } else {
      const target = unit.procs.find(
        (p) => p.name === normalizeAlName(s.name) && p.params === s.args,
      );
      if (target !== undefined) walk(target, unit, depth + 1, seen, out);
    }
  }
}

/**
 * The tier over every access before the first lowering: an Insert or Modify anywhere there is refused whatever the table holds
 * (a read before it is refused too, or passes on an empty table and the write is then refused), so it decides first (PR-35's
 * write-first reading); then a DeleteAll, ModifyAll, Delete or Rename; then reads alone.
 */
function tierOf(methods: readonly string[]): RestrictiveTier {
  if (methods.some((m) => WRITE_FIRM.has(m))) return "firm";
  if (methods.some((m) => WRITE_UNCERTAIN.has(m))) return "uncertain-write";
  return "uncertain-read";
}

/**
 * The discovered tests at risk, in an exposed codeunit of a test app that installs the mock (the caller checks the mock). A test
 * the model cannot find is not at risk (the TestPage scan names those).
 */
export function restrictiveDefaultAtRisk(
  model: TestAppModel,
  tests: readonly TestMethodRef[],
): RestrictiveAtRisk[] {
  const out: RestrictiveAtRisk[] = [];
  for (const t of tests) {
    // `model.units` holds codeunits only (other objects are `model.objects`)
    for (const unit of model.units.filter((u) => u.id === t.codeunitId)) {
      if (!isExposed(unit)) continue;
      const decl = unit.procs.find((p) => p.name === normalizeAlName(t.method) && p.params === 0);
      if (decl === undefined) continue;
      const ev: Event[] = [];
      walk(decl, unit, 0, new Set(), ev);
      const accesses = ev.flatMap((e) => (e.e === "access" ? [e.method] : []));
      const first = accesses[0];
      if (first !== undefined) {
        out.push({
          test: `${t.codeunitName}.${t.method}`,
          tier: tierOf(accesses),
          firstAccess: first,
        });
        break;
      }
    }
  }
  return out;
}
