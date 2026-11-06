/**
 * R847, Part 1: the pure parts of the check for an installed app that is NOT a dependent of the target.
 * Plan: docs/superpowers/specs/2026-11-06-r847-non-dependent-clash-plan.md. The orchestration (the
 * reads, the leads, the refusal) is in `object-clash.ts`; nothing here touches a server.
 *
 * BC refuses an upgrade whose target gives a second app's object or field the same identity, and when
 * it cannot restore, removes the target and its dependents. Installed apps are disjoint (BC refuses a
 * clashing pair at publish), so a clash must involve something NEW in the target. So this asks about
 * what is new, by key, and never lists (R433).
 */
import { OWNERS_MAX_ITEMS, type OwnersRead, UnfilteredExtensionsQueryError } from "./harness";
import type { PackageMember, SourceMember } from "./member-clash";
import type { DeclaredObject } from "./object-clash";

/** The one deadline for all the reads of one check, in ms. No retry. */
export const READ_BUDGET_MS = 10_000;

const keyOf = (o: { readonly kind: string; readonly id: number }): string => `${o.kind}:${o.id}`;

/** The objects the target has that the installed target's package does not: new by (kind, id), each
 *  once. With no `base` (none could be read) that is the whole set. */
export function newObjects(
  target: readonly DeclaredObject[],
  base: readonly DeclaredObject[] | undefined,
): DeclaredObject[] {
  const have = new Set((base ?? []).map(keyOf));
  const seen = new Set<string>();
  const out: DeclaredObject[] = [];
  for (const o of target) {
    const k = keyOf(o);
    if (have.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(o);
  }
  return out;
}

/** One base object for each kind in `items`, if the base has one: a known-installed control for that
 *  kind, whose owner must come back as the target. A kind with none is simply not in the result. */
export function controlObjects(
  items: readonly DeclaredObject[],
  base: readonly DeclaredObject[],
): DeclaredObject[] {
  const kinds = new Set(items.map((o) => o.kind));
  const out: DeclaredObject[] = [];
  for (const kind of kinds) {
    const control = base.find((o) => o.kind === kind);
    if (control !== undefined) out.push(control);
  }
  return out;
}

/** A field the target adds to a table it does not own, new by id or by name. */
export interface NewField {
  /** The table as the source writes it: a NAME, not yet an id. */
  readonly tableName: string;
  readonly id: number;
  readonly name: string;
  /** What is new: the (table, id) pair, the (table, name) pair, or both. */
  readonly byId: boolean;
  readonly byName: boolean;
}

/**
 * Fields of a tableextension on a table the target does not own, minus those the installed target's
 * package already holds. A target's OWN tables are skipped: a non-dependent cannot extend them (AL
 * needs a dependency), and Base has 29,441 own-table fields against 284 tableextension fields. A field
 * is new by id when no base field of that table has its id, and new by name likewise; one that is
 * neither is left out. Enum values are not read (the Field table does not hold them): see
 * `newEnumValues`.
 */
export function newTableFields(
  members: readonly SourceMember[],
  base: readonly PackageMember[] | undefined,
): NewField[] {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const b of base ?? []) {
    if (b.container !== "Table") continue;
    ids.add(`${b.ownerKey}:${b.id}`);
    names.add(`${b.ownerKey}:${b.name}`);
  }
  const out: NewField[] = [];
  const seen = new Set<string>();
  for (const m of members) {
    if (m.container !== "Table" || m.own) continue;
    const byId = !ids.has(`${m.ownerKey}:${m.id}`);
    const byName = !names.has(`${m.ownerKey}:${m.name}`);
    const k = `${m.ownerKey}:${m.id}:${m.name}`;
    if ((!byId && !byName) || seen.has(k)) continue;
    seen.add(k);
    out.push({ tableName: m.ownerName, id: m.id, name: m.name, byId, byName });
  }
  return out;
}

/** The values of an enumextension on an enum the target does not own, new by ordinal or by name. */
export interface NewEnumValues {
  readonly enumName: string;
  readonly count: number;
}

/**
 * New values (not in the installed target's package) of enumextensions on enums the target does not
 * own, counted by enum. The server has no table for them, so they cannot be asked: the caller WARNS
 * that they were not checked (R845 measured enum clashes as strips).
 */
export function newEnumValues(
  members: readonly SourceMember[],
  base: readonly PackageMember[] | undefined,
): NewEnumValues[] {
  const ords = new Set<string>();
  const names = new Set<string>();
  for (const b of base ?? []) {
    if (b.container !== "Enum") continue;
    ords.add(`${b.ownerKey}:${b.id}`);
    names.add(`${b.ownerKey}:${b.name}`);
  }
  const counts = new Map<string, NewEnumValues>();
  const seen = new Set<string>();
  for (const m of members) {
    if (m.container !== "Enum" || m.own) continue;
    if (ords.has(`${m.ownerKey}:${m.id}`) && names.has(`${m.ownerKey}:${m.name}`)) continue;
    const k = `${m.ownerKey}:${m.id}:${m.name}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const have = counts.get(m.ownerKey);
    counts.set(m.ownerKey, { enumName: m.ownerName, count: (have?.count ?? 0) + 1 });
  }
  return [...counts.values()];
}

/**
 * Reads `items` in calls of at most 200, in order, until all are read, the deadline has passed or a
 * call answers fewer rows than it was given. Each call gets the time left as the client's own
 * timeout, and a second less as the control app's `MaxMs`, so the AL loop stops first and a partial
 * `read` can arrive. Returns the rows read (the first `rows.length` items), how many items are
 * `unread`, and `error` when a call failed: the rows of the earlier calls are kept. Only
 * `UnfilteredExtensionsQueryError` is rethrown. A call that answers a row count other than its
 * `read` throws: the verifier has already refused that, so only a bad fake reaches here.
 */
export async function readInBatches<I, R>(
  items: readonly I[],
  call: (batch: readonly I[], maxMs: number, timeoutMs: number) => Promise<OwnersRead<R>>,
  clock: { readonly now: () => number; readonly deadlineMs: number },
): Promise<{ readonly rows: R[]; readonly unread: number; readonly error?: unknown }> {
  const rows: R[] = [];
  for (let at = 0; at < items.length; at += OWNERS_MAX_ITEMS) {
    const left = clock.deadlineMs - clock.now();
    if (left <= 0) break;
    const batch = items.slice(at, at + OWNERS_MAX_ITEMS);
    let got: OwnersRead<R>;
    try {
      got = await call(batch, Math.max(1, Math.floor(left) - 1000), left);
    } catch (error) {
      if (error instanceof UnfilteredExtensionsQueryError) throw error;
      return { rows, unread: items.length - rows.length, error };
    }
    if (got.rows.length !== got.read || got.read > batch.length) {
      throw new Error(
        `an owners read answered ${got.rows.length} row(s) and read=${got.read} for ${batch.length} item(s)`,
      );
    }
    rows.push(...got.rows);
    if (got.read < batch.length) break;
  }
  return { rows, unread: items.length - rows.length };
}
