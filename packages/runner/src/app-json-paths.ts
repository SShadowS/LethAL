import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * R-422 / R-913: one replacement made in an app.json path. `field` is `logo`, `screenshots[<i>]`
 * or `resourceFolders[<i>]`. `kind` is `backslash` (R-422: `\` -> `/`) or `case` (R-913: the
 * letter case of a name, rewritten to the spelling on disk).
 */
export type AppJsonPathChange = {
  readonly field: string;
  readonly from: string;
  readonly to: string;
  readonly kind: "backslash" | "case";
};

/**
 * R-422: the app.json array fields that name files or folders, from the alc schema (`logo` is the
 * one string field). The Linux `alc` reads a `\` there as part of the name and stops with AL1001
 * (a file) or AL0863 (a folder) before compiling a line. Everything else (URLs, names, text, ids)
 * is left exactly as written.
 */
const APP_JSON_PATH_ARRAY_FIELDS = ["screenshots", "resourceFolders"] as const;

/**
 * R-913: a resolver maps a `/` path to the spelling on disk, or `undefined` when it has nothing to
 * say (the path exists as written, nothing matches, or more than one entry matches).
 */
export type CaseResolver = (path: string) => string | undefined;

/**
 * R-913: the real resolver for the directory an app.json sits in. Windows' alc ignores letter
 * case; the Linux alc does not (`"logo": "ExtensionLogo.png"` beside `extensionlogo.png` stops it
 * with AL1001). Walks the path one segment at a time: an exact entry wins; else exactly one
 * case-insensitive match is used; else the whole path is left alone.
 */
export function diskCaseResolver(dir: string): CaseResolver {
  return (path) => {
    let cur = dir;
    const out: string[] = [];
    for (const seg of path.split("/")) {
      if (seg === "" || seg === "." || seg === "..") {
        out.push(seg);
        cur = join(cur, seg);
        continue;
      }
      let names: string[];
      try {
        names = readdirSync(cur);
      } catch {
        return undefined;
      }
      let hit: string | undefined = names.includes(seg) ? seg : undefined;
      if (hit === undefined) {
        const lower = seg.toLowerCase();
        const matches = names.filter((n) => n.toLowerCase() === lower);
        if (matches.length !== 1) return undefined;
        hit = matches[0];
      }
      if (hit === undefined) return undefined;
      out.push(hit);
      cur = join(cur, hit);
    }
    const fixed = out.join("/");
    return fixed === path ? undefined : fixed;
  };
}

/**
 * R-422: returns a copy of the manifest with `/` in place of `\` in `logo`, each string element of
 * `screenshots` and each string element of `resourceFolders`, plus what changed. Never mutates the
 * input. A missing field, a non-string value and a non-string element are kept as they are.
 * R-913: with `resolveCase`, a path that then still differs from the spelling on disk is rewritten
 * to that spelling, as a second change.
 */
export function normaliseAppJsonPaths(
  manifest: Readonly<Record<string, unknown>>,
  resolveCase?: CaseResolver,
): {
  readonly manifest: Record<string, unknown>;
  readonly changes: readonly AppJsonPathChange[];
} {
  const changes: AppJsonPathChange[] = [];
  const out: Record<string, unknown> = { ...manifest };
  const fix = (field: string, value: string): string => {
    const slashed = value.replaceAll("\\", "/");
    if (slashed !== value) changes.push({ field, from: value, to: slashed, kind: "backslash" });
    const cased = resolveCase?.(slashed);
    if (cased === undefined || cased === slashed) return slashed;
    changes.push({ field, from: slashed, to: cased, kind: "case" });
    return cased;
  };
  const { logo } = manifest;
  if (typeof logo === "string") out.logo = fix("logo", logo);
  for (const key of APP_JSON_PATH_ARRAY_FIELDS) {
    const value = manifest[key];
    if (Array.isArray(value)) {
      out[key] = value.map((el: unknown, i: number) =>
        typeof el === "string" ? fix(`${key}[${i}]`, el) : el,
      );
    }
  }
  return { manifest: out, changes };
}

/** R-913: the sentence about letter-case changes, or "" when there were none. */
export function caseChangeText(changes: readonly AppJsonPathChange[]): string {
  const cased = changes.filter((c) => c.kind === "case");
  if (cased.length === 0) return "";
  const parts = cased.map((c) => `${c.field} "${c.from}" -> "${c.to}"`).join("; ");
  return `app.json names a file or folder in different letter case than the one on disk: ${parts}. LethAL wrote the on-disk spelling in the app.json it compiles, because the Linux alc reads names case-sensitively and fails with AL1001 or AL0863. Your project's own app.json was not changed; write the on-disk spelling there to remove this warning.`;
}
