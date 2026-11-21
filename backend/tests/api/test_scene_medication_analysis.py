"""Whole unmarked-table uploads produce independently grounded package rows through the ordinary route."""
import json
from base64 import b64decode
from io import BytesIO

from fastapi.testclient import TestClient
from PIL import Image

from app.ai.client import OpenAIClient
from app.main import create_app


def upload(client, *, reverse=False, marked=False):
    image = Image.new("RGB", (120, 80), "red")
    image.paste("blue", (60, 0, 120, 80))
    data = BytesIO()
    image.save(data, "PNG")
    sides = ["front", "reverse"] if reverse else ["front"]
    form = dict(evidence=dict(case_id="example", sources=[dict(id=s, attachment_id=s,
                     kind="label_photo" if s == "front" else "reverse_photo") for s in sides]),
                photo_source_ids=sides, scene_photo_ids=sides)
    if marked:
        form["scene_photo_ids"] = []
        form["evidence"]["sources"].append(dict(id="left", attachment_id="front", kind="label_photo"))
        form["evidence"]["items"] = [dict(id="left", source_id="left", row_id="order-a", kind="label_region")]
        form["region_locations"] = {"left": {"left": "0%,0%,50%,100%"}}
    files = [("form", (None, json.dumps(form), "application/json"))]
    files.extend(("photos", ("example.png", data.getvalue(), "image/png")) for _ in sides)
    result = client.post("/medication-analysis", files=files)
    assert result.status_code == 200, result.text
    return result.json()


def provider_calls(*, partial=False, empty=False):
    calls = []
    def transport(request, _timeout):
        body = json.loads(request.data)
        content = body["input"][0]["content"]
        pixels = Image.open(BytesIO(b64decode(content[-1]["image_url"].split(",")[1])))
        assert body["store"] is False
        calls.append((body["text"]["format"]["name"], pixels.size))
        if body["text"]["format"]["name"] == "ProposedBounds":
            reply = {"regions": [] if empty else [dict(x=x,y=0,width=.5,height=1) for x in [0,.5]]}
        else:
            name = "Synthetic red label" if pixels.getpixel((0, 0))[0] else "Synthetic blue label"
            if partial and name == "Synthetic blue label":
                raise TimeoutError()
            reply = dict(names=[name], directions="1 tablet each morning", amount_prescribed="21 tablets",
                         facility=dict(organization="Synthetic Clinic", organization_phone="000-0000"))
        return json.dumps(dict(status="completed", output=[dict(type="message", content=[
            dict(type="output_text",text=json.dumps(reply))])])).encode()
    return OpenAIClient(api_key="fixture", model="fixture", transport=transport), calls


def test_two_sides_two_distinct_crops_no_duplicate_orders_from_reverse():
    provider, calls = provider_calls()
    with TestClient(create_app(get_provider=lambda: provider)) as client:
        preview = upload(client, reverse=True)
        repeated = upload(client, reverse=True)
    rows = preview["rows"]
    assert [r["observed_names"][0]["value"] for r in rows] == ["Synthetic red label","Synthetic blue label"]
    assert [r["id"] for r in rows] == [r["id"] for r in repeated["rows"]]
    assert {r["id"] for r in rows} == {l["row_id"] for l in preview["located_regions"] if l["attachment_id"]=="front"}
    assert all(r["observed_names"][0]["evidence"] == r["sources"][0] for r in rows)
    for row in rows:
        ref = row["sources"][0]
        assert row["label_fields"]["amount_prescribed"] == {"status":"readable","value":"21 tablets","evidence":ref}
        regimen, = row["regimens"]
        assert regimen["dose_amount"] == 1 and regimen["time_of_day"] == ["morning"]
        assert regimen["evidence"]["directions_text"] == ref
        assert preview["dispensing_facilities"][row["id"]]["organization_phone"] == "000-0000"
        assert preview["dispensing_facilities"][row["id"]]["evidence"] == ref
    assert len(preview["located_regions"]) == 4 and not preview["photo_issues"]
    assert calls.count(("ProposedBounds",(120,80))) == 4 and calls.count(("PrintedLabel",(60,80))) == 4


def test_per_crop_failure_does_not_erase_readable_sibling():
    provider, _ = provider_calls(partial=True)
    with TestClient(create_app(get_provider=lambda:provider)) as client:
        preview = upload(client)
    assert [r["identity_status"] for r in preview["rows"]] == ["named","unreadable"]
    assert preview["rows"][1]["observed_names"] == []
    assert preview["photo_issues"][0]["item_id"] == preview["rows"][1]["id"]
    assert preview["photo_issues"][0]["provider_code"] == "provider_timeout"


def test_missing_configuration_and_empty_scene_never_make_medicine(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with TestClient(create_app()) as client:
        result = upload(client)
    assert result["rows"] == [] and result["located_regions"] == []
    assert result["photo_issues"][0]["provider_code"] == "provider_unconfigured"
    provider, _ = provider_calls(empty=True)
    with TestClient(create_app(get_provider=lambda: provider)) as client:
        result = upload(client)
    assert not result["rows"] and result["photo_issues"][0]["code"] == "no_regions"


def test_bounded_original_client_can_recover_using_the_narrow_crop_contract():
    provider, calls = provider_calls()
    with TestClient(create_app(get_provider=lambda: provider)) as client:
        preview = upload(client, marked=True)
    assert calls == [("LabelAnalysisResult", (60, 80)), ("PrintedLabel", (60, 80))]
    row, = preview["rows"]
    assert row["id"] == "order-a" and row["observed_names"][0]["value"] == "Synthetic red label"
    assert row["observed_names"][0]["evidence"] == {"source_id":"left", "item_id":"left"}
