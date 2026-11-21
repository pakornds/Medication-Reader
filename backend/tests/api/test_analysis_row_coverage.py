import json
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.ai.client import OpenAIClient
from app.main import create_app
from test_medication_analysis import multipart_parts, scoped_ocr, synthetic_case


@pytest.mark.parametrize("omission", ["row", "located_source", "item_reference"])
def test_missing_group_or_its_photo_evidence_rejects_transfer_preview_and_allows_retry(omission):
    form, photos, complete = synthetic_case()
    provider = Mock(spec=OpenAIClient)
    proposed = {**complete, "rows": complete["rows"][:2]}
    if omission != "row":
        source_id = "patient-account" if omission == "located_source" else "reverse-photo"
        proposed["rows"].append({**complete["rows"][2], "sources": [{"source_id": source_id}], "reverse_crop": None})

    def generate(*, evidence_text, output_type, **kwargs):
        manifest = json.loads(evidence_text)
        result = scoped_ocr(manifest, complete) if "items" in manifest else proposed
        return output_type.model_validate(result)

    provider.generate.side_effect = generate
    with TestClient(create_app(get_provider=lambda: provider)) as client:
        response = client.post("/medication-analysis", files=multipart_parts(form, photos))
        assert response.status_code == 502, response.text
        assert response.json()["detail"]["code"] == "unsupported_form_evidence"
        assert response.json()["detail"]["recoverable"] is True
        assert "rows" not in response.json()

        proposed = complete
        retry = client.post("/medication-analysis", files=multipart_parts(form, photos))
        assert retry.status_code == 200, retry.text
        rows = retry.json()["rows"]
        assert [row["id"] for row in rows] == ["row-a", "row-b", "row-c"]
        assert rows[2]["identity_status"] == "unlabeled"
        assert rows[2]["reverse_crop"] == {"source_id": "reverse-photo", "item_id": "pill-c"}


@pytest.mark.parametrize("sides", [("front",), ("reverse",), ("front", "reverse")])
def test_one_row_covers_an_inseparable_group_across_its_located_views(sides):
    _, fixture_photos, _ = synthetic_case()
    views = {
        "front": ("label_photo", fixture_photos[0]),
        "reverse": ("reverse_photo", fixture_photos[1]),
    }
    sources = [{"id": side, "kind": views[side][0]} for side in sides]
    items = [
        {"id": "group-crop", "source_id": side, "row_id": "group", "kind": "pill_crop"}
        for side in sides
    ]
    form = {
        "evidence": {
            "case_id": "case",
            "sources": [*sources, {"id": "letter", "kind": "transfer_record"}],
            "items": [
                *items,
                {"id": "excerpt", "source_id": "letter", "row_id": "note-only", "kind": "record_excerpt"},
            ],
        },
        "photo_source_ids": list(sides),
    }
    refs = [{"source_id": side, "item_id": "group-crop"} for side in sides]
    row = {"id": "group", "identity_status": "unlabeled", "unknown_label": "Unknown medication A", "sources": refs}
    provider = Mock(spec=OpenAIClient)
    model_rows = []
    provider.generate.side_effect = lambda *, output_type, **kwargs: output_type(case_id="case", rows=model_rows)
    photos = [views[side][1] for side in sides]
    with TestClient(create_app(get_provider=lambda: provider)) as client:
        incomplete = client.post("/medication-analysis", files=multipart_parts(form, photos))
        assert incomplete.status_code == 502, incomplete.text

        model_rows.append(row)
        complete = client.post("/medication-analysis", files=multipart_parts(form, photos))
        assert complete.status_code == 200, complete.text
        result, = complete.json()["rows"]
        assert result["id"] == "group"
        assert result["sources"] == refs
