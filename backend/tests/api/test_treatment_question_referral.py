"""Form referrals are staff-facing follow-ups, separate from medication evidence."""
import json

import pytest
from fastapi.testclient import TestClient

from app.ai.client import OpenAIClient
from app.main import create_app
from test_medication_analysis import multipart_parts, scoped_ocr, synthetic_case


REFERRAL = {
    "field": "treatment_referral",
    "question": "Please discuss this treatment question with a pharmacist or doctor.",
    "potential_source_id": None,
}
UNSUPPORTED = "Make the provider's proposed treatment change."


def fixture_app(question, flagged):
    form, photos, proposal = synthetic_case()
    form["question"] = question
    row = proposal["rows"][0]
    row["follow_ups"] = [{"field": "directions", "question": UNSUPPORTED}]
    if flagged:
        row["follow_ups"] += [dict(REFERRAL, question=UNSUPPORTED, potential_source_id="prior-clinic")] * 2

    def transport(request, _timeout):
        payload = json.loads(request.data)
        submitted = json.loads(payload["input"][0]["content"][0]["text"])
        output = scoped_ocr(submitted, proposal) if "items" in submitted else proposal
        return json.dumps({
            "status": "completed",
            "output": [{"type": "message", "content": [{"type": "output_text", "text": json.dumps(output)}]}],
        }).encode()

    provider = OpenAIClient(api_key="fixture", model="fixture", transport=transport)
    return create_app(get_provider=lambda: provider), form, photos


@pytest.mark.parametrize(("question", "flagged", "expect_referral"), [
    ("Should I change how I take Demo A?", True, True),
    ("What directions are printed on the Demo A label?", False, False),
    ("What is printed on Demo A, and should I change how I take it?", True, True),
    (None, True, False),
])
def test_referral_preserves_separate_sources(question, flagged, expect_referral):
    app, form, photos = fixture_app(question, flagged)
    with TestClient(app) as client:
        response = client.post("/medication-analysis", files=multipart_parts(form, photos))
    assert response.status_code == 200, response.text
    named, other, unknown = response.json()["rows"]
    referrals = [item for item in named["follow_ups"] if item["field"] == "treatment_referral"]
    assert referrals == ([REFERRAL] if expect_referral else [])
    assert all(item["field"] != "treatment_referral" for row in (other, unknown) for item in row["follow_ups"])
    assert any(item["field"] == "directions" for item in unknown["follow_ups"])
    directions = named["label_fields"]["directions"]
    assert directions["value"] == "เช้าและเย็น"
    assert directions["evidence"] == {"source_id": "label-photo", "item_id": "label-a"}
    report, = named["reported_use"]
    assert report["value"] == form["patient_report"][0]["value"]
    assert report["evidence"] == {"source_id": "patient-account", "item_id": None}
    assert [part["basis"] for part in named["regimens"]] == ["documented", "reported"]
    assert UNSUPPORTED not in response.text
    if question:
        assert question not in response.text
