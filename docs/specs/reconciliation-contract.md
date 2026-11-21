# Reconciliation API contract

Run `python -m app.schemas.openapi` after installing the backend. It emits an
OpenAPI 3.1 document with components generated from the Pydantic models.
The document describes payloads while feature routes are under development.
Route registration in [#28](https://github.com/pakornds/Medication-Reader/issues/28)
publishes the mounted operations through FastAPI.

| Payload | Models |
| --- | --- |
| Evidence analysis | `AnalysisRequest`, `AnalysisResult`, `CaseEvidence`, `EvidenceRef` |
| Pill observations and synthetic candidates | `PillObservation`, `CandidateRequest`, `CandidateResult` |
| Clinician verification and mock import | `ReviewerIdentity`, `ReviewRow`, `ImportRequest`, `ImportReceipt` |
| Simulated checks | `CheckRequest`, `CheckSummary` |
| Recoverable service failures | `ServiceError` |

The case manifest tracks organization, ward, reporter, collector, contact and
source date independently. An unavailable record stays visible with a reason
and can be the subject of a follow-up. Only available evidence supports a
claim. Keep the form question separate from the report and other notes.

Pass structurally valid analysis through `validate_analysis_result(result,
evidence)` before displaying it. Match photo-based claims to a located item
with the same source and row ID in the application-provided manifest. Use
the field's own citation even when multiple rows come from the same image.
An attachment can support an unknown row while dispensing provenance remains
unknown. A citation establishes the evidence location. The extraction and
analysis services also need to verify that the transcribed value is supported
by that location. Keep approval and verification in `ReviewRow`, outside
agent suggestions.

The synthetic fixtures in
[`backend/tests/fixtures/contracts/`](../../backend/tests/fixtures/contracts/)
provide a bilingual clinic label, an unlabeled bag, a potentially wrong label,
an unavailable clinic record, conflicting ward and patient evidence, and
successful and recoverable service responses. From the repository root, run
`python -m pytest backend/tests/test_contracts.py` to verify the fixtures and
evidence boundaries.
