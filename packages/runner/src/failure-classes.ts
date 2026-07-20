import type { OperationOutcome } from "./operation-outcome";

/**
 * Thrown by a backend's `activate()` when SetActive/ClearActive fails. Extends Error
 * DIRECTLY (never PublicationFailure) so `instanceof` cannot cross-match — the project's
 * typed-error rule (see AlcCompileError/DeploymentError). The orchestrator branches on
 * `.outcome`, never on the class or the message.
 */
export class ActivationFailure extends Error {
  constructor(
    message: string,
    readonly outcome: OperationOutcome,
  ) {
    super(message);
    this.name = "ActivationFailure";
  }
}

/** Thrown by the publish path when publication's server-side fate is ambiguous. Extends Error
 *  directly, never ActivationFailure. */
export class PublicationFailure extends Error {
  constructor(
    message: string,
    readonly outcome: OperationOutcome,
  ) {
    super(message);
    this.name = "PublicationFailure";
  }
}
