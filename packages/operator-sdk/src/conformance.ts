import {
  type MutationOperator,
  type MutationSpec,
  buildSemanticContext,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";

export interface ConformanceResult {
  allPassed: boolean;
  failures: ConformanceFailure[];
}

export interface ConformanceFailure {
  caseName: string;
  reason: string;
  produced: ReadonlyArray<{
    beforeText: string;
    afterText: string;
    parentContext: MutationSpec["parentContext"];
  }>;
}

export async function runConformance(op: MutationOperator): Promise<ConformanceResult> {
  const failures: ConformanceFailure[] = [];

  for (const c of op.conformanceTests) {
    const tree = parseAL(c.sourceAL);
    const root = wrapRoot(tree);
    const ctx = buildSemanticContext([{ path: `conformance://${c.name}`, root }]);

    const produced: MutationSpec[] = [];
    visit(root, (node) => {
      if (op.targets(node, ctx)) {
        for (const spec of op.generate(node, ctx)) {
          produced.push(spec);
        }
      }
    });

    // A case with NO expected specs is a documented refusal: the operator must emit nothing here.
    // Checking only that every expected spec appeared made such a case pass on any input at all
    // (R137) — the repo's empty-vs-empty shape, inside the harness meant to catch it.
    if (c.expectedSpecs.length === 0) {
      if (produced.length > 0) {
        failures.push({
          caseName: c.name,
          reason: `refusal case produced ${produced.length} spec(s), expected none`,
          produced: produced.map(describe),
        });
      }
      continue;
    }

    const expectedRemaining = c.expectedSpecs.slice();
    for (const spec of produced) {
      const idx = expectedRemaining.findIndex(
        (e) =>
          e.parentContext === spec.parentContext &&
          e.beforeText === spec.before.text.trim() &&
          e.afterText === renderAfter(spec).trim(),
      );
      if (idx >= 0) expectedRemaining.splice(idx, 1);
    }

    if (expectedRemaining.length > 0) {
      failures.push({
        caseName: c.name,
        reason: `expected mutation not produced: ${JSON.stringify(expectedRemaining[0])}`,
        produced: produced.map(describe),
      });
    }
  }

  return { allPassed: failures.length === 0, failures };
}

function describe(spec: MutationSpec): ConformanceFailure["produced"][number] {
  return {
    beforeText: spec.before.text,
    afterText: renderAfter(spec),
    parentContext: spec.parentContext,
  };
}

function renderAfter(spec: MutationSpec): string {
  const after = spec.after as { text?: string };
  return after.text ?? "";
}
