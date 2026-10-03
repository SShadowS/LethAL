import { describe, expect, it } from "bun:test";
import { maskAlNonCode } from "../../src/ast/mask";

/**
 * R80: the one lexer that replaced two. These cases are the CONTRACT both callers depend on —
 * schemata's `stripAlComments` (mutant attribution) and the runner's `maskNonCode` (test
 * discovery) — and each one is here because getting it wrong silently loses work rather than
 * failing: a mis-lexed quote blanks the rest of a file, and a file with no visible header or no
 * visible `[Test]` is dropped, not reported.
 */
const attribution = { blankStringContents: false } as const;
const discovery = { blankStringContents: true } as const;

describe("maskAlNonCode", () => {
  describe("shared by both policies", () => {
    it("blanks line and block comments, preserving length and every newline", () => {
      const src = "a // gone\n/* also\ngone */ b";
      for (const opts of [attribution, discovery]) {
        const out = maskAlNonCode(src, opts);
        expect(out.length).toBe(src.length);
        expect(out.split("\n").length).toBe(src.split("\n").length);
        expect(out).not.toContain("gone");
        expect(out).toContain("a ");
        expect(out.trimEnd().endsWith("b")).toBe(true);
      }
    });

    it("does not let a comment marker inside a string open a comment", () => {
      // The failure this prevents is total: treating this `//` as a comment blanks the rest of
      // the file, and the object header below it disappears.
      const src = "Error('use // and /* here');\ncodeunit 51070 \"After\"\n{\n}\n";
      for (const opts of [attribution, discovery]) {
        expect(maskAlNonCode(src, opts)).toContain('codeunit 51070 "After"');
      }
    });

    it("steps over a quoted identifier containing a comment marker", () => {
      // Double quotes are AL's quoted IDENTIFIER, not a string: the name is code and must survive
      // under both policies, or `codeunit 79210 "First Suite"` loses its name.
      const src = 'Rec."Field // Odd" := 1;\n';
      for (const opts of [attribution, discovery]) {
        expect(maskAlNonCode(src, opts)).toBe(src);
      }
    });

    it("treats '' inside a string as an escaped quote, not a close-then-reopen", () => {
      // Mis-reading `''` ends the string early, so the `//` that follows opens a comment and eats
      // the rest of the LINE — including the closing `);`.
      //
      // An earlier version of this test asserted only that a `codeunit` header on the NEXT line
      // survived, and it passed with the escape branch deleted: the damage stops at the newline,
      // so the header was never at risk. The assertions below are on the damaged line itself.
      const src = "Error('don''t // stop');\n";

      // Nothing here is a comment — the `//` lives inside the string — so nothing is blanked.
      expect(maskAlNonCode(src, attribution)).toBe(src);

      // The literal goes, the call around it stays. Without the escape branch the trailing `);`
      // is swallowed by the bogus comment, which is what this pins.
      const masked = maskAlNonCode(src, discovery);
      expect(masked).not.toContain("stop");
      expect(masked.startsWith("Error(")).toBe(true);
      expect(masked.trimEnd().endsWith(");")).toBe(true);
      expect(masked.length).toBe(src.length);
    });

    it("lexes an ODD-quote line by the escape rule, not by pairing off quotes", () => {
      // Deleting the `''` escape branch leaves every case above GREEN, and that is a property of
      // AL rather than a weak test: on well-formed input `'don''t'` and `'don'` + `'t'` tile the
      // SAME span, so blanking cannot tell them apart. The branch can only change output on a line
      // with an odd number of quotes — which does not compile, and is therefore exactly the input
      // class the end-of-line rule above exists to serve.
      //
      // `x := 'a'';` — by the escape rule the `''` is one escaped quote, so the literal starting
      // at index 5 never closes on this line and is abandoned; scanning resumes and finds `'';` as
      // a two-character literal at 7..9. Pairing off quotes instead would blank 5..8 and leave the
      // quote at 8 standing. Asserted as an exact string because "roughly blanked" is what let the
      // deletion through in the first place.
      const src = "x := 'a'';\n";
      expect(maskAlNonCode(src, discovery)).toBe("x := 'a  ;\n");
      expect(maskAlNonCode(src, attribution)).toBe(src);
    });

    it("stops an unterminated quote at end of line instead of pairing it with a LATER line's", () => {
      // Neither shape compiles in AL, so a project LethAL can build cannot contain one. The rule
      // is for the project that does NOT compile: pairing an abandoned quote with the next one
      // further down swallows everything between them, blanking the file's own object header —
      // exactly the silent whole-file drop this masking exists to prevent (R79).
      //
      // The later quote is the whole point. An earlier version of this test omitted it and passed
      // with the rule deleted: with nothing to pair against, an unterminated quote is abandoned by
      // both rules and blanks nothing either way.
      for (const opener of ["'", '"']) {
        const src = `Error(${opener}unterminated\ncodeunit 51072 "After"\n{\n}\nMsg := 'later';\n`;
        for (const opts of [attribution, discovery]) {
          expect(maskAlNonCode(src, opts)).toContain('codeunit 51072 "After"');
        }
      }

      // The quoted-IDENTIFIER half needs its own shape. `"` is never blanked, only stepped over,
      // so pairing it across lines shows up not as lost text but as a real comment inside the
      // skipped span that never gets blanked — and a surviving `Subtype = Test;` or object header
      // in a comment is the other direction of the same R79 bug.
      const src = 'Rec."unterminated\n// this comment must still go\nx := "Field";\n';
      for (const opts of [attribution, discovery]) {
        expect(maskAlNonCode(src, opts)).not.toContain("must still go");
      }
    });

    it("preserves carriage returns inside blanked comments", () => {
      // Every consumer reads this text with `^`/`$`-anchored multiline regexes, so line structure
      // is part of the output contract. The pre-R80 schemata stripper turned `\r` into a space
      // inside comments; over 717 real .al files that was the ONLY behavioural difference the
      // shared lexer introduced, and it is pinned here rather than left to be rediscovered.
      const src = 'a // gone\r\ncodeunit 51073 "After"\r\n';
      for (const opts of [attribution, discovery]) {
        const out = maskAlNonCode(src, opts);
        expect(out.length).toBe(src.length);
        expect(out).toContain("\r\n");
        expect(out).not.toContain("gone");
      }
    });

    it("blanks an unterminated block comment through end of file, as the compiler does", () => {
      const src = 'codeunit 51074 "Before"\n/* never closed\nstill inside\n';
      for (const opts of [attribution, discovery]) {
        const out = maskAlNonCode(src, opts);
        expect(out).toContain('codeunit 51074 "Before"');
        expect(out).not.toContain("still inside");
      }
    });
  });

  describe("the policy the two callers deliberately differ on", () => {
    const src = "Msg := 'codeunit 50100 \"Sales Post\"';\n";

    it("attribution keeps string contents — schemata's `stripAlComments`", () => {
      expect(maskAlNonCode(src, attribution)).toBe(src);
    });

    it("discovery blanks them — R79's bug was prose of exactly this shape opening a section", () => {
      const out = maskAlNonCode(src, discovery);
      expect(out).not.toContain("Sales Post");
      expect(out).not.toContain("codeunit 50100");
      expect(out.length).toBe(src.length);
      // The quotes go too, not just the contents: a lone surviving quote would re-open the state
      // machine on the next literal.
      expect(out).toContain("Msg := ");
      expect(out.trimEnd().endsWith(";")).toBe(true);
    });
  });

  // R418: every offset the mask reads and every offset its callers map back to the source is a
  // UTF-16 unit (tree-sitter's offsets, halved by the native addon, are UTF-16 too). A character
  // outside the Basic Multilingual Plane (an emoji) is TWO units, so the output must keep both
  // places: blanked, a surrogate pair becomes two spaces; kept, it stays intact.
  describe("R418: offsets are UTF-16 units", () => {
    const policies = [
      ["attribution", attribution],
      ["discovery", discovery],
    ] as const;

    it("keeps the input length under both policies when the text holds a non-BMP character", () => {
      const inputs = [
        "x := '😀'; // note\nnext\n",
        "// 😀😀\n/* a */ codeunit 5 Foo\n",
        "x := '😀abc';\nnext\n",
        "a /* 😀 */ b\n",
        "'😀'\n",
      ];
      for (const [name, opts] of policies) {
        for (const src of inputs) {
          const out = maskAlNonCode(src, opts);
          expect({ policy: name, src, length: out.length }).toEqual({
            policy: name,
            src,
            length: src.length,
          });
        }
      }
    });

    // These four cases came from lane-preproc's d129996d (R-403), which dropped its own mask test
    // so that R418 is the only change to `maskAlNonCode`. The first one (`æøå`, BMP non-ASCII) is
    // the CONTROL: it is green before the R418 fix too, because a BMP character is one UTF-16 unit
    // and one code point. The other three hold a non-BMP character and were red before it.
    for (const src of [
      "// æøå\nX",
      "// \u{1F600}\nX",
      "'\u{1F600}\u{1F600}' X",
      "/* \u{1F600} */ X",
    ]) {
      it(`keeps length and the offset of X for ${JSON.stringify(src)} (from R-403)`, () => {
        for (const [name, opts] of policies) {
          const out = maskAlNonCode(src, opts);
          expect({ policy: name, length: out.length, x: out.indexOf("X") }).toEqual({
            policy: name,
            length: src.length,
            x: src.indexOf("X"),
          });
        }
      });
    }

    it("an emoji in a string does not shift the blanking of a later comment", () => {
      const src = "x := '😀'; // note\nnext\n";
      expect(maskAlNonCode(src, attribution)).toBe(`x := '😀'; ${" ".repeat(7)}\nnext\n`);
      expect(maskAlNonCode(src, discovery)).toBe(`x := ${" ".repeat(4)}; ${" ".repeat(7)}\nnext\n`);
    });

    it("an emoji in a comment does not erase the object header after it", () => {
      const src = "// 😀😀\n/* a */ codeunit 5 Foo\n";
      const expected = `${" ".repeat(7)}\n${" ".repeat(7)} codeunit 5 Foo\n`;
      expect(maskAlNonCode(src, attribution)).toBe(expected);
      expect(maskAlNonCode(src, discovery)).toBe(expected);
    });

    it("a blanked string holding an emoji keeps the character after it", () => {
      const src = "x := '😀abc';\nnext\n";
      expect(maskAlNonCode(src, discovery)).toBe(`x := ${" ".repeat(7)};\nnext\n`);
      expect(maskAlNonCode(src, attribution)).toBe(src);
    });

    it("a blanked surrogate pair becomes two spaces; a kept one stays intact", () => {
      expect(maskAlNonCode("//😀\n", attribution)).toBe("    \n");
      expect(maskAlNonCode("//😀\n", discovery)).toBe("    \n");
      expect(maskAlNonCode("'😀'\n", attribution)).toBe("'😀'\n");
    });

    // A seeded property test (no dependency): mulberry32 is a 32-bit PRNG small enough to inline.
    // The oracle replaces each non-BMP character with `zz` (same UTF-16 length, plain ASCII) and
    // requires the same blanked positions. BMP behaviour is pinned by every test above, so the
    // all-BMP text is a sound reference for where the blanks belong.
    it("matches an all-BMP oracle on 2,000 seeded random strings", () => {
      const mulberry32 = (seed: number) => {
        let state = seed;
        return (): number => {
          state = (state + 0x6d2b79f5) | 0;
          let t = state;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      };
      const SEED = 418;
      const rand = mulberry32(SEED);
      const alphabet = ["/", "*", "'", '"', "\n", "\r", "a", " ", "é", "中", "😀", "𝄞"];
      const blankedPositions = (src: string, out: string): number[] => {
        const at: number[] = [];
        for (let k = 0; k < src.length; k++) if (out[k] === " " && src[k] !== " ") at.push(k);
        return at;
      };
      const failures: string[] = [];
      for (let n = 0; n < 2000 && failures.length < 5; n++) {
        const len = Math.floor(rand() * 61);
        let src = "";
        for (let c = 0; c < len; c++) src += alphabet[Math.floor(rand() * alphabet.length)];
        const bmp = src.replace(/[\u{10000}-\u{10FFFF}]/gu, "zz");
        for (const [name, opts] of policies) {
          const where = `seed ${SEED}, case ${n}, ${name}, input ${JSON.stringify(src)}`;
          const out = maskAlNonCode(src, opts);
          if (out.length !== src.length) {
            failures.push(`${where}: length ${out.length}, expected ${src.length}`);
            continue;
          }
          for (let k = 0; k < src.length; k++) {
            const o = out[k];
            const s = src[k];
            if (o !== s && o !== " ") failures.push(`${where}: index ${k} changed to ${o}`);
            if ((s === "\n" || s === "\r") && o !== s)
              failures.push(`${where}: newline lost at ${k}`);
            const code = o === undefined ? 0 : o.charCodeAt(0);
            if (code >= 0xd800 && code <= 0xdbff && out[k + 1] !== src[k + 1]) {
              failures.push(`${where}: half a surrogate pair at ${k}`);
            }
          }
          const expected = blankedPositions(bmp, maskAlNonCode(bmp, opts));
          const actual = blankedPositions(src, out);
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            failures.push(
              `${where}: blanked ${JSON.stringify(actual)}, oracle ${JSON.stringify(expected)}`,
            );
          }
        }
      }
      expect(failures).toEqual([]);
    });
  });
});
