import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignMutantIds, compileSchemataForFile, dedupeSpecs } from "@lethal/schemata";
import type { CompiledArtifact } from "../../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../../src/backend";
import { MAX_GUARDS_PER_METHOD, largestMethodGuards } from "../../src/large-fold";
import { generateMutationSet, operatorTiers, runSession } from "../../src/orchestrator";
import type { SessionConfig } from "../../src/orchestrator";
import type { SessionReport } from "../../src/report";
import { ResultsStore } from "../../src/store";

/** PR-461: shared by the three `pr461-method-guards*.test.ts` files (split to keep each well under VERIFY's 180 s). */

export const tierOf = (n: string) => operatorTiers.get(n);

/** One codeunit, one procedure per entry of `methods`, each `n` flat `Z := Z + i;` lines (no loop: R164). */
export function writeProject(methods: readonly number[]): string {
  const dir = mkdtempSync(join(tmpdir(), "pr461-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "app.json"),
    JSON.stringify({
      id: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
      name: "P",
      publisher: "x",
      version: "1.0.0.0",
      runtime: "17.0",
      application: "28.0.0.0",
      idRanges: [{ from: 50000, to: 50099 }],
    }),
  );
  const procs = methods.map((n, m) => {
    const body = Array.from({ length: n }, (_, i) => `        Z := Z + ${i + 1};`).join("\n");
    return `    procedure Work${m}()\n    var\n        Z: Integer;\n    begin\n${body}\n    end;\n`;
  });
  writeFileSync(join(dir, "src", "P.Codeunit.al"), `codeunit 50000 "P"\n{\n${procs.join("\n")}}\n`);
  return dir;
}

export function writeTests(): string {
  const testDir = mkdtempSync(join(tmpdir(), "pr461-tests-"));
  writeFileSync(
    join(testDir, "T.Codeunit.al"),
    'codeunit 50050 "T"\n{\n    Subtype = Test;\n\n    [Test]\n    procedure T1()\n    begin\n    end;\n}\n',
  );
  return testDir;
}

export async function fileOf(methods: readonly number[]) {
  const set = await generateMutationSet(writeProject(methods), { emit: () => {} } as never);
  const [f] = set.files;
  if (f === undefined) throw new Error("no file");
  return f;
}

/**
 * The most `.Active('` calls between two method headers of the real emitted text (any header form, as
 * `largestMethodBytes` reads them). Throws when a guard sits before the first header (uncounted).
 */
export function textGuards(f: Awaited<ReturnType<typeof fileOf>>): number {
  const deduped = dedupeSpecs(f.specs, tierOf);
  const ided = assignMutantIds(new Map([[f.path, deduped]])).get(f.path) ?? [];
  const text = compileSchemataForFile(f.source, f.root, deduped, ided, f.path);
  const starts = [
    ...text.matchAll(
      /^(?:[ \t]*\[[^\n]*\][ \t]*\r?\n)*[ \t]*(?:local |internal |protected )?(?:procedure|trigger) /gim,
    ),
  ].map((m) => m.index ?? 0);
  starts.push(text.length);
  if (text.slice(0, starts[0] ?? 0).includes(".Active('")) {
    throw new Error(`${f.path}: a guard sits before the first method header`);
  }
  let max = 0;
  for (let i = 0; i + 1 < starts.length; i += 1) {
    const span = text.slice(starts[i] ?? 0, starts[i + 1] ?? 0);
    max = Math.max(max, span.split(".Active('").length - 1);
  }
  return max;
}

/** The fewest statements that put one method over MAX_GUARDS_PER_METHOD, read through the real plan. */
export async function statementsOverLimit(): Promise<number> {
  const f = await fileOf([100]);
  let n = Math.floor((MAX_GUARDS_PER_METHOD / dedupeSpecs(f.specs, tierOf).length) * 100);
  while ((largestMethodGuards(await fileOf([n]), tierOf, 0)?.guards ?? 0) <= MAX_GUARDS_PER_METHOD)
    n += 1;
  return n;
}

export class StubBackend implements ExecutionBackend {
  deploys = 0;
  constructor(
    private readonly kind: "bcdev" | "al-runner-v3",
    /** Every test covers `Work0`, so its mutants are scored (and survive) rather than no-coverage. */
    private readonly covers = false,
  ) {}
  async runnerBuild(): Promise<{ version: string; binarySha256: string }> {
    return { version: "alrunner 3.0.0-alpha.2 (91253f2d6)", binarySha256: "b".repeat(64) };
  }
  capabilities(): BackendCapabilities {
    return {
      coverage: "procedure",
      deploy: "publish",
      isolation: "session",
      kind: this.kind,
      authoritative: this.kind === "bcdev",
    };
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(): Promise<CompiledArtifact | null> {
    this.deploys += 1;
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(): Promise<void> {}
  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    if (!this.covers) return { ref, outcome: "pass", durationMs: 5 };
    return {
      ref,
      outcome: "pass",
      durationMs: 5,
      coverage: {
        granularity: "procedure" as const,
        entries: [{ objectType: "Codeunit", objectId: 50000, procedure: "Work0" }],
      },
      ...(opts.coverage === "none"
        ? { attestation: { observedAny: true, identityMismatch: false } }
        : {}),
    };
  }
}

/** A session on a stub backend: what it threw (if anything), its report and how many deploys it made. */
export async function session(
  methods: readonly number[] | { readonly projectDir: string; readonly testDir: string },
  kind: "bcdev" | "al-runner-v3",
  extra: Partial<SessionConfig> = {},
  covers = false,
) {
  const { projectDir, testDir } =
    "projectDir" in methods
      ? methods
      : { projectDir: writeProject(methods), testDir: writeTests() };
  const backend = new StubBackend(kind, covers);
  const store = new ResultsStore(":memory:");
  let thrown: unknown;
  let report: SessionReport | undefined;
  try {
    report = await runSession({
      backend,
      store,
      projectDir,
      testDir,
      instrumentedDir: join(mkdtempSync(join(tmpdir(), "pr461-i-")), "instr"),
      selectorIds: { selectorId: 50090, controlId: 50091, tableId: 50092 },
      allowLargeRun: true,
      emit: [() => {}],
      ...extra,
    });
  } catch (e) {
    thrown = e;
  } finally {
    store.close();
  }
  return { thrown, report, deploys: backend.deploys };
}
