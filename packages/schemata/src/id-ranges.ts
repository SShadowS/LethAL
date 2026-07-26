import type { SelectorConfig } from "./selector";

/**
 * One entry of app.json's `idRanges` array — the id band(s) the real `alc.exe` accepts an object
 * id from (AL0297). A target app may declare several, possibly non-contiguous, ranges.
 */
export interface AppIdRange {
  readonly from: number;
  readonly to: number;
}

/**
 * An AL object already declared somewhere in the target project, identified by its (type, id)
 * pair — see `MutantManifestEntry.objectType`'s doc comment in `project.ts` for why an id alone
 * never identifies an AL object (ids are unique only within a type).
 */
export interface DeclaredObject {
  readonly type: string;
  readonly id: number;
  readonly name: string;
}

/**
 * Parses app.json's `idRanges` array into typed `{from, to}` pairs. Throws loudly on a
 * missing/empty/malformed array — the real `alc.exe` requires every compiled object's id to fall
 * in a declared range (AL0297), so a target with none is already structurally uncompilable, and
 * `validateSelectorIds` below has nothing to check ids against without it.
 */
export function parseIdRanges(appManifest: Readonly<Record<string, unknown>>): AppIdRange[] {
  const raw = appManifest.idRanges;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `target app.json has no non-empty "idRanges" array (got ${JSON.stringify(raw)}) — required to validate the injected Mutation Selector/Register/Upgrade object ids before compiling`,
    );
  }
  return raw.map((entry, i) => {
    const record =
      entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const { from, to } = record;
    if (typeof from !== "number" || typeof to !== "number") {
      throw new Error(
        `target app.json idRanges[${i}] is malformed (expected {"from": number, "to": number}), got ${JSON.stringify(entry)}`,
      );
    }
    if (from > to) {
      throw new Error(
        `target app.json idRanges[${i}] has "from" (${from}) greater than "to" (${to})`,
      );
    }
    return { from, to };
  });
}

function idInRanges(id: number, ranges: readonly AppIdRange[]): boolean {
  return ranges.some((r) => id >= r.from && id <= r.to);
}

function rangesText(ranges: readonly AppIdRange[]): string {
  return ranges.length === 0 ? "(none)" : ranges.map((r) => `${r.from}-${r.to}`).join(", ");
}

/** Field-by-field description of the three ids `SelectorConfig` carries — used to build error
 *  messages that name exactly which id is at fault and what AL object it becomes. */
const SELECTOR_FIELDS: ReadonlyArray<{ key: keyof SelectorConfig; label: string }> = [
  { key: "selectorId", label: 'selectorId (the "Mutation Selector" codeunit)' },
  { key: "controlId", label: 'controlId (the "Mutation Register" install codeunit)' },
  { key: "tableId", label: 'tableId (the "Mutation Upgrade" codeunit)' },
];

/**
 * Validates the three injected object ids before anything is ever compiled (R3/R4). The real
 * `alc.exe` enforces app.json's `idRanges` for every object it compiles, including the injected
 * Mutation Selector/Register/Upgrade codeunits (AL0297) — verified against a real BC server
 * 2026-07-18 (see `cli.ts`'s `DEFAULT_SELECTOR_IDS` doc comment). An id outside every declared
 * range is therefore a deterministic compile failure; failing here first turns a multi-minute
 * round trip through a live BC server into an instant, actionable error naming both the offending
 * id and the ranges it needed to fall inside.
 *
 * Also refuses, just as loudly:
 *  - two (or three) of the three ids being equal to each other — `alc` would then be asked to
 *    declare two AL objects under the same id, a guaranteed compile failure of its own;
 *  - a selector id equal to the id of an object the target project ALREADY declares. Checked only
 *    against `existingObjects` entries of type `"codeunit"` — all three injected objects are
 *    codeunits (see `emitMutationSelector`/`emitRegisterInstall`/`emitRegisterUpgrade` in
 *    `selector.ts`), and a BC object id is unique only within its own type, so a same-id table or
 *    page is not a real collision. Callers are expected to pre-filter `existingObjects` to
 *    codeunit entries only (see `scanDeclaredObjects` in `project.ts`); an empty/omitted map
 *    simply skips this check, matching a caller with nothing to compare against.
 */
export function validateSelectorIds(
  selectorIds: SelectorConfig,
  idRanges: readonly AppIdRange[],
  existingObjects: ReadonlyMap<number, DeclaredObject> = new Map(),
): void {
  for (const { key, label } of SELECTOR_FIELDS) {
    const id = selectorIds[key];
    if (!idInRanges(id, idRanges)) {
      throw new Error(
        `selector id out of range: ${label} = ${id} falls outside every idRange the target app.json declares (${rangesText(idRanges)}). Choose a different --selector-id/--control-id/--table-id (or lethal.config.json's "selectorIds" section) value inside one of those ranges, or widen the target app.json's idRanges.`,
      );
    }
  }

  const labelById = new Map<number, string>();
  for (const { key, label } of SELECTOR_FIELDS) {
    const id = selectorIds[key];
    const priorLabel = labelById.get(id);
    if (priorLabel !== undefined) {
      throw new Error(
        `selector ids collide: ${priorLabel} and ${label} are both ${id} — selectorId, controlId, and tableId must be pairwise distinct (each becomes its own AL object).`,
      );
    }
    labelById.set(id, label);
  }

  for (const { key, label } of SELECTOR_FIELDS) {
    const id = selectorIds[key];
    const existing = existingObjects.get(id);
    if (existing !== undefined) {
      throw new Error(
        `selector id collides with an existing object: ${label} = ${id} is already declared as ` +
          `codeunit ${id} "${existing.name}" in the target project. Choose a different id.`,
      );
    }
  }
}
