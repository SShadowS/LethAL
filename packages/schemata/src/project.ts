import type { ALSyntaxNode, MutationSpec } from "@lethal/engine";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { compileSchemataForFile } from "./compile";
import { assignMutantIds } from "./ids";
import {
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
  readonly selectorObjectId: number;
}

export interface MutantManifestEntry {
  readonly mutantId: string;
  readonly file: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly operatorName: string;
  readonly operatorVersion: string;
}

export interface MutantManifest {
  readonly selectorObjectId: number;
  readonly mutants: readonly MutantManifestEntry[];
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
    for (const { mutantId, spec } of idedByFile.get(f.path) ?? []) {
      manifest.push({
        mutantId,
        file: f.path,
        startIndex: spec.before.startIndex,
        endIndex: spec.before.endIndex,
        operatorName: spec.operatorName,
        operatorVersion: spec.operatorVersion,
      });
    }
  }

  const selectorCfg = {
    selectorId: input.selectorObjectId,
    controlId: input.selectorObjectId + 1,
    tableId: input.selectorObjectId + 2,
  };
  await writeFile(
    join(input.targetDir, "MutationSelector.Codeunit.al"),
    emitMutationSelector(selectorCfg),
    "utf8",
  );
  await writeFile(
    join(input.targetDir, "MutationActive.Table.al"),
    emitMutationActiveTable(selectorCfg),
    "utf8",
  );
  await writeFile(
    join(input.targetDir, "MutationControl.Codeunit.al"),
    emitMutationControl(selectorCfg),
    "utf8",
  );
  await writeFile(
    join(input.targetDir, "webservices.xml"),
    emitWebServicesXml(selectorCfg),
    "utf8",
  );

  const manifestJson: MutantManifest = {
    selectorObjectId: input.selectorObjectId,
    mutants: manifest,
  };
  await writeFile(
    join(input.targetDir, "mutant-manifest.json"),
    `${JSON.stringify(manifestJson, null, 2)}\n`,
    "utf8",
  );
}
