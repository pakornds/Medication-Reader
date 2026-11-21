import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.schemas.analysis import AnalysisRequest
from app.schemas.evidence import EvidenceRef
from app.schemas.package_capture import PackageCapture, RegionBounds

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "package-capture"


@pytest.fixture
def capture_payload():
    return json.loads((FIXTURES / "two-photos.json").read_text(encoding="utf-8"))


def test_two_photos_round_trip_and_project_to_existing_evidence(capture_payload):
    capture = PackageCapture.model_validate(capture_payload)
    assert PackageCapture.model_validate_json(capture.model_dump_json()) == capture
    assert [package.id for package in capture.packages] == ["package-a", "package-b", "package-c"]
    assert [region.visibility for region in capture.reverse.regions] == ["visible", "visible"]
    assert len(capture.packages[1].items) == 2
    assert {item.kind for item in capture.packages[1].items} == {"pending_appearance"}
    assert capture.front.regions[-1].id == "front-unassigned"

    manifest = capture.to_case_evidence()
    assert {source.attachment_id for source in manifest.sources} == {"table-front", "table-reverse"}
    assert {(source.id, source.organization) for source in manifest.sources if source.organization} == {
        ("clinic-a", "Demo Clinic A"),
        ("clinic-a-reverse", "Demo Clinic A"),
        ("clinic-c", "Demo Clinic C"),
    }
    appearance_items = [item for item in manifest.items if item.kind == "pill_crop"]
    assert {item.row_id for item in appearance_items} == {"pending-b-round", "pending-b-oval"}
    assert {item.source_id for item in appearance_items} == {"bag-b"}
    assert {
        capture.origin_for(EvidenceRef(source_id=item.source_id, item_id=item.id)).region_id
        for item in appearance_items
    } == {"front-b-round", "front-b-oval"}
    reverse_label = next(item for item in manifest.items if item.kind == "matched_reverse_label")
    origin = capture.origin_for(EvidenceRef(source_id=reverse_label.source_id, item_id=reverse_label.id))
    assert (origin.attachment_id, origin.revision, origin.region_id) == ("table-reverse", 2, "reverse-a")


def test_single_row_produces_unchanged_legacy_request():
    payload = json.loads((FIXTURES / "legacy-single-row.json").read_text(encoding="utf-8"))
    capture = PackageCapture.model_validate(payload["capture"])
    legacy = AnalysisRequest.model_validate({"evidence": payload["legacy_evidence"]})
    assert AnalysisRequest(evidence=capture.to_case_evidence()) == legacy
    assert capture.reverse is None


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("case_id", "other-encounter", "different encounter"),
        ("revision", 1, "current attachment revision"),
        ("attachment_id", "retaken-photo", "current attachment revision"),
        ("region_id", "front-a", "selected view"),
    ],
)
def test_rejects_foreign_or_stale_region_references(capture_payload, field, value, message):
    capture_payload["reverse_matches"][0]["region"][field] = value
    with pytest.raises(ValidationError, match=message):
        PackageCapture.model_validate(capture_payload)


@pytest.mark.parametrize(
    "bounds",
    [
        {"x": 0.8, "y": 0, "width": 0.21, "height": 1},
        {"x": 0, "y": 0.5, "width": 1, "height": 0.500001},
        {"x": -0.01, "y": 0, "width": 1, "height": 1},
        {"x": 0, "y": 0, "width": 0, "height": 1},
    ],
)
def test_bounds_are_positive_and_within_display(bounds):
    with pytest.raises(ValidationError):
        RegionBounds.model_validate(bounds)


def test_exif_orientation_records_display_coordinate_convention(capture_payload):
    capture = PackageCapture.model_validate(capture_payload)
    assert capture.front.exif_orientation == 6
    assert capture.front.coordinate_space == "exif_transposed_display"
    bounds = capture.locate(capture.packages[0].front_regions[0]).bounds
    assert bounds.model_dump() == {"x": 0.05, "y": 0.1, "width": 0.25, "height": 0.35}

    capture_payload["front"]["coordinate_space"] = "raw_sensor"
    with pytest.raises(ValidationError, match="coordinate_space"):
        PackageCapture.model_validate(capture_payload)


