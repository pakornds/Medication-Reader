"""Attribution of facility details through the normal multipart analysis route."""

import json
from functools import partial
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw, ImageFont

from app.ai.client import OpenAIClient
from app.main import create_app


def synthetic_scene(*, matched: bool = True, documented: bool = True):
    items = [
        {"source_id": "clinic-alpha", "id": "front-a", "row_id": "row-a", "kind": "label_region"},
        {"source_id": "front-b", "id": "front-b", "row_id": "row-b", "kind": "label_region"},
        {"source_id": "hospital-beta", "id": "reverse-b", "row_id": "row-b",
         "kind": "matched_reverse_label" if matched else "label_region"},
        {"source_id": "pill-photo", "id": "pill-c", "row_id": "row-c", "kind": "pill_crop"},
    ]

    form = {
        "evidence": {
            "case_id": "demo-dispensing",
            "sources": [
                {"id": "clinic-alpha", "kind": "label_photo", "attachment_id": "front-scene",
                 "organization": "Demo Clinic Alpha", "organization_type": "clinic",
                 "organization_address": "99 Demo Lane", "contact": "Patient phone 081-555XXXX"},
                {"id": "front-b", "kind": "label_photo", "attachment_id": "front-scene"},
                {"id": "hospital-beta", "kind": "reverse_photo", "attachment_id": "reverse-scene",
                 "organization": "Demo Hospital Beta", "organization_type": "hospital",
                 "department_or_ward": "Outpatient Pharmacy", "organization_phone": "02-123XXXX"},
                {"id": "pill-photo", "kind": "reverse_photo", "attachment_id": "reverse-scene",
                 "organization": "Unverified Facility", "contact": "Unrelated phone 079-123XXXX"},
            ],
            "items": items,
        },
        "photo_source_ids": ["clinic-alpha", "hospital-beta"],
        "region_locations": {
            "clinic-alpha": {"front-a": "0%,0%,50%,100%"},
            "front-b": {"front-b": "50%,0%,50%,100%"},
            "hospital-beta": {"reverse-b": "0%,0%,50%,100%"},
            "pill-photo": {"pill-c": "50%,0%,50%,100%"},
        },
    }

    def photo(left, right=None):
        image = Image.new("RGB", (1000, 450), "#c9d7d6")
        drawing = ImageDraw.Draw(image)
        font = ImageFont.load_default(size=23)
        for x, lines in ((22, left), (522, right)):
            if lines is None:
                drawing.ellipse((720, 180, 790, 230), fill="white", outline="#aaa")
                continue
            drawing.rounded_rectangle((x, 45, x + 450, 380), radius=10, fill="white", outline="#333", width=2)
            drawing.multiline_text((x + 16, 70), "\n".join(lines), font=font, fill="black", spacing=10)
        image_file = BytesIO()
        image.save(image_file, format="PNG")
        return image_file.getvalue()

    return [
        ("form", (None, json.dumps(form), "application/json")),
        ("photos", ("front.png", photo(
            ["SYNTHETIC DEMO", "Demo A 5 mg", "Dispensed by Demo Clinic Alpha", "99 Demo Lane",
             "Patient phone 081-555XXXX"],
            ["SYNTHETIC DEMO", "Demo B 10 mg"],
        ), "image/png")),
        ("photos", ("reverse.png", photo(
            ["SYNTHETIC DEMO", "Demo B 10 mg",
             "Dispensed by Demo Hospital Beta" if documented else "Demo Hospital Beta (referring hospital)",
             "Outpatient Pharmacy", "Facility phone 02-123XXXX"],
        ), "image/png")),
    ]


def named(row_id, name, ref, dispensing_source=None):
    return {
        "id": row_id,
        "identity_status": "named",
        "sources": [ref],
        "observed_names": [{"value": name, "evidence": ref}],
        "dispensing_source_id": dispensing_source,
    }


def fixture_transport(request, _timeout, *, documented):
    content = json.loads(request.data)["input"][0]["content"]
    manifest = json.loads(content[0]["text"])
    if "items" in manifest:
        item, = manifest["items"]
        source_id = item["source_id"]
        ref = {"source_id": source_id, "item_id": item["id"]}
        name = "Demo A" if item["row_id"] == "row-a" else "Demo B"
        is_dispenser = source_id == "clinic-alpha" or (source_id == "hospital-beta" and documented)
        dispenser = source_id if is_dispenser else None
        rows = [named(item["row_id"], name, ref, dispenser)]
    else:
        rows = [
            named("row-a", "Demo A", {"source_id": "clinic-alpha", "item_id": "front-a"}),
            named("row-b", "Demo B", {"source_id": "front-b", "item_id": "front-b"}, "hospital-beta"),
            {"id": "row-c", "identity_status": "unlabeled", "unknown_label": "Unknown medication C",
             "sources": [{"source_id": "pill-photo", "item_id": "pill-c"}],
             "dispensing_source_id": "pill-photo"},
        ]
    return json.dumps({
        "status": "completed",
        "output": [{"type": "message", "content": [
            {"type": "output_text", "text": json.dumps({"case_id": "demo-dispensing", "rows": rows})},
        ]}],
    }).encode()


@pytest.mark.parametrize(
    "matched,documented",
    [(True, True), (False, True), (True, False)],
    ids=["confirmed-reverse", "unpaired-reverse", "facility-role-unclear"],
)
def test_medication_analysis_preserves_only_attributed_facilities(matched, documented):
    provider = OpenAIClient(
        api_key="fixture-key", model="fixture-model",
        transport=partial(fixture_transport, documented=documented),
    )
    with TestClient(create_app(get_provider=lambda: provider)) as client:
        response = client.post(
            "/medication-analysis", files=synthetic_scene(matched=matched, documented=documented),
        )

    assert response.status_code == 200, response.text
    result = response.json()
    rows = {row["id"]: row for row in result["rows"]}
    facilities = result["dispensing_facilities"]
    alpha = facilities["row-a"]
    assert rows["row-a"]["dispensing_source_id"] == "clinic-alpha"
    assert alpha["evidence"] == {"source_id": "clinic-alpha", "item_id": "front-a"}
    assert alpha["organization"] == "Demo Clinic Alpha"
    assert alpha["organization_address"] == "99 Demo Lane"
    assert alpha["organization_phone"] is None
    assert "contact" not in alpha
    assert rows["row-c"]["dispensing_source_id"] is None
    assert "row-c" not in facilities

    if matched and documented:
        assert rows["row-b"]["dispensing_source_id"] == "hospital-beta"
        beta = facilities["row-b"]
        assert beta["evidence"] == {"source_id": "hospital-beta", "item_id": "reverse-b"}
        assert beta["evidence"] in rows["row-b"]["sources"]
        assert beta["organization"] == "Demo Hospital Beta"
        assert beta["organization_phone"] == "02-123XXXX"
        assert beta["organization_address"] is None
    else:
        assert rows["row-b"]["dispensing_source_id"] is None
        assert "row-b" not in facilities