"""Synthetic acceptance coverage for the optional explanation service."""

import json
from base64 import b64encode
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import pytest

from app.ai.client import OpenAIClient
from app.schemas.admission import Action, NewEncounter
from app.schemas.review import ReviewerIdentity
from app.schemas.review_scopes import ExposureObservation
from app.services.admissions import AdmissionStore
from app.services.hospital import MockHospital
from app.services.review_explanations import ExplanationRequest, ReviewExplanationService
from app.services.review_snapshots import ReviewSnapshotStore, SnapshotUpdate

_DOCTOR = ReviewerIdentity(id="demo-doctor", name="Demo doctor", role="doctor")
_NURSE = ReviewerIdentity(id="demo-nurse", name="Demo nurse", role="nurse")
_AT = datetime(2026, 11, 21, 4, 10, tzinfo=UTC)
_RAW_EVIDENCE = "Synthetic raw interview marker and contact sample@example.invalid"
_GAP_ID = "ddi-item%2D1-item%2D2"
_SYNTHETIC_PHOTO = Path(__file__).resolve().parents[1] / "fixtures/ai/label-side.png"


class FixtureEncounter:
    def __init__(self, *, second_source="E2", owner=_DOCTOR):
        self.hospital = MockHospital()
        self.admissions = AdmissionStore(self.hospital)
        self.snapshots = ReviewSnapshotStore(clock=lambda: _AT)
        self.owner = owner
        self.case = self.admissions.create(owner, NewEncounter(patient_alias="Synthetic aliases only"))
        for source, name, schedule in (("E1", "Demo Amber", "scheduled"), (second_source, "Demo Slate", "prn")):
            self.apply("add", entry={
                "source": {"id": source, "kind": "reviewer_record", "reporter": _RAW_EVIDENCE},
                "wording": f"{name}. {_RAW_EVIDENCE}", "name": name, "record_basis": "documented_interview",
            })
            row_id = list(self.case["rows"])[-1]
            self.apply(
                "interview", row_id=row_id, source_id=source, ownership="patient",
                current_use="current", dose="fixture", route="oral", schedule=schedule,
            )
            self.apply("verify", row_id=row_id, source_id=source)
        self.apply("add", entry={
            "source": {"id": "E3", "kind": "reverse_photo"}, "wording": "Synthetic unidentified item",
            "photo": {
                "media_type": "image/png", "data": b64encode(_SYNTHETIC_PHOTO.read_bytes()).decode(),
                "region": [0.1, 0.1, 0.5, 0.5], "bag": "synthetic-3", "pairing": "matched",
                "appearance": "unidentified",
            },
        })
        snapshot = self.snapshots.update(
            self.case, SnapshotUpdate(
                admission_revision=self.case["revision"],
                exposures=[ExposureObservation(row_ids=["item-1", "item-2"], status="unknown")],
            )
        )
        self.snapshot_id = snapshot.snapshot_id
        self.report = self.snapshots.run(self.case, self.snapshot_id, "DDI", enabled=True)

    def apply(self, action, **data):
        self.case = self.admissions.apply(
            self.owner, self.case["id"],
            Action.model_validate({
                "revision": self.case["revision"],
                "request_id": uuid4().hex,
                "command": {"action": action, **data},
            }),
        )

    def edit_supporting_evidence(self):
        self.apply(
            "link", row_id="item-1", confirmed=True,
            entry={"source": {"id": "E5", "kind": "reviewer_record"}, "wording": "Synthetic clarification"},
        )

    def request(self, language="en", **overrides):
        target = next(scope for scope in self.report.scopes if scope.reason_code == "unconfirmed_overlap")
        return ExplanationRequest.model_validate({
            "snapshot_id": self.snapshot_id, "kind": "DDI", "language": language,
            "purpose": "explain_gap", "item_id": target.scope_id,
        } | overrides)

    def service(self, get_provider):
        return ReviewExplanationService(self.admissions, self.snapshots, get_provider)


@pytest.fixture
def encounter():
    case = FixtureEncounter()
    yield case
    case.hospital.close()


def _read_packet(request):
    payload = json.loads(request.data)
    assert payload["store"] is False
    assert payload["model"] == "synthetic-test-model"
    content = payload["input"][0]["content"]
    assert len(content) == 1 and content[0]["type"] == "input_text"
    packet = json.loads(content[0]["text"])
    assert "get_check_summary" in packet and "get_review_item" in packet and "get_rule_reference" in packet
    return packet


