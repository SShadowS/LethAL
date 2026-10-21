/**
 * R347: the member a report row belongs to, for grouping. A trigger row's `procedureName` is `""`,
 * not absent (R229's trap), so `procedureName ?? ""` put every trigger in a file in one group.
 * The trigger's own name decides instead.
 */
export function memberOf(m: {
  readonly procedureName?: string;
  readonly triggerName?: string;
}): string {
  return m.procedureName || m.triggerName || "";
}
