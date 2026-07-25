import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationSpec,
  astSubtreeHash,
  findEnclosingProcedure,
} from "@lethal/engine";
import { compileSchemataForFile } from "./compile";
import { type TierResolver, dedupeSpecs } from "./dedup";
import { assignMutantIds } from "./ids";
import {
  type SelectorConfig,
  emitMutationSelector,
  emitRegisterInstall,
  emitRegisterUpgrade,
} from "./selector";

export const CONTROL_SELECTOR_FILENAME = "MutationSelector.Codeunit.al";
export const CONTROL_REGISTER_FILENAME = "MutationRegister.Codeunit.al";
export const CONTROL_UPGRADE_FILENAME = "MutationUpgrade.Codeunit.al";

export interface InstrumentedFile {
  readonly path: string;
  readonly source: string;
  readonly root: ALSyntaxNode;
  readonly specs: readonly MutationSpec[];
}

export interface WriteInput {
  readonly targetDir: string;
  readonly files: readonly InstrumentedFile[];
  readonly selectorIds: SelectorConfig;
  readonly artifactId: string;
  /** The target project's own app.json `id` — baked into the delegating selector and the
   *  register-install codeunit so the LethAL Control extension keys state on the full
   *  (targetAppId, artifactId, mutantId) tuple (Layer 5C-A). */
  readonly targetAppId: string;
  /** Tier of each registered operator, keyed by `MutationSpec.operatorName` — used to resolve
   *  Tier-2 narrowings of a Tier-1 operator that would otherwise emit a byte-identical mutant at
   *  the same site under two names (see `dedupeSpecs`). `MutationSpec` itself carries no tier
   *  (that's a property of `MutationOperator`), so the caller supplies this map. */
  readonly operatorTiers: ReadonlyMap<string, 1 | 2 | 3 | "custom">;
}

export interface MutantManifestEntry {
  readonly mutantId: string;
  readonly file: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startLine: number;
  readonly operatorName: string;
  readonly operatorVersion: string;
  readonly astHash: string;
  /**
   * The AL object KEYWORD this mutant's object was declared with, lowercased: `table`,
   * `codeunit`, `page`, `report`, `query`, `xmlport`, `enum`.
   *
   * Required, and deliberately not optional: BC object ids are unique PER TYPE, so
   * `codeunitId` alone does not identify an object — `table 50100 "Foo"` alongside
   * `codeunit 50100 "Foo Mgt."` is ordinary. Coverage lookup keys on the (type, id) pair
   * (`packages/runner/src/selection.ts`), and a manifest that cannot supply the type is
   * refused there rather than silently defaulted: defaulting merges two different objects'
   * coverage and turns a live mutation site into a false survivor.
   */
  readonly objectType: string;
  /** The object's id. Named `codeunitId` for history; it is the id of whatever
   *  `objectType` names, not necessarily a codeunit. */
  readonly codeunitId: number;
  readonly codeunitName: string;
  readonly procedureName: string;
  readonly triggerName?: string;
}

export interface MutantManifest {
  readonly selectorIds: SelectorConfig;
  readonly artifactId: string;
  readonly mutants: readonly MutantManifestEntry[];
}

function lineOfIndex(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/** Global, so `matchAll` can find EVERY object header in the file, not just the first. */
const OBJECT_HEADER =
  /^\s*(codeunit|table|page|report|query|xmlport|enum)\s+(\d+)\s+("([^"]+)"|(\w+))/gim;

/**
 * The declared object's kind, id and name. `type` is the matched AL keyword lowercased
 * (`table`, `codeunit`, ...) — a BC object id is unique only WITHIN a type, so every consumer
 * that identifies an object (coverage lookup above all) needs the pair, not the id alone.
 *
 * Exactly ONE object declaration per file is required, and a file with more THROWS. AL permits
 * several objects in one file (rare, but legal), and every layer downstream of here assumes one:
 *
 * - this function labels every mutant in the file with the FIRST header's `(type, id)`, so a
 *   mutant in the second object is looked up under the first object's coverage key — the wrong
 *   test set, hence a verdict that is silently wrong rather than merely imprecise (the exact
 *   failure the (type, id) pair key exists to prevent, see `MutantManifestEntry.objectType`);
 * - `injectMutationSelectorVar` (compile.ts) injects into `findFirst(codeunit) ?? findFirst
 *   (table)`, which for `page X` + `codeunit Y` in one file is the SECOND object, leaving the
 *   guards emitted into the first object with no declaration in scope: AL0118.
 *
 * Refusing the shape is the honest answer; producing verdicts we know can be wrong is not.
 */
function objectHeaderOf(
  source: string,
  filePath: string,
): { type: string; id: number; name: string } {
  // `matchAll` operates on an internal clone, so the shared `g` regex's `lastIndex` never carries
  // between calls (a plain `.exec` loop on OBJECT_HEADER would).
  const matches = [...source.matchAll(OBJECT_HEADER)];
  const first = matches[0];
  if (first === undefined) throw new Error(`${filePath}: file has no AL object header`);
  if (matches.length > 1) {
    const found = matches.map((m) => `${m[1]?.toLowerCase()} ${m[2]} ${m[4] ?? m[5] ?? ""}`);
    const why =
      "LethAL supports exactly one AL object per file. Every mutant in the file would be " +
      "attributed to the FIRST object's (objectType, objectId), so mutants in the others would " +
      "be coverage-matched against the wrong object's tests — wrong verdicts, silently — and " +
      "the selector var is injected into only one of the objects (AL0118 in the rest). Split " +
      "them into one file each.";
    throw new Error(
      `writeInstrumentedProject: cannot instrument ${filePath} — it declares ${matches.length} AL objects (${found.join("; ")}). ${why}`,
    );
  }
  const type = first[1];
  if (type === undefined) {
    // Unreachable while OBJECT_HEADER keeps group 1 — asserted rather than defaulted, because a
    // wrong/absent object type silently merges two objects' coverage (see MutantManifestEntry).
    throw new Error(`${filePath}: AL object header matched without an object keyword`);
  }
  return { type: type.toLowerCase(), id: Number(first[2]), name: first[4] ?? first[5] ?? "" };
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}