def _selection(packet):
    item = packet["get_review_item"][0]
    return {
        **{key: packet[key] for key in ("snapshot_id", "kind", "language", "purpose")},
        "finding_ids": [item["item_id"]] if item["outcome"] == "finding" else [],
        "exclusion_ids": [item["item_id"]] if item["outcome"] == "unevaluated" else [],
        "evidence_ids": item["evidence_ids"],
        "rule_ids": item["rule_ids"],
        "follow_up_ids": item["follow_up_ids"],
    }


def _response(selection):
    return json.dumps({"status": "completed", "output": [{
        "type": "message", "content": [{"type": "output_text", "text": json.dumps(selection)}],
    }]}).encode()


def _client(transport):
    return OpenAIClient(api_key="fixture-only", model="synthetic-test-model", transport=transport)


@pytest.mark.parametrize(("language", "template", "question"), [
    (
        "en",
        "Simulated review: use during the same period is unconfirmed. This potential interaction was not evaluated.",
        "When did you last take Demo Slate, and did you take Demo Amber during the same period?",
    ),
    (
        "th",
        "การทบทวนแบบจำลอง: ยังไม่ยืนยันการใช้ยาในช่วงเวลาเดียวกัน จึงยังไม่ได้ประเมินปฏิกิริยาระหว่างยาคู่นี้",
        "คุณใช้ Demo Slate ครั้งล่าสุดเมื่อใด และได้ใช้ Demo Amber ในช่วงเวลาเดียวกันหรือไม่",
    ),
])
def test_real_adapter_validates_bilingual_selection_and_uses_fixed_templates(encounter, language, template, question):
    calls = []

    def transport(request, timeout):
        packet = _read_packet(request)
        calls.append(packet)
        return _response(_selection(packet))

    result = encounter.service(lambda: _client(transport)).explain(
        encounter.case["id"], _DOCTOR, encounter.request(language)
    )
    assert len(calls) == 1
    assert result.snapshot_id == encounter.snapshot_id
    assert result.release_id == "demo-overlap-v2"
    assert result.mapping_version == "demo-ingredient-map-v2"
    assert result.kind == "DDI" and result.language == language
    assert result.purpose == "explain_gap" and result.simulated
    assert result.template_id == "overlap-gap" and result.source == "model_selection"
    assert result.finding_ids == [] and result.exclusion_ids == [_GAP_ID]
    assert result.evidence_ids == ["E1", "E2"]
    assert result.rule_ids == ["demo-ddi-conditional-exposure"]
    assert result.follow_up_ids == ["ask-last-use-and-overlap"]
    assert result.follow_ups[0].question == question
    assert result.explanation == template


def test_model_packet_never_includes_raw_notes_contacts_names_photos_or_source_identifiers():
    case = FixtureEncounter(second_source="source-contact-sentinel@example.invalid")
    try:
        calls = []

        def transport(request, timeout):
            packet = _read_packet(request)
            calls.append(bytes(request.data))
            return _response(_selection(packet))

        result = case.service(lambda: _client(transport)).explain(case.case["id"], _DOCTOR, case.request())
        assert result.source == "model_selection"
        assert result.evidence_ids == ["E1", "source-contact-sentinel@example.invalid"]
        assert len(calls) == 1
        raw = calls[0]
        for marker in (
            b"input_image", b"image_url", b"base64", b"raw interview marker",
            b"example.invalid", b"Demo Amber", b"Demo Slate", case.case["id"].encode(),
            b"admission_revision", b'"E1"', b'"E3"', b64encode(_SYNTHETIC_PHOTO.read_bytes()),
        ):
            assert marker not in raw
    finally:
        case.hospital.close()


@pytest.mark.parametrize("change", [
    {"finding_ids": ["invented-finding"]},
    {"exclusion_ids": ["item-outside-this-scope"]},
    {"evidence_ids": ["invented-evidence"]},
    {"rule_ids": ["invented-rule"]},
    {"follow_up_ids": ["invented-follow-up"]},
    {"snapshot_id": "different-snapshot"},
    {"kind": "DRP"},
    {"language": "th"},
    {"purpose": "explain_finding"},
    {"explanation": "Change both medication doses."},
])
def test_invented_ids_mismatched_scope_and_model_prose_have_deterministic_fallback(encounter, change):
    def transport(request, timeout):
        return _response(_selection(_read_packet(request)) | change)

    result = encounter.service(lambda: _client(transport)).explain(
        encounter.case["id"], _DOCTOR, encounter.request()
    )
    assert result.source == "deterministic_fallback" and result.purpose == "clarify_scope"
    assert result.explanation == "Simulated review: 0 of 3 scopes evaluated, 0 findings and 3 exclusions."
    assert result.template_id == "scope-coverage"
    assert not (result.finding_ids or result.exclusion_ids or result.evidence_ids or result.rule_ids or result.follow_up_ids)


