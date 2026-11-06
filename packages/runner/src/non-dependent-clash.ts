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
import { OWNERS_MAX_ITEMS, type OwnersRead } from "./harness";
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
 * neither is left out. Enum values are not read (the Field table does not hold them).
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

/**
 * Reads `items` in calls of at most 200, in order, until all are read, the deadline has passed or a
 * call answers fewer rows than it was given. Each call gets the time left as both the control app's
 * `MaxMs` and the client's own timeout. Returns the rows read (the first `rows.length` items) and how
 * many items are `unread`. A call that answers a row count other than its `read` throws: the
 * verifier has already refused that, so only a bad fake reaches here.
 */
export async function readInBatches<I, R>(
  items: readonly I[],
  call: (batch: readonly I[], maxMs: number, timeoutMs: number) => Promise<OwnersRead<R>>,
  clock: { readonly now: () => number; readonly deadlineMs: number },
): Promise<{ readonly rows: R[]; readonly unread: number }> {
  const rows: R[] = [];
  while (rows.length < items.length) {
    const left = clock.deadlineMs - clock.now();
    if (left <= 0) break;
    const batch = items.slice(rows.length, rows.length + OWNERS_MAX_ITEMS);
    const got = await call(batch, Math.max(1, Math.floor(left)), left);
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
