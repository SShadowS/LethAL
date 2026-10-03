/**
 * Blank out everything the AL compiler does not read as code — comments, and optionally the
 * contents of string literals — preserving every offset, so any index into the result is also an
 * index into the original.
 *
 * ONE implementation, because there were two (R80). `stripAlComments` (schemata) and
 * `maskNonCode` (runner, R79) were written three weeks apart, in the same codebase, for the same
 * class of bug — prose parsed as a declaration — without either knowing about the other, and they
 * disagreed about string literals. Nothing misbehaved, but the next person to hit this class would
 * have written a third one.
 *
 * The two callers keep their DIFFERENT policies, because the difference is real and each is right
 * for its own consumer:
 *
 *   - **Test discovery** (`blankStringContents: true`) must blank string CONTENTS: a literal
 *     `'codeunit 50100 "Sales Post"'` has the same shape as a header, and R79 measured it opening
 *     a bogus section that swallowed every `[Test]` after it — silently, as `no-coverage`.
 *   - **Mutant attribution** (`blankStringContents: false`) does not, and must not change its mind
 *     casually: `objectHeadersOf` decides which object a mutant belongs to. Measured over 717 real
 *     `.al` files (Continia Document Output's Cloud + Test, every fixture, and the control app),
 *     the two policies produce IDENTICAL object-header sets — so the flag is a documented
 *     difference rather than a live disagreement, and either policy would attribute the same way
 *     today.
 *
 * Both policies share the lexing that is genuinely common, and that is the point: a future fix to
 * quote handling lands in one place instead of drifting between two.
 */

export interface AlMaskOptions {
  /**
   * Blank the contents of single-quoted string literals (and their quotes) as well as comments.
   *
   * `false` steps over a string intact — which is NOT the same as ignoring quotes. Strings are
   * tracked either way, because AL text may legally contain `//` or `/*` (`Error('use // here')`)
   * and a stripper blind to them would blank the rest of the file and report "no AL object header"
   * on a perfectly valid one.
   */
  readonly blankStringContents: boolean;
}

/**
 * DOUBLE quotes are AL's QUOTED IDENTIFIER, not a string — `codeunit 79210 "First Suite"` needs
 * its name — so they are stepped over intact under both policies, never blanked.
 *
 * Unterminated `'` and `"` stop at end of line rather than running to EOF. Neither compiles in AL,
 * so a project LethAL can actually build cannot contain one; the rule matters for the project that
 * does NOT compile, where running a quote to EOF would blank the remainder of the file and
 * recreate exactly the silent whole-file drop this masking exists to prevent (R79). An
 * unterminated block comment still runs to EOF, because that IS what the AL compiler does with it.
 */
export function maskAlNonCode(source: string, options: AlMaskOptions): string {
  const out = Array.from(source);
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) {
      const ch = out[k];
      // Newlines survive so line numbers, and the `^`/`$` anchors of every multiline regex reading
      // this text, keep addressing the same lines they did in the original.
      if (ch !== "\n" && ch !== "\r") out[k] = " ";
    }
  };
  const endOfLine = (from: number): number => {
    const nl = source.indexOf("\n", from);
    return nl === -1 ? source.length : nl;
  };

  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (c === "/" && next === "/") {
      const end = endOfLine(i);
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close === -1 ? source.length : close + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "'") {
      const lineEnd = endOfLine(i);
      let j = i + 1;
      let closed = false;
      while (j < lineEnd) {
        if (source[j] === "'") {
          // `''` inside a string is AL's escaped quote, not a close followed by an open.
          if (source[j + 1] === "'") {
            j += 2;
            continue;
          }
          j += 1;
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) {
        i += 1;
        continue;
      }
      if (options.blankStringContents) blank(i, j);
      i = j;
      continue;
    }
    if (c === '"') {
      const lineEnd = endOfLine(i);
      const close = source.indexOf('"', i + 1);
      i = close === -1 || close >= lineEnd ? i + 1 : close + 1;
      continue;
    }
    i += 1;
  }
  return out.join("");
}
