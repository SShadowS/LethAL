/**
 * SemanticContext — composition root for Layer 1 semantic services.
 *
 * Ties together the symbol table, type table, and caller index produced by the
 * previous tasks, and exposes a memoized `cfgFor(procedure)` that builds a CFG
 * on first access and caches it keyed on the procedure symbol identity.
 *
 * Callers (analyses, operators) receive a single `SemanticContext` and ask it
 * the four canonical questions:
 *   - "What symbol is this?"            via `symbols`
 *   - "What type does this node have?"  via `types`
 *   - "Who calls this procedure?"       via `callers`
 *   - "What is the control flow here?"  via `cfgFor(procedure)`
 *
 * The CFG cache is a WeakMap so CFGs are released when their procedure symbol
 * becomes unreachable (e.g. on re-parse).
 */
import type { CFG } from "./cfg";
import { buildCFG } from "./cfg";
import type { CallerIndex } from "./callers";
import { buildCallerIndex } from "./callers";
import type { ProcedureSymbol, SourceFile, SymbolTable } from "./symbol-table";
import { buildSymbolTable } from "./symbol-table";
import type { TypeTable } from "./types";
import { buildTypeTable } from "./types";

export interface SemanticContext {
  readonly symbols: SymbolTable;
  readonly types: TypeTable;
  readonly callers: CallerIndex;
  cfgFor(procedure: ProcedureSymbol): CFG;
}

export function buildSemanticContext(
  files: readonly SourceFile[],
): SemanticContext {
  const symbols = buildSymbolTable(files);
  const types = buildTypeTable(files, symbols);
  const callers = buildCallerIndex(files, symbols);
  const cfgCache = new WeakMap<object, CFG>();
  return {
    symbols,
    types,
    callers,
    cfgFor(procedure) {
      const cached = cfgCache.get(procedure);
      if (cached !== undefined) return cached;
      const cfg = buildCFG(procedure.node);
      cfgCache.set(procedure, cfg);
      return cfg;
    },
  };
}
