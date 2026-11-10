/**
 * R901: a `controladdin` names its files with backslashes (`Scripts = 'Res\Js\a.js';`). alc on
 * Linux reads each string as ONE file name and fails with AL0327. A batch project is LethAL's own
 * scratch copy, so its text is rewritten to `/` (alc on Windows accepts `/` too). Same length, so
 * no line or column moves. Only the strings of these properties, inside a `controladdin { }`
 * block, change; every other string and every comment is left alone.
 */
const RESOURCE_PROPERTIES = new Set([
  "scripts",
  "startupscript",
  "recreatescript",
  "refreshscript",
  "stylesheets",
  "images",
]);

export function rewriteControlAddInPaths(text: string): string {
  if (!/controladdin/i.test(text)) return text;
  const out = text.split("");
  const n = text.length;
  let i = 0;
  let pendingAddIn = false;
  let depth = 0; // brace depth inside the current controladdin block; 0 = outside one

  while (i < n) {
    const c = text.charAt(i);
    const next = text.charAt(i + 1);
    if (c === "/" && next === "/") {
      while (i < n && text.charAt(i) !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === "'") {
      i = skipString(text, i, false, out);
    } else if (c === '"') {
      i = skipQuoted(text, i);
    } else if (c === "{") {
      if (depth > 0) depth++;
      else if (pendingAddIn) {
        depth = 1;
        pendingAddIn = false;
      }
      i++;
    } else if (c === "}") {
      if (depth > 0) depth--;
      i++;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(text.charAt(j))) j++;
      const word = text.slice(i, j).toLowerCase();
      i = j;
      if (depth === 0 && word === "controladdin") pendingAddIn = true;
      else if (depth > 0 && RESOURCE_PROPERTIES.has(word)) {
        let k = i;
        while (k < n && /\s/.test(text.charAt(k))) k++;
        if (text.charAt(k) !== "=") continue;
        i = k + 1;
        // The property statement, up to its `;`.
        while (i < n && text.charAt(i) !== ";") {
          const d = text.charAt(i);
          if (d === "'") i = skipString(text, i, true, out);
          else if (d === "/" && text.charAt(i + 1) === "/") {
            while (i < n && text.charAt(i) !== "\n") i++;
          } else if (d === "/" && text.charAt(i + 1) === "*") {
            const end = text.indexOf("*/", i + 2);
            i = end < 0 ? n : end + 2;
          } else i++;
        }
      }
    } else i++;
  }
  return out.join("");
}

/** Past the `'...'` literal at `start` (`''` is an escaped quote); with `rewrite`, `\` becomes `/` in `out`. */
function skipString(text: string, start: number, rewrite: boolean, out: string[]): number {
  let i = start + 1;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === "'") {
      if (text.charAt(i + 1) === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    if (rewrite && c === "\\") out[i] = "/";
    i++;
  }
  return i;
}

/** Past the `"..."` quoted identifier at `start`. */
function skipQuoted(text: string, start: number): number {
  const end = text.indexOf('"', start + 1);
  return end < 0 ? text.length : end + 1;
}