@pytest.mark.parametrize("failure", ["malformed_json", "timeout"])
def test_transport_failures_keep_report_available(encounter, failure):
    def transport(request, timeout):
        if failure == "timeout":
            raise TimeoutError("synthetic timeout")
        return b"malformed message envelope"

    result = encounter.service(lambda: _client(transport)).explain(
        encounter.case["id"], _DOCTOR, encounter.request()
    )
    assert result.source == "deterministic_fallback"
    assert result.release_id == encounter.report.release_id
    assert encounter.snapshots.get_report(encounter.case, encounter.snapshot_id, "DDI") == encounter.report


def _forbidden_provider():
    pytest.fail("No provider should be constructed for this request")


def test_wrong_case_wrong_role_missing_stale_and_not_run_skip_the_model(encounter):
    service = encounter.service(_forbidden_provider)
    other = encounter.admissions.create(_DOCTOR, NewEncounter(patient_alias="Different synthetic encounter"))
    for case_id, actor, request in [
        (other["id"], _DOCTOR, encounter.request()),
        (encounter.case["id"], _NURSE, encounter.request()),
        (encounter.case["id"], _DOCTOR, encounter.request(kind="DRP")),
        (encounter.case["id"], _DOCTOR, encounter.request(snapshot_id="retired-id")),
    ]:
        result = service.explain(case_id, actor, request)
        assert result.source == "reviewer_referral" and result.template_id == "current-report-required"
        assert result.release_id is None and result.evidence_ids == []
    encounter.snapshots.run(encounter.case, encounter.snapshot_id, "DDI", enabled=False)
    assert service.explain(encounter.case["id"], _DOCTOR, encounter.request()).template_id == "current-report-required"
    encounter.edit_supporting_evidence()
    assert service.explain(encounter.case["id"], _DOCTOR, encounter.request()).template_id == "current-report-required"


def test_treatment_referral_and_unknown_requested_item_do_not_call_provider(encounter):
    service = encounter.service(_forbidden_provider)
    treatment = service.explain(encounter.case["id"], _DOCTOR, encounter.request("th", purpose="treatment_request"))
    assert treatment.purpose == "refer_to_reviewer" and treatment.template_id == "treatment-referral"
    assert treatment.follow_ups == [] and treatment.evidence_ids == []
    invented_item = service.explain(encounter.case["id"], _DOCTOR, encounter.request(item_id="invented"))
    assert invented_item.source == "deterministic_fallback" and invented_item.exclusion_ids == []


def test_model_output_is_discarded_if_supporting_evidence_changes_during_request(encounter):
    def transport(request, timeout):
        selection = _selection(_read_packet(request))
        encounter.edit_supporting_evidence()
        return _response(selection)

    result = encounter.service(lambda: _client(transport)).explain(
        encounter.case["id"], _DOCTOR, encounter.request()
    )
    assert result.source == "reviewer_referral" and result.template_id == "current-report-required"
    assert result.release_id is None and result.follow_up_ids == [] and result.exclusion_ids == []


def test_bound_drp_finding_uses_only_its_actual_rule_and_verified_sources(encounter):
    report = encounter.snapshots.run(encounter.case, encounter.snapshot_id, "DRP", enabled=True)
    finding = next(scope for scope in report.scopes if scope.outcome == "finding")

    def transport(request, timeout):
        return _response(_selection(_read_packet(request)))

    result = encounter.service(lambda: _client(transport)).explain(
        encounter.case["id"], _DOCTOR,
        encounter.request(kind="DRP", purpose="explain_finding", item_id=finding.scope_id),
    )
    assert result.template_id == "shared-ingredient-finding"
    assert result.finding_ids == [finding.scope_id] and result.exclusion_ids == []
    assert result.evidence_ids == ["E1", "E2"]
    assert result.follow_up_ids == ["ask-shared-ingredient-intent"]
