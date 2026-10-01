/**
 * R307: one file the instrumenter cannot handle. Thrown by a per-file check (the printer's overlap
 * check, the schemata injector, latch and header rules) so a run can refuse THAT file and measure
 * the rest. Any other exception still aborts the run. Extends `Error` directly (CLAUDE.md).
 *
 * The message is for the thrown error only. A report takes `formatRefusal`, built from the
 * structured fields, so no source text reaches it.
 */
export type FileRefusalShape =
  | "overlap"
  | "unsupported-kind"
  | "latch-owner"
  | "no-anchor"
  | "no-header"
  | "object-mix"
  | "site-before-header";

export interface RefusedObject {
  readonly type: string;
  readonly id: number;
  readonly name: string;
}

export interface FileRefusalFields {
  readonly file: string;
  readonly shape: FileRefusalShape;
  readonly objects?: readonly RefusedObject[];
  /** 1-based first and last line. */
  readonly lines?: readonly [number, number];
}

export class FileRefusedError extends Error {
  readonly file: string;
  readonly shape: FileRefusalShape;
  readonly objects?: readonly RefusedObject[];
  readonly lines?: readonly [number, number];
  constructor(message: string, fields: FileRefusalFields) {
    super(message);
    this.name = "FileRefusedError";
    this.file = fields.file;
    this.shape = fields.shape;
    if (fields.objects !== undefined) this.objects = fields.objects;
    if (fields.lines !== undefined) this.lines = fields.lines;
  }
}

const SENTENCE: Record<FileRefusalShape, string> = {
  overlap: "two rewrites of this file overlap",
  "unsupported-kind": "a mutation guard sits in an object that cannot carry the selector var",
  "latch-owner": "a reach marker sits outside any member that could declare its latch",
  "no-anchor": "no place was found to declare the selector var or reach latch",
  "no-header": "the object header rule found no object header",
  "object-mix": "an object that can carry the selector var shares the file with one that cannot",
  "site-before-header": "a mutation site sits before the first object header the header rule found",
};

/** R307: the refused row's `detail`, from the structured fields only. `type:id` never occurs in
 *  AL, so no header line of the refused file is copied. */
export function formatRefusal(err: FileRefusedError): string {
  let out = `${err.shape} in ${err.file}: ${SENTENCE[err.shape]}`;
  if (err.objects !== undefined && err.objects.length > 0) {
    out += `; objects ${err.objects.map((o) => `${o.type}:${o.id} ${JSON.stringify(o.name)}`).join(", ")}`;
  }
  if (err.lines !== undefined) out += `; lines ${err.lines[0]}-${err.lines[1]}`;
  return out;
}
