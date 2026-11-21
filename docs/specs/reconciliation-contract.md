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

The regular FastAPI app exposes `POST /regimens/parse`. Supply an assigned row ID, component ID, statement, basis, source reference and case evidence. Each populated clinical field in the response cites its source. A partial or unparsed result retains the unsupported wording. Store documented and reported components on `row.regimens`. An assigned nurse, doctor or pharmacist records the encounter’s actual regimen on `row.verification.regimens`. An edited field may cite a different source. A current row with structured verification needs a complete dose, unit, route and schedule for each verified component. Older rows with only sourced dose, route and frequency remain supported.

From a checkout with the backend installed, run:

```sh
python -m uvicorn app.regimen_demo:create_app --factory --host 127.0.0.1
```

Open [the local synthetic review](http://127.0.0.1:8000/regimen-demo/). Load the fixture, compare the documented morning timing with the patient's evening report, edit actual use, verify it and approve the import. The page reads back the receiving record using the receipt timestamp. This explicit local demo uses a fixture pharmacist and an in-memory mock hospital. The regular application does not register that fixture identity.

## Admission encounters

Start the regular FastAPI application and open [/admission/](http://127.0.0.1:8000/admission/). Configure distinct synthetic staff tokens in the server environment using `MEDICATION_READER_DEMO_NURSE_TOKEN`, `MEDICATION_READER_DEMO_DOCTOR_TOKEN` and `MEDICATION_READER_DEMO_REVIEWER_TOKEN` (pharmacist). Sign in with a token in each independent browser session. Tokens stay in page memory.

Create a synthetic encounter. The creator and the demo pharmacist are assigned automatically. Select additional staff at creation. Add a sourced order or an unknown appearance. For mixed bags, create one item for each distinguishable appearance with its own crop and shared bag reference. Confirm a later source link explicitly. A targeted retake supersedes one item view. Reviewers can transcribe directly or use the existing configured analysis provider to read a matched label region. A reverse label uses the located item kind `matched_reverse_label`.

Start the interview or print the dated worksheet after the first row. Record ownership, reported status, actual regimen, reason and optional clinician note. Select an available interview or discharge record when it supports the encounter review. Each verification records its reviewer and time. Conflicting identity sources require a source selection and documented resolution. Separate orders keep separate IDs even when they name the same product.

`POST /admissions` creates the encounter. `GET /admissions` lists assigned encounters, including pending referrals and finished reviews. `GET /admissions/{id}` returns the dated review. `GET /admissions/{id}/candidates` lists names from its records and prior mock imports. Use `POST /admissions/{id}/actions` with the current revision, a unique request ID and a discriminated command. See the [running OpenAPI schema](http://127.0.0.1:8000/docs) for each payload. A repeated identical command returns the latest record without another event. A stale revision or reused request ID with different content returns 409.

`refer` sends unresolved items, checked evidence and a reason to the assigned pharmacist. A proposed name is optional. A pharmacist can correct, confirm, reject or leave an item pending. Cite independent evidence linked to the physical item for confirmation or correction. `finish` requires completed routine verification and no outstanding required identity review. A finished review is read-only. `import` approves the selected verified rows for the mock hospital and returns a receipt. Clinical completion and referral never write to the hospital.

The admission store belongs to a single mock app instance and lasts for the life of that server process. Staff can close the page, sign in from another device and reopen an assigned record. Browser storage contains only successful UTC import timestamps. Run this fixture demo with one server worker. The app omits encounter and import requests from Uvicorn access logs. A server restart clears the synthetic encounters and mock hospital.

### Independent identity evidence

A proposal records the name, its reference and the proposer against the original item. The command `decide` cites a separate active source on that item, the outcome and the pharmacist's finding. An independent source carries an `identity_basis` of `matched_original_package`, `dispensing_confirmation` or `item_specific_record`, and wording that documents how the physical item was identified. A repeat crop from the challenged attachment or image cannot confirm it. A separate dispensing confirmation specifically identifying the bag can support a pharmacist correction. A transfer list or catalogue hit alone remains a proposal. The event trail retains original source IDs, the proposal and the decision. [Issue #65](https://github.com/pakornds/Medication-Reader/issues/65) tracks applying the disputed-label rule to legacy import snapshots outside admission encounters.
