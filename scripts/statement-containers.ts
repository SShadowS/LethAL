#!/usr/bin/env bun
/**
 * R217: list every place the tree-sitter-al grammar can put a STATEMENT, so that a new one cannot
 * appear without somebody classifying it (`packages/engine/src/ast/tree-walks.ts`,
 * `STATEMENT_CONTAINER_CLASSES`; pinned by `packages/engine/tests/ast/statement-containers.test.ts`).
 *
 * Reads `src/node-types.json` of the EXACT crate cargo resolves (`cargo metadata` honours
 * CARGO_HOME) and writes `packages/engine/src/ast/statement-containers.json`.
 * `scripts/build-native-parser.ts` regenerates the list in memory and refuses when the committed
 * file differs. Run this after a grammar bump:
 *
 *   bun scripts/statement-containers.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cargoPackages } from "./check-native-grammar";

export const OUT = join(
  import.meta.dir,
  "..",
  "packages",
  "engine",
  "src",
  "ast",
  "statement-containers.json",
);

interface TypeRef {
  readonly type: string;
  readonly named: boolean;
}
interface Slot {
  readonly types: readonly TypeRef[];
}
interface NodeType {
  readonly type: string;
  readonly named: boolean;
  readonly fields?: Readonly<Record<string, Slot>>;
  readonly children?: Slot;
}

export interface Candidate {
  readonly container: string;
  readonly field: string;
}
export interface StatementContainers {
  readonly grammarVersion: string;
  readonly nodeTypesSha256: string;
  readonly candidates: readonly Candidate[];
}

/** Containers that hold statements but whose allowed types name no `*_statement` kind: the rule
 *  below cannot see them, so they are listed by name. `preproc_guarded_statement.children` carries
 *  only expression statements. NOT here: `preproc_split_call_statement.children` (call fragments). */
const NAMED_EXTRA: readonly Candidate[] = [
  { container: "preproc_guarded_statement", field: "children" },
];

const holdsStatement = (s: Slot): boolean =>
  s.types.some((t) => t.named && t.type.endsWith("_statement"));

/** Every `(container, field)` and `container.children` whose allowed types include a named
 *  `*_statement` kind, plus NAMED_EXTRA. Sorted, no duplicates. Pure. */
export function statementContainerCandidates(nodeTypes: readonly NodeType[]): Candidate[] {
  const keys = new Map<string, Candidate>();
  const add = (c: Candidate): void => void keys.set(`${c.container}.${c.field}`, c);
  for (const n of nodeTypes) {
    if (!n.named) continue;
    for (const [field, slot] of Object.entries(n.fields ?? {}))
      if (holdsStatement(slot)) add({ container: n.type, field });
    if (n.children !== undefined && holdsStatement(n.children))
      add({ container: n.type, field: "children" });
  }
  for (const c of NAMED_EXTRA) add(c);
  return [...keys.values()].sort((a, b) =>
    `${a.container}.${a.field}` < `${b.container}.${b.field}` ? -1 : 1,
  );
}

/** The list as the crate cargo resolves today. */
export function currentStatementContainers(): StatementContainers {
  const pkg = cargoPackages().find((p) => p.name === "tree-sitter-al");
  if (pkg === undefined) throw new Error("cargo metadata lists no tree-sitter-al package");
  const bytes = readFileSync(join(dirname(pkg.manifest_path), "src", "node-types.json"));
  return {
    grammarVersion: pkg.version,
    nodeTypesSha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    candidates: statementContainerCandidates(JSON.parse(bytes.toString("utf8")) as NodeType[]),
  };
}

export const serialize = (v: StatementContainers): string => `${JSON.stringify(v, null, 2)}\n`;

if (import.meta.main) {
  const v = currentStatementContainers();
  writeFileSync(OUT, serialize(v));
  console.log(`statement-containers: wrote ${v.candidates.length} candidates to ${OUT}`);
}
