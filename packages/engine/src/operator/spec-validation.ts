import { z } from "zod";

const SEMVER = /^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/;

const specSchema = z.object({
  operatorName: z.string().min(1),
  operatorVersion: z.string().regex(SEMVER),
  astNodeId: z.string().min(1),
  before: z.object({ kind: z.string() }).passthrough(),
  after: z.object({ kind: z.string() }).passthrough(),
  parentContext: z.enum([
    "statement-position",
    "expression-position",
    "short-circuit-operand",
  ]),
  equivalenceHint: z.enum(["likely-equivalent", "unknown"]).optional(),
});

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

export function validateSpec(raw: unknown): ValidationResult {
  const parsed = specSchema.safeParse(raw);
  if (parsed.success) return { ok: true };
  return { ok: false, error: formatZodError(parsed.error) };
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
}
