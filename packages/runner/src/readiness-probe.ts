/** Dependencies are NON-mutating reads only. `odataRead` MUST be a read (the `DeploymentVerifier`
 *  `Identity` read), never ClearActive — ClearActive mutates the very table observed stranded (spec §10). */
export interface ReadinessProbeDeps {
  odataRead: () => Promise<unknown>;
  testPlaneHandshake: () => Promise<unknown>;
}

/**
 * Post-clear readiness check for BOTH work planes the mutation loop drives (OData 7048 + the
 * SignalR test runner). Runs ONLY after quarantine has been cleared by proven recycle (spec §10).
 * A pass is necessary to resume but proves nothing about any past strand.
 */
export class ReadinessProbe {
  constructor(private readonly deps: ReadinessProbeDeps) {}

  async probe(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.deps.odataRead();
    } catch (err) {
      return { ok: false, detail: `OData plane not ready: ${String(err)}` };
    }
    try {
      await this.deps.testPlaneHandshake();
    } catch (err) {
      return { ok: false, detail: `test plane not ready: ${String(err)}` };
    }
    return { ok: true, detail: "both work planes answered" };
  }
}
