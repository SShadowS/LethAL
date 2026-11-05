/** R-422: one `\` -> `/` replacement made in an app.json. `field` is `logo`, `screenshots[<i>]` or `resourceFolders[<i>]`. */
export type AppJsonPathChange = {
  readonly field: string;
  readonly from: string;
  readonly to: string;
};

/**
 * R-422: the app.json array fields that name files or folders, from the alc schema (`logo` is the
 * one string field). The Linux `alc` reads a `\` there as part of the name and stops with AL1001
 * (a file) or AL0863 (a folder) before compiling a line. Everything else (URLs, names, text, ids)
 * is left exactly as written.
 */
const APP_JSON_PATH_ARRAY_FIELDS = ["screenshots", "resourceFolders"] as const;

/**
 * R-422: returns a copy of the manifest with `/` in place of `\` in `logo`, each string element of
 * `screenshots` and each string element of `resourceFolders`, plus what changed. Never mutates the
 * input. A missing field, a non-string value and a non-string element are kept as they are.
 */
export function normaliseAppJsonPaths(manifest: Readonly<Record<string, unknown>>): {
  readonly manifest: Record<string, unknown>;
  readonly changes: readonly AppJsonPathChange[];
} {
  const changes: AppJsonPathChange[] = [];
  const out: Record<string, unknown> = { ...manifest };
  const fix = (field: string, value: string): string => {
    const to = value.replaceAll("\\", "/");
    if (to !== value) changes.push({ field, from: value, to });
    return to;
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
