# Published JSON Schemas

Machine-readable descriptions of what LethAL prints, for a consumer that wants to validate a file or
generate types rather than discover a shape change by crashing on it. Draft 2020-12.

| File | Describes | Version constant |
|---|---|---|
| [`explain-v5.schema.json`](explain-v5.schema.json) | `lethal explain <report.json>` on stdout | `EXPLAIN_SCHEMA_VERSION` = 5 |
| [`explain-v4.schema.json`](explain-v4.schema.json) | the same, from builds before GH-24; kept so a stored v4 document stays checkable (its value sets drifted, see `docs/roadmap/R233.md`) | `EXPLAIN_SCHEMA_VERSION` = 4 |
| [`doctor-v1.schema.json`](doctor-v1.schema.json) | `lethal doctor --json` on stdout | `DOCTOR_SCHEMA_VERSION` = 1 |
| [`report-v2.schema.json`](report-v2.schema.json) | the JSON report written with `--out` | `REPORT_SCHEMA_VERSION` = 2 |
| [`stream-v1.schema.json`](stream-v1.schema.json) | one line of the NDJSON stream written with `--progress-out` | `STREAM_SCHEMA_VERSION` = 1 |

**Of the five files, three are hand-written and two are generated, and the split is about SIZE
rather than principle.** `explain` (a few dozen leaves; v5 and the kept v4) and `doctor` (8) are
hand-written; v5 and `doctor` are pinned against their declarations, and v4 is frozen as it was
published. `report` and `stream` are generated.
`SessionReport` walks out to 130 leaves and the stream is a union of 20 event shapes; at that size a
hand-written file stops being a guarantee and becomes a second copy of the type that someone
forgets, so `bun scripts/generate-schemas.ts` emits both, and `--check` fails when a committed file
no longer matches the type.

Two caveats worth reading before you validate against these:

- The stream schema describes one EVENT line. The first line of a `--progress-out` file is a header
  the sink writes itself (`ndjsonHeader: true`, no `seq`), and it deliberately does NOT validate.
- The report schema describes the shape THIS build writes. Required fields have been added without
  bumping `schemaVersion`, so an archived report of the same version can lack a property the schema
  requires — see `docs/roadmap/R157.md`, which pins both halves of that.

## What keeps these true

`packages/runner/tests/schemas.test.ts`, three ways, because a published schema that has drifted is
worse than no schema at all — it calls a correct document invalid, at every consumer that validates.

1. **Shape.** Each schema's leaf paths are asserted equal to the leaves walked out of the TypeScript
   declaration (`ExplainOutput`, `DoctorJsonOutput`), in both directions. A field added to the type
   with no schema entry fails; a schema property with no field fails.
2. **Value domains.** Every `enum` is asserted equal to the runtime constant it copies, so a value
   added to `Caveat` or `MutantErrorCause` cannot leave the schema behind. Every `enum` in the
   current explain schema is ALSO pinned against a literal list (R233), so a value added without a
   version bump fails.
3. **Real data.** The projection of a committed campaign report is validated against
   `explain-v5.schema.json`, capped and uncapped.

The validator in that test is small on purpose — type, const, enum, required, properties,
additionalProperties, items, minItems, local `$ref`. It is not a JSON Schema implementation and must
not become one. A schema here that needs a keyword it does not support is a signal to add a real
validator as a dependency.

## Versioning

A version bumps when a field is renamed or removed, when a field changes meaning, or when a value
domain changes **in either direction** — growing one is not free, because a consumer branches on the
value and an unrecognised one lands in whatever its else-branch says. **Adding a field does not
bump it**, so a consumer must tolerate properties it does not know.

A new version means a new file. `explain-v4.schema.json` stays as it is when a v5 arrives, so a
stored document remains checkable against the schema it was written under.
