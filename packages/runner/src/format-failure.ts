/**
 * R346: the one way a gate prints a failure. It always prints `name: message` read from the error
 * itself, and takes only the frame lines (`    at ...`) from `err.stack`.
 *
 * Why not `err.stack`: Bun builds the stack string on the first read, and if a garbage collection
 * runs between an async throw and that read, the header comes out as a bare `Error` with no message
 * (oven-sh/bun#34398, reproduced on Bun 1.3.14). A live gate collects plenty before its catch runs,
 * so `err.stack ?? err.message` can print a failure with its reason missing. `err.message` is never
 * affected, so the header is built from it.
 *
 * A non-Error throw is printed as a string, and never throws itself.
 *
 * The `err.cause` chain follows, one `Caused by: ...` line per link, because the old
 * `console.error(err)` printed it and a wrapped failure's real reason is often only there.
 */
export function formatFailure(err: unknown): string {
  if (!(err instanceof Error)) return safeString(err);
  const frames = (err.stack ?? "").split("\n").filter((line) => /^\s+at\s/.test(line));
  return [headerOf(err), ...frames, ...causeLines(err)].join("\n");
}

/**
 * At most this many `Caused by:` lines are printed, then one line saying the chain was cut. A real
 * chain is one or two deep; the bound stops a chain built by a getter from printing forever.
 */
const MAX_CAUSE_DEPTH = 8;

function headerOf(err: Error): string {
  return err.message === "" ? err.name : `${err.name}: ${err.message}`;
}

function causeLines(err: Error): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>([err]);
  try {
    let cause: unknown = err.cause;
    while (cause !== undefined) {
      if (seen.has(cause)) {
        out.push("Caused by: (cycle: this cause was already printed above)");
        break;
      }
      if (out.length === MAX_CAUSE_DEPTH) {
        out.push(`Caused by: (chain cut after ${MAX_CAUSE_DEPTH} causes)`);
        break;
      }
      seen.add(cause);
      out.push(`Caused by: ${cause instanceof Error ? headerOf(cause) : safeString(cause)}`);
      cause = cause instanceof Error ? cause.cause : undefined;
    }
  } catch {
    // A throwing `cause` getter must not lose the failure this module exists to print.
    out.push("Caused by: (unreadable)");
  }
  return out;
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    // `String(Object.create(null))` throws. Losing the failure because it cannot be printed is
    // the very thing this module exists to prevent.
    return Object.prototype.toString.call(value);
  }
}
