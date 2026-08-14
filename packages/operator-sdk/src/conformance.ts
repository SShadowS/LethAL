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

    // Drained one-for-one, and BOTH leftovers are reported. Until R142 only the expected side was
    // inspected: a case expecting one spec passed when the operator emitted that spec plus an
    // unwanted one, which is the empty-vs-empty shape R137 closed for refusal cases wearing a
    // different costume. Counting rather than set-matching also catches a duplicate — the same
    // mutation emitted twice drains the single expectation once and leaves one over.
    //
    // Measured before this was turned on (`scripts/r142-probe`): across all 15 registered
    // operators, 31 non-empty cases, ZERO produce a spec their golden does not name. No golden
    // needed completing, which is why this could be a contract rather than a migration.
    const expectedRemaining = c.expectedSpecs.slice();
    const unexpected: MutationSpec[] = [];
    for (const spec of produced) {
      const idx = expectedRemaining.findIndex(
        (e) =>
          e.parentContext === spec.parentContext &&
          e.beforeText === spec.before.text.trim() &&
          e.afterText === renderAfter(spec).trim(),
      );
      if (idx >= 0) expectedRemaining.splice(idx, 1);
      else unexpected.push(spec);
    }

    if (expectedRemaining.length > 0) {
      failures.push({
        caseName: c.name,
        reason: `expected mutation not produced: ${JSON.stringify(expectedRemaining[0])}`,
        produced: produced.map(describe),
      });
    }

    // Reported SEPARATELY from the miss above, never folded into it: "the golden names a mutation
    // the operator did not make" and "the operator made one the golden does not name" are two
    // different defects, and a case can be both at once. The offending specs are named rather than
    // counted, so a reader can tell an under-specified golden from an operator emitting something
    // it should not — the distinction R142 warned would otherwise be answered by weakening the
    // contract.
    if (unexpected.length > 0) {
      const named = unexpected
        .map((s) => JSON.stringify(`${s.before.text.trim()} -> ${renderAfter(s).trim()}`))
        .join(", ");
      failures.push({
        caseName: c.name,
        reason: `case produced ${unexpected.length} spec(s) its expectation does not name: ${named}`,
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