function procedureNameOf(spec: MutationSpec): string {
  const proc = findEnclosingProcedure(spec.before);
  if (proc === null) return "";
  const nameNode = proc.childForFieldName("name");
  return nameNode === null ? "" : stripQuotes(nameNode.text);
}

/**
 * Name of the enclosing `trigger_declaration`, or `undefined` outside one.
 *
 * Trigger bodies have no enclosing `procedure`, so `procedureNameOf` returns
 * `""` for them. That empty string becomes the coverage key `<objectId>::`,
 * which matches no coverage entry and silently classifies every trigger mutant
 * as no-coverage — no error, no failing test, just a tier that appears to have
 * nothing to run.
 */
function triggerNameOf(spec: MutationSpec): string | undefined {
  let current: ALSyntaxNode | null = spec.before;
  while (current !== null) {
    if (current.kind === ALNodeKind.trigger) {
      const nameNode = current.childForFieldName("name");
      return nameNode === null ? undefined : stripQuotes(nameNode.text);
    }
    current = current.parent;
  }
  return undefined;
}

export async function writeInstrumentedProject(input: WriteInput): Promise<void> {
  await mkdir(input.targetDir, { recursive: true });

  // Dedup runs BEFORE ids are assigned and BEFORE compilation: dropping a mutant only while
  // building the manifest would leave it compiled into the emitted dispatch chain holding an
  // assigned id — an unreported mutation that still exists in the artifact.
  const tierOf: TierResolver = (name) => input.operatorTiers.get(name);
  const specsByFile = new Map<string, readonly MutationSpec[]>();
  for (const f of input.files) specsByFile.set(f.path, dedupeSpecs(f.specs, tierOf));
  const idedByFile = assignMutantIds(specsByFile);

  const manifest: MutantManifestEntry[] = [];
  for (const f of input.files) {
    const ided = idedByFile.get(f.path) ?? [];
    const deduped = specsByFile.get(f.path) ?? [];
    // Read the header BEFORE instrumenting: both of its throws (no object, several objects) mean
    // this file can never be attributed correctly, and failing before the write keeps a refused
    // file from being left behind, half-instrumented, in the artifact dir.
    const header = objectHeaderOf(f.source, f.path);
    const compiled = compileSchemataForFile(f.source, f.root, deduped, ided, f.path);
    await writeFile(join(input.targetDir, basename(f.path)), compiled, "utf8");
    for (const { mutantId, spec } of ided) {
      const triggerName = triggerNameOf(spec);
      manifest.push({
        mutantId,
        file: f.path,
        startIndex: spec.before.startIndex,
        endIndex: spec.before.endIndex,
        startLine: lineOfIndex(f.source, spec.before.startIndex),
        operatorName: spec.operatorName,
        operatorVersion: spec.operatorVersion,
        astHash: astSubtreeHash(spec.before),
        objectType: header.type,
        codeunitId: header.id,
        codeunitName: header.name,
        procedureName: procedureNameOf(spec),
        ...(triggerName !== undefined ? { triggerName } : {}),
      });
    }
  }

  // The delegating selector (Active -> LC Control State.IsActive) and the register-install
  // codeunit (registers targetAppId -> artifactId on install). The in-target Mutation Active
  // table, Mutation Control codeunit, and MutationControl web-service XML are NO LONGER emitted —
  // the LethAL Control extension owns all of that now (Layer 5C-A Task 4). The freed controlId
  // becomes the register-install codeunit's object id.
  //
  // Task 8: the selector is the single source of the (targetAppId, artifactId) identity tuple —
  // emitRegisterInstall/emitRegisterUpgrade now read it off `Mutation Selector` at runtime
  // instead of taking it as args, so registration can never diverge from what `Active` uses.
  await writeFile(
    join(input.targetDir, CONTROL_SELECTOR_FILENAME),
    emitMutationSelector({
      ...input.selectorIds,
      artifactId: input.artifactId,
      targetAppId: input.targetAppId,
    }),
    "utf8",
  );
  await writeFile(
    join(input.targetDir, CONTROL_REGISTER_FILENAME),
    emitRegisterInstall({ objectId: input.selectorIds.controlId }),
    "utf8",
  );
  await writeFile(
    join(input.targetDir, CONTROL_UPGRADE_FILENAME),
    emitRegisterUpgrade({ objectId: input.selectorIds.tableId }),
    "utf8",
  );

  const manifestJson: MutantManifest = {
    selectorIds: input.selectorIds,
    artifactId: input.artifactId,
    mutants: manifest,
  };
  await writeFile(
    join(input.targetDir, "mutant-manifest.json"),
    `${JSON.stringify(manifestJson, null, 2)}\n`,
    "utf8",
  );
}
