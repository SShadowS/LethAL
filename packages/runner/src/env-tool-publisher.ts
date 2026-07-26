import type { CompiledArtifact } from "./artifact";
import type { EnvToolBlock, EnvToolClient } from "./env-tool";
import { EnvToolError } from "./env-tool";
import { serializePublish } from "./publish-serializer";
import type { AppPublisher } from "./publisher";

export interface EnvToolPublisherIo {
  readonly readArtifact: (path: string) => Promise<Uint8Array>;
}

/**
 * Publishes through the configured environment tool instead of altool. Same guarantees as
 * `ContainerDeployer.publish`: the artifact's bytes are re-hashed immediately before the publish
 * and a mismatch refuses, and publishes serialize per environment (the key is
 * `canonicalContainerKey` of the resolved connection, whose serverInstance IS the envId).
 *
 * The tool's failure text is surfaced verbatim (both streams) because the orchestrator's one-shot
 * version-conflict recovery parses BC's rejection message out of it.
 */
export class EnvToolPublisher implements AppPublisher {
  constructor(
    private readonly client: EnvToolClient,
    private readonly block: EnvToolBlock,
    private readonly ctx: { readonly envId: string; readonly serializerKey: string },
    private readonly io: EnvToolPublisherIo,
  ) {}

  async publish(artifact: CompiledArtifact): Promise<void> {
    await serializePublish(this.ctx.serializerKey, async () => {
      const bytes = await this.io.readArtifact(artifact.appPath);
      const actual = Bun.SHA256.hash(bytes, "hex");
      if (actual !== artifact.sha256) {
        throw new EnvToolError(
          `refusing to publish ${artifact.appPath}: digest ${actual} does not match the compiled ` +
            `artifact's ${artifact.sha256} — the file changed after compilation`,
        );
      }
      await this.client.run(this.block, "publish", {
        envId: this.ctx.envId,
        appFile: artifact.appPath,
      });
    });
  }

  /**
   * Publishes a file that has no `CompiledArtifact` record — `lethal-control.app` and every
   * `publishApps` entry. The digest is computed and reported rather than compared: there is no
   * expectation to compare against, and inventing one would be theatre.
   */
  async publishFile(appPath: string): Promise<void> {
    await serializePublish(this.ctx.serializerKey, async () => {
      const bytes = await this.io.readArtifact(appPath);
      const digest = Bun.SHA256.hash(bytes, "hex");
      console.log(`[lethal] publishing ${appPath} (sha256 ${digest}) to env ${this.ctx.envId}`);
      await this.client.run(this.block, "publish", { envId: this.ctx.envId, appFile: appPath });
    });
  }
}
