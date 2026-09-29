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
 */
export function formatFailure(err: unknown): string {
  if (!(err instanceof Error)) return safeString(err);
  const header = err.message === "" ? err.name : `${err.name}: ${err.message}`;
  const frames = (err.stack ?? "").split("\n").filter((line) => /^\s+at\s/.test(line));
  return [header, ...frames].join("\n");
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
