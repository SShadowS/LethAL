/**
 * R870 (GitHub #27): the shared bc-toolbox CLI envelope, `@sshadows/bc-toolbox-envelope` 0.1.0.
 * With `--json`, stdout carries exactly one envelope; logs stay on stderr; exit codes do not move.
 * The package needs zod 4 and LethAL is on zod 3, so its JSON Schema is vendored instead, byte for
 * byte (`schemas/cli-envelope-v1.schema.json`, pinned by sha256 in `r870-cli-envelope.test.ts`).
 */
import { UncommittedPathError } from "./campaign-git";

export const CLI_ENVELOPE_SCHEMA_VERSION = "1" as const;

/** The toolbox's core codes: they mean the same in every tool. Never renamed, never reused. */
export const TOOLBOX_CORE_ERROR_CODES = [
  "INVALID_ARGUMENT",
  "CONFIGURATION_ERROR",
  "AUTHENTICATION_FAILED",
  "ENDPOINT_UNREACHABLE",
  "UNSUPPORTED_SERVER",
  "NOT_FOUND",
  "TOOL_DISABLED",
  "TIMEOUT",
  "SERVER_REJECTED",
  "PROTOCOL_ERROR",
  "INTERNAL_ERROR",
] as const;

/** LethAL's extension codes, for state only this tool has. */
export const LETHAL_ERROR_CODES = [
  // `campaign compare` refuses to read a stage whose pre-commitment is not committed.
  "UNCOMMITTED_PRECOMMITMENT",
] as const;

export type CliErrorCode =
  | (typeof TOOLBOX_CORE_ERROR_CODES)[number]
  | (typeof LETHAL_ERROR_CODES)[number];

export type CliErrorCategory =
  | "validation"
  | "configuration"
  | "auth"
  | "network"
  | "state"
  | "server"
  | "protocol"
  | "internal";

export interface CliErrorBody {
  readonly code: CliErrorCode;
  readonly category: CliErrorCategory;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
  readonly nextSteps: readonly [string, ...string[]];
}

export type CliEnvelope =
  | {
      readonly schemaVersion: typeof CLI_ENVELOPE_SCHEMA_VERSION;
      readonly status: "ok";
      readonly data: unknown;
      readonly warnings: readonly string[];
    }
  | {
      readonly schemaVersion: typeof CLI_ENVELOPE_SCHEMA_VERSION;
      readonly status: "error";
      readonly error: CliErrorBody;
      readonly warnings: readonly string[];
    };

export function cliOk(data: unknown, warnings: readonly string[] = []): CliEnvelope {
  return { schemaVersion: CLI_ENVELOPE_SCHEMA_VERSION, status: "ok", data, warnings };
}

/** How an error is classed for the envelope. Carried on the error, so its name and text stay as they were. */
interface Classed {
  readonly code: CliErrorCode;
  readonly category: CliErrorCategory;
  readonly nextSteps: readonly [string, ...string[]];
}
const CLASSED = Symbol.for("lethal.cli-envelope.classed");

/** Marks `err` with its envelope class and returns it. A later mark does not replace an earlier one. */
export function classify(err: unknown, c: Classed): unknown {
  if (err instanceof Error && !(CLASSED in err)) {
    Object.defineProperty(err, CLASSED, { value: c, enumerable: false });
  }
  return err;
}

const DEBUG_STEP =
  "Run again with LETHAL_DEBUG=1 for the stack trace, and report it at https://github.com/SShadowS/LethAL/issues.";

/** The envelope for a failure: its mark, else what its class says, else INTERNAL_ERROR. */
export function cliError(err: unknown, warnings: readonly string[] = []): CliEnvelope {
  const e = err instanceof Error ? err : new Error(String(err));
  const marked = (e as { [CLASSED]?: Classed })[CLASSED];
  const c: Classed =
    marked ??
    (e instanceof UncommittedPathError
      ? {
          code: "UNCOMMITTED_PRECOMMITMENT",
          category: "state",
          nextSteps: ["Commit the named file, then run the same command again."],
        }
      : { code: "INTERNAL_ERROR", category: "internal", nextSteps: [DEBUG_STEP] });
  return {
    schemaVersion: CLI_ENVELOPE_SCHEMA_VERSION,
    status: "error",
    error: {
      code: c.code,
      category: c.category,
      message: e.message,
      retryable: false,
      details: { name: e.name },
      nextSteps: c.nextSteps,
    },
    warnings,
  };
}

/** The bad-argument class: argv the parser refused. */
export const INVALID_ARGUMENT: Classed = {
  code: "INVALID_ARGUMENT",
  category: "validation",
  nextSteps: ["Run `lethal --help` for the subcommands and the flags each one takes."],
};

/** The configuration class: a config file that cannot be read or used. */
export const CONFIGURATION_ERROR: Classed = {
  code: "CONFIGURATION_ERROR",
  category: "configuration",
  nextSteps: [
    "Check the file --config names: that it exists, is JSON, and has the section the message names.",
    "`lethal init --project <dir>` writes a starting config.",
  ],
};

/** Whether argv asks for the envelope. Read from the raw argv, so a refused argv still gets one. */
export function wantsEnvelope(argv: readonly string[]): boolean {
  return argv.includes("--json");
}
