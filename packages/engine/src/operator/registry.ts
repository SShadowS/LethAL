import { isALNodeKind } from "../ast/node-kinds";
import type { MutationOperator } from "./interface";

const SEMVER = /^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/;

export interface Registry {
  register(op: MutationOperator): void;
  list(): readonly MutationOperator[];
  get(name: string, version: string): MutationOperator | null;
}

export function createRegistry(): Registry {
  const key = (n: string, v: string) => `${n}@${v}`;
  const operators = new Map<string, MutationOperator>();

  return {
    register(op) {
      if (!SEMVER.test(op.version)) {
        throw new Error(`operator ${op.name}: version ${op.version} is not semver`);
      }
      for (const kind of op.targetNodeKinds) {
        if (!isALNodeKind(kind)) {
          throw new Error(
            `operator ${op.name}: targetNodeKinds contains unknown ALNodeKind "${kind}"`,
          );
        }
      }
      for (const kind of op.producesNodeKinds) {
        if (!isALNodeKind(kind)) {
          throw new Error(
            `operator ${op.name}: producesNodeKinds contains unknown ALNodeKind "${kind}"`,
          );
        }
      }
      const k = key(op.name, op.version);
      if (operators.has(k)) {
        throw new Error(`operator ${k} already registered`);
      }
      operators.set(k, op);
    },
    list() {
      return Array.from(operators.values());
    },
    get(name, version) {
      return operators.get(key(name, version)) ?? null;
    },
  };
}
