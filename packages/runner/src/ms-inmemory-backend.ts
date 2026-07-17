import type { ExecutionBackend } from "./backend";

const MSG =
  "MsInMemoryBackend is a placeholder for Microsoft's announced in-memory AL runner. " +
  "See docs/superpowers/specs/2026-07-17-layer-4-execution-runtime-design.md §7.";

export class MsInMemoryBackend implements ExecutionBackend {
  capabilities(): never {
    throw new Error(MSG);
  }
  status(): never {
    throw new Error(MSG);
  }
  deploy(): never {
    throw new Error(MSG);
  }
  activate(): never {
    throw new Error(MSG);
  }
  run(): never {
    throw new Error(MSG);
  }
}
