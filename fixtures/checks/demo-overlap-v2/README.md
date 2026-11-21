# Demo overlap v2 fixture

`case.json` is the shared synthetic fixture for the optional screening workflow.
Load it with `ScreeningFixture.model_validate_json` from
`app.schemas.review_scopes`. The single document contains the release and
rules, two snapshots of the same encounter, and the expected DDI and DRP report
for each snapshot. All products, ingredients and evidence are fictional.

| Snapshot | Report | Evaluated / total | Findings | Excluded |
| --- | --- | --- | --- | --- |
| PRN overlap unknown | DDI | 0 / 3 | 0 | 3 |
| PRN overlap unknown | DRP | 1 / 3 | 1 | 2 |
| Overlap confirmed by E4 | DDI | 1 / 3 | 1 | 2 |
| Overlap confirmed by E4 | DRP | 1 / 3 | 1 | 2 |

Count scopes without a `parent_scope_id`. The R1/R2 DDI scope has two child
ingredient comparisons. The X/X comparison is explicitly covered with no
finding in both snapshots. The X/Y comparison needs a confirmed exposure for
the R1/R2 pair. The R1/R2 DRP shared-X rule uses the complete ingredient maps
and supported routes, so it retains its finding and R2's PRN status in both
snapshots. R3 remains unidentified throughout.

Use `scope_id` together with the report's `snapshot_id`. DDI and DRP use
independent scope IDs. Per-rule source and context metadata lives in the
release. Scope evidence and follow-up IDs refer to the snapshot and release
respectively.
