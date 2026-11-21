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

Each logical source can carry an organization name, type, department or ward, facility address, facility phone and extension, and institutional email. Separate logical sources can share an `attachment_id` when one upload shows several organizations. `EvidenceRef` identifies the logical source and located item. Existing payloads with only `contact` remain readable. Preserve this value verbatim when its type or owner is unknown. See [source fields and attribution](medication-reader-v1.md#source-fields-and-attribution).

An unavailable record stays visible with a reason
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

## Try the regimen round trip

The regular FastAPI app exposes `POST /regimens/parse`. Supply an assigned row ID, component ID, statement, basis, source reference and case evidence. Each populated clinical field in the response cites its source. A partial or unparsed result retains the unsupported wording. Store documented and reported components on `row.regimens`. A pharmacist or doctor records the encounter’s actual regimen on `row.verification.regimens`. An edited field may cite a different source. A current row with structured verification needs a complete dose, unit, route and schedule for each verified component. Older rows with only sourced dose, route and frequency remain supported.

From a checkout with the backend installed, run:

```sh
python -m uvicorn app.regimen_demo:create_app --factory --host 127.0.0.1
```

Open [the local synthetic review](http://127.0.0.1:8000/regimen-demo/). Load the fixture, compare the documented morning timing with the patient's evening report, edit actual use, verify it and approve the import. The page reads back the receiving record using the receipt timestamp. This explicit local demo uses a fixture pharmacist and an in-memory mock hospital. The regular application does not register that fixture identity.