def test_opaque_reverse_remains_recorded_without_evidence(capture_payload):
    capture_payload["reverse"]["visibility"] = "opaque"
    with pytest.raises(ValidationError, match="Opaque"):
        PackageCapture.model_validate(capture_payload)

    capture_payload["packages"][0]["items"][0]["evidence"].pop()
    opaque = PackageCapture.model_validate(capture_payload)
    assert opaque.reverse.visibility == "opaque"
    assert all(item.kind != "matched_reverse_label" for item in opaque.to_case_evidence().items)

    capture_payload["reverse"] = None
    capture_payload["reverse_matches"] = []
    with pytest.raises(ValidationError, match="corresponding capture view"):
        PackageCapture.model_validate(capture_payload)
    capture_payload["sources"] = [
        source for source in capture_payload["sources"] if source["kind"] != "reverse_photo"
    ]
    assert PackageCapture.model_validate(capture_payload).reverse is None


def test_candidate_reverse_cannot_supply_evidence(capture_payload):
    capture_payload["reverse_matches"][0]["status"] = "candidate"
    with pytest.raises(ValidationError, match="confirmed reverse region"):
        PackageCapture.model_validate(capture_payload)


def test_two_front_packages_cannot_confirm_the_same_reverse(capture_payload):
    capture_payload["reverse_matches"][1]["status"] = "confirmed"
    with pytest.raises(ValidationError, match="only one package"):
        PackageCapture.model_validate(capture_payload)


def test_source_on_shared_attachment_cannot_leak_across_regions(capture_payload):
    capture_payload["packages"][2]["items"][0]["evidence"][0]["source_id"] = "clinic-a"
    with pytest.raises(ValidationError, match="across physical packages"):
        PackageCapture.model_validate(capture_payload)


def test_pending_appearance_cannot_claim_label_evidence(capture_payload):
    capture_payload["packages"][1]["items"][0]["evidence"][0]["kind"] = "label"
    with pytest.raises(ValidationError, match="only cite appearance"):
        PackageCapture.model_validate(capture_payload)


def test_multiple_reverse_crops_can_belong_to_one_package(capture_payload):
    reverse_region_ids = ["reverse-b-round", "reverse-b-oval"]
    package = capture_payload["packages"][1]
    reverse_source_id = "reverse-bag-b"
    capture_payload["sources"].append({
        "id": reverse_source_id, "kind": "reverse_photo", "attachment_id": "table-reverse",
    })
    for region_id, item, x in zip(reverse_region_ids, package["items"], (0.4, 0.51), strict=True):
        capture_payload["reverse"]["regions"].append({
            "id": region_id,
            "bounds": {"x": x, "y": 0.1, "width": 0.08, "height": 0.1},
        })
        region = {
            "case_id": "demo-two-photos",
            "side": "reverse",
            "attachment_id": "table-reverse",
            "revision": 2,
            "region_id": region_id,
        }
        capture_payload["reverse_matches"].append({
            "package_id": "package-b", "region": region, "status": "confirmed",
        })
        item["evidence"].append({
            "item_id": region_id, "source_id": reverse_source_id, "kind": "appearance", "region": region,
        })

    capture = PackageCapture.model_validate(capture_payload)
    manifest = capture.to_case_evidence()
    for region_id, row_id in zip(reverse_region_ids, ["pending-b-round", "pending-b-oval"], strict=True):
        item = next(item for item in manifest.items if item.id == region_id)
        assert (item.kind, item.row_id) == ("pill_crop", row_id)
        ref = EvidenceRef(source_id=item.source_id, item_id=item.id)
        assert capture.origin_for(ref).region_id == region_id
