import {
  type ALSyntaxNode,
  type MutationSpec,
  astSubtreeHash,
  findEnclosingProcedure,
} from "@lethal/engine";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { compileSchemataForFile } from "./compile";
import { assignMutantIds } from "./ids";
import {
  type SelectorConfig,
  emitMutationSelector,
  emitMutationActiveTable,
  emitMutationControl,
  emitWebServicesXml,
} from "./selector";

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
  readonly codeunitId: number;
  readonly codeunitName: string;
  readonly procedureName: string;
}

export interface MutantManifest {
  readonly selectorIds: SelectorConfig;
  readonly mutants: readonly MutantManifestEntry[];
}

function lineOfIndex(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

const OBJECT_HEADER =
  /^\s*(codeunit|table|page|report|query|xmlport|enum)\s+(\d+)\s+("([^"]+)"|(\w+))/im;

function objectHeaderOf(source: string): { id: number; name: string } {
  const m = OBJECT_HEADER.exec(source);
  if (!m) throw new Error("instrumented file has no AL object header");
  return { id: Number(m[2]), name: m[4] ?? m[5] ?? "" };
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

export async function writeInstrumentedProject(input: WriteInput): Promise<void> {
  await mkdir(input.targetDir, { recursive: true });

  const specsByFile = new Map<string, readonly MutationSpec[]>();
  for (const f of input.files) specsByFile.set(f.path, f.specs);
  const idedByFile = assignMutantIds(specsByFile);

  const manifest: MutantManifestEntry[] = [];
  for (const f of input.files) {
    const compiled = compileSchemataForFile(f.source, f.root, f.specs);
    await writeFile(join(input.targetDir, basename(f.path)), compiled, "utf8");
    const header = objectHeaderOf(f.source);
    for (const { mutantId, spec } of idedByFile.get(f.path) ?? []) {
      manifest.push({
        mutantId,
        file: f.path,
        startIndex: spec.before.startIndex,
        endIndex: spec.before.endIndex,
        startLine: lineOfIndex(f.source, spec.before.startIndex),
        operatorName: spec.operatorName,
        operatorVersion: spec.operatorVersion,
        astHash: astSubtreeHash(spec.before),
        codeunitId: header.id,
        codeunitName: header.name,
        procedureName: procedureNameOf(spec),
      });
    }
  }

  await writeFile(
    join(input.targetDir, "MutationSelector.Codeunit.al"),
    emitMutationSelector(input.selectorIds),
    "utf8",
  );
  await writeFile(
    join(input.targetDir, "MutationActive.Table.al"),
    emitMutationActiveTable(input.selectorIds),
    "utf8",
  );
  await writeFile(
    join(input.targetDir, "MutationControl.Codeunit.al"),
    emitMutationControl(input.selectorIds),
    "utf8",
  );
  await writeFile(
    join(input.targetDir, "webservices.xml"),
    emitWebServicesXml(input.selectorIds),
    "utf8",
  );

  const manifestJson: MutantManifest = {
    selectorIds: input.selectorIds,
    mutants: manifest,
  };
  await writeFile(
    join(input.targetDir, "mutant-manifest.json"),
    `${JSON.stringify(manifestJson, null, 2)}\n`,
    "utf8",
  );
}
